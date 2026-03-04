/**
 * @fileoverview PubMed spell-check tool definition. Uses NCBI's ESpell service
 * to suggest corrections for search queries.
 * @module src/mcp-server/tools/definitions/pubmed-spell.tool
 */

import type { ContentBlock } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

import { container } from '@/container/core/container.js';
import { NcbiServiceToken } from '@/container/core/tokens.js';
import type { SdkContext, ToolDefinition } from '@/mcp-server/tools/utils/toolDefinition.js';
import { withToolAuth } from '@/mcp-server/transports/auth/lib/withAuth.js';
import { markdown } from '@/utils/formatting/markdownBuilder.js';
import { logger } from '@/utils/internal/logger.js';
import type { RequestContext } from '@/utils/internal/requestContext.js';

const ncbi = () => container.resolve(NcbiServiceToken);

// ─── Metadata ────────────────────────────────────────────────────────────────

const TOOL_NAME = 'pubmed_spell';
const TOOL_TITLE = 'PubMed Spell Check';
const TOOL_DESCRIPTION =
  "Spell-check a query and get NCBI's suggested correction. Useful for refining search queries.";
const TOOL_ANNOTATIONS = {
  readOnlyHint: true,
  idempotentHint: true,
  openWorldHint: true,
} as const;

// ─── Schemas ─────────────────────────────────────────────────────────────────

const InputSchema = z.object({
  query: z.string().min(2).describe('Query to spell-check'),
});

const OutputSchema = z.object({
  original: z.string().describe('Original query'),
  corrected: z.string().describe('Corrected query (same as original if no suggestion)'),
  hasSuggestion: z.boolean().describe('Whether NCBI suggested a correction'),
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
  logger.info('Executing pubmed_spell tool', { ...appContext, query: input.query });

  const result = await ncbi().eSpell({ db: 'pubmed', term: input.query }, appContext);

  logger.notice('pubmed_spell completed', {
    ...appContext,
    hasSuggestion: result.hasSuggestion,
  });

  return {
    original: result.original,
    corrected: result.corrected,
    hasSuggestion: result.hasSuggestion,
  };
}

// ─── Response Formatter ──────────────────────────────────────────────────────

function responseFormatter(result: Output): ContentBlock[] {
  const md = markdown().h2('PubMed Spell Check');

  if (result.hasSuggestion) {
    md.keyValue('Original', result.original).keyValue('Suggested', result.corrected);
  } else {
    md.paragraph(`No spelling corrections suggested for: "${result.original}"`);
  }

  return [{ type: 'text', text: md.build() }];
}

// ─── Export ──────────────────────────────────────────────────────────────────

export const pubmedSpellTool: ToolDefinition<typeof InputSchema, typeof OutputSchema> = {
  name: TOOL_NAME,
  title: TOOL_TITLE,
  description: TOOL_DESCRIPTION,
  annotations: TOOL_ANNOTATIONS,
  inputSchema: InputSchema,
  outputSchema: OutputSchema,
  logic: withToolAuth(['tool:pubmed_spell:read'], logic),
  responseFormatter,
};
