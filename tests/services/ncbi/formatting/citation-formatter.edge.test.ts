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
  formatCitations,
  formatMla,
  formatRis,
  formatVancouver,
} from '@/services/ncbi/formatting/citation-formatter.js';
import type { ParsedArticle } from '@/services/ncbi/types.js';

// ─── Shared fixture ───────────────────────────────────────────────────────────

const baseArticle: ParsedArticle = {
  recordType: 'journal-article',
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
    // The bare surname is the whole author element: no dangling comma before the year
    expect(formatApa(article)).toMatch(/^OnlyLast\. \(2024\)\. Test Article\./);
  });

  it('moves the title into the author position when a record has no authors (#139)', () => {
    // APA 7 §9.12: with no author the title takes the author position — the
    // reference must not open on the year.
    const article: ParsedArticle = { ...baseArticle, authors: [] };
    const citation = formatApa(article);

    expect(citation).toBe(
      'Test Article. (2024). *Test Journal*, *10*(2), 100\u{2013}110. https://doi.org/10.1000/test',
    );
    expect(citation).not.toMatch(/^\(2024\)\./);
  });

  it('moves the title into the author position when authors is undefined (#139)', () => {
    const { authors: _authors, ...article } = baseArticle;
    const citation = formatApa(article);

    expect(citation).toMatch(/^Test Article\. \(2024\)\./);
    // The title takes the author position exactly once — it is not repeated
    // after the year.
    expect(citation.match(/Test Article/g)).toHaveLength(1);
  });

  it('keeps the author position for a record that has authors (#139)', () => {
    expect(formatApa(baseArticle)).toMatch(/^Smith, J\. \(2024\)\. Test Article\./);
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
    const { title: _title, ...article } = baseArticle;
    // No title segment at all — the year runs straight into the journal
    expect(formatApa(article)).toBe(
      'Smith, J. (2024). *Test Journal*, *10*(2), 100\u{2013}110. https://doi.org/10.1000/test',
    );
  });
});

// ─── APA: date fallback ───────────────────────────────────────────────────────

describe('formatApa — date fallback to articleDates', () => {
  it('uses articleDates year when journalInfo publicationDate is absent', () => {
    const article: ParsedArticle = {
      recordType: 'journal-article',
      pmid: '99',
      title: 'Preprint article',
      articleDates: [{ dateType: 'Electronic', year: '2025', month: '01', day: '15' }],
    };
    const citation = formatApa(article);
    expect(citation).toContain('(2025).');
  });

  it('returns "n.d." when neither journalInfo date nor articleDates year is present', () => {
    const article: ParsedArticle = {
      recordType: 'journal-article',
      pmid: '99',
      title: 'Undated',
    };
    expect(formatApa(article)).toContain('(n.d.).');
  });

  it('keeps a journal article dated by articleDates to the year in every style (#189)', () => {
    // The full-date rendering is a Bookshelf chapter's alone; a journal record's
    // `ArticleDate` still contributes only its year, and RIS gains no `DA`.
    const article: ParsedArticle = {
      recordType: 'journal-article',
      pmid: '99',
      title: 'Preprint article',
      journalInfo: { title: 'Test Journal' },
      articleDates: [{ dateType: 'Electronic', year: '2025', month: '1', day: '15' }],
    };
    expect(formatMla(article)).toBe('"Preprint article." *Test Journal*, 2025.');
    expect(formatRis(article)).toContain('PY  - 2025\n');
    expect(formatRis(article)).not.toContain('DA  - ');
    expect(formatVancouver(article)).toBe('Preprint article. Test Journal. 2025.');
  });

  it('keeps a whole-book record on its book date even when it carries record dates (#189)', () => {
    // Only a chapter is cited by its own ContributionDate/DateRevised.
    const article: ParsedArticle = {
      recordType: 'book',
      pmid: '99',
      title: 'A Book',
      book: { title: 'A Book', publisher: 'Pub', pubDate: '2020' },
      articleDates: [{ dateType: 'DateRevised', year: '2024', month: '3', day: '1' }],
    };
    expect(formatApa(article)).toContain('(2020).');
    expect(formatMla(article)).toBe('*A Book*, Pub, 2020.');
    expect(formatRis(article)).not.toContain('DA  - ');
    expect(formatVancouver(article)).toBe('A Book. Pub; 2020.');
  });
});

// ─── formatCitations dispatcher ──────────────────────────────────────────────

