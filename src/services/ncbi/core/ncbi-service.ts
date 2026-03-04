/**
 * @fileoverview High-level service for interacting with NCBI E-utilities.
 * Orchestrates the API client, request queue, and response handler to provide
 * typed methods for each E-utility endpoint. Designed for DI — all dependencies
 * are constructor-injected rather than internally instantiated.
 * @module src/services/ncbi/core/ncbi-service
 */

import { logger } from '@/utils/internal/logger.js';
import type { RequestContext } from '@/utils/internal/requestContext.js';

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
} from '../types.js';
import type { NcbiApiClient } from './api-client.js';
import type { NcbiRequestQueue } from './request-queue.js';
import type { NcbiResponseHandler } from './response-handler.js';

/**
 * Facade over NCBI's E-utility suite. Each public method corresponds to a
 * single E-utility endpoint, handles parameter defaults, and returns a
 * typed result after queueing, fetching, and parsing.
 *
 * All I/O flows through the injected {@link NcbiApiClient} (HTTP),
 * {@link NcbiRequestQueue} (rate limiting), and {@link NcbiResponseHandler}
 * (XML/JSON parsing + error extraction).
 */
export class NcbiService {
  constructor(
    private readonly apiClient: NcbiApiClient,
    private readonly queue: NcbiRequestQueue,
    private readonly responseHandler: NcbiResponseHandler,
  ) {}

  // ---------------------------------------------------------------------------
  // Public E-utility methods
  // ---------------------------------------------------------------------------

  /**
   * Searches an NCBI database and returns matching IDs with metadata.
   * Always uses XML retmode for consistent parsing.
   *
   * @param params - Must include `db` and `term` at minimum.
   * @param context - Request context for logging / correlation.
   * @returns Normalized search result with numeric counts and string ID list.
   */
  async eSearch(params: NcbiRequestParams, context: RequestContext): Promise<ESearchResult> {
    const response = await this.performRequest<ESearchResponseContainer>(
      'esearch',
      params,
      context,
      { retmode: 'xml' },
    );

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

  /**
   * Retrieves document summaries for a set of IDs.
   * Unwraps the XML container to return the inner ESummaryResult directly.
   *
   * @param params - Must include `db` and `id`.
   * @param context - Request context.
   */
  async eSummary(params: NcbiRequestParams, context: RequestContext): Promise<ESummaryResult> {
    const retmode = params.version === '2.0' && params.retmode === 'json' ? 'json' : 'xml';
    const response = await this.performRequest<ESummaryResponseContainer>(
      'esummary',
      params,
      context,
      { retmode },
    );
    return response.eSummaryResult;
  }

  /**
   * Fetches full records from an NCBI database.
   * Automatically uses POST when the `id` list exceeds 200 comma-separated IDs.
   *
   * @param params - Must include `db` and `id`.
   * @param context - Request context.
   * @param options - Override retmode or force POST.
   * @typeParam T - Expected parsed result shape. Defaults to `{ PubmedArticleSet?: XmlPubmedArticleSet }`.
   */
  eFetch<T = { PubmedArticleSet?: XmlPubmedArticleSet }>(
    params: NcbiRequestParams,
    context: RequestContext,
    options: NcbiRequestOptions = { retmode: 'xml' },
  ): Promise<T> {
    const usePost =
      options.usePost || (typeof params.id === 'string' && params.id.split(',').length > 200);
    return this.performRequest<T>('efetch', params, context, { ...options, usePost });
  }

  /**
   * Finds links between records in the same or different NCBI databases.
   *
   * @param params - Must include `db`, `dbfrom`, and `id`.
   * @param context - Request context.
   * @typeParam T - Expected parsed result shape. Callers should provide a typed parameter
   *   matching their expected ELink response structure.
   */
  eLink<T = Record<string, unknown>>(
    params: NcbiRequestParams,
    context: RequestContext,
  ): Promise<T> {
    return this.performRequest<T>('elink', params, context, { retmode: 'xml' });
  }

  /**
   * Checks spelling of a search term using NCBI's ESpell service.
   *
   * @param params - Must include `db` and `term`.
   * @param context - Request context.
   * @returns The original query, suggested correction, and whether a suggestion exists.
   */
  async eSpell(params: NcbiRequestParams, context: RequestContext): Promise<ESpellResult> {
    const response = await this.performRequest<ESpellResponseContainer>('espell', params, context, {
      retmode: 'xml',
    });

    const spellResult = response.eSpellResult;
    const original = spellResult.Query ?? (params.term as string) ?? '';
    const corrected = spellResult.CorrectedQuery ?? '';

    logger.debug('ESpell result parsed.', {
      ...context,
      original,
      corrected,
      hasSuggestion: corrected.length > 0 && corrected !== original,
    });

    return {
      original,
      corrected: corrected || original,
      hasSuggestion: corrected.length > 0 && corrected !== original,
    };
  }

  /**
   * Retrieves metadata about an NCBI database (fields, links, etc.).
   *
   * @param params - Optionally includes `db`; omit to list all databases.
   * @param context - Request context.
   */
  eInfo(params: NcbiRequestParams, context: RequestContext): Promise<unknown> {
    return this.performRequest('einfo', params, context, { retmode: 'xml' });
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  /**
   * Shared request pipeline: enqueue -> fetch raw text -> parse & check errors.
   */
  private performRequest<T>(
    endpoint: string,
    params: NcbiRequestParams,
    context: RequestContext,
    options?: NcbiRequestOptions,
  ): Promise<T> {
    return this.queue.enqueue(
      async () => {
        const text = await this.apiClient.makeRequest(endpoint, params, context, options);
        return this.responseHandler.parseAndHandleResponse<T>(text, endpoint, context, options);
      },
      context,
      endpoint,
      params,
    );
  }
}
