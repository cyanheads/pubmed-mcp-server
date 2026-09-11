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
  formatVancouver,
} from '@/services/ncbi/formatting/citation-formatter.js';
import { parseArticleSet } from '@/services/ncbi/parsing/article-parser.js';
import type { ParsedArticle } from '@/services/ncbi/types.js';
import {
  ADA_WHOLE_BOOK_XML,
  articleSetXml,
  GENEREVIEWS_CHAPTER_XML,
  LACTMED_CHAPTER_XML,
  NAP_WHOLE_BOOK_XML,
  parseArticleSetXml,
} from '../parsing/_book-fixtures.js';

const sampleArticle: ParsedArticle = {
  recordType: 'journal-article',
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
  recordType: 'journal-article',
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

  it('preserves Unicode-letter initials (\u00c1, \u00d6, \u00c9, \u00df)', () => {
    const article: ParsedArticle = {
      ...sampleArticle,
      authors: [
        { lastName: 'Del Pozo', firstName: '\u00c1ngela', initials: '\u00c1' },
        { lastName: 'M\u00fcller', firstName: '\u00d6mer', initials: '\u00d6' },
        { lastName: 'Dupont', firstName: '\u00c9lise', initials: '\u00c9M' },
      ],
    };
    const citation = formatApa(article);
    expect(citation).toContain('Del Pozo, \u00c1.');
    expect(citation).toContain('M\u00fcller, \u00d6.');
    expect(citation).toContain('Dupont, \u00c9. M.');
    expect(citation).not.toMatch(/,\s*,/);
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
      recordType: 'journal-article',
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

    // A Bookshelf chapter is never labelled "Book Chapter" by PubMed — its
    // publication type is Review or Study Guide — so the entry type comes from
    // `recordType`, which a publication-type map cannot supply. (#114)
    const chapter: ParsedArticle = {
      ...sampleArticle,
      recordType: 'book-chapter',
      publicationTypes: ['Review'],
      book: { title: 'Cancer Medicine', publisher: 'B.C. Decker Inc.' },
    };
    expect(formatBibtex(chapter)).toMatch(/^@incollection\{/);

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

    // As with BibTeX, CHAP comes from `recordType` — PubMed never labels a
    // Bookshelf chapter "Book Chapter". (#114)
    const chapter: ParsedArticle = {
      ...sampleArticle,
      recordType: 'book-chapter',
      publicationTypes: ['Review'],
      book: { title: 'Cancer Medicine', publisher: 'B.C. Decker Inc.' },
    };
    expect(formatRis(chapter)).toMatch(/^TY {2}- CHAP/);

    const preprint: ParsedArticle = { ...sampleArticle, publicationTypes: ['Preprint'] };
    expect(formatRis(preprint)).toMatch(/^TY {2}- GEN/);

    const unknown: ParsedArticle = { ...sampleArticle, publicationTypes: ['Journal Article'] };
    expect(formatRis(unknown)).toMatch(/^TY {2}- JOUR/);
  });

  it('falls back to e-ISSN when print ISSN is missing', () => {
    const { issn: _issn, ...journalInfo } = sampleArticle.journalInfo!;
    const article: ParsedArticle = {
      ...sampleArticle,
      journalInfo: { ...journalInfo, eIssn: '1546-170X' },
    };
    expect(formatRis(article)).toContain('SN  - 1546-170X');
  });
});

