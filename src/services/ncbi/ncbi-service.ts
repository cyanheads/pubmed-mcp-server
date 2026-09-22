/**
 * @fileoverview High-level service for interacting with NCBI E-utilities.
 * Orchestrates the API client, request queue, and response handler to provide
 * typed methods for each E-utility endpoint. Every call runs as a retry loop around
 * the shared request queue — each attempt re-queued and re-paced — under one total
 * deadline that covers queue wait, attempts, and backoff. Uses init/accessor pattern.
 * @module src/services/ncbi/ncbi-service
 */

import {
  JsonRpcErrorCode,
  McpError,
  rateLimited,
  serializationError,
  timeout,
  validationError,
} from '@cyanheads/mcp-ts-core/errors';
import {
  defaultIsTransient,
  logger,
  type Pacer,
  requestContextService,
  withRetry,
} from '@cyanheads/mcp-ts-core/utils';

import { getServerConfig } from '@/config/server-config.js';
import { recoveryFor } from '@/services/error-contracts.js';
import { NcbiApiClient } from './api-client.js';
import { createNcbiRequestQueue } from './request-queue.js';
import {
  emptyEFetchResultFor,
  NcbiResponseHandler,
  reclassifyNcbiHttpError,
} from './response-handler.js';
import {
  type ECitMatchCitation,
  type ECitMatchResult,
  type ESearchErrorList,
  type ESearchResponseContainer,
  type ESearchResult,
  type ESearchWarningList,
  type ESpellResponseContainer,
  type ESpellResult,
  type ESummaryResponseContainer,
  type ESummaryResult,
  type IdConvertRecord,
  type IdConvertResponse,
  NCBI_PMC_IDCONV_URL,
  type NcbiCallOptions,
  type NcbiRequestOptions,
  type NcbiRequestParams,
  type XmlPubmedArticleSet,
} from './types.js';

/**
 * Per-idType expected-format hints surfaced when PMC ID Converter rejects a
 * batch with HTTP 400. Informational only — NCBI's API is the authority on
 * what's accepted, so a stale hint here only weakens the error message, never
 * blocks a valid request.
 */
const ID_CONVERT_FORMAT_HINTS: Record<string, string> = {
  pmid: 'numeric digits, e.g. "23193287"',
  pmcid: '"PMC" + digits or bare digits, e.g. "PMC3531190" or "3531190"',
  doi: 'starts with "10.", e.g. "10.1093/nar/gks1195"',
};

/** Every member either list can carry; both shapes are all-optional string arrays. */
type ESearchDiagnostics = ESearchErrorList & ESearchWarningList;

/**
 * NCBI collapses a single-entry `ErrorList`/`WarningList` member to a scalar and
 * leaves multi-entry members as arrays, and `parseTagValue` coerces a numeric-looking
 * phrase to a number. Normalize every member to `string[]` so `ESearchErrorList` /
 * `ESearchWarningList` describe what callers actually receive.
 */
function normalizeDiagnosticList(
  list: ESearchDiagnostics | undefined,
): ESearchDiagnostics | undefined {
  if (!list) return;
  const normalized: ESearchDiagnostics = {};
  for (const [key, value] of Object.entries(list)) {
    normalized[key as keyof ESearchDiagnostics] = (Array.isArray(value) ? value : [value]).map(
      String,
    );
  }
  return normalized;
}

/**
 * The tracking token each citation is submitted to ECitMatch under — echoed
 * back verbatim on that citation's response row, and unique within the request.
 *
 * Always the citation's 1-based position, never `ECitMatchCitation.key`. That
 * label is caller-supplied, so reconciling response rows on it collapses two
 * citations carrying the same label onto one row and hands the second
 * citation's PMID to the first (#113); and a `|` inside it shifts the
 * pipe-delimited field layout of the submitted line, so NCBI's echoed row no
 * longer reconciles and a citation it matched comes back as not_found (#125).
 * Keeping the label off the wire entirely removes both.
 */
function wireKeysFor(citations: ECitMatchCitation[]): string[] {
  return citations.map((_, i) => String(i + 1));
}

/** Ceiling on one backoff sleep, so a high retry count cannot grow it without bound. */
const MAX_BACKOFF_MS = 30_000;

