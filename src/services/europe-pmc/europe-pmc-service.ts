/**
 * @fileoverview Europe PMC service. Wraps the EPMC REST API with rate-limiting,
 * retries, and JATS XML parsing. `search()` covers keyword discovery across the
 * EPMC corpus (MED/PMC/PPR/PAT/AGR), `fetchRecords()` resolves specific records
 * by `source` + EPMC id, `fullTextXml()` fetches a record's full-text JATS, and
 * `citations()` / `references()` walk EPMC's link graph. The XML parser is built
 * from the same `ORDERED_XML_PARSER_OPTIONS` NCBI's ordered parser uses, so
 * `parsePmcArticle` consumes the result without modification.
 *
 * Every call runs as a retry loop around the shared request queue: each attempt
 * re-enters the queue and waits out its start gap, and a backoff sleep holds no
 * concurrency slot, so callers backing off never stall the calls behind them.
 *
 * A search's retry boundary covers fetch and response classification, so
 * Europe PMC's intermittent empty `{ version }` envelope is retried like an
 * HTTP outage; only a sort or cursor that explains it is reported as bad input.
 * A `relevance` sort is sent as none, and a sort whose keys are not each one
 * field plus `asc`/`desc` fails before the request. Europe PMC answers an
 * unreadable cursor, and a sort it cannot use, with the HTTP 503 it uses for an
 * outage, so a 503 on a caller-supplied cursor or a sort is checked against the
 * first page of the same query — with the sort for the cursor, without it for
 * the sort — and the input is blamed only when a retry draws the 503 again
 * while that first page was served.
 * A search reports the effective query Europe PMC echoes back, or — with no
 * echo — the source-filtered query it sent.
 *
 * Optional service: only constructed when `EUROPEPMC_ENABLED=true` (the
 * default). `getEuropePmcService()` returns `undefined` when disabled so
 * callers can skip the chain step gracefully.
 *
 * @module src/services/europe-pmc/europe-pmc-service
 */

import {
  JsonRpcErrorCode,
  McpError,
  serializationError,
  serviceUnavailable,
  validationError,
} from '@cyanheads/mcp-ts-core/errors';
import {
  defaultIsTransient,
  logger,
  type Pacer,
  requestContextService,
  withRetry,
} from '@cyanheads/mcp-ts-core/utils';
// biome-ignore lint/suspicious/noDeprecatedImports: staying on in-tree XMLValidator — see ncbi/response-handler.ts
import { XMLParser, XMLValidator } from 'fast-xml-parser';

import { getServerConfig } from '@/config/server-config.js';
import { ORDERED_XML_PARSER_OPTIONS } from '@/services/ncbi/parsing/ordered-xml-parser-options.js';
import type { JatsNode, JatsNodeList } from '@/services/ncbi/parsing/pmc-xml-helpers.js';
import { stripInvisibleFormatChars } from '@/services/ncbi/parsing/text-helpers.js';
import { ensureArray } from '@/services/ncbi/parsing/xml-helpers.js';
import { buildSearchQuery, EuropePmcApiClient } from './api-client.js';
import { createEuropePmcRequestQueue } from './request-queue.js';
import type {
  EuropePmcFullTextResult,
  EuropePmcLinksResponse,
  EuropePmcRecordRef,
  EuropePmcRelatedRecord,
  EuropePmcRelatedResult,
  EuropePmcSearchHit,
  EuropePmcSearchParams,
  EuropePmcSearchResponse,
  EuropePmcSearchResult,
  EuropePmcSource,
} from './types.js';

/** Ceiling on one backoff sleep, so a high retry count cannot grow it without bound. */
const MAX_BACKOFF_MS = 30_000;

/**
 * Retry gate: the framework's transient set, narrowed to `McpError`s. The client
 * classifies every upstream failure, so a plain `Error` reaching the loop is a defect
 * or a response that cannot parse — retrying it only repeats it.
 */
const isTransient = (error: unknown): boolean =>
  error instanceof McpError && defaultIsTransient(error);

