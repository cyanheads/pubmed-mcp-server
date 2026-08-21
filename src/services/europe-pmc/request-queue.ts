/**
 * @fileoverview Rate-limited request scheduler for Europe PMC calls. Caps
 * concurrent in-flight requests and enforces a minimum start-gap between
 * dispatches to stay polite with EBI's infrastructure. Independent rate
 * domain from NCBI's queue — Europe PMC runs on a different host with its
 * own limits.
 * @module src/services/europe-pmc/request-queue
 */

import { logger, requestContextService } from '@cyanheads/mcp-ts-core/utils';

const DEFAULT_MAX_CONCURRENT = 4;

interface Waiter<T = unknown> {
  label: string;
  onAbort?: () => void;
  reject: (reason?: unknown) => void;
  resolve: (value: T | PromiseLike<T>) => void;
  signal?: AbortSignal;
  task: () => Promise<T>;
}

/**
 * Schedules Europe PMC requests against two independent ceilings:
 *
 *   - **Throughput** (`minStartGapMs`): minimum delay between two consecutive
 *     dispatch times. Defaults to 200ms to be polite with EBI.
 *   - **Concurrency** (`maxConcurrent`): maximum simultaneous in-flight
 *     requests. Decouples concurrency from rate so slow upstream responses
 *     don't block new dispatches.
 *
 * Enqueue accepts an optional `AbortSignal` so callers can bound their total
 * time inside the scheduler — when the signal fires, a still-waiting task
 * rejects immediately instead of sitting behind a saturated worker.
 */
export class EuropePmcRequestQueue {
  private readonly waiters: Waiter[] = [];
  private readonly minStartGapMs: number;
  private readonly maxConcurrent: number;
  private inFlight = 0;
  private lastStartTime = 0;
  private nextDispatchTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(minStartGapMs: number, maxConcurrent: number = DEFAULT_MAX_CONCURRENT) {
    this.minStartGapMs = minStartGapMs;
    this.maxConcurrent = maxConcurrent;
  }

  enqueue<T>(task: () => Promise<T>, label: string, signal?: AbortSignal): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (signal?.aborted) {
        reject(signal.reason);
        return;
      }

      const waiter: Waiter<T> = {
        resolve,
        reject,
        task,
        label,
        ...(signal && { signal }),
      };

      if (signal) {
        const onAbort = () => {
          const idx = this.waiters.indexOf(waiter as Waiter);
          if (idx === -1) return;
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
        this.nextDispatchTimer = setTimeout(() => {
          this.nextDispatchTimer = undefined;
          this.tryDispatch();
        }, gap);
        return;
      }

      const waiter = this.waiters.shift();
      if (!waiter) return;

      if (waiter.signal && waiter.onAbort) {
        waiter.signal.removeEventListener('abort', waiter.onAbort);
      }

      this.lastStartTime = Date.now();
      this.inFlight += 1;
      logger.debug(
        `Executing Europe PMC request via queue: ${waiter.label}`,
        requestContextService.createRequestContext({
          operation: 'EuropePmcQueueDispatch',
          additionalContext: {
            label: waiter.label,
            inFlight: this.inFlight,
            queueDepth: this.waiters.length,
          },
        }),
      );

      Promise.resolve()
        .then(() => waiter.task())
        .then(waiter.resolve, (err) => {
          logger.error(
            'Error processing Europe PMC request from queue.',
            requestContextService.createRequestContext({
              operation: 'EuropePmcQueueProcess',
              additionalContext: {
                label: waiter.label,
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
