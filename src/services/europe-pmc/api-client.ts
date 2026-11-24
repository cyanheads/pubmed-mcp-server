/**
 * @fileoverview Low-level HTTP client for Europe PMC's REST API. Builds URLs and
 * the source-filtered search query (`buildSearchQuery`, shared with the service
 * so it can report the query it sent), injects the optional contact email, and
 * exposes single-attempt search, fullTextXML, and citation-link calls. A search
 * goes out as a GET, or as a form POST to `/searchPOST` once its parameters
 * outgrow a URL. Classifies each endpoint's HTTP failures — a failed search as
 * `europepmc_unreachable`, a search too long to accept as
 * `europepmc_invalid_input`, a fullTextXML 404 as `not-available` — while retry
 * logic lives in `EuropePmcService`.
 * @module src/services/europe-pmc/api-client
 */

import {
  JsonRpcErrorCode,
  McpError,
  serviceUnavailable,
  validationError,
} from '@cyanheads/mcp-ts-core/errors';
import { fetchWithTimeout, logger, requestContextService } from '@cyanheads/mcp-ts-core/utils';

import { readBody } from '@/services/fetch-redaction.js';

import {
  EUROPEPMC_API_BASE,
  EUROPEPMC_DEFAULT_PAGE_SIZE,
  type EuropePmcSearchParams,
} from './types.js';

const USER_AGENT = 'pubmed-mcp-server (+https://github.com/cyanheads/pubmed-mcp-server)';

/**
 * Composed search query-string length, in characters, past which a search is
 * POSTed — the rule `NcbiApiClient` applies to E-utilities. Europe PMC refuses a
 * URL several times longer, with HTTP 400 or 414 at a length that shifts with
 * the request's headers, so the margin absorbs header and config drift on its
 * side.
 */
const POST_THRESHOLD = 2000;

/** Next step for a search Europe PMC refuses as too long. */
const TOO_LONG_RECOVERY_HINT =
  'Shorten the query: split its OR-joined clauses across several searches and merge the hits by `epmcId`.';

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
 * `error.code` or `error.data.status` — see `fullTextXml`'s 404 →
 * `not-available` and `search`'s 413 or 414 → `europepmc_invalid_input`. (#90, #321)
 */
export class EuropePmcApiClient {
  constructor(private readonly config: EuropePmcApiClientConfig) {}

  /**
   * Execute a search. Returns the raw JSON response body as a string so
   * `EuropePmcService` can parse and surface SerializationError consistently
   * when the body is malformed.
   *
   * The search is a GET to `/search` while its composed query string — every
   * parameter it sends, source filter and encoding included — is at most
   * {@link POST_THRESHOLD} characters, and past that a POST of the same string
   * to `/searchPOST` as an `application/x-www-form-urlencoded` body, which
   * Europe PMC answers alike. Every search — each attempt, each first-page probe,
   * each record lookup — makes that choice from its own parameters. (#321)
   *
   * A failed search is never "no match" — a genuine zero-hit
   * query is HTTP 200 with `hitCount: 0`. A 404 is reclassified from its
   * status-mapped `NotFound` to `ServiceUnavailable` so the service retries it.
   * A retryable 5xx keeps its code, so a 504 stays `Timeout`. Only a failure
   * that ends up `ServiceUnavailable` carries `europepmc_unreachable`, the one
   * code that reason is declared for. An upstream
   * `retryAfter` is kept. An HTTP 413 or 414 is the search being too long for
   * Europe PMC to accept: it fails as non-retryable `europepmc_invalid_input`
   * with a hint to split the query. A 429 and every other 4xx pass through
   * unchanged — a bare 400 included, which Europe PMC also answers other
   * malformed requests with — as does a 501, whose `data.retryable: false`
   * keeps it out of the retry loop. (#152, #321)
   */
  async search(params: EuropePmcSearchParams): Promise<string> {
    const form = this.buildSearchForm(params);
    const usePost = form.length > POST_THRESHOLD;
    const ctx = requestContextService.createRequestContext({
      operation: 'EuropePmcSearch',
      additionalContext: { query: params.query },
    });

    let response: Response;
    try {
      response = await fetchWithTimeout(
        usePost ? `${EUROPEPMC_API_BASE}/searchPOST` : `${EUROPEPMC_API_BASE}/search?${form}`,
        this.config.timeoutMs,
        ctx,
        {
          ...(usePost && { method: 'POST', body: form }),
          headers: {
            Accept: 'application/json',
            'User-Agent': USER_AGENT,
            ...(usePost && { 'Content-Type': 'application/x-www-form-urlencoded' }),
          },
          ...(params.signal && { signal: params.signal }),
        },
      );
    } catch (error: unknown) {
      if (error instanceof McpError) {
        const status = error.data?.status;
        if (status === 413 || status === 414) {
          throw validationError(
            `Europe PMC refused the search as too long to accept (HTTP ${status}).`,
            {
              reason: 'europepmc_invalid_input',
              retryable: false,
              status,
              recovery: { hint: TOO_LONG_RECOVERY_HINT },
            },
            { cause: error },
          );
        }
        const isOutage =
          status === 404 ||
          (typeof status === 'number' && status >= 500 && error.data?.retryable !== false);
        if (!isOutage) throw error;
        const code = status === 404 ? JsonRpcErrorCode.ServiceUnavailable : error.code;
        throw new McpError(
          code,
          `Europe PMC search request failed: ${error.message}`,
          {
            ...(code === JsonRpcErrorCode.ServiceUnavailable && {
              reason: 'europepmc_unreachable',
            }),
            status,
            ...(error.data?.retryAfter !== undefined && { retryAfter: error.data.retryAfter }),
          },
          { cause: error },
        );
      }
      const msg = error instanceof Error ? error.message : String(error);
      throw serviceUnavailable(
        `Europe PMC search request failed: ${msg}`,
        { reason: 'europepmc_unreachable' },
        { cause: error },
      );
    }

    return readBody(response.text());
  }

