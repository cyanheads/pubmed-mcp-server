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
  extractReferences,
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