/**
 * Margin added to the time left on the deadline when it is offered to the queue as a
 * wait budget. The queue sheds an arrival whose projected wait exceeds the budget, and
 * separately times out a caller still waiting when the budget runs out; that second
 * timer would otherwise land on the same instant as the deadline itself. Setting it just
 * past the deadline leaves expiry to the deadline, so a call still queued when its time
 * is up always reports `ncbi_deadline_exceeded`, never `queue_full`.
 */
const QUEUE_WAIT_MARGIN_MS = 1;

/**
 * Retry gate: the framework's transient set, narrowed to `McpError`s. The client and
 * response handler classify every upstream failure, so a plain `Error` reaching the
 * loop is a defect or a response that cannot parse — retrying it only repeats it.
 */
const isTransient = (error: unknown): boolean =>
  error instanceof McpError && defaultIsTransient(error);

/**
 * Maps what the retry loop throws onto this service's declared failure reasons. Runs
 * outside the loop, so the loop itself still sees the framework's `pacer_shed` — which
 * it never retries — and `retry_deadline_exceeded`.
 *
 * - `pacer_shed` → `queue_full` (RateLimited), keeping the shed's `retryAfter`.
 * - `retry_deadline_exceeded` → `ncbi_deadline_exceeded` (Timeout).
 * - Retries exhausted → the last attempt's code and message with `endpoint` and
 *   `attempts`; a ServiceUnavailable is stamped `ncbi_unreachable`.
 * - Anything else — a failure that was never retried — passes through unchanged.
 */
function toServiceError(error: unknown, endpoint: string, deadlineMs: number): unknown {
  if (!(error instanceof McpError)) return error;
  const data = error.data ?? {};

  if (data.reason === 'pacer_shed') {
    return rateLimited(
      `NCBI request queue is full or cannot start this call before its deadline (${String(data.queueDepth)} requests waiting).`,
      {
        reason: 'queue_full',
        endpoint,
        queueSize: data.queueDepth,
        retryAfter: data.retryAfter,
        ...recoveryFor('queue_full'),
      },
      { cause: error },
    );
  }

  if (data.reason === 'retry_deadline_exceeded') {
    return timeout(
      `NCBI request deadline (${deadlineMs}ms) exceeded`,
      { reason: 'ncbi_deadline_exceeded', deadlineMs, ...recoveryFor('ncbi_deadline_exceeded') },
      { cause: error },
    );
  }

  if (typeof data.retryAttempts !== 'number') return error;
  // Other retryable codes (Timeout, RateLimited) keep their code with no reason.
  const reason =
    error.code === JsonRpcErrorCode.ServiceUnavailable ? 'ncbi_unreachable' : undefined;
  return new McpError(
    error.code,
    error.message,
    {
      ...(reason && { reason, ...recoveryFor(reason) }),
      endpoint,
      attempts: data.retryAttempts,
      ...(data.ncbiErrors !== undefined && { ncbiErrors: data.ncbiErrors }),
    },
    { cause: error.cause ?? error },
  );
}

/**
 * Facade over NCBI's E-utility suite. Each public method corresponds to a
 * single E-utility endpoint.
 */
export class NcbiService {
  constructor(
    private readonly apiClient: NcbiApiClient,
    private readonly queue: Pacer,
    private readonly responseHandler: NcbiResponseHandler,
    private readonly maxRetries: number,
    private readonly totalDeadlineMs: number,
  ) {}

  async eSearch(params: NcbiRequestParams, options?: NcbiCallOptions): Promise<ESearchResult> {
    const response = await this.performRequest<ESearchResponseContainer>('esearch', params, {
      retmode: 'xml',
      ...(options?.signal && { signal: options.signal }),
    });

    const esResult = response.eSearchResult;
    const errorList = normalizeDiagnosticList(esResult.ErrorList);
    const warningList = normalizeDiagnosticList(esResult.WarningList);
    return {
      count: parseInt(esResult.Count, 10) || 0,
      retmax: parseInt(esResult.RetMax, 10) || 0,
      retstart: parseInt(esResult.RetStart, 10) || 0,
      ...(esResult.QueryKey !== undefined && { queryKey: esResult.QueryKey }),
      ...(esResult.WebEnv !== undefined && { webEnv: esResult.WebEnv }),
      idList: (esResult.IdList?.Id ?? []).map(String),
      queryTranslation: esResult.QueryTranslation,
      ...(errorList !== undefined && { errorList }),
      ...(warningList !== undefined && { warningList }),
    };
  }

