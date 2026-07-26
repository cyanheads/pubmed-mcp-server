/**
 * @fileoverview Types for the Europe PMC REST API. Covers the search response
 * shape and the fullTextXML endpoint contract.
 *
 * See https://europepmc.org/RestfulWebService for the full API. We use only
 * the search endpoint (`/webservices/rest/search`) and the fullText endpoint
 * (`/webservices/rest/{id}/fullTextXML`).
 *
 * @module src/services/europe-pmc/types
 */

/** Base URL for Europe PMC's RESTful web service. */
export const EUROPEPMC_API_BASE = 'https://www.ebi.ac.uk/europepmc/webservices/rest';

/**
 * Europe PMC source taxonomy. Determines which corpus a record belongs to and
 * what identifier scheme applies. PubMed-derived records carry a `pmid`; PMC
 * preprints carry an EPMC id (`source: PPR`) but no PMID; patents and Agricola
 * records may carry neither.
 */
export type EuropePmcSource = 'MED' | 'PMC' | 'PPR' | 'PAT' | 'AGR' | 'CTX' | 'CBA' | 'ETH' | 'HIR';

/** Allowed sources for `pubmed_europepmc_search` input. */
export const EUROPEPMC_DEFAULT_SOURCES = ['MED', 'PMC', 'PPR'] as const;
export const EUROPEPMC_ALL_SOURCES = ['MED', 'PMC', 'PPR', 'PAT', 'AGR'] as const;

/**
 * Single record from a Europe PMC search response. Only fields the server
 * actually consumes are typed; the upstream payload carries many more under
 * `resultType=core`. Field optionality reflects EPMC's real-world sparsity —
 * preprints often lack `journalTitle`; patents lack `authorString`.
 */
export interface EuropePmcSearchHit {
  abstractText?: string;
  authorString?: string;
  bookOrReportDetails?: unknown;
  citedByCount?: number;
  doi?: string;
  /** ISO date (YYYY-MM-DD) of first index in EPMC. */
  firstIndexDate?: string;
  /** ISO date (YYYY-MM-DD) of publication where known. */
  firstPublicationDate?: string;
  hasBook?: 'Y' | 'N';
  hasPDF?: 'Y' | 'N';
  /** "Y"/"N" — whether EPMC believes a full-text XML is available for this record. */
  hasTextMinedTerms?: 'Y' | 'N';
  /** EPMC's own record identifier — unique within `source`. Always present. */
  id: string;
  inEPMC?: 'Y' | 'N';
  inPMC?: 'Y' | 'N';
  isOpenAccess?: 'Y' | 'N';
  issue?: string;
  journalTitle?: string;
  journalVolume?: string;
  /** Some hits carry their own license. Free-form per EPMC. */
  license?: string;
  pageInfo?: string;
  pmcid?: string;
  pmid?: string;
  pubYear?: string;
  source: EuropePmcSource;
  title?: string;
  [extra: string]: unknown;
}

/** Wrapper for the `resultList` block in a search response. */
export interface EuropePmcResultList {
  result?: EuropePmcSearchHit[] | EuropePmcSearchHit;
}

/**
 * Top-level shape of a Europe PMC JSON search response. EPMC returns scalar
 * `result` when there's exactly one hit; `request.queryString` echoes the
 * effective query so callers can preview what EPMC actually searched.
 */
export interface EuropePmcSearchResponse {
  /** Structured error code on input rejection (e.g. empty query). */
  errCode?: number | string;
  /** Structured error message on input rejection (e.g. empty query). */
  errMsg?: string;
  /** Total matching records across all pages. */
  hitCount?: number;
  /** Cursor token for the next page; absent on the final page. */
  nextCursorMark?: string;
  /** Cursor used for this response, echoed back from the request. */
  request?: {
    queryString?: string;
    resultType?: string;
    cursorMark?: string;
    pageSize?: number;
    sort?: string;
    [extra: string]: unknown;
  };
  resultList?: EuropePmcResultList;
  version?: string;
  [extra: string]: unknown;
}

/** Normalized search result returned by the service layer. */
export interface EuropePmcSearchResult {
  /** Cursor used for this response. Returned as-is so callers can echo it. */
  cursorMark?: string;
  hitCount: number;
  hits: EuropePmcSearchHit[];
  /** Cursor for the next page. `undefined` when no more pages remain. */
  nextCursorMark?: string;
  query: string;
}

/** Parameters accepted by the EPMC search endpoint. */
export interface EuropePmcSearchParams {
  /** EPMC's cursor pagination token; start with `*` for the first page. */
  cursorMark?: string;
  /** Max 100 (per EPMC docs). */
  pageSize?: number;
  query: string;
  /** Default `core` — richest payload with abstract, IDs, dates, license. */
  resultType?: 'core' | 'lite' | 'idlist';
  signal?: AbortSignal;
  /** Optional sort spec, e.g. `FIRST_PIDATE desc`. */
  sort?: string;
  /** Allowed sources, comma-joined into the query as `(SRC:"MED" OR ...)`. */
  sources?: readonly EuropePmcSource[];
}

/**
 * Address of one Europe PMC record: the corpus it lives in plus EPMC's own
 * identifier within that corpus. The pair is the only identifier many PPR,
 * PAT, and AGR records carry — they frequently have no PMID and no DOI.
 */
export interface EuropePmcRecordRef {
  epmcId: string;
  source: EuropePmcSource;
}

/** Outcome of a fullTextXML lookup. */
export type EuropePmcFullTextResult =
  | { kind: 'found'; xml: string; epmcId: string; source: EuropePmcSource }
  | { kind: 'not-available'; reason: string };

/**
 * Single record from the citations or references endpoint.
 * Only fields the server uses are typed; `pmid` is the key field.
 */
export interface EuropePmcRelatedRecord {
  authorString?: string;
  doi?: string;
  id: string;
  journalTitle?: string;
  pmid?: string;
  pubYear?: string;
  source?: string;
  title?: string;
  [key: string]: unknown;
}

/** Top-level shape of a Europe PMC citations/references JSON response. */
export interface EuropePmcLinksResponse {
  citationList?: { citation?: EuropePmcRelatedRecord[] | EuropePmcRelatedRecord };
  hitCount?: number;
  nextPageUrl?: string;
  referenceList?: { reference?: EuropePmcRelatedRecord[] | EuropePmcRelatedRecord };
}

/** Normalized result from citations() or references(). */
export interface EuropePmcRelatedResult {
  pmids: string[];
  totalCount: number;
}
