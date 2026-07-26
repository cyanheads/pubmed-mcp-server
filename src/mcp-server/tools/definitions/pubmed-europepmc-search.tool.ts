/**
 * @fileoverview Europe PMC search tool. Surfaces records PubMed-only search
 * can't reach: preprints (source `PPR`), Agricola (`AGR`), patents (`PAT`),
 * and EPMC-only OA articles. Uses EPMC's cursor-based pagination
 * (`cursorMark`) — unlike `pubmed_search_articles`'s offset-based paging,
 * because EPMC's search API doesn't support offset.
 *
 * Only registered when `EUROPEPMC_ENABLED=true` (the default). The handler
 * fails fast with a configuration error if the service is unset, since the
 * tool wouldn't be registered in that case.
 *
 * @module src/mcp-server/tools/definitions/pubmed-europepmc-search.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { EUROPEPMC_SERVICE_ERRORS } from '@/services/error-contracts.js';
import { getEuropePmcService } from '@/services/europe-pmc/europe-pmc-service.js';
import {
  EUROPEPMC_ALL_SOURCES,
  EUROPEPMC_DEFAULT_SOURCES,
  type EuropePmcSource,
} from '@/services/europe-pmc/types.js';
import { toDisplayText } from '@/services/ncbi/parsing/text-helpers.js';
import {
  conceptMeta,
  EDAM_DATABASE_SEARCH,
  EDAM_PUBMED_ID,
  SCHEMA_SEARCH_ACTION,
} from './_concepts.js';
import { sliceCodeUnits } from './_text.js';

const SourceEnum = z.enum(['MED', 'PMC', 'PPR', 'PAT', 'AGR']);

/**
 * Character budget for `abstractSnippet`. Keeps a search page bounded no matter
 * how many hits carry long abstracts; `pubmed_europepmc_fetch` serves the
 * complete text for the records a caller actually wants. A cut that would split
 * a surrogate pair backs off a code unit, so a snippet can come back one
 * character under the budget. (#93)
 */
const ABSTRACT_SNIPPET_LIMIT = 400;

// ─── Tool Definition ─────────────────────────────────────────────────────────

