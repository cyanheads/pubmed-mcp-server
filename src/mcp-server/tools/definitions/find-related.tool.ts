/**
 * @fileoverview PubMed related articles tool — finds articles related to a
 * source article via a provider chain: NCBI ELink (primary) → Europe PMC →
 * OpenAlex. First success wins; results are never merged across sources.
 * Supports offset pagination on the returned window. A served empty answer is a
 * success; only a chain where every eligible provider failed is an error.
 * @module src/mcp-server/tools/definitions/find-related.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { configurationError, JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import {
  EUROPEPMC_SERVICE_ERRORS,
  NCBI_SERVICE_ERRORS,
  OPENALEX_SERVICE_ERRORS,
} from '@/services/error-contracts.js';
import { getEuropePmcService } from '@/services/europe-pmc/europe-pmc-service.js';
import { getNcbiService } from '@/services/ncbi/ncbi-service.js';
import { extractBriefSummaries } from '@/services/ncbi/parsing/esummary-parser.js';
import { ensureArray } from '@/services/ncbi/parsing/xml-helpers.js';
import type { ParsedBriefSummary } from '@/services/ncbi/types.js';
import { getOpenAlexServiceOptional } from '@/services/openalex/openalex-service.js';
import { conceptMeta, EDAM_DATA_RETRIEVAL, SCHEMA_SCHOLARLY_ARTICLE } from './_concepts.js';
import { pmidStringSchema } from './_schemas.js';
import { escapeMarkdownInline } from './_text.js';

// ─── ELink XML types ─────────────────────────────────────────────────────────

interface XmlELinkItem {
  Id: string | number | { '#text'?: string | number };
}

interface ELinkLinkSetDb {
  Link?: XmlELinkItem | XmlELinkItem[];
  LinkName?: string;
}

interface ELinkResultItem {
  LinkSet?: { LinkSetDb?: ELinkLinkSetDb | ELinkLinkSetDb[] };
}

interface ELinkResponse {
  eLinkResult?: ELinkResultItem | ELinkResultItem[];
}

function extractValue(field: string | number | { '#text'?: string | number } | undefined): string {
  if (field === undefined || field === null) return '';
  if (typeof field === 'object') return field['#text'] !== undefined ? String(field['#text']) : '';
  return String(field);
}

// ─── Provider result type ─────────────────────────────────────────────────────

type ProviderName = 'ncbi' | 'europepmc' | 'openalex';

/** Human-facing provider names for notices and recovery hints. */
const PROVIDER_LABELS: Record<ProviderName, string> = {
  ncbi: 'NCBI',
  europepmc: 'Europe PMC',
  openalex: 'OpenAlex',
};

/** A provider the server never reached because configuration turned it off. */
const PROVIDER_DISABLED = 'provider_disabled';
/** A provider failure that carried no declared service-contract reason. */
const UNCLASSIFIED_ERROR = 'unclassified_error';

/**
 * Common result shape returned by each provider.
 * `allPmids` is indexed from 0 in PMID-addressable rows, so `offset` slices it
 * directly whichever provider served it.
 */
interface ProviderResult {
  allPmids: string[];
  /** Upstream rows in the served page that carry no PubMed PMID (Europe PMC). */
  droppedNoPmid?: number;
  /** Europe PMC paging stopped at its page cap before the window was covered. */
  reachCapped?: boolean;
  source: ProviderName;
  totalCount: number;
}

/** One provider's outcome in the chain, reported when every attempt failed. */
interface ProviderAttempt {
  message: string;
  provider: ProviderName;
  reason: string;
}

// ─── NCBI provider ────────────────────────────────────────────────────────────

