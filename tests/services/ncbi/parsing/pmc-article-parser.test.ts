/**
 * @fileoverview Tests for PMC JATS XML article parser. Fixtures reflect the
 * shape produced by fast-xml-parser in `preserveOrder: true` mode (see
 * `pmc-xml-helpers.ts`).
 * @module tests/services/ncbi/parsing/pmc-article-parser.test
 */

import { XMLParser } from 'fast-xml-parser';
import { describe, expect, it } from 'vitest';
import { ORDERED_XML_PARSER_OPTIONS } from '@/services/ncbi/parsing/ordered-xml-parser-options.js';
import {
  extractBodySections,
  extractJatsAuthors,
  extractPmcAssets,
  extractPmcTables,
  extractReferences,
  MAX_TABLE_COLUMNS,
  parsePmcArticle,
} from '@/services/ncbi/parsing/pmc-article-parser.js';
import type { JatsNode } from '@/services/ncbi/parsing/pmc-xml-helpers.js';

/** Build a text node. */
const t = (text: string): JatsNode => ({ '#text': text });
/** Build an element node with the given tag and children. */
const el = (tag: string, children: JatsNode[], attrs?: Record<string, string>): JatsNode =>
  attrs ? { [tag]: children, ':@': attrs } : { [tag]: children };

/**
 * The LaTeX document publishers deposit as a `<tex-math>` body, reproducing the
 * preamble, the tab indentation and the `\begin{document}` wrapper of a real
 * Springer/Nature deposit. Every `<tex-math>` in PMC12855809 carries this shape.
 */
const texDocument = (expression: string): string =>
  '\\documentclass[12pt]{minimal}\n\t\t\t\t\\usepackage{amsmath}\n\t\t\t\t' +
  '\\usepackage{upgreek}\n\t\t\t\t\\setlength{\\oddsidemargin}{-69pt}\n\t\t\t\t' +
  `\\begin{document}${expression}\\end{document}`;

/** `<tex-math>` carrying the full LaTeX document wrapper around `expression`. */
const texMath = (expression: string): JatsNode => el('tex-math', [t(texDocument(expression))]);

describe('extractJatsAuthors', () => {
  it('returns empty for undefined', () => {
    expect(extractJatsAuthors(undefined)).toEqual([]);
  });

  it('extracts named authors', () => {
    const group = el('contrib-group', [
      el('contrib', [el('name', [el('surname', [t('Smith')]), el('given-names', [t('John')])])], {
        '@_contrib-type': 'author',
      }),
      el('contrib', [el('name', [el('surname', [t('Doe')]), el('given-names', [t('Jane')])])], {
        '@_contrib-type': 'author',
      }),
    ]);
    const authors = extractJatsAuthors(group);
    expect(authors).toHaveLength(2);
    expect(authors[0]).toEqual({ lastName: 'Smith', givenNames: 'John' });
  });

  it('extracts collective/group authors', () => {
    const group = el('contrib-group', [
      el('contrib', [el('collab', [t('COVID-19 Study Group')])], { '@_contrib-type': 'author' }),
    ]);
    const authors = extractJatsAuthors(group);
    expect(authors).toHaveLength(1);
    expect(authors[0]?.collectiveName).toBe('COVID-19 Study Group');
  });

  it('skips non-author contributors', () => {
    const group = el('contrib-group', [
      el('contrib', [el('name', [el('surname', [t('Editor')]), el('given-names', [t('A')])])], {
        '@_contrib-type': 'editor',
      }),
      el('contrib', [el('name', [el('surname', [t('Author')]), el('given-names', [t('B')])])], {
        '@_contrib-type': 'author',
      }),
    ]);
    const authors = extractJatsAuthors(group);
    expect(authors).toHaveLength(1);
    expect(authors[0]?.lastName).toBe('Author');
  });

  it('accepts author contributors without contrib-type and skips empty collab names', () => {
    const group = el('contrib-group', [
      el('contrib', [el('collab', [t('   ')])], { '@_contrib-type': 'author' }),
      el('contrib', [el('name', [el('surname', [t('Untyped')])])]),
    ]);

    expect(extractJatsAuthors(group)).toEqual([{ lastName: 'Untyped' }]);
  });
});

describe('extractBodySections', () => {
  it('returns empty for undefined', () => {
    expect(extractBodySections(undefined)).toEqual([]);
  });

  it('extracts paragraphs from body without sections', () => {
    const body = el('body', [el('p', [t('Direct paragraph text.')])]);
    const sections = extractBodySections(body);
    expect(sections).toHaveLength(1);
    expect(sections[0]?.text).toBe('Direct paragraph text.');
  });

  it('extracts titled sections', () => {
    const body = el('body', [
      el('sec', [el('title', [t('Introduction')]), el('p', [t('Intro text.')])]),
      el('sec', [el('title', [t('Methods')]), el('p', [t('Methods text.')])]),
    ]);
    const sections = extractBodySections(body);
    expect(sections).toHaveLength(2);
    expect(sections[0]?.title).toBe('Introduction');
    expect(sections[0]?.text).toBe('Intro text.');
  });

  it('handles nested subsections', () => {
    const body = el('body', [
      el('sec', [
        el('title', [t('Results')]),
        el('p', [t('Overview.')]),
        el('sec', [el('title', [t('Subresult')]), el('p', [t('Detail.')])]),
      ]),
    ]);
    const sections = extractBodySections(body);
    expect(sections[0]?.subsections).toHaveLength(1);
    expect(sections[0]?.subsections?.[0]?.title).toBe('Subresult');
  });

  it('recurses through three or more levels of nested sections (issue #112)', () => {
    // PMC9575052's shape: body/sec[RESULTS]/sec[Case reports]/sec[Patient N],
    // extended one level further to pin that the parser has no depth cap.
    const body = el('body', [
      el('sec', [
        el('title', [t('RESULTS')]),
        el('p', [t('Results overview.')]),
        el('sec', [
          el('title', [t('Case reports of surgical patients')]),
          el('sec', [el('title', [t('Patient 4')]), el('p', [t('Patient 4 narrative.')])]),
          el('sec', [
            el('title', [t('Patient 11')]),
            el('p', [t('Patient 11 narrative.')]),
            el('sec', [el('title', [t('Follow-up')]), el('p', [t('Follow-up narrative.')])]),
          ]),
        ]),
      ]),
    ]);

    const sections = extractBodySections(body);
    const caseReports = sections[0]?.subsections?.[0];
    expect(caseReports?.title).toBe('Case reports of surgical patients');
    expect(caseReports?.text).toBe('');
    expect(caseReports?.subsections?.map((s) => s.title)).toEqual(['Patient 4', 'Patient 11']);
    expect(caseReports?.subsections?.[1]?.subsections?.[0]).toEqual({
      title: 'Follow-up',
      text: 'Follow-up narrative.',
    });
  });

  it('flushes direct paragraphs before and after structured sections', () => {
    const body = el('body', [
      el('p', [t('Opening paragraph.')]),
      el('p', [t('Second opening paragraph.')]),
      el('sec', [el('title', [t('Methods')]), el('p', [t('Methods text.')])]),
      el('p', [t('Trailing paragraph.')]),
    ]);

    const sections = extractBodySections(body);
    expect(sections).toEqual([
      { text: 'Opening paragraph.\n\nSecond opening paragraph.' },
      { title: 'Methods', text: 'Methods text.' },
      { text: 'Trailing paragraph.' },
    ]);
  });

  it('omits empty sections', () => {
    const body = el('body', [
      el('sec', [el('title', [t('Empty')])]),
      el('sec', [el('title', [t('Populated')]), el('p', [t('Text.')])]),
    ]);

    expect(extractBodySections(body)).toEqual([{ title: 'Populated', text: 'Text.' }]);
  });

  it('lifts a table-wrap nested inside a <p> out of the paragraph text (regression #111)', () => {
    // PMC6913007's shape: the whole table — label, caption, every cell — sits
    // inside the paragraph, so textContent() concatenated the grid into the
    // prose and merged adjacent numbers into values that never existed.
    const body = el('body', [
      el('sec', [
        el('title', [t('Benchmarking')]),
        el('p', [
          t('…used as the ground-truth annotation for benchmarking. '),
          el('table-wrap', [
            el('label', [t('Table 1')]),
            el('caption', [el('p', [t('TE content in the rice genome')])]),
            el('table', [
              el('tbody', [
                el('tr', [
                  el('td', [t('LTR')]),
                  el('td', [t('14.44')]),
                  el('td', [t('9.11')]),
                  el('td', [t('23.54')]),
                ]),
              ]),
            ]),
          ]),
        ]),
      ]),
    ]);

    const text = extractBodySections(body)[0]?.text ?? '';
    expect(text).toBe('…used as the ground-truth annotation for benchmarking.');
    expect(text).not.toContain('14.449.1123.54');
    expect(text).not.toContain('Table 1');
  });

  it('keeps a section whose only paragraph wrapped a table as a heading-only entry (regression #111)', () => {
    // PMC13088883 "Appendix A – Good Agricultural Practice": the section's one
    // <p> holds nothing but the <table-wrap>, so lifting the table emptied the
    // paragraph and the empty-section rule then discarded the heading with it.
    const body = el('body', [
      el('sec', [
        el('title', [t('Appendix A – Good Agricultural Practice')]),
        el('p', [
          el('table-wrap', [
            el('label', [t('Table A.1')]),
            el('table', [el('tbody', [el('tr', [el('td', [t('Coffee beans')])])])]),
          ]),
        ]),
      ]),
      el('sec', [el('title', [t('Populated')]), el('p', [t('Text.')])]),
    ]);

    expect(extractBodySections(body)).toEqual([
      { title: 'Appendix A – Good Agricultural Practice', text: '' },
      { title: 'Populated', text: 'Text.' },
    ]);
  });

  it('keeps a section whose only child is a table-wrap as a heading-only entry (regression #111)', () => {
    const body = el('body', [
      el('sec', [
        el('title', [t('Appendix B – Used compound codes')]),
        el('table-wrap', [el('table', [el('tbody', [el('tr', [el('td', [t('code')])])])])]),
      ]),
    ]);

    expect(extractBodySections(body)).toEqual([
      { title: 'Appendix B – Used compound codes', text: '' },
    ]);
  });

  it('still drops a section that only wraps a ref-list (regression #116)', () => {
    // The counterpart to the two cases above: nothing was lifted out of this
    // section, so it never had readable prose and must not survive as an empty
    // "References" heading.
    const body = el('body', [
      el('sec', [
        el('title', [t('References')]),
        el('sec', [el('ref-list', [el('ref', [el('mixed-citation', [t('Alpha 2020.')])])])]),
      ]),
      el('sec', [el('title', [t('Introduction')]), el('p', [t('Intro text.')])]),
    ]);

    expect(extractBodySections(body)).toEqual([{ title: 'Introduction', text: 'Intro text.' }]);
  });

  it('renders a def-list as one entry per def-item, its title lifted onto an untitled <sec> (#130, #169)', () => {
    // PMC12696417's ABBREVIATIONS: a <def-list> is the untitled <sec>'s only
    // child, so reading <p> and <sec> alone dropped the section outright. The
    // list's title is the section's title, the way a body-level list's is.
    const defList = el('def-list', [
      el('title', [t('ABBREVIATIONS')]),
      el('def-item', [el('term', [t('ANOVA')]), el('def', [el('p', [t('analysis of variance')])])]),
      el('def-item', [el('term', [t('SNP')]), el('def', [el('p', [t('single nucleotide')])])]),
    ]);

    expect(extractBodySections(el('body', [el('sec', [defList])]))).toEqual([
      {
        title: 'ABBREVIATIONS',
        text: '- ANOVA — analysis of variance\n- SNP — single nucleotide',
      },
    ]);
    // Under a titled <sec> the list keeps its title as a line of its own.
    expect(
      extractBodySections(el('body', [el('sec', [el('title', [t('Glossary')]), defList])])),
    ).toEqual([
      {
        title: 'Glossary',
        text: 'ABBREVIATIONS\n- ANOVA — analysis of variance\n- SNP — single nucleotide',
      },
    ]);
  });

  it('renders each list type with its own item marker (#130)', () => {
    const body = el('body', [
      el('sec', [
        el('title', [t('Findings')]),
        el('list', [el('list-item', [el('p', [t('Bulleted.')])])], { '@_list-type': 'bullet' }),
        el(
          'list',
          [el('list-item', [el('p', [t('First.')])]), el('list-item', [el('p', [t('Second.')])])],
          { '@_list-type': 'order' },
        ),
        el('list', [el('list-item', [el('p', [t('Bare.')])])], { '@_list-type': 'simple' }),
        el('list', [el('list-item', [el('p', [t('Untyped.')])])]),
      ]),
    ]);

    expect(extractBodySections(body)[0]?.text).toBe(
      '- Bulleted.\n\n1. First.\n2. Second.\n\nBare.\n\n- Untyped.',
    );
  });

  it('renders a list title above its items and drops an empty list (#130)', () => {
    const body = el('body', [
      el('sec', [
        el('title', [t('Findings')]),
        el('p', [t('Prose.')]),
        el('list', [el('title', [t('Key points')]), el('list-item', [el('p', [t('Point.')])])], {
          '@_list-type': 'bullet',
        }),
        el('list', [], { '@_list-type': 'bullet' }),
      ]),
    ]);

    expect(extractBodySections(body)[0]?.text).toBe('Prose.\n\nKey points\n- Point.');
  });

  it('indents a list or def-list nested inside a list-item two spaces per level (#130)', () => {
    // list-item's JATS content model is (label?, title?, (p | def-list | list)+).
    const body = el('body', [
      el('sec', [
        el('title', [t('Protocol')]),
        el(
          'list',
          [
            el('list-item', [
              el('p', [t('Outer step.')]),
              el(
                'list',
                [
                  el('list-item', [
                    el('p', [t('Inner step.')]),
                    el('list', [el('list-item', [el('p', [t('Deepest step.')])])], {
                      '@_list-type': 'bullet',
                    }),
                  ]),
                ],
                { '@_list-type': 'bullet' },
              ),
              el('def-list', [
                el('def-item', [el('term', [t('CV')]), el('def', [el('p', [t('coefficient')])])]),
              ]),
            ]),
          ],
          { '@_list-type': 'bullet' },
        ),
      ]),
    ]);

    expect(extractBodySections(body)[0]?.text).toBe(
      '- Outer step.\n  - Inner step.\n    - Deepest step.\n  - CV — coefficient',
    );
  });

  it('quotes every disp-quote line and trails its attribution (#130)', () => {
    // No record in the 68-record validation draw carried a <disp-quote>, so this
    // is pinned against a fixture built from the JATS content model.
    const body = el('body', [
      el('sec', [
        el('title', [t('Discussion')]),
        el('disp-quote', [
          el('p', [t('First quoted paragraph.')]),
          el('p', [t('Second quoted paragraph.')]),
          el('attrib', [t('Carson, 1962')]),
        ]),
      ]),
    ]);

    expect(extractBodySections(body)[0]?.text).toBe(
      '> First quoted paragraph.\n> Second quoted paragraph.\n> — Carson, 1962',
    );
  });

  it('flattens a boxed-text sec subtree with each heading on its own line (#130)', () => {
    // PMC11726426's shape — the <boxed-text>'s only children are <sec>s, so
    // rendering it as a caption plus paragraphs would drop the nested headings.
    // PMC13528390 nests a bullet <list> in the same position.
    const body = el('body', [
      el('sec', [
        el('title', [t('Introduction')]),
        el('p', [t('Opening prose.')]),
        el('boxed-text', [
          el('sec', [el('title', [t('Core Ideas')]), el('p', [t('Boxed prose.')])]),
          el('sec', [
            el('title', [t('Implications')]),
            el('list', [el('list-item', [el('p', [t('Testing can guide dosing.')])])], {
              '@_list-type': 'bullet',
            }),
          ]),
        ]),
      ]),
    ]);

    // Delimited from the prose around it, with no label or title to name it by (#210).
    expect(extractBodySections(body)[0]?.text).toBe(
      'Opening prose.\n\n[Box]\n\nCore Ideas\nBoxed prose.\n\nImplications\n- Testing can guide dosing.\n\n[End of box]',
    );
  });

  it('returns a preformat-only body as one section, line breaks intact (#130)', () => {
    // PMC9663051 / PMC9663116 / PMC5420876: the whole <body> is one
    // <preformat preformat-type="pmc-ocr-text"> carrying the entire article, so
    // the walk returned sections: [] and the tool layer reported no body at all.
    const body = el('body', [
      el('preformat', [t('\n\t\t\tCME  Infectious diseases - 1\nMalaria: treatment\n\t\t')], {
        '@_preformat-type': 'pmc-ocr-text',
      }),
    ]);

    const sections = extractBodySections(body);
    expect(sections).toHaveLength(1);
    expect(sections[0]?.text).toBe('```\nCME  Infectious diseases - 1\nMalaria: treatment\n```');
    // The double space between "CME" and "Infectious" is OCR column spacing that
    // textContent()'s whitespace collapse would have destroyed.
    expect(sections[0]?.text).toContain('CME  Infectious');
  });

  it('titles a body-level def-list section with the def-list own title (#148)', () => {
    // PMC13546078's <body> opens with its abbreviations <def-list>, before any
    // <sec>. The title used to be rendered as the first line of an untitled
    // section's text, so content[] printed no heading and the list ran on from
    // the abstract above it.
    const body = el('body', [
      el('def-list', [
        el('title', [t('Abbreviations')]),
        el('def-item', [el('term', [t('BS')]), el('def', [el('p', [t('bariatric surgery')])])]),
        el('def-item', [el('term', [t('CV')]), el('def', [el('p', [t('cardiovascular')])])]),
      ]),
      el('sec', [el('title', [t('Introduction')]), el('p', [t('Intro text.')])]),
    ]);

    expect(extractBodySections(body)).toEqual([
      { title: 'Abbreviations', text: '- BS — bariatric surgery\n- CV — cardiovascular' },
      { title: 'Introduction', text: 'Intro text.' },
    ]);
  });

  it('titles body-level list and boxed-text sections the same way (#148)', () => {
    // A <list> carries its title as a direct <title>; a <boxed-text> carries it
    // in <caption><title>, the only place its JATS content model puts one.
    const body = el('body', [
      el('list', [el('title', [t('Key points')]), el('list-item', [el('p', [t('Point one.')])])], {
        '@_list-type': 'bullet',
      }),
      el('boxed-text', [
        el('caption', [el('title', [t('Box 1. Study at a glance')])]),
        el('sec', [el('title', [t('Design')]), el('p', [t('Randomized.')])]),
      ]),
    ]);

    expect(extractBodySections(body)).toEqual([
      { title: 'Key points', text: '- Point one.' },
      { title: 'Box 1. Study at a glance', text: 'Design\nRandomized.' },
    ]);
  });

  it('gives a titled body-level block its own section inside a run of untitled blocks (#148)', () => {
    // Prose on either side of the titled list is not the list's content, so it
    // stays in untitled sections of its own rather than under the list heading.
    const body = el('body', [
      el('p', [t('Opening paragraph.')]),
      el('list', [el('title', [t('Key points')]), el('list-item', [el('p', [t('Point.')])])], {
        '@_list-type': 'bullet',
      }),
      el('p', [t('Closing paragraph.')]),
      el('sec', [el('title', [t('Methods')]), el('p', [t('Methods text.')])]),
    ]);

    expect(extractBodySections(body)).toEqual([
      { text: 'Opening paragraph.' },
      { title: 'Key points', text: '- Point.' },
      { text: 'Closing paragraph.' },
      { title: 'Methods', text: 'Methods text.' },
    ]);
  });

  it('keeps a run of untitled body-level blocks in one untitled section (#148)', () => {
    // Characterization: a block with no title of its own gives the section no
    // title — the tool layer labels it — and a run of them stays together.
    const body = el('body', [
      el('p', [t('Opening paragraph.')]),
      el('list', [el('list-item', [el('p', [t('Untitled point.')])])], {
        '@_list-type': 'bullet',
      }),
      el('boxed-text', [el('sec', [el('title', [t('Core Ideas')]), el('p', [t('Boxed.')])])]),
      el('sec', [el('title', [t('Methods')]), el('p', [t('Methods text.')])]),
    ]);

    // The untitled box stays in the run, delimited from the blocks before it (#210).
    expect(extractBodySections(body)).toEqual([
      {
        text: 'Opening paragraph.\n\n- Untitled point.\n\n[Box]\n\nCore Ideas\nBoxed.\n\n[End of box]',
      },
      { title: 'Methods', text: 'Methods text.' },
    ]);
  });

  it('renders a p-nested disp-formula at block position with its label (#130)', () => {
    // PMC11711298: <disp-formula> sits inside a <p>, so its content ran straight
    // into the sentence around it.
    const body = el('body', [
      el('sec', [
        el('title', [t('Methods')]),
        el('p', [
          t('The model is '),
          el('disp-formula', [
            el('label', [t('(1)')]),
            el('tex-math', [t('y = X\\beta + Zu + e')]),
          ]),
          t(' where u is random.'),
        ]),
      ]),
    ]);

    expect(extractBodySections(body)[0]?.text).toBe(
      'The model is\n\n(1) y = X\\beta + Zu + e\n\nwhere u is random.',
    );
  });

  it('prefers tex-math under alternatives and drops a graphic-only formula (#130)', () => {
    const body = el('body', [
      el('sec', [
        el('title', [t('Methods')]),
        el('disp-formula', [
          el('label', [t('(1)')]),
          el('alternatives', [
            el('graphic', [], { '@_xlink:href': 'eq1.gif' }),
            el('tex-math', [t('E = mc^2')]),
          ]),
        ]),
        el('disp-formula', [
          el('label', [t('(2)')]),
          el('graphic', [], { '@_xlink:href': 'e2.gif' }),
        ]),
        el('p', [t('Trailing prose.')]),
      ]),
    ]);

    // The graphic-only formula contributes nothing at all — not a bare label on
    // an otherwise empty line.
    expect(extractBodySections(body)[0]?.text).toBe('(1) E = mc^2\n\nTrailing prose.');
  });

  it('lifts a p-nested fig out of the sentence and leaves a marker (#130)', () => {
    // PMC12715233: `warranted.Fig. 1Comparison` — a sentence terminator, a figure
    // label and a caption's first word with nothing between them.
    const body = el('body', [
      el('p', [
        t('…suggests that further scrutiny is warranted.'),
        el(
          'fig',
          [
            el('label', [t('Fig. 1')]),
            el('caption', [el('p', [t('Comparison of apparent resistivity and phase data.')])]),
            el('graphic', [], { '@_xlink:href': 'f0001.jpg' }),
          ],
          { '@_id': 'F1' },
        ),
      ]),
    ]);

    const text = extractBodySections(body)[0]?.text ?? '';
    expect(text).toBe('…suggests that further scrutiny is warranted.\n\n[Figure: Fig. 1]');
    expect(text).not.toContain('warranted.Fig. 1Comparison');
    expect(text).not.toContain('Comparison of apparent resistivity');
  });

  it('emits a p-nested list and media at block position, never inside a sentence (#130)', () => {
    const body = el('body', [
      el('sec', [
        el('title', [t('Methods')]),
        el('p', [
          t('Samples were prepared as follows.'),
          el('list', [el('list-item', [el('p', [t('Rinse twice.')])])], {
            '@_list-type': 'bullet',
          }),
          t('Then measured.'),
          el('media', [], { '@_xlink:href': 'movie.mp4' }),
        ]),
      ]),
    ]);

    // <media> carries no text at all, so it contributes nothing — but it still
    // splits the run rather than fusing the text on either side of it.
    expect(extractBodySections(body)[0]?.text).toBe(
      'Samples were prepared as follows.\n\n- Rinse twice.\n\nThen measured.',
    );
  });

  it('keeps a section whose only child is a fig as a heading-only entry (#130)', () => {
    // 16 such sections in the 68-record validation draw. The heading is what
    // places the figure that names it, and a `sections` filter needs it to match.
    const body = el('body', [
      el('sec', [
        el('title', [t('Figure 3 legend')]),
        el('fig', [el('caption', [el('p', [t('Uncaptioned deposit.')])])], { '@_id': 'F3' }),
      ]),
      el('sec', [
        el('title', [t('Supplement')]),
        el('supplementary-material', [el('media', [], { '@_xlink:href': 's1.pdf' })], {
          '@_id': 'S1',
        }),
      ]),
    ]);

    expect(extractBodySections(body)).toEqual([
      { title: 'Figure 3 legend', text: '[Figure]' },
      { title: 'Supplement', text: '[Supplementary]' },
    ]);
  });

  it('interleaves paragraphs, blocks and subsections in document order (#130)', () => {
    const body = el('body', [
      el('sec', [
        el('title', [t('Results')]),
        el('p', [t('Before.')]),
        el('list', [el('list-item', [el('p', [t('Item.')])])], { '@_list-type': 'bullet' }),
        el('p', [t('After.')]),
        el('sec', [el('title', [t('Detail')]), el('p', [t('Nested.')])]),
        el('p', [t('Trailing.')]),
      ]),
    ]);

    expect(extractBodySections(body)).toEqual([
      {
        title: 'Results',
        text: 'Before.\n\n- Item.\n\nAfter.\n\nTrailing.',
        subsections: [{ title: 'Detail', text: 'Nested.' }],
      },
    ]);
  });

  it('reads an <alternatives>-wrapped inline formula inside the sentence holding it (#130)', () => {
    // PMC12816603's shape — <inline-formula><alternatives><tex-math/><mml:math/>
    // </alternatives></inline-formula>, the standard Springer/Nature deposit,
    // here inside a <p>. <alternatives> is a container for equivalent renderings
    // of one object, so it takes the placement of whatever holds it; at this
    // position that is the sentence, not a block of its own. One rendering
    // reaches that sentence — the <tex-math> — rather than every rendering the
    // container carries. (#135)
    const body = el('body', [
      el('sec', [
        el('title', [t('Methods')]),
        el('p', [
          t('Transport stalls once '),
          el(
            'inline-formula',
            [
              el('alternatives', [
                el('tex-math', [t('\\eta_{crit}')]),
                el('mml:math', [t('ηcrit')]),
              ]),
            ],
            { '@_id': 'IEq1' },
          ),
          t(' is exceeded.'),
        ]),
      ]),
    ]);

    const text = extractBodySections(body)[0]?.text ?? '';
    expect(text).toBe('Transport stalls once \\eta_{crit} is exceeded.');
    expect(text).not.toContain('\n\n');
  });

  it('preserves document order across mixed inline content (regression for issue #19)', () => {
    // <p>Our candidates include <italic>NF1</italic> and <italic>MED12</italic>, as well as <italic>NF2</italic>.</p>
    const body = el('body', [
      el('sec', [
        el('title', [t('Results')]),
        el('p', [
          t('Our candidates include '),
          el('italic', [t('NF1')]),
          t(' and '),
          el('italic', [t('MED12')]),
          t(', as well as '),
          el('italic', [t('NF2')]),
          t('.'),
        ]),
      ]),
    ]);
    const sections = extractBodySections(body);
    expect(sections[0]?.text).toBe('Our candidates include NF1 and MED12, as well as NF2.');
  });
});

