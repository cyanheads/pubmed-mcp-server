/**
 * @fileoverview Tests for the shared PubMed field-tag classification.
 * @module tests/services/ncbi/field-tags.test
 */

import { describe, expect, it } from 'vitest';

import { clauseFieldGroup, fieldTagGroup, fieldTagKind } from '@/services/ncbi/field-tags.js';

import { cpuMsPerCall } from '../../_helpers.js';

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

describe('fieldTagGroup (#294)', () => {
  it.each([
    // MeSH vocabulary: every record type pubmed_lookup_mesh resolves.
    ['mh', 'mesh'],
    ['MeSH Terms', 'mesh'],
    ['mesh', 'mesh'],
    ['mh:noexp', 'mesh'],
    ['majr', 'mesh'],
    ['MeSH Major Topic', 'mesh'],
    ['majr:noexp', 'mesh'],
    ['nm', 'mesh'],
    ['subs', 'mesh'],
    ['Supplementary Concept', 'mesh'],
    ['pa', 'mesh'],
    ['papx', 'mesh'],
    ['Pharmacological Action', 'mesh'],
    ['sh', 'mesh'],
    ['subh', 'mesh'],
    ['Subheading', 'mesh'],
    ['MeSH Subheading', 'mesh'],
    ['pt', 'mesh'],
    ['ptyp', 'mesh'],
    ['Publication Type', 'mesh'],
    // Journals.
    ['ta', 'journal'],
    ['jour', 'journal'],
    ['Journal', 'journal'],
    // Languages.
    ['la', 'language'],
    ['lang', 'language'],
    ['Language', 'language'],
    // Any other PubMed field tag.
    ['tiab', 'other'],
    ['Title/Abstract', 'other'],
    ['au', 'other'],
    ['Author', 'other'],
    ['jid', 'other'],
    ['dp', 'other'],
    ['sb', 'other'],
    ['mhda', 'other'],
    // Not a PubMed field tag.
    ['ab', undefined],
    ['18F', undefined],
    ['NoSuchField', undefined],
    [':noexp', undefined],
    ['', undefined],
  ] as const)('groups [%s] as %s', (content, group) => {
    expect(fieldTagGroup(content)).toBe(group);
  });

  it('ignores case, surrounding whitespace, and a search modifier', () => {
    expect(fieldTagGroup('  MH :noexp ')).toBe('mesh');
    expect(fieldTagGroup('JOURNAL')).toBe('journal');
  });
});

describe('clauseFieldGroup — the field of a clause ESearch reports unmatched (#294)', () => {
  it.each([
    // QuotedPhraseNotFound keeps the clause's tag as the caller wrote it.
    ['"dapagliflozin"[MeSH Terms]', 'mesh'],
    ['"dapagliflozin"[mh:noexp]', 'mesh'],
    ['"Heart Failure/zzqx"[mh]', 'mesh'],
    ['"Randomised Controlled Trial"[Publication Type]', 'mesh'],
    ['"New England Journal of Medicine"[Journal]', 'journal'],
    ['"N Engl J Mde"[ta]', 'journal'],
    ['"en"[la]', 'language'],
    ['"zzqxw yyqzv"[tiab]', 'other'],
    ['"a[b]c"[tiab]', 'other'],
    ['"dapagliflozin"[mh] ', 'mesh'],
    // PhraseNotFound drops the tag of an unquoted clause: `dapagliflozin[mh]`
    // and `En[Language]` come back bare, so their field is unknown.
    ['dapagliflozin', undefined],
    ['En', undefined],
    ['"zzqxw yyqzv"', undefined],
    // A bracket that is no PubMed field tag names no field.
    ['"zzq"[NoSuchField]', undefined],
    ['"fdg"[18F]', undefined],
    ['"x"[mh]]', undefined],
    ['mh]', undefined],
    ['', undefined],
  ] as const)('reads %s as %s', (clause, group) => {
    expect(clauseFieldGroup(clause)).toBe(group);
  });

  describe('linear time on adversarial input', () => {
    /**
     * Worst cases for its scan — a closer with no opener, openers with no
     * closer, whitespace and colons inside the bracket — then a digit run and
     * the two line-break shapes. No regex runs, so every shape carries the
     * full 64× span.
     */
    it.each<[string, (n: number) => string, ReturnType<typeof clauseFieldGroup>]>([
      ['a closing bracket after a long run with no opener', (n) => `${'x'.repeat(n)}]`, undefined],
      ['openers with no closer, then one closer', (n) => `${'['.repeat(n)}]`, undefined],
      ['a whitespace run inside the tag', (n) => `"a"[${' '.repeat(n)}mh${' '.repeat(n)}]`, 'mesh'],
      ['colons after the tag', (n) => `"a"[mh${':'.repeat(n)}]`, 'mesh'],
      ['a trailing whitespace run', (n) => `"a"[ta]${' '.repeat(n)}`, 'journal'],
      ['a long digit run', (n) => `"${'1'.repeat(n)}"[tiab]`, 'other'],
      ['one long line ending in a break', (n) => `${'§1 x'.repeat(n / 4)}\ny`, undefined],
      ['line breaks throughout the tag', (n) => `"a"[la${'  \r\n'.repeat(n / 4)}]`, 'language'],
    ])('scales linearly from 5k to 320k characters: %s', (_label, build, group) => {
      // Doubling from 5k, each size checked against the outcome and the
      // absolute bound before the next runs, with the 5k baseline timed again
      // beside it so a core switch between readings cannot skew the ratio.
      const base = build(5_000);
      const baselines: number[] = [];
      let largest = 0;
      for (let n = 5_000; n <= 320_000; n *= 2) {
        const clause = build(n);
        expect(clauseFieldGroup(clause)).toBe(group);
        baselines.push(cpuMsPerCall(5_000, () => clauseFieldGroup(base)));
        largest = cpuMsPerCall(n, () => clauseFieldGroup(clause));
        expect(largest).toBeLessThan(200);
      }
      // Linear work grows 64× across the span; quadratic grows 4096×. The least
      // growth over the baselines read beside each size is the one asserted.
      expect(largest / Math.max(...baselines, 0.0005)).toBeLessThan(256);
    });
  });
});
