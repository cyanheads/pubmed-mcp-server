/**
 * @fileoverview High-level service for interacting with NCBI E-utilities.
 * Orchestrates the API client, request queue, and response handler to provide
 * typed methods for each E-utility endpoint. Every call runs as a retry loop around
 * the shared request queue — each attempt re-queued and re-paced — under one total
 * deadline that covers queue wait, attempts, and backoff. Uses init/accessor pattern.
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
import { NcbiApiClient } from './api-client.js';
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
  type ESpellResult,
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
 * the edit-distance bound catches on the next span.
 */
function judgeReplacement(span: string, replacement: string): 'apply' | 'keep' | 'stop' {
  if (!/[A-Za-z]/.test(span) || replacement === '') return 'stop';
  if (/[\d\u0080-￿]/.test(span)) return 'keep';
  if (span.toLowerCase() === replacement.toLowerCase()) return 'keep';
  if (!/[a-z]/.test(span) && (span.match(/[A-Z]/g)?.length ?? 0) >= 2) return 'keep';
  return withinEdits(span.toLowerCase(), replacement.toLowerCase(), 2) ? 'apply' : 'stop';
}

/**
 * Rebuild ESpell's suggestion over the caller's own text. `<CorrectedQuery>`
 * lowercases the query and drops digits, field tags, and operator casing, so it
 * cannot be re-run as written. `<SpelledQuery>` interleaves the caller's text
 * verbatim (`Original`) with replacements (`Replaced`); the caller's text between
 * two `Original`s is the span the `Replaced` between them stands for. Spans that
 * hold a digit or non-ASCII character, are all uppercase, or differ only in case
 * keep their text; the first span that can't be placed or judged ends the
 * rebuild, and the caller's text runs unchanged from there. Linear in the query
 * and the segments. (#241)
 *
 * @internal exported for direct unit tests
 */
export function rebuildSpelledQuery(
  query: string,
  segments: readonly SpelledSegment[],
): { corrected: string; hasSuggestion: boolean } {
  let corrected = '';
  let cursor = 0;
  let hasSuggestion = false;
  let pending: string | undefined;
  const finish = () => ({ corrected: corrected + query.slice(cursor), hasSuggestion });

  /** Settle the pending replacement against `query[cursor, end)`; false stops the rebuild. */
  const settle = (end: number): boolean => {
    if (pending === undefined) return true;
    const span = query.slice(cursor, end);
    const verdict = judgeReplacement(span, pending);
    if (verdict === 'stop') return false;
    corrected += verdict === 'apply' ? pending : span;
    hasSuggestion ||= verdict === 'apply';
    cursor = end;
    pending = undefined;
    return true;
  };

  for (const segment of segments) {
    if (segment.kind === 'Replaced') {
      if (pending !== undefined) return finish();
      pending = segment.text;
      continue;
    }
    const at =
      pending === undefined
        ? query.startsWith(segment.text, cursor)
          ? cursor
          : -1
        : query.indexOf(segment.text, cursor);
    if (at < 0 || !settle(at)) return finish();
    corrected += segment.text;
    cursor += segment.text.length;
  }
  settle(query.length);
  return finish();
}

/** The text of an ordered-parser element: its text children joined, whitespace kept. */
function nodeText(node: JatsNode | undefined): string | undefined {
  return node && childrenOf(node).filter(isTextNode).map(textOf).join('');
}

/**
 * One deadline and one retry allowance shared by every request of a call that
 * sends several, so splitting the call into more requests never extends either.
 */