  /**
   * Fetch the JATS full-text XML for an EPMC record by one of its
   * `fullTextIdList` ids — a PMCID, or a preprint's own accession.
   *
   * Europe PMC publishes this XML for its open-access subset only, and answers
   * any other id — a record outside that subset, an unknown id — with HTTP 500,
   * which reads as a transient outage and is retried. So callers request only
   * the id `epmcFullTextId()` returns. A 404 is still read as
   * `{ kind: 'not-available' }`.
   *
   * `fetchWithTimeout` throws a status-mapped `McpError` on any non-2xx rather
   * than resolving with the `Response` (`expectedStatuses` only lowers the log
   * severity), so the 404 arrives here as `McpError(NotFound)` and must be
   * converted in the catch block. Every other failure keeps throwing. (#90, #267)
   */
  async fullTextXml(epmcId: string, signal?: AbortSignal): Promise<EuropePmcFullTextFetchResult> {
    const url = `${EUROPEPMC_API_BASE}/${encodeURIComponent(epmcId)}/fullTextXML`;
    const ctx = requestContextService.createRequestContext({
      operation: 'EuropePmcFullTextXml',
      additionalContext: { epmcId },
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
        { reason: 'europepmc_unreachable', epmcId },
        { cause: error },
      );
    }

    const xml = await readBody(response.text());
    if (!xml.trim()) {
      logger.debug(
        'Europe PMC returned an empty fullTextXML body.',
        requestContextService.createRequestContext({
          operation: 'EuropePmcFullTextXmlEmpty',
          additionalContext: { epmcId },
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
    const ctx = requestContextService.createRequestContext({
      operation,
      additionalContext: { pmid },
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
        `Europe PMC links request failed: ${msg}`,
        { reason: 'europepmc_unreachable' },
        { cause: error },
      );
    }

    return readBody(response.text());
  }

  /**
   * The composed query string a search sends — on the URL of a GET, or as the
   * body of a POST: the source-filtered query, the fixed format, result type,
   * page size, cursor, and the optional sort and contact email, encoded.
   */
  private buildSearchForm(params: EuropePmcSearchParams): string {
    const finalParams: Record<string, string> = {
      query: buildSearchQuery(params),
      format: 'json',
      resultType: params.resultType ?? 'core',
      pageSize: String(params.pageSize ?? EUROPEPMC_DEFAULT_PAGE_SIZE),
      cursorMark: params.cursorMark ?? '*',
    };
    if (params.sort) finalParams.sort = params.sort;
    if (this.config.email) finalParams.email = this.config.email;

    return new URLSearchParams(finalParams).toString();
  }
}

/**
 * The query string a search sends: the caller's query combined with an
 * optional source filter. EPMC's query syntax supports `SRC:"X"` field tokens —
 * the requested sources are OR-joined into a parenthesized clause and ANDed
 * with the caller's query.
 *
 * A single source is repeated (`SRC:"MED" OR SRC:"MED"`). Europe PMC matches
 * nothing when a query is exactly one `EXT_ID` clause ANDed with one `SRC`
 * clause and either value is quoted; the repeated clause matches quoted and
 * unquoted `EXT_ID` alike and returns the same total as a lone clause for any
 * other query. Multi-source clauses are sent as they are. (#175)
 */
export function buildSearchQuery(params: Pick<EuropePmcSearchParams, 'query' | 'sources'>): string {
  const base = params.query.trim();
  if (!params.sources || params.sources.length === 0) return base;
  const sources =
    params.sources.length === 1 ? [...params.sources, ...params.sources] : params.sources;
  const sourceClause = sources.map((s) => `SRC:"${s}"`).join(' OR ');
  return `(${base}) AND (${sourceClause})`;
}
