/**
 * @fileoverview PubMed search tool. Searches PubMed with full query syntax,
 * field-specific filters, date ranges, pagination, and optional brief summaries.
 * A query with no search term — blank, invisible characters only, markup only, a
 * bare field tag, or empty parentheses — is rejected before NCBI is called, as
 * is a filter value with no term once sanitized (`"   "`, `"()"`), a
 * `dateRange` bound that is no real calendar date, and a range whose `minDate`
 * falls after its `maxDate`. `limit`, `retmax`, `num_results`, and `pageSize`
 * are accepted as aliases for `maxResults`, `term` and `queryTerm` for `query`,
 * `retstart` for `offset`, and `sortBy` for `sort`. The total match count rides
 * in `output` so `format()` can state it in the header beside the returned
 * count, and a summary's `docType` is rendered only when it marks something
 * other than an ordinary journal article (`citation`).
 * @module src/mcp-server/tools/definitions/search-articles.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { sanitization } from '@cyanheads/mcp-ts-core/utils';
import { NCBI_SERVICE_ERRORS, QUERY_INPUT_ERRORS } from '@/services/error-contracts.js';
import { getNcbiService } from '@/services/ncbi/ncbi-service.js';
import { extractBriefSummaries } from '@/services/ncbi/parsing/esummary-parser.js';
import type { ESearchErrorList, ESearchWarningList } from '@/services/ncbi/types.js';
import {
  conceptMeta,
  EDAM_DATABASE_SEARCH,
  EDAM_PUBMED_ID,
  SCHEMA_SEARCH_ACTION,
} from './_concepts.js';
import { escapeMarkdownInline } from './_text.js';
import { hasVisibleText } from './_visible-text.js';

/**
 * Accepts empty strings (treated as "no filter" by the handler) or dates in
 * YYYY, YYYY/MM, or YYYY/MM/DD form with `/`, `-`, or `.` separators.
 * Catches obvious typos at the edge so they don't degrade silently to 0 results.
 * Calendar validity and bound order are checked in the handler
 * ({@link dateRangeProblem}).
 */
const DATE_RE = /^$|^\d{4}([/\-.]\d{1,2}([/\-.]\d{1,2})?)?$/;

/**
 * Days in `month` (1–12) of `year`, leap years included. `setUTCFullYear` reads
 * the year literally, where `Date.UTC` would map 0–99 onto 1900–1999.
 */
function daysInMonth(year: number, month: number): number {
  const date = new Date(0);
  date.setUTCFullYear(year, month, 0);
  return date.getUTCDate();
}

/**
 * The first and last day a `dateRange` bound covers, as zero-padded
 * `YYYY/MM/DD` strings that sort in calendar order — PubMed reads a partial
 * date as its whole year or month — or why the bound names no real date. The
 * value has already matched {@link DATE_RE}, so it splits into one to three
 * numbers with a four-digit year.
 */
function dateBoundSpan(value: string): { first: string; last: string } | { problem: string } {
  const [yearText = '', monthText, dayText] = value.split(/[/\-.]/);
  const year = Number(yearText);
  const month = monthText === undefined ? undefined : Number(monthText);
  const day = dayText === undefined ? undefined : Number(dayText);
  const ymd = (m: number, d: number) =>
    `${yearText}/${String(m).padStart(2, '0')}/${String(d).padStart(2, '0')}`;

  if (month !== undefined && (month < 1 || month > 12)) {
    return { problem: `month ${monthText} is outside 01–12` };
  }
  if (month !== undefined && day !== undefined) {
    if (day < 1) return { problem: `day ${dayText} is not a day; days start at 01` };
    const monthDays = daysInMonth(year, month);
    if (day > monthDays) {
      return { problem: `${ymd(month, 1).slice(0, 7)} has ${monthDays} days` };
    }
  }
  return {
    first: ymd(month ?? 1, day ?? 1),
    last: ymd(month ?? 12, day ?? daysInMonth(year, month ?? 12)),
  };
}

/**
 * Why a `dateRange` names no real span, or `undefined` when it does. Every
 * non-empty bound must be a real calendar date, even beside an empty bound that
 * drops the filter, and `minDate` must not fall after `maxDate` once each is
 * expanded the way PubMed reads a partial date: `minDate` from the start of its
 * year or month, `maxDate` to the end. `2024/06 : 2024` is a range;
 * `2024/07 : 2024/06/30` is reversed. PubMed answers either mistake with zero
 * hits and reports the valid date tag as unrecognized. (#177)
 */
