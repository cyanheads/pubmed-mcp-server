/**
 * @fileoverview Tests for plain-text normalization helpers.
 * @module tests/services/ncbi/parsing/text-helpers.test
 */

import { describe, expect, it } from 'vitest';
import { decodeHtmlEntities, toDisplayText } from '@/services/ncbi/parsing/text-helpers.js';

describe('decodeHtmlEntities', () => {
  it('decodes the core named XML entities', () => {
    expect(decodeHtmlEntities('CSR&amp;D')).toBe('CSR&D');
    expect(decodeHtmlEntities('a &lt;b&gt; c &quot;d&quot; &apos;e&apos;')).toBe(
      'a <b> c "d" \'e\'',
    );
  });

  it('decodes decimal and hex numeric references', () => {
    expect(decodeHtmlEntities('en&#8211;dash')).toBe('en–dash');
    expect(decodeHtmlEntities('hex&#x2013;dash')).toBe('hex–dash');
    expect(decodeHtmlEntities('beta &#x3b2;')).toBe('beta β');
  });

  it('collapses an NCBI double-encoded ampersand left by one parser pass', () => {
    // EFetch ships `CSR&amp;amp;D`; the XML parser decodes once to `CSR&amp;D`,
    // and this second pass yields the display form. (#74)
    expect(decodeHtmlEntities('CSR&amp;D I01CX002210')).toBe('CSR&D I01CX002210');
  });

  it('leaves a bare ampersand untouched (idempotent on already-decoded text)', () => {
    expect(decodeHtmlEntities('AT&T')).toBe('AT&T');
    expect(decodeHtmlEntities('CSR&D')).toBe('CSR&D');
  });

  it('leaves unknown named entities and malformed references intact', () => {
    expect(decodeHtmlEntities('&notarealentity;')).toBe('&notarealentity;');
    expect(decodeHtmlEntities('&#xZZ;')).toBe('&#xZZ;');
  });
});

