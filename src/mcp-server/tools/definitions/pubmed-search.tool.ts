/**
 * @fileoverview PubMed search tool definition. Searches PubMed with full query
 * syntax, filters, date ranges, and optional brief summaries via ESummary.
 * @module src/mcp-server/tools/definitions/pubmed-search.tool
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
import { sanitization } from '@/utils/security/sanitization.js';

const ncbi = () => container.resolve(NcbiServiceToken);

// ─── Metadata ────────────────────────────────────────────────────────────────

const TOOL_NAME = 'pubmed_search';
const TOOL_TITLE = 'PubMed Search';
const TOOL_DESCRIPTION =
  'Search PubMed with full query syntax, filters, and date ranges. Returns PMIDs and optional brief summaries.';
const TOOL_ANNOTATIONS = {
  readOnlyHint: true,
  idempotentHint: true,
  openWorldHint: true,
} as const;

// ─── Schemas ─────────────────────────────────────────────────────────────────

const InputSchema = z.object({
  query: z.string().min(1).describe('PubMed search query (supports full NCBI syntax)'),
  maxResults: z.number().int().min(1).max(1000).default(20).describe('Maximum results to return'),
  sort: z
    .enum(['relevance', 'pub_date', 'author', 'journal'])
    .default('relevance')
    .describe('Sort order'),
  dateRange: z
    .object({
      minDate: z.string().describe('Start date (YYYY/MM/DD)'),
      maxDate: z.string().describe('End date (YYYY/MM/DD)'),
      dateType: z
        .enum(['pdat', 'mdat', 'edat'])
        .default('pdat')
        .describe('Date type: pdat (publication), mdat (modification), edat (entrez)'),
    })
    .optional()
    .describe('Filter by date range (YYYY/MM/DD)'),
  publicationTypes: z.array(z.string()).optional().describe('Filter by publication type'),
  includeSummaries: z
    .number()
    .int()
    .min(0)
    .max(50)
    .default(0)
    .describe('Fetch brief summaries for top N results'),
});

const OutputSchema = z.object({
  query: z.string().describe('Original query'),
  totalFound: z.number().describe('Total matching articles'),
  pmids: z.array(z.string()).describe('PubMed IDs'),
  summaries: z
    .array(
      z.object({
        pmid: z.string(),
        title: z.string().optional(),
        authors: z.string().optional(),
        source: z.string().optional(),
        pubDate: z.string().optional(),
        doi: z.string().optional(),
      }),
    )
    .optional()
    .describe('Brief summaries'),
  searchUrl: z.string().describe('PubMed search URL'),
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
  logger.info('Executing pubmed_search tool', { ...appContext, query: input.query });

  let effectiveQuery = sanitization.sanitizeString(input.query, { context: 'text' });

  if (input.dateRange) {
    const { minDate, maxDate, dateType } = input.dateRange;
    effectiveQuery += ` AND (${minDate}[${dateType}] : ${maxDate}[${dateType}])`;
  }

  if (input.publicationTypes && input.publicationTypes.length > 0) {
    const ptQuery = input.publicationTypes
      .map((pt) => `"${sanitization.sanitizeString(pt, { context: 'text' })}"[Publication Type]`)
      .join(' OR ');
    effectiveQuery += ` AND (${ptQuery})`;
  }

  const esResult = await ncbi().eSearch(
    {
      db: 'pubmed',
      term: effectiveQuery,
      retmax: input.maxResults,
      sort: input.sort,
      usehistory: input.includeSummaries > 0 ? 'y' : undefined,
    },
    appContext,
  );

  const pmids = esResult.idList;
  const totalFound = esResult.count;

  let summaries: Output['summaries'];

  if (input.includeSummaries > 0 && pmids.length > 0) {
    const eSummaryParams: Record<string, string | number | undefined> = {
      db: 'pubmed',
      version: '2.0',
      retmode: 'xml',
    };

    if (esResult.webEnv && esResult.queryKey) {
      eSummaryParams.WebEnv = esResult.webEnv;
      eSummaryParams.query_key = esResult.queryKey;
      eSummaryParams.retmax = input.includeSummaries;
    } else {
      eSummaryParams.id = pmids.slice(0, input.includeSummaries).join(',');
    }

    const eSummaryResult = await ncbi().eSummary(eSummaryParams, appContext);

    if (eSummaryResult) {
      const briefSummaries = await extractBriefSummaries(eSummaryResult, appContext);
      summaries = briefSummaries.map((s) => ({
        pmid: s.pmid,
        title: s.title,
        authors: s.authors,
        source: s.source,
        pubDate: s.pubDate,
        doi: s.doi,
      }));
    }
  }

  const searchUrl = `https://pubmed.ncbi.nlm.nih.gov/?term=${encodeURIComponent(input.query)}`;

  logger.notice('pubmed_search completed', {
    ...appContext,
    totalFound,
    pmidCount: pmids.length,
    summaryCount: summaries?.length ?? 0,
  });

  return { query: input.query, totalFound, pmids, summaries, searchUrl };
}

// ─── Response Formatter ──────────────────────────────────────────────────────

function responseFormatter(result: Output): ContentBlock[] {
  const md = markdown()
    .h2('PubMed Search Results')
    .keyValue('Query', result.query)
    .keyValue('Total Found', result.totalFound)
    .keyValue('PMIDs Returned', result.pmids.length)
    .keyValue('Search URL', result.searchUrl);

  if (result.pmids.length > 0) {
    md.h3('PMIDs').paragraph(result.pmids.join(', '));
  }

  md.when(!!result.summaries && result.summaries.length > 0, () => {
    md.h3('Summaries');
    for (const s of result.summaries ?? []) {
      md.h4(s.title ?? s.pmid);
      md.keyValue('PMID', s.pmid);
      if (s.authors) md.keyValue('Authors', s.authors);
      if (s.source) md.keyValue('Source', s.source);
      if (s.pubDate) md.keyValue('Published', s.pubDate);
      if (s.doi) md.keyValue('DOI', s.doi);
    }
  });

  return [{ type: 'text', text: md.build() }];
}

// ─── Export ──────────────────────────────────────────────────────────────────

export const pubmedSearchTool: ToolDefinition<typeof InputSchema, typeof OutputSchema> = {
  name: TOOL_NAME,
  title: TOOL_TITLE,
  description: TOOL_DESCRIPTION,
  annotations: TOOL_ANNOTATIONS,
  inputSchema: InputSchema,
  outputSchema: OutputSchema,
  logic: withToolAuth(['tool:pubmed_search:read'], logic),
  responseFormatter,
};
