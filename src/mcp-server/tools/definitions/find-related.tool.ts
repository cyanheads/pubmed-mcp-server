/**
 * @fileoverview PubMed related articles tool — finds articles related to a
 * source article via a provider chain: NCBI ELink (primary) → Europe PMC →
 * OpenAlex. First success wins; results are never merged across sources.
 * Supports offset pagination on the returned window, sized by `maxResults`
 * (`limit` and `pageSize` accepted as aliases, and `relation` for
 * `relationship`); a `maxResults` past the per-call cap is served at the cap
 * with a notice. Whichever provider answered, the window's rows come from one
 * ESummary call, built as `pubmed_search_articles` builds its summaries
 * (`_summary-row.ts`); when that call fails, each row is its PMID and PubMed
 * link. A served empty answer is a success; only a chain where every eligible
 * provider failed is an error. Every return path carries the total match count
 * in `output`, which `format()` states in the header. A zero-padded source PMID
 * runs as the PMID it spells, so the source never appears among its own related
 * articles.
 *
 * The whole chain runs under one deadline, started as the handler starts (#310). A
 * step that another step can still follow — a fallback provider, a reference-coverage
 * check, the rows' ESummary — takes half the time left as it starts; the last step
 * takes what remains. A provider whose step has no time left is never asked and is
 * reported `not_reached`, apart from every failure label; the rows' ESummary in that
 * case is skipped like a failed one, with a notice of its own.
 * @module src/mcp-server/tools/definitions/find-related.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import {
  configurationError,
  JsonRpcErrorCode,
  McpError,
  timeout,
} from '@cyanheads/mcp-ts-core/errors';
import { markdownLink } from '@cyanheads/mcp-ts-core/utils';
import {
  type CallDeadline,
  isSpent,
  shareDeadline,
  startCallDeadline,
} from '@/services/call-deadline.js';
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
import { pageSizeCeiling, pageSizeClampNotice } from './_page-size.js';
import { normalizePmid, pmidStringSchema } from './_schemas.js';
import { summaryRow, summaryRowSchema } from './_summary-row.js';
import { escapeMarkdownInParagraph, escapeMarkdownLineStart } from './_text.js';

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
/** A provider the chain never asked because its step had no time left on the call's deadline. */
const NOT_REACHED = 'not_reached';
/** A provider failure that carried no declared reason and whose code names none below. */
const UNCLASSIFIED_ERROR = 'unclassified_error';

/**
 * Label for a provider failure that carries no declared reason, named by its code.
 * A declared reason wins: NCBI stamps `ncbi_unreachable`, `ncbi_timed_out`, and
 * `ncbi_rate_limited` on a `ServiceUnavailable`, `Timeout`, and `RateLimited`; Europe
 * PMC stamps `europepmc_unreachable`, `europepmc_timed_out`, and
 * `europepmc_rate_limited` on those three codes; OpenAlex stamps `openalex_unreachable`
 * on a `ServiceUnavailable` and `openalex_invalid_response` on a body it cannot parse.
 * Each stamps its `*_deadline_exceeded` on a call its deadline cut: the provider's own
 * total deadline, or the share of this call's deadline its step ran under. So an
 * exhausted OpenAlex timeout or rate limit reaches the chain with its code and no
 * reason.
 */
const REASON_BY_CODE = new Map<JsonRpcErrorCode, string>([
  [JsonRpcErrorCode.RateLimited, 'rate_limited'],
  [JsonRpcErrorCode.Timeout, 'timed_out'],
]);

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

/** One provider's outcome in the chain, reported when no provider answered. */
interface ProviderAttempt {
  message: string;
  provider: ProviderName;
  reason: string;
}

/**
 * A reference-coverage fallback that failed or was not reached instead of
 * answering. Carries the declared reason and whether a retry can reach it —
 * never the upstream message, which can hold URLs and request detail this
 * success payload has no business publishing.
 */
interface CoverageFailure {
  provider: 'europepmc' | 'openalex';
  reason: string;
  retryable: boolean;
}

/**
 * Declared retryability per reason the two coverage fallbacks can throw, from their
 * service contracts — `europepmc_deadline_exceeded` and `openalex_deadline_exceeded`
 * among them, both retryable.
 */
