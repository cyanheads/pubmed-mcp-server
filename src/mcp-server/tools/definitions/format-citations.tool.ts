/**
 * @fileoverview PubMed citation tool — generates formatted citations (APA, MLA,
 * BibTeX, RIS, Vancouver) for one or more PubMed articles. A zero-padded PMID
 * is fetched and matched as the PMID it spells; `ids` is accepted as an alias
 * for `pmids`.
 * @module src/mcp-server/tools/definitions/format-citations.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { NCBI_SERVICE_ERRORS } from '@/services/error-contracts.js';
import {
  type CitationStyle,
  formatCitations,
} from '@/services/ncbi/formatting/citation-formatter.js';
import { getNcbiService } from '@/services/ncbi/ncbi-service.js';
import { parseArticleSet } from '@/services/ncbi/parsing/article-parser.js';
import { conceptMeta, EDAM_DATA_FORMATTING, SCHEMA_CREATIVE_WORK } from './_concepts.js';
import { normalizePmid, pmidStringSchema } from './_schemas.js';

const CitationStyleEnum = z.enum(['apa', 'mla', 'bibtex', 'ris', 'vancouver']);

/**
 * A union rejects a bad `format` with Zod's top-level `Invalid input`, which
 * buries the accepted values inside the per-branch issue tree — a client that
 * reads only `content[]` never sees them. Stating them on the union itself
 * reproduces what a plain enum field renders (`pubmed_convert_ids.idType`),
 * derived from the enum so the two can't drift.
 */
const CITATION_STYLE_ERROR = `Invalid option: expected one of ${CitationStyleEnum.options
  .map((style) => `"${style}"`)
  .join('|')}, or a non-empty array of those values`;

export const formatCitationsTool = tool('pubmed_format_citations', {
  description:
    'Get formatted citations for PubMed articles in one or more formats (apa, mla, bibtex, ris, vancouver). Pass a single format as a string or multiple as an array.',
  annotations: { readOnlyHint: true, openWorldHint: true },
  _meta: conceptMeta([SCHEMA_CREATIVE_WORK, EDAM_DATA_FORMATTING]),
  sourceUrl:
    'https://github.com/cyanheads/pubmed-mcp-server/blob/main/src/mcp-server/tools/definitions/format-citations.tool.ts',

  errors: [...NCBI_SERVICE_ERRORS] as const,

  // Never advertised; rewritten to the canonical key before the schema parses. (#156)
  inputAliases: { ids: 'pmids' },

  input: z.object({
    pmids: z.array(pmidStringSchema).min(1).max(50).describe('PubMed IDs to cite'),
    format: z
      .union(
        [
          CitationStyleEnum.describe(
            'Single citation style. One of: apa, mla, bibtex, ris, vancouver.',
          ),
          z
            .array(CitationStyleEnum)
            .min(1)
            .describe(
              'Multiple citation styles to generate. Each entry: apa, mla, bibtex, ris, or vancouver.',
            ),
        ],
        { error: CITATION_STYLE_ERROR },
      )
      .default('apa')
      .describe(
        'Citation format(s) to generate — single style as a string or multiple as an array. Allowed values: apa, mla, bibtex, ris, vancouver.',
      ),
  }),

  output: z.object({
    citations: z
      .array(
        z
          .object({
            pmid: z.string().describe('PubMed ID'),
            title: z.string().optional().describe('Article title'),
            citations: z.record(z.string(), z.string()).describe('Citations keyed by style'),
          })
          .describe('Citations for a single article'),
      )
      .describe('Citations per article'),
    totalSubmitted: z.number().describe('Number of PMIDs submitted for citation formatting'),
    totalFormatted: z.number().describe('Number of PMIDs successfully formatted'),
    unavailablePmids: z
      .array(z.string())
      .optional()
      .describe(
        'PMIDs PubMed returned no record for, so nothing could be cited for them. That is all this reports: PubMed omits a PMID it does not recognize silently, with no error and no reason, so the absence says nothing about whether the PMID exists. Use `pubmed_search_articles` to find PMIDs that do resolve.',
      ),
  }),

  // Recovery guidance when nothing could be formatted — agent-facing context, surfaced
  // via ctx.enrich.notice() to both structuredContent and content[]; absent on success.
  enrichment: {
    notice: z
      .string()
      .optional()
      .describe(
        'Optional guidance when no citations were produced — points to discovery tools. Absent when at least one citation was produced.',
      ),
  },

  async handler(input, ctx) {
    const formats: CitationStyle[] = Array.isArray(input.format) ? input.format : [input.format];
    ctx.log.debug('Fetching articles for citation generation', {
      pmids: input.pmids,
      formats,
    });
    // NCBI reads `00000001` as PMID 1 and answers with `<PMID>1</PMID>`, so the
    // request and the unavailability diff below both use the canonical form;
    // `unavailablePmids` still reports the caller's own spelling. (#161)
    const requested = [...new Set(input.pmids.map(normalizePmid))];
    const raw = await getNcbiService().eFetch(
      { db: 'pubmed', id: requested.join(','), retmode: 'xml' },
      { retmode: 'xml', usePost: requested.length >= 25, signal: ctx.signal },
    );
    // Reads both members of the set. Taking `PubmedArticleSet.PubmedArticle`
    // alone discards every NCBI Bookshelf record, leaving a chapter or book
    // uncitable and its PMID reported unavailable. (#114)
    const citations = parseArticleSet(raw?.PubmedArticleSet).map((parsed) => ({
      pmid: parsed.pmid,
      title: parsed.title,
      citations: formatCitations(parsed, formats),
    }));

    const returnedPmids = new Set(citations.map((entry) => entry.pmid));
    const unavailablePmids = input.pmids.filter((pmid) => !returnedPmids.has(normalizePmid(pmid)));

    if (citations.length === 0) {
      ctx.enrich.notice(
        'No articles were returned: PubMed matched no record to any of the submitted PMIDs. It omits a PMID it does not recognize silently, without an error or a reason, so nothing more than that is known here. Try pubmed_search_articles to discover PMIDs that resolve, or pubmed_spell_check if these came from a noisy source.',
      );
    }
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
