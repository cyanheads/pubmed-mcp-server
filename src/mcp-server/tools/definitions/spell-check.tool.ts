/**
 * @fileoverview PubMed spell-check tool. Uses NCBI's ESpell service to correct
 * every misspelled token of a PubMed search query in one call — the recovery
 * step after a zero-hit or thin `pubmed_search_articles` result.
 * @module src/mcp-server/tools/definitions/spell-check.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { NCBI_QUERY_INPUT_ERRORS, NCBI_SERVICE_ERRORS } from '@/services/error-contracts.js';
import { getNcbiService } from '@/services/ncbi/ncbi-service.js';
import { conceptMeta, SCHEMA_SEARCH_ACTION } from './_concepts.js';

export const spellCheckTool = tool('pubmed_spell_check', {
  description:
    'Spell-check a PubMed search query against NCBI ESpell and get the corrected query back. Use after a zero-hit or thin `pubmed_search_articles` result, or when a drug, gene, disease, or author name may be misspelled — every misspelled token is corrected in one call (`alzhiemer diseese treatmnt outcomse` → `alzheimer disease treatment outcomes`), and `hasSuggestion` is false when NCBI has no change to offer. Re-run the search with `corrected`.',
  annotations: { readOnlyHint: true, openWorldHint: true },
  _meta: conceptMeta([SCHEMA_SEARCH_ACTION]),
  sourceUrl:
    'https://github.com/cyanheads/pubmed-mcp-server/blob/main/src/mcp-server/tools/definitions/spell-check.tool.ts',

  errors: [...NCBI_SERVICE_ERRORS, ...NCBI_QUERY_INPUT_ERRORS] as const,

  input: z.object({
    query: z
      .string()
      .min(2)
      .describe(
        'PubMed search query to spell-check. Must carry a term: a blank or whitespace-only value is rejected rather than sent to ESpell.',
      ),
  }),

  output: z.object({
    original: z.string().describe('Original query'),
    corrected: z.string().describe('Corrected query (same as original if no suggestion)'),
    hasSuggestion: z.boolean().describe('Whether NCBI suggested a correction'),
  }),

  async handler(input, ctx) {
    ctx.log.info('Executing pubmed_spell_check tool', { query: input.query });
    // `min(2)` counts the spaces, so a whitespace-only query passes the schema.
    // ESpell answers a blank term with an empty `<ERROR/>` element the response
    // handler does not detect, and the tool would report the blank input as
    // spell-checked. Reject before the call. (#133)
    if (input.query.trim().length === 0) {
      throw ctx.fail('blank_query', 'The `query` is blank — there is nothing to spell-check.', {
        ...ctx.recoveryFor('blank_query'),
      });
    }
    const result = await getNcbiService().eSpell(
      { db: 'pubmed', term: input.query },
      { signal: ctx.signal },
    );
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
