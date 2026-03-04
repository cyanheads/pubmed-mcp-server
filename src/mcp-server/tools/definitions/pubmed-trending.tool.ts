/**
 * @fileoverview PubMed trending tool — finds recent articles in a topic area,
 * filtered by a configurable look-back period and sorted by publication date.
 * Convenience wrapper around ESearch + ESummary with date filtering.
 * @module src/mcp-server/tools/definitions/pubmed-trending.tool
 */

import type { ContentBlock } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

import { container } from '@/container/core/container.js';
import { NcbiServiceToken } from '@/container/core/tokens.js';
import type { SdkContext, ToolDefinition } from '@/mcp-server/tools/utils/toolDefinition.js';
import { withToolAuth } from '@/mcp-server/transports/auth/lib/withAuth.js';
import { extractBriefSummaries } from '@/services/ncbi/parsing/esummary-parser.js';
import { markdown } from '@/utils/formatting/markdownBuilder.js';
import { logger } from '@/utils/internal/logger.js';
import type { RequestContext } from '@/utils/internal/requestContext.js';

const ncbi = () => container.resolve(NcbiServiceToken);

// ---------------------------------------------------------------------------
// Metadata
// ---------------------------------------------------------------------------

const TOOL_NAME = 'pubmed_trending';
const TOOL_TITLE = 'PubMed Trending';
const TOOL_DESCRIPTION =
  'Find recent articles in a field, sorted by publication date. Convenience wrapper for date-filtered search.';
const TOOL_ANNOTATIONS = {
  readOnlyHint: true,
  idempotentHint: true,
  openWorldHint: true,
} as const;

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const InputSchema = z.object({
  query: z.string().min(1).describe('Topic to find trending articles for'),
  days: z.number().int().min(1).max(365).default(30).describe('Look-back period in days'),
  maxResults: z.number().int().min(1).max(50).default(10).describe('Maximum results'),
});

const OutputSchema = z.object({
  query: z.string().describe('Search query used'),
  period: z.string().describe('Date range description'),
  articles: z
    .array(
      z.object({
        pmid: z.string(),
        title: z.string().optional(),
        authors: z.string().optional(),
        publicationDate: z.string().optional(),
        source: z.string().optional(),
      }),
    )
    .describe('Trending articles'),
});

type Input = z.infer<typeof InputSchema>;
type Output = z.infer<typeof OutputSchema>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Format a Date as YYYY/MM/DD for NCBI date parameters. */
function formatNcbiDate(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}/${m}/${d}`;
}

// ---------------------------------------------------------------------------
// Logic
// ---------------------------------------------------------------------------

async function logic(
  input: Input,
  appContext: RequestContext,
  _sdkContext: SdkContext,
): Promise<Output> {
  const now = new Date();
  const minDateObj = new Date(now.getTime() - input.days * 24 * 60 * 60 * 1000);
  const minDate = formatNcbiDate(minDateObj);
  const maxDate = formatNcbiDate(now);

  logger.debug('Searching for trending articles', {
    ...appContext,
    query: input.query,
    minDate,
    maxDate,
    maxResults: input.maxResults,
  });

  const searchResult = await ncbi().eSearch(
    {
      db: 'pubmed',
      term: input.query,
      retmax: input.maxResults,
      sort: 'pub_date',
      datetype: 'pdat',
      mindate: minDate,
      maxdate: maxDate,
      usehistory: 'y',
    },
    appContext,
  );

  if (searchResult.idList.length === 0) {
    return {
      query: input.query,
      period: `Last ${input.days} days`,
      articles: [],
    };
  }

  // Enrich with ESummary
  const summaryResult = await ncbi().eSummary(
    { db: 'pubmed', id: searchResult.idList.join(',') },
    appContext,
  );
  const briefSummaries = await extractBriefSummaries(summaryResult, appContext);

  const articles = briefSummaries.map((bs) => ({
    pmid: bs.pmid,
    title: bs.title,
    authors: bs.authors,
    publicationDate: bs.pubDate,
    source: bs.source,
  }));

  logger.debug('Trending articles retrieved', {
    ...appContext,
    totalSearchCount: searchResult.count,
    returnedCount: articles.length,
  });

  return {
    query: input.query,
    period: `Last ${input.days} days`,
    articles,
  };
}

// ---------------------------------------------------------------------------
// Response formatter
// ---------------------------------------------------------------------------

function responseFormatter(result: Output): ContentBlock[] {
  const md = markdown();
  md.text(`# Trending: ${result.query}\n`);
  md.text(`**Period:** ${result.period}\n`);

  if (result.articles.length === 0) {
    md.text('No articles found in this period.');
    return [{ type: 'text', text: md.build() }];
  }

  for (const article of result.articles) {
    md.text(`- **[PMID ${article.pmid}](https://pubmed.ncbi.nlm.nih.gov/${article.pmid}/)**`);
    if (article.title) {
      md.text(`  ${article.title}`);
    }
    const meta: string[] = [];
    if (article.authors) meta.push(article.authors);
    if (article.publicationDate) meta.push(article.publicationDate);
    if (article.source) meta.push(article.source);
    if (meta.length > 0) {
      md.text(`  *${meta.join(' | ')}*`);
    }
  }

  return [{ type: 'text', text: md.build() }];
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export const pubmedTrendingTool: ToolDefinition<typeof InputSchema, typeof OutputSchema> = {
  name: TOOL_NAME,
  title: TOOL_TITLE,
  description: TOOL_DESCRIPTION,
  annotations: TOOL_ANNOTATIONS,
  inputSchema: InputSchema,
  outputSchema: OutputSchema,
  logic: withToolAuth(['tool:pubmed_trending:read'], logic),
  responseFormatter,
};
