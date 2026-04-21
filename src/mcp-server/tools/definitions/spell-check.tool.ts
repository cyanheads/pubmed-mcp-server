/**
 * @fileoverview PubMed spell-check tool. Uses NCBI's ESpell service
 * to suggest corrections for search queries.
 * @module src/mcp-server/tools/definitions/spell-check.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { getNcbiService } from '@/services/ncbi/ncbi-service.js';
import { conceptMeta, SCHEMA_SEARCH_ACTION } from './_concepts.js';

export const spellCheckTool = tool('pubmed_spell_check', {
  description:
    "Spell-check a query and get NCBI's suggested correction. Useful for refining search queries.",
  annotations: { readOnlyHint: true, openWorldHint: true },
  _meta: conceptMeta([SCHEMA_SEARCH_ACTION]),
  sourceUrl:
    'https://github.com/cyanheads/pubmed-mcp-server/blob/main/src/mcp-server/tools/definitions/spell-check.tool.ts',

  input: z.object({
    query: z.string().min(2).describe('PubMed search query to spell-check'),
  }),

  output: z.object({
    original: z.string().describe('Original query'),
    corrected: z.string().describe('Corrected query (same as original if no suggestion)'),
    hasSuggestion: z.boolean().describe('Whether NCBI suggested a correction'),
  }),

  async handler(input, ctx) {
    ctx.log.info('Executing pubmed_spell tool', { query: input.query });
    const result = await getNcbiService().eSpell({ db: 'pubmed', term: input.query });
    return {
      original: result.original,
      corrected: result.corrected,
      hasSuggestion: result.hasSuggestion,
    };
  },

  format: (result) => {
    if (result.hasSuggestion) {
      return [
        {
          type: 'text',
          text: `**Suggestion:** "${result.corrected}" (original: "${result.original}")`,
        },
      ];
    }
    return [
      {
        type: 'text',
        text: `No suggestion — query "${result.original}" appears correct as written.`,
      },
    ];
  },
});
