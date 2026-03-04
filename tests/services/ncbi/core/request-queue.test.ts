/**
 * @fileoverview Unit tests for the NcbiRequestQueue — a FIFO queue that serialises
 * NCBI E-utility calls and enforces a minimum delay between consecutive requests.
 * @module tests/services/ncbi/core/request-queue.test
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { NcbiRequestQueue } from '@/services/ncbi/core/request-queue.js';
import type { NcbiRequestParams } from '@/services/ncbi/types.js';
import { JsonRpcErrorCode, McpError } from '@/types-global/errors.js';
import { logger } from '@/utils/internal/logger.js';
import { requestContextService } from '@/utils/internal/requestContext.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal valid NcbiRequestParams used throughout the test suite. */
const TEST_PARAMS: NcbiRequestParams = { db: 'pubmed' };

/** Create a fresh RequestContext for each call so tests remain independent. */
function ctx() {
  return requestContextService.createRequestContext({ operation: 'test' });
}

// ---------------------------------------------------------------------------
// Constructor
// ---------------------------------------------------------------------------

describe('NcbiRequestQueue — constructor', () => {
  it('creates a queue with the specified delay and default max size', async () => {
    // A queue created with a 200ms delay should accept at least 100 tasks
    // (the default max) without rejecting immediately.
    vi.useRealTimers();
    const queue = new NcbiRequestQueue(200);

    const task = vi.fn(async () => 'ok');
    const result = await queue.enqueue(task, ctx(), 'esearch', TEST_PARAMS);

    expect(result).toBe('ok');
    expect(task).toHaveBeenCalledOnce();
    vi.useFakeTimers();
  });

  it('creates a queue with a custom max size', async () => {
    vi.useRealTimers();
    // maxQueueSize = 1: one item may sit pending while one is in-flight.
    // A third enqueue (pending queue already at 1) is rejected.
    const queue = new NcbiRequestQueue(0, 1);

    // Start one task that won't resolve until we release a latch.
    let release!: () => void;
    const latch = new Promise<void>((r) => {
      release = r;
    });
    const blocking = vi.fn(async () => {
      await latch;
      return 'first';
    });
    const pFirst = queue.enqueue(blocking, ctx(), 'esearch', TEST_PARAMS);

    // Flush the microtask that kicks off processQueue so 'blocking' is in-flight
    // (shifted out of this.queue) before we enqueue any more items.
    await Promise.resolve();
    await Promise.resolve();

    // Enqueue one more — fills the single pending slot.
    const filler = vi.fn(async () => 'second');
    const pFiller = queue.enqueue(filler, ctx(), 'esearch', TEST_PARAMS);

    // A third enqueue should be immediately rejected (queue full).
    await expect(
      queue.enqueue(
        vi.fn(async () => 'overflow'),
        ctx(),
        'esearch',
        TEST_PARAMS,
      ),
    ).rejects.toBeInstanceOf(McpError);

    // Unblock so tests clean up properly.
    release();
    await pFirst;
    await pFiller;
    vi.useFakeTimers();
  });
});

// ---------------------------------------------------------------------------
// enqueue — basic behaviour
// ---------------------------------------------------------------------------

