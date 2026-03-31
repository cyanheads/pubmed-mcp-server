/**
 * @fileoverview Citation lookup tool. Resolves partial bibliographic references
 * to PubMed IDs using NCBI's ECitMatch service.
 * @module src/mcp-server/tools/definitions/lookup-citation.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { getNcbiService } from '@/services/ncbi/ncbi-service.js';
import type { ECitMatchCitation } from '@/services/ncbi/types.js';

export const lookupCitationTool = tool('pubmed_lookup_citation', {
  description: `Look up PubMed IDs from partial bibliographic citations. Useful when you have a reference (journal, year, volume, page, author) and need the PMID. Uses NCBI ECitMatch for deterministic matching — more reliable than searching by citation fields.`,
  annotations: { readOnlyHint: true, openWorldHint: true },

  input: z.object({
    citations: z
      .array(
        z.object({
          journal: z
            .string()
            .optional()
            .describe('Journal title or ISO abbreviation (e.g., "proc natl acad sci u s a")'),
          year: z.string().optional().describe('Publication year (e.g., "1991")'),
          volume: z.string().optional().describe('Volume number'),
          firstPage: z.string().optional().describe('First page number'),
          authorName: z
            .string()
            .optional()
            .describe('Author name, typically "lastname initials" (e.g., "mann bj")'),
          key: z
            .string()
            .optional()
            .describe(
              'Arbitrary label to track this citation in results. Auto-assigned if omitted.',
            ),
        }),
      )
      .min(1)
      .max(25)
      .describe('Citations to look up. More fields = better match accuracy.'),
  }),

  output: z.object({
    results: z
      .array(
        z.object({
          key: z.string().describe('Citation tracking key'),
          pmid: z.string().optional().describe('Matched PubMed ID'),
          matched: z.boolean().describe('Whether a PMID was found'),
        }),
      )
      .describe('Match results, one per input citation'),
    totalMatched: z.number().describe('Number of citations with PMID matches'),
    totalSubmitted: z.number().describe('Number of citations submitted'),
  }),

  async handler(input, ctx) {
    ctx.log.info('Executing pubmed_lookup_citation', { count: input.citations.length });

    for (const c of input.citations) {
      if (!c.journal && !c.year && !c.volume && !c.firstPage && !c.authorName) {
        throw new Error(
          'Each citation must include at least one bibliographic field (journal, year, volume, firstPage, or authorName).',
        );
      }
    }

    const citations: ECitMatchCitation[] = input.citations.map((c, i) => ({
      journal: c.journal,
      year: c.year,
      volume: c.volume,
      firstPage: c.firstPage,
      authorName: c.authorName,
      key: c.key ?? String(i + 1),
    }));

    const results = await getNcbiService().eCitMatch(citations);

    const mapped = results.map((r) => ({
      key: r.key,
      matched: r.matched,
      ...(r.pmid && { pmid: r.pmid }),
    }));

    const totalMatched = mapped.filter((r) => r.matched).length;
    ctx.log.info('pubmed_lookup_citation completed', {
      totalMatched,
      totalSubmitted: citations.length,
    });

    return { results: mapped, totalMatched, totalSubmitted: citations.length };
  },

  format: (result) => {
    const lines = [
      `## Citation Lookup Results`,
      `**Matched:** ${result.totalMatched}/${result.totalSubmitted}`,
      '',
      '| Key | PMID | Status |',
      '|:---|:---|:---|',
    ];
    for (const r of result.results) {
      const pmid = r.pmid ?? '-';
      const status = r.matched ? 'Matched' : 'No match';
      lines.push(`| ${r.key} | ${pmid} | ${status} |`);
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
