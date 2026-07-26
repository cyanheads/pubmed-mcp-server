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
import {
  conceptMeta,
  EDAM_ACCESSION,
  EDAM_DATA_RETRIEVAL,
  SCHEMA_SCHOLARLY_ARTICLE,
} from './_concepts.js';

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
    title: z.string().optional().describe('Record title'),
    authors: z.string().optional().describe('Formatted author string'),
    journal: z.string().optional().describe('Journal title'),
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

// ─── Tool Definition ─────────────────────────────────────────────────────────

export const pubmedEuropepmcFetchTool = tool('pubmed_europepmc_fetch', {
  description:
    "Fetch complete Europe PMC records — including the full, untruncated abstract — for records addressed by `source` plus `epmcId`. Pairs with `pubmed_europepmc_search`, which returns bounded `abstractSnippet` values and flags cut ones with `abstractTruncated: true`; pass those hits' `source` and `epmcId` here to read the whole abstract. This is the retrieval path for preprint (`PPR`), patent (`PAT`), and Agricola (`AGR`) records, which frequently carry no PMID and no DOI, so `pubmed_fetch_articles` and `pubmed_fetch_fulltext` cannot address them. Up to 25 records per call.",
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
  }),

  output: z.object({
    records: z
      .array(FetchedRecordSchema)
      .describe('Resolved records, in the order Europe PMC returned them'),
    notFound: z
      .array(RecordRefSchema)
      .optional()
      .describe('Requested `source` + `epmcId` pairs Europe PMC returned no record for'),
  }),

  // Recovery guidance when some or all requested pairs resolve to nothing —
  // agent-facing context, surfaced to structuredContent and content[] alike.
  enrichment: {
    notice: z
      .string()
      .optional()
      .describe(
        'Guidance when one or more requested records could not be resolved. Absent when every record came back.',
      ),
  },

  async handler(input, ctx) {
    ctx.log.info('Executing pubmed_europepmc_fetch', { recordCount: input.records.length });
    const epmc = getEuropePmcService();
    if (!epmc) {
      throw ctx.fail(
        'europepmc_disabled',
        'Europe PMC service is not available. Set EUROPEPMC_ENABLED=true to use this tool.',
        { ...ctx.recoveryFor('europepmc_disabled') },
      );
    }

    const hits = await epmc.fetchRecords(input.records, ctx.signal);

    const records = hits.map((h) => {
      // EPMC returns abstractText as a raw JSON string carrying JATS/HTML markup,
      // un-decoded entities, and soft hyphens (no XML parser runs on it). The
      // cleanup mirrors pubmed_europepmc_search; only the truncation is dropped.
      const abstract = h.abstractText ? toDisplayText(h.abstractText) : '';
      return {
        source: h.source as (typeof EUROPEPMC_ALL_SOURCES)[number],
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
    for (const r of records) {
      resolved.add(refKey(r.source, r.epmcId));
      // A `PMC` request for a PubMed-indexed article resolves to that article's
      // canonical `MED` record, which reports the requested PMCID in `pmcId`
      // instead of as its own id. Without this alias the record comes back in
      // `records` and is reported missing in the same response.
      if (r.pmcId) resolved.add(refKey('PMC', r.pmcId));
    }
    const notFound = input.records.filter((ref) => !resolved.has(refKey(ref.source, ref.epmcId)));

    ctx.log.info('pubmed_europepmc_fetch completed', {
      requested: input.records.length,
      returned: records.length,
    });

    // An unresolved id shaped like a PMCID is reachable by another route:
    // pubmed_fetch_fulltext addresses PMCIDs directly, with no `source` pair.
    const pmcidHint = notFound.some((r) => PMCID_SHAPED_RE.test(r.epmcId))
      ? ' An id shaped like a PMCID also resolves through pubmed_fetch_fulltext, whose `pmcids` input takes it on its own.'
      : '';

    if (records.length === 0) {
      ctx.enrich.notice(
        `Europe PMC returned no record for any requested pair. Both fields must be copied verbatim from a pubmed_europepmc_search hit — \`epmcId\` is Europe PMC's own id (the PMID only for \`source: "MED"\`), and it must be paired with the same hit's \`source\`.${pmcidHint}`,
      );
    } else if (notFound.length > 0) {
      ctx.enrich.notice(
        `Europe PMC returned no record for ${notFound.length} of ${input.records.length} requested pairs: ${notFound
          .map((r) => `${r.source}/${r.epmcId}`)
          .join(
            ', ',
          )}. Verify each against its pubmed_europepmc_search hit — a mismatched \`source\` is the usual cause.${pmcidHint}`,
      );
    }

    return {
      records,
      ...(notFound.length > 0 && { notFound }),
    };
  },

  format: (result) => {
    const lines = ['## Europe PMC Records', `**Returned:** ${result.records.length}`];

    if (result.notFound?.length) {
      lines.push(
        `**Not found:** ${result.notFound.map((r) => `${r.source}/${r.epmcId}`).join(', ')}`,
      );
    }

    for (const r of result.records) {
      lines.push(`\n### ${r.title ?? r.epmcId}`);
      lines.push(`**Source:** ${r.source} | **EPMC ID:** ${r.epmcId}`);
      if (r.authors) lines.push(`**Authors:** ${r.authors}`);
      if (r.journal) lines.push(`**Journal:** ${r.journal}`);
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
