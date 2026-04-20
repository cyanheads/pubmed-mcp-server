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
});
