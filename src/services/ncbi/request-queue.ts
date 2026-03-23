/**
 * @fileoverview FIFO request queue for NCBI E-utility calls that enforces a minimum
 * delay between requests to comply with NCBI rate limits.
 * @module src/services/ncbi/request-queue
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { logger } from '@cyanheads/mcp-ts-core/utils';

import type { NcbiRequestParams } from './types.js';

const DEFAULT_MAX_QUEUE_SIZE = 100;

interface QueuedRequest<T = unknown> {
  endpoint: string;
  params: NcbiRequestParams;
  reject: (reason?: unknown) => void;
  resolve: (value: T | PromiseLike<T>) => void;
  task: () => Promise<T>;
}

/**
 * Processes NCBI API requests through a FIFO queue, inserting a configurable
 * delay between consecutive calls to stay within NCBI's rate-limit window.
 */
export class NcbiRequestQueue {
  private readonly queue: QueuedRequest[] = [];
  private readonly delayMs: number;
  private readonly maxQueueSize: number;
  private processing = false;
  private lastRequestTime = 0;

  constructor(delayMs: number, maxQueueSize = DEFAULT_MAX_QUEUE_SIZE) {
    this.delayMs = delayMs;
    this.maxQueueSize = maxQueueSize;
  }

  enqueue<T>(task: () => Promise<T>, endpoint: string, params: NcbiRequestParams): Promise<T> {
    if (this.queue.length >= this.maxQueueSize) {
      return Promise.reject(
        new McpError(
          JsonRpcErrorCode.RateLimited,
          `NCBI request queue is full (max ${this.maxQueueSize}).`,
          { endpoint, queueSize: this.queue.length },
        ),
      );
    }

    return new Promise<T>((resolve, reject) => {
      this.queue.push({
        resolve: resolve as (value: unknown) => void,
        reject,
        task,
        endpoint,
        params,
      });

      if (!this.processing) {
        queueMicrotask(() => this.processQueue());
      }
    });
  }

  private async processQueue(): Promise<void> {
    if (this.processing || this.queue.length === 0) return;
    this.processing = true;

    const item = this.queue.shift();
    if (!item) {
      this.processing = false;
      return;
    }
    const { resolve, reject, task, endpoint } = item;

    try {
      const now = Date.now();
      const elapsed = now - this.lastRequestTime;
      const wait = this.delayMs - elapsed;

      if (wait > 0) {
        logger.debug(`Delaying NCBI request by ${wait}ms to respect rate limit.`, {
          endpoint,
          delayMs: wait,
        } as never);
        await new Promise<void>((r) => setTimeout(r, wait));
      }

      this.lastRequestTime = Date.now();
      logger.info(`Executing NCBI request via queue: ${endpoint}`, {
        endpoint,
      } as never);

      const result = await task();
      resolve(result);
    } catch (error: unknown) {
      logger.error('Error processing NCBI request from queue.', {
        endpoint,
        errorMessage: error instanceof Error ? error.message : String(error),
      } as never);
      reject(error);
    } finally {
      this.processing = false;
      if (this.queue.length > 0) {
        queueMicrotask(() => this.processQueue());
      }
    }
  }
}