async function ncbiProvider(
  pmid: string,
  relationship: 'similar' | 'cited_by' | 'references',
  signal: AbortSignal,
): Promise<ProviderResult> {
  const ncbi = getNcbiService();
  const linkName =
    relationship === 'cited_by'
      ? 'pubmed_pubmed_citedin'
      : relationship === 'references'
        ? 'pubmed_pubmed_refs'
        : 'pubmed_pubmed';

  const eLinkResult = (await ncbi.eLink(
    {
      dbfrom: 'pubmed',
      db: 'pubmed',
      id: pmid,
      cmd: 'neighbor',
      linkname: linkName,
      retmode: 'xml',
    },
    { signal },
  )) as ELinkResponse;

  const eLinkResultsArray = ensureArray(eLinkResult?.eLinkResult);
  const firstResult = eLinkResultsArray[0] as ELinkResultItem | undefined;
  const linkSet = firstResult?.LinkSet;
  let foundPmids: string[] = [];

  if (linkSet?.LinkSetDb) {
    const linkSetDbArray = ensureArray(linkSet.LinkSetDb);
    const targetDb = linkSetDbArray.find((db) => db.LinkName === linkName) ?? linkSetDbArray[0];

    if (targetDb?.Link) {
      foundPmids = ensureArray(targetDb.Link)
        .map((link: XmlELinkItem) => extractValue(link.Id))
        .filter((p) => p && p !== pmid && p !== '0');
    }
  }

  return { allPmids: foundPmids, totalCount: foundPmids.length, source: 'ncbi' };
}

// ─── Europe PMC provider ──────────────────────────────────────────────────────

/**
 * Europe PMC supports citations and references for MED-source records.
 * It has no `similar` equivalent, so we skip it for that relationship.
 */
function epmcSupports(relationship: 'similar' | 'cited_by' | 'references'): boolean {
  return relationship === 'cited_by' || relationship === 'references';
}

/** Europe PMC's per-request row ceiling — 1001 is rejected with an `errMsg`. */
const EPMC_MAX_PAGE_SIZE = 1000;
/** Upper bound on Europe PMC pages pulled for one request. */
const EPMC_MAX_PAGES = 10;

/**
 * Fetch enough Europe PMC pages to cover [offset, offset+maxResults) in
 * PMID-addressable rows. Europe PMC pages count every upstream record, but
 * non-MED rows carry no PubMed PMID and are dropped, so a single page sized on
 * the raw window can under-fill it. Pages share one size (the endpoint pages by
 * number, so the size must stay constant) and are pulled until the filtered
 * array reaches the window, upstream runs out, or `EPMC_MAX_PAGES` is hit.
 */
async function epmcProvider(
  pmid: string,
  relationship: 'cited_by' | 'references',
  offset: number,
  maxResults: number,
  signal: AbortSignal,
): Promise<ProviderResult> {
  const epmc = getEuropePmcService();
  if (!epmc) {
    throw configurationError('Europe PMC is turned off by server configuration.', {
      reason: PROVIDER_DISABLED,
      provider: 'europepmc',
    });
  }

  const needed = offset + maxResults;
  const pageSize = Math.min(needed, EPMC_MAX_PAGE_SIZE);
  const allPmids: string[] = [];
  let droppedNoPmid = 0;
  let hitCount = 0;
  let exhausted = false;
  for (let page = 1; page <= EPMC_MAX_PAGES && allPmids.length < needed; page++) {
    const result =
      relationship === 'cited_by'
        ? await epmc.citations(pmid, pageSize, page, signal)
        : await epmc.references(pmid, pageSize, page, signal);
    allPmids.push(...result.pmids);
    droppedNoPmid += result.droppedNoPmid;
    hitCount = result.hitCount;
    const served = result.pmids.length + result.droppedNoPmid;
    if (served < pageSize || page * pageSize >= hitCount) {
      exhausted = true;
      break;
    }
  }

  return {
    allPmids,
    // Exhausting upstream makes the addressable count exact; otherwise only
    // Europe PMC's own total is known.
    totalCount: exhausted ? allPmids.length : hitCount,
    source: 'europepmc',
    droppedNoPmid,
    reachCapped: !exhausted && allPmids.length < needed,
  };
}

// ─── OpenAlex provider ────────────────────────────────────────────────────────

async function openAlexProvider(
  pmid: string,
  relationship: 'similar' | 'cited_by' | 'references',
  maxNeeded: number,
  signal: AbortSignal,
): Promise<ProviderResult> {
  const oa = getOpenAlexServiceOptional();
  if (!oa) {
    throw configurationError('OpenAlex is not configured on this server.', {
      reason: PROVIDER_DISABLED,
      provider: 'openalex',
    });
  }

  let result: { pmids: string[]; totalCount: number };
  switch (relationship) {
    case 'similar':
      result = await oa.similar(pmid, maxNeeded, signal);
      break;
    case 'cited_by':
      result = await oa.citedBy(pmid, maxNeeded, signal);
      break;
    case 'references':
      result = await oa.references(pmid, maxNeeded, signal);
      break;
  }

  return { allPmids: result.pmids, totalCount: result.totalCount, source: 'openalex' };
}

