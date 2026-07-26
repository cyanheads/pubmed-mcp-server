/**
 * @fileoverview Low-level HTTP client for Europe PMC's REST API. Builds URLs,
 * injects the optional contact email, and exposes single-attempt search and
 * fullTextXML calls. Retry logic lives in `EuropePmcService`.
 * @module src/services/europe-pmc/api-client
 */

import { JsonRpcErrorCode, McpError, serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
import { fetchWithTimeout, logger, requestContextService } from '@cyanheads/mcp-ts-core/utils';

import { recoveryFor } from '@/services/error-contracts.js';
import { EUROPEPMC_API_BASE, type EuropePmcSearchParams } from './types.js';

const USER_AGENT = 'pubmed-mcp-server (+https://github.com/cyanheads/pubmed-mcp-server)';

export interface EuropePmcApiClientConfig {
  email?: string;
  timeoutMs: number;
}

/**
 * Outcome of a fullTextXML fetch attempt. Wraps the typed contract so service
 * callers don't need to inspect raw `Response` objects.
 */
export type EuropePmcFullTextFetchResult =
  | { kind: 'found'; xml: string }
  | { kind: 'not-available'; reason: string };

/**
 * Low-level HTTP client for Europe PMC. Single-attempt — retries upstream.
 *
 * Every method here resolves only on HTTP 2xx: `fetchWithTimeout` throws a
 * status-mapped `McpError` for any non-2xx rather than returning the failing
 * `Response`, so a `!response.ok` check after the call can never run. A status
 * that needs graceful handling is converted in the catch block by inspecting
 * `error.code` — see `fullTextXml`'s 404 → `not-available`. (#90)
 */
export class EuropePmcApiClient {
  constructor(private readonly config: EuropePmcApiClientConfig) {}

  /**
   * Execute a search. Returns the raw JSON response body as a string so
   * `EuropePmcService` can parse and surface SerializationError consistently
   * when the body is malformed.
   */
  async search(params: EuropePmcSearchParams): Promise<string> {
    const url = this.buildSearchUrl(params);
    const ctx = requestContextService.createRequestContext({
      operation: 'EuropePmcSearch',
      query: params.query,
    });

    let response: Response;
    try {
      response = await fetchWithTimeout(url, this.config.timeoutMs, ctx, {
        headers: { Accept: 'application/json', 'User-Agent': USER_AGENT },
        ...(params.signal && { signal: params.signal }),
      });
    } catch (error: unknown) {
      if (error instanceof McpError) throw error;
      const msg = error instanceof Error ? error.message : String(error);
      throw serviceUnavailable(
        `Europe PMC search request failed: ${msg}`,
        { reason: 'europepmc_unreachable', ...recoveryFor('europepmc_unreachable') },
        { cause: error },
      );
    }

    return response.text();
  }

  /**
   * Fetch the JATS full-text XML for an EPMC record by its internal id.
   * Returns `{ kind: 'not-available' }` for 404 — EPMC has the record but
   * doesn't publish a full-text XML for it (very common for preprints).
   *
   * `fetchWithTimeout` throws a status-mapped `McpError` on any non-2xx rather
   * than resolving with the `Response` (`expectedStatuses` only lowers the log
   * severity), so the 404 arrives here as `McpError(NotFound)` and must be
   * converted in the catch block. Every other failure keeps throwing. (#90)
   */
  async fullTextXml(epmcId: string, signal?: AbortSignal): Promise<EuropePmcFullTextFetchResult> {
    const url = `${EUROPEPMC_API_BASE}/${encodeURIComponent(epmcId)}/fullTextXML`;
    const ctx = requestContextService.createRequestContext({
      operation: 'EuropePmcFullTextXml',
      epmcId,
    });

    let response: Response;
    try {
      response = await fetchWithTimeout(url, this.config.timeoutMs, ctx, {
        headers: {
          Accept: 'application/xml, text/xml, */*;q=0.5',
          'User-Agent': USER_AGENT,
        },
        expectedStatuses: [404],
        ...(signal && { signal }),
      });
    } catch (error: unknown) {
      if (error instanceof McpError) {
        if (error.code === JsonRpcErrorCode.NotFound) {
          return { kind: 'not-available', reason: 'EPMC has no fullTextXML for this record' };
        }
        throw error;
      }
      const msg = error instanceof Error ? error.message : String(error);
      throw serviceUnavailable(
        `Europe PMC fullTextXML request failed: ${msg}`,
        { reason: 'europepmc_unreachable', epmcId, ...recoveryFor('europepmc_unreachable') },
        { cause: error },
      );
    }

    const xml = await response.text();
    if (!xml.trim()) {
      logger.debug(
        'Europe PMC returned an empty fullTextXML body.',
        requestContextService.createRequestContext({
          operation: 'EuropePmcFullTextXmlEmpty',
          epmcId,
        }),
      );
      return { kind: 'not-available', reason: 'EPMC returned an empty fullTextXML body' };
    }
    return { kind: 'found', xml };
  }

  /**
   * Fetch citations for a PubMed article (articles that cite this one).
   * Endpoint: GET /MED/{pmid}/citations?page=1&pageSize=N&format=json
   * Returns the raw JSON response body as a string.
   */
  citations(pmid: string, pageSize: number, page: number, signal?: AbortSignal): Promise<string> {
    const url = `${EUROPEPMC_API_BASE}/MED/${encodeURIComponent(pmid)}/citations?page=${page}&pageSize=${pageSize}&format=json`;
    return this.fetchLinksJson(url, 'EuropePmcCitations', pmid, signal);
  }

  /**
   * Fetch references from a PubMed article (articles this one cites).
   * Endpoint: GET /MED/{pmid}/references?page=1&pageSize=N&format=json
   * Returns the raw JSON response body as a string.
   */
  references(pmid: string, pageSize: number, page: number, signal?: AbortSignal): Promise<string> {
    const url = `${EUROPEPMC_API_BASE}/MED/${encodeURIComponent(pmid)}/references?page=${page}&pageSize=${pageSize}&format=json`;
    return this.fetchLinksJson(url, 'EuropePmcReferences', pmid, signal);
  }

  /** Helper: fetch a links (citations/references) JSON URL and return the body. */
  private async fetchLinksJson(
    url: string,
    operation: string,
    pmid: string,
    signal?: AbortSignal,
  ): Promise<string> {
    const ctx = requestContextService.createRequestContext({ operation, pmid });

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
        `Europe PMC links request failed: ${msg}`,
        { reason: 'europepmc_unreachable', ...recoveryFor('europepmc_unreachable') },
        { cause: error },
      );
    }

    return response.text();
  }

  private buildSearchUrl(params: EuropePmcSearchParams): string {
    const finalParams: Record<string, string> = {
      query: this.buildQueryString(params),
      format: 'json',
      resultType: params.resultType ?? 'core',
      pageSize: String(params.pageSize ?? 25),
      cursorMark: params.cursorMark ?? '*',
    };
    if (params.sort) finalParams.sort = params.sort;
    if (this.config.email) finalParams.email = this.config.email;

    return `${EUROPEPMC_API_BASE}/search?${new URLSearchParams(finalParams).toString()}`;
  }

  /**
   * Combine the caller's query with an optional source filter. EPMC's query
   * syntax supports `SRC:"X"` field tokens — we OR-join the requested sources
   * into a parenthesized clause and AND it with the user's query.
   */
  private buildQueryString(params: EuropePmcSearchParams): string {
    const base = params.query.trim();
    if (!params.sources || params.sources.length === 0) return base;
    const sourceClause = params.sources.map((s) => `SRC:"${s}"`).join(' OR ');
    return `(${base}) AND (${sourceClause})`;
  }
}
