/**
 * @fileoverview NIH iCite service behind `pubmed_fetch_citation_metrics`: one
 * `/pubs` request per call, retried on transient failures within a total
 * deadline, its records normalized and checked against the PMIDs sent — a
 * record for a PMID not sent fails as `icite_unrequested_record`, unretried.
 *
 * The total deadline is iCite's own, or the time the tool call has left when
 * that is less. Its expiry ends the call as `icite_deadline_exceeded`. Once the
 * attempts stop without it — retries ran out, or the next backoff would not fit
 * the time left — the last attempt's `data.reason` is kept
 * (`icite_invalid_response` for a body that is not the JSON envelope), a
 * `ServiceUnavailable` with no reason — a network failure or an HTTP 5xx — is
 * reported as `icite_unreachable`, and a `Timeout` as `icite_timed_out`. A
 * `RateLimited` keeps its own code and any upstream `retryAfter`.
 *
 * Reuses the Europe PMC per-request timeout and retry count (the same settings
 * the OpenAlex service runs on); iCite takes no key or contact email.
 *
 * @module src/services/icite/icite-service
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import {
  JsonRpcErrorCode,
  McpError,
  serviceUnavailable,
  timeout,
} from '@cyanheads/mcp-ts-core/errors';
import { logger, requestContextService, withRetry } from '@cyanheads/mcp-ts-core/utils';

import { getServerConfig } from '@/config/server-config.js';
import { type CallDeadline, upstreamBound } from '@/services/call-deadline.js';
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
 * `cited_by_clin` as PMID strings, in iCite's order (iCite sends integers).
 * Absent unless it is a non-empty list of PMIDs: a list holding anything else
 * is dropped whole, like any mistyped value, and its count stays as counted.
 */
function clinicalCitationPmids(raw: IciteRawRecord): string[] | undefined {
  if (!Array.isArray(raw.cited_by_clin) || raw.cited_by_clin.length === 0) return;
  const pmids: string[] = [];
  for (const entry of raw.cited_by_clin) {
    const pmid = typeof entry === 'number' ? String(entry) : entry;
    if (typeof pmid !== 'string' || !CANONICAL_PMID_RE.test(pmid)) return;
    pmids.push(pmid);
  }
  return pmids;
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
    ...present('clinicalCitationPmids', clinicalCitationPmids(raw)),
  };
}

const OPERATION = 'NIH iCite /pubs';

/** The reason a failure the attempts stopped on is reported under, by its code, when it carries none. */
const REASON_BY_CODE = new Map<JsonRpcErrorCode, string>([
  [JsonRpcErrorCode.ServiceUnavailable, 'icite_unreachable'],
  [JsonRpcErrorCode.Timeout, 'icite_timed_out'],
]);

/** The expiry of the deadline a call ran under, `deadlineMs` long. */
function deadlineExceeded(deadlineMs: number, cause?: unknown): McpError {
  return timeout(
    `NIH iCite request deadline (${deadlineMs}ms) exceeded`,
    { reason: 'icite_deadline_exceeded', deadlineMs },
    cause === undefined ? undefined : { cause },
  );
}

/**
 * Maps what the retry loop throws onto this service's failure reasons. A caller's
 * abort never reaches here.
 *
 * - The deadline fired — mid-request or mid-backoff → `icite_deadline_exceeded`,
 *   with `deadlineMs`.
 * - The loop stopped because the next backoff would not fit the time left → the
 *   last attempt's error as when retries run out, below. It arrives as the same
 *   `retry_deadline_exceeded` an expiry does, and its timing cannot tell the two
 *   apart (timers can fire early), so the loop's own signal does.
 * - Every other failure keeps its `data.reason`; one with none is stamped the
 *   reason {@link REASON_BY_CODE} names for its code, and any other code passes
 *   through unchanged.
 */
function toServiceError(error: unknown, deadlineFired: boolean, deadlineMs: number): unknown {
  if (!(error instanceof McpError)) return error;
  let failure = error;
  if (error.data?.reason === 'retry_deadline_exceeded') {
    if (deadlineFired) return deadlineExceeded(deadlineMs, error);
    failure = asExhausted(error.cause, Number(error.data.retryAttempts));
  }
  const reason = failure.data?.reason === undefined ? REASON_BY_CODE.get(failure.code) : undefined;
  if (reason === undefined) return failure;
  return new McpError(
    failure.code,
    failure.message,
    { ...failure.data, reason },
    { cause: failure },
  );
}

/**
 * The last attempt's error in the shape `withRetry` gives one whose retries ran out:
 * the attempt count in the message and as `retryAttempts`. A failure that is not an
 * `McpError` — a body that failed mid-stream — reads as unreachable.
 */
function asExhausted(last: unknown, attempts: number): McpError {
  const lastError =
    last instanceof McpError
      ? last
      : serviceUnavailable(
          `NIH iCite request failed: ${last instanceof Error ? last.message : String(last)}`,
          undefined,
          { cause: last },
        );
  return new McpError(
    lastError.code,
    `${lastError.message} (failed after ${attempts} attempt${attempts === 1 ? '' : 's'})`,
    { ...lastError.data, retryAttempts: attempts, operation: OPERATION },
    { cause: lastError },
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
   * send fails the call as `icite_unrequested_record`, unretried and marked
   * `retryable: false` — repeating the request repeats the answer. The mark is
   * set here because the framework fills in only the contract's recovery hint
   * on a service throw, not its `retryable`.
   *
   * The call runs under {@link ICITE_DEADLINE_MS}, or under the time `deadline` has
   * left when that is less; a `deadline` already spent sends nothing and fails as
   * `icite_deadline_exceeded`. A caller's abort passes through unchanged.
   */
  async fetchRecords(
    pmids: readonly string[],
    ctx: Context,
    deadline?: CallDeadline,
  ): Promise<IciteRecord[]> {
    const bound = upstreamBound(ICITE_DEADLINE_MS, deadline);
    if (bound.spent && !ctx.signal.aborted) throw deadlineExceeded(bound.deadlineMs);

    let loopSignal: AbortSignal | undefined;
    let raw: IciteRawRecord[];
    try {
      raw = await withRetry(
        ({ signal }) => {
          loopSignal = signal;
          /**
           * The deadline's expiry reaches the request through `signal`. The per-request
           * timeout stays uncapped: a timer shortened to the time left would fire at the
           * deadline's own instant and could be read as an ordinary timeout.
           */
          return this.client.fetchPubs(pmids, this.timeoutMs, ctx, signal);
        },
        {
          maxRetries: this.maxRetries,
          deadlineMs: bound.remainingMs,
          operation: OPERATION,
          context: ctx,
          signal: ctx.signal,
        },
      );
    } catch (error: unknown) {
      if (ctx.signal.aborted) throw error;
      // The caller is ruled out, so the loop's signal has aborted only if the deadline fired.
      throw toServiceError(error, loopSignal?.aborted === true, bound.deadlineMs);
    }

    const requested = new Set(pmids);
    return raw.map((entry) => {
      const record = normalizeRecord(entry);
      if (!record || !requested.has(record.pmid)) {
        throw serviceUnavailable(
          `NIH iCite answered with a record for PMID ${String(entry.pmid)}, which this call did not request.`,
          {
            reason: 'icite_unrequested_record',
            retryable: false,
            unrequestedPmid: String(entry.pmid),
          },
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