interface CallBudget {
  /** `Date.now()` at which the call's deadline expires. */
  readonly expiresAt: number;
  /** Retries the call may still spend; each request's retries come off as it settles. */
  retriesLeft: number;
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

/** The reason each code a retry loop can end on is stamped with; a Timeout gets none. */
const REASON_BY_CODE = new Map<JsonRpcErrorCode, string>([
  [JsonRpcErrorCode.ServiceUnavailable, 'ncbi_unreachable'],
  [JsonRpcErrorCode.RateLimited, 'ncbi_rate_limited'],
]);

/**
 * A retry loop that ran out, reported as its last attempt's failure: that attempt's
 * code with `endpoint`, `attempts`, and NCBI's `ncbiErrors` when the attempt carried
 * them. A ServiceUnavailable is stamped `ncbi_unreachable`; a RateLimited is stamped
 * `ncbi_rate_limited` and keeps the `retryAfter` its 429 named; a Timeout keeps its
 * code with no reason.
 */
function retriesSpent(
  last: McpError,
  message: string,
  attempts: number,
  endpoint: string,
  cause: unknown,
): McpError {
  const reason = REASON_BY_CODE.get(last.code);
  const retryAfter = last.code === JsonRpcErrorCode.RateLimited ? last.data?.retryAfter : undefined;
  return new McpError(
    last.code,
    message,
    {
      ...(reason && { reason }),
      endpoint,
      attempts,
      ...(last.data?.ncbiErrors !== undefined && { ncbiErrors: last.data.ncbiErrors }),
      ...(retryAfter !== undefined && { retryAfter }),
    },
    { cause },
  );
}

/** What {@link toServiceError} needs to know about the retry loop that threw. */
interface LoopOutcome {
  /** Whether that deadline fired — the loop's own signal, never inferred from the error. */
  deadlineFired: boolean;
  /** The loop's total deadline. */
  deadlineMs: number;
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
 *   framework appends the attempt count) with `endpoint`, `attempts`, and `ncbiErrors`.
 * - A 429 never retried because its `Retry-After` outlasts the time left or the backoff
 *   cap → the attempt's own error, stamped `ncbi_rate_limited`.
 * - Anything else — a failure that was never retried — passes through unchanged.
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
    return timeout(
      `NCBI request deadline (${loop.deadlineMs}ms) exceeded`,
      {
        reason: 'ncbi_deadline_exceeded',
        deadlineMs: loop.deadlineMs,
        ...(loop.ncbiErrors !== undefined && { ncbiErrors: loop.ncbiErrors }),
      },
      { cause: error },
    );
  }

  if (typeof data.retryAttempts === 'number') {
    return retriesSpent(error, error.message, data.retryAttempts, endpoint, error.cause ?? error);
  }
  if (error.code === JsonRpcErrorCode.RateLimited) {
    return new McpError(
      error.code,
      error.message,
      { ...data, reason: 'ncbi_rate_limited' },
      { cause: error },
    );
  }
  return error;
}

/**
 * Facade over NCBI's E-utility suite. Each public method corresponds to a
 * single E-utility endpoint.
 */
export class NcbiService {
  constructor(
    private readonly apiClient: NcbiApiClient,
    private readonly queue: Pacer,
    private readonly responseHandler: NcbiResponseHandler,
    private readonly maxRetries: number,
    private readonly totalDeadlineMs: number,
  ) {}

