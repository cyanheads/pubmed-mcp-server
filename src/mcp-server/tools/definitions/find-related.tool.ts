/**
 * @fileoverview PubMed related articles tool — finds articles related to a
 * source article via NCBI ELink and enriches results with ESummary data.
 * @module src/mcp-server/tools/definitions/find-related.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { getNcbiService } from '@/services/ncbi/ncbi-service.js';
import { extractBriefSummaries } from '@/services/ncbi/parsing/esummary-parser.js';
import { ensureArray } from '@/services/ncbi/parsing/xml-helpers.js';
import { conceptMeta, EDAM_DATA_RETRIEVAL, SCHEMA_SCHOLARLY_ARTICLE } from './_concepts.js';
import { pmidStringSchema } from './_schemas.js';

// ─── ELink XML types ─────────────────────────────────────────────────────────

interface XmlELinkItem {
  Id: string | number | { '#text'?: string | number };
  Score?: string | number | { '#text'?: string | number };
}

interface ELinkLinkSetDb {
  Link?: XmlELinkItem | XmlELinkItem[];
  LinkName?: string;
}

interface ELinkResultItem {
  ERROR?: string;
  LinkSet?: { LinkSetDb?: ELinkLinkSetDb | ELinkLinkSetDb[] };
}

interface ELinkResponse {
  eLinkResult?: ELinkResultItem | ELinkResultItem[];
}

function extractValue(field: string | number | { '#text'?: string | number } | undefined): string {
  if (field === undefined || field === null) return '';
  if (typeof field === 'object') return field['#text'] !== undefined ? String(field['#text']) : '';
  return String(field);
}

// ─── Tool Definition ─────────────────────────────────────────────────────────

export const findRelatedTool = tool('pubmed_find_related', {
  description:
    'Find articles related to a source article — similar content, citing articles, or references.',
  annotations: { readOnlyHint: true, openWorldHint: true },
  _meta: conceptMeta([SCHEMA_SCHOLARLY_ARTICLE, EDAM_DATA_RETRIEVAL]),
  sourceUrl:
    'https://github.com/cyanheads/pubmed-mcp-server/blob/main/src/mcp-server/tools/definitions/find-related.tool.ts',

  input: z.object({
    pmid: pmidStringSchema.describe('Source PubMed ID'),
    relationship: z
      .enum(['similar', 'cited_by', 'references'])
      .default('similar')
      .describe(
        'Relationship type: similar (content-based), cited_by (articles citing this one), references (articles this one cites)',
      ),
    maxResults: z.number().int().min(1).max(50).default(10).describe('Maximum related articles'),
  }),

  output: z.object({
    sourcePmid: z.string().describe('Source PubMed ID'),
    relationship: z.enum(['similar', 'cited_by', 'references']).describe('Relationship type used'),
    articles: z
      .array(
        z
          .object({
            pmid: z.string().describe('PubMed ID'),
            title: z.string().optional().describe('Article title'),
            authors: z.string().optional().describe('Author string'),
            source: z.string().optional().describe('Journal source'),
            pubDate: z.string().optional().describe('Publication date'),
            score: z
              .number()
              .optional()
              .describe(
                'NCBI relevance score (arbitrary scale, higher = more related; only present for similar)',
              ),
          })
          .describe('Related article with enriched summary'),
      )
      .describe('Related articles'),
    totalFound: z.number().describe('Total related articles found before truncation'),
    notice: z
      .string()
      .optional()
      .describe(
        'Optional guidance when results are empty due to a known limitation — e.g. references for a non-PMC source. Absent on successful result pages.',
      ),
  }),

  async handler(input, ctx) {
    const ncbi = getNcbiService();
    ctx.log.debug('Finding related articles', {
      pmid: input.pmid,
      relationship: input.relationship,
    });

    const eLinkParams: Record<string, string> = {
      dbfrom: 'pubmed',
      db: 'pubmed',
      id: input.pmid,
      retmode: 'xml',
    };
    switch (input.relationship) {
      case 'similar':
        eLinkParams.cmd = 'neighbor_score';
        break;
      case 'cited_by':
        eLinkParams.cmd = 'neighbor';
        eLinkParams.linkname = 'pubmed_pubmed_citedin';
        break;
      case 'references':
        eLinkParams.cmd = 'neighbor';
        eLinkParams.linkname = 'pubmed_pubmed_refs';
        break;
    }

    const eLinkResult = (await ncbi.eLink(eLinkParams, { signal: ctx.signal })) as ELinkResponse;
    const eLinkResultsArray = ensureArray(eLinkResult?.eLinkResult);
    const firstResult = eLinkResultsArray[0] as ELinkResultItem | undefined;

    if (firstResult?.ERROR) {
      throw new Error(
        `ELink error: ${typeof firstResult.ERROR === 'string' ? firstResult.ERROR : JSON.stringify(firstResult.ERROR)}`,
      );
    }

    const linkSet = firstResult?.LinkSet;
    let foundPmids: { pmid: string; score?: number }[] = [];

    if (linkSet?.LinkSetDb) {
      const linkSetDbArray = ensureArray(linkSet.LinkSetDb);
      const expectedLinkName =
        input.relationship === 'cited_by'
          ? 'pubmed_pubmed_citedin'
          : input.relationship === 'references'
            ? 'pubmed_pubmed_refs'
            : 'pubmed_pubmed';
      const targetDb =
        linkSetDbArray.find((db) => db.LinkName === expectedLinkName) ?? linkSetDbArray[0];

      if (targetDb?.Link) {
        foundPmids = ensureArray(targetDb.Link)
          .map((link: XmlELinkItem) => ({
            pmid: extractValue(link.Id),
            ...(extractValue(link.Score) ? { score: Number(extractValue(link.Score)) } : {}),
          }))
          .filter((item) => item.pmid && item.pmid !== input.pmid && item.pmid !== '0');
      }
    }

    const totalFound = foundPmids.length;
    if (foundPmids.length === 0) {
      // NCBI's pubmed_pubmed_refs ELink only resolves reference lists for
      // PMC-indexed sources, so a valid PMID without a PMCID looks identical
      // to "this article cites nothing". Look up the source's PMCID so the
      // caller gets a relationship-aware recovery hint.
      let notice: string | undefined;
      if (input.relationship === 'references') {
        try {
          const summaryResult = await ncbi.eSummary(
            { db: 'pubmed', id: input.pmid },
            { signal: ctx.signal },
          );
          const summaries = await extractBriefSummaries(summaryResult);
          const sourcePmcId = summaries[0]?.pmcId;
          notice = sourcePmcId
            ? `No reference list found in PMC for PMID ${input.pmid} (PMCID ${sourcePmcId}).`
            : `Reference lists require the source article to be indexed in PMC. PMID ${input.pmid} has no PMCID — references unavailable. Use pubmed_fetch_articles to inspect the article record, or try relationship: "similar" / "cited_by".`;
        } catch (err) {
          ctx.log.debug('Failed to look up source PMCID for references hint', { err });
        }
      }
      return {
        sourcePmid: input.pmid,
        relationship: input.relationship,
        articles: [],
        totalFound: 0,
        ...(notice && { notice }),
      };
    }

    if (foundPmids.every((p) => p.score !== undefined)) {
      foundPmids.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
    }

    const pmidsToEnrich = foundPmids.slice(0, input.maxResults);
    const summaryResult = await ncbi.eSummary(
      {
        db: 'pubmed',
        id: pmidsToEnrich.map((p) => p.pmid).join(','),
      },
      { signal: ctx.signal },
    );
    const briefSummaries = await extractBriefSummaries(summaryResult);
    const summaryMap = new Map(briefSummaries.map((bs) => [bs.pmid, bs]));

    const articles = pmidsToEnrich.map((p) => {
      const details = summaryMap.get(p.pmid);
      return {
        pmid: p.pmid,
        title: details?.title,
        authors: details?.authors,
        source: details?.source,
        pubDate: details?.pubDate,
        score: p.score,
      };
    });

    return { sourcePmid: input.pmid, relationship: input.relationship, articles, totalFound };
  },

  format: (result) => {
    const lines = [
      `# Related Articles for PMID ${result.sourcePmid}`,
      `**Relationship:** ${result.relationship} | **Found:** ${result.totalFound}`,
    ];
    if (result.notice) lines.push(`\n> ${result.notice}`);
    if (result.articles.length === 0) {
      if (!result.notice) lines.push('No related articles found.');
    } else {
      for (const a of result.articles) {
        const scorePart = a.score !== undefined ? ` (score: ${a.score})` : '';
        lines.push(
          `- **[PMID ${a.pmid}](https://pubmed.ncbi.nlm.nih.gov/${a.pmid}/)**${scorePart}`,
        );
        if (a.title) lines.push(`  ${a.title}`);
        if (a.authors) lines.push(`  *${a.authors}*`);
        const meta = [a.source, a.pubDate].filter(Boolean).join(', ');
        if (meta) lines.push(`  ${meta}`);
      }
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
