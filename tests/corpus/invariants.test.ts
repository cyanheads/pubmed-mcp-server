/**
 * @fileoverview Proves each corpus invariant (`invariants.ts`) can fail: a clean
 * synthetic result holds every one, then each test plants exactly one leak and
 * expects exactly that invariant's message, and each documented exemption is
 * shown not to fire.
 * @module tests/corpus/invariants.test
 */
import { describe, expect, it } from 'vitest';
import type { CorpusArticle } from './expect.js';
import { checkInvariants } from './invariants.js';
import { structuredStrings } from './run-tool.js';

/**
 * A source with one of everything the invariants count or read across: a
 * `<break/>` between words and between numbers, a zero-gap `<xref>` run, a
 * table, a figure, a supplement, two references, and an inline `<italic>`.
 */
const SOURCE =
  '<article><front><article-meta><title-group><article-title>Boundary <italic>study</italic></article-title></title-group></article-meta></front>' +
  '<body><sec><title>Results</title>' +
  '<p>Rate ratios<break/>IRR shown [<xref ref-type="bibr" rid="R1">1</xref><xref ref-type="bibr" rid="R2">2</xref>].</p>' +
  '<table-wrap id="T1"><label>Table 1</label><table><tbody><tr><td>57 ± 20<break/>95 percentile</td></tr></tbody></table></table-wrap>' +
  '<fig id="F1"><label>Figure 1</label><caption><p>Cohort.</p></caption></fig>' +
  '<supplementary-material id="S1"><label>Data S1</label></supplementary-material>' +
  '</sec></body><back><ref-list>' +
  '<ref id="R1"><mixed-citation>Smith J. Cell. 2020.</mixed-citation></ref>' +
  '<ref id="R2"><mixed-citation>Doe K. Cell. 2021.</mixed-citation></ref>' +
  '</ref-list></back></article>';

const FIGURE = { assetType: 'figure', label: 'Figure 1', caption: 'Cohort.' } as const;
const SUPPLEMENT = { assetType: 'supplementary-material', label: 'Data S1' } as const;

/** A result that reads {@link SOURCE} correctly. */
const ARTICLE: CorpusArticle = {
  title: 'Boundary study',
  sections: [{ title: 'Results', text: 'Rate ratios IRR shown [1,2].' }],
  tables: [{ label: 'Table 1', rows: [['57 ± 20\n95 percentile']] }],
  assets: [FIGURE, SUPPLEMENT],
  references: [
    { id: 'R1', citation: 'Smith J. Cell. 2020.' },
    { id: 'R2', citation: 'Doe K. Cell. 2021.' },
  ],
};

/** The `content[]` text {@link ARTICLE} renders to. */
const TEXT = [
  '### Boundary study',
  '#### Results',
  'Rate ratios IRR shown [1,2].',
  '#### Tables (1)',
  '##### Table 1',
  '| 57 ± 20 · 95 percentile |',
  '#### Assets (2)',
  '*figure · Figure 1*',
  'Cohort.',
  '*supplementary-material · Data S1*',
  '#### References (2)',
  '- [R1] Smith J. Cell. 2020.',
  '- [R2] Doe K. Cell. 2021.',
].join('\n');

interface Planted {
  article?: CorpusArticle;
  source?: string;
  tablesOverride?: number;
  text?: string;
}

/** Every invariant problem for the clean result with `planted` swapped in. */
function problems({
  article = ARTICLE,
  source = SOURCE,
  tablesOverride,
  text = TEXT,
}: Planted = {}) {
  return checkInvariants({
    article,
    source,
    strings: structuredStrings({ articles: [article] }),
    tablesOverride,
    text,
  });
}

/** {@link ARTICLE} with its one section's text replaced. */
const withSectionText = (text: string): CorpusArticle => ({
  ...ARTICLE,
  sections: [{ title: 'Results', text }],
});

/** {@link TEXT} without the lines `drop` matches. */
const textWithout = (drop: RegExp): string =>
  TEXT.split('\n')
    .filter((line) => !drop.test(line))
    .join('\n');