/**
 * Reshapes an error whose retries ran out: the last attempt's code and message with
 * the attempt count appended, `label`, `attempts`, and the upstream `retryAfter`, so a
 * 429 still tells the caller how long to wait. Only a `ServiceUnavailable` gains
 * `europepmc_unreachable`; a `Timeout` or `RateLimited` keeps its code with no
 * reason, as the OpenAlex service reports them. Anything never retried — a
 * non-transient failure, or a `Retry-After` longer than the backoff cap — passes
 * through unchanged.
 */
function toServiceError(error: unknown, label: string): unknown {
  if (!(error instanceof McpError) || typeof error.data?.retryAttempts !== 'number') return error;
  const last = error.cause instanceof McpError ? error.cause : error;
  const attempts = error.data.retryAttempts;
  return new McpError(
    error.code,
    `${last.message} (failed after ${attempts} attempt${attempts === 1 ? '' : 's'})`,
    {
      ...(error.code === JsonRpcErrorCode.ServiceUnavailable && {
        reason: 'europepmc_unreachable',
      }),
      label,
      attempts,
      ...(last.data?.retryAfter !== undefined && { retryAfter: last.data.retryAfter }),
    },
    { cause: last },
  );
}

/**
 * Europe PMC lookup clause for one record addressed by `source` + EPMC id.
 *
 * The unquoted form is load-bearing: Europe PMC matches zero records for
 * `EXT_ID:"<id>" AND SRC:<source>` — quotes survive on an identifier token only
 * while no `AND SRC:` clause follows it. Callers pass ids through a schema that
 * restricts them to identifier characters, so no escaping is applied here.
 *
 * `SRC:PMC` alone under-resolves: the PMC corpus holds only articles Europe PMC
 * has no PubMed record for. Once an article is indexed in PubMed its canonical
 * record moves to `MED` and carries the PMCID as a field, so `EXT_ID:PMC8371605
 * AND SRC:PMC` matches nothing while `PMCID:PMC8371605` resolves it. OR the two
 * together for `PMC` so both corpus placements resolve from one request. The
 * same asymmetry drove the PMCID branch of `pubmed_fetch_fulltext` (#85); that
 * path can drop the `SRC:PMC` clause outright because it never takes a
 * caller-supplied source, whereas this one must still serve genuine PMC-only
 * records. (#94)
 */
function recordLookupQuery({ epmcId, source }: EuropePmcRecordRef): string {
  const extIdClause = `(EXT_ID:${epmcId} AND SRC:${source})`;
  return source === 'PMC' ? `${extIdClause} OR (PMCID:${epmcId})` : extIdClause;
}

/**
 * The caller's cursor when it asks for a page past the first. `*` and an
 * exactly-empty cursor both read as the first page upstream.
 */
function callerCursor({ cursorMark }: EuropePmcSearchParams): string | undefined {
  return cursorMark && cursorMark !== '*' ? cursorMark : undefined;
}

/** Next step for a cursor Europe PMC cannot read, whichever way it signals that. */
const CURSOR_RECOVERY_HINT =
  "Pass the previous response's `nextCursorMark` verbatim as `cursorMark`, or `*` to restart from the first page.";

/** The sort fields Europe PMC documents. */
const DOCUMENTED_SORT_FIELDS = new Set([
  'P_PDATE_D',
  'CITED',
  'AUTH_FIRST',
  'PUB_YEAR',
  'FIRST_IDATE_D',
]);

/** Next step for a sort Europe PMC cannot use, whichever way it signals that. */
const SORT_RECOVERY_HINT =
  'Use a documented sort (`P_PDATE_D desc`, `CITED desc`, `AUTH_FIRST asc`, `PUB_YEAR desc`, or `FIRST_IDATE_D desc`), or omit `sort` for relevance ranking.';

/** `relevance`, alone or with `desc`: Europe PMC's default order, which it refuses as a sort. */
const RELEVANCE_SORT_RE = /^\s*relevance(?:\s+desc)?\s*$/i;

/** One sort key: a single field token and an `asc`/`desc` direction, any case and spacing. */
const SORT_KEY_RE = /^\s*\S+\s+(?:asc|desc)\s*$/i;

