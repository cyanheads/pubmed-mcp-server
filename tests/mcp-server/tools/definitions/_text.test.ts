/**
 * @fileoverview Tests for the surrogate-safe character cut shared by the
 * budgeted tool definitions (issue #93).
 * @module tests/mcp-server/tools/definitions/_text.test
 */

import { describe, expect, it } from 'vitest';

const { escapeMarkdownInline, sliceCodeUnits } = await import(
  '@/mcp-server/tools/definitions/_text.js'
);

/** DNA emoji U+1F9EC — one code point, two UTF-16 code units. */
const ASTRAL = '\u{1F9EC}';

describe('sliceCodeUnits', () => {
  it('backs off a code unit when the cut lands between a high and low surrogate', () => {
    const text = `${'A'.repeat(9)}${ASTRAL}${'B'.repeat(5)}`;
    const cut = sliceCodeUnits(text, 10);

    expect(cut).toBe('A'.repeat(9));
    expect(cut).toHaveLength(9);
    expect(cut.isWellFormed()).toBe(true);
  });

  it('spends the whole allowance when the cut lands just before an astral character', () => {
    const text = `${'A'.repeat(10)}${ASTRAL}${'B'.repeat(5)}`;
    const cut = sliceCodeUnits(text, 10);

    expect(cut).toBe('A'.repeat(10));
    expect(cut).toHaveLength(10);
    expect(cut.isWellFormed()).toBe(true);
  });

  it('keeps a whole pair when the cut lands just after an astral character', () => {
    const text = `${'A'.repeat(8)}${ASTRAL}${'B'.repeat(5)}`;
    const cut = sliceCodeUnits(text, 10);

    expect(cut).toBe(`${'A'.repeat(8)}${ASTRAL}`);
    expect(cut).toHaveLength(10);
    expect(cut.isWellFormed()).toBe(true);
  });

  it('never exceeds the allowance for any cut point across an astral run', () => {
    const text = `${ASTRAL.repeat(5)}${'A'.repeat(5)}`;
    for (let limit = 0; limit <= text.length; limit += 1) {
      const cut = sliceCodeUnits(text, limit);
      expect(cut.length).toBeLessThanOrEqual(limit);
      expect(cut.isWellFormed()).toBe(true);
      expect(text.startsWith(cut)).toBe(true);
    }
  });

  it('returns the string unchanged when the allowance covers it', () => {
    const text = `hello ${ASTRAL}`;
    expect(sliceCodeUnits(text, text.length)).toBe(text);
    expect(sliceCodeUnits(text, text.length + 100)).toBe(text);
  });

  it('returns empty for a zero or negative allowance', () => {
    expect(sliceCodeUnits(`${ASTRAL}abc`, 0)).toBe('');
    expect(sliceCodeUnits(`${ASTRAL}abc`, -5)).toBe('');
  });

  it('does not carry an unpaired high surrogate over the cut boundary', () => {
    // Already-malformed upstream text: the lone surrogate sits at the boundary.
    const cut = sliceCodeUnits('AB\ud83eCD', 3);

    expect(cut).toBe('AB');
    expect(cut.isWellFormed()).toBe(true);
  });

  it('cuts, it does not sanitize — malformed text that fits comes back untouched', () => {
    const malformed = 'AB\ud83e';
    expect(sliceCodeUnits(malformed, 10)).toBe(malformed);
  });
});

