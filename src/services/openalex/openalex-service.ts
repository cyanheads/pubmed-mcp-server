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
 * Transient failures retry with capped exponential backoff, honoring an upstream
 * `Retry-After`. One total deadline (`EUROPEPMC_TOTAL_DEADLINE_MS`, borrowed like
 * the timeout and retry count), or the time the tool call has left when that is
 * less, bounds every request, attempt, and backoff a public method makes; its
 * expiry ends the call as `openalex_deadline_exceeded`. Once the attempts stop
 * without it — retries ran out, or the next wait would not fit — the last
 * attempt's `data.reason` is kept (`openalex_invalid_response` for a body that
 * is not JSON), and only a `ServiceUnavailable` with no reason is reported as
 * `openalex_unreachable`; a `Timeout` or `RateLimited` keeps its own code and
 * any upstream `retryAfter`.
 *
 * Uses the NCBI_ADMIN_EMAIL config (adminEmail) as the OpenAlex polite-pool
 * `mailto=` parameter when set; omits it when unset.
 *
 * @module src/services/openalex/openalex-service
 */

import { JsonRpcErrorCode, McpError, timeout } from '@cyanheads/mcp-ts-core/errors';
import {
  defaultIsTransient,
  logger,
  requestContextService,
  withRetry,
} from '@cyanheads/mcp-ts-core/utils';

import { getServerConfig } from '@/config/server-config.js';
import {
  type CallDeadline,
  isSpent,
  remainingMs,
  upstreamBound,
} from '@/services/call-deadline.js';
import { OpenAlexApiClient } from './api-client.js';
import {
  OPENALEX_MAX_FILTER_VALUES,
  OPENALEX_MAX_PAGE_SIZE,
  OPENALEX_MAX_UPSTREAM_REQUESTS,
  type OpenAlexRelatedResult,
  type OpenAlexWork,
} from './types.js';

/** Ceiling on one backoff sleep, so a high retry count cannot grow it without bound. */
const MAX_BACKOFF_MS = 30_000;

/**
 * Retry gate: the framework's transient set, narrowed to `McpError`s. The client
 * classifies every upstream failure, so a plain `Error` reaching the loop — a body
 * that failed mid-stream — is passed on unretried.
 */
const isTransient = (error: unknown): boolean =>
  error instanceof McpError && defaultIsTransient(error);

/** What {@link toServiceError} needs to know about the retry loop that threw. */
interface LoopOutcome {
  /** Attempts the loop made. */
  attempts: number;
  /** The deadline the loop ran under. */
  deadline: CallDeadline;
  /** Whether the deadline fired — the loop's own signal, never inferred from the error. */
  deadlineFired: boolean;
}

/** The expiry of the deadline a call ran under, `deadlineMs` long. */
function deadlineExceeded(label: string, deadlineMs: number, cause?: unknown): McpError {
  return timeout(
    `OpenAlex request deadline (${deadlineMs}ms) exceeded`,
    { reason: 'openalex_deadline_exceeded', label, deadlineMs },
    cause === undefined ? undefined : { cause },
  );
}

/**
 * The failure the attempts stopped on, as the caller sees it: its code and message
 * with the attempt count appended, `label`, `attempts`, and an upstream
 * `retryAfter`, so a 429 still tells the caller how long to wait. Its `data.reason`
 * is kept (`openalex_invalid_response` for a body that is not JSON); only a
 * `ServiceUnavailable` carrying none gains `openalex_unreachable`, the one code that
 * reason is declared for. A `Timeout` or `RateLimited` keeps its code with no
 * reason, and `pubmed_find_related` names it by that code.
 */
function exhausted(last: McpError, label: string, attempts: number): McpError {
  const reason =
    last.data?.reason ??
    (last.code === JsonRpcErrorCode.ServiceUnavailable ? 'openalex_unreachable' : undefined);
  return new McpError(
    last.code,
    `${last.message} (failed after ${attempts} attempt${attempts === 1 ? '' : 's'})`,
    {
      ...(reason !== undefined && { reason }),
      label,
      attempts,
      ...(last.data?.retryAfter !== undefined && { retryAfter: last.data.retryAfter }),
    },
    { cause: last },
  );
}

