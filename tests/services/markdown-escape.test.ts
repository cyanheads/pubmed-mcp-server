/**
 * @fileoverview Tests for the shared CommonMark prose escape: the kinds the
 * citation formatter marks its own italics and URLs with, and the single-line
 * renderer built on them (#263). The kind-free path is `escapeMarkdownBlock`'s,
 * tabled in `tests/mcp-server/tools/definitions/_text.test.ts`.
 * @module tests/services/markdown-escape.test
 */

import { describe, expect, it } from 'vitest';
import { renderMarkdownLine } from '@/services/markdown-escape.js';
import { readCommonMark } from '../_helpers.js';

describe('renderMarkdownLine (#263)', () => {
  it.each<[string, Parameters<typeof renderMarkdownLine>[0], string]>([
    ['a lone `*` in prose stays raw', ['A*B. ', { italic: 'J' }, '.'], 'A*B. *J*.'],
    ['two prose `*` are escaped', ['A*B C*D. ', { italic: 'J' }], 'A\\*B C\\*D. *J*'],
    ['a `*` inside the italics is always escaped', ['T. ', { italic: 'J*M' }], 'T. *J\\*M*'],
    [
      'an italic `*` does not count toward the prose `*`',
      ['A*B. ', { italic: 'J*M' }],
      'A*B. *J\\*M*',
    ],
    [
      'a URL is copied as it is, but its `*` counts',
      ['A*B ', { verbatim: 'https://x/a*b_c_' }],
      'A\\*B https://x/a*b_c_',
    ],
    ['`~` and backticks count across prose and italics', ['5` ', { italic: '3`' }], '5\\` *3\\`*'],
    ['an underscore pair across pieces', ['_a ', { italic: 'b_' }], '\\_a *b\\_*'],
    ['a line-start marker in prose', ['1. Group. (2020).'], '1\\. Group. (2020).'],
    ['`]` only before `(`', ['[a]. [b](c)'], '[a]. [b\\](c)'],
  ])('%s', (_label, pieces, expected) => {
    expect(renderMarkdownLine(pieces)).toBe(expected);
  });

  it('collapses whitespace across pieces and trims the ends, as the citation join did', () => {
    expect(
      renderMarkdownLine(['  a\n\tb ', ' ', { italic: ' c  d' }, '  ', { verbatim: 'u' }, ' ']),
    ).toBe('a b * c d* u');
    expect(renderMarkdownLine([' ', '\n'])).toBe('');
  });

  it('reads back every upstream character through a CommonMark parse', () => {
    const line = renderMarkdownLine([
      'Lee *K, Doe_ A (2020). HLA-B*57 <i>x</i> R&amp;D. ',
      { italic: 'J*M_' },
      ', ',
      { italic: '6*' },
      '. ',
      { verbatim: 'https://doi.org/10.1/a_b' },
    ]);
    expect(readCommonMark(line)).toBe(
      'Lee *K, Doe_ A (2020). HLA-B*57 <i>x</i> R&amp;D. ⟨em⟩J*M_⟨/em⟩, ⟨em⟩6*⟨/em⟩. https://doi.org/10.1/a_b',
    );
  });

  describe('linear time on adversarial input', () => {
    /** CPU time of `run`, in ms — this thread's user + system time, not wall clock. */
    const cpuMs = (run: () => void): number => {
      const start = process.threadCpuUsage();
      run();
      const { user, system } = process.threadCpuUsage(start);
      return (user + system) / 1000;
    };
    const fill = (unit: string, length: number) =>
      unit.repeat(Math.ceil(length / unit.length)).slice(0, length);

    /** Every character with a backslash before it. */
    const escapedEach = (text: string) => text.replace(/[\s\S]/g, '\\$&');

    /** Each row's builder takes the size and returns the pieces and the line they must render as. */
    it.each<[string, (n: number) => [Parameters<typeof renderMarkdownLine>[0], string]]>([
      [
        'delimiters split across italics',
        (n) => [
          [fill('*_~`', n / 2), { italic: fill('*_', n / 2) }],
          `${escapedEach(fill('*_~`', n / 2))}*${escapedEach(fill('*_', n / 2))}*`,
        ],
      ],
      ['a whitespace run', (n) => [[`a${' '.repeat(n - 2)}b`], 'a b']],
      [
        'many short pieces',
        (n) => [Array.from({ length: n / 4 }, () => ({ italic: 'a*' })), '*a\\**'.repeat(n / 4)],
      ],
      ['a digit run', (n) => [['1'.repeat(n)], '1'.repeat(n)]],
      [
        'one long line ending in a break',
        (n) => [[`${'§1 x'.repeat(n / 4)}\ny`], `${'§1 x'.repeat(n / 4)} y`],
      ],
      [
        'line breaks throughout',
        (n) => [['x  \r\n'.repeat(n / 5)], Array.from({ length: n / 5 }, () => 'x').join(' ')],
      ],
    ])('scales linearly from 5k to 320k characters of %s', (_label, build) => {
      // Doubling from 5k, each size's line and absolute bound checked before the next runs.
      const times: number[] = [];
      for (let n = 5_000; n <= 320_000; n *= 2) {
        const [pieces, line] = build(n);
        expect(renderMarkdownLine(pieces)).toBe(line);
        const ms = Math.min(
          ...Array.from({ length: 3 }, () => cpuMs(() => renderMarkdownLine(pieces))),
        );
        expect(ms).toBeLessThan(400);
        times.push(ms);
      }
      // Linear work grows 64× across the span; quadratic grows 4096×.
      expect((times.at(-1) ?? 0) / Math.max(times[0] ?? 0, 0.05)).toBeLessThan(256);
    });
  });
});