describe('extractPmcTables', () => {
  /** `<table-wrap>` carrying an XHTML body, matching the PMC11391094 shape. */
  const tableWrap = (id: string, label: string, caption: string, table: JatsNode) =>
    el(
      'table-wrap',
      [
        el('label', [t(label)]),
        el('caption', [el('p', [t(caption)])]),
        table,
        el('table-wrap-foot', [el('fn', [el('p', [t('Data are mean±sd.')])])]),
      ],
      { '@_id': id },
    );

  const xhtmlTable = () =>
    el('table', [
      el('colgroup', [el('col', [])]),
      el('thead', [
        el('tr', [
          el('th', [t('')]),
          el('th', [t('Benralizumab (n=23)')]),
          el('th', [t('Placebo (n=23)')]),
        ]),
      ]),
      el('tbody', [
        el('tr', [
          el('td', [t('Age, years')]),
          el('td', [t('30.4±12.3')]),
          el('td', [t('31.5±13.3')]),
        ]),
        // PMC11391094's group-label row: one <td colspan="3">, which occupies
        // all three grid columns rather than only the first.
        el('tr', [el('td', [t('Race')], { '@_colspan': '3' })]),
      ]),
    ]);

  it('returns empty for undefined', () => {
    expect(extractPmcTables(undefined)).toEqual([]);
  });

  it('extracts a table-wrap sitting beside <p> inside a <sec> (regression #111)', () => {
    const article = el('article', [
      el('body', [
        el('sec', [
          el('title', [t('Results')]),
          el('p', [t('Baseline characteristics are shown.')]),
          tableWrap('TB1', 'TABLE 1', 'Demographic and baseline characteristics', xhtmlTable()),
        ]),
      ]),
    ]);

    expect(extractPmcTables(article)).toEqual([
      {
        id: 'TB1',
        label: 'TABLE 1',
        caption: 'Demographic and baseline characteristics',
        sectionTitle: 'Results',
        headerRowCount: 1,
        rows: [
          ['', 'Benralizumab (n=23)', 'Placebo (n=23)'],
          ['Age, years', '30.4±12.3', '31.5±13.3'],
          ['Race', 'Race', 'Race'],
        ],
        footnotes: 'Data are mean±sd.',
      },
    ]);
  });

  it('names the innermost enclosing <sec> at any depth (regression #111)', () => {
    const article = el('article', [
      el('body', [
        el('sec', [
          el('title', [t('Results')]),
          el('sec', [
            el('title', [t('Biomarkers')]),
            el('sec', [
              el('title', [t('Sputum')]),
              tableWrap('TB3', 'TABLE 3', 'Allergen-induced biomarkers', xhtmlTable()),
            ]),
          ]),
        ]),
      ]),
    ]);

    expect(extractPmcTables(article)[0]?.sectionTitle).toBe('Sputum');
  });

  it('walks the whole <article>, not just <body>, in document order (regression #111)', () => {
    const article = el('article', [
      el('body', [
        el('sec', [
          el('title', [t('Results')]),
          tableWrap('TB1', 'TABLE 1', 'In body', xhtmlTable()),
        ]),
      ]),
      el('floats-group', [tableWrap('TB2', 'TABLE 2', 'In floats-group', xhtmlTable())]),
      el('back', [
        el('sec', [
          el('title', [t('Appendix A')]),
          el('table-wrap-group', [
            tableWrap('TB3', 'TABLE 3', 'In table-wrap-group', xhtmlTable()),
          ]),
        ]),
        el('app-group', [el('app', [tableWrap('TB4', 'TABLE 4', 'In app-group', xhtmlTable())])]),
      ]),
    ]);

    const tables = extractPmcTables(article);
    expect(tables.map((tb) => tb.id)).toEqual(['TB1', 'TB2', 'TB3', 'TB4']);
    expect(tables.map((tb) => tb.sectionTitle)).toEqual([
      'Results',
      undefined,
      'Appendix A',
      undefined,
    ]);
    for (const tb of tables) expect(tb.rows).toHaveLength(3);
  });

  it('reads an XHTML table wrapped in <alternatives> beside a graphic (regression #111)', () => {
    const article = el('article', [
      el('body', [
        el('sec', [
          el(
            'table-wrap',
            [
              el('label', [t('Table 1')]),
              el('alternatives', [el('graphic', [], { '@_href': 't1.jpg' }), xhtmlTable()]),
            ],
            { '@_id': 'T1' },
          ),
        ]),
      ]),
    ]);

    const table = extractPmcTables(article)[0];
    expect(table?.rows).toHaveLength(3);
    expect(table?.unextractableReason).toBeUndefined();
  });

  it('marks a graphic-only deposit unextractable but keeps its label and caption (regression #111)', () => {
    const article = el('article', [
      el('body', [
        el('sec', [
          el('title', [t('Results')]),
          el(
            'table-wrap',
            [
              el('label', [t('Table 1')]),
              el('caption', [el('p', [t('Scanned table')])]),
              el('graphic', [], { '@_href': 'tbl1.jpg' }),
              el('table-wrap-foot', [el('p', [t('Source: authors.')])]),
            ],
            { '@_id': 'T1' },
          ),
        ]),
      ]),
    ]);

    expect(extractPmcTables(article)).toEqual([
      {
        id: 'T1',
        label: 'Table 1',
        caption: 'Scanned table',
        sectionTitle: 'Results',
        headerRowCount: 0,
        rows: [],
        footnotes: 'Source: authors.',
        unextractableReason: 'graphic-only',
      },
    ]);
  });

  it('takes the unextractable path for a CALS tgroup body (regression #111)', () => {
    // Deliberate: 0 of 283 surveyed tables used the CALS model, so the XHTML
    // extractor covers the corpus and CALS is disclosed rather than parsed.
    const article = el('article', [
      el('body', [
        el('sec', [
          el(
            'table-wrap',
            [
              el('label', [t('Table 1')]),
              el('tgroup', [el('tbody', [el('row', [el('entry', [t('cell')])])])], {
                '@_cols': '1',
              }),
            ],
            { '@_id': 'T1' },
          ),
        ]),
      ]),
    ]);

    const table = extractPmcTables(article)[0];
    expect(table?.rows).toEqual([]);
    expect(table?.unextractableReason).toBe('cals-tgroup');
  });

  it('counts a leading all-<th> row as a header when there is no <thead> (regression #111)', () => {
    const article = el('article', [
      el('body', [
        el('sec', [
          el(
            'table-wrap',
            [
              el('table', [
                el('tr', [el('th', [t('Gene')]), el('th', [t('Count')])]),
                el('tr', [el('td', [t('NF1')]), el('td', [t('12')])]),
              ]),
            ],
            { '@_id': 'T1' },
          ),
        ]),
      ]),
    ]);

    const table = extractPmcTables(article)[0];
    expect(table?.headerRowCount).toBe(1);
    expect(table?.rows).toEqual([
      ['Gene', 'Count'],
      ['NF1', '12'],
    ]);
  });

  /** Wrap a bare `<table>` in the minimum `<article>` the walker needs. */
  const articleWithTable = (table: JatsNode): JatsNode =>
    el('article', [el('body', [el('sec', [el('table-wrap', [table], { '@_id': 'T1' })])])]);

  it('expands a colspan cell across every column it covers (regression #111)', () => {
    const table = extractPmcTables(
      articleWithTable(
        el('table', [
          el('thead', [
            el('tr', [
              el('th', [t('')]),
              el('th', [t('Benralizumab')], { '@_colspan': '3' }),
              el('th', [t('Placebo')], { '@_colspan': '3' }),
            ]),
          ]),
          el('tbody', [
            el('tr', [
              el('td', [t('Blood eosinophils')]),
              el('td', [t('268.4±183.6')]),
              el('td', [t('10.0±23.7')]),
              el('td', [t('7.8±16.5')]),
              el('td', [t('241.7±141.8')]),
              el('td', [t('232.6±147.9')]),
              el('td', [t('251.3±152.2')]),
            ]),
          ]),
        ]),
      ),
    )[0];

    // Every row is one entry per grid column, so `Placebo` sits over the three
    // columns it heads instead of over column 3 alone.
    expect(table?.rows).toEqual([
      ['', 'Benralizumab', 'Benralizumab', 'Benralizumab', 'Placebo', 'Placebo', 'Placebo'],
      [
        'Blood eosinophils',
        '268.4±183.6',
        '10.0±23.7',
        '7.8±16.5',
        '241.7±141.8',
        '232.6±147.9',
        '251.3±152.2',
      ],
    ]);
  });

  it('carries a rowspan cell down the rows it covers (regression #111)', () => {
    const table = extractPmcTables(
      articleWithTable(
        el('table', [
          el('tbody', [
            el('tr', [
              el('td', [t('Cohort A')], { '@_rowspan': '3' }),
              el('td', [t('Week 0')]),
              el('td', [t('1.1')]),
            ]),
            el('tr', [el('td', [t('Week 4')]), el('td', [t('2.2')])]),
            el('tr', [el('td', [t('Week 9')]), el('td', [t('3.3')])]),
            el('tr', [el('td', [t('Cohort B')]), el('td', [t('Week 0')]), el('td', [t('4.4')])]),
          ]),
        ]),
      ),
    )[0];

    expect(table?.rows).toEqual([
      ['Cohort A', 'Week 0', '1.1'],
      ['Cohort A', 'Week 4', '2.2'],
      ['Cohort A', 'Week 9', '3.3'],
      ['Cohort B', 'Week 0', '4.4'],
    ]);
  });

  it('aligns two header rows against each other when the first spans (regression #111)', () => {
    // PMC11391094 TABLE 2: a rowspan="2" stub column beside two colspan="3"
    // group headers, with the per-column labels on the second header row.
    const table = extractPmcTables(
      articleWithTable(
        el('table', [
          el('thead', [
            el('tr', [
              el('th', [t('')], { '@_rowspan': '2' }),
              el('th', [t('Benralizumab')], { '@_colspan': '3' }),
              el('th', [t('Placebo')], { '@_colspan': '3' }),
            ]),
            el('tr', [
              el('th', [t('Baseline')]),
              el('th', [t('Week 4')]),
              el('th', [t('Week 9')]),
              el('th', [t('Baseline')]),
              el('th', [t('Week 4')]),
              el('th', [t('Week 9')]),
            ]),
          ]),
          el('tbody', [
            el('tr', [
              el('td', [t('Blood eosinophils')]),
              el('td', [t('268.4±183.6')]),
              el('td', [t('a')]),
              el('td', [t('b')]),
              el('td', [t('c')]),
              el('td', [t('d')]),
              el('td', [t('e')]),
            ]),
          ]),
        ]),
      ),
    )[0];

    expect(table?.headerRowCount).toBe(2);
    expect(table?.rows.map((r) => r.length)).toEqual([7, 7, 7]);
    // The second header row is offset by the first row's rowspan stub, so
    // `Baseline` lands under `Benralizumab` rather than in the label column.
    expect(table?.rows[1]).toEqual([
      '',
      'Baseline',
      'Week 4',
      'Week 9',
      'Baseline',
      'Week 4',
      'Week 9',
    ]);
  });

  it('caps an absurd declared span instead of allocating for it (regression #111)', () => {
    const table = extractPmcTables(
      articleWithTable(
        el('table', [
          el('tbody', [
            el('tr', [el('td', [t('boom')], { '@_colspan': '99999999' })]),
            el('tr', [el('td', [t('after')])]),
          ]),
        ]),
      ),
    )[0];

    expect(table?.rows[0]).toHaveLength(MAX_TABLE_COLUMNS);
    expect(table?.rows[0]?.every((cell) => cell === 'boom')).toBe(true);
    expect(table?.rows[1]).toEqual(['after']);
  });

  it('ignores a non-numeric or zero span rather than dropping the cell (regression #111)', () => {
    const table = extractPmcTables(
      articleWithTable(
        el('table', [
          el('tbody', [
            el('tr', [
              el('td', [t('a')], { '@_colspan': '0' }),
              el('td', [t('b')], { '@_colspan': 'wide' }),
              el('td', [t('c')], { '@_rowspan': '-4' }),
            ]),
          ]),
        ]),
      ),
    )[0];

    expect(table?.rows).toEqual([['a', 'b', 'c']]);
  });

  it('names the enclosing back-matter section of a table outside the body (regression #111)', () => {
    // 64 of 283 surveyed tables sit at `back/sec`. The section name is the
    // reader's only positional cue there, so it is reported, not withheld.
    const article = el('article', [
      el('back', [
        el('sec', [
          el('title', [t('Appendix A – Good Agricultural Practice')]),
          tableWrap('TB9', 'TABLE A.1', 'Authorised uses', xhtmlTable()),
        ]),
      ]),
    ]);

    expect(extractPmcTables(article)[0]?.sectionTitle).toBe(
      'Appendix A – Good Agricultural Practice',
    );
  });

  it('extracts a <p>-nested table exactly once, with its cells out of the prose (regression #111)', () => {
    const article = el('article', [
      el('body', [
        el('sec', [
          el('title', [t('Benchmarking')]),
          el('p', [
            t('Annotation results follow. '),
            el(
              'table-wrap',
              [
                el('label', [t('Table 1')]),
                el('table', [
                  el('tbody', [
                    el('tr', [el('td', [t('LTR')]), el('td', [t('14.44')]), el('td', [t('9.11')])]),
                  ]),
                ]),
              ],
              { '@_id': 'T1' },
            ),
          ]),
        ]),
      ]),
    ]);

    const tables = extractPmcTables(article);
    expect(tables).toHaveLength(1);
    expect(tables[0]?.rows).toEqual([['LTR', '14.44', '9.11']]);

    const article2 = parsePmcArticle(article);
    expect(article2.sections[0]?.text).toBe('Annotation results follow.');
    expect(JSON.stringify(article2.sections)).not.toContain('14.44');
  });

  it('separates a table caption title from the paragraphs under it (regression #111)', () => {
    // <caption> children carry no punctuation between them, so the concatenating
    // read ran the title's last word into the first paragraph's first word.
    const article = el('article', [
      el('body', [
        el('sec', [
          el('title', [t('Results')]),
          el(
            'table-wrap',
            [
              el('label', [t('Table 1')]),
              el('caption', [
                el('title', [t('Baseline characteristics')]),
                el('p', [t('Values are mean (SD).')]),
                el('p', [t('Missing entries are left blank.')]),
              ]),
              el('table', [el('tbody', [el('tr', [el('td', [t('Age, years')])])])]),
            ],
            { '@_id': 'T1' },
          ),
        ]),
      ]),
    ]);

    expect(extractPmcTables(article)[0]?.caption).toBe(
      'Baseline characteristics Values are mean (SD). Missing entries are left blank.',
    );
  });

  it('omits tables entirely from an article that has none (regression #111)', () => {
    const article = el('article', [
      el('body', [el('sec', [el('title', [t('Results')]), el('p', [t('No tables here.')])])]),
    ]);

    expect(extractPmcTables(article)).toEqual([]);
    expect('tables' in parsePmcArticle(article)).toBe(false);
  });
});

