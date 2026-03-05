/**
 * @fileoverview Tests for the PMC JATS XML article parser.
 * @module tests/services/ncbi/parsing/pmc-article-parser.test
 */
import { describe, expect, it } from 'vitest';

import {
  extractBodySections,
  extractJatsAuthors,
  extractReferences,
  extractTextContent,
  parsePmcArticle,
} from '@/services/ncbi/parsing/pmc-article-parser.js';
import type { XmlJatsArticle, XmlJatsBack, XmlJatsBody } from '@/services/ncbi/types.js';

// ─── extractTextContent ──────────────────────────────────────────────────────

describe('extractTextContent', () => {
  it('returns empty string for null/undefined', () => {
    expect(extractTextContent(null)).toBe('');
    expect(extractTextContent(undefined)).toBe('');
  });

  it('returns string directly', () => {
    expect(extractTextContent('hello world')).toBe('hello world');
  });

  it('returns number as string', () => {
    expect(extractTextContent(42)).toBe('42');
  });

  it('extracts #text from object', () => {
    expect(extractTextContent({ '#text': 'some text' })).toBe('some text');
  });

  it('concatenates #text with child element text', () => {
    const node = {
      '#text': 'This is',
      italic: 'important',
    };
    expect(extractTextContent(node)).toBe('This is important');
  });

  it('skips attribute keys starting with @_', () => {
    const node = {
      '#text': 'hello',
      '@_id': 'sec1',
      '@_sec-type': 'methods',
    };
    expect(extractTextContent(node)).toBe('hello');
  });

  it('handles arrays', () => {
    expect(extractTextContent(['one', 'two', 'three'])).toBe('one two three');
  });

  it('recursively extracts from nested objects', () => {
    const node = {
      '#text': 'We found that',
      xref: { '#text': '[1]' },
      italic: { '#text': 'p < 0.05' },
    };
    const result = extractTextContent(node);
    expect(result).toContain('We found that');
    expect(result).toContain('[1]');
    expect(result).toContain('p < 0.05');
  });

  it('collapses whitespace', () => {
    const node = { '#text': 'hello   world  ' };
    expect(extractTextContent(node)).toBe('hello world');
  });
});

// ─── extractJatsAuthors ──────────────────────────────────────────────────────

describe('extractJatsAuthors', () => {
  it('returns empty array for undefined', () => {
    expect(extractJatsAuthors(undefined)).toEqual([]);
  });

  it('extracts a single author', () => {
    const contribGroup = {
      contrib: {
        '@_contrib-type': 'author',
        name: { surname: 'Smith', 'given-names': 'John' },
      },
    };
    expect(extractJatsAuthors(contribGroup)).toEqual([{ lastName: 'Smith', givenNames: 'John' }]);
  });

  it('extracts multiple authors', () => {
    const contribGroup = {
      contrib: [
        {
          '@_contrib-type': 'author',
          name: { surname: 'Smith', 'given-names': 'John' },
        },
        {
          '@_contrib-type': 'author',
          name: { surname: 'Doe', 'given-names': 'Jane' },
        },
      ],
    };
    const authors = extractJatsAuthors(contribGroup);
    expect(authors).toHaveLength(2);
    expect(authors[0]).toEqual({ lastName: 'Smith', givenNames: 'John' });
    expect(authors[1]).toEqual({ lastName: 'Doe', givenNames: 'Jane' });
  });

  it('skips non-author contributors', () => {
    const contribGroup = {
      contrib: [
        {
          '@_contrib-type': 'author',
          name: { surname: 'Smith', 'given-names': 'John' },
        },
        {
          '@_contrib-type': 'editor',
          name: { surname: 'Editor', 'given-names': 'Bob' },
        },
      ],
    };
    const authors = extractJatsAuthors(contribGroup);
    expect(authors).toHaveLength(1);
    expect(authors[0]!.lastName).toBe('Smith');
  });

  it('handles collective (group) authors', () => {
    const contribGroup = {
      contrib: {
        '@_contrib-type': 'author',
        collab: 'COVID-19 Research Group',
      },
    };
    const authors = extractJatsAuthors(contribGroup);
    expect(authors).toEqual([{ collectiveName: 'COVID-19 Research Group' }]);
  });

  it('handles multiple contrib-groups', () => {
    const contribGroups = [
      { contrib: { '@_contrib-type': 'author', name: { surname: 'A', 'given-names': 'B' } } },
      { contrib: { '@_contrib-type': 'author', name: { surname: 'C', 'given-names': 'D' } } },
    ];
    const authors = extractJatsAuthors(contribGroups);
    expect(authors).toHaveLength(2);
  });
});