describe('escapeMarkdownInline (issue #102)', () => {
  describe('leaves alone what cannot alter structure inline', () => {
    it.each([
      ['a comparison against a decimal', 'Efficacy confirmed (P<0.001) in all arms'],
      ['a greater-than with spaces', 'IL-6 > baseline at 24 hours'],
      ['a bare inequality between letters', 'Sampled where n<N across cohorts'],
      ['a lone underscore inside a gene name', 'TP53_mutant tumours resist therapy'],
      ['several intraword underscores', 'TP53_mutant and BRCA1_null cell_lines'],
      ['a lone asterisk', 'Growth measured at 5*g centrifugation'],
      ['a lone tilde', 'Cohort of ~250 participants'],
      ['a lone backtick', 'The 5` untranslated region'],
      ['a hash away from the line start', 'Cohort #3 outcomes'],
      ['an inequality with no closing angle bracket', 'Threshold set where a<b holds'],
      ['plain prose', 'Aquaporin promotes early stomatal closure in grapevine leaves'],
    ])('%s', (_label, title) => {
      expect(escapeMarkdownInline(title)).toBe(title);
    });
  });

  describe('neutralizes what would alter structure', () => {
    it('escapes an inline HTML/JATS tag that survived upstream normalization', () => {
      expect(escapeMarkdownInline('<i>PIP2;1</i> aquaporin promotes closure')).toBe(
        '\\<i>PIP2;1\\</i> aquaporin promotes closure',
      );
    });

    it('escapes an angle-bracket span that a Markdown renderer reads as a tag', () => {
      // `<b and c>` is a well-formed HTML open tag, so the prose after it would
      // render bold — the same gap `toDisplayText`'s tag strip documents.
      expect(escapeMarkdownInline('where a<b and c>d holds')).toBe('where a\\<b and c>d holds');
    });

    it('escapes a lone bracket — its partner may sit in a sibling field rendered in the same paragraph', () => {
      expect(escapeMarkdownInline('See [ref')).toBe('See \\[ref');
      expect(escapeMarkdownInline('Nature](https://example.test)')).toBe(
        'Nature\\](https://example.test)',
      );
    });

    it('escapes a bracket pair so no clickable link can form', () => {
      expect(escapeMarkdownInline('[Retracted] Effects of the compound')).toBe(
        '\\[Retracted\\] Effects of the compound',
      );
      expect(escapeMarkdownInline('[click](https://example.test/x)')).toBe(
        '\\[click\\](https://example.test/x)',
      );
    });

    it('escapes asterisks that could pair into emphasis', () => {
      expect(escapeMarkdownInline('a *Nature* study')).toBe('a \\*Nature\\* study');
      expect(escapeMarkdownInline('**bold** claim')).toBe('\\*\\*bold\\*\\* claim');
    });

    it('escapes underscores that could pair into emphasis, keeping intraword ones', () => {
      expect(escapeMarkdownInline('a _stressed_ result')).toBe('a \\_stressed\\_ result');
      expect(escapeMarkdownInline('TP53_mutant _stressed_ result')).toBe(
        'TP53_mutant \\_stressed\\_ result',
      );
    });

    it('escapes tildes that could pair into strikethrough', () => {
      expect(escapeMarkdownInline('~250~ participants')).toBe('\\~250\\~ participants');
    });

    it('escapes backticks that could pair into a code span', () => {
      expect(escapeMarkdownInline('the `gene` locus')).toBe('the \\`gene\\` locus');
    });

    it('replaces line breaks so the value cannot escape its heading', () => {
      expect(escapeMarkdownInline('Title\n# Injected heading')).toBe('Title # Injected heading');
      expect(escapeMarkdownInline('Title\r\n\r\nstill one line')).toBe('Title still one line');
    });

    it('escapes a literal backslash so it cannot neutralize the escapes around it', () => {
      expect(escapeMarkdownInline('back\\slash *a* *b*')).toBe('back\\\\slash \\*a\\* \\*b\\*');
    });
  });

  it('is idempotent in rendered terms — escaping twice only adds literal backslashes', () => {
    // The helper is render-time only; it must never be applied to a value on
    // its way into structuredContent, where a second pass would compound.
    const once = escapeMarkdownInline('a *Nature* study');
    expect(escapeMarkdownInline(once)).toBe('a \\\\\\*Nature\\\\\\* study');
  });

  it('returns an empty string unchanged', () => {
    expect(escapeMarkdownInline('')).toBe('');
  });
});