/**
 * The sort a search sends. `relevance` and `relevance desc` read as no sort,
 * since relevance is Europe PMC's default order and it refuses the word as a
 * sort. Any other sort must be a comma-separated list of keys, each one field
 * token plus `asc` or `desc`, or it fails here with no request: Europe PMC
 * refuses every other shape (a key with no direction, an empty key, an extra
 * token) on every request, with the HTTP 503 it also uses for an outage.
 *
 * The field itself is never checked locally: Europe PMC honors some
 * undocumented fields (`ID asc` reorders results), silently ignores others
 * (`SCORE desc`), and refuses the rest with a 503 the search diagnoses by
 * probing the same query unsorted. An empty or whitespace-only sort is no sort,
 * as Europe PMC serves it. (#159, #239)
 */
function effectiveSort(sort: string | undefined): string | undefined {
  if (!sort?.trim() || RELEVANCE_SORT_RE.test(sort)) return;
  if (sort.split(',').every((key) => SORT_KEY_RE.test(key))) return sort;
  throw validationError(
    `Europe PMC cannot use the sort "${sort}" — each comma-separated key needs one field and an \`asc\` or \`desc\` direction.`,
    {
      reason: 'europepmc_invalid_input',
      retryable: false,
      sort,
      recovery: { hint: SORT_RECOVERY_HINT },
    },
  );
}

/**
 * Whether a well-shaped sort is the likely cause of an empty `{ version }`
 * envelope: one of its keys names a field outside the documented set. Europe
 * PMC orders by every key of a valid list (`PUB_YEAR desc, CITED desc`); fields
 * compare case-insensitively, matching its own parsing.
 *
 * Classification only, never a local allowlist: the request has already gone
 * out, and only the envelope decides. Malformed keys never get this far —
 * {@link effectiveSort} rejects them before the request. (#159)
 */
function sortExplainsEnvelope(sort: string): boolean {
  return sort
    .split(',')
    .some((key) => !DOCUMENTED_SORT_FIELDS.has(key.trim().split(/\s+/)[0]?.toUpperCase() ?? ''));
}

/**
 * What a served first-page probe says about a search answered with HTTP 503:
 * the caller's cursor is the likely cause, the sort is, or neither (an outage).
 */
type Http503Suspect = 'cursor' | 'sort' | 'none';

/**
 * Facade over the Europe PMC REST API:
 *   - `search()` — keyword search across MED/PMC/PPR/PAT/AGR.
 *   - `fetchRecords()` — batch lookup of specific records by source + EPMC id.
 *   - `fullTextXml()` — JATS full text for an EPMC record.
 *   - `citations()` / `references()` — EPMC's link graph for a PubMed article.
 *
 * All honor `ctx.signal` for cancellation and retry transient failures with
 * capped exponential backoff plus jitter, each attempt paced through the shared
 * request queue.
 */
export class EuropePmcService {
  private readonly orderedXmlParser: XMLParser;

  constructor(
    private readonly client: EuropePmcApiClient,
    private readonly queue: Pacer,
    private readonly maxRetries: number,
  ) {
    /**
     * EPMC's fullTextXML is JATS Z39.96 — the same DTD PMC uses, consumed by
     * the same `parsePmcArticle` — so it is built from the one shared options
     * constant rather than a second copy that can drift. (#127)
     */
    this.orderedXmlParser = new XMLParser(ORDERED_XML_PARSER_OPTIONS);
  }

