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
import { EUROPEPMC_SERVICE_ERRORS, OPENALEX_SERVICE_ERRORS } from '@/services/error-contracts.js';
import { getEuropePmcService } from '@/services/europe-pmc/europe-pmc-service.js';
import { getNcbiService } from '@/services/ncbi/ncbi-service.js';
import { extractBriefSummaries } from '@/services/ncbi/parsing/esummary-parser.js';
import { ensureArray } from '@/services/ncbi/parsing/xml-helpers.js';
import type { ParsedBriefSummary } from '@/services/ncbi/types.js';
import { getOpenAlexServiceOptional } from '@/services/openalex/openalex-service.js';
import {
  OPENALEX_MAX_UPSTREAM_REQUESTS,
  type OpenAlexRelatedResult,
} from '@/services/openalex/types.js';
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
  /** Rows fetched for this request that carry no PubMed PMID (Europe PMC, OpenAlex). */
  droppedNoPmid?: number;
  /** The provider's paging stopped at its cap before the window was covered. */
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

/**
 * A reference-coverage fallback that threw instead of answering. Carries the
 * declared reason and whether a retry can reach it — never the upstream
 * message, which can hold URLs and request detail this success payload has no
 * business publishing.
 */
interface CoverageFailure {
  provider: 'europepmc' | 'openalex';
  reason: string;
  retryable: boolean;
}

/** Declared retryability per reason the two coverage fallbacks can throw. */
const RETRYABLE_BY_REASON = new Map<string, boolean>(
  [...EUROPEPMC_SERVICE_ERRORS, ...OPENALEX_SERVICE_ERRORS].map((entry) => [
    entry.reason,
    entry.retryable,
  ]),
);

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

  let result: OpenAlexRelatedResult;
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

  return {
    allPmids: result.pmids,
    totalCount: result.totalCount,
    source: 'openalex',
    droppedNoPmid: result.droppedNoPmid,
    reachCapped: result.reachCapped,
  };
}

/**
 * Record a coverage-fallback failure with its declared reason. A provider off by
 * configuration never recovers on retry; an unclassified transport failure is
 * treated as transient, matching how the fully-failed chain reports one.
 */
function coverageFailureFrom(provider: 'europepmc' | 'openalex', err: unknown): CoverageFailure {
  const { reason } = attemptFrom(provider, err);
  const retryable =
    reason === PROVIDER_DISABLED ? false : (RETRYABLE_BY_REASON.get(reason) ?? true);
  return { provider, reason, retryable };
}

/** "A", "A or B", "A, B, or C" — the providers a notice may claim answered. */
function joinWithOr(labels: readonly string[]): string {
  if (labels.length <= 1) return labels[0] ?? '';
  if (labels.length === 2) return `${labels[0]} or ${labels[1]}`;
  return `${labels.slice(0, -1).join(', ')}, or ${labels[labels.length - 1]}`;
}

/** One provider outcome per entry: `Europe PMC (provider_disabled), OpenAlex (openalex_unreachable)`. */
function summarizeOutcomes(entries: readonly { provider: ProviderName; reason: string }[]): string {
  return entries.map((e) => `${PROVIDER_LABELS[e.provider]} (${e.reason})`).join(', ');
}

/**
 * Trailing clause naming the providers configuration turned off, which no retry
 * brings back. Empty when every entry is a transient failure.
 */
function disabledClause(entries: readonly { provider: ProviderName; reason: string }[]): string {
  const disabled = entries
    .filter((e) => e.reason === PROVIDER_DISABLED)
    .map((e) => PROVIDER_LABELS[e.provider]);
  if (disabled.length === 0) return '';
  return ` ${disabled.join(' and ')} ${disabled.length > 1 ? 'are' : 'is'} turned off by server configuration and will not recover on retry.`;
}

/**
 * Disclosure for a `references` answer whose coverage check came back short.
 * Names each provider that failed and its reason, separates a
 * configuration-disabled provider from the transient failures worth retrying,
 * and never describes a failed provider as having answered.
 */
function coverageIncompleteNotice(failures: readonly CoverageFailure[]): string {
  const retryClause = failures.some((f) => f.retryable)
    ? ' Retry after a brief delay to complete the coverage check.'
    : '';
  return `Reference coverage could not be fully checked — ${summarizeOutcomes(failures)} did not answer.${retryClause}${disabledClause(failures)}`;
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
  return `Providers attempted: ${summarizeOutcomes(attempts)}. Retry the transient failures after a brief delay.${disabledClause(attempts)}`;
}

