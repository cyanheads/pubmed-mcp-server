/**
 * @fileoverview Types for the Europe PMC REST API. Covers the search response
 * shape and the fullTextXML endpoint contract, including which search hits it
 * publishes full text for (`epmcFullTextId`) and where each result type keeps
 * the journal name (`epmcJournal`).
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
 * preprints carry no journal; patents lack `authorString`.
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
  /**
   * The ids Europe PMC serves full text under: the PMCID for a `MED` or `PMC`
   * record, the record's own accession for a `PPR` preprint. Present on every
   * open-access record and on some outside the open-access subset, so it is
   * not an availability signal on its own — see {@link epmcFullTextId}.
   */
  fullTextIdList?: { fullTextId?: string[] };
  hasBook?: 'Y' | 'N';
  hasPDF?: 'Y' | 'N';
  /** "Y"/"N" — whether Europe PMC holds text-mined terms for this record. Not a full-text signal. */
  hasTextMinedTerms?: 'Y' | 'N';
  /** EPMC's own record identifier — unique within `source`. Always present. */
  id: string;
  inEPMC?: 'Y' | 'N';
  inPMC?: 'Y' | 'N';
  isOpenAccess?: 'Y' | 'N';
  issue?: string;
  /** The journal block of a `core` result, which carries no `journalTitle`. Read through {@link epmcJournal}. */
  journalInfo?: { journal?: { medlineAbbreviation?: string; title?: string } };
  /** The journal name of a `lite` result; `core` results carry `journalInfo` instead. Read through {@link epmcJournal}. */
  journalTitle?: string;
  journalVolume?: string;
  /** Europe PMC's license string for the record (`cc by`, `cc0`, …). `core` results only; independent of `isOpenAccess`. */
  license?: string;
  pageInfo?: string;
  pmcid?: string;
  pmid?: string;
  pubYear?: string;
  source: EuropePmcSource;
  title?: string;
  [extra: string]: unknown;
}

/**
 * The id to request a hit's `fullTextXML` under, or `undefined` when Europe
 * PMC publishes none for it. Europe PMC serves that XML for its open-access
 * subset only: the hit must carry `isOpenAccess: "Y"` and a `fullTextIdList`
 * id, the PMCID or a preprint's own accession. `inPMC` and `inEPMC` do not
 * decide it, and a request for any other record draws an HTTP 500 that cannot
 * be told apart from an unknown id or an outage — so a hit failing this test is
 * never requested. (#267)
 */
export function epmcFullTextId(hit: EuropePmcSearchHit): string | undefined {
  return hit.isOpenAccess === 'Y' ? hit.fullTextIdList?.fullTextId?.[0] : undefined;
}

/**
 * A hit's journal name, the same for both result types: a `lite` result's
 * `journalTitle`, else a `core` result's `journalInfo.journal`
 * `medlineAbbreviation`, else its full `title`. That fallback reproduces
 * `journalTitle` on every captured record — the full `title` alone matches it
 * only where Europe PMC records no abbreviation, and `isoabbreviation` is absent
 * on Agricola records. `undefined` when the hit carries no journal. (#274)
 */
export function epmcJournal(hit: EuropePmcSearchHit): string | undefined {
  const journal = hit.journalInfo?.journal;
  return hit.journalTitle || journal?.medlineAbbreviation || journal?.title || undefined;
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
  /**
   * Optional sort spec: comma-separated `<field> asc|desc` keys, e.g.
   * `CITED desc` or `PUB_YEAR desc, CITED desc`. `relevance` (Europe PMC's
   * default order) is sent as no sort.
   */
  sort?: string;
  /**
   * Allowed sources, OR-joined into a `(SRC:"MED" OR ...)` clause ANDed with the
   * query. A single source is repeated (`SRC:"MED" OR SRC:"MED"`), since Europe
   * PMC matches nothing for a lone quoted `EXT_ID` clause ANDed with a lone `SRC`
   * clause. (#175)
   */
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
  /** Structured error code on input rejection (e.g. `pageSize` above 1000). */
  errCode?: number | string;
  /** Structured error message on input rejection, returned under HTTP 200. */
  errMsg?: string;
  hitCount?: number;
  nextPageUrl?: string;
  referenceList?: { reference?: EuropePmcRelatedRecord[] | EuropePmcRelatedRecord };
}

/** Normalized result from citations() or references(). */
export interface EuropePmcRelatedResult {
  /** Rows in the fetched page dropped because they carry no PubMed PMID. */
  droppedNoPmid: number;
  /** Europe PMC's own total across the whole result set, every upstream record counted. */
  hitCount: number;
  /** PubMed PMIDs from the fetched page, in the order Europe PMC returned them. */
  pmids: string[];
  /**
   * Total before windowing. When the fetched page covered the whole upstream
   * result set this is the PMID-addressable count (`pmids.length`); otherwise
   * it is Europe PMC's `hitCount`, which counts every upstream record —
   * including the non-`MED` rows that carry no PubMed PMID.
   */
  totalCount: number;
}