describe('extractPmcAssets', () => {
  /** `<fig>` in the shape every one of 258 in the validation draw carries. */
  const fig = (id: string, label: string, caption: string, href: string) =>
    el(
      'fig',
      [
        el('label', [t(label)]),
        el('caption', [el('p', [t(caption)])]),
        el('graphic', [], { '@_xlink:href': href }),
      ],
      { '@_id': id },
    );

  it('returns empty for undefined', () => {
    expect(extractPmcAssets(undefined)).toEqual([]);
  });

  it('returns a sec-hung figure with every field it deposits (#130)', () => {
    const article = el('article', [
      el('body', [
        el('sec', [
          el('title', [t('Results')]),
          el('p', [t('Resistivity rose.')]),
          fig('F1', 'Figure 1.', 'Apparent resistivity by interval.', 'g001.jpg'),
        ]),
      ]),
    ]);

    expect(extractPmcAssets(article)).toEqual([
      {
        assetType: 'figure',
        id: 'F1',
        label: 'Figure 1.',
        caption: 'Apparent resistivity by interval.',
        sectionTitle: 'Results',
        href: 'g001.jpg',
      },
    ]);
  });

  it('reads a one-paragraph caption with its inline markup in place (#111)', () => {
    // Characterization. Inline markup inside a caption paragraph is transparent
    // and must stay so: splitting at every child boundary would read
    // `Expression of NF1 across 12 tissues.` back as three spaced fragments.
    const article = el('article', [
      el('body', [
        el('sec', [
          el('title', [t('Results')]),
          el(
            'fig',
            [
              el('label', [t('Fig. 1')]),
              el('caption', [
                el('p', [t('Expression of '), el('italic', [t('NF1')]), t(' across 12 tissues.')]),
              ]),
            ],
            { '@_id': 'F1' },
          ),
        ]),
      ]),
    ]);

    expect(extractPmcAssets(article)[0]?.caption).toBe('Expression of NF1 across 12 tissues.');
  });

  it('walks the whole article in document order and inherits section titles (#130)', () => {
    // 17% of figures and 23% of supplementary material sit outside <body>: a
    // <floats-group> deposit (PMC10827061's eight figures), back matter, and the
    // abstract in <front>. An untitled <sec> keeps its parent's title.
    const article = el('article', [
      el('front', [
        el('article-meta', [
          el('abstract', [fig('FA', 'Graphical abstract', 'Overview.', 'ga.jpg')]),
        ]),
      ]),
      el('body', [
        el('sec', [
          el('title', [t('Results')]),
          el('sec', [fig('F1', 'Figure 1.', 'In an untitled subsection.', 'g001.jpg')]),
        ]),
      ]),
      el('floats-group', [fig('F2', 'Figure 2.', 'In floats-group.', 'g002.jpg')]),
      el('back', [
        el('sec', [
          el('title', [t('Appendix A')]),
          el('p', [
            el(
              'supplementary-material',
              [
                el('label', [t('Table S3')]),
                el('caption', [el('p', [t('Raw measurements.')])]),
                el('media', [], { '@_xlink:href': 's003.xlsx' }),
              ],
              { '@_id': 'S3' },
            ),
          ]),
        ]),
      ]),
    ]);

    expect(extractPmcAssets(article)).toEqual([
      {
        assetType: 'figure',
        id: 'FA',
        label: 'Graphical abstract',
        caption: 'Overview.',
        href: 'ga.jpg',
      },
      {
        assetType: 'figure',
        id: 'F1',
        label: 'Figure 1.',
        caption: 'In an untitled subsection.',
        sectionTitle: 'Results',
        href: 'g001.jpg',
      },
      {
        assetType: 'figure',
        id: 'F2',
        label: 'Figure 2.',
        caption: 'In floats-group.',
        href: 'g002.jpg',
      },
      {
        assetType: 'supplementary-material',
        id: 'S3',
        label: 'Table S3',
        caption: 'Raw measurements.',
        sectionTitle: 'Appendix A',
        href: 's003.xlsx',
      },
    ]);
  });

  it('returns an unlabelled or pointerless asset rather than dropping it (#130)', () => {
    // PMC13155148's two supplements carry a caption and a <media> but no <label>;
    // 14 of 84 in the draw carry no pointer at all.
    const article = el('article', [
      el('body', [
        el('sec', [
          el('title', [t('Data availability')]),
          el(
            'supplementary-material',
            [
              el('caption', [el('p', [t('Fig. S1. Vector map.')])]),
              el('media', [], { '@_xlink:href': 'MOL2-20-1253-s002.pdf' }),
            ],
            { '@_id': 'mol270153-supitem-0001' },
          ),
          el('supplementary-material', [], { '@_id': 'bare' }),
          el('fig', [el('caption', [el('p', [t('Caption but no label.')])])]),
        ]),
      ]),
    ]);

    expect(extractPmcAssets(article)).toEqual([
      {
        assetType: 'supplementary-material',
        id: 'mol270153-supitem-0001',
        caption: 'Fig. S1. Vector map.',
        sectionTitle: 'Data availability',
        href: 'MOL2-20-1253-s002.pdf',
      },
      { assetType: 'supplementary-material', id: 'bare', sectionTitle: 'Data availability' },
      {
        assetType: 'figure',
        caption: 'Caption but no label.',
        sectionTitle: 'Data availability',
      },
    ]);
  });

  it('reads a label and caption the deposit hangs on the pointer element (#130)', () => {
    // JATS puts `label?, caption?` in the content model of <media> and <graphic>
    // as well as of <supplementary-material>, and a common deposit style uses it:
    // 19 of the 68-record draw's supplementary items carry their caption there and
    // nothing on the element itself. Reading only direct children returns an asset
    // with an id and an href and no text at all.
    const article = el('article', [
      el('body', [
        el('sec', [
          el('title', [t('Supplementary information')]),
          el(
            'supplementary-material',
            [
              el(
                'media',
                [
                  el('label', [t('Supplementary Information')]),
                  el('caption', [el('p', [t('Supplementary Note, Figs. 1–24 and Tables 1–3.')])]),
                ],
                { '@_xlink:href': '41551_2025_1498_MOESM1_ESM.pdf' },
              ),
            ],
            { '@_id': 'MOESM1' },
          ),
        ]),
      ]),
    ]);

    expect(extractPmcAssets(article)).toEqual([
      {
        assetType: 'supplementary-material',
        id: 'MOESM1',
        label: 'Supplementary Information',
        caption: 'Supplementary Note, Figs. 1–24 and Tables 1–3.',
        sectionTitle: 'Supplementary information',
        href: '41551_2025_1498_MOESM1_ESM.pdf',
      },
    ]);
  });

  it('names the in-text marker with the label the pointer carries (#130)', () => {
    // The tool layer removes a marker by rebuilding it from `assets[].label`, so
    // the marker the parser leaves has to resolve the label the same way the
    // asset record does. A deposit that hangs its label on the <media> used to
    // yield a bare `[Supplementary]` beside an asset labelled `Data S1`, and the
    // marker survived `includeAssets: false` in the section text.
    const body = el('body', [
      el('sec', [
        el('title', [t('Supplementary information')]),
        el(
          'supplementary-material',
          [
            el(
              'media',
              [el('label', [t('Data S1')]), el('caption', [el('p', [t('Raw measurements.')])])],
              { '@_xlink:href': 's001.xlsx' },
            ),
          ],
          { '@_id': 'sup1' },
        ),
      ]),
    ]);

    const asset = extractPmcAssets(el('article', [body]))[0];
    expect(asset?.label).toBe('Data S1');
    expect(extractBodySections(body)[0]?.text).toBe(`[Supplementary: ${asset?.label}]`);
  });

  it('prefers the asset element own label and caption over the pointer own (#130)', () => {
    const article = el('article', [
      el('body', [
        el('sec', [
          el('title', [t('Results')]),
          el(
            'fig',
            [
              el('label', [t('Fig. 1')]),
              el('caption', [el('p', [t('The figure caption.')])]),
              el('graphic', [el('caption', [el('p', [t('The graphic caption.')])])], {
                '@_xlink:href': 'g001.jpg',
              }),
            ],
            { '@_id': 'F1' },
          ),
        ]),
      ]),
    ]);

    expect(extractPmcAssets(article)[0]).toEqual({
      assetType: 'figure',
      id: 'F1',
      label: 'Fig. 1',
      caption: 'The figure caption.',
      sectionTitle: 'Results',
      href: 'g001.jpg',
    });
  });

  it('separates an asset caption title from the paragraphs under it (#111, #130)', () => {
    // PMC12816603 Fig. 1 reads `…observational constraints6.Cloud susceptibilities…`
    // today — a caption title's trailing citation superscript, then its first
    // paragraph's first word, with nothing between them. 60 of 342 asset
    // captions in a 68-record draw carry the defect.
    const article = el('article', [
      el('body', [
        el('sec', [
          el('title', [t('Results')]),
          el(
            'fig',
            [
              el('label', [t('Fig. 1')]),
              el('caption', [
                el('title', [t('Cloud susceptibilities from observational constraints')]),
                el('p', [t('Susceptibilities are shown for each regime.')]),
                el('p', [t('Shading marks the interquartile range.')]),
              ]),
              el('graphic', [], { '@_xlink:href': 'g001.jpg' }),
            ],
            { '@_id': 'F1' },
          ),
        ]),
      ]),
    ]);

    expect(extractPmcAssets(article)[0]?.caption).toBe(
      'Cloud susceptibilities from observational constraints Susceptibilities are shown for each regime. Shading marks the interquartile range.',
    );
  });

  it('omits assets entirely from an article that has none (#130)', () => {
    // PMC12753918 and PMC12696417 carry no <fig> and no <supplementary-material>.
    // An empty array would read as "this article has no assets", which the absent
    // field already says.
    const article = el('article', [
      el('body', [el('sec', [el('title', [t('Results')]), el('p', [t('No figures here.')])])]),
    ]);

    expect(extractPmcAssets(article)).toEqual([]);
    expect('assets' in parsePmcArticle(article)).toBe(false);
  });

  it('lifts a p-nested figure exactly once, out of the prose and into assets[] (#130)', () => {
    const article = el('article', [
      el('body', [
        el('p', [
          t('…suggests that further scrutiny is warranted.'),
          fig('F1', 'Fig. 1', 'Comparison of apparent resistivity and phase data.', 'f0001.jpg'),
        ]),
      ]),
    ]);

    const parsed = parsePmcArticle(article);
    expect(parsed.assets).toHaveLength(1);
    expect(parsed.assets?.[0]?.caption).toBe('Comparison of apparent resistivity and phase data.');
    // A <p>-nested figure has no enclosing <sec>, so it names no section.
    expect(parsed.assets?.[0]?.sectionTitle).toBeUndefined();
    const sections = JSON.stringify(parsed.sections);
    expect(sections).not.toContain('warranted.Fig. 1Comparison');
    expect(sections).not.toContain('Comparison of apparent resistivity');
    expect(sections).toContain('[Figure: Fig. 1]');
  });

  describe('a pointer wrapped in <alternatives> (#142)', () => {
    /**
     * No figure of this shape turned up in a ~2,000-figure live sample, so these
     * cases are pinned against fixtures built from the JATS content model and
     * JATS4R's display-object recommendation, not against a live PMCID.
     */
    const graphic = (href: string, attrs: Record<string, string> = {}, children: JatsNode[] = []) =>
      el('graphic', children, { '@_xlink:href': href, ...attrs });

    /** An article whose one section holds a single `<fig id="Fig1">` with these children. */
    const articleWithFig = (...children: JatsNode[]) =>
      el('article', [
        el('body', [
          el('sec', [el('title', [t('Results')]), el('fig', children, { '@_id': 'Fig1' })]),
        ]),
      ]);

    it('takes the first pointer in document order when none is marked for the web', () => {
      const article = articleWithFig(
        el('label', [t('Figure 1')]),
        el('caption', [el('p', [t('Study design.')])]),
        el('alternatives', [
          graphic('fig1.tif', { '@_mimetype': 'image', '@_mime-subtype': 'tiff' }),
          graphic('fig1.jpg', { '@_mimetype': 'image', '@_mime-subtype': 'jpeg' }),
        ]),
      );

      expect(extractPmcAssets(article)).toEqual([
        {
          assetType: 'figure',
          id: 'Fig1',
          label: 'Figure 1',
          caption: 'Study design.',
          sectionTitle: 'Results',
          href: 'fig1.tif',
        },
      ]);
    });

    it('prefers the pointer whose specific-use names the web over a print one before it', () => {
      const article = articleWithFig(
        el('label', [t('Figure 1')]),
        el('alternatives', [
          graphic('fig1-print.tif', { '@_specific-use': 'print' }),
          graphic('fig1-web.jpg', { '@_specific-use': 'web' }),
        ]),
      );

      expect(extractPmcAssets(article)[0]?.href).toBe('fig1-web.jpg');
    });

    it('matches a specific-use value that contains web, on a <media> as well as a <graphic>', () => {
      const article = articleWithFig(
        el('label', [t('Movie 1')]),
        el('alternatives', [
          el('media', [], { '@_xlink:href': 'movie1.mov', '@_specific-use': 'print-only' }),
          el('media', [], { '@_xlink:href': 'movie1.mp4', '@_specific-use': 'Web-Version' }),
        ]),
      );

      expect(extractPmcAssets(article)[0]?.href).toBe('movie1.mp4');
    });

    it('reads a label and caption hung on the wrapped pointer and names the marker with it', () => {
      // `label?, caption?` are in the content model of <graphic>; a label hung
      // there rather than on the <fig> must reach both the asset and the marker
      // the tool layer rebuilds from it.
      const article = articleWithFig(
        el('alternatives', [
          graphic('fig2.jpg', { '@_specific-use': 'web' }, [
            el('label', [t('Figure 2')]),
            el('caption', [el('p', [t('Enrollment flow.')])]),
          ]),
          graphic('fig2.tif', { '@_specific-use': 'print' }),
        ]),
      );

      expect(extractPmcAssets(article)).toEqual([
        {
          assetType: 'figure',
          id: 'Fig1',
          label: 'Figure 2',
          caption: 'Enrollment flow.',
          sectionTitle: 'Results',
          href: 'fig2.jpg',
        },
      ]);
      expect(parsePmcArticle(article).sections[0]?.text).toBe('[Figure: Figure 2]');
    });

    it('keeps a direct pointer ahead of any under <alternatives>', () => {
      // Characterization: the direct child resolves first, <graphic> before
      // <media>, exactly as before the <alternatives> fallback existed.
      const direct = articleWithFig(
        el('label', [t('Figure 1')]),
        graphic('direct.jpg'),
        el('alternatives', [graphic('wrapped.jpg', { '@_specific-use': 'web' })]),
      );
      const directMedia = articleWithFig(
        el('media', [], { '@_xlink:href': 'direct.mp4' }),
        el('alternatives', [graphic('wrapped.jpg', { '@_specific-use': 'web' })]),
      );

      expect(extractPmcAssets(direct)[0]?.href).toBe('direct.jpg');
      expect(extractPmcAssets(directMedia)[0]?.href).toBe('direct.mp4');
    });

    it('reports no href when neither the figure nor its <alternatives> holds a pointer', () => {
      // Characterization: an <alternatives> of renderings that name no file
      // still leaves the figure without an href — nothing is fabricated.
      const article = articleWithFig(
        el('label', [t('Figure 3')]),
        el('caption', [el('p', [t('Schematic.')])]),
        el('alternatives', [texMath('x^2'), el('textual-form', [t('A parabola.')])]),
      );

      expect(extractPmcAssets(article)).toEqual([
        {
          assetType: 'figure',
          id: 'Fig1',
          label: 'Figure 3',
          caption: 'Schematic.',
          sectionTitle: 'Results',
        },
      ]);
    });
  });
});

