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
import type {
  ESearchResponseContainer,
  ESearchResult,
  ESpellResponseContainer,
  ESpellResult,
  ESummaryResponseContainer,
  ESummaryResult,
  NcbiRequestOptions,
  NcbiRequestParams,
  XmlPubmedArticleSet,
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
      async () => {
        for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
          try {
            const text = await this.apiClient.makeRequest(endpoint, params, options);
            return this.responseHandler.parseAndHandleResponse<T>(text, endpoint, options);
          } catch (error: unknown) {
            // Only retry transient errors (ServiceUnavailable, Timeout).
            // Validation, serialization, and other errors fail immediately.
            if (error instanceof McpError) {
              if (
                error.code !== JsonRpcErrorCode.ServiceUnavailable &&
                error.code !== JsonRpcErrorCode.Timeout
              ) {
                throw error;
              }
            }

            if (attempt < this.maxRetries) {
              const retryDelay = 1000 * 2 ** attempt; // 1s, 2s, 4s
              logger.warning(
                `NCBI request to ${endpoint} failed. Retrying (${attempt + 1}/${this.maxRetries}) in ${retryDelay}ms.`,
                { endpoint, attempt: attempt + 1, retryDelay } as never,
              );
              await new Promise<void>((r) => setTimeout(r, retryDelay));
              continue;
            }

            // Final attempt exhausted — surface retry context so the caller
            // knows this wasn't a single failed request.
            const attempts = this.maxRetries + 1;
            const msg = error instanceof Error ? error.message : String(error);
            throw new McpError(
              error instanceof McpError ? error.code : JsonRpcErrorCode.ServiceUnavailable,
              `${msg} (failed after ${attempts} attempts)`,
              { endpoint, attempts },
            );
          }
        }

        throw new McpError(JsonRpcErrorCode.InternalError, 'Request failed after all retries.', {
          endpoint,
        });
      },
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
