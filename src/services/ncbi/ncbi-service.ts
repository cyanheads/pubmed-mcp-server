/**
 * @fileoverview High-level service for interacting with NCBI E-utilities.
 * Orchestrates the API client, request queue, and response handler to provide
 * typed methods for each E-utility endpoint. Every call runs as a retry loop around
 * the shared request queue — each attempt re-queued and re-paced — under one deadline
 * that covers queue wait, attempts, and backoff: NCBI's own, or the time the tool call
 * has left when that is less. Once a call to an endpoint
 * fails on every attempt, later calls to that endpoint make one attempt each until
 * one succeeds. Uses init/accessor pattern.
 * @module src/services/ncbi/ncbi-service
 */

import {
  invalidParams,
  JsonRpcErrorCode,
  McpError,
  rateLimited,
  serializationError,
  timeout,
  validationError,
} from '@cyanheads/mcp-ts-core/errors';
import {
  defaultIsTransient,
  logger,
  type Pacer,
  requestContextService,
  withRetry,
} from '@cyanheads/mcp-ts-core/utils';

import { getServerConfig } from '@/config/server-config.js';
import { type CallDeadline, upstreamBound } from '@/services/call-deadline.js';
import { NcbiApiClient } from './api-client.js';
import { fieldTagKind } from './field-tags.js';
import {
  childrenOf,
  findOne,
  isTextNode,
  type JatsNode,
  type JatsNodeList,
  tagNameOf,
  textOf,
} from './parsing/pmc-xml-helpers.js';
import { createNcbiRequestQueue } from './request-queue.js';
import {
  emptyEFetchResultFor,
  NcbiResponseHandler,
  reclassifyNcbiHttpError,
} from './response-handler.js';
import {
  type ECitMatchCitation,
  type ECitMatchResult,
  type ESearchErrorList,
  type ESearchResponseContainer,
  type ESearchResult,
  type ESearchWarningList,
  ESPELL_CHECK_MAX_REQUESTS,
  ESPELL_CHECK_TIME_LIMIT_MS,
  type ESpellCheckSkipReason,
  type ESpellResult,
  type ESpellSkippedCheck,
  type ESummaryResponseContainer,
  type ESummaryResult,
  type IdConvertRecord,
  type IdConvertResponse,
  NCBI_PMC_IDCONV_URL,
  type NcbiCallOptions,
  type NcbiRequestOptions,
  type NcbiRequestParams,
  type XmlPubmedArticleSet,
} from './types.js';

/**
 * Per-idType expected-format hints surfaced when PMC ID Converter rejects a
 * batch with HTTP 400. Informational only — NCBI's API is the authority on
 * what's accepted, so a stale hint here only weakens the error message, never
 * blocks a valid request.
 */
const ID_CONVERT_FORMAT_HINTS: Record<string, string> = {
  pmid: 'numeric digits, e.g. "23193287"',
  pmcid: '"PMC" + digits or bare digits, e.g. "PMC3531190" or "3531190"',
  doi: 'starts with "10.", e.g. "10.1093/nar/gks1195"',
};

/** Every member either list can carry; both shapes are all-optional string arrays. */
type ESearchDiagnostics = ESearchErrorList & ESearchWarningList;

/**
 * NCBI collapses a single-entry `ErrorList`/`WarningList` member to a scalar and
 * leaves multi-entry members as arrays, and `parseTagValue` coerces a numeric-looking
 * phrase to a number. Normalize every member to `string[]` so `ESearchErrorList` /
 * `ESearchWarningList` describe what callers actually receive.
 */
function normalizeDiagnosticList(
  list: ESearchDiagnostics | undefined,
): ESearchDiagnostics | undefined {
  if (!list) return;
  const normalized: ESearchDiagnostics = {};
  for (const [key, value] of Object.entries(list)) {
    normalized[key as keyof ESearchDiagnostics] = (Array.isArray(value) ? value : [value]).map(
      String,
    );
  }
  return normalized;
}

/**
 * The tracking token a citation is submitted to ECitMatch under — echoed back
 * verbatim on that citation's response row, and unique within the call.
 *
 * Always the citation's 1-based position in the call, never
 * `ECitMatchCitation.key`, and the same in every request that carries it, so a
 * re-requested line reconciles without renumbering (#193). The label is
 * caller-supplied, so reconciling response rows on it collapses two citations
 * carrying the same label onto one row and hands the second citation's PMID to
 * the first (#113); and a `|` inside it shifts the pipe-delimited field layout
 * of the submitted line, so NCBI's echoed row no longer reconciles and a
 * citation it matched comes back as not_found (#125). Keeping the label off the
 * wire entirely removes both.
 */
function wireKeyFor(index: number): string {
  return String(index + 1);
}

/** One submitted citation as an ECitMatch `bdata` line. */
function bdataLine(c: ECitMatchCitation, index: number): string {
  return `${c.journal ?? ''}|${c.year ?? ''}|${c.volume ?? ''}|${c.firstPage ?? ''}|${c.authorName ?? ''}|${wireKeyFor(index)}|`;
}

/** ECitMatch's response rows, each carrying the wire key its line was submitted under. */
function parseECitMatchRows(text: string): ECitMatchResult[] {
  return text
    .split(/[\r\n]+/)
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      const parts = line.split('|');
      const key = parts[5]?.trim() ?? '';
      const rawOutcome = parts[6]?.trim() ?? '';

      if (/^\d+$/.test(rawOutcome)) {
        return { key, matched: true, pmid: rawOutcome, status: 'matched' as const };
      }

      if (rawOutcome.startsWith('AMBIGUOUS')) {
        const csv = /^AMBIGUOUS\s+([\d,\s]+)/.exec(rawOutcome)?.[1];
        const candidatePmids = csv
          ? csv
              .split(',')
              .map((p) => p.trim())
              .filter((p) => /^\d+$/.test(p))
          : undefined;
        return {
          key,
          matched: false,
          pmid: null,
          status: 'ambiguous' as const,
          detail: rawOutcome,
          ...(candidatePmids?.length && { candidatePmids }),
        };
      }

      return {
        key,
        matched: false,
        pmid: null,
        status: 'not_found' as const,
        ...(rawOutcome && { detail: rawOutcome }),
      };
    });
}

