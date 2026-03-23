/**
 * @fileoverview Tests for PMC JATS XML article parser.
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
import type {
  XmlJatsArticle,
  XmlJatsBack,
  XmlJatsBody,
  XmlJatsContribGroup,
} from '@/services/ncbi/types.js';

describe('extractTextContent', () => {
  it('returns empty string for null/undefined', () => {
    expect(extractTextContent(null)).toBe('');
    expect(extractTextContent(undefined)).toBe('');
  });

  it('returns a string directly', () => {
    expect(extractTextContent('hello world')).toBe('hello world');
  });

  it('converts numbers to string', () => {
    expect(extractTextContent(42)).toBe('42');
  });

  it('extracts #text from objects', () => {
    expect(extractTextContent({ '#text': 'content' })).toBe('content');
  });

  it('joins array elements', () => {
    expect(extractTextContent(['hello', 'world'])).toBe('hello world');
  });

  it('recursively extracts from nested objects', () => {
    const node = {
      '#text': 'prefix',
      italic: { '#text': 'emphasized' },
    };
    const result = extractTextContent(node);
    expect(result).toContain('prefix');
    expect(result).toContain('emphasized');
  });

  it('skips @_ attribute keys', () => {
    const node = { '#text': 'content', '@_id': 'sec1' };
    expect(extractTextContent(node)).toBe('content');
  });
});

describe('extractJatsAuthors', () => {
  it('returns empty for undefined', () => {
    expect(extractJatsAuthors(undefined)).toEqual([]);
  });

  it('extracts named authors', () => {
    const group: XmlJatsContribGroup = {
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
    const authors = extractJatsAuthors(group);
    expect(authors).toHaveLength(2);
    expect(authors[0]).toEqual({ lastName: 'Smith', givenNames: 'John' });
  });

  it('extracts collective/group authors', () => {
    const group: XmlJatsContribGroup = {
      contrib: [{ '@_contrib-type': 'author', collab: 'COVID-19 Study Group' }],
    };
    const authors = extractJatsAuthors(group);
    expect(authors).toHaveLength(1);
    expect(authors[0]?.collectiveName).toBe('COVID-19 Study Group');
  });

  it('skips non-author contributors', () => {
    const group: XmlJatsContribGroup = {
      contrib: [
        { '@_contrib-type': 'editor', name: { surname: 'Editor', 'given-names': 'A' } },
        { '@_contrib-type': 'author', name: { surname: 'Author', 'given-names': 'B' } },
      ],
    };
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
    const body: XmlJatsBody = { p: 'Direct paragraph text.' };
    const sections = extractBodySections(body);
    expect(sections).toHaveLength(1);
    expect(sections[0]?.text).toBe('Direct paragraph text.');
  });

  it('extracts titled sections', () => {
    const body: XmlJatsBody = {
      sec: [
        { title: 'Introduction', p: 'Intro text.' },
        { title: 'Methods', p: 'Methods text.' },
      ],
    };
    const sections = extractBodySections(body);
    expect(sections).toHaveLength(2);
    expect(sections[0]?.title).toBe('Introduction');
    expect(sections[0]?.text).toBe('Intro text.');
  });

  it('handles nested subsections', () => {
    const body: XmlJatsBody = {
      sec: [
        {
          title: 'Results',
          p: 'Overview.',
          sec: [{ title: 'Subresult', p: 'Detail.' }],
        },
      ],
    };
    const sections = extractBodySections(body);
    expect(sections[0]?.subsections).toHaveLength(1);
    expect(sections[0]?.subsections?.[0]?.title).toBe('Subresult');
  });
});

describe('extractReferences', () => {
  it('returns empty for undefined', () => {
    expect(extractReferences(undefined)).toEqual([]);
  });

  it('extracts mixed-citation references', () => {
    const back: XmlJatsBack = {
      'ref-list': {
        ref: [
          {
            '@_id': 'ref1',
            label: '1',
            'mixed-citation': 'Smith J et al. Nature 2024.',
          },
        ],
      },
    };
    const refs = extractReferences(back);
    expect(refs).toHaveLength(1);
    expect(refs[0]?.id).toBe('ref1');
    expect(refs[0]?.label).toBe('1');
    expect(refs[0]?.citation).toContain('Smith J');
  });

  it('falls back to element-citation', () => {
    const back: XmlJatsBack = {
      'ref-list': {
        ref: [{ 'element-citation': 'Citation text here.' }],
      },
    };
    const refs = extractReferences(back);
    expect(refs).toHaveLength(1);
    expect(refs[0]?.citation).toBe('Citation text here.');
  });
});

describe('parsePmcArticle', () => {
  it('parses a minimal JATS article', () => {
    const article: XmlJatsArticle = {
      front: {
        'article-meta': {
          'article-id': [
            { '@_pub-id-type': 'pmcid', '#text': 'PMC1234567' },
            { '@_pub-id-type': 'pmid', '#text': '12345' },
            { '@_pub-id-type': 'doi', '#text': '10.1000/test' },
          ],
          'title-group': { 'article-title': 'Test Article Title' },
          'contrib-group': {
            contrib: [
              { '@_contrib-type': 'author', name: { surname: 'Smith', 'given-names': 'J' } },
            ],
          },
        },
      },
      body: {
        sec: [{ title: 'Introduction', p: 'Body text here.' }],
      },
    };

    const result = parsePmcArticle(article);
    expect(result.pmcId).toBe('PMC1234567');
    expect(result.pmid).toBe('12345');
    expect(result.doi).toBe('10.1000/test');
    expect(result.title).toBe('Test Article Title');
    expect(result.authors).toHaveLength(1);
    expect(result.sections).toHaveLength(1);
    expect(result.pmcUrl).toContain('PMC1234567');
    expect(result.pubmedUrl).toContain('12345');
  });

  it('normalizes PMCID without PMC prefix', () => {
    const article: XmlJatsArticle = {
      front: {
        'article-meta': {
          'article-id': [{ '@_pub-id-type': 'pmc-uid', '#text': '1234567' }],
        },
      },
    };
    const result = parsePmcArticle(article);
    expect(result.pmcId).toBe('PMC1234567');
  });

  it('preserves article type attribute', () => {
    const article: XmlJatsArticle = {
      '@_article-type': 'research-article',
      front: {
        'article-meta': {
          'article-id': [{ '@_pub-id-type': 'pmcid', '#text': 'PMC1' }],
        },
      },
    };
    const result = parsePmcArticle(article);
    expect(result.articleType).toBe('research-article');
  });
});
