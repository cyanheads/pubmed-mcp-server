/**
 * @fileoverview The deadline one tool call runs under. A handler starts it once and
 * passes it to every upstream call it makes, so a call that sends several requests, or
 * falls back from one provider to the next, still ends inside one bound instead of
 * adding each provider's own deadline to the last.
 * @module src/services/call-deadline
 */

import { getServerConfig, type ServerConfig } from '@/config/server-config.js';

/**
 * A tool call's deadline when no provider deadline is configured past it, in ms. MCP
 * clients give up on a request at 60 s by default; this leaves the answer room to arrive.
 */
const DEFAULT_CALL_DEADLINE_MS = 50_000;

/**
 * Time left at or under which a deadline counts as spent, in ms. Node can fire a timer
 * aimed at an instant while `Date.now()` still reads 1 ms short of it, so a request
 * started on that reading would be sent on its own deadline.
 */
const SPENT_MARGIN_MS = 1;

/** A deadline, with the length it was set to. */
export interface CallDeadline {
  /** `Date.now()` at which the deadline expires. */
  readonly expiresAt: number;
  /** The deadline's length when it was set, in ms: what its expiry reports as `deadlineMs`. */
  readonly totalMs: number;
}

/** The deadline one upstream call runs under, from {@link upstreamBound}. */
export interface UpstreamBound {
  /** Length of whichever deadline binds, in ms: what its expiry reports as `deadlineMs`. */
  readonly deadlineMs: number;
  /** Time the upstream call may take from now, in ms. */
  readonly remainingMs: number;
  /** Whether the tool call's deadline has already run out, so the call sends nothing. */
  readonly spent: boolean;
}

/**
 * How long one tool call may run, in ms: {@link DEFAULT_CALL_DEADLINE_MS}, or the
 * longest configured provider deadline when an operator raised one past that.
 */
export function callDeadlineMs(
  config: Pick<ServerConfig, 'totalDeadlineMs' | 'europepmcTotalDeadlineMs'>,
): number {
  return Math.max(
    DEFAULT_CALL_DEADLINE_MS,
    config.totalDeadlineMs,
    config.europepmcTotalDeadlineMs,
  );
}

/** Starts a tool call's deadline now. Call it once, as the handler starts. */
export function startCallDeadline(): CallDeadline {
  const totalMs = callDeadlineMs(getServerConfig());
  return { expiresAt: Date.now() + totalMs, totalMs };
}

/** Time left on `deadline` in ms, never negative. */
export function remainingMs(deadline: CallDeadline): number {
  return Math.max(0, deadline.expiresAt - Date.now());
}

/** Whether `deadline` has no time left to start a request in. */
export function isSpent(deadline: CallDeadline): boolean {
  return deadline.expiresAt - Date.now() <= SPENT_MARGIN_MS;
}

/**
 * The deadline for a chain step that has other steps after it: half the time left. A
 * step that hangs still leaves the steps after it time to answer, the provider asked
 * first keeps the largest part, and time a step does not use goes back to the rest. A
 * step with nothing after it runs under `deadline` itself, as does any step of a spent
 * deadline.
 */
export function shareDeadline(deadline: CallDeadline): CallDeadline {
  if (isSpent(deadline)) return deadline;
  const totalMs = Math.floor(remainingMs(deadline) / 2);
  return { expiresAt: Date.now() + totalMs, totalMs };
}

/**
 * The deadline one upstream call runs under: the provider's own, or the time the tool
 * call has left when that is less. Without a `deadline` the provider's own applies.
 */
export function upstreamBound(providerDeadlineMs: number, deadline?: CallDeadline): UpstreamBound {
  if (!deadline) {
    return { deadlineMs: providerDeadlineMs, remainingMs: providerDeadlineMs, spent: false };
  }
  const left = remainingMs(deadline);
  return left < providerDeadlineMs
    ? { deadlineMs: deadline.totalMs, remainingMs: left, spent: isSpent(deadline) }
    : { deadlineMs: providerDeadlineMs, remainingMs: providerDeadlineMs, spent: false };
}
