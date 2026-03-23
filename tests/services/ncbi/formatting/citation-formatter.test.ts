/**
 * @fileoverview Tests for citation formatting (APA, MLA, BibTeX, RIS).
 * @module tests/services/ncbi/formatting/citation-formatter.test
 */

import { describe, expect, it } from 'vitest';
import {
  formatApa,
  formatBibtex,
  formatCitation,
  formatCitations,
  formatMla,
  formatRis,
} from '@/services/ncbi/formatting/citation-formatter.js';
import type { ParsedArticle } from '@/services/ncbi/types.js';

const sampleArticle: ParsedArticle = {
  pmid: '12345678',
  title: 'A Novel Approach to Gene Therapy',
  authors: [
    { lastName: 'Smith', firstName: 'John', initials: 'J' },
    { lastName: 'Doe', firstName: 'Jane', initials: 'JA' },
    { lastName: 'Johnson', firstName: 'Robert', initials: 'RB' },
  ],
  abstractText: 'This is the abstract.',
  journalInfo: {
    title: 'Nature Medicine',
    isoAbbreviation: 'Nat Med',
    volume: '30',
    issue: '5',
    pages: '123-130',
    publicationDate: { year: '2024', month: 'May' },
  },
  doi: '10.1038/s41591-024-00001-0',
  keywords: ['gene therapy', 'CRISPR'],
  publicationTypes: ['Journal Article'],
};

const minimalArticle: ParsedArticle = {
  pmid: '99999',
};

describe('formatApa', () => {
  it('formats a full article', () => {
    const citation = formatApa(sampleArticle);
    expect(citation).toContain('Smith, J.');
    expect(citation).toContain('Doe, J. A.');
    expect(citation).toContain('(2024).');
    expect(citation).toContain('A Novel Approach to Gene Therapy.');
    expect(citation).toContain('*Nature Medicine*');
    expect(citation).toContain('*30*(5)');
    expect(citation).toContain('123-130');
    expect(citation).toContain('https://doi.org/10.1038/s41591-024-00001-0');
  });

  it('handles articles with no date', () => {
    const citation = formatApa(minimalArticle);
    expect(citation).toContain('(n.d.).');
  });

  it('handles collective/group authors', () => {
    const article: ParsedArticle = {
      ...sampleArticle,
      authors: [{ collectiveName: 'WHO Study Group' }],
    };
    const citation = formatApa(article);
    expect(citation).toContain('WHO Study Group');
  });

  it('handles 2 authors with ampersand', () => {
    const article: ParsedArticle = {
      ...sampleArticle,
      authors: [
        { lastName: 'Smith', initials: 'J' },
        { lastName: 'Doe', initials: 'J' },
      ],
    };
    const citation = formatApa(article);
    expect(citation).toContain('Smith, J., & Doe, J.');
  });
});

describe('formatMla', () => {
  it('formats a full article', () => {
    const citation = formatMla(sampleArticle);
    expect(citation).toContain('Smith, John');
    expect(citation).toContain('et al.');
    expect(citation).toContain('"A Novel Approach to Gene Therapy."');
    expect(citation).toContain('*Nature Medicine*');
    expect(citation).toContain('vol. 30');
    expect(citation).toContain('no. 5');
    expect(citation).toContain('pp. 123-130');
  });

  it('handles 2 authors with "and"', () => {
    const article: ParsedArticle = {
      ...sampleArticle,
      authors: [
        { lastName: 'Smith', firstName: 'John' },
        { lastName: 'Doe', firstName: 'Jane' },
      ],
    };
    const citation = formatMla(article);
    expect(citation).toContain('Smith, John, and Jane Doe.');
  });
});

describe('formatBibtex', () => {
  it('generates valid BibTeX entry', () => {
    const citation = formatBibtex(sampleArticle);
    expect(citation).toMatch(/^@article\{pmid12345678,/);
    expect(citation).toContain('author');
    expect(citation).toContain('{Smith}, John');
    expect(citation).toContain('title');
    expect(citation).toContain('journal');
    expect(citation).toContain('year');
    expect(citation).toContain('volume');
    expect(citation).toContain('doi');
    expect(citation).toContain('pmid');
    expect(citation).toMatch(/\}$/);
  });

  it('escapes special LaTeX characters in titles', () => {
    const article: ParsedArticle = {
      ...sampleArticle,
      title: 'A & B: Effects of $100 on #1 Priority',
    };
    const citation = formatBibtex(article);
    expect(citation).toContain('\\&');
    expect(citation).toContain('\\$');
    expect(citation).toContain('\\#');
  });
});

describe('formatRis', () => {
  it('generates valid RIS record', () => {
    const citation = formatRis(sampleArticle);
    expect(citation).toMatch(/^TY {2}- JOUR/);
    expect(citation).toContain('AU  - Smith, John');
    expect(citation).toContain('AU  - Doe, Jane');
    expect(citation).toContain('TI  - A Novel Approach to Gene Therapy');
    expect(citation).toContain('JF  - Nature Medicine');
    expect(citation).toContain('JO  - Nat Med');
    expect(citation).toContain('PY  - 2024');
    expect(citation).toContain('VL  - 30');
    expect(citation).toContain('IS  - 5');
    expect(citation).toContain('SP  - 123');
    expect(citation).toContain('EP  - 130');
    expect(citation).toContain('DO  - 10.1038/s41591-024-00001-0');
    expect(citation).toContain('KW  - gene therapy');
    expect(citation).toContain('KW  - CRISPR');
    expect(citation).toContain('AB  - This is the abstract.');
    expect(citation).toMatch(/ER {2}- $/);
  });
});

describe('formatCitation', () => {
  it('dispatches to the correct formatter', () => {
    expect(formatCitation(sampleArticle, 'apa')).toBe(formatApa(sampleArticle));
    expect(formatCitation(sampleArticle, 'mla')).toBe(formatMla(sampleArticle));
    expect(formatCitation(sampleArticle, 'bibtex')).toBe(formatBibtex(sampleArticle));
    expect(formatCitation(sampleArticle, 'ris')).toBe(formatRis(sampleArticle));
  });
});

describe('formatCitations', () => {
  it('returns a record keyed by style', () => {
    const result = formatCitations(sampleArticle, ['apa', 'bibtex']);
    expect(Object.keys(result)).toEqual(['apa', 'bibtex']);
    expect(result.apa).toBe(formatApa(sampleArticle));
    expect(result.bibtex).toBe(formatBibtex(sampleArticle));
  });
});