/**
 * Maps what the retry loop throws onto this service's failure reasons. A caller's
 * abort never reaches here.
 *
 * - The deadline fired — mid-request or mid-backoff → `openalex_deadline_exceeded`
 *   (Timeout), with `label` and `deadlineMs`.
 * - The attempts stopped without it — retries ran out, the next backoff would not
 *   fit the time left (which arrives as the same `retry_deadline_exceeded` an
 *   expiry does, so the loop's own signal tells the two apart), or a `Retry-After`
 *   outlasts the backoff cap or the time left → {@link exhausted}.
 * - Anything never retried — a non-transient failure — passes through unchanged.
 */
function toServiceError(error: unknown, label: string, loop: LoopOutcome): unknown {
  if (!(error instanceof McpError)) return error;
  if (error.data?.reason === 'retry_deadline_exceeded' && loop.deadlineFired) {
    return deadlineExceeded(label, loop.deadline.totalMs, error);
  }
  if (error.data?.reason === 'retry_deadline_exceeded' || error.data?.retryAttempts !== undefined) {
    return exhausted(error.cause instanceof McpError ? error.cause : error, label, loop.attempts);
  }
  return isTransient(error) ? exhausted(error, label, loop.attempts) : error;
}

/** Strip the `https://openalex.org/` prefix an OA ID may carry. */
function bareOaId(id: string): string {
  return id.startsWith('https://openalex.org/') ? id.slice('https://openalex.org/'.length) : id;
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

/**
 * Service facade over the OpenAlex API for the find-related provider chain.
 *
 * Each public method takes the caller's `signal` and, beside it, the tool call's
 * `deadline`. Every request the method sends shares one deadline, set as it
 * starts: `totalDeadlineMs`, or the time `deadline` has left when that is less. A
 * request that would start on a spent deadline sends nothing and fails as
 * `openalex_deadline_exceeded`; a caller's abort rethrows the caller's own reason.
 */
export class OpenAlexService {
  /**
   * @param totalDeadlineMs Bound on one public call, in ms — `EUROPEPMC_TOTAL_DEADLINE_MS`
   *   in production. The tool call's `deadline` shortens it when that has less time left.
   */
  constructor(
    private readonly client: OpenAlexApiClient,
    private readonly maxRetries: number,
    private readonly totalDeadlineMs: number,
  ) {}

  /**
   * Find works with similar content to the given PMID via OpenAlex `related_works`.
   * Returns PMIDs only; drops any record with no PMID.
   * `n` is the size of the window the caller needs covered.
   */
  async similar(
    pmid: string,
    n: number,
    signal?: AbortSignal,
    deadline?: CallDeadline,
  ): Promise<OpenAlexRelatedResult> {
    const window = this.callWindow(deadline);
    const work = await this.fetchWork(pmid, window, signal);
    if (!work) return emptyResult();

    return this.resolveIdsToPmids(
      pmid,
      work.related_works ?? [],
      n,
      `resolveRelatedWorks(${pmid})`,
      window,
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
  async citedBy(
    pmid: string,
    n: number,
    signal?: AbortSignal,
    deadline?: CallDeadline,
  ): Promise<OpenAlexRelatedResult> {
    const window = this.callWindow(deadline);
    const work = await this.fetchWork(pmid, window, signal);
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
      const { works, totalCount } = await this.runBounded(
        (loopSignal) => this.client.getCitedBy(work.id, perPage, page, loopSignal),
        `getCitedBy(${work.id}, page ${page})`,
        window,
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
  async references(
    pmid: string,
    n: number,
    signal?: AbortSignal,
    deadline?: CallDeadline,
  ): Promise<OpenAlexRelatedResult> {
    const window = this.callWindow(deadline);
    const work = await this.fetchWork(pmid, window, signal);
    if (!work) return emptyResult();

    return this.resolveIdsToPmids(
      pmid,
      work.referenced_works ?? [],
      n,
      `resolveReferencedWorks(${pmid})`,
      window,
      signal,
    );
  }

  /**
   * The deadline every request of one public call shares, set as the call starts:
   * `totalDeadlineMs`, or the time `deadline` has left when that is less, reporting
   * the length of whichever binds as its `totalMs`.
   */
  private callWindow(deadline?: CallDeadline): CallDeadline {
    const bound = upstreamBound(this.totalDeadlineMs, deadline);
    return { expiresAt: Date.now() + bound.remainingMs, totalMs: bound.deadlineMs };
  }

  /** Look up the source work by PMID; `null` when OpenAlex doesn't index it. */
  private fetchWork(
    pmid: string,
    window: CallDeadline,
    signal?: AbortSignal,
  ): Promise<OpenAlexWork | null> {
    return this.runBounded(
      (loopSignal) => this.client.getWorkByPmid(pmid, loopSignal),
      `getWorkByPmid(${pmid})`,
      window,
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
    window: CallDeadline,
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
      const resolved = await this.runBounded(
        (loopSignal) => this.client.resolveOaIdsToPmids(ids, loopSignal),
        label,
        window,
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
   * Runs one request as a retry loop bounded by `window`, the public call's shared
   * deadline. The loop's signal — the caller's joined with the deadline's — reaches
   * the request, so the one in flight when the deadline fires is aborted then
   * rather than at its own timeout. `execute` receives that signal.
   *
   * A caller abort rethrows the caller's own reason, before the loop or after it;
   * a `window` already spent sends nothing. Every other failure is mapped by
   * {@link toServiceError}. Once the caller is ruled out, the loop's signal has
   * aborted only if the deadline fired.
   */
  private async runBounded<T>(
    execute: (signal: AbortSignal) => Promise<T>,
    label: string,
    window: CallDeadline,
    signal?: AbortSignal,
  ): Promise<T> {
    if (signal?.aborted) throw signal.reason;
    if (isSpent(window)) throw deadlineExceeded(label, window.totalMs);

    let attempts = 0;
    let loopSignal: AbortSignal | undefined;
    try {
      return await withRetry(
        ({ signal: attemptSignal }) => {
          loopSignal = attemptSignal;
          const attempt = ++attempts;
          return execute(attemptSignal).catch((error: unknown) => {
            if (attempt <= this.maxRetries && isTransient(error)) {
              logger.warning(
                `OpenAlex ${label} failed on attempt ${attempt} of ${this.maxRetries + 1}.`,
                requestContextService.createRequestContext({
                  operation: 'OpenAlexRetry',
                  additionalContext: {
                    label,
                    attempt,
                    error: error instanceof Error ? error.message : String(error),
                  },
                }),
              );
            }
            throw error;
          });
        },
        {
          maxRetries: this.maxRetries,
          maxDelayMs: MAX_BACKOFF_MS,
          deadlineMs: remainingMs(window),
          isTransient,
          operation: `OpenAlex ${label}`,
          ...(signal && { signal }),
        },
      );
    } catch (error: unknown) {
      if (signal?.aborted) throw signal.reason;
      throw toServiceError(error, label, {
        attempts,
        deadline: window,
        deadlineFired: loopSignal?.aborted === true,
      });
    }
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
  // Reuse EPMC retry config and total deadline — same upstream reliability tier
  _service = new OpenAlexService(
    client,
    config.europepmcMaxRetries,
    config.europepmcTotalDeadlineMs,
  );
  logger.info(
    'OpenAlex service initialized.',
    requestContextService.createRequestContext({
      operation: 'OpenAlexInit',
      additionalContext: {
        hasEmail: !!config.adminEmail,
        maxRetries: config.europepmcMaxRetries,
        timeoutMs: config.europepmcTimeoutMs,
        deadlineMs: config.europepmcTotalDeadlineMs,
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
