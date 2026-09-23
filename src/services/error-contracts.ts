/**
 * @fileoverview Canonical error contracts. Single source of truth for the
 * failure modes services throw and tools declare in `errors[]`, plus the
 * input rejections shared by the tools that forward a free-text query
 * upstream.
 *
 * Service-layer code can't reach `ctx.recoveryFor` (no Context), so it spreads
 * `recoveryFor(reason)` from this module into the error factory's `data` arg.
 * The framework mirrors `data.recovery.hint` into the wire payload's
 * `content[]` text, so clients get the same actionable hint they would from a
 * handler-level `ctx.fail`.
 *
 * Tool definitions import the contract arrays directly and spread them into
 * their `errors: [...]` declarations to surface the failure modes to the LLM.
 * Every service-array entry carries `thrownBy: 'service'` so the linter's
 * `error-contract-unthrown` check skips it while still checking the handler's
 * own reasons. Spread a service array only into a tool whose handler lets that
 * service's errors propagate — a tool that catches them all never produces
 * those reasons.
 *
 * @module src/services/error-contracts
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';

/**
 * Failure modes the NCBI service layer can surface. Tools whose handler lets
 * `getNcbiService()` failures propagate spread these into their own `errors[]`
 * so the declared contract matches what actually reaches the wire.
 */
export const NCBI_SERVICE_ERRORS = [
  {
    reason: 'queue_full',
    code: JsonRpcErrorCode.RateLimited,
    when: 'The local NCBI request queue shed the call — the queue is full, or the call cannot start before its total deadline (for example behind the cooldown that follows an NCBI 429).',
    recovery:
      'Wait the number of seconds in `retryAfter`, then retry; the NCBI request queue is saturated or cooling down after a rate limit.',
    retryable: true,
    thrownBy: 'service',
  },
  {
    reason: 'ncbi_unreachable',
    code: JsonRpcErrorCode.ServiceUnavailable,
    when: 'NCBI E-utilities is unreachable after all retry attempts.',
    recovery: 'Retry after a brief delay; NCBI was unreachable across all retry attempts.',
    retryable: true,
    thrownBy: 'service',
  },
  {
    reason: 'ncbi_deadline_exceeded',
    code: JsonRpcErrorCode.Timeout,
    when: 'Total request deadline expired before NCBI returned a response.',
    recovery: 'Reduce batch size or retry; NCBI may be under temporary load.',
    retryable: true,
    thrownBy: 'service',
  },
  {
    reason: 'ncbi_invalid_response',
    code: JsonRpcErrorCode.SerializationError,
    when: 'NCBI returned a body that could not be parsed (invalid XML/JSON).',
    recovery: 'Retry the request; NCBI returned a malformed response that could not be parsed.',
    retryable: true,
    thrownBy: 'service',
  },
  {
    reason: 'ncbi_resource_not_found',
    code: JsonRpcErrorCode.NotFound,
    when: 'NCBI returned a structured "not found" error for the requested ID(s).',
    recovery:
      'Verify the ID exists in PubMed; the resource was not found in NCBI and retrying will not help.',
    retryable: false,
    thrownBy: 'service',
  },
] as const;

/**
 * Input failure the NCBI query tools reject before any call is made. Declared
 * here rather than inside `NCBI_SERVICE_ERRORS` so only the tools that actually
 * throw it advertise it — a tool that takes no free-text query can never
 * produce it, and declaring it there would advertise a failure mode that
 * cannot happen.
 *
 * Unlike the service arrays in this module, this one is thrown from a tool
 * handler via `ctx.fail('blank_query', …)`, so its recovery hint resolves
 * through `ctx.recoveryFor` and it stays out of {@link ServiceErrorReason}.
 */
export const NCBI_QUERY_INPUT_ERRORS = [
  {
    reason: 'blank_query',
    code: JsonRpcErrorCode.ValidationError,
    when: 'The query holds no search term once whitespace, and anything the tool strips before searching, are removed — so NCBI would receive a blank term. pubmed_search_articles strips markup, bracketed field tags, and parentheses, so a bare field tag such as `[pdat]` or empty parentheses `()` count as blank there.',
    recovery:
      'Supply a nonblank search term — a bare field tag or empty parentheses carry none; NCBI cannot search a blank term and retrying the same input will not help.',
    retryable: false,
  },
] as const;

/**
 * Input failure the identifier-conversion path rejects before any call is made.
 * Separate from {@link NCBI_QUERY_INPUT_ERRORS} for the same reason that array
 * is separate from the service contracts: only a tool that takes caller-supplied
 * identifiers can produce it.
 *
 * Thrown from a tool handler via `ctx.fail('malformed_id', …)`, so its recovery
 * hint resolves through `ctx.recoveryFor` and it stays out of
 * {@link ServiceErrorReason}.
 */
export const NCBI_ID_INPUT_ERRORS = [
  {
    reason: 'malformed_id',
    code: JsonRpcErrorCode.ValidationError,
    when: 'An `ids` element does not match the declared `idType` — most often several identifiers packed into one element, which the comma-delimited upstream batch would split into extra records.',
    recovery:
      'Submit one identifier per `ids` element, in the declared idType format; the same packed value will be rejected again.',
    retryable: false,
  },
] as const;