// ─── Tool Definition ─────────────────────────────────────────────────────────

export const findRelatedTool = tool('pubmed_find_related', {
  description:
    'Find articles related to a source article — similar content (similar), articles citing this one (cited_by), or articles this one cites (references). Uses NCBI ELink as the primary source; falls back to Europe PMC then OpenAlex when NCBI is unavailable.',
  annotations: { readOnlyHint: true, openWorldHint: true },
  _meta: conceptMeta([SCHEMA_SCHOLARLY_ARTICLE, EDAM_DATA_RETRIEVAL]),
  sourceUrl:
    'https://github.com/cyanheads/pubmed-mcp-server/blob/main/src/mcp-server/tools/definitions/find-related.tool.ts',

  // The handler catches every provider and ESummary failure, so no service
  // reason reaches the caller as the top-level `data.reason`; each surfaces
  // nested in `data.attempted` or the `coverageFailures` enrichment instead.
  errors: [
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
            authors: z
              .string()
              .optional()
              .describe(
                "Author string — the first three of the record's own authors, then \"et al.\". On an NCBI Bookshelf chapter these are the chapter's authors; the book's editors are in `editors`.",
              ),
            source: z
              .string()
              .optional()
              .describe(
                'Journal the article appeared in. Absent on an NCBI Bookshelf record, which has no journal — its venue is in `bookTitle` and `publisherName` instead, and `docType` says which kind of record it is.',
              ),
            bookTitle: z
              .string()
              .optional()
              .describe(
                'Title of the book an NCBI Bookshelf record belongs to. Present instead of `source` on a book record; absent on a journal article.',
              ),
            publisherName: z
              .string()
              .optional()
              .describe(
                'Publisher of the book an NCBI Bookshelf record belongs to. Present only on a book record; absent on a journal article.',
              ),
            docType: z
              .string()
              .optional()
              .describe(
                'What PubMed classifies this record as: "chapter" or "book" for an NCBI Bookshelf record, "citation" for an ordinary journal article. Absent when PubMed supplies none.',
              ),
            editors: z
              .array(z.string().describe('One editor, "Surname Initials" as ESummary renders it'))
              .optional()
              .describe(
                "Editors of the containing book, kept out of `authors` so they cannot displace the record's own authors. Absent on a journal article and on a book that credits no editors.",
              ),
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
        'Total related articles found before windowing. A Europe PMC or OpenAlex total may shrink to the PubMed-addressable count once a request window covers the whole upstream set, since rows without a PubMed PMID cannot be returned.',
      ),
    source: z
      .enum(['ncbi', 'europepmc', 'openalex'])
      .describe('Provider that answered this request'),
    notice: z
      .string()
      .optional()
      .describe(
        'Guidance when results are empty, a fallback provider answered, offset overshot, a fallback provider could not be reached, or upstream rows were excluded for carrying no PubMed PMID. Absent on a clean NCBI result page.',
      ),
    coverageFailures: z
      .array(
        z
          .object({
            provider: z
              .enum(['europepmc', 'openalex'])
              .describe('Reference-coverage provider that failed'),
            reason: z
              .string()
              .describe('Declared failure reason, e.g. europepmc_unreachable or provider_disabled'),
            retryable: z.boolean().describe('Whether a retry can reach this provider'),
          })
          .describe('One coverage provider that could not be checked'),
      )
      .optional()
      .describe(
        'Reference-coverage fallbacks that failed instead of answering, so the reference set is unverified rather than confirmed absent. Absent when every provider consulted answered.',
      ),
  },

  enrichmentTrailer: {
    totalCount: { label: 'Total Found' },
    source: { label: 'Source' },
    coverageFailures: {
      render: (value = []) => `**Coverage not checked:** ${summarizeOutcomes(value)}`,
    },
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
    // Reference-coverage fallbacks that threw. NCBI answering successfully with
    // an empty set is not the same fact as a provider never being reached, so a
    // failure here is carried to the caller instead of logged and dropped.
    const coverageFailures: CoverageFailure[] = [];

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
        // Providers that actually answered — the only ones a "no references"
        // notice may claim to have checked.
        const coverageChecked: ProviderName[] = ['ncbi'];
        const refAttempts: Array<{
          provider: 'europepmc' | 'openalex';
          run: () => Promise<ProviderResult>;
        }> = [
          {
            provider: 'europepmc',
            run: () =>
              epmcProvider(input.pmid, 'references', input.offset, input.maxResults, ctx.signal),
          },
          {
            provider: 'openalex',
            run: () =>
              openAlexProvider(
                input.pmid,
                'references',
                input.offset + input.maxResults,
                ctx.signal,
              ),
          },
        ];
        for (const attempt of refAttempts) {
          try {
            const result = await attempt.run();
            coverageChecked.push(attempt.provider);
            if (result.allPmids.length > 0) {
              refFallback = result;
              break;
            }
          } catch (err) {
            ctx.log.warning('References fallback provider failed', {
              provider: attempt.provider,
              err: describeError(err),
            });
            coverageFailures.push(coverageFailureFrom(attempt.provider, err));
          }
        }

        if (refFallback) {
          providerResult = refFallback;
          fallbackKind = 'references_coverage';
        } else {
          ctx.enrich({ source: 'ncbi' });
          ctx.enrich.total(0);
          if (coverageFailures.length > 0) ctx.enrich({ coverageFailures });
          const sourcePmcId = sourceSummary.pmcId;
          const checked = joinWithOr(coverageChecked.map((p) => PROVIDER_LABELS[p]));
          const noReferences = sourcePmcId
            ? `No reference list found for PMID ${input.pmid} (PMCID ${sourcePmcId}) via ${checked}.`
            : `No reference list available for PMID ${input.pmid} via ${checked}. Use pubmed_fetch_articles to inspect the article record, or try relationship: "similar" / "cited_by".`;
          ctx.enrich.notice(
            coverageFailures.length > 0
              ? `${noReferences} ${coverageIncompleteNotice(coverageFailures)}`
              : noReferences,
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
    // A provider that failed before another one answered still shapes how far
    // this reference set was actually checked.
    if (coverageFailures.length > 0) ctx.enrich({ coverageFailures });

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
    // Both fallbacks count every upstream record, but only some rows carry a
    // PubMed PMID — Europe PMC's non-MED sources, OpenAlex works with no PubMed
    // record. Disclose the gap so an empty or short window reads as an
    // excluded-rows effect rather than an exhausted result set.
    if (droppedNoPmid > 0) {
      const excluded =
        source === 'europepmc'
          ? 'non-MED sources such as preprints'
          : 'works OpenAlex indexes with no PubMed record';
      notices.push(
        `${PROVIDER_LABELS[source]} served ${allPmids.length + droppedNoPmid} upstream rows for this request, ${droppedNoPmid} with no PubMed PMID (${excluded}); those rows cannot be returned here.`,
      );
    }

    // The request cap bounds how far into a fallback's set one request can
    // reach. It counts pages for Europe PMC and for OpenAlex's `cites:` filter,
    // but OpenAlex serves `similar` and `references` from the source work's own
    // ID list, which it resolves in batches — so the same cap names a different
    // unit of work there.
    if (reachCapped) {
      const cap = source === 'europepmc' ? EPMC_MAX_PAGES : OPENALEX_MAX_UPSTREAM_REQUESTS;
      const walk =
        source === 'europepmc' || input.relationship === 'cited_by'
          ? `paging stopped after ${cap} pages`
          : `ID resolution stopped after ${cap} batches`;
      notices.push(
        `${PROVIDER_LABELS[source]} ${walk} (${allPmids.length} PubMed-addressable rows) without reaching offset ${input.offset}; lower the offset.`,
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
      // Version 2.0 is what carries a Bookshelf record's venue: the version 1
      // DocSum format has no BookTitle, PublisherName or DocType element, and
      // names editors without the AuthType that separates them from the
      // record's own authors. On that older format a book row reports an empty
      // Source and no book fields at all. (#114)
      const summaryResult = await ncbi.eSummary(
        { db: 'pubmed', version: '2.0', retmode: 'xml', id: window.join(',') },
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
          bookTitle: details?.bookTitle,
          publisherName: details?.publisherName,
          docType: details?.docType,
          editors: details?.editors,
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
        if (a.editors?.length)
          lines.push(`  edited by ${escapeMarkdownInline(a.editors.join(', '))}`);
        // A Bookshelf record has no journal: its book and publisher stand in
        // for the source so the row still names a venue. (#114)
        const book = [a.bookTitle, a.publisherName].filter(Boolean).join(' — ');
        const meta = [a.source, book, a.docType, a.pubDate].filter(Boolean).join(', ');
        if (meta) lines.push(`  ${meta}`);
      }
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
