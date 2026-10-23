/**
 * @fileoverview Tests for the text helpers shared by the tool definitions: the
 * surrogate-safe character cut (issue #93), the word-boundary cut built on it
 * (issue #143), and the render-time Markdown escapes (issues #102, #111, #130,
 * #255).
 * @module tests/mcp-server/tools/definitions/_text.test
 */

import { describe, expect, it } from 'vitest';
import { bunMarkdown, renderedHtml, renderedText } from '../../../_helpers.js';

const {
  escapeMarkdownBlock,
  escapeMarkdownInline,
  escapeMarkdownLineStart,
  escapeMarkdownListItem,
  escapeMarkdownTableCell,
  markdownCodeFence,
  markdownCodeSpan,
  sliceAtWordBoundary,
  sliceCodeUnits,
} = await import('@/mcp-server/tools/definitions/_text.js');

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

const plain = (text: string) => escapeMarkdownBlock(text, 'plain');
const structured = (text: string) => escapeMarkdownBlock(text, 'structured');

describe('escapeMarkdownBlock (issue #255)', () => {
  describe('the reproductions', () => {
    it.each([
      ['PMC10754557 — a measurement', 'size: 10*8*6 mm', 'size: 10\\*8\\*6 mm'],
      [
        'PMC11609225 — subscripts in a MathML linear form',
        'A=(a_{ij})_{N×N}, where a_{ij}>0',
        'A=(a\\_{ij})\\_{N×N}, where a\\_{ij}>0',
      ],
      [
        'PMC11609225 — a matrix row separator',
        '(L & M \\\\ M^{T} & N)<0',
        '(L & M \\\\\\ M^{T} & N)<0',
      ],
      [
        'PMID 39292993 — HGVS frameshifts',
        'p.(F222Lfs*46); c.2289dupC, p.(V764Rfs*19)',
        'p.(F222Lfs\\*46); c.2289dupC, p.(V764Rfs\\*19)',
      ],
      [
        'PMC10727567 — the same variant twice',
        'p.His252Glnfs*21 and again p.His252Glnfs*21',
        'p.His252Glnfs\\*21 and again p.His252Glnfs\\*21',
      ],
    ])('%s', (_label, source, expected) => {
      expect(plain(source)).toBe(expected);
      expect(structured(source)).toBe(expected);
    });
  });

  describe('emphasis pairing is judged per blank-line-delimited block', () => {
    it('escapes one delimiter on each of two lines of a block — they pair across the line break', () => {
      expect(plain('3.42*1012/L at admission\nfalling to 2.33*1012/L')).toBe(
        '3.42\\*1012/L at admission\nfalling to 2.33\\*1012/L',
      );
      expect(structured('Case\nsize 10*8 and 9*7 mm')).toBe('Case\nsize 10\\*8 and 9\\*7 mm');
    });

    it('leaves a delimiter alone in its own block — no pairing reaches across a blank line', () => {
      expect(plain('13.43*10^9 cells\n\n89*10^9 later')).toBe('13.43*10^9 cells\n\n89*10^9 later');
      expect(plain('size 10*8*6\n\n41*47 mm')).toBe('size 10\\*8\\*6\n\n41*47 mm');
    });

    it.each([
      ['a lone asterisk', '41*47 mm'],
      ['an intraword underscore', 'TP53_mutant tumours'],
      ['a reference sequence', 'NM_003482.3 and NM_012307.5'],
      ['a lone tilde', 'a cohort of ~250'],
      ['a lone backtick', 'the 5` UTR'],
      ['a comparison', 'P<0.001 where n<N'],
      ['legacy PubMed inequality notation', 'relative intensity <or= 20 or > 20'],
      ['a citation marker list', 'as shown [12] and [1,2,3] and [4–6]'],
      ['an ampersand that is no entity', 'R&D and A & B'],
      ['TeX commands', '\\frac{a}{b} + \\alpha'],
    ])('leaves %s raw', (_label, source) => {
      expect(plain(source)).toBe(source);
      expect(structured(source)).toBe(source);
    });

    it('escapes pairable underscores only, keeping intraword ones', () => {
      expect(plain('TP53_mutant _stressed_ cells')).toBe('TP53_mutant \\_stressed\\_ cells');
    });

    it('escapes tildes and backticks that could pair', () => {
      expect(plain('~250 to ~300')).toBe('\\~250 to \\~300');
      expect(plain('the `gene` locus')).toBe('the \\`gene\\` locus');
    });
  });

  describe('backslashes', () => {
    it('escapes a backslash before ASCII punctuation and at a line end', () => {
      expect(plain('a\\*b')).toBe('a\\\\*b');
      expect(plain('ends with\\\nnext')).toBe('ends with\\\\\nnext');
      expect(plain('trailing\\')).toBe('trailing\\\\');
    });

    it('leaves a backslash before a letter, a digit or a space raw', () => {
      expect(plain('\\frac \\alpha \\1 \\ x')).toBe('\\frac \\alpha \\1 \\ x');
    });
  });

  describe('brackets, tags and entities', () => {
    it('escapes `]` only where it would close link text', () => {
      expect(plain('[Ca2+](i) rose')).toBe('[Ca2+\\](i) rose');
      expect(plain('[x][y] and [z]')).toBe('[x\\][y] and [z]');
    });

    it('escapes a link reference definition opening a line', () => {
      expect(plain('[1]: https://evil.test')).toBe('\\[1]: https://evil.test');
      expect(plain('see [1]: this is prose')).toBe('see [1]: this is prose');
    });

    it('escapes a tag-shaped `<`, across lines of a block', () => {
      expect(plain('HuMab<CD20> and <i>x</i>')).toBe('HuMab\\<CD20> and \\<i>x\\</i>');
      expect(plain('a <b\nc> d')).toBe('a \\<b\nc> d');
      expect(plain('x <https://a.b> y <!-- c --> <a.b@c.d>')).toBe(
        'x \\<https://a.b> y \\<!-- c --> \\<a.b@c.d>',
      );
    });

    it('does not look for a tag across a blank line', () => {
      expect(plain('a <b\n\nc> d')).toBe('a <b\n\nc> d');
    });

    it('escapes an entity-shaped `&`', () => {
      expect(plain('&alpha; &amp; &#955; &#x3bb;')).toBe('\\&alpha; \\&amp; \\&#955; \\&#x3bb;');
    });
  });

  describe('line starts in plain mode', () => {
    it.each([
      ['an ATX heading', '# 1 Background', '\\# 1 Background'],
      ['a six-hash heading', '###### x', '\\###### x'],
      ['a quote', '> 18 years', '\\> 18 years'],
      ['a quote with no space', '>18 years', '\\>18 years'],
      ['a dash bullet', '- 5 mg', '\\- 5 mg'],
      ['a plus bullet', '+ 5 mg', '\\+ 5 mg'],
      ['an asterisk bullet', '* note', '\\* note'],
      ['an ordered item', '1. First', '1\\. First'],
      ['an ordered item with a paren', '2) Second', '2\\) Second'],
      ['an indented heading', '   # h', '   \\# h'],
      ['a fence', '```', '\\`\\`\\`'],
      ['a tilde fence', '~~~', '\\~\\~\\~'],
      ['a thematic break', '***', '\\*\\*\\*'],
      ['an HTML block start', '<div', '\\<div'],
      ['a closing-tag HTML block start', '</p>', '\\</p>'],
    ])('escapes %s', (_label, source, expected) => {
      expect(plain(source)).toBe(expected);
    });

    it('escapes setext underlines and table delimiter rows on later lines of a block', () => {
      expect(plain('Results\n===')).toBe('Results\n\\===');
      expect(plain('Results\n---')).toBe('Results\n\\---');
      expect(plain('Results\n-')).toBe('Results\n\\-');
      expect(plain('a | b\n|---|:-:|')).toBe('a | b\n\\|---|:-:|');
    });

    it.each([
      ['a hash with no space', '#MeToo in medicine'],
      ['seven hashes', '####### x'],
      ['a ten-digit number', '1234567890. x'],
      ['a number with no delimiter', '2024 cohort'],
      ['a dash with no space', '-5 mg'],
      ['a less-than before a digit', '<5 years'],
      ['legacy inequality notation', '<or= 20'],
      ['a run of dashes with text', '-- note'],
    ])('leaves %s raw', (_label, source) => {
      expect(plain(source)).toBe(source);
    });

    it('passes an indented code block through verbatim, where a backslash would show', () => {
      expect(plain('    code \\* &amp; *x*\n    more\nprose *a* *b*')).toBe(
        '    code \\* &amp; *x*\n    more\nprose \\*a\\* \\*b\\*',
      );
    });

    it('treats a four-space line after prose as a continuation, not code', () => {
      expect(plain('prose\n    # not code')).toBe('prose\n    # not code');
    });
  });

  describe('structured mode keeps the parser line grammar', () => {
    it('keeps list markers and nesting and escapes the text after them', () => {
      const source = [
        'Abbreviations',
        '- BS — bariatric *surgery*',
        '  - nested 3*4 item',
        '  1. # not a heading',
        '-',
        '  prose after the nested list',
        '1. first',
        '2. second',
      ].join('\n');
      expect(structured(source)).toBe(
        [
          'Abbreviations',
          '- BS — bariatric \\*surgery\\*',
          '  - nested 3\\*4 item',
          '  1. \\# not a heading',
          '-',
          '  prose after the nested list',
          '1. first',
          '2. second',
        ].join('\n'),
      );
    });

    it('keeps quote markers and escapes the quoted text', () => {
      expect(structured('> quoted *text*\n> — Attrib\n> - a list in a quote')).toBe(
        '> quoted \\*text\\*\n> — Attrib\n> - a list in a quote',
      );
    });

    it('escapes a block marker the parser never writes', () => {
      expect(structured('* not a parser bullet\n+ nor this\n>18 years\n# heading\n1) item')).toBe(
        '\\* not a parser bullet\n\\+ nor this\n\\>18 years\n\\# heading\n1\\) item',
      );
    });

    it('passes preformat fence content through verbatim, blank lines included', () => {
      const source = 'before *a*\n\n```\nraw *code* \\* &amp; <b>\n\n# kept\n```\n\nafter *b*';
      expect(structured(source)).toBe(
        'before \\*a\\*\n\n```\nraw *code* \\* &amp; <b>\n\n# kept\n```\n\nafter \\*b\\*',
      );
    });

    it('passes a quoted fence through verbatim', () => {
      expect(structured('> ```\n> raw *x* *y*\n> ```')).toBe('> ```\n> raw *x* *y*\n> ```');
    });

    it('runs an unclosed fence verbatim to the end, then closes it with its opening line', () => {
      expect(structured('```\nraw *x* *y*\n# kept')).toBe('```\nraw *x* *y*\n# kept\n```');
    });

    it('closes a fence a budget cut left open, inside a quote and after a final line break', () => {
      expect(structured('before *a*\n\n````\nraw *x* *y*')).toBe(
        'before \\*a\\*\n\n````\nraw *x* *y*\n````',
      );
      expect(structured('> ```\n> raw *x* *y*')).toBe('> ```\n> raw *x* *y*\n> ```');
      expect(structured('```\nraw *x*\n')).toBe('```\nraw *x*\n```');
    });

    it('closes a longer fence only on a backtick run at least as long', () => {
      const source = '````\nraw *x*\n```\nstill *raw* `x`\n````\n\nafter *b*';
      expect(structured(source)).toBe('````\nraw *x*\n```\nstill *raw* `x`\n````\n\nafter \\*b\\*');
      expect(structured('> `````\n> ````\n> *x* *y*\n> `````')).toBe(
        '> `````\n> ````\n> *x* *y*\n> `````',
      );
    });

    it('closes a fence on a longer run than opened it, as CommonMark does', () => {
      expect(structured('```\nraw *x*\n`````\nafter *b*')).toBe(
        '```\nraw *x*\n`````\nafter \\*b\\*',
      );
    });

    it('treats a fence line in plain mode as prose', () => {
      expect(plain('```\nraw *x* *y*\n```')).toBe('\\`\\`\\`\nraw \\*x\\* \\*y\\*\n\\`\\`\\`');
    });

    it('keeps box markers and citation markers raw', () => {
      const source = '[Box: Box 1. Virtual format]\n\nText [12].\n\n[End of box]';
      expect(structured(source)).toBe(source);
    });
  });

  it('keeps every line separator byte for byte', () => {
    expect(plain('a *b*\r\nc *d*\re\n\n- f')).toBe('a \\*b\\*\r\nc \\*d\\*\re\n\n\\- f');
  });

  it('returns empty and already-plain text unchanged', () => {
    expect(plain('')).toBe('');
    expect(structured('')).toBe('');
    const prose =
      'Aquaporin promotes early stomatal closure in grapevine leaves.\n\nSecond paragraph.';
    expect(plain(prose)).toBe(prose);
    expect(structured(prose)).toBe(prose);
  });
});

