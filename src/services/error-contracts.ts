/**
 * @fileoverview Canonical error contracts: the failure modes the NCBI, Europe
 * PMC, and OpenAlex services throw and tools declare in `errors[]`, plus the
 * input rejections some tools raise before any upstream call. Unpaywall has no
 * array here: its one caller, `pubmed_fetch_fulltext`, catches every Unpaywall
 * failure and reports it as a tier outcome, so no Unpaywall reason reaches a
 * caller as an error.
 *
 * Service-layer code stamps `data: { reason }` on its throws, adding its own
 * `data.recovery` only where the hint depends on runtime detail. When a failure
 * with no hint of its own reaches a tool or resource that declares the reason,
 * the framework fills that entry's `recovery` in as `data.recovery.hint` — the
 * same hint a handler-level `ctx.fail` gets. A tool's error also renders the
 * hint as a `Recovery:` line in its `content[]` text (dropped when the message
 * already contains it); a resource's carries it only in the JSON-RPC error's
 * `data`.
 *
 * Definitions import the contract arrays directly and spread them into their
 * `errors: [...]` declarations to surface the failure modes to the LLM.
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
    when: 'NCBI E-utilities failed on every attempt the retry budget allowed — retries ran out, or the next backoff would overrun the total deadline.',
    recovery: 'Retry after a brief delay; NCBI failed on every attempt this call made.',
    retryable: true,
    thrownBy: 'service',
  },
  {
    reason: 'ncbi_rate_limited',
    code: JsonRpcErrorCode.RateLimited,
    when: 'NCBI answered HTTP 429 (too many requests) and the call stopped on it — retries ran out, the next backoff would overrun the total deadline, or the Retry-After NCBI named outlasts the time left or the 30-second backoff cap.',
    recovery:
      "Wait as long as `retryAfter` says when present (a number of seconds or an HTTP date), otherwise a few seconds, then retry; NCBI is throttling this server's requests. If the server runs without NCBI_API_KEY, setting it raises the E-utilities ceiling from about 3 to about 10 requests per second and shortens the default gap between requests — an operator setting in the server's environment, not a tool input.",
    retryable: true,
    thrownBy: 'service',
  },
  {
    reason: 'ncbi_deadline_exceeded',
    code: JsonRpcErrorCode.Timeout,
    when: 'The total NCBI request deadline expired before NCBI answered successfully — mid-request, while queued, or during a retry backoff.',
    recovery:
      'Retry after a brief delay; NCBI may be under temporary load. For a large batch, split it into smaller calls.',
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
 * Input failure the free-text query tools reject before any call is made —
 * the NCBI query tools and `pubmed_europepmc_search` alike. Declared here
 * rather than inside a service array so only the tools that actually throw it
 * advertise it — a tool that takes no free-text query can never produce it,
 * and declaring it there would advertise a failure mode that cannot happen.
 *
 * Unlike the service arrays in this module, this one is thrown from a tool
 * handler via `ctx.fail('blank_query', …)`, so its entry carries no `thrownBy`.
 */
export const QUERY_INPUT_ERRORS = [
  {
    reason: 'blank_query',
    code: JsonRpcErrorCode.ValidationError,
    when: 'The query contains no search term: nothing is left once whitespace and invisible characters such as a zero-width space are disregarded. pubmed_search_articles and pubmed_europepmc_search first decode HTML entities and also disregard markup and parentheses, so `()`, `<b></b>`, and `&nbsp;` hold no term there; pubmed_search_articles also disregards bracketed field tags such as `[pdat]`.',
    recovery: 'Supply a nonblank search term; retrying the same blank input will not help.',
    retryable: false,
  },
] as const;

/**
 * Input failure the identifier-conversion path rejects before any call is made.
 * Separate from {@link QUERY_INPUT_ERRORS} for the same reason that array
 * is separate from the service contracts: only a tool that takes caller-supplied
 * identifiers can produce it.
 *
 * Thrown from a tool handler via `ctx.fail('malformed_id', …)`, so its entry
 * carries no `thrownBy`.
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
    code: JsonRpcErrorCode.ServiceUnavailable,
    when: 'The last of the retry attempts against OpenAlex returned a body that could not be parsed as JSON.',
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
    when: 'Europe PMC rejected the request input — an error message in place of results, an empty response to a sort with an undocumented field or no asc/desc direction, or a pagination cursor it cannot read (an empty response on the last attempt the retry budget allows, or a second HTTP 503 when the first page of the same query is served).',
    recovery:
      "Fix the rejected input before retrying — the query, the sort, or the cursorMark (pass the previous response's `nextCursorMark` verbatim, or `*` to restart); the same input will most likely be rejected again.",
    retryable: false,
    thrownBy: 'service',
  },
] as const;
