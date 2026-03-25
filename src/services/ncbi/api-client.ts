/**
 * @fileoverview Core HTTP client for NCBI E-utility requests. Handles URL construction,
 * API key injection, and GET/POST selection based on payload size. Single-attempt only;
 * retry logic lives in NcbiService.performRequest to cover both HTTP and XML-level errors.
 * @module src/services/ncbi/api-client
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { fetchWithTimeout, logger, requestContextService } from '@cyanheads/mcp-ts-core/utils';

import { NCBI_EUTILS_BASE_URL, type NcbiRequestOptions, type NcbiRequestParams } from './types.js';

/** Maximum encoded query-string length before automatically switching to POST. */
const POST_THRESHOLD = 2000;

export interface NcbiApiClientConfig {
  adminEmail?: string;
  apiKey?: string;
  timeoutMs: number;
  toolIdentifier: string;
}

/**
 * Low-level HTTP client for NCBI E-utilities. Constructs URLs, injects credentials,
 * and chooses GET/POST based on payload size. Single-attempt — retry logic lives
 * in {@link NcbiService.performRequest} so it covers both HTTP and XML-level errors.
 */
export class NcbiApiClient {
  constructor(private readonly config: NcbiApiClientConfig) {}

  async makeRequest(
    endpoint: string,
    params: NcbiRequestParams,
    options?: NcbiRequestOptions,
  ): Promise<string> {
    const finalParams = this.buildParams(params);
    const usePost = this.shouldPost(finalParams, options);
    const url = `${NCBI_EUTILS_BASE_URL}/${endpoint}.fcgi`;

    try {
      logger.debug(`NCBI HTTP request: ${usePost ? 'POST' : 'GET'} ${url}`, {
        endpoint,
      } as never);

      const response = usePost
        ? await this.postRequest(url, finalParams)
        : await this.getRequest(url, finalParams);

      if (!response.ok) {
        throw new McpError(
          JsonRpcErrorCode.ServiceUnavailable,
          `NCBI API returned HTTP ${response.status}.`,
          { endpoint, status: response.status },
        );
      }

      return await response.text();
    } catch (error: unknown) {
      if (error instanceof McpError) throw error;

      const msg = error instanceof Error ? error.message : String(error);
      throw new McpError(JsonRpcErrorCode.ServiceUnavailable, `NCBI request failed: ${msg}`, {
        endpoint,
      });
    }
  }

  private buildParams(params: NcbiRequestParams): Record<string, string> {
    const raw: Record<string, string | number | undefined> = {
      tool: this.config.toolIdentifier,
      email: this.config.adminEmail,
      api_key: this.config.apiKey,
      ...params,
    };

    const result: Record<string, string> = {};
    for (const [key, value] of Object.entries(raw)) {
      if (value != null) {
        result[key] = String(value);
      }
    }
    return result;
  }

  private shouldPost(params: Record<string, string>, options?: NcbiRequestOptions): boolean {
    if (options?.usePost) return true;
    const queryString = new URLSearchParams(params).toString();
    return queryString.length > POST_THRESHOLD;
  }

  private getRequest(url: string, params: Record<string, string>): Promise<Response> {
    const qs = new URLSearchParams(params).toString();
    const fullUrl = qs ? `${url}?${qs}` : url;
    const ctx = requestContextService.createRequestContext({ operation: 'NcbiGet', url: fullUrl });
    return fetchWithTimeout(fullUrl, this.config.timeoutMs, ctx);
  }

  private postRequest(url: string, params: Record<string, string>): Promise<Response> {
    const body = new URLSearchParams(params).toString();
    const ctx = requestContextService.createRequestContext({ operation: 'NcbiPost', url });
    return fetchWithTimeout(url, this.config.timeoutMs, ctx, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
  }
}