  /**
   * Search Europe PMC. Cursor-based pagination — pass `cursorMark: '*'` (or
   * omit) for the first page; pass the returned `nextCursorMark` for the next.
   *
   * The retry boundary covers the fetch and the response classification
   * together, so an empty envelope retries like any other transient failure
   * rather than surfacing after the loop has already returned. (#159)
   *
   * The sort is resolved before any request (see {@link effectiveSort}): a
   * `relevance` sort is dropped, and a malformed one fails with no request.
   *
   * Europe PMC answers both an unreadable cursor and a sort it cannot use with
   * the HTTP 503 it uses for an outage. The first 503 on a search carrying a
   * caller-supplied cursor or a sort draws probes of the same query's first
   * page, and the search is retried either way: one 503 is not enough to tell
   * bad input from a transient outage. With a cursor, the first page with the
   * sort is probed first (#180); when it is served, the cursor is the suspect.
   * Otherwise, with a sort, the first page without the sort is probed — never
   * with the caller's cursor, which Europe PMC binds to the sort that issued
   * it — and when that is served, the sort is the suspect (#239). A later 503
   * fails the search at once as non-retryable input naming the suspect; with
   * no suspect it goes on through the ordinary retry path. A 503 with no retry
   * left is never probed, since nothing could use the answer.
   */
  async search(params: EuropePmcSearchParams): Promise<EuropePmcSearchResult> {
    const { sort: requestedSort, ...rest } = params;
    const sort = effectiveSort(requestedSort);
    const request: EuropePmcSearchParams = { ...rest, ...(sort && { sort }) };
    const cursorMark = callerCursor(request);
    let suspect: Http503Suspect | undefined;
    return await this.runPaced(
      'search',
      request.signal,
      (attempt) => this.searchOnce(request, attempt === this.maxRetries + 1),
      cursorMark === undefined && sort === undefined
        ? undefined
        : async (error, signal, attempt) => {
            if (!(error instanceof McpError) || error.data?.status !== 503) return error;
            if (suspect === undefined) {
              if (attempt <= this.maxRetries) {
                suspect = await this.diagnose503(request, signal);
              }
              return error;
            }
            if (suspect === 'cursor') {
              return validationError(
                `Europe PMC answered cursorMark "${cursorMark}" with HTTP 503 twice but served the first page of the same query — the cursor is most likely invalid or expired.`,
                {
                  reason: 'europepmc_invalid_input',
                  cursorMark,
                  status: 503,
                  retryable: false,
                  recovery: { hint: CURSOR_RECOVERY_HINT },
                },
                { cause: error },
              );
            }
            if (suspect === 'sort') {
              return validationError(
                `Europe PMC answered sort "${sort}" with HTTP 503 twice but served the same query without it — Europe PMC most likely cannot sort by it.`,
                {
                  reason: 'europepmc_invalid_input',
                  sort,
                  status: 503,
                  retryable: false,
                  recovery: { hint: SORT_RECOVERY_HINT },
                },
                { cause: error },
              );
            }
            return error;
          },
    );
  }

  /**
   * Which input, if any, explains a 503 on `request`: the caller's cursor when
   * the first page with the same sort is served, the sort when the first page
   * without it is served, otherwise neither.
   */
  private async diagnose503(
    request: EuropePmcSearchParams,
    signal: AbortSignal,
  ): Promise<Http503Suspect> {
    if (callerCursor(request) !== undefined && (await this.firstPageServed(request, signal))) {
      return 'cursor';
    }
    if (request.sort !== undefined) {
      const { sort: _sort, ...unsorted } = request;
      if (await this.firstPageServed(unsorted, signal)) return 'sort';
    }
    return 'none';
  }

  /**
   * Whether Europe PMC serves the first page of the search in `params`: one
   * request (`cursorMark: '*'`, `pageSize: 1`), paced like any other, with no
   * retries of its own. Any failure reads as not served — except the caller's
   * cancellation, which propagates.
   */
  private async firstPageServed(
    params: EuropePmcSearchParams,
    signal: AbortSignal,
  ): Promise<boolean> {
    try {
      await this.queue.run(
        () => this.searchOnce({ ...params, cursorMark: '*', pageSize: 1, signal }, false),
        { signal },
      );
      return true;
    } catch (error: unknown) {
      if (signal.aborted) throw error;
      return false;
    }
  }

