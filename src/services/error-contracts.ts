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
 *
 * @module src/services/error-contracts
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';

/**
 * Failure modes the NCBI service layer can surface. Tools that consume
 * `getNcbiService()` should spread these into their own `errors[]` so the
 * declared contract matches what actually reaches the wire.
 */
export const NCBI_SERVICE_ERRORS = [
  {
    reason: 'queue_full',
    code: JsonRpcErrorCode.RateLimited,
    when: 'Local NCBI request queue is at capacity.',
    recovery: 'Retry after 1-2 seconds; the request queue hit the NCBI rate limit.',
    retryable: true,
  },
  {
    reason: 'ncbi_unreachable',
    code: JsonRpcErrorCode.ServiceUnavailable,
    when: 'NCBI E-utilities is unreachable after all retry attempts.',
    recovery: 'Retry after a brief delay; NCBI was unreachable across all retry attempts.',
    retryable: true,
  },
  {
    reason: 'ncbi_deadline_exceeded',
    code: JsonRpcErrorCode.Timeout,
    when: 'Total request deadline expired before NCBI returned a response.',
    recovery: 'Reduce batch size or retry; NCBI may be under temporary load.',
    retryable: true,
  },
  {
    reason: 'ncbi_invalid_response',
    code: JsonRpcErrorCode.SerializationError,
    when: 'NCBI returned a body that could not be parsed (invalid XML/JSON).',
    recovery: 'Retry the request; NCBI returned a malformed response that could not be parsed.',
    retryable: true,
  },
  {
    reason: 'ncbi_resource_not_found',
    code: JsonRpcErrorCode.NotFound,
    when: 'NCBI returned a structured "not found" error for the requested ID(s).',
    recovery:
      'Verify the ID exists in PubMed; the resource was not found in NCBI and retrying will not help.',
    retryable: false,
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
    when: 'The query holds no search term once whitespace, and any markup the tool strips first, are removed — so NCBI would receive a blank term.',
    recovery:
      'Supply a nonblank search term; NCBI cannot search a blank term and retrying the same input will not help.',
    retryable: false,
  },
] as const;

/**
 * Failure modes the Unpaywall service layer can surface. Tools that consume
 * `getUnpaywallService()` (currently `pubmed_fetch_fulltext`) should spread
 * these into their `errors[]`.
 */
export const UNPAYWALL_SERVICE_ERRORS = [
  {
    reason: 'unpaywall_unreachable',
    code: JsonRpcErrorCode.ServiceUnavailable,
    when: 'Unpaywall was unreachable when resolving a DOI or fetching content.',
    recovery:
      'Retry after a brief delay; Unpaywall was unreachable. The PMC source remains the primary path.',
    retryable: true,
  },
] as const;

/**
 * Failure modes the OpenAlex service layer can surface. Tools that consume
 * `getOpenAlexService()` / `getOpenAlexServiceOptional()` should spread
 * these into their `errors[]`.
 */
export const OPENALEX_SERVICE_ERRORS = [
  {
    reason: 'openalex_unreachable',
    code: JsonRpcErrorCode.ServiceUnavailable,
    when: 'OpenAlex was unreachable after all retry attempts.',
    recovery:
      'Retry after a brief delay; OpenAlex was unreachable. NCBI and Europe PMC remain available.',
    retryable: true,
  },
  {
    reason: 'openalex_invalid_response',
    code: JsonRpcErrorCode.SerializationError,
    when: 'OpenAlex returned a body that could not be parsed (invalid JSON).',
    recovery: 'Retry the request; OpenAlex returned a malformed response that could not be parsed.',
    retryable: true,
  },
] as const;

/**
 * Failure modes the Europe PMC service layer can surface. Tools that consume
 * `getEuropePmcService()` should spread these into their `errors[]`.
 */
export const EUROPEPMC_SERVICE_ERRORS = [
  {
    reason: 'europepmc_unreachable',
    code: JsonRpcErrorCode.ServiceUnavailable,
    when: 'Europe PMC was unreachable after all retry attempts.',
    recovery:
      'Retry after a brief delay; Europe PMC was unreachable. NCBI PMC and Unpaywall remain available.',
    retryable: true,
  },
  {
    reason: 'europepmc_invalid_response',
    code: JsonRpcErrorCode.SerializationError,
    when: 'Europe PMC returned a body that could not be parsed (invalid JSON or XML).',
    recovery:
      'Retry the request; Europe PMC returned a malformed response that could not be parsed.',
    retryable: true,
  },
  {
    reason: 'europepmc_invalid_input',
    code: JsonRpcErrorCode.ValidationError,
    when: 'Europe PMC rejected the request input (empty query, unknown sort field, malformed parameter).',
    recovery:
      'Adjust the input — usually the query or sort field — before retrying; the same input will be rejected again.',
    retryable: false,
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