describe('escapeMarkdownLineStart (issue #255)', () => {
  it.each([
    ['# Not a heading', '\\# Not a heading'],
    ['> 90% of cases', '\\> 90% of cases'],
    ['- a dash', '\\- a dash'],
    ['1. Introduction', '1\\. Introduction'],
  ])('escapes the block marker opening %j', (source, expected) => {
    expect(escapeMarkdownLineStart(source)).toBe(expected);
  });

  it('leaves a line opening with no block marker unchanged', () => {
    expect(escapeMarkdownLineStart('Nature, 2021')).toBe('Nature, 2021');
    expect(escapeMarkdownLineStart('#MeToo')).toBe('#MeToo');
  });

  it('composes with the inline escape without doubling a backslash', () => {
    expect(escapeMarkdownLineStart(escapeMarkdownInline('* a *b*'))).toBe('\\* a \\*b\\*');
  });

  it.each([
    ['[x] done', '\\[x] done'],
    ['[X] done', '\\[X] done'],
    ['[ ] open', '\\[ ] open'],
    ['[x]', '\\[x]'],
    ['\t[x]\tdone', '\t\\[x]\tdone'],
  ])('escapes the GFM task-list marker opening %j', (source, expected) => {
    expect(escapeMarkdownLineStart(source)).toBe(expected);
  });

  it('leaves a bracket that is no task-list marker raw', () => {
    for (const line of ['[12] Smith J', '[y] other', '[x]done', '[ x] spaced']) {
      expect(escapeMarkdownLineStart(line)).toBe(line);
    }
  });
});

