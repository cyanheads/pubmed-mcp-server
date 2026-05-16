/**
 * @fileoverview Europe PMC search tool. Searches the Europe PMC database for
 * biomedical articles. Supports cursor-based pagination, sort orders, and
 * returns PMID, title, authors, journal, year, DOI, citation counts, and
 * full-text availability flags.
 * @module src/mcp-server/tools/definitions/europepmc-search.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { search } from '@/services/europepmc/europepmc-service.js';
import {
  conceptMeta,
  EDAM_DATABASE_SEARCH,
  EDAM_PUBMED_ID,
  SCHEMA_SCHOLARLY_ARTICLE,
} from './_concepts.js';

const EuropePmcPaperSchema = z
  .object({
    pmid: z.string().describe('PubMed ID'),
    title: z.string().describe('Article title'),
    authorString: z.string().describe('Formatted author string'),
    journalTitle: z.string().describe('Journal title'),
    pubYear: z.string().describe('Publication year'),
    doi: z.string().describe('DOI'),
    source: z.string().describe('Data source (e.g. MED, PMC)'),
    hasFullText: z.string().describe('Full text availability (Y/N)'),
    citedByCount: z.number().describe('Number of citations in Europe PMC'),
  })
  .describe('Europe PMC search result entry');

export const europepmcSearchTool = tool('pubmed_europepmc_search', {
  description:
    'Search Europe PMC for biomedical articles. Complements PubMed with broader European open-access coverage, preprints, and citation counts. Supports cursor-based pagination for scrolling through large result sets.',
  annotations: { readOnlyHint: true, openWorldHint: true },
  _meta: conceptMeta([SCHEMA_SCHOLARLY_ARTICLE, EDAM_DATABASE_SEARCH, EDAM_PUBMED_ID]),
  sourceUrl:
    'https://github.com/cyanheads/pubmed-mcp-server/blob/main/src/mcp-server/tools/definitions/europepmc-search.tool.ts',

  input: z.object({
    query: z.string().min(1).describe('Europe PMC search query (supports full Europe PMC syntax)'),
    pageSize: z.number().int().min(1).max(1000).default(25).describe('Results per page'),
    cursorMark: z
      .string()
      .default('*')
      .describe('Cursor for pagination. Use "*" for first page, then use returned nextCursorMark.'),
    sort: z
      .enum(['RELEVANCE', 'DATE', 'CITED'])
      .default('RELEVANCE')
      .describe('Sort order: RELEVANCE, DATE (newest first), or CITED (most cited first)'),
  }),

  output: z.object({
    query: z.string().describe('Original query'),
    totalHits: z.number().describe('Total matching articles'),
    nextCursorMark: z.string().describe('Cursor for next page (empty when no more results)'),
    pageSize: z.number().describe('Results per page'),
    results: z.array(EuropePmcPaperSchema).describe('Search results'),
    searchUrl: z.string().describe('Europe PMC search URL'),
  }),

  async handler(input, ctx) {
    ctx.log.info('Executing pubmed_europepmc_search', { query: input.query });
    const result = await search({
      query: input.query,
      pageSize: input.pageSize,
      cursorMark: input.cursorMark,
      sort: input.sort,
      signal: ctx.signal,
    });

    const searchUrl = `https://europepmc.org/search?query=${encodeURIComponent(input.query)}`;

    ctx.log.info('pubmed_europepmc_search completed', {
      totalHits: result.totalHits,
      returned: result.results.length,
    });

    return {
      query: input.query,
      totalHits: result.totalHits,
      nextCursorMark: result.nextCursorMark,
      pageSize: result.pageSize,
      results: result.results,
      searchUrl,
    };
  },

  format: (result) => {
    const lines = [
      '## Europe PMC Search Results',
      `**Query:** ${result.query}`,
      `**Total Hits:** ${result.totalHits} | **Returned:** ${result.results.length} | **Page Size:** ${result.pageSize}`,
      `**Search URL:** ${result.searchUrl}`,
    ];

    if (result.nextCursorMark && result.nextCursorMark !== '*') {
      lines.push(`**Next Cursor:** \`${result.nextCursorMark}\` (use for next page)`);
    }

    if (result.results.length === 0) {
      lines.push('\n> No results found. Try broadening the query or checking spelling.');
    }

    for (const r of result.results) {
      lines.push(`\n### ${r.title}`);
      lines.push(`**PMID:** ${r.pmid} | **Year:** ${r.pubYear} | **Cited by:** ${r.citedByCount}`);
      if (r.authorString) lines.push(`**Authors:** ${r.authorString}`);
      if (r.journalTitle) lines.push(`**Journal:** ${r.journalTitle}`);
      if (r.doi) lines.push(`**DOI:** ${r.doi}`);
      if (r.source) lines.push(`**Source:** ${r.source}`);
      lines.push(
        `**Full Text:** ${r.hasFullText === 'Y' ? 'Available in Europe PMC' : 'Not available'}`,
      );
      lines.push(`**Cited by:** ${r.citedByCount}`);
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