/** One `<SpelledQuery>` child: the caller's own text, or ESpell's replacement for a span of it. */
export interface SpelledSegment {
  kind: 'Original' | 'Replaced';
  text: string;
}

/** A span of the caller's text, `[start, end)`, and the replacement written over it. */
interface SpelledReplacement {
  end: number;
  replacement: string;
  start: number;
}

/**
 * Whether `a` is within `k` single-character edits of `b`. At the first
 * mismatch any edit script must substitute, delete, or insert there, so three
 * branches per edit cover it: at most 13 linear scans for `k = 2`.
 */
function withinEdits(a: string, b: string, k: number): boolean {
  if (Math.abs(a.length - b.length) > k) return false;
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  if (i === a.length && i === b.length) return true;
  if (k === 0) return false;
  const restA = a.slice(i);
  const restB = b.slice(i);
  return (
    withinEdits(restA.slice(1), restB.slice(1), k - 1) ||
    withinEdits(restA.slice(1), restB, k - 1) ||
    withinEdits(restA, restB.slice(1), k - 1)
  );
}

/**
 * What to do with ESpell's replacement for one span of the caller's text: apply
 * it, keep the span as written, or stop replacing. A span with no ASCII letter
 * means ESpell dropped a token (`1918`, `19`, `β`), and every later replacement
 * lands one span early — as it does past a split acronym (`PCR` → `pc r`), which
 * the edit-distance bound catches on the next span. A single letter replaced by
 * another (`q fever` → `c fever`, the initial in `smith q` → `smith t`) carries
 * no spelling evidence, and any one-letter replacement is within two edits of a
 * one-letter span, so it is kept; one grown into a word (`n` → `in`) still
 * applies. (#250)
 */
function judgeReplacement(span: string, replacement: string): 'apply' | 'keep' | 'stop' {
  if (!/[A-Za-z]/.test(span) || replacement === '') return 'stop';
  if (/[\d\u0080-￿]/.test(span)) return 'keep';
  if (span.toLowerCase() === replacement.toLowerCase()) return 'keep';
  if (!/[a-z]/.test(span) && (span.match(/[A-Z]/g)?.length ?? 0) >= 2) return 'keep';
  if (span.length === 1 && replacement.length === 1) return 'keep';
  return withinEdits(span.toLowerCase(), replacement.toLowerCase(), 2) ? 'apply' : 'stop';
}

/** A boolean operator between two clauses; PubMed reads only the uppercase forms as operators. */
const OPERATOR = /\s(?:AND|OR|NOT)\s/y;

/**
 * Every span of `query` the rebuild keeps as written, as `[start, end)`
 * offsets in order: each bracket — a `[`, the next `]`, and the text between —
 * and, before the bracket of an indexed field tag ({@link fieldTagKind}), the
 * value it qualifies. That value is the quoted phrase directly before the `[`,
 * or else the text back to the nearest `AND`, `OR`, `NOT`, parenthesis, earlier
 * bracket, or the query start. A free-text tag (`[tiab]`) and a bracket that is
 * no field tag (`[18F]`) cover only themselves. An unclosed `[` opens no
 * bracket. One forward scan: the text between brackets is read once for
 * boundaries and quotes, and each `indexOf` starts past the last bracket found.
 */
function fieldTagRanges(query: string): [start: number, end: number][] {
  const ranges: [number, number][] = [];
  let scan = 0;
  for (let open = query.indexOf('['); open >= 0; ) {
    const close = query.indexOf(']', open + 1);
    if (close < 0) break;
    // Where a value ending at `open` can start, and the last two quotes before it.
    let boundary = scan;
    let quote = -1;
    let openingQuote = -1;
    for (; scan < open; scan++) {
      const char = query[scan];
      if (char === '(' || char === ')') {
        boundary = scan + 1;
      } else if (char === '"') {
        openingQuote = quote;
        quote = scan;
      } else {
        OPERATOR.lastIndex = scan;
        if (OPERATOR.test(query)) {
          boundary = OPERATOR.lastIndex;
          // Resume on the operator's trailing space, which can open the next one.
          scan = boundary - 2;
        }
      }
    }
    let start = open;
    if (fieldTagKind(query.slice(open + 1, close)) === 'indexed') {
      start = quote === open - 1 && openingQuote >= 0 ? openingQuote : boundary;
    }
    ranges.push([start, close + 1]);
    scan = close + 1;
    open = query.indexOf('[', scan);
  }
  return ranges;
}

/**
 * The replacements in ESpell's suggestion that apply to the caller's own text,
 * in query order. `<CorrectedQuery>` lowercases the query and drops digits,
 * field tags, and operator casing, so it cannot be re-run as written.
 * `<SpelledQuery>` interleaves the caller's text verbatim (`Original`) with
 * replacements (`Replaced`); the caller's text between two `Original`s is the
 * span the `Replaced` between them stands for. A span that overlaps a field tag
 * keeps its text and the rebuild continues past it: ESpell rewrites tag text it
 * doesn't recognize (`risk[tiab] AND alzhiemer` → `risk[tia] AND alzheimer`),
 * and PubMed then ignores the tag (#250). So does a span that overlaps the
 * value of an indexed field ({@link fieldTagRanges}): ESpell's dictionary is
 * not the field's index, and it rewrites correctly spelled values into ones the
 * field doesn't hold (`free full text[sb]` → `fred full text[sb]`, `aged[mh]` →
 * `age[mh]`); a free-text field's value (`diabetis[tiab]`) is corrected like
 * any other text (#259). Spans that hold a digit or non-ASCII character, are
 * all uppercase, differ only in case, or are one letter replaced by one letter
 * also keep their text; the first span that can't be placed or judged ends the
 * rebuild, and the caller's text runs unchanged from there. Linear in the query
 * and the segments. (#241)
 */
