/**
 * @fileoverview Tests for the surrogate-safe character cut shared by the
 * budgeted tool definitions (issue #93).
 * @module tests/mcp-server/tools/definitions/_text.test
 */

import { describe, expect, it } from 'vitest';

const { sliceCodeUnits } = await import('@/mcp-server/tools/definitions/_text.js');

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
