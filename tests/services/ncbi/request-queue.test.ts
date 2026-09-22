/**
 * @fileoverview Tests for the NCBI request queue — the framework pacer configured with
 * NCBI's start gap, concurrency cap, queue depth, and 429 cooldown.
 * @module tests/services/ncbi/request-queue.test
 */

import { JsonRpcErrorCode, rateLimited, serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
import type { Pacer } from '@cyanheads/mcp-ts-core/utils';
import { describe, expect, it, vi } from 'vitest';
import { createNcbiRequestQueue } from '@/services/ncbi/request-queue.js';

function createQueue(minStartGapMs: number, maxConcurrent = 8, maxQueueDepth?: number): Pacer {
  return createNcbiRequestQueue({
    minStartGapMs,
    maxConcurrent,
    ...(maxQueueDepth !== undefined && { maxQueueDepth }),
  });
}

describe('createNcbiRequestQueue', () => {
  it('executes a single task', async () => {
    const queue = createQueue(0);
    const result = await queue.run(() => Promise.resolve('done'));
    expect(result).toBe('done');
  });

  it('dispatches multiple tasks in FIFO order', async () => {
    const queue = createQueue(0);
    const dispatched: number[] = [];

    const tasks = [1, 2, 3].map((n) =>
      queue.run(async () => {
        dispatched.push(n);
        return n;
      }),
    );

    const results = await Promise.all(tasks);
    expect(results).toEqual([1, 2, 3]);
    expect(dispatched).toEqual([1, 2, 3]);
  });

  it('runs tasks concurrently up to maxConcurrent', async () => {
    const queue = createQueue(0, 3);
    let inFlight = 0;
    let peak = 0;

    const task = async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise<void>((r) => setTimeout(r, 30));
      inFlight -= 1;
    };

    await Promise.all([queue.run(task), queue.run(task), queue.run(task)]);

    expect(peak).toBe(3);
  });

  it('caps in-flight tasks at maxConcurrent', async () => {
    const queue = createQueue(0, 2);
    let inFlight = 0;
    let peak = 0;

    const task = async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise<void>((r) => setTimeout(r, 30));
      inFlight -= 1;
    };

    await Promise.all([queue.run(task), queue.run(task), queue.run(task), queue.run(task)]);

    expect(peak).toBe(2);
  });

  it('rejects a queued task when its abort signal fires before dispatch', async () => {
    const queue = createQueue(0, 1);

    // Block the only in-flight slot.
    const blockerTask = vi.fn(() => new Promise<void>((r) => setTimeout(r, 100)));
    const blocker = queue.run(blockerTask);

    const controller = new AbortController();
    const queuedTask = vi.fn(() => Promise.resolve('done'));
    const queued = queue.run(queuedTask, { signal: controller.signal });

    controller.abort(new Error('queue wait cancelled'));

    await expect(queued).rejects.toThrow(/queue wait cancelled/);
    expect(queuedTask).not.toHaveBeenCalled();

    await blocker;
    expect(blockerTask).toHaveBeenCalledTimes(1);
  });

  it('rejects immediately when the abort signal is already aborted', async () => {
    const queue = createQueue(0, 4);
    const controller = new AbortController();
    controller.abort(new Error('already aborted'));

    const task = vi.fn(() => Promise.resolve());
    await expect(queue.run(task, { signal: controller.signal })).rejects.toThrow(/already aborted/);
    expect(task).not.toHaveBeenCalled();
  });

  it('sheds an arrival once the queue is at depth', async () => {
    // maxConcurrent=1 → only one task can be in flight; maxQueueDepth=1 → one
    // task can wait. A third request overflows.
    const queue = createQueue(0, 1, 1);
    const blocking = new Promise<void>((resolve) => setTimeout(resolve, 100));
    const inFlight = queue.run(() => blocking); // takes the in-flight slot
    const waiting = queue.run(() => Promise.resolve()); // fills the queue

    const overflowTask = vi.fn(() => Promise.resolve());
    // The service relabels this rejection `queue_full`; the queue itself reports the
    // framework's shed, which the retry loop is built not to retry.
    await expect(queue.run(overflowTask)).rejects.toMatchObject({
      code: JsonRpcErrorCode.RateLimited,
      data: { reason: 'pacer_shed', queueDepth: 1, retryAfter: expect.any(Number) },
    });
    expect(overflowTask).not.toHaveBeenCalled();

    await Promise.all([inFlight, waiting]);
  });

  it('propagates task errors to the caller', async () => {
    const queue = createQueue(0);
    await expect(queue.run(() => Promise.reject(new Error('task failed')))).rejects.toThrow(
      'task failed',
    );
  });

  it('continues processing after a failed task', async () => {
    const queue = createQueue(0);
    const p1 = queue.run(() => Promise.reject(new Error('fail'))).catch(() => 'caught');
    const p2 = queue.run(() => Promise.resolve('ok'));

    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toBe('caught');
    expect(r2).toBe('ok');
  });

  it('does not block a fast task behind a slow one when concurrency > 1', async () => {
    const queue = createQueue(0, 2);
    const completions: string[] = [];

    const slow = queue.run(async () => {
      await new Promise<void>((r) => setTimeout(r, 100));
      completions.push('slow');
    });
    const fast = queue.run(async () => {
      await new Promise<void>((r) => setTimeout(r, 10));
      completions.push('fast');
    });

    await Promise.all([slow, fast]);
    expect(completions).toEqual(['fast', 'slow']);
  }, 1000);

  it('serializes execution when maxConcurrent=1', async () => {
    const queue = createQueue(0, 1);
    let inFlight = 0;
    let peak = 0;

    const task = async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise<void>((r) => setTimeout(r, 20));
      inFlight -= 1;
    };

    await Promise.all([queue.run(task), queue.run(task), queue.run(task)]);

    expect(peak).toBe(1);
  }, 1000);

  it('handles a burst of 50 tasks without losing any', async () => {
    const queue = createQueue(0, 4);

    const tasks = Array.from({ length: 50 }, (_, i) =>
      queue.run(async () => {
        await new Promise<void>((r) => setTimeout(r, 5));
        return i;
      }),
    );

    const finished = await Promise.all(tasks);
    expect(finished).toHaveLength(50);
    expect(new Set(finished).size).toBe(50);
    expect(finished).toEqual([...Array(50).keys()]);
  }, 2000);

  it('respects min-start-gap between consecutive starts with concurrency > 1', async () => {
    const queue = createQueue(50, 3);
    const startTimes: number[] = [];
    const begin = Date.now();

    const tasks = [0, 1, 2].map((i) =>
      queue.run(async () => {
        startTimes.push(Date.now() - begin);
        return i;
      }),
    );

    await Promise.all(tasks);

    // Starts should land near 0, 50, 100 with generous CI tolerance.
    expect(startTimes[0]).toBeLessThan(30);
    expect(startTimes[1] as number).toBeGreaterThanOrEqual(40);
    expect(startTimes[1] as number).toBeLessThan(110);
    expect(startTimes[2] as number).toBeGreaterThanOrEqual(90);
    expect(startTimes[2] as number).toBeLessThan(180);
  }, 2000);

  it('frees the slot when a task rejects', async () => {
    const queue = createQueue(0, 1);

    await expect(queue.run(() => Promise.reject(new Error('boom')))).rejects.toThrow('boom');

    // If the slot were still held, the next task would hang on the in-flight cap.
    const result = await queue.run(() => Promise.resolve('ok'));
    expect(result).toBe('ok');
  }, 1000);

  it('frees the slot when a task throws synchronously', async () => {
    const queue = createQueue(0, 1);

    await expect(
      queue.run((() => {
        throw new Error('sync boom');
      }) as () => Promise<unknown>),
    ).rejects.toThrow('sync boom');

    const result = await queue.run(() => Promise.resolve('ok'));
    expect(result).toBe('ok');
  }, 1000);

  it('does not reject a completed task when its signal aborts later', async () => {
    const queue = createQueue(0, 1);
    const controller = new AbortController();
    let lateRejection: unknown;

    const promise = queue.run(() => Promise.resolve('ok'), { signal: controller.signal });
    promise.catch((e: unknown) => {
      lateRejection = e;
    });

    const result = await promise;
    expect(result).toBe('ok');

    controller.abort(new Error('late'));
    await new Promise<void>((r) => setTimeout(r, 10));

    expect(lateRejection).toBeUndefined();
  }, 1000);

  it('tolerates a pending dispatch timer after its waiter is cancelled', async () => {
    // Dispatch once, then queue a task that has to wait out the start gap and
    // cancel it. The gap timer eventually fires with no waiter left and must not
    // throw or strand the queue.
    const queue = createQueue(60, 2);

    await queue.run(() => Promise.resolve());

    const controller = new AbortController();
    const queued = queue.run(() => Promise.resolve('should-not-run'), {
      signal: controller.signal,
    });
    controller.abort(new Error('cancelled before gap elapsed'));
    await expect(queued).rejects.toThrow(/cancelled/);

    await new Promise<void>((r) => setTimeout(r, 100));

    const fresh = await queue.run(() => Promise.resolve('fresh'));
    expect(fresh).toBe('fresh');
  }, 2000);

  it('allows mixed signal / no-signal waiters in the same queue', async () => {
    const queue = createQueue(0, 1);
    const blocker = queue.run(() => new Promise<void>((r) => setTimeout(r, 50)));

    const controller = new AbortController();
    const withSignal = queue.run(() => Promise.resolve('with-signal'), {
      signal: controller.signal,
    });
    const withoutSignal = queue.run(() => Promise.resolve('without-signal'));

    controller.abort(new Error('cancelled'));

    await expect(withSignal).rejects.toThrow(/cancelled/);
    const both = await Promise.all([blocker, withoutSignal]);
    expect(both[1]).toBe('without-signal');
  }, 2000);

  it('delays the next dispatch when requests arrive inside the rate-limit window', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);

    try {
      const queue = createQueue(1000);
      const firstTask = vi.fn(async () => 'first');
      const secondTask = vi.fn(async () => 'second');

      const first = queue.run(firstTask);
      await vi.runAllTimersAsync();
      await expect(first).resolves.toBe('first');

      const second = queue.run(secondTask);
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(999);
      expect(secondTask).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      await expect(second).resolves.toBe('second');
      expect(secondTask).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('sheds an arrival whose projected wait exceeds its maxWaitMs, without running it', async () => {
    const queue = createQueue(1000, 4);
    await queue.run(() => Promise.resolve());

    const task = vi.fn(() => Promise.resolve('late'));
    await expect(queue.run(task, { maxWaitMs: 500 })).rejects.toMatchObject({
      code: JsonRpcErrorCode.RateLimited,
      data: { reason: 'pacer_shed', retryAfter: 1 },
    });
    expect(task).not.toHaveBeenCalled();
  });
});