function dateRangeProblem(
  minDate: string,
  maxDate: string,
): { fields: string[]; message: string } | undefined {
  const min = minDate ? dateBoundSpan(minDate) : undefined;
  const max = maxDate ? dateBoundSpan(maxDate) : undefined;

  const fields: string[] = [];
  const problems: string[] = [];
  for (const [field, value, span] of [
    ['dateRange.minDate', minDate, min],
    ['dateRange.maxDate', maxDate, max],
  ] as const) {
    if (span && 'problem' in span) {
      fields.push(field);
      problems.push(`\`${field}\` "${value}" is not a real calendar date: ${span.problem}.`);
    }
  }
  if (fields.length > 0) return { fields, message: problems.join(' ') };

  if (min && max && 'first' in min && 'last' in max && min.first > max.last) {
    return {
      fields: ['dateRange.minDate', 'dateRange.maxDate'],
      message: `\`dateRange.minDate\` "${minDate}" (from ${min.first}) falls after \`dateRange.maxDate\` "${maxDate}" (through ${max.last}), so the range covers no dates.`,
    };
  }
  return;
}

/**
 * PubMed query syntax a filter value can hold without holding a term:
 * grouping parentheses, field-tag brackets, and phrase quotes.
 */
const FILTER_SYNTAX = /[()[\]"]/g;

/**
 * Sanitizes one filter value, recording `path` in `blank` when it holds no term
 * once {@link FILTER_SYNTAX} is disregarded (`"   "`, `"<b></b>"`, `"&#8203;"`,
 * `"()"`): sent as written, it would put a field clause with no term in the
 * query PubMed runs, and PubMed answers `asthma AND ()[Author]` with every
 * `asthma` match. A value that passes is returned sanitized, syntax characters
 * included. An exactly-empty string sets no filter — form clients send one for a
 * field left untouched (#14) — so it returns `undefined`, like an omitted field.
 * (#176)
 */
async function sanitizeFilter(
  value: string | undefined,
  path: string,
  blank: string[],
): Promise<string | undefined> {
  if (!value) return;
  const sanitized = await sanitization.sanitizeString(value, { context: 'text' });
  if (hasVisibleText(sanitized.replace(FILTER_SYNTAX, ''))) return sanitized;
  blank.push(path);
  return;
}

/**
 * {@link sanitizeFilter} for each list element, naming a blank one by its
 * index in the framework's dotted path style (`meshTerms.1`) and dropping an
 * empty one. `undefined` when no element is left to filter on.
 */
async function sanitizeFilterList(
  values: string[] | undefined,
  path: string,
  blank: string[],
): Promise<string[] | undefined> {
  const kept: string[] = [];
  for (const [index, value] of (values ?? []).entries()) {
    const sanitized = await sanitizeFilter(value, `${path}.${index}`, blank);
    if (sanitized !== undefined) kept.push(sanitized);
  }
  return kept.length > 0 ? kept : undefined;
}

/**
 * NCBI's eSearch serves `retstart` up to 9998 for PubMed and fails the whole
 * request above it, so the ceiling is enforced at the edge where the caller can
 * still act on it. The limit is db-specific — it does not apply to db=mesh.
 */
const OFFSET_MAX = 9998;

/**
 * PubMed search field tags, lowercased: the tags in PubMed's search-field help,
 * their full names, and ESearch's own field names, each confirmed live to be
 * read as a field tag — a bare `[pdat]` returns "No items found." PubMed searches
 * the content of any other bracket as text (`[18F]`, `[cancer]`, `[smith j]`, and
 * `[ab]` all return matches), so the blank-term check treats only these as
 * carrying no term. A tag missing here fails safe: its bare form is sent and
 * answered as an ordinary zero-hit search.
 */
const PUBMED_FIELD_TAGS = new Set(
  [
    '1au|ad|aid|all|au|auid|book|cn|cois|crdt|dcom|doi|dp|ed|edat|fau|filter|fir|gr|ip|ir',
    'isbn|jid|la|lastau|lid|lr|majr|mh|mhda|nm|ot|pa|pg|pl|pmid|ps|pt|pubn|rn|sb|sh|si|so',
    'ta|ti|tiab|tt|tw|vi|affl|aucl|auth|cdat|cnty|coln|ecno|eid|epdat|epdt|faut|filt|finv',
    'full|grnt|iss|jour|lang|laut|mdat|mesh|otrm|page|papx|pdat|pid|ppdat|ppdt|ptyp|subh',
    'subs|titl|vol|word|author|editor|issue|subset|title|volume',
    'keyword|affiliation|all fields|author - corporate|author - first|author - identifier',
    'author - last|author cluster id|completion date|conflict of interest statements',
    'corporate author|create date|date - completion|date - create|date - entry|date - mesh',
    'date - modification|date - publication|ec/rn number|electronic publication date',
    'entry date|extended pmid|first author name|full author name|full investigator name',
    'grants and funding|investigator|journal|language|last author name|location id',
    'mesh date|mesh major topic|mesh subheading|mesh terms|modification date|other term',
    'pagination|personal name as subject|pharmacological action|place of publication',
    'print publication date|publication date|publication type|publisher|publisher id',
    'secondary source id|subheading|subject - personal name|supplementary concept|text word',
    'title/abstract|transliterated title',
  ]
    .join('|')
    .split('|'),
);

/**
 * The query with every parenthesis and every bracketed field tag removed — what
 * the blank-term check tests. A tag's search modifier (`[mh:noexp]`,
 * `[tiab:~3]`) does not change what it is; a bracket with no visible text
 * carries no term.
 */
function withoutTermlessMarkup(query: string): string {
  return query
    .replace(/\[([^\]]*)\]/g, (bracket, content: string) => {
      const tag = content.trim().toLowerCase();
      return !hasVisibleText(content) || PUBMED_FIELD_TAGS.has(tag.replace(/\s*:.*$/, ''))
        ? ''
        : bracket;
    })
    .replace(/[()]/g, '');
}