describe('extractReferences', () => {
  it('returns empty for undefined', () => {
    expect(extractReferences(undefined)).toEqual([]);
  });

  it('extracts mixed-citation references', () => {
    const back = el('back', [
      el('ref-list', [
        el(
          'ref',
          [el('label', [t('1')]), el('mixed-citation', [t('Smith J et al. Nature 2024.')])],
          { '@_id': 'ref1' },
        ),
      ]),
    ]);
    const refs = extractReferences(back);
    expect(refs).toHaveLength(1);
    expect(refs[0]?.id).toBe('ref1');
    expect(refs[0]?.label).toBe('1');
    expect(refs[0]?.citation).toContain('Smith J');
  });

  it('falls back to element-citation', () => {
    const back = el('back', [
      el('ref-list', [el('ref', [el('element-citation', [t('Citation text here.')])])]),
    ]);
    const refs = extractReferences(back);
    expect(refs).toHaveLength(1);
    expect(refs[0]?.citation).toBe('Citation text here.');
  });

  it('skips references without citation text', () => {
    const back = el('back', [
      el('ref-list', [
        el('ref', [el('label', [t('1')])]),
        el('ref', [el('mixed-citation', [t('   ')])]),
      ]),
    ]);

    expect(extractReferences(back)).toEqual([]);
  });

  it('extracts references wrapped in citation-alternatives, preferring mixed-citation (regression #66)', () => {
    // <ref id="CR15"><citation-alternatives><element-citation/><mixed-citation/></citation-alternatives></ref>
    // — the AlphaFold (PMC8371605) shape that previously dropped 64 of 84 refs.
    const back = el('back', [
      el('ref-list', [
        el(
          'ref',
          [
            el('label', [t('15')]),
            el('citation-alternatives', [
              el('element-citation', [t('Structured citation form.')]),
              el('mixed-citation', [t('Jumper J, et al. Nature. 2021;596:583-9.')]),
            ]),
          ],
          { '@_id': 'CR15' },
        ),
        // a direct mixed-citation ref still works alongside wrapped ones
        el('ref', [el('mixed-citation', [t('Direct ref. Science. 2020.')])], { '@_id': 'CR16' }),
      ]),
    ]);
    const refs = extractReferences(back);
    expect(refs).toHaveLength(2);
    expect(refs[0]?.id).toBe('CR15');
    expect(refs[0]?.label).toBe('15');
    // prefers the readable mixed-citation form inside citation-alternatives
    expect(refs[0]?.citation).toBe('Jumper J, et al. Nature. 2021;596:583-9.');
    expect(refs[1]?.id).toBe('CR16');
    expect(refs[1]?.citation).toBe('Direct ref. Science. 2020.');
  });

  it('falls back to element-citation inside citation-alternatives when no mixed form exists', () => {
    const back = el('back', [
      el('ref-list', [
        el('ref', [el('citation-alternatives', [el('element-citation', [t('Element only.')])])], {
          '@_id': 'CR1',
        }),
      ]),
    ]);
    const refs = extractReferences(back);
    expect(refs).toHaveLength(1);
    expect(refs[0]?.citation).toBe('Element only.');
  });

  it('renders structured element-citation fields with separators, pages verbatim (regression #69)', () => {
    // PMC12973387 (Elsevier deposit) ships <element-citation> only. Its child
    // elements carry no punctuation, so the old flat textContent() ran every
    // field together (DomanJ.L.…editorsCell18618…) and <lpage>4002.e26</lpage>
    // coerced upstream to 4.002e+29. Authors must separate, fields must space,
    // typed pub-ids must label, page tokens must survive verbatim.
    const back = el('back', [
      el('ref-list', [
        el(
          'ref',
          [
            el('label', [t('2')]),
            el('element-citation', [
              el(
                'person-group',
                [
                  el('name', [el('surname', [t('Doman')]), el('given-names', [t('J.L.')])]),
                  el('name', [el('surname', [t('Pandey')]), el('given-names', [t('S.')])]),
                ],
                { '@_person-group-type': 'author' },
              ),
              el('article-title', [t('Phage-assisted evolution yields compact prime editors')]),
              el('source', [t('Cell')]),
              el('volume', [t('186')]),
              el('issue', [t('18')]),
              el('year', [t('2023')]),
              el('fpage', [t('3983')]),
              el('lpage', [t('4002.e26')]),
              el('pub-id', [t('37657419')], { '@_pub-id-type': 'pmid' }),
              el('pub-id', [t('10.1016/j.cell.2023.07.039')], { '@_pub-id-type': 'doi' }),
              el('pub-id', [t('PMC10482982')], { '@_pub-id-type': 'pmcid' }),
            ]),
          ],
          { '@_id': 'bib2' },
        ),
      ]),
    ]);

    const refs = extractReferences(back);
    expect(refs).toHaveLength(1);
    expect(refs[0]?.id).toBe('bib2');
    // Volume(issue) and the page range read as they print (#209), page tokens verbatim.
    expect(refs[0]?.citation).toBe(
      'Doman J.L., Pandey S. Phage-assisted evolution yields compact prime editors Cell 186(18) 2023 3983–4002.e26 PMID 37657419 DOI 10.1016/j.cell.2023.07.039 PMCID PMC10482982',
    );
    // Acceptance invariants from the issue:
    expect(refs[0]?.citation).not.toMatch(/e\+\d+/); // no scientific-notation page
    expect(refs[0]?.citation).not.toContain('DomanJ.L.'); // authors not run together
  });

  /** Wrap `children` as the sole `<mixed-citation>` of a single `<ref>`. */
  function mixedRef(children: JatsNode[], id = 'R1'): JatsNode {
    return el('back', [
      el('ref-list', [el('ref', [el('mixed-citation', children)], { '@_id': id })]),
    ]);
  }

  it('separates and labels two adjacent zero-gap pub-ids (regression #115)', () => {
    // PMC11391094 ref C37: `doi:<pub-id doi/><pub-id pmid/>` — the literal
    // `doi:` prefix must not be double-labeled, and the PMID must not fuse onto
    // the DOI.
    const refs = extractReferences(
      mixedRef(
        [
          el('source', [t('Clin Exp Allergy')]),
          t(' 2020; 50: 1267–1269. doi:'),
          el('pub-id', [t('10.1111/cea.13720')], { '@_pub-id-type': 'doi' }),
          el('pub-id', [t('32762056')], { '@_pub-id-type': 'pmid' }),
          t('\n'),
        ],
        'C37',
      ),
    );

    expect(refs[0]?.citation).toBe(
      'Clin Exp Allergy 2020; 50: 1267–1269. doi:10.1111/cea.13720 PMID 32762056',
    );
    expect(refs[0]?.citation).not.toContain('1372032762056');
  });

  it('separates and labels three adjacent zero-gap pub-ids (regression #115)', () => {
    // PMC8371605 ref CR1: DOI + PMCID + PMID run together with zero-length gaps.
    const refs = extractReferences(
      mixedRef(
        [
          t('Thompson, M. C. Advances in methods. '),
          el('italic', [t('F1000Res')], { '@_toggle': 'yes' }),
          t('. '),
          el('bold', [t('9')]),
          t(', 667 (2020).'),
          el('pub-id', [t('10.12688/f1000research.25097.1')], { '@_pub-id-type': 'doi' }),
          el('pub-id', [t('PMC7333361')], { '@_pub-id-type': 'pmcid' }),
          el('pub-id', [t('32676184')], { '@_pub-id-type': 'pmid' }),
        ],
        'CR1',
      ),
    );

    expect(refs[0]?.citation).toBe(
      'Thompson, M. C. Advances in methods. F1000Res. 9, 667 (2020). DOI 10.12688/f1000research.25097.1 PMCID PMC7333361 PMID 32676184',
    );
    expect(refs[0]?.citation).not.toContain('25097.1PMC733336132676184');
  });

  it('separates an inserted label from the prose it follows (regression #115)', () => {
    // Cochrane style: the DOI carries a literal `[DOI: ` prefix and the PMID
    // follows the closing bracket with no gap. The prefixed id keeps its own
    // spacing byte-for-byte; the label this renderer inserts gets separated from
    // the `]` so it does not read as one token.
    const refs = extractReferences(
      mixedRef([
        el('source', [t('Journal of Pediatrics')]),
        el('year', [t('2011')]),
        t(':'),
        el('fpage', [t('119')]),
        t('. [DOI: '),
        el('pub-id', [t('10.1016/j.jpeds.2010.07.021')], { '@_pub-id-type': 'doi' }),
        t(']'),
        el('pub-id', [t('20850761')], { '@_pub-id-type': 'pmid' }),
      ]),
    );

    expect(refs[0]?.citation).toBe(
      'Journal of Pediatrics 2011:119. [DOI: 10.1016/j.jpeds.2010.07.021] PMID 20850761',
    );
  });

  it('collapses a whitespace-only gap between pub-ids to one space (regression #115)', () => {
    const refs = extractReferences(
      mixedRef([
        t('Ref. '),
        el('pub-id', [t('31235882')], { '@_pub-id-type': 'pmid' }),
        t('\n'),
        el('pub-id', [t('10.1038/s41592-019-0437-4')], { '@_pub-id-type': 'doi' }),
      ]),
    );

    expect(refs[0]?.citation).toBe('Ref. PMID 31235882 DOI 10.1038/s41592-019-0437-4');
  });

  it('spaces a zero-gap italic title against a bold volume (regression #123)', () => {
    // PMC8371605 ref CR7: `<italic>Nat. Methods</italic><bold>16</bold>, …`.
    const refs = extractReferences(
      mixedRef(
        [
          t('Steinegger, M. Protein-level assembly. '),
          el('italic', [t('Nat. Methods')], { '@_toggle': 'yes' }),
          el('bold', [t('16')]),
          t(', 603–606 (2019).'),
          el('pub-id', [t('31235882')], { '@_pub-id-type': 'pmid' }),
        ],
        'CR7',
      ),
    );

    expect(refs[0]?.citation).toBe(
      'Steinegger, M. Protein-level assembly. Nat. Methods 16, 603–606 (2019). PMID 31235882',
    );
    expect(refs[0]?.citation).not.toContain('Nat. Methods16');
  });

  it('separates a zero-gap surname and given-names inside a bare <name> (regression #124)', () => {
    // PMC7250045 ref R1: `<name><surname>Nybakken</surname><given-names>JW</given-names></name>`
    // is a direct child of the mixed-citation, with zero characters between the
    // two parts. All 1150 <name> authors in that record share the shape.
    const refs = extractReferences(
      mixedRef([
        el('name', [el('surname', [t('Nybakken')]), el('given-names', [t('JW')])], {
          '@_name-style': 'western',
        }),
        t('\n'),
        el('source', [t('Marine Biology: An Ecological Approach')]),
        t(', '),
        el('edition', [t('4th ed.')]),
        t('; '),
        el('publisher-name', [t('Addison-Wessley Publishing')]),
        t(': '),
        el('publisher-loc', [t('Boston, MA')]),
        t(', '),
        el('year', [t('2001')]),
        t('.'),
      ]),
    );

    expect(refs[0]?.citation).toBe(
      'Nybakken JW Marine Biology: An Ecological Approach, 4th ed.; Addison-Wessley Publishing: Boston, MA, 2001.',
    );
    expect(refs[0]?.citation).not.toContain('NybakkenJW');
  });

  /**
   * PMC11391094 ref C37's author block. `separator` is the text node the source
   * carries between `<surname>` and `<given-names>` — a newline live, and empty
   * in the constructed zero-gap variant. Either way the rendered citation must
   * come out identical.
   */
  function personGroupRef(separator: string): JatsNode {
    const stringName = (surname: string, given: string) =>
      el(
        'string-name',
        separator
          ? [el('surname', [t(surname)]), t(separator), el('given-names', [t(given)])]
          : [el('surname', [t(surname)]), el('given-names', [t(given)])],
        { '@_name-style': 'western' },
      );

    return mixedRef(
      [
        el(
          'person-group',
          [
            stringName('Lommatzsch', 'M'),
            t(', '),
            stringName('Marchewski', 'H'),
            t(', '),
            stringName('Schwefel', 'G'),
            t(', '),
            el('etal', [t('et al.')]),
          ],
          { '@_person-group-type': 'author' },
        ),
        t('\n'),
        el('article-title', [
          t('Benralizumab strongly reduces blood basophils in severe eosinophilic asthma'),
        ]),
        t('. '),
        el('source', [t('Clin Exp Allergy')]),
        t(' 2020; 50: 1267–1269. doi:'),
        el('pub-id', [t('10.1111/cea.13720')], { '@_pub-id-type': 'doi' }),
        el('pub-id', [t('32762056')], { '@_pub-id-type': 'pmid' }),
        t('\n'),
      ],
      'C37',
    );
  }

  const C37_CITATION =
    'Lommatzsch M, Marchewski H, Schwefel G, et al. Benralizumab strongly reduces blood basophils in severe eosinophilic asthma. Clin Exp Allergy 2020; 50: 1267–1269. doi:10.1111/cea.13720 PMID 32762056';

  it('separates a zero-gap <string-name> nested in a <person-group> (regression #124)', () => {
    const refs = extractReferences(personGroupRef(''));
    expect(refs[0]?.citation).toBe(C37_CITATION);
    expect(refs[0]?.citation).not.toContain('LommatzschM');
  });

  it('leaves a <person-group> whose name parts carry source whitespace unchanged (regression #124)', () => {
    const refs = extractReferences(personGroupRef('\n'));
    expect(refs[0]?.citation).toBe(C37_CITATION);
  });

  it('leaves punctuated and text-adjacent transitions unchanged (regression #115)', () => {
    // Elements already separated by punctuation must render byte-identical, and
    // a zero-gap text→element transition (a footnote-style marker) must not gain
    // a space.
    const refs = extractReferences(
      mixedRef([
        el('string-name', [el('surname', [t('Lommatzsch')]), t(' '), el('given-names', [t('M')])]),
        t(', '),
        el('etal', [t('et al.')]),
        t(' '),
        el('article-title', [t('Benralizumab reduces basophils')]),
        t('. '),
        el('source', [t('Clin Exp Allergy')]),
        t('; '),
        el('volume', [t('50')]),
        t(': '),
        el('fpage', [t('1267')]),
        t('–'),
        el('lpage', [t('1269')]),
        t('.'),
        el('sup', [t('a')]),
      ]),
    );

    expect(refs[0]?.citation).toBe(
      'Lommatzsch M, et al. Benralizumab reduces basophils. Clin Exp Allergy; 50: 1267–1269.a',
    );
  });

  it('finds a ref-list nested at any depth, not just as a direct <back> child (regression #116)', () => {
    // PMC12973387's shape: no <back> at all — the list sits at
    // body/sec[References]/sec/ref-list.
    const article = el('article', [
      el('body', [
        el('sec', [el('title', [t('Introduction')]), el('p', [t('Intro text.')])]),
        el('sec', [
          el('title', [t('References')]),
          el('sec', [
            el('ref-list', [
              el('ref', [el('label', [t('1.')]), el('element-citation', [t('First reference.')])], {
                '@_id': 'bib1',
              }),
              el(
                'ref',
                [el('label', [t('2.')]), el('element-citation', [t('Second reference.')])],
                { '@_id': 'bib2' },
              ),
            ]),
          ]),
        ]),
      ]),
    ]);

    expect(extractReferences(article).map((r) => r.label)).toEqual(['1.', '2.']);
  });

  it('descends through a matched ref-list into a nested one (regression #116)', () => {
    const article = el('article', [
      el('back', [
        el('ref-list', [
          el('title', [t('References')]),
          el('ref', [el('mixed-citation', [t('Outer ref.')])], { '@_id': 'OUT1' }),
          el('ref-list', [
            el('title', [t('Further reading')]),
            el('ref', [el('mixed-citation', [t('Inner ref.')])], { '@_id': 'IN1' }),
          ]),
        ]),
      ]),
    ]);

    expect(extractReferences(article).map((r) => r.id)).toEqual(['OUT1', 'IN1']);
  });

  it('yields each reference once when <back> and <body> both carry a ref-list (regression #116)', () => {
    // Synthetic — not observed live, but the JATS DTD permits both containers.
    const ref = (id: string, citation: string) =>
      el('ref', [el('mixed-citation', [t(citation)])], { '@_id': id });
    const article = el('article', [
      el('body', [
        el('sec', [
          el('title', [t('Discussion')]),
          el('p', [t('Body text.')]),
          el('sec', [el('ref-list', [ref('R1', 'Alpha 2020.'), ref('R2', 'Beta 2021.')])]),
        ]),
      ]),
      el('back', [el('ref-list', [ref('R1', 'Alpha 2020.'), ref('R3', 'Gamma 2022.')])]),
    ]);

    const refs = extractReferences(article);
    expect(refs.map((r) => r.id)).toEqual(['R1', 'R2', 'R3']);
  });

  it('renders element-citation collab + etal author forms (regression #69)', () => {
    const back = el('back', [
      el('ref-list', [
        el(
          'ref',
          [
            el('element-citation', [
              el(
                'person-group',
                [el('collab', [t('The ENCODE Project Consortium')]), el('etal', [])],
                { '@_person-group-type': 'author' },
              ),
              el('source', [t('Nature')]),
              el('year', [t('2012')]),
            ]),
          ],
          { '@_id': 'bib9' },
        ),
      ]),
    ]);
    const refs = extractReferences(back);
    expect(refs[0]?.citation).toBe('The ENCODE Project Consortium, et al. Nature 2012');
  });
});