// ─── extractBodySections ─────────────────────────────────────────────────────

describe('extractBodySections', () => {
  it('returns empty array for undefined body', () => {
    expect(extractBodySections(undefined)).toEqual([]);
  });

  it('handles body with paragraphs but no sections', () => {
    const body: XmlJatsBody = {
      p: 'This article has no section wrappers.',
    };
    const sections = extractBodySections(body);
    expect(sections).toHaveLength(1);
    expect(sections[0]!.text).toBe('This article has no section wrappers.');
  });

  it('extracts a single section with title and paragraph', () => {
    const body: XmlJatsBody = {
      sec: {
        title: 'Introduction',
        p: 'This is the introduction text.',
      },
    };
    const sections = extractBodySections(body);
    expect(sections).toHaveLength(1);
    expect(sections[0]!.title).toBe('Introduction');
    expect(sections[0]!.text).toBe('This is the introduction text.');
  });

  it('extracts multiple sections', () => {
    const body: XmlJatsBody = {
      sec: [
        { title: 'Introduction', p: 'Intro text.' },
        { title: 'Methods', p: 'Methods text.' },
        { title: 'Results', p: 'Results text.' },
      ],
    };
    const sections = extractBodySections(body);
    expect(sections).toHaveLength(3);
    expect(sections[0]!.title).toBe('Introduction');
    expect(sections[1]!.title).toBe('Methods');
    expect(sections[2]!.title).toBe('Results');
  });

  it('handles nested subsections', () => {
    const body: XmlJatsBody = {
      sec: {
        title: 'Methods',
        p: 'Overview of methods.',
        sec: [
          { title: 'Study Design', p: 'Randomized controlled trial.' },
          { title: 'Participants', p: '100 patients enrolled.' },
        ],
      },
    };
    const sections = extractBodySections(body);
    expect(sections).toHaveLength(1);
    expect(sections[0]!.title).toBe('Methods');
    expect(sections[0]!.subsections).toHaveLength(2);
    expect(sections[0]!.subsections![0]!.title).toBe('Study Design');
    expect(sections[0]!.subsections![1]!.title).toBe('Participants');
  });

  it('handles multiple paragraphs joined with double newline', () => {
    const body: XmlJatsBody = {
      sec: {
        title: 'Discussion',
        p: ['First paragraph.', 'Second paragraph.'],
      },
    };
    const sections = extractBodySections(body);
    expect(sections[0]!.text).toBe('First paragraph.\n\nSecond paragraph.');
  });

  it('skips empty sections', () => {
    const body: XmlJatsBody = {
      sec: [{ title: 'Empty Section' }, { title: 'Has Content', p: 'Some text.' }],
    };
    const sections = extractBodySections(body);
    expect(sections).toHaveLength(1);
    expect(sections[0]!.title).toBe('Has Content');
  });

  it('includes section labels', () => {
    const body: XmlJatsBody = {
      sec: {
        label: '1',
        title: 'Introduction',
        p: 'Text here.',
      },
    };
    const sections = extractBodySections(body);
    expect(sections[0]!.label).toBe('1');
  });
});

// ─── extractReferences ───────────────────────────────────────────────────────

