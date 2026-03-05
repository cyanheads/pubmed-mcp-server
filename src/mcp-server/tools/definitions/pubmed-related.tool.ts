/**
 * @fileoverview PubMed related articles tool — finds articles related to a
 * source article via NCBI ELink (similar content, citing articles, or
 * references) and enriches results with ESummary data.
 * @module src/mcp-server/tools/definitions/pubmed-related.tool
 */

import type { ContentBlock } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

import { container } from '@/container/core/container.js';
import { NcbiServiceToken } from '@/container/core/tokens.js';
import type { SdkContext, ToolDefinition } from '@/mcp-server/tools/utils/toolDefinition.js';
import { withToolAuth } from '@/mcp-server/transports/auth/lib/withAuth.js';
import { extractBriefSummaries } from '@/services/ncbi/parsing/esummary-parser.js';
import { ensureArray } from '@/services/ncbi/parsing/xml-helpers.js';
import { JsonRpcErrorCode, McpError } from '@/types-global/errors.js';
import { markdown } from '@/utils/formatting/markdownBuilder.js';
import { logger } from '@/utils/internal/logger.js';
import type { RequestContext } from '@/utils/internal/requestContext.js';

const ncbi = () => container.resolve(NcbiServiceToken);

// ---------------------------------------------------------------------------
// Metadata
// ---------------------------------------------------------------------------

const TOOL_NAME = 'pubmed_related';
const TOOL_TITLE = 'PubMed Related Articles';
const TOOL_DESCRIPTION =
  'Find articles related to a source article — similar content, citing articles, or references.';
const TOOL_ANNOTATIONS = {
  readOnlyHint: true,
  idempotentHint: true,
  openWorldHint: true,
} as const;

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const InputSchema = z.object({
  pmid: z.string().regex(/^\d+$/).describe('Source PubMed ID'),
  relationship: z
    .enum(['similar', 'cited_by', 'references'])
    .default('similar')
    .describe('Type of relationship'),
  maxResults: z.number().int().min(1).max(50).default(10).describe('Maximum related articles'),
});

const OutputSchema = z.object({
  sourcePmid: z.string().describe('Source PubMed ID'),
  relationship: z.string().describe('Relationship type used'),
  articles: z
    .array(
      z.object({
        pmid: z.string(),
        title: z.string().optional(),
        authors: z.string().optional(),
        score: z.number().optional(),
      }),
    )
    .describe('Related articles'),
  totalFound: z.number().describe('Total related articles found before truncation'),
});

type Input = z.infer<typeof InputSchema>;
type Output = z.infer<typeof OutputSchema>;

// ---------------------------------------------------------------------------
// ELink XML types (local — match the NCBI response shape)
// ---------------------------------------------------------------------------

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
  LinkSet?: {
    LinkSetDb?: ELinkLinkSetDb | ELinkLinkSetDb[];
  };
}

