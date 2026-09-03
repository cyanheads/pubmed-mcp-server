/**
 * @fileoverview OpenAlex service for related-article fallback in `pubmed_find_related`.
 * Provides three capabilities that mirror the NCBI eLink relationships:
 *   - `similar(pmid, n)`: related_works → PMIDs (mirrors pubmed_pubmed)
 *   - `citedBy(pmid, n)`: cites:W<id> filter → PMIDs (mirrors pubmed_pubmed_citedin)
 *   - `references(pmid, n)`: referenced_works → PMIDs (mirrors pubmed_pubmed_refs)
 *
 * All three methods drop records with no PMID — never mints fake IDs.
 * Uses the NCBI_ADMIN_EMAIL config (adminEmail) as the OpenAlex polite-pool
 * `mailto=` parameter when set; omits it when unset.
 *
 * @module src/services/openalex/openalex-service
 */

import { internalError, JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { logger, requestContextService } from '@cyanheads/mcp-ts-core/utils';

import { getServerConfig } from '@/config/server-config.js';
import { recoveryFor } from '@/services/error-contracts.js';
import { isTransient } from '@/services/retry-policy.js';
import { OpenAlexApiClient } from './api-client.js';
import type { OpenAlexWork } from './types.js';

/** Transient codes eligible for retry. */
const RETRYABLE_CODES = new Set<JsonRpcErrorCode>([
  JsonRpcErrorCode.ServiceUnavailable,
  JsonRpcErrorCode.Timeout,
  JsonRpcErrorCode.RateLimited,
]);

const MAX_BACKOFF_MS = 30_000;

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

/** Service facade over the OpenAlex API for the find-related provider chain. */
export class OpenAlexService {
  constructor(
    private readonly client: OpenAlexApiClient,
    private readonly maxRetries: number,
  ) {}

  /**
   * Find works with similar content to the given PMID via OpenAlex `related_works`.
   * Returns PMIDs only; drops any record with no PMID.
   * `n` is the number of PMIDs to return (OpenAlex caps related_works at ~10).
   */
  async similar(
    pmid: string,
    n: number,
    signal?: AbortSignal,
  ): Promise<{ pmids: string[]; totalCount: number }> {
    const work = await this.withRetry(
      () => this.client.getWorkByPmid(pmid, signal),
      `getWorkByPmid(${pmid})`,
      signal,
    );
    if (!work) return { pmids: [], totalCount: 0 };

    const relatedIds = (work.related_works ?? []).slice(0, Math.min(n * 3, 50));
    if (relatedIds.length === 0) return { pmids: [], totalCount: 0 };

    const resolved = await this.withRetry(
      () => this.client.resolveOaIdsToPmids(relatedIds, signal),
      `resolveRelatedWorks(${pmid})`,
      signal,
    );

    const pmids = this.extractPmids(resolved, pmid).slice(0, n);
    return { pmids, totalCount: work.related_works?.length ?? 0 };
  }

  /**
   * Find works that cite the given PMID via OpenAlex `cites:W<id>` filter.
   * Returns PMIDs only; drops any record with no PMID.
   */
  async citedBy(
    pmid: string,
    n: number,
    signal?: AbortSignal,
  ): Promise<{ pmids: string[]; totalCount: number }> {
    const work = await this.withRetry(
      () => this.client.getWorkByPmid(pmid, signal),
      `getWorkByPmid(${pmid})`,
      signal,
    );
    if (!work) return { pmids: [], totalCount: 0 };

    const { works, totalCount } = await this.withRetry(
      () => this.client.getCitedBy(work.id, n, signal),
      `getCitedBy(${work.id})`,
      signal,
    );

    const pmids = this.extractPmids(works, pmid);
    return { pmids, totalCount };
  }

  /**
   * Find works referenced by the given PMID via OpenAlex `referenced_works`.
   * Returns PMIDs only; drops any record with no PMID.
   */
  async references(
    pmid: string,
    n: number,
    signal?: AbortSignal,
  ): Promise<{ pmids: string[]; totalCount: number }> {
    const work = await this.withRetry(
      () => this.client.getWorkByPmid(pmid, signal),
      `getWorkByPmid(${pmid})`,
      signal,
    );
    if (!work) return { pmids: [], totalCount: 0 };

    const refIds = (work.referenced_works ?? []).slice(0, Math.min(n * 3, 200));
    if (refIds.length === 0) return { pmids: [], totalCount: 0 };

    const resolved = await this.withRetry(
      () => this.client.resolveOaIdsToPmids(refIds, signal),
      `resolveReferencedWorks(${pmid})`,
      signal,
    );

    const pmids = this.extractPmids(resolved, pmid).slice(0, n);
    return { pmids, totalCount: work.referenced_works?.length ?? 0 };
  }

  /**
   * Extract unique numeric PMIDs from a list of works, excluding the source PMID.
   * Any work with no PMID is silently dropped (never minted).
   */
  private extractPmids(works: OpenAlexWork[], excludePmid: string): string[] {
    const seen = new Set<string>();
    const result: string[] = [];
    for (const w of works) {
      const pmid = extractPmid(w);
      if (!pmid || pmid === excludePmid || seen.has(pmid)) continue;
      seen.add(pmid);
      result.push(pmid);
    }
    return result;
  }

  /** Retry wrapper for transient errors, mirroring the EPMC service pattern. */
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
        if (!isTransient(error, RETRYABLE_CODES)) throw error;

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
        const msg = error instanceof Error ? error.message : String(error);
        throw new McpError(
          error.code,
          `${msg} (failed after ${attempts} attempts)`,
          {
            reason: 'openalex_unreachable',
            label,
            attempts,
            ...recoveryFor('openalex_unreachable'),
          },
          { cause: error },
        );
      }
    }

    throw internalError('OpenAlex request failed after all retries.', {
      reason: 'openalex_unreachable',
      ...recoveryFor('openalex_unreachable'),
    });
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