function spelledReplacements(
  query: string,
  segments: readonly SpelledSegment[],
): SpelledReplacement[] {
  const applied: SpelledReplacement[] = [];
  let cursor = 0;
  let pending: string | undefined;

  const tags = fieldTagRanges(query);
  let tagIndex = 0;
  /**
   * Whether `query[start, end)` overlaps a field tag or an indexed value. Spans
   * arrive in query order, so a range that ends at or before `start` can't
   * touch a later span and the index only moves forward.
   */
  const overlapsTag = (start: number, end: number): boolean => {
    let tag = tags[tagIndex];
    while (tag && tag[1] <= start) tag = tags[++tagIndex];
    return tag !== undefined && tag[0] < end;
  };

  /** Settle the pending replacement against `query[cursor, end)`; false stops the rebuild. */
  const settle = (end: number): boolean => {
    if (pending === undefined) return true;
    const verdict = overlapsTag(cursor, end)
      ? 'keep'
      : judgeReplacement(query.slice(cursor, end), pending);
    if (verdict === 'stop') return false;
    if (verdict === 'apply') applied.push({ start: cursor, end, replacement: pending });
    cursor = end;
    pending = undefined;
    return true;
  };

  for (const segment of segments) {
    if (segment.kind === 'Replaced') {
      if (pending !== undefined) return applied;
      pending = segment.text;
      continue;
    }
    const at =
      pending === undefined
        ? query.startsWith(segment.text, cursor)
          ? cursor
          : -1
        : query.indexOf(segment.text, cursor);
    if (at < 0 || !settle(at)) return applied;
    cursor += segment.text.length;
  }
  settle(query.length);
  return applied;
}

/** `query` with each replacement written over its span; `replacements` are in query order. */
function applyReplacements(query: string, replacements: readonly SpelledReplacement[]): string {
  let corrected = '';
  let cursor = 0;
  for (const { start, end, replacement } of replacements) {
    corrected += query.slice(cursor, start) + replacement;
    cursor = end;
  }
  return corrected + query.slice(cursor);
}

/**
 * ESpell's suggestion rebuilt over the caller's own text: every replacement
 * {@link spelledReplacements} accepts, written in place, before any record-count
 * check. `hasSuggestion` is whether one was.
 *
 * @internal exported for direct unit tests
 */
export function rebuildSpelledQuery(
  query: string,
  segments: readonly SpelledSegment[],
): { corrected: string; hasSuggestion: boolean } {
  const replacements = spelledReplacements(query, segments);
  return {
    corrected: applyReplacements(query, replacements),
    hasSuggestion: replacements.length > 0,
  };
}

/**
 * A replacement with fewer than one PubMed record for every this many of the
 * word it replaces is dropped. Over a 74-query corpus, a good correction's word
 * held at most 1.0002 times its replacement's records — ESearch's automatic term
 * mapping gives many misspellings the count of the word they mean — and a bad
 * one's at least 12 times. (#316)
 */
const RARER_REPLACEMENT_FACTOR = 10;

/** A check's read: the value NCBI gave, or why the check got none. */
type CheckRead<T> = { ok: true; value: T } | { ok: false; reason: ESpellCheckSkipReason };

/** The text of an ordered-parser element: its text children joined, whitespace kept. */
function nodeText(node: JatsNode | undefined): string | undefined {
  return node && childrenOf(node).filter(isTextNode).map(textOf).join('');
}

/**
 * One deadline and one retry allowance shared by every request of a call that
 * sends several, so splitting the call into more requests never extends either.
 */
interface CallBudget {
  /**
   * The call's deadline: NCBI's own, started with the call, or the tool call's when
   * that expires first. `totalMs` is the length an expiry reports.
   */
  readonly deadline: CallDeadline;
  /** Retries the call may still spend; each request's retries come off as it settles. */
  retriesLeft: number;
}

/**
 * The expiry of the deadline a call ran under, `deadlineMs` long: what
 * {@link toServiceError} maps a fired deadline to, and what a call whose deadline is
 * already spent fails with before it sends anything.
 */
function deadlineExceeded(deadlineMs: number, cause?: unknown, ncbiErrors?: unknown): McpError {
  return timeout(
    `NCBI request deadline (${deadlineMs}ms) exceeded`,
    {
      reason: 'ncbi_deadline_exceeded',
      deadlineMs,
      ...(ncbiErrors !== undefined && { ncbiErrors }),
    },
    cause === undefined ? undefined : { cause },
  );
}

/** Ceiling on one backoff sleep, so a high retry count cannot grow it without bound. */
const MAX_BACKOFF_MS = 30_000;

/**
 * Margin added to the time left on the deadline when it is offered to the queue as a
 * wait budget. The queue sheds an arrival whose projected wait exceeds the budget, and
 * separately times out a caller still waiting when the budget runs out; that second
 * timer would otherwise land on the same instant as the deadline itself. Setting it just
 * past the deadline leaves expiry to the deadline, so a call still queued when its time
 * is up always reports `ncbi_deadline_exceeded`, never `queue_full`.
 */
const QUEUE_WAIT_MARGIN_MS = 1;

/**
 * Retry gate: the framework's transient set, narrowed to `McpError`s. The client and
 * response handler classify every upstream failure, so a plain `Error` reaching the
 * loop is a defect or a response that cannot parse — retrying it only repeats it.
 */
const isTransient = (error: unknown): boolean =>
  error instanceof McpError && defaultIsTransient(error);

/**
 * The reason each transient code a retry loop can stop on is reported under. Each is
 * declared for that code alone, so a 504 stays a Timeout and never reads as
 * `ncbi_unreachable`.
 */
const REASON_BY_CODE = new Map<JsonRpcErrorCode, string>([
  [JsonRpcErrorCode.ServiceUnavailable, 'ncbi_unreachable'],
  [JsonRpcErrorCode.Timeout, 'ncbi_timed_out'],
  [JsonRpcErrorCode.RateLimited, 'ncbi_rate_limited'],
]);

/**
 * A retry loop that ran out, reported as its last attempt's failure: that attempt's code
 * under the reason {@link REASON_BY_CODE} names for it, with `endpoint`, `attempts`, and
 * NCBI's `ncbiErrors` and the upstream `retryAfter` when the attempt carried them. A
 * ServiceUnavailable is `ncbi_unreachable`; a Timeout — an HTTP 504, 408, or 425 — is
 * `ncbi_timed_out`; a RateLimited is `ncbi_rate_limited`, its 429's `retryAfter` telling
 * the caller how long to wait. A request the client's per-request timeout ended arrives
 * as the client's ServiceUnavailable, so it is `ncbi_unreachable`.
 */
