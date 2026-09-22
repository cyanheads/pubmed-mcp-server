/**
 * @fileoverview Regression for issue #157 — an NCBI 429 closes the shared request
 * queue for every caller instead of each caller retrying into the throttle, and a
 * caller the queue cannot start before its deadline is shed as `queue_full` at once.
 * Drives the production wiring (`initNcbiService`: real client, queue, retry, and
 * response handler) against a stubbed global fetch under fake timers, so every
 * assertion reads when upstream requests actually started.
 * @module tests/services/ncbi/rate-limit-cooldown.test
 */

import { JsonRpcErrorCode, type McpError } from '@cyanheads/mcp-ts-core/errors';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@cyanheads/mcp-ts-core/utils', async () => {
  const actual = await vi.importActual<typeof import('@cyanheads/mcp-ts-core/utils')>(
    '@cyanheads/mcp-ts-core/utils',
  );
  return {
    ...actual,
    logger: { debug: vi.fn(), info: vi.fn(), notice: vi.fn(), warning: vi.fn(), error: vi.fn() },
    requestContextService: { createRequestContext: vi.fn(() => ({ requestId: 'test' })) },
  };
});

/** Fake-clock origin. Nonzero so no scheduler reads a zero timestamp as "never started". */
const T0 = 1_000_000;

const ESEARCH_OK =
  '<?xml version="1.0" encoding="UTF-8" ?>\n<eSearchResult><Count>1</Count><RetMax>1</RetMax><RetStart>0</RetStart><IdList><Id>23193287</Id></IdList><QueryTranslation>test</QueryTranslation></eSearchResult>';

/** The JSON body NCBI answers a throttled key with. */
const RATE_LIMIT_BODY = '{"error":"API rate limit exceeded","count":"4","limit":"3"}';

type Reply = { status: 200 } | { status: 429; retryAfter?: string };

/** Offsets from T0 at which each upstream request started, in call order. */
let starts: number[];

function stubFetch(script: Reply[]): void {
  starts = [];
  let call = 0;
  vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
    starts.push(Date.now() - T0);
    const reply = script[Math.min(call++, script.length - 1)] as Reply;
    if (reply.status === 200) return Promise.resolve(new Response(ESEARCH_OK, { status: 200 }));
    return Promise.resolve(
      new Response(RATE_LIMIT_BODY, {
        status: 429,
        headers: {
          'content-type': 'application/json',
          ...(reply.retryAfter && { 'retry-after': reply.retryAfter }),
        },
      }),
    );
  });
}

type NcbiService = import('@/services/ncbi/ncbi-service.js').NcbiService;

async function buildService(env: {
  delayMs: number;
  deadlineMs: number;
  maxRetries: number;
}): Promise<NcbiService> {
  vi.stubEnv('NCBI_API_KEY', '');
  vi.stubEnv('NCBI_REQUEST_DELAY_MS', String(env.delayMs));
  vi.stubEnv('NCBI_MAX_CONCURRENT', '4');
  vi.stubEnv('NCBI_MAX_RETRIES', String(env.maxRetries));
  vi.stubEnv('NCBI_TOTAL_DEADLINE_MS', String(env.deadlineMs));
  const { initNcbiService, getNcbiService } = await import('@/services/ncbi/ncbi-service.js');
  initNcbiService();
  return getNcbiService();
}

type Outcome = { ok: true } | { ok: false; error: McpError };