describe('createNcbiRequestQueue 429 cooldown', () => {
  /** Runs `outcomes` one task at a time and returns each task's start offset. */
  async function startsFor(
    queue: Pacer,
    outcomes: ReadonlyArray<'throttled' | 'ok' | 'failed' | { retryAfter: string }>,
  ): Promise<number[]> {
    const begin = Date.now();
    const starts: number[] = [];
    for (const outcome of outcomes) {
      const run = queue
        .run(async () => {
          starts.push(Date.now() - begin);
          if (outcome === 'ok') return;
          if (outcome === 'failed') throw serviceUnavailable('backend down');
          throw rateLimited('throttled', typeof outcome === 'object' ? outcome : {});
        })
        .catch(() => undefined);
      await vi.runAllTimersAsync();
      await run;
    }
    return starts;
  }

  function withFakeClock(body: () => Promise<void>) {
    return async () => {
      vi.useFakeTimers();
      vi.setSystemTime(100_000);
      try {
        await body();
      } finally {
        vi.useRealTimers();
      }
    };
  }

  it(
    'doubles the gate on each consecutive 429 from one second up to the 15s ceiling',
    withFakeClock(async () => {
      const queue = createQueue(0, 4);
      const starts = await startsFor(queue, [
        'throttled',
        'throttled',
        'throttled',
        'throttled',
        'throttled',
        'throttled',
        'ok',
      ]);
      // Gaps: 1s, 2s, 4s, 8s, then 16s capped at 15s, twice.
      expect(starts).toEqual([0, 1000, 3000, 7000, 15_000, 30_000, 45_000]);
    }),
  );

  it(
    'resets the escalation on the first success',
    withFakeClock(async () => {
      const queue = createQueue(0, 4);
      const starts = await startsFor(queue, ['throttled', 'throttled', 'ok', 'throttled', 'ok']);
      // After the success the next 429 closes the gate for 1s again, not 4s.
      expect(starts).toEqual([0, 1000, 3000, 3000, 4000]);
    }),
  );

  it(
    'leaves the gate open on a failure that is not a rate limit',
    withFakeClock(async () => {
      const queue = createQueue(0, 4);
      const starts = await startsFor(queue, ['failed', 'failed', 'ok']);
      expect(starts).toEqual([0, 0, 0]);
    }),
  );

  it(
    'honors a longer Retry-After and caps it at the ceiling',
    withFakeClock(async () => {
      const queue = createQueue(0, 4);
      const starts = await startsFor(queue, [
        { retryAfter: '3' },
        'ok',
        { retryAfter: '120' },
        'ok',
      ]);
      expect(starts).toEqual([0, 3000, 3000, 18_000]);
    }),
  );
});