function retriesSpent(
  last: McpError,
  message: string,
  attempts: number,
  endpoint: string,
  cause: unknown,
): McpError {
  const reason = REASON_BY_CODE.get(last.code);
  return new McpError(
    last.code,
    message,
    {
      ...(reason && { reason }),
      endpoint,
      attempts,
      ...(last.data?.ncbiErrors !== undefined && { ncbiErrors: last.data.ncbiErrors }),
      ...(last.data?.retryAfter !== undefined && { retryAfter: last.data.retryAfter }),
    },
    { cause },
  );
}

/** What {@link toServiceError} needs to know about the retry loop that threw. */
interface LoopOutcome {
  /** Whether that deadline fired — the loop's own signal, never inferred from the error. */
  deadlineFired: boolean;
  /** Length of the deadline the loop ran under: NCBI's own, or the tool call's when it had less left. */
  deadlineMs: number;
  /**
   * Whether the loop was held to one attempt because the endpoint's previous call spent
   * its retries on `ncbi_unreachable`, where it would otherwise have retried. (#287)
   */
  failFast: boolean;
  /**
   * NCBI's diagnostics from the latest attempt that carried any. An expiry that aborts a
   * later attempt in flight or in the queue arrives without them. (#174)
   */
  ncbiErrors: unknown;
}

/**
 * Maps what the retry loop throws onto this service's declared failure reasons. Runs
 * outside the loop, so the loop itself still sees the framework's `pacer_shed` — which
 * it never retries — and `retry_deadline_exceeded`.
 *
 * - `pacer_shed` → `queue_full` (RateLimited), keeping the shed's `retryAfter`.
 * - `retry_deadline_exceeded` with the deadline fired — mid-request, in the queue, or
 *   mid-backoff → `ncbi_deadline_exceeded` (Timeout), with NCBI's `ncbiErrors` from the
 *   latest attempt that carried any, wherever the timer landed.
 * - `retry_deadline_exceeded` with the deadline not fired — the loop stopped because
 *   the next backoff would not fit the time left → retries spent, as below. The error's
 *   own cause or timing cannot tell the two apart (a request aborted mid-flight fails as
 *   the client's ServiceUnavailable, and timers can fire early), so `deadlineFired` — the
 *   loop's own signal — does. (#174)
 * - Retries exhausted → retries spent: the last attempt's code and message (the
 *   framework appends the attempt count) with `endpoint`, `attempts`, `ncbiErrors`, and
 *   `retryAfter`. A fail-fast loop's one attempt also says why it never retried. (#287)
 * - A transient failure never retried → the attempt's own error, `retryAfter` intact,
 *   under the reason {@link REASON_BY_CODE} names for its code: a 429 is
 *   `ncbi_rate_limited`, a 503 `ncbi_unreachable`, a 504 `ncbi_timed_out`. The loop
 *   throws a transient failure unretried only when its `Retry-After` outlasts the time
 *   left or the backoff cap. It carries no `attempts`, so it never arms fail-fast.
 * - Anything else never retried — a non-transient failure, such as a 501 — passes
 *   through unchanged.
 */
function toServiceError(error: unknown, endpoint: string, loop: LoopOutcome): unknown {
  if (!(error instanceof McpError)) return error;
  const data = error.data ?? {};

  if (data.reason === 'pacer_shed') {
    return rateLimited(
      `NCBI request queue is full or cannot start this call before its deadline (${String(data.queueDepth)} requests waiting).`,
      {
        reason: 'queue_full',
        endpoint,
        queueSize: data.queueDepth,
        retryAfter: data.retryAfter,
      },
      { cause: error },
    );
  }

  if (data.reason === 'retry_deadline_exceeded') {
    const last = error.cause;
    const attempts = data.retryAttempts;
    if (!loop.deadlineFired && last instanceof McpError && typeof attempts === 'number') {
      const count = `${attempts} attempt${attempts > 1 ? 's' : ''}`;
      return retriesSpent(
        last,
        `${last.message} (failed after ${count})`,
        attempts,
        endpoint,
        error,
      );
    }
    return deadlineExceeded(loop.deadlineMs, error, loop.ncbiErrors);
  }

  if (typeof data.retryAttempts === 'number') {
    const message =
      loop.failFast && error.cause instanceof McpError
        ? `${error.cause.message} (failed after 1 attempt, without retrying: the previous ${endpoint} call failed on every attempt)`
        : error.message;
    return retriesSpent(error, message, data.retryAttempts, endpoint, error.cause ?? error);
  }
  const reason = REASON_BY_CODE.get(error.code);
  if (reason !== undefined && isTransient(error)) {
    return new McpError(error.code, error.message, { ...data, reason }, { cause: error });
  }
  return error;
}

/**
 * Facade over NCBI's E-utility suite. Each public method corresponds to a
 * single E-utility endpoint.
 *
 * One service serves every caller and tenant in the process, so the endpoints it
 * holds as failing are shared the way the queue's 429 gate is; each
 * `initNcbiService()` builds a service that holds none. (#287)
 */
export class NcbiService {
  /**
   * Endpoints, by their `runPaced` label, whose latest call ended `ncbi_unreachable`
   * with its retries spent. A call to one makes a single attempt; any success on that
   * endpoint removes it.
   */
  private readonly failingEndpoints = new Set<string>();

  constructor(
    private readonly apiClient: NcbiApiClient,
    private readonly queue: Pacer,
    private readonly responseHandler: NcbiResponseHandler,
    private readonly maxRetries: number,
    private readonly totalDeadlineMs: number,
  ) {}

  async eSearch(params: NcbiRequestParams, options?: NcbiCallOptions): Promise<ESearchResult> {
    const response = await this.performRequest<ESearchResponseContainer>('esearch', params, {
      ...options,
      retmode: 'xml',
    });

    const esResult = response.eSearchResult;
    // A well-formed document with another root (an XHTML error page behind an XML
    // prolog) parses cleanly but answers nothing; read past here it is a TypeError.
    if (esResult === undefined) {
      throw serializationError('NCBI ESearch returned a document with no eSearchResult element.', {
        reason: 'ncbi_invalid_response',
        endpoint: 'esearch',
      });
    }
    // Every answer without an `<ERROR>` carries a `<Count>`, which the parser coerces
    // to a number; one missing or not a number, read as zero, reports a false empty
    // result. A `rettype=count` answer legitimately has no `<RetMax>` or `<RetStart>`.
    const count = String(esResult.Count);
    if (!/^\d+$/.test(count)) {
      throw serializationError(
        'NCBI ESearch returned an eSearchResult element with no numeric Count.',
        {
          reason: 'ncbi_invalid_response',
          endpoint: 'esearch',
        },
      );
    }
    const errorList = normalizeDiagnosticList(esResult.ErrorList);
    const warningList = normalizeDiagnosticList(esResult.WarningList);
    return {
      count: Number(count),
      retmax: parseInt(esResult.RetMax, 10) || 0,
      retstart: parseInt(esResult.RetStart, 10) || 0,
      ...(esResult.QueryKey !== undefined && { queryKey: esResult.QueryKey }),
      ...(esResult.WebEnv !== undefined && { webEnv: esResult.WebEnv }),
      idList: (esResult.IdList?.Id ?? []).map(String),
      queryTranslation: esResult.QueryTranslation,
      ...(errorList !== undefined && { errorList }),
      ...(warningList !== undefined && { warningList }),
    };
  }

