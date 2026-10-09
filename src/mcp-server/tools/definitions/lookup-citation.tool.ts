/**
 * @fileoverview Citation lookup tool. Resolves partial bibliographic references
 * to PubMed IDs using NCBI's ECitMatch service, then verifies author agreement
 * against ESummary to catch cases where ECitMatch's journal+volume+page weighting
 * returns a PMID whose author roster doesn't contain the queried author.
 * `citations` is advertised as an array of 1–25 citations. A lone citation
 * object is wrapped into a one-element array before validation, and `citation`
 * is accepted as an alias for `citations`. Every citation-shape rule lives in
 * the schema, so a citation that cannot match is rejected under its
 * `citations.N.<field>` path before ECitMatch is called: `year` is four digits,
 * the other bibliographic fields hold a visible character, and each citation
 * carries a journal or a year.
 * @module src/mcp-server/tools/definitions/lookup-citation.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { NCBI_SERVICE_ERRORS } from '@/services/error-contracts.js';
import { getNcbiService } from '@/services/ncbi/ncbi-service.js';
import { extractBriefSummaries } from '@/services/ncbi/parsing/esummary-parser.js';
import type { ECitMatchCitation } from '@/services/ncbi/types.js';
import {
  conceptMeta,
  EDAM_DATA_RETRIEVAL,
  EDAM_PUBMED_ID,
  SCHEMA_SCHOLARLY_ARTICLE,
} from './_concepts.js';
import { hasVisibleText } from './_visible-text.js';

/** Extract the surname token (first whitespace-separated part) from an author string. */
function surname(name: string): string {
  return name.trim().split(/\s+/)[0]?.toLowerCase() ?? '';
}

/**
 * ECitMatch reads each citation as six `|`-delimited fields, and the citations
 * of one request are joined into a single payload with `\r`. Either character
 * inside an interpolated field shifts that layout — NCBI mis-parses the line or
 * splits one citation into two response rows, and the citation's real match is
 * lost. Rejected at the schema so the constraint is advertised as a JSON-Schema
 * `pattern` and a hazardous citation never reaches NCBI, rather than silently
 * rewriting what the caller asked for. (#125)
 *
 * `key` is exempt: it is a label echoed onto the result and is never put on the
 * wire (the service submits positional tokens instead), so it stays free-form.
 */
const BDATA_FIELD_RE = /^[^|\r\n]*$/;
const BDATA_FIELD_ERROR =
  'Cannot contain a pipe ("|") or a line break. Those characters shift ECitMatch\'s field layout — remove them or replace them with a space.';
const TEXT_FIELD_HINT =
  'Must contain a visible character, and cannot contain a pipe ("|") or a line break.';
const VISIBLE_TEXT_ERROR =
  'Must contain a visible character. Omit the field rather than sending only spaces or invisible characters.';

/**
 * The only year ECitMatch matches on: four ASCII digits, padding with spaces or
 * tabs tolerated. Every other form — `1991a`, `91`, `1991-1992`, `1991 May` —
 * misses, and a journal-less citation carrying one makes ECitMatch drop that
 * line and every line after it. No CR or LF, so the bdata layout rule above
 * holds for this field too. (#187)
 */
const YEAR_RE = /^[ \t]*\d{4}[ \t]*$/;

/**
 * A safe integer sent for a string field, read as its decimal string — the
 * framework's own repair rule (a safe integer other than `-0`). That repair
 * reaches a lone citation object and this schema's preprocess output alike, and
 * hands the handler the same value. What it cannot do is hold a repaired value
 * to the field's own check: when the digits then fail it, the call is rejected
 * with the original `expected string, received number`, so an integer year
 * that is not four digits would be told to resend it as a string. Converting
 * before validation reports the four-digit rule instead. Anything else passes
 * through to be rejected as before. (#187, #198)
 */
const integerAsString = (value: unknown): unknown =>
  typeof value === 'number' && Number.isSafeInteger(value) && !Object.is(value, -0)
    ? String(value)
    : value;

/**
 * An exactly-empty string from a form client means "unset", never a value to
 * validate: it parses to `undefined` before the field's checks run, so the
 * advertised schema keeps its plain `pattern`. Whitespace and invisible-only
 * values still reach the checks and are rejected. An integer is read as its
 * decimal string first. (#187, #198)
 */
const blankAsUnset = <T extends z.ZodType>(schema: T) =>
  z.preprocess((value) => {
    const read = integerAsString(value);
    return read === '' ? undefined : read;
  }, schema);

/**
 * A bibliographic text field: rejected when it would shift the bdata layout or
 * holds no visible character — whitespace or a zero-width space sent as a
 * journal reads as present here but constrains nothing upstream. (#125, #187)
 */
