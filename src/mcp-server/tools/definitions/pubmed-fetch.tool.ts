/**
 * @fileoverview PubMed fetch tool definition. Fetches full article metadata by
 * PubMed IDs, including abstracts, authors, journal info, and MeSH terms.
 * @module src/mcp-server/tools/definitions/pubmed-fetch.tool
 */

import type { ContentBlock } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

import { container } from '@/container/core/container.js';
import { NcbiServiceToken } from '@/container/core/tokens.js';
import type { SdkContext, ToolDefinition } from '@/mcp-server/tools/utils/toolDefinition.js';
import { withToolAuth } from '@/mcp-server/transports/auth/lib/withAuth.js';
import { parseFullArticle } from '@/services/ncbi/parsing/article-parser.js';
import { ensureArray } from '@/services/ncbi/parsing/xml-helpers.js';
import type { XmlPubmedArticle } from '@/services/ncbi/types.js';
import { JsonRpcErrorCode, McpError } from '@/types-global/errors.js';
import { markdown } from '@/utils/formatting/markdownBuilder.js';
import { logger } from '@/utils/internal/logger.js';
import type { RequestContext } from '@/utils/internal/requestContext.js';

const ncbi = () => container.resolve(NcbiServiceToken);

// ─── Metadata ────────────────────────────────────────────────────────────────

const TOOL_NAME = 'pubmed_fetch';
const TOOL_TITLE = 'PubMed Fetch';
const TOOL_DESCRIPTION =
  'Fetch full article metadata by PubMed IDs. Returns detailed article information including abstract, authors, journal, MeSH terms.';
const TOOL_ANNOTATIONS = {
  readOnlyHint: true,
  idempotentHint: true,
  openWorldHint: true,
} as const;

// ─── Schemas ─────────────────────────────────────────────────────────────────

const InputSchema = z.object({
  pmids: z.array(z.string().regex(/^\d+$/)).min(1).max(200).describe('PubMed IDs to fetch'),
  includeMesh: z.boolean().default(true).describe('Include MeSH terms'),
  includeGrants: z.boolean().default(false).describe('Include grant information'),
});

const ArticleSchema = z.object({
  pmid: z.string().optional().describe('PubMed ID'),
  title: z.string().optional().describe('Article title'),
  abstractText: z.string().optional().describe('Abstract text'),
  affiliations: z.array(z.string()).optional().describe('Deduplicated author affiliations'),
  authors: z.array(z.any()).optional().describe('Author list'),
  journalInfo: z.any().optional().describe('Journal information'),
  doi: z.string().optional().describe('Digital Object Identifier'),
  pmcId: z.string().optional().describe('PubMed Central ID (e.g. PMC1234567)'),
  pubmedUrl: z.string().optional().describe('PubMed article URL'),
  pmcUrl: z.string().optional().describe('PubMed Central full text URL (when available)'),
  publicationTypes: z.array(z.string()).optional().describe('Publication types'),
  keywords: z.array(z.string()).optional().describe('Keywords'),
  meshTerms: z.array(z.any()).optional().describe('MeSH terms'),
  grantList: z.array(z.any()).optional().describe('Grant information'),
  articleDates: z
    .array(
      z.object({
        dateType: z.string().optional().describe('Date type (e.g. "Electronic", "received")'),
        year: z.string().optional().describe('Year'),
        month: z.string().optional().describe('Month'),
        day: z.string().optional().describe('Day'),
      }),
    )
    .optional()
    .describe('Article dates (e.g. electronic publication, received, accepted)'),
});

const OutputSchema = z.object({
  articles: z.array(ArticleSchema).describe('Parsed articles'),
  totalReturned: z.number().describe('Number of articles returned'),
});

// ─── Types ───────────────────────────────────────────────────────────────────

type Input = z.infer<typeof InputSchema>;
type Output = z.infer<typeof OutputSchema>;

// ─── Logic ───────────────────────────────────────────────────────────────────

async function logic(
  input: Input,
  appContext: RequestContext,
  _sdkContext: SdkContext,
): Promise<Output> {
  logger.info('Executing pubmed_fetch tool', {
    ...appContext,
    pmidCount: input.pmids.length,
  });

  const xmlData = await ncbi().eFetch(
    { db: 'pubmed', id: input.pmids.join(','), retmode: 'xml' },
    appContext,
    { retmode: 'xml', usePost: input.pmids.length > 200 },
  );

  // Structural parse failure — missing top-level key entirely
  if (!xmlData || !('PubmedArticleSet' in xmlData)) {
    throw new McpError(
      JsonRpcErrorCode.InternalError,
      'Invalid EFetch response from NCBI: missing PubmedArticleSet',
      { requestId: appContext.requestId },
    );
  }

  // Empty PubmedArticleSet (all PMIDs invalid) — return empty result
  if (!xmlData.PubmedArticleSet || !xmlData.PubmedArticleSet.PubmedArticle) {
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

  logger.notice('pubmed_fetch completed', {
    ...appContext,
    requested: input.pmids.length,
    returned: articles.length,
  });

  return { articles, totalReturned: articles.length };
}

// ─── Response Formatter ──────────────────────────────────────────────────────

function responseFormatter(result: Output): ContentBlock[] {
  const md = markdown().h2('PubMed Articles').keyValue('Articles Returned', result.totalReturned);

  for (const article of result.articles) {
    md.h3(article.title ?? article.pmid ?? 'Unknown');
    if (article.pmid) md.keyValue('PMID', article.pmid);
    if (article.doi) md.keyValue('DOI', article.doi);
    if (article.pubmedUrl) md.keyValue('PubMed', article.pubmedUrl);
    if (article.pmcUrl) md.keyValue('PMC', article.pmcUrl);

    if (article.authors?.length) {
      const authorStr = article.authors
        .slice(0, 5)
        .map(
          (a: { lastName?: string; initials?: string; collectiveName?: string }) =>
            a.collectiveName ?? `${a.lastName ?? ''} ${a.initials ?? ''}`.trim(),
        )
        .join(', ');
      md.keyValue('Authors', article.authors.length > 5 ? `${authorStr}, et al.` : authorStr);
    }

    if (article.journalInfo) {
      const ji = article.journalInfo;
      const parts = [ji.title, ji.volume && `${ji.volume}`, ji.pages].filter(Boolean);
      if (parts.length > 0) md.keyValue('Journal', parts.join(', '));
    }

    if (article.abstractText) {
      md.h4('Abstract').paragraph(article.abstractText);
    }

    if (article.meshTerms?.length) {
      md.keyValue(
        'MeSH Terms',
        article.meshTerms
          .map((m: { descriptorName?: string }) => m.descriptorName)
          .filter(Boolean)
          .join('; '),
      );
    }

    if (article.keywords?.length) {
      md.keyValue('Keywords', article.keywords.join('; '));
    }
  }

  return [{ type: 'text', text: md.build() }];
}

// ─── Export ──────────────────────────────────────────────────────────────────

export const pubmedFetchTool: ToolDefinition<typeof InputSchema, typeof OutputSchema> = {
  name: TOOL_NAME,
  title: TOOL_TITLE,
  description: TOOL_DESCRIPTION,
  annotations: TOOL_ANNOTATIONS,
  inputSchema: InputSchema,
  outputSchema: OutputSchema,
  logic: withToolAuth(['tool:pubmed_fetch:read'], logic),
  responseFormatter,
};