  /**
   * One search attempt: fetch, parse, and classify the body. `isLastAttempt`
   * lets an empty envelope on the last attempt the retry budget allows be
   * attributed to a caller-supplied cursor.
   */
  private async searchOnce(
    params: EuropePmcSearchParams,
    isLastAttempt: boolean,
  ): Promise<EuropePmcSearchResult> {
    const text = await this.client.search(params);

    let parsed: EuropePmcSearchResponse;
    try {
      parsed = JSON.parse(text) as EuropePmcSearchResponse;
    } catch (error: unknown) {
      throw serializationError(
        'Failed to parse Europe PMC search JSON response.',
        {
          reason: 'europepmc_invalid_response',
          responseSnippet: text.substring(0, 200),
        },
        { cause: error },
      );
    }

    /**
     * EPMC surfaces structured input errors (e.g. empty query) via `errMsg`
     * with HTTP 200. Route to ValidationError (non-retryable) so the caller
     * fixes the input instead of looping on the same request.
     */
    const errMsg = typeof parsed.errMsg === 'string' ? parsed.errMsg : undefined;
    if (errMsg) {
      throw validationError(`Europe PMC rejected the request: ${errMsg}`, {
        reason: 'europepmc_invalid_input',
        retryable: false,
        epmcErrCode: parsed.errCode,
        epmcErrMsg: errMsg,
        recovery: { hint: `Europe PMC reported: "${errMsg}". Fix the input and retry.` },
      });
    }

    /**
     * EPMC answers some requests with a `{ version }`-only envelope — no
     * `hitCount`, no `request` echo, no `resultList`. Without this guard the
     * response normalizes to a fake 0-hit success. Every cause produces the
     * byte-identical body, so it is classified by its likely cause:
     *
     * - A sort that EPMC rejects every time (see `sortExplainsEnvelope`) fails
     *   fast as non-retryable input — retrying only adds backoff.
     * - A non-default cursor that draws it on the last attempt the retry budget
     *   allows is most likely invalid or expired; EPMC rejects a malformed
     *   cursor every time. Earlier attempts may have failed another way.
     * - Otherwise it is intermittent upstream noise — valid requests, with or
     *   without a documented sort, draw it on a fraction of calls and succeed
     *   when repeated — so it is thrown as a transient `europepmc_unreachable`
     *   for the retry loop, and never names the caller's input. (#159)
     *
     * Each throw keeps the diagnosis (message) apart from the next step
     * (recovery hint): the framework renders `data.recovery.hint` in
     * `content[]` as a `Recovery:` line only when the message does not already
     * contain it, so one string passed as both would leave the caller the
     * diagnosis and no separate next step. (#75)
     */
    if (
      parsed.hitCount === undefined &&
      parsed.request === undefined &&
      parsed.resultList === undefined
    ) {
      const cursorMark = callerCursor(params);
      if (params.sort && sortExplainsEnvelope(params.sort)) {
        throw validationError(
          `Europe PMC silently rejected the request — most likely the sort "${params.sort}", which uses a field outside the documented set.`,
          {
            reason: 'europepmc_invalid_input',
            retryable: false,
            sort: params.sort,
            ...(cursorMark && { cursorMark }),
            responseSnippet: text.substring(0, 200),
            recovery: { hint: SORT_RECOVERY_HINT },
          },
        );
      }
      if (cursorMark && isLastAttempt) {
        throw validationError(
          `Europe PMC answered the last attempt for cursorMark "${cursorMark}" with an empty response — the cursor is most likely invalid or expired.`,
          {
            reason: 'europepmc_invalid_input',
            retryable: false,
            cursorMark,
            responseSnippet: text.substring(0, 200),
            recovery: { hint: CURSOR_RECOVERY_HINT },
          },
        );
      }
      throw serviceUnavailable(
        'Europe PMC returned an empty response with no hit count or result list.',
        { reason: 'europepmc_unreachable' },
      );
    }

    const hits = ensureArray<EuropePmcSearchHit>(parsed.resultList?.result);
    // Without an echo, report the query actually sent — source filter included —
    // not the caller's bare query, which searches every source. (#150)
    const echoed = parsed.request?.queryString ?? buildSearchQuery(params);

    // EPMC's `request.cursorMark` echo is URL-encoded (the wire form), while
    // `nextCursorMark` in the JSON body is raw. Use the caller's input as the
    // current cursor so the echo is consistent and the equality check below
    // (used to detect "no more pages") compares like-for-like.
    const cursorMark = params.cursorMark ?? '*';
    const nextCursor =
      parsed.nextCursorMark && parsed.nextCursorMark !== cursorMark
        ? parsed.nextCursorMark
        : undefined;

    return {
      hits,
      hitCount: parsed.hitCount ?? hits.length,
      ...(nextCursor && { nextCursorMark: nextCursor }),
      cursorMark,
      query: echoed,
    };
  }