  async eSummary(params: NcbiRequestParams, options?: NcbiCallOptions): Promise<ESummaryResult> {
    const retmode = params.version === '2.0' && params.retmode === 'json' ? 'json' : 'xml';
    const response = await this.performRequest<ESummaryResponseContainer>('esummary', params, {
      ...options,
      retmode,
    });
    return response.eSummaryResult;
  }

  eFetch<T = { PubmedArticleSet?: XmlPubmedArticleSet }>(
    params: NcbiRequestParams,
    options: NcbiRequestOptions = { retmode: 'xml' },
  ): Promise<T> {
    const usePost =
      options.usePost || (typeof params.id === 'string' && params.id.split(',').length > 200);
    return this.performRequest<T>('efetch', params, { ...options, usePost });
  }

  eLink<T = Record<string, unknown>>(
    params: NcbiRequestParams,
    options?: NcbiCallOptions,
  ): Promise<T> {
    return this.performRequest<T>('elink', params, { ...options, retmode: 'xml' });
  }

  /**
   * ESpell's correction of a PubMed query, rebuilt over the caller's text
   * ({@link spelledReplacements}) with each replacement checked against PubMed
   * ({@link checkReplacements}). A query ESpell leaves as written costs this one
   * request, which runs under the tool call's `deadline`; checking the replacements
   * of one that it changes costs at most {@link ESPELL_CHECK_MAX_REQUESTS} more,
   * within {@link ESPELL_CHECK_TIME_LIMIT_MS} or the time the deadline has left,
   * whichever is less. A check that cannot run degrades and is reported in
   * `skippedChecks`; the caller's abort rejects.
   */
  async eSpell(params: NcbiRequestParams, options?: NcbiCallOptions): Promise<ESpellResult> {
    const { original, segments } = await this.spelledQuery(params, options);
    const replacements = spelledReplacements(original, segments);
    const { applied, skippedChecks } =
      replacements.length > 0
        ? await this.checkReplacements(original, replacements, options)
        : { applied: replacements, skippedChecks: [] };
    const corrected = applyReplacements(original, applied);
    const hasSuggestion = applied.length > 0;

    logger.debug(
      'ESpell result parsed.',
      requestContextService.createRequestContext({
        operation: 'NcbiESpell',
        additionalContext: {
          original,
          corrected,
          hasSuggestion,
          skippedChecks: skippedChecks.length,
        },
      }),
    );

    return {
      original,
      corrected,
      hasSuggestion,
      ...(skippedChecks.length > 0 && { skippedChecks }),
    };
  }

  /** One ESpell request: the query as ESpell echoed it, and its `<SpelledQuery>` segments in order. */
  private async spelledQuery(
    params: NcbiRequestParams,
    options: NcbiCallOptions | undefined,
  ): Promise<{ original: string; segments: SpelledSegment[] }> {
    // The ordered parser keeps `<SpelledQuery>`'s segments in document order with
    // their whitespace, and keeps every value text: ESpell echoes the caller's
    // term in `<Query>`, and a coercing parse turns `007` / `1e5` / `33306283`
    // into numbers before this method runs. (#108, #241)
    const response = await this.performRequest<JatsNodeList>('espell', params, {
      ...options,
      retmode: 'xml',
      useOrderedParser: true,
    });

    const spellResult = findOne(response, 'eSpellResult');
    // A well-formed document with another root parses cleanly, and read past here it
    // answers "nothing to correct".
    if (spellResult === undefined) {
      throw serializationError('NCBI ESpell returned a document with no eSpellResult element.', {
        reason: 'ncbi_invalid_response',
        endpoint: 'espell',
      });
    }
    const original = nodeText(findOne(spellResult, 'Query')) ?? String(params.term ?? '');
    const segments = childrenOf(findOne(spellResult, 'SpelledQuery') ?? {}).flatMap(
      (node): SpelledSegment[] => {
        const kind = tagNameOf(node);
        return kind === 'Original' || kind === 'Replaced'
          ? [{ kind, text: nodeText(node) ?? '' }]
          : [];
      },
    );
    return { original, segments };
  }

