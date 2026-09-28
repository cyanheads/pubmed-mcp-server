/**
 * @fileoverview Tests for the shared visible-text check behind every blank-input
 * rejection.
 * @module tests/mcp-server/tools/definitions/_visible-text.test
 */

import { describe, expect, it } from 'vitest';

import { hasVisibleText } from '@/mcp-server/tools/definitions/_visible-text.js';

describe('hasVisibleText', () => {
  it.each([
    ['an empty string', ''],
    ['ASCII whitespace', ' \t\n\r\v\f'],
    ['a next-line character (U+0085), which String.prototype.trim keeps', '\u0085'],
    ['a no-break space (U+00A0)', ' '],
    ['Unicode spaces', '        　'],
    ['a zero-width space (U+200B)', '​'],
    ['a word joiner (U+2060)', '⁠'],
    ['a Mongolian vowel separator (U+180E)', '᠎'],
    ['a soft hyphen (U+00AD)', '­'],
    ['zero-width non-joiner and joiner (U+200C, U+200D)', '‌‍'],
    ['a byte-order mark (U+FEFF)', '﻿'],
    ['format characters between spaces', ' ​ ⁠\u0085 '],
    ['a start-of-heading control character (U+0001)', '\u0001'],
    ['a null character (U+0000)', '\u0000'],
    ['a delete character (U+007F)', '\u007F'],
    ['a C1 control character (U+009F)', '\u009F'],
    ['control characters between spaces', ' \u0001 \u001B '],
    // Default-ignorable code points outside `\p{Cf}` and `\p{White_Space}`,
    // which render as nothing.
    ['a Hangul filler (U+3164)', 'ㅤ'],
    ['a Hangul choseong filler (U+115F)', 'ᅟ'],
    ['a Hangul jungseong filler (U+1160)', 'ᅠ'],
    ['a halfwidth Hangul filler (U+FFA0)', 'ﾠ'],
    ['a combining grapheme joiner (U+034F)', '͏'],
    ['a lone variation selector (U+FE0F)', '️'],
    ['a Khmer inherent vowel (U+17B4)', '឴'],
    ['Hangul fillers between spaces', ' ㅤ ᅟ '],
  ])('is false for %s', (_label, value) => {
    expect(hasVisibleText(value)).toBe(false);
  });

  it.each([
    ['a letter', 'a'],
    ['a padded word', '  covid  '],
    ['a letter after a zero-width space', '​x'],
    ['a letter after a control character', '\u0001x'],
    ['a digit', '7'],
    ['an accented letter', 'é'],
    ['an astral character', '🧬'],
    ['a CJK ideograph', '癌'],
    ['punctuation', '()'],
    ['markup it does not strip', '<b></b>'],
    ['a letter after a Hangul filler', 'ㅤx'],
    ['a Hangul syllable', '한'],
    ['an emoji with a variation selector', '❤️'],
  ])('is true for %s', (_label, value) => {
    expect(hasVisibleText(value)).toBe(true);
  });
});