describe('escapeMarkdownListItem (issue #255)', () => {
  it('escapes a value inline and at its line start', () => {
    expect(escapeMarkdownListItem('# Smith *J* <b>')).toBe('\\# Smith \\*J\\* \\<b>');
    expect(escapeMarkdownListItem('1. Dept of A_B_C')).toBe('1\\. Dept of A_B_C');
    expect(escapeMarkdownListItem('> Group\nline two')).toBe('\\> Group line two');
  });

  it('leaves an ordinary name unchanged', () => {
    expect(escapeMarkdownListItem('Jane Q. Smith Jr')).toBe('Jane Q. Smith Jr');
  });
});

describe('escapeMarkdownBlock GFM task-list markers (issue #255)', () => {
  it('escapes a task-list marker opening a parser list item, at any nesting or quote depth', () => {
    const source = '- [x] done\n  - [ ] open\n1. [X] item\n> - [x] quoted\n- [x]';
    expect(structured(source)).toBe(
      '- \\[x] done\n  - \\[ ] open\n1. \\[X] item\n> - \\[x] quoted\n- \\[x]',
    );
  });

  it('leaves a bracket that opens no task-list item raw', () => {
    const source =
      '- [12] cited\n- [y] other\n- [x]done\n[x] not in a list\n\n  [x] indented prose';
    expect(structured(source)).toBe(source);
  });

  it('needs no rule of its own in plain mode, where the list marker is escaped', () => {
    expect(plain('- [x] done')).toBe('\\- [x] done');
  });
});

