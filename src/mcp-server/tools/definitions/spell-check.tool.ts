/**
 * @fileoverview PubMed spell-check tool. Applies NCBI ESpell's corrections to a
 * PubMed search query in place, keeping its field tags, the values of indexed
 * fields (`aged[mh]`), operators, spacing, and gene symbols — the recovery
 * step after a zero-hit or thin
 * `pubmed_search_articles` result. Each correction is checked against PubMed
 * record counts first, and a check that could not run is named in a notice.
 * `term` is accepted as an alias for `query`.
 * @module src/mcp-server/tools/definitions/spell-check.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { startCallDeadline } from '@/services/call-deadline.js';
import { NCBI_SERVICE_ERRORS, QUERY_INPUT_ERRORS } from '@/services/error-contracts.js';
import { getNcbiService } from '@/services/ncbi/ncbi-service.js';
import {
  ESPELL_CHECK_MAX_REQUESTS,
  ESPELL_CHECK_TIME_LIMIT_MS,
  type ESpellCheckSkipReason,
  type ESpellSkippedCheck,
} from '@/services/ncbi/types.js';
import { conceptMeta, SCHEMA_SEARCH_ACTION } from './_concepts.js';
import { markdownCodeSpan } from './_text.js';
import { hasVisibleText } from './_visible-text.js';

/**
 * Why a check did not run, as the clause that ends a notice sentence. A
 * `time_limit` stop is the checks' own limit or the tool call's deadline,
 * whichever came first, so its clause names neither. (#310)
 */
const SKIP_CAUSES: Readonly<Record<ESpellCheckSkipReason, string>> = {
  request_failed: 'an NCBI request failed',
  request_cap: `the checks reached their limit of ${ESPELL_CHECK_MAX_REQUESTS} NCBI requests`,
  time_limit: 'the checks ran out of time',
};

/**
 * One notice naming every check that did not run: a sentence for each kind of
 * check and cause, in the order the service first reported it, listing the
 * caller's words as code spans. `ctx.enrich.notice` keeps only its last call,
 * so the sentences go out joined. (#316)
 */
function skippedChecksNotice(skipped: readonly ESpellSkippedCheck[]): string {
  const groups = new Map<
    string,
    { check: ESpellSkippedCheck['check']; reason: ESpellCheckSkipReason; items: string[] }
  >();
  for (const { check, reason, word, replacement } of skipped) {
    const key = `${check} ${reason}`;
    const group = groups.get(key) ?? { check, reason, items: [] };
    groups.set(key, group);
    group.items.push(
      check === 'count'
        ? `${markdownCodeSpan(word)} → ${markdownCodeSpan(replacement)}`
        : `${markdownCodeSpan(word)} (not ${markdownCodeSpan(replacement)})`,
    );
  }
  return [...groups.values()]
    .map(({ check, reason, items }) =>
      check === 'count'
        ? `Applied as ESpell wrote them; their PubMed record counts were not checked because ${SKIP_CAUSES[reason]}: ${items.join(', ')}.`
        : `Kept as written because ESpell's correction has under a tenth of their PubMed records; no MeSH-dictionary spelling was tried because ${SKIP_CAUSES[reason]}: ${items.join(', ')}.`,
    )
    .join(' ');
}

export const spellCheckTool = tool('pubmed_spell_check', {
  description:
    "Spell-check a PubMed search query against NCBI ESpell and get the corrected query back. Use after a zero-hit or thin `pubmed_search_articles` result, or when a drug, gene, disease, or author name may be misspelled. Corrections are applied in place, so field tags, operators, spacing, and gene symbols stay as written (`alzhiemer diseese treatmnt outcomse` → `alzheimer disease treatment outcomes`). The value of an indexed field — MeSH, publication type, journal, author, language, subset, and the like (`aged[mh]`, `free full text[sb]`, `zhang y[au]`) — is kept as written, misspelled or not, since the ESpell dictionary is not the index that field searches; free-text fields such as `[tiab]`, `[ti]`, and `[tw]` are corrected. Words in all capitals, with digits or non-ASCII letters, or differing only in case are never changed, nor is a single letter swapped for another (`q fever`, the initial in `smith q`), words after a number or symbol ESpell skips are left as written, and `hasSuggestion` is false when no correction was applied. Each correction is checked against PubMed first: one with under a tenth of the PubMed records of the word it replaces is dropped and the word kept (`tirzepatide`, which ESpell would turn into `irzepatide`), unless ESpell's MeSH dictionary offers a spelling PubMed holds more often than the word (`tirzepatid` → `tirzepatide`). A check that cannot run leaves ESpell's correction applied, or the dropped word as written, and `notice` names it. Re-run the search with `corrected`.",
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
        "The query with ESpell's accepted corrections applied in place; field tags, the values of indexed fields such as `aged[mh]` and `zhang y[au]`, operators, spacing, words in capitals or with digits, and a single letter ESpell would swap for another are kept as written. So is a word whose ESpell correction has under a tenth of its PubMed records, unless ESpell's MeSH dictionary offers a spelling PubMed holds more often than the word, which is used instead. Same as `original` when `hasSuggestion` is false.",
      ),
    hasSuggestion: z
      .boolean()
      .describe('Whether at least one correction was applied to `corrected`'),
  }),

  // A check that did not run, surfaced via ctx.enrich.notice() on both
  // structuredContent and content[]; absent when every check ran.
  enrichment: {
    notice: z
      .string()
      .optional()
      .describe(
        `Names each correction applied as ESpell wrote it without its PubMed record-count check, and each word kept as written without a MeSH-dictionary spelling tried, with the cause: an NCBI request failed, the checks reached their limit of ${ESPELL_CHECK_MAX_REQUESTS} requests, or they ran out of time (${ESPELL_CHECK_TIME_LIMIT_MS / 1000} seconds, or less when the tool call had less time left). Absent when every check ran.`,
      ),
  },

  async handler(input, ctx) {
    const deadline = startCallDeadline();
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
      { signal: ctx.signal, deadline },
    );
    if (result.skippedChecks) ctx.enrich.notice(skippedChecksNotice(result.skippedChecks));
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