  /**
   * Look up specific records by `source` + EPMC id. One search request covers
   * the whole batch: each ref becomes a `recordLookupQuery` clause, OR-joined
   * into a single query.
   *
   * Returns the hits Europe PMC resolved, in the order it returned them.
   * Unmatched refs are simply absent — callers diff against their own request
   * to report misses rather than getting a padded array back. A `PMC` ref can
   * resolve to a `MED`-source hit that reports the requested PMCID in `pmcid`
   * rather than as its `id`, so that diff matches on the PMCID too.
   */
  async fetchRecords(
    refs: readonly EuropePmcRecordRef[],
    signal?: AbortSignal,
  ): Promise<EuropePmcSearchHit[]> {
    const result = await this.search({
      query: refs.map(recordLookupQuery).join(' OR '),
      resultType: 'core',
      pageSize: refs.length,
      ...(signal && { signal }),
    });
    return result.hits;
  }

  /**
   * Fetch the JATS full text for an EPMC record. Returns:
   *   - `{ kind: 'found', xml, epmcId, source }` — JATS XML string usable
   *     directly by tool callers that hold their own parser, or via
   *     `parseFullTextXml()` for the parsed tree.
   *   - `{ kind: 'not-available', reason }` — EPMC has the record but
   *     publishes no fullTextXML (404 or empty body).
   */
  async fullTextXml(
    epmcId: string,
    source: EuropePmcSource,
    signal?: AbortSignal,
  ): Promise<EuropePmcFullTextResult> {
    const outcome = await this.runPaced(`fullTextXml(${epmcId})`, signal, () =>
      this.client.fullTextXml(epmcId, signal),
    );

    if (outcome.kind === 'not-available') {
      return { kind: 'not-available', reason: outcome.reason };
    }
    return { kind: 'found', xml: outcome.xml, epmcId, source };
  }

  /**
   * Fetch articles that cite the given PubMed article from Europe PMC.
   * Endpoint: GET /MED/{pmid}/citations?page=N&pageSize=N&format=json
   * Returns only records with a PMID; the rest are dropped and counted in
   * `droppedNoPmid`.
   *
   * @param pmid  Source PubMed ID
   * @param pageSize  Number of records to request per page (max 1000 per EPMC)
   * @param page  1-based page number
   * @param signal  Optional AbortSignal
   */
  citations(
    pmid: string,
    pageSize: number,
    page: number,
    signal?: AbortSignal,
  ): Promise<EuropePmcRelatedResult> {
    return this.fetchRelatedLinks(
      () => this.client.citations(pmid, pageSize, page, signal),
      'citations',
      pmid,
      (parsed) => ensureArray<EuropePmcRelatedRecord>(parsed.citationList?.citation),
      signal,
    );
  }

  /**
   * Fetch articles referenced by the given PubMed article from Europe PMC.
   * Endpoint: GET /MED/{pmid}/references?page=N&pageSize=N&format=json
   * Returns only records with a PMID; the rest are dropped and counted in
   * `droppedNoPmid`.
   *
   * @param pmid  Source PubMed ID
   * @param pageSize  Number of records to request per page (max 1000 per EPMC)
   * @param page  1-based page number
   * @param signal  Optional AbortSignal
   */
  references(
    pmid: string,
    pageSize: number,
    page: number,
    signal?: AbortSignal,
  ): Promise<EuropePmcRelatedResult> {
    return this.fetchRelatedLinks(
      () => this.client.references(pmid, pageSize, page, signal),
      'references',
      pmid,
      (parsed) => ensureArray<EuropePmcRelatedRecord>(parsed.referenceList?.reference),
      signal,
    );
  }