/** Upper bound on brief summaries fetched per call; shared by the schema and the format() cap message. */
const SUMMARY_COUNT_MAX = 50;

/** Renders a diagnostic list as a comma-separated set of backticked clauses. */
function quoteClauses(clauses: string[]): string {
  return clauses.map((clause) => `\`${clause}\``).join(', ');
}

/**
 * Produces an optional human- and agent-readable hint for the cases where the
 * returned PMIDs alone leave the caller without enough signal to recover.
 *
 * The signals are independent and can co-occur, so every applicable one is
 * collected and joined rather than the first match being returned:
 * - A `dateRange` with one bound filled, which drops the date filter entirely
 * - Field tags PubMed did not recognize (results silently unrestricted)
 * - Phrases PubMed matched nothing for
 * - No matches at all (suggest spell-check / removing filters)
 * - Pagination overshoot (offset ≥ totalCount)
 *
 * The one precedence rule: an unmatched phrase names the exact clause that
 * returned nothing, so it replaces the generic empty-result guidance, which
 * would only guess across every filter the request might have set.
 */
function buildNotice(args: {
  totalCount: number;
  pmidCount: number;
  offset: number;
  hasFilters: boolean;
  partialDateBound?: { name: 'minDate' | 'maxDate'; value: string };
  errorList?: ESearchErrorList;
  warningList?: ESearchWarningList;
}): string | undefined {
  const { totalCount, pmidCount, offset, hasFilters, partialDateBound, errorList, warningList } =
    args;
  const notices: string[] = [];

  if (partialDateBound) {
    const missing = partialDateBound.name === 'minDate' ? 'maxDate' : 'minDate';
    const sentinel = missing === 'maxDate' ? '3000' : '1000';
    notices.push(
      `No date filter was applied: dateRange needs both bounds and only \`${partialDateBound.name}\` ("${partialDateBound.value}") was supplied. Set \`${missing}\` as well — for an open-ended range pass a wide sentinel (e.g. \`${missing}: "${sentinel}"\`).`,
    );
  }

  const ignoredFields = [
    ...(errorList?.FieldNotFound ?? []),
    ...(warningList?.FieldNotFound ?? []),
  ];
  if (ignoredFields.length > 0) {
    notices.push(
      `PubMed did not recognize the field tag(s) ${quoteClauses(ignoredFields)} and searched those terms as free text, so these results are not restricted by that field. Correct the tag or drop it.`,
    );
  }

  const unmatchedPhrases = [
    ...(errorList?.PhraseNotFound ?? []),
    ...(warningList?.PhraseNotFound ?? []),
    ...(warningList?.QuotedPhraseNotFound ?? []),
  ];
  if (unmatchedPhrases.length > 0) {
    notices.push(
      `PubMed matched nothing for ${quoteClauses(unmatchedPhrases)}, so that clause contributed no results. Check the spelling, or resolve the term with pubmed_lookup_mesh before filtering on it.`,
    );
  }

  if (totalCount === 0) {
    if (unmatchedPhrases.length === 0) {
      notices.push(
        hasFilters
          ? 'No results matched your query with the applied filters. Try removing filters (e.g. dateRange, publicationTypes, meshTerms), broadening dates, or verifying author/journal spelling.'
          : 'No results matched your query. Try running pubmed_spell_check for a suggested correction or broaden the query.',
      );
    }
  } else if (pmidCount === 0 && offset > 0 && offset >= totalCount) {
    notices.push(
      `Offset ${offset} exceeds totalCount (${totalCount}). Reset offset to 0 or reduce it below ${totalCount} to page through results.`,
    );
  }

  return notices.length > 0 ? notices.join(' ') : undefined;
}