const RETRYABLE_BY_REASON = new Map<string, boolean>(
  [...EUROPEPMC_SERVICE_ERRORS, ...OPENALEX_SERVICE_ERRORS].map((entry) => [
    entry.reason,
    entry.retryable,
  ]),
);

/**
 * Throws when a fallback's step has no time left on the call's deadline, before its
 * service is asked: the caller's own reason when the caller has cancelled, otherwise
 * a `not_reached` outcome, which the chain records beside the failures but never
 * words as one.
 */
function ensureTimeLeft(
  provider: 'europepmc' | 'openalex',
  deadline: CallDeadline,
  signal: AbortSignal,
): void {
  if (!isSpent(deadline)) return;
  signal.throwIfAborted();
  throw timeout(`${PROVIDER_LABELS[provider]} was not reached: ${notReachedReason(1)}`, {
    reason: NOT_REACHED,
    provider,
  });
}

/** Why a provider was not reached, for `count` of them. */
function notReachedReason(count: number): string {
  return `this call's deadline ran out before ${count === 1 ? 'it was' : 'they were'} asked.`;
}

// ─── NCBI provider ────────────────────────────────────────────────────────────

async function ncbiProvider(
  pmid: string,
  relationship: 'similar' | 'cited_by' | 'references',
  signal: AbortSignal,
  deadline: CallDeadline,
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
    { signal, deadline },
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
 * array reaches the window, upstream runs out, or `EPMC_MAX_PAGES` is hit. Every
 * page runs under the one `deadline` this step started with.
 */
async function epmcProvider(
  pmid: string,
  relationship: 'cited_by' | 'references',
  offset: number,
  maxResults: number,
  signal: AbortSignal,
  deadline: CallDeadline,
): Promise<ProviderResult> {
  const epmc = getEuropePmcService();
  if (!epmc) {
    throw configurationError('Europe PMC is turned off by server configuration.', {
      reason: PROVIDER_DISABLED,
      provider: 'europepmc',
    });
  }
  ensureTimeLeft('europepmc', deadline, signal);

  const needed = offset + maxResults;
  const pageSize = Math.min(needed, EPMC_MAX_PAGE_SIZE);
  const allPmids: string[] = [];
  let droppedNoPmid = 0;
  let hitCount = 0;
  let exhausted = false;
  for (let page = 1; page <= EPMC_MAX_PAGES && allPmids.length < needed; page++) {
    const result =
      relationship === 'cited_by'
        ? await epmc.citations(pmid, pageSize, page, signal, deadline)
        : await epmc.references(pmid, pageSize, page, signal, deadline);
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
  deadline: CallDeadline,
): Promise<ProviderResult> {
  const oa = getOpenAlexServiceOptional();
  if (!oa) {
    throw configurationError('OpenAlex is not configured on this server.', {
      reason: PROVIDER_DISABLED,
      provider: 'openalex',
    });
  }
  ensureTimeLeft('openalex', deadline, signal);

  let result: OpenAlexRelatedResult;
  switch (relationship) {
    case 'similar':
      result = await oa.similar(pmid, maxNeeded, signal, deadline);
      break;
    case 'cited_by':
      result = await oa.citedBy(pmid, maxNeeded, signal, deadline);
      break;
    case 'references':
      result = await oa.references(pmid, maxNeeded, signal, deadline);
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
 * configuration never recovers on retry; one the deadline never reached is reached
 * by a new call, which starts a deadline of its own; a failure with no declared
 * reason is treated as transient, matching how the fully-failed chain reports one,
 * unless the error itself says a retry cannot succeed (`data.retryable: false`).
 */
function coverageFailureFrom(provider: 'europepmc' | 'openalex', err: unknown): CoverageFailure {
  const { reason } = attemptFrom(provider, err);
  if (reason === PROVIDER_DISABLED) return { provider, reason, retryable: false };
  if (reason === NOT_REACHED) return { provider, reason, retryable: true };
  const retryable =
    RETRYABLE_BY_REASON.get(reason) ?? !(err instanceof McpError && err.data?.retryable === false);
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
 * Every coverage failure with its reason and whether a retry can reach it, as the
 * `content[]` trailer prints `coverageFailures`: `Europe PMC (europepmc_unreachable,
 * retryable), OpenAlex (unclassified_error, not retryable)`.
 */
function summarizeCoverageFailures(failures: readonly CoverageFailure[]): string {
  return failures
    .map(
      (f) =>
        `${PROVIDER_LABELS[f.provider]} (${f.reason}, ${f.retryable ? 'retryable' : 'not retryable'})`,
    )
    .join(', ');
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

/** Whether an outcome is a provider the deadline never reached, as opposed to one that ran. */
function wasNotReached(entry: { reason: string }): boolean {
  return entry.reason === NOT_REACHED;
}

/**
 * Sentence naming the providers the call's deadline never reached, which were never
 * asked and so never failed. Empty when every entry ran.
 */
function notReachedSentence(
  entries: readonly { provider: ProviderName; reason: string }[],
): string {
  const skipped = entries.filter(wasNotReached).map((e) => PROVIDER_LABELS[e.provider]);
  if (skipped.length === 0) return '';
  return `${skipped.join(' and ')} ${skipped.length > 1 ? 'were' : 'was'} not reached: ${notReachedReason(skipped.length)}`;
}

/**
 * Retry guidance for the coverage providers that failed: a retry completes the
 * check when every one of them is retryable, and reaches only the ones it names
 * when just some are. Empty when none is.
 */
function retryClause(failed: readonly CoverageFailure[]): string {
  const retryable = failed.filter((f) => f.retryable);
  if (retryable.length === 0) return '';
  if (retryable.length === failed.length) {
    return ' Retry after a brief delay to complete the coverage check.';
  }
  return ` Retry after a brief delay to check ${retryable.map((f) => PROVIDER_LABELS[f.provider]).join(' and ')}.`;
}

/**
 * Disclosure for a `references` answer whose coverage check came back short.
 * Names each provider that failed and its reason, offers a retry only for the
 * failures a retry can reach, separates a configuration-disabled provider from
 * the transient failures, names a provider the deadline never reached apart from
 * both, and never describes a failed provider as having answered.
 */
function coverageIncompleteNotice(failures: readonly CoverageFailure[]): string {
  const failed = failures.filter((f) => !wasNotReached(f));
  const answered =
    failed.length > 0
      ? `${summarizeOutcomes(failed)} did not answer.${retryClause(failed)}${disabledClause(failed)}`
      : '';
  const outcomes = [answered, notReachedSentence(failures)].filter(Boolean).join(' ');
  return `Reference coverage could not be fully checked — ${outcomes}`;
}

/** Compact, log-safe description of an unknown thrown value. */
function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Record a provider failure with the declared service-contract reason it
 * carries — or, without one, a label for its code — so the aggregate error names
 * each origin's own failure mode instead of collapsing the chain into one
 * opaque message.
 */
function attemptFrom(provider: ProviderName, err: unknown): ProviderAttempt {
  const reason =
    err instanceof McpError
      ? ((err.data as { reason?: string } | undefined)?.reason ??
        REASON_BY_CODE.get(err.code) ??
        UNCLASSIFIED_ERROR)
      : UNCLASSIFIED_ERROR;
  return { provider, reason, message: describeError(err) };
}

/**
 * Recovery hint for a fully failed chain. Names only the providers actually
 * attempted and their observed outcomes — never another origin's health —
 * separates a configuration-disabled provider, which no retry brings back, from
 * the transient failures worth retrying, and names a provider the deadline never
 * reached in a sentence of its own rather than among the failures. NCBI always
 * runs, so the attempted list is never empty.
 */
function allProvidersFailedHint(attempts: readonly ProviderAttempt[]): string {
  const ran = attempts.filter((a) => !wasNotReached(a));
  const skipped = notReachedSentence(attempts);
  return `Providers attempted: ${summarizeOutcomes(ran)}. Retry the transient failures after a brief delay.${disabledClause(ran)}${skipped && ` ${skipped}`}`;
}

// ─── Tool Definition ─────────────────────────────────────────────────────────

/** Related articles one call returns; a larger `maxResults` is served at this size. (#232) */
const MAX_RESULTS_CAP = 50;

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
      when: "Every provider eligible for the requested relationship failed, or was not asked because the call's deadline ran out first; none answered.",
      recovery:
        "Read data.attempted for each provider outcome, then retry the transient failures after a brief delay; an entry marked provider_disabled is turned off by server configuration and will not recover, and one marked not_reached was never asked because the call's deadline ran out before it.",
      retryable: true,
    },
  ] as const,

  // Never advertised; rewritten to the canonical key before the schema parses.
  // Sibling tools' count names, and `relation`, which on this tool can only mean
  // the relationship selector. (#156, #190, #290)
  inputAliases: { limit: 'maxResults', pageSize: 'maxResults', relation: 'relationship' },

  input: z.object({
    pmid: pmidStringSchema.describe('Source PubMed ID'),
    relationship: z
      .enum(['similar', 'cited_by', 'references'])
      .default('similar')
      .describe(
        'Relationship type: similar (content-based), cited_by (articles citing this one), references (articles this one cites)',
      ),
    maxResults: z
      .number()
      .int()
      .min(1)
      .max(pageSizeCeiling(MAX_RESULTS_CAP))
      .default(10)
      .describe(
        `Maximum related articles per page, up to ${MAX_RESULTS_CAP} per call. A larger value is served at ${MAX_RESULTS_CAP}, with a notice naming the next \`offset\` when more remain.`,
      ),
    offset: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe(
        `Result offset for pagination (0-based). For the next page, add the number of articles returned (at most ${MAX_RESULTS_CAP}) to this offset.`,
      ),
  }),

  output: z.object({
    sourcePmid: z.string().describe('Source PubMed ID'),
    relationship: z.enum(['similar', 'cited_by', 'references']).describe('Relationship type used'),
    offset: z.number().describe('Result offset used'),
    articles: z
      .array(summaryRowSchema.describe('Related article with enriched summary'))
      .describe(
        "Related articles, each summarized as `pubmed_search_articles` summarizes a search result. When NCBI eSummary does not answer, or the call's deadline runs out before it is asked, each is its `pmid` and `pubmedUrl` alone, with a notice.",
      ),
    // A domain field, not enrichment: format() sees only this payload, and the
    // header states the total beside the returned count. (#147)
    totalCount: z
      .number()
      .describe(
        'Total related articles found before windowing. A Europe PMC or OpenAlex total may shrink to the PubMed-addressable count once a request window covers the whole upstream set, since rows without a PubMed PMID cannot be returned.',
      ),
  }),

  // Result-set context the agent reasons with — the answering provider and
  // recovery guidance. Surfaced via ctx.enrich(...) to structuredContent and
  // content[]; kept out of the domain return.
  enrichment: {
    source: z
      .enum(['ncbi', 'europepmc', 'openalex'])
      .describe('Provider that answered this request'),
    notice: z
      .string()
      .optional()
      .describe(
        `Guidance when results are empty, a fallback provider answered, offset overshot, a fallback provider could not be reached or was not asked before the call's deadline ran out, upstream rows were excluded for carrying no PubMed PMID, article metadata could not be fetched, or a \`maxResults\` past the per-call cap of ${MAX_RESULTS_CAP} was served at ${MAX_RESULTS_CAP}. Absent on an NCBI result page that needs none of these.`,
      ),
    coverageFailures: z
      .array(
        z
          .object({
            provider: z
              .enum(['europepmc', 'openalex'])
              .describe('Reference-coverage provider that did not answer'),
            reason: z
              .string()
              .describe(
                "Declared failure reason, e.g. europepmc_unreachable; provider_disabled when configuration turned the provider off, not_reached when the call's deadline ran out before it was asked",
              ),
            retryable: z.boolean().describe('Whether a retry can reach this provider'),
          })
          .describe('One coverage provider that could not be checked'),
      )
      .optional()
      .describe(
        "Reference-coverage fallbacks that failed, or were not asked before the call's deadline ran out, instead of answering, so the reference set is unverified rather than confirmed absent. Absent when every provider consulted answered.",
      ),
  },

  enrichmentTrailer: {
    source: { label: 'Source' },
    coverageFailures: {
      render: (value = []) => `**Coverage not checked:** ${summarizeCoverageFailures(value)}`,
    },
  },

  async handler(input, ctx) {
    // Every upstream call below runs under this one deadline. A step that a later
    // step can still follow — a fallback, a coverage check, the rows' ESummary —
    // takes `shareDeadline(deadline)` as it starts, half the time left; the last step
    // takes `deadline` itself. (#310)
    const deadline = startCallDeadline();
    const ncbi = getNcbiService();
    ctx.log.debug('Finding related articles', {
      pmid: input.pmid,
      relationship: input.relationship,
      offset: input.offset,
    });
    // ELink answers `0034265844` as PMID 34265844 and lists that PMID first among
    // its own `similar` neighbors, so the self-filter — and every upstream call —
    // uses the canonical form. `sourcePmid` and the notices keep the caller's
    // spelling. (#161)
    const canonicalPmid = normalizePmid(input.pmid);
    // A `maxResults` past the cap is served at the cap rather than rejected, and
    // every provider window and the ESummary batch are sized from this applied
    // value, never from the request. (#232)
    const maxResults = Math.min(input.maxResults, MAX_RESULTS_CAP);
    /**
     * Emits the call's one notice — only the last `ctx.enrich.notice` survives —
     * with the page-size clamp, when it applied, ahead of the other sentences.
     * `nextOffset` is named only when results remain past this page.
     */
    const emitNotice = (sentences: string[], nextOffset?: number) => {
      const all =
        maxResults < input.maxResults
          ? [
              pageSizeClampNotice(
                'maxResults',
                input.maxResults,
                MAX_RESULTS_CAP,
                nextOffset === undefined
                  ? undefined
                  : `Pass \`offset: ${nextOffset}\` for the next page.`,
              ),
              ...sentences,
            ]
          : sentences;
      if (all.length > 0) ctx.enrich.notice(all.join(' '));
    };

    // ── Provider chain ──────────────────────────────────────────────────────
    // Try NCBI first; on failure fall back to Europe PMC then OpenAlex (first
    // success wins, never merged). A non-PMC `references` source returns an empty
    // NCBI set rather than throwing — that structural fallback is handled below.

    let providerResult: ProviderResult | null = null;
    // Europe PMC's served-but-empty answer, held so a later OpenAlex failure
    // falls back to it: an answer of zero is still an answer, not an outage.
    let epmcEmpty: ProviderResult | null = null;
    // Every provider the chain tried, with its outcome. A structurally ineligible
    // provider (Europe PMC for `similar`) is never tried and never appears here;
    // an unconfigured one is tried, fails as `provider_disabled` without reaching
    // its upstream, and is recorded like any other failure; one whose step had no
    // time left is recorded as `not_reached`, never asked.
    const attempts: ProviderAttempt[] = [];
    // Records WHY a non-primary provider answered, so the provenance notice can
    // distinguish an NCBI outage from references coverage for a non-PMC source.
    let fallbackKind: 'outage' | 'references_coverage' | undefined;
    // Reference-coverage fallbacks that threw. NCBI answering successfully with
    // an empty set is not the same fact as a provider never being reached, so a
    // failure here is carried to the caller instead of logged and dropped.
    const coverageFailures: CoverageFailure[] = [];

    // 1. NCBI (primary). An ESummary always follows an answer, and a fallback a
    //    failure, so ELink takes a share.
    try {
      providerResult = await ncbiProvider(
        canonicalPmid,
        input.relationship,
        ctx.signal,
        shareDeadline(deadline),
      );
    } catch (err) {
      if (ctx.signal.aborted) throw err;
      ctx.log.warning('NCBI eLink failed, trying fallback providers', {
        pmid: input.pmid,
        err: describeError(err),
      });
      attempts.push(attemptFrom('ncbi', err));
    }

    // 2. Europe PMC (fallback for cited_by / references only). An empty EPMC
    //    result is not "served" — fall through to OpenAlex rather than return 0.
    //    OpenAlex or the rows' ESummary follows, so it takes a share.
    if (providerResult === null && epmcSupports(input.relationship)) {
      try {
        const epmcResult = await epmcProvider(
          canonicalPmid,
          input.relationship as 'cited_by' | 'references',
          input.offset,
          maxResults,
          ctx.signal,
          shareDeadline(deadline),
        );
        if (epmcResult.allPmids.length > 0) {
          providerResult = epmcResult;
          fallbackKind = 'outage';
        } else {
          epmcEmpty = epmcResult;
        }
      } catch (err) {
        if (ctx.signal.aborted) throw err;
        ctx.log.warning('Europe PMC fallback did not answer, trying OpenAlex', {
          pmid: input.pmid,
          err: describeError(err),
        });
        attempts.push(attemptFrom('europepmc', err));
      }
    }

    // 3. OpenAlex (last resort for all relationships). The rows' ESummary follows
    //    an answer, so it takes a share too.
    if (providerResult === null) {
      try {
        providerResult = await openAlexProvider(
          canonicalPmid,
          input.relationship,
          input.offset + maxResults,
          ctx.signal,
          shareDeadline(deadline),
        );
        fallbackKind = 'outage';
      } catch (err) {
        if (ctx.signal.aborted) throw err;
        ctx.log.warning('OpenAlex fallback did not answer', {
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
      // The last step, unless a references coverage check can run after it: one
      // turned off by configuration asks no upstream, so it needs no time. A source
      // ESummary with no time left sends nothing and fails, which leaves the source
      // unconfirmed exactly as any other failure of it does.
      const coverageCanFollow =
        input.relationship === 'references' &&
        (getEuropePmcService() !== undefined || getOpenAlexServiceOptional() !== undefined);
      try {
        // Version 2.0, as for the rows: the version 1 DocSum has no BookTitle, so a
        // whole Bookshelf book, whose Title is empty, would read as unknown there.
        const summaryResult = await ncbi.eSummary(
          { db: 'pubmed', version: '2.0', retmode: 'xml', id: canonicalPmid },
          { signal: ctx.signal, deadline: coverageCanFollow ? shareDeadline(deadline) : deadline },
        );
        const [summary] = await extractBriefSummaries(summaryResult);
        // An unknown PMID comes back as an error entry holding its uid alone. A
        // Bookshelf book has no Title and is named by its BookTitle (40825089).
        if (summary?.title || summary?.bookTitle) sourceSummary = summary;
        else sourceConfirmedMissing = true;
      } catch (err) {
        if (ctx.signal.aborted) throw err;
        ctx.log.debug('Source PMID ESummary failed', { err });
        const reason =
          err instanceof McpError
            ? (err.data as { reason?: string } | undefined)?.reason
            : undefined;
        if (reason === 'ncbi_resource_not_found') sourceConfirmedMissing = true;
      }

      if (sourceConfirmedMissing) {
        ctx.enrich({ source: 'ncbi' });
        emitNotice([
          `Source PMID ${input.pmid} not found in PubMed. Verify the ID with \`pubmed_fetch_articles\` or \`pubmed_search_articles\`.`,
        ]);
        return {
          sourcePmid: input.pmid,
          relationship: input.relationship,
          offset: input.offset,
          articles: [],
          totalCount: 0,
        };
      }

      // References coverage fallback — only for a confirmed-valid source. NCBI
      // resolves references only for PMC-indexed sources, so a valid non-PMC
      // source returns empty; Europe PMC then OpenAlex serve them. An unconfirmed
      // source (ESummary itself failed) stays silent — the empty set is most
      // likely a transient NCBI issue, not a real "no references".
      if (input.relationship === 'references' && sourceSummary) {
        let refFallback: ProviderResult | null = null;
        // Providers that actually answered — the only ones a "no references"
        // notice may claim to have checked.
        const coverageChecked: ProviderName[] = ['ncbi'];
        // Each runs under a share: OpenAlex can follow Europe PMC, and the rows'
        // ESummary follows an answer from either.
        const refAttempts: Array<{
          provider: 'europepmc' | 'openalex';
          run: (stepDeadline: CallDeadline) => Promise<ProviderResult>;
        }> = [
          {
            provider: 'europepmc',
            run: (stepDeadline) =>
              epmcProvider(
                canonicalPmid,
                'references',
                input.offset,
                maxResults,
                ctx.signal,
                stepDeadline,
              ),
          },
          {
            provider: 'openalex',
            run: (stepDeadline) =>
              openAlexProvider(
                canonicalPmid,
                'references',
                input.offset + maxResults,
                ctx.signal,
                stepDeadline,
              ),
          },
        ];
        for (const attempt of refAttempts) {
          try {
            const result = await attempt.run(shareDeadline(deadline));
            coverageChecked.push(attempt.provider);
            if (result.allPmids.length > 0) {
              refFallback = result;
              break;
            }
          } catch (err) {
            if (ctx.signal.aborted) throw err;
            ctx.log.warning('References fallback provider did not answer', {
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
          if (coverageFailures.length > 0) ctx.enrich({ coverageFailures });
          const sourcePmcId = sourceSummary.pmcId;
          const checked = joinWithOr(coverageChecked.map((p) => PROVIDER_LABELS[p]));
          const noReferences = sourcePmcId
            ? `No reference list found for PMID ${input.pmid} (PMCID ${sourcePmcId}) via ${checked}.`
            : `No reference list available for PMID ${input.pmid} via ${checked}. Use pubmed_fetch_articles to inspect the article record, or try relationship: "similar" / "cited_by".`;
          emitNotice([
            coverageFailures.length > 0
              ? `${noReferences} ${coverageIncompleteNotice(coverageFailures)}`
              : noReferences,
          ]);
          return {
            sourcePmid: input.pmid,
            relationship: input.relationship,
            offset: input.offset,
            articles: [],
            totalCount: 0,
          };
        }
      } else {
        // similar / cited_by empty for a valid source, or references with an
        // unconfirmed source — return the honest empty with no notice beyond a
        // page-size clamp.
        ctx.enrich({ source: 'ncbi' });
        emitNotice([]);
        return {
          sourcePmid: input.pmid,
          relationship: input.relationship,
          offset: input.offset,
          articles: [],
          totalCount: 0,
        };
      }
    }

    // ── Window the result set + enrich ──────────────────────────────────────────
    const { allPmids, totalCount, source, droppedNoPmid = 0, reachCapped = false } = providerResult;
    ctx.enrich({ source });
    // A provider that failed before another one answered still shapes how far
    // this reference set was actually checked.
    if (coverageFailures.length > 0) ctx.enrich({ coverageFailures });

    // For NCBI the full neighbor set is in memory; for EPMC/OpenAlex the provider
    // pre-fetched enough PMID-addressable rows to cover the window.
    const window = allPmids.slice(input.offset, input.offset + maxResults);
    // The page after this one, for the clamp notice. A fallback that stopped
    // short of the window (`reachCapped`) left rows before it unread, so no
    // continuation is offered past them.
    const nextOffset =
      !reachCapped && input.offset + maxResults < totalCount
        ? input.offset + maxResults
        : undefined;

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
    // unit of work there. A walk that found no PMID gets no advice: a lower
    // offset reads a prefix of the same rows, or the same batches.
    if (reachCapped) {
      const cap = source === 'europepmc' ? EPMC_MAX_PAGES : OPENALEX_MAX_UPSTREAM_REQUESTS;
      const walk =
        source === 'europepmc' || input.relationship === 'cited_by'
          ? `paging stopped after ${cap} pages`
          : `ID resolution stopped after ${cap} batches`;
      const found = allPmids.length;
      const outcome =
        found === 0
          ? ' without finding a row that carries a PubMed PMID.'
          : found <= input.offset
            ? `, having found ${found} PubMed-addressable rows, without reaching offset ${input.offset}; lower the offset.`
            : `, having found ${found} PubMed-addressable rows, so this page holds rows ${input.offset}–${found - 1} of the ${input.offset}–${input.offset + maxResults - 1} requested.`;
      notices.push(`${PROVIDER_LABELS[source]} ${walk}${outcome}`);
    }

    if (window.length === 0) {
      emitNotice(notices, nextOffset);
      return {
        sourcePmid: input.pmid,
        relationship: input.relationship,
        offset: input.offset,
        articles: [],
        totalCount,
      };
    }

    // Enrich the window with ESummary, the chain's last step, under the call's own
    // deadline. When a fallback answered because NCBI is down, eSummary hits the
    // same host and may also fail — degrade to bare PMIDs (the article metadata
    // fields are all optional) rather than failing the whole request, so the
    // chain's resilience survives the enrichment step. With no time left it is
    // never asked, and its notice says so rather than reporting it failed.
    let summaryMap: Map<string, ParsedBriefSummary> | undefined;
    if (isSpent(deadline)) {
      ctx.signal.throwIfAborted();
      notices.push(
        "Article metadata was not fetched — this call's deadline ran out before NCBI eSummary was asked; returning related PMIDs only. Use pubmed_fetch_articles for full metadata.",
      );
    } else {
      try {
        // Version 2.0 is what carries a Bookshelf record's venue: the version 1
        // DocSum format has no BookTitle, PublisherName or DocType element, and
        // names editors without the AuthType that separates them from the
        // record's own authors. On that older format a book row reports an empty
        // Source and no book fields at all. (#114)
        const summaryResult = await ncbi.eSummary(
          { db: 'pubmed', version: '2.0', retmode: 'xml', id: window.join(',') },
          { signal: ctx.signal, deadline },
        );
        const briefSummaries = await extractBriefSummaries(summaryResult);
        summaryMap = new Map(briefSummaries.map((bs) => [bs.pmid, bs]));
      } catch (err) {
        if (ctx.signal.aborted) throw err;
        ctx.log.warning('ESummary enrichment failed; returning related PMIDs without metadata', {
          err: describeError(err),
        });
        notices.push(
          'Article metadata is temporarily unavailable (NCBI eSummary did not respond); returning related PMIDs only. Retry for full metadata, or use pubmed_fetch_articles.',
        );
      }
    }
    emitNotice(notices, nextOffset);
    return {
      sourcePmid: input.pmid,
      relationship: input.relationship,
      offset: input.offset,
      articles: window.map((pmid) => summaryRow(summaryMap?.get(pmid) ?? { pmid })),
      totalCount,
    };
  },

  format: (result) => {
    const lines = [
      `# Related Articles for PMID ${result.sourcePmid}`,
      `**Relationship:** ${result.relationship}`,
      `**Returned:** ${result.articles.length} of ${result.totalCount} | **Offset:** ${result.offset}`,
    ];
    if (result.articles.length === 0) {
      lines.push('No related articles found.');
    } else {
      // The title, author, editor, language and meta lines of an item are one
      // paragraph, and the authors sit inside this server's own `*…*`, so every
      // value takes the paragraph escape: a lone `*` in two of them would pair.
      // (#261)
      const escaped = (part: string | undefined) => (part ? escapeMarkdownInParagraph(part) : '');
      for (const a of result.articles) {
        // The item opens on its identifiers: the PubMed link, then the DOI as
        // text and the PMC copy as a link, so the meta line stays the item's
        // last. (#297)
        const identifiers = [`**${markdownLink(`PMID ${a.pmid}`, a.pubmedUrl)}**`];
        if (a.doi) identifiers.push(`DOI ${escaped(a.doi)}`);
        if (a.pmcId)
          identifiers.push(a.pmcUrl ? markdownLink(a.pmcId, a.pmcUrl) : escaped(a.pmcId));
        lines.push(`- ${identifiers.join(' · ')}`);
        // The title and meta lines open a line of the list item, where a
        // leading `#`, `>` or `- ` would start a heading, quote or nested list,
        // so the line start is escaped as well. (#255)
        if (a.title) lines.push(`  ${escapeMarkdownLineStart(escaped(a.title))}`);
        if (a.authors) lines.push(`  *${escaped(a.authors)}*`);
        if (a.editors?.length) lines.push(`  edited by ${escaped(a.editors.join(', '))}`);
        // Its own line above the meta line, which stays the item's last (#297):
        // a comma-joined list would read as more meta segments. (#309)
        if (a.languages?.length) lines.push(`  Language: ${escaped(a.languages.join(', '))}`);
        // A Bookshelf record has no journal: its book and publisher stand in
        // for the source so the row still names a venue. (#114)
        const book = [escaped(a.bookTitle), escaped(a.publisherName)].filter(Boolean).join(' — ');
        // `citation` is every ordinary journal article; the segment earns its
        // place only when it flags a Bookshelf chapter or book. (#146)
        const docType = a.docType === 'citation' ? undefined : a.docType;
        const epub = a.epubDate && `epub ${escaped(a.epubDate)}`;
        const meta = [escaped(a.source), book, escaped(docType), escaped(a.pubDate), epub]
          .filter(Boolean)
          .join(', ');
        if (meta) lines.push(`  ${escapeMarkdownLineStart(meta)}`);
      }
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
