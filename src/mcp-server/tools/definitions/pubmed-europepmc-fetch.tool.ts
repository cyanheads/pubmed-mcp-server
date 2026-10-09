/**
 * @fileoverview Europe PMC record fetch tool. Detail counterpart to
 * `pubmed_europepmc_search`: resolves specific records by `source` + `epmcId`
 * and returns each one's complete, untruncated abstract. That pair is the only
 * identifier many PPR, PAT, and AGR records carry, so `pubmed_fetch_articles`
 * (PMIDs) and `pubmed_fetch_fulltext` (PMCIDs / PMIDs / DOIs) cannot reach them.
 *
 * Only registered when `EUROPEPMC_ENABLED=true` (the default). The handler
 * fails fast with a configuration error if the service is unset, since the
 * tool wouldn't be registered in that case.
 *
 * @module src/mcp-server/tools/definitions/pubmed-europepmc-fetch.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { EUROPEPMC_SERVICE_ERRORS } from '@/services/error-contracts.js';
import { getEuropePmcService } from '@/services/europe-pmc/europe-pmc-service.js';
import { EUROPEPMC_ALL_SOURCES } from '@/services/europe-pmc/types.js';
import { toDisplayText } from '@/services/ncbi/parsing/text-helpers.js';
import { fitWholeItems } from './_budget.js';
import {
  conceptMeta,
  EDAM_ACCESSION,
  EDAM_DATA_RETRIEVAL,
  SCHEMA_SCHOLARLY_ARTICLE,
} from './_concepts.js';
import { escapeMarkdownInline } from './_text.js';

const SourceEnum = z.enum(EUROPEPMC_ALL_SOURCES);

/**
 * Europe PMC ids are identifier tokens (`PPR1283828`, `KR20120031038`,
 * `IND609436151`, `PMC13294766`, or a bare PMID). Restricting the character set
 * keeps them safe to interpolate unquoted into the EPMC lookup query, where the
 * quoted form matches nothing.
 */
const epmcIdSchema = z
  .string()
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._-]*$/,
    'epmcId must be a Europe PMC record identifier — letters, digits, dots, hyphens, or underscores only (e.g. "PPR1283828", "KR20120031038", "IND609436151"). Copy it verbatim from a pubmed_europepmc_search hit\'s `epmcId`.',
  )
  .max(64);

/** An `epmcId` in PMCID shape — `pubmed_fetch_fulltext` addresses these directly. */
const PMCID_SHAPED_RE = /^PMC\d+$/i;

const RecordRefSchema = z
  .object({
    source: SourceEnum.describe(
      "Europe PMC source corpus — `MED` (PubMed), `PMC` (PubMed Central), `PPR` (preprint), `PAT` (patent), `AGR` (Agricola). Copy it from the search hit's `source`. `PMC` paired with a PMCID resolves whether or not the article is also indexed in PubMed, and a PubMed-indexed one comes back as its canonical `MED` record carrying that PMCID in `pmcId`.",
    ),
    epmcId: epmcIdSchema.describe(
      "Europe PMC's own record id within that source. Copy it from the search hit's `epmcId` — for `MED` records this is the PMID; for the other sources it is an EPMC-native accession.",
    ),
  })
  .describe('One record address: the Europe PMC source corpus plus its id within that corpus');

const FetchedRecordSchema = z
  .object({
    source: SourceEnum.describe('Europe PMC source the record was resolved from'),
    epmcId: z.string().describe("Europe PMC's internal record id"),
    title: z
      .string()
      .optional()
      .describe(
        'Record title as display-ready plain text — JATS/HTML markup stripped and HTML entities decoded.',
      ),
    authors: z
      .string()
      .optional()
      .describe(
        'Formatted author string as display-ready plain text — JATS/HTML markup stripped and HTML entities decoded.',
      ),
    journal: z
      .string()
      .optional()
      .describe(
        'Journal title as display-ready plain text — JATS/HTML markup stripped and HTML entities decoded.',
      ),
    pubYear: z.string().optional().describe('Publication year'),
    firstPublicationDate: z.string().optional().describe('First publication date (ISO YYYY-MM-DD)'),
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
      .describe('Whether Europe PMC reports the record as open access'),
    hasFullTextXml: z
      .boolean()
      .optional()
      .describe(
        'Whether Europe PMC publishes a fullTextXML for this record. Derived from `inPMC` — only records with a PMC counterpart have JATS via Europe PMC.',
      ),
    abstract: z
      .string()
      .optional()
      .describe(
        'Complete abstract as display-ready plain text — JATS/HTML markup stripped and HTML entities decoded, never truncated. Omitted when Europe PMC carries no abstract for the record.',
      ),
    citedByCount: z.number().optional().describe('Citation count reported by Europe PMC'),
    epmcUrl: z.string().describe('Europe PMC article URL'),
  })
  .describe('Complete Europe PMC record');