describe('toDisplayText', () => {
  it('strips JATS/HTML structural tags and collapses the gaps', () => {
    expect(toDisplayText('<h4>Background: </h4> Emergency department triage')).toBe(
      'Background: Emergency department triage',
    );
    expect(toDisplayText('<title>Abstract</title>  <p>  <bold>Background:</bold>  text')).toBe(
      'Abstract Background: text',
    );
  });

  it('decodes entities after stripping tags', () => {
    expect(toDisplayText('Emergency &amp; care &lt;LLMs&gt;')).toBe('Emergency & care <LLMs>');
  });

  it('removes soft hyphens (literal and entity-encoded) that corrupt mid-word tokens', () => {
    expect(toDisplayText('clini­cal gen­eration')).toBe('clinical generation');
    expect(toDisplayText('soft&shy;hyphen')).toBe('softhyphen');
  });

  it('returns empty string for a markup-only input', () => {
    expect(toDisplayText('<p></p>')).toBe('');
  });

  it('strips namespaced and self-closing tags', () => {
    expect(toDisplayText('H<mml:math>x</mml:math>O')).toBe('H x O');
    expect(toDisplayText('line<br/>break')).toBe('line break');
    expect(toDisplayText('<sec id="s1" sec-type="methods">Methods</sec>')).toBe('Methods');
  });

  describe('statistical notation survives the tag strip (#94)', () => {
    it('keeps a P value whose `<` precedes a real tag', () => {
      // The reported failure: the strip opened on the `<` of `P<0.001` and closed
      // on the `>` of the next real tag, deleting the Results text between them.
      expect(toDisplayText('CI, -0.67 to -0.23; P<0.001).</p><title>Conclusions</title>')).toBe(
        'CI, -0.67 to -0.23; P<0.001). Conclusions',
      );
    });

    it('keeps a comparison whose `<` is followed by a letter', () => {
      // Forbidding `<` inside the tag body stops a match opened on the stray `<`
      // from spanning across `<bold>`.
      expect(toDisplayText('n<N chain expression <bold>up</bold>')).toBe('n<N chain expression up');
      expect(toDisplayText('if a<B then <i>c</i> else <i>d</i>')).toBe('if a<B then c else d');
    });

    it('keeps repeated numeric comparisons ahead of a tag', () => {
      expect(toDisplayText('x<1 and y<2 <bold>z</bold>')).toBe('x<1 and y<2 z');
    });

    it('leaves a spaced comparison untouched', () => {
      expect(toDisplayText('a < b and c > d')).toBe('a < b and c > d');
    });

    it('documents the accepted limitation: a tagless `<letter … >` pair still strips', () => {
      // `a<b and c>d` is indistinguishable from a tag by shape alone. Closing this
      // would take a tag-name allowlist, which would silently drop unknown JATS
      // elements — the pattern deliberately errs toward leaving markup visible
      // rather than deleting text, so this case is a known residual gap.
      expect(toDisplayText('a<b and c>d')).toBe('a d');
      // A tag-shaped term in raw prose is the same gap: no shape rule tells it
      // from an unknown JATS element.
      expect(toDisplayText('HuMab<CD20> antibody')).toBe('HuMab antibody');
    });
  });

  describe('structural tags and escaped literal text', () => {
    it('replaces a non-formatting tag with a space, attributes and all', () => {
      expect(toDisplayText('<h4>Background: </h4>Emergency')).toBe('Background: Emergency');
      expect(toDisplayText('see<a href="x">link</a>here')).toBe('see link here');
    });

    it.each([
      ['Children Aged &lt;5 Years', 'Children Aged <5 Years'],
      ['p&lt;0.001', 'p<0.001'],
      ['FCR &lt; 0.25', 'FCR < 0.25'],
      ['the &lt;gene&gt; token', 'the <gene> token'],
      ['tuned &lt;LLMs&gt;', 'tuned <LLMs>'],
      ['H&lt;mml:math&gt;x', 'H<mml:math>x'],
      ['the &lt;i class="x"&gt; tag', 'the <i class="x"> tag'],
      ['Assay of &amp;lt;i&amp;gt; markers', 'Assay of &lt;i&gt; markers'],
    ])('keeps escaped text that is not a bare formatting tag literal: %s', (input, expected) => {
      expect(toDisplayText(input)).toBe(expected);
    });
  });

  describe('inline formatting tags, raw or entity-encoded (#181)', () => {
    const FORMATTING_NAMES = [
      'b',
      'i',
      'u',
      'sup',
      'sub',
      'inf',
      'sc',
      'bold',
      'italic',
      'underline',
      'em',
      'strong',
    ];

    it('removes the entity-encoded tags Europe PMC sends in MED titles', () => {
      expect(
        toDisplayText(
          '&lt;b&gt;Molecular mechanism of ephedrine-regulated ferroptosis in asthma via PKM2-ACSL4 lactylation&lt;/b&gt;.',
        ),
      ).toBe(
        'Molecular mechanism of ephedrine-regulated ferroptosis in asthma via PKM2-ACSL4 lactylation.',
      );
      expect(toDisplayText('Application of [&lt;sup&gt;18&lt;/sup&gt;F]NaF')).toBe(
        'Application of [18F]NaF',
      );
      expect(
        toDisplayText('Fe&lt;sub&gt;3&lt;/sub&gt;O&lt;sub&gt;4&lt;/sub&gt; nanoparticles'),
      ).toBe('Fe3O4 nanoparticles');
      expect(toDisplayText('Phenotypes in &lt;italic&gt;Drosophila&lt;/italic&gt;')).toBe(
        'Phenotypes in Drosophila',
      );
    });

    it('matches encoded tags case-insensitively', () => {
      expect(toDisplayText('&LT;I&GT;x&LT;/I&GT;')).toBe('x');
    });

    it('removes an unpaired encoded tag', () => {
      expect(toDisplayText('Effects of &lt;i&gt;Bacillus')).toBe('Effects of Bacillus');
    });

    it('gives one string whichever form the tags arrive in', () => {
      expect(toDisplayText('D<sub>2</sub>O')).toBe('D2O');
      expect(toDisplayText('D&lt;sub&gt;2&lt;/sub&gt;O')).toBe('D2O');
    });

    it.each(FORMATTING_NAMES)('removes bare `%s` tags without a space, raw and encoded', (name) => {
      const upper = name.toUpperCase();
      expect(toDisplayText(`x<${name}>y</${name}>z`)).toBe('xyz');
      expect(toDisplayText(`x<${upper}>y</${upper}>z`)).toBe('xyz');
      expect(toDisplayText(`x&lt;${name}&gt;y&lt;/${name}&gt;z`)).toBe('xyz');
      expect(toDisplayText(`x&lt;${upper}&gt;y&lt;/${upper}&gt;z`)).toBe('xyz');
    });

    it('decodes once and never re-scans what a removal joins or a decode produces', () => {
      expect(toDisplayText('&lt;&lt;i&gt;i&gt;')).toBe('<i>');
      expect(toDisplayText('x <<i>i> y')).toBe('x <i> y');
      expect(toDisplayText('Assay of &amp;lt;i&amp;gt; markers')).toBe(
        'Assay of &lt;i&gt; markers',
      );
    });

    it('keeps the space for a formatting-named tag that is not bare', () => {
      // A `b` tag with a body is not a formatting tag, so the #94 limitation
      // keeps its space rather than joining `a` and `d`.
      expect(toDisplayText('a<b and c>d')).toBe('a d');
      expect(toDisplayText('x<sup class="s">2</sup>')).toBe('x 2');
    });

    it('normalizes an encoded empty element to nothing, as the raw form does', () => {
      expect(toDisplayText('&lt;i&gt;&lt;/i&gt;')).toBe('');
      expect(toDisplayText('<i></i>')).toBe('');
    });

    it('keeps the break where a formatting tag follows sentence-closing punctuation', () => {
      // Abstracts set headings in bold or italic with no whitespace around them.
      expect(toDisplayText('young children.<b>Aim.</b> The aim')).toBe(
        'young children. Aim. The aim',
      );
      expect(toDisplayText('<i>Objective.</i>Quantitative analysis')).toBe(
        'Objective. Quantitative analysis',
      );
      expect(toDisplayText('<b>Background/Objectives:</b><i>Escherichia coli</i> bacteremia')).toBe(
        'Background/Objectives: Escherichia coli bacteremia',
      );
      expect(toDisplayText('index of 10%.<sup>18</sup>F-FDG')).toBe('index of 10%. 18F-FDG');
      expect(toDisplayText('Results.&lt;i&gt;E. coli&lt;/i&gt; grew')).toBe(
        'Results. E. coli grew',
      );
    });

    it('still joins where no sentence ends', () => {
      expect(toDisplayText('T2::<i>Nluc</i>')).toBe('T2::Nluc');
      expect(toDisplayText('<i>bla</i><sub>CTX-M</sub>.')).toBe('blaCTX-M.');
      expect(toDisplayText('in <i>E. coli</i>.')).toBe('in E. coli.');
      expect(toDisplayText('statement.</b> In')).toBe('statement. In');
      expect(toDisplayText('P = 0.<b>05</b>, at 10:<b>30</b>')).toBe('P = 0.05, at 10:30');
    });
  });

  describe('legacy `<or=` notation (#195)', () => {
    it('keeps a `<or=` comparison and the text up to a later `>`', () => {
      expect(toDisplayText('relative intensity <or= 20 or > 20), identified')).toBe(
        'relative intensity <or= 20 or > 20), identified',
      );
    });

    it('still removes real tags, with and without attributes', () => {
      expect(toDisplayText('<i>x</i> <sup>2</sup> <a href="x">y</a> line<br/>break')).toBe(
        'x 2 y line break',
      );
    });
  });

  describe('linear time on adversarial input (#181, #195)', () => {
    /** CPU time of `run`, in ms — this thread's user + system time, not wall clock. */
    const cpuMs = (run: () => void): number => {
      const start = process.threadCpuUsage();
      run();
      const { user, system } = process.threadCpuUsage(start);
      return (user + system) / 1000;
    };

    /** Fastest of five measurements of ten calls each — the least noisy reading of the work. */
    const fastestMs = (input: string): number => {
      toDisplayText(input);
      return Math.min(
        ...Array.from({ length: 5 }, () =>
          cpuMs(() => {
            for (let i = 0; i < 10; i++) toDisplayText(input);
          }),
        ),
      );
    };

    /** Repeat `unit` to exactly `length` characters. */
    const fill = (unit: string, length: number) =>
      unit.repeat(Math.ceil(length / unit.length)).slice(0, length);

    it.each([
      ['`&lt;` with no `&gt;`', '&lt;'.repeat(100_000), '<'.repeat(100_000)],
      ['`&lt;i`', '&lt;i'.repeat(100_000), '<i'.repeat(100_000)],
      ['`<a`', '<a'.repeat(100_000), '<a'.repeat(100_000)],
      ['`&lt;&lt;i&gt;i&gt;`', '&lt;&lt;i&gt;i&gt;'.repeat(100_000), '<i>'.repeat(100_000)],
      ['`<or=`', '<or='.repeat(100_000), '<or='.repeat(100_000)],
      ['`<a b ` (body, no `>`)', '<a b '.repeat(100_000), '<a b '.repeat(100_000).trim()],
      ['`<` then 10^5 letters', `<${'a'.repeat(100_000)}`, `<${'a'.repeat(100_000)}`],
      ['`.<i>`', '.<i>'.repeat(100_000), '.'.repeat(100_000)],
      ['`.` then 10^5 `<i>`', `.${'<i>'.repeat(100_000)}a`, '. a'],
    ])('handles 10^5 repetitions of %s within a CPU bound', (_label, input, expected) => {
      let output = '';
      const elapsed = cpuMs(() => {
        output = toDisplayText(input);
      });
      expect(output).toBe(expected);
      expect(elapsed).toBeLessThan(400);
    });

    it.each([
      ['&lt;'],
      ['&lt;i'],
      ['&lt;/'],
      ['&lt;bol'],
      ['<a'],
      ['<<<a'],
      ['&lt;&lt;i&gt;i&gt;'],
      ['<or='],
      ['<a b '],
      ['<a'.concat('b'.repeat(99))],
      ['.<i>'],
      ['.&lt;i&gt;'],
    ])('scales linearly from 5k to 80k characters of %s', (unit) => {
      const [t5k, t20k, t80k] = [5_000, 20_000, 80_000].map((n) => fastestMs(fill(unit, n)));
      // Linear work grows 16× across the span; quadratic grows 256×.
      expect((t80k ?? 0) / Math.max(t5k ?? 0, 0.001)).toBeLessThan(64);
      expect(t20k).toBeLessThan(400);
      expect(t80k).toBeLessThan(400);
    });

    it('scales linearly on `<` followed only by letters', () => {
      const [t5k, t80k] = [5_000, 80_000].map((n) => fastestMs(`<${'a'.repeat(n - 1)}`));
      expect((t80k ?? 0) / Math.max(t5k ?? 0, 0.001)).toBeLessThan(64);
      expect(t80k).toBeLessThan(400);
    });
  });
});
