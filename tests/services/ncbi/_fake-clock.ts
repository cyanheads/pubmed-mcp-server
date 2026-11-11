/**
 * @fileoverview Fake-clock drivers for service tests that run the NCBI retry loop,
 * request queue, and cooldown gate under `vi.useFakeTimers()`: track a call's
 * settlement without awaiting it, then advance the clock timer to timer until it
 * settles, so every assertion reads the exact instant the call's last timer fired.
 * @module tests/services/ncbi/_fake-clock
 */

import type { McpError } from '@cyanheads/mcp-ts-core/errors';
import { vi } from 'vitest';

export type Outcome = { ok: true } | { ok: false; error: McpError };

export interface Tracked {
  outcome: Outcome | undefined;
}

/** Tracks a call's settlement without awaiting it, so the test can keep driving the clock. */
export function track(promise: Promise<unknown>): Tracked {
  const handle: Tracked = { outcome: undefined };
  promise.then(
    () => {
      handle.outcome = { ok: true };
    },
    (error: McpError) => {
      handle.outcome = { ok: false, error };
    },
  );
  return handle;
}

/**
 * Advances the fake clock to each next pending timer, firing it, until `handle` settles.
 * Every step lets pending promise callbacks finish before and after its timer fires, so
 * the drive costs a few event-loop turns per timer rather than one per clock increment.
 * Throws instead of spinning when the call is still pending with no timer left to fire
 * — nothing the clock drives can settle it — or once the clock has moved more than
 * `budgetMs` past where the drive started.
 */
export async function driveUntilSettled(handle: Tracked, budgetMs = 30_000): Promise<Outcome> {
  const startedAt = Date.now();
  // Settles a call that needs no timer at all without moving the clock.
  await vi.advanceTimersByTimeAsync(0);
  while (handle.outcome === undefined) {
    const elapsedMs = Date.now() - startedAt;
    if (elapsedMs > budgetMs) {
      throw new Error(`Call still pending ${elapsedMs}ms into a ${budgetMs}ms fake-clock drive.`);
    }
    if (vi.getTimerCount() === 0) {
      throw new Error(
        `Call still pending ${elapsedMs}ms into the drive with no fake timer left to fire.`,
      );
    }
    await vi.advanceTimersToNextTimerAsync();
  }
  return handle.outcome;
}