describe('extractReferences', () => {
  it('returns empty array for undefined back', () => {
    expect(extractReferences(undefined)).toEqual([]);
  });

  it('returns empty array when ref-list has no refs', () => {
    const back: XmlJatsBack = { 'ref-list': {} };
    expect(extractReferences(back)).toEqual([]);
  });

  it('extracts references from mixed-citation', () => {
    const back: XmlJatsBack = {
      'ref-list': {
        ref: {
          '@_id': 'ref1',
          label: '1',
          'mixed-citation': 'Smith J, et al. Some article. Nature. 2020;580:123-456.',
        },
      },
    };
    const refs = extractReferences(back);
    expect(refs).toHaveLength(1);
    expect(refs[0]!.id).toBe('ref1');
    expect(refs[0]!.label).toBe('1');
    expect(refs[0]!.citation).toContain('Smith J');
  });

  it('extracts references from element-citation fallback', () => {
    const back: XmlJatsBack = {
      'ref-list': {
        ref: {
          '@_id': 'ref2',
          'element-citation': {
            '#text': 'Article title',
            source: 'Nature',
            year: '2020',
          },
        },
      },
    };
    const refs = extractReferences(back);
    expect(refs).toHaveLength(1);
    expect(refs[0]!.citation).toBeTruthy();
  });

  it('handles multiple references', () => {
    const back: XmlJatsBack = {
      'ref-list': {
        ref: [
          { '@_id': 'r1', 'mixed-citation': 'Reference 1.' },
          { '@_id': 'r2', 'mixed-citation': 'Reference 2.' },
          { '@_id': 'r3', 'mixed-citation': 'Reference 3.' },
        ],
      },
    };
    const refs = extractReferences(back);
    expect(refs).toHaveLength(3);
  });
});

// ─── parsePmcArticle ─────────────────────────────────────────────────────────

