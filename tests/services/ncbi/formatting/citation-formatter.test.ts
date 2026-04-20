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

  it('preserves decoded Unicode metadata', () => {
    const article: ParsedArticle = {
      ...sampleArticle,
      title: '\u03b2-catenin in Garc\u00eda-L\u00f3pez cohorts',
      authors: [{ lastName: 'Garc\u00eda-L\u00f3pez', firstName: 'Maria', initials: 'M' }],
      journalInfo: {
        ...sampleArticle.journalInfo!,
        title: 'Revista Cl\u00ednica',
        pages: '45\u201352',
      },
    };
    const citation = formatApa(article);
    expect(citation).toContain('Garc\u00eda-L\u00f3pez, M.');
    expect(citation).toContain('\u03b2-catenin in Garc\u00eda-L\u00f3pez cohorts.');
    expect(citation).toContain('*Revista Cl\u00ednica*');
    expect(citation).toContain('45\u201352');
  });

  it('adds trailing period when last author is collective', () => {
    const article: ParsedArticle = {
      ...sampleArticle,
      authors: [
        { lastName: 'Short', firstName: 'William', initials: 'WR' },
        { collectiveName: 'ACTT-1 Study Group Members' },
      ],
    };
    const citation = formatApa(article);
    expect(citation).toContain('ACTT-1 Study Group Members. (2024).');
    expect(citation).not.toContain('ACTT-1 Study Group Members (2024)');
  });

  it('adds trailing period when the only author is collective', () => {
    const article: ParsedArticle = {
      ...sampleArticle,
      authors: [{ collectiveName: 'ATLAS Collaboration' }],
    };
    const citation = formatApa(article);
    expect(citation).toContain('ATLAS Collaboration. (2024).');
  });

  it('falls back to articleDates year when journal pub date is missing', () => {
    const article: ParsedArticle = {
      pmid: '555',
      title: 'Electronic-only paper.',
      articleDates: [{ dateType: 'Electronic', year: '2023', month: '7' }],
    };
    const citation = formatApa(article);
    expect(citation).toContain('(2023).');
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

  it('uses "p." for a single page and "pp." for a range', () => {
    const single: ParsedArticle = {
      ...sampleArticle,
      journalInfo: { ...sampleArticle.journalInfo!, pages: '42' },
    };
    expect(formatMla(single)).toContain('p. 42');
    expect(formatMla(single)).not.toContain('pp.');

    const range: ParsedArticle = {
      ...sampleArticle,
      journalInfo: { ...sampleArticle.journalInfo!, pages: '42-48' },
    };
    expect(formatMla(range)).toContain('pp. 42-48');
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

  it('strips trailing period from title to avoid double punctuation', () => {
    const article: ParsedArticle = {
      ...sampleArticle,
      title: 'Pembrolizumab versus Chemotherapy for Lung Cancer.',
    };
    const citation = formatBibtex(article);
    expect(citation).toContain('{Pembrolizumab versus Chemotherapy for Lung Cancer}');
    expect(citation).not.toContain('Lung Cancer.}');
  });

  it('maps publication types to BibTeX entry types', () => {
    const book: ParsedArticle = { ...sampleArticle, publicationTypes: ['Book'] };
    expect(formatBibtex(book)).toMatch(/^@book\{/);

    const chapter: ParsedArticle = { ...sampleArticle, publicationTypes: ['Book Chapter'] };
    expect(formatBibtex(chapter)).toMatch(/^@inbook\{/);

    const preprint: ParsedArticle = { ...sampleArticle, publicationTypes: ['Preprint'] };
    expect(formatBibtex(preprint)).toMatch(/^@misc\{/);

    const unknown: ParsedArticle = { ...sampleArticle, publicationTypes: ['Journal Article'] };
    expect(formatBibtex(unknown)).toMatch(/^@article\{/);
  });

  it('emits issn, pmcid, and merged keywords+MeSH', () => {
    const article: ParsedArticle = {
      ...sampleArticle,
      pmcId: 'PMC7654321',
      journalInfo: { ...sampleArticle.journalInfo!, issn: '1078-8956' },
      meshTerms: [
        { descriptorName: 'Humans', isMajorTopic: false },
        { descriptorName: 'CRISPR', isMajorTopic: true }, // duplicate of keyword; dedup
      ],
    };
    const citation = formatBibtex(article);
    expect(citation).toContain('issn');
    expect(citation).toContain('1078-8956');
    expect(citation).toContain('pmcid');
    expect(citation).toContain('PMC7654321');
    expect(citation).toContain('keywords');
    expect(citation).toContain('gene therapy');
    expect(citation).toContain('Humans');
    // Deduplicated — CRISPR should appear once
    expect(citation.match(/CRISPR/g)?.length).toBe(1);
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

  it('splits en-dash page ranges into start and end pages', () => {
    const article: ParsedArticle = {
      ...sampleArticle,
      journalInfo: {
        ...sampleArticle.journalInfo!,
        pages: '45\u201352',
      },
    };
    const citation = formatRis(article);
    expect(citation).toContain('SP  - 45');
    expect(citation).toContain('EP  - 52');
  });

  it('expands PubMed truncated-end page ranges (737-8 → 737/738, 1639-41 → 1639/1641)', () => {
    const short: ParsedArticle = {
      ...sampleArticle,
      journalInfo: { ...sampleArticle.journalInfo!, pages: '737-8' },
    };
    expect(formatRis(short)).toContain('SP  - 737');
    expect(formatRis(short)).toContain('EP  - 738');

    const medium: ParsedArticle = {
      ...sampleArticle,
      journalInfo: { ...sampleArticle.journalInfo!, pages: '1639-41' },
    };
    expect(formatRis(medium)).toContain('SP  - 1639');
    expect(formatRis(medium)).toContain('EP  - 1641');

    // Full ranges unchanged
    const full: ParsedArticle = {
      ...sampleArticle,
      journalInfo: { ...sampleArticle.journalInfo!, pages: '105-116' },
    };
    expect(formatRis(full)).toContain('SP  - 105');
    expect(formatRis(full)).toContain('EP  - 116');
  });

  it('collapses embedded newlines in abstract to single spaces', () => {
    const article: ParsedArticle = {
      ...sampleArticle,
      abstractText: 'BACKGROUND:\n\nFirst paragraph.\n\nRESULTS:\n\nSecond paragraph.',
    };
    const citation = formatRis(article);
    expect(citation).toContain('AB  - BACKGROUND: First paragraph. RESULTS: Second paragraph.');
    // No blank lines inside the record body
    const lines = citation.split('\n');
    const abIndex = lines.findIndex((l) => l.startsWith('AB  -'));
    expect(lines[abIndex + 1]?.startsWith('ER')).toBe(true);
  });

  it('emits SN (ISSN), PMC URL, and merges MeSH into keywords', () => {
    const article: ParsedArticle = {
      ...sampleArticle,
      pmcId: 'PMC7654321',
      journalInfo: { ...sampleArticle.journalInfo!, issn: '1078-8956', eIssn: '1546-170X' },
      meshTerms: [{ descriptorName: 'Humans', isMajorTopic: false }],
    };
    const citation = formatRis(article);
    expect(citation).toContain('SN  - 1078-8956');
    expect(citation).toContain('UR  - https://pmc.ncbi.nlm.nih.gov/articles/PMC7654321/');
    expect(citation).toContain('KW  - Humans');
    expect(citation).toContain('KW  - gene therapy');
  });

  it('maps publication types to RIS reference types', () => {
    const book: ParsedArticle = { ...sampleArticle, publicationTypes: ['Book'] };
    expect(formatRis(book)).toMatch(/^TY {2}- BOOK/);

    const chapter: ParsedArticle = { ...sampleArticle, publicationTypes: ['Book Chapter'] };
    expect(formatRis(chapter)).toMatch(/^TY {2}- CHAP/);

    const preprint: ParsedArticle = { ...sampleArticle, publicationTypes: ['Preprint'] };
    expect(formatRis(preprint)).toMatch(/^TY {2}- GEN/);

    const unknown: ParsedArticle = { ...sampleArticle, publicationTypes: ['Journal Article'] };
    expect(formatRis(unknown)).toMatch(/^TY {2}- JOUR/);
  });

  it('falls back to e-ISSN when print ISSN is missing', () => {
    const article: ParsedArticle = {
      ...sampleArticle,
      journalInfo: { ...sampleArticle.journalInfo!, issn: undefined, eIssn: '1546-170X' },
    };
    expect(formatRis(article)).toContain('SN  - 1546-170X');
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
