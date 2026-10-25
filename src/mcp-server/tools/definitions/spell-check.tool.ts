/**
 * @fileoverview PubMed spell-check tool. Applies NCBI ESpell's corrections to a
 * PubMed search query in place, keeping its field tags, the values of indexed
 * fields (`aged[mh]`), operators, spacing, and gene symbols — the recovery
 * step after a zero-hit or thin
 * `pubmed_search_articles` result. `term` is accepted as an alias for `query`.
 * @module src/mcp-server/tools/definitions/spell-check.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { NCBI_SERVICE_ERRORS, QUERY_INPUT_ERRORS } from '@/services/error-contracts.js';
import { getNcbiService } from '@/services/ncbi/ncbi-service.js';
import { conceptMeta, SCHEMA_SEARCH_ACTION } from './_concepts.js';
import { markdownCodeSpan } from './_text.js';
import { hasVisibleText } from './_visible-text.js';

export const spellCheckTool = tool('pubmed_spell_check', {
  description:
    'Spell-check a PubMed search query against NCBI ESpell and get the corrected query back. Use after a zero-hit or thin `pubmed_search_articles` result, or when a drug, gene, disease, or author name may be misspelled. Corrections are applied in place, so field tags, operators, spacing, and gene symbols stay as written (`alzhiemer diseese treatmnt outcomse` → `alzheimer disease treatment outcomes`). The value of an indexed field — MeSH, publication type, journal, author, language, subset, and the like (`aged[mh]`, `free full text[sb]`, `zhang y[au]`) — is kept as written, misspelled or not, since the ESpell dictionary is not the index that field searches; free-text fields such as `[tiab]`, `[ti]`, and `[tw]` are corrected. Words in all capitals, with digits or non-ASCII letters, or differing only in case are never changed, nor is a single letter swapped for another (`q fever`, the initial in `smith q`), words after a number or symbol ESpell skips are left as written, and `hasSuggestion` is false when no correction was applied. Re-run the search with `corrected`.',
  annotations: { readOnlyHint: true, openWorldHint: true },
  _meta: conceptMeta([SCHEMA_SEARCH_ACTION]),
  sourceUrl:
    'https://github.com/cyanheads/pubmed-mcp-server/blob/main/src/mcp-server/tools/definitions/spell-check.tool.ts',

  errors: [...NCBI_SERVICE_ERRORS, ...QUERY_INPUT_ERRORS] as const,

  // Never advertised; rewritten to the canonical key before the schema parses.
  // ESpell's own name for the query. (#190)
  inputAliases: { term: 'query' },

  input: z.object({
    query: z
      .string()
      .min(2)
      .describe(
        'PubMed search query to spell-check. Must carry a term: a value of only whitespace or invisible characters, such as a zero-width space, is rejected rather than sent to ESpell.',
      ),
  }),

  output: z.object({
    original: z.string().describe('Original query'),
    corrected: z
      .string()
      .describe(
        "The query with ESpell's accepted corrections applied in place; field tags, the values of indexed fields such as `aged[mh]` and `zhang y[au]`, operators, spacing, words in capitals or with digits, and a single letter ESpell would swap for another are kept as written. Same as `original` when `hasSuggestion` is false.",
      ),
    hasSuggestion: z
      .boolean()
      .describe('Whether at least one correction was applied to `corrected`'),
  }),

  async handler(input, ctx) {
    ctx.log.info('Executing pubmed_spell_check tool', { query: input.query });
    // `min(2)` counts the spaces, so a whitespace-only query passes the schema.
    // ESpell answers a blank term with an empty `<ERROR/>` element the response
    // handler does not detect, and the tool would report the blank input as
    // spell-checked. Reject before the call — invisible characters such as a
    // zero-width space included. (#133, #176)
    if (!hasVisibleText(input.query)) {
      throw ctx.fail('blank_query', 'The `query` is blank — there is nothing to spell-check.');
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

  // Both queries are code spans: a caller re-runs `corrected` as written, so its
  // field tags, wildcards and operators must read exactly, raw and rendered. (#255)
  format: (result) => {
    if (result.hasSuggestion) {
      return [
        {
          type: 'text',
          text: `**Suggestion:** ${markdownCodeSpan(result.corrected)} (original: ${markdownCodeSpan(result.original)})`,
        },
      ];
    }
    return [
      {
        type: 'text',
        text: `No correction applied — query ${markdownCodeSpan(result.original)} is returned as written.`,
      },
    ];
  },
});
