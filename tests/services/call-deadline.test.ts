/**
 * @fileoverview Tests for the per-tool-call deadline: its length under each provider
 * configuration, the time it has left, the share a chain step runs under, and the
 * bound one upstream call takes from it.
 * @module tests/services/call-deadline.test
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type CallDeadline,
  callDeadlineMs,
  isSpent,
  remainingMs,
  shareDeadline,
  upstreamBound,
} from '@/services/call-deadline.js';

const NOW = Date.UTC(2026, 0, 1);

/** A deadline set at `NOW` to run `totalMs`. */
const deadlineOf = (totalMs: number): CallDeadline => ({ expiresAt: NOW + totalMs, totalMs });

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('callDeadlineMs', () => {
  it.each([
    ['both provider deadlines at their defaults', 50_000, 45_000, 50_000],
    ['both provider deadlines lowered', 10_000, 5_000, 50_000],
    ['the NCBI deadline raised past 50 s', 120_000, 45_000, 120_000],
    ['the Europe PMC deadline raised past 50 s', 50_000, 90_000, 90_000],
    ['both raised, Europe PMC further', 70_000, 80_000, 80_000],
  ])('is 50 s or the longest raised provider deadline: %s', (_case, ncbi, europepmc, expected) => {
    expect(callDeadlineMs({ totalDeadlineMs: ncbi, europepmcTotalDeadlineMs: europepmc })).toBe(
      expected,
    );
  });
});

describe('startCallDeadline', () => {
  /** Loads the module against a fresh config, so each case reads its own environment. */
  async function start(): Promise<CallDeadline> {
    vi.resetModules();
    const { startCallDeadline } = await import('@/services/call-deadline.js');
    return startCallDeadline();
  }

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('runs 50 s from now at the default configuration', async () => {
    delete process.env.NCBI_TOTAL_DEADLINE_MS;
    delete process.env.EUROPEPMC_TOTAL_DEADLINE_MS;

    expect(await start()).toEqual({ expiresAt: NOW + 50_000, totalMs: 50_000 });
  });

  it('runs as long as a provider deadline an operator raised past 50 s', async () => {
    vi.stubEnv('NCBI_TOTAL_DEADLINE_MS', '120000');

    expect(await start()).toEqual({ expiresAt: NOW + 120_000, totalMs: 120_000 });
  });
});

describe('remainingMs and isSpent', () => {
  it('counts down from the full length and never goes negative', () => {
    const deadline = deadlineOf(50_000);
    expect(remainingMs(deadline)).toBe(50_000);

    vi.setSystemTime(NOW + 20_000);
    expect(remainingMs(deadline)).toBe(30_000);

    vi.setSystemTime(NOW + 80_000);
    expect(remainingMs(deadline)).toBe(0);
  });

  it.each([
    [49_998, false],
    [49_999, true],
    [50_000, true],
    [50_001, true],
  ])('%i ms into a 50 s deadline, spent is %s', (elapsedMs, spent) => {
    vi.setSystemTime(NOW + elapsedMs);
    expect(isSpent(deadlineOf(50_000))).toBe(spent);
  });
});

describe('shareDeadline', () => {
  it('gives a step with others after it half the time left', () => {
    const call = deadlineOf(50_000);

    expect(shareDeadline(call)).toEqual({ expiresAt: NOW + 25_000, totalMs: 25_000 });

    // The first step hung for its whole share: the next takes half of what is left.
    vi.setSystemTime(NOW + 25_000);
    expect(shareDeadline(call)).toEqual({ expiresAt: NOW + 37_500, totalMs: 12_500 });
  });

  it('returns the time a step did not use to the steps after it', () => {
    const call = deadlineOf(50_000);

    // The first step answered in 2 s of its 25 s share: 48 s are left to share.
    vi.setSystemTime(NOW + 2_000);
    expect(shareDeadline(call)).toEqual({ expiresAt: NOW + 26_000, totalMs: 24_000 });
  });

  it('rounds a share down, so a share never ends past the deadline', () => {
    const call = deadlineOf(50_000);
    vi.setSystemTime(NOW + 49_995);

    expect(shareDeadline(call)).toEqual({ expiresAt: NOW + 49_997, totalMs: 2 });
  });

  it('hands a step of a spent deadline the deadline itself', () => {
    const call = deadlineOf(50_000);
    vi.setSystemTime(NOW + 49_999);

    expect(shareDeadline(call)).toBe(call);
  });
});

describe('upstreamBound', () => {
  it("is the provider's own deadline when the call carries none", () => {
    expect(upstreamBound(45_000)).toEqual({
      deadlineMs: 45_000,
      remainingMs: 45_000,
      spent: false,
    });
  });

  it("is the provider's own deadline while the call has at least that long left", () => {
    expect(upstreamBound(45_000, deadlineOf(50_000))).toEqual({
      deadlineMs: 45_000,
      remainingMs: 45_000,
      spent: false,
    });

    vi.setSystemTime(NOW + 5_000);
    expect(upstreamBound(45_000, deadlineOf(50_000))).toEqual({
      deadlineMs: 45_000,
      remainingMs: 45_000,
      spent: false,
    });
  });

  it("is the time the call has left once that is less, reported as the call deadline's length", () => {
    vi.setSystemTime(NOW + 20_000);

    expect(upstreamBound(45_000, deadlineOf(50_000))).toEqual({
      deadlineMs: 50_000,
      remainingMs: 30_000,
      spent: false,
    });
  });

  it.each([
    [49_999, 1],
    [50_000, 0],
    [65_000, 0],
  ])('is spent %i ms into a 50 s call deadline', (elapsedMs, left) => {
    vi.setSystemTime(NOW + elapsedMs);

    expect(upstreamBound(45_000, deadlineOf(50_000))).toEqual({
      deadlineMs: 50_000,
      remainingMs: left,
      spent: true,
    });
  });
});
