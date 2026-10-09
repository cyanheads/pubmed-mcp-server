/**
 * @fileoverview Core HTTP client for NCBI E-utility requests. Handles URL construction,
 * API key injection, and GET/POST selection based on payload size. Single-attempt only;
 * retry logic lives in NcbiService.performRequest to cover both HTTP and XML-level errors.
 * @module src/services/ncbi/api-client
 */

import { McpError, serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
import { httpErrorFromResponse, logger, requestContextService } from '@cyanheads/mcp-ts-core/utils';

import { redactRejection } from '@/services/fetch-redaction.js';

import { NCBI_EUTILS_BASE_URL, type NcbiRequestOptions, type NcbiRequestParams } from './types.js';

/** Maximum encoded query-string length before automatically switching to POST. */
const POST_THRESHOLD = 2000;

/**
 * Wraps a non-`McpError` fetch rejection — header or body phase — as `ncbi_unreachable`.
 * The request URL carries `api_key` and the operator's `email`, and a runtime can quote
 * it in the rejection text, so that text is redacted before it becomes the message.
 */
function unreachable(error: unknown, data: Record<string, unknown>): McpError {
  const cause = redactRejection(error);
  const msg = cause instanceof Error ? cause.message : String(cause);
  return serviceUnavailable(
    `NCBI request failed: ${msg}`,
    { reason: 'ncbi_unreachable', ...data },
    { cause },
  );
}

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
    const suffix = endpoint.includes('.') ? '' : '.fcgi';
    const url = `${NCBI_EUTILS_BASE_URL}/${endpoint}${suffix}`;

    try {
      logger.debug(
        `NCBI HTTP request: ${usePost ? 'POST' : 'GET'} ${endpoint}`,
        requestContextService.createRequestContext({
          operation: 'NcbiHttpRequest',
          additionalContext: { endpoint },
        }),
      );

      const response = usePost
        ? await this.postRequest(url, finalParams, options?.signal)
        : await this.getRequest(url, finalParams, options?.signal);

      if (!response.ok) {
        /**
         * The framework classifies both 500 and 501 as ServiceUnavailable, so the
         * transient mesh-layer 500s the eutils proxy returns reach the retry loop in
         * NcbiService.withRetry. A 501 also carries `data.retryable: false`, which that
         * gate honors to fail a Not Implemented response on the first attempt.
         */
        throw await httpErrorFromResponse(response, {
          service: 'NCBI',
          data: { endpoint },
        });
      }

      return await response.text();
    } catch (error: unknown) {
      if (error instanceof McpError) throw error;
      throw unreachable(error, { endpoint });
    }
  }

  /**
   * Make a GET request to a non-eutils NCBI endpoint (e.g., PMC ID Converter).
   * Uses plain fetch (not fetchWithTimeout) so we can capture response bodies on
   * error status codes — fetchWithTimeout throws before the body can be read.
   * Injects tool and email params but not api_key (eutils-specific).
   *
   * Records and error data name the URL's host and the caller's own params,
   * never the request URL, whose query carries the operator's email.
   */
  async makeExternalRequest(
    url: string,
    params: NcbiRequestParams,
    externalSignal?: AbortSignal,
  ): Promise<string> {
    const finalParams: Record<string, string> = {
      tool: this.config.toolIdentifier,
      ...(this.config.adminEmail && { email: this.config.adminEmail }),
    };
    for (const [key, value] of Object.entries(params)) {
      if (value != null) finalParams[key] = String(value);
    }

    const qs = new URLSearchParams(finalParams).toString();
    const fullUrl = qs ? `${url}?${qs}` : url;
    const host = URL.parse(url)?.host;

    const signal = this.buildTimeoutSignal(externalSignal);

    try {
      logger.debug(
        'NCBI external request: GET',
        requestContextService.createRequestContext({
          operation: 'NcbiExternalRequest',
          additionalContext: { host, params },
        }),
      );
      const response = await fetch(fullUrl, { signal });

      const body = await response.text();

      if (!response.ok) {
        throw await httpErrorFromResponse(response, {
          service: 'NCBI',
          captureBody: false,
          data: { host, body: body.substring(0, 500) },
        });
      }

      return body;
    } catch (error: unknown) {
      if (error instanceof McpError) throw error;
      throw unreachable(error, { host });
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

  /**
   * GET an eutils endpoint. Uses plain fetch (not fetchWithTimeout) so {@link makeRequest}
   * holds the failing `Response` and can build the error from it — fetchWithTimeout throws
   * on any non-2xx before the response is reachable.
   */
  private getRequest(
    url: string,
    params: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<Response> {
    const qs = new URLSearchParams(params).toString();
    const fullUrl = qs ? `${url}?${qs}` : url;
    return fetch(fullUrl, { signal: this.buildTimeoutSignal(signal) });
  }

  /** POST an eutils endpoint (large payloads). Plain fetch — see {@link getRequest}. */
  private postRequest(
    url: string,
    params: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<Response> {
    const body = new URLSearchParams(params).toString();
    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      signal: this.buildTimeoutSignal(signal),
    });
  }

  /**
   * Composes the per-request timeout (`AbortSignal.timeout`) with an optional caller
   * signal — whichever aborts first wins. Shared by every fetch path in this client.
   */
  private buildTimeoutSignal(externalSignal?: AbortSignal): AbortSignal {
    const timeoutSignal = AbortSignal.timeout(this.config.timeoutMs);
    return externalSignal ? AbortSignal.any([timeoutSignal, externalSignal]) : timeoutSignal;
  }
}