/** Compact, log-safe description of an unknown thrown value. */
function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Record a provider failure with the declared service-contract reason it
 * carries, so the aggregate error names each origin's own failure mode instead
 * of collapsing the chain into one opaque message.
 */
function attemptFrom(provider: ProviderName, err: unknown): ProviderAttempt {
  const reason =
    err instanceof McpError
      ? ((err.data as { reason?: string } | undefined)?.reason ?? UNCLASSIFIED_ERROR)
      : UNCLASSIFIED_ERROR;
  return { provider, reason, message: describeError(err) };
}

/**
 * Recovery hint for a fully failed chain. Names only the providers actually
 * attempted and their observed outcomes — never another origin's health — and
 * separates a configuration-disabled provider, which no retry brings back, from
 * the transient failures worth retrying.
 */
function allProvidersFailedHint(attempts: readonly ProviderAttempt[]): string {
  const summary = attempts.map((a) => `${PROVIDER_LABELS[a.provider]} (${a.reason})`).join(', ');
  const disabled = attempts
    .filter((a) => a.reason === PROVIDER_DISABLED)
    .map((a) => PROVIDER_LABELS[a.provider]);
  const disabledClause = disabled.length
    ? ` ${disabled.join(' and ')} ${disabled.length > 1 ? 'are' : 'is'} turned off by server configuration and will not recover on retry.`
    : '';
  return `Providers attempted: ${summary}. Retry the transient failures after a brief delay.${disabledClause}`;
}

// ─── Tool Definition ─────────────────────────────────────────────────────────