/** Tracks a call's settlement without awaiting it, so the test can keep driving the clock. */
function track(promise: Promise<unknown>): { outcome: Outcome | undefined } {
  const handle: { outcome: Outcome | undefined } = { outcome: undefined };
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

/** Advances the fake clock in small steps until `handle` settles (or the budget runs out). */
async function driveUntilSettled(handle: { outcome: Outcome | undefined }, budgetMs = 30_000) {
  for (let spent = 0; handle.outcome === undefined && spent <= budgetMs; spent += 10) {
    await vi.advanceTimersByTimeAsync(10);
  }
  return handle.outcome;
}

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers({ now: T0 });
  // Pin backoff jitter so a retry's sleep is exactly its exponential value.
  vi.spyOn(Math, 'random').mockReturnValue(0.5);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

const search = (service: NcbiService, term: string, signal?: AbortSignal) =>
  service.eSearch({ db: 'pubmed', term }, signal ? { signal } : undefined);

describe('NCBI 429 cooldown gate (issue #157)', () => {
  it('holds every caller behind an escalating cooldown that the first success resets', async () => {
    // Four single-attempt callers in sequence, each started once the previous one
    // settled: 429, 429, success, 429, success.
    stubFetch([
      { status: 429 },
      { status: 429 },
      { status: 200 },
      { status: 429 },
      { status: 200 },
    ]);
    const service = await buildService({ delayMs: 50, deadlineMs: 60_000, maxRetries: 0 });

    const outcomes: Outcome[] = [];
    for (const term of ['a', 'b', 'c', 'd', 'e']) {
      const outcome = await driveUntilSettled(track(search(service, term)));
      outcomes.push(outcome as Outcome);
    }

    // A throttled at 0 closes the gate for 1s; B waits it out and is throttled
    // again, doubling it to 2s; C waits that out and succeeds, resetting the
    // count; D goes out one start-gap later and its 429 closes the gate for 1s,
    // not 4s — the escalation restarted.
    expect(starts).toEqual([0, 1000, 3000, 3050, 4050]);
    expect(outcomes.map((o) => o.ok)).toEqual([false, false, true, false, true]);
    expect(outcomes[0]).toMatchObject({ error: { code: JsonRpcErrorCode.RateLimited } });
  });

  it('holds a caller that arrives while the gate is closed, then starts it when the gate opens', async () => {
    stubFetch([{ status: 429 }, { status: 200 }]);
    const service = await buildService({ delayMs: 50, deadlineMs: 60_000, maxRetries: 0 });

    const throttled = await driveUntilSettled(track(search(service, 'a')));
    expect(throttled).toMatchObject({ ok: false });

    const queued = track(search(service, 'b'));
    // Up to 1ms before the gate reopens, 1s after the 429.
    await vi.advanceTimersByTimeAsync(T0 + 999 - Date.now());
    expect(starts).toEqual([0]);
    expect(queued.outcome).toBeUndefined();

    await vi.advanceTimersByTimeAsync(1);
    expect(starts).toEqual([0, 1000]);
    expect(await driveUntilSettled(queued)).toEqual({ ok: true });
  });

  it('re-queues a retried attempt behind the gate its own 429 closed, after a caller that arrived meanwhile', async () => {
    // A is throttled at 0 and retries; B arrives while the gate is closed. Retry
    // outside, queue inside: A's retry re-enters the queue behind B once its 1s
    // backoff ends, so B starts when the gate opens and A one start-gap later. A
    // retry loop inside the queue would never close the gate, starting B at 50.
    stubFetch([{ status: 429 }, { status: 200 }]);
    const service = await buildService({ delayMs: 50, deadlineMs: 60_000, maxRetries: 1 });

    const a = track(search(service, 'a'));
    await vi.advanceTimersByTimeAsync(10);
    const b = track(search(service, 'b'));

    expect(await driveUntilSettled(a)).toEqual({ ok: true });
    expect(await driveUntilSettled(b)).toEqual({ ok: true });
    expect(starts).toEqual([0, 1000, 1050]);
  });

  it('waits the Retry-After window NCBI names when it is longer than the cooldown', async () => {
    stubFetch([{ status: 429, retryAfter: '3' }, { status: 200 }]);
    const service = await buildService({ delayMs: 50, deadlineMs: 60_000, maxRetries: 0 });

    await driveUntilSettled(track(search(service, 'a')));
    await driveUntilSettled(track(search(service, 'b')));

    expect(starts).toEqual([0, 3000]);
  });

  it('caps an oversized Retry-After at the cooldown ceiling', async () => {
    stubFetch([{ status: 429, retryAfter: '120' }, { status: 200 }]);
    const service = await buildService({ delayMs: 50, deadlineMs: 60_000, maxRetries: 0 });

    await driveUntilSettled(track(search(service, 'a')));
    await driveUntilSettled(track(search(service, 'b')), 60_000);

    expect(starts).toEqual([0, 15_000]);
  });

  it('a caller cancelled while held behind the gate rejects with its own reason and never starts', async () => {
    stubFetch([{ status: 429 }, { status: 200 }]);
    const service = await buildService({ delayMs: 50, deadlineMs: 60_000, maxRetries: 0 });

    await driveUntilSettled(track(search(service, 'a')));
    const controller = new AbortController();
    const held = track(search(service, 'b', controller.signal));

    await vi.advanceTimersByTimeAsync(200);
    controller.abort(new Error('caller cancelled behind the gate'));
    await vi.advanceTimersByTimeAsync(0);

    expect(held.outcome).toMatchObject({
      ok: false,
      error: { message: 'caller cancelled behind the gate' },
    });
    await vi.advanceTimersByTimeAsync(2000);
    expect(starts).toEqual([0]);
  });
});

describe('deadline-aware shedding (issue #157)', () => {
  it('sheds a call the queue cannot start before its deadline as queue_full, at once and without retrying', async () => {
    stubFetch([{ status: 200 }]);
    // A 3s start gap against a 5s deadline: the first call starts now, the second
    // at 3s, the third could not start before 6s.
    const service = await buildService({ delayMs: 3000, deadlineMs: 5000, maxRetries: 3 });

    const first = track(search(service, 'a'));
    const second = track(search(service, 'b'));
    const third = track(search(service, 'c'));
    await vi.advanceTimersByTimeAsync(0);

    // Settled with no clock movement: one attempt, no backoff sleep.
    expect(third.outcome).toMatchObject({
      ok: false,
      error: {
        code: JsonRpcErrorCode.RateLimited,
        data: {
          reason: 'queue_full',
          endpoint: 'esearch',
          retryAfter: 6,
          recovery: { hint: expect.stringContaining('retryAfter') },
        },
      },
    });
    expect(starts).toEqual([0]);

    expect(await driveUntilSettled(second)).toEqual({ ok: true });
    expect(first.outcome).toEqual({ ok: true });
    expect(starts).toEqual([0, 3000]);
  });

  it('sheds a caller whose deadline cannot outlast an escalated cooldown', async () => {
    // Consecutive 429s escalate the gate 1s → 2s → 4s → 8s. A caller arriving
    // behind the 8s gate with a 5s deadline is shed instead of queued.
    stubFetch([{ status: 429 }]);
    const service = await buildService({ delayMs: 50, deadlineMs: 5000, maxRetries: 0 });

    for (const term of ['a', 'b', 'c', 'd']) {
      const outcome = await driveUntilSettled(track(search(service, term)));
      expect(outcome).toMatchObject({ error: { code: JsonRpcErrorCode.RateLimited } });
    }
    expect(starts).toEqual([0, 1000, 3000, 7000]);

    const shed = track(search(service, 'e'));
    await vi.advanceTimersByTimeAsync(0);

    expect(shed.outcome).toMatchObject({
      ok: false,
      error: {
        code: JsonRpcErrorCode.RateLimited,
        data: { reason: 'queue_full', retryAfter: 8 },
      },
    });
    expect(starts).toHaveLength(4);
  });
});