/**
 * Failure modes the Unpaywall service layer can surface. A tool whose handler
 * lets `getUnpaywallService()` failures propagate spreads these into its
 * `errors[]`. None does today: `pubmed_fetch_fulltext`, the only consumer,
 * folds every Unpaywall failure into its tier chain, so the entries serve the
 * service's own `recoveryFor` hints.
 */
export const UNPAYWALL_SERVICE_ERRORS = [
  {
    reason: 'unpaywall_unreachable',
    code: JsonRpcErrorCode.ServiceUnavailable,
    when: 'Unpaywall was unreachable when resolving a DOI or fetching content.',
    recovery:
      'Retry after a brief delay; Unpaywall was unreachable. The PMC source remains the primary path.',
    retryable: true,
    thrownBy: 'service',
  },
] as const;

/**
 * Failure modes the OpenAlex service layer can surface. Tools whose handler
 * lets `getOpenAlexService()` / `getOpenAlexServiceOptional()` failures
 * propagate spread these into their `errors[]`.
 */
export const OPENALEX_SERVICE_ERRORS = [
  {
    reason: 'openalex_unreachable',
    code: JsonRpcErrorCode.ServiceUnavailable,
    when: 'OpenAlex was unreachable after all retry attempts.',
    recovery:
      'Retry after a brief delay; OpenAlex was unreachable. NCBI and Europe PMC remain available.',
    retryable: true,
    thrownBy: 'service',
  },
  {
    reason: 'openalex_invalid_response',
    code: JsonRpcErrorCode.SerializationError,
    when: 'OpenAlex returned a body that could not be parsed (invalid JSON).',
    recovery: 'Retry the request; OpenAlex returned a malformed response that could not be parsed.',
    retryable: true,
    thrownBy: 'service',
  },
] as const;

/**
 * Failure modes the Europe PMC service layer can surface. Tools whose handler
 * lets `getEuropePmcService()` failures propagate spread these into their
 * `errors[]`.
 */
export const EUROPEPMC_SERVICE_ERRORS = [
  {
    reason: 'europepmc_unreachable',
    code: JsonRpcErrorCode.ServiceUnavailable,
    when: 'Europe PMC failed on every retry attempt — unreachable, an HTTP 404 or 5xx other than a 504 timeout from its search endpoint, or an empty response with no results.',
    recovery:
      'Retry after a brief delay; Europe PMC was unreachable. NCBI PMC and Unpaywall remain available.',
    retryable: true,
    thrownBy: 'service',
  },
  {
    reason: 'europepmc_invalid_response',
    code: JsonRpcErrorCode.SerializationError,
    when: 'Europe PMC returned a body that could not be parsed (invalid JSON or XML).',
    recovery:
      'Retry the request; Europe PMC returned a malformed response that could not be parsed.',
    retryable: true,
    thrownBy: 'service',
  },
  {
    reason: 'europepmc_invalid_input',
    code: JsonRpcErrorCode.ValidationError,
    when: 'Europe PMC rejected the request input — an error message such as an empty query, an empty response to a sort with an undocumented field or no asc/desc direction, or an empty response to a pagination cursor on every attempt.',
    recovery:
      'Adjust the input — the query, the sort, or the cursorMark — before retrying; the same input will be rejected again.',
    retryable: false,
    thrownBy: 'service',
  },
] as const;

/**
 * Reason identifier union for type-safe authoring on the service layer.
 * Tool handlers get a tighter typed union from `ctx.fail` / `ctx.recoveryFor`
 * via the framework — this is the service-side fallback.
 */
export type ServiceErrorReason =
  | (typeof NCBI_SERVICE_ERRORS)[number]['reason']
  | (typeof UNPAYWALL_SERVICE_ERRORS)[number]['reason']
  | (typeof EUROPEPMC_SERVICE_ERRORS)[number]['reason']
  | (typeof OPENALEX_SERVICE_ERRORS)[number]['reason'];

const REASON_TO_RECOVERY = new Map<ServiceErrorReason, string>(
  [
    ...NCBI_SERVICE_ERRORS,
    ...UNPAYWALL_SERVICE_ERRORS,
    ...EUROPEPMC_SERVICE_ERRORS,
    ...OPENALEX_SERVICE_ERRORS,
  ].map((entry) => [entry.reason, entry.recovery]),
);

/**
 * Service-layer counterpart to `ctx.recoveryFor`. Returns `{ recovery: { hint } }`
 * for the contract reason. Use at every service throw that stamps a `reason` so
 * the wire payload carries the same actionable hint the LLM gets from
 * handler-level `ctx.fail`.
 *
 * The parameter is constrained to `ServiceErrorReason`, so typos fail at compile
 * time. The runtime guard catches the impossible case where the reason union
 * and the recovery map drift apart in future edits.
 *
 * @example
 *   throw serviceUnavailable(msg, { reason: 'ncbi_unreachable', ...recoveryFor('ncbi_unreachable') });
 */
export function recoveryFor(reason: ServiceErrorReason): { recovery: { hint: string } } {
  const hint = REASON_TO_RECOVERY.get(reason);
  if (hint === undefined) {
    throw new Error(`recoveryFor: no recovery hint registered for reason "${reason}"`);
  }
  return { recovery: { hint } };
}