  /**
   * Shared logic for citations() and references(): fetch, parse, extract PMIDs.
   * Drops records with no PMID — never mints fake IDs — and reports how many
   * rows that cost, so callers can disclose the gap between Europe PMC's
   * upstream row count and the PubMed-addressable set they actually get back.
   */
  private async fetchRelatedLinks(
    fetch: () => Promise<string>,
    kind: string,
    pmid: string,
    extractRecords: (parsed: EuropePmcLinksResponse) => EuropePmcRelatedRecord[],
    signal?: AbortSignal,
  ): Promise<EuropePmcRelatedResult> {
    const text = await this.runPaced(`${kind}(${pmid})`, signal, fetch);

    let parsed: EuropePmcLinksResponse;
    try {
      parsed = JSON.parse(text) as EuropePmcLinksResponse;
    } catch (error: unknown) {
      throw serializationError(
        `Failed to parse Europe PMC ${kind} JSON response.`,
        {
          reason: 'europepmc_invalid_response',
          responseSnippet: text.substring(0, 200),
        },
        { cause: error },
      );
    }

    /**
     * EPMC surfaces structured input errors via `errMsg` under HTTP 200 — a
     * `pageSize` above its 1000-row ceiling lands here. Route to ValidationError
     * (non-retryable) so the caller fixes the request instead of reading the
     * rejection as an empty result set.
     */
    const errMsg = typeof parsed.errMsg === 'string' ? parsed.errMsg : undefined;
    if (errMsg) {
      throw validationError(`Europe PMC rejected the ${kind} request: ${errMsg}`, {
        reason: 'europepmc_invalid_input',
        retryable: false,
        epmcErrCode: parsed.errCode,
        epmcErrMsg: errMsg,
        recovery: { hint: `Europe PMC reported: "${errMsg}". Fix the input and retry.` },
      });
    }

    const records = extractRecords(parsed);
    const pmids: string[] = [];
    for (const rec of records) {
      // EPMC citation/reference records carry no `pmid` field: for a MED-source
      // record the `id` IS the PubMed ID. Non-MED records (PPR/PMC/PAT/AGR) have
      // no PubMed PMID and are dropped. A `pmid` field is honored if ever present.
      const candidate = rec.pmid ?? (rec.source === 'MED' ? rec.id : undefined);
      const p = candidate?.trim();
      if (p && /^\d+$/.test(p)) pmids.push(p);
    }

    // `hitCount` counts every upstream record, PMID-bearing or not, so it
    // overstates what callers can address whenever a row was dropped. When this
    // page held the whole result set the addressable count is exact; past that
    // only EPMC's own total is available.
    const hitCount = parsed.hitCount ?? records.length;
    const coversWholeSet = records.length >= hitCount;

    return {
      pmids,
      hitCount,
      totalCount: coversWholeSet ? pmids.length : hitCount,
      droppedNoPmid: records.length - pmids.length,
    };
  }

  /**
   * Parse a JATS XML string into the ordered node tree consumed by
   * `parsePmcArticle`. Returns the `<article>` JatsNode, or `undefined` when
   * the body doesn't contain an article element (malformed / empty).
   *
   * Throws `SerializationError` only for fundamentally invalid XML; an
   * article-free but well-formed body returns `undefined` so callers can
   * surface a `no-epmc-fulltext` outcome without a hard failure. Invisible
   * characters a deposit carries inside words are dropped before parsing, as
   * on the PMC EFetch tier. (#224)
   */
  parseFullTextXml(xml: string): JatsNode | undefined {
    const validationResult = XMLValidator.validate(xml.replace(/<!DOCTYPE[^>]*>/gi, ''));
    if (validationResult !== true) {
      throw serializationError('Received invalid XML from Europe PMC.', {
        reason: 'europepmc_invalid_response',
        responseSnippet: xml.substring(0, 200),
      });
    }

    let parsed: unknown;
    try {
      parsed = this.orderedXmlParser.parse(stripInvisibleFormatChars(xml));
    } catch (error: unknown) {
      const parserError = error instanceof Error ? error.message : String(error);
      throw serializationError(
        `Failed to parse Europe PMC fullTextXML response: ${parserError}`,
        {
          reason: 'europepmc_invalid_response',
          parserError,
          responseSnippet: xml.substring(0, 200),
        },
        { cause: error },
      );
    }

    if (!Array.isArray(parsed)) return;
    const nodes = parsed as JatsNodeList;
    return nodes.find((n) => 'article' in n);
  }