describe('parsePmcArticle', () => {
  it('parses a minimal JATS article', () => {
    const article = el(
      'article',
      [
        el('front', [
          el('article-meta', [
            el('article-id', [t('PMC1234567')], { '@_pub-id-type': 'pmcid' }),
            el('article-id', [t('12345')], { '@_pub-id-type': 'pmid' }),
            el('article-id', [t('10.1000/test')], { '@_pub-id-type': 'doi' }),
            el('title-group', [el('article-title', [t('Test Article Title')])]),
            el('contrib-group', [
              el(
                'contrib',
                [el('name', [el('surname', [t('Smith')]), el('given-names', [t('J')])])],
                { '@_contrib-type': 'author' },
              ),
            ]),
          ]),
        ]),
        el('body', [
          el('sec', [el('title', [t('Introduction')]), el('p', [t('Body text here.')])]),
        ]),
      ],
      { '@_article-type': 'research-article' },
    );

    const result = parsePmcArticle(article);
    expect(result.pmcId).toBe('PMC1234567');
    expect(result.pmid).toBe('12345');
    expect(result.doi).toBe('10.1000/test');
    expect(result.title).toBe('Test Article Title');
    expect(result.authors).toHaveLength(1);
    expect(result.sections).toHaveLength(1);
    expect(result.articleType).toBe('research-article');
    expect(result.pmcUrl).toContain('PMC1234567');
    expect(result.pubmedUrl).toContain('12345');
  });

  it('normalizes PMCID without PMC prefix', () => {
    const article = el('article', [
      el('front', [
        el('article-meta', [el('article-id', [t('1234567')], { '@_pub-id-type': 'pmc-uid' })]),
      ]),
    ]);
    const result = parsePmcArticle(article);
    expect(result.pmcId).toBe('PMC1234567');
  });

  it('keeps mixed-content abstracts readable (regression for issue #19)', () => {
    // <abstract><p>Candidates include <italic>NF1</italic> and <italic>MED12</italic>, as well as <italic>NF2</italic>, <italic>CUL3</italic>.</p></abstract>
    const article = el('article', [
      el('front', [
        el('article-meta', [
          el('article-id', [t('PMC4089965')], { '@_pub-id-type': 'pmcid' }),
          el('abstract', [
            el('p', [
              t('Candidates include '),
              el('italic', [t('NF1')]),
              t(' and '),
              el('italic', [t('MED12')]),
              t(', as well as '),
              el('italic', [t('NF2')]),
              t(', '),
              el('italic', [t('CUL3')]),
              t('.'),
            ]),
          ]),
        ]),
      ]),
    ]);
    const result = parsePmcArticle(article);
    expect(result.abstract).toBe('Candidates include NF1 and MED12, as well as NF2, CUL3.');
  });

  it('joins abstract sections as "Title: text" blocks and paragraphs with one space (#134)', () => {
    // Characterization. This is the shape every record with one untyped
    // abstract already returns, and the selection rule must not disturb it:
    // sibling paragraphs inside a section separate by a single space, sections
    // by a blank line, and a section without a title contributes its prose bare.
    const article = el('article', [
      el('front', [
        el('article-meta', [
          el('article-id', [t('PMC900')], { '@_pub-id-type': 'pmcid' }),
          el('abstract', [
            el('sec', [
              el('title', [t('Background')]),
              el('p', [t('First paragraph.')]),
              el('p', [t('Second paragraph.')]),
            ]),
            el('sec', [el('p', [t('Untitled section prose.')])]),
          ]),
        ]),
      ]),
    ]);

    expect(parsePmcArticle(article).abstract).toBe(
      'Background: First paragraph. Second paragraph.\n\nUntitled section prose.',
    );
  });

  it('falls back to print publication dates and direct abstract text', () => {
    const article = el('article', [
      el('front', [
        el('article-meta', [
          el('article-id', [t('PMC100')], { '@_pub-id-type': 'pmcid' }),
          el('pub-date', [el('year', [t('2022')]), el('month', [t('11')]), el('day', [t('05')])], {
            '@_pub-type': 'ppub',
          }),
          el('abstract', [t('Plain abstract text.')]),
        ]),
      ]),
    ]);

    const result = parsePmcArticle(article);
    expect(result.publicationDate).toEqual({ year: '2022', month: '11', day: '05' });
    expect(result.abstract).toBe('Plain abstract text.');
  });

  it('prefers the untyped <abstract> over typed ones serialized before it (#134)', () => {
    // PMC13131449 and PMC13539245 deposit `graphical`, `author-highlights` and
    // the untyped abstract in that order, so reading the first one returned the
    // graphical abstract's 18-character title as the article's abstract and the
    // real one never reached the response.
    const article = el('article', [
      el('front', [
        el('article-meta', [
          el('article-id', [t('PMC13131449')], { '@_pub-id-type': 'pmcid' }),
          el(
            'abstract',
            [
              el('title', [t('Graphical abstract')]),
              el('fig', [el('graphic', [], { '@_xlink:href': 'ga.jpg' })], { '@_id': 'ga' }),
            ],
            { '@_abstract-type': 'graphical' },
          ),
          el('abstract', [el('p', [t('Highlight one.')])], {
            '@_abstract-type': 'author-highlights',
          }),
          el('abstract', [el('p', [t('The article’s own abstract.')])]),
        ]),
      ]),
    ]);

    expect(parsePmcArticle(article).abstract).toBe('The article’s own abstract.');
  });

  it('falls back to the first <abstract> when the record deposits no untyped one (#134)', () => {
    const article = el('article', [
      el('front', [
        el('article-meta', [
          el('article-id', [t('PMC901')], { '@_pub-id-type': 'pmcid' }),
          el('abstract', [el('p', [t('Executive summary prose.')])], {
            '@_abstract-type': 'executive-summary',
          }),
          el('abstract', [el('p', [t('Short form.')])], { '@_abstract-type': 'short' }),
        ]),
      ]),
    ]);

    expect(parsePmcArticle(article).abstract).toBe('Executive summary prose.');
  });

  it('lifts a <fig> and renders a <list> inside the chosen abstract (#134)', () => {
    // PMC13316352's graphical abstract reaches the output today through a
    // <p><fig><caption>, so the abstract arrives as a 453-character figure
    // caption. Inside the selected element the body walk's rule applies: the
    // caption belongs to assets[], and the figure leaves its marker behind.
    const article = el('article', [
      el('front', [
        el('article-meta', [
          el('article-id', [t('PMC13316352')], { '@_pub-id-type': 'pmcid' }),
          el('abstract', [
            el('p', [
              t('Attachment is promoted by stress fibers.'),
              el(
                'fig',
                [
                  el('label', [t('Fig. 7')]),
                  el('caption', [el('p', [t('STK11 facilitates influenza A virus attachment.')])]),
                ],
                { '@_id': 'fx1' },
              ),
            ]),
            el('list', [el('list-item', [el('p', [t('Sialic acid clusters stay disordered.')])])], {
              '@_list-type': 'bullet',
            }),
          ]),
        ]),
      ]),
    ]);

    // The list reads on lines of its own, set apart by a blank line as in a
    // body section, rather than running onto the figure marker. (#202)
    const parsed = parsePmcArticle(article);
    expect(parsed.abstract).toBe(
      'Attachment is promoted by stress fibers.\n\n[Figure: Fig. 7]\n\n- Sialic acid clusters stay disordered.',
    );
    expect(parsed.abstract).not.toContain('STK11 facilitates');
    expect(parsed.assets?.[0]?.caption).toBe('STK11 facilitates influenza A virus attachment.');
  });

  it('surfaces body-nested references without disturbing sections[] (regression #116)', () => {
    // PMC12973387 via Europe PMC: no <back>, the ref-list sits under a
    // "References" <sec> that carries no prose of its own.
    const article = el('article', [
      el('front', [
        el('article-meta', [el('article-id', [t('PMC12973387')], { '@_pub-id-type': 'pmcid' })]),
      ]),
      el('body', [
        el('sec', [el('title', [t('Introduction')]), el('p', [t('Intro text.')])]),
        el('sec', [el('title', [t('Methods')]), el('p', [t('Methods text.')])]),
        el('sec', [
          el('title', [t('References')]),
          el('sec', [
            el('ref-list', [
              el('ref', [el('label', [t('1.')]), el('mixed-citation', [t('Alpha 2020.')])], {
                '@_id': 'bib1',
              }),
            ]),
          ]),
        ]),
      ]),
    ]);

    const result = parsePmcArticle(article);
    expect(result.references).toEqual([{ id: 'bib1', label: '1.', citation: 'Alpha 2020.' }]);
    // The References wrapper has no prose, so it must not leak in as an empty
    // section, and the surrounding sections keep document order.
    expect(result.sections.map((s) => s.title)).toEqual(['Introduction', 'Methods']);
  });

  it('parses rich JATS metadata without fabricating missing fields', () => {
    const article = el(
      'article',
      [
        el('front', [
          el('journal-meta', [
            el('journal-title-group', [el('journal-title', [t('Journal of Tests')])]),
            el('issn', [t('1234-5678')]),
          ]),
          el('article-meta', [
            el('article-id', [t('PMC7654321')], { '@_pub-id-type': 'pmcid' }),
            el('article-id', [t('7654321')], { '@_pub-id-type': 'pmid' }),
            el('title-group', [el('article-title', [t('Structured Article')])]),
            el('contrib-group', [
              el('contrib', [el('name', [el('surname', [t('Smith')])])], {
                '@_contrib-type': 'author',
              }),
            ]),
            el('aff', [t('Department of Testing')]),
            el('pub-date', [el('year', [t('2020')])], { '@_pub-type': 'ppub' }),
            el('pub-date', [el('year', [t('2021')]), el('month', [t('03')])], {
              '@_pub-type': 'epub',
            }),
            el('volume', [t('12')]),
            el('issue', [t('2')]),
            el('fpage', [t('10')]),
            el('lpage', [t('12')]),
            el('abstract', [
              el('sec', [el('title', [t('Background')]), el('p', [t('Why it matters.')])]),
              el('sec', [el('p', [t('Unlabeled abstract text.')])]),
            ]),
            el('kwd-group', [el('kwd', [t('PubMed')]), el('kwd', [t('Testing')])]),
          ]),
        ]),
        el('body', [el('p', [t('Opening body.')])]),
        el('back', [
          el('ref-list', [
            el('ref', [el('mixed-citation', [t('Reference text.')])], { '@_id': 'R1' }),
          ]),
        ]),
      ],
      { '@_article-type': 'review-article' },
    );

    const result = parsePmcArticle(article);

    expect(result).toMatchObject({
      pmcId: 'PMC7654321',
      pmid: '7654321',
      title: 'Structured Article',
      affiliations: ['Department of Testing'],
      journal: {
        title: 'Journal of Tests',
        issn: '1234-5678',
        volume: '12',
        issue: '2',
        pages: '10-12',
      },
      publicationDate: { year: '2021', month: '03' },
      abstract: 'Background: Why it matters.\n\nUnlabeled abstract text.',
      keywords: ['PubMed', 'Testing'],
      sections: [{ text: 'Opening body.' }],
      references: [{ id: 'R1', citation: 'Reference text.' }],
      articleType: 'review-article',
    });
    expect(result.doi).toBeUndefined();
  });

  it('surfaces <elocation-id> for an article-meta with no <fpage>', () => {
    // Shape of a real PMC deposit (The Plant Genome 18(1), e20542): article
    // number only, no page range — roughly half of PMC full-text records.
    const article = el('article', [
      el('front', [
        el('journal-meta', [
          el('journal-title-group', [el('journal-title', [t('The Plant Genome')])]),
        ]),
        el('article-meta', [
          el('article-id', [t('PMC11711121')], { '@_pub-id-type': 'pmcid' }),
          el('title-group', [el('article-title', [t('Article Number Only')])]),
          el('volume', [t('18')]),
          el('issue', [t('1')]),
          el('elocation-id', [t('e20542')]),
        ]),
      ]),
      el('body', [el('p', [t('Opening body.')])]),
    ]);

    const result = parsePmcArticle(article);
    expect(result.journal).toMatchObject({
      title: 'The Plant Genome',
      volume: '18',
      issue: '1',
      elocationId: 'e20542',
    });
    expect(result.journal?.pages).toBeUndefined();
  });

  it('carries both when an article-meta has <fpage> and <elocation-id>', () => {
    const article = el('article', [
      el('front', [
        el('journal-meta', [el('journal-title-group', [el('journal-title', [t('PLoS One')])])]),
        el('article-meta', [
          el('volume', [t('19')]),
          el('fpage', [t('e0300123')]),
          el('elocation-id', [t('e0300123')]),
        ]),
      ]),
      el('body', [el('p', [t('Opening body.')])]),
    ]);

    const result = parsePmcArticle(article);
    expect(result.journal?.pages).toBe('e0300123');
    expect(result.journal?.elocationId).toBe('e0300123');
  });
});

// ─── LaTeX preambles and <alternatives> duplication (#135) ───────────────────