  async eSearch(params: NcbiRequestParams, options?: NcbiCallOptions): Promise<ESearchResult> {
    const response = await this.performRequest<ESearchResponseContainer>('esearch', params, {
      retmode: 'xml',
      ...(options?.signal && { signal: options.signal }),
    });

    const esResult = response.eSearchResult;
    const errorList = normalizeDiagnosticList(esResult.ErrorList);
    const warningList = normalizeDiagnosticList(esResult.WarningList);
    return {
      count: parseInt(esResult.Count, 10) || 0,
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
      retmode,
      ...(options?.signal && { signal: options.signal }),
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
    return this.performRequest<T>('elink', params, {
      retmode: 'xml',
      ...(options?.signal && { signal: options.signal }),
    });
  }

  async eSpell(params: NcbiRequestParams, options?: NcbiCallOptions): Promise<ESpellResult> {
    // The ordered parser keeps `<SpelledQuery>`'s segments in document order with
    // their whitespace, and keeps every value text: ESpell echoes the caller's
    // term in `<Query>`, and a coercing parse turns `007` / `1e5` / `33306283`
    // into numbers before this method runs. (#108, #241)
    const response = await this.performRequest<JatsNodeList>('espell', params, {
      retmode: 'xml',
      useOrderedParser: true,
      ...(options?.signal && { signal: options.signal }),
    });

    const spellResult = findOne(response, 'eSpellResult');
    const original = nodeText(findOne(spellResult, 'Query')) ?? String(params.term ?? '');
    const segments = childrenOf(findOne(spellResult, 'SpelledQuery') ?? {}).flatMap(
      (node): SpelledSegment[] => {
        const kind = tagNameOf(node);
        return kind === 'Original' || kind === 'Replaced'
          ? [{ kind, text: nodeText(node) ?? '' }]
          : [];
      },
    );
    const { corrected, hasSuggestion } = rebuildSpelledQuery(original, segments);

    logger.debug(
      'ESpell result parsed.',
      requestContextService.createRequestContext({
        operation: 'NcbiESpell',
        additionalContext: { original, corrected, hasSuggestion },
      }),
    );

    return { original, corrected, hasSuggestion };
  }

  eInfo(params: NcbiRequestParams, options?: NcbiCallOptions): Promise<unknown> {
    return this.performRequest('einfo', params, {
      retmode: 'xml',
      ...(options?.signal && { signal: options.signal }),
    });
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
   * request draws on one deadline and one retry allowance for the whole call.
   * A line with no row ahead of one that has a row is not a stop and is never
   * re-requested; it stays `not_found`, as every missing row did before. (#54, #193)
   */
  async eCitMatch(
    citations: ECitMatchCitation[],
    options?: NcbiCallOptions,
  ): Promise<ECitMatchResult[]> {
    const budget: CallBudget = {
      expiresAt: Date.now() + this.totalDeadlineMs,
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
      text = await this.runPaced('idconv', options?.signal, (signal) =>
        this.apiClient.makeExternalRequest(NCBI_PMC_IDCONV_URL, params, signal),
      );
    } catch (error: unknown) {
      // PMC ID Converter returns 400 (InvalidParams) for malformed inputs and
      // leaks the upstream HTML/text body into `data.body`. Rewrite the message
      // with idType-specific guidance and drop the leaky body, keeping the
      // InvalidParams code every other NCBI 400 carries.
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
   * not just this one). One deadline covers queue wait, attempts, and backoff. Its
   * signal — joined with the caller's — reaches the queue wait, the backoff sleep,
   * and the HTTP request, and each attempt offers the queue only the time left, so
   * a call that cannot start in time is shed at once instead of waiting it out.
   *
   * With a `budget`, the request is one of several in a call: its deadline is the
   * time the call has left and its retries are the ones the call has not spent,
   * which it then spends from. A failure is still reported against the call's
   * full deadline.
   *
   * A caller abort rethrows the caller's own reason; every other failure is mapped
   * onto this service's reasons by {@link toServiceError}, after the loop. Once the
   * caller is ruled out, the loop's signal has aborted only if the deadline fired.
   */
  private async runPaced<T>(
    endpoint: string,
    callerSignal: AbortSignal | undefined,
    execute: (signal: AbortSignal) => Promise<T>,
    budget?: CallBudget,
  ): Promise<T> {
    const maxRetries = budget?.retriesLeft ?? this.maxRetries;
    let attempt = 0;
    let loopSignal: AbortSignal | undefined;
    let ncbiErrors: unknown;
    try {
      return await withRetry(
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
          deadlineMs: budget ? Math.max(0, budget.expiresAt - Date.now()) : this.totalDeadlineMs,
          isTransient,
          operation: `NCBI ${endpoint}`,
          ...(callerSignal && { signal: callerSignal }),
        },
      );
    } catch (error: unknown) {
      if (callerSignal?.aborted) throw callerSignal.reason;
      throw toServiceError(error, endpoint, {
        deadlineMs: this.totalDeadlineMs,
        deadlineFired: loopSignal?.aborted === true,
        ncbiErrors,
      });
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
      options?.signal,
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
