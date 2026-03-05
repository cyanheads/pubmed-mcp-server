/**
 * @fileoverview Tests for hand-rolled citation formatters (APA, MLA, BibTeX, RIS).
 * Exercises all exported functions against a shared realistic fixture and
 * a set of edge-case variants.
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

// ---------------------------------------------------------------------------
// Shared fixture
// ---------------------------------------------------------------------------

const sampleArticle: ParsedArticle = {
  pmid: '12345678',
  title: 'A Study of Testing Frameworks',
  authors: [
    { lastName: 'Smith', firstName: 'John', initials: 'J' },
    { lastName: 'Doe', firstName: 'Jane', initials: 'J' },
  ],
  journalInfo: {
    title: 'Journal of Software Testing',
    isoAbbreviation: 'J Softw Test',
    volume: '42',
    issue: '3',
    pages: '100-115',
    publicationDate: { year: '2024', month: 'Mar' },
  },
  doi: '10.1234/test.2024.001',
  keywords: ['testing', 'vitest'],
  abstractText: 'This is a test abstract.',
};

// ---------------------------------------------------------------------------
// formatApa
// ---------------------------------------------------------------------------

describe('formatApa', () => {
  it('standard article with 2 authors uses "&"', () => {
    const result = formatApa(sampleArticle);
    expect(result).toContain('Smith, J., & Doe, J.');
  });

  it('standard article includes year in parens', () => {
    const result = formatApa(sampleArticle);
    expect(result).toContain('(2024).');
  });

  it('standard article includes title', () => {
    const result = formatApa(sampleArticle);
    expect(result).toContain('A Study of Testing Frameworks.');
  });

  it('standard article includes journal with volume and issue', () => {
    const result = formatApa(sampleArticle);
    expect(result).toContain('*Journal of Software Testing*');
    expect(result).toContain('*42*(3)');
    expect(result).toContain('100-115');
  });

  it('article with DOI produces https://doi.org/ URL', () => {
    const result = formatApa(sampleArticle);
    expect(result).toContain('https://doi.org/10.1234/test.2024.001');
  });

  it('article with no authors omits author segment', () => {
    const article: ParsedArticle = { ...sampleArticle, authors: [] };
    const result = formatApa(article);
    expect(result).not.toContain('Smith');
    expect(result).toContain('(2024).');
  });

  it('article with collective name author returns group name', () => {
    const article: ParsedArticle = {
      ...sampleArticle,
      authors: [{ collectiveName: 'The Testing Consortium' }],
    };
    const result = formatApa(article);
    expect(result).toContain('The Testing Consortium');
  });

  it('article with >20 authors uses first 19, ellipsis, then last', () => {
    const manyAuthors = Array.from({ length: 22 }, (_, i) => ({
      lastName: `Author${i + 1}`,
      firstName: 'A',
      initials: 'A',
    }));
    const article: ParsedArticle = { ...sampleArticle, authors: manyAuthors };
    const result = formatApa(article);
    expect(result).toContain('Author1,');
    expect(result).toContain('Author19,');
    expect(result).toContain('...');
    expect(result).toContain('Author22');
    expect(result).not.toContain('Author20,');
    expect(result).not.toContain('Author21,');
  });

  it('article with no date falls back to "(n.d.)"', () => {
    const { journalInfo: _ji, ...rest } = sampleArticle;
    const article: ParsedArticle = rest;
    const result = formatApa(article);
    expect(result).toContain('(n.d.).');
  });

  it('article without journal info omits journal segment', () => {
    const { journalInfo: _, ...rest } = sampleArticle;
    const article: ParsedArticle = rest;
    const result = formatApa(article);
    expect(result).not.toContain('Journal of Software Testing');
  });

  it('strips trailing period from title before adding its own', () => {
    const article: ParsedArticle = {
      ...sampleArticle,
      title: 'A Study of Testing Frameworks.',
    };
    const result = formatApa(article);
    expect(result).not.toMatch(/Frameworks\.\./);
  });

  it('article without DOI has no doi.org URL', () => {
    const { doi: _, ...rest } = sampleArticle;
    const article: ParsedArticle = rest;
    const result = formatApa(article);
    expect(result).not.toContain('doi.org');
  });
});

// ---------------------------------------------------------------------------
// formatMla
// ---------------------------------------------------------------------------

describe('formatMla', () => {
  it('standard article with 2 authors uses "and"', () => {
    const result = formatMla(sampleArticle);
    expect(result).toContain('Smith, John, and Jane Doe.');
  });

  it('3+ authors collapses to "et al."', () => {
    const article: ParsedArticle = {
      ...sampleArticle,
      authors: [
        { lastName: 'Smith', firstName: 'John' },
        { lastName: 'Doe', firstName: 'Jane' },
        { lastName: 'Brown', firstName: 'Bob' },
      ],
    };
    const result = formatMla(article);
    expect(result).toContain('Smith, John, et al.');
    expect(result).not.toContain('Brown');
  });

  it('single author — no "and" or "et al."', () => {
    const article: ParsedArticle = {
      ...sampleArticle,
      authors: [{ lastName: 'Smith', firstName: 'John' }],
    };
    const result = formatMla(article);
    expect(result).toContain('Smith, John.');
    expect(result).not.toContain('and');
    expect(result).not.toContain('et al.');
  });

  it('standard article wraps title in quotes', () => {
    const result = formatMla(sampleArticle);
    expect(result).toContain('"A Study of Testing Frameworks."');
  });

  it('standard article includes journal in italics marker', () => {
    const result = formatMla(sampleArticle);
    expect(result).toContain('*Journal of Software Testing*');
    expect(result).toContain('vol. 42');
    expect(result).toContain('no. 3');
    expect(result).toContain('pp. 100-115');
  });

  it('standard article includes year in journal details', () => {
    const result = formatMla(sampleArticle);
    expect(result).toContain('2024');
  });

  it('article with no date omits year from journal details', () => {
    const article: ParsedArticle = {
      ...sampleArticle,
      journalInfo: (() => {
        const { publicationDate: _, ...rest } = sampleArticle.journalInfo!;
        return rest;
      })(),
    };
    const result = formatMla(article);
    expect(result).not.toContain('n.d.');
  });

  it('article with no authors omits author segment', () => {
    const article: ParsedArticle = { ...sampleArticle, authors: [] };
    const result = formatMla(article);
    expect(result).not.toContain('Smith');
  });

  it('article with DOI appends doi.org URL with trailing period', () => {
    const result = formatMla(sampleArticle);
    expect(result).toContain('https://doi.org/10.1234/test.2024.001.');
  });
});

// ---------------------------------------------------------------------------
// formatBibtex
// ---------------------------------------------------------------------------

describe('formatBibtex', () => {
  it('standard article produces @article{pmid...} structure', () => {
    const result = formatBibtex(sampleArticle);
    expect(result).toMatch(/^@article\{pmid12345678,/);
    expect(result).toMatch(/\}$/);
  });

  it('standard article includes author field with "and" separator', () => {
    const result = formatBibtex(sampleArticle);
    expect(result).toContain('author');
    expect(result).toContain('{Smith}, John and {Doe}, Jane');
  });

  it('standard article includes title, journal, year, volume, number, pages, doi, pmid fields', () => {
    const result = formatBibtex(sampleArticle);
    expect(result).toContain('{A Study of Testing Frameworks}');
    expect(result).toContain('Journal of Software Testing');
    expect(result).toContain('{2024}');
    expect(result).toContain('{42}');
    expect(result).toContain('{3}');
    expect(result).toContain('{100-115}');
    expect(result).toContain('{10.1234/test.2024.001}');
    expect(result).toContain('{12345678}');
  });

  it('escapes special BibTeX characters in title: & % $ # _ { } ~ ^', () => {
    const article: ParsedArticle = {
      ...sampleArticle,
      title: 'A & B: $50 #test_one {braced} ~tilde ^caret',
    };
    const result = formatBibtex(article);
    expect(result).toContain('\\&');
    expect(result).toContain('\\$');
    expect(result).toContain('\\#');
    expect(result).toContain('\\_');
    expect(result).toContain('\\{');
    expect(result).toContain('\\}');
    expect(result).toContain('\\textasciitilde{}');
    expect(result).toContain('\\textasciicircum{}');
  });

  it('collective name author is wrapped in braces', () => {
    const article: ParsedArticle = {
      ...sampleArticle,
      authors: [{ collectiveName: 'The Testing Consortium' }],
    };
    const result = formatBibtex(article);
    expect(result).toContain('{The Testing Consortium}');
  });

  it('article with no date omits year field', () => {
    const { journalInfo: _, ...rest } = sampleArticle;
    const article: ParsedArticle = rest;
    const result = formatBibtex(article);
    expect(result).not.toMatch(/year\s*=/);
  });
});

// ---------------------------------------------------------------------------
// formatRis
// ---------------------------------------------------------------------------

describe('formatRis', () => {
  it('standard article starts with TY - JOUR', () => {
    const result = formatRis(sampleArticle);
    expect(result).toMatch(/^TY {2}- JOUR/);
  });

  it('one AU tag per named author', () => {
    const result = formatRis(sampleArticle);
    const auLines = result.split('\n').filter((l) => l.startsWith('AU  -'));
    expect(auLines).toHaveLength(2);
    expect(auLines[0]).toBe('AU  - Smith, John');
    expect(auLines[1]).toBe('AU  - Doe, Jane');
  });

  it('pages are split into SP and EP tags', () => {
    const result = formatRis(sampleArticle);
    expect(result).toContain('SP  - 100');
    expect(result).toContain('EP  - 115');
  });

  it('keywords appear as individual KW tags', () => {
    const result = formatRis(sampleArticle);
    expect(result).toContain('KW  - testing');
    expect(result).toContain('KW  - vitest');
  });

  it('abstract appears as AB tag', () => {
    const result = formatRis(sampleArticle);
    expect(result).toContain('AB  - This is a test abstract.');
  });

  it('ends with "ER  - " (trailing space)', () => {
    const result = formatRis(sampleArticle);
    const lines = result.split('\n');
    expect(lines.at(-1)).toBe('ER  - ');
  });

  it('collective name author emits AU tag with group name', () => {
    const article: ParsedArticle = {
      ...sampleArticle,
      authors: [{ collectiveName: 'The Testing Consortium' }],
    };
    const result = formatRis(article);
    expect(result).toContain('AU  - The Testing Consortium');
  });

  it('includes journal title as JF and ISO abbreviation as JO', () => {
    const result = formatRis(sampleArticle);
    expect(result).toContain('JF  - Journal of Software Testing');
    expect(result).toContain('JO  - J Softw Test');
  });

  it('includes PubMed URL', () => {
    const result = formatRis(sampleArticle);
    expect(result).toContain('UR  - https://pubmed.ncbi.nlm.nih.gov/12345678/');
  });

  it('article with no date omits PY tag', () => {
    const { journalInfo: _, ...rest } = sampleArticle;
    const article: ParsedArticle = rest;
    const result = formatRis(article);
    expect(result).not.toContain('PY  -');
  });

  it('article with no keywords omits KW tags', () => {
    const article: ParsedArticle = { ...sampleArticle, keywords: [] };
    const result = formatRis(article);
    expect(result).not.toContain('KW  -');
  });
});

// ---------------------------------------------------------------------------
// formatCitation
// ---------------------------------------------------------------------------

describe('formatCitation', () => {
  it('dispatches to formatApa for "apa"', () => {
    const result = formatCitation(sampleArticle, 'apa');
    expect(result).toBe(formatApa(sampleArticle));
  });

  it('dispatches to formatMla for "mla"', () => {
    const result = formatCitation(sampleArticle, 'mla');
    expect(result).toBe(formatMla(sampleArticle));
  });

  it('dispatches to formatBibtex for "bibtex"', () => {
    const result = formatCitation(sampleArticle, 'bibtex');
    expect(result).toBe(formatBibtex(sampleArticle));
  });

  it('dispatches to formatRis for "ris"', () => {
    const result = formatCitation(sampleArticle, 'ris');
    expect(result).toBe(formatRis(sampleArticle));
  });
});

// ---------------------------------------------------------------------------
// formatCitations
// ---------------------------------------------------------------------------

describe('formatCitations', () => {
  it('returns a record keyed by each requested style', () => {
    const result = formatCitations(sampleArticle, ['apa', 'mla']);
    expect(Object.keys(result)).toEqual(expect.arrayContaining(['apa', 'mla']));
    expect(Object.keys(result)).toHaveLength(2);
  });

  it('values match individual formatCitation calls', () => {
    const result = formatCitations(sampleArticle, ['apa', 'bibtex', 'ris']);
    expect(result.apa).toBe(formatCitation(sampleArticle, 'apa'));
    expect(result.bibtex).toBe(formatCitation(sampleArticle, 'bibtex'));
    expect(result.ris).toBe(formatCitation(sampleArticle, 'ris'));
  });

  it('returns all four styles when all are requested', () => {
    const result = formatCitations(sampleArticle, ['apa', 'mla', 'bibtex', 'ris']);
    expect(Object.keys(result)).toHaveLength(4);
    for (const key of ['apa', 'mla', 'bibtex', 'ris']) {
      expect(result[key]).toBeTruthy();
    }
  });

  it('returns an empty record when styles array is empty', () => {
    const result = formatCitations(sampleArticle, []);
    expect(result).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// Internal helpers — exercised through public API
// ---------------------------------------------------------------------------

describe('escapeBibtex (via formatBibtex)', () => {
  it('escapes a literal backslash without double-escaping the braces', () => {
    const article: ParsedArticle = {
      ...sampleArticle,
      title: 'Path C:\\data\\results',
    };
    const result = formatBibtex(article);
    // Should contain \textbackslash{} NOT \textbackslash\{\}
    expect(result).toContain('\\textbackslash{}');
    expect(result).not.toContain('\\textbackslash\\{\\}');
  });

  it('escapes tilde without corrupting the trailing braces', () => {
    const article: ParsedArticle = {
      ...sampleArticle,
      title: 'User ~home directory',
    };
    const result = formatBibtex(article);
    expect(result).toContain('\\textasciitilde{}');
    expect(result).not.toContain('\\textasciitilde\\{\\}');
  });

  it('escapes caret without corrupting the trailing braces', () => {
    const article: ParsedArticle = {
      ...sampleArticle,
      title: 'X^2 convergence',
    };
    const result = formatBibtex(article);
    expect(result).toContain('\\textasciicircum{}');
    expect(result).not.toContain('\\textasciicircum\\{\\}');
  });

  it('handles multiple special characters in one string', () => {
    const article: ParsedArticle = {
      ...sampleArticle,
      title: '\\~^&%$#_{}',
    };
    const result = formatBibtex(article);
    expect(result).toContain('\\textbackslash{}');
    expect(result).toContain('\\textasciitilde{}');
    expect(result).toContain('\\textasciicircum{}');
    expect(result).toContain('\\&');
    expect(result).toContain('\\%');
    expect(result).toContain('\\$');
    expect(result).toContain('\\#');
    expect(result).toContain('\\_');
    expect(result).toContain('\\{');
    expect(result).toContain('\\}');
  });

  it('escapes special characters in author names', () => {
    const article: ParsedArticle = {
      ...sampleArticle,
      authors: [{ lastName: "O'Brien & Sons", firstName: 'José' }],
    };
    const result = formatBibtex(article);
    expect(result).toContain('\\&');
  });
});

describe('formatAuthorApa edge cases', () => {
  it('derives initials from firstName when initials field is absent', () => {
    const article: ParsedArticle = {
      ...sampleArticle,
      authors: [{ lastName: 'Smith', firstName: 'John Michael' }],
    };
    const result = formatApa(article);
    expect(result).toContain('Smith, J. M.');
  });

  it('handles firstName with hyphens (derives initials per part)', () => {
    const article: ParsedArticle = {
      ...sampleArticle,
      authors: [{ lastName: 'Lee', firstName: 'Mei-Ling' }],
    };
    const result = formatApa(article);
    expect(result).toContain('Lee, M. L.');
  });

  it('does not produce "undefined." when firstName has consecutive spaces', () => {
    const article: ParsedArticle = {
      ...sampleArticle,
      authors: [{ lastName: 'Test', firstName: 'A  B' }],
    };
    const result = formatApa(article);
    expect(result).not.toContain('undefined');
  });

  it('author with only lastName, no firstName or initials', () => {
    const article: ParsedArticle = {
      ...sampleArticle,
      authors: [{ lastName: 'Aristotle' }],
    };
    const result = formatApa(article);
    expect(result).toContain('Aristotle');
    expect(result).not.toContain('Aristotle,');
  });

  it('author with only firstName, no lastName', () => {
    const article: ParsedArticle = {
      ...sampleArticle,
      authors: [{ firstName: 'Madonna', initials: 'M' }],
    };
    const result = formatApa(article);
    expect(result).toContain('M.');
  });

  it('author with neither name nor collectiveName produces empty string gracefully', () => {
    const article: ParsedArticle = {
      ...sampleArticle,
      authors: [{}],
    };
    const result = formatApa(article);
    // Should not crash; the empty author contributes nothing meaningful
    expect(typeof result).toBe('string');
  });
});

describe('formatAuthorsApa author-count boundaries', () => {
  it('single author — no ampersand', () => {
    const article: ParsedArticle = {
      ...sampleArticle,
      authors: [{ lastName: 'Solo', initials: 'S' }],
    };
    const result = formatApa(article);
    expect(result).toContain('Solo, S.');
    expect(result).not.toContain('&');
  });

  it('3 authors — comma-separated with & before last', () => {
    const article: ParsedArticle = {
      ...sampleArticle,
      authors: [
        { lastName: 'A', initials: 'X' },
        { lastName: 'B', initials: 'Y' },
        { lastName: 'C', initials: 'Z' },
      ],
    };
    const result = formatApa(article);
    expect(result).toContain('A, X., B, Y., & C, Z.');
  });

  it('exactly 20 authors — all listed, no ellipsis', () => {
    const authors = Array.from({ length: 20 }, (_, i) => ({
      lastName: `Author${i + 1}`,
      initials: 'A',
    }));
    const article: ParsedArticle = { ...sampleArticle, authors };
    const result = formatApa(article);
    expect(result).toContain('Author1');
    expect(result).toContain('Author20');
    expect(result).toContain('& Author20');
    expect(result).not.toContain('...');
  });

  it('exactly 21 authors — triggers ellipsis rule', () => {
    const authors = Array.from({ length: 21 }, (_, i) => ({
      lastName: `Author${i + 1}`,
      initials: 'A',
    }));
    const article: ParsedArticle = { ...sampleArticle, authors };
    const result = formatApa(article);
    expect(result).toContain('Author19');
    expect(result).toContain('...');
    expect(result).toContain('Author21');
    expect(result).not.toContain('Author20');
  });
});

describe('splitPages (via formatRis)', () => {
  it('splits pages with en-dash', () => {
    const article: ParsedArticle = {
      ...sampleArticle,
      journalInfo: { ...sampleArticle.journalInfo!, pages: '100\u2013115' },
    };
    const result = formatRis(article);
    expect(result).toContain('SP  - 100');
    expect(result).toContain('EP  - 115');
  });

  it('splits pages with em-dash', () => {
    const article: ParsedArticle = {
      ...sampleArticle,
      journalInfo: { ...sampleArticle.journalInfo!, pages: '200\u2014250' },
    };
    const result = formatRis(article);
    expect(result).toContain('SP  - 200');
    expect(result).toContain('EP  - 250');
  });

  it('single page number only emits SP, no EP', () => {
    const article: ParsedArticle = {
      ...sampleArticle,
      journalInfo: { ...sampleArticle.journalInfo!, pages: 'e12345' },
    };
    const result = formatRis(article);
    expect(result).toContain('SP  - e12345');
    expect(result).not.toMatch(/EP {2}-/);
  });

  it('no pages omits both SP and EP', () => {
    const { pages: _, ...journalWithoutPages } = sampleArticle.journalInfo!;
    const article: ParsedArticle = {
      ...sampleArticle,
      journalInfo: journalWithoutPages,
    };
    const result = formatRis(article);
    expect(result).not.toMatch(/SP {2}-/);
    expect(result).not.toMatch(/EP {2}-/);
  });
});

describe('minimal article (pmid only)', () => {
  const minimal: ParsedArticle = { pmid: '99999999' };

  it('formatApa returns year fallback only', () => {
    const result = formatApa(minimal);
    expect(result).toContain('(n.d.).');
    expect(result).not.toContain('doi.org');
  });

  it('formatMla returns empty-ish string without crashing', () => {
    const result = formatMla(minimal);
    expect(typeof result).toBe('string');
  });

  it('formatBibtex returns valid structure with pmid field', () => {
    const result = formatBibtex(minimal);
    expect(result).toMatch(/^@article\{pmid99999999,/);
    expect(result).toContain('{99999999}');
    expect(result).toMatch(/\}$/);
  });

  it('formatRis includes TY, AN, UR, ER tags', () => {
    const result = formatRis(minimal);
    expect(result).toContain('TY  - JOUR');
    expect(result).toContain('AN  - 99999999');
    expect(result).toContain('UR  - https://pubmed.ncbi.nlm.nih.gov/99999999/');
    expect(result).toContain('ER  - ');
  });
});

describe('formatMla edge cases', () => {
  it('collective name author works', () => {
    const article: ParsedArticle = {
      ...sampleArticle,
      authors: [{ collectiveName: 'WHO Working Group' }],
    };
    const result = formatMla(article);
    expect(result).toContain('WHO Working Group.');
  });

  it('author with only lastName', () => {
    const article: ParsedArticle = {
      ...sampleArticle,
      authors: [{ lastName: 'Plato' }],
    };
    const result = formatMla(article);
    expect(result).toContain('Plato.');
  });

  it('journal without volume or issue only shows title and year', () => {
    const article: ParsedArticle = {
      ...sampleArticle,
      journalInfo: {
        title: 'Nature',
        publicationDate: { year: '2024' },
      },
    };
    const result = formatMla(article);
    expect(result).toContain('*Nature*');
    expect(result).not.toContain('vol.');
    expect(result).not.toContain('no.');
  });
});

describe('formatBibtex edge cases', () => {
  it('author with only firstName (no lastName)', () => {
    const article: ParsedArticle = {
      ...sampleArticle,
      authors: [{ firstName: 'Madonna' }],
    };
    const result = formatBibtex(article);
    expect(result).toContain('Madonna');
  });

  it('author with only lastName (no firstName)', () => {
    const article: ParsedArticle = {
      ...sampleArticle,
      authors: [{ lastName: 'Aristotle' }],
    };
    const result = formatBibtex(article);
    expect(result).toContain('{Aristotle}');
  });

  it('empty authors array omits author field', () => {
    const article: ParsedArticle = { ...sampleArticle, authors: [] };
    const result = formatBibtex(article);
    expect(result).not.toMatch(/author\s*=/);
  });

  it('journal without volume omits volume field', () => {
    const article: ParsedArticle = {
      ...sampleArticle,
      journalInfo: { title: 'Test Journal', publicationDate: { year: '2024' } },
    };
    const result = formatBibtex(article);
    expect(result).not.toMatch(/volume\s*=/);
    expect(result).not.toMatch(/number\s*=/);
    expect(result).not.toMatch(/pages\s*=/);
  });
});
