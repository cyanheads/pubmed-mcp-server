/**
 * @fileoverview High-level service for interacting with NCBI E-utilities.
 * Orchestrates the API client, request queue, and response handler to provide
 * typed methods for each E-utility endpoint. Uses init/accessor pattern.
 * @module src/services/ncbi/ncbi-service
 */

import {
  internalError,
  JsonRpcErrorCode,
  McpError,
  serializationError,
  timeout,
  validationError,
} from '@cyanheads/mcp-ts-core/errors';
import { logger, requestContextService } from '@cyanheads/mcp-ts-core/utils';

import { getServerConfig } from '@/config/server-config.js';
import { recoveryFor } from '@/services/error-contracts.js';
import { NcbiApiClient } from './api-client.js';
import { NcbiRequestQueue } from './request-queue.js';
import { NcbiResponseHandler } from './response-handler.js';
import {
  type ECitMatchCitation,
  type ECitMatchResult,
  type ESearchResponseContainer,
  type ESearchResult,
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
  pmcid: '"PMC" + digits, e.g. "PMC3531190"',
  doi: 'starts with "10.", e.g. "10.1093/nar/gks1195"',
};

/** Sentinel reason used when the service-level deadline expires. */
class NcbiDeadlineExceeded extends Error {
  constructor(deadlineMs: number) {
    super(`NCBI request deadline (${deadlineMs}ms) exceeded`);
    this.name = 'NcbiDeadlineExceeded';
  }
}

/**
 * Sleep that resolves after `ms`, or rejects immediately if `signal` aborts.
 * Cleans up both timer and listener when either side wins.
 */
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
 * Facade over NCBI's E-utility suite. Each public method corresponds to a
 * single E-utility endpoint.
 */
export class NcbiService {
  constructor(
    private readonly apiClient: NcbiApiClient,
    private readonly queue: NcbiRequestQueue,
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
    return {
      count: parseInt(esResult.Count, 10) || 0,
      retmax: parseInt(esResult.RetMax, 10) || 0,
      retstart: parseInt(esResult.RetStart, 10) || 0,
      ...(esResult.QueryKey !== undefined && { queryKey: esResult.QueryKey }),
      ...(esResult.WebEnv !== undefined && { webEnv: esResult.WebEnv }),
      idList: (esResult.IdList?.Id ?? []).map(String),
      queryTranslation: esResult.QueryTranslation,
      ...(esResult.ErrorList !== undefined && { errorList: esResult.ErrorList }),
      ...(esResult.WarningList !== undefined && { warningList: esResult.WarningList }),
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
      ...(options?.signal && { signal: options.signal }),
    });

    const spellResult = response.eSpellResult;
    const original = spellResult.Query ?? (params.term as string) ?? '';
    const corrected = spellResult.CorrectedQuery ?? '';