describe('markdownCodeSpan (issue #255)', () => {
  it.each([
    ['cance* AND neuro*', '`cance* AND neuro*`'],
    ['risk[tiab] AND <b>x</b> &amp; a_b_c \\*', '`risk[tiab] AND <b>x</b> &amp; a_b_c \\*`'],
    ['a`b', '``a`b``'],
    ['`a', '`` `a ``'],
    ['a``', '``` a`` ```'],
    [' padded ', '`  padded  `'],
    ['   ', '`   `'],
    ['line one\nline two', '`line one line two`'],
  ])('wraps %j in a fence longer than any backtick run it holds', (value, expected) => {
    expect(markdownCodeSpan(value)).toBe(expected);
  });

  it('returns an empty value empty', () => {
    expect(markdownCodeSpan('')).toBe('');
  });
});

describe('markdownCodeFence (issue #255)', () => {
  it('is three backticks, or one longer than the longest backtick run in the text', () => {
    expect(markdownCodeFence('@article{x, title={A}}')).toBe('```');
    expect(markdownCodeFence('title={``A``}')).toBe('```');
    expect(markdownCodeFence('a\n```\nb ```` c')).toBe('`````');
  });
});

/** How many `<tag` elements `markdown` renders to. */
const count = (markdown: string, tag: string) => renderedHtml(markdown).split(`<${tag}`).length - 1;