describe('tex-math preamble and alternatives duplication (#135)', () => {
  /** Text a `<p>` contributes when it sits alone in a titled section. */
  const paragraphText = (children: JatsNode[]): string =>
    extractBodySections(
      el('body', [el('sec', [el('title', [t('Methods')]), el('p', children)])]),
    )[0]?.text ?? '';

  it('renders a bare <inline-formula><tex-math> in place without the preamble', () => {
    // PMC12855809's dominant shape: 310 bare inline formulae, every one carrying
    // the \documentclass preamble, no <alternatives> and no <mml:math>.
    const text = paragraphText([
      t('Operations run over '),
      el('inline-formula', [texMath('$$\\mathbb {F}_q$$')], { '@_id': 'IEq1' }),
      t(' throughout.'),
    ]);

    expect(text).toBe('Operations run over $$\\mathbb {F}_q$$ throughout.');
    expect(text).not.toContain('\\documentclass');
    expect(text).not.toContain('\\usepackage');
    expect(text).not.toContain('\\begin{document}');
  });

  it('renders an <alternatives>-wrapped inline formula once, without the preamble', () => {
    const text = paragraphText([
      t('Reducing threshold RH '),
      el(
        'inline-formula',
        [el('alternatives', [texMath('$$\\eta_{crit}$$'), el('mml:math', [t('ηcrit')])])],
        { '@_id': 'IEq1' },
      ),
      t(' by 0.8.'),
    ]);

    expect(text).toBe('Reducing threshold RH $$\\eta_{crit}$$ by 0.8.');
    expect(text).not.toContain('ηcrit');
    expect(text).not.toContain('\\documentclass');
  });

  it('reaches a formula nested inside <italic> inside a <p>', () => {
    const text = paragraphText([
      t('The bound '),
      el('italic', [
        el('inline-formula', [
          el('alternatives', [texMath('$$\\eta$$'), el('mml:math', [t('η')])]),
        ]),
      ]),
      t(' holds.'),
    ]);

    expect(text).toBe('The bound $$\\eta$$ holds.');
  });

  it('renders a <disp-formula> at block position without the preamble', () => {
    const body = el('body', [
      el('sec', [
        el('title', [t('Model')]),
        el('p', [t('We define the delay as')]),
        el('disp-formula', [el('label', [t('1')]), texMath('$$D = a - b$$')], { '@_id': 'Equ1' }),
        el('p', [t('where a is arrival.')]),
      ]),
    ]);

    const text = extractBodySections(body)[0]?.text ?? '';
    expect(text).toBe('We define the delay as\n\n1 $$D = a - b$$\n\nwhere a is arrival.');
    expect(text).not.toContain('\\documentclass');
  });

  it('renders a <disp-formula> whose <tex-math> sits under <alternatives>', () => {
    const body = el('body', [
      el('sec', [
        el('title', [t('Model')]),
        el('disp-formula', [
          el('label', [t('2')]),
          el('alternatives', [texMath('$$E = mc^2$$'), el('mml:math', [t('E=mc2')])]),
        ]),
      ]),
    ]);

    expect(extractBodySections(body)[0]?.text).toBe('2 $$E = mc^2$$');
  });

  it('renders a <disp-formula> whose rendering sits beside a pointer carrying alt text', () => {
    // renderDispFormula excludes <graphic> from its fallback text, so choosing
    // the pointer leaves the formula with no body and it drops out entirely,
    // label and all.
    const body = el('body', [
      el('sec', [
        el('title', [t('Model')]),
        el('p', [t('Before.')]),
        el('disp-formula', [
          el('label', [t('3')]),
          el('alternatives', [
            el('graphic', [el('alt-text', [t('equ3.gif')])], { '@_xlink:href': 'equ3.gif' }),
            el('mml:math', [t('η')]),
          ]),
        ]),
        el('p', [t('After.')]),
      ]),
    ]);

    expect(extractBodySections(body)[0]?.text).toBe('Before.\n\n3 η\n\nAfter.');
  });

  it('renders the MathML beside a <tex-math> carrying no expression', () => {
    const text = paragraphText([
      t('Threshold '),
      el('inline-formula', [
        el('alternatives', [el('tex-math', []), el('mml:math', [t('ηcrit')])]),
      ]),
      t(' applies.'),
    ]);

    expect(text).toBe('Threshold ηcrit applies.');
  });

  it('keeps block placement for a <disp-formula> under <alternatives> in a nested <sec>', () => {
    const body = el('body', [
      el('sec', [
        el('title', [t('Results')]),
        el('sec', [
          el('title', [t('Derivation')]),
          el('p', [t('Before.')]),
          el('alternatives', [el('disp-formula', [texMath('$$x = y$$')])]),
          el('p', [t('After.')]),
        ]),
      ]),
    ]);

    const subsection = extractBodySections(body)[0]?.subsections?.[0];
    expect(subsection?.text).toBe('Before.\n\n$$x = y$$\n\nAfter.');
  });

  it('strips the preamble from an <alternatives> inside a <td> inside a nested <table-wrap>', () => {
    // PMC12816603's only <alternatives> sits in a table cell, so the defect
    // reaches tables[].rows as well as sections[].text.
    const tableWrap = el(
      'table-wrap',
      [
        el('label', [t('Table 1')]),
        el('table', [
          el('tbody', [
            el('tr', [
              el('td', [t('REF-S2')]),
              el('td', [
                t('Reducing threshold RH '),
                el('inline-formula', [
                  el('alternatives', [texMath('$$\\eta_{crit}$$'), el('mml:math', [t('ηcrit')])]),
                ]),
                t(' over the ocean'),
              ]),
            ]),
          ]),
        ]),
      ],
      { '@_id': 'Tab1' },
    );

    const body = el('body', [el('sec', [el('title', [t('Setup')]), el('p', [tableWrap])])]);
    const article = el('article', [body]);

    const tables = extractPmcTables(article);
    expect(tables[0]?.rows).toEqual([
      ['REF-S2', 'Reducing threshold RH $$\\eta_{crit}$$ over the ocean'],
    ]);
    expect(JSON.stringify(tables)).not.toContain('documentclass');
    // The table's text is carried by tables[], never duplicated into the prose.
    expect(extractBodySections(body)[0]?.text).toBe('');
  });

  it('leaves a record with no <tex-math> and no <alternatives> untouched', () => {
    const body = el('body', [
      el('sec', [
        el('title', [t('Results')]),
        el('p', [t('Our candidates include '), el('italic', [t('NF1')]), t('.')]),
      ]),
    ]);

    expect(extractBodySections(body)).toEqual([
      { title: 'Results', text: 'Our candidates include NF1.' },
    ]);
  });

  it('carries no LaTeX preamble anywhere in a parsed article (#135)', () => {
    const article = el('article', [
      el('front', [
        el('journal-meta', [el('journal-title-group', [el('journal-title', [t('Sci Rep')])])]),
        el('article-meta', [
          el('article-id', [t('12855809')], { '@_pub-id-type': 'pmcid' }),
          el('title-group', [el('article-title', [t('Threshold transport')])]),
          el('abstract', [
            el('p', [t('We bound '), el('inline-formula', [texMath('$$Q$$')]), t(' from below.')]),
          ]),
        ]),
      ]),
      el('body', [
        el('sec', [
          el('title', [t('Methods')]),
          el('p', [
            t('Operations run over '),
            el('inline-formula', [texMath('$$\\mathbb {F}_q$$')]),
            t('.'),
          ]),
          el('disp-formula', [el('label', [t('1')]), texMath('$$D = a - b$$')]),
          el(
            'table-wrap',
            [
              el('caption', [
                el('p', [t('Symbols used in '), el('inline-formula', [texMath('$$Q$$')])]),
              ]),
              el('table', [
                el('tbody', [
                  el('tr', [
                    el('td', [el('inline-formula', [texMath('$$r_i$$')])]),
                    el('td', [t('rounds')]),
                  ]),
                ]),
              ]),
            ],
            { '@_id': 'Tab1' },
          ),
        ]),
      ]),
    ]);

    const parsed = parsePmcArticle(article);
    const serialized = JSON.stringify(parsed);

    for (const marker of ['documentclass', 'usepackage', 'begin{document}']) {
      expect(serialized).not.toContain(marker);
    }
    expect(parsed.abstract).toBe('We bound $$Q$$ from below.');
    expect(parsed.sections[0]?.text).toBe(
      'Operations run over $$\\mathbb {F}_q$$.\n\n1 $$D = a - b$$',
    );
    expect(parsed.tables?.[0]?.rows).toEqual([['$$r_i$$', 'rounds']]);
    expect(parsed.tables?.[0]?.caption).toBe('Symbols used in $$Q$$');
    // One rendering per formula: the expression appears exactly once per site.
    expect(parsed.sections[0]?.text.match(/\$\$/g)).toHaveLength(4);
  });
});

// ─── Structural boundaries (#185), affiliations (#196), citation runs (#197) ───

/** Parse a JATS fragment with the server's ordered parser options. */
const jatsArticle = (xml: string): JatsNode => {
  const parsed = new XMLParser(ORDERED_XML_PARSER_OPTIONS).parse(xml) as JatsNode[];
  const article = parsed.find((node) => 'article' in node);
  if (!article) throw new Error('fixture has no <article>');
  return article;
};

/** An `<article>` around the given `<article-meta>` children and `<body>` content. */
const articleXml = (meta: string, body = '') =>
  `<article><front><article-meta><article-id pub-id-type="pmcid">PMC1</article-id>${meta}</article-meta></front><body>${body}</body></article>`;

describe('structural boundaries in tables and prose (#185)', () => {
  /** PMC10164684's three tables, reduced to the cells and footnotes under test. */
  const PMC10164684 = jatsArticle(
    articleXml(
      '',
      '<sec><title>Results</title>' +
        '<table-wrap id="T1"><label>Table 1</label><table><thead><tr><th>Characteristic</th></tr></thead><tbody><tr><td>Age</td></tr></tbody></table>' +
        '<table-wrap-foot><fn id="TFN1"><p id="P50">Abbreviations: IQR, interquartile range; OCS, oral corticosteroids.</p></fn>' +
        '<fn id="TFN2"><label>+</label><p id="P51">66 (97%) of the 68% patients on dupilumab were using the 300 mg every 2-week dose.</p></fn>' +
        '<fn id="TFN3"><label>*</label><p id="P52">No patient within this cohort was uninsured</p></fn>' +
        '<fn id="TFN4"><label>#</label><p id="P53">The five patients on omalizumab all had IgE within the accepted level.</p></fn></table-wrap-foot></table-wrap>' +
        '<table-wrap id="T2"><label>Table 2</label><table><thead><tr><th align="left" valign="bottom" rowspan="1" colspan="1">EXACERBATION RATE RATIOS<break/>IRR (95% CI)</th><th>MEPOLIZUMAB</th></tr></thead></table></table-wrap>' +
        '<table-wrap id="T3"><label>Table 3</label><table><thead><tr><th align="left" valign="bottom" rowspan="1" colspan="1">MEAN DIFFERENCE IN LITERS<break/>(95% CI)</th><th>MEPOLIZUMAB</th></tr></thead></table></table-wrap>' +
        '</sec>',
    ),
  );

  it('keeps a <break/> in a header cell as a line boundary (PMC10164684 Tables 2 and 3)', () => {
    const tables = parsePmcArticle(PMC10164684).tables ?? [];
    expect(tables[1]?.rows[0]).toEqual(['EXACERBATION RATE RATIOS\nIRR (95% CI)', 'MEPOLIZUMAB']);
    expect(tables[2]?.rows[0]).toEqual(['MEAN DIFFERENCE IN LITERS\n(95% CI)', 'MEPOLIZUMAB']);
  });

  it('returns one footnotes line per <fn>, each marker leading its line (PMC10164684 Table 1)', () => {
    const footnotes = parsePmcArticle(PMC10164684).tables?.[0]?.footnotes;
    expect(footnotes?.split('\n')).toEqual([
      'Abbreviations: IQR, interquartile range; OCS, oral corticosteroids.',
      '+ 66 (97%) of the 68% patients on dupilumab were using the 300 mg every 2-week dose.',
      '* No patient within this cohort was uninsured',
      '# The five patients on omalizumab all had IgE within the accepted level.',
    ]);
  });

  it('splits multi-value cells at <break/> instead of fusing their numbers (PMC11176230, PMC13531951)', () => {
    const article = jatsArticle(
      articleXml(
        '',
        '<table-wrap id="Tab4"><table><thead><tr><th/><th align="left" colspan="2" rowspan="1">KTR<break/><italic toggle="yes">n</italic>\u2009=\u2009157<break/>mean measured GFR: 57\u2009±\u200920<break/>95 percentile range: 25–87</th></tr></thead>' +
          '<tbody><tr><td>Creatine</td><td align="center" valign="top" rowspan="1" colspan="1">1.08<break/>2.44</td><td>0.020</td></tr></tbody></table></table-wrap>',
      ),
    );
    const rows = parsePmcArticle(article).tables?.[0]?.rows ?? [];
    expect(rows[0]?.[1]).toBe(
      'KTR\nn = 157\nmean measured GFR: 57 ± 20\n95 percentile range: 25–87',
    );
    expect(rows[1]).toEqual(['Creatine', '1.08\n2.44', '0.020']);
    expect(JSON.stringify(rows)).not.toMatch(/2095|1\.082\.44/);
  });

  it('gives a <list> in a cell one line per item, label included (PMC12892626)', () => {
    const article = jatsArticle(
      articleXml(
        '',
        '<table-wrap id="tbl1"><table><tbody><tr><td align="left"><list list-type="simple" id="celist10">' +
          '<list-item id="celistitem10"><label>1.</label><p id="para10">Hispanic, or of Hispanic origin, background or descendent</p></list-item>' +
          '<list-item id="celistitem20"><label>2.</label><p id="para20">Aged 55 or over</p></list-item>' +
          '</list></td></tr></tbody></table></table-wrap>',
      ),
    );
    expect(parsePmcArticle(article).tables?.[0]?.rows[0]?.[0]).toBe(
      '1. Hispanic, or of Hispanic origin, background or descendent\n2. Aged 55 or over',
    );
  });

  it('leaves a single-footnote footer and inline cell markers as they read before', () => {
    const article = jatsArticle(
      articleXml(
        '',
        '<table-wrap><table><tbody><tr><td>0.108<sup>a</sup></td></tr></tbody></table>' +
          '<table-wrap-foot><p><sup>a</sup>Fisher’s exact test</p></table-wrap-foot></table-wrap>',
      ),
    );
    const table = parsePmcArticle(article).tables?.[0];
    expect(table?.rows).toEqual([['0.108a']]);
    expect(table?.footnotes).toBe('aFisher’s exact test');
  });

  it('keeps each item label of a simple list in section text (PMC12878422 celist10)', () => {
    const article = jatsArticle(
      articleXml(
        '',
        '<sec><title>Methods</title><p id="para140">\n<list list-type="simple" id="celist10">' +
          '<list-item id="celistitem10"><label>1.</label><p id="para150">Cereals (including potatoes, bread, pasta, rice, cookies)</p></list-item>' +
          '<list-item id="celistitem20"><label>2.</label><p id="para160">Pulses</p></list-item>' +
          '</list></p></sec>',
      ),
    );
    expect(parsePmcArticle(article).sections[0]?.text).toBe(
      '1. Cereals (including potatoes, bread, pasta, rice, cookies)\n2. Pulses',
    );
  });

  it('leaves the label out of a list that prints its own marker, and a simple list without labels bare', () => {
    const sections = extractBodySections(
      el('body', [
        el('list', [el('list-item', [el('label', [t('(a)')]), el('p', [t('First.')])])], {
          '@_list-type': 'order',
        }),
        el('list', [el('list-item', [el('label', [t('•')]), el('p', [t('Dot.')])])], {
          '@_list-type': 'bullet',
        }),
        el('list', [el('list-item', [el('p', [t('Bare.')])])], { '@_list-type': 'simple' }),
      ]),
    );
    expect(sections[0]?.text).toBe('1. First.\n\n- Dot.\n\nBare.');
  });

  it('reads a <fig-group> label beside its caption with one space (PMC12266799)', () => {
    const article = jatsArticle(
      articleXml(
        '',
        '<sec><title>Results</title><p>Shown below.</p><fig-group position="float" id="F3" orientation="portrait"><label>FIGURE 3</label>' +
          '<caption><p>Kaplan-Meier cumulative incidence curves.</p></caption></fig-group></sec>',
      ),
    );
    expect(parsePmcArticle(article).sections[0]?.text).toBe(
      'Shown below.\n\nFIGURE 3 Kaplan-Meier cumulative incidence curves.',
    );
  });

  it('reads <break/>, <hr/> and an inline <fn> in a paragraph as one space each', () => {
    const article = jatsArticle(
      articleXml(
        '',
        '<sec><title>Intro</title><p>Line one<break/>line two<hr/>line three<fn id="fn1"><label>a</label><p>A note.</p></fn>after.</p></sec>',
      ),
    );
    expect(parsePmcArticle(article).sections[0]?.text).toBe(
      'Line one line two line three a A note. after.',
    );
  });

  it('keeps inline markup in section prose unspaced', () => {
    const article = jatsArticle(
      articleXml(
        '',
        '<sec><title>Intro</title><p>H<sub>2</sub>O<sub>2</sub> at 1 × 10<sup>−5</sup> M, kg/m<sup>2</sup>, the i<italic>th</italic> run (Smith et al., <xref ref-type="bibr" rid="b1">2008</xref>).</p></sec>',
      ),
    );
    expect(parsePmcArticle(article).sections[0]?.text).toBe(
      'H2O2 at 1 × 10−5 M, kg/m2, the ith run (Smith et al., 2008).',
    );
  });
});

describe('adjacent citation markers in prose (#197)', () => {
  it('separates a run of markers with nothing between them by commas (PMC13581315)', () => {
    const article = jatsArticle(
      articleXml(
        '',
        '<sec><title>Introduction</title><p>recognised among Asians.[<xref rid="R1" ref-type="bibr">1</xref><xref rid="R2" ref-type="bibr">2</xref>' +
          '<xref rid="R3" ref-type="bibr">3</xref><xref rid="R4" ref-type="bibr">4</xref>] Delayed diagnosis.[<xref rid="R5" ref-type="bibr">5</xref>,' +
          '<xref rid="R7" ref-type="bibr">7</xref>–<xref rid="R9" ref-type="bibr">9</xref>]</p></sec>',
      ),
    );
    expect(parsePmcArticle(article).sections[0]?.text).toBe(
      'recognised among Asians.[1,2,3,4] Delayed diagnosis.[5,7–9]',
    );
  });

  it('starts a fresh run after a block interrupts the paragraph', () => {
    const article = jatsArticle(
      articleXml(
        '',
        '<sec><title>Intro</title><p>Before <xref>1</xref><list><list-item><p>item</p></list-item></list><xref>2</xref> after.</p></sec>',
      ),
    );
    expect(parsePmcArticle(article).sections[0]?.text).toBe('Before 1\n\n- item\n\n2 after.');
  });
});

describe('affiliations at every front-matter level (#196)', () => {
  it('reads <aff> inside <contrib-group> (PMC11176230 shape)', () => {
    const article = jatsArticle(
      articleXml(
        '<contrib-group><contrib contrib-type="author"><name><surname>Post</surname><given-names>Adrian</given-names></name><xref ref-type="aff" rid="aff1">1</xref></contrib>' +
          '<contrib contrib-type="author"><name><surname>Bakker</surname><given-names>Stephan</given-names></name><xref ref-type="aff" rid="aff1">1</xref><xref ref-type="aff" rid="aff2">2</xref></contrib>' +
          '<aff id="aff1"><label>1</label>Department of Internal Medicine, University Medical Center Groningen, Groningen, The Netherlands</aff>' +
          '<aff id="aff2"><label>2</label>Laboratory Medicine, Groningen, The Netherlands</aff></contrib-group>',
      ),
    );
    expect(parsePmcArticle(article).affiliations).toEqual([
      '1 Department of Internal Medicine, University Medical Center Groningen, Groningen, The Netherlands',
      '2 Laboratory Medicine, Groningen, The Netherlands',
    ]);
  });

  it('reads <aff> inside each <contrib>, one copy per distinct affiliation (PMC13588555 shape)', () => {
    const article = jatsArticle(
      articleXml(
        '<contrib-group><contrib contrib-type="author"><name><surname>Rajasingham</surname></name><aff id="A1">Emergency Response and Recovery Branch, CDC, Atlanta, USA</aff></contrib>' +
          '<contrib contrib-type="author"><name><surname>Harvey</surname></name><aff id="A2">Ethiopia WASH Cluster, Addis Ababa, Ethiopia</aff></contrib>' +
          '<contrib contrib-type="author"><name><surname>Martinsen</surname></name><aff id="A5">Emergency Response and Recovery Branch, CDC, Atlanta, USA</aff></contrib></contrib-group>',
      ),
    );
    expect(parsePmcArticle(article).affiliations).toEqual([
      'Emergency Response and Recovery Branch, CDC, Atlanta, USA',
      'Ethiopia WASH Cluster, Addis Ababa, Ethiopia',
    ]);
  });

  it('reads both levels in document order, an <aff> directly under <article-meta> included', () => {
    const article = jatsArticle(
      articleXml(
        '<contrib-group><contrib><name><surname>A</surname></name><aff id="a1">Group-level contrib aff</aff></contrib><aff id="a2">Group aff</aff></contrib-group>' +
          '<aff id="a3">Meta-level aff</aff>',
      ),
    );
    expect(parsePmcArticle(article).affiliations).toEqual([
      'Group-level contrib aff',
      'Group aff',
      'Meta-level aff',
    ]);
  });

  it('reads an <institution-wrap> as the institution and address only, without ROR/GRID/ISNI ids', () => {
    const article = jatsArticle(
      articleXml(
        '<contrib-group><aff id="Aff1"><label>1</label><institution-wrap><institution-id institution-id-type="ROR">https://ror.org/034t3zs45</institution-id>' +
          '<institution-id institution-id-type="GRID">grid.454711.2</institution-id><institution-id institution-id-type="ISNI">0000 0001 1942 5509</institution-id>' +
          '<institution>School of Food and Biological Engineering, </institution><institution>Shaanxi University of Science and Technology, </institution></institution-wrap>Xi’an, 710021 China </aff></contrib-group>',
      ),
    );
    const [affiliation] = parsePmcArticle(article).affiliations ?? [];
    expect(affiliation).toBe(
      '1 School of Food and Biological Engineering, Shaanxi University of Science and Technology, Xi’an, 710021 China',
    );
    expect(affiliation).not.toMatch(/ror\.org|grid\.|0000 0001/);
  });

  it('returns an <aff> directly under <article-meta> as before', () => {
    const article = jatsArticle(
      articleXml(
        '<aff id="aff1">Department of Testing, Example University</aff><aff id="aff2">Second Institute</aff>',
      ),
    );
    expect(parsePmcArticle(article).affiliations).toEqual([
      'Department of Testing, Example University',
      'Second Institute',
    ]);
  });

  it('omits the field when the front matter carries no <aff>', () => {
    const article = jatsArticle(
      articleXml(
        '<contrib-group><contrib><name><surname>A</surname></name></contrib></contrib-group>',
      ),
    );
    expect(parsePmcArticle(article).affiliations).toBeUndefined();
  });
});

