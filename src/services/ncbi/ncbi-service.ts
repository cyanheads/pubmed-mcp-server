/**
 * @fileoverview High-level service for interacting with NCBI E-utilities.
 * Orchestrates the API client, request queue, and response handler to provide
 * typed methods for each E-utility endpoint. Uses init/accessor pattern.
 * @module src/services/ncbi/ncbi-service
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { logger } from '@cyanheads/mcp-ts-core/utils';

import { getServerConfig } from '@/config/server-config.js';
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
  type NcbiRequestOptions,
  type NcbiRequestParams,
  type XmlPubmedArticleSet,
} from './types.js';

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
  ) {}

  async eSearch(params: NcbiRequestParams): Promise<ESearchResult> {
    const response = await this.performRequest<ESearchResponseContainer>('esearch', params, {
      retmode: 'xml',
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

  async eSummary(params: NcbiRequestParams): Promise<ESummaryResult> {
    const retmode = params.version === '2.0' && params.retmode === 'json' ? 'json' : 'xml';
    const response = await this.performRequest<ESummaryResponseContainer>('esummary', params, {
      retmode,
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

  eLink<T = Record<string, unknown>>(params: NcbiRequestParams): Promise<T> {
    return this.performRequest<T>('elink', params, { retmode: 'xml' });
  }

  async eSpell(params: NcbiRequestParams): Promise<ESpellResult> {
    const response = await this.performRequest<ESpellResponseContainer>('espell', params, {
      retmode: 'xml',
    });

    const spellResult = response.eSpellResult;
    const original = spellResult.Query ?? (params.term as string) ?? '';
    const corrected = spellResult.CorrectedQuery ?? '';

    logger.debug('ESpell result parsed.', {
      original,
      corrected,
      hasSuggestion: corrected.length > 0 && corrected !== original,
    } as never);

    return {
      original,
      corrected: corrected || original,
      hasSuggestion: corrected.length > 0 && corrected !== original,
    };
  }

  eInfo(params: NcbiRequestParams): Promise<unknown> {
    return this.performRequest('einfo', params, { retmode: 'xml' });
  }

  /**
   * Look up PMIDs from partial citation strings via NCBI ECitMatch.
   * Each citation can include journal, year, volume, first page, and author name.
   */
  async eCitMatch(citations: ECitMatchCitation[]): Promise<ECitMatchResult[]> {
    const bdata = citations
      .map(
        (c) =>
          `${c.journal ?? ''}|${c.year ?? ''}|${c.volume ?? ''}|${c.firstPage ?? ''}|${c.authorName ?? ''}|${c.key}|`,
      )
      .join('\r');

    const text = await this.performRequest<string>(
      'ecitmatch.cgi',
      { db: 'pubmed', retmode: 'xml', bdata },
      { retmode: 'text' },
    );

    return text
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
          return {
            key,
            matched: false,
            pmid: null,
            status: 'ambiguous' as const,
            detail: rawOutcome,
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
  }

  /**
   * Convert between article identifiers (DOI, PMID, PMCID) using the PMC ID Converter API.
   * Accepts up to 200 IDs in a single request. Only works for articles in PMC.
   */
  async idConvert(ids: string[], idtype?: string): Promise<IdConvertRecord[]> {
    const params: NcbiRequestParams = {
      ids: ids.join(','),
      format: 'json',
      ...(idtype && { idtype }),
    };

    const text = await this.queue.enqueue(
      () =>
        this.withRetry(
          () => this.apiClient.makeExternalRequest(NCBI_PMC_IDCONV_URL, params),
          'idconv',
        ),
      'idconv',
      params,
    );

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new McpError(
        JsonRpcErrorCode.SerializationError,
        'Failed to parse ID Converter JSON response.',
        { responseSnippet: text.substring(0, 200) },
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
   * Retry wrapper for transient NCBI errors (ServiceUnavailable, Timeout, RateLimited).
   * Non-transient errors (validation, serialization) fail immediately.
   * Uses capped exponential backoff with jitter.
   */
  private async withRetry<T>(execute: () => Promise<T>, label: string): Promise<T> {
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        return await execute();
      } catch (error: unknown) {
        if (error instanceof McpError && !NcbiService.RETRYABLE_CODES.has(error.code)) {
          throw error;
        }

        if (attempt < this.maxRetries) {
          const baseDelay = Math.min(1000 * 2 ** attempt, NcbiService.MAX_BACKOFF_MS);
          const jitter = baseDelay * (0.75 + 0.5 * Math.random()); // ±25%
          const retryDelay = Math.round(jitter);
          logger.warning(
            `NCBI request to ${label} failed. Retrying (${attempt + 1}/${this.maxRetries}) in ${retryDelay}ms.`,
            { endpoint: label, attempt: attempt + 1, retryDelay } as never,
          );
          await new Promise<void>((r) => setTimeout(r, retryDelay));
          continue;
        }

        const attempts = this.maxRetries + 1;
        const msg = error instanceof Error ? error.message : String(error);
        throw new McpError(
          error instanceof McpError ? error.code : JsonRpcErrorCode.ServiceUnavailable,
          `${msg} (failed after ${attempts} attempts)`,
          { endpoint: label, attempts },
        );
      }
    }

    throw new McpError(JsonRpcErrorCode.InternalError, 'Request failed after all retries.', {
      endpoint: label,
    });
  }

  /**
   * Enqueues a request with retry logic that covers both HTTP-level failures
   * (network errors, timeouts) and XML-level errors (NCBI returning 200 OK
   * with an error structure in the response body, e.g. connection resets
   * surfaced as C++ exception traces).
   */
  private performRequest<T>(
    endpoint: string,
    params: NcbiRequestParams,
    options?: NcbiRequestOptions,
  ): Promise<T> {
    return this.queue.enqueue(
      () =>
        this.withRetry(async () => {
          const text = await this.apiClient.makeRequest(endpoint, params, options);
          return this.responseHandler.parseAndHandleResponse<T>(text, endpoint, options);
        }, endpoint),
      endpoint,
      params,
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
  const queue = new NcbiRequestQueue(config.requestDelayMs);
  const responseHandler = new NcbiResponseHandler();
  _service = new NcbiService(apiClient, queue, responseHandler, config.maxRetries);
  logger.info('NCBI service initialized.', {
    toolIdentifier: config.toolIdentifier,
    hasApiKey: !!config.apiKey,
    requestDelayMs: config.requestDelayMs,
  } as never);
}

/** Get the initialized NCBI service. Throws if not initialized. */
export function getNcbiService(): NcbiService {
  if (!_service) throw new Error('NCBI service not initialized. Call initNcbiService() first.');
  return _service;
}
