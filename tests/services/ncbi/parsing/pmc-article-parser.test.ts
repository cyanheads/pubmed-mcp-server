/**
 * @fileoverview Tests for PMC JATS XML article parser. Fixtures reflect the
 * shape produced by fast-xml-parser in `preserveOrder: true` mode (see
 * `pmc-xml-helpers.ts`).
 * @module tests/services/ncbi/parsing/pmc-article-parser.test
 */

import { describe, expect, it } from 'vitest';
import {
  extractBodySections,
  extractJatsAuthors,
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

  it('omits tables entirely from an article that has none (regression #111)', () => {
    const article = el('article', [
      el('body', [el('sec', [el('title', [t('Results')]), el('p', [t('No tables here.')])])]),
    ]);

    expect(extractPmcTables(article)).toEqual([]);
    expect('tables' in parsePmcArticle(article)).toBe(false);
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
    expect(refs[0]?.citation).toBe(
      'Doman J.L., Pandey S. Phage-assisted evolution yields compact prime editors Cell 186 18 2023 3983 4002.e26 PMID 37657419 DOI 10.1016/j.cell.2023.07.039 PMCID PMC10482982',
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
});
