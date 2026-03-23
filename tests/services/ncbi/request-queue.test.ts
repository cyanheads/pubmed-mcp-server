/**
 * @fileoverview Tests for the NCBI rate-limited request queue.
 * @module tests/services/ncbi/request-queue.test
 */

import { describe, expect, it, vi } from 'vitest';
import { NcbiRequestQueue } from '@/services/ncbi/request-queue.js';

vi.mock('@cyanheads/mcp-ts-core/utils', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
  },
}));

describe('NcbiRequestQueue', () => {
  it('executes a single enqueued task', async () => {
    const queue = new NcbiRequestQueue(0);
    const result = await queue.enqueue(() => Promise.resolve('done'), 'test', { db: 'pubmed' });
    expect(result).toBe('done');
  });

  it('executes multiple tasks sequentially', async () => {
    const queue = new NcbiRequestQueue(0);
    const order: number[] = [];

    const t1 = queue.enqueue(
      async () => {
        order.push(1);
        return 1;
      },
      'e1',
      {},
    );
    const t2 = queue.enqueue(
      async () => {
        order.push(2);
        return 2;
      },
      'e2',
      {},
    );
    const t3 = queue.enqueue(
      async () => {
        order.push(3);
        return 3;
      },
      'e3',
      {},
    );

    const results = await Promise.all([t1, t2, t3]);
    expect(results).toEqual([1, 2, 3]);
    expect(order).toEqual([1, 2, 3]);
  });

  it('rejects when queue is full', async () => {
    const queue = new NcbiRequestQueue(0, 1);
    // Fill the queue with a blocking task
    const blocking = new Promise<void>((resolve) => setTimeout(resolve, 100));
    queue.enqueue(() => blocking, 'blocking', {});

    await expect(queue.enqueue(() => Promise.resolve(), 'overflow', {})).rejects.toThrow(
      /queue is full/,
    );
  });

  it('propagates task errors to the caller', async () => {
    const queue = new NcbiRequestQueue(0);
    await expect(
      queue.enqueue(() => Promise.reject(new Error('task failed')), 'fail', {}),
    ).rejects.toThrow('task failed');
  });

  it('continues processing after a failed task', async () => {
    const queue = new NcbiRequestQueue(0);
    const p1 = queue
      .enqueue(() => Promise.reject(new Error('fail')), 'e1', {})
      .catch(() => 'caught');
    const p2 = queue.enqueue(() => Promise.resolve('ok'), 'e2', {});

    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toBe('caught');
    expect(r2).toBe('ok');
  });
});
