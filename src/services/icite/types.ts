/**
 * @fileoverview Types and constants for NIH iCite (https://icite.od.nih.gov/),
 * the NIH Office of Portfolio Analysis citation-metrics service. One endpoint
 * is used: `GET /api/pubs?pmids=…&fl=…`, keyless, answering a comma-separated
 * PMID list with one record per PMID it knows.
 * @module src/services/icite/types
 */

/** Base URL for the iCite public API. */
export const ICITE_API_BASE = 'https://icite.od.nih.gov/api';

/**
 * The `fl` allowlist every request sends. iCite drops a misspelled field name
 * without an error, and a request naming no valid field answers with a larger
 * default record, so the list is fixed here and pinned by a test. `cited_by_clin`
 * is fetched only to count it; the unbounded `cited_by` and `references` arrays
 * are never requested.
 */
export const ICITE_FIELDS = [
  'pmid',
  'title',
  'year',
  'journal',
  'doi',
  'is_research_article',
  'is_clinical',
  'provisional',
  'citation_count',
  'citations_per_year',
  'expected_citations_per_year',
  'field_citation_rate',
  'relative_citation_ratio',
  'nih_percentile',
  'apt',
  'human',
  'animal',
  'molecular_cellular',
  'citedByClinicalArticle',
  'cited_by_clin',
] as const;

/**
 * Largest PMID sent to iCite. iCite reads a `pmids` value it does not accept as
 * a PMID — `0`, or a number as large as 2,147,483,647 — as no PMID at all, and a
 * request left with none answers with its first 1,000 records from PMID 1. It
 * answers 1,000,000,000 as an ordinary miss, and PubMed assigns 8-digit PMIDs,
 * so a larger value is reported unavailable without being sent. The bound also
 * keeps a full batch's URL far below the ~4.1 KB at which iCite answers 413.
 */
export const ICITE_MAX_PMID = 1_000_000_000;

/**
 * Total wall-clock budget for one iCite call across every attempt and backoff,
 * so the retry ladder settles inside a client's 60-second request timeout.
 */
export const ICITE_DEADLINE_MS = 50_000;

/** A record as iCite serves it under {@link ICITE_FIELDS}. Every metric can be null or absent. */
export interface IciteRawRecord {
  animal?: unknown;
  apt?: unknown;
  citation_count?: unknown;
  citations_per_year?: unknown;
  cited_by_clin?: unknown;
  citedByClinicalArticle?: unknown;
  doi?: unknown;
  expected_citations_per_year?: unknown;
  field_citation_rate?: unknown;
  human?: unknown;
  is_clinical?: unknown;
  is_research_article?: unknown;
  journal?: unknown;
  molecular_cellular?: unknown;
  nih_percentile?: unknown;
  pmid: number | string;
  provisional?: unknown;
  relative_citation_ratio?: unknown;
  title?: unknown;
  year?: unknown;
}

/**
 * One iCite record, normalized: camelCase names, a null or absent upstream
 * value left absent. `title` and `journal` are iCite's text as served — callers
 * render them for display.
 */
export interface IciteRecord {
  animal?: number;
  apt?: number;
  citationCount?: number;
  citationsPerYear?: number;
  citedByClinicalArticle?: boolean;
  /** Length of `cited_by_clin`; `0` when it is null and `citedByClinicalArticle` is false. */
  clinicalCitationCount?: number;
  doi?: string;
  expectedCitationsPerYear?: number;
  fieldCitationRate?: number;
  human?: number;
  isClinical?: boolean;
  isResearchArticle?: boolean;
  journal?: string;
  molecularCellular?: number;
  nihPercentile?: number;
  /** Canonical PMID — digits, no leading zeros. */
  pmid: string;
  /** Present only beside `relativeCitationRatio`. */
  rcrProvisional?: boolean;
  relativeCitationRatio?: number;
  title?: string;
  year?: number;
}