export const pubmedEuropepmcSearchTool = tool('pubmed_europepmc_search', {
  description:
    'Search Europe PMC, a broad open-access biomedical corpus. Surfaces preprints (`source: PPR`), patents (`source: PAT`), Agricola (`source: AGR`), plus everything in PubMed (`MED`) and PMC. Use when additional coverage is needed — preprints and EPMC-only OA records are the typical recovery. Paginate via `cursorMark`. Defaults to `MED`, `PMC`, and `PPR`; pass `sources` to include `PAT` / `AGR`. Abstracts arrive as a bounded `abstractSnippet` with `abstractTruncated` marking the cut ones — pass a hit’s `source` and `epmcId` to `pubmed_europepmc_fetch` for the complete abstract.',
  annotations: { readOnlyHint: true, openWorldHint: true },
  _meta: conceptMeta([SCHEMA_SEARCH_ACTION, EDAM_DATABASE_SEARCH, EDAM_PUBMED_ID]),
  sourceUrl:
    'https://github.com/cyanheads/pubmed-mcp-server/blob/main/src/mcp-server/tools/definitions/pubmed-europepmc-search.tool.ts',

  errors: [
    ...EUROPEPMC_SERVICE_ERRORS,
    {
      reason: 'europepmc_disabled',
      code: JsonRpcErrorCode.ConfigurationError,
      when: 'Europe PMC service is disabled via EUROPEPMC_ENABLED=false.',
      recovery: 'Set EUROPEPMC_ENABLED=true (the default) and restart the server to use this tool.',
    },
  ] as const,

  input: z.object({
    query: z
      .string()
      .min(1)
      .describe(
        'Europe PMC search query. Supports field tokens like `AUTH:"<name>"`, `JOURNAL:"<title>"`, `TITLE:"<words>"`, `PUB_YEAR:[2020 TO 2024]`, `DOI:"..."`, `EXT_ID:<pmid> AND SRC:MED`, `PMCID:PMC<digits>`. Identifier tokens combined with `AND SRC:` must be unquoted — the quoted form matches nothing. Free text is matched broadly across abstract/title/keywords.',
      ),
    pageSize: z
      .number()
      .int()
      .min(1)
      .max(100)
      .default(25)
      .describe('Results per page. Max 100 per EPMC API.'),
    cursorMark: z
      .string()
      .default('*')
      .describe(
        "Pagination cursor. Use `*` (default) for the first page; pass the previous response's `nextCursorMark` for subsequent pages.",
      ),
    sources: z
      .array(SourceEnum)
      .min(1)
      .optional()
      .describe(
        `Filter to specific EPMC sources. Defaults to ${EUROPEPMC_DEFAULT_SOURCES.join(', ')} when omitted. Pass an explicit array including PAT or AGR to broaden coverage. Allowed values: ${EUROPEPMC_ALL_SOURCES.join(', ')}.`,
      ),
    resultType: z
      .enum(['core', 'lite'])
      .default('core')
      .describe(
        '`core` returns abstract, IDs, dates, license; `lite` is a smaller payload with IDs and titles only.',
      ),
    sort: z
      .string()
      .optional()
      .describe(
        'Optional EPMC sort: `<field> asc|desc`. Documented sortable fields: `P_PDATE_D` (publication date), `CITED` (citation count), `AUTH_FIRST` (first author surname), `PUB_YEAR` (publication year). Examples: `P_PDATE_D desc` (newest first), `CITED desc` (most cited). Omit for relevance ranking. Fields outside the documented set are rejected by EPMC. Note: `P_PDATE_D` is ignored for preprint-only (`sources: ["PPR"]`) result sets — preprints have no populated publication date, so use `PUB_YEAR` to order preprints by date.',
      ),
  }),

  output: z.object({
    hits: z
      .array(
        z
          .object({
            source: SourceEnum.describe(
              'Europe PMC source — `MED` (PubMed), `PMC` (PubMed Central), `PPR` (preprint), `PAT` (patent), `AGR` (Agricola)',
            ),
            epmcId: z
              .string()
              .describe(
                "Europe PMC's internal record id. Pass it with this hit's `source` to `pubmed_europepmc_fetch` for the complete record. Europe PMC's `fullTextXML` is keyed on `pmcId`, not on this id, so records without a PMC counterpart have no full text to fetch.",
              ),
            title: z.string().optional().describe('Article title'),
            authors: z.string().optional().describe('Formatted author string'),
            journal: z.string().optional().describe('Journal title'),
            pubYear: z.string().optional().describe('Publication year'),
            firstPublicationDate: z
              .string()
              .optional()
              .describe('First publication date (ISO YYYY-MM-DD)'),
            pmid: z.string().optional().describe('PMID when present in PubMed'),
            pmcId: z.string().optional().describe('PMC ID when present in PMC'),
            doi: z
              .string()
              .optional()
              .describe(
                'DOI when present, cased as Europe PMC reports it. DOIs are case-insensitive by spec and no case normalization is applied here, so the same DOI can arrive in a different case from `pubmed_fetch_articles` (Europe PMC `10.1056/nejmoa2212948`, NCBI `10.1056/NEJMoa2212948`) — a byte-for-byte comparison across the two reports a false mismatch.',
              ),
            isOpenAccess: z
              .boolean()
              .optional()
              .describe('Whether EPMC reports the record as open access'),
            hasFullTextXml: z
              .boolean()
              .optional()
              .describe(
                'Whether Europe PMC publishes a fullTextXML for this record. Derived from `inPMC` — only records with a PMC counterpart have JATS via EPMC; preprints (`PPR`) and MED-only records return false.',
              ),
            abstractSnippet: z
              .string()
              .optional()
              .describe(
                `First ${ABSTRACT_SNIPPET_LIMIT} characters of the abstract as display-ready plain text — JATS/HTML markup stripped and HTML entities decoded — when \`resultType: "core"\` is requested, with a trailing … appended when the abstract was cut. Check \`abstractTruncated\` before treating it as the whole abstract.`,
              ),
            abstractTruncated: z
              .boolean()
              .optional()
              .describe(
                'Whether `abstractSnippet` was cut short of the full abstract. Retrieve the complete text with `pubmed_europepmc_fetch` using this record’s `source` and `epmcId`. Present whenever `abstractSnippet` is; omitted when Europe PMC carries no abstract.',
              ),
            citedByCount: z.number().optional().describe('Citation count reported by Europe PMC'),
            epmcUrl: z.string().describe('Europe PMC article URL'),
          })
          .describe('Single Europe PMC record returned by the search'),
      )
      .describe('Matching Europe PMC records, in the order EPMC returned them'),
    cursorMark: z.string().describe('Cursor used for this response (echoed from the request)'),
    nextCursorMark: z
      .string()
      .optional()
      .describe('Cursor to pass back as `cursorMark` for the next page. Absent on the final page.'),
    searchUrl: z.string().describe("Europe PMC's website search URL for this query"),
  }),

  // Result-set context the agent reasons with — the query as EPMC echoed it, the total
  // match count, the sources actually queried, and recovery guidance for empty pages.
  // Surfaced via ctx.enrich(...) to structuredContent and content[]; out of the return.
  enrichment: {
    query: z.string().describe('Effective query string echoed by Europe PMC'),
    totalCount: z.number().describe('Total matching records across all pages'),
    appliedSources: z
      .array(SourceEnum)
      .describe('Sources the query was filtered against (defaults applied)'),
    notice: z
      .string()
      .optional()
      .describe('Optional guidance when results are empty or paging overshot'),
  },

  // content[] trailer presentation for the enrichment block. structuredContent always
  // carries the full structured value; this only shapes the human-facing trailer line.
  enrichmentTrailer: {
    query: { label: 'Effective Query' },
    totalCount: { label: 'Total Hits' },
    appliedSources: {
      render: (sources) => `**Sources:** ${sources.join(', ')}`,
    },
  },

  async handler(input, ctx) {
    ctx.log.info('Executing pubmed_europepmc_search', { query: input.query });
    const epmc = getEuropePmcService();
    if (!epmc) {
      throw ctx.fail(
        'europepmc_disabled',
        'Europe PMC service is not available. Set EUROPEPMC_ENABLED=true to use this tool.',
        { ...ctx.recoveryFor('europepmc_disabled') },
      );
    }

    const sources = (input.sources ?? EUROPEPMC_DEFAULT_SOURCES) as readonly EuropePmcSource[];
    const result = await epmc.search({
      query: input.query,
      resultType: input.resultType,
      pageSize: input.pageSize,
      cursorMark: input.cursorMark,
      sources,
      ...(input.sort && { sort: input.sort }),
      ...(ctx.signal && { signal: ctx.signal }),
    });

    const hits = result.hits.map((h) => {
      // EPMC returns abstractText as a raw JSON string carrying JATS/HTML markup,
      // un-decoded entities, and soft hyphens (no XML parser runs on it). Clean it
      // to display-ready plain text before truncating, so the snippet budget is
      // spent on text and soft hyphens don't corrupt downstream token matching. (#74)
      const abstract = h.abstractText ? toDisplayText(h.abstractText) : '';
      const truncated = abstract.length > ABSTRACT_SNIPPET_LIMIT;
      return {
        source: h.source as 'MED' | 'PMC' | 'PPR' | 'PAT' | 'AGR',
        epmcId: h.id,
        ...(h.title && { title: h.title }),
        ...(h.authorString && { authors: h.authorString }),
        ...(h.journalTitle && { journal: h.journalTitle }),
        ...(h.pubYear && { pubYear: h.pubYear }),
        ...(h.firstPublicationDate && { firstPublicationDate: h.firstPublicationDate }),
        ...(h.pmid && { pmid: h.pmid }),
        ...(h.pmcid && { pmcId: h.pmcid }),
        ...(h.doi && { doi: h.doi }),
        ...(h.isOpenAccess !== undefined && { isOpenAccess: h.isOpenAccess === 'Y' }),
        ...(h.inPMC !== undefined && { hasFullTextXml: h.inPMC === 'Y' }),
        ...(abstract && {
          abstractSnippet: truncated
            ? `${sliceCodeUnits(abstract, ABSTRACT_SNIPPET_LIMIT)}…`
            : abstract,
          abstractTruncated: truncated,
        }),
        ...(typeof h.citedByCount === 'number' && { citedByCount: h.citedByCount }),
        epmcUrl: `https://europepmc.org/article/${h.source}/${h.id}`,
      };
    });

    // Europe PMC accepts a `P_PDATE_D` sort but silently ignores it for
    // preprint-only (PPR) result sets — preprints have no populated publication
    // date, so results come back relevance-ranked, not date-ordered. Signal it so
    // a caller asking for "newest first" isn't misled by the silent fallback.
    // (PUB_YEAR is honored for PPR; only the day-granularity P_PDATE_D is not.)
    const sortField = input.sort?.trim().split(/\s+/)[0]?.toUpperCase();
    const isPprOnly = sources.length > 0 && sources.every((s) => s === 'PPR');
    let notice: string | undefined;
    if (result.hitCount === 0) {
      notice =
        'No results matched your Europe PMC query. Try broadening the query, removing source filters, or running pubmed_spell_check on the term.';
    } else if (sortField === 'P_PDATE_D' && isPprOnly) {
      notice =
        'Europe PMC ignores `P_PDATE_D` sort for preprint-only (PPR) results — preprints have no populated publication date, so records are returned in relevance order, not by date. To order preprints by date, sort by `PUB_YEAR`, or re-rank the returned page by each record’s `firstPublicationDate`.';
    }

    ctx.log.info('pubmed_europepmc_search completed', {
      hitCount: result.hitCount,
      returnedHits: hits.length,
      hasNextPage: !!result.nextCursorMark,
    });

    ctx.enrich({
      query: result.query,
      appliedSources: [...sources] as ('MED' | 'PMC' | 'PPR' | 'PAT' | 'AGR')[],
    });
    ctx.enrich.total(result.hitCount);
    if (notice) ctx.enrich.notice(notice);

    return {
      hits,
      cursorMark: result.cursorMark ?? '*',
      ...(result.nextCursorMark && { nextCursorMark: result.nextCursorMark }),
      searchUrl: `https://europepmc.org/search?query=${encodeURIComponent(input.query)}`,
    };
  },

  format: (result) => {
    const lines = [
      '## Europe PMC Search Results',
      `**Returned:** ${result.hits.length}`,
      `**Cursor:** ${result.cursorMark}${result.nextCursorMark ? ` → \`${result.nextCursorMark}\` (next page)` : ' (final page)'}`,
      `**Search URL:** ${result.searchUrl}`,
    ];

    if (result.hits.length > 0) {
      lines.push('\n### Hits');
      for (const h of result.hits) {
        lines.push(`\n#### ${h.title ?? h.epmcId}`);
        lines.push(`**Source:** ${h.source} | **EPMC ID:** ${h.epmcId}`);
        if (h.authors) lines.push(`**Authors:** ${h.authors}`);
        if (h.journal) lines.push(`**Journal:** ${h.journal}`);
        if (h.firstPublicationDate) lines.push(`**Published:** ${h.firstPublicationDate}`);
        if (h.pubYear) lines.push(`**Year:** ${h.pubYear}`);
        if (h.pmid) lines.push(`**PMID:** ${h.pmid}`);
        if (h.pmcId) lines.push(`**PMCID:** ${h.pmcId}`);
        if (h.doi) lines.push(`**DOI:** ${h.doi}`);
        if (h.isOpenAccess !== undefined)
          lines.push(`**Open Access:** ${h.isOpenAccess ? 'yes' : 'no'}`);
        if (h.hasFullTextXml !== undefined) {
          lines.push(`**Full-text XML in EPMC:** ${h.hasFullTextXml ? 'yes' : 'no'}`);
        }
        if (typeof h.citedByCount === 'number') lines.push(`**Cited by:** ${h.citedByCount}`);
        lines.push(`**URL:** ${h.epmcUrl}`);
        if (h.abstractSnippet) {
          lines.push(`\n${h.abstractSnippet}`);
          if (h.abstractTruncated) {
            lines.push(
              `_Abstract truncated at ${ABSTRACT_SNIPPET_LIMIT} characters — call \`pubmed_europepmc_fetch\` with this record's \`source\` and \`epmcId\` for the complete text._`,
            );
          }
        }
      }
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