describe('NcbiRequestQueue — enqueue', () => {
  beforeEach(() => {
    vi.useRealTimers();
    vi.spyOn(logger, 'debug').mockImplementation(() => {});
    vi.spyOn(logger, 'info').mockImplementation(() => {});
    vi.spyOn(logger, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useFakeTimers();
  });

  it('executes a single task and returns its result', async () => {
    const queue = new NcbiRequestQueue(0);
    const task = vi.fn(async () => 42);

    const result = await queue.enqueue(task, ctx(), 'esearch', TEST_PARAMS);

    expect(result).toBe(42);
    expect(task).toHaveBeenCalledOnce();
  });

  it('rejects immediately when the queue is full', async () => {
    // maxQueueSize = 1: one item may sit pending while one is in-flight.
    // After the in-flight slot is taken and the single pending slot is filled,
    // any further enqueue is rejected.
    const queue = new NcbiRequestQueue(0, 1);

    let release!: () => void;
    const latch = new Promise<void>((r) => {
      release = r;
    });
    const blocking = vi.fn(async () => {
      await latch;
    });
    const pFirst = queue.enqueue(blocking, ctx(), 'esearch', TEST_PARAMS);

    // Flush the microtask that runs processQueue so 'blocking' is in-flight
    // (shifted off this.queue) before we add more items.
    await Promise.resolve();
    await Promise.resolve();

    // Fill the single pending slot.
    const pFiller = queue.enqueue(
      vi.fn(async () => 'filler'),
      ctx(),
      'esearch',
      TEST_PARAMS,
    );

    // Now the pending queue is full — this enqueue must be rejected.
    const rejection = queue.enqueue(
      vi.fn(async () => 'x'),
      ctx(),
      'esearch',
      TEST_PARAMS,
    );
    await expect(rejection).rejects.toBeInstanceOf(McpError);

    release();
    await pFirst;
    await pFiller;
  });

  it('rejects with McpError carrying the RateLimited code when queue is full', async () => {
    const queue = new NcbiRequestQueue(0, 1);

    let release!: () => void;
    const latch = new Promise<void>((r) => {
      release = r;
    });
    const blocking = vi.fn(async () => {
      await latch;
    });
    const pFirst = queue.enqueue(blocking, ctx(), 'esearch', TEST_PARAMS);

    // Let processQueue run and shift 'blocking' into in-flight position.
    await Promise.resolve();
    await Promise.resolve();

    // Fill the pending slot.
    const pFiller = queue.enqueue(
      vi.fn(async () => 'filler'),
      ctx(),
      'esearch',
      TEST_PARAMS,
    );

    // Attempt to enqueue past capacity.
    let thrown: unknown;
    try {
      await queue.enqueue(
        vi.fn(async () => 'y'),
        ctx(),
        'esearch',
        TEST_PARAMS,
      );
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(McpError);
    expect((thrown as McpError).code).toBe(JsonRpcErrorCode.RateLimited);

    release();
    await pFirst;
    await pFiller;
  });
});

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------

describe('NcbiRequestQueue — rate limiting', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(logger, 'debug').mockImplementation(() => {});
    vi.spyOn(logger, 'info').mockImplementation(() => {});
    vi.spyOn(logger, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('executes the first request immediately without any imposed delay', async () => {
    const queue = new NcbiRequestQueue(100);
    const task = vi.fn(async () => 'immediate');

    // The first task should resolve without needing to advance timers.
    const promise = queue.enqueue(task, ctx(), 'esearch', TEST_PARAMS);
    // Flush microtasks so processQueue starts.
    await Promise.resolve();
    await Promise.resolve();
    // Task is async but has no timer dependency on first run — just needs microtasks.
    const result = await promise;

    expect(result).toBe('immediate');
    expect(task).toHaveBeenCalledOnce();
  });

  it('enforces the configured delay between consecutive requests', async () => {
    const DELAY = 100;
    const queue = new NcbiRequestQueue(DELAY);

    const order: string[] = [];
    const t1 = vi.fn(async () => {
      order.push('t1');
      return 'r1';
    });
    const t2 = vi.fn(async () => {
      order.push('t2');
      return 'r2';
    });

    // Enqueue both tasks.
    const p1 = queue.enqueue(t1, ctx(), 'esearch', TEST_PARAMS);
    const p2 = queue.enqueue(t2, ctx(), 'esearch', TEST_PARAMS);

    // Let the first task execute (no wait on first request).
    await vi.advanceTimersByTimeAsync(0);
    expect(t1).toHaveBeenCalledOnce();
    expect(t2).not.toHaveBeenCalled();

    // Advance past the rate-limit window so t2 is unblocked.
    await vi.advanceTimersByTimeAsync(DELAY);

    const [r1, r2] = await Promise.all([p1, p2]);

    expect(r1).toBe('r1');
    expect(r2).toBe('r2');
    expect(order).toEqual(['t1', 't2']);
  });
});

// ---------------------------------------------------------------------------
// Sequential processing
// ---------------------------------------------------------------------------

describe('NcbiRequestQueue — sequential processing', () => {
  beforeEach(() => {
    vi.useRealTimers();
    vi.spyOn(logger, 'debug').mockImplementation(() => {});
    vi.spyOn(logger, 'info').mockImplementation(() => {});
    vi.spyOn(logger, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useFakeTimers();
  });

  it('executes multiple tasks one at a time in FIFO order', async () => {
    const queue = new NcbiRequestQueue(0);
    const order: number[] = [];

    const tasks = [1, 2, 3].map((n) =>
      vi.fn(async () => {
        order.push(n);
        return n;
      }),
    );

    const results = await Promise.all(
      tasks.map((t) => queue.enqueue(t, ctx(), 'esearch', TEST_PARAMS)),
    );

    expect(results).toEqual([1, 2, 3]);
    expect(order).toEqual([1, 2, 3]);
  });

  it('completes tasks in FIFO order regardless of individual task duration', async () => {
    const queue = new NcbiRequestQueue(0);
    const completionOrder: string[] = [];

    // t1 takes longer internally, but t2 must still wait for t1 to finish
    // because the queue is strictly sequential.
    const t1 = vi.fn(async () => {
      await new Promise<void>((r) => setTimeout(r, 20));
      completionOrder.push('t1');
      return 'slow';
    });
    const t2 = vi.fn(async () => {
      completionOrder.push('t2');
      return 'fast';
    });

    const [r1, r2] = await Promise.all([
      queue.enqueue(t1, ctx(), 'esearch', TEST_PARAMS),
      queue.enqueue(t2, ctx(), 'esearch', TEST_PARAMS),
    ]);

    expect(r1).toBe('slow');
    expect(r2).toBe('fast');
    expect(completionOrder).toEqual(['t1', 't2']);
  });
});

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------

describe('NcbiRequestQueue — error handling', () => {
  beforeEach(() => {
    vi.useRealTimers();
    vi.spyOn(logger, 'debug').mockImplementation(() => {});
    vi.spyOn(logger, 'info').mockImplementation(() => {});
    vi.spyOn(logger, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useFakeTimers();
  });

  it('rejects the promise when the task throws', async () => {
    const queue = new NcbiRequestQueue(0);
    const boom = new Error('task exploded');
    const task = vi.fn(async () => {
      throw boom;
    });

    await expect(queue.enqueue(task, ctx(), 'esearch', TEST_PARAMS)).rejects.toThrow(
      'task exploded',
    );
  });

  it('rejects with the exact error instance thrown by the task', async () => {
    const queue = new NcbiRequestQueue(0);
    const original = new McpError(JsonRpcErrorCode.ServiceUnavailable, 'upstream down');
    const task = vi.fn(async () => {
      throw original;
    });

    let caught: unknown;
    try {
      await queue.enqueue(task, ctx(), 'efetch', TEST_PARAMS);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBe(original);
  });

  it('does not block subsequent tasks after one task fails', async () => {
    const queue = new NcbiRequestQueue(0);

    const failing = vi.fn(async () => {
      throw new Error('boom');
    });
    const succeeding = vi.fn(async () => 'ok');

    const p1 = queue.enqueue(failing, ctx(), 'esearch', TEST_PARAMS);
    const p2 = queue.enqueue(succeeding, ctx(), 'esearch', TEST_PARAMS);

    await expect(p1).rejects.toThrow('boom');
    await expect(p2).resolves.toBe('ok');
    expect(succeeding).toHaveBeenCalledOnce();
  });

  it('continues processing after multiple consecutive failures', async () => {
    const queue = new NcbiRequestQueue(0);

    const fail1 = vi.fn(async () => {
      throw new Error('fail1');
    });
    const fail2 = vi.fn(async () => {
      throw new Error('fail2');
    });
    const success = vi.fn(async () => 'recovered');

    const p1 = queue.enqueue(fail1, ctx(), 'esearch', TEST_PARAMS);
    const p2 = queue.enqueue(fail2, ctx(), 'esearch', TEST_PARAMS);
    const p3 = queue.enqueue(success, ctx(), 'esearch', TEST_PARAMS);

    await expect(p1).rejects.toThrow('fail1');
    await expect(p2).rejects.toThrow('fail2');
    await expect(p3).resolves.toBe('recovered');
  });
});

// ---------------------------------------------------------------------------
// Queue drain and restart
// ---------------------------------------------------------------------------

describe('NcbiRequestQueue — queue drain and restart', () => {
  beforeEach(() => {
    vi.useRealTimers();
    vi.spyOn(logger, 'debug').mockImplementation(() => {});
    vi.spyOn(logger, 'info').mockImplementation(() => {});
    vi.spyOn(logger, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useFakeTimers();
  });

  it('drains completely after all tasks finish', async () => {
    const queue = new NcbiRequestQueue(0);
    const tasks = [1, 2, 3].map((n) => vi.fn(async () => n));

    const results = await Promise.all(
      tasks.map((t) => queue.enqueue(t, ctx(), 'esearch', TEST_PARAMS)),
    );

    expect(results).toEqual([1, 2, 3]);
    for (const t of tasks) {
      expect(t).toHaveBeenCalledOnce();
    }
  });

  it('accepts and processes new tasks after the queue drains', async () => {
    const queue = new NcbiRequestQueue(0);

    // First batch
    const t1 = vi.fn(async () => 'batch1');
    const r1 = await queue.enqueue(t1, ctx(), 'esearch', TEST_PARAMS);
    expect(r1).toBe('batch1');

    // Second batch enqueued after drain — should work identically.
    const t2 = vi.fn(async () => 'batch2');
    const r2 = await queue.enqueue(t2, ctx(), 'esearch', TEST_PARAMS);
    expect(r2).toBe('batch2');

    expect(t1).toHaveBeenCalledOnce();
    expect(t2).toHaveBeenCalledOnce();
  });
});