const textField = () =>
  blankAsUnset(
    z
      .string()
      .regex(BDATA_FIELD_RE, BDATA_FIELD_ERROR)
      .refine(hasVisibleText, VISIBLE_TEXT_ERROR)
      .optional(),
  );

const CitationSchema = z
  .object({
    journal: textField().describe(
      `Journal title or ISO abbreviation (e.g., "proc natl acad sci u s a"). ${TEXT_FIELD_HINT}`,
    ),
    year: blankAsUnset(
      z.string().regex(YEAR_RE, 'Must be a four-digit year, e.g. "1991".').optional(),
    ).describe('Publication year as four digits (e.g., "1991").'),
    volume: textField().describe(`Volume number. ${TEXT_FIELD_HINT}`),
    firstPage: textField().describe(`First page number. ${TEXT_FIELD_HINT}`),
    authorName: textField().describe(
      `Author name, typically "lastname initials" (e.g., "mann bj"). ${TEXT_FIELD_HINT}`,
    ),
    key: z
      .preprocess(integerAsString, z.string().optional())
      .describe(
        'Arbitrary label to track this citation in results. Auto-assigned if omitted. Echoed back unchanged and never sent to NCBI, so any character is accepted here.',
      ),
  })
  .describe(
    'Citation to match against PubMed. Must include at least journal or a four-digit year — ECitMatch primary-keys on journal+volume+page, so author-only or volume-only inputs guarantee no match.',
  )
  /**
   * Zod still runs this beside a field that failed its own check, handing it the
   * raw value, so the rule tests the journal and year itself: a whitespace
   * journal or a malformed year never satisfies it. (#187)
   */
  .refine(
    (c) =>
      (c.journal !== undefined && hasVisibleText(c.journal)) ||
      (c.year !== undefined && YEAR_RE.test(c.year)),
    {
      message:
        'Each citation must include at least a journal or year field — ECitMatch primary-keys on journal+volume+page, so author-only or volume-only inputs guarantee no match.',
    },
  );

/**
 * Message for a `citations` value the array check refuses (a string, a number, a
 * missing field, or an array outside 1–25) in place of Zod's bare `expected
 * array`, so the caller learns both shapes that parse. A lone object never
 * reaches this check: it is wrapped first, and its own field issues report under
 * `citations.0`.
 */
const CITATIONS_SHAPE_ERROR =
  'Invalid input: expected a citation object or an array of 1–25 citation objects';