describe.runIf(bunMarkdown !== undefined)(
  'escapeMarkdownBlock rendered round trip (issue #255)',
  () => {
    const collapse = (text: string) => text.replace(/\s+/g, ' ').trim();

    /** Prose whose every character must survive rendering once escaped. */
    const PLAIN_SOURCES = [
      'Case: size: 10*8*6 mm, 10*6*6 mm, 11*10*9 mm and 17*12*15 mm.',
      'WBC 3.42*1012/L on admission, falling to 2.33*1012/L.',
      'A=(a_{ij})_{N×N}, where a_{ij}>0, and (L & M \\\\ M^{T} & N)<0.',
      'two nonsense [c.466C>T, p.(R156*); c.2776C>T, p.(R926*)] and three frameshift [c.666delT, p.(F222Lfs*46); c.2289dupC, p.(V764Rfs*19)].',
      'Rituximab, Ocrelizumab, or HuMab<CD20>; [alpha],[alpha]-trehalose; [Ca2+](i) rose.',
      '# 1 Background\n> 18 years\n- 5 mg\n+ 6 mg\n* 7 mg\n1. first\n2) second\n===\n---\n[1]: https://evil.test\n<div\n| a | b |\n|---|---|',
      '&alpha; &amp; &#955; x <https://a.b> y <!-- c --> z <b and c>d `code` ~~gone~~ __u__ _e_',
      'ends with a backslash\\\nand a \\* literal and \\frac{a}{b}',
      'line one measures 10*8\nline two measures 9*7 too',
      '    indented code \\* &amp;\nnext line *a* *b*',
      '```\nfence\n```\n~~~',
    ];

    it.each(PLAIN_SOURCES)('plain mode renders every source character of %j', (source) => {
      expect(renderedText(plain(source))).toBe(collapse(source));
    });

    /** The parser's structure taken off a line, as a renderer takes it off. */
    const STRUCTURE_RE = /^(?: {2})*(?:> )*(?: {2})*(?:- |-$|\d{1,9}\. |\d{1,9}\.$)?/;
    const structuredVisible = (source: string) =>
      collapse(
        source
          .split('\n')
          .filter((line) => !/^(?:> )*```$/.test(line))
          .map((line) => line.replace(STRUCTURE_RE, ''))
          .join('\n'),
      );

    const STRUCTURED_SOURCE = [
      'Patients and methods',
      'Tumours measured 10*8*6 mm [12] with p.His252Glnfs*21 and p.His252Glnfs*21.',
      '',
      'Abbreviations',
      '- BS — bariatric *surgery* (a_{ij})_{N×N}',
      '  - nested 3*4 item <CD20>',
      '  1. nested ordered',
      '-',
      '  prose after the nested list &amp;',
      '',
      '1. first [Ca2+](i)',
      '2. second \\* x',
      '',
      '> quoted *text*',
      '> — Attrib',
      '',
      '```',
      'raw *code* \\* &amp; <b>x</b>',
      '',
      'still raw',
      '```',
      '',
      '[Box: Box 1. Title]',
      '',
      '[End of box]',
    ].join('\n');

    it('structured mode renders every source character outside the parser structure', () => {
      expect(renderedText(structured(STRUCTURED_SOURCE))).toBe(
        structuredVisible(STRUCTURED_SOURCE),
      );
    });

    it('structured mode renders the same lists, quotes and code blocks as the unescaped text', () => {
      const escaped = structured(STRUCTURED_SOURCE);
      for (const tag of ['li', 'ul', 'ol', 'blockquote', 'pre']) {
        expect(count(escaped, tag)).toBe(count(STRUCTURED_SOURCE, tag));
      }
      expect(count(escaped, 'li')).toBe(6);
      expect(count(escaped, 'em')).toBe(0);
    });

    it('keeps a deposit line of three backticks inside a longer fence', () => {
      const source = 'Code:\n\n````\nlet a = 2*3*4;\n```\nnot *closed* yet\n````\n\nafter';
      expect(count(structured(source), 'pre')).toBe(1);
      expect(count(structured(source), 'em')).toBe(0);
      expect(renderedText(structured(source))).toBe(
        'Code: let a = 2*3*4; ``` not *closed* yet after',
      );
    });

    it('keeps the markdown after a fence a budget cut left open out of the code block', () => {
      const cut = structured('Methods *a*\n\n```\nraw 10*8*6');
      const document = `${cut}\n\n#### Results\n${structured('size 10*8*6 mm')}`;
      expect(count(document, 'h4')).toBe(1);
      expect(count(document, 'pre')).toBe(1);
      expect(renderedText(document)).toBe('Methods *a* raw 10*8*6 Results size 10*8*6 mm');
    });
  },
);

/** CPU time of `run`, in ms — this thread's user + system time, not wall clock. */
const cpuMs = (run: () => void): number => {
  const start = process.threadCpuUsage();
  run();
  const { user, system } = process.threadCpuUsage(start);
  return (user + system) / 1000;
};

/** Repeat `unit` to exactly `length` characters. */
const fill = (unit: string, length: number) =>
  unit.repeat(Math.ceil(length / unit.length)).slice(0, length);

describe('escapeMarkdownBlock linear time on adversarial input (issue #255)', () => {
  /** Fastest of five measurements of `calls` calls each — the least noisy reading of the work. */
  const fastestMs = (input: string, mode: 'plain' | 'structured', calls = 2): number => {
    escapeMarkdownBlock(input, mode);
    return Math.min(
      ...Array.from({ length: 5 }, () =>
        cpuMs(() => {
          for (let i = 0; i < calls; i++) escapeMarkdownBlock(input, mode);
        }),
      ),
    );
  };

  /** Worst cases for each scan: tag and entity lookaheads, line-start rules, the structure prefix. */
  const ADVERSARIAL: Array<[string, (n: number) => string]> = [
    ['`<a` with no `>`', (n) => fill('<a', n)],
    ['`<` then letters', (n) => `<${'a'.repeat(n - 1)}`],
    ['`<a`, then as many `>`', (n) => `${'<a'.repeat(n / 4)}${'>'.repeat(n / 2)}`],
    ['`<a@` (email branch)', (n) => fill('<a@', n)],
    ['`&` then 31 letters, no `;`', (n) => fill(`&${'a'.repeat(31)}`, n)],
    ['`[a` lines (definition scan)', (n) => fill('[a\n', n)],
    ['`[` then letters', (n) => `[${'a'.repeat(n - 1)}`],
    ['a `#` run', (n) => '#'.repeat(n)],
    ['dashes ending in a letter', (n) => `${'-'.repeat(n - 1)}x`],
    ['`> ` repeated (quote prefix)', (n) => fill('> ', n)],
    ['spaces ending in a letter', (n) => `${' '.repeat(n - 1)}x`],
    ['mixed delimiters', (n) => fill('*_~`', n)],
    ['a backslash before punctuation', (n) => fill('\\*', n)],
    ['a backtick run (fence scan)', (n) => '`'.repeat(n)],
    ['fence lines throughout', (n) => fill('```\n', n)],
    [
      'a backtick run after `> `, ending in a letter',
      (n) => `${fill('> ', n / 2)}${'`'.repeat(n / 2 - 1)}x`,
    ],
  ];

  /** Shapes no regex here switches engine mode on, so they carry the full 64× span. */
  const FULL_SPAN: Array<[string, (n: number) => string]> = [
    ['a digit run', (n) => '1'.repeat(n)],
    ['one long line ending in a break', (n) => `${'§1 x'.repeat(n / 4)}\ny`],
    ['line breaks throughout', (n) => '  \r\n'.repeat(n / 4)],
  ];

  for (const mode of ['plain', 'structured'] as const) {
    it.each(ADVERSARIAL)(
      `scales linearly from 5k to 80k characters of %s (${mode})`,
      (_label, build) => {
        // Doubling from 5k, each size checked against the absolute bound before the next runs.
        const times: number[] = [];
        for (let n = 5_000; n <= 80_000; n *= 2) {
          const ms = fastestMs(build(n), mode);
          expect(ms).toBeLessThan(400);
          times.push(ms);
        }
        // Linear work grows 16× across the span; quadratic grows 256×.
        expect((times.at(-1) ?? 0) / Math.max(times[0] ?? 0, 0.05)).toBeLessThan(64);
      },
    );

    it.each(FULL_SPAN)(
      `scales linearly from 5k to 320k characters of %s (${mode})`,
      (_label, build) => {
        // Doubling from 5k, each size checked against the absolute bound before the next runs.
        const times: number[] = [];
        for (let n = 5_000; n <= 320_000; n *= 2) {
          const ms = fastestMs(build(n), mode);
          expect(ms).toBeLessThan(400);
          times.push(ms);
        }
        // Linear work grows 64× across the span; quadratic grows 4096×.
        expect((times.at(-1) ?? 0) / Math.max(times[0] ?? 0, 0.05)).toBeLessThan(256);
      },
    );
  }
});

describe('markdownCodeSpan and markdownCodeFence linear time on adversarial input (issue #255)', () => {
  const HELPERS = { markdownCodeSpan, markdownCodeFence } as const;

  /** Fastest of five measurements of 4 calls each — the least noisy reading of the work. */
  const fastestMs = (input: string, helper: keyof typeof HELPERS): number => {
    const run = HELPERS[helper];
    run(input);
    return Math.min(
      ...Array.from({ length: 5 }, () =>
        cpuMs(() => {
          for (let i = 0; i < 4; i++) run(input);
        }),
      ),
    );
  };

  /** Every shape carries the full 64× span: the run scan is a plain loop, no regex. */
  const SHAPES: Array<[string, (n: number) => string]> = [
    ['one backtick run', (n) => '`'.repeat(n)],
    ['runs of growing length', (n) => fill('`a``b```c````d', n)],
    ['single backticks between letters', (n) => fill('`a', n)],
    ['a digit run', (n) => '1'.repeat(n)],
    ['one long line ending in a break', (n) => `${'§1 x'.repeat(n / 4)}\ny`],
    ['line breaks throughout', (n) => '  \r\n'.repeat(n / 4)],
  ];

  for (const helper of Object.keys(HELPERS) as (keyof typeof HELPERS)[]) {
    it.each(SHAPES)(
      `scales linearly from 5k to 320k characters of %s (${helper})`,
      (_label, build) => {
        // Doubling from 5k, each size checked against the absolute bound before the next runs.
        const times: number[] = [];
        for (let n = 5_000; n <= 320_000; n *= 2) {
          const ms = fastestMs(build(n), helper);
          expect(ms).toBeLessThan(400);
          times.push(ms);
        }
        // Linear work grows 64× across the span; quadratic grows 4096×.
        expect((times.at(-1) ?? 0) / Math.max(times[0] ?? 0, 0.05)).toBeLessThan(256);
      },
    );
  }
});

describe('render-time escapes: constructs a renderer reads that the escapes missed (issue #255)', () => {
  it('escapes an entity-shaped `&` in an inline value and a table cell', () => {
    expect(escapeMarkdownInline('R&amp;D &#955; &#x3bb; A & B &c')).toBe(
      'R\\&amp;D \\&#955; \\&#x3bb; A & B &c',
    );
    expect(escapeMarkdownTableCell('10.1/a&amp;b|c')).toBe('10.1/a\\&amp;b\\|c');
  });

  it('escapes a comment opener whose body holds a `<`', () => {
    expect(plain('x <!-- a<b --> y')).toBe('x \\<!-- a\\<b --> y');
    expect(escapeMarkdownInline('x <!-- a<b --> y')).toBe('x \\<!-- a\\<b --> y');
  });

  it('escapes a block-opening `[` whose definition label closes on a later line', () => {
    expect(plain('[a\nb]: /u\n\n[a b]')).toBe('\\[a\nb]: /u\n\n[a b]');
    expect(plain('[Box: Box 1. Virtual format]')).toBe('[Box: Box 1. Virtual format]');
  });

  it('escapes an inline email autolink whose local part opens with a non-letter', () => {
    expect(escapeMarkdownInline('mail <1a@b.org> now')).toBe('mail \\<1a@b.org> now');
  });

  it('escapes a block marker behind a leading tab', () => {
    expect(escapeMarkdownLineStart('\t> quote')).toBe('\t\\> quote');
  });

  describe.runIf(bunMarkdown !== undefined)('rendered', () => {
    it.each([
      ['an entity in a label line', `**T:** ${escapeMarkdownInline('R&amp;D')}`, 'T: R&amp;D'],
      ['a comment holding a `<`', plain('x <!-- a<b --> y'), 'x <!-- a<b --> y'],
      ['a two-line definition label', plain('[a\nb]: /u\n\n[a b]'), '[a b]: /u [a b]'],
      [
        'a tab before a quote marker',
        `- x\n  ${escapeMarkdownLineStart('\t> quote')}`,
        'x > quote',
      ],
    ])('shows every character of %s', (_label, markdown, expected) => {
      expect(renderedText(markdown)).toBe(expected);
    });
  });
});

describe.runIf(bunMarkdown !== undefined)(
  'task-list markers and code spans rendered (issue #255)',
  () => {
    it('keeps the brackets of a parser list item that opens like a task', () => {
      const markdown = structured('- [x] done\n  - [ ] open\n1. [X] item');
      expect(renderedHtml(markdown)).not.toContain('<input');
      expect(count(markdown, 'li')).toBe(3);
      expect(renderedText(markdown)).toBe('[x] done [ ] open [X] item');
    });

    it('keeps the brackets of a list item value that opens like a task', () => {
      const markdown = `- ${escapeMarkdownLineStart('[x] Smith J')}\n- ${escapeMarkdownListItem('[ ] *a* *b*')}`;
      expect(renderedHtml(markdown)).not.toContain('<input');
      expect(renderedText(markdown)).toBe('[x] Smith J [ ] *a* *b*');
    });

    it.each([
      'cance* AND neuro*',
      'risk[tiab] AND <b>x</b> &amp; a_b_c_ \\* ~~d~~',
      'a`b',
      '`a',
      'a``',
      ' padded ',
    ])('renders the code span of %j as the value', (value) => {
      /** The text of the one code span `markdown` renders, the renderer's entities decoded. */
      const codeText = (markdown: string) => {
        const spans = [...renderedHtml(markdown).matchAll(/<code>([\s\S]*?)<\/code>/g)];
        expect(spans).toHaveLength(1);
        return (spans[0]?.[1] ?? '')
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .replace(/&quot;/g, '"')
          .replace(/&amp;/g, '&');
      };
      expect(codeText(markdownCodeSpan(value))).toBe(value);
      expect(codeText(`**Query:** ${markdownCodeSpan(value)}`)).toBe(value);
    });

    it('keeps a fenced block whose content holds a fence-length backtick run closed at its end', () => {
      const content = 'title={a ``` b}\n```\nnot *emphasis*';
      const fence = markdownCodeFence(content);
      const markdown = `${fence}bibtex\n${content}\n${fence}\n\nafter *b*`;
      expect(count(markdown, 'pre')).toBe(1);
      expect(renderedHtml(markdown)).toContain('not *emphasis*');
      expect(renderedHtml(markdown)).toContain('<em>b</em>');
    });
  },
);
