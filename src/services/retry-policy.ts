/**
 * @fileoverview Shared transience check for the hand-rolled retry loops in the NCBI,
 * OpenAlex, and Europe PMC services. Mirrors the framework's `defaultIsTransient`
 * (`withRetry`, `@cyanheads/mcp-ts-core/utils`) so the three gates classify identically
 * to the framework path they don't use.
 * @module src/services/retry-policy
 */

import type { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';

/**
 * Whether a thrown `McpError` should be retried. An explicit `data.retryable === false`
 * opt-out wins over code-based classification; absent (or `true`) the code decides.
 *
 * The HTTP helpers stamp the opt-out on an upstream 501, which classifies as
 * `ServiceUnavailable` — a transient code — but re-asks for a method the upstream has
 * declared absent, so it must fail on the first attempt.
 */
export function isTransient(
  error: McpError,
  transientCodes: ReadonlySet<JsonRpcErrorCode>,
): boolean {
  if (error.data?.retryable === false) return false;
  return transientCodes.has(error.code);
}
