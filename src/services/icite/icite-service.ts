/**
 * @fileoverview NIH iCite service behind `pubmed_fetch_citation_metrics`: one
 * `/pubs` request per call, retried on transient failures within a total
 * deadline, its records normalized and checked against the PMIDs sent.
 *
 * Once retries run out, the last attempt's `data.reason` is kept
 * (`icite_invalid_response` for a body that is not the JSON envelope), and a
 * `ServiceUnavailable` with no reason — a network failure or an HTTP 5xx — is
 * reported as `icite_unreachable`. A `Timeout` or `RateLimited` keeps its own
 * code and any upstream `retryAfter`.
 *
 * Reuses the Europe PMC per-request timeout and retry count (the same settings
 * the OpenAlex service runs on); iCite takes no key or contact email.
 *
 * @module src/services/icite/icite-service
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError, serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
import { logger, requestContextService, withRetry } from '@cyanheads/mcp-ts-core/utils';

import { getServerConfig } from '@/config/server-config.js';
import { IciteApiClient } from './api-client.js';
import { ICITE_DEADLINE_MS, type IciteRawRecord, type IciteRecord } from './types.js';

const CANONICAL_PMID_RE = /^[1-9]\d*$/;

const finite = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;
const flag = (value: unknown): boolean | undefined =>
  typeof value === 'boolean' ? value : undefined;
const text = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() !== '' ? value : undefined;

/** `{ [key]: value }` when `value` is defined, `{}` otherwise — an absent value stays absent. */
const present = <K extends string, V>(key: K, value: V | undefined) =>
  (value === undefined ? {} : { [key]: value }) as Partial<Record<K, V>>;

/**
 * `cited_by_clin` counted. iCite leaves it null rather than `[]` when no
 * clinical article cites the record, so null beside `citedByClinicalArticle:
 * false` is a count of 0; any other null is unknown, as is the count of a
 * record that carries no flag at all.
 */
function clinicalCitationCount(raw: IciteRawRecord): number | undefined {
  const cited = flag(raw.citedByClinicalArticle);
  if (cited === undefined) return;
  if (Array.isArray(raw.cited_by_clin)) return raw.cited_by_clin.length;
  return cited === false && raw.cited_by_clin == null ? 0 : undefined;
}

/**
 * Map one raw record to an {@link IciteRecord}, dropping every null or
 * mistyped value. `provisional` is kept only beside an RCR: iCite reports
 * `false` for a record with no RCR at all, which would read as a final RCR that
 * does not exist. Returns `undefined` for a record whose PMID is not a PMID.
 */
function normalizeRecord(raw: IciteRawRecord): IciteRecord | undefined {
  const pmid = String(raw.pmid);
  if (!CANONICAL_PMID_RE.test(pmid)) return;
  const relativeCitationRatio = finite(raw.relative_citation_ratio);
  return {
    pmid,
    ...present('title', text(raw.title)),
    ...present('year', finite(raw.year)),
    ...present('journal', text(raw.journal)),
    ...present('doi', text(raw.doi)),
    ...present('isResearchArticle', flag(raw.is_research_article)),
    ...present('isClinical', flag(raw.is_clinical)),
    ...present('relativeCitationRatio', relativeCitationRatio),
    ...present(
      'rcrProvisional',
      relativeCitationRatio === undefined ? undefined : flag(raw.provisional),
    ),
    ...present('nihPercentile', finite(raw.nih_percentile)),
    ...present('citationCount', finite(raw.citation_count)),
    ...present('citationsPerYear', finite(raw.citations_per_year)),
    ...present('expectedCitationsPerYear', finite(raw.expected_citations_per_year)),
    ...present('fieldCitationRate', finite(raw.field_citation_rate)),
    ...present('apt', finite(raw.apt)),
    ...present('human', finite(raw.human)),
    ...present('animal', finite(raw.animal)),
    ...present('molecularCellular', finite(raw.molecular_cellular)),
    ...present('citedByClinicalArticle', flag(raw.citedByClinicalArticle)),
    ...present('clinicalCitationCount', clinicalCitationCount(raw)),
  };
}

/**
 * An exhausted failure as the caller sees it: a `ServiceUnavailable` that
 * carries no reason — a network failure or an HTTP 5xx — becomes
 * `icite_unreachable`. Every other error, a caller's abort included, passes
 * through unchanged.
 */
function withUnreachableReason(error: unknown): unknown {
  if (
    !(error instanceof McpError) ||
    error.code !== JsonRpcErrorCode.ServiceUnavailable ||
    error.data?.reason !== undefined
  ) {
    return error;
  }
  return new McpError(
    error.code,
    error.message,
    { ...error.data, reason: 'icite_unreachable' },
    { cause: error },
  );
}

/** Service facade over the iCite `/pubs` endpoint. */
export class IciteService {
  constructor(
    private readonly client: IciteApiClient,
    private readonly timeoutMs: number,
    private readonly maxRetries: number,
  ) {}

  /**
   * Fetch the iCite records for `pmids` in one request. `pmids` must be
   * distinct canonical PMIDs no larger than `ICITE_MAX_PMID` — iCite answers a
   * list with no PMID it accepts with its first 1,000 records instead.
   *
   * Records come back in iCite's order, one per PMID it knows; a PMID it does
   * not know is absent, with no error. A record for a PMID the call did not
   * send fails the call as `icite_invalid_response`, unretried — repeating the
   * request repeats the answer.
   */
  async fetchRecords(pmids: readonly string[], ctx: Context): Promise<IciteRecord[]> {
    let raw: IciteRawRecord[];
    try {
      raw = await withRetry(
        ({ signal, remainingMs }) =>
          this.client.fetchPubs(pmids, Math.min(this.timeoutMs, remainingMs), ctx, signal),
        {
          maxRetries: this.maxRetries,
          deadlineMs: ICITE_DEADLINE_MS,
          operation: 'NIH iCite /pubs',
          context: ctx,
          signal: ctx.signal,
        },
      );
    } catch (error: unknown) {
      throw withUnreachableReason(error);
    }

    const requested = new Set(pmids);
    return raw.map((entry) => {
      const record = normalizeRecord(entry);
      if (!record || !requested.has(record.pmid)) {
        throw serviceUnavailable(
          `NIH iCite answered with a record for PMID ${String(entry.pmid)}, which this call did not request.`,
          { reason: 'icite_invalid_response', unrequestedPmid: String(entry.pmid) },
        );
      }
      return record;
    });
  }
}

// ─── Init / Accessor ────────────────────────────────────────────────────────

let _service: IciteService | undefined;

/** Initialize the iCite service. Call from `setup()` in createApp. */
export function initIciteService(): void {
  const config = getServerConfig();
  _service = new IciteService(
    new IciteApiClient(),
    config.europepmcTimeoutMs,
    config.europepmcMaxRetries,
  );
  logger.info(
    'NIH iCite service initialized.',
    requestContextService.createRequestContext({
      operation: 'IciteInit',
      additionalContext: {
        maxRetries: config.europepmcMaxRetries,
        timeoutMs: config.europepmcTimeoutMs,
        deadlineMs: ICITE_DEADLINE_MS,
      },
    }),
  );
}

/** Get the initialized iCite service. Throws if not initialized. */
export function getIciteService(): IciteService {
  if (!_service) throw new Error('iCite service not initialized. Call initIciteService() first.');
  return _service;
}
