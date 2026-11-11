/**
 * @fileoverview The fake-clock driver's own contract: it settles a call on the exact
 * instant its last timer fires, and fails loudly — never reporting a settlement that did
 * not happen — when a call is still pending with no timer left to fire or once the clock
 * has moved past the drive's budget. Every NCBI retry-loop suite reads its outcomes
 * through it, so a driver that returned quietly would let a hung call pass.
 * @module tests/services/ncbi/_fake-clock.test
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { driveUntilSettled, track } from './_fake-clock.js';

const T0 = 1_000_000;

beforeEach(() => {
  vi.useFakeTimers({ now: T0 });
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

/** Resolves after `ms` of fake time, through one timer. */
const elapse = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('driveUntilSettled', () => {
  it('settles on the instant the last timer fires, timer to timer', async () => {
    const call = (async () => {
      await elapse(1_000);
      await elapse(30_000);
      throw Object.assign(new Error('gave up'), { code: -1 });
    })();

    const outcome = await driveUntilSettled(track(call), 60_000);

    expect(outcome).toMatchObject({ ok: false, error: { message: 'gave up' } });
    expect(Date.now() - T0).toBe(31_000);
  });

  it('settles a call that needs no timer without moving the clock', async () => {
    await expect(driveUntilSettled(track(Promise.resolve('done')))).resolves.toEqual({ ok: true });
    expect(Date.now()).toBe(T0);
  });

  it('throws when the call is still pending with no timer left to fire', async () => {
    const hung = track(new Promise(() => {}));

    await expect(driveUntilSettled(hung)).rejects.toThrow(
      'Call still pending 0ms into the drive with no fake timer left to fire.',
    );
    expect(hung.outcome).toBeUndefined();
  });

  it('throws once a timer has fired and nothing is left to settle the call', async () => {
    const hung = track(elapse(5_000).then(() => new Promise(() => {})));

    await expect(driveUntilSettled(hung)).rejects.toThrow(
      'Call still pending 5000ms into the drive with no fake timer left to fire.',
    );
  });

  it('throws once the clock has moved past its budget while timers keep firing', async () => {
    const ticker = setInterval(() => {}, 1_000);
    const hung = track(new Promise(() => {}));

    await expect(driveUntilSettled(hung, 10_000)).rejects.toThrow(
      'Call still pending 11000ms into a 10000ms fake-clock drive.',
    );
    expect(Date.now() - T0).toBe(11_000);
    clearInterval(ticker);
  });
});
