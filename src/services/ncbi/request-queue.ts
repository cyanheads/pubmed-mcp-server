/**
 * @fileoverview Rate-limited request scheduler for NCBI E-utility calls. Caps
 * concurrent in-flight requests and enforces a minimum start-gap between
 * dispatches to stay within NCBI's documented per-second ceiling. Supports
 * abort-during-wait so callers' deadlines can bound queue time end-to-end.
 * @module src/services/ncbi/request-queue
 */

import { rateLimited } from '@cyanheads/mcp-ts-core/errors';
import { logger, requestContextService } from '@cyanheads/mcp-ts-core/utils';

import { recoveryFor } from '@/services/error-contracts.js';
import type { NcbiRequestParams } from './types.js';

const DEFAULT_MAX_CONCURRENT = 8;
const DEFAULT_MAX_QUEUE_SIZE = 100;

interface Waiter<T = unknown> {
  endpoint: string;
  onAbort?: () => void;
  params: NcbiRequestParams;
  reject: (reason?: unknown) => void;
  resolve: (value: T | PromiseLike<T>) => void;
  signal?: AbortSignal;
  task: () => Promise<T>;
}

/**
 * Schedules NCBI API requests against two independent ceilings:
 *
 *   - **Throughput** (`minStartGapMs`): minimum delay between two consecutive
 *     dispatch times. Matches NCBI's per-second start-rate cap (≈3/s without
 *     an API key, ≈10/s with one).
 *   - **Concurrency** (`maxConcurrent`): maximum number of requests in flight
 *     simultaneously. Decouples concurrency from rate, so slow upstream
 *     responses don't block new dispatches.
 *
 * Enqueue accepts an optional `AbortSignal` so callers can bound their total
 * time inside the scheduler — when the signal fires, a still-waiting task
 * rejects immediately instead of sitting behind a saturated worker for
 * minutes.
 */
export class NcbiRequestQueue {
  private readonly waiters: Waiter[] = [];
  private readonly minStartGapMs: number;
  private readonly maxConcurrent: number;
  private readonly maxQueueSize: number;
  private inFlight = 0;
  private lastStartTime = 0;
  private nextDispatchTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    minStartGapMs: number,
    maxConcurrent: number = DEFAULT_MAX_CONCURRENT,
    maxQueueSize: number = DEFAULT_MAX_QUEUE_SIZE,
  ) {
    this.minStartGapMs = minStartGapMs;
    this.maxConcurrent = maxConcurrent;
    this.maxQueueSize = maxQueueSize;
  }

  enqueue<T>(
    task: () => Promise<T>,
    endpoint: string,
    params: NcbiRequestParams,
    signal?: AbortSignal,
  ): Promise<T> {
    if (this.waiters.length >= this.maxQueueSize) {
      return Promise.reject(
        rateLimited(`NCBI request queue is full (max ${this.maxQueueSize}).`, {
          reason: 'queue_full',
          endpoint,
          queueSize: this.waiters.length,
          ...recoveryFor('queue_full'),
        }),
      );
    }

    return new Promise<T>((resolve, reject) => {
      if (signal?.aborted) {
        reject(signal.reason);
        return;
      }

      const waiter: Waiter<T> = {
        resolve,
        reject,
        task,
        endpoint,
        params,
        ...(signal && { signal }),
      };

      if (signal) {
        const onAbort = () => {
          const idx = this.waiters.indexOf(waiter as Waiter);
          if (idx === -1) return; // already dispatched — the task forwards its own signal
          this.waiters.splice(idx, 1);
          reject(signal.reason);
        };
        waiter.onAbort = onAbort;
        signal.addEventListener('abort', onAbort, { once: true });
      }

      this.waiters.push(waiter as Waiter);
      this.tryDispatch();
    });
  }

  private tryDispatch(): void {
    if (this.nextDispatchTimer !== undefined) return;

    while (this.inFlight < this.maxConcurrent && this.waiters.length > 0) {
      const now = Date.now();
      const gap = this.minStartGapMs - (now - this.lastStartTime);
      if (gap > 0) {
        logger.debug(
          `Delaying next NCBI dispatch by ${gap}ms to respect rate limit.`,
          requestContextService.createRequestContext({
            operation: 'NcbiQueueWait',
            additionalContext: { delayMs: gap },
          }),
        );
        this.nextDispatchTimer = setTimeout(() => {
          this.nextDispatchTimer = undefined;
          this.tryDispatch();
        }, gap);
        return;
      }

      const waiter = this.waiters.shift();
      if (!waiter) return;

      // Detach the cancel listener now that we're about to start; the task is
      // responsible for forwarding its own signal to downstream I/O.
      if (waiter.signal && waiter.onAbort) {
        waiter.signal.removeEventListener('abort', waiter.onAbort);
      }

      this.lastStartTime = Date.now();
      this.inFlight += 1;
      logger.info(
        `Executing NCBI request via queue: ${waiter.endpoint}`,
        requestContextService.createRequestContext({
          operation: 'NcbiQueueDispatch',
          additionalContext: {
            endpoint: waiter.endpoint,
            inFlight: this.inFlight,
            queueDepth: this.waiters.length,
          },
        }),
      );

      // `Promise.resolve().then(() => task())` converts any sync throw from
      // `task()` into a rejected promise so the finally() bookkeeping always
      // runs.
      Promise.resolve()
        .then(() => waiter.task())
        .then(waiter.resolve, (err) => {
          logger.error(
            'Error processing NCBI request from queue.',
            requestContextService.createRequestContext({
              operation: 'NcbiQueueProcess',
              additionalContext: {
                endpoint: waiter.endpoint,
                errorMessage: err instanceof Error ? err.message : String(err),
              },
            }),
          );
          waiter.reject(err);
        })
        .finally(() => {
          this.inFlight -= 1;
          this.tryDispatch();
        });
    }
  }
}