  async eSummary(params: NcbiRequestParams, options?: NcbiCallOptions): Promise<ESummaryResult> {
    const retmode = params.version === '2.0' && params.retmode === 'json' ? 'json' : 'xml';
    const response = await this.performRequest<ESummaryResponseContainer>('esummary', params, {
      retmode,
      ...(options?.signal && { signal: options.signal }),
    });
    return response.eSummaryResult;
  }

  eFetch<T = { PubmedArticleSet?: XmlPubmedArticleSet }>(
    params: NcbiRequestParams,
    options: NcbiRequestOptions = { retmode: 'xml' },
  ): Promise<T> {
    const usePost =
      options.usePost || (typeof params.id === 'string' && params.id.split(',').length > 200);
    return this.performRequest<T>('efetch', params, { ...options, usePost });
  }

  eLink<T = Record<string, unknown>>(
    params: NcbiRequestParams,
    options?: NcbiCallOptions,
  ): Promise<T> {
    return this.performRequest<T>('elink', params, {
      retmode: 'xml',
      ...(options?.signal && { signal: options.signal }),
    });
  }

  async eSpell(params: NcbiRequestParams, options?: NcbiCallOptions): Promise<ESpellResult> {
    const response = await this.performRequest<ESpellResponseContainer>('espell', params, {
      retmode: 'xml',
      // ESpell echoes the caller's term back in <Query>. The coercing default
      // parser would turn an all-numeric one into a number — and `007` / `1e5`
      // into different text entirely — before this method runs. (#108)
      useVerbatimParser: true,
      ...(options?.signal && { signal: options.signal }),
    });

    const spellResult = response.eSpellResult;
    const original = spellResult.Query ?? (params.term as string) ?? '';
    const corrected = spellResult.CorrectedQuery ?? '';

    logger.debug(
      'ESpell result parsed.',
      requestContextService.createRequestContext({
        operation: 'NcbiESpell',
        additionalContext: {
          original,
          corrected,
          hasSuggestion: corrected.length > 0 && corrected !== original,
        },
      }),
    );

    return {
      original,
      corrected: corrected || original,
      hasSuggestion: corrected.length > 0 && corrected !== original,
    };
  }

  eInfo(params: NcbiRequestParams, options?: NcbiCallOptions): Promise<unknown> {
    return this.performRequest('einfo', params, {
      retmode: 'xml',
      ...(options?.signal && { signal: options.signal }),
    });
  }

  /**
   * Look up PMIDs from partial citation strings via NCBI ECitMatch.
   * Each citation can include journal, year, volume, first page, and author name.
   *
   * Results come back one per submitted citation, in submission order, carrying
   * the caller's `key`. Correlation runs on the wire key (see
   * {@link wireKeysFor}), never on `key` itself — that label is caller-supplied,
   * so it may repeat and may carry characters that break the wire format.
   * (#113, #125)
   */
  async eCitMatch(
    citations: ECitMatchCitation[],
    options?: NcbiCallOptions,
  ): Promise<ECitMatchResult[]> {
    const wireKeys = wireKeysFor(citations);
    const bdata = citations
      .map(
        (c, i) =>
          `${c.journal ?? ''}|${c.year ?? ''}|${c.volume ?? ''}|${c.firstPage ?? ''}|${c.authorName ?? ''}|${wireKeys[i]}|`,
      )
      .join('\r');

    const text = await this.performRequest<string>(
      'ecitmatch.cgi',
      { db: 'pubmed', retmode: 'xml', bdata },
      { retmode: 'text', ...(options?.signal && { signal: options.signal }) },
    );

    const parsed: ECitMatchResult[] = text
      .split(/[\r\n]+/)
      .filter((line) => line.trim().length > 0)
      .map((line) => {
        const parts = line.split('|');
        const key = parts[5]?.trim() ?? '';
        const rawOutcome = parts[6]?.trim() ?? '';

        if (/^\d+$/.test(rawOutcome)) {
          return { key, matched: true, pmid: rawOutcome, status: 'matched' as const };
        }

        if (rawOutcome.startsWith('AMBIGUOUS')) {
          const csv = /^AMBIGUOUS\s+([\d,\s]+)/.exec(rawOutcome)?.[1];
          const candidatePmids = csv
            ? csv
                .split(',')
                .map((p) => p.trim())
                .filter((p) => /^\d+$/.test(p))
            : undefined;
          return {
            key,
            matched: false,
            pmid: null,
            status: 'ambiguous' as const,
            detail: rawOutcome,
            ...(candidatePmids?.length && { candidatePmids }),
          };
        }

        return {
          key,
          matched: false,
          pmid: null,
          status: 'not_found' as const,
          ...(rawOutcome && { detail: rawOutcome }),
        };
      });

    // ECitMatch omits lines for citations it cannot classify. Reconcile on the
    // wire key each citation was submitted under — unique within the request, so
    // one row can never stand in for a second citation — then restore the
    // caller's label on the way out. Every input gets a result row, so callers
    // can rely on results.length === citations.length and on results[i]
    // describing citations[i]. (#54, #113, #125)
    const parsedByWireKey = new Map(parsed.map((r) => [r.key, r]));
    return citations.map((c, i): ECitMatchResult => {
      const row = parsedByWireKey.get(wireKeys[i] ?? '');
      return row
        ? { ...row, key: c.key }
        : { key: c.key, matched: false, pmid: null, status: 'not_found' as const };
    });
  }

