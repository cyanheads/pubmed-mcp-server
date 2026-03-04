/**
 * @fileoverview PubMed citation tool — generates formatted citations (APA, MLA,
 * BibTeX, RIS) for one or more PubMed articles by fetching full records via
 * EFetch and running them through the citation formatter.
 * @module src/mcp-server/tools/definitions/pubmed-cite.tool
 */

import type { ContentBlock } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

import { container } from '@/container/core/container.js';
import { NcbiServiceToken } from '@/container/core/tokens.js';
import type { SdkContext, ToolDefinition } from '@/mcp-server/tools/utils/toolDefinition.js';
import { withToolAuth } from '@/mcp-server/transports/auth/lib/withAuth.js';
import {
  type CitationStyle,
  formatCitations,
} from '@/services/ncbi/formatting/citation-formatter.js';
import { parseFullArticle } from '@/services/ncbi/parsing/article-parser.js';
import { ensureArray } from '@/services/ncbi/parsing/xml-helpers.js';
import type { XmlPubmedArticle } from '@/services/ncbi/types.js';
import { JsonRpcErrorCode, McpError } from '@/types-global/errors.js';
import { markdown } from '@/utils/formatting/markdownBuilder.js';
import { logger } from '@/utils/internal/logger.js';
import type { RequestContext } from '@/utils/internal/requestContext.js';

const ncbi = () => container.resolve(NcbiServiceToken);

// ---------------------------------------------------------------------------
// Metadata
// ---------------------------------------------------------------------------

const TOOL_NAME = 'pubmed_cite';
const TOOL_TITLE = 'PubMed Citations';
const TOOL_DESCRIPTION =
  'Get formatted citations for PubMed articles in APA, MLA, BibTeX, or RIS format.';
const TOOL_ANNOTATIONS = {
  readOnlyHint: true,
  idempotentHint: true,
  openWorldHint: true,
} as const;

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const InputSchema = z.object({
  pmids: z.array(z.string().regex(/^\d+$/)).min(1).max(20).describe('PubMed IDs to cite'),
  styles: z
    .array(z.enum(['apa', 'mla', 'bibtex', 'ris']))
    .default(['apa'])
    .describe('Citation styles to generate'),
});

const OutputSchema = z.object({
  citations: z
    .array(
      z.object({
        pmid: z.string(),
        title: z.string().optional(),
        citations: z.record(z.string(), z.string()),
      }),
    )
    .describe('Citations per article'),
});

type Input = z.infer<typeof InputSchema>;
type Output = z.infer<typeof OutputSchema>;

// ---------------------------------------------------------------------------
// Logic
// ---------------------------------------------------------------------------

async function logic(
  input: Input,
  appContext: RequestContext,
  _sdkContext: SdkContext,
): Promise<Output> {
  logger.debug('Fetching articles for citation generation', {
    ...appContext,
    pmids: input.pmids,
    styles: input.styles,
  });

  const raw = await ncbi().eFetch({ db: 'pubmed', id: input.pmids.join(',') }, appContext);

  const xmlArticles: XmlPubmedArticle[] = ensureArray(raw?.PubmedArticleSet?.PubmedArticle);

  if (xmlArticles.length === 0) {
    throw new McpError(
      JsonRpcErrorCode.NotFound,
      `No articles found for PMIDs: ${input.pmids.join(', ')}`,
      { requestId: appContext.requestId },
    );
  }

  const citations = xmlArticles.map((xmlArticle) => {
    const parsed = parseFullArticle(xmlArticle);
    return {
      pmid: parsed.pmid,
      title: parsed.title,
      citations: formatCitations(parsed, input.styles as CitationStyle[]),
    };
  });

  logger.debug('Citations generated', {
    ...appContext,
    citationCount: citations.length,
  });

  return { citations };
}

// ---------------------------------------------------------------------------
// Response formatter
// ---------------------------------------------------------------------------

function responseFormatter(result: Output): ContentBlock[] {
  const md = markdown();
  md.text('# PubMed Citations\n');

  for (const entry of result.citations) {
    md.text(`## PMID ${entry.pmid}`);
    if (entry.title) {
      md.text(`**${entry.title}**\n`);
    }

    for (const [style, citation] of Object.entries(entry.citations)) {
      md.text(`### ${style.toUpperCase()}\n`);
      if (style === 'bibtex' || style === 'ris') {
        md.text(`\`\`\`${style}\n${citation}\n\`\`\`\n`);
      } else {
        md.text(`${citation}\n`);
      }
    }
  }

  return [{ type: 'text', text: md.build() }];
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export const pubmedCiteTool: ToolDefinition<typeof InputSchema, typeof OutputSchema> = {
  name: TOOL_NAME,
  title: TOOL_TITLE,
  description: TOOL_DESCRIPTION,
  annotations: TOOL_ANNOTATIONS,
  inputSchema: InputSchema,
  outputSchema: OutputSchema,
  logic: withToolAuth(['tool:pubmed_cite:read'], logic),
  responseFormatter,
};