describe('a nested list inside a list item paragraph (#200)', () => {
  /** The text of the first body section holding `secContent`. */
  const sectionText = (secContent: string): string | undefined =>
    parsePmcArticle(jatsArticle(articleXml('', `<sec><title>S</title>${secContent}</sec>`)))
      .sections[0]?.text;

  /** A `bullet` list of plain paragraph items. */
  const bullets = (...items: string[]) =>
    `<list list-type="bullet">${items.map((i) => `<list-item><p>${i}</p></list-item>`).join('')}</list>`;

  it('starts every nested item on a line of its own beneath its parent (PMC12892673)', () => {
    const text = sectionText(
      '<p id="para40">We agreed on the following priorities:<list list-type="simple" id="celist10">' +
        '<list-item id="celistitem10"><label>-</label><p id="para50">PREVENTION:<list list-type="simple" id="celist20">' +
        '<list-item id="celistitem20"><label>•</label><p id="para60">Implementation and education of known risk factors;</p></list-item>' +
        '<list-item id="celistitem30"><label>•</label><p id="para70">Large interventional studies.</p></list-item></list></p></list-item>' +
        '<list-item id="celistitem40"><label>-</label><p id="para80">EARLY DIAGNOSIS:<list list-type="simple" id="celist30">' +
        '<list-item id="celistitem50"><label>•</label><p id="para90">Development and validation of new biological markers;</p></list-item></list></p></list-item>' +
        '</list></p>',
    );
    expect(text).toBe(
      [
        'We agreed on the following priorities:',
        '',
        '- PREVENTION:',
        '  • Implementation and education of known risk factors;',
        '  • Large interventional studies.',
        '- EARLY DIAGNOSIS:',
        '  • Development and validation of new biological markers;',
      ].join('\n'),
    );
  });

  it('renders a list inside the item paragraph exactly as one that is a direct child of the item', () => {
    const inParagraph = sectionText(
      `<list list-type="order"><list-item><p>Parent:${bullets('Child one', 'Child two')}` +
        '<def-list><def-item><term>BMI</term><def><p>body mass index</p></def></def-item></def-list></p></list-item></list>',
    );
    const directChild = sectionText(
      `<list list-type="order"><list-item><p>Parent:</p>${bullets('Child one', 'Child two')}` +
        '<def-list><def-item><term>BMI</term><def><p>body mass index</p></def></def-item></def-list></list-item></list>',
    );
    expect(inParagraph).toBe('1. Parent:\n  - Child one\n  - Child two\n  - BMI — body mass index');
    expect(inParagraph).toBe(directChild);
  });

  it('indents a list nested two paragraphs deep two levels', () => {
    const text = sectionText(
      `<list list-type="bullet"><list-item><p>Top<list list-type="bullet"><list-item><p>Middle${bullets('Bottom')}</p></list-item></list></p></list-item></list>`,
    );
    expect(text).toBe('- Top\n  - Middle\n    - Bottom');
  });

  it('keeps prose that follows the nested list below it, in document order (PMC8533647)', () => {
    // The rest of the same <p>, then a later sibling <p>, both after the list.
    const text = sectionText(
      `<list list-type="order"><list-item><label>3.</label><p>RoB from confounding${bullets('Assumes a list', 'Low RoB requires balance.')}` +
        ' </p><p>Assess against the worksheet.</p></list-item><list-item><p>Next.</p></list-item></list>',
    );
    expect(text).toBe(
      '1. RoB from confounding\n  - Assumes a list\n  - Low RoB requires balance.\n  Assess against the worksheet.\n2. Next.',
    );
    expect(
      sectionText(
        `<list list-type="bullet"><list-item><p>Before${bullets('Child')}after.</p></list-item></list>`,
      ),
    ).toBe('- Before\n  - Child\n  after.');
  });

  it('keeps prose after a direct-child list below it as well (#203)', () => {
    expect(
      sectionText(
        `<list list-type="bullet"><list-item><p>Before</p>${bullets('Child')}<p>after.</p></list-item></list>`,
      ),
    ).toBe('- Before\n  - Child\n  after.');
  });

  it('leaves flat lists and direct-child nested lists as they read before', () => {
    expect(
      sectionText(
        '<list list-type="bullet"><list-item><p>First para.</p><p>Second para.</p></list-item>' +
          '<list-item><p>Next.</p></list-item></list>',
      ),
    ).toBe('- First para. Second para.\n- Next.');
    expect(
      sectionText(
        `<list list-type="bullet"><list-item><p>Parent</p>${bullets('Child one', 'Child two')}</list-item></list>`,
      ),
    ).toBe('- Parent\n  - Child one\n  - Child two');
    expect(sectionText(`<p>Lead-in:${bullets('A', 'B')}</p>`)).toBe('Lead-in:\n\n- A\n- B');
  });
});

describe('a list inside an abstract reads on lines of its own (#202)', () => {
  /** The `abstract` parsed from an `<abstract>` holding `content`. */
  const abstractOf = (content: string): string | undefined =>
    parsePmcArticle(jatsArticle(articleXml(`<abstract>${content}</abstract>`))).abstract;

  /** A `bullet` list of plain paragraph items. */
  const bullets = (...items: string[]) =>
    `<list list-type="bullet">${items.map((i) => `<list-item><p>${i}</p></list-item>`).join('')}</list>`;

  it('starts a section that opens with a list on the line below its heading (PMC10869376)', () => {
    const abstract = abstractOf(
      '<sec><title>Abstract</title><p>Type 2 diabetes mellitus (T2DM) was reported to be associated with impaired immune response.</p></sec>' +
        '<sec><title>Key points</title><p id="Par2">\n<list list-type="bullet">' +
        '<list-item><p id="Par3">\n<italic toggle="yes">Hyperglycemia may suppress tryptophanase activity.</italic>\n</p></list-item>' +
        '<list-item><p id="Par4">\n<italic toggle="yes">The low abundance of Bacteroides may lead to the decrease of skatole.</italic>\n</p></list-item>' +
        '<list-item><p id="Par5">\n<italic toggle="yes">A low abundance of</italic> anti-inflammatory bacteria <italic toggle="yes">may induce an inflammatory response.</italic></p></list-item>' +
        '</list>\n</p></sec>' +
        '<sec><title>Supplementary Information</title><p>The online version contains supplementary material.</p></sec>',
    );
    expect(abstract).toBe(
      [
        'Abstract: Type 2 diabetes mellitus (T2DM) was reported to be associated with impaired immune response.',
        '',
        'Key points:',
        '- Hyperglycemia may suppress tryptophanase activity.',
        '- The low abundance of Bacteroides may lead to the decrease of skatole.',
        '- A low abundance of anti-inflammatory bacteria may induce an inflammatory response.',
        '',
        'Supplementary Information: The online version contains supplementary material.',
      ].join('\n'),
    );
  });

  it('breaks the heading line for a one-item list and for a definition list', () => {
    expect(
      abstractOf(
        '<sec><title>Key point</title><list list-type="order"><list-item><p>Only one.</p></list-item></list></sec>',
      ),
    ).toBe('Key point:\n1. Only one.');
    expect(
      abstractOf(
        '<sec><title>Abbreviations</title><def-list><def-item><term>BMI</term><def><p>body mass index</p></def></def-item></def-list></sec>',
      ),
    ).toBe('Abbreviations:\n- BMI — body mass index');
  });

  it('sets a list apart from the statements around it with a blank line, as a body section does', () => {
    const list = bullets('First.', 'Second.');
    expect(abstractOf(`<p>Intro.</p>${list}<p>After.</p>`)).toBe(
      'Intro.\n\n- First.\n- Second.\n\nAfter.',
    );
    // A list in the middle of a paragraph leaves that paragraph's own edges
    // prose, so the statement after it still joins with a space.
    expect(abstractOf(`<p>Intro:${list}then more.</p><p>Next.</p>`)).toBe(
      'Intro:\n\n- First.\n- Second.\n\nthen more. Next.',
    );
    expect(
      abstractOf(`<sec><title>Results</title><p>We found:</p>${list}<p>After.</p></sec>`),
    ).toBe('Results: We found:\n\n- First.\n- Second.\n\nAfter.');
    const body = parsePmcArticle(
      jatsArticle(
        articleXml('', `<sec><title>S</title><p>We found:</p>${list}<p>After.</p></sec>`),
      ),
    ).sections[0]?.text;
    expect(body).toBe('We found:\n\n- First.\n- Second.\n\nAfter.');
  });

  it('ends a list that closes a paragraph before the next statement starts (PMC8533648)', () => {
    const abstract = abstractOf(
      '<sec><title>Executive Summary/Abstract</title>' +
        '<sec><title>OBJECTIVES</title><p>The main goal is to examine the evidence.</p>' +
        '<p>The research questions underlying this project are as follows:\n' +
        bullets(
          'Do programmes reduce exclusion?',
          'Are some approaches more effective than others?',
        ) +
        '\n</p></sec>' +
        '<sec><title>SEARCH METHODS</title><p>The authors conducted a comprehensive search.</p></sec></sec>',
    );
    expect(abstract).toBe(
      'Executive Summary/Abstract: OBJECTIVES The main goal is to examine the evidence. ' +
        'The research questions underlying this project are as follows:\n\n' +
        '- Do programmes reduce exclusion?\n- Are some approaches more effective than others?\n\n' +
        'SEARCH METHODS The authors conducted a comprehensive search.',
    );
  });

  it('lays out an abstract that holds no list as before, apart from the #210 box delimiters', () => {
    expect(
      abstractOf(
        '<sec><title>Plain language summary</title><sec><title>The review in brief</title><p>Interventions have a temporary effect.</p>' +
          '<boxed-text><sec><title>What is the aim of this review?</title><p>This review examines exclusion.</p></sec></boxed-text></sec></sec>' +
          '<sec><title>Background</title><p>One.</p><p>Two <disp-formula><tex-math>x=1</tex-math></disp-formula> three.</p></sec>',
      ),
    ).toBe(
      // The box stands on lines of its own between its delimiters, as a list does (#210).
      'Plain language summary: The review in brief Interventions have a temporary effect.\n\n[Box]\n\nWhat is the aim of this review?\n' +
        'This review examines exclusion.\n\n[End of box]\n\nBackground: One. Two\n\nx=1\n\nthree.',
    );
    expect(abstractOf('<p>First paragraph.</p><p>Second <italic>paragraph</italic>.</p>')).toBe(
      'First paragraph. Second paragraph.',
    );
  });
});

describe('prose after a nested list that is a direct child of its item (#203)', () => {
  /** The text of the first body section holding `secContent`. */
  const sectionText = (secContent: string): string | undefined =>
    parsePmcArticle(jatsArticle(articleXml('', `<sec><title>S</title>${secContent}</sec>`)))
      .sections[0]?.text;

  /** A `bullet` list of plain paragraph items. */
  const bullets = (...items: string[]) =>
    `<list list-type="bullet">${items.map((i) => `<list-item><p>${i}</p></list-item>`).join('')}</list>`;

  it('keeps the prose after the nested list below it, in source order', () => {
    expect(
      sectionText(
        '<list><list-item><p>A</p><list><list-item><p>x</p></list-item></list><p>B</p></list-item></list>',
      ),
    ).toBe('- A\n  - x\n  B');
  });

  it('renders the item as #200 renders the same list nested inside the item paragraph', () => {
    const direct = sectionText(
      `<list list-type="order"><list-item><p>A</p>${bullets('x')}<p>B</p></list-item><list-item><p>Next.</p></list-item></list>`,
    );
    const inParagraph = sectionText(
      `<list list-type="order"><list-item><p>A${bullets('x')}B</p></list-item><list-item><p>Next.</p></list-item></list>`,
    );
    expect(direct).toBe('1. A\n  - x\n  B\n2. Next.');
    expect(direct).toBe(inParagraph);
  });

  it('keeps prose between and after two nested lists in order, two levels deep too', () => {
    expect(
      sectionText(
        `<list list-type="bullet"><list-item><p>A</p>${bullets('x')}<p>B</p>${bullets('y')}<p>C</p></list-item></list>`,
      ),
    ).toBe('- A\n  - x\n  B\n  - y\n  C');
    expect(
      sectionText(
        `<list list-type="bullet"><list-item><p>Top</p><list list-type="bullet"><list-item><p>Middle</p>${bullets('Bottom')}<p>Tail.</p></list-item></list></list-item></list>`,
      ),
    ).toBe('- Top\n  - Middle\n    - Bottom\n    Tail.');
  });

  it('keeps the marker of an item whose text all follows its nested list', () => {
    expect(
      sectionText(
        `<list list-type="order"><list-item><p>First.</p></list-item><list-item>${bullets('x')}<p>B</p></list-item><list-item><p>Third.</p></list-item></list>`,
      ),
    ).toBe('1. First.\n2.\n  - x\n  B\n3. Third.');
    expect(
      sectionText(`<list list-type="bullet"><list-item><p>${bullets('x')}B</p></list-item></list>`),
    ).toBe('-\n  - x\n  B');
  });

  it('leaves an item whose paragraphs all precede its nested list as it read before', () => {
    expect(
      sectionText(
        `<list list-type="bullet"><list-item><p>Parent</p><p>More.</p>${bullets('Child one', 'Child two')}</list-item></list>`,
      ),
    ).toBe('- Parent More.\n  - Child one\n  - Child two');
    expect(
      sectionText(
        `<list list-type="order"><list-item><p>First.</p></list-item><list-item>${bullets('x')}</list-item></list>`,
      ),
    ).toBe('1. First.\n  - x');
  });
});

describe('abstract content outside any section (#204)', () => {
  /** The `abstract` parsed from an `<abstract>` holding `content`. */
  const abstractOf = (content: string): string | undefined =>
    parsePmcArticle(jatsArticle(articleXml(`<abstract id="Abs1">${content}</abstract>`))).abstract;

  /** The "Supplementary Information" section Springer deposits after the abstract. */
  const supplementary = (doi: string) =>
    `<sec><title>Supplementary Information</title><p>The online version contains supplementary material available at ${doi}.</p></sec>`;

  it('keeps a direct paragraph that precedes a section, as a paragraph of its own (PMC11281965)', () => {
    const abstract = abstractOf(
      '<p id="Par1">Sepsis is characterized by a metabolic disorder of amino acid occurs in the early stage. ' +
        'Serum samples were collected on the 1<sup>st</sup>, 3<sup>rd</sup> and 7<sup>th</sup> day following admission. ' +
        'PLS-DA (VIP &gt; 1.0) and <italic toggle="yes">Kruskal-Wallis</italic> test (<italic toggle="yes">p</italic> &lt; 0.05) were employed.</p>' +
        supplementary('10.1007/s00726-024-03408-3'),
    );
    expect(abstract).toBe(
      'Sepsis is characterized by a metabolic disorder of amino acid occurs in the early stage. ' +
        'Serum samples were collected on the 1st, 3rd and 7th day following admission. ' +
        'PLS-DA (VIP > 1.0) and Kruskal-Wallis test (p < 0.05) were employed.\n\n' +
        'Supplementary Information: The online version contains supplementary material available at 10.1007/s00726-024-03408-3.',
    );
  });

  it('reads a run of direct paragraphs as an untitled section does, space-joined (PMC11176230)', () => {
    const abstract = abstractOf(
      '<p id="Par1">Creatine is a natural nitrogenous organic acid.</p>' +
        '<p id="Par2">Trial registration ID: <ext-link ext-link-type="pmc:clinical-trial" xlink:href="NCT02811835">NCT02811835</ext-link>.</p>' +
        '<p id="Par5"><bold>Trial registration URL</bold>: <ext-link ext-link-type="uri" xlink:href="https://clinicaltrials.gov/ct2/show/NCT02811835">https://clinicaltrials.gov/ct2/show/NCT02811835</ext-link>.</p>' +
        supplementary('10.1007/s00726-024-03401-w'),
    );
    expect(abstract).toBe(
      'Creatine is a natural nitrogenous organic acid. Trial registration ID: NCT02811835. ' +
        'Trial registration URL: https://clinicaltrials.gov/ct2/show/NCT02811835.\n\n' +
        'Supplementary Information: The online version contains supplementary material available at 10.1007/s00726-024-03401-w.',
    );
    // An untitled <sec> holding the same paragraphs reads the same way.
    expect(
      abstractOf(
        '<sec><p>Creatine is a natural nitrogenous organic acid.</p><p>Trial registration ID: NCT02811835.</p></sec>' +
          supplementary('10.1007/s00726-024-03401-w'),
      ),
    ).toBe(
      abstractOf(
        '<p>Creatine is a natural nitrogenous organic acid.</p><p>Trial registration ID: NCT02811835.</p>' +
          supplementary('10.1007/s00726-024-03401-w'),
      ),
    );
  });

  it('keeps direct content between and after sections in source order', () => {
    expect(
      abstractOf(
        '<sec><title>Background</title><p>Why.</p></sec><p>Loose one.</p><p>Loose two.</p>' +
          '<sec><title>Methods</title><p>How.</p></sec><p>Tail.</p>',
      ),
    ).toBe('Background: Why.\n\nLoose one. Loose two.\n\nMethods: How.\n\nTail.');
  });

  it("leaves out the abstract's own title and label, and lays out a direct list as #202 does", () => {
    expect(
      abstractOf(
        '<label>A</label><title>Abstract</title><p>Lead.</p>' +
          '<list list-type="bullet"><list-item><p>One.</p></list-item><list-item><p>Two.</p></list-item></list>' +
          '<sec><title>Results</title><p>Found.</p></sec>',
      ),
    ).toBe('Lead.\n\n- One.\n- Two.\n\nResults: Found.');
  });

  it('leaves abstracts made only of sections, or only of paragraphs, byte-identical', () => {
    expect(
      abstractOf(
        '\n<title>Abstract</title>\n<sec>\n<title>Background</title>\n<p>One.</p>\n<p>Two.</p>\n</sec>\n' +
          '<sec>\n<p>Untitled.</p>\n</sec>\n<sec>\n<title>Conclusions</title>\n<p>Three.</p>\n</sec>\n',
      ),
    ).toBe('Background: One. Two.\n\nUntitled.\n\nConclusions: Three.');
    expect(
      abstractOf('\n<p>First paragraph.</p>\n<p>Second <italic>paragraph</italic>.</p>\n'),
    ).toBe('First paragraph. Second paragraph.');
  });
});

