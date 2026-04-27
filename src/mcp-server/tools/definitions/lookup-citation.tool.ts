/**
 * @fileoverview Citation lookup tool. Resolves partial bibliographic references
 * to PubMed IDs using NCBI's ECitMatch service, then verifies author agreement
 * against ESummary to catch cases where ECitMatch's journal+volume+page weighting
 * returns a PMID whose author roster doesn't contain the queried author.
 * @module src/mcp-server/tools/definitions/lookup-citation.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
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

/** Split a formatted authors string ("Lastname FI, Lastname FI, et al.") into surnames. */
function authorSurnames(authors: string): string[] {
  return authors
    .split(', ')
    .map((a) => surname(a))
    .filter((s) => s.length > 0 && s !== 'et');
}

export const lookupCitationTool = tool('pubmed_lookup_citation', {
  description: `Look up PubMed IDs from partial bibliographic citations. Useful when you have a reference (journal, year, volume, page, author) and need the PMID. Uses NCBI ECitMatch for deterministic matching — more reliable than searching by citation fields. Each citation must include at least one bibliographic field (journal, year, volume, firstPage, or authorName); more fields = better match accuracy.`,
  annotations: { readOnlyHint: true, openWorldHint: true },
  _meta: conceptMeta([SCHEMA_SCHOLARLY_ARTICLE, EDAM_DATA_RETRIEVAL, EDAM_PUBMED_ID]),
  sourceUrl:
    'https://github.com/cyanheads/pubmed-mcp-server/blob/main/src/mcp-server/tools/definitions/lookup-citation.tool.ts',

  input: z.object({
    citations: z
      .array(
        z
          .object({
            journal: z
              .string()
              .optional()
              .describe('Journal title or ISO abbreviation (e.g., "proc natl acad sci u s a")'),
            year: z.string().optional().describe('Publication year (e.g., "1991")'),
            volume: z.string().optional().describe('Volume number'),
            firstPage: z.string().optional().describe('First page number'),
            authorName: z
              .string()
              .optional()
              .describe('Author name, typically "lastname initials" (e.g., "mann bj")'),
            key: z
              .string()
              .optional()
              .describe(
                'Arbitrary label to track this citation in results. Auto-assigned if omitted.',
              ),
          })
          .describe(
            'Citation to match against PubMed. Must include at least one bibliographic field (journal, year, volume, firstPage, or authorName).',
          )
          .refine((c) => !!(c.journal || c.year || c.volume || c.firstPage || c.authorName), {
            message:
              'Each citation must include at least one bibliographic field (journal, year, volume, firstPage, or authorName).',
          }),
      )
      .min(1)
      .max(25)
      .describe('Citations to look up. More fields = better match accuracy.'),
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
    const results = await ncbi.eCitMatch(citations, { signal: ctx.signal });

    const queriedAuthorByKey = new Map<string, string>();
    const queriedYearByKey = new Map<string, string>();
    for (const c of citations) {
      if (c.authorName) queriedAuthorByKey.set(c.key, c.authorName);
      if (c.year) queriedYearByKey.set(c.key, c.year);
    }

    const matchedPmids = Array.from(
      new Set(results.filter((r) => r.matched && r.pmid).map((r) => r.pmid as string)),
    );

    const summaryByPmid = new Map<string, { authors?: string; pubDate?: string }>();
    if (matchedPmids.length > 0) {
      const summaryResult = await ncbi.eSummary(
        { db: 'pubmed', id: matchedPmids.join(',') },
        { signal: ctx.signal },
      );
      const summaries = await extractBriefSummaries(summaryResult);
      for (const s of summaries) {
        summaryByPmid.set(s.pmid, {
          ...(s.authors && { authors: s.authors }),
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

    const mapped: MappedResult[] = results.map((r) => {
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
      const { authors, pubDate } = summary;

      if (authors) {
        const firstAuthor = authors.split(', ')[0]?.trim();
        if (firstAuthor && firstAuthor !== 'et al.') base.matchedFirstAuthor = firstAuthor;

        const queried = queriedAuthorByKey.get(r.key);
        if (queried) {
          const querySurname = surname(queried);
          const articleSurnames = authorSurnames(authors);
          if (querySurname && !articleSurnames.includes(querySurname)) {
            warnings.push({
              code: 'author_mismatch',
              message: `Queried author "${queried}" not found in matched article authors (${authors}). ECitMatch weights journal+volume+page and may return a PMID whose authors disagree with the query — verify before using this PMID.`,
            });
            ctx.log.warning('Citation match returned PMID with author mismatch', {
              key: r.key,
              pmid: r.pmid,
              queriedAuthor: queried,
              matchedAuthors: authors,
            });
          }
        }
      }

      const queriedYear = queriedYearByKey.get(r.key);
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
    for (const r of result.results) {
      lines.push(`\n### ${r.key}`);
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