const AppliedFiltersSchema = z.object({
  dateRange: z
    .object({
      minDate: z.string().describe('Applied minimum date'),
      maxDate: z.string().describe('Applied maximum date'),
      dateType: z
        .enum(['pdat', 'mdat', 'edat'])
        .describe('Applied date field used for the range filter'),
    })
    .optional()
    .describe('Date range filter applied to the search'),
  publicationTypes: z
    .array(z.string())
    .optional()
    .describe('Publication type filters applied to the search'),
  author: z.string().optional().describe('Author filter applied to the search'),
  journal: z.string().optional().describe('Journal filter applied to the search'),
  meshTerms: z.array(z.string()).optional().describe('MeSH term filters applied to the search'),
  language: z.string().optional().describe('Language filter applied to the search'),
  hasAbstract: z
    .boolean()
    .optional()
    .describe('Whether results were restricted to articles with abstracts'),
  freeFullText: z
    .boolean()
    .optional()
    .describe('Whether results were restricted to free full-text articles'),
  species: z
    .enum(['humans', 'animals'])
    .optional()
    .describe('Species filter applied to the search'),
});

export const searchArticlesTool = tool('pubmed_search_articles', {
  description:
    'Search PubMed with full query syntax, filters, and date ranges. Returns PMIDs and optional brief summaries. Supports field-specific filters (author, journal, MeSH terms), common filters (language, species, free full text), and pagination via offset for paging through large result sets.',
  annotations: { readOnlyHint: true, openWorldHint: true },
  _meta: conceptMeta([SCHEMA_SEARCH_ACTION, EDAM_DATABASE_SEARCH, EDAM_PUBMED_ID]),
  sourceUrl:
    'https://github.com/cyanheads/pubmed-mcp-server/blob/main/src/mcp-server/tools/definitions/search-articles.tool.ts',

  errors: [
    ...NCBI_SERVICE_ERRORS,
    ...QUERY_INPUT_ERRORS,
    {
      reason: 'invalid_date_range',
      code: JsonRpcErrorCode.ValidationError,
      when: 'A `dateRange` bound is not a real calendar date — a month outside 01–12, day 00, or a day past the end of its month such as `2023/02/29` — or `minDate` falls after `maxDate` once PubMed expands each partial date: `minDate` from the start of its year or month, `maxDate` to the end.',
      recovery:
        'Correct the named bound to a real calendar date, or swap the bounds so minDate does not fall after maxDate; the same range will be rejected again.',
      retryable: false,
    },
    {
      reason: 'blank_filter',
      code: JsonRpcErrorCode.ValidationError,
      when: 'An `author`, `journal`, or `language` value, or a `publicationTypes` or `meshTerms` element, holds no term once markup is removed and HTML entities are decoded — only whitespace, invisible characters such as a zero-width space, parentheses, brackets, or double quotes are left, as in `()` or `""` — so its field clause would carry no term. An exactly-empty string is not blank here; it sets no filter.',
      recovery:
        'Give each named filter a value, or pass an empty string or omit it for no filter; the same blank value will be rejected again.',
      retryable: false,
    },
  ] as const,

  // Never advertised; rewritten to the canonical key before the schema parses.
  // ESearch's own names (`retmax`, `term`, `retstart`), sibling tools' names, and
  // common caller spellings. `max_results` needs no entry — the framework's
  // case-style repair maps it. (#156, #190)
  inputAliases: {
    limit: 'maxResults',
    retmax: 'maxResults',
    num_results: 'maxResults',
    pageSize: 'maxResults',
    term: 'query',
    queryTerm: 'query',
    retstart: 'offset',
    sortBy: 'sort',
  },

  input: z.object({
    query: z
      .string()
      .min(1)
      .describe(
        'PubMed search query (supports full NCBI syntax). Must carry a search term: a value that is blank once markup, bracketed field tags (`[pdat]`), parentheses, and invisible characters such as a zero-width space are disregarded is rejected rather than sent to PubMed.',
      ),
    maxResults: z
      .number()
      .int()
      .min(0)
      .max(1000)
      .default(20)
      .describe('Maximum results to return. 0 returns only `totalCount`.'),
    offset: z
      .number()
      .int()
      .min(0)
      .max(OFFSET_MAX)
      .default(0)
      .describe(
        `Result offset for pagination (0-based). PubMed serves at most the first ${OFFSET_MAX + 1} records of a result set, so this caps at ${OFFSET_MAX}; narrow the query or add filters to reach anything beyond it.`,
      ),
    sort: z
      .enum(['relevance', 'pub_date', 'author', 'journal'])
      .default('relevance')
      .describe('Sort order: relevance (default), pub_date (newest first), author, or journal'),
    dateRange: z
      .object({
        minDate: z
          .string()
          .regex(DATE_RE, 'Date must be YYYY, YYYY/MM, or YYYY/MM/DD (/, -, or . separators)')
          .describe(
            'Start date (YYYY/MM/DD, YYYY/MM, or YYYY). Must be a real calendar date — `2023/02/29` is rejected. Leaving it empty drops the whole date range, not just this bound; for no lower bound pass a wide sentinel such as `1000`.',
          ),
        maxDate: z
          .string()
          .regex(DATE_RE, 'Date must be YYYY, YYYY/MM, or YYYY/MM/DD (/, -, or . separators)')
          .describe(
            'End date (YYYY/MM/DD, YYYY/MM, or YYYY). Must be a real calendar date — `2023/02/29` is rejected. Leaving it empty drops the whole date range, not just this bound; for no upper bound pass a wide sentinel such as `3000`.',
          ),
        dateType: z
          .enum(['pdat', 'mdat', 'edat'])
          .default('pdat')
          .describe('Date type: pdat (publication), mdat (modification), edat (entrez)'),
      })
      .optional()
      .describe(
        'Filter by date range. The filter is applied only when both `minDate` and `maxDate` are non-empty; either one empty disables the entire date range. A partial date covers its whole year or month, and a range whose `minDate` falls after its `maxDate` is rejected: `2024/06` to `2024` is valid, `2024/07` to `2024/06/30` is not.',
      ),
    publicationTypes: z
      .array(z.string())
      .optional()
      .describe(
        'Filter by publication type (e.g. "Review", "Clinical Trial", "Meta-Analysis"). Multiple values are OR\'d — any match qualifies. Empty strings are skipped; an element of only whitespace, invisible characters, markup, parentheses, brackets, or double quotes is rejected.',
      ),
    author: z
      .string()
      .optional()
      .describe(
        'Filter by author name (e.g. "Smith J"). An empty string applies no filter; a value of only whitespace, invisible characters, markup, parentheses, brackets, or double quotes is rejected.',
      ),
    journal: z
      .string()
      .optional()
      .describe(
        'Filter by journal name. An empty string applies no filter; a value of only whitespace, invisible characters, markup, parentheses, brackets, or double quotes is rejected.',
      ),
    meshTerms: z
      .array(z.string())
      .optional()
      .describe(
        "Filter by MeSH terms. Multiple terms are AND'd — all must match. Empty strings are skipped; an element of only whitespace, invisible characters, markup, parentheses, brackets, or double quotes is rejected.",
      ),
    language: z
      .string()
      .optional()
      .describe(
        'Filter by language (e.g. "english"). An empty string applies no filter; a value of only whitespace, invisible characters, markup, parentheses, brackets, or double quotes is rejected.',
      ),
    hasAbstract: z.boolean().optional().describe('Only include articles with abstracts'),
    freeFullText: z.boolean().optional().describe('Only include free full text articles'),
    species: z.enum(['humans', 'animals']).optional().describe('Filter by species'),
    summaryCount: z
      .number()
      .int()
      .min(0)
      .max(SUMMARY_COUNT_MAX)
      .default(0)
      .describe(
        `Fetch brief summaries for top N results (0 = PMIDs only). Above the ${SUMMARY_COUNT_MAX} cap, pass the remaining PMIDs to pubmed_fetch_articles.`,
      ),
  }),

  output: z.object({
    query: z.string().describe('Original query'),
    offset: z.number().describe('Result offset used'),
    pmids: z.array(z.string()).describe('PubMed IDs'),
    summaries: z
      .array(
        z
          .object({
            pmid: z.string().describe('PubMed ID'),
            title: z.string().optional().describe('Article title'),
            authors: z
              .string()
              .optional()
              .describe(
                "Formatted author string — the first three of the record's own authors, then \"et al.\". On an NCBI Bookshelf chapter these are the chapter's authors; the book's editors are reported separately in `editors`.",
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
                'Publication date as YYYY-MM-DD; a month- or year-only date reads as the first day of that month or year. On an NCBI Bookshelf chapter (`docType` "chapter") it is the chapter\'s own date — its last revision, otherwise its contribution — not the year its book began.',
              ),
            doi: z
              .string()
              .optional()
              .describe(
                'DOI, cased as NCBI reports it. DOIs are case-insensitive by spec and no case normalization is applied here, so casing can differ from a Europe PMC-sourced `doi` — compare the two case-insensitively.',
              ),
            pmcId: z.string().optional().describe('PMC ID'),
            pmcUrl: z.string().optional().describe('PMC URL'),
            pubmedUrl: z.string().optional().describe('PubMed URL'),
          })
          .describe('Brief article summary'),
      )
      .describe('Brief summaries (empty array when summaryCount is 0)'),
    searchUrl: z.string().describe('PubMed search URL'),
    // A domain field, not enrichment: format() sees only this payload, and the
    // header states the total beside the returned count. (#147)
    totalCount: z.number().describe('Total matching articles'),
  }),

  // Result-set context the agent reasons with — the query as PubMed parsed it, the
  // normalized filters, and recovery guidance for empty or overshot pages.
  // Populated via ctx.enrich(...) so it reaches structuredContent and content[]
  // alike; kept out of the domain return.
  enrichment: {
    effectiveQuery: z
      .string()
      .describe('Sanitized query sent to PubMed after applying all active filters'),
    appliedFilters: AppliedFiltersSchema.describe(
      'Normalized filter values that were applied to the PubMed query',
    ),
    notice: z
      .string()
      .optional()
      .describe(
        'Optional guidance when the result set does not reflect what was asked for — a field tag PubMed ignored, a phrase it matched nothing for, a dateRange dropped for having one bound, no matches at all, or paging past the end. Absent when nothing applies.',
      ),
  },

  // content[] trailer presentation for the enrichment block. structuredContent always
  // carries the full structured value; this only shapes the human-facing trailer line.
  enrichmentTrailer: {
    effectiveQuery: { label: 'Effective Query' },
    appliedFilters: {
      render: (filters) => {
        const lines: string[] = [];
        if (filters.dateRange) {
          lines.push(
            `- **Date range:** ${filters.dateRange.minDate} – ${filters.dateRange.maxDate} (${filters.dateRange.dateType})`,
          );
        }
        if (filters.publicationTypes?.length) {
          lines.push(`- **Publication types:** ${filters.publicationTypes.join(', ')}`);
        }
        if (filters.author) lines.push(`- **Author:** ${filters.author}`);
        if (filters.journal) lines.push(`- **Journal:** ${filters.journal}`);
        if (filters.meshTerms?.length) {
          lines.push(`- **MeSH terms:** ${filters.meshTerms.join(', ')}`);
        }
        if (filters.language) lines.push(`- **Language:** ${filters.language}`);
        if (filters.hasAbstract) lines.push('- **Has abstract:** yes');
        if (filters.freeFullText) lines.push('- **Free full text:** yes');
        if (filters.species) lines.push(`- **Species:** ${filters.species}`);
        return lines.length > 0
          ? `**Applied Filters:**\n${lines.join('\n')}`
          : '**Applied Filters:** none';
      },
    },
  },

  async handler(input, ctx) {
    ctx.log.info('Executing pubmed_search', { query: input.query });
    const ncbi = getNcbiService();

    let effectiveQuery = await sanitization.sanitizeString(input.query, { context: 'text' });

    // `min(1)` counts whitespace, and the sanitizer reduces markup with no text
    // content to an empty string, so both reach here as a blank term. NCBI
    // answers a blank term with HTTP 200 and an embedded <ERROR> reading
    // "Search is temporarily unavailable", which classifies as a retryable
    // outage — the caller would spend the whole retry deadline on a
    // deterministic input mistake. Reject before the call instead. (#122)
    //
    // A bare field tag (`[pdat]`) or empty parentheses carry no term either, so
    // the check runs on a copy with those removed; `effectiveQuery` itself is
    // sent as written. A bracket that is not a field tag (`[18F]`) is a term, and
    // boolean operators are kept: NCBI reads an operand-less `NOT[ti]` as
    // literal text and returns real matches. (#145)
    //
    // Invisible characters carry no term either, including those the sanitizer
    // decodes from an entity (`&#8203;`). (#176)
    if (!hasVisibleText(withoutTermlessMarkup(effectiveQuery))) {
      throw ctx.fail(
        'blank_query',
        'The `query` carries no search term — it is blank once markup, bracketed field tags, parentheses, and invisible characters are disregarded.',
      );
    }

    const { dateRange } = input;
    const minDate = dateRange?.minDate.trim() ?? '';
    const maxDate = dateRange?.maxDate.trim() ?? '';
    const dateProblem = dateRangeProblem(minDate, maxDate);
    if (dateProblem) {
      throw ctx.fail('invalid_date_range', dateProblem.message, { fields: dateProblem.fields });
    }

    // Every filter is sanitized and checked before any clause is built, so a
    // blank one fails the call instead of reaching PubMed as an empty field
    // clause (`asthma AND    [Author]`). (#176)
    const blankFilters: string[] = [];
    const sanitizedPubTypes = await sanitizeFilterList(
      input.publicationTypes,
      'publicationTypes',
      blankFilters,
    );
    const sanitizedAuthor = await sanitizeFilter(input.author, 'author', blankFilters);
    const sanitizedJournal = await sanitizeFilter(input.journal, 'journal', blankFilters);
    const sanitizedMeshTerms = await sanitizeFilterList(input.meshTerms, 'meshTerms', blankFilters);
    const sanitizedLanguage = await sanitizeFilter(input.language, 'language', blankFilters);
    if (blankFilters.length > 0) {
      throw ctx.fail(
        'blank_filter',
        `${quoteClauses(blankFilters)} ${blankFilters.length === 1 ? 'holds' : 'hold'} no term once markup, whitespace, invisible characters, parentheses, brackets, and double quotes are disregarded, so the field clause would carry no term.`,
        { fields: blankFilters },
      );
    }

    // Build filters — capture normalized values for both query construction and appliedFilters
    let normalizedDateRange:
      | { minDate: string; maxDate: string; dateType: 'pdat' | 'mdat' | 'edat' }
      | undefined;
    if (dateRange && minDate && maxDate) {
      normalizedDateRange = {
        minDate: minDate.replace(/[-.]/g, '/'),
        maxDate: maxDate.replace(/[-.]/g, '/'),
        dateType: dateRange.dateType,
      };
      effectiveQuery += ` AND (${normalizedDateRange.minDate}[${normalizedDateRange.dateType}] : ${normalizedDateRange.maxDate}[${normalizedDateRange.dateType}])`;
    }
    // Both bounds are required for the filter to apply, so one filled bound is a
    // dropped date range the caller gets no other signal about.
    const partialDateBound =
      minDate && !maxDate
        ? ({ name: 'minDate', value: minDate } as const)
        : maxDate && !minDate
          ? ({ name: 'maxDate', value: maxDate } as const)
          : undefined;

    if (sanitizedPubTypes) {
      effectiveQuery += ` AND (${sanitizedPubTypes.map((pt) => `"${pt}"[Publication Type]`).join(' OR ')})`;
    }
    if (sanitizedAuthor) effectiveQuery += ` AND ${sanitizedAuthor}[Author]`;
    if (sanitizedJournal) effectiveQuery += ` AND "${sanitizedJournal}"[Journal]`;
    if (sanitizedMeshTerms) {
      effectiveQuery += ` AND (${sanitizedMeshTerms.map((term) => `"${term}"[MeSH Terms]`).join(' AND ')})`;
    }
    if (sanitizedLanguage) effectiveQuery += ` AND ${sanitizedLanguage}[Language]`;

    if (input.hasAbstract) effectiveQuery += ' AND hasabstract[text word]';
    if (input.freeFullText) effectiveQuery += ' AND free full text[filter]';
    if (input.species) effectiveQuery += ` AND ${input.species}[MeSH Terms]`;

    const esResult = await ncbi.eSearch(
      {
        db: 'pubmed',
        term: effectiveQuery,
        retmax: input.maxResults,
        retstart: input.offset,
        sort: input.sort,
        usehistory: input.summaryCount > 0 ? 'y' : undefined,
      },
      { signal: ctx.signal },
    );

    const pmids = esResult.idList;
    let summaries: {
      pmid: string;
      title?: string | undefined;
      authors?: string | undefined;
      source?: string | undefined;
      bookTitle?: string | undefined;
      publisherName?: string | undefined;
      docType?: string | undefined;
      editors?: string[] | undefined;
      pubDate?: string | undefined;
      doi?: string | undefined;
      pmcId?: string | undefined;
      pmcUrl?: string | undefined;
      pubmedUrl?: string | undefined;
    }[] = [];

    if (input.summaryCount > 0 && pmids.length > 0) {
      const eSummaryParams: Record<string, string | number | undefined> = {
        db: 'pubmed',
        version: '2.0',
        retmode: 'xml',
      };
      if (esResult.webEnv && esResult.queryKey) {
        eSummaryParams.WebEnv = esResult.webEnv;
        eSummaryParams.query_key = esResult.queryKey;
        eSummaryParams.retmax = Math.min(input.summaryCount, pmids.length);
        eSummaryParams.retstart = input.offset;
      } else {
        eSummaryParams.id = pmids.slice(0, input.summaryCount).join(',');
      }

      const eSummaryResult = await ncbi.eSummary(eSummaryParams, { signal: ctx.signal });
      if (eSummaryResult) {
        const briefSummaries = await extractBriefSummaries(eSummaryResult);
        summaries = briefSummaries.map((s) => ({
          pmid: s.pmid,
          title: s.title,
          authors: s.authors,
          source: s.source,
          bookTitle: s.bookTitle,
          publisherName: s.publisherName,
          docType: s.docType,
          editors: s.editors,
          pubDate: s.pubDate,
          doi: s.doi,
          pmcId: s.pmcId,
          ...(s.pmcId && { pmcUrl: `https://www.ncbi.nlm.nih.gov/pmc/articles/${s.pmcId}/` }),
          pubmedUrl: `https://pubmed.ncbi.nlm.nih.gov/${s.pmid}/`,
        }));
      }
    }

    const searchUrl = `https://pubmed.ncbi.nlm.nih.gov/?term=${encodeURIComponent(effectiveQuery)}`;
    const appliedFilters = {
      ...(normalizedDateRange && { dateRange: normalizedDateRange }),
      ...(sanitizedPubTypes && { publicationTypes: sanitizedPubTypes }),
      ...(sanitizedAuthor && { author: sanitizedAuthor }),
      ...(sanitizedJournal && { journal: sanitizedJournal }),
      ...(sanitizedMeshTerms && { meshTerms: sanitizedMeshTerms }),
      ...(sanitizedLanguage && { language: sanitizedLanguage }),
      ...(input.hasAbstract && { hasAbstract: true }),
      ...(input.freeFullText && { freeFullText: true }),
      ...(input.species && { species: input.species }),
    };
    ctx.log.info('pubmed_search completed', {
      totalCount: esResult.count,
      pmidCount: pmids.length,
    });

    const notice = buildNotice({
      totalCount: esResult.count,
      pmidCount: pmids.length,
      offset: input.offset,
      hasFilters: Object.keys(appliedFilters).length > 0,
      ...(partialDateBound && { partialDateBound }),
      ...(esResult.errorList && { errorList: esResult.errorList }),
      ...(esResult.warningList && { warningList: esResult.warningList }),
    });

    ctx.enrich({ effectiveQuery, appliedFilters });
    if (notice) ctx.enrich.notice(notice);

    return {
      query: input.query,
      offset: input.offset,
      pmids,
      summaries,
      searchUrl,
      totalCount: esResult.count,
    };
  },

  format: (result) => {
    const lines = [
      `## PubMed Search Results`,
      `**Query:** ${result.query}`,
      `**Returned:** ${result.pmids.length} of ${result.totalCount} | **Offset:** ${result.offset}`,
      `**Search URL:** ${result.searchUrl}`,
    ];
    if (result.pmids.length > 0) lines.push(`\n**PMIDs:** ${result.pmids.join(', ')}`);
    if (result.summaries?.length) {
      if (result.summaries.length < result.pmids.length) {
        const shown = `Summaries shown for top ${result.summaries.length} of ${result.pmids.length} PMIDs`;
        lines.push(
          // At the cap there is no knob left to raise, so point at the tool that
          // can read the rest instead of at `summaryCount`.
          result.summaries.length >= SUMMARY_COUNT_MAX
            ? `\n> ${shown} — \`summaryCount\` is at its maximum (${SUMMARY_COUNT_MAX}). Fetch the remaining ${result.pmids.length - result.summaries.length} with \`pubmed_fetch_articles\` using the PMIDs above.`
            : `\n> ${shown}. Increase \`summaryCount\` (max ${SUMMARY_COUNT_MAX}) to fetch more.`,
        );
      }
      lines.push('\n### Summaries');
      for (const s of result.summaries) {
        // Render-time only — `structuredContent.summaries[].title` keeps the
        // plain-text value the eSummary parser produced. (#102)
        lines.push(`\n#### ${escapeMarkdownInline(s.title ?? s.pmid)}`);
        lines.push(`**PMID:** ${s.pmid}`);
        if (s.authors) lines.push(`**Authors:** ${s.authors}`);
        if (s.editors?.length) lines.push(`**Editors:** ${s.editors.join(', ')}`);
        if (s.source) lines.push(`**Source:** ${s.source}`);
        // A Bookshelf record has no journal, so its venue takes the Source
        // slot rather than leaving the summary without one. (#114)
        if (s.bookTitle || s.publisherName) {
          lines.push(`**Book:** ${[s.bookTitle, s.publisherName].filter(Boolean).join(' — ')}`);
        }
        // `citation` is every ordinary journal article; the line earns its
        // place only when it flags a Bookshelf chapter or book. (#146)
        if (s.docType && s.docType !== 'citation') lines.push(`**Doc Type:** ${s.docType}`);
        if (s.pubDate) lines.push(`**Published:** ${s.pubDate}`);
        if (s.doi) lines.push(`**DOI:** ${s.doi}`);
        if (s.pmcId) lines.push(`**PMCID:** ${s.pmcId}`);
        if (s.pubmedUrl) lines.push(`**PubMed:** ${s.pubmedUrl}`);
        if (s.pmcUrl) lines.push(`**PMC:** ${s.pmcUrl}`);
      }
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
