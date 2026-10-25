/**
 * @fileoverview Tests for citation formatting (APA, MLA, BibTeX, RIS).
 * @module tests/services/ncbi/formatting/citation-formatter.test
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
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
import { readCommonMark } from '../../../_helpers.js';
import { PMC_FIXTURES_DIR } from '../../../corpus/fixtures.js';
import { PUBMED_FIXTURES_DIR } from '../../../corpus/pubmed-fixtures.js';
import {
  ADA_WHOLE_BOOK_XML,
  articleSetXml,
  ENDOTEXT_CHAPTER_XML,
  GENEREVIEWS_ALZHEIMER_CHAPTER_XML,
  GENEREVIEWS_CHAPTER_XML,
  JOURNAL_ARTICLE_XML,
  LACTMED_CHAPTER_XML,
  NAP_WHOLE_BOOK_XML,
  NICE_WHOLE_BOOK_XML,
  PROBE_REPORTS_CHAPTER_XML,
  parseArticleSetXml,
} from '../parsing/_book-fixtures.js';
import {
  ERRATUM_NOTE_ARTICLE_XML,
  PUBLISHED_ERRATUM_XML,
  RETRACTED_ARTICLE_XML,
  RETRACTION_NOTICE_XML,
} from '../parsing/_comments-corrections-fixtures.js';
import { NO_PAGINATION_XML, NONE_PAGINATION_XML } from '../parsing/_pagination-fixtures.js';
import { FRENCK_JR_XML, HORMUTH_2ND_XML } from '../parsing/_suffix-fixtures.js';

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
    expect(citation).toContain('123\u{2013}130');
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
    // Year;Volume(Issue):Pages, the range elided in Citing Medicine form (#253)
    expect(citation).toContain('2024;30(5):123-30.');
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
      '*The European Respiratory Journal*, *64*(3), Article 2400512.',
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
    // *and* as an ELocationID. Vancouver, BibTeX, and RIS print it once, as the
    // pages-only case does; APA and MLA cite it as the article number it is. (#217)
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
    expect(formatApa(both)).toContain('*64*(3), Article e0300123.');
    expect(formatApa(pagesOnly)).toContain('*64*(3), e0300123.');
    expect(formatMla(both)).toContain('vol. 64, no. 3, 2024, art. e0300123.');
    expect(formatMla(pagesOnly)).toContain('vol. 64, no. 3, 2024, p. e0300123.');
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
      'Smith, J., Doe, J. A., & Johnson, R. B. (2024). A Novel Approach to Gene Therapy. *Nature Medicine*, *30*(5), 123\u{2013}130. https://doi.org/10.1038/s41591-024-00001-0',
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
      'Smith J, Doe JA, Johnson RB. A Novel Approach to Gene Therapy. Nat Med. 2024;30(5):123-30. doi: 10.1038/s41591-024-00001-0',
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
          '1998 Sep 4 [updated 2026 Mar 25]. ' +
          'In: Adam MP, Bick S, Mirzaa GM, Wallace SE, Amemiya A, editors. GeneReviews® [Internet]. ' +
          'Seattle (WA): University of Washington, Seattle; 1993-2026. ' +
          'Available from: https://www.ncbi.nlm.nih.gov/books/NBK1247/',
      );
    });

    it('keeps the In: form for a chapter with no editors', () => {
      const citation = formatVancouver(lactMed());
      expect(citation).toBe(
        'Carboplatin. 2026 Aug 15. In: Drugs and Lactation Database (LactMed®) [Internet]. ' +
          'Bethesda (MD): National Institute of Child Health and Human Development; 2006-. ' +
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
        'Petrucelli, N., Daly, M. B., & Pal, T. (2026). ' +
          'BRCA1- and BRCA2-Associated Hereditary Breast and Ovarian Cancer. ' +
          'In M. P. Adam, S. Bick, G. M. Mirzaa, S. E. Wallace, & A. Amemiya (Eds.), *GeneReviews®*. ' +
          'University of Washington, Seattle. https://www.ncbi.nlm.nih.gov/books/NBK1247/',
      );
    });

    it('dates a record from the chapter or the book rather than falling through to n.d.', () => {
      expect(formatApa(lactMed())).toContain('(2026).');
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
        'Carboplatin. (2026). In *Drugs and Lactation Database (LactMed®)*. ' +
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
        'Carboplatin. (2026). In M. P. Adam (Ed.), *Drugs and Lactation Database (LactMed®)*. ' +
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
          '*GeneReviews®*, edited by Margaret P Adam, et al., University of Washington, Seattle, 25 Mar. 2026.',
      );
    });

    it('drops the edited-by clause when there are no editors', () => {
      const citation = formatMla(lactMed());
      expect(citation).not.toContain('edited by');
      expect(citation).toBe(
        '"Carboplatin." *Drugs and Lactation Database (LactMed®)*, ' +
          'National Institute of Child Health and Human Development, 15 Aug. 2026.',
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

  it('cites the record title in every style on the no-contributor shapes', () => {
    for (const article of [lactMed(), adaBook()]) {
      const title = article.title ?? '';
      expect(title).not.toBe('');
      const citations = formatCitations(article, ['apa', 'mla', 'bibtex', 'ris', 'vancouver']);
      expect(Object.keys(citations)).toHaveLength(5);
      for (const [style, text] of Object.entries(citations)) {
        expect(text, `${article.pmid} ${style}`).toContain(title);
      }
    }
  });
});

// ─── Bookshelf chapter dates (#189) ──────────────────────────────────────────
//
// A chapter is cited by its own date — `DateRevised` when present, otherwise
// `ContributionDate` — never by the year its containing book began. The
// containing book's date survives only in Vancouver's container.

describe('Bookshelf chapter dates (#189)', () => {
  const record = (xml: string): ParsedArticle => {
    const parsed = parseArticleSet(parseArticleSetXml(articleSetXml(xml)))[0];
    if (!parsed) throw new Error('fixture did not parse');
    return parsed;
  };
  const ALL = ['apa', 'mla', 'bibtex', 'ris', 'vancouver'] as const;

  /** PMID 20301340: contributed 1998-10-23, revised 2018-12-20, book 1993–2026. */
  const alzheimer = () => record(GENEREVIEWS_ALZHEIMER_CHAPTER_XML);
  /** PMID 25905212: contributed 2025-07-03, open-ended book from 2000. */
  const endotext = () => record(ENDOTEXT_CHAPTER_XML);
  /** PMID 21634080: contributed 2009-09-01, revised 2011-02-10, open-ended book from 2010. */
  const probeReport = () => record(PROBE_REPORTS_CHAPTER_XML);

  /** Endotext with its `ContributionDate` replaced by the given inner XML. */
  const endotextContributed = (inner: string) =>
    record(
      ENDOTEXT_CHAPTER_XML.replace(
        '<ContributionDate><Year>2025</Year><Month>7</Month><Day>3</Day></ContributionDate>',
        `<ContributionDate>${inner}</ContributionDate>`,
      ),
    );

  const bibtexYear = (bibtex: string) => /^ {2}year\s+= \{(\d{4})\},?$/m.exec(bibtex)?.[1];

  describe('PMID 20301340 — a revised GeneReviews chapter', () => {
    it('cites the revision year in APA, BibTeX, and RIS', () => {
      const article = alzheimer();
      expect(formatApa(article)).toBe(
        'Bird, T. D. (2018). Alzheimer Disease Overview. ' +
          'In M. P. Adam, S. Bick, G. M. Mirzaa, S. E. Wallace, & A. Amemiya (Eds.), *GeneReviews®*. ' +
          'University of Washington, Seattle. https://www.ncbi.nlm.nih.gov/books/NBK1161/',
      );
      expect(bibtexYear(formatBibtex(article))).toBe('2018');
      const ris = formatRis(article);
      expect(ris).toContain('PY  - 2018\nDA  - 2018/12/20\n');
      expect(ris).not.toContain('PY  - 1993');
    });

    it('cites the full revision date in MLA, abbreviating the month', () => {
      expect(formatMla(alzheimer())).toBe(
        'Bird, Thomas D. "Alzheimer Disease Overview." *GeneReviews®*, edited by Margaret P Adam, ' +
          'et al., University of Washington, Seattle, 20 Dec. 2018.',
      );
    });

    it('puts the contribution and update dates after the chapter title in Vancouver', () => {
      expect(formatVancouver(alzheimer())).toBe(
        'Bird TD. Alzheimer Disease Overview. 1998 Oct 23 [updated 2018 Dec 20]. In: Adam MP, Bick S, ' +
          'Mirzaa GM, Wallace SE, Amemiya A, editors. GeneReviews® [Internet]. Seattle (WA): University ' +
          'of Washington, Seattle; 1993-2026. Available from: https://www.ncbi.nlm.nih.gov/books/NBK1161/',
      );
    });
  });

  describe('PMID 25905212 — an Endotext chapter in an open-ended book', () => {
    it('cites the contribution date when the chapter was never revised', () => {
      const article = endotext();
      expect(formatApa(article)).toBe(
        'Persani, L., Lania, A., & Beck-Peccoz, P. (2025). Thyrotropin-Secreting Pituitary Adenomas. ' +
          'In K. R. Feingold, R. A. Adler, S. F. Ahmed, B. Anawalt, M. R. Blackman, G. Chrousos, & ' +
          'E. Corpas (Eds.), *Endotext*. MDText.com, Inc. https://www.ncbi.nlm.nih.gov/books/NBK278978/',
      );
      expect(formatMla(article)).toBe(
        'Persani, Luca, et al. "Thyrotropin-Secreting Pituitary Adenomas." *Endotext*, edited by ' +
          'Kenneth R Feingold, et al., MDText.com, Inc., 3 July 2025.',
      );
      expect(bibtexYear(formatBibtex(article))).toBe('2025');
      expect(formatRis(article)).toContain('PY  - 2025\nDA  - 2025/07/03\n');
    });

    it('writes the open-ended book range as `2000-` in the Vancouver container', () => {
      expect(formatVancouver(endotext())).toBe(
        'Persani L, Lania A, Beck-Peccoz P. Thyrotropin-Secreting Pituitary Adenomas. 2025 Jul 3. ' +
          'In: Feingold KR, Adler RA, Ahmed SF, Anawalt B, Blackman MR, Chrousos G, et al., editors. ' +
          'Endotext [Internet]. South Dartmouth (MA): MDText.com, Inc.; 2000-. ' +
          'Available from: https://www.ncbi.nlm.nih.gov/books/NBK278978/',
      );
    });

    it('never doubles the period after a publisher that already ends in one', () => {
      for (const style of ALL) {
        expect(formatCitations(endotext(), [style])[style], style).not.toContain('Inc..');
      }
    });
  });

  describe('PMID 21634080 — a chapter contributed before its book began', () => {
    it('cites the revision, not the earlier contribution or the later book start', () => {
      const article = probeReport();
      expect(formatApa(article)).toMatch(/^Lopez, M\., .* & Cuddy, M\. \(2011\)\. Antagonists/);
      expect(formatMla(article)).toMatch(
        /, National Center for Biotechnology Information \(US\), 10 Feb\. 2011\.$/,
      );
      expect(bibtexYear(formatBibtex(article))).toBe('2011');
      expect(formatRis(article)).toContain('PY  - 2011\nDA  - 2011/02/10\n');
    });

    it('renders both dates and the open-ended container in Vancouver', () => {
      expect(formatVancouver(probeReport())).toBe(
        'Lopez M, Welsh K, Yuan H, Stonich D, Su Y, Garcia X, et al. Antagonists of IAP-family ' +
          'anti-apoptotic proteins - Probe 2. 2009 Sep 1 [updated 2011 Feb 10]. In: Probe Reports from ' +
          'the NIH Molecular Libraries Program [Internet]. Bethesda (MD): National Center for ' +
          'Biotechnology Information (US); 2010-. Available from: https://www.ncbi.nlm.nih.gov/books/NBK55068/',
      );
    });

    it('marks a revision-only chapter as updated in Vancouver', () => {
      const revisedOnly = record(
        PROBE_REPORTS_CHAPTER_XML.replace(
          '<ContributionDate><Year>2009</Year><Month>9</Month><Day>1</Day></ContributionDate>',
          '',
        ),
      );
      expect(formatVancouver(revisedOnly)).toContain('Probe 2. [updated 2011 Feb 10]. In: ');
      expect(formatApa(revisedOnly)).toContain('(2011).');
    });
  });

  describe('partial chapter dates render only the parts they have', () => {
    it('renders a year and month', () => {
      const article = endotextContributed('<Year>2025</Year><Month>7</Month>');
      expect(formatApa(article)).toContain('(2025).');
      expect(formatMla(article)).toMatch(/, MDText\.com, Inc\., July 2025\.$/);
      expect(formatRis(article)).toContain('PY  - 2025\nDA  - 2025/07\n');
      expect(formatVancouver(article)).toContain('Adenomas. 2025 Jul. In: ');
    });

    it('renders a year alone', () => {
      const article = endotextContributed('<Year>2025</Year>');
      expect(formatMla(article)).toMatch(/, MDText\.com, Inc\., 2025\.$/);
      expect(formatRis(article)).toContain('PY  - 2025\nDA  - 2025\n');
      expect(formatVancouver(article)).toContain('Adenomas. 2025. In: ');
    });

    it('drops a non-numeric month and its day rather than guessing them', () => {
      const article = endotextContributed('<Year>2025</Year><Month>Spring</Month><Day>3</Day>');
      expect(formatMla(article)).toMatch(/, MDText\.com, Inc\., 2025\.$/);
      expect(formatRis(article)).toContain('DA  - 2025\n');
      expect(formatVancouver(article)).toContain('Adenomas. 2025. In: ');
    });

    it.each([
      [1, 'Jan.', 'Jan'],
      [2, 'Feb.', 'Feb'],
      [3, 'Mar.', 'Mar'],
      [4, 'Apr.', 'Apr'],
      [5, 'May', 'May'],
      [6, 'June', 'Jun'],
      [7, 'July', 'Jul'],
      [8, 'Aug.', 'Aug'],
      [9, 'Sept.', 'Sep'],
      [10, 'Oct.', 'Oct'],
      [11, 'Nov.', 'Nov'],
      [12, 'Dec.', 'Dec'],
    ])('month %i reads %s in MLA and %s in Vancouver', (month, mla, vancouver) => {
      const article = endotextContributed(`<Year>2025</Year><Month>${month}</Month><Day>9</Day>`);
      expect(formatMla(article)).toMatch(new RegExp(`, 9 ${mla.replace('.', '\\.')} 2025\\.$`));
      expect(formatVancouver(article)).toContain(`Adenomas. 2025 ${vancouver} 9. In: `);
      expect(formatRis(article)).toContain(`DA  - 2025/${String(month).padStart(2, '0')}/09\n`);
    });
  });

  describe('records whose dates do not change', () => {
    it('keeps the whole-book record 40825089 on its own publication year in every style', () => {
      const citations = formatCitations(record(NICE_WHOLE_BOOK_XML), [...ALL]);
      expect(citations.apa).toBe(
        'Dapagliflozin for treating chronic kidney disease. (2025). National Institute for Health ' +
          'and Care Excellence (NICE). https://www.ncbi.nlm.nih.gov/books/NBK617223/',
      );
      expect(citations.mla).toBe(
        '*Dapagliflozin for treating chronic kidney disease*, National Institute for Health and ' +
          'Care Excellence (NICE), 2025.',
      );
      expect(bibtexYear(citations.bibtex ?? '')).toBe('2025');
      expect(citations.ris).toContain('PY  - 2025\n');
      expect(citations.ris).not.toContain('DA  - ');
      expect(citations.vancouver).toBe(
        'Dapagliflozin for treating chronic kidney disease. London: National Institute for Health ' +
          'and Care Excellence (NICE); 2025. Available from: https://www.ncbi.nlm.nih.gov/books/NBK617223/',
      );
    });

    it('falls back to the book year for a chapter carrying neither date', () => {
      const undated = record(
        GENEREVIEWS_ALZHEIMER_CHAPTER_XML.replace(/<ContributionDate>.*<\/DateRevised>/, ''),
      );
      expect(undated.articleDates).toBeUndefined();
      const citations = formatCitations(undated, [...ALL]);
      expect(citations.apa).toBe(
        'Bird, T. D. (1993). Alzheimer Disease Overview. ' +
          'In M. P. Adam, S. Bick, G. M. Mirzaa, S. E. Wallace, & A. Amemiya (Eds.), *GeneReviews®*. ' +
          'University of Washington, Seattle. https://www.ncbi.nlm.nih.gov/books/NBK1161/',
      );
      expect(citations.mla).toMatch(/, University of Washington, Seattle, 1993\.$/);
      expect(bibtexYear(citations.bibtex ?? '')).toBe('1993');
      expect(citations.ris).toContain('PY  - 1993\n');
      expect(citations.ris).not.toContain('DA  - ');
      expect(citations.vancouver).toBe(
        'Bird TD. Alzheimer Disease Overview. In: Adam MP, Bick S, Mirzaa GM, Wallace SE, Amemiya A, ' +
          'editors. GeneReviews® [Internet]. Seattle (WA): University of Washington, Seattle; ' +
          '1993-2026. Available from: https://www.ncbi.nlm.nih.gov/books/NBK1161/',
      );
    });

    it('keeps a journal article on its journal date with no RIS DA line', () => {
      const citations = formatCitations(record(JOURNAL_ARTICLE_XML), [...ALL]);
      expect(citations.apa).toContain('Lall, R. (2026). Paramedic analgesia');
      expect(citations.mla).toContain('vol. 30, no. 57, 2026, pp. 1-32.');
      expect(bibtexYear(citations.bibtex ?? '')).toBe('2026');
      expect(citations.ris).toContain('PY  - 2026\n');
      expect(citations.ris).not.toContain('DA  - ');
      expect(citations.vancouver).toContain('Health Technol Assess. 2026;30(57):1-32.');
    });
  });

  describe('a publisher that already ends in a period, on every book path', () => {
    /** Endotext with no chapter or book date, so the publisher ends the MLA detail run. */
    const undatedEndotext = () =>
      record(
        ENDOTEXT_CHAPTER_XML.replace(
          '<ContributionDate><Year>2025</Year><Month>7</Month><Day>3</Day></ContributionDate>',
          '',
        )
          .replace('<PubDate><Year>2000</Year></PubDate>', '')
          .replace('<BeginningDate><Year>2000</Year></BeginningDate>', ''),
      );

    it('ends APA, MLA, and Vancouver on a single period', () => {
      const article = undatedEndotext();
      expect(formatApa(article)).toContain('(n.d.). Thyrotropin-Secreting Pituitary Adenomas. In ');
      expect(formatApa(article)).toContain('*Endotext*. MDText.com, Inc. https://');
      expect(formatMla(article)).toMatch(
        /, edited by Kenneth R Feingold, et al\., MDText\.com, Inc\.$/,
      );
      expect(formatVancouver(article)).toContain(
        'South Dartmouth (MA): MDText.com, Inc. Available from: ',
      );
      for (const style of ALL) {
        expect(formatCitations(article, [style])[style], style).not.toContain('Inc..');
      }
    });
  });
});

