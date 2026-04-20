/**
 * @fileoverview PMC full-text fetch tool. Retrieves full-text articles from PubMed
 * Central via NCBI EFetch with db=pmc. Supports PMCID input or PMID-to-PMCID resolution.
 * @module src/mcp-server/tools/definitions/fetch-fulltext.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { getNcbiService } from '@/services/ncbi/ncbi-service.js';
import { parsePmcArticle } from '@/services/ncbi/parsing/pmc-article-parser.js';
import { findAll, findOne, type JatsNodeList } from '@/services/ncbi/parsing/pmc-xml-helpers.js';
import type { ParsedPmcArticle } from '@/services/ncbi/types.js';

function normalizePmcId(id: string): string {
  return id.replace(/^PMC/i, '');
}

async function resolvePmidsToPmcIds(
  pmids: string[],
): Promise<{ resolved: Map<string, string>; unavailable: string[] }> {
  const records = await getNcbiService().idConvert(pmids, 'pmid');
  const resolved = new Map<string, string>();
  for (const record of records) {
    if (record.pmid !== undefined && record.pmcid) {
      resolved.set(String(record.pmid), normalizePmcId(String(record.pmcid)));
    }
  }
  return { resolved, unavailable: pmids.filter((pmid) => !resolved.has(pmid)) };
}

function filterSections(
  sections: ParsedPmcArticle['sections'],
  sectionFilter: string[],
): ParsedPmcArticle['sections'] {
  const lowerFilter = sectionFilter.map((s) => s.toLowerCase());
  return sections.filter(
    (s) => s.title && lowerFilter.some((f) => s.title?.toLowerCase().includes(f)),
  );
}

// ─── Tool Definition ─────────────────────────────────────────────────────────

const SubsectionSchema = z.object({
  title: z.string().optional().describe('Subsection heading'),
  label: z.string().optional().describe('Subsection label'),
  text: z.string().describe('Subsection body text'),
});

const SectionSchema = z.object({
  title: z.string().optional().describe('Section heading'),
  label: z.string().optional().describe('Section label'),
  text: z.string().describe('Section body text'),
  subsections: z.array(SubsectionSchema).optional().describe('Nested subsections'),
});

export const fetchFulltextTool = tool('pubmed_fetch_fulltext', {
  description:
    'Fetch full-text articles from PubMed Central (PMC). Returns complete article body text, sections, and references for open-access articles. Accepts PMC IDs directly or PubMed IDs (auto-resolved via the PMC ID Converter).',
  annotations: { readOnlyHint: true, openWorldHint: true },

  input: z.object({
    pmcids: z
      .array(z.string())
      .min(1)
      .max(10)
      .optional()
      .describe('PMC IDs to fetch (e.g. ["PMC9575052"]). Provide this OR pmids, not both.'),
    pmids: z
      .array(z.string().regex(/^\d+$/))
      .min(1)
      .max(10)
      .optional()
      .describe(
        'PubMed IDs to resolve to PMC full text. Provide this OR pmcids, not both. Only works for open-access articles available in PMC.',
      ),
    includeReferences: z.boolean().default(false).describe('Include reference list'),
    maxSections: z
      .number()
      .int()
      .min(1)
      .max(50)
      .optional()
      .describe('Maximum top-level body sections'),
    sections: z
      .array(z.string())
      .optional()
      .describe(
        'Filter to specific sections by title, case-insensitive (e.g. ["Introduction", "Methods", "Results", "Discussion"])',
      ),
  }),

  output: z.object({
    articles: z
      .array(
        z.object({
          pmcId: z.string().describe('PMC ID'),
          pmcUrl: z.string().describe('PMC URL'),
          pmid: z.string().optional().describe('PubMed ID'),
          pubmedUrl: z.string().optional().describe('PubMed URL'),
          title: z.string().optional().describe('Article title'),
          abstract: z.string().optional().describe('Abstract'),
          authors: z
            .array(
              z.object({
                collectiveName: z.string().optional().describe('Group name'),
                givenNames: z.string().optional().describe('Given names'),
                lastName: z.string().optional().describe('Last name'),
              }),
            )
            .optional()
            .describe('Authors'),
          doi: z.string().optional().describe('DOI'),
          journal: z
            .object({
              title: z.string().optional().describe('Journal title'),
              issn: z.string().optional().describe('ISSN'),
              volume: z.string().optional().describe('Volume number'),
              issue: z.string().optional().describe('Issue number'),
              pages: z.string().optional().describe('Page range'),
            })
            .optional()
            .describe('Journal information'),
          keywords: z.array(z.string()).optional().describe('Keywords'),
          sections: z.array(SectionSchema).describe('Article body sections'),
          references: z
            .array(
              z.object({
                citation: z.string().describe('Citation text'),
                id: z.string().optional().describe('Reference ID'),
                label: z.string().optional().describe('Reference label'),
              }),
            )
            .optional()
            .describe('Reference list'),
          articleType: z.string().optional().describe('Article type'),
          affiliations: z.array(z.string()).optional().describe('Author affiliations'),
          publicationDate: z
            .object({
              year: z.string().optional().describe('Publication year'),
              month: z.string().optional().describe('Publication month'),
              day: z.string().optional().describe('Publication day'),
            })
            .optional()
            .describe('Publication date'),
        }),
      )
      .describe('Full-text articles'),
    totalReturned: z.number().describe('Number of articles returned'),
    unavailablePmids: z.array(z.string()).optional().describe('PMIDs not available in PMC'),
    unavailablePmcIds: z.array(z.string()).optional().describe('PMC IDs that returned no data'),
  }),

  async handler(input, ctx) {
    ctx.log.info('Executing pubmed_pmc_fetch', {
      hasPmcids: !!input.pmcids,
      hasPmids: !!input.pmids,
      idCount: (input.pmcids ?? input.pmids)?.length,
    });

    if (!input.pmcids && !input.pmids) throw new Error('Either pmcids or pmids must be provided');
    if (input.pmcids && input.pmids) throw new Error('Provide pmcids or pmids, not both');

    let pmcIds: string[];
    let unavailablePmids: string[] | undefined;

    if (input.pmids) {
      const resolution = await resolvePmidsToPmcIds(input.pmids);
      if (resolution.resolved.size === 0) {
        return { articles: [], totalReturned: 0, unavailablePmids: input.pmids };
      }
      pmcIds = [...resolution.resolved.values()];
      if (resolution.unavailable.length > 0) unavailablePmids = resolution.unavailable;
    } else {
      pmcIds = (input.pmcids ?? []).map(normalizePmcId);
    }

    const xmlData = await getNcbiService().eFetch<JatsNodeList>(
      { db: 'pmc', id: pmcIds.join(','), retmode: 'xml' },
      { retmode: 'xml', useOrderedParser: true, usePost: pmcIds.length > 5 },
    );

    const articleSet = findOne(xmlData, 'pmc-articleset');
    if (!articleSet) {
      throw new Error('Invalid PMC EFetch response: missing pmc-articleset');
    }

    let articles: ParsedPmcArticle[] = findAll(articleSet, 'article').map(parsePmcArticle);

    if (input.sections?.length) {
      const sectionFilter = input.sections;
      articles = articles.map((a) => ({
        ...a,
        sections: filterSections(a.sections, sectionFilter),
      }));
    }
    if (input.maxSections !== undefined)
      articles = articles.map((a) => ({ ...a, sections: a.sections.slice(0, input.maxSections) }));
    if (!input.includeReferences)
      articles = articles.map(({ references: _, ...rest }) => rest as ParsedPmcArticle);

    const returnedPmcIds = new Set(articles.map((a) => a.pmcId));
    const missingPmcIds = pmcIds
      .map((id) => (id.startsWith('PMC') ? id : `PMC${id}`))
      .filter((id) => !returnedPmcIds.has(id));

    ctx.log.info('pubmed_pmc_fetch completed', {
      requested: pmcIds.length,
      returned: articles.length,
    });
    return {
      articles,
      totalReturned: articles.length,
      ...(unavailablePmids && { unavailablePmids }),
      ...(missingPmcIds.length > 0 && { unavailablePmcIds: missingPmcIds }),
    };
  },

  format: (result) => {
    const lines = [`## PMC Full-Text Articles`, `**Articles Returned:** ${result.totalReturned}`];
    if (result.unavailablePmids?.length)
      lines.push(`**Unavailable PMIDs:** ${result.unavailablePmids.join(', ')}`);
    if (result.unavailablePmcIds?.length)
      lines.push(`**Unavailable PMC IDs:** ${result.unavailablePmcIds.join(', ')}`);
    for (const a of result.articles) {
      lines.push(`\n### ${a.title ?? a.pmcId}`);
      if (a.authors?.length) {
        const fmtAuthor = (au: (typeof a.authors)[number]) =>
          au.collectiveName ??
          `${au.lastName ?? ''}${au.givenNames ? ` ${au.givenNames}` : ''}`.trim();
        const first3 = a.authors.slice(0, 3).map(fmtAuthor).join(', ');
        const authorStr = a.authors.length > 3 ? `${first3}, et al.` : first3;
        lines.push(`**Authors:** ${authorStr}`);
      }
      if (a.affiliations?.length) lines.push(`**Affiliations:** ${a.affiliations.join('; ')}`);
      if (a.journal) {
        const parts = [a.journal.title];
        if (a.journal.volume)
          parts.push(`**${a.journal.volume}**${a.journal.issue ? `(${a.journal.issue})` : ''}`);
        if (a.journal.pages) parts.push(a.journal.pages);
        lines.push(`**Journal:** ${parts.filter(Boolean).join(', ')}`);
      }
      if (a.articleType) lines.push(`**Type:** ${a.articleType}`);
      if (a.publicationDate) {
        const d = a.publicationDate;
        const dateParts = [d.year, d.month, d.day].filter(Boolean);
        if (dateParts.length) lines.push(`**Published:** ${dateParts.join('-')}`);
      }
      lines.push(`**PMCID:** ${a.pmcId}`);
      if (a.pmid) lines.push(`**PMID:** ${a.pmid}`);
      if (a.doi) lines.push(`**DOI:** ${a.doi}`);
      lines.push(`**PMC:** ${a.pmcUrl}`);
      if (a.pubmedUrl) lines.push(`**PubMed:** ${a.pubmedUrl}`);
      if (a.keywords?.length) lines.push(`**Keywords:** ${a.keywords.join(', ')}`);
      if (a.abstract) lines.push(`\n#### Abstract\n${a.abstract}`);
      for (const sec of a.sections) {
        if (sec.title) lines.push(`\n#### ${sec.title}`);
        if (sec.text) lines.push(sec.text);
        if (sec.subsections?.length) {
          for (const sub of sec.subsections) {
            if (sub.title) lines.push(`\n##### ${sub.title}`);
            if (sub.text) lines.push(sub.text);
          }
        }
      }
      if (a.references?.length) {
        lines.push(`\n#### References (${a.references.length})`);
        for (const ref of a.references) {
          const label = ref.label ?? ref.id ?? '';
          lines.push(`- ${label ? `[${label}] ` : ''}${ref.citation}`);
        }
      }
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