    logger.debug(
      'ESpell result parsed.',
      requestContextService.createRequestContext({
        operation: 'NcbiESpell',
        original,
        corrected,
        hasSuggestion: corrected.length > 0 && corrected !== original,
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
   */
  async eCitMatch(
    citations: ECitMatchCitation[],
    options?: NcbiCallOptions,
  ): Promise<ECitMatchResult[]> {
    const bdata = citations
      .map(
        (c) =>
          `${c.journal ?? ''}|${c.year ?? ''}|${c.volume ?? ''}|${c.firstPage ?? ''}|${c.authorName ?? ''}|${c.key}|`,
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

    // ECitMatch omits lines for citations it cannot classify. Reconcile against
    // the submitted citations so every input gets a result row — callers can rely
    // on results.length === citations.length and correlate by key.
    const parsedByKey = new Map(parsed.map((r) => [r.key, r]));
    return citations.map(
      (c): ECitMatchResult =>
        parsedByKey.get(c.key) ?? {
          key: c.key,
          matched: false,
          pmid: null,
          status: 'not_found' as const,
        },
    );
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
    // Normalize PMCID inputs: bare numeric IDs (e.g. "3531190") get "PMC" prefixed
    // so mixed PMC-prefixed and bare IDs don't trigger a 400 from the converter.
    const normalized = ids.map((id) =>
      idtype === 'pmcid' && /^\d+$/.test(id) ? `PMC${id}` : id,
    );
    const params: NcbiRequestParams = {
      ids: normalized.join(','),
      format: 'json',
      ...(idtype && { idtype }),
    };

    let text: string;
    try {
      text = await this.runWithDeadline(
        (signal) =>
          this.queue.enqueue(
            () =>
              this.withRetry(
                () => this.apiClient.makeExternalRequest(NCBI_PMC_IDCONV_URL, params, signal),
                'idconv',
                signal,
              ),
            'idconv',
            params,
            signal,
          ),
        options?.signal,
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

  /** Error codes that are transient and worth retrying with backoff. */
  private static readonly RETRYABLE_CODES = new Set([
    JsonRpcErrorCode.ServiceUnavailable,
    JsonRpcErrorCode.Timeout,
    JsonRpcErrorCode.RateLimited,
  ]);

  /** Maximum backoff delay per retry (prevents exponential explosion at high retry counts). */
  private static readonly MAX_BACKOFF_MS = 30_000;

  /**
   * Wraps a task with a service-level deadline. Returns a combined AbortSignal
   * (internal deadline OR'd with the caller's `ctx.signal`, if any) that the
   * task must forward to both the HTTP call and any backoff sleep so cancellation
   * interrupts the full retry chain — not just the next attempt.
   */
  private async runWithDeadline<T>(
    task: (signal: AbortSignal) => Promise<T>,
    callerSignal?: AbortSignal,
  ): Promise<T> {
    const deadlineController = new AbortController();
    const deadlineTimer = setTimeout(
      () => deadlineController.abort(new NcbiDeadlineExceeded(this.totalDeadlineMs)),
      this.totalDeadlineMs,
    );

    const signal = callerSignal
      ? AbortSignal.any([deadlineController.signal, callerSignal])
      : deadlineController.signal;

    try {
      return await task(signal);
    } catch (error: unknown) {
      if (error instanceof NcbiDeadlineExceeded) {
        throw timeout(
          error.message,
          {
            reason: 'ncbi_deadline_exceeded',
            deadlineMs: this.totalDeadlineMs,
            ...recoveryFor('ncbi_deadline_exceeded'),
          },
          { cause: error },
        );
      }
      throw error;
    } finally {
      clearTimeout(deadlineTimer);
    }
  }

  /**
   * Retry wrapper for transient NCBI errors (ServiceUnavailable, Timeout, RateLimited).
   * Non-transient McpErrors and unexpected plain Errors fail immediately.
   * Uses capped exponential backoff with jitter. Backoff sleep is abortable via
   * `signal`, so deadline expiration or caller cancel short-circuits the chain.
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

        if (!(error instanceof McpError)) {
          throw error;
        }

        if (!NcbiService.RETRYABLE_CODES.has(error.code)) {
          throw error;
        }

        if (attempt < this.maxRetries) {
          const baseDelay = Math.min(1000 * 2 ** attempt, NcbiService.MAX_BACKOFF_MS);
          const jitter = baseDelay * (0.75 + 0.5 * Math.random()); // ±25%
          const retryDelay = Math.round(jitter);
          logger.warning(
            `NCBI request to ${label} failed. Retrying (${attempt + 1}/${this.maxRetries}) in ${retryDelay}ms.`,
            requestContextService.createRequestContext({
              operation: 'NcbiRetry',
              endpoint: label,
              attempt: attempt + 1,
              retryDelay,
            }),
          );
          await abortableSleep(retryDelay, signal);
          continue;
        }

        const attempts = this.maxRetries + 1;
        const msg = error instanceof Error ? error.message : String(error);
        // Tag transient ServiceUnavailable retries-exhausted with `ncbi_unreachable` so
        // tool callers can switch on a stable reason. Other retryable codes (Timeout,
        // RateLimited) keep their original code with no reason — `ncbi_deadline_exceeded`
        // and `queue_full` are stamped at their own throw sites.
        const reason =
          error.code === JsonRpcErrorCode.ServiceUnavailable ? 'ncbi_unreachable' : undefined;
        throw new McpError(
          error.code,
          `${msg} (failed after ${attempts} attempts)`,
          {
            ...(reason && { reason, ...recoveryFor(reason) }),
            endpoint: label,
            attempts,
          },
          { cause: error },
        );
      }
    }

    throw internalError('Request failed after all retries.', {
      reason: 'ncbi_unreachable',
      endpoint: label,
      ...recoveryFor('ncbi_unreachable'),
    });
  }

  /**
   * Runs a request under a service-level deadline that bounds queue wait time
   * + retry chain + HTTP execution. The deadline is constructed *outside* the
   * queue so a backlog can't burn a request's budget before it even dispatches.
   *
   * The combined deadline+caller signal is threaded into the queue (cancels a
   * still-waiting task), the retry chain (cancels pending backoff sleeps),
   * and the HTTP fetch (cancels wedged requests).
   */
  private performRequest<T>(
    endpoint: string,
    params: NcbiRequestParams,
    options?: NcbiRequestOptions,
  ): Promise<T> {
    return this.runWithDeadline(
      (signal) =>
        this.queue.enqueue(
          () =>
            this.withRetry(
              async () => {
                const text = await this.apiClient.makeRequest(endpoint, params, {
                  ...options,
                  signal,
                });
                return this.responseHandler.parseAndHandleResponse<T>(text, endpoint, options);
              },
              endpoint,
              signal,
            ),
          endpoint,
          params,
          signal,
        ),
      options?.signal,
    );
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
  const queue = new NcbiRequestQueue(config.requestDelayMs, config.maxConcurrent);
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
      toolIdentifier: config.toolIdentifier,
      hasApiKey: !!config.apiKey,
      requestDelayMs: config.requestDelayMs,
      maxConcurrent: config.maxConcurrent,
      totalDeadlineMs: config.totalDeadlineMs,
    }),
  );
}

/** Get the initialized NCBI service. Throws if not initialized. */
export function getNcbiService(): NcbiService {
  if (!_service) throw new Error('NCBI service not initialized. Call initNcbiService() first.');
  return _service;
}