  /**
   * Convert between article identifiers (DOI, PMID, PMCID) using the PMC ID Converter API.
   * Accepts up to 200 IDs in a single request. Only works for articles in PMC.
   */
  async idConvert(
    ids: string[],
    idtype?: string,
    options?: NcbiCallOptions,
  ): Promise<IdConvertRecord[]> {
    // A comma is the ID Converter's list delimiter in every encoding, so an
    // element carrying one is indistinguishable from two submitted IDs: the
    // upstream answers 200 with more records than were submitted and the
    // one-record-per-input contract breaks. Reject at the service boundary so
    // no caller can reach the splitting behavior, whichever tool built the
    // input. (#120)
    const packed = ids.find((id) => id.includes(','));
    if (packed !== undefined) {
      throw validationError(
        `PMC ID Converter identifier "${packed}" contains a comma, which the API reads as a list delimiter. Submit one identifier per array element.`,
        { idType: idtype, idCount: ids.length },
      );
    }

    // The PMC ID Converter rejects an entire batch (HTTP 400) when PMC-prefixed
    // and bare-digit PMCIDs are mixed, even though it accepts each form on its
    // own. Canonicalize bare digits to "PMC"+digits so every pmcid batch is
    // homogeneous and resolves like a same-format one. (#73)
    const normalizedIds =
      idtype === 'pmcid'
        ? ids.map((id) => {
            const trimmed = id.trim();
            return /^\d+$/.test(trimmed) ? `PMC${trimmed}` : trimmed;
          })
        : ids;
    const params: NcbiRequestParams = {
      ids: normalizedIds.join(','),
      format: 'json',
      ...(idtype && { idtype }),
    };

    let text: string;
    try {
      text = await this.runPaced('idconv', options?.signal, (signal) =>
        this.apiClient.makeExternalRequest(NCBI_PMC_IDCONV_URL, params, signal),
      );
    } catch (error: unknown) {
      // PMC ID Converter returns 400 (InvalidParams) for malformed inputs and
      // leaks the upstream HTML/text body into `data.body`. Rewrite to a typed
      // validation error with idType-specific guidance and drop the leaky body.
      if (error instanceof McpError && error.code === JsonRpcErrorCode.InvalidParams) {
        const hint = ID_CONVERT_FORMAT_HINTS[idtype ?? ''];
        const message = hint
          ? `PMC ID Converter rejected one or more inputs as malformed (idType="${idtype}"). Expected: ${hint}.`
          : `PMC ID Converter rejected the input as malformed (idType="${idtype ?? 'unspecified'}").`;
        throw validationError(message, { idType: idtype, idCount: ids.length }, { cause: error });
      }
      throw error;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error: unknown) {
      throw serializationError(
        'Failed to parse ID Converter JSON response.',
        {
          reason: 'ncbi_invalid_response',
          responseSnippet: text.substring(0, 200),
          ...recoveryFor('ncbi_invalid_response'),
        },
        { cause: error },
      );
    }

    return (parsed as IdConvertResponse).records ?? [];
  }

