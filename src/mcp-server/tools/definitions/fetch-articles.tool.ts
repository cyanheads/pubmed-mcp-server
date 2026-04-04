/**
 * @fileoverview PubMed fetch tool. Fetches full article metadata by PubMed IDs,
 * including abstracts, authors, journal info, and MeSH terms.
 * @module src/mcp-server/tools/definitions/fetch-articles.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { getNcbiService } from '@/services/ncbi/ncbi-service.js';
import { parseFullArticle } from '@/services/ncbi/parsing/article-parser.js';
import { ensureArray } from '@/services/ncbi/parsing/xml-helpers.js';
import type { XmlPubmedArticle } from '@/services/ncbi/types.js';

export const fetchArticlesTool = tool('pubmed_fetch_articles', {
  description:
    'Fetch full article metadata by PubMed IDs. Returns detailed article information including abstract, authors, journal, MeSH terms.',
  annotations: { readOnlyHint: true, openWorldHint: true },

  input: z.object({
    pmids: z.array(z.string().regex(/^\d+$/)).min(1).max(200).describe('PubMed IDs to fetch'),
    includeMesh: z.boolean().default(true).describe('Include MeSH terms'),
    includeGrants: z.boolean().default(false).describe('Include grant information'),
  }),

  output: z.object({
    articles: z
      .array(
        z.object({
          pmid: z.string().optional().describe('PubMed ID'),
          title: z.string().optional().describe('Article title'),
          abstractText: z.string().optional().describe('Abstract text'),
          affiliations: z.array(z.string()).optional().describe('Deduplicated author affiliations'),
          authors: z
            .array(
              z.object({
                lastName: z.string().optional().describe('Last name'),
                firstName: z.string().optional().describe('First/given name'),
                initials: z.string().optional().describe('Author initials'),
                collectiveName: z.string().optional().describe('Group/collective author name'),
                affiliationIndices: z
                  .array(z.number())
                  .optional()
                  .describe('Indices into the top-level affiliations array'),
                orcid: z.string().optional().describe('ORCID identifier'),
              }),
            )
            .optional()
            .describe('Author list'),
          journalInfo: z
            .object({
              title: z.string().optional().describe('Full journal title'),
              isoAbbreviation: z.string().optional().describe('ISO journal abbreviation'),
              issn: z.string().optional().describe('Print ISSN'),
              eIssn: z.string().optional().describe('Electronic ISSN'),
              volume: z.string().optional().describe('Volume number'),
              issue: z.string().optional().describe('Issue number'),
              pages: z.string().optional().describe('Page range (e.g. "48-55")'),
              publicationDate: z
                .object({
                  year: z.string().optional().describe('Publication year'),
                  month: z.string().optional().describe('Publication month'),
                  day: z.string().optional().describe('Publication day'),
                  medlineDate: z
                    .string()
                    .optional()
                    .describe('Non-standard date string (e.g. "2000 Spring")'),
                })
                .optional()
                .describe('Journal publication date'),
            })
            .optional()
            .describe('Journal information'),
          doi: z.string().optional().describe('DOI'),
          pmcId: z.string().optional().describe('PMC ID'),
          pubmedUrl: z.string().optional().describe('PubMed article URL'),
          pmcUrl: z.string().optional().describe('PMC full text URL'),
          publicationTypes: z.array(z.string()).optional().describe('Publication types'),
          keywords: z.array(z.string()).optional().describe('Keywords'),
          meshTerms: z
            .array(
              z.object({
                descriptorName: z.string().optional().describe('MeSH descriptor name'),
                descriptorUi: z.string().optional().describe('MeSH descriptor unique ID'),
                isMajorTopic: z.boolean().describe('Whether this is a major topic of the article'),
                qualifiers: z
                  .array(
                    z.object({
                      qualifierName: z.string().describe('Qualifier/subheading name'),
                      qualifierUi: z.string().optional().describe('Qualifier unique ID'),
                      isMajorTopic: z.boolean().describe('Whether this qualifier is a major topic'),
                    }),
                  )
                  .optional()
                  .describe('MeSH qualifiers/subheadings'),
              }),
            )
            .optional()
            .describe('MeSH terms'),
          grantList: z
            .array(
              z.object({
                grantId: z.string().optional().describe('Grant identifier'),
                acronym: z.string().optional().describe('Grant acronym'),
                agency: z.string().optional().describe('Funding agency'),
                country: z.string().optional().describe('Agency country'),
              }),
            )
            .optional()
            .describe('Grant information'),
          articleDates: z
            .array(
              z.object({
                dateType: z.string().optional().describe('Date type'),
                year: z.string().optional().describe('Year'),
                month: z.string().optional().describe('Month'),
                day: z.string().optional().describe('Day'),
              }),
            )
            .optional()
            .describe('Article dates'),
        }),
      )
      .describe('Parsed articles'),
    totalReturned: z.number().describe('Number of articles returned'),
    unavailablePmids: z
      .array(z.string())
      .optional()
      .describe('PMIDs that returned no article data'),
  }),

  async handler(input, ctx) {
    ctx.log.info('Executing pubmed_fetch', { pmidCount: input.pmids.length });

    const xmlData = await getNcbiService().eFetch(
      { db: 'pubmed', id: input.pmids.join(','), retmode: 'xml' },
      { retmode: 'xml', usePost: input.pmids.length >= 100 },
    );

    if (!xmlData || !('PubmedArticleSet' in xmlData)) {
      throw new Error('Invalid EFetch response from NCBI: missing PubmedArticleSet');
    }

    if (!xmlData.PubmedArticleSet?.PubmedArticle) {
      return { articles: [], totalReturned: 0 };
    }

    const xmlArticles = ensureArray(xmlData.PubmedArticleSet.PubmedArticle) as XmlPubmedArticle[];
    const articles = xmlArticles
      .filter((a) => a?.MedlineCitation)
      .map((a) => {
        const parsed = parseFullArticle(a, {
          includeMesh: input.includeMesh,
          includeGrants: input.includeGrants,
        });
        return {
          ...parsed,
          pubmedUrl: `https://pubmed.ncbi.nlm.nih.gov/${parsed.pmid}/`,
          ...(parsed.pmcId && {
            pmcUrl: `https://www.ncbi.nlm.nih.gov/pmc/articles/${parsed.pmcId}/`,
          }),
        };
      });

    const returnedPmids = new Set(articles.map((a) => a.pmid).filter(Boolean));
    const unavailable = input.pmids.filter((id) => !returnedPmids.has(id));

    ctx.log.info('pubmed_fetch completed', {
      requested: input.pmids.length,
      returned: articles.length,
    });
    return {
      articles,
      totalReturned: articles.length,
      ...(unavailable.length > 0 && { unavailablePmids: unavailable }),
    };
  },

  format: (result) => {
    const lines = [`## PubMed Articles`, `**Articles Returned:** ${result.totalReturned}`];
    if (result.unavailablePmids?.length)
      lines.push(`**Unavailable PMIDs:** ${result.unavailablePmids.join(', ')}`);
    for (const a of result.articles) {
      lines.push(`\n### ${a.title ?? a.pmid ?? 'Unknown'}`);
      if (a.authors?.length) {
        const fmtAuthor = (au: (typeof a.authors)[number]) =>
          au.collectiveName ?? `${au.lastName ?? ''} ${au.initials ?? ''}`.trim();
        const first3 = a.authors.slice(0, 3).map(fmtAuthor).join(', ');
        const authorStr = a.authors.length > 3 ? `${first3}, et al.` : first3;
        lines.push(`**Authors:** ${authorStr}`);
      }
      if (a.affiliations?.length) lines.push(`**Affiliations:** ${a.affiliations.join('; ')}`);
      const ji = a.journalInfo;
      if (ji) {
        const parts = [ji.isoAbbreviation ?? ji.title];
        const year = ji.publicationDate?.year;
        if (year) parts.push(year);
        if (ji.volume) parts.push(`**${ji.volume}**${ji.issue ? `(${ji.issue})` : ''}`);
        if (ji.pages) parts.push(ji.pages);
        lines.push(`**Journal:** ${parts.filter(Boolean).join(', ')}`);
      }
      if (a.publicationTypes?.length) lines.push(`**Type:** ${a.publicationTypes.join(', ')}`);
      if (a.pmid) lines.push(`**PMID:** ${a.pmid}`);
      if (a.doi) lines.push(`**DOI:** ${a.doi}`);
      if (a.pubmedUrl) lines.push(`**PubMed:** ${a.pubmedUrl}`);
      if (a.pmcUrl) lines.push(`**PMC:** ${a.pmcUrl}`);
      if (a.abstractText) lines.push(`\n#### Abstract\n${a.abstractText}`);
      if (a.keywords?.length) lines.push(`\n**Keywords:** ${a.keywords.join(', ')}`);
      if (a.meshTerms?.length) {
        lines.push(`\n#### MeSH Terms`);
        for (const m of a.meshTerms) {
          const major = m.isMajorTopic ? ' *' : '';
          const qualifiers = m.qualifiers?.length
            ? ` (${m.qualifiers.map((q) => `${q.qualifierName}${q.isMajorTopic ? '*' : ''}`).join(', ')})`
            : '';
          lines.push(`- ${m.descriptorName}${major}${qualifiers}`);
        }
      }
      if (a.grantList?.length) {
        lines.push(`\n#### Grants`);
        for (const g of a.grantList) {
          const parts = [g.grantId, g.agency, g.country].filter(Boolean);
          lines.push(`- ${parts.join(' — ')}`);
        }
      }
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