describe('corpus invariants', () => {
  it('hold for a result that reads the source correctly', () => {
    expect(problems()).toEqual([]);
  });

  it('report a source element name that reached the output as a tag', () => {
    expect(
      problems({ article: withSectionText('Rate ratios <italic>IRR</italic> shown [1,2].') }),
    ).toEqual([
      'leaked JATS tag at articles[0].sections[0].text: "<italic>IRR</italic> shown [1,2]."',
    ]);
  });

  it('exempt an escaped tag and a tag name the source never uses', () => {
    expect(
      problems({ article: withSectionText('Rate ratios \\<italic> and <widget> shown [1,2].') }),
    ).toEqual([]);
  });

  it('report an undecoded entity, and exempt one the source escapes as text', () => {
    const text = TEXT.replace('Rate ratios IRR', 'Rate ratios &amp; IRR');
    expect(problems({ text })).toEqual(['undecoded entity at content[]: "&amp;"']);
    expect(problems({ text, source: `${SOURCE}<!-- &amp;amp; -->` })).toEqual([]);
  });

  it('report a stringified missing value in structuredContent, and exempt one the source holds', () => {
    const article: CorpusArticle = {
      ...ARTICLE,
      tables: [{ label: 'NaN', rows: [['57 ± 20\n95 percentile']] }],
    };
    expect(problems({ article })).toEqual([
      'a stringified missing value at articles[0].tables[0].label',
    ]);
    expect(
      problems({ article, source: SOURCE.replace('<label>Table 1</label>', '<label>NaN</label>') }),
    ).toEqual([]);
  });

  it('report a missing value rendered as a content[] cell', () => {
    expect(problems({ text: TEXT.replace('| 57 ± 20 · 95 percentile |', '| null |') })).toEqual([
      '"null" rendered as a value in content[]',
    ]);
  });

  it('report an empty heading in content[]', () => {
    const text = `${TEXT}\n####`;
    expect(problems({ text })).toEqual([
      `an empty heading in content[] at offset ${text.lastIndexOf('####')}`,
    ]);
  });

  it('report a blank structured title', () => {
    expect(
      problems({
        article: { ...ARTICLE, sections: [{ title: ' ', text: 'Rate ratios IRR shown [1,2].' }] },
      }),
    ).toEqual(['a blank title at articles[0].sections[0].title']);
  });

  it("report a table count off the source's <table-wrap> count, unless expect.json states the difference", () => {
    const article: CorpusArticle = { ...ARTICLE, tables: [] };
    const text = textWithout(/^(#### Tables|##### Table 1|\| 57)/);
    expect(problems({ article, text })).toEqual([
      '1 tables expected (1 <table-wrap> in the source), 0 returned',
    ]);
    expect(problems({ article, text, tablesOverride: 0 })).toEqual([]);
  });

  it('report a content[] table count that disagrees with structuredContent', () => {
    expect(problems({ text: TEXT.replace('#### Tables (1)', '#### Tables (2)') })).toEqual([
      'content[] lists 2 tables, structuredContent 1',
    ]);
  });

  it('report fewer figures than the source holds', () => {
    const article: CorpusArticle = { ...ARTICLE, assets: [SUPPLEMENT] };
    expect(problems({ article, text: textWithout(/^\*figure/) })).toEqual([
      '1 <fig> in the source, 0 figures returned',
    ]);
  });

  it('report fewer supplements than the source holds', () => {
    const article: CorpusArticle = { ...ARTICLE, assets: [FIGURE] };
    expect(problems({ article })).toEqual(['1 <supplementary-material> in the source, 0 returned']);
  });

  it('report a content[] figure count that disagrees with structuredContent', () => {
    expect(problems({ text: textWithout(/^\*figure/) })).toEqual([
      'content[] renders 0 figures, structuredContent 1',
    ]);
  });

  it('report fewer than 95% of the source references', () => {
    const article: CorpusArticle = { ...ARTICLE, references: [] };
    expect(problems({ article, text: textWithout(/^(#### References|- \[R)/) })).toEqual([
      '2 <ref> in the source, 0 references returned',
    ]);
  });

  it('report a content[] reference count that disagrees with structuredContent', () => {
    expect(problems({ text: TEXT.replace('#### References (2)', '#### References (3)') })).toEqual([
      'content[] lists 3 references, structuredContent 2',
    ]);
  });

  it('report words fused across a separating boundary, on either surface', () => {
    expect(problems({ article: withSectionText('Rate ratiosIRR shown [1,2].') })).toEqual([
      'text fused across a JATS boundary: "ratiosIRR"',
    ]);
    expect(problems({ text: TEXT.replace('57 ± 20 · 95', '57 ± 2095') })).toEqual([
      'text fused across a JATS boundary: "2095"',
    ]);
  });

  it('report a zero-gap citation-marker run read as one number', () => {
    expect(problems({ article: withSectionText('Rate ratios IRR shown [12].') })).toEqual([
      'text fused across a JATS boundary: "[12]"',
    ]);
  });

  it('exempt a join at punctuation and a fusion a single source text node already holds', () => {
    const punctuated = SOURCE.replace('<label>Data S1</label>', '<label>Data S1</label><p>.</p>');
    expect(problems({ source: punctuated, text: `${TEXT}\nData S1.` })).toEqual([]);
    const native = SOURCE.replace('</body>', '<p>The ratiosIRR token is literal.</p></body>');
    expect(
      problems({ source: native, article: withSectionText('Rate ratiosIRR shown [1,2].') }),
    ).toEqual([]);
  });
});
