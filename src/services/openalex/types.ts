/**
 * @fileoverview Types for the OpenAlex API. Covers the work lookup (PMID resolve),
 * related/referenced works resolution, and cited-by filter endpoints.
 *
 * See https://docs.openalex.org/api-entities/works for the full API.
 * We use three endpoints:
 *   - GET /works/pmid:{pmid}?select=id,related_works,referenced_works
 *   - GET /works?filter=openalex:{id}|{id}&select=id,ids  (batch PMID resolve)
 *   - GET /works?filter=cites:{id}&select=id,ids  (cited_by)
 *
 * @module src/services/openalex/types
 */

/** Base URL for the OpenAlex public API. */
export const OPENALEX_API_BASE = 'https://api.openalex.org';

/**
 * Rows OpenAlex serves per request. The documented `per_page` range is 1-100,
 * and basic paging is additionally bounded by `page × per_page ≤ 10,000` —
 * beyond that the API returns HTTP 400 and demands cursor paging.
 */
export const OPENALEX_MAX_PAGE_SIZE = 100;

/**
 * Values one `filter=openalex:W1|W2|…` OR-clause accepts. A 101st value is
 * rejected with HTTP 400 ("Maximum number of values exceeded"), so a caller
 * resolving a long ID list must split it into batches of this size.
 */
export const OPENALEX_MAX_FILTER_VALUES = 100;

/**
 * Upstream requests one service call may spend reaching the window — pages of
 * the `cites:` filter, or ID-resolution batches. Ten pages of 100 reach 1,000
 * upstream rows: past the 50-row `maxResults` ceiling at any realistic offset,
 * inside the `page × per_page ≤ 10,000` basic-paging limit, and ~3s of
 * sequential requests at the ~0.3s a page costs (~0.7s for a 100-ID batch).
 */
export const OPENALEX_MAX_UPSTREAM_REQUESTS = 10;

/**
 * Identifier block on an OpenAlex Work. Only `openalex` (the OA ID) is always
 * present; `pmid` is absent for non-PubMed records. We only care about PMIDs —
 * any record without one is dropped.
 */
export interface OpenAlexWorkIds {
  doi?: string;
  mag?: string;
  openalex?: string;
  pmid?: string;
  [key: string]: string | undefined;
}

/**
 * Minimal Work record — only fields the service actually uses. We use
 * `select=id,ids` on batch calls to keep responses small.
 */
export interface OpenAlexWork {
  /** OpenAlex canonical ID, e.g. "https://openalex.org/W2960163646". */
  id: string;
  ids?: OpenAlexWorkIds;
  /** IDs of referenced works (this work's reference list). Only present when requested. */
  referenced_works?: string[];
  /** IDs of related works (content-based similarity). Only present when requested. */
  related_works?: string[];
}

/** Top-level response shape from the /works collection endpoint. */
export interface OpenAlexWorksResponse {
  meta?: {
    count?: number;
    page?: number;
    per_page?: number;
    next_cursor?: string;
  };
  results?: OpenAlexWork[];
  [key: string]: unknown;
}

/**
 * Resolved PMID list returned by service methods. `pmids` is indexed in
 * PubMed-addressable rows only — upstream records with no PMID are dropped and
 * counted in `droppedNoPmid`, so a caller can disclose the gap between
 * OpenAlex's own totals and what it can actually return.
 */
export interface OpenAlexRelatedResult {
  /** Candidate rows fetched for this request that carry no PubMed PMID. */
  droppedNoPmid: number;
  pmids: string[];
  /** Paging/batching stopped at its cap before the requested window was covered. */
  reachCapped: boolean;
  /**
   * Exact PubMed-addressable count once the fetchable set is exhausted;
   * OpenAlex's own upstream count while rows remain unfetched.
   */
  totalCount: number;
}
