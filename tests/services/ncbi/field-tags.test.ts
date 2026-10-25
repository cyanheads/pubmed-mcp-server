/**
 * @fileoverview Tests for the shared PubMed field-tag classification.
 * @module tests/services/ncbi/field-tags.test
 */

import { describe, expect, it } from 'vitest';

import { fieldTagKind } from '@/services/ncbi/field-tags.js';

describe('fieldTagKind (#259)', () => {
  it.each([
    // Free text: the value is words of the record's own text.
    ['tiab', 'free-text'],
    ['Title/Abstract', 'free-text'],
    ['ti', 'free-text'],
    ['Title', 'free-text'],
    ['tw', 'free-text'],
    ['Text Word', 'free-text'],
    ['ot', 'free-text'],
    ['Other Term', 'free-text'],
    ['tt', 'free-text'],
    ['Transliterated Title', 'free-text'],
    ['all', 'free-text'],
    ['All Fields', 'free-text'],
    ['cois', 'free-text'],
    ['Conflict of Interest Statements', 'free-text'],
    ['tiab:~3', 'free-text'],
    // Indexed: the value matches an index ESpell's dictionary does not hold.
    ['mh', 'indexed'],
    ['MeSH Terms', 'indexed'],
    ['mh:noexp', 'indexed'],
    ['majr', 'indexed'],
    ['pt', 'indexed'],
    ['Publication Type', 'indexed'],
    ['ta', 'indexed'],
    ['Journal', 'indexed'],
    ['au', 'indexed'],
    ['Author', 'indexed'],
    ['la', 'indexed'],
    ['Language', 'indexed'],
    ['sb', 'indexed'],
    ['filter', 'indexed'],
    ['ad', 'indexed'],
    ['dp', 'indexed'],
    ['Date - Publication', 'indexed'],
    // Not a PubMed field tag: PubMed searches the bracket's content as text.
    ['ab', undefined],
    ['18F', undefined],
    ['cancer', undefined],
    ['smith j', undefined],
    [':noexp', undefined],
    ['', undefined],
  ] as const)('reads [%s] as %s', (content, kind) => {
    expect(fieldTagKind(content)).toBe(kind);
  });

  it.each([
    ['surrounding whitespace', '  MH  ', 'indexed'],
    ['capitals', 'TIAB', 'free-text'],
    ['whitespace before the modifier', 'mh :noexp', 'indexed'],
  ] as const)('ignores %s', (_label, content, kind) => {
    expect(fieldTagKind(content)).toBe(kind);
  });

  describe('linear time on adversarial input', () => {
    /** CPU time of `run`, in ms — this thread's user + system time, not wall clock. */
    const cpuMs = (run: () => void): number => {
      const start = process.threadCpuUsage();
      run();
      const { user, system } = process.threadCpuUsage(start);
      return (user + system) / 1000;
    };

    /** Fastest of three single-call measurements after one warm-up call. */
    const fastestMs = (content: string): number => {
      fieldTagKind(content);
      return Math.min(...Array.from({ length: 3 }, () => cpuMs(() => fieldTagKind(content))));
    };

    it.each<[string, (n: number) => string, ReturnType<typeof fieldTagKind>]>([
      [
        'a whitespace run between a word and a modifier',
        (n) => `mh${' '.repeat(n)}:noexp`,
        'indexed',
      ],
      ['a whitespace run with no modifier', (n) => `a${' '.repeat(n)}b`, undefined],
      ['colons throughout', (n) => `mh${':'.repeat(n)}`, 'indexed'],
      ['one long line ending in a break', (n) => `${'§1 x'.repeat(n / 4)}\ny`, undefined],
      ['line breaks throughout', (n) => `${'  \r\n'.repeat(n / 4)}mh`, 'indexed'],
    ])('scales linearly from 5k to 320k characters: %s', (_label, build, kind) => {
      // Doubling from 5k, each size checked against the outcome and the absolute
      // bound before the next runs.
      const times: number[] = [];
      for (let n = 5_000; n <= 320_000; n *= 2) {
        const content = build(n);
        expect(fieldTagKind(content)).toBe(kind);
        const ms = fastestMs(content);
        expect(ms).toBeLessThan(200);
        times.push(ms);
      }
      // Linear work grows 64× across the span; quadratic grows 4096×.
      expect((times.at(-1) ?? 0) / Math.max(times[0] ?? 0, 0.05)).toBeLessThan(256);
    });
  });
});