const DeferredSchema = z
  .object({
    maxResponseCharacters: z
      .number()
      .describe('The `maxResponseCharacters` ceiling this response was budgeted against'),
    returnedCharacters: z
      .number()
      .describe('Serialized characters the returned records account for'),
    deferredCount: z
      .number()
      .describe('Records that resolved but were withheld to stay under the ceiling'),
    records: z
      .array(
        FetchedRecordSchema.pick({ source: true, epmcId: true }).describe(
          'One deferred record, addressed by its own `source` + `epmcId`',
        ),
      )
      .describe(
        "The deferred records, in response order, each as the resolved record's own `source` + `epmcId` — a `PMC` request answered by its `MED` record is listed as that `MED` pair. Pass them back as `records` to retrieve them. Never contains a pair from `notFound`.",
      ),
    nextDeferredCharacters: z
      .number()
      .describe(
        'Serialized size of the next deferred record — the first entry in `records`, where the response stopped. Raise `maxResponseCharacters` to at least this to make progress; a smaller record further down `records` cannot be reached until this one fits.',
      ),
  })
  .describe(
    'Continuation state for records the whole-response budget withheld. Present only when `maxResponseCharacters` deferred at least one record.',
  );

// ─── Tool Definition ─────────────────────────────────────────────────────────

