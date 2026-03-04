/**
 * @fileoverview Core HTTP client for NCBI E-utility requests. Handles URL construction,
 * API key injection, GET/POST selection based on payload size, and exponential backoff
 * retries. Uses `fetchWithTimeout` instead of axios for a leaner dependency footprint.
 * @module src/services/ncbi/core/api-client
 */

import { JsonRpcErrorCode, McpError } from '@/types-global/errors.js';
import { logger } from '@/utils/internal/logger.js';
import type { RequestContext } from '@/utils/internal/requestContext.js';
import { fetchWithTimeout } from '@/utils/network/fetchWithTimeout.js';

import { NCBI_EUTILS_BASE_URL, type NcbiRequestOptions, type NcbiRequestParams } from '../types.js';

/** Maximum encoded query-string length before automatically switching to POST. */
const POST_THRESHOLD = 2000;

/**
 * Configuration accepted by {@link NcbiApiClient} at construction time.
 * All NCBI-specific credentials and tuning knobs are passed here rather than
 * read from a global config singleton — the DI container wires these.
 */
export interface NcbiApiClientConfig {
  /** Contact email sent as the `email` parameter (required by NCBI). */
  adminEmail?: string;
  /** NCBI API key (optional but recommended — raises rate limit). */
  apiKey?: string;
  /** Maximum retry attempts on transient failures. */
  maxRetries: number;
  /** Per-request timeout in milliseconds. */
  timeoutMs: number;
  /** Value sent as the `tool` parameter (required by NCBI). */
  toolIdentifier: string;
}

/**
 * Low-level HTTP client for NCBI E-utilities.
 *
 * Responsibilities:
 * - Constructs the full URL (`${NCBI_EUTILS_BASE_URL}/${endpoint}.fcgi`).
 * - Injects `tool`, `email`, and `api_key` from config.
 * - Chooses GET by default; switches to POST when `usePost` is set or the
 *   encoded `id` parameter exceeds {@link POST_THRESHOLD} characters.
 * - Retries with exponential backoff (`2^attempt * 200 ms`).
 * - Returns the raw response body text — parsing is the caller's concern.
 */
export class NcbiApiClient {
  constructor(private readonly config: NcbiApiClientConfig) {}

  /**
   * Makes an HTTP request to an NCBI E-utility endpoint and returns the raw
   * response body as a string.
   *
   * @param endpoint - The E-utility name without `.fcgi` (e.g. "esearch").
   * @param params - E-utility query parameters.
   * @param context - Request context for logging / correlation.
   * @param options - Controls POST override, retmode, etc.
   * @returns The raw response text.
   * @throws {McpError} After all retries are exhausted or on unexpected errors.
   */
  async makeRequest(
    endpoint: string,
    params: NcbiRequestParams,
    context: RequestContext,
    options?: NcbiRequestOptions,
  ): Promise<string> {
    const finalParams = this.buildParams(params);
    const usePost = this.shouldPost(finalParams, options);
    const url = `${NCBI_EUTILS_BASE_URL}/${endpoint}.fcgi`;

    for (let attempt = 0; attempt <= this.config.maxRetries; attempt++) {
      try {
        logger.debug(`NCBI HTTP request: ${usePost ? 'POST' : 'GET'} ${url}`, {
          ...context,
          endpoint,
          attempt: attempt + 1,
        });

        const response = usePost
          ? await this.postRequest(url, finalParams, context)
          : await this.getRequest(url, finalParams, context);

        return await response.text();
      } catch (error: unknown) {
        if (error instanceof McpError) {
          // Don't retry McpErrors that are not transient
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
            {
              ...context,
              endpoint,
              attempt: attempt + 1,
              retryDelay,
              errorMessage: error instanceof Error ? error.message : String(error),
            },
          );
          await new Promise<void>((r) => setTimeout(r, retryDelay));
          continue;
        }

        // All retries exhausted
        if (error instanceof McpError) throw error;

        const msg = error instanceof Error ? error.message : String(error);
        logger.error(
          `NCBI request to ${endpoint} failed after ${this.config.maxRetries} retries.`,
          {
            ...context,
            endpoint,
            errorMessage: msg,
          },
        );
        throw new McpError(
          JsonRpcErrorCode.ServiceUnavailable,
          `NCBI request failed after retries: ${msg}`,
          { endpoint },
        );
      }
    }

    // Unreachable in practice, but satisfies TypeScript's control-flow analysis.
    throw new McpError(JsonRpcErrorCode.InternalError, 'Request failed after all retries.', {
      endpoint,
    });
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Merges user-supplied params with NCBI credential params, filtering out
   * `undefined`/`null` values and stringifying everything.
   */
  private buildParams(params: NcbiRequestParams): Record<string, string> {
    const raw: Record<string, string | number | undefined> = {
      tool: this.config.toolIdentifier,
      email: this.config.adminEmail,
      api_key: this.config.apiKey,
      ...params,
    };

    const result: Record<string, string> = {};
    for (const [key, value] of Object.entries(raw)) {
      if (value !== undefined && value !== null) {
        result[key] = String(value);
      }
    }
    return result;
  }

  /**
   * Determines whether the request should use POST. Uses POST if:
   * - `options.usePost` is explicitly set, or
   * - the total encoded query string exceeds {@link POST_THRESHOLD} characters.
   */
  private shouldPost(params: Record<string, string>, options?: NcbiRequestOptions): boolean {
    if (options?.usePost) return true;
    const queryString = new URLSearchParams(params).toString();
    return queryString.length > POST_THRESHOLD;
  }

  /** Sends a GET request with params encoded in the query string. */
  private getRequest(
    url: string,
    params: Record<string, string>,
    context: RequestContext,
  ): Promise<Response> {
    const qs = new URLSearchParams(params).toString();
    const fullUrl = qs ? `${url}?${qs}` : url;
    return fetchWithTimeout(fullUrl, this.config.timeoutMs, context);
  }

  /** Sends a POST request with params as a URL-encoded form body. */
  private postRequest(
    url: string,
    params: Record<string, string>,
    context: RequestContext,
  ): Promise<Response> {
    const body = new URLSearchParams(params).toString();
    return fetchWithTimeout(url, this.config.timeoutMs, context, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
  }
}