  /**
   * Runs one NCBI call: a retry loop around the shared request queue, so every
   * attempt re-queues and is re-paced (and a 429 closes the gate for all callers,
   * not just this one). One deadline covers queue wait, attempts, and backoff. Its
   * signal — joined with the caller's — reaches the queue wait, the backoff sleep,
   * and the HTTP request, and each attempt offers the queue only the time left, so
   * a call that cannot start in time is shed at once instead of waiting it out.
   *
   * A caller abort rethrows the caller's own reason; every other failure is mapped
   * onto this service's reasons by {@link toServiceError}, after the loop.
   */
  private async runPaced<T>(
    endpoint: string,
    callerSignal: AbortSignal | undefined,
    execute: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    let attempt = 0;
    try {
      return await withRetry(
        ({ signal, remainingMs }) => {
          attempt += 1;
          return this.queue
            .run(execute, { signal, maxWaitMs: remainingMs + QUEUE_WAIT_MARGIN_MS })
            .catch((error: unknown) => {
              if (attempt <= this.maxRetries && isTransient(error)) {
                logger.warning(
                  `NCBI request to ${endpoint} failed on attempt ${attempt} of ${this.maxRetries + 1}.`,
                  requestContextService.createRequestContext({
                    operation: 'NcbiRetry',
                    additionalContext: {
                      endpoint,
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
          deadlineMs: this.totalDeadlineMs,
          isTransient,
          operation: `NCBI ${endpoint}`,
          ...(callerSignal && { signal: callerSignal }),
        },
      );
    } catch (error: unknown) {
      if (callerSignal?.aborted) throw callerSignal.reason;
      throw toServiceError(error, endpoint, this.totalDeadlineMs);
    }
  }

  /**
   * One eutils request through {@link runPaced}: fetch, classify, parse. EFetch's
   * all-invalid-ID rejection resolves as the empty set NCBI returns for an unknown
   * ID, and a backend-failure envelope is reclassified as transient so it retries.
   */
  private performRequest<T>(
    endpoint: string,
    params: NcbiRequestParams,
    options?: NcbiRequestOptions,
  ): Promise<T> {
    return this.runPaced(endpoint, options?.signal, async (signal) => {
      const text = await this.apiClient
        .makeRequest(endpoint, params, { ...options, signal })
        .catch((error: unknown) => {
          const empty = emptyEFetchResultFor(error, endpoint, params.db);
          if (empty !== undefined) return empty;
          throw reclassifyNcbiHttpError(error, endpoint);
        });
      return this.responseHandler.parseAndHandleResponse<T>(text, endpoint, options);
    });
  }
}

// ─── Init / Accessor ────────────────────────────────────────────────────────

let _service: NcbiService | undefined;

/** Initialize the NCBI service. Call from `setup()` in createApp. */
export function initNcbiService(): void {
  const config = getServerConfig();
  const apiClient = new NcbiApiClient({
    toolIdentifier: config.toolIdentifier,
    timeoutMs: config.timeoutMs,
    ...(config.apiKey && { apiKey: config.apiKey }),
    ...(config.adminEmail && { adminEmail: config.adminEmail }),
  });
  const queue = createNcbiRequestQueue({
    minStartGapMs: config.requestDelayMs,
    maxConcurrent: config.maxConcurrent,
  });
  const responseHandler = new NcbiResponseHandler();
  _service = new NcbiService(
    apiClient,
    queue,
    responseHandler,
    config.maxRetries,
    config.totalDeadlineMs,
  );
  logger.info(
    'NCBI service initialized.',
    requestContextService.createRequestContext({
      operation: 'NcbiInit',
      additionalContext: {
        toolIdentifier: config.toolIdentifier,
        hasApiKey: !!config.apiKey,
        requestDelayMs: config.requestDelayMs,
        maxConcurrent: config.maxConcurrent,
        totalDeadlineMs: config.totalDeadlineMs,
      },
    }),
  );
}

/** Get the initialized NCBI service. Throws if not initialized. */
export function getNcbiService(): NcbiService {
  if (!_service) throw new Error('NCBI service not initialized. Call initNcbiService() first.');
  return _service;
}