describe('formatCitations', () => {
  it('returns an empty record for an empty styles array', () => {
    expect(formatCitations(baseArticle, [])).toEqual({});
  });

  it('keys each requested style to that style formatter output', () => {
    expect(formatCitations(baseArticle, ['apa', 'mla', 'bibtex', 'ris', 'vancouver'])).toEqual({
      apa: formatApa(baseArticle),
      mla: formatMla(baseArticle),
      bibtex: formatBibtex(baseArticle),
      ris: formatRis(baseArticle),
      vancouver: formatVancouver(baseArticle),
    });
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

  it('escapes each special character exactly once', () => {
    const citation = formatBibtex({ ...baseArticle, title: 'A & B_c' });
    expect(citation).toMatch(/^ {2}title += \{\{A \\& B\\_c\}\},$/m);
    expect(citation).not.toContain('\\textbackslash{}');
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
    const { pages: _pages, ...journalInfo } = baseArticle.journalInfo!;
    const article: ParsedArticle = { ...baseArticle, journalInfo };
    const ris = formatRis(article);
    expect(ris).not.toContain('SP  -');
    expect(ris).not.toContain('EP  -');
  });
});

// ─── APA: page range forms (#217) ────────────────────────────────────────────

describe('formatApa — page range forms (#217)', () => {
  const apaPages = (pages: string) =>
    /\*10\*\(2\), (.+)\. https:/.exec(
      formatApa({ ...baseArticle, journalInfo: { ...baseArticle.journalInfo!, pages } }),
    )?.[1];

  it.each([
    ['737-8', '737\u{2013}738'],
    ['e60-e65', 'e60\u{2013}e65'],
    ['e60-5', 'e60\u{2013}e65'],
    ['100\u{2014}120', '100\u{2013}120'],
    ['45\u{2013}52', '45\u{2013}52'],
    ['42', '42'],
    // A supplement range carries the start's prefix to an end NLM wrote bare
    ['S56-73', 'S56\u{2013}S73'],
    ['S5-15', 'S5\u{2013}S15'],
    ['S87-109', 'S87\u{2013}S109'],
    ['1255.e1-5', '1255.e1\u{2013}1255.e5'],
  ])('writes %s as %s', (pages, apa) => {
    expect(apaPages(pages)).toBe(apa);
  });

  it('writes each range of a list in full, keeping the rest of its text', () => {
    expect(apaPages('123-5, 130-2')).toBe('123\u{2013}125, 130\u{2013}132');
    expect(apaPages('61-6, 70-4, 76 passim')).toBe('61\u{2013}66, 70\u{2013}74, 76 passim');
    expect(apaPages('1407-8; author reply 1409-10')).toBe(
      '1407\u{2013}1408; author reply 1409\u{2013}1410',
    );
  });

  it('expands only a digit end: a Roman-numeral range is written as NLM gives it', () => {
    expect(apaPages('xii-xv')).toBe('xii\u{2013}xv');
  });

  it('leaves MLA on the page text NLM gives', () => {
    const article = {
      ...baseArticle,
      journalInfo: { ...baseArticle.journalInfo!, pages: '737-8' },
    };
    expect(formatMla(article)).toContain('pp. 737-8.');
  });
});

// ─── APA and MLA: journal title case (#217) ──────────────────────────────────

describe('formatApa and formatMla — journal title case edge cases (#217)', () => {
  const journalOf = (citation: string) => /\*(.+)\*/.exec(citation)?.[1];
  const cased = (title: string) => {
    const article: ParsedArticle = {
      recordType: 'journal-article',
      pmid: '1',
      journalInfo: { title },
    };
    return [journalOf(formatApa(article)), journalOf(formatMla(article))];
  };

  it.each([
    // A word carrying a digit is left as written
    ['Journal of 3d printing', 'Journal of 3d Printing'],
    // An apostrophe stays inside the word, straight or curly
    ["Journal of women's health (2002)", "Journal of Women's Health (2002)"],
    ['Journal of women\u{2019}s health', 'Journal of Women\u{2019}s Health'],
    // Lowercase is Unicode lowercase
    ['Revista m\u{e9}dica de Chile', 'Revista M\u{e9}dica de Chile'],
    // A parallel title after " = " opens on a capital, even on a minor word
    [
      'Zhonghua er ke za zhi = Chinese journal of pediatrics',
      'Zhonghua Er Ke Za Zhi = Chinese Journal of Pediatrics',
    ],
    ['Journal = a review', 'Journal = A Review'],
    // A colon or semicolon set against the word opens a subtitle as well
    ['CA: a cancer journal for clinicians', 'CA: A Cancer Journal for Clinicians'],
    [
      'Drug metabolism and disposition: the biological fate of chemicals',
      'Drug Metabolism and Disposition: The Biological Fate of Chemicals',
    ],
    ['Isis; an international review', 'Isis; An International Review'],
    ['Child: care, health and development', 'Child: Care, Health and Development'],
    // Punctuation around a word does not hide it
    ['BMJ (Clinical research ed.)', 'BMJ (Clinical Research Ed.)'],
    ['JMIR mHealth and uHealth', 'JMIR mHealth and uHealth'],
    // A French or Italian elision keeps its particle lowercase and capitalizes the word
    ["Journal francais d'ophtalmologie", "Journal Francais d'Ophtalmologie"],
    [
      "Neuropsychiatrie de l'enfance et de l'adolescence",
      "Neuropsychiatrie de l'Enfance et de l'Adolescence",
    ],
    [
      "Archivio italiano delle malattie dell'apparato digerente",
      "Archivio Italiano delle Malattie dell'Apparato Digerente",
    ],
    ["l'annee psychologique", "L'Annee Psychologique"],
    // The particles of the other languages NLM catalogs stay lowercase
    ['Akusherstvo i ginekologiia', 'Akusherstvo i Ginekologiia'],
    ['Roczniki Akademii Medycznej w Bialymstoku', 'Roczniki Akademii Medycznej w Bialymstoku'],
    [
      'Tidsskrift for den Norske laegeforening : tidsskrift for praktisk medicin, ny raekke',
      'Tidsskrift for den Norske Laegeforening : Tidsskrift for Praktisk Medicin, Ny Raekke',
    ],
    ['Beitrage zur gerichtlichen Medizin', 'Beitrage zur Gerichtlichen Medizin'],
    ['Turk hijiyen ve deneysel biyoloji dergisi', 'Turk Hijiyen ve Deneysel Biyoloji Dergisi'],
    ['Brain and nerve = Shinkei kenkyu no shinpo', 'Brain and Nerve = Shinkei Kenkyu no Shinpo'],
    [
      'South African medical journal = Suid-Afrikaanse tydskrif vir geneeskunde',
      'South African Medical Journal = Suid-Afrikaanse Tydskrif vir Geneeskunde',
    ],
    // ...but never a romanized Chinese syllable, nor a place name's own word
    ['Zhongguo fei ai za zhi', 'Zhongguo Fei Ai Za Zhi'],
    ['African review (Dar es Salaam, Tanzania)', 'African Review (Dar es Salaam, Tanzania)'],
    // A brand NLM writes in lowercase keeps it
    ['npj quantum materials', 'npj Quantum Materials'],
    ['i-Perception', 'i-Perception'],
    ['e-SPEN journal', 'e-SPEN Journal'],
  ])('%s → %s', (nlm, titleCase) => {
    expect(cased(nlm)).toEqual([titleCase, titleCase]);
  });

  it('leaves a book title as the record gives it', () => {
    const book: ParsedArticle = {
      recordType: 'book',
      pmid: '1',
      title: 'Clinical methods',
      authors: [{ lastName: 'Walker', firstName: 'H Kenneth', initials: 'HK' }],
      book: { title: 'Clinical methods', publisher: 'Butterworths' },
    };
    expect(formatApa(book)).toContain('*Clinical methods*.');
    expect(formatMla(book)).toContain('*Clinical methods*,');
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

  it('keeps a paragraphed abstract on one AB line, every line a tag', () => {
    const article: ParsedArticle = {
      ...baseArticle,
      abstractText: 'Para1.\n\nPara2.\n\nPara3.',
    };
    const lines = formatRis(article).split('\n');
    // A blank or untagged line would end or corrupt the record in strict RIS parsers
    expect(lines.every((line) => /^[A-Z][A-Z0-9] {2}- /.test(line))).toBe(true);
    expect(lines).toContain('AB  - Para1. Para2. Para3.');
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
    const lines = formatRis(article).split('\n');
    expect(lines).toContain('TI  - A Study of A--B Interactions');
    expect(lines.every((line) => /^[A-Z][A-Z0-9] {2}- /.test(line))).toBe(true);
    expect(lines.at(-1)).toBe('ER  - ');
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
  const sparse: ParsedArticle = { recordType: 'journal-article', pmid: '9999' };

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

  it('formatBibtex returns an entry carrying only the pmid field', () => {
    expect(formatBibtex(sparse)).toBe('@article{pmid9999,\n  pmid = {9999}\n}');
  });

  it('formatRis returns valid record that ends with ER', () => {
    const ris = formatRis(sparse);
    expect(ris).toMatch(/ER {2}- $/);
    expect(ris).toContain('TY  - JOUR');
  });

  it('formatVancouver returns an empty string for a pmid-only article', () => {
    expect(formatVancouver(sparse)).toBe('');
  });
});