describe('formatVancouver', () => {
  it('formats a full article in ICMJE/NLM style', () => {
    const citation = formatVancouver(sampleArticle);
    // Authors: surname + initials, no periods, comma-separated; all listed (≤6)
    expect(citation).toContain('Smith J, Doe JA, Johnson RB.');
    expect(citation).toContain('A Novel Approach to Gene Therapy.');
    // NLM journal abbreviation, not the full title
    expect(citation).toContain('Nat Med.');
    expect(citation).not.toContain('Nature Medicine');
    // Year;Volume(Issue):Pages
    expect(citation).toContain('2024;30(5):123-130.');
    // DOI in NLM "doi: " form
    expect(citation).toContain('doi: 10.1038/s41591-024-00001-0');
  });

  it('lists all authors for six or fewer', () => {
    const authors = Array.from({ length: 6 }, (_, i) => ({
      lastName: `Auth${i + 1}`,
      initials: 'AB',
    }));
    const citation = formatVancouver({ ...sampleArticle, authors });
    expect(citation).toContain('Auth1 AB, Auth2 AB, Auth3 AB, Auth4 AB, Auth5 AB, Auth6 AB.');
    expect(citation).not.toContain('et al.');
  });

  it('truncates to the first six authors plus "et al." for seven or more', () => {
    const authors = Array.from({ length: 7 }, (_, i) => ({
      lastName: `Auth${i + 1}`,
      initials: 'AB',
    }));
    const citation = formatVancouver({ ...sampleArticle, authors });
    expect(citation).toContain('Auth6 AB, et al.');
    expect(citation).not.toContain('Auth7');
  });

  it('renders initials without periods (Surname AB, not A. B.)', () => {
    const citation = formatVancouver({
      ...sampleArticle,
      authors: [{ lastName: 'Jumper', firstName: 'John Michael', initials: 'JM' }],
    });
    expect(citation).toContain('Jumper JM.');
  });

  it('derives initials from firstName when the initials field is absent', () => {
    const citation = formatVancouver({
      ...sampleArticle,
      authors: [{ lastName: 'Lee', firstName: 'Mary-Anne' }],
    });
    expect(citation).toContain('Lee MA.');
  });

  it('falls back to the full journal title when no ISO abbreviation is present', () => {
    const { isoAbbreviation: _isoAbbreviation, ...journalInfo } = sampleArticle.journalInfo!;
    const article: ParsedArticle = { ...sampleArticle, journalInfo };
    expect(formatVancouver(article)).toContain('Nature Medicine.');
  });

  it('uses a collective/group author name directly', () => {
    const citation = formatVancouver({
      ...sampleArticle,
      authors: [{ collectiveName: 'WHO Study Group' }],
    });
    expect(citation).toContain('WHO Study Group.');
  });

  it('omits the DOI segment when no DOI is present', () => {
    const { doi: _doi, ...article } = sampleArticle;
    expect(formatVancouver(article)).not.toContain('doi:');
  });

  it('handles a date-only article without crashing', () => {
    expect(typeof formatVancouver(minimalArticle)).toBe('string');
  });
});

