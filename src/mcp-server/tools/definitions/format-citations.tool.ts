/**
 * @fileoverview PubMed citation tool — generates formatted citations (APA, MLA,
 * BibTeX, RIS) for one or more PubMed articles.
 * @module src/mcp-server/tools/definitions/format-citations.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import {
  type CitationStyle,
  formatCitations,
} from '@/services/ncbi/formatting/citation-formatter.js';
import { getNcbiService } from '@/services/ncbi/ncbi-service.js';
import { parseFullArticle } from '@/services/ncbi/parsing/article-parser.js';
import { ensureArray } from '@/services/ncbi/parsing/xml-helpers.js';
import type { XmlPubmedArticle } from '@/services/ncbi/types.js';
import { conceptMeta, EDAM_DATA_FORMATTING, SCHEMA_CREATIVE_WORK } from './_concepts.js';
import { pmidStringSchema } from './_schemas.js';

export const formatCitationsTool = tool('pubmed_format_citations', {
  description: 'Get formatted citations for PubMed articles in APA, MLA, BibTeX, or RIS format.',
  annotations: { readOnlyHint: true, openWorldHint: true },
  _meta: conceptMeta([SCHEMA_CREATIVE_WORK, EDAM_DATA_FORMATTING]),
  sourceUrl:
    'https://github.com/cyanheads/pubmed-mcp-server/blob/main/src/mcp-server/tools/definitions/format-citations.tool.ts',

  input: z.object({
    pmids: z.array(pmidStringSchema).min(1).max(50).describe('PubMed IDs to cite'),
    styles: z
      .array(z.enum(['apa', 'mla', 'bibtex', 'ris']))
      .default(['apa'])
      .describe('Citation styles to generate'),
  }),

  output: z.object({
    citations: z
      .array(
        z.object({
          pmid: z.string().describe('PubMed ID'),
          title: z.string().optional().describe('Article title'),
          citations: z.record(z.string(), z.string()).describe('Citations keyed by style'),
        }),
      )
      .describe('Citations per article'),
    totalSubmitted: z.number().describe('Number of PMIDs submitted for citation formatting'),
    totalFormatted: z.number().describe('Number of PMIDs successfully formatted'),
    unavailablePmids: z
      .array(z.string())
      .optional()
      .describe('Requested PMIDs that did not return article metadata'),
  }),

  async handler(input, ctx) {
    ctx.log.debug('Fetching articles for citation generation', {
      pmids: input.pmids,
      styles: input.styles,
    });
    const raw = await getNcbiService().eFetch(
      { db: 'pubmed', id: input.pmids.join(','), retmode: 'xml' },
      { retmode: 'xml', usePost: input.pmids.length >= 25 },
    );
    const xmlArticles: XmlPubmedArticle[] = ensureArray(raw?.PubmedArticleSet?.PubmedArticle);

    if (xmlArticles.length === 0) {
      throw new Error(`No articles found for PMIDs: ${input.pmids.join(', ')}`);
    }

    const citations = xmlArticles.map((xmlArticle) => {
      const parsed = parseFullArticle(xmlArticle);
      return {
        pmid: parsed.pmid,
        title: parsed.title,
        citations: formatCitations(parsed, input.styles as CitationStyle[]),
      };
    });

    const returnedPmids = new Set(citations.map((entry) => entry.pmid));
    const unavailablePmids = input.pmids.filter((pmid) => !returnedPmids.has(pmid));

    return {
      citations,
      totalSubmitted: input.pmids.length,
      totalFormatted: citations.length,
      ...(unavailablePmids.length > 0 && { unavailablePmids }),
    };
  },

  format: (result) => {
    const lines = [
      '# PubMed Citations',
      `**Formatted:** ${result.totalFormatted}/${result.totalSubmitted}`,
    ];
    if (result.unavailablePmids?.length) {
      lines.push(`**Unavailable PMIDs:** ${result.unavailablePmids.join(', ')}`);
    }
    for (const entry of result.citations) {
      lines.push(`\n## PMID ${entry.pmid}`);
      if (entry.title) lines.push(`**${entry.title}**`);
      for (const [style, citation] of Object.entries(entry.citations)) {
        lines.push(`\n### ${style.toUpperCase()}`);
        if (style === 'bibtex' || style === 'ris') {
          lines.push(`\`\`\`${style}\n${citation}\n\`\`\``);
        } else {
          lines.push(citation);
        }
      }
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
