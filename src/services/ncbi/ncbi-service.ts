/**
 * @fileoverview High-level service for interacting with NCBI E-utilities.
 * Orchestrates the API client, request queue, and response handler to provide
 * typed methods for each E-utility endpoint. Uses init/accessor pattern.
 * @module src/services/ncbi/ncbi-service
 */

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

  private performRequest<T>(
    endpoint: string,
    params: NcbiRequestParams,
    options?: NcbiRequestOptions,
  ): Promise<T> {
    return this.queue.enqueue(
      async () => {
        const text = await this.apiClient.makeRequest(endpoint, params, options);
        return this.responseHandler.parseAndHandleResponse<T>(text, endpoint, options);
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
    maxRetries: config.maxRetries,
    timeoutMs: config.timeoutMs,
    ...(config.apiKey && { apiKey: config.apiKey }),
    ...(config.adminEmail && { adminEmail: config.adminEmail }),
  });
  const queue = new NcbiRequestQueue(config.requestDelayMs);
  const responseHandler = new NcbiResponseHandler();
  _service = new NcbiService(apiClient, queue, responseHandler);
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