describe('electronic article locators', () => {
  // PMID 39060015 as NCBI returns it: no Pagination element, a pii locator in
  // ELocationID, and the DOI beside it.
  const locatorArticle: ParsedArticle = {
    recordType: 'journal-article',
    pmid: '39060015',
    title:
      'Benralizumab for allergic asthma: a randomised, double-blind, placebo-controlled trial.',
    authors: [{ lastName: 'Sehmi', firstName: 'Roma', initials: 'R' }],
    journalInfo: {
      title: 'The European respiratory journal',
      isoAbbreviation: 'Eur Respir J',
      eIssn: '1399-3003',
      volume: '64',
      issue: '3',
      elocationId: '2400512',
      elocationIdType: 'pii',
      publicationDate: { year: '2024', month: 'Sep' },
    },
    doi: '10.1183/13993003.00512-2024',
  };

  /** Same record with the locator fields absent entirely, not set to undefined. */
  const {
    elocationId: _elocationId,
    elocationIdType: _elocationIdType,
    ...unlocatedJournal
  } = locatorArticle.journalInfo!;

  it('formatVancouver appends the locator as a trailing NLM note, not in the colon slot', () => {
    expect(formatVancouver(locatorArticle)).toBe(
      'Sehmi R. Benralizumab for allergic asthma: a randomised, double-blind, placebo-controlled trial. Eur Respir J. 2024;64(3). pii: 2400512. doi: 10.1183/13993003.00512-2024',
    );
  });

  it('formatVancouver labels a non-pii locator with its own type', () => {
    const citation = formatVancouver({
      ...locatorArticle,
      journalInfo: { ...locatorArticle.journalInfo, elocationIdType: 'pmcid' },
    });
    expect(citation).toContain('2024;64(3). pmcid: 2400512.');
  });

  it('formatApa puts "Article <value>" in the page slot', () => {
    expect(formatApa(locatorArticle)).toContain(
      '*The European respiratory journal*, *64*(3), Article 2400512.',
    );
  });

  it('formatMla puts "art. <value>" in the page slot', () => {
    const citation = formatMla(locatorArticle);
    expect(citation).toContain('art. 2400512');
    expect(citation).not.toContain('pp.');
    expect(citation).not.toContain('p. 2400512');
  });

  it('formatBibtex emits eid and no pages field', () => {
    const citation = formatBibtex(locatorArticle);
    expect(citation).toContain('eid');
    expect(citation).toContain('{2400512}');
    expect(citation).not.toMatch(/^\s*pages\s/m);
  });

  it('formatRis emits C7 and no SP/EP', () => {
    const citation = formatRis(locatorArticle);
    expect(citation).toContain('C7  - 2400512');
    expect(citation).not.toContain('SP  -');
    expect(citation).not.toContain('EP  -');
  });

  it('renders pagination, not the locator, when a record carries both', () => {
    // PLoS ONE and Scientific Reports report the article number as pagination
    // *and* as an ELocationID. Output must be identical to the pages-only case.
    const pagesOnly: ParsedArticle = {
      ...locatorArticle,
      journalInfo: { ...unlocatedJournal, pages: 'e0300123' },
    };
    const both: ParsedArticle = {
      ...locatorArticle,
      journalInfo: {
        ...locatorArticle.journalInfo,
        pages: 'e0300123',
        elocationId: 'e0300123',
      },
    };
    expect(formatVancouver(both)).toBe(formatVancouver(pagesOnly));
    expect(formatApa(both)).toBe(formatApa(pagesOnly));
    expect(formatMla(both)).toBe(formatMla(pagesOnly));
    expect(formatBibtex(both)).toBe(formatBibtex(pagesOnly));
    expect(formatRis(both)).toBe(formatRis(pagesOnly));
  });

  it('renders neither a page nor a locator when the record carries neither', () => {
    const neither: ParsedArticle = { ...locatorArticle, journalInfo: unlocatedJournal };
    expect(formatVancouver(neither)).toContain('2024;64(3). doi:');
    expect(formatApa(neither)).toContain('*64*(3).');
    expect(formatApa(neither)).not.toContain('Article');
    expect(formatMla(neither)).not.toContain('art.');
    expect(formatBibtex(neither)).not.toContain('eid');
    expect(formatRis(neither)).not.toContain('C7  -');
  });
});

describe('paginated records render byte-identically across every style', () => {
  // Locked byte-for-byte: a record that carries real `pages` must be unaffected
  // by electronic-article-locator handling, whether or not a locator is also
  // present. Any diff here is a regression, not a formatting preference.
  it('formatApa', () => {
    expect(formatApa(sampleArticle)).toBe(
      'Smith, J., Doe, J. A., & Johnson, R. B. (2024). A Novel Approach to Gene Therapy. *Nature Medicine*, *30*(5), 123-130. https://doi.org/10.1038/s41591-024-00001-0',
    );
  });

  it('formatMla', () => {
    expect(formatMla(sampleArticle)).toBe(
      'Smith, John, et al. "A Novel Approach to Gene Therapy." *Nature Medicine*, vol. 30, no. 5, 2024, pp. 123-130. https://doi.org/10.1038/s41591-024-00001-0.',
    );
  });

  it('formatBibtex', () => {
    expect(formatBibtex(sampleArticle)).toBe(
      [
        '@article{pmid12345678,',
        '  author   = {{Smith}, John and {Doe}, Jane and {Johnson}, Robert},',
        '  title    = {{A Novel Approach to Gene Therapy}},',
        '  journal  = {Nature Medicine},',
        '  year     = {2024},',
        '  volume   = {30},',
        '  number   = {5},',
        '  pages    = {123-130},',
        '  doi      = {10.1038/s41591-024-00001-0},',
        '  pmid     = {12345678},',
        '  keywords = {{gene therapy}, {CRISPR}}',
        '}',
      ].join('\n'),
    );
  });

  it('formatRis', () => {
    expect(formatRis(sampleArticle)).toBe(
      [
        'TY  - JOUR',
        'AU  - Smith, John',
        'AU  - Doe, Jane',
        'AU  - Johnson, Robert',
        'TI  - A Novel Approach to Gene Therapy',
        'JF  - Nature Medicine',
        'JO  - Nat Med',
        'PY  - 2024',
        'VL  - 30',
        'IS  - 5',
        'SP  - 123',
        'EP  - 130',
        'DO  - 10.1038/s41591-024-00001-0',
        'AN  - 12345678',
        'UR  - https://pubmed.ncbi.nlm.nih.gov/12345678/',
        'KW  - gene therapy',
        'KW  - CRISPR',
        'AB  - This is the abstract.',
        'ER  - ',
      ].join('\n'),
    );
  });

  it('formatVancouver', () => {
    expect(formatVancouver(sampleArticle)).toBe(
      'Smith J, Doe JA, Johnson RB. A Novel Approach to Gene Therapy. Nat Med. 2024;30(5):123-130. doi: 10.1038/s41591-024-00001-0',
    );
  });
});

