/**
 * @fileoverview Citation-metrics tool over NIH iCite: the Relative Citation
 * Ratio, NIH percentile, citation counts and rates, and translation scores for
 * a batch of PMIDs, one iCite request per call. PMIDs past the per-call limit
 * come back unfetched in `overLimit`; PMIDs iCite has no record for come back in
 * `unavailablePmids`, never as an error.
 * @module src/mcp-server/tools/definitions/fetch-citation-metrics.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { ICITE_SERVICE_ERRORS } from '@/services/error-contracts.js';
import { getIciteService } from '@/services/icite/icite-service.js';
import { ICITE_MAX_PMID, type IciteRecord } from '@/services/icite/types.js';
import { toDisplayText } from '@/services/ncbi/parsing/text-helpers.js';
import {
  conceptMeta,
  EDAM_DATA_RETRIEVAL,
  EDAM_PUBMED_ID,
  SCHEMA_SCHOLARLY_ARTICLE,
} from './_concepts.js';
import { normalizePmid, pmidStringSchema } from './_schemas.js';
import { escapeMarkdownInParagraph } from './_text.js';

/** Distinct PMIDs one call fetches; the rest are returned unfetched in `overLimit`. */
const FETCH_LIMIT = 200;

/** PMIDs one call may name. */
const MAX_PMIDS = 1000;

const ICITE_URL = 'https://icite.od.nih.gov/';

const MetricsRecordSchema = z
  .object({
    pmid: z.string().describe('PubMed ID, without leading zeros.'),
    title: z
      .string()
      .optional()
      .describe(
        'Article title as display-ready plain text — markup stripped and HTML entities decoded. Absent when iCite carries none.',
      ),
    year: z
      .number()
      .optional()
      .describe(
        "iCite's publication year: the year of the published version, which can differ from PubMed's publication date.",
      ),
    journal: z.string().optional().describe('Journal abbreviation as iCite reports it.'),
    doi: z.string().optional().describe('DOI when iCite carries one.'),
    isResearchArticle: z
      .boolean()
      .optional()
      .describe(
        'Whether iCite classes the record as a primary research article; reviews, editorials, letters, and errata are not.',
      ),
    isClinical: z
      .boolean()
      .optional()
      .describe('Whether iCite classes the article as clinical research.'),
    relativeCitationRatio: z
      .number()
      .optional()
      .describe(
        "Relative Citation Ratio (RCR): the article's citations per year divided by the citations per year expected for its field, benchmarked so the median NIH-funded paper of the same year scores 1.0. Absent when iCite computes none — papers too recent to benchmark, and some older records.",
      ),
    rcrProvisional: z
      .boolean()
      .optional()
      .describe(
        'True when iCite marks the RCR provisional: a recent paper whose RCR can change as citations accrue. Present only beside `relativeCitationRatio`.',
      ),
    nihPercentile: z
      .number()
      .optional()
      .describe(
        "Percentile (0–100) of the article's RCR among NIH-funded papers. Absent when iCite reports none, as for papers before 1980 and for most-recent-year provisional RCRs.",
      ),
    citationCount: z
      .number()
      .optional()
      .describe(
        'Citations iCite counts for the article. Absent when the record is not yet scored.',
      ),
    citationsPerYear: z
      .number()
      .optional()
      .describe('Citations per year since publication, the numerator of the RCR.'),
    expectedCitationsPerYear: z
      .number()
      .optional()
      .describe(
        "Citations per year expected for an article in this one's field and year, the denominator of the RCR.",
      ),
    fieldCitationRate: z
      .number()
      .optional()
      .describe(
        "Citation rate of the article's co-citation network — the field benchmark the expected rate is derived from.",
      ),
    apt: z
      .number()
      .optional()
      .describe(
        "Approximate Potential to Translate: iCite's estimate of the likelihood that a clinical article will cite this one, reported as 0.05, 0.25, 0.75, or 0.95.",
      ),
    human: z
      .number()
      .optional()
      .describe("Share (0–1) of the article's MeSH terms in the Human category."),
    animal: z
      .number()
      .optional()
      .describe("Share (0–1) of the article's MeSH terms in the Animal category."),
    molecularCellular: z
      .number()
      .optional()
      .describe("Share (0–1) of the article's MeSH terms in the Molecular/Cellular category."),
    citedByClinicalArticle: z
      .boolean()
      .optional()
      .describe('Whether at least one clinical article cites this one.'),
    clinicalCitationCount: z
      .number()
      .optional()
      .describe(
        'Clinical articles citing this one: 0 when `citedByClinicalArticle` is false, absent when that flag is.',
      ),
  })
  .describe('NIH iCite citation metrics for one PubMed article');

