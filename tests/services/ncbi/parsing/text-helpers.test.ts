/**
 * @fileoverview Tests for plain-text normalization helpers.
 * @module tests/services/ncbi/parsing/text-helpers.test
 */

import { describe, expect, it } from 'vitest';
import {
  decodeHtmlEntities,
  europePmcTitleText,
  stripEncodedMarkupTags,
  toDisplayText,
} from '@/services/ncbi/parsing/text-helpers.js';

import { EPMC_APOS_TITLE_HIT } from './_entity-fixtures.js';

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

describe('europePmcTitleText (#272)', () => {
  it('decodes the layer NCBI double-encoded in a PubMed title Europe PMC relays (MED/42138044)', () => {
    expect(europePmcTitleText(EPMC_APOS_TITLE_HIT.title)).toBe(
      "Cervical Vestibular-Evoked Myogenic Potentials (cVEMPs) in Parkinson's Disease Patients: Prospective, Case-Control study.",
    );
  });

  it('decodes one layer more than toDisplayText, never to a fixed point', () => {
    expect(europePmcTitleText('a &amp;amp;lt; b')).toBe('a &lt; b');
    expect(europePmcTitleText('Assay of &amp;lt;i&amp;gt; markers')).toBe('Assay of <i> markers');
  });

  it.each([
    ['plain text', "What Counts as 'Real' in Healthcare Interaction?"],
    ['an entity Europe PMC encoded once', 'R&amp;D at AT&T, P &lt; 0.05'],
    ['entity-encoded title markup', '&lt;b&gt;Molecular mechanism of ferroptosis&lt;/b&gt;.'],
    ['raw markup and notation', '<i>PIP2;1</i> where P<0.001 and IL-6 > baseline'],
  ])('reads a title with no residual layer as toDisplayText does: %s', (_label, title) => {
    expect(europePmcTitleText(title)).toBe(toDisplayText(title));
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
      // `a<b and c>d` is indistinguishable from a tag with attributes by shape
      // alone, so this case is a known residual gap.
      expect(toDisplayText('a<b and c>d')).toBe('a d');
      // A bare tag-shaped term with no closing partner is kept (#256).
      expect(toDisplayText('HuMab<CD20> antibody')).toBe('HuMab<CD20> antibody');
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

  describe('a bare tag-shaped term with no closing partner (#256)', () => {
    it('keeps a literal antibody identifier (PAT/US2011076273)', () => {
      expect(
        toDisplayText(
          'such as e.g. Rituximab, Ocrelizumab, or HuMab<CD20>, or a mixture of such antibody molecules',
        ),
      ).toBe(
        'such as e.g. Rituximab, Ocrelizumab, or HuMab<CD20>, or a mixture of such antibody molecules',
      );
      expect(toDisplayText('tuned <LLMs> and <CD20>')).toBe('tuned <LLMs> and <CD20>');
    });

    it.each([
      ['an unknown element closed later', 'a<CD20>x</CD20>b', 'a x b'],
      ['a partner in another case', 'a<Foo>x</foo>b', 'a x b'],
      ['a partner before the opener', 'a</sec>b<sec>c', 'a b c'],
      ['one partner for several openers', '<x>a<x>b</x>', 'a b'],
      ['a closing partner with a body', 'a<CD20>x</CD20 >b', 'a x b'],
    ])('strips a bare tag whose `</name>` is in the string: %s', (_label, input, expected) => {
      expect(toDisplayText(input)).toBe(expected);
    });

    it.each([
      ['br', 'line<br>break', 'line break'],
      ['hr', 'a<hr>b', 'a b'],
      ['img', 'a<img>b', 'a b'],
      ['wbr', 'long<wbr>word', 'long word'],
      ['p', '<p>First paragraph', 'First paragraph'],
      ['P', 'a<P>b', 'a b'],
      ['li', '<li>item one<li>item two', 'item one item two'],
      ['i', 'Effects of <i>Bacillus', 'Effects of Bacillus'],
      ['SUP', 'x<SUP>2', 'x2'],
    ])('strips an unpaired bare `<%s>`, a void or formatting name', (_name, input, expected) => {
      expect(toDisplayText(input)).toBe(expected);
    });

    it.each([
      ['a closing tag', 'HuMab</CD20> antibody', 'HuMab antibody'],
      ['attributes, unclosed', '<span data-teams="true">Preprint title', 'Preprint title'],
      ['a self-closing slash', 'a<CD20/>b', 'a b'],
      ['a trailing space', 'a<CD20 >b', 'a b'],
    ])('strips an unpaired tag with %s', (_label, input, expected) => {
      expect(toDisplayText(input)).toBe(expected);
    });

    it('keeps an opener whose only partner names another element', () => {
      expect(toDisplayText('HuMab<CD20> x</CD19> y')).toBe('HuMab<CD20> x y');
    });

    it('does not count an entity-encoded closing tag as a partner', () => {
      expect(toDisplayText('HuMab<CD20> and &lt;/CD20&gt;')).toBe('HuMab<CD20> and </CD20>');
    });
  });

  describe('entity-encoded void and paragraph tags (#262)', () => {
    it('strips the encoded markup of a Europe PMC abstract (MED/42515993)', () => {
      // Europe PMC's JSON carries the record's double-encoded HTML one layer down.
      expect(
        toDisplayText(
          '&lt;p&gt;&lt;strong&gt;Introduction:&lt;/strong&gt; Pollen monitoring plays an important role in modern allergy care.&lt;br /&gt;Quantitatively determining airborne pollen concentrations serves as a clinically relevant&lt;br /&gt;tool for diagnosis.&lt;br /&gt;&lt;strong&gt;Aim:&lt;/strong&gt; The study.&lt;/p&gt;',
        ),
      ).toBe(
        'Introduction: Pollen monitoring plays an important role in modern allergy care. Quantitatively determining airborne pollen concentrations serves as a clinically relevant tool for diagnosis. Aim: The study.',
      );
    });

    it.each([
      ['br', 'line&lt;br&gt;break'],
      ['br /', 'line&lt;br /&gt;break'],
      ['br/', 'line&lt;br/&gt;break'],
      ['/br', 'line&lt;/br&gt;break'],
      ['BR /', 'line&LT;BR /&GT;break'],
      ['hr', 'line&lt;hr&gt;break'],
      ['img /', 'line&lt;img /&gt;break'],
      ['li', 'line&lt;li&gt;break'],
      ['/li', 'line&lt;/li&gt;break'],
      ['p', 'line&lt;p&gt;break'],
      ['/p', 'line&lt;/p&gt;break'],
      ['wbr', 'line&lt;wbr&gt;break'],
      ['b /', 'line&lt;b /&gt;break'],
    ])('turns an encoded `<%s>` into a space', (_name, input) => {
      expect(toDisplayText(input)).toBe('line break');
    });

    it.each([
      ['an element outside the set', 'the &lt;pre&gt; block', 'the <pre> block'],
      ['a name the set only prefixes', 'a &lt;bra&gt; b', 'a <bra> b'],
      ['attributes', 'the &lt;p class="x"&gt; tag', 'the <p class="x"> tag'],
      ['a body that is not a lone slash', 'a &lt;br x/&gt; b', 'a <br x/> b'],
      ['no closing semicolon', 'medicine.&lt;/p&gt.', 'medicine.</p&gt.'],
      ['a second encoded layer', 'a &amp;lt;br /&amp;gt; b', 'a &lt;br /&gt; b'],
    ])('keeps encoded text that is not one of those tags: %s', (_label, input, expected) => {
      expect(toDisplayText(input)).toBe(expected);
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

    /** Fastest of five measurements of `calls` calls each — the least noisy reading of the work. */
    const fastestMs = (input: string, calls = 10): number => {
      toDisplayText(input);
      return Math.min(
        ...Array.from({ length: 5 }, () =>
          cpuMs(() => {
            for (let i = 0; i < calls; i++) toDisplayText(input);
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
      ['`</a` (#256)', '</a'.repeat(100_000), '</a'.repeat(100_000)],
      [
        '`<a`, then as many `>` (#256)',
        `${'<a'.repeat(100_000)}${'>'.repeat(100_000)}`,
        `${'<a'.repeat(100_000)}${'>'.repeat(100_000)}`,
      ],
      ['`<a>`, never closed (#256)', '<a>'.repeat(100_000), '<a>'.repeat(100_000)],
      ['`<a>`, closed once at the end (#256)', `${'<a>'.repeat(100_000)}</a>`, ''],
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

    it.each<[string, (n: number) => string]>([
      ['`</a` (#256)', (n) => fill('</a', n)],
      ['`<a>`, never closed (#256)', (n) => fill('<a>', n)],
      ['`<a>`, closed once at the end (#256)', (n) => `${fill('<a>', n - 4)}</a>`],
      ['`<a`, then as many `>` (#256)', (n) => `${'<a'.repeat(n / 4)}${'>'.repeat(n / 2)}`],
      ['`<CD20> x ` (#256)', (n) => fill('<CD20> x ', n)],
      ['a digit run', (n) => '1'.repeat(n)],
      ['one long line ending in a break', (n) => `${'§1 x'.repeat(n / 4)}\ny`],
      ['line breaks throughout', (n) => '  \r\n'.repeat(n / 4)],
    ])('scales linearly from 5k to 320k characters of %s', (_label, build) => {
      // Doubling from 5k, each size checked against the absolute bound before the
      // next runs. Two calls per measurement keep seven sizes inside the test timeout.
      const times: number[] = [];
      for (let n = 5_000; n <= 320_000; n *= 2) {
        const ms = fastestMs(build(n), 2);
        expect(ms).toBeLessThan(400);
        times.push(ms);
      }
      // Linear work grows 64× across the span; quadratic grows 4096×.
      expect((times.at(-1) ?? 0) / Math.max(times[0] ?? 0, 0.05)).toBeLessThan(256);
    });

    it('scales linearly on `<` followed only by letters', () => {
      const [t5k, t80k] = [5_000, 80_000].map((n) => fastestMs(`<${'a'.repeat(n - 1)}`));
      expect((t80k ?? 0) / Math.max(t5k ?? 0, 0.001)).toBeLessThan(64);
      expect(t80k).toBeLessThan(400);
    });
  });
});

describe('stripEncodedMarkupTags (#262)', () => {
  it('strips the encoded tags of an EFetch abstract and leaves its entities for the decode', () => {
    expect(
      stripEncodedMarkupTags(
        '&lt;b&gt;Introduction:&lt;/b&gt; Postural stability remains limited.&lt;b&gt;Aim:&lt;/b&gt; To elucidate (P &lt; 0.001) a clinically relevant&lt;br /&gt;tool.',
      ),
    ).toBe(
      'Introduction: Postural stability remains limited. Aim: To elucidate (P &lt; 0.001) a clinically relevant tool.',
    );
  });

  it('leaves raw tags alone: they were single-encoded in the XML, so they are text', () => {
    expect(stripEncodedMarkupTags('<b>Aim:</b> HuMab<CD20> a<br />b')).toBe(
      '<b>Aim:</b> HuMab<CD20> a<br />b',
    );
  });

  it('adds no space beside whitespace or at either end, and keeps every line break', () => {
    expect(stripEncodedMarkupTags('&lt;p&gt;a.&lt;/p&gt;&lt;p&gt;b&lt;br /&gt;')).toBe('a. b');
    expect(stripEncodedMarkupTags('a.&lt;/p&gt;\n\n&lt;p&gt;b')).toBe('a.\n\nb');
    expect(stripEncodedMarkupTags('a &lt;br /&gt;b')).toBe('a b');
    expect(stripEncodedMarkupTags('a&lt;br /&gt;&lt;/b&gt; b')).toBe('a b');
  });

  it('keeps whitespace it did not produce, and a string with no encoded tag, byte for byte', () => {
    expect(stripEncodedMarkupTags('a  b\n\nc ')).toBe('a  b\n\nc ');
    expect(stripEncodedMarkupTags(' &lt;CD20&gt; P &lt; 0.001 &amp;lt;br&amp;gt; ')).toBe(
      ' &lt;CD20&gt; P &lt; 0.001 &amp;lt;br&amp;gt; ',
    );
  });

  it('joins where a formatting tag splits a word and keeps the break after a sentence', () => {
    expect(stripEncodedMarkupTags('D&lt;sub&gt;2&lt;/sub&gt;O')).toBe('D2O');
    expect(stripEncodedMarkupTags('children.&lt;b&gt;Aim.&lt;/b&gt; The')).toBe(
      'children. Aim. The',
    );
  });
});

describe('the encoded-tag strip runs in linear time (#262)', () => {
  /** CPU time of `run`, in ms — this thread's user + system time, not wall clock. */
  const cpuMs = (run: () => void): number => {
    const start = process.threadCpuUsage();
    run();
    const { user, system } = process.threadCpuUsage(start);
    return (user + system) / 1000;
  };

  /** `unit` repeated as many whole times as fit in `length` characters. */
  const units = (unit: string, length: number) => unit.repeat(Math.floor(length / unit.length));

  /**
   * Each row's builder takes the size and returns the input, what
   * `stripEncodedMarkupTags` must return for it, and what `toDisplayText` must.
   */
  it.each<[string, (n: number) => [string, string, string]]>([
    [
      '`&lt;br` with no `&gt;`',
      (n) => [units('&lt;br', n), units('&lt;br', n), '<br'.repeat(Math.floor(n / 6))],
    ],
    ['`&lt;br /&gt;` back to back', (n) => [units('&lt;br /&gt;', n), '', '']],
    [
      '`&lt;b&gt;` after a period',
      (n) => [units('.&lt;b&gt;', n), '.'.repeat(n / 10), '.'.repeat(n / 10)],
    ],
    ['a period, then only `&lt;b&gt;`', (n) => [`.${units('&lt;b&gt;', n - 2)}a`, '. a', '. a']],
    [
      '`&lt;br` then one long space run',
      (n) => [`&lt;br${' '.repeat(n - 6)}`, `&lt;br${' '.repeat(n - 6)}`, '<br'],
    ],
    [
      'one long line ending in a break',
      (n) => [
        `${'§1 x'.repeat(n / 4)}\ny`,
        `${'§1 x'.repeat(n / 4)}\ny`,
        `${'§1 x'.repeat(n / 4)} y`,
      ],
    ],
    [
      'line breaks throughout',
      (n) => [
        'x  \r\n'.repeat(n / 5),
        'x  \r\n'.repeat(n / 5),
        Array.from({ length: n / 5 }, () => 'x').join(' '),
      ],
    ],
  ])('scales linearly from 5k to 320k characters of %s', (_label, build) => {
    for (const [strip, outcome] of [
      [stripEncodedMarkupTags, 1],
      [toDisplayText, 2],
    ] as const) {
      // Doubling from 5k, each size's result and absolute bound checked before the
      // next runs; the fastest of three readings per size.
      const times: number[] = [];
      for (let n = 5_000; n <= 320_000; n *= 2) {
        const built = build(n);
        const input = built[0];
        expect(strip(input)).toBe(built[outcome]);
        const ms = Math.min(...Array.from({ length: 3 }, () => cpuMs(() => strip(input))));
        expect(ms).toBeLessThan(400);
        times.push(ms);
      }
      // Linear work grows 64× across the span; quadratic grows 4096×.
      expect((times.at(-1) ?? 0) / Math.max(times[0] ?? 0, 0.05)).toBeLessThan(256);
    }
  });
});

describe('the Europe PMC title decode runs in linear time (#272)', () => {
  /** CPU time of `run`, in ms — this thread's user + system time, not wall clock. */
  const cpuMs = (run: () => void): number => {
    const start = process.threadCpuUsage();
    run();
    const { user, system } = process.threadCpuUsage(start);
    return (user + system) / 1000;
  };

  /** Each row's builder takes the size and returns the input and the title it must read as. */
  it.each<[string, (n: number) => [string, string]]>([
    [
      '`&amp;amp;` back to back',
      (n) => ['&amp;amp;'.repeat(Math.floor(n / 9)), '&'.repeat(Math.floor(n / 9))],
    ],
    [
      '`&` then one long letter run with no `;`',
      (n) => [`&${'a'.repeat(n - 1)}`, `&${'a'.repeat(n - 1)}`],
    ],
    [
      '`&#x` then one long hex run with no `;`',
      (n) => [`&#x${'1'.repeat(n - 3)}`, `&#x${'1'.repeat(n - 3)}`],
    ],
    ['`&a` with no `;`', (n) => ['&a'.repeat(n / 2), '&a'.repeat(n / 2)]],
    [
      'one long line ending in a break',
      (n) => [`${'§1 x'.repeat(n / 4)}\ny`, `${'§1 x'.repeat(n / 4)} y`],
    ],
    [
      'line breaks throughout',
      (n) => ['x  \r\n'.repeat(n / 5), Array.from({ length: n / 5 }, () => 'x').join(' ')],
    ],
  ])('scales linearly from 5k to 320k characters of %s', (_label, build) => {
    // Doubling from 5k, each size's title and absolute bound checked before the
    // next runs; the fastest of three readings per size.
    const times: number[] = [];
    for (let n = 5_000; n <= 320_000; n *= 2) {
      const [input, title] = build(n);
      expect(europePmcTitleText(input)).toBe(title);
      const ms = Math.min(
        ...Array.from({ length: 3 }, () => cpuMs(() => europePmcTitleText(input))),
      );
      expect(ms).toBeLessThan(400);
      times.push(ms);
    }
    // Linear work grows 64× across the span; quadratic grows 4096×.
    expect((times.at(-1) ?? 0) / Math.max(times[0] ?? 0, 0.05)).toBeLessThan(256);
  });
});
