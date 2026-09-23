/**
 * @fileoverview OpenAlex service for related-article fallback in `pubmed_find_related`.
 * Provides three capabilities that mirror the NCBI eLink relationships:
 *   - `similar(pmid, n)`: related_works → PMIDs (mirrors pubmed_pubmed)
 *   - `citedBy(pmid, n)`: cites:W<id> filter → PMIDs (mirrors pubmed_pubmed_citedin)
 *   - `references(pmid, n)`: referenced_works → PMIDs (mirrors pubmed_pubmed_refs)
 *
 * Each method returns at least `n` PubMed-addressable rows when OpenAlex has
 * them: `citedBy` walks pages of the `cites:` filter, and the other two resolve
 * the work's ID list in batches, both stopping once the window is covered,
 * upstream runs out, or a cap is reached. Records with no PMID are dropped —
 * never minted — and counted, so callers can disclose the shortfall instead of
 * serving an unexplained empty window.
 *
 * Transient failures retry with capped exponential backoff. Once retries run
 * out, only a `ServiceUnavailable` is reported as `openalex_unreachable`; a
 * `Timeout` or `RateLimited` keeps its own code and any upstream `retryAfter`.
 *
 * Uses the NCBI_ADMIN_EMAIL config (adminEmail) as the OpenAlex polite-pool
 * `mailto=` parameter when set; omits it when unset.
 *
 * @module src/services/openalex/openalex-service
 */

