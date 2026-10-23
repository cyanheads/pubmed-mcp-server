/**
 * @fileoverview Tests for `outlineShares`, the `outline` overflow mode's split of
 * a character budget across the parts of one level (issue #252): the allotment
 * rule, its equality with the empty-and-recompute statement of that rule, and
 * its running time in the number of parts.
 * @module tests/mcp-server/tools/definitions/_outline-shares.test
 */

import { describe, expect, it } from 'vitest';
import { outlineShares } from '@/mcp-server/tools/definitions/_outline-shares.js';

/**
 * The allotment as first written: equal shares handed out round by round, then
 * the last part cut below the floor emptied and every share recomputed, until
 * none is left. Kept verbatim as the oracle the one-pass version must match.
 */
function evenSharesOracle(caps: number[], total: number): number[] {
  const allowances = caps.map(() => 0);
  let remaining = total;

  while (remaining > 0) {
    const hungry = caps.reduce<number[]>((acc, cap, i) => {
      if ((allowances[i] ?? 0) < cap) acc.push(i);
      return acc;
    }, []);
    if (hungry.length === 0) break;

    const share = Math.floor(remaining / hungry.length);
    for (const i of hungry) {
      const want = (caps[i] ?? 0) - (allowances[i] ?? 0);
      const give = Math.min(share === 0 ? 1 : share, want, remaining);
      allowances[i] = (allowances[i] ?? 0) + give;
      remaining -= give;
      if (remaining === 0) break;
    }
  }
  return allowances;
}

function outlineSharesOracle(caps: number[], total: number, floor: number): number[] {
  const live = [...caps];
  for (;;) {
    const shares = evenSharesOracle(live, total);
    const short = shares.findLastIndex((share, i) => share < (live[i] ?? 0) && share < floor);
    if (short === -1) return shares;
    live[short] = 0;
  }
}

/** Mulberry32: a small seeded generator, so every run draws the same cases. */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('outlineShares (issue #252)', () => {
  it('gives every part its whole cap when the budget covers them all', () => {
    expect(outlineShares([300, 0, 120], 1_000, 100)).toEqual([300, 0, 120]);
  });

  it('raises the level over short parts and spends the whole budget', () => {
    // 100 + 50 leave 850 for the two long parts: 425 each.
    expect(outlineShares([100, 2_000, 50, 3_000], 1_000, 100)).toEqual([100, 425, 50, 425]);
  });

  it('hands the characters short of the next level to the first capped parts', () => {
    expect(outlineShares([500, 500, 500], 1_000, 100)).toEqual([334, 333, 333]);
  });

  it('empties the last part cut below the floor, then the next, until the rest clear it', () => {
    // Six equal parts at 400 share 66 each — under the floor. Emptying from the
    // end leaves four at 100.
    expect(outlineShares([1_000, 1_000, 1_000, 1_000, 1_000, 1_000], 400, 100)).toEqual([
      100, 100, 100, 100, 0, 0,
    ]);
  });

  it('keeps a part that fits whole at any length, below the floor included', () => {
    expect(outlineShares([1_000, 30, 1_000, 1_000], 280, 100)).toEqual([125, 30, 125, 0]);
  });

  it('returns nothing for an empty or zero budget, and no parts for no parts', () => {
    expect(outlineShares([200, 300], 0, 100)).toEqual([0, 0]);
    expect(outlineShares([200, 300], -5, 100)).toEqual([0, 0]);
    expect(outlineShares([], 1_000, 100)).toEqual([]);
  });

  it('matches the empty-and-recompute rule on every seeded case', () => {
    const random = seeded(255_252);
    const int = (below: number) => Math.floor(random() * below);
    /** Draws whose expected allotment takes each branch of the rule. */
    const reached = { whole: 0, cut: 0, emptied: 0 };
    for (let draw = 0; draw < 4_000; draw++) {
      const parts = draw % 50 === 0 ? 100 + int(150) : int(24);
      const shape = int(4);
      const caps = Array.from({ length: parts }, () => {
        if (shape === 0) return int(400); // short parts around the floor
        if (shape === 1) return int(4) === 0 ? 0 : 50 + int(5_000); // empty parts among long ones
        if (shape === 2) return 700; // all equal, so the remainder and the floor decide
        return int(3) === 0 ? int(120) : int(20_000); // a few short among very long
      });
      const sum = caps.reduce((n, cap) => n + cap, 0);
      const total = int(5) === 0 ? int(parts + 3) : int(Math.ceil(sum * 1.2) + 2);
      const floor = [0, 1, 37, 100, 100, 150][int(6)] ?? 100;
      const expected = outlineSharesOracle(caps, total, floor);
      expect(outlineShares(caps, total, floor), JSON.stringify({ caps, total, floor })).toEqual(
        expected,
      );
      const cap = (i: number) => caps[i] ?? 0;
      if (parts > 0 && expected.every((share, i) => share === cap(i))) reached.whole += 1;
      if (expected.some((share, i) => share > 0 && share < cap(i))) reached.cut += 1;
      if (expected.some((share, i) => share === 0 && cap(i) > 0) && expected.some((s) => s > 0)) {
        reached.emptied += 1;
      }
    }
    // Every branch is compared hundreds of times, so no draw change can leave one untested.
    expect(
      Math.min(reached.whole, reached.cut, reached.emptied),
      JSON.stringify(reached),
    ).toBeGreaterThan(200);
  });
});

describe('outlineShares runs in O(n log n) in the number of parts (issue #252)', () => {
  /** CPU time of `run`, in ms — this thread's user + system time, not wall clock. */
  const cpuMs = (run: () => void): number => {
    const start = process.threadCpuUsage();
    run();
    const { user, system } = process.threadCpuUsage(start);
    return (user + system) / 1000;
  };

  /** Fastest of five readings of one call — the least noisy measure of the work. */
  const fastestMs = (caps: number[], total: number): number => {
    outlineShares(caps, total, 100);
    return Math.min(
      ...Array.from({ length: 5 }, () => cpuMs(() => outlineShares(caps, total, 100))),
    );
  };

  const SHAPES: Array<[string, (parts: number) => [number[], number]]> = [
    // Every part under the floor at once: half of them emptied, one by one.
    ['equal parts under the floor', (n) => [Array.from({ length: n }, () => 1_000), 50 * n]],
    // Short parts the level covers whole, interleaved with ones it cuts.
    [
      'short and long parts interleaved',
      (n) => [Array.from({ length: n }, (_, i) => (i % 3 === 0 ? 40 + (i % 50) : 5_000)), 120 * n],
    ],
    // Caps rising with position, so the last parts — emptied first — are the longest.
    ['caps rising with position', (n) => [Array.from({ length: n }, (_, i) => 10 + i), 30 * n]],
  ];

  it.each(SHAPES)('scales from 500 to 32,000 parts of %s', (_label, build) => {
    // Doubling from 500, each size checked against the absolute bound before the next runs.
    const times: number[] = [];
    for (let parts = 500; parts <= 32_000; parts *= 2) {
      const ms = fastestMs(...build(parts));
      expect(ms).toBeLessThan(200);
      times.push(ms);
    }
    // n log n grows about 107× across the span; quadratic grows 4096×.
    expect((times.at(-1) ?? 0) / Math.max(times[0] ?? 0, 0.05)).toBeLessThan(256);
  });
});