/** A citation sent on its own rather than in an array. JSON input has no other object kind. */
const isCitationObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export const lookupCitationTool = tool('pubmed_lookup_citation', {
  description: `Look up PubMed IDs from partial bibliographic citations. Useful when you have a reference (journal, year, volume, page, author) and need the PMID — deterministic citation matching, more reliable than free-text search for structured references. Each citation must include at least journal or a four-digit year (ECitMatch primary-keys on journal+volume+page; author-only or volume-only inputs guarantee no match); more fields = better match accuracy.`,
  annotations: { readOnlyHint: true, openWorldHint: true },
  _meta: conceptMeta([SCHEMA_SCHOLARLY_ARTICLE, EDAM_DATA_RETRIEVAL, EDAM_PUBMED_ID]),
  sourceUrl:
    'https://github.com/cyanheads/pubmed-mcp-server/blob/main/src/mcp-server/tools/definitions/lookup-citation.tool.ts',

  errors: [...NCBI_SERVICE_ERRORS] as const,

  /**
   * Never advertised; rewritten to the canonical key before the schema parses.
   * A single object usually arrives under this name, and `citations` wraps it
   * into a one-element array. (#156)
   */
  inputAliases: { citation: 'citations' },

  input: z.object({
    /**
     * The wrap runs before validation and stays off the advertised schema, which
     * remains a plain `type: "array"`. A top-level union would advertise
     * `citations` with no `type` for a client to build the parameter from. (#173)
     *
     * A string is refused here, as one `invalid_type` issue: left to the array,
     * its `length` runs the size checks after the type check fails and the shape
     * message reports twice. The pipe stops on this issue, and its code keeps
     * the framework's "Send citations as an array, not a string." recovery.
     */
    citations: z
      .preprocess(
        (value, ctx) => {
          if (typeof value === 'string') {
            ctx.issues.push({
              code: 'invalid_type',
              expected: 'array',
              input: value,
              message: CITATIONS_SHAPE_ERROR,
            });
            return value;
          }
          return isCitationObject(value) ? [value] : value;
        },
        z.array(CitationSchema, { error: CITATIONS_SHAPE_ERROR }).min(1).max(25),
      )
      .describe(
        'Citations to look up, 1–25, each matched independently. More fields = better match accuracy.',
      ),
  }),

  output: z.object({
    results: z
      .array(
        z
          .object({
            key: z.string().describe('Citation tracking key'),
            pmid: z.string().optional().describe('Matched PubMed ID'),
            matched: z.boolean().describe('Whether a PMID was found'),
            status: z
              .enum(['matched', 'not_found', 'ambiguous'])
              .describe('Lookup outcome classification for this citation'),
            detail: z
              .string()
              .optional()
              .describe('Additional detail returned by ECitMatch for non-exact matches'),
            candidatePmids: z
              .array(z.string().describe('PMID'))
              .optional()
              .describe(
                'Candidate PMIDs returned when the citation matched ambiguously. Add more bibliographic fields and retry to disambiguate, or fetch each candidate via pubmed_fetch_articles to pick the intended one.',
              ),
            matchedFirstAuthor: z
              .string()
              .optional()
              .describe(
                'First author of the matched article (e.g., "Husain M"). Useful eyeball signal for verifying a match.',
              ),
            warnings: z
              .array(
                z
                  .object({
                    code: z
                      .enum(['author_mismatch', 'year_mismatch'])
                      .describe('Machine-readable warning code'),
                    message: z.string().describe('Human-readable description of the warning'),
                  })
                  .describe('Non-fatal warning about the match'),
              )
              .optional()
              .describe(
                'Non-fatal warnings about this match. A PMID may be returned even when the queried author or year disagrees with the matched article — verify before treating the PMID as authoritative.',
              ),
          })
          .describe('Per-citation match result'),
      )
      .describe('Match results, one per input citation'),
    totalMatched: z.number().describe('Number of citations with PMID matches'),
    totalSubmitted: z.number().describe('Number of citations submitted'),
    totalWarnings: z
      .number()
      .describe('Number of matched citations that carry at least one warning'),
  }),

  async handler(input, ctx) {
    ctx.log.info('Executing pubmed_lookup_citation', { count: input.citations.length });

    const citations: ECitMatchCitation[] = input.citations.map((c, i) => ({
      journal: c.journal,
      year: c.year,
      volume: c.volume,
      firstPage: c.firstPage,
      authorName: c.authorName,
      key: c.key ?? String(i + 1),
    }));

    const ncbi = getNcbiService();
    // One result per submitted citation, in submission order — so verification
    // context is read from `citations[i]`, never looked up by `key`. That label
    // is caller-supplied and may repeat, and keying on it hands one citation's
    // queried author and year to another. (#113)
    const results = await ncbi.eCitMatch(citations, { signal: ctx.signal });

    const matchedPmids = Array.from(
      new Set(results.filter((r) => r.matched && r.pmid).map((r) => r.pmid as string)),
    );

    const summaryByPmid = new Map<
      string,
      { authors?: string; authorNames?: string[]; pubDate?: string }
    >();
    if (matchedPmids.length > 0) {
      // Version 2.0, because the version 1 DocSum drops what verification
      // needs: it lists a consortium as a `CollectiveName` item the roster
      // never reads, and it has no `DocDate`, so a Bookshelf chapter would be
      // dated by its book's start year. (#199, #201)
      const summaryResult = await ncbi.eSummary(
        { db: 'pubmed', version: '2.0', retmode: 'xml', id: matchedPmids.join(',') },
        { signal: ctx.signal },
      );
      const summaries = await extractBriefSummaries(summaryResult);
      for (const s of summaries) {
        summaryByPmid.set(s.pmid, {
          ...(s.authors && { authors: s.authors }),
          ...(s.authorNames?.length && { authorNames: s.authorNames }),
          ...(s.pubDate && { pubDate: s.pubDate }),
        });
      }
    }

    type Warning = {
      code: 'author_mismatch' | 'year_mismatch';
      message: string;
    };

    type MappedResult = {
      key: string;
      matched: boolean;
      status: 'matched' | 'not_found' | 'ambiguous';
      pmid?: string;
      detail?: string;
      candidatePmids?: string[];
      matchedFirstAuthor?: string;
      warnings?: Warning[];
    };

    const mapped: MappedResult[] = results.map((r, i) => {
      const queried = citations[i]?.authorName;
      const queriedYear = citations[i]?.year;
      const base: MappedResult = {
        key: r.key,
        matched: r.matched,
        status: r.status,
        ...(r.pmid && { pmid: r.pmid }),
        ...(r.detail && { detail: r.detail }),
        ...(r.candidatePmids?.length && { candidatePmids: r.candidatePmids }),
      };

      if (!r.matched || !r.pmid) return base;

      const summary = summaryByPmid.get(r.pmid);
      if (!summary) return base;

      const warnings: Warning[] = [];
      const { authors, authorNames, pubDate } = summary;

      if (authors) {
        const firstAuthor = authors.split(', ')[0]?.trim();
        if (firstAuthor && firstAuthor !== 'et al.') base.matchedFirstAuthor = firstAuthor;

        // Verified against the full roster, not `authors` — that display string
        // collapses to three names plus "et al.", so matching on it flags a
        // genuine fourth-or-later author as a mismatch. (#87)
        if (queried && authorNames?.length) {
          const querySurname = surname(queried);
          const articleSurnames = authorNames.map(surname);
          if (querySurname && !articleSurnames.includes(querySurname)) {
            warnings.push({
              code: 'author_mismatch',
              message: `Queried author "${queried}" not found in the matched article's ${authorNames.length}-author roster (${authors}). ECitMatch weights journal+volume+page and may return a PMID whose authors disagree with the query — verify before using this PMID.`,
            });
            ctx.log.warning('Citation match returned PMID with author mismatch', {
              key: r.key,
              pmid: r.pmid,
              queriedAuthor: queried,
              matchedAuthorCount: authorNames.length,
            });
          }
        }
      }

      if (queriedYear && pubDate) {
        const matchedYear = pubDate.slice(0, 4);
        if (/^\d{4}$/.test(matchedYear) && matchedYear !== queriedYear.trim()) {
          warnings.push({
            code: 'year_mismatch',
            message: `Queried year "${queriedYear}" does not match matched article year "${matchedYear}" (pubDate ${pubDate}). ECitMatch tolerates year disagreement — verify before using this PMID.`,
          });
          ctx.log.warning('Citation match returned PMID with year mismatch', {
            key: r.key,
            pmid: r.pmid,
            queriedYear,
            matchedYear,
          });
        }
      }

      if (warnings.length > 0) base.warnings = warnings;

      return base;
    });

    const totalMatched = mapped.filter((r) => r.matched).length;
    const totalWarnings = mapped.filter((r) => r.warnings?.length).length;
    ctx.log.info('pubmed_lookup_citation completed', {
      totalMatched,
      totalSubmitted: citations.length,
      totalWarnings,
    });

    return { results: mapped, totalMatched, totalSubmitted: citations.length, totalWarnings };
  },

  format: (result) => {
    const lines = [
      `## Citation Lookup Results`,
      `**Matched:** ${result.totalMatched}/${result.totalSubmitted}`,
    ];
    if (result.totalWarnings > 0) {
      lines.push(`**Warnings:** ${result.totalWarnings}`);
    }
    // The heading leads with the citation's 1-based submission index, which is
    // unique across the batch. `key` is a caller-supplied label that may repeat,
    // and text-only clients read this markdown instead of structuredContent — so
    // without the index two results can render under identical headings with no
    // way to tell which block answers which submitted citation. (#128)
    for (const [i, r] of result.results.entries()) {
      lines.push(`\n### ${i + 1} · ${r.key}`);
      if (r.pmid) lines.push(`**PMID:** ${r.pmid}`);
      if (r.matchedFirstAuthor) lines.push(`**First Author:** ${r.matchedFirstAuthor}`);
      if (r.candidatePmids?.length) {
        lines.push(`**Candidate PMIDs:** ${r.candidatePmids.join(', ')}`);
      }
      if (r.detail) lines.push(`**Detail:** ${r.detail}`);

      if (r.warnings?.length) {
        lines.push(`**Warnings:**`);
        for (const w of r.warnings) {
          lines.push(`- [${w.code}] ${w.message}`);
        }
      }

      if (r.status === 'matched') {
        const mismatches = r.warnings?.map((w) => w.code) ?? [];
        const hasMismatch = mismatches.length > 0;
        lines.push(`**Status:** Matched`);
        lines.push(
          hasMismatch
            ? `**Next Step:** ${mismatches.join(' + ')} detected — confirm this PMID is the intended article before citing. ECitMatch weights journal+volume+page and can resolve despite author/year disagreement.`
            : `**Next Step:** PMID is ready for downstream PubMed fetch or citation tools.`,
        );
        continue;
      }

      if (r.status === 'ambiguous') {
        lines.push(`**Status:** Ambiguous`);
        lines.push(
          r.candidatePmids?.length
            ? `**Next Step:** Add more citation fields to disambiguate, or fetch the candidate PMIDs above via pubmed_fetch_articles to pick the intended one manually.`
            : `**Next Step:** Add more citation fields such as journal, year, volume, firstPage, or authorName, then retry.`,
        );
        continue;
      }

      lines.push(`**Status:** No match`);
      lines.push(`**Next Step:** Verify the citation details or try pubmed_search_articles.`);
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