  /**
   * Runs one Europe PMC call: a retry loop around the shared request queue, so
   * every attempt re-queues and is re-paced, and a backoff sleep holds no queue
   * slot. No service-level deadline — Europe PMC requests are cheap individually
   * and the caller's signal (typically `ctx.signal`) bounds the total chain; that
   * signal reaches the queue wait and the backoff sleep. `execute` receives the
   * one-based attempt number.
   *
   * `reclassify`, when given, sees each failed attempt after its queue slot is
   * released and before the retry decision, with the attempt's signal and its
   * one-based number. The error it returns is the one the loop judges, so it
   * can end the retries by returning a non-transient error.
   *
   * A caller abort rethrows the caller's own reason; an exhausted failure is
   * reshaped by {@link toServiceError}, after the loop.
   */
  private async runPaced<T>(
    label: string,
    signal: AbortSignal | undefined,
    execute: (attempt: number) => Promise<T>,
    reclassify?: (error: unknown, signal: AbortSignal, attempt: number) => Promise<unknown>,
  ): Promise<T> {
    let attempt = 0;
    try {
      return await withRetry(
        ({ signal: attemptSignal }) => {
          const current = ++attempt;
          return this.queue
            .run(() => execute(current), { signal: attemptSignal })
            .catch(async (failure: unknown) => {
              const error = reclassify
                ? await reclassify(failure, attemptSignal, current)
                : failure;
              if (current <= this.maxRetries && isTransient(error)) {
                logger.warning(
                  `Europe PMC ${label} failed on attempt ${current} of ${this.maxRetries + 1}.`,
                  requestContextService.createRequestContext({
                    operation: 'EuropePmcRetry',
                    additionalContext: {
                      label,
                      attempt: current,
                      error: error instanceof Error ? error.message : String(error),
                    },
                  }),
                );
              }
              throw error;
            });
        },
        {
          maxRetries: this.maxRetries,
          maxDelayMs: MAX_BACKOFF_MS,
          isTransient,
          operation: `Europe PMC ${label}`,
          ...(signal && { signal }),
        },
      );
    } catch (error: unknown) {
      if (signal?.aborted) throw signal.reason;
      throw toServiceError(error, label);
    }
  }
}

// ─── Init / Accessor ────────────────────────────────────────────────────────

let _service: EuropePmcService | undefined;

/**
 * Initialize the Europe PMC service when enabled. Safe to call regardless of
 * config — `EUROPEPMC_ENABLED=false` leaves the service unset so callers see
 * `undefined` and skip the chain step.
 */
export function initEuropePmcService(): void {
  const config = getServerConfig();
  if (!config.europepmcEnabled) {
    logger.info('Europe PMC service disabled (EUROPEPMC_ENABLED=false).');
    return;
  }

  const client = new EuropePmcApiClient({
    timeoutMs: config.europepmcTimeoutMs,
    ...(config.europepmcEmail && { email: config.europepmcEmail }),
  });
  const queue = createEuropePmcRequestQueue(config.europepmcRequestDelayMs);
  _service = new EuropePmcService(client, queue, config.europepmcMaxRetries);
  logger.info(
    'Europe PMC service initialized.',
    requestContextService.createRequestContext({
      operation: 'EuropePmcInit',
      additionalContext: {
        requestDelayMs: config.europepmcRequestDelayMs,
        maxRetries: config.europepmcMaxRetries,
        timeoutMs: config.europepmcTimeoutMs,
        hasEmail: !!config.europepmcEmail,
      },
    }),
  );
}

/** Returns the initialized service, or `undefined` when EPMC is disabled. */
export function getEuropePmcService(): EuropePmcService | undefined {
  return _service;
}