  /**
   * Checks ESpell's `db=pubmed` replacements against PubMed, in query order
   * (#316). ESpell's dictionary is built from PubMed text, typos included, so it
   * can rewrite a correctly spelled word into one PubMed barely holds
   * (`tirzepatide` → `irzepatide`). Each replacement's ESearch record count is
   * compared with the caller's word's, both sent as the bare word with automatic
   * term mapping on; one under a tenth of it ({@link RARER_REPLACEMENT_FACTOR})
   * is dropped and the caller's word kept. For dropped words alone, ESpell's
   * `db=mesh` dictionary is then asked once for the whole query, and its
   * replacement for a dropped word's exact span is used when PubMed holds more
   * records of it than of the caller's word. ESearch gives no per-term counts for
   * a query of several terms, so each count is its own request; one already
   * counted in this call is not sent again.
   *
   * Every read goes through the shared queue, at most
   * {@link ESPELL_CHECK_MAX_REQUESTS} of them, all under one bound this method
   * owns (its timer and the signal joined with the caller's):
   * {@link ESPELL_CHECK_TIME_LIMIT_MS}, or the time the tool call's `deadline` has
   * left when that is less. The reads take that bound in place of the deadline, so
   * whichever of the two ends the checks, they end the same way; a spent deadline
   * leaves them no time at all. Once a read would pass the cap or the bound runs
   * out, nothing after it is checked: a replacement left unchecked is applied as
   * ESpell wrote it, and a dropped word left without its `db=mesh` lookup stays as
   * written. A read that fails with a classified NCBI error degrades the same way
   * for that word alone. Each is reported in `skippedChecks`. The caller's abort
   * rejects with its reason, and any other error rejects as thrown.
   */
  private async checkReplacements(
    query: string,
    replacements: readonly SpelledReplacement[],
    options: NcbiCallOptions | undefined,
  ): Promise<{ applied: SpelledReplacement[]; skippedChecks: ESpellSkippedCheck[] }> {
    const callerSignal = options?.signal;
    const limit = upstreamBound(ESPELL_CHECK_TIME_LIMIT_MS, options?.deadline);
    const bound = new AbortController();
    if (limit.spent) bound.abort();
    const timer = limit.spent ? undefined : setTimeout(() => bound.abort(), limit.remainingMs);
    const signal = callerSignal ? AbortSignal.any([callerSignal, bound.signal]) : bound.signal;
    const counts = new Map<string, number>();
    let sent = 0;
    let stopped: ESpellCheckSkipReason | undefined;

    /**
     * Why the checks have ended, once they have: the bound ran out, or `requests` more
     * would pass the cap. A cancelled caller rejects instead, even where no read is left
     * to observe it, as on a spent deadline.
     */
    const halted = (requests: number): ESpellCheckSkipReason | undefined => {
      callerSignal?.throwIfAborted();
      if (stopped === undefined && bound.signal.aborted) stopped = 'time_limit';
      if (stopped === undefined && sent + requests > ESPELL_CHECK_MAX_REQUESTS) {
        stopped = 'request_cap';
      }
      return stopped;
    };
    /** How many of `terms` this call has not counted yet. */
    const uncounted = (...terms: string[]): number =>
      new Set(terms.filter((term) => !counts.has(term))).size;

    const read = async <T>(run: (signal: AbortSignal) => Promise<T>): Promise<CheckRead<T>> => {
      sent += 1;
      try {
        return { ok: true, value: await run(signal) };
      } catch (error: unknown) {
        if (callerSignal?.aborted) throw callerSignal.reason;
        if (bound.signal.aborted) {
          stopped = 'time_limit';
          return { ok: false, reason: stopped };
        }
        if (error instanceof McpError) return { ok: false, reason: 'request_failed' };
        throw error;
      }
    };
    const count = async (term: string): Promise<CheckRead<number>> => {
      const known = counts.get(term);
      if (known !== undefined) return { ok: true, value: known };
      const got = await read((s) =>
        this.eSearch({ db: 'pubmed', term, rettype: 'count' }, { signal: s }),
      );
      if (!got.ok) return got;
      counts.set(term, got.value.count);
      return { ok: true, value: got.value.count };
    };

    // What each replacement's span becomes; `undefined` keeps the caller's word.
    const chosen: (string | undefined)[] = replacements.map((r) => r.replacement);
    const dropped: { index: number; span: SpelledReplacement; word: string; wordCount: number }[] =
      [];
    const skippedChecks: ESpellSkippedCheck[] = [];

    try {
      for (const [index, span] of replacements.entries()) {
        const word = query.slice(span.start, span.end);
        const skip = (reason: ESpellCheckSkipReason) =>
          skippedChecks.push({ check: 'count', word, replacement: span.replacement, reason });

        const stop = halted(uncounted(word, span.replacement));
        if (stop) {
          skip(stop);
          continue;
        }
        const wordCount = await count(word);
        if (!wordCount.ok) {
          skip(wordCount.reason);
          continue;
        }
        // No replacement is rarer than a word PubMed holds no record of.
        if (wordCount.value === 0) continue;
        const replacementCount = await count(span.replacement);
        if (!replacementCount.ok) {
          skip(replacementCount.reason);
          continue;
        }
        if (replacementCount.value * RARER_REPLACEMENT_FACTOR < wordCount.value) {
          chosen[index] = undefined;
          dropped.push({ index, span, word, wordCount: wordCount.value });
        }
      }

      if (dropped.length > 0) {
        const keep = (entry: (typeof dropped)[number], reason: ESpellCheckSkipReason) =>
          skippedChecks.push({
            check: 'mesh',
            word: entry.word,
            replacement: entry.span.replacement,
            reason,
          });

        const stop = halted(1);
        const mesh: CheckRead<{ segments: SpelledSegment[] }> = stop
          ? { ok: false, reason: stop }
          : await read((s) => this.spelledQuery({ db: 'mesh', term: query }, { signal: s }));
        if (!mesh.ok) {
          for (const entry of dropped) keep(entry, mesh.reason);
        } else {
          const meshByStart = new Map(
            spelledReplacements(query, mesh.value.segments).map((r) => [r.start, r]),
          );
          for (const entry of dropped) {
            const candidate = meshByStart.get(entry.span.start);
            // The MeSH dictionary offers no replacement for this exact span.
            if (candidate?.end !== entry.span.end) continue;
            const meshStop = halted(uncounted(candidate.replacement));
            if (meshStop) {
              keep(entry, meshStop);
              continue;
            }
            const candidateCount = await count(candidate.replacement);
            if (!candidateCount.ok) {
              keep(entry, candidateCount.reason);
              continue;
            }
            if (candidateCount.value > entry.wordCount) chosen[entry.index] = candidate.replacement;
          }
        }
      }
    } finally {
      clearTimeout(timer);
    }

    const applied = replacements.flatMap((span, i) => {
      const replacement = chosen[i];
      return replacement === undefined ? [] : [{ ...span, replacement }];
    });
    return { applied, skippedChecks };
  }

  eInfo(params: NcbiRequestParams, options?: NcbiCallOptions): Promise<unknown> {
    return this.performRequest('einfo', params, { ...options, retmode: 'xml' });
  }

