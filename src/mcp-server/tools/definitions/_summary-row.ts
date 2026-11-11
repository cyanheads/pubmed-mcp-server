/**
 * @fileoverview The brief-summary row `pubmed_search_articles` summaries and
 * `pubmed_find_related` rows share: one schema, one set of field descriptions,
 * and one builder from the ESummary parse ({@link ParsedBriefSummary}), so the
 * two tools carry the same identifiers, links, and dates. Each tool keeps its
 * own `format()` layout. (#293, #297)
 * @module src/mcp-server/tools/definitions/_summary-row
 */

import { z } from '@cyanheads/mcp-ts-core';
import type { ParsedBriefSummary } from '@/services/ncbi/types.js';

/** One row: every field but `pmid` and `pubmedUrl` is absent when ESummary has no value for it. */
export const summaryRowSchema = z.object({
  pmid: z.string().describe('PubMed ID'),
  title: z.string().optional().describe('Article title'),
  authors: z
    .string()
    .optional()
    .describe(
      "Author string — the first three of the record's own authors, then \"et al.\". On an NCBI Bookshelf chapter these are the chapter's authors; the book's editors are in `editors`.",
    ),
  source: z
    .string()
    .optional()
    .describe(
      'Journal the article appeared in. Absent on an NCBI Bookshelf record, which has no journal — its venue is in `bookTitle` and `publisherName` instead, and `docType` says which kind of record it is.',
    ),
  bookTitle: z
    .string()
    .optional()
    .describe(
      'Title of the book an NCBI Bookshelf record belongs to, e.g. "GeneReviews(®)". Present instead of `source` on a book record; absent on a journal article.',
    ),
  publisherName: z
    .string()
    .optional()
    .describe(
      'Publisher of the book an NCBI Bookshelf record belongs to. Present only on a book record; absent on a journal article.',
    ),
  docType: z
    .string()
    .optional()
    .describe(
      'What PubMed classifies this record as: "chapter" or "book" for an NCBI Bookshelf record, "citation" for an ordinary journal article. Absent when PubMed supplies none.',
    ),
  editors: z
    .array(z.string().describe('One editor, "Surname Initials" as ESummary renders it'))
    .optional()
    .describe(
      "Editors of the containing book, kept out of `authors` so they cannot displace the record's own authors. Absent on a journal article and on a book that credits no editors.",
    ),
  pubDate: z
    .string()
    .optional()
    .describe(
      'Publication date as PubMed states it, in ISO 8601 at that precision: `2026`, `2026-12`, or `2026-09-30`. A stated range is an interval `start/end` — `2026-09/2026-10` for a bimonthly issue, `1994/1995`, `2006-12-12/2007-01-01` — and a season reads as its year; every form opens with the four-digit year. On an NCBI Bookshelf chapter (`docType` "chapter") it is the chapter\'s own date — its last revision, otherwise its contribution — not the year its book began. Absent when PubMed states no date with a year.',
    ),
  epubDate: z
    .string()
    .optional()
    .describe(
      'Electronic publication date — when the article went online, often ahead of the issue `pubDate` names — in ISO 8601 at the precision PubMed states, normally `YYYY-MM-DD`. Absent when PubMed records none.',
    ),
  doi: z
    .string()
    .optional()
    .describe(
      'DOI, cased as NCBI reports it. DOIs are case-insensitive by spec and no case normalization is applied here, so casing can differ from a Europe PMC-sourced `doi` — compare the two case-insensitively. Absent when the record has none.',
    ),
  pmcId: z
    .string()
    .optional()
    .describe(
      "PubMed Central ID (`PMC` prefix) of the record's PMC copy. Absent when the record has none.",
    ),
  pmcUrl: z
    .string()
    .optional()
    .describe("Link to the record's PMC copy; present exactly when `pmcId` is."),
  pubmedUrl: z.string().describe("Link to the record's PubMed page; present on every row."),
});

export type SummaryRow = z.infer<typeof summaryRowSchema>;

/**
 * The row for one ESummary record, carrying each field the parse holds and
 * nothing for one it lacks; `pmcUrl` is built from `pmcId` and `pubmedUrl` from
 * the PMID. `summaryRow({ pmid })` is the row for a PMID ESummary did not
 * describe: `{ pmid, pubmedUrl }`.
 */
export function summaryRow(summary: ParsedBriefSummary): SummaryRow {
  const {
    pmid,
    title,
    authors,
    source,
    bookTitle,
    publisherName,
    docType,
    editors,
    pubDate,
    epubDate,
    doi,
    pmcId,
  } = summary;
  return {
    pmid,
    ...(title !== undefined && { title }),
    ...(authors !== undefined && { authors }),
    ...(source !== undefined && { source }),
    ...(bookTitle !== undefined && { bookTitle }),
    ...(publisherName !== undefined && { publisherName }),
    ...(docType !== undefined && { docType }),
    ...(editors !== undefined && { editors }),
    ...(pubDate !== undefined && { pubDate }),
    ...(epubDate !== undefined && { epubDate }),
    ...(doi !== undefined && { doi }),
    ...(pmcId !== undefined && {
      pmcId,
      pmcUrl: `https://www.ncbi.nlm.nih.gov/pmc/articles/${pmcId}/`,
    }),
    pubmedUrl: `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`,
  };
}