describe('abstract section titles that already end in punctuation (#205)', () => {
  const abstractOf = (content: string): string | undefined =>
    parsePmcArticle(jatsArticle(articleXml(`<abstract>${content}</abstract>`))).abstract;

  it('adds no second colon to a title deposited with one (PMC10164684)', () => {
    expect(
      abstractOf(
        '<sec><title>Background:</title><p>Multiple monoclonal antibodies are approved.</p></sec>' +
          '<sec><title>Methods:</title><p>We pooled trials.</p></sec>',
      ),
    ).toBe(
      'Background: Multiple monoclonal antibodies are approved.\n\nMethods: We pooled trials.',
    );
  });

  it('keeps a title ending in a period, question mark, or exclamation mark as written', () => {
    expect(
      abstractOf(
        '<sec><title>Study Design.</title><p>Cohort.</p></sec>' +
          '<sec><title>What is known?</title><p>Little.</p></sec>' +
          '<sec><title>Take home!</title><p>Act.</p></sec>',
      ),
    ).toBe('Study Design. Cohort.\n\nWhat is known? Little.\n\nTake home! Act.');
  });

  it('still adds the colon to a title with no terminal punctuation', () => {
    expect(abstractOf('<sec><title>Results</title><p>It worked.</p></sec>')).toBe(
      'Results: It worked.',
    );
  });
});

describe('affiliations of contributors who are not authors (#196)', () => {
  const affiliationsOf = (meta: string): string[] | undefined =>
    parsePmcArticle(jatsArticle(articleXml(meta))).affiliations;

  it("leaves out an <aff> inside an editor's <contrib> (PMC10666927 shape)", () => {
    expect(
      affiliationsOf(
        '<contrib-group><contrib contrib-type="author"><name><surname>Kohrs</surname></name><xref ref-type="aff" rid="aff1">1</xref></contrib>' +
          '<aff id="aff1"><label>1</label>QUEST Center for Responsible Research, Berlin, Germany</aff></contrib-group>' +
          '<contrib-group><contrib contrib-type="editor"><name><surname>Rodgers</surname></name>' +
          '<aff><institution-wrap><institution-id institution-id-type="ror">https://ror.org/04a9tmd77</institution-id><institution>Icahn School of Medicine at Mount Sinai</institution></institution-wrap><country>United States</country></aff></contrib>' +
          '<contrib contrib-type="senior_editor"><name><surname>Zaidi</surname></name><aff><institution>Icahn School of Medicine at Mount Sinai</institution></aff></contrib></contrib-group>',
      ),
    ).toEqual(['1 QUEST Center for Responsible Research, Berlin, Germany']);
  });

  it('leaves out a direct <aff> of a <contrib-group> that holds no author', () => {
    expect(
      affiliationsOf(
        '<contrib-group><contrib><name><surname>Author</surname></name></contrib><aff id="a1">Author Institute</aff></contrib-group>' +
          '<contrib-group><contrib contrib-type="reviewer"><name><surname>Reviewer</surname></name></contrib><aff id="r1">Reviewer Institute</aff></contrib-group>',
      ),
    ).toEqual(['Author Institute']);
  });

  it("keeps an untyped <contrib>'s <aff> and a direct <aff> of a group mixing authors with others", () => {
    expect(
      affiliationsOf(
        '<contrib-group><contrib><name><surname>A</surname></name><aff id="a1">Untyped contributor aff</aff></contrib>' +
          '<contrib contrib-type="editor"><name><surname>E</surname></name></contrib><aff id="a2">Shared group aff</aff></contrib-group>' +
          '<contrib-group><aff id="a3">Group with no contrib</aff></contrib-group>',
      ),
    ).toEqual(['Untyped contributor aff', 'Shared group aff', 'Group with no contrib']);
  });
});

describe('institution identifiers in body text (#208)', () => {
  const fundingSource = (id: string, name: string) =>
    `<funding-source><institution-wrap><institution-id institution-id-type="doi">${id}</institution-id><institution>${name}</institution></institution-wrap></funding-source>`;

  it('names the funder without its id in section prose (PMC11609225 Funding)', () => {
    const article = jatsArticle(
      articleXml(
        '',
        `<sec><title>Funding</title><p>This research was sponsored by the ${fundingSource('10.13039/501100001809', 'National Natural Science Foundation of China')} grant No. <award-id award-type="grant">12250410247</award-id>, and also by the <funding-source>Ministry of Science and Technology of China</funding-source>.</p></sec>` +
          `<sec><title>Declaration of Competing Interest</title><p>Article publishing charges were provided by ${fundingSource('10.13039/501100014881', 'Guangzhou University')}.</p></sec>`,
      ),
    );
    const [funding, declaration] = parsePmcArticle(article).sections;
    expect(funding?.text).toBe(
      'This research was sponsored by the National Natural Science Foundation of China grant No. 12250410247, and also by the Ministry of Science and Technology of China.',
    );
    expect(declaration?.text).toBe(
      'Article publishing charges were provided by Guangzhou University.',
    );
  });

  it('leaves an id out of a table cell and a figure caption too', () => {
    const article = jatsArticle(
      articleXml(
        '',
        `<sec><title>S</title><table-wrap id="T1"><caption><p>Funded by ${fundingSource('10.13039/100000002', 'NIH')}.</p></caption><table><tbody><tr><td>${fundingSource('10.13039/100000001', 'NSF')}</td></tr></tbody></table></table-wrap></sec>`,
      ),
    );
    const table = parsePmcArticle(article).tables?.[0];
    expect(table?.caption).toBe('Funded by NIH.');
    expect(table?.rows).toEqual([['NSF']]);
  });

  it('reads funding prose with no <institution-id> as before', () => {
    const article = jatsArticle(
      articleXml(
        '',
        '<sec><title>Funding</title><p>Supported by the <funding-source><institution-wrap><institution>Wellcome Trust</institution></institution-wrap></funding-source> (grant <award-id>12345</award-id>).</p></sec>',
      ),
    );
    expect(parsePmcArticle(article).sections[0]?.text).toBe(
      'Supported by the Wellcome Trust (grant 12345).',
    );
  });
});

describe('reference fields that run together (#209)', () => {
  /** The `references[]` of an article whose `<back>` holds `refs`. */
  const referencesOf = (refs: string) =>
    extractReferences(
      jatsArticle(
        `<article><front><article-meta><article-id pub-id-type="pmcid">PMC1</article-id></article-meta></front><back><ref-list>${refs}</ref-list></back></article>`,
      ),
    );
  const name = (surname: string, given: string) =>
    `<name name-style="western"><surname>${surname}</surname><given-names>${given}</given-names></name>`;

  it('separates zero-gap <name>s with ", " and reads an empty <etal/> as "et al." (PMC10754557 R19)', () => {
    const [ref] = referencesOf(
      `<ref id="R19"><label>[19]</label><mixed-citation publication-type="journal"><person-group person-group-type="author">${name('Zwierenga', 'F')}${name('van Veggel', 'B')}${name('Hendriks', 'LEL')}<etal/></person-group>. ` +
        '<article-title>High dose osimertinib in patients with advanced stage EGFR exon 20 mutation-positive NSCLC.</article-title>\n<source>Lung Cancer</source>. <year>2022</year>;<volume>170</volume>:<fpage>133</fpage>–<lpage>40</lpage>.</mixed-citation></ref>',
    );
    expect(ref?.citation).toBe(
      'Zwierenga F, van Veggel B, Hendriks LEL, et al. High dose osimertinib in patients with advanced stage EGFR exon 20 mutation-positive NSCLC. Lung Cancer. 2022;170:133–40.',
    );
  });

  it('separates names a newline alone divides, and closes "et al." with the source period (PMC12266799)', () => {
    const [ref] = referencesOf(
      `<ref id="r1"><mixed-citation>\n<person-group person-group-type="author">\n${name('Berzigotti', 'A')}\n${name('García-Pagán', 'JC')}\n<etal/>\n</person-group>. <article-title>Elastography and spleen size</article-title>. <source>Gastroenterology</source>.</mixed-citation></ref>`,
    );
    expect(ref?.citation).toBe(
      'Berzigotti A, García-Pagán JC, et al. Elastography and spleen size. Gastroenterology.',
    );
  });

  it('reads an <etal/> outside the <person-group> after source punctuation (PMC10164684, PMC11572527, PMC13610153)', () => {
    const refs = referencesOf(
      `<ref id="a"><mixed-citation>${name('Liao', 'KP')}, ${name('Cai', 'T')}, <etal/>\n<article-title>Development of phenotype algorithms</article-title>.</mixed-citation></ref>` +
        `<ref id="b"><mixed-citation><person-group person-group-type="author">${name('Wray', 'NR')}, ${name('Ripke', 'S')}</person-group>, <etal/>. <article-title>Genome-wide association analyses</article-title>.</mixed-citation></ref>` +
        `<ref id="c"><mixed-citation><person-group person-group-type="author">${name('Hirsch', 'JS')}${name('Ng', 'JH')}<etal/></person-group>; <collab>Northwell COVID-19 Research Consortium</collab>. <article-title>Acute kidney injury</article-title>.</mixed-citation></ref>`,
    );
    expect(refs.map((ref) => ref.citation)).toEqual([
      'Liao KP, Cai T, et al. Development of phenotype algorithms.',
      'Wray NR, Ripke S, et al. Genome-wide association analyses.',
      'Hirsch JS, Ng JH, et al.; Northwell COVID-19 Research Consortium. Acute kidney injury.',
    ]);
  });

  it('keeps an <etal> that carries its own text, and a source "et al.." the renderer did not supply, as written', () => {
    const refs = referencesOf(
      `<ref id="a"><mixed-citation><person-group>${name('Smith', 'J')}, <etal>et al</etal></person-group>. <source>Cell</source>.</mixed-citation></ref>` +
        '<ref id="b"><mixed-citation><string-name><surname>Doe</surname> <given-names>K</given-names></string-name> et al.. <source>Cell</source>.</mixed-citation></ref>',
    );
    expect(refs.map((ref) => ref.citation)).toEqual([
      'Smith J, et al. Cell.',
      'Doe K et al.. Cell.',
    ]);
  });

  it('joins an <element-citation> page range and volume(issue) (PMC11292240 bib2)', () => {
    const [ref] = referencesOf(
      `<ref id="bib2"><label>2</label><element-citation publication-type="journal"><person-group person-group-type="author">${name('Pasteur', 'M.C.')}${name('Bilton', 'D.')}</person-group>` +
        '<article-title>British thoracic society guideline for non-CF bronchiectasis</article-title><source>Thorax</source><volume>65</volume><issue>SUPPL. 1</issue><year>2010</year><fpage>i1</fpage><lpage>i58</lpage>' +
        '<pub-id pub-id-type="pmid">20627931</pub-id></element-citation></ref>',
    );
    expect(ref?.citation).toBe(
      'Pasteur M.C., Bilton D. British thoracic society guideline for non-CF bronchiectasis Thorax 65(SUPPL. 1) 2010 i1–i58 PMID 20627931',
    );
    expect(ref?.label).toBe('2');
  });

  it('leaves <element-citation> fields that are not an adjacent pair spaced as before', () => {
    const [ref] = referencesOf(
      '<ref id="r"><element-citation><source>Nurse Res.</source><volume>16</volume><year>2008</year><issue>1</issue><fpage>56</fpage>\n<elocation-id>e5</elocation-id><lpage>71</lpage></element-citation></ref>',
    );
    expect(ref?.citation).toBe('Nurse Res. 16 2008 1 56 e5 71');
  });

  it('drops the square brackets a <label> is printed in, and keeps every other label as printed', () => {
    const refs = referencesOf(
      '<ref id="R19"><label>[19]</label><mixed-citation>A.</mixed-citation></ref>' +
        '<ref id="B1"><label>1.</label><mixed-citation>B.</mixed-citation></ref>' +
        '<ref id="C3"><label>(3)</label><mixed-citation>C.</mixed-citation></ref>' +
        '<ref id="D4"><label>[4]–[5]</label><mixed-citation>D.</mixed-citation></ref>',
    );
    expect(refs.map((ref) => ref.label)).toEqual(['19', '1.', '(3)', '[4]–[5]']);
  });
});

describe('boxed text set apart from the body (#210)', () => {
  /** The sections of an article whose `<body>` holds `body`. */
  const sectionsOf = (body: string) => parsePmcArticle(jatsArticle(articleXml('', body))).sections;

  it('opens a floating box with its label and title and closes it before the body resumes (PMC10666927)', () => {
    const [section] = sectionsOf(
      '<sec><title>Introduction</title><p>Members organized a virtual brainstorming event (see <xref rid="box1" ref-type="boxed-text">Box 1</xref>).</p>' +
        '<boxed-text id="box1" position="float"><label>Box 1.</label><caption><title>Virtual unconference format</title></caption><p>In March 2022, 96 participants took part.</p></boxed-text>' +
        '<p>The first section of this paper provides a brief overview.</p></sec>',
    );
    expect(section?.text).toBe(
      'Members organized a virtual brainstorming event (see Box 1).\n\n' +
        '[Box: Box 1. Virtual unconference format]\n\nIn March 2022, 96 participants took part.\n\n[End of box]\n\n' +
        'The first section of this paper provides a brief overview.',
    );
  });

  it('names a box by its title alone, keeps its caption paragraphs, and delimits one nested in a <p>', () => {
    const [section] = sectionsOf(
      '<sec><title>Summary</title><p>Before the box.<boxed-text><caption><title>Highlights</title><p>Caption note.</p></caption>' +
        '<p>Fusions are rare.</p><list list-type="bullet"><list-item><p>Actionable.</p></list-item></list></boxed-text>After the box.</p></sec>',
    );
    expect(section?.text).toBe(
      'Before the box.\n\n[Box: Highlights]\n\nCaption note.\n\nFusions are rare.\n\n- Actionable.\n\n[End of box]\n\nAfter the box.',
    );
  });

  it('delimits a box inside a box, each closing in order', () => {
    const [section] = sectionsOf(
      '<sec><title>S</title><boxed-text><label>Box 2</label><p>Outer.</p><boxed-text><caption><title>Inner</title></caption><p>Inside.</p></boxed-text><p>Outer again.</p></boxed-text></sec>',
    );
    expect(section?.text).toBe(
      '[Box: Box 2]\n\nOuter.\n\n[Box: Inner]\n\nInside.\n\n[End of box]\n\nOuter again.\n\n[End of box]',
    );
  });

  it('keeps a named box with no readable content as its opening line, and an unnamed one out', () => {
    const [section] = sectionsOf(
      '<sec><title>S</title><p>Prose.</p><boxed-text><caption><title>Figure panel</title></caption><graphic href="a.jpg"/></boxed-text>' +
        '<boxed-text><graphic href="b.jpg"/></boxed-text></sec>',
    );
    expect(section?.text).toBe('Prose.\n\n[Box: Figure panel]');
  });

  it('leaves a titled box that forms a section of its own as it read before', () => {
    expect(
      sectionsOf(
        '<boxed-text><caption><title>Key messages:</title></caption><p>In this cohort:</p><list list-type="bullet"><list-item><p>Dupilumab helped.</p></list-item></list></boxed-text>' +
          '<sec><title>Methods</title><p>Text.</p></sec>',
      ),
    ).toEqual([
      { title: 'Key messages:', text: 'In this cohort:\n\n- Dupilumab helped.' },
      { title: 'Methods', text: 'Text.' },
    ]);
  });
});

describe('reference rendering runs in linear time (#209)', () => {
  /** CPU time of `run`, in ms — this thread's user + system time, not wall clock. */
  const cpuMs = (run: () => void): number => {
    const start = process.threadCpuUsage();
    run();
    const { user, system } = process.threadCpuUsage(start);
    return (user + system) / 1000;
  };

  /** Fastest of five measurements of five renders each. */
  const fastestMs = (render: () => void): number => {
    render();
    return Math.min(
      ...Array.from({ length: 5 }, () =>
        cpuMs(() => {
          for (let i = 0; i < 5; i++) render();
        }),
      ),
    );
  };

  /** `unit` repeated until its serialized form spans about `chars` characters. */
  const repeat = (unit: JatsNode[], unitChars: number, chars: number): JatsNode[] =>
    Array.from({ length: Math.ceil(chars / unitChars) }, () => unit).flat();

  const nameNode = el('name', [el('surname', [t('A')]), el('given-names', [t('B')])]);
  const inPersonGroup = (children: JatsNode[]) =>
    el('mixed-citation', [el('person-group', children)]);

  it.each([
    // `<name>…</name><name>…</name>`: a ", " owed between every pair.
    ['zero-gap names', (units: JatsNode[]) => inPersonGroup(units), [nameNode], 63],
    // `<name>…</name>\n`: whitespace held, then dropped for a ", ".
    [
      'names a newline divides',
      (units: JatsNode[]) => inPersonGroup(units),
      [nameNode, t('\n')],
      64,
    ],
    // `<etal/>.`: a supplied "et al." whose period the source closes every time.
    [
      'supplied et al. closed by the source',
      (units: JatsNode[]) => el('mixed-citation', units),
      [el('etal', []), t('.')],
      8,
    ],
    // `<pub-id/>`: a label read against the text written so far, every time.
    [
      'zero-gap typed pub-ids',
      (units: JatsNode[]) => el('mixed-citation', units),
      [el('pub-id', [t('1')], { '@_pub-id-type': 'pmid' })],
      37,
    ],
    // `<fpage/><lpage/>`: a range joined from the part just written.
    [
      'element-citation page pairs',
      (units: JatsNode[]) => el('element-citation', units),
      [el('fpage', [t('1')]), el('lpage', [t('2')])],
      32,
    ],
  ])('renders %s in linear CPU time', (_label, wrap, unit, unitChars) => {
    const at = (chars: number) =>
      el('ref-list', [el('ref', [wrap(repeat(unit as JatsNode[], unitChars as number, chars))])]);
    const small = at(5_000);
    const large = at(80_000);
    const t5k = fastestMs(() => extractReferences(small));
    const t80k = fastestMs(() => extractReferences(large));
    expect(t80k / t5k).toBeLessThan(64);
    expect(t80k).toBeLessThan(250);
  });
});