// ─── APA and MLA journal conventions (#217) ──────────────────────────────────
//
// NLM catalogs a journal name in sentence case, elides a page range's end, and
// copies an article number into `MedlinePgn`. APA and MLA cite the name in
// title case and an article number as one; APA writes a range in full with an
// en dash. Vancouver, BibTeX, and RIS keep NLM's own values.

describe('APA and MLA journal conventions (#217)', () => {
  /** A real PubMed record from the corpus, through the production parser. */
  const corpusRecord = (pmid: string): ParsedArticle => {
    const xml = readFileSync(join(PUBMED_FIXTURES_DIR, `pmid${pmid}`, 'source.xml'), 'utf8');
    const parsed = parseArticleSet(parseArticleSetXml(xml))[0];
    if (!parsed) throw new Error(`corpus record ${pmid} did not parse`);
    return parsed;
  };
  const record = (xml: string): ParsedArticle => {
    const parsed = parseArticleSet(parseArticleSetXml(articleSetXml(xml)))[0];
    if (!parsed) throw new Error('fixture did not parse');
    return parsed;
  };

  /** PMID 34026693 — `MedlinePgn` 662953 equals `ELocationID` pii 662953. */
  const frontiers = () => corpusRecord('34026693');
  /** PMID 38869518 — `MedlinePgn` 42 equals pii 42, a Springer article number. */
  const aminoAcids = () => corpusRecord('38869518');
  /** PMID 34116029 — `865-878.e8`, a pii that is not the pagination, keyword case repeats. */
  const gastro = () => corpusRecord('34116029');
  /** PMID 9500320 — elided `637-41`, no non-DOI locator. */
  const lancet1998 = () => record(RETRACTED_ARTICLE_XML);
  /** PMID 20137807 — a single page, 445, beside a DOI-typed `ELocationID` only. */
  const lancet2010 = () => record(RETRACTION_NOTICE_XML);

  /** The italicized journal name APA prints for a record carrying only that name. */
  const apaJournal = (title: string) =>
    /\*(.+)\*/.exec(
      formatApa({ recordType: 'journal-article', pmid: '1', journalInfo: { title } }),
    )?.[1];
  const mlaJournal = (title: string) =>
    /\*(.+)\*/.exec(
      formatMla({ recordType: 'journal-article', pmid: '1', journalInfo: { title } }),
    )?.[1];

  it("keeps Vancouver, BibTeX, and RIS on NLM's journal name and pagination", () => {
    const article = frontiers();
    expect(formatVancouver(article)).toContain(
      'Front Pediatr. 2021;9:662953. doi: 10.3389/fped.2021.662953',
    );
    expect(formatBibtex(article)).toMatch(/^ {2}journal\s+= \{Frontiers in pediatrics\},$/m);
    expect(formatBibtex(article)).toMatch(/^ {2}pages\s+= \{662953\},$/m);
    expect(formatBibtex(article)).not.toMatch(/^ {2}eid\s/m);
    expect(formatRis(article)).toContain('JF  - Frontiers in pediatrics\n');
    expect(formatRis(article)).toContain('SP  - 662953\n');
    expect(formatRis(article)).not.toContain('C7  -');

    const elided = lancet1998();
    expect(formatVancouver(elided)).toContain('Lancet. 1998;351(9103):637-41.');
    // BibTeX writes the elided range in full, as RIS does (#228)
    expect(formatBibtex(elided)).toMatch(/^ {2}pages\s+= \{637-641\},$/m);
    expect(formatRis(elided)).toContain('SP  - 637\nEP  - 641\n');
  });

  it('keeps a page that matches no non-DOI locator as a page in APA and MLA', () => {
    const notice = lancet2010();
    expect(formatApa(notice)).toContain('*Lancet*, *375*(9713), 445.');
    expect(formatMla(notice)).toContain('vol. 375, no. 9713, 2010, p. 445.');

    // PMID 39964127: a Lancet page, 2413, whose pii is the article's own S-number.
    const lancetPage: ParsedArticle = {
      ...sampleArticle,
      journalInfo: {
        ...sampleArticle.journalInfo!,
        pages: '2413',
        elocationId: 'S0140-6736(24)02673-4',
        elocationIdType: 'pii',
      },
    };
    expect(formatApa(lancetPage)).toContain('*30*(5), 2413.');
    expect(formatApa(lancetPage)).not.toContain('Article');
    expect(formatMla(lancetPage)).toContain('2024, p. 2413.');
    expect(formatMla(lancetPage)).not.toContain('art.');
  });

  it("keeps NLM's page text in MLA, which elides a range itself", () => {
    expect(formatMla(lancet1998())).toContain('vol. 351, no. 9103, 1998, pp. 637-41.');
    expect(formatMla(gastro())).toContain('vol. 161, no. 3, 2021, pp. 865-878.e8.');
  });

  it("writes an APA page range with an en dash and NLM's elided end expanded", () => {
    expect(formatApa(lancet1998())).toContain('*Lancet*, *351*(9103), 637\u{2013}641.');
    expect(formatApa(gastro())).toContain('*Gastroenterology*, *161*(3), 865\u{2013}878.e8.');
  });

  it('cites pagination equal to the non-DOI locator as an article number in APA and MLA', () => {
    expect(formatApa(frontiers())).toContain('*Frontiers in Pediatrics*, *9*, Article 662953.');
    expect(formatMla(frontiers())).toContain(
      '*Frontiers in Pediatrics*, vol. 9, 2021, art. 662953.',
    );
    expect(formatApa(aminoAcids())).toContain('*Amino Acids*, *56*(1), Article 42.');
    expect(formatMla(aminoAcids())).toContain('vol. 56, no. 1, 2024, art. 42.');
    expect(formatMla(aminoAcids())).not.toContain('p. 42');
  });

  it("title-cases the journal name in APA and MLA without touching NLM's own casing", () => {
    const cases: [string, string][] = [
      ['Frontiers in pediatrics', 'Frontiers in Pediatrics'],
      ['Annales de dermatologie et de venereologie', 'Annales de Dermatologie et de Venereologie'],
      ['Disease-a-month : DM', 'Disease-a-Month : DM'],
      ['Brain : a journal of neurology', 'Brain : A Journal of Neurology'],
      ['PloS one', 'PloS One'],
      ['Cellular & molecular biology letters', 'Cellular & Molecular Biology Letters'],
      [
        'Angewandte Chemie (International ed. in English)',
        'Angewandte Chemie (International Ed. in English)',
      ],
      // NLM's place qualifier is dropped before casing (#227)
      ['Health technology assessment (Winchester, England)', 'Health Technology Assessment'],
      ['Lancet (London, England)', 'Lancet'],
      [
        'Proceedings of the National Academy of Sciences of the United States of America',
        'Proceedings of the National Academy of Sciences of the United States of America',
      ],
      ['eLife', 'eLife'],
      ['mBio', 'mBio'],
      ['JAMA', 'JAMA'],
      ['iScience', 'iScience'],
    ];
    for (const [nlm, titleCase] of cases) {
      expect(apaJournal(nlm), nlm).toBe(titleCase);
      expect(mlaJournal(nlm), nlm).toBe(titleCase);
    }
  });

  it('applies that rule to every journal title in the corpus', () => {
    // readdirSync's order is the filesystem's; sort so the pins below line up
    const pubmedTitles = readdirSync(PUBMED_FIXTURES_DIR)
      .sort()
      .map((dir) => corpusRecord(dir.replace(/^pmid/, '')).journalInfo?.title ?? '');
    const pmcTitles = readdirSync(PMC_FIXTURES_DIR).map(
      (dir) =>
        /<journal-title>([^<]+)<\/journal-title>/.exec(
          readFileSync(join(PMC_FIXTURES_DIR, dir, 'source.xml'), 'utf8'),
        )?.[1] ?? '',
    );
    expect(pubmedTitles).toHaveLength(6);
    expect(pmcTitles).toHaveLength(9);

    /** A word part the rule may capitalize: lowercase letters, apostrophes inside. */
    const lowercaseWord = /^[^\p{L}\p{N}]*\p{Ll}+(?:['\u{2019}]\p{Ll}+)*[^\p{L}\p{N}]*$/u;
    for (const title of [...pubmedTitles, ...pmcTitles]) {
      expect(title).not.toBe('');
      for (const cased of [apaJournal(title), mlaJournal(title)]) {
        const before = title.split(/([\s-]+)/);
        const after = (cased ?? '').split(/([\s-]+)/);
        expect(after, title).toHaveLength(before.length);
        before.forEach((word, i) => {
          const result = after[i];
          if (result === word) return;
          // Only an all-lowercase word changes, and only its first letter
          expect(word, title).toMatch(lowercaseWord);
          expect(result?.toLowerCase(), title).toBe(word);
          expect(result?.replace(/^[^\p{L}]*\p{Lu}/u, ''), title).toBe(
            word.replace(/^[^\p{L}]*\p{Ll}/u, ''),
          );
        });
      }
    }

    // NLM's sentence-case names gain capitals; PMC's publisher-cased ones keep theirs
    expect(pubmedTitles.map(apaJournal)).toEqual([
      'Cellular & Molecular Biology Letters',
      'Frontiers in Pediatrics',
      'Gastroenterology',
      'Medicine',
      'Amino Acids',
      'Heliyon',
    ]);
    expect(pmcTitles.map(apaJournal)).toEqual(pmcTitles);
  });

  it('lowercases a preposition longer than three letters in MLA only', () => {
    expect(apaJournal('Notes from the field')).toBe('Notes From the Field');
    expect(mlaJournal('Notes from the field')).toBe('Notes from the Field');
  });

  it('drops a keyword that repeats an earlier one ignoring case, keeping the first spelling', () => {
    const article = gastro();
    const bibtex = formatBibtex(article);
    expect(bibtex).toContain('{Deep learning}');
    expect(bibtex).toContain('{Risk assessment}');
    expect(bibtex).not.toContain('{Deep Learning}');
    expect(bibtex).not.toContain('{Risk Assessment}');
    const ris = formatRis(article);
    expect(ris).toContain('KW  - Deep learning\n');
    expect(ris).toContain('KW  - Risk assessment\n');
    expect(ris).not.toContain('KW  - Deep Learning\n');
    expect(ris).not.toContain('KW  - Risk Assessment\n');

    const mixed: ParsedArticle = {
      ...sampleArticle,
      keywords: ['CRISPR', 'gene therapy'],
      meshTerms: [
        { descriptorName: 'Gene Therapy', isMajorTopic: true },
        { descriptorName: 'Humans', isMajorTopic: false },
        { descriptorName: 'crispr', isMajorTopic: false },
      ],
    };
    expect(formatBibtex(mixed)).toContain('keywords = {{CRISPR}, {gene therapy}, {Humans}}');
    expect(formatRis(mixed)).toContain('KW  - CRISPR\nKW  - gene therapy\nKW  - Humans\nAB  -');
  });
});

// ─── NLM journal qualifiers in APA and MLA (#227) ────────────────────────────
//
// NLM's `Journal/Title` appends a place, year, or edition to tell same-named
// journals apart (`Lancet (London, England)`). The journal prints no such text,
// so APA and MLA drop it; any other parenthetical names the journal and stays.
// Vancouver, BibTeX, and RIS keep NLM's own values.

describe('NLM journal qualifiers in APA and MLA (#227)', () => {
  /** The italicized journal name APA and MLA print for a record carrying only its journal. */
  const citedJournal = (title: string, isoAbbreviation?: string) => {
    const article: ParsedArticle = {
      recordType: 'journal-article',
      pmid: '1',
      journalInfo: { title, ...(isoAbbreviation && { isoAbbreviation }) },
    };
    return [formatApa(article), formatMla(article)].map(
      (citation) => /\*(.+)\*/.exec(citation)?.[1],
    );
  };

  // Each row is NLM's `Title` and `ISOAbbreviation` for that journal.
  it.each([
    // PMIDs 9500320, 42855198, 42848938, 42796427, 42817577
    ['Lancet (London, England)', 'Lancet', 'Lancet'],
    ['BMJ (Clinical research ed.)', 'BMJ', 'BMJ'],
    ['Science (New York, N.Y.)', 'Science', 'Science'],
    ['Medicina (Kaunas, Lithuania)', 'Medicina (Kaunas)', 'Medicina'],
    ['Sensors (Basel, Switzerland)', 'Sensors (Basel)', 'Sensors'],
    // A place with a year, a year alone, a format; title case applies to what remains
    ['Life (Chicago, Ill. : 1978)', 'Life', 'Life'],
    ["Journal of women's health (2002)", 'J Womens Health (Larchmt)', "Journal of Women's Health"],
    ['Psychiatric bulletin (2014)', 'Psychiatr Bull (2014)', 'Psychiatric Bulletin'],
    ['Freshwater science (Print)', 'Freshw Sci', 'Freshwater Science'],
    ['African review (Dar es Salaam, Tanzania)', 'Afr Rev', 'African Review'],
    [
      'Health technology assessment (Winchester, England)',
      'Health Technol Assess',
      'Health Technology Assessment',
    ],
  ])('drops the qualifier from %s', (title, iso, cited) => {
    expect(citedJournal(title, iso)).toEqual([cited, cited]);
  });

  it.each([
    // An issuing body names a generic title: PMIDs 42847602 and 42361356
    [
      'Proceedings (Baylor University. Medical Center)',
      'Proc (Bayl Univ Med Cent)',
      'Proceedings (Baylor University. Medical Center)',
    ],
    [
      'Journal (Canadian Dental Association)',
      'J Can Dent Assoc',
      'Journal (Canadian Dental Association)',
    ],
    // An edition the ISO abbreviation also names is a journal of its own
    ['Medicina clinica (English ed.)', 'Med Clin (Engl Ed)', 'Medicina Clinica (English Ed.)'],
    [
      'Angewandte Chemie (International ed. in English)',
      'Angew Chem Int Ed Engl',
      'Angewandte Chemie (International Ed. in English)',
    ],
    [
      'Frontiers in bioscience (Landmark edition)',
      'Front Biosci (Landmark Ed)',
      'Frontiers in Bioscience (Landmark Edition)',
    ],
    // A nested parenthetical is one unit, never cut at its inner group
    [
      'Bulletin (Hospital for Joint Diseases (New York, N.Y.))',
      'Bull Hosp Jt Dis',
      'Bulletin (Hospital for Joint Diseases (New York, N.Y.))',
    ],
    // A one-word place and a subject are not NLM qualifiers
    ['Mental health (London)', 'Ment Health (Lond)', 'Mental Health (London)'],
    [
      'Seminars in veterinary medicine and surgery (small animal)',
      'Semin Vet Med Surg Small Anim',
      'Seminars in Veterinary Medicine and Surgery (Small Animal)',
    ],
  ])('keeps the parenthetical of %s', (title, iso, cited) => {
    expect(citedJournal(title, iso)).toEqual([cited, cited]);
  });

  it('drops an edition the ISO abbreviation does not name, or when the record has none', () => {
    expect(citedJournal('BMJ (Clinical research ed.)')).toEqual(['BMJ', 'BMJ']);
    expect(citedJournal('Medicina clinica (English ed.)')).toEqual([
      'Medicina Clinica',
      'Medicina Clinica',
    ]);
  });

  /**
   * The rule's measured misses over NLM's journal list: a place-shaped issuing
   * body is dropped, and a place carrying no region or a year after a period is
   * kept, as before the rule.
   */
  it.each([
    ['Collegian (Royal College of Nursing, Australia)', 'Collegian', 'Collegian'],
    ['Medical record (New York : 1934)', 'Med Rec', 'Medical Record (New York : 1934)'],
    [
      'Psychology and behavioral sciences (New York, N.Y. 2012)',
      'Psychol Behav Sci',
      'Psychology and Behavioral Sciences (New York, N.Y. 2012)',
    ],
  ])('cites %s by the rule as measured', (title, iso, cited) => {
    expect(citedJournal(title, iso)).toEqual([cited, cited]);
  });

  it('keeps Vancouver, BibTeX, and RIS on the qualified name (PMID 9500320)', () => {
    const article = parseArticleSet(parseArticleSetXml(articleSetXml(RETRACTED_ARTICLE_XML)))[0];
    if (!article) throw new Error('fixture did not parse');
    expect(formatApa(article)).toContain('*Lancet*, *351*(9103), 637\u{2013}641.');
    expect(formatMla(article)).toContain('*Lancet*, vol. 351, no. 9103, 1998, pp. 637-41.');
    expect(formatVancouver(article)).toContain('. Lancet. 1998;351(9103):637-41.');
    expect(formatBibtex(article)).toMatch(/^ {2}journal\s+= \{Lancet \(London, England\)\},$/m);
    expect(formatRis(article)).toContain('JF  - Lancet (London, England)\nJO  - Lancet\n');
  });
});

// ─── BibTeX and RIS page ranges written in full (#228) ───────────────────────
//
// NLM elides a range's end (`637-41`) and drops a prefix from it (`S5-15`).
// BibTeX and RIS write each range in full by the rule APA uses; NCBI's own
// `StartPage`/`EndPage` for the same records are the oracle.

describe('BibTeX and RIS page ranges written in full (#228)', () => {
  const withPages = (pages: string): ParsedArticle => ({
    ...sampleArticle,
    journalInfo: { ...sampleArticle.journalInfo!, pages },
  });
  const bibtexPages = (pages: string) =>
    /^ {2}pages\s+= \{(.*)\},$/m.exec(formatBibtex(withPages(pages)))?.[1];
  const risPages = (pages: string) => {
    const ris = formatRis(withPages(pages));
    return [/^SP {2}- (.*)$/m.exec(ris)?.[1], /^EP {2}- (.*)$/m.exec(ris)?.[1]];
  };

  /** PMID, `MedlinePgn`, and the `StartPage`/`EndPage` NCBI serves beside it. */
  it.each([
    ['9500320', '637-41', '637', '641'],
    ['5071698', '614-7', '614', '617'],
    ['4626599', '897-900', '897', '900'],
    ['24564693', 'S5-15', 'S5', 'S15'],
    ['17016951', 'S99-103', 'S99', 'S103'],
    ['21883993', 'e58-65', 'e58', 'e65'],
    ['29018563', 'e16-e18', 'e16', 'e18'],
    ['34120956', 'xii-xv', 'xii', 'xv'],
    ['42394887', '145-150.e1', '145', '150.e1'],
    ['8696098', '1308, 1310-4', '1308', '1314'],
    ['8696105', '1340, 1343, 1344', '1340', '1344'],
  ])('PMID %s: %s runs from %s to %s', (_pmid, pages, startPage, endPage) => {
    expect(risPages(pages)).toEqual([startPage, endPage]);
  });

  it.each([
    ['637-41', '637-641'],
    ['S5-15', 'S5-S15'],
    ['e1-5', 'e1-e5'],
    ['xii-xv', 'xii-xv'],
    ['1308, 1310-4', '1308, 1310-1314'],
    ['1407-8; author reply 1409-10', '1407-1408; author reply 1409-1410'],
  ])('writes BibTeX pages %s as %s', (pages, full) => {
    expect(bibtexPages(pages)).toBe(full);
  });

  it('keeps a single page and an article number without an end page', () => {
    expect(risPages('445')).toEqual(['445', undefined]);
    expect(risPages('e0364621')).toEqual(['e0364621', undefined]);
    expect(risPages('1407-8; author reply 1409-10')).toEqual(['1407', '1410']);
  });

  it('leaves full ranges, single pages, and article numbers byte-identical', () => {
    for (const pages of ['865-878.e8', '123-130', '445', 'e0364621', 'S3-S13']) {
      expect(bibtexPages(pages), pages).toBe(pages);
    }
    expect(formatBibtex(sampleArticle)).toContain('  pages    = {123-130},\n');
    expect(formatRis(sampleArticle)).toContain('SP  - 123\nEP  - 130\n');
  });

  it("keeps APA's expansion and MLA's and Vancouver's NLM text", () => {
    const article = withPages('1308, 1310-4');
    expect(formatApa(article)).toContain('*30*(5), 1308, 1310\u{2013}1314.');
    expect(formatMla(article)).toContain('2024, pp. 1308, 1310-4.');
    expect(formatVancouver(article)).toContain('2024;30(5):1308, 1310-4.');
  });
});

// ─── Vancouver page ranges, ISSN-L, and RIS title punctuation (#253) ─────────
//
// `MedlinePgn` is elided on indexed MEDLINE records but arrives in full on
// publisher-supplied ones, so two articles of one journal cited different
// forms. Vancouver writes every range in Citing Medicine's elided form.
// `Journal/ISSN` is the medium NLM indexed the record from; BibTeX and RIS
// print the journal's linking ISSN instead.

describe('Vancouver page ranges in Citing Medicine form (#253)', () => {
  const withPages = (pages: string): ParsedArticle => ({
    ...sampleArticle,
    journalInfo: { ...sampleArticle.journalInfo!, pages },
  });
  /** The pages Vancouver prints after `Year;Vol(Issue):`. */
  const vancouverPages = (pages: string) =>
    /^.*2024;30\(5\):(.*)\. doi: /.exec(formatVancouver(withPages(pages)))?.[1];
  const bibtexPages = (pages: string) =>
    /^ {2}pages\s+= \{(.*)\},$/m.exec(formatBibtex(withPages(pages)))?.[1];

  it.each([
    ['1637-1645', '1637-45'],
    ['123-129', '123-9'],
    ['1199-1201', '1199-201'],
    ['99-101', '99-101'],
    ['S12-S15', 'S12-5'],
    ['e123-e129', 'e123-9'],
    ['R1-R10', 'R1-10'],
    ['S5-S15', 'S5-15'],
    ['123-130', '123-30'],
    ['1637\u{2013}1645', '1637\u{2013}45'],
    ['1407-1408; author reply 1409-1410', '1407-8; author reply 1409-10'],
    ['1308, 1310-1314', '1308, 1310-4'],
  ])('elides %s to %s', (pages, elided) => {
    expect(vancouverPages(pages)).toBe(elided);
  });

  it.each([
    '637-41',
    'S5-15',
    'e58-65',
    '1407-8; author reply 1409-10',
    'e123',
    'S12',
    '662953',
    '445',
    'iii-v',
    'xii-xv',
    '865-878.e8',
    'S12-e15',
    '123-123',
    'S5-S5',
  ])('leaves %s unchanged', (pages) => {
    expect(vancouverPages(pages)).toBe(pages);
  });

  it('writes an elided end back out to the end it came from', () => {
    for (const pages of [
      '1637-1645',
      '123-129',
      '1199-1201',
      '99-101',
      'S12-S15',
      'e123-e129',
      'R1-R10',
      '1407-1408; author reply 1409-1410',
    ]) {
      const elided = vancouverPages(pages);
      if (elided === undefined) throw new Error(`no Vancouver pages for ${pages}`);
      expect(bibtexPages(elided), elided).toBe(pages);
    }
  });

  it('cites two articles of one journal in one form, whatever form NLM gave', () => {
    const elided = parseArticleSet(parseArticleSetXml(articleSetXml(RETRACTED_ARTICLE_XML)))[0];
    const full = parseArticleSet(
      parseArticleSetXml(
        articleSetXml(
          RETRACTION_NOTICE_XML.replace(
            '<MedlinePgn>445</MedlinePgn>',
            '<MedlinePgn>1637-1645</MedlinePgn>',
          ),
        ),
      ),
    )[0];
    if (!elided || !full) throw new Error('fixture did not parse');
    expect(formatVancouver(elided)).toContain('Lancet. 1998;351(9103):637-41.');
    expect(formatVancouver(full)).toContain('Lancet. 2010;375(9713):1637-45.');
  });

  it("keeps APA's, MLA's, BibTeX's, and RIS's pagination byte-identical", () => {
    const article = withPages('1637-1645');
    expect(formatApa(article)).toContain('*30*(5), 1637\u{2013}1645.');
    expect(formatMla(article)).toContain('2024, pp. 1637-1645.');
    expect(bibtexPages('1637-1645')).toBe('1637-1645');
    expect(formatRis(article)).toContain('SP  - 1637\nEP  - 1645\n');
  });
});

describe('BibTeX and RIS ISSN: the journal linking ISSN (#253)', () => {
  const parse = (xml: string) => {
    const [article] = parseArticleSet(parseArticleSetXml(articleSetXml(xml)), {
      includeIssnLinking: true,
    });
    if (!article) throw new Error('fixture did not parse');
    return article;
  };
  const bibtexIssn = (article: ParsedArticle) =>
    /^ {2}issn\s+= \{(.*)\},$/m.exec(formatBibtex(article))?.[1];
  const risSn = (article: ParsedArticle) => formatRis(article).match(/^SN {2}- .*$/gm);

  it('prints ISSN-L for a record NLM indexed from the electronic edition', () => {
    // PMID 20137807: `<ISSN IssnType="Electronic">1474-547X</ISSN>`, ISSN-L 0140-6736
    const notice = parse(RETRACTION_NOTICE_XML);
    expect(bibtexIssn(notice)).toBe('0140-6736');
    expect(risSn(notice)).toEqual(['SN  - 0140-6736']);
  });

  it('prints the same ISSN-L for a print-indexed record of that journal', () => {
    // PMID 9500320: `<ISSN IssnType="Print">0140-6736</ISSN>`, ISSN-L 0140-6736
    const article = parse(RETRACTED_ARTICLE_XML);
    expect(bibtexIssn(article)).toBe('0140-6736');
    expect(risSn(article)).toEqual(['SN  - 0140-6736']);
  });

  it('falls back to Journal/ISSN when the record carries no ISSN-L', () => {
    const noLinking = parse(
      RETRACTION_NOTICE_XML.replace('<ISSNLinking>0140-6736</ISSNLinking>', ''),
    );
    expect(bibtexIssn(noLinking)).toBe('1474-547X');
    expect(risSn(noLinking)).toEqual(['SN  - 1474-547X']);
  });
});

describe('RIS TI drops one trailing period (#253)', () => {
  it('ends the title without its period, as BibTeX does', () => {
    const article = parseArticleSet(parseArticleSetXml(articleSetXml(RETRACTED_ARTICLE_XML)))[0];
    if (!article) throw new Error('fixture did not parse');
    expect(formatRis(article)).toContain(
      '\nTI  - Ileal-lymphoid-nodular hyperplasia, non-specific colitis, and pervasive developmental disorder in children\n',
    );
    expect(formatBibtex(article)).toContain(
      '{Ileal-lymphoid-nodular hyperplasia, non-specific colitis, and pervasive developmental disorder in children}',
    );
  });

  it('keeps a question mark, and drops only one of two periods', () => {
    const titled = (title: string) => formatRis({ ...sampleArticle, title });
    expect(titled('Is it safe?')).toContain('\nTI  - Is it safe?\n');
    expect(titled('Wait for it..')).toContain('\nTI  - Wait for it.\n');
  });
});

// ─── Hyphenated article numbers (#231) ───────────────────────────────────────
//
// American Society for Microbiology journals deposit `MedlinePgn` without the
// hyphen their article number carries (`e0364621` beside pii `e03646-21`).
// APA and MLA cite the locator's form.

describe('hyphenated article numbers in APA and MLA (#231)', () => {
  /** PMID 35164571 (mBio 13(1), 2021), as the record carries it. */
  const asmArticle = (pages: string, elocationId: string): ParsedArticle => ({
    recordType: 'journal-article',
    pmid: '35164571',
    title: 'Structural Basis for the Peptidoglycan-Editing Activity of YfiH.',
    authors: [{ lastName: 'Lee', firstName: 'Meng-Sheng', initials: 'MS' }],
    journalInfo: {
      title: 'mBio',
      isoAbbreviation: 'mBio',
      volume: '13',
      issue: '1',
      pages,
      elocationId,
      elocationIdType: 'pii',
      publicationDate: { year: '2021', month: 'Feb', day: '22' },
    },
    doi: `10.1128/mbio.${elocationId.slice(1)}`,
  });

  it('cites the locator when MedlinePgn is it without its hyphen', () => {
    const article = asmArticle('e0364621', 'e03646-21');
    expect(formatApa(article)).toContain(
      '*mBio*, *13*(1), Article e03646-21. https://doi.org/10.1128/mbio.03646-21',
    );
    expect(formatMla(article)).toContain('*mBio*, vol. 13, no. 1, 2021, art. e03646-21.');

    // PMID 35164570, the same journal issue
    const other = asmArticle('e0379621', 'e03796-21');
    expect(formatApa(other)).toContain('*mBio*, *13*(1), Article e03796-21.');
    expect(formatMla(other)).toContain('vol. 13, no. 1, 2021, art. e03796-21.');
  });

  it('never reads a page range as an article number', () => {
    const range = asmArticle('123-45', '12345');
    expect(formatApa(range)).toContain('*13*(1), 123\u{2013}145.');
    expect(formatApa(range)).not.toContain('Article');
    expect(formatMla(range)).toContain('2021, pp. 123-45.');
  });

  it('keeps Vancouver, BibTeX, and RIS on the pagination NLM gives', () => {
    const article = asmArticle('e0364621', 'e03646-21');
    expect(formatVancouver(article)).toContain(
      'mBio. 2021;13(1):e0364621. doi: 10.1128/mbio.03646-21',
    );
    expect(formatBibtex(article)).toMatch(/^ {2}pages\s+= \{e0364621\},$/m);
    expect(formatBibtex(article)).not.toMatch(/^ {2}eid\s/m);
    expect(formatRis(article)).toContain('SP  - e0364621\n');
    expect(formatRis(article)).not.toContain('C7  -');
  });
});

// ─── Whitespace in record text (#233) ────────────────────────────────────────
//
// The parser trims a field's ends only, so a line break inside one reaches the
// formatter. Every style writes record text on one line.

describe('whitespace runs in record text collapse in every style (#233)', () => {
  /** PMID 34120956, its real record with a line break injected into `ArticleTitle`. */
  const NHSC_XML =
    '<PubmedArticle><MedlineCitation Status="MEDLINE" Owner="NLM" IndexingMethod="Automated"><PMID Version="1">34120956</PMID><Article PubModel="Print"><Journal><ISSN IssnType="Electronic">1548-6869</ISSN><JournalIssue CitedMedium="Internet"><Volume>32</Volume><Issue>2</Issue><PubDate><Year>2021</Year></PubDate></JournalIssue><Title>Journal of health care for the poor and underserved</Title><ISOAbbreviation>J Health Care Poor Underserved</ISOAbbreviation></Journal><ArticleTitle>NHSC at 50: New Investments for a New Workforce.</ArticleTitle><Pagination><StartPage>xii</StartPage><EndPage>xv</EndPage><MedlinePgn>xii-xv</MedlinePgn></Pagination><ELocationID EIdType="doi" ValidYN="Y">10.1353/hpu.2021.0084</ELocationID><AuthorList CompleteYN="Y"><Author ValidYN="Y"><LastName>Nunez</LastName><ForeName>Felix L</ForeName><Initials>FL</Initials></Author><Author ValidYN="Y"><LastName>Overbeck</LastName><ForeName>Marc</ForeName><Initials>M</Initials></Author><Author ValidYN="Y"><LastName>Kelly</LastName><ForeName>Amanda Pears</ForeName><Initials>AP</Initials></Author></AuthorList><Language>eng</Language><PublicationTypeList><PublicationType UI="D016428">Journal Article</PublicationType></PublicationTypeList></Article><MedlineJournalInfo><Country>United States</Country><MedlineTA>J Health Care Poor Underserved</MedlineTA><NlmUniqueID>9103800</NlmUniqueID><ISSNLinking>1049-2089</ISSNLinking></MedlineJournalInfo></MedlineCitation><PubmedData><PublicationStatus>ppublish</PublicationStatus><ArticleIdList><ArticleId IdType="pubmed">34120956</ArticleId><ArticleId IdType="doi">10.1353/hpu.2021.0084</ArticleId></ArticleIdList></PubmedData></PubmedArticle>';
  const parsed = (xml: string): ParsedArticle => {
    const article = parseArticleSet(parseArticleSetXml(articleSetXml(xml)))[0];
    if (!article) throw new Error('fixture did not parse');
    return article;
  };
  const TITLE = 'NHSC at 50: New Investments for a New Workforce.';
  /** Each style's output for a record, every style held to one line but RIS and BibTeX. */
  const expectOneLineEach = (article: ParsedArticle) => {
    const ris = formatRis(article).split('\n');
    expect(
      ris.every((line) => /^[A-Z][A-Z0-9] {2}- /.test(line)),
      ris.join('\n'),
    ).toBe(true);
    const bibtex = formatBibtex(article).split('\n');
    expect(
      bibtex.every((line) => /^(@\w+\{pmid\d+,|\}| {2}\w+\s*= \{.*\},?)$/.test(line)),
      bibtex.join('\n'),
    ).toBe(true);
    for (const citation of [formatApa(article), formatMla(article), formatVancouver(article)]) {
      expect(citation).not.toMatch(/\s{2}|[\n\r]/);
    }
  };

  it('keeps the parsed title line break, then writes it on one line in every style', () => {
    for (const broken of ['NHSC at 50:\n\nNew', 'NHSC at 50:&#10;New']) {
      const article = parsed(NHSC_XML.replace('NHSC at 50: New', broken));
      expect(article.title).toMatch(/^NHSC at 50:\n+New Investments/);
      expectOneLineEach(article);
      // RIS drops the title's one trailing period, as BibTeX does (#253)
      expect(formatRis(article)).toContain(`\nTI  - ${TITLE.replace(/\.$/, '')}\n`);
      expect(formatBibtex(article)).toMatch(
        /^ {2}title\s+= \{\{NHSC at 50: New Investments for a New Workforce\}\},$/m,
      );
      expect(formatApa(article)).toContain(`(2021). ${TITLE} *Journal of Health Care`);
      expect(formatMla(article)).toContain(`"${TITLE}"`);
      expect(formatVancouver(article)).toContain(`Kelly AP. ${TITLE} J Health Care`);
    }
  });

  it('writes a collective author, keyword, journal title, and book title on one line', () => {
    const article: ParsedArticle = {
      ...sampleArticle,
      authors: [{ collectiveName: 'NHSC\nWorkforce  Group' }, ...(sampleArticle.authors ?? [])],
      keywords: ['primary\ncare'],
      journalInfo: {
        ...sampleArticle.journalInfo!,
        title: 'Nature\r\nmedicine',
        isoAbbreviation: 'Nat\nMed',
      },
    };
    expectOneLineEach(article);
    expect(formatRis(article)).toContain('AU  - NHSC Workforce Group\n');
    expect(formatRis(article)).toContain('KW  - primary care\n');
    expect(formatRis(article)).toContain('JF  - Nature medicine\nJO  - Nat Med\n');
    expect(formatBibtex(article)).toContain('{primary care}');
    expect(formatApa(article)).toContain('NHSC Workforce Group, Smith');
    expect(formatApa(article)).toContain('*Nature Medicine*');
    expect(formatVancouver(article)).toContain('Nat Med. 2024');

    const chapter = parsed(
      LACTMED_CHAPTER_XML.replace('Drugs and Lactation', 'Drugs and\nLactation'),
    );
    expectOneLineEach(chapter);
    expect(formatApa(chapter)).toContain('*Drugs and Lactation Database (LactMed®)*');
    expect(formatMla(chapter)).toContain('*Drugs and Lactation Database (LactMed®)*');
    expect(formatVancouver(chapter)).toContain(
      'In: Drugs and Lactation Database (LactMed®) [Internet].',
    );
    expect(formatRis(chapter)).toContain('BT  - Drugs and Lactation Database (LactMed®)\n');
    expect(formatBibtex(chapter)).toMatch(/booktitle\s+= \{Drugs and Lactation Database/);
  });

  it('leaves a record without a whitespace run byte-identical', () => {
    const article = parsed(NHSC_XML);
    expect(formatRis(article)).toBe(
      [
        'TY  - JOUR',
        'AU  - Nunez, Felix L',
        'AU  - Overbeck, Marc',
        'AU  - Kelly, Amanda Pears',
        `TI  - ${TITLE.replace(/\.$/, '')}`,
        'JF  - Journal of health care for the poor and underserved',
        'JO  - J Health Care Poor Underserved',
        'PY  - 2021',
        'VL  - 32',
        'IS  - 2',
        'SP  - xii',
        'EP  - xv',
        'SN  - 1548-6869',
        'DO  - 10.1353/hpu.2021.0084',
        'AN  - 34120956',
        'UR  - https://pubmed.ncbi.nlm.nih.gov/34120956/',
        'ER  - ',
      ].join('\n'),
    );
    expect(formatApa(article)).toBe(
      `Nunez, F. L., Overbeck, M., & Kelly, A. P. (2021). ${TITLE} *Journal of Health Care for the Poor and Underserved*, *32*(2), xii\u{2013}xv. https://doi.org/10.1353/hpu.2021.0084`,
    );
    expect(formatVancouver(article)).toBe(
      `Nunez FL, Overbeck M, Kelly AP. ${TITLE} J Health Care Poor Underserved. 2021;32(2):xii-xv. doi: 10.1353/hpu.2021.0084`,
    );
  });
});

// ─── Retraction and erratum notices (#215) ───────────────────────────────────
//
// NCBI links a retracted or corrected article to its notice through
// `CommentsCorrectionsList`. Vancouver prints Citing Medicine's `Retraction in:` /
// `Erratum in:` note, as NCBI's own NLM export does; APA adds APA 7's retraction
// parenthetical. Every record here is real (see the fixture files).

describe('retraction and erratum notices (#215)', () => {
  const corpusRecord = (pmid: string): ParsedArticle => {
    const xml = readFileSync(join(PUBMED_FIXTURES_DIR, `pmid${pmid}`, 'source.xml'), 'utf8');
    const parsed = parseArticleSet(parseArticleSetXml(xml))[0];
    if (!parsed) throw new Error(`corpus record ${pmid} did not parse`);
    return parsed;
  };
  const record = (xml: string): ParsedArticle => {
    const parsed = parseArticleSet(parseArticleSetXml(articleSetXml(xml)))[0];
    if (!parsed) throw new Error('fixture did not parse');
    return parsed;
  };
  /** The same record with no linked notices at all. */
  const withoutNotices = ({ commentsCorrections: _cc, ...article }: ParsedArticle) => article;

  /** PMID 31844417 — one `RetractionIn`, PMID 40251503. */
  const retracted = () => corpusRecord('31844417');
  /** PMID 39624286 — one `ErratumIn`, PMID 41216527. */
  const corrected = () => corpusRecord('39624286');
  /** PMID 9500320 — two `RetractionIn`, one `ExpressionOfConcernIn`, 26 `CommentIn`. */
  const wakefield = () => record(RETRACTED_ARTICLE_XML);
  /** PMID 23300797 — `ErratumIn` with no PMID, a `Note`, and no final period. */
  const erratumWithNote = () => record(ERRATUM_NOTE_ARTICLE_XML);
  /** PMID 8643635 — `ErratumIn` with no period or DOI, then `ErratumFor`. */
  const publishedErratum = () => record(PUBLISHED_ERRATUM_XML);

  it('leaves a record whose links qualify nothing byte-identical in every style', () => {
    // 20137807 is itself a retraction notice (`RetractionOf` only); 34116029
    // carries only a `CommentIn`.
    for (const article of [record(RETRACTION_NOTICE_XML), corpusRecord('34116029')]) {
      expect(article.commentsCorrections?.length).toBeGreaterThan(0);
      for (const style of ['apa', 'mla', 'bibtex', 'ris', 'vancouver'] as const) {
        expect(formatCitation(article, style), `${article.pmid} ${style}`).toBe(
          formatCitation(withoutNotices(article), style),
        );
      }
    }
  });

  it('leaves MLA, BibTeX, and RIS byte-identical for every record', () => {
    for (const article of [retracted(), corrected(), wakefield(), erratumWithNote()]) {
      for (const style of ['mla', 'bibtex', 'ris'] as const) {
        expect(formatCitation(article, style), `${article.pmid} ${style}`).toBe(
          formatCitation(withoutNotices(article), style),
        );
      }
    }
  });

  it("appends Vancouver's Retraction in: note after the DOI, which then closes with a period", () => {
    expect(formatVancouver(retracted())).toBe(
      'Li H, Tian X, Wang P, Huang M, Xu R, Nie T. MicroRNA-582-3p negatively regulates cell proliferation and cell cycle progression in acute myeloid leukemia by targeting cyclin B2. Cell Mol Biol Lett. 2019;24:66. doi: 10.1186/s11658-019-0184-7. Retraction in: Cell Mol Biol Lett. 2025 Apr 18;30(1):51. doi: 10.1186/s11658-025-00729-3.',
    );
  });

  it("appends Vancouver's Erratum in: note, with no APA parenthetical", () => {
    expect(formatVancouver(corrected())).toMatch(
      /doi: 10\.1016\/j\.heliyon\.2024\.e40335\. Erratum in: Heliyon\. 2025 Jun 30;11\(12\):e43572\. doi: 10\.1016\/j\.heliyon\.2025\.e43572\.$/,
    );
    expect(formatApa(corrected())).toBe(formatApa(withoutNotices(corrected())));
  });

  it('prints every retraction in NCBI order and no expression of concern or comment', () => {
    const vancouver = formatVancouver(wakefield());
    expect(vancouver).toMatch(
      /1998;351\(9103\):637-41\. doi: 10\.1016\/s0140-6736\(97\)11096-0\. Retraction in: Lancet\. 2004 Mar 6;363\(9411\):750\. doi: 10\.1016\/S0140-6736\(04\)15715-2\. Retraction in: Lancet\. 2010 Feb 6;375\(9713\):445\. doi: 10\.1016\/S0140-6736\(10\)60175-4\.$/,
    );
    expect(vancouver).not.toContain('Eur J Gastroenterol Hepatol');
    expect(vancouver).not.toContain('author reply');
  });

  it("ends APA on APA 7's retraction parenthetical, several joined with a semicolon", () => {
    expect(formatApa(retracted())).toMatch(
      /https:\/\/doi\.org\/10\.1186\/s11658-019-0184-7 \(Retraction published Cell Mol Biol Lett\. 2025 Apr 18;30\(1\):51\. doi: 10\.1186\/s11658-025-00729-3\)$/,
    );
    expect(formatApa(wakefield())).toMatch(
      / \(Retraction published Lancet\. 2004 Mar 6;363\(9411\):750\. doi: 10\.1016\/S0140-6736\(04\)15715-2; Lancet\. 2010 Feb 6;375\(9713\):445\. doi: 10\.1016\/S0140-6736\(10\)60175-4\)$/,
    );
  });

  it('ends a note on exactly one period whatever NCBI gives, and keeps its Note out', () => {
    const vancouver = formatVancouver(erratumWithNote());
    expect(vancouver).toMatch(
      / Erratum in: PLoS One\. 2013;8\(6\)\. doi:10\.1371\/annotation\/df743c15-c50e-4d00-a24d-510e15f9a73b\.$/,
    );
    for (const style of ['apa', 'mla', 'bibtex', 'ris', 'vancouver'] as const) {
      expect(formatCitation(erratumWithNote(), style), style).not.toContain('corrected to');
    }
    // A published erratum: its own `ErratumIn` prints, its `ErratumFor` does not
    expect(formatVancouver(publishedErratum())).toMatch(
      /doi: 10\.1073\/pnas\.93\.11\.5674\. Erratum in: Proc Natl Acad Sci U S A 1996 Aug 20;93\(17\):9302\.$/,
    );
    expect(formatVancouver(publishedErratum())).not.toContain('7090-4');
  });

  it('follows the source with the notes when the record has no DOI', () => {
    const { doi: _doi, ...noDoi } = retracted();
    expect(formatVancouver(noDoi)).toMatch(
      /Cell Mol Biol Lett\. 2019;24:66\. Retraction in: Cell Mol Biol Lett\. 2025 Apr 18;30\(1\):51\. doi: 10\.1186\/s11658-025-00729-3\.$/,
    );
    expect(formatApa(noDoi)).toMatch(
      /\*24\*, Article 66\. \(Retraction published Cell Mol Biol Lett\. 2025 Apr 18;30\(1\):51\. doi: 10\.1186\/s11658-025-00729-3\)$/,
    );
  });

  it('prints no note for a notice type Citing Medicine does not set in the reference', () => {
    // RetractedandRepublishedIn, CorrectedandRepublishedIn, and
    // ExpressionOfConcernIn qualify the article but take no in-string note.
    const article: ParsedArticle = {
      ...sampleArticle,
      commentsCorrections: [
        { refType: 'RetractedandRepublishedIn', refSource: 'Nat Med. 2025;31(1):1.', pmid: '1' },
        { refType: 'CorrectedandRepublishedIn', refSource: 'Nat Med. 2025;31(2):2.', pmid: '2' },
        { refType: 'ExpressionOfConcernIn', refSource: 'Nat Med. 2025;31(3):3.', pmid: '3' },
      ],
    };
    for (const style of ['apa', 'mla', 'bibtex', 'ris', 'vancouver'] as const) {
      expect(formatCitation(article, style), style).toBe(
        formatCitation(withoutNotices(article), style),
      );
    }
  });
});

// NCBI writes the literal `None` as the page value on some records. It is no
// page: the record cites as one carrying no pagination at all. (#248)

describe("NCBI's literal None page value (#248)", () => {
  const record = (xml: string): ParsedArticle => {
    const parsed = parseArticleSet(parseArticleSetXml(articleSetXml(xml)))[0];
    if (!parsed) throw new Error('fixture did not parse');
    return parsed;
  };

  it('cites PMID 42845821 in every style exactly as the record with no pagination', () => {
    const none = record(NONE_PAGINATION_XML);
    const bare = record(NO_PAGINATION_XML);
    for (const style of ['apa', 'mla', 'bibtex', 'ris', 'vancouver'] as const) {
      const citation = formatCitation(none, style);
      expect(citation, style).toBe(formatCitation(bare, style));
      expect(citation, style).not.toContain('None');
    }
  });
});

// An author's generational suffix stays verbatim as NCBI writes it (`Jr`,
// `2nd`). Inverted name forms set it off with a comma; natural-order and NLM
// forms append it after a space. (#226)

describe('author name suffixes in every style (#226)', () => {
  const record = (xml: string): ParsedArticle => {
    const parsed = parseArticleSet(parseArticleSetXml(articleSetXml(xml)))[0];
    if (!parsed) throw new Error('fixture did not parse');
    return parsed;
  };
  const frenck = () => record(FRENCK_JR_XML);
  const hormuth = () => record(HORMUTH_2ND_XML);
  const withAuthors = (authors: NonNullable<ParsedArticle['authors']>): ParsedArticle => ({
    ...sampleArticle,
    authors,
  });
  const FRENCK = { lastName: 'Frenck', firstName: 'Robert W', initials: 'RW', suffix: 'Jr' };

  describe('PMID 34525284 — first author Frenck RW Jr', () => {
    it('APA sets the suffix off after the initials', () => {
      expect(formatApa(frenck())).toBe(
        'Frenck, R. W., Jr, Dormitzer, P. R., & Gurtman, A. (2021). BNT162b2 Covid-19 Vaccine in Adolescents. Reply. ' +
          '*The New England Journal of Medicine*, *385*(14), 1343. https://doi.org/10.1056/NEJMc2113394',
      );
    });

    it('MLA inverts the first author with the suffix last', () => {
      expect(formatMla(frenck())).toBe(
        'Frenck, Robert W, Jr, et al. "BNT162b2 Covid-19 Vaccine in Adolescents. Reply." ' +
          '*The New England Journal of Medicine*, vol. 385, no. 14, 2021, p. 1343. https://doi.org/10.1056/NEJMc2113394.',
      );
    });

    it('BibTeX uses the three-part {Last}, Jr, First form', () => {
      expect(formatBibtex(frenck())).toContain(
        '  author   = {{Frenck}, Jr, Robert W and {Dormitzer}, Philip R and {Gurtman}, Alejandra},\n',
      );
    });

    it('RIS writes AU as Lastname, Firstname, Suffix', () => {
      const ris = formatRis(frenck());
      expect(ris).toContain(
        'TY  - JOUR\nAU  - Frenck, Robert W, Jr\nAU  - Dormitzer, Philip R\nAU  - Gurtman, Alejandra\nTI  - ',
      );
    });

    it("Vancouver appends the suffix after the initials, as NCBI's NLM export does", () => {
      expect(formatVancouver(frenck())).toBe(
        'Frenck RW Jr, Dormitzer PR, Gurtman A. BNT162b2 Covid-19 Vaccine in Adolescents. Reply. ' +
          'N Engl J Med. 2021;385(14):1343. doi: 10.1056/NEJMc2113394',
      );
    });
  });

  describe('PMID 42409342 — second author Hormuth DA 2nd', () => {
    it('keeps the ordinal verbatim in Vancouver and APA', () => {
      expect(formatVancouver(hormuth())).toMatch(
        /^Das A, Hormuth DA 2nd, Virostko J, Parker P, Quarles CC, Yankeelov TE\. Repeatability /,
      );
      expect(formatApa(hormuth())).toMatch(
        /^Das, A\., Hormuth, D\. A\., 2nd, Virostko, J\., Parker, P\., Quarles, C\. C\., & Yankeelov, T\. E\. \(2026\)\. /,
      );
    });

    it('renders it in the BibTeX and RIS author lists', () => {
      expect(formatBibtex(hormuth())).toContain('{Das}, Ayesha and {Hormuth}, 2nd, David A and');
      expect(formatRis(hormuth())).toContain('AU  - Das, Ayesha\nAU  - Hormuth, David A, 2nd\n');
    });
  });

  describe('a suffix at the end of an author list', () => {
    it('takes the closing period after the suffix in APA, MLA and Vancouver', () => {
      const article = withAuthors([FRENCK]);
      expect(formatApa(article)).toMatch(/^Frenck, R\. W\., Jr\. \(2024\)\. A Novel/);
      expect(formatMla(article)).toMatch(/^Frenck, Robert W, Jr\. "A Novel/);
      expect(formatVancouver(article)).toMatch(/^Frenck RW Jr\. A Novel/);
    });

    it('MLA writes a second author first-name-first, suffix last', () => {
      const article = withAuthors([sampleArticle.authors?.[0] ?? {}, FRENCK]);
      expect(formatMla(article)).toMatch(/^Smith, John, and Robert W Frenck Jr\. "A Novel/);
    });
  });

  describe('a suffixed name with no ForeName (initials only)', () => {
    const article = () => withAuthors([{ lastName: 'Frenck', initials: 'RW', suffix: 'Jr' }]);

    it('keeps each style positional', () => {
      expect(formatApa(article())).toMatch(/^Frenck, R\. W\., Jr\. \(2024\)/);
      expect(formatMla(article())).toMatch(/^Frenck, Jr\. "A Novel/);
      expect(formatBibtex(article())).toContain('author   = {{Frenck}, Jr,},');
      expect(formatRis(article())).toContain('AU  - Frenck, , Jr\n');
      expect(formatVancouver(article())).toMatch(/^Frenck RW Jr\. A Novel/);
    });
  });

  it('leaves a suffix out when there is no surname for it to qualify', () => {
    const article = withAuthors([{ firstName: 'Robert W', initials: 'RW', suffix: 'Jr' }]);
    for (const style of ['apa', 'mla', 'bibtex', 'ris', 'vancouver'] as const) {
      expect(formatCitation(article, style), style).not.toContain('Jr');
    }
  });

  describe('editor positions', () => {
    /** GeneReviews (PMID 20301425) with its first editor given the DTD-permitted `Suffix`. */
    const chapter = () =>
      record(
        GENEREVIEWS_CHAPTER_XML.replace(
          '<LastName>Adam</LastName><ForeName>Margaret P</ForeName><Initials>MP</Initials>',
          '<LastName>Adam</LastName><ForeName>Margaret P</ForeName><Initials>MP</Initials><Suffix>Jr</Suffix>',
        ),
      );

    it('APA writes the In … (Eds.) editor first-name-first, suffix last', () => {
      expect(formatApa(chapter())).toContain(
        'In M. P. Adam Jr, S. Bick, G. M. Mirzaa, S. E. Wallace, & A. Amemiya (Eds.), *GeneReviews®*.',
      );
    });

    it('MLA writes the edited-by editor first-name-first, suffix last', () => {
      expect(formatMla(chapter())).toContain('edited by Margaret P Adam Jr, et al.,');
    });

    it('BibTeX and RIS invert the editor like an author', () => {
      expect(formatBibtex(chapter())).toContain(
        'editor    = {{Adam}, Jr, Margaret P and {Bick}, Sarah',
      );
      expect(formatRis(chapter())).toContain('A2  - Adam, Margaret P, Jr\nA2  - Bick, Sarah\n');
    });

    it('Vancouver lists the editor as NLM lists an author', () => {
      expect(formatVancouver(chapter())).toContain(
        'In: Adam MP Jr, Bick S, Mirzaa GM, Wallace SE, Amemiya A, editors.',
      );
    });

    it('APA inverts an editor standing in the author position of a whole book', () => {
      const book = record(
        ADA_WHOLE_BOOK_XML.replace(
          '</PubDate>',
          '</PubDate><AuthorList Type="editors" CompleteYN="Y"><Author ValidYN="Y"><LastName>Adam</LastName>' +
            '<ForeName>Margaret P</ForeName><Initials>MP</Initials><Suffix>Jr</Suffix></Author></AuthorList>',
        ),
      );
      expect(formatApa(book)).toMatch(/^Adam, M\. P\., Jr \(Ed\.\)\. \(2026\)\. /);
    });
  });
});

describe('APA and MLA escape the record text they carry as Markdown (#263)', () => {
  /** PMID 42504015, two of its twelve authors: a title holding two `*`. */
  const twoStars: ParsedArticle = {
    recordType: 'journal-article',
    pmid: '42504015',
    title:
      'HLA-B*15:21 carrier status is a susceptibility factor of carbamazepine-induced nonimmediate cutaneous adverse reactions in HLA-B*15:02-negative patients: A retrospective cohort study.',
    authors: [
      { lastName: 'Ruanglertboon', firstName: 'Warit', initials: 'W' },
      { lastName: 'Seree-Aphinan', firstName: 'Chanudda', initials: 'C' },
    ],
    journalInfo: {
      title: 'British journal of clinical pharmacology',
      isoAbbreviation: 'Br J Clin Pharmacol',
      publicationDate: { year: '2026' },
    },
    doi: '10.1002/bcp.70714',
  };

  /** PMID 41035243, two of its four authors: a title holding one `*`. */
  const oneStar: ParsedArticle = {
    recordType: 'journal-article',
    pmid: '41035243',
    title:
      'HLA‒B*58:01 and skin reactions in pediatric hematology and oncology patients treated with allopurinol.',
    authors: [
      { lastName: 'Maneechai', firstName: 'Parisa', initials: 'P' },
      { lastName: 'Sanpakit', firstName: 'Kleebsabai', initials: 'K' },
    ],
    journalInfo: {
      title: 'Clinical and experimental pediatrics',
      isoAbbreviation: 'Clin Exp Pediatr',
      volume: '68',
      issue: '12',
      pages: '974-980',
      publicationDate: { year: '2025' },
    },
    doi: '10.3345/cep.2025.01032',
  };

  it('escapes a title whose two `*` would pair, and renders both (PMID 42504015)', () => {
    const apa = formatApa(twoStars);
    const mla = formatMla(twoStars);
    expect(apa).toBe(
      'Ruanglertboon, W., & Seree-Aphinan, C. (2026). HLA-B\\*15:21 carrier status is a susceptibility factor of carbamazepine-induced nonimmediate cutaneous adverse reactions in HLA-B\\*15:02-negative patients: A retrospective cohort study. *British Journal of Clinical Pharmacology*. https://doi.org/10.1002/bcp.70714',
    );
    expect(mla).toBe(
      'Ruanglertboon, Warit, and Chanudda Seree-Aphinan. "HLA-B\\*15:21 carrier status is a susceptibility factor of carbamazepine-induced nonimmediate cutaneous adverse reactions in HLA-B\\*15:02-negative patients: A retrospective cohort study." *British Journal of Clinical Pharmacology*, 2026. https://doi.org/10.1002/bcp.70714.',
    );
    expect(readCommonMark(apa)).toBe(
      'Ruanglertboon, W., & Seree-Aphinan, C. (2026). HLA-B*15:21 carrier status is a susceptibility factor of carbamazepine-induced nonimmediate cutaneous adverse reactions in HLA-B*15:02-negative patients: A retrospective cohort study. ⟨em⟩British Journal of Clinical Pharmacology⟨/em⟩. https://doi.org/10.1002/bcp.70714',
    );
    expect(readCommonMark(mla)).toContain(
      'in HLA-B*15:02-negative patients: A retrospective cohort study." ⟨em⟩British Journal of Clinical Pharmacology⟨/em⟩, 2026.',
    );
  });

  it('leaves a citation with one lone `*` byte-identical (PMID 41035243)', () => {
    expect(formatApa(oneStar)).toBe(
      'Maneechai, P., & Sanpakit, K. (2025). HLA‒B*58:01 and skin reactions in pediatric hematology and oncology patients treated with allopurinol. *Clinical and Experimental Pediatrics*, *68*(12), 974–980. https://doi.org/10.3345/cep.2025.01032',
    );
    expect(formatMla(oneStar)).toBe(
      'Maneechai, Parisa, and Kleebsabai Sanpakit. "HLA‒B*58:01 and skin reactions in pediatric hematology and oncology patients treated with allopurinol." *Clinical and Experimental Pediatrics*, vol. 68, no. 12, 2025, pp. 974-980. https://doi.org/10.3345/cep.2025.01032.',
    );
    expect(readCommonMark(formatApa(oneStar))).toContain('HLA‒B*58:01 and skin reactions');
  });

  it('judges pairing across the whole citation: one `*` in a name and one in the title', () => {
    const apa = formatApa({
      ...oneStar,
      authors: [{ collectiveName: 'HLA*Study Group' }],
    });
    expect(apa).toMatch(/^HLA\\\*Study Group\. \(2025\)\. HLA‒B\\\*58:01 and skin/);
    expect(readCommonMark(apa)).toMatch(/^HLA\*Study Group\. \(2025\)\. HLA‒B\*58:01 and skin/);
  });

  it('escapes every `*` inside the italics it writes: journal, volume, book title', () => {
    const article: ParsedArticle = {
      ...oneStar,
      title: 'Plain title.',
      journalInfo: {
        ...oneStar.journalInfo,
        title: 'J*Med',
        isoAbbreviation: 'J*Med',
        volume: '6*',
      },
    };
    const apa = formatApa(article);
    expect(apa).toContain('Plain title. *J\\*Med*, *6\\**(12), 974–980.');
    expect(readCommonMark(apa)).toContain('Plain title. ⟨em⟩J*Med⟨/em⟩, ⟨em⟩6*⟨/em⟩(12), 974–980.');
    const mla = formatMla(article);
    expect(mla).toContain('"Plain title." *J\\*Med*, vol. 6*, no. 12');
    expect(readCommonMark(mla)).toContain('⟨em⟩J*Med⟨/em⟩, vol. 6*, no. 12');

    const [chapter] = parseArticleSet(
      parseArticleSetXml(
        articleSetXml(
          GENEREVIEWS_CHAPTER_XML.replace(
            '<BookTitle book="gene">GeneReviews',
            '<BookTitle book="gene">Gene*Reviews',
          ),
        ),
      ),
    );
    if (!chapter) throw new Error('fixture did not parse');
    for (const citation of [formatApa(chapter), formatMla(chapter)]) {
      expect(citation).toContain('*Gene\\*Reviews®');
      expect(readCommonMark(citation)).toContain('⟨em⟩Gene*Reviews®');
      expect(citation).not.toMatch(/\\(?=[^*])/);
    }
  });

  it('applies the prose rules to the rest: tags, entities, links, underscores', () => {
    const article: ParsedArticle = {
      ...oneStar,
      title: 'Effects of <i>Bacillus</i> on R&amp;D [see](x) in _wild_ type.',
    };
    const apa = formatApa(article);
    expect(apa).toContain(
      '(2025). Effects of \\<i>Bacillus\\</i> on R\\&amp;D [see\\](x) in \\_wild\\_ type. *Clinical',
    );
    expect(readCommonMark(apa)).toContain(
      '(2025). Effects of <i>Bacillus</i> on R&amp;D [see](x) in _wild_ type. ⟨em⟩Clinical',
    );
  });

  it('leaves a bracketed translated title and an intraword underscore byte-identical', () => {
    const apa = formatApa({ ...oneStar, title: '[Effects of TP53_mutant cells].' });
    expect(apa).toContain('(2025). [Effects of TP53_mutant cells]. *Clinical');
  });

  it('writes the DOI and Bookshelf URLs as they are, never backslash-escaped', () => {
    const apa = formatApa({ ...twoStars, doi: '10.1002/(SICI)1097_x_*y' });
    expect(apa.endsWith(' https://doi.org/10.1002/(SICI)1097_x_*y')).toBe(true);
    const mla = formatMla({ ...twoStars, doi: '10.1002/(SICI)1097_x_*y' });
    expect(mla.endsWith(' https://doi.org/10.1002/(SICI)1097_x_*y.')).toBe(true);

    const [chapter] = parseArticleSet(parseArticleSetXml(articleSetXml(GENEREVIEWS_CHAPTER_XML)));
    if (!chapter) throw new Error('fixture did not parse');
    expect(formatApa(chapter)).toMatch(/ https:\/\/www\.ncbi\.nlm\.nih\.gov\/books\/NBK1247\/$/);
  });

  it('counts a delimiter in a URL, so a lone one in the title cannot pair with it', () => {
    const apa = formatApa({ ...oneStar, doi: '10.1/x*y' });
    expect(apa).toContain('HLA‒B\\*58:01');
    expect(apa.endsWith('https://doi.org/10.1/x*y')).toBe(true);
    expect(readCommonMark(apa)).toContain('HLA‒B*58:01');
    expect(readCommonMark(apa).endsWith('https://doi.org/10.1/x*y')).toBe(true);
  });
});
