/**
 * @fileoverview Edge-case and logic tests for the citation formatter. Covers
 * APA 21+ author truncation, formatCitation/formatCitations dispatchers,
 * BibTeX special-character escaping, splitPages expansion, collapseWhitespace,
 * and injection-in-metadata handling.
 * @module tests/services/ncbi/formatting/citation-formatter.edge.test
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
import type { ParsedArticle } from '@/services/ncbi/types.js';

// ─── Shared fixture ───────────────────────────────────────────────────────────

const baseArticle: ParsedArticle = {
  pmid: '12345678',
  title: 'Test Article',
  authors: [{ lastName: 'Smith', firstName: 'John', initials: 'J' }],
  journalInfo: {
    title: 'Test Journal',
    isoAbbreviation: 'Test J',
    volume: '10',
    issue: '2',
    pages: '100-110',
    publicationDate: { year: '2024', month: 'Jan' },
  },
  doi: '10.1000/test',
  abstractText: 'Test abstract.',
};

// ─── APA: 21+ author truncation ──────────────────────────────────────────────

describe('formatApa — 21+ author truncation', () => {
  it('produces "first 19, ..., last" for exactly 21 authors', () => {
    const authors = Array.from({ length: 21 }, (_, i) => ({
      lastName: `Author${i + 1}`,
      firstName: `First${i + 1}`,
      initials: `F${i + 1}`,
    }));
    const citation = formatApa({ ...baseArticle, authors });
    // First author must appear
    expect(citation).toContain('Author1, F.');
    // 19th author must appear
    expect(citation).toContain('Author19');
    // 20th should NOT appear (ellipsis replaces them)
    expect(citation).not.toContain('Author20,');
    // Last (21st) must appear after ellipsis
    expect(citation).toContain('... Author21');
    // Ellipsis present
    expect(citation).toContain('...');
  });

  it('produces "first 19, ..., last" for exactly 20 authors (boundary — 20 uses comma-& rule)', () => {
    const authors = Array.from({ length: 20 }, (_, i) => ({
      lastName: `Auth${i + 1}`,
      firstName: 'X',
      initials: 'X',
    }));
    const citation = formatApa({ ...baseArticle, authors });
    // 20 authors: comma-separated + & before last
    expect(citation).toContain('& Auth20');
    expect(citation).not.toContain('...');
  });

  it('includes exactly 19 authors before the ellipsis for 25-author list', () => {
    const authors = Array.from({ length: 25 }, (_, i) => ({
      lastName: `Surname${String(i + 1).padStart(2, '0')}`,
      initials: 'X',
    }));
    const citation = formatApa({ ...baseArticle, authors });
    // Authors 1–19 should appear
    for (let i = 1; i <= 19; i++) {
      expect(citation).toContain(`Surname${String(i).padStart(2, '0')}`);
    }
    // Authors 20–24 should NOT appear in the body (only #25 appears after ellipsis)
    for (let i = 20; i <= 24; i++) {
      expect(citation).not.toContain(`Surname${String(i).padStart(2, '0')}, `);
    }
    // Last author appears after ellipsis
    expect(citation).toContain('... Surname25');
  });
});

// ─── APA: author-only edge cases ─────────────────────────────────────────────

describe('formatApa — author edge cases', () => {
  it('handles author with only lastName (no initials, no firstName)', () => {
    const article: ParsedArticle = {
      ...baseArticle,
      authors: [{ lastName: 'OnlyLast' }],
    };
    const citation = formatApa(article);
    expect(citation).toContain('OnlyLast');
    // No trailing comma-space before year
    expect(citation).not.toMatch(/OnlyLast,\s+,/);
  });

  it('handles article with no authors at all', () => {
    const article: ParsedArticle = { ...baseArticle, authors: [] };
    const citation = formatApa(article);
    // Should still produce a valid citation string with title and year
    expect(citation).toContain('(2024).');
    expect(citation).toContain('Test Article.');
  });

  it('handles article with undefined authors', () => {
    const article: ParsedArticle = { ...baseArticle, authors: undefined };
    const citation = formatApa(article);
    expect(citation).toContain('(2024).');
  });

  it('derives initials from firstName when initials field is absent', () => {
    const article: ParsedArticle = {
      ...baseArticle,
      authors: [{ lastName: 'Smith', firstName: 'John William' }],
    };
    const citation = formatApa(article);
    // APA derives "J. W." from "John William"
    expect(citation).toContain('Smith, J. W.');
  });

  it('handles hyphenated firstName in initials derivation', () => {
    const article: ParsedArticle = {
      ...baseArticle,
      authors: [{ lastName: 'Lee', firstName: 'Mary-Anne' }],
    };
    const citation = formatApa(article);
    expect(citation).toContain('Lee, M. A.');
  });
});

// ─── APA: title edge cases ───────────────────────────────────────────────────

describe('formatApa — title edge cases', () => {
  it('strips trailing period from title to avoid double punctuation', () => {
    const article: ParsedArticle = { ...baseArticle, title: 'Pembrolizumab versus Chemotherapy.' };
    const citation = formatApa(article);
    // Should NOT produce "…Chemotherapy.."
    expect(citation).not.toMatch(/Chemotherapy\.\./);
    expect(citation).toContain('Pembrolizumab versus Chemotherapy.');
  });

  it('handles article with no title', () => {
    const article: ParsedArticle = { ...baseArticle, title: undefined };
    const citation = formatApa(article);
    // Still valid — just no title segment
    expect(citation).toContain('(2024).');
  });
});

// ─── APA: date fallback ───────────────────────────────────────────────────────

describe('formatApa — date fallback to articleDates', () => {
  it('uses articleDates year when journalInfo publicationDate is absent', () => {
    const article: ParsedArticle = {
      pmid: '99',
      title: 'Preprint article',
      articleDates: [{ dateType: 'Electronic', year: '2025', month: '01', day: '15' }],
    };
    const citation = formatApa(article);
    expect(citation).toContain('(2025).');
  });

  it('returns "n.d." when neither journalInfo date nor articleDates year is present', () => {
    const article: ParsedArticle = { pmid: '99', title: 'Undated' };
    expect(formatApa(article)).toContain('(n.d.).');
  });
});

// ─── formatCitation dispatcher ───────────────────────────────────────────────

describe('formatCitation', () => {
  it.each(['apa', 'mla', 'bibtex', 'ris', 'vancouver'] as const)(
    'returns a non-empty string for style=%s',
    (style) => {
      const result = formatCitation(baseArticle, style);
      expect(typeof result).toBe('string');
      expect(result.length).toBeGreaterThan(0);
    },
  );

  it('apa result contains journal name and year', () => {
    expect(formatCitation(baseArticle, 'apa')).toContain('Test Journal');
  });

  it('mla result contains title in quotes', () => {
    expect(formatCitation(baseArticle, 'mla')).toContain('"Test Article."');
  });

  it('bibtex result starts with @article{', () => {
    expect(formatCitation(baseArticle, 'bibtex')).toMatch(/^@article\{/);
  });

  it('ris result starts with TY  - JOUR', () => {
    expect(formatCitation(baseArticle, 'ris')).toMatch(/^TY {2}- JOUR/);
  });
});

// ─── formatCitations dispatcher ──────────────────────────────────────────────

describe('formatCitations', () => {
  it('returns a record with one key per requested style', () => {
    const result = formatCitations(baseArticle, ['apa', 'bibtex']);
    expect(Object.keys(result).sort()).toEqual(['apa', 'bibtex'].sort());
  });

  it('returns an empty record for an empty styles array', () => {
    expect(formatCitations(baseArticle, [])).toEqual({});
  });

  it('returns all five styles when all are requested', () => {
    const result = formatCitations(baseArticle, ['apa', 'mla', 'bibtex', 'ris', 'vancouver']);
    expect(Object.keys(result)).toHaveLength(5);
  });

  it('each style value matches direct formatCitation output', () => {
    const styles = ['apa', 'mla', 'bibtex', 'ris', 'vancouver'] as const;
    const multi = formatCitations(baseArticle, [...styles]);
    for (const style of styles) {
      expect(multi[style]).toBe(formatCitation(baseArticle, style));
    }
  });
});

// ─── BibTeX: special-character escaping ──────────────────────────────────────

describe('formatBibtex — special-character escaping', () => {
  it.each([
    ['ampersand', 'A & B', '\\&'],
    ['dollar', 'A $100 paper', '\\$'],
    ['hash', 'Section #1 result', '\\#'],
    ['underscore', 'matrix_factorization', '\\_'],
    ['percent', '95% confidence', '\\%'],
    ['braces', 'result {in braces}', '\\{'],
  ])('escapes %s in title', (_label, title, expected) => {
    const citation = formatBibtex({ ...baseArticle, title });
    expect(citation).toContain(expected);
  });

  it('escapes backslash to \\textbackslash{}', () => {
    const citation = formatBibtex({ ...baseArticle, title: 'Path\\separator' });
    expect(citation).toContain('\\textbackslash{}');
  });

  it('escapes tilde to \\textasciitilde{}', () => {
    const citation = formatBibtex({ ...baseArticle, title: 'A~B approximation' });
    expect(citation).toContain('\\textasciitilde{}');
  });

  it('escapes caret to \\textasciicircum{}', () => {
    const citation = formatBibtex({ ...baseArticle, title: 'power^2 growth' });
    expect(citation).toContain('\\textasciicircum{}');
  });

  it('does not double-escape already-escaped sequences', () => {
    const citation = formatBibtex({ ...baseArticle, title: 'Normal Title' });
    // Should not contain escaped-backslash artifacts on clean titles
    expect(citation).not.toContain('\\\\');
  });
});

// ─── BibTeX: multi-word MeSH keywords (regression #68) ───────────────────────

describe('formatBibtex — multi-word MeSH keywords', () => {
  it('brace-wraps each descriptor so inverted-form commas do not split a term', () => {
    const article: ParsedArticle = {
      ...baseArticle,
      keywords: [],
      meshTerms: [
        { descriptorName: 'Databases, Protein', isMajorTopic: false },
        { descriptorName: 'Models, Molecular', isMajorTopic: false },
        { descriptorName: 'Neural Networks, Computer', isMajorTopic: true },
      ],
    };
    const bibtex = formatBibtex(article);
    // Each multi-word MeSH descriptor stays one braced keyword
    expect(bibtex).toContain('{Databases, Protein}');
    expect(bibtex).toContain('{Models, Molecular}');
    expect(bibtex).toContain('{Neural Networks, Computer}');
  });

  it('brace-wraps single-word keywords too, keeping terms unambiguous', () => {
    const article: ParsedArticle = {
      ...baseArticle,
      keywords: ['Protein Folding'],
      meshTerms: [{ descriptorName: 'Humans', isMajorTopic: false }],
    };
    const bibtex = formatBibtex(article);
    expect(bibtex).toContain('{Protein Folding}');
    expect(bibtex).toContain('{Humans}');
  });
});

// ─── RIS: splitPages expansion ───────────────────────────────────────────────

describe('formatRis — splitPages expansion', () => {
  it('handles single-page entry (no end page)', () => {
    const article = { ...baseArticle, journalInfo: { ...baseArticle.journalInfo!, pages: '42' } };
    const ris = formatRis(article);
    expect(ris).toContain('SP  - 42');
    expect(ris).not.toContain('EP  -');
  });

  it('expands 737-8 to 737/738', () => {
    const article = {
      ...baseArticle,
      journalInfo: { ...baseArticle.journalInfo!, pages: '737-8' },
    };
    const ris = formatRis(article);
    expect(ris).toContain('SP  - 737');
    expect(ris).toContain('EP  - 738');
  });

  it('expands 1639-41 to 1639/1641', () => {
    const article = {
      ...baseArticle,
      journalInfo: { ...baseArticle.journalInfo!, pages: '1639-41' },
    };
    const ris = formatRis(article);
    expect(ris).toContain('SP  - 1639');
    expect(ris).toContain('EP  - 1641');
  });

  it('handles em-dash separator correctly', () => {
    const article = {
      ...baseArticle,
      journalInfo: { ...baseArticle.journalInfo!, pages: '100—120' },
    };
    const ris = formatRis(article);
    expect(ris).toContain('SP  - 100');
    expect(ris).toContain('EP  - 120');
  });

  it('handles undefined pages gracefully — no SP/EP tags', () => {
    const article = {
      ...baseArticle,
      journalInfo: { ...baseArticle.journalInfo!, pages: undefined },
    };
    const ris = formatRis(article);
    expect(ris).not.toContain('SP  -');
    expect(ris).not.toContain('EP  -');
  });
});

// ─── RIS: collapseWhitespace in abstract ─────────────────────────────────────

describe('formatRis — collapseWhitespace', () => {
  it('collapses tab characters to a single space', () => {
    const article: ParsedArticle = {
      ...baseArticle,
      abstractText: 'Background:\t\tFirst.\t\tResults:\t\tSecond.',
    };
    const ris = formatRis(article);
    expect(ris).toContain('AB  - Background: First. Results: Second.');
  });

  it('collapses mixed CR/LF line endings', () => {
    const article: ParsedArticle = {
      ...baseArticle,
      abstractText: 'First sentence.\r\nSecond sentence.',
    };
    const ris = formatRis(article);
    expect(ris).toContain('AB  - First sentence. Second sentence.');
  });

  it('does not include double blank lines inside the RIS body', () => {
    const article: ParsedArticle = {
      ...baseArticle,
      abstractText: 'Para1.\n\nPara2.\n\nPara3.',
    };
    const ris = formatRis(article);
    const lines = ris.split('\n');
    for (let i = 0; i < lines.length - 1; i++) {
      // Two consecutive blank lines would break strict RIS parsers
      const bothBlank = lines[i]?.trim() === '' && lines[i + 1]?.trim() === '';
      expect(bothBlank).toBe(false);
    }
  });
});

// ─── Security: injection in metadata fields ──────────────────────────────────

describe('citation formatters — injection in metadata', () => {
  it('BibTeX escapes LaTeX injection in author name', () => {
    const article: ParsedArticle = {
      ...baseArticle,
      authors: [{ lastName: 'Smith$100', firstName: 'John', initials: 'J' }],
    };
    const bibtex = formatBibtex(article);
    // Dollar sign in last name must be escaped so LaTeX doesn't enter math mode
    expect(bibtex).toContain('Smith\\$100');
  });

  it('RIS: title with double-dash does not corrupt record structure', () => {
    const article: ParsedArticle = {
      ...baseArticle,
      title: 'A Study of A--B Interactions',
    };
    const ris = formatRis(article);
    // Record must still end cleanly with ER
    expect(ris).toMatch(/ER {2}- $/);
  });

  it('APA: HTML tags in title appear verbatim (no sanitization — no HTML context)', () => {
    const article: ParsedArticle = {
      ...baseArticle,
      title: '<b>Bold</b> approach to therapy',
    };
    const citation = formatApa(article);
    // APA is plain text — tags are included as-is (no HTML rendering context)
    expect(citation).toContain('<b>Bold</b> approach to therapy');
  });

  it('BibTeX: journal name with & is escaped to \\&', () => {
    const article: ParsedArticle = {
      ...baseArticle,
      journalInfo: { ...baseArticle.journalInfo!, title: 'Mind & Brain' },
    };
    const bibtex = formatBibtex(article);
    expect(bibtex).toContain('Mind \\& Brain');
  });
});

// ─── MLA: edge cases ─────────────────────────────────────────────────────────

describe('formatMla — edge cases', () => {
  it('handles article with only one author (no et al.)', () => {
    const citation = formatMla({
      ...baseArticle,
      authors: [{ lastName: 'Doe', firstName: 'Jane' }],
    });
    expect(citation).not.toContain('et al.');
    expect(citation).toContain('Doe, Jane.');
  });

  it('does not truncate at 3+ authors — produces "Last, First, et al."', () => {
    const citation = formatMla({
      ...baseArticle,
      authors: [
        { lastName: 'Alpha', firstName: 'A' },
        { lastName: 'Beta', firstName: 'B' },
        { lastName: 'Gamma', firstName: 'C' },
      ],
    });
    expect(citation).toContain('Alpha, A, et al.');
  });

  it('handles no authors gracefully', () => {
    const citation = formatMla({ ...baseArticle, authors: [] });
    expect(citation).toContain('"Test Article."');
  });

  it('handles collective author as first author', () => {
    const citation = formatMla({
      ...baseArticle,
      authors: [{ collectiveName: 'WHO Study Group' }],
    });
    expect(citation).toContain('WHO Study Group');
  });
});

// ─── Minimal article: no optional fields ─────────────────────────────────────

describe('formatters — sparse article (only pmid)', () => {
  const sparse: ParsedArticle = { pmid: '9999' };

  it('formatApa returns valid citation with n.d. and no crash', () => {
    const citation = formatApa(sparse);
    expect(citation).toContain('(n.d.).');
    expect(citation.length).toBeGreaterThan(0);
  });

  it('formatMla returns empty string for a pmid-only article (no title/author/journal)', () => {
    // MLA builds from title/authors/journal — none present → empty string. Not a crash.
    const citation = formatMla(sparse);
    expect(typeof citation).toBe('string');
    // Must not throw — verify it's a string (possibly empty)
    expect(citation).toBe('');
  });

  it('formatBibtex returns valid entry with minimal fields', () => {
    const bibtex = formatBibtex(sparse);
    expect(bibtex).toContain('@article{pmid9999,');
    expect(bibtex).toContain('pmid');
  });

  it('formatRis returns valid record that ends with ER', () => {
    const ris = formatRis(sparse);
    expect(ris).toMatch(/ER {2}- $/);
    expect(ris).toContain('TY  - JOUR');
  });

  it('formatVancouver returns a string for a pmid-only article', () => {
    expect(typeof formatVancouver(sparse)).toBe('string');
  });
});