export const findRelatedTool = tool('pubmed_find_related', {
  description:
    'Find articles related to a source article — similar content (similar), articles citing this one (cited_by), or articles this one cites (references). Uses NCBI ELink as the primary source; falls back to Europe PMC then OpenAlex when NCBI is unavailable.',
  annotations: { readOnlyHint: true, openWorldHint: true },
  _meta: conceptMeta([SCHEMA_SCHOLARLY_ARTICLE, EDAM_DATA_RETRIEVAL]),
  sourceUrl:
    'https://github.com/cyanheads/pubmed-mcp-server/blob/main/src/mcp-server/tools/definitions/find-related.tool.ts',

  errors: [
    ...NCBI_SERVICE_ERRORS,
    ...EUROPEPMC_SERVICE_ERRORS,
    ...OPENALEX_SERVICE_ERRORS,
    {
      reason: 'all_providers_failed',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'Every provider eligible for the requested relationship failed; none answered.',
      recovery:
        'Read data.attempted for each provider outcome, then retry the transient failures after a brief delay; an entry marked provider_disabled is turned off by server configuration and will not recover.',
      retryable: true,
    },
  ] as const,

  input: z.object({
    pmid: pmidStringSchema.describe('Source PubMed ID'),
    relationship: z
      .enum(['similar', 'cited_by', 'references'])
      .default('similar')
      .describe(
        'Relationship type: similar (content-based), cited_by (articles citing this one), references (articles this one cites)',
      ),
    maxResults: z.number().int().min(1).max(50).default(10).describe('Maximum related articles'),
    offset: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe(
        'Result offset for pagination (0-based); page through results by incrementing by maxResults',
      ),
  }),

  output: z.object({
    sourcePmid: z.string().describe('Source PubMed ID'),
    relationship: z.enum(['similar', 'cited_by', 'references']).describe('Relationship type used'),
    offset: z.number().describe('Result offset used'),
    articles: z
      .array(
        z
          .object({
            pmid: z.string().describe('PubMed ID'),
            title: z.string().optional().describe('Article title'),
            authors: z.string().optional().describe('Author string'),
            source: z.string().optional().describe('Journal source'),
            pubDate: z.string().optional().describe('Publication date'),
          })
          .describe('Related article with enriched summary'),
      )
      .describe('Related articles'),
  }),

  // Result-set context the agent reasons with — pre-truncation match count,
  // the answering provider, and recovery guidance. Surfaced via ctx.enrich(...)
  // to structuredContent and content[]; kept out of the domain return.
  enrichment: {
    totalCount: z
      .number()
      .describe(
        'Total related articles found before windowing. A Europe PMC total may shrink to the PubMed-addressable count once a request window covers the whole upstream set, since rows without a PubMed PMID cannot be returned.',
      ),
    source: z
      .enum(['ncbi', 'europepmc', 'openalex'])
      .describe('Provider that answered this request'),
    notice: z
      .string()
      .optional()
      .describe(
        'Guidance when results are empty, a fallback provider answered, offset overshot, or Europe PMC rows were excluded for carrying no PubMed PMID. Absent on a clean NCBI result page.',
      ),
  },

  enrichmentTrailer: {
    totalCount: { label: 'Total Found' },
    source: { label: 'Source' },
  },

  async handler(input, ctx) {
    const ncbi = getNcbiService();
    ctx.log.debug('Finding related articles', {
      pmid: input.pmid,
      relationship: input.relationship,
      offset: input.offset,
    });

    // ── Provider chain ──────────────────────────────────────────────────────
    // Try NCBI first; on failure fall back to Europe PMC then OpenAlex (first
    // success wins, never merged). A non-PMC `references` source returns an empty
    // NCBI set rather than throwing — that structural fallback is handled below.

    let providerResult: ProviderResult | null = null;
    // Europe PMC's served-but-empty answer, held so a later OpenAlex failure
    // falls back to it: an answer of zero is still an answer, not an outage.
    let epmcEmpty: ProviderResult | null = null;
    // Every provider the chain actually reached, with its outcome. Structurally
    // ineligible providers (Europe PMC for `similar`) and unconfigured ones are
    // never attempted, so they never appear here.
    const attempts: ProviderAttempt[] = [];
    // Records WHY a non-primary provider answered, so the provenance notice can
    // distinguish an NCBI outage from references coverage for a non-PMC source.
    let fallbackKind: 'outage' | 'references_coverage' | undefined;

    // 1. NCBI (primary)
    try {
      providerResult = await ncbiProvider(input.pmid, input.relationship, ctx.signal);
    } catch (err) {
      ctx.log.warning('NCBI eLink failed, trying fallback providers', {
        pmid: input.pmid,
        err: describeError(err),
      });
      attempts.push(attemptFrom('ncbi', err));
    }

    // 2. Europe PMC (fallback for cited_by / references only). An empty EPMC
    //    result is not "served" — fall through to OpenAlex rather than return 0.
    if (providerResult === null && epmcSupports(input.relationship)) {
      try {
        const epmcResult = await epmcProvider(
          input.pmid,
          input.relationship as 'cited_by' | 'references',
          input.offset,
          input.maxResults,
          ctx.signal,
        );
        if (epmcResult.allPmids.length > 0) {
          providerResult = epmcResult;
          fallbackKind = 'outage';
        } else {
          epmcEmpty = epmcResult;
        }
      } catch (err) {
        ctx.log.warning('Europe PMC fallback failed, trying OpenAlex', {
          pmid: input.pmid,
          err: describeError(err),
        });
        attempts.push(attemptFrom('europepmc', err));
      }
    }

    // 3. OpenAlex (last resort for all relationships)
    if (providerResult === null) {
      try {
        providerResult = await openAlexProvider(
          input.pmid,
          input.relationship,
          input.offset + input.maxResults,
          ctx.signal,
        );
        fallbackKind = 'outage';
      } catch (err) {
        ctx.log.warning('OpenAlex fallback failed', {
          pmid: input.pmid,
          err: describeError(err),
        });
        attempts.push(attemptFrom('openalex', err));
      }
    }
    if (providerResult === null && epmcEmpty) {
      providerResult = epmcEmpty;
      fallbackKind = 'outage';
    }

    // ── Every eligible provider failed ────────────────────────────────────────
    // A request no source answered is a failure, not an empty result set: a
    // success-shaped payload here would invent a provenance and a count for an
    // answer nobody gave. A provider that genuinely answered with zero records
    // set `providerResult` above and never reaches this branch.
    if (providerResult === null) {
      throw ctx.fail(
        'all_providers_failed',
        `No provider could return ${input.relationship} for PMID ${input.pmid}.`,
        {
          sourcePmid: input.pmid,
          relationship: input.relationship,
          attempted: attempts,
          recovery: { hint: allProvidersFailedHint(attempts) },
        },
      );
    }

    // ── NCBI returned an empty set ──────────────────────────────────────────────
    // ELink returns an empty LinkSet for both invalid source PMIDs and valid PMIDs
    // with no neighbors; a single ESummary disambiguates and yields the PMCID. For
    // `references`, a valid non-PMC source has no NCBI reference list — Europe PMC
    // and OpenAlex serve references for any source, so try them before giving up.
    if (providerResult.source === 'ncbi' && providerResult.allPmids.length === 0) {
      let sourceSummary: ParsedBriefSummary | undefined;
      let sourceConfirmedMissing = false;
      try {
        const summaryResult = await ncbi.eSummary(
          { db: 'pubmed', id: input.pmid },
          { signal: ctx.signal },
        );
        const summaries = await extractBriefSummaries(summaryResult);
        sourceSummary = summaries[0];
        if (!sourceSummary?.title) sourceConfirmedMissing = true;
      } catch (err) {
        ctx.log.debug('Source PMID ESummary failed', { err });
        const reason =
          err instanceof McpError
            ? (err.data as { reason?: string } | undefined)?.reason
            : undefined;
        if (reason === 'ncbi_resource_not_found') sourceConfirmedMissing = true;
      }

      if (sourceConfirmedMissing) {
        ctx.enrich({ source: 'ncbi' });
        ctx.enrich.total(0);
        ctx.enrich.notice(
          `Source PMID ${input.pmid} not found in PubMed. Verify the ID with \`pubmed_fetch_articles\` or \`pubmed_search_articles\`.`,
        );
        return {
          sourcePmid: input.pmid,
          relationship: input.relationship,
          offset: input.offset,
          articles: [],
        };
      }

      // References coverage fallback — only for a confirmed-valid source. NCBI
      // resolves references only for PMC-indexed sources, so a valid non-PMC
      // source returns empty; Europe PMC then OpenAlex serve them. An unconfirmed
      // source (ESummary itself failed) stays silent — the empty set is most
      // likely a transient NCBI issue, not a real "no references".
      if (input.relationship === 'references' && sourceSummary?.title) {
        let refFallback: ProviderResult | null = null;
        const refAttempts: Array<() => Promise<ProviderResult>> = [
          () => epmcProvider(input.pmid, 'references', input.offset, input.maxResults, ctx.signal),
          () =>
            openAlexProvider(input.pmid, 'references', input.offset + input.maxResults, ctx.signal),
        ];
        for (const attempt of refAttempts) {
          try {
            const result = await attempt();
            if (result.allPmids.length > 0) {
              refFallback = result;
              break;
            }
          } catch (err) {
            ctx.log.warning('References fallback provider failed', { err: describeError(err) });
          }
        }

        if (refFallback) {
          providerResult = refFallback;
          fallbackKind = 'references_coverage';
        } else {
          ctx.enrich({ source: 'ncbi' });
          ctx.enrich.total(0);
          const sourcePmcId = sourceSummary.pmcId;
          ctx.enrich.notice(
            sourcePmcId
              ? `No reference list found for PMID ${input.pmid} (PMCID ${sourcePmcId}) via NCBI, Europe PMC, or OpenAlex.`
              : `No reference list available for PMID ${input.pmid} via NCBI, Europe PMC, or OpenAlex. Use pubmed_fetch_articles to inspect the article record, or try relationship: "similar" / "cited_by".`,
          );
          return {
            sourcePmid: input.pmid,
            relationship: input.relationship,
            offset: input.offset,
            articles: [],
          };
        }
      } else {
        // similar / cited_by empty for a valid source, or references with an
        // unconfirmed source — return the honest empty without a notice.
        ctx.enrich({ source: 'ncbi' });
        ctx.enrich.total(0);
        return {
          sourcePmid: input.pmid,
          relationship: input.relationship,
          offset: input.offset,
          articles: [],
        };
      }
    }

    // ── Window the result set + enrich ──────────────────────────────────────────
    const { allPmids, totalCount, source, droppedNoPmid = 0, reachCapped = false } = providerResult;
    ctx.enrich({ source });
    ctx.enrich.total(totalCount);

    // For NCBI the full neighbor set is in memory; for EPMC/OpenAlex the provider
    // pre-fetched enough PMID-addressable rows to cover the window.
    const window = allPmids.slice(input.offset, input.offset + input.maxResults);

    // Only the LAST ctx.enrich.notice survives, so collect the applicable
    // fragments (overshoot, provenance, enrichment-degraded) and emit them once.
    const notices: string[] = [];
    if (input.offset > 0 && input.offset >= totalCount) {
      notices.push(
        `Offset ${input.offset} exceeds totalCount (${totalCount}). Reset offset to 0 or reduce it below ${totalCount} to page through results.`,
      );
    }
    if (source !== 'ncbi') {
      const providerName = PROVIDER_LABELS[source];
      const detail =
        source === 'openalex'
          ? input.relationship === 'similar'
            ? 'related_works — OpenAlex similarity, not PubMed’s neighbor algorithm'
            : input.relationship === 'cited_by'
              ? 'cites: filter'
              : 'referenced_works'
          : `${input.relationship === 'cited_by' ? 'citations' : 'references'} index`;
      notices.push(
        fallbackKind === 'references_coverage'
          ? `NCBI has no PMC-indexed reference list for PMID ${input.pmid} — references served by ${providerName} (${detail}).`
          : `NCBI eLink unavailable — related articles served by ${providerName} (${detail}).`,
      );
    }
    // Europe PMC counts every upstream record, but only MED-source rows carry a
    // PubMed PMID. Disclose the gap so an empty or short window reads as an
    // excluded-rows effect rather than an exhausted result set.
    if (droppedNoPmid > 0) {
      notices.push(
        `Europe PMC served ${allPmids.length + droppedNoPmid} upstream rows for this request, ${droppedNoPmid} with no PubMed PMID (non-MED sources such as preprints); those rows cannot be returned here.`,
      );
    }

    // The page cap bounds how far into Europe PMC's set one request can reach.
    if (reachCapped) {
      notices.push(
        `Europe PMC paging stopped after ${EPMC_MAX_PAGES} pages (${allPmids.length} PubMed-addressable rows) without reaching offset ${input.offset}; lower the offset.`,
      );
    }

    if (window.length === 0) {
      if (notices.length > 0) ctx.enrich.notice(notices.join(' '));
      return {
        sourcePmid: input.pmid,
        relationship: input.relationship,
        offset: input.offset,
        articles: [],
      };
    }

    // Enrich the window with ESummary. When a fallback answered because NCBI is
    // down, eSummary hits the same host and may also fail — degrade to bare PMIDs
    // (the article metadata fields are all optional) rather than failing the whole
    // request, so the chain's resilience survives the enrichment step.
    try {
      const summaryResult = await ncbi.eSummary(
        { db: 'pubmed', id: window.join(',') },
        { signal: ctx.signal },
      );
      const briefSummaries = await extractBriefSummaries(summaryResult);
      const summaryMap = new Map(briefSummaries.map((bs) => [bs.pmid, bs]));
      const articles = window.map((pmid) => {
        const details = summaryMap.get(pmid);
        return {
          pmid,
          title: details?.title,
          authors: details?.authors,
          source: details?.source,
          pubDate: details?.pubDate,
        };
      });
      if (notices.length > 0) ctx.enrich.notice(notices.join(' '));
      return {
        sourcePmid: input.pmid,
        relationship: input.relationship,
        offset: input.offset,
        articles,
      };
    } catch (err) {
      if (ctx.signal.aborted) throw err;
      ctx.log.warning('ESummary enrichment failed; returning related PMIDs without metadata', {
        err: describeError(err),
      });
      notices.push(
        'Article metadata is temporarily unavailable (NCBI eSummary did not respond); returning related PMIDs only. Retry for full metadata, or use pubmed_fetch_articles.',
      );
      ctx.enrich.notice(notices.join(' '));
      return {
        sourcePmid: input.pmid,
        relationship: input.relationship,
        offset: input.offset,
        articles: window.map((pmid) => ({ pmid })),
      };
    }
  },

  format: (result) => {
    const lines = [
      `# Related Articles for PMID ${result.sourcePmid}`,
      `**Relationship:** ${result.relationship}`,
      `**Returned:** ${result.articles.length} | **Offset:** ${result.offset}`,
    ];
    if (result.articles.length === 0) {
      lines.push('No related articles found.');
    } else {
      for (const a of result.articles) {
        lines.push(`- **[PMID ${a.pmid}](https://pubmed.ncbi.nlm.nih.gov/${a.pmid}/)**`);
        if (a.title) lines.push(`  ${escapeMarkdownInline(a.title)}`);
        if (a.authors) lines.push(`  *${escapeMarkdownInline(a.authors)}*`);
        const meta = [a.source, a.pubDate].filter(Boolean).join(', ');
        if (meta) lines.push(`  ${meta}`);
      }
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
