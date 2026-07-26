/**
 * @fileoverview PubMed search tool. Searches PubMed with full query syntax,
 * field-specific filters, date ranges, pagination, and optional brief summaries.
 * @module src/mcp-server/tools/definitions/search-articles.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { sanitization } from '@cyanheads/mcp-ts-core/utils';
import { NCBI_SERVICE_ERRORS } from '@/services/error-contracts.js';
import { getNcbiService } from '@/services/ncbi/ncbi-service.js';
import { extractBriefSummaries } from '@/services/ncbi/parsing/esummary-parser.js';
import type { ESearchErrorList, ESearchWarningList } from '@/services/ncbi/types.js';
import {
  conceptMeta,
  EDAM_DATABASE_SEARCH,
  EDAM_PUBMED_ID,
  SCHEMA_SEARCH_ACTION,
} from './_concepts.js';

/**
 * Accepts empty strings (treated as "no filter" by the handler) or dates in
 * YYYY, YYYY/MM, or YYYY/MM/DD form with `/`, `-`, or `.` separators.
 * Catches obvious typos at the edge so they don't degrade silently to 0 results.
 */
const DATE_RE = /^$|^\d{4}([/\-.]\d{1,2}([/\-.]\d{1,2})?)?$/;

/**
 * NCBI's eSearch serves `retstart` up to 9998 for PubMed and fails the whole
 * request above it, so the ceiling is enforced at the edge where the caller can
 * still act on it. The limit is db-specific — it does not apply to db=mesh.
 */
const OFFSET_MAX = 9998;

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
    const sentinel = missing === 'maxDate' ? '3000' : '1800';
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

  errors: [...NCBI_SERVICE_ERRORS] as const,

  input: z.object({
    query: z.string().min(1).describe('PubMed search query (supports full NCBI syntax)'),
    maxResults: z.number().int().min(1).max(1000).default(20).describe('Maximum results to return'),
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
          .describe('Start date (YYYY/MM/DD, YYYY/MM, or YYYY); empty string disables this bound'),
        maxDate: z
          .string()
          .regex(DATE_RE, 'Date must be YYYY, YYYY/MM, or YYYY/MM/DD (/, -, or . separators)')
          .describe('End date (YYYY/MM/DD, YYYY/MM, or YYYY); empty string disables this bound'),
        dateType: z
          .enum(['pdat', 'mdat', 'edat'])
          .default('pdat')
          .describe('Date type: pdat (publication), mdat (modification), edat (entrez)'),
      })
      .optional()
      .describe(
        'Filter by date range. The filter is applied only when both `minDate` and `maxDate` are non-empty; either one empty disables the entire date range.',
      ),
    publicationTypes: z
      .array(z.string())
      .optional()
      .describe(
        'Filter by publication type (e.g. "Review", "Clinical Trial", "Meta-Analysis"). Multiple values are OR\'d — any match qualifies.',
      ),
    author: z.string().optional().describe('Filter by author name (e.g. "Smith J")'),
    journal: z.string().optional().describe('Filter by journal name'),
    meshTerms: z
      .array(z.string())
      .optional()
      .describe("Filter by MeSH terms. Multiple terms are AND'd — all must match."),
    language: z.string().optional().describe('Filter by language (e.g. "english")'),
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
            authors: z.string().optional().describe('Formatted author string'),
            source: z.string().optional().describe('Journal source'),
            pubDate: z.string().optional().describe('Publication date'),
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
  }),

  // Result-set context the agent reasons with — the query as PubMed parsed it, the
  // total match count, the normalized filters, and recovery guidance for empty or
  // overshot pages. Populated via ctx.enrich(...) so it reaches structuredContent and
  // content[] alike; kept out of the domain return.
  enrichment: {
    effectiveQuery: z
      .string()
      .describe('Sanitized query sent to PubMed after applying all active filters'),
    totalCount: z.number().describe('Total matching articles'),
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
    totalCount: { label: 'Total Found' },
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

    // Build filters — capture normalized values for both query construction and appliedFilters
    let normalizedDateRange:
      | { minDate: string; maxDate: string; dateType: 'pdat' | 'mdat' | 'edat' }
      | undefined;
    const { dateRange } = input;
    const minDate = dateRange?.minDate.trim() ?? '';
    const maxDate = dateRange?.maxDate.trim() ?? '';
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

    let sanitizedPubTypes: string[] | undefined;
    if (input.publicationTypes?.length) {
      sanitizedPubTypes = await Promise.all(
        input.publicationTypes.map((pt) => sanitization.sanitizeString(pt, { context: 'text' })),
      );
      effectiveQuery += ` AND (${sanitizedPubTypes.map((pt) => `"${pt}"[Publication Type]`).join(' OR ')})`;
    }

    let sanitizedAuthor: string | undefined;
    if (input.author) {
      sanitizedAuthor = await sanitization.sanitizeString(input.author, { context: 'text' });
      effectiveQuery += ` AND ${sanitizedAuthor}[Author]`;
    }

    let sanitizedJournal: string | undefined;
    if (input.journal) {
      sanitizedJournal = await sanitization.sanitizeString(input.journal, { context: 'text' });
      effectiveQuery += ` AND "${sanitizedJournal}"[Journal]`;
    }

    let sanitizedMeshTerms: string[] | undefined;
    if (input.meshTerms?.length) {
      sanitizedMeshTerms = await Promise.all(
        input.meshTerms.map((term) => sanitization.sanitizeString(term, { context: 'text' })),
      );
      effectiveQuery += ` AND (${sanitizedMeshTerms.map((term) => `"${term}"[MeSH Terms]`).join(' AND ')})`;
    }

    let sanitizedLanguage: string | undefined;
    if (input.language) {
      sanitizedLanguage = await sanitization.sanitizeString(input.language, { context: 'text' });
      effectiveQuery += ` AND ${sanitizedLanguage}[Language]`;
    }

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
      ...(sanitizedPubTypes?.length && { publicationTypes: sanitizedPubTypes }),
      ...(sanitizedAuthor && { author: sanitizedAuthor }),
      ...(sanitizedJournal && { journal: sanitizedJournal }),
      ...(sanitizedMeshTerms?.length && { meshTerms: sanitizedMeshTerms }),
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
    ctx.enrich.total(esResult.count);
    if (notice) ctx.enrich.notice(notice);

    return {
      query: input.query,
      offset: input.offset,
      pmids,
      summaries,
      searchUrl,
    };
  },

  format: (result) => {
    const lines = [
      `## PubMed Search Results`,
      `**Query:** ${result.query}`,
      `**Returned:** ${result.pmids.length} | **Offset:** ${result.offset}`,
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
        lines.push(`\n#### ${s.title ?? s.pmid}`);
        lines.push(`**PMID:** ${s.pmid}`);
        if (s.authors) lines.push(`**Authors:** ${s.authors}`);
        if (s.source) lines.push(`**Source:** ${s.source}`);
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