export const pubmedEuropepmcFetchTool = tool('pubmed_europepmc_fetch', {
  description:
    "Fetch complete Europe PMC records — including the full, untruncated abstract — for records addressed by `source` plus `epmcId`. Pairs with `pubmed_europepmc_search`, which returns bounded `abstractSnippet` values and flags cut ones with `abstractTruncated: true`; pass those hits' `source` and `epmcId` here to read the whole abstract. This is the retrieval path for preprint (`PPR`), patent (`PAT`), and Agricola (`AGR`) records, which frequently carry no PMID and no DOI, so `pubmed_fetch_articles` and `pubmed_fetch_fulltext` cannot address them. Up to 25 records per call. Set `maxResponseCharacters` to bound the whole response: records past the ceiling are deferred whole and listed in `deferred.records` for a follow-up call.",
  annotations: { readOnlyHint: true, openWorldHint: true },
  _meta: conceptMeta([SCHEMA_SCHOLARLY_ARTICLE, EDAM_DATA_RETRIEVAL, EDAM_ACCESSION]),
  sourceUrl:
    'https://github.com/cyanheads/pubmed-mcp-server/blob/main/src/mcp-server/tools/definitions/pubmed-europepmc-fetch.tool.ts',

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
    records: z
      .array(RecordRefSchema)
      .min(1)
      .max(25)
      .describe(
        'Records to retrieve, each addressed by the `source` and `epmcId` of a `pubmed_europepmc_search` hit. The whole batch resolves in one Europe PMC request.',
      ),
    maxResponseCharacters: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe(
        'Opt-in ceiling for the whole response, in characters. Each record is measured as the JSON record it is returned as — title, authors, journal, abstract, identifiers, every field it carries. Records are kept in the order Europe PMC returned them until the next one would cross the ceiling; that record and the rest are deferred whole (never partially populated) and listed in `deferred.records`. Response envelope fields — `notFound`, `deferred` itself — are not counted. Omit to return every resolved record.',
      ),
  }),

  output: z.object({
    records: z
      .array(FetchedRecordSchema)
      .describe(
        'Resolved records, in the order Europe PMC returned them. Under a `maxResponseCharacters` budget, only the leading records that fit; `deferred.records` lists the rest.',
      ),
    notFound: z
      .array(RecordRefSchema)
      .optional()
      .describe(
        'Requested `source` + `epmcId` pairs Europe PMC returned no record for. Reported in full regardless of where a `maxResponseCharacters` cut lands — these are misses, not deferrals.',
      ),
    deferred: DeferredSchema.optional(),
  }),

  // Recovery guidance when some or all requested pairs resolve to nothing, and
  // when the whole-response budget deferred records — agent-facing context,
  // surfaced to structuredContent and content[] alike.
  enrichment: {
    notice: z
      .string()
      .optional()
      .describe(
        'Guidance when one or more requested records could not be resolved, or when `maxResponseCharacters` deferred records — naming how to retrieve them. Absent when every requested record came back.',
      ),
    truncated: z
      .boolean()
      .optional()
      .describe(
        'True when `maxResponseCharacters` withheld at least one resolved record. Absent when the response carries every record that resolved. The continuation state is in `deferred`.',
      ),
  },

  async handler(input, ctx) {
    ctx.log.info('Executing pubmed_europepmc_fetch', { recordCount: input.records.length });
    const epmc = getEuropePmcService();
    if (!epmc) {
      throw ctx.fail(
        'europepmc_disabled',
        'Europe PMC service is not available. Set EUROPEPMC_ENABLED=true to use this tool.',
      );
    }

    const hits = await epmc.fetchRecords(input.records, ctx.signal);

    const resolvedRecords = hits.map((h) => {
      // EPMC returns these as raw JSON strings carrying JATS/HTML markup,
      // un-decoded entities, and soft hyphens (no XML parser runs on them).
      // Title is the confirmed live vector — preprints carry italicized species
      // and gene names — but authors and journal are free-text upstream fields
      // on the same footing, so all three take the single-pass normalization
      // the abstract already gets. (#102) The cleanup mirrors
      // pubmed_europepmc_search; only the truncation is dropped.
      const abstract = h.abstractText ? toDisplayText(h.abstractText) : '';
      const title = h.title ? toDisplayText(h.title) : '';
      const authors = h.authorString ? toDisplayText(h.authorString) : '';
      const journal = h.journalTitle ? toDisplayText(h.journalTitle) : '';
      return {
        source: h.source as (typeof EUROPEPMC_ALL_SOURCES)[number],
        epmcId: h.id,
        ...(title && { title }),
        ...(authors && { authors }),
        ...(journal && { journal }),
        ...(h.pubYear && { pubYear: h.pubYear }),
        ...(h.firstPublicationDate && { firstPublicationDate: h.firstPublicationDate }),
        ...(h.pmid && { pmid: h.pmid }),
        ...(h.pmcid && { pmcId: h.pmcid }),
        ...(h.doi && { doi: h.doi }),
        ...(h.isOpenAccess !== undefined && { isOpenAccess: h.isOpenAccess === 'Y' }),
        ...(h.inPMC !== undefined && { hasFullTextXml: h.inPMC === 'Y' }),
        ...(abstract && { abstract }),
        ...(typeof h.citedByCount === 'number' && { citedByCount: h.citedByCount }),
        epmcUrl: `https://europepmc.org/article/${h.source}/${h.id}`,
      };
    });

    // Europe PMC treats identifiers case-insensitively, so match the request
    // against the response on an upper-cased key rather than reporting a hit as
    // missing over a casing difference.
    const refKey = (source: string, id: string) => `${source}:${id.toUpperCase()}`;
    const resolved = new Set<string>();
    for (const r of resolvedRecords) {
      resolved.add(refKey(r.source, r.epmcId));
      // A `PMC` request for a PubMed-indexed article resolves to that article's
      // canonical `MED` record, which reports the requested PMCID in `pmcId`
      // instead of as its own id. Without this alias the record comes back in
      // `records` and is reported missing in the same response.
      if (r.pmcId) resolved.add(refKey('PMC', r.pmcId));
    }
    // Diffed against every resolved record, before the budget cut below, so a
    // deferred record is never also reported missing.
    const notFound = input.records.filter((ref) => !resolved.has(refKey(ref.source, ref.epmcId)));

    // Whole-response budget: fill with complete records in response order and
    // hand the rest back as pairs the caller can re-submit. Without
    // `maxResponseCharacters` nothing is measured and the response is exactly
    // what it was before the budget existed. (#188)
    const ceiling = input.maxResponseCharacters;
    const fit = ceiling === undefined ? undefined : fitWholeItems(resolvedRecords, ceiling);
    const records = fit?.kept ?? resolvedRecords;
    const deferred =
      ceiling !== undefined && fit?.nextDeferredCharacters !== undefined
        ? {
            maxResponseCharacters: ceiling,
            returnedCharacters: fit.keptCharacters,
            deferredCount: fit.deferred.length,
            records: fit.deferred.map((r) => ({ source: r.source, epmcId: r.epmcId })),
            nextDeferredCharacters: fit.nextDeferredCharacters,
          }
        : undefined;

    ctx.log.info('pubmed_europepmc_fetch completed', {
      requested: input.records.length,
      returned: records.length,
      ...(deferred && { deferred: deferred.deferredCount }),
    });

    // An unresolved id shaped like a PMCID is reachable by another route:
    // pubmed_fetch_fulltext addresses PMCIDs directly, with no `source` pair.
    const pmcidHint = notFound.some((r) => PMCID_SHAPED_RE.test(r.epmcId))
      ? ' An id shaped like a PMCID also resolves through pubmed_fetch_fulltext, whose `pmcids` input takes it on its own.'
      : '';

    // Only the last ctx.enrich.notice survives, so the applicable guidance is
    // collected and emitted once. The empty-batch case keys on what resolved,
    // not on what the budget kept: a batch emptied by a small ceiling is a
    // budget outcome, not a batch of unknown pairs.
    const notices: string[] = [];
    if (resolvedRecords.length === 0) {
      notices.push(
        `Europe PMC returned no record for any requested pair. Both fields must be copied verbatim from a pubmed_europepmc_search hit — \`epmcId\` is Europe PMC's own id (the PMID only for \`source: "MED"\`), and it must be paired with the same hit's \`source\`.${pmcidHint}`,
      );
    } else if (notFound.length > 0) {
      notices.push(
        `Europe PMC returned no record for ${notFound.length} of ${input.records.length} requested pairs: ${notFound
          .map(formatPair)
          .join(
            ', ',
          )}. Verify each against its pubmed_europepmc_search hit — a mismatched \`source\` is the usual cause.${pmcidHint}`,
      );
    }
    if (deferred) {
      ctx.enrich({ truncated: true });
      notices.push(buildDeferralNotice(deferred));
    }
    if (notices.length > 0) ctx.enrich.notice(notices.join(' '));

    return {
      records,
      ...(notFound.length > 0 && { notFound }),
      ...(deferred && { deferred }),
    };
  },

  format: (result) => {
    const lines = ['## Europe PMC Records', `**Returned:** ${result.records.length}`];

    if (result.notFound?.length) {
      lines.push(`**Not found:** ${result.notFound.map(formatPair).join(', ')}`);
    }

    if (result.deferred) {
      const d = result.deferred;
      lines.push(
        `**Deferred by the response budget:** ${d.deferredCount} record(s) — ${d.returnedCharacters} of ${d.maxResponseCharacters} budgeted characters returned; next deferred record ${d.nextDeferredCharacters} characters`,
        `Re-call \`pubmed_europepmc_fetch\` with these as \`records\` (\`source\`/\`epmcId\`): ${d.records.map(formatPair).join(', ')}`,
      );
    }

    for (const r of result.records) {
      // Escaping is render-time only — the structuredContent values above stay
      // plain text; only these interpolations are neutralized. (#102)
      lines.push(`\n### ${escapeMarkdownInline(r.title ?? r.epmcId)}`);
      lines.push(`**Source:** ${r.source} | **EPMC ID:** ${r.epmcId}`);
      if (r.authors) lines.push(`**Authors:** ${escapeMarkdownInline(r.authors)}`);
      if (r.journal) lines.push(`**Journal:** ${escapeMarkdownInline(r.journal)}`);
      if (r.firstPublicationDate) lines.push(`**Published:** ${r.firstPublicationDate}`);
      if (r.pubYear) lines.push(`**Year:** ${r.pubYear}`);
      if (r.pmid) lines.push(`**PMID:** ${r.pmid}`);
      if (r.pmcId) lines.push(`**PMCID:** ${r.pmcId}`);
      if (r.doi) lines.push(`**DOI:** ${r.doi}`);
      if (r.isOpenAccess !== undefined) {
        lines.push(`**Open Access:** ${r.isOpenAccess ? 'yes' : 'no'}`);
      }
      if (r.hasFullTextXml !== undefined) {
        lines.push(`**Full-text XML in EPMC:** ${r.hasFullTextXml ? 'yes' : 'no'}`);
      }
      if (typeof r.citedByCount === 'number') lines.push(`**Cited by:** ${r.citedByCount}`);
      lines.push(`**URL:** ${r.epmcUrl}`);
      if (r.abstract) lines.push(`\n#### Abstract\n${r.abstract}`);
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});

/** A record address as the notices and `content[]` render it: `SOURCE/epmcId`. */
function formatPair(pair: { epmcId: string; source: string }): string {
  return `${pair.source}/${pair.epmcId}`;
}

/**
 * Compose the recovery notice for a response the whole-response budget bounded.
 * Names what was spent, which pairs are still retrievable, and the ceiling the
 * next call has to clear — so a caller reading only `content[]` can resume
 * without inspecting `deferred`. (#188)
 */
function buildDeferralNotice(deferred: z.infer<typeof DeferredSchema>): string {
  const spent =
    deferred.returnedCharacters === 0
      ? `The first record alone exceeds the requested maxResponseCharacters of ${deferred.maxResponseCharacters}, so none were returned.`
      : `Response character budget reached: ${deferred.returnedCharacters} of ${deferred.maxResponseCharacters} characters returned.`;
  return `${spent} ${deferred.deferredCount} resolved record(s) were deferred whole: ${deferred.records.map(formatPair).join(', ')}. Re-call pubmed_europepmc_fetch with those pairs as \`records\` to retrieve them, or raise maxResponseCharacters to at least ${deferred.nextDeferredCharacters} — the size of the next deferred record.`;
}