describe('parsePmcArticle', () => {
  const minimalArticle: XmlJatsArticle = {
    '@_article-type': 'research-article',
    front: {
      'article-meta': {
        'article-id': [
          { '#text': 'PMC9575052', '@_pub-id-type': 'pmcid' },
          { '#text': '36255726', '@_pub-id-type': 'pmid' },
          { '#text': '10.1234/example', '@_pub-id-type': 'doi' },
        ],
        'title-group': {
          'article-title': 'A Test Article Title',
        },
        'contrib-group': {
          contrib: [
            {
              '@_contrib-type': 'author',
              name: { surname: 'Smith', 'given-names': 'John' },
            },
          ],
        },
        'pub-date': {
          '@_pub-type': 'epub',
          year: '2022',
          month: '10',
          day: '15',
        },
        abstract: {
          p: 'This is the abstract text.',
        },
      },
      'journal-meta': {
        'journal-title-group': { 'journal-title': 'Nature' },
        issn: { '#text': '1234-5678' },
      },
    },
    body: {
      sec: [
        { title: 'Introduction', p: 'Intro paragraph.' },
        { title: 'Methods', p: 'Methods paragraph.' },
      ],
    },
  };

  it('extracts all metadata from a full article', () => {
    const result = parsePmcArticle(minimalArticle);

    expect(result.pmcId).toBe('PMC9575052');
    expect(result.pmid).toBe('36255726');
    expect(result.doi).toBe('10.1234/example');
    expect(result.title).toBe('A Test Article Title');
    expect(result.authors).toHaveLength(1);
    expect(result.authors![0]!.lastName).toBe('Smith');
    expect(result.journal?.title).toBe('Nature');
    expect(result.publicationDate?.year).toBe('2022');
    expect(result.abstract).toBe('This is the abstract text.');
    expect(result.pmcUrl).toBe('https://www.ncbi.nlm.nih.gov/pmc/articles/PMC9575052/');
    expect(result.pubmedUrl).toBe('https://pubmed.ncbi.nlm.nih.gov/36255726/');
    expect(result.articleType).toBe('research-article');
  });

  it('extracts body sections', () => {
    const result = parsePmcArticle(minimalArticle);
    expect(result.sections).toHaveLength(2);
    expect(result.sections[0]!.title).toBe('Introduction');
    expect(result.sections[1]!.title).toBe('Methods');
  });

  it('normalizes PMCID without prefix', () => {
    const article: XmlJatsArticle = {
      front: {
        'article-meta': {
          'article-id': { '#text': '9575052', '@_pub-id-type': 'pmcid' },
        },
      },
    };
    const result = parsePmcArticle(article);
    expect(result.pmcId).toBe('PMC9575052');
  });

  it('handles article with no body', () => {
    const article: XmlJatsArticle = {
      front: {
        'article-meta': {
          'article-id': { '#text': 'PMC1234567', '@_pub-id-type': 'pmcid' },
        },
      },
    };
    const result = parsePmcArticle(article);
    expect(result.sections).toEqual([]);
  });

  it('handles structured abstract with sections', () => {
    const article: XmlJatsArticle = {
      front: {
        'article-meta': {
          'article-id': { '#text': 'PMC1234567', '@_pub-id-type': 'pmcid' },
          abstract: {
            sec: [
              { title: 'Objective', p: 'To test something.' },
              { title: 'Methods', p: 'We did stuff.' },
              { title: 'Results', p: 'Things happened.' },
            ],
          },
        },
      },
    };
    const result = parsePmcArticle(article);
    expect(result.abstract).toContain('Objective: To test something.');
    expect(result.abstract).toContain('Methods: We did stuff.');
    expect(result.abstract).toContain('Results: Things happened.');
  });

  it('extracts keywords', () => {
    const article: XmlJatsArticle = {
      front: {
        'article-meta': {
          'article-id': { '#text': 'PMC1234567', '@_pub-id-type': 'pmcid' },
          'kwd-group': {
            kwd: ['machine learning', 'natural language processing', 'biomedical'],
          },
        },
      },
    };
    const result = parsePmcArticle(article);
    expect(result.keywords).toEqual([
      'machine learning',
      'natural language processing',
      'biomedical',
    ]);
  });

  it('extracts references from back matter', () => {
    const article: XmlJatsArticle = {
      front: {
        'article-meta': {
          'article-id': { '#text': 'PMC1234567', '@_pub-id-type': 'pmcid' },
        },
      },
      back: {
        'ref-list': {
          ref: [
            { '@_id': 'r1', label: '1', 'mixed-citation': 'First reference.' },
            { '@_id': 'r2', label: '2', 'mixed-citation': 'Second reference.' },
          ],
        },
      },
    };
    const result = parsePmcArticle(article);
    expect(result.references).toHaveLength(2);
    expect(result.references![0]!.citation).toBe('First reference.');
  });

  it('omits optional fields when absent', () => {
    const article: XmlJatsArticle = {
      front: {
        'article-meta': {
          'article-id': { '#text': 'PMC1234567', '@_pub-id-type': 'pmcid' },
        },
      },
    };
    const result = parsePmcArticle(article);
    expect(result.pmcId).toBe('PMC1234567');
    expect(result.pmid).toBeUndefined();
    expect(result.doi).toBeUndefined();
    expect(result.title).toBeUndefined();
    expect(result.authors).toBeUndefined();
    expect(result.journal).toBeUndefined();
    expect(result.abstract).toBeUndefined();
    expect(result.keywords).toBeUndefined();
    expect(result.references).toBeUndefined();
  });

  it('falls back to pmc-uid article-id type', () => {
    const article: XmlJatsArticle = {
      front: {
        'article-meta': {
          'article-id': { '#text': '9575052', '@_pub-id-type': 'pmc-uid' },
        },
      },
    };
    const result = parsePmcArticle(article);
    expect(result.pmcId).toBe('PMC9575052');
  });

  it('returns empty pmcId when no article-id matches pmcid or pmc-uid', () => {
    const article: XmlJatsArticle = {
      front: {
        'article-meta': {
          'article-id': { '#text': '12345678', '@_pub-id-type': 'pmid' },
        },
      },
    };
    const result = parsePmcArticle(article);
    // No PMCID found — should be empty, not 'PMC' (bare prefix)
    expect(result.pmcId).toBe('');
  });

  it('extracts affiliations from aff elements', () => {
    const article: XmlJatsArticle = {
      front: {
        'article-meta': {
          'article-id': { '#text': 'PMC1234567', '@_pub-id-type': 'pmcid' },
          aff: [
            { '#text': 'Department of Biology, MIT, Cambridge, MA' },
            { '#text': 'School of Medicine, Harvard, Boston, MA' },
          ],
        },
      },
    };
    const result = parsePmcArticle(article);
    expect(result.affiliations).toHaveLength(2);
    expect(result.affiliations![0]).toContain('MIT');
    expect(result.affiliations![1]).toContain('Harvard');
  });

  it('extracts journal with page range from fpage and lpage', () => {
    const article: XmlJatsArticle = {
      front: {
        'article-meta': {
          'article-id': { '#text': 'PMC1234567', '@_pub-id-type': 'pmcid' },
          volume: '42',
          issue: '3',
          fpage: '100',
          lpage: '115',
        },
        'journal-meta': {
          'journal-title-group': { 'journal-title': 'Nature' },
        },
      },
    };
    const result = parsePmcArticle(article);
    expect(result.journal?.pages).toBe('100-115');
    expect(result.journal?.volume).toBe('42');
    expect(result.journal?.issue).toBe('3');
  });

  it('uses fpage alone when lpage is absent', () => {
    const article: XmlJatsArticle = {
      front: {
        'article-meta': {
          'article-id': { '#text': 'PMC1234567', '@_pub-id-type': 'pmcid' },
          fpage: 'e12345',
        },
        'journal-meta': {
          'journal-title-group': { 'journal-title': 'PLOS ONE' },
        },
      },
    };
    const result = parsePmcArticle(article);
    expect(result.journal?.pages).toBe('e12345');
  });
});