import { internalError, JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { defaultIsTransient, logger, requestContextService } from '@cyanheads/mcp-ts-core/utils';

import { getServerConfig } from '@/config/server-config.js';
import { recoveryFor } from '@/services/error-contracts.js';
import { OpenAlexApiClient } from './api-client.js';
import {
  OPENALEX_MAX_FILTER_VALUES,
  OPENALEX_MAX_PAGE_SIZE,
  OPENALEX_MAX_UPSTREAM_REQUESTS,
  type OpenAlexRelatedResult,
  type OpenAlexWork,
} from './types.js';

const MAX_BACKOFF_MS = 30_000;

/** Strip the `https://openalex.org/` prefix an OA ID may carry. */
function bareOaId(id: string): string {
  return id.startsWith('https://openalex.org/') ? id.slice('https://openalex.org/'.length) : id;
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) return new Promise((r) => setTimeout(r, ms));
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Extract a PMID string from an OpenAlex Work record's `ids.pmid` field.
 * OpenAlex encodes PMIDs as full URLs: "https://pubmed.ncbi.nlm.nih.gov/31295471"
 * This normalizes to the bare numeric string. Returns null when absent.
 */
function extractPmid(work: OpenAlexWork): string | null {
  const raw = work.ids?.pmid;
  if (!raw) return null;
  // Strip URL prefix if present (e.g. "https://pubmed.ncbi.nlm.nih.gov/31295471")
  const match = /(\d+)\s*$/.exec(raw);
  return match?.[1] ?? null;
}

/**
 * Nothing to page through: no source work, or an empty ID list. Built per call
 * rather than shared — the `pmids` array escapes to the caller by identity, and
 * one module-level instance would hand every empty answer the same array.
 */
function emptyResult(): OpenAlexRelatedResult {
  return { pmids: [], totalCount: 0, droppedNoPmid: 0, reachCapped: false };
}

/**
 * Accumulates PubMed-addressable rows across pages or batches: dedupes, drops
 * the source work, and counts the rows that carry no PMID. Kept as one object
 * so a multi-request walk cannot reset the `seen` set between requests and
 * re-emit a PMID an earlier page already returned.
 */
class PmidCollector {
  readonly pmids: string[] = [];
  droppedNoPmid = 0;
  private readonly seen = new Set<string>();

  constructor(private readonly excludePmid: string) {}

  /**
   * Add one candidate row. `undefined` means OpenAlex returned nothing for a
   * requested ID — unaddressable in PubMed exactly like a row with no PMID.
   */
  add(work: OpenAlexWork | undefined): void {
    const pmid = work ? extractPmid(work) : null;
    if (!pmid) {
      this.droppedNoPmid++;
      return;
    }
    if (pmid === this.excludePmid || this.seen.has(pmid)) return;
    this.seen.add(pmid);
    this.pmids.push(pmid);
  }
}

/** Service facade over the OpenAlex API for the find-related provider chain. */
export class OpenAlexService {
  constructor(
    private readonly client: OpenAlexApiClient,
    private readonly maxRetries: number,
  ) {}

  /**
   * Find works with similar content to the given PMID via OpenAlex `related_works`.
   * Returns PMIDs only; drops any record with no PMID.
   * `n` is the size of the window the caller needs covered.
   */
  async similar(pmid: string, n: number, signal?: AbortSignal): Promise<OpenAlexRelatedResult> {
    const work = await this.fetchWork(pmid, signal);
    if (!work) return emptyResult();

    return this.resolveIdsToPmids(
      pmid,
      work.related_works ?? [],
      n,
      `resolveRelatedWorks(${pmid})`,
      signal,
    );
  }

  /**
   * Find works that cite the given PMID via OpenAlex `cites:W<id>` filter.
   * Returns PMIDs only; drops any record with no PMID.
   *
   * Pages are all one size and are pulled until the filtered array covers `n`,
   * upstream runs out, or `OPENALEX_MAX_UPSTREAM_REQUESTS` is hit — the rows OpenAlex
   * serves count every citing work, but only those with a PubMed PMID are
   * addressable, so a single page sized on the raw window can under-fill it.
   */
  async citedBy(pmid: string, n: number, signal?: AbortSignal): Promise<OpenAlexRelatedResult> {
    const work = await this.fetchWork(pmid, signal);
    if (!work) return emptyResult();

    const perPage = Math.min(n, OPENALEX_MAX_PAGE_SIZE);
    const collector = new PmidCollector(pmid);
    let upstreamCount = 0;
    let exhausted = false;

    for (
      let page = 1;
      page <= OPENALEX_MAX_UPSTREAM_REQUESTS && collector.pmids.length < n;
      page++
    ) {
      const { works, totalCount } = await this.withRetry(
        () => this.client.getCitedBy(work.id, perPage, page, signal),
        `getCitedBy(${work.id}, page ${page})`,
        signal,
      );
      upstreamCount = totalCount;
      for (const w of works) collector.add(w);
      if (works.length < perPage || page * perPage >= totalCount) {
        exhausted = true;
        break;
      }
    }

    return this.finish(collector, exhausted, upstreamCount, n);
  }

  /**
   * Find works referenced by the given PMID via OpenAlex `referenced_works`.
   * Returns PMIDs only; drops any record with no PMID.
   */
  async references(pmid: string, n: number, signal?: AbortSignal): Promise<OpenAlexRelatedResult> {
    const work = await this.fetchWork(pmid, signal);
    if (!work) return emptyResult();

    return this.resolveIdsToPmids(
      pmid,
      work.referenced_works ?? [],
      n,
      `resolveReferencedWorks(${pmid})`,
      signal,
    );
  }

  /** Look up the source work by PMID; `null` when OpenAlex doesn't index it. */
  private fetchWork(pmid: string, signal?: AbortSignal): Promise<OpenAlexWork | null> {
    return this.withRetry(
      () => this.client.getWorkByPmid(pmid, signal),
      `getWorkByPmid(${pmid})`,
      signal,
    );
  }

  /**
   * Resolve an OpenAlex ID list (a work's references or related works) to PMIDs,
   * in batches, until the window is covered, the list is exhausted, or the
   * request cap is reached. The work record carries the whole list, so this
   * paginates resolution rather than an upstream query.
   *
   * Each batch's rows are re-ordered to the requested IDs, so the result follows
   * the source list — a window at any offset stays stable across calls, whatever
   * order OpenAlex answers a batch in.
   */
  private async resolveIdsToPmids(
    pmid: string,
    oaIds: string[],
    n: number,
    label: string,
    signal?: AbortSignal,
  ): Promise<OpenAlexRelatedResult> {
    if (oaIds.length === 0) return emptyResult();

    const collector = new PmidCollector(pmid);
    let consumed = 0;

    for (
      let batch = 0;
      batch < OPENALEX_MAX_UPSTREAM_REQUESTS &&
      consumed < oaIds.length &&
      collector.pmids.length < n;
      batch++
    ) {
      const ids = oaIds.slice(consumed, consumed + OPENALEX_MAX_FILTER_VALUES);
      const resolved = await this.withRetry(
        () => this.client.resolveOaIdsToPmids(ids, signal),
        label,
        signal,
      );
      const byId = new Map(resolved.map((w) => [bareOaId(w.id), w]));
      for (const id of ids) collector.add(byId.get(bareOaId(id)));
      consumed += ids.length;
    }

    return this.finish(collector, consumed >= oaIds.length, oaIds.length, n);
  }

  /**
   * Shape a walk's outcome. Exhausting the fetchable set makes the addressable
   * count exact; short of that only OpenAlex's own total is known, and a window
   * the walk never reached is flagged rather than served as a silent empty.
   */
  private finish(
    collector: PmidCollector,
    exhausted: boolean,
    upstreamCount: number,
    n: number,
  ): OpenAlexRelatedResult {
    return {
      pmids: collector.pmids,
      totalCount: exhausted ? collector.pmids.length : upstreamCount,
      droppedNoPmid: collector.droppedNoPmid,
      reachCapped: !exhausted && collector.pmids.length < n,
    };
  }

  /**
   * Retry wrapper for transient errors. On exhaustion the last error keeps its
   * code and an upstream `retryAfter`, so a 429 still tells the caller how long to
   * wait. Only a `ServiceUnavailable` gains `openalex_unreachable` and its hint — the
   * one code that reason is declared for; a `Timeout` or `RateLimited` keeps its
   * code with no reason, as the NCBI and Europe PMC services report them.
   */
  private async withRetry<T>(
    execute: () => Promise<T>,
    label: string,
    signal?: AbortSignal,
  ): Promise<T> {
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      if (signal?.aborted) throw signal.reason;

      try {
        return await execute();
      } catch (error: unknown) {
        if (signal?.aborted) throw signal.reason;
        if (!(error instanceof McpError)) throw error;
        if (!defaultIsTransient(error)) throw error;

        if (attempt < this.maxRetries) {
          const baseDelay = Math.min(1000 * 2 ** attempt, MAX_BACKOFF_MS);
          const jitter = baseDelay * (0.75 + 0.5 * Math.random());
          const retryDelay = Math.round(jitter);
          logger.warning(
            `OpenAlex ${label} failed. Retrying (${attempt + 1}/${this.maxRetries}) in ${retryDelay}ms.`,
            requestContextService.createRequestContext({
              operation: 'OpenAlexRetry',
              additionalContext: { label, attempt: attempt + 1, retryDelay },
            }),
          );
          await abortableSleep(retryDelay, signal);
          continue;
        }

        const attempts = this.maxRetries + 1;
        throw new McpError(
          error.code,
          `${error.message} (failed after ${attempts} attempts)`,
          {
            ...(error.code === JsonRpcErrorCode.ServiceUnavailable && {
              reason: 'openalex_unreachable',
              ...recoveryFor('openalex_unreachable'),
            }),
            label,
            attempts,
            ...(error.data?.retryAfter !== undefined && { retryAfter: error.data.retryAfter }),
          },
          { cause: error },
        );
      }
    }

    throw internalError('OpenAlex request failed after all retries.', { label });
  }
}

