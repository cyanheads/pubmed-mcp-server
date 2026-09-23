/**
 * @fileoverview Tests for the text helpers shared by the tool definitions: the
 * surrogate-safe character cut (issue #93), the word-boundary cut built on it
 * (issue #143), and the render-time Markdown escapes (issues #102, #111, #130).
 * @module tests/mcp-server/tools/definitions/_text.test
 */

import { describe, expect, it } from 'vitest';

const { escapeMarkdownInline, escapeMarkdownTableCell, sliceAtWordBoundary, sliceCodeUnits } =
  await import('@/mcp-server/tools/definitions/_text.js');

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

describe('sliceAtWordBoundary (issue #143)', () => {
  it('backs a cut that lands mid-word off to the end of the last whole word', () => {
    // PMC13546078's 2.1 Study Design used to end "…valid indirect compa".
    const text =
      'The transitivity assumption (a prerequisite for valid indirect comparisons) holds.';
    const cut = sliceAtWordBoundary(text, 70);

    expect(sliceCodeUnits(text, 70)).toBe(
      'The transitivity assumption (a prerequisite for valid indirect compari',
    );
    expect(cut).toBe('The transitivity assumption (a prerequisite for valid indirect');
  });

  it('keeps the last word whole when the allowance ends exactly on it', () => {
    expect(sliceAtWordBoundary('alpha beta gamma', 10)).toBe('alpha beta');
  });

  it('drops the whitespace a cut would otherwise end on', () => {
    expect(sliceAtWordBoundary('alpha   beta', 7)).toBe('alpha');
    expect(sliceAtWordBoundary('alpha beta gamma', 11)).toBe('alpha beta');
  });

  it('treats a line break as a word boundary', () => {
    expect(sliceAtWordBoundary('- BS — bariatric surgery\n- CV — cardiovascular', 30)).toBe(
      '- BS — bariatric surgery\n- CV',
    );
    expect(sliceAtWordBoundary('line one\nline two', 12)).toBe('line one');
  });

  it('cuts at the allowance when a single unbroken token overruns it', () => {
    // No boundary to back off to: returning nothing would drop the whole field
    // on a small budget, so the token is cut the way sliceCodeUnits cuts it.
    expect(sliceAtWordBoundary('A'.repeat(20), 10)).toBe('A'.repeat(10));
    expect(sliceAtWordBoundary('ACGTACGTACGT tail', 6)).toBe('ACGTAC');
  });

  it('never splits a surrogate pair, backing off a word or falling back to a code unit', () => {
    expect(sliceAtWordBoundary(`abc ${ASTRAL}${ASTRAL}xyz`, 6)).toBe('abc');
    const unbroken = sliceAtWordBoundary(`${'A'.repeat(9)}${ASTRAL}B`, 10);
    expect(unbroken).toBe('A'.repeat(9));
    expect(unbroken.isWellFormed()).toBe(true);
  });

  it('returns the text unchanged when it fits, and empty for a zero or negative allowance', () => {
    expect(sliceAtWordBoundary('fits whole', 10)).toBe('fits whole');
    expect(sliceAtWordBoundary('fits whole', 500)).toBe('fits whole');
    expect(sliceAtWordBoundary('alpha beta', 0)).toBe('');
    expect(sliceAtWordBoundary('alpha beta', -3)).toBe('');
  });

  it('returns a well-formed prefix within the allowance that ends a word, for every cut point', () => {
    const text = `Obesity ${ASTRAL} is a  major\nglobal health issue; GLP-1RAs reduce MACEs.`;
    for (let limit = 0; limit <= text.length + 1; limit += 1) {
      const cut = sliceAtWordBoundary(text, limit);
      expect(cut.length).toBeLessThanOrEqual(limit);
      expect(text.startsWith(cut)).toBe(true);
      expect(cut.isWellFormed()).toBe(true);
      expect(cut).toBe(cut.trimEnd());
      // A cut with any boundary inside its allowance ends on one: the character
      // after it starts a gap. Only an allowance inside the first word, which
      // has no boundary to back off to, may end mid-token.
      if (cut.length < text.length && /\s/.test(text.slice(0, limit))) {
        expect(text.charAt(cut.length)).toMatch(/\s/);
      }
    }
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

describe('escapeMarkdownTableCell', () => {
  it('escapes a pipe, which would otherwise end the cell and shift the row', () => {
    expect(escapeMarkdownTableCell('A|B')).toBe('A\\|B');
  });

  it('leaves a pipe alone in the inline escape, where it is an ordinary character', () => {
    expect(escapeMarkdownInline('A|B')).toBe('A|B');
  });

  it('collapses a line break, which would end the row', () => {
    expect(escapeMarkdownTableCell('first\nsecond')).toBe('first second');
  });

  it('still applies the inline escapes', () => {
    expect(escapeMarkdownTableCell('a *b* c|d')).toBe('a \\*b\\* c\\|d');
  });

  it('escapes a source backslash and the cell delimiter independently', () => {
    // The backslash pass has to run before the pipe pass. Reversed, the `\` this
    // function adds for the pipe is doubled by the backslash pass and the
    // delimiter is left bare: `back\\slash a\\|b`, which splits the cell.
    expect(escapeMarkdownTableCell('back\\slash a|b')).toBe('back\\\\slash a\\|b');
  });

  it('returns an empty string unchanged', () => {
    expect(escapeMarkdownTableCell('')).toBe('');
  });
});

describe('escapeMarkdownInline over asset fields (issue #130)', () => {
  it('neutralizes a caption that would otherwise form a link and emphasis', () => {
    const caption = 'Effect of *treatment* on [outcome](https://evil.test)';
    const escaped = escapeMarkdownInline(caption);

    expect(escaped).toBe('Effect of \\*treatment\\* on \\[outcome\\](https://evil.test)');
  });

  it('neutralizes a bracket pair and a tag-shaped angle bracket in an href', () => {
    // The `href` is upstream text, not a value this server composes, so it gets
    // the same treatment as any other interpolated string.
    expect(escapeMarkdownInline('bin/g001[1].jpg <img src=x>')).toBe(
      'bin/g001\\[1\\].jpg \\<img src=x>',
    );
  });

  it('leaves a deposit filename legible — its underscores are intraword', () => {
    // `12345_2024_MOESM1_ESM.pdf` is the shape supplementary pointers arrive in.
    // Every underscore is flanked by alphanumerics, so none can open emphasis
    // and spending a backslash on each would only cost the reader.
    expect(escapeMarkdownInline('12345_2024_MOESM1_ESM.pdf')).toBe('12345_2024_MOESM1_ESM.pdf');
    expect(escapeMarkdownInline('MOL2-20-1253-g001.jpg')).toBe('MOL2-20-1253-g001.jpg');
  });

  it('collapses a multi-line caption so it cannot escape its meta line', () => {
    expect(escapeMarkdownInline('Panel A\nPanel B')).toBe('Panel A Panel B');
  });
});