  /**
   * Look up PMIDs from partial citation strings via NCBI ECitMatch.
   * Each citation can include journal, year, volume, first page, and author name.
   *
   * Results come back one per submitted citation, in submission order, carrying
   * the caller's `key`. Correlation runs on the wire key (see
   * {@link wireKeyFor}), never on `key` itself — that label is caller-supplied,
   * so it may repeat and may carry characters that break the wire format.
   * (#113, #125)
   *
   * A journal-less citation ECitMatch finds no candidate for ends the response:
   * that line and every line after it come back with no row. So the response
   * stops at the line after the last one answered; that line is reported
   * `not_found`, and the lines after it are requested again without it, until
   * every line has a result. A complete response costs one request, each
   * dropped line at most one more — 25 requests for 25 such citations. Every
   * request draws on one deadline and one retry allowance for the whole call; the
   * deadline is NCBI's own, or the tool call's `deadline` when that expires first.
   * A line with no row ahead of one that has a row is not a stop and is never
   * re-requested; it stays `not_found`, as every missing row did before. (#54, #193)
   */
  async eCitMatch(
    citations: ECitMatchCitation[],
    options?: NcbiCallOptions,
  ): Promise<ECitMatchResult[]> {
    const bound = upstreamBound(this.totalDeadlineMs, options?.deadline);
    const budget: CallBudget = {
      deadline: { expiresAt: Date.now() + bound.remainingMs, totalMs: bound.deadlineMs },
      retriesLeft: this.maxRetries,
    };
    const rowByIndex = new Map<number, ECitMatchResult>();
    let pending = citations.map((citation, index) => ({ citation, index }));

    while (pending.length > 0) {
      const bdata = pending.map(({ citation, index }) => bdataLine(citation, index)).join('\r');
      const text = await this.performRequest<string>(
        'ecitmatch.cgi',
        { db: 'pubmed', retmode: 'xml', bdata },
        { retmode: 'text', ...(options?.signal && { signal: options.signal }) },
        budget,
      );

      // Reconcile on the wire key each line was submitted under — unique within
      // the call, so one row can never stand in for a second citation. The line
      // after the last one answered is where the response stopped: it keeps no
      // row, and only the lines after it go out again.
      const rowByWireKey = new Map(parseECitMatchRows(text).map((r) => [r.key, r]));
      let lastAnswered = -1;
      for (const [position, { index }] of pending.entries()) {
        const row = rowByWireKey.get(wireKeyFor(index));
        if (!row) continue;
        rowByIndex.set(index, row);
        lastAnswered = position;
      }
      pending = pending.slice(lastAnswered + 2);
    }

    // Every input gets a result row, so callers can rely on results.length ===
    // citations.length and on results[i] describing citations[i]; the caller's
    // label is restored on the way out. (#54, #113, #125)
    return citations.map((c, i): ECitMatchResult => {
      const row = rowByIndex.get(i);
      return row
        ? { ...row, key: c.key }
        : { key: c.key, matched: false, pmid: null, status: 'not_found' as const };
    });
  }

  /**
   * Convert between article identifiers (DOI, PMID, PMCID) using the PMC ID Converter API.
   * Accepts up to 200 IDs in a single request. Only works for articles in PMC.
   */
  async idConvert(
    ids: string[],
    idtype?: string,
    options?: NcbiCallOptions,
  ): Promise<IdConvertRecord[]> {
    // A comma is the ID Converter's list delimiter in every encoding, so an
    // element carrying one is indistinguishable from two submitted IDs: the
    // upstream answers 200 with more records than were submitted and the
    // one-record-per-input contract breaks. Reject at the service boundary so
    // no caller can reach the splitting behavior, whichever tool built the
    // input. (#120)
    const packed = ids.find((id) => id.includes(','));
    if (packed !== undefined) {
      throw validationError(
        `PMC ID Converter identifier "${packed}" contains a comma, which the API reads as a list delimiter. Submit one identifier per array element.`,
        { idType: idtype, idCount: ids.length },
      );
    }

    // The PMC ID Converter rejects an entire batch (HTTP 400) when PMC-prefixed
    // and bare-digit PMCIDs are mixed, even though it accepts each form on its
    // own. Canonicalize bare digits to "PMC"+digits so every pmcid batch is
    // homogeneous and resolves like a same-format one. (#73)
    const normalizedIds =
      idtype === 'pmcid'
        ? ids.map((id) => {
            const trimmed = id.trim();
            return /^\d+$/.test(trimmed) ? `PMC${trimmed}` : trimmed;
          })
        : ids;
    const params: NcbiRequestParams = {
      ids: normalizedIds.join(','),
      format: 'json',
      ...(idtype && { idtype }),
    };

    let text: string;
    try {
      text = await this.runPaced('idconv', options, (signal) =>
        this.apiClient.makeExternalRequest(NCBI_PMC_IDCONV_URL, params, signal),
      );
    } catch (error: unknown) {
      // PMC ID Converter returns 400 (InvalidParams) for malformed inputs, with
      // an HTML/text page as its body. Rewrite the message with idType-specific
      // guidance, keeping the InvalidParams code every other NCBI 400 carries;
      // the page stays on the cause, server-side.
      if (error instanceof McpError && error.code === JsonRpcErrorCode.InvalidParams) {
        const hint = ID_CONVERT_FORMAT_HINTS[idtype ?? ''];
        const message = hint
          ? `PMC ID Converter rejected one or more inputs as malformed (idType="${idtype}"). Expected: ${hint}.`
          : `PMC ID Converter rejected the input as malformed (idType="${idtype ?? 'unspecified'}").`;
        throw invalidParams(message, { idType: idtype, idCount: ids.length }, { cause: error });
      }
      throw error;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error: unknown) {
      throw serializationError(
        'Failed to parse ID Converter JSON response.',
        {
          reason: 'ncbi_invalid_response',
          responseSnippet: text.substring(0, 200),
        },
        { cause: error },
      );
    }

    return (parsed as IdConvertResponse).records ?? [];
  }