describe('formatCitation', () => {
  it('dispatches to the correct formatter', () => {
    expect(formatCitation(sampleArticle, 'apa')).toBe(formatApa(sampleArticle));
    expect(formatCitation(sampleArticle, 'mla')).toBe(formatMla(sampleArticle));
    expect(formatCitation(sampleArticle, 'bibtex')).toBe(formatBibtex(sampleArticle));
    expect(formatCitation(sampleArticle, 'ris')).toBe(formatRis(sampleArticle));
    expect(formatCitation(sampleArticle, 'vancouver')).toBe(formatVancouver(sampleArticle));
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

// ─── Bookshelf records (#114) ────────────────────────────────────────────────
//
// Records come from real EFetch bodies through the production parser, so a
// formatter expectation here is an expectation about what NCBI actually ships.

describe('Bookshelf records (#114)', () => {
  const record = (xml: string): ParsedArticle => {
    const parsed = parseArticleSet(parseArticleSetXml(articleSetXml(xml)))[0];
    if (!parsed) throw new Error('fixture did not parse');
    return parsed;
  };

  /** Chapter with its own authors inside an edited book. */
  const geneReviews = () => record(GENEREVIEWS_CHAPTER_XML);
  /** Chapter with no authors and no editors anywhere. */
  const lactMed = () => record(LACTMED_CHAPTER_XML);
  /** Whole book, no authors, no editors. */
  const adaBook = () => record(ADA_WHOLE_BOOK_XML);
  /** Whole book with a collective author and two ISBNs. */
  const napBook = () => record(NAP_WHOLE_BOOK_XML);

  describe('formatVancouver', () => {
    it('follows NLM Citing Medicine Ch. 22 §C for a chapter in an edited book', () => {
      expect(formatVancouver(geneReviews())).toBe(
        'Petrucelli N, Daly MB, Pal T. BRCA1- and BRCA2-Associated Hereditary Breast and Ovarian Cancer. ' +
          'In: Adam MP, Bick S, Mirzaa GM, Wallace SE, Amemiya A, editors. GeneReviews® [Internet]. ' +
          'Seattle (WA): University of Washington, Seattle; 1993-2026. ' +
          'Available from: https://www.ncbi.nlm.nih.gov/books/NBK1247/',
      );
    });

    it('keeps the In: form for a chapter with no editors', () => {
      const citation = formatVancouver(lactMed());
      expect(citation).toBe(
        'Carboplatin. In: Drugs and Lactation Database (LactMed®) [Internet]. ' +
          'Bethesda (MD): National Institute of Child Health and Human Development; 2006. ' +
          'Available from: https://www.ncbi.nlm.nih.gov/books/NBK500577/',
      );
    });

    it('renders a whole book without an In: or a duplicated title', () => {
      const citation = formatVancouver(adaBook());
      expect(citation).not.toContain('In:');
      expect(citation).toBe(
        'A Practical Guide to Hypoglycemia: New Approaches to Overcoming a Persistent Barrier to ' +
          'Optimal Glycemic Management. Arlington (VA): American Diabetes Association; 2026. ' +
          'Available from: https://www.ncbi.nlm.nih.gov/books/NBK624619/',
      );
    });

    it('omits [cited] and extent rather than fabricating them', () => {
      const citation = formatVancouver(geneReviews());
      expect(citation).not.toContain('[cited');
      expect(citation).not.toContain('p.]');
    });
  });

  describe('formatApa', () => {
    it('uses the chapter-in-edited-book form', () => {
      expect(formatApa(geneReviews())).toBe(
        'Petrucelli, N., Daly, M. B., & Pal, T. (1993). ' +
          'BRCA1- and BRCA2-Associated Hereditary Breast and Ovarian Cancer. ' +
          'In M. P. Adam, S. Bick, G. M. Mirzaa, S. E. Wallace, & A. Amemiya (Eds.), *GeneReviews®*. ' +
          'University of Washington, Seattle. https://www.ncbi.nlm.nih.gov/books/NBK1247/',
      );
    });

    it('takes the date from the book rather than falling through to n.d.', () => {
      expect(formatApa(lactMed())).toContain('(2006).');
      expect(formatApa(adaBook())).toContain('(2026).');
      expect(formatApa(adaBook())).not.toContain('n.d.');
    });

    it('prefers the DOI over the Bookshelf URL when the record has one', () => {
      expect(formatApa(napBook())).toContain('https://doi.org/10.17226/29416');
      expect(formatApa(napBook())).not.toContain('ncbi.nlm.nih.gov/books');
    });

    it('renders a whole book as title, publisher, URL', () => {
      // APA 7 §9.12: a record crediting neither authors nor editors puts the
      // title in the author position, unitalicized, with the year after it —
      // never opening on the date. (#139)
      expect(formatApa(adaBook())).toBe(
        'A Practical Guide to Hypoglycemia: New Approaches to Overcoming a Persistent ' +
          'Barrier to Optimal Glycemic Management. (2026). American Diabetes Association. ' +
          'https://doi.org/10.2337/db20261',
      );
    });

    it('puts a chapter title in the author position when nothing else credits it (#139)', () => {
      expect(formatApa(lactMed())).toBe(
        'Carboplatin. (2006). In *Drugs and Lactation Database (LactMed®)*. ' +
          'National Institute of Child Health and Human Development. ' +
          'https://www.ncbi.nlm.nih.gov/books/NBK500577/',
      );
    });

    it('keeps a chapter title in the author position when only the book has editors (#139)', () => {
      // The editor position belongs to the book. A chapter crediting no author
      // of its own still opens on its title, with the editors in the `In …`
      // clause where APA 7 §10.3 puts them.
      const chapterUnderEditedBook = record(
        LACTMED_CHAPTER_XML.replace(
          '<Medium>Internet</Medium>',
          '<Medium>Internet</Medium><AuthorList Type="editors" CompleteYN="Y">' +
            '<Author ValidYN="Y"><LastName>Adam</LastName><ForeName>Margaret P</ForeName>' +
            '<Initials>MP</Initials></Author></AuthorList>',
        ),
      );

      expect(chapterUnderEditedBook.authors).toEqual([]);
      expect(formatApa(chapterUnderEditedBook)).toBe(
        'Carboplatin. (2006). In M. P. Adam (Ed.), *Drugs and Lactation Database (LactMed®)*. ' +
          'National Institute of Child Health and Human Development. ' +
          'https://www.ncbi.nlm.nih.gov/books/NBK500577/',
      );
    });

    it('leaves the author position alone when a contributor exists (#139)', () => {
      // The title moves up only when nothing else credits the record.
      expect(formatApa(geneReviews())).toMatch(/^Petrucelli, N\./);
      expect(formatApa(napBook())).toMatch(/^National Academies of Sciences/);
    });
  });

  describe('formatMla', () => {
    it('uses the chapter form with edited by', () => {
      expect(formatMla(geneReviews())).toBe(
        'Petrucelli, Nancie, et al. "BRCA1- and BRCA2-Associated Hereditary Breast and Ovarian Cancer." ' +
          '*GeneReviews®*, edited by Margaret P Adam, et al., University of Washington, Seattle, 1993.',
      );
    });

    it('drops the edited-by clause when there are no editors', () => {
      const citation = formatMla(lactMed());
      expect(citation).not.toContain('edited by');
      expect(citation).toBe(
        '"Carboplatin." *Drugs and Lactation Database (LactMed®)*, ' +
          'National Institute of Child Health and Human Development, 2006.',
      );
    });

    it('italicizes the title of a whole book instead of quoting it', () => {
      const citation = formatMla(napBook());
      expect(citation).toContain('*AI Infrastructure to Accelerate AI Convergence');
      expect(citation).not.toContain('"AI Infrastructure');
    });
  });

  describe('formatBibtex', () => {
    it('emits @incollection for a chapter, with booktitle, editor, publisher and address', () => {
      const bibtex = formatBibtex(geneReviews());
      expect(bibtex).toMatch(/^@incollection\{pmid20301425,/);
      expect(bibtex).toContain('booktitle = {GeneReviews®}');
      expect(bibtex).toContain('publisher = {University of Washington, Seattle}');
      expect(bibtex).toContain('address   = {Seattle (WA)}');
      expect(bibtex).toContain('editor    = {{Adam}, Margaret P and {Bick}, Sarah');
      expect(bibtex).not.toContain('journal');
    });

    it('emits @book for a whole-book record, with every ISBN', () => {
      const bibtex = formatBibtex(napBook());
      expect(bibtex).toMatch(/^@book\{pmid42691195,/);
      expect(bibtex).toContain('isbn      = {9780309605397, 0309605393}');
      expect(bibtex).not.toContain('booktitle');
    });

    it('emits @incollection for a chapter with no authors at all', () => {
      const bibtex = formatBibtex(lactMed());
      expect(bibtex).toMatch(/^@incollection\{pmid29999637,/);
      expect(bibtex).not.toContain('author');
      expect(bibtex).not.toContain('editor');
    });
  });

  describe('formatRis', () => {
    it('emits TY - CHAP with BT, A2, PB and CY for a chapter', () => {
      const ris = formatRis(geneReviews());
      expect(ris).toContain('TY  - CHAP');
      expect(ris).toContain(
        'TI  - BRCA1- and BRCA2-Associated Hereditary Breast and Ovarian Cancer',
      );
      expect(ris).toContain('BT  - GeneReviews®');
      expect(ris).toContain('A2  - Adam, Margaret P');
      expect(ris).toContain('PB  - University of Washington, Seattle');
      expect(ris).toContain('CY  - Seattle (WA)');
      expect(ris).toContain('UR  - https://www.ncbi.nlm.nih.gov/books/NBK1247/');
      expect(ris).not.toContain('JF  - ');
      expect(ris).toMatch(/ER {2}- $/);
    });

    it('emits TY - BOOK with the ISBNs and no duplicated BT for a whole book', () => {
      const ris = formatRis(napBook());
      expect(ris).toContain('TY  - BOOK');
      expect(ris).toContain('SN  - 9780309605397');
      expect(ris).toContain('SN  - 0309605393');
      expect(ris).not.toContain('BT  - ');
    });

    it('emits a usable record for a whole book with no contributors', () => {
      const ris = formatRis(adaBook());
      expect(ris).toContain('TY  - BOOK');
      expect(ris).not.toContain('AU  - ');
      expect(ris).not.toContain('A2  - ');
      expect(ris).toContain('PY  - 2026');
    });
  });

  describe('a whole book credited to its editors', () => {
    /**
     * No sampled record pairs a whole book with an editor list, so one is built
     * from the ADA book by adding the DTD-permitted `Book/AuthorList
     * Type="editors"`. APA 7 puts editors in the author position when a work
     * has no authors of its own.
     */
    const withEditors = (...editors: { forename: string; initials: string; last: string }[]) =>
      record(
        ADA_WHOLE_BOOK_XML.replace(
          '</PubDate>',
          `</PubDate><AuthorList Type="editors" CompleteYN="Y">${editors
            .map(
              (e) =>
                `<Author ValidYN="Y"><LastName>${e.last}</LastName><ForeName>${e.forename}</ForeName><Initials>${e.initials}</Initials></Author>`,
            )
            .join('')}</AuthorList>`,
        ),
      );

    const ADA_TITLE =
      '*A Practical Guide to Hypoglycemia: New Approaches to Overcoming a Persistent Barrier to Optimal Glycemic Management*.';

    it('puts a single editor in the author position with (Ed.)', () => {
      const article = withEditors({ forename: 'Margaret P', initials: 'MP', last: 'Adam' });
      expect(article.authors).toEqual([]);
      expect(formatApa(article)).toBe(
        `Adam, M. P. (Ed.). (2026). ${ADA_TITLE} American Diabetes Association. https://doi.org/10.2337/db20261`,
      );
    });

    it('uses (Eds.) for more than one editor', () => {
      const article = withEditors(
        { forename: 'Margaret P', initials: 'MP', last: 'Adam' },
        { forename: 'Sarah', initials: 'S', last: 'Bick' },
      );
      expect(formatApa(article)).toBe(
        `Adam, M. P., & Bick, S. (Eds.). (2026). ${ADA_TITLE} American Diabetes Association. https://doi.org/10.2337/db20261`,
      );
    });

    it('falls through to the title position when the book credits nobody', () => {
      // The editor position is for a book that has editors; with neither
      // authors nor editors the title takes the author position instead of the
      // reference opening on the year. (#139)
      expect(formatApa(adaBook())).toMatch(/^A Practical Guide to Hypoglycemia/);
      expect(formatApa(adaBook())).not.toContain('(Ed.)');
      expect(formatApa(adaBook())).not.toContain(ADA_TITLE);
    });
  });

  describe('a chapter does not borrow the book-level DOI', () => {
    /** No sampled chapter carries a `Book/ELocationID`, so one is added. */
    const chapterUnderDoiBook = () =>
      record(
        GENEREVIEWS_CHAPTER_XML.replace(
          '<Medium>Internet</Medium>',
          '<ELocationID EIdType="doi">10.1093/genereviews.book</ELocationID><Medium>Internet</Medium>',
        ),
      );

    /** The ADA book with its own DOI removed, leaving only the book-level one. */
    const bookWithOnlyBookDoi = () =>
      record(ADA_WHOLE_BOOK_XML.replace('<ArticleId IdType="doi">10.2337/db20261</ArticleId>', ''));

    it('resolves a chapter to the Bookshelf URL, not the book DOI', () => {
      const chapter = chapterUnderDoiBook();
      expect(chapter.book?.doi).toBe('10.1093/genereviews.book');
      expect(chapter.doi).toBeUndefined();

      const apa = formatApa(chapter);
      expect(apa).not.toContain('10.1093/genereviews.book');
      expect(apa).toContain('https://www.ncbi.nlm.nih.gov/books/NBK1247/');
    });

    it('omits the BibTeX doi field and the RIS DO tag for such a chapter', () => {
      const chapter = chapterUnderDoiBook();
      expect(formatBibtex(chapter)).not.toContain('doi');
      expect(formatRis(chapter)).not.toContain('DO  - ');
    });

    it('still falls back to the book DOI on a whole-book record', () => {
      const book = bookWithOnlyBookDoi();
      expect(book.doi).toBeUndefined();
      expect(book.book?.doi).toBe('10.2337/db20261');
      expect(formatApa(book)).toContain('https://doi.org/10.2337/db20261');
      expect(formatBibtex(book)).toContain('doi       = {10.2337/db20261}');
      expect(formatRis(book)).toContain('DO  - 10.2337/db20261');
    });
  });

  it('dispatches every style without throwing on the no-contributor shapes', () => {
    for (const article of [lactMed(), adaBook()]) {
      const citations = formatCitations(article, ['apa', 'mla', 'bibtex', 'ris', 'vancouver']);
      for (const [style, text] of Object.entries(citations)) {
        expect(text.length, style).toBeGreaterThan(0);
      }
    }
  });
});
