/**
 * @fileoverview FIFO request queue for NCBI E-utility calls that enforces a minimum
 * delay between requests to comply with NCBI rate limits. Requests are enqueued as
 * task functions and processed sequentially with configurable inter-request spacing.
 * @module src/services/ncbi/core/request-queue
 */

import { JsonRpcErrorCode, McpError } from '@/types-global/errors.js';
import { logger } from '@/utils/internal/logger.js';
import type { RequestContext } from '@/utils/internal/requestContext.js';

import type { NcbiRequestParams } from '../types.js';

/** Default maximum number of requests that can be queued before rejecting new ones. */
const DEFAULT_MAX_QUEUE_SIZE = 100;

/**
 * A single queued request holding the task to execute, its promise
 * settlement callbacks, and metadata for logging.
 */
interface QueuedRequest<T = unknown> {
  context: RequestContext;
  endpoint: string;
  params: NcbiRequestParams;
  reject: (reason?: unknown) => void;
  resolve: (value: T | PromiseLike<T>) => void;
  task: () => Promise<T>;
}

/**
 * Processes NCBI API requests through a FIFO queue, inserting a configurable
 * delay between consecutive calls to stay within NCBI's rate-limit window.
 *
 * Only one request executes at a time. When a request completes (or fails),
 * the next item in the queue is picked up via a microtask to avoid deep
 * recursive call stacks.
 */
export class NcbiRequestQueue {
  private readonly queue: QueuedRequest[] = [];
  private readonly delayMs: number;
  private readonly maxQueueSize: number;
  private processing = false;
  private lastRequestTime = 0;

  /**
   * @param delayMs - Minimum milliseconds to wait between consecutive NCBI requests.
   * @param maxQueueSize - Maximum queued requests before rejecting new ones.
   */
  constructor(delayMs: number, maxQueueSize = DEFAULT_MAX_QUEUE_SIZE) {
    this.delayMs = delayMs;
    this.maxQueueSize = maxQueueSize;
  }

  /**
   * Enqueues a task to be executed when rate-limit spacing permits.
   *
   * @param task - An async function that performs the actual NCBI HTTP call.
   * @param context - Request context for structured logging / correlation.
   * @param endpoint - The E-utility endpoint name (e.g. "esearch").
   * @param params - The request parameters (logged for diagnostics).
   * @returns A promise that resolves or rejects with the task's result.
   */
  enqueue<T>(
    task: () => Promise<T>,
    context: RequestContext,
    endpoint: string,
    params: NcbiRequestParams,
  ): Promise<T> {
    if (this.queue.length >= this.maxQueueSize) {
      return Promise.reject(
        new McpError(
          JsonRpcErrorCode.RateLimited,
          `NCBI request queue is full (max ${this.maxQueueSize}).`,
          {
            endpoint,
            queueSize: this.queue.length,
          },
        ),
      );
    }

    return new Promise<T>((resolve, reject) => {
      this.queue.push({
        resolve: resolve as (value: unknown) => void,
        reject,
        task,
        context,
        endpoint,
        params,
      });

      if (!this.processing) {
        // Kick off processing on the next microtask
        Promise.resolve().then(() => this.processQueue());
      }
    });
  }

  /**
   * Drains the queue one item at a time, waiting for the configured delay
   * between requests. Processing continues via microtask chaining to prevent
   * deep call stacks on large queues.
   */
  private async processQueue(): Promise<void> {
    if (this.processing || this.queue.length === 0) {
      return;
    }
    this.processing = true;

    const item = this.queue.shift();
    if (!item) {
      // Unreachable — the length check above guarantees at least one item.
      this.processing = false;
      return;
    }
    const { resolve, reject, task, context, endpoint } = item;

    try {
      const now = Date.now();
      const elapsed = now - this.lastRequestTime;
      const wait = this.delayMs - elapsed;

      if (wait > 0) {
        logger.debug(`Delaying NCBI request by ${wait}ms to respect rate limit.`, {
          ...context,
          endpoint,
          delayMs: wait,
        });
        await new Promise<void>((r) => setTimeout(r, wait));
      }

      this.lastRequestTime = Date.now();
      logger.info(`Executing NCBI request via queue: ${endpoint}`, {
        ...context,
        endpoint,
      });

      const result = await task();
      resolve(result);
    } catch (error: unknown) {
      logger.error('Error processing NCBI request from queue.', {
        ...context,
        endpoint,
        errorMessage: error instanceof Error ? error.message : String(error),
      });
      reject(error);
    } finally {
      this.processing = false;
      if (this.queue.length > 0) {
        Promise.resolve().then(() => this.processQueue());
      }
    }
  }
}
