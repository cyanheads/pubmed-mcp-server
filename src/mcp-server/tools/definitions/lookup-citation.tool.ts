/**
 * @fileoverview Citation lookup tool. Resolves partial bibliographic references
 * to PubMed IDs using NCBI's ECitMatch service, then verifies author agreement
 * against ESummary to catch cases where ECitMatch's journal+volume+page weighting
 * returns a PMID whose author roster doesn't contain the queried author.
 * `citations` takes an array or a single citation object, and `citation` is
 * accepted as an alias for it.
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
const BDATA_FIELD_HINT = 'Cannot contain a pipe ("|") or a line break.';
const BDATA_FIELD_ERROR = `${BDATA_FIELD_HINT} Those characters shift ECitMatch's field layout — remove them or replace them with a space.`;

const CitationSchema = z
  .object({
    journal: z
      .string()
      .regex(BDATA_FIELD_RE, BDATA_FIELD_ERROR)
      .optional()
      .describe(
        `Journal title or ISO abbreviation (e.g., "proc natl acad sci u s a"). ${BDATA_FIELD_HINT}`,
      ),
    year: z
      .string()
      .regex(BDATA_FIELD_RE, BDATA_FIELD_ERROR)
      .optional()
      .describe(`Publication year (e.g., "1991"). ${BDATA_FIELD_HINT}`),
    volume: z
      .string()
      .regex(BDATA_FIELD_RE, BDATA_FIELD_ERROR)
      .optional()
      .describe(`Volume number. ${BDATA_FIELD_HINT}`),
    firstPage: z
      .string()
      .regex(BDATA_FIELD_RE, BDATA_FIELD_ERROR)
      .optional()
      .describe(`First page number. ${BDATA_FIELD_HINT}`),
    authorName: z
      .string()
      .regex(BDATA_FIELD_RE, BDATA_FIELD_ERROR)
      .optional()
      .describe(
        `Author name, typically "lastname initials" (e.g., "mann bj"). ${BDATA_FIELD_HINT}`,
      ),
    key: z
      .string()
      .optional()
      .describe(
        'Arbitrary label to track this citation in results. Auto-assigned if omitted. Echoed back unchanged and never sent to NCBI, so any character is accepted here.',
      ),
  })
  .describe(
    'Citation to match against PubMed. Must include at least journal or year — ECitMatch primary-keys on journal+volume+page, so author-only or volume-only inputs guarantee no match.',
  )
  .refine((c) => !!(c.journal || c.year), {
    message:
      'Each citation must include at least a journal or year field — ECitMatch primary-keys on journal+volume+page, so author-only or volume-only inputs guarantee no match.',
  });

/**
 * The union issue's own message, in place of Zod's bare `Invalid input`. A value
 * that fails only a check inside one branch — a pipe in a field, a missing
 * journal and year — keeps that branch's issue and path. A value that fails both
 * branches outright (a string, or an array element of the wrong type) is one
 * union issue carrying this message, with each branch's issues nested under it.
 */
const CITATIONS_SHAPE_ERROR =
  'Invalid input: expected a citation object or an array of 1–25 citation objects';

export const lookupCitationTool = tool('pubmed_lookup_citation', {
  description: `Look up PubMed IDs from partial bibliographic citations. Useful when you have a reference (journal, year, volume, page, author) and need the PMID — deterministic citation matching, more reliable than free-text search for structured references. Each citation must include at least journal or year (ECitMatch primary-keys on journal+volume+page; author-only or volume-only inputs guarantee no match); more fields = better match accuracy.`,
  annotations: { readOnlyHint: true, openWorldHint: true },
  _meta: conceptMeta([SCHEMA_SCHOLARLY_ARTICLE, EDAM_DATA_RETRIEVAL, EDAM_PUBMED_ID]),
  sourceUrl:
    'https://github.com/cyanheads/pubmed-mcp-server/blob/main/src/mcp-server/tools/definitions/lookup-citation.tool.ts',

  errors: [...NCBI_SERVICE_ERRORS] as const,

  // Never advertised; rewritten to the canonical key before the schema parses.
  // A single object usually arrives under this name, which the union below
  // accepts. (#156)
  inputAliases: { citation: 'citations' },

  input: z.object({
    citations: z
      .union(
        [
          z
            .array(CitationSchema)
            .min(1)
            .max(25)
            .describe('Up to 25 citations, each matched independently.'),
          CitationSchema,
        ],
        { error: CITATIONS_SHAPE_ERROR },
      )
      .describe(
        'Citations to look up — an array of up to 25, or a single citation object. More fields = better match accuracy.',
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
    const submitted = Array.isArray(input.citations) ? input.citations : [input.citations];
    ctx.log.info('Executing pubmed_lookup_citation', { count: submitted.length });

    const citations: ECitMatchCitation[] = submitted.map((c, i) => ({
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
      const summaryResult = await ncbi.eSummary(
        { db: 'pubmed', id: matchedPmids.join(',') },
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
