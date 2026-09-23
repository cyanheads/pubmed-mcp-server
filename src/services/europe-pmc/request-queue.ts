/**
 * @fileoverview Request queue for Europe PMC calls, built on the framework pacer.
 * Caps concurrent in-flight requests and spaces request starts to stay polite with
 * EBI's infrastructure, and releases a waiting caller the moment its signal aborts.
 * Each retry attempt re-enters the queue, so a backoff sleep holds no slot and every
 * attempt waits out the start gap. Independent rate domain from NCBI's queue —
 * Europe PMC runs on a different host with its own limits.
 * @module src/services/europe-pmc/request-queue
 */

import { createPacer, type Pacer } from '@cyanheads/mcp-ts-core/utils';

/**
 * Europe PMC requests in flight at once. `pubmed_fetch_fulltext` fans its Europe PMC
 * tier out over every candidate in parallel and relies on this cap to bound it.
 */
const MAX_CONCURRENT = 4;

/**
 * Creates the pacer every Europe PMC call runs through. No queue-depth cap and no
 * wait budget: a caller waits for its turn rather than being shed, so the pacer never
 * rejects on its own — only the caller's signal ends a wait early.
 */
export function createEuropePmcRequestQueue(minStartGapMs: number): Pacer {
  return createPacer({ name: 'europepmc', minStartGapMs, maxConcurrent: MAX_CONCURRENT });
}
