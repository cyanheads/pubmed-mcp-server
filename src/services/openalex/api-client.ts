/**
 * @fileoverview Low-level HTTP client for the OpenAlex API. Builds URLs,
 * injects the optional polite-pool email, and exposes single-attempt fetch
 * calls. Retry logic lives in `OpenAlexService`.
 * @module src/services/openalex/api-client
 */

import { McpError, serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
import {
  fetchWithTimeout,
  httpErrorFromResponse,
  logger,
  requestContextService,
} from '@cyanheads/mcp-ts-core/utils';

import { recoveryFor } from '@/services/error-contracts.js';
import { OPENALEX_API_BASE, type OpenAlexWork, type OpenAlexWorksResponse } from './types.js';

const USER_AGENT = 'pubmed-mcp-server (+https://github.com/cyanheads/pubmed-mcp-server)';

export interface OpenAlexApiClientConfig {
  /** Admin email for OpenAlex polite pool (mailto= param). Optional. */
  email?: string;
  timeoutMs: number;
}

/** Low-level HTTP client for OpenAlex. Single-attempt — retries upstream. */
export class OpenAlexApiClient {
  constructor(private readonly config: OpenAlexApiClientConfig) {}

  /**
   * Fetch a single work by PMID. Returns the work record (with related_works
   * and referenced_works populated) or null when the PMID is unknown.
   */
  async getWorkByPmid(pmid: string, signal?: AbortSignal): Promise<OpenAlexWork | null> {
    const params = new URLSearchParams({
      select: 'id,related_works,referenced_works',
    });
    if (this.config.email) params.set('mailto', this.config.email);

    const url = `${OPENALEX_API_BASE}/works/pmid:${encodeURIComponent(pmid)}?${params.toString()}`;
    const ctx = requestContextService.createRequestContext({
      operation: 'OpenAlexGetWorkByPmid',
      pmid,
    });

    let response: Response;
    try {
      response = await fetchWithTimeout(url, this.config.timeoutMs, ctx, {
        headers: { Accept: 'application/json', 'User-Agent': USER_AGENT },
        expectedStatuses: [404],
        ...(signal && { signal }),
      });
    } catch (error: unknown) {
      if (error instanceof McpError) throw error;
      const msg = error instanceof Error ? error.message : String(error);
      throw serviceUnavailable(
        `OpenAlex request failed: ${msg}`,
        { reason: 'openalex_unreachable', ...recoveryFor('openalex_unreachable') },
        { cause: error },
      );
    }

    if (response.status === 404) return null;

    if (!response.ok) {
      throw await httpErrorFromResponse(response, {
        service: 'OpenAlex',
        data: { url, reason: 'openalex_unreachable', ...recoveryFor('openalex_unreachable') },
      });
    }

    const text = await response.text();
    try {
      return JSON.parse(text) as OpenAlexWork;
    } catch (error: unknown) {
      throw serviceUnavailable(
        'OpenAlex returned a non-JSON body.',
        { reason: 'openalex_invalid_response', ...recoveryFor('openalex_invalid_response') },
        { cause: error },
      );
    }
  }

  /**
   * Batch-resolve a list of OpenAlex work IDs to their PMIDs.
   * Uses the filter=openalex:W1|W2|... endpoint with select=id,ids.
   * Returns only records that carry a `pmid` field.
   */
  resolveOaIdsToPmids(oaIds: string[], signal?: AbortSignal): Promise<OpenAlexWork[]> {
    if (oaIds.length === 0) return Promise.resolve([]);

    // Strip https://openalex.org/ prefix if present — filter expects bare IDs
    const bareIds = oaIds.map((id) =>
      id.startsWith('https://openalex.org/') ? id.slice('https://openalex.org/'.length) : id,
    );

    const params = new URLSearchParams({
      filter: `openalex:${bareIds.join('|')}`,
      select: 'id,ids',
      per_page: String(Math.min(oaIds.length, 200)),
    });
    if (this.config.email) params.set('mailto', this.config.email);

    const url = `${OPENALEX_API_BASE}/works?${params.toString()}`;
    return this.fetchWorksList(url, 'OpenAlexResolveOaIds', signal);
  }

  /**
   * Fetch works that cite a given OpenAlex work ID (the cited_by relationship).
   * Returns up to `perPage` records with PMIDs.
   */
  async getCitedBy(
    oaId: string,
    perPage: number,
    signal?: AbortSignal,
  ): Promise<{ works: OpenAlexWork[]; totalCount: number }> {
    // Strip full URL prefix if needed
    const bareId = oaId.startsWith('https://openalex.org/')
      ? oaId.slice('https://openalex.org/'.length)
      : oaId;

    const params = new URLSearchParams({
      filter: `cites:${bareId}`,
      select: 'id,ids',
      per_page: String(Math.min(perPage, 200)),
    });
    if (this.config.email) params.set('mailto', this.config.email);

    const url = `${OPENALEX_API_BASE}/works?${params.toString()}`;
    const ctx = requestContextService.createRequestContext({
      operation: 'OpenAlexGetCitedBy',
      oaId: bareId,
    });

    let response: Response;
    try {
      response = await fetchWithTimeout(url, this.config.timeoutMs, ctx, {
        headers: { Accept: 'application/json', 'User-Agent': USER_AGENT },
        ...(signal && { signal }),
      });
    } catch (error: unknown) {
      if (error instanceof McpError) throw error;
      const msg = error instanceof Error ? error.message : String(error);
      throw serviceUnavailable(
        `OpenAlex request failed: ${msg}`,
        { reason: 'openalex_unreachable', ...recoveryFor('openalex_unreachable') },
        { cause: error },
      );
    }

    if (!response.ok) {
      throw await httpErrorFromResponse(response, {
        service: 'OpenAlex',
        data: { url, reason: 'openalex_unreachable', ...recoveryFor('openalex_unreachable') },
      });
    }

    const text = await response.text();
    let parsed: OpenAlexWorksResponse;
    try {
      parsed = JSON.parse(text) as OpenAlexWorksResponse;
    } catch (error: unknown) {
      throw serviceUnavailable(
        'OpenAlex returned a non-JSON body.',
        { reason: 'openalex_invalid_response', ...recoveryFor('openalex_invalid_response') },
        { cause: error },
      );
    }

    logger.debug(
      'OpenAlex cited_by response',
      requestContextService.createRequestContext({
        operation: 'OpenAlexGetCitedByDone',
        oaId: bareId,
        totalCount: parsed.meta?.count,
        resultCount: parsed.results?.length,
      }),
    );

    return {
      works: parsed.results ?? [],
      totalCount: parsed.meta?.count ?? 0,
    };
  }

  /** Helper: fetch a /works?... URL and return parsed results. */
  private async fetchWorksList(
    url: string,
    operation: string,
    signal?: AbortSignal,
  ): Promise<OpenAlexWork[]> {
    const ctx = requestContextService.createRequestContext({ operation });

    let response: Response;
    try {
      response = await fetchWithTimeout(url, this.config.timeoutMs, ctx, {
        headers: { Accept: 'application/json', 'User-Agent': USER_AGENT },
        ...(signal && { signal }),
      });
    } catch (error: unknown) {
      if (error instanceof McpError) throw error;
      const msg = error instanceof Error ? error.message : String(error);
      throw serviceUnavailable(
        `OpenAlex request failed: ${msg}`,
        { reason: 'openalex_unreachable', ...recoveryFor('openalex_unreachable') },
        { cause: error },
      );
    }

    if (!response.ok) {
      throw await httpErrorFromResponse(response, {
        service: 'OpenAlex',
        data: { url, reason: 'openalex_unreachable', ...recoveryFor('openalex_unreachable') },
      });
    }

    const text = await response.text();
    let parsed: OpenAlexWorksResponse;
    try {
      parsed = JSON.parse(text) as OpenAlexWorksResponse;
    } catch (error: unknown) {
      throw serviceUnavailable(
        'OpenAlex returned a non-JSON body.',
        { reason: 'openalex_invalid_response', ...recoveryFor('openalex_invalid_response') },
        { cause: error },
      );
    }

    return parsed.results ?? [];
  }
}