// ─── Init / Accessor ────────────────────────────────────────────────────────

let _service: OpenAlexService | undefined;

/** Initialize the OpenAlex service. Call from `setup()` in createApp. */
export function initOpenAlexService(): void {
  const config = getServerConfig();
  const client = new OpenAlexApiClient({
    timeoutMs: config.europepmcTimeoutMs, // reuse EPMC timeout — same order of magnitude
    ...(config.adminEmail && { email: config.adminEmail }),
  });
  // Reuse EPMC retry config — same upstream reliability tier
  _service = new OpenAlexService(client, config.europepmcMaxRetries);
  logger.info(
    'OpenAlex service initialized.',
    requestContextService.createRequestContext({
      operation: 'OpenAlexInit',
      additionalContext: {
        hasEmail: !!config.adminEmail,
        maxRetries: config.europepmcMaxRetries,
        timeoutMs: config.europepmcTimeoutMs,
      },
    }),
  );
}

/** Get the initialized OpenAlex service. Throws if not initialized. */
export function getOpenAlexService(): OpenAlexService {
  if (!_service)
    throw new Error('OpenAlex service not initialized. Call initOpenAlexService() first.');
  return _service;
}

/** Returns the service if initialized, undefined otherwise (for optional use). */
export function getOpenAlexServiceOptional(): OpenAlexService | undefined {
  return _service;
}