interface ELinkResponse {
  eLinkResult?: ELinkResultItem | ELinkResultItem[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Extract a string value from an ELink Id/Score field. */
function extractValue(field: string | number | { '#text'?: string | number } | undefined): string {
  if (field === undefined || field === null) return '';
  if (typeof field === 'object') {
    return field['#text'] !== undefined ? String(field['#text']) : '';
  }
  return String(field);
}

// ---------------------------------------------------------------------------
// Logic
// ---------------------------------------------------------------------------

async function logic(
  input: Input,
  appContext: RequestContext,
  _sdkContext: SdkContext,
): Promise<Output> {
  logger.debug('Finding related articles', {
    ...appContext,
    pmid: input.pmid,
    relationship: input.relationship,
  });

  // Build ELink params based on relationship type
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

  const eLinkResult = (await ncbi().eLink(eLinkParams, appContext)) as ELinkResponse;

  logger.debug('Raw ELink response received', {
    ...appContext,
    hasResult: !!eLinkResult?.eLinkResult,
  });

  // Navigate the response — eLinkResult may be array or object
  const eLinkResultsArray = ensureArray(eLinkResult?.eLinkResult);
  const firstResult = eLinkResultsArray[0] as ELinkResultItem | undefined;

  if (firstResult?.ERROR) {
    throw new McpError(
      JsonRpcErrorCode.ServiceUnavailable,
      `ELink error: ${typeof firstResult.ERROR === 'string' ? firstResult.ERROR : JSON.stringify(firstResult.ERROR)}`,
      { requestId: appContext.requestId },
    );
  }

  const linkSet = firstResult?.LinkSet;
  let foundPmids: { pmid: string; score?: number }[] = [];

  if (linkSet?.LinkSetDb) {
    // All relationship types use cmd=neighbor/neighbor_score and return LinkSetDb
    const linkSetDbArray = ensureArray(linkSet.LinkSetDb);

    // Match the expected LinkName for the relationship type
    const expectedLinkName =
      input.relationship === 'cited_by'
        ? 'pubmed_pubmed_citedin'
        : input.relationship === 'references'
          ? 'pubmed_pubmed_refs'
          : 'pubmed_pubmed';
    const targetDb =
      linkSetDbArray.find((db) => db.LinkName === expectedLinkName) ?? linkSetDbArray[0];

    if (targetDb?.Link) {
      const links = ensureArray(targetDb.Link);
      foundPmids = links
        .map((link: XmlELinkItem) => {
          const pmid = extractValue(link.Id);
          const scoreStr = extractValue(link.Score);
          return {
            pmid,
            ...(scoreStr ? { score: Number(scoreStr) } : {}),
          };
        })
        .filter((item) => item.pmid && item.pmid !== input.pmid && item.pmid !== '0');
    }
  }

  const totalFound = foundPmids.length;

  if (foundPmids.length === 0) {
    return {
      sourcePmid: input.pmid,
      relationship: input.relationship,
      articles: [],
      totalFound: 0,
    };
  }

  // Sort by score descending if scores exist
  if (foundPmids.every((p) => p.score !== undefined)) {
    foundPmids.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  }

  const pmidsToEnrich = foundPmids.slice(0, input.maxResults);
  const pmidIds = pmidsToEnrich.map((p) => p.pmid);

  // Enrich with ESummary
  const summaryResult = await ncbi().eSummary({ db: 'pubmed', id: pmidIds.join(',') }, appContext);
  const briefSummaries = await extractBriefSummaries(summaryResult, appContext);
  const summaryMap = new Map(briefSummaries.map((bs) => [bs.pmid, bs]));

  const articles = pmidsToEnrich.map((p) => {
    const details = summaryMap.get(p.pmid);
    return {
      pmid: p.pmid,
      title: details?.title,
      authors: details?.authors,
      score: p.score,
    };
  });

  logger.debug('Related articles enriched', {
    ...appContext,
    totalFound,
    returnedCount: articles.length,
  });

  return {
    sourcePmid: input.pmid,
    relationship: input.relationship,
    articles,
    totalFound,
  };
}

// ---------------------------------------------------------------------------
// Response formatter
// ---------------------------------------------------------------------------

function responseFormatter(result: Output): ContentBlock[] {
  const md = markdown();
  md.text(`# Related Articles for PMID ${result.sourcePmid}\n`);
  md.text(`**Relationship:** ${result.relationship} | **Found:** ${result.totalFound}\n`);

  if (result.articles.length === 0) {
    md.text('No related articles found.');
    return [{ type: 'text', text: md.build() }];
  }

  for (const article of result.articles) {
    const scorePart = article.score !== undefined ? ` (score: ${article.score})` : '';
    md.text(
      `- **[PMID ${article.pmid}](https://pubmed.ncbi.nlm.nih.gov/${article.pmid}/)**${scorePart}`,
    );
    if (article.title) {
      md.text(`  ${article.title}`);
    }
    if (article.authors) {
      md.text(`  *${article.authors}*`);
    }
  }

  return [{ type: 'text', text: md.build() }];
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export const pubmedRelatedTool: ToolDefinition<typeof InputSchema, typeof OutputSchema> = {
  name: TOOL_NAME,
  title: TOOL_TITLE,
  description: TOOL_DESCRIPTION,
  annotations: TOOL_ANNOTATIONS,
  inputSchema: InputSchema,
  outputSchema: OutputSchema,
  logic: withToolAuth(['tool:pubmed_related:read'], logic),
  responseFormatter,
};
