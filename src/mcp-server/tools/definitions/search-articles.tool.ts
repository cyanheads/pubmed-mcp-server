/**
 * @fileoverview PubMed search tool. Searches PubMed with full query syntax,
 * field-specific filters, date ranges, pagination, and optional brief summaries.
 * @module src/mcp-server/tools/definitions/search-articles.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { sanitization } from '@cyanheads/mcp-ts-core/utils';
import { getNcbiService } from '@/services/ncbi/ncbi-service.js';
import { extractBriefSummaries } from '@/services/ncbi/parsing/esummary-parser.js';
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
 * Produces an optional human- and agent-readable hint for edge cases where
 * bare empty arrays leave the caller without enough signal to recover:
 * - No matches at all (suggest spell-check / removing filters)
 * - Filters applied but nothing matched (suggest relaxing filters)
 * - Pagination overshoot (offset ≥ totalFound)
 */
function buildNotice(args: {
  totalFound: number;
  pmidCount: number;
  offset: number;
  hasFilters: boolean;
}): string | undefined {
  const { totalFound, pmidCount, offset, hasFilters } = args;
  if (totalFound === 0) {
    return hasFilters
      ? 'No results matched your query with the applied filters. Try removing filters (e.g. dateRange, publicationTypes, meshTerms), broadening dates, or verifying author/journal spelling.'
      : 'No results matched your query. Try running pubmed_spell_check for a suggested correction or broaden the query.';
  }
  if (pmidCount === 0 && offset > 0 && offset >= totalFound) {
    return `Offset ${offset} exceeds totalFound (${totalFound}). Reset offset to 0 or reduce it below ${totalFound} to page through results.`;
  }
  return;
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

  input: z.object({
    query: z.string().min(1).describe('PubMed search query (supports full NCBI syntax)'),
    maxResults: z.number().int().min(1).max(1000).default(20).describe('Maximum results to return'),
    offset: z.number().int().min(0).default(0).describe('Result offset for pagination (0-based)'),
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
      .max(50)
      .default(0)
      .describe('Fetch brief summaries for top N results (0 = PMIDs only)'),
  }),

  output: z.object({
    query: z.string().describe('Original query'),
    effectiveQuery: z
      .string()
      .describe('Sanitized query sent to PubMed after applying all active filters'),
    appliedFilters: AppliedFiltersSchema.describe(
      'Normalized filter values that were applied to the PubMed query',
    ),
    totalFound: z.number().describe('Total matching articles'),
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
            doi: z.string().optional().describe('DOI'),
            pmcId: z.string().optional().describe('PMC ID'),
            pmcUrl: z.string().optional().describe('PMC URL'),
            pubmedUrl: z.string().optional().describe('PubMed URL'),
          })
          .describe('Brief article summary'),
      )
      .describe('Brief summaries (empty array when summaryCount is 0)'),
    searchUrl: z.string().describe('PubMed search URL'),
    notice: z
      .string()
      .optional()
      .describe(
        'Optional guidance when results are empty or paging overshot — e.g. how to broaden filters or reset offset. Absent on successful result pages.',
      ),
  }),

  async handler(input, ctx) {
    ctx.log.info('Executing pubmed_search', { query: input.query });
    const ncbi = getNcbiService();

    let effectiveQuery = await sanitization.sanitizeString(input.query, { context: 'text' });

    // Build filters — capture normalized values for both query construction and appliedFilters
    let normalizedDateRange:
      | { minDate: string; maxDate: string; dateType: 'pdat' | 'mdat' | 'edat' }
      | undefined;
    if (input.dateRange?.minDate && input.dateRange?.maxDate) {
      normalizedDateRange = {
        minDate: input.dateRange.minDate.trim().replace(/[-.]/g, '/'),
        maxDate: input.dateRange.maxDate.trim().replace(/[-.]/g, '/'),
        dateType: input.dateRange.dateType,
      };
      effectiveQuery += ` AND (${normalizedDateRange.minDate}[${normalizedDateRange.dateType}] : ${normalizedDateRange.maxDate}[${normalizedDateRange.dateType}])`;
    }

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
      totalFound: esResult.count,
      pmidCount: pmids.length,
    });

    const notice = buildNotice({
      totalFound: esResult.count,
      pmidCount: pmids.length,
      offset: input.offset,
      hasFilters: Object.keys(appliedFilters).length > 0,
    });

    return {
      query: input.query,
      effectiveQuery,
      appliedFilters,
      totalFound: esResult.count,
      offset: input.offset,
      pmids,
      summaries,
      searchUrl,
      ...(notice && { notice }),
    };
  },

  format: (result) => {
    const lines = [
      `## PubMed Search Results`,
      `**Query:** ${result.query}`,
      `**Effective Query:** ${result.effectiveQuery}`,
      `**Total Found:** ${result.totalFound} | **Returned:** ${result.pmids.length} | **Offset:** ${result.offset}`,
      `**Search URL:** ${result.searchUrl}`,
    ];
    if (Object.keys(result.appliedFilters).length > 0) {
      lines.push('\n### Applied Filters');
      if (result.appliedFilters.dateRange) {
        lines.push(
          `- **Date Range (${result.appliedFilters.dateRange.dateType}):** ${result.appliedFilters.dateRange.minDate} to ${result.appliedFilters.dateRange.maxDate}`,
        );
      }
      if (result.appliedFilters.publicationTypes?.length) {
        lines.push(`- **Publication Types:** ${result.appliedFilters.publicationTypes.join(', ')}`);
      }
      if (result.appliedFilters.author) {
        lines.push(`- **Author:** ${result.appliedFilters.author}`);
      }
      if (result.appliedFilters.journal) {
        lines.push(`- **Journal:** ${result.appliedFilters.journal}`);
      }
      if (result.appliedFilters.meshTerms?.length) {
        lines.push(`- **MeSH Terms:** ${result.appliedFilters.meshTerms.join(', ')}`);
      }
      if (result.appliedFilters.language) {
        lines.push(`- **Language:** ${result.appliedFilters.language}`);
      }
      if (result.appliedFilters.hasAbstract) {
        lines.push(`- **Has Abstract:** Yes`);
      }
      if (result.appliedFilters.freeFullText) {
        lines.push(`- **Free Full Text:** Yes`);
      }
      if (result.appliedFilters.species) {
        lines.push(`- **Species:** ${result.appliedFilters.species}`);
      }
    }
    if (result.notice) lines.push(`\n> ${result.notice}`);
    if (result.pmids.length > 0) lines.push(`\n**PMIDs:** ${result.pmids.join(', ')}`);
    if (result.summaries?.length) {
      if (result.summaries.length < result.pmids.length) {
        lines.push(
          `\n> Summaries shown for top ${result.summaries.length} of ${result.pmids.length} PMIDs. Increase \`summaryCount\` (max 50) to fetch more.`,
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
