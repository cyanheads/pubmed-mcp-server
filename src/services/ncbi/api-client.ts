/**
 * @fileoverview Core HTTP client for NCBI E-utility requests. Handles URL construction,
 * API key injection, GET/POST selection based on payload size, and exponential backoff retries.
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
  maxRetries: number;
  timeoutMs: number;
  toolIdentifier: string;
}

/**
 * Low-level HTTP client for NCBI E-utilities. Constructs URLs, injects credentials,
 * chooses GET/POST, and retries with exponential backoff.
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

    for (let attempt = 0; attempt <= this.config.maxRetries; attempt++) {
      try {
        logger.debug(`NCBI HTTP request: ${usePost ? 'POST' : 'GET'} ${url}`, {
          endpoint,
          attempt: attempt + 1,
        } as never);

        const response = usePost
          ? await this.postRequest(url, finalParams)
          : await this.getRequest(url, finalParams);

        return await response.text();
      } catch (error: unknown) {
        if (error instanceof McpError) {
          if (
            error.code !== JsonRpcErrorCode.ServiceUnavailable &&
            error.code !== JsonRpcErrorCode.Timeout
          ) {
            throw error;
          }
        }

        if (attempt < this.config.maxRetries) {
          const retryDelay = 2 ** attempt * 200;
          logger.warning(
            `NCBI request to ${endpoint} failed. Retrying (${attempt + 1}/${this.config.maxRetries}) in ${retryDelay}ms.`,
            { endpoint, attempt: attempt + 1, retryDelay } as never,
          );
          await new Promise<void>((r) => setTimeout(r, retryDelay));
          continue;
        }

        if (error instanceof McpError) throw error;

        const msg = error instanceof Error ? error.message : String(error);
        logger.error(
          `NCBI request to ${endpoint} failed after ${this.config.maxRetries} retries.`,
          { endpoint, errorMessage: msg } as never,
        );
        throw new McpError(
          JsonRpcErrorCode.ServiceUnavailable,
          `NCBI request failed after retries: ${msg}`,
          { endpoint },
        );
      }
    }

    throw new McpError(JsonRpcErrorCode.InternalError, 'Request failed after all retries.', {
      endpoint,
    });
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