// ─── extractPubDate priority ─────────────────────────────────────────────────

describe('pub-date priority in parsePmcArticle', () => {
  it('prefers epub over ppub', () => {
    const article: XmlJatsArticle = {
      front: {
        'article-meta': {
          'article-id': { '#text': 'PMC1234567', '@_pub-id-type': 'pmcid' },
          'pub-date': [
            { '@_pub-type': 'ppub', year: '2023', month: '6' },
            { '@_pub-type': 'epub', year: '2023', month: '4', day: '15' },
          ],
        },
      },
    };
    const result = parsePmcArticle(article);
    expect(result.publicationDate?.year).toBe('2023');
    expect(result.publicationDate?.month).toBe('4');
    expect(result.publicationDate?.day).toBe('15');
  });

  it('falls back to ppub when epub is absent', () => {
    const article: XmlJatsArticle = {
      front: {
        'article-meta': {
          'article-id': { '#text': 'PMC1234567', '@_pub-id-type': 'pmcid' },
          'pub-date': { '@_pub-type': 'ppub', year: '2022', month: '12' },
        },
      },
    };
    const result = parsePmcArticle(article);
    expect(result.publicationDate?.year).toBe('2022');
    expect(result.publicationDate?.month).toBe('12');
  });

  it('falls back to date-type="pub" when no epub/ppub', () => {
    const article: XmlJatsArticle = {
      front: {
        'article-meta': {
          'article-id': { '#text': 'PMC1234567', '@_pub-id-type': 'pmcid' },
          'pub-date': { '@_date-type': 'pub', year: '2021' },
        },
      },
    };
    const result = parsePmcArticle(article);
    expect(result.publicationDate?.year).toBe('2021');
  });

  it('returns undefined publicationDate when year is absent', () => {
    const article: XmlJatsArticle = {
      front: {
        'article-meta': {
          'article-id': { '#text': 'PMC1234567', '@_pub-id-type': 'pmcid' },
          'pub-date': { '@_pub-type': 'epub', month: '3' },
        },
      },
    };
    const result = parsePmcArticle(article);
    expect(result.publicationDate).toBeUndefined();
  });
});