const OverLimitSchema = z
  .object({
    limit: z
      .number()
      .describe(
        'Distinct PMIDs one call fetches. The first this many, in request order, were fetched; the PMIDs below were not.',
      ),
    pmids: z
      .array(z.string())
      .describe(
        'PMIDs past the per-call limit, none of them fetched, in request order — each listed once, under the first spelling sent. Re-call `pubmed_fetch_citation_metrics` with these as `pmids`, at most `limit` per call.',
      ),
  })
  .describe(
    'PMIDs the call named past the per-call fetch limit. Present only when the call named more distinct PMIDs than one call fetches.',
  );

type MetricsRecord = z.infer<typeof MetricsRecordSchema>;

export const fetchCitationMetricsTool = tool('pubmed_fetch_citation_metrics', {
  description: `Fetch NIH iCite citation metrics for PubMed articles: the Relative Citation Ratio (RCR), NIH percentile, citation count, citations per year, expected and field citation rates, the Approximate Potential to Translate (APT), the human, animal, and molecular/cellular shares of each article's MeSH terms, and how many clinical articles cite it. RCR is a field- and year-normalized citation rate benchmarked to NIH-funded papers, whose median RCR is 1.0; iCite computes none for the most recent papers and marks recent ones provisional. iCite does not flag retractions — a retracted article keeps its metrics — so check pubmed_fetch_articles for retraction notices before relying on a record. Up to ${MAX_PMIDS} PMIDs per call; the first ${FETCH_LIMIT} distinct PMIDs are fetched and the rest returned in \`overLimit\`. PMIDs iCite has no record for are listed in \`unavailablePmids\`.`,
  annotations: { readOnlyHint: true, openWorldHint: true },
  _meta: conceptMeta([SCHEMA_SCHOLARLY_ARTICLE, EDAM_DATA_RETRIEVAL, EDAM_PUBMED_ID]),
  sourceUrl:
    'https://github.com/cyanheads/pubmed-mcp-server/blob/main/src/mcp-server/tools/definitions/fetch-citation-metrics.tool.ts',

  errors: [...ICITE_SERVICE_ERRORS] as const,

  // Never advertised; rewritten to the canonical key before the schema parses.
  inputAliases: { ids: 'pmids' },

  input: z.object({
    pmids: z
      .array(pmidStringSchema)
      .min(1)
      .max(MAX_PMIDS)
      .describe(
        `PubMed IDs to look up (e.g. ["23456789"]). The first ${FETCH_LIMIT} distinct PMIDs are fetched; the rest are returned in \`overLimit\`. Leading zeros are ignored, so "00023456789" and "23456789" name one article.`,
      ),
  }),

  output: z.object({
    records: z
      .array(MetricsRecordSchema)
      .describe('One record per fetched PMID iCite knows, in request order.'),
    unavailablePmids: z
      .array(z.string())
      .optional()
      .describe(
        'Requested PMIDs within the per-call limit that NIH iCite has no record for, in request order, under the spelling sent. iCite omits a PMID it has no record for without an error, so the absence says nothing about whether PubMed has the article; pubmed_fetch_articles confirms that.',
      ),
    overLimit: OverLimitSchema.optional(),
  }),

  enrichment: {
    notice: z
      .string()
      .optional()
      .describe(
        'Names the PMIDs iCite had no record for, records not yet scored, records with no RCR or a provisional one, and PMIDs past the per-call limit with how to fetch them. Absent when every record came back final and complete.',
      ),
  },

  async handler(input, ctx) {
    ctx.log.info('Executing pubmed_fetch_citation_metrics', { pmidCount: input.pmids.length });

    const { fetched, overLimit } = splitAtFetchLimit(input.pmids);
    // `0` and out-of-range values are never sent: iCite reads a list holding no
    // PMID it accepts as a request for its first 1,000 records. They are misses.
    const sendable = fetched.map((entry) => entry.pmid).filter(isIcitePmid);
    const found = sendable.length > 0 ? await getIciteService().fetchRecords(sendable, ctx) : [];

    // iCite answers in lexicographic PMID order; the response follows the request.
    const byPmid = new Map(found.map((record) => [record.pmid, record]));
    const records: MetricsRecord[] = [];
    const unavailable: string[] = [];
    for (const { pmid, sent } of fetched) {
      const record = byPmid.get(pmid);
      if (record) records.push(toOutputRecord(record));
      else unavailable.push(sent);
    }

    ctx.log.info('pubmed_fetch_citation_metrics completed', {
      requested: input.pmids.length,
      sent: sendable.length,
      returned: records.length,
      unavailable: unavailable.length,
      overLimit: overLimit.length,
    });

    const notice = buildNotice(records, unavailable, fetched.length, overLimit);
    if (notice) ctx.enrich.notice(notice);

    return {
      records,
      ...(unavailable.length > 0 && { unavailablePmids: unavailable }),
      ...(overLimit.length > 0 && { overLimit: { limit: FETCH_LIMIT, pmids: overLimit } }),
    };
  },

  format: (result) => {
    const lines = [
      '## NIH iCite Citation Metrics',
      `Source: [NIH iCite](${ICITE_URL})`,
      `**Records:** ${result.records.length}`,
    ];
    if (result.unavailablePmids?.length) {
      lines.push(`**Unavailable PMIDs:** ${result.unavailablePmids.join(', ')}`);
    }
    if (result.overLimit) {
      const o = result.overLimit;
      lines.push(
        `**Over the per-call limit:** ${o.pmids.length} PMID(s) not fetched — a call fetches the first ${o.limit} distinct PMIDs`,
        `Re-call \`pubmed_fetch_citation_metrics\` with these PMIDs: ${o.pmids.join(', ')}`,
      );
    }
    for (const r of result.records) lines.push('', ...recordLines(r));
    return [{ type: 'text', text: lines.join('\n') }];
  },
});