  /**
   * Runs one NCBI call: a retry loop around the shared request queue, so every
   * attempt re-queues and is re-paced (and a 429 closes the gate for all callers,
   * not just this one). One deadline covers queue wait, attempts, and backoff: NCBI's
   * own, or the time the tool call's `deadline` has left when that is less
   * ({@link upstreamBound}), and an expiry reports the length of whichever it was. Its
   * signal — joined with the caller's — reaches the queue wait, the backoff sleep, and
   * the HTTP request, and each attempt offers the queue only the time left, so a call
   * that cannot start in time is shed at once instead of waiting it out. A call that
   * starts on a spent deadline sends nothing and arms no timer: it fails at once as
   * that deadline's expiry.
   *
   * With a `budget`, the request is one of several in a call: its deadline is the
   * budget's, which already holds the earlier of NCBI's and the tool call's, so
   * `deadline` is not read; its retries are the ones the call has not spent, which it
   * then spends from.
   *
   * A caller abort rethrows the caller's own reason, on a spent deadline too; every
   * other failure is mapped onto this service's reasons by {@link toServiceError},
   * after the loop. Once the caller is ruled out, the loop's signal has aborted only if
   * the deadline fired.
   *
   * A call to an endpoint in {@link failingEndpoints}, read once as the call starts,
   * makes one attempt instead of its ladder — unless it had no retries to give up
   * (`NCBI_MAX_RETRIES=0`, or a budget already spent). A call already running keeps
   * its ladder. Success removes the endpoint; a call that ends `ncbi_unreachable` with
   * its retries spent adds it. A caller abort, a deadline expiry, a rate limit, a shed,
   * and a failure that was never retried leave the set as it was. (#287)
   */
  private async runPaced<T>(
    endpoint: string,
    options: NcbiCallOptions | undefined,
    execute: (signal: AbortSignal) => Promise<T>,
    budget?: CallBudget,
  ): Promise<T> {
    const callerSignal = options?.signal;
    const bound = upstreamBound(this.totalDeadlineMs, budget?.deadline ?? options?.deadline);
    // `withRetry` still calls its function once on a 0 ms deadline, and the queue starts
    // it, so a spent deadline would still send the request.
    if (bound.spent) {
      throw callerSignal?.aborted ? callerSignal.reason : deadlineExceeded(bound.deadlineMs);
    }
    const allowedRetries = budget?.retriesLeft ?? this.maxRetries;
    const failFast = allowedRetries > 0 && this.failingEndpoints.has(endpoint);
    const maxRetries = failFast ? 0 : allowedRetries;
    let attempt = 0;
    let loopSignal: AbortSignal | undefined;
    let ncbiErrors: unknown;
    try {
      const result = await withRetry(
        ({ signal, remainingMs }) => {
          loopSignal = signal;
          attempt += 1;
          return this.queue
            .run(execute, { signal, maxWaitMs: remainingMs + QUEUE_WAIT_MARGIN_MS })
            .catch((error: unknown) => {
              if (error instanceof McpError && error.data?.ncbiErrors !== undefined) {
                ncbiErrors = error.data.ncbiErrors;
              }
              if (attempt <= maxRetries && isTransient(error)) {
                logger.warning(
                  `NCBI request to ${endpoint} failed on attempt ${attempt} of ${maxRetries + 1}.`,
                  requestContextService.createRequestContext({
                    operation: 'NcbiRetry',
                    additionalContext: {
                      endpoint,
                      attempt,
                      error: error instanceof Error ? error.message : String(error),
                    },
                  }),
                );
              }
              throw error;
            });
        },
        {
          maxRetries,
          maxDelayMs: MAX_BACKOFF_MS,
          deadlineMs: bound.remainingMs,
          isTransient,
          operation: `NCBI ${endpoint}`,
          ...(callerSignal && { signal: callerSignal }),
        },
      );
      this.failingEndpoints.delete(endpoint);
      return result;
    } catch (error: unknown) {
      if (callerSignal?.aborted) throw callerSignal.reason;
      const failure = toServiceError(error, endpoint, {
        deadlineMs: bound.deadlineMs,
        deadlineFired: loopSignal?.aborted === true,
        failFast,
        ncbiErrors,
      });
      // Only a retries-spent failure carries `attempts`; one that ends unreachable arms.
      if (
        failure instanceof McpError &&
        failure.data?.reason === 'ncbi_unreachable' &&
        typeof failure.data.attempts === 'number'
      ) {
        this.failingEndpoints.add(endpoint);
      }
      throw failure;
    } finally {
      if (budget) budget.retriesLeft -= attempt - 1;
    }
  }

  /**
   * One eutils request through {@link runPaced}: fetch, classify, parse. EFetch's
   * all-invalid-ID rejection resolves as the empty set NCBI returns for an unknown
   * ID, and a backend-failure envelope is reclassified as transient so it retries.
   */
  private performRequest<T>(
    endpoint: string,
    params: NcbiRequestParams,
    options?: NcbiRequestOptions,
    budget?: CallBudget,
  ): Promise<T> {
    return this.runPaced(
      endpoint,
      options,
      async (signal) => {
        const text = await this.apiClient
          .makeRequest(endpoint, params, { ...options, signal })
          .catch((error: unknown) => {
            const empty = emptyEFetchResultFor(error, endpoint, params.db);
            if (empty !== undefined) return empty;
            throw reclassifyNcbiHttpError(error, endpoint);
          });
        return this.responseHandler.parseAndHandleResponse<T>(text, endpoint, options);
      },
      budget,
    );
  }
}

// ─── Init / Accessor ────────────────────────────────────────────────────────

let _service: NcbiService | undefined;

/** Initialize the NCBI service. Call from `setup()` in createApp. */
export function initNcbiService(): void {
  const config = getServerConfig();
  const apiClient = new NcbiApiClient({
    toolIdentifier: config.toolIdentifier,
    timeoutMs: config.timeoutMs,
    ...(config.apiKey && { apiKey: config.apiKey }),
    ...(config.adminEmail && { adminEmail: config.adminEmail }),
  });
  const queue = createNcbiRequestQueue({
    minStartGapMs: config.requestDelayMs,
    maxConcurrent: config.maxConcurrent,
  });
  const responseHandler = new NcbiResponseHandler();
  _service = new NcbiService(
    apiClient,
    queue,
    responseHandler,
    config.maxRetries,
    config.totalDeadlineMs,
  );
  logger.info(
    'NCBI service initialized.',
    requestContextService.createRequestContext({
      operation: 'NcbiInit',
      additionalContext: {
        toolIdentifier: config.toolIdentifier,
        // A log key containing `apiKey` (e.g. `hasApiKey`) is redacted to `[REDACTED]`.
        ncbiKeyConfigured: !!config.apiKey,
        requestDelayMs: config.requestDelayMs,
        maxConcurrent: config.maxConcurrent,
        totalDeadlineMs: config.totalDeadlineMs,
      },
    }),
  );
}

/** Get the initialized NCBI service. Throws if not initialized. */
export function getNcbiService(): NcbiService {
  if (!_service) throw new Error('NCBI service not initialized. Call initNcbiService() first.');
  return _service;
}
