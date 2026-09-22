/**
 * @fileoverview Request queue for NCBI E-utility calls, built on the framework pacer.
 * Spaces request starts to NCBI's per-second ceiling, caps concurrent in-flight
 * requests and queue depth, releases a waiting caller the moment its signal aborts,
 * and closes one shared cooldown gate for every queued caller when NCBI answers 429.
 * Each retry attempt re-enters the queue, so a throttled upstream paces the whole
 * server rather than each caller retrying into it on its own backoff.
 * @module src/services/ncbi/request-queue
 */

import { createPacer, type Pacer } from '@cyanheads/mcp-ts-core/utils';

/** Waiting callers past which a new arrival is shed at once. */
const DEFAULT_MAX_QUEUE_DEPTH = 100;

/**
 * Gate closed on an NCBI 429: one second — the width of NCBI's rate window — doubled
 * per consecutive 429 and reset by the first success. An honored `Retry-After` is capped
 * by the same ceiling, a quarter of the default total deadline, so a caller queued
 * behind the longest gate still has budget left for its request.
 */
const RATE_LIMIT_COOLDOWN = { baseMs: 1_000, maxMs: 15_000 };

/** Settings for {@link createNcbiRequestQueue}. */
export interface NcbiRequestQueueOptions {
  /** Maximum requests in flight at once. */
  maxConcurrent: number;
  /** Waiting callers past which a new arrival is shed. Defaults to 100. */
  maxQueueDepth?: number;
  /** Minimum gap between two request starts — NCBI's per-second ceiling. */
  minStartGapMs: number;
}

/**
 * Creates the pacer every NCBI E-utility call runs through. A caller passes its
 * remaining deadline as `maxWaitMs`: a call whose projected wait already exceeds it
 * — behind a deep queue or a closed cooldown gate — is shed at enqueue with a
 * `pacer_shed` rejection carrying `retryAfter`, rather than waiting out a deadline
 * it cannot meet.
 */
export function createNcbiRequestQueue({
  maxConcurrent,
  maxQueueDepth = DEFAULT_MAX_QUEUE_DEPTH,
  minStartGapMs,
}: NcbiRequestQueueOptions): Pacer {
  return createPacer({
    name: 'ncbi',
    minStartGapMs,
    maxConcurrent,
    maxQueueDepth,
    cooldown: RATE_LIMIT_COOLDOWN,
  });
}