/**
 * Distinct PMIDs in request order — keyed on the canonical form, so
 * `00023456789` and `23456789` are one — split at {@link FETCH_LIMIT}. Each
 * keeps the first spelling sent, which is what a miss or an over-limit entry
 * reports back.
 */
function splitAtFetchLimit(pmids: readonly string[]): {
  fetched: { pmid: string; sent: string }[];
  overLimit: string[];
} {
  const fetched: { pmid: string; sent: string }[] = [];
  const overLimit: string[] = [];
  const seen = new Set<string>();
  for (const sent of pmids) {
    const pmid = normalizePmid(sent);
    if (seen.has(pmid)) continue;
    seen.add(pmid);
    if (fetched.length < FETCH_LIMIT) fetched.push({ pmid, sent });
    else overLimit.push(sent);
  }
  return { fetched, overLimit };
}

/** A canonical PMID iCite reads as one: not `0`, and no larger than {@link ICITE_MAX_PMID}. */
function isIcitePmid(pmid: string): boolean {
  return pmid !== '0' && Number(pmid) <= ICITE_MAX_PMID;
}

/** The service record with its title and journal made display-ready. */
function toOutputRecord(record: IciteRecord): MetricsRecord {
  const { title: rawTitle, journal: rawJournal, ...rest } = record;
  const title = rawTitle ? toDisplayText(rawTitle) : '';
  const journal = rawJournal ? toDisplayText(rawJournal) : '';
  return {
    ...rest,
    ...(title && { title }),
    ...(journal && { journal }),
  };
}

/**
 * The one notice a call carries: misses, records not yet scored, records with
 * no RCR or a provisional one, and the over-limit remainder — each part only
 * when it applies.
 */
function buildNotice(
  records: readonly MetricsRecord[],
  unavailable: readonly string[],
  fetchedCount: number,
  overLimit: readonly string[],
): string | undefined {
  const parts: string[] = [];
  if (unavailable.length > 0) {
    // `0` and out-of-range values count here though they are never sent, so
    // the denominator is the requested PMIDs within the limit, not those fetched.
    const within =
      overLimit.length > 0
        ? `the first ${fetchedCount} distinct requested PMIDs`
        : `${fetchedCount} distinct requested PMIDs`;
    const which =
      records.length === 0
        ? overLimit.length > 0
          ? `any of ${within}`
          : 'any of the requested PMIDs'
        : `${unavailable.length} of ${within}`;
    parts.push(
      `NIH iCite has no record for ${which}: ${unavailable.join(', ')}. iCite omits a PMID it has no record for without an error, so this does not say whether PubMed has the article; pubmed_fetch_articles confirms that.`,
    );
  }
  const unscored = records.filter((r) => r.citationCount === undefined).map((r) => r.pmid);
  if (unscored.length > 0) {
    parts.push(`Not yet scored by iCite — no citation count or RCR: ${unscored.join(', ')}.`);
  }
  const noRcr = records
    .filter((r) => r.citationCount !== undefined && r.relativeCitationRatio === undefined)
    .map((r) => r.pmid);
  if (noRcr.length > 0) {
    parts.push(
      `No RCR: ${noRcr.join(', ')} — iCite computes none for papers too recent to benchmark and for some older records.`,
    );
  }
  const provisional = records.filter((r) => r.rcrProvisional === true).map((r) => r.pmid);
  if (provisional.length > 0) {
    parts.push(
      `Provisional RCR: ${provisional.join(', ')} — recent papers whose RCR can change as citations accrue.`,
    );
  }
  if (overLimit.length > 0) {
    parts.push(
      `This call fetched the first ${FETCH_LIMIT} distinct PMIDs; ${overLimit.length} more ${overLimit.length === 1 ? 'was' : 'were'} not fetched: ${overLimit.join(', ')}. Re-call pubmed_fetch_citation_metrics with those PMIDs, at most ${FETCH_LIMIT} per call, to retrieve them.`,
    );
  }
  return parts.length > 0 ? parts.join(' ') : undefined;
}

const NOT_AVAILABLE = 'Not available';

const shown = (value: number | undefined): string =>
  value === undefined ? NOT_AVAILABLE : String(value);
const yesNo = (value: boolean | undefined): string =>
  value === undefined ? NOT_AVAILABLE : value ? 'Yes' : 'No';
/** A record's lines form one paragraph, so its upstream strings take the paragraph escape. (#261) */
const escaped = (value: string | undefined): string =>
  value === undefined ? NOT_AVAILABLE : escapeMarkdownInParagraph(value);

/** The `content[]` block for one record: every field, `Not available` where iCite has none. */
function recordLines(r: MetricsRecord): string[] {
  const rcr =
    r.relativeCitationRatio === undefined
      ? `**Relative Citation Ratio:** ${NOT_AVAILABLE}`
      : `**Relative Citation Ratio:** ${r.relativeCitationRatio} | **RCR provisional:** ${yesNo(r.rcrProvisional)}`;
  return [
    `### PMID ${r.pmid}`,
    `**Title:** ${escaped(r.title)}`,
    `**Year:** ${shown(r.year)} | **Journal:** ${escaped(r.journal)} | **DOI:** ${escaped(r.doi)}`,
    `**Research article:** ${yesNo(r.isResearchArticle)} | **Clinical:** ${yesNo(r.isClinical)}`,
    `${rcr} | **NIH percentile:** ${shown(r.nihPercentile)}`,
    `**Citations:** ${shown(r.citationCount)} | **Citations per year:** ${shown(r.citationsPerYear)} | **Expected citations per year:** ${shown(r.expectedCitationsPerYear)} | **Field citation rate:** ${shown(r.fieldCitationRate)}`,
    `**APT:** ${shown(r.apt)} | **Human:** ${shown(r.human)} | **Animal:** ${shown(r.animal)} | **Molecular/cellular:** ${shown(r.molecularCellular)}`,
    `**Cited by a clinical article:** ${yesNo(r.citedByClinicalArticle)} | **Clinical citations:** ${shown(r.clinicalCitationCount)}`,
  ];
}
