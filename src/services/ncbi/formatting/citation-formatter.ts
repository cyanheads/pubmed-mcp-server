/**
 * @fileoverview Hand-rolled citation formatters for PubMed articles.
 * Supports APA 7th, MLA 9th, BibTeX, RIS, and Vancouver (ICMJE/NLM) formats.
 * Pure TypeScript, zero dependencies, Workers-compatible.
 * @module src/services/ncbi/formatting/citation-formatter
 */

import type {
  ParsedArticle,
  ParsedArticleAuthor,
  ParsedBookEditor,
  ParsedBookInfo,
  ParsedJournalInfo,
} from '../types.js';

/** Supported citation output formats. */
export type CitationStyle = 'apa' | 'mla' | 'bibtex' | 'ris' | 'vancouver';

/** A Bookshelf record — a chapter or a whole book — with its book metadata. */
type BookRecord = ParsedArticle & { book: ParsedBookInfo };

/**
 * Whether a record cites a book rather than a journal article. Dispatch is on
 * `recordType`, never on `publicationTypes`: a Bookshelf record's publication
 * type is `Review` or `Study Guide`, so type strings cannot tell the two apart.
 */
function isBookRecord(article: ParsedArticle): article is BookRecord {
  return article.recordType !== 'journal-article' && article.book !== undefined;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extract the publication year from a ParsedArticle.
 * Prefers `journalInfo.publicationDate.year`, then the containing book's own
 * date, then the earliest `articleDates` entry (for a book, its contribution
 * date) before giving up. Returns 'n.d.' (no date) when no year is available.
 */
function getYear(article: ParsedArticle): string {
  const journalYear = article.journalInfo?.publicationDate?.year;
  if (journalYear) return journalYear;
  const bookYear = article.book?.pubDate ?? article.book?.beginningDate ?? article.book?.endingDate;
  if (bookYear) return bookYear;
  const articleYear = article.articleDates?.find((d) => d.year)?.year;
  return articleYear ?? 'n.d.';
}

/**
 * The date NLM prints for a book: a closed range for a book published over
 * several years (`1993-2026`), otherwise the single publication year.
 */
function bookDateSpan(book: ParsedBookInfo): string | undefined {
  if (book.beginningDate && book.endingDate && book.beginningDate !== book.endingDate) {
    return `${book.beginningDate}-${book.endingDate}`;
  }
  return book.pubDate ?? book.beginningDate ?? book.endingDate;
}

/** `Place: Publisher`, or whichever half the record carries. */
function bookImprint(book: ParsedBookInfo): string | undefined {
  if (book.publisherLocation && book.publisher) {
    return `${book.publisherLocation}: ${book.publisher}`;
  }
  return book.publisher ?? book.publisherLocation;
}

/** Where the book is readable — the NCBI Bookshelf permalink. */
function bookshelfUrl(book: ParsedBookInfo): string | undefined {
  return book.accession ? `https://www.ncbi.nlm.nih.gov/books/${book.accession}/` : undefined;
}

/**
 * The DOI a citation may carry — the record's own, and on a whole book the
 * book-level `Book/ELocationID` as a fallback. A chapter never inherits the
 * containing book's DOI: that identifier resolves to the book, so citing a
 * chapter with it points a reader at the wrong work. (#114)
 */
function citableDoi(article: ParsedArticle): string | undefined {
  if (article.doi) return article.doi;
  return article.recordType === 'book' ? article.book?.doi : undefined;
}

/**
 * The access URL for a book citation: the DOI when the record has one — APA and
 * most style guides prefer it — and the Bookshelf permalink otherwise.
 */
function bookAccessUrl(article: BookRecord): string | undefined {
  const doi = citableDoi(article);
  return doi ? `https://doi.org/${doi}` : bookshelfUrl(article.book);
}

/** Book title with its medium marker, e.g. `GeneReviews® [Internet]`. */
function bookTitleWithMedium(book: ParsedBookInfo): string | undefined {
  if (!book.title) return;
  return book.medium ? `${book.title} [${book.medium}]` : book.title;
}

/** Strip a single trailing period so the caller can add its own. */
function stripTrailingPeriod(text: string): string {
  return text.replace(/\.\s*$/, '');
}

/**
 * End a segment with exactly one period. An author list already closing on
 * "et al." or on an initial keeps the period it has rather than gaining a second.
 */
function terminate(text: string): string {
  return text.endsWith('.') ? text : `${text}.`;
}

/**
 * Split a pages string like "45-67" into start and end components.
 * Handles en-dashes, em-dashes, and hyphens. Expands PubMed's truncated-end
 * convention (e.g., "737-8" → { start: "737", end: "738" }, "1639-41" →
 * "1639"/"1641") so downstream RIS/BibTeX consumers see absolute page numbers.
 */
function splitPages(pages?: string): { start?: string; end?: string } {
  if (!pages) return {};
  const parts = pages.split(/[-\u2013\u2014]/).map((p) => p.trim());
  let [start, end] = parts;
  if (start && end && end.length < start.length) {
    end = start.slice(0, start.length - end.length) + end;
  }
  if (start && end) return { start, end };
  return start ? { start } : {};
}

/**
 * The electronic article locator that stands in for a page range, or undefined.
 *
 * Returns a value only when the record carries no pagination. Publishers that
 * report the article number as both `Pagination` and `ELocationID` (PLoS ONE,
 * Scientific Reports) are already covered by the `pages` rendering, and printing
 * both would duplicate the number in every style.
 */
function articleLocator(journal?: ParsedJournalInfo): string | undefined {
  if (journal?.pages) return;
  return journal?.elocationId || undefined;
}

/**
 * Collapse internal whitespace (including embedded newlines from structured
 * abstracts) to single spaces. Strict RIS parsers treat blank lines as record
 * terminators, so abstract text must be flattened before emission.
 */
function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * PubMed `PublicationType` → BibTeX entry type. Defaults to `article`.
 * Book records never reach this map — they dispatch on `recordType` instead,
 * because PubMed labels a Bookshelf record `Review` or `Study Guide`.
 */
const BIBTEX_ENTRY_TYPE: Record<string, string> = {
  Book: 'book',
  Preprint: 'misc',
};

/** PubMed `PublicationType` → RIS reference type. Defaults to `JOUR`. */
const RIS_REFERENCE_TYPE: Record<string, string> = {
  Book: 'BOOK',
  Preprint: 'GEN',
};

function firstMappedType(
  types: string[] | undefined,
  map: Record<string, string>,
  fallback: string,
): string {
  if (!types?.length) return fallback;
  for (const t of types) {
    const mapped = map[t];
    if (mapped) return mapped;
  }
  return fallback;
}

/**
 * Escape characters that are special in LaTeX/BibTeX values.
 * Handles: & % $ # _ { } ~ ^
 */
function escapeBibtex(text: string): string {
  return text.replace(/[\\&%$#_{}~^]/g, (ch) => {
    switch (ch) {
      case '\\':
        return '\\textbackslash{}';
      case '~':
        return '\\textasciitilde{}';
      case '^':
        return '\\textasciicircum{}';
      default:
        return `\\${ch}`;
    }
  });
}

// ---------------------------------------------------------------------------
// Author formatters
// ---------------------------------------------------------------------------

/**
 * Format a single author in APA style: `Last, F. M.`
 * Collective/group authors return the group name directly.
 */
function formatAuthorApa(author: ParsedArticleAuthor): string {
  if (author.collectiveName) return author.collectiveName;
  const last = author.lastName ?? '';
  // Prefer initials (already condensed), fall back to deriving from firstName
  const initials =
    author.initials ??
    author.firstName
      ?.split(/[\s-]+/)
      .filter(Boolean)
      .map((part) => `${part[0]}.`)
      .join(' ');
  if (!initials) return last;
  // Extract only letter characters (Unicode-aware: preserve Á, Ö, É, etc.),
  // format each as "X." separated by spaces.
  const formatted = Array.from(initials.replace(/[^\p{L}]/gu, ''))
    .map((c) => `${c}.`)
    .join(' ');
  if (!last) return formatted;
  return `${last}, ${formatted}`;
}

/**
 * Format the full author list for APA 7th edition.
 * - 1 author: `Last, F. M.`
 * - 2 authors: `Last, F. M., & Last, F. M.`
 * - 3-20 authors: comma-separated, `& ` before last
 * - 21+ authors: first 19, `...`, then last author
 */
function formatAuthorsApa(authors: ParsedArticleAuthor[]): string {
  const formatted = authors.map(formatAuthorApa);
  if (formatted.length === 0) return '';
  if (formatted.length === 1) return formatted[0] ?? '';
  if (formatted.length === 2) return `${formatted[0]}, & ${formatted[1]}`;
  if (formatted.length <= 20) {
    const allButLast = formatted.slice(0, -1).join(', ');
    return `${allButLast}, & ${formatted.at(-1)}`;
  }
  // >20 authors: first 19, ellipsis, last
  const first19 = formatted.slice(0, 19).join(', ');
  return `${first19}, ... ${formatted.at(-1)}`;
}

/**
 * Format a single author in MLA style.
 * First listed author: `Last, First Middle.`
 * Subsequent authors: `First Middle Last`
 */
function formatAuthorMla(author: ParsedArticleAuthor, isFirst: boolean): string {
  if (author.collectiveName) return author.collectiveName;
  const last = author.lastName ?? '';
  const first = author.firstName ?? '';
  if (!last && !first) return '';
  if (!first) return last;
  if (!last) return first;
  return isFirst ? `${last}, ${first}` : `${first} ${last}`;
}

/**
 * Format the full author list for MLA 9th edition.
 * - 1 author: `Last, First.`
 * - 2 authors: `Last, First, and First Last.`
 * - 3+ authors: `Last, First, et al.`
 */
function formatAuthorsMla(authors: ParsedArticleAuthor[]): string {
  const first = authors[0];
  if (!first) return '';
  if (authors.length === 1) return formatAuthorMla(first, true);
  if (authors.length === 2) {
    const second = authors[1];
    return second
      ? `${formatAuthorMla(first, true)}, and ${formatAuthorMla(second, false)}`
      : formatAuthorMla(first, true);
  }
  return `${formatAuthorMla(first, true)}, et al.`;
}

/**
 * Format a single author in BibTeX style: `{Last}, {First}`
 */
function formatAuthorBibtex(author: ParsedArticleAuthor): string {
  if (author.collectiveName) return `{${escapeBibtex(author.collectiveName)}}`;
  const last = author.lastName ? escapeBibtex(author.lastName) : '';
  const first = author.firstName ? escapeBibtex(author.firstName) : '';
  if (!last && !first) return '';
  if (!first) return `{${last}}`;
  if (!last) return first;
  return `{${last}}, ${first}`;
}

// ---------------------------------------------------------------------------
// APA 7th Edition
// ---------------------------------------------------------------------------

/**
 * Format an editor in APA's "In E. E. Editor (Ed.)," position: initials first,
 * surname last — the inverse of the author position.
 */
function formatEditorApa(editor: ParsedBookEditor): string {
  if (editor.collectiveName) return editor.collectiveName;
  const initialsSource =
    editor.initials ??
    editor.firstName
      ?.split(/[\s-]+/)
      .filter(Boolean)
      .map((part) => part[0])
      .join('');
  const initials = initialsSource
    ? Array.from(initialsSource.replace(/[^\p{L}]/gu, ''))
        .map((c) => `${c}.`)
        .join(' ')
    : '';
  return [initials, editor.lastName].filter(Boolean).join(' ');
}

/** APA editor list: comma-separated, `& ` before the last name. */
function formatEditorsApa(editors: ParsedBookEditor[]): string {
  const names = editors.map(formatEditorApa).filter(Boolean);
  if (names.length === 0) return '';
  if (names.length === 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')}, & ${names.at(-1)}`;
}

/**
 * Format a Bookshelf record as an APA 7th edition citation.
 *
 * Chapter in an edited book (APA 7 §10.3):
 * ```
 * Authors (Year). Chapter title. In E. Editor (Ed.), *Book title*. Publisher. URL
 * ```
 * A whole-book record drops the `In …` clause and italicizes its own title.
 *
 * A record crediting nobody at all — no authors, and for a whole book no
 * editors either — moves its title into the author position instead (APA 7
 * §9.12). Bookshelf makes that common: a whole-book record frequently credits
 * neither. The title is not italicized there, and the year follows it. (#139)
 */
function formatApaBook(article: BookRecord): string {
  const { book } = article;
  const parts: string[] = [];

  const authorStr = article.authors?.length ? formatAuthorsApa(article.authors) : '';
  /** The record's own title, which stands in the author position when set. */
  const leadTitle = article.recordType === 'book-chapter' ? article.title : book.title;
  let titleLedTheReference = false;

  if (authorStr) {
    parts.push(terminate(authorStr));
  } else if (article.recordType === 'book' && book.editors?.length) {
    // APA 7: an edited book with no authors of its own is cited from the editor
    // position — `Last, F. M. (Ed.).` — rather than opening on the year.
    parts.push(`${formatAuthorsApa(book.editors)} (${book.editors.length > 1 ? 'Eds.' : 'Ed.'}).`);
  } else if (leadTitle) {
    parts.push(`${stripTrailingPeriod(leadTitle)}.`);
    titleLedTheReference = true;
  }

  parts.push(`(${getYear(article)}).`);

  if (article.recordType === 'book-chapter') {
    if (article.title && !titleLedTheReference)
      parts.push(`${stripTrailingPeriod(article.title)}.`);
    const editorStr = book.editors?.length ? formatEditorsApa(book.editors) : '';
    const editorLabel = (book.editors?.length ?? 0) > 1 ? 'Eds.' : 'Ed.';
    const container = book.title ? `*${stripTrailingPeriod(book.title)}*` : '';
    if (container) {
      parts.push(
        editorStr ? `In ${editorStr} (${editorLabel}), ${container}.` : `In ${container}.`,
      );
    }
  } else if (book.title && !titleLedTheReference) {
    parts.push(`*${stripTrailingPeriod(book.title)}*.`);
  }

  if (book.publisher) parts.push(`${book.publisher}.`);

  const url = bookAccessUrl(article);
  if (url) parts.push(url);

  return parts.join(' ');
}

/**
 * Format a PubMed article as an APA 7th edition citation.
 *
 * Pattern:
 * ```
 * Authors (Year). Title. *Journal*, *Volume*(Issue), Pages. https://doi.org/DOI
 * ```
 * With no author the title takes the author position (APA 7 §9.12):
 * ```
 * Title. (Year). *Journal*, *Volume*(Issue), Pages. https://doi.org/DOI
 * ```
 * A Bookshelf record routes to {@link formatApaBook}.
 */
export function formatApa(article: ParsedArticle): string {
  if (isBookRecord(article)) return formatApaBook(article);
  const parts: string[] = [];

  // Authors — ensure trailing period (individual author initials end with '.',
  // but collective names do not, which would otherwise produce "Name (Year).")
  const authorStr = article.authors?.length ? formatAuthorsApa(article.authors) : '';
  // APA 7 §9.12: with no author the title takes the author position — the
  // reference reads `Title. (Year). *Journal*, …` rather than opening on the
  // date. It is not italicized there. (#139)
  const titleLedTheReference = !authorStr && Boolean(article.title);

  if (authorStr) {
    parts.push(terminate(authorStr));
  } else if (article.title) {
    parts.push(`${stripTrailingPeriod(article.title)}.`);
  }

  // Year
  const year = getYear(article);
  parts.push(`(${year}).`);

  // Title — use as-is from PubMed (sentence case already assumed)
  if (article.title && !titleLedTheReference) {
    // Strip trailing period from title if present; we add our own
    const title = stripTrailingPeriod(article.title);
    parts.push(`${title}.`);
  }

  // Journal, volume, issue, pages
  const journal = article.journalInfo;
  if (journal?.title) {
    let journalPart = `*${journal.title}*`;
    if (journal.volume) {
      journalPart += `, *${journal.volume}*`;
      if (journal.issue) {
        journalPart += `(${journal.issue})`;
      }
    }
    if (journal.pages) {
      journalPart += `, ${journal.pages}`;
    } else {
      // APA 7 p. 294-295: an article number takes the page range's place
      const locator = articleLocator(journal);
      if (locator) journalPart += `, Article ${locator}`;
    }
    journalPart += '.';
    parts.push(journalPart);
  }

  // DOI — no trailing period after DOI URL
  if (article.doi) {
    parts.push(`https://doi.org/${article.doi}`);
  }

  return parts.join(' ');
}

// ---------------------------------------------------------------------------
// MLA 9th Edition
// ---------------------------------------------------------------------------

/**
 * Format a PubMed article as an MLA 9th edition citation.
 *
 * Pattern:
 * ```
 * Last, First, et al. "Title." *Journal*, vol. 12, no. 3, 2024, pp. 45-67. DOI.
 * ```
 */
/** MLA renders editors first-name-first after `edited by`. */
function formatEditorsMla(editors: ParsedBookEditor[]): string {
  const names = editors
    .map((editor) =>
      editor.collectiveName
        ? editor.collectiveName
        : [editor.firstName, editor.lastName].filter(Boolean).join(' '),
    )
    .filter(Boolean);
  if (names.length === 0) return '';
  if (names.length === 1) return names[0] ?? '';
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names[0]}, et al.`;
}

/**
 * Format a Bookshelf record as an MLA 9th edition citation.
 *
 * ```
 * Author. "Chapter Title." *Book Title*, edited by E. Editor, Publisher, Year.
 * ```
 * A whole-book record italicizes its own title in place of the quoted chapter.
 */
function formatMlaBook(article: BookRecord): string {
  const { book } = article;
  const parts: string[] = [];

  const authorStr = article.authors?.length ? formatAuthorsMla(article.authors) : '';
  if (authorStr) parts.push(terminate(authorStr));

  if (article.recordType === 'book-chapter' && article.title) {
    parts.push(`"${stripTrailingPeriod(article.title)}."`);
  }

  const detailParts: string[] = [];
  if (book.title) detailParts.push(`*${stripTrailingPeriod(book.title)}*`);
  const editorStr = book.editors?.length ? formatEditorsMla(book.editors) : '';
  if (editorStr) detailParts.push(`edited by ${editorStr}`);
  if (book.edition) detailParts.push(book.edition);
  if (book.publisher) detailParts.push(book.publisher);
  const year = getYear(article);
  if (year !== 'n.d.') detailParts.push(year);
  if (detailParts.length) parts.push(`${detailParts.join(', ')}.`);

  return parts.join(' ');
}

export function formatMla(article: ParsedArticle): string {
  if (isBookRecord(article)) return formatMlaBook(article);
  const parts: string[] = [];

  // Authors
  const authorStr = article.authors?.length ? formatAuthorsMla(article.authors) : '';

  if (authorStr) {
    // Ensure author string ends with period
    parts.push(terminate(authorStr));
  }

  // Title in quotes
  if (article.title) {
    const title = stripTrailingPeriod(article.title);
    parts.push(`"${title}."`);
  }

  // Journal and publication details
  const journal = article.journalInfo;
  if (journal?.title) {
    const detailParts: string[] = [];
    detailParts.push(`*${journal.title}*`);

    if (journal.volume) {
      detailParts.push(`vol. ${journal.volume}`);
    }
    if (journal.issue) {
      detailParts.push(`no. ${journal.issue}`);
    }

    const year = getYear(article);
    if (year !== 'n.d.') {
      detailParts.push(year);
    }

    if (journal.pages) {
      // MLA 9 §6.56: "p." for a single page, "pp." for a range
      const isRange = /[-\u2013\u2014]/.test(journal.pages);
      detailParts.push(`${isRange ? 'pp.' : 'p.'} ${journal.pages}`);
    } else {
      // MLA 9 codifies no article-number form; citation guides converge on
      // "art. <value>" in the page position.
      const locator = articleLocator(journal);
      if (locator) detailParts.push(`art. ${locator}`);
    }

    parts.push(`${detailParts.join(', ')}.`);
  }

  // DOI
  if (article.doi) {
    parts.push(`https://doi.org/${article.doi}.`);
  }

  return parts.join(' ');
}

// ---------------------------------------------------------------------------
// BibTeX
// ---------------------------------------------------------------------------

/**
 * Format a PubMed article as a BibTeX entry.
 *
 * ```bibtex
 * @article{pmid12345678,
 *   author  = {Last, First and Last, First},
 *   title   = {Article Title},
 *   journal = {Journal Name},
 *   year    = {2024},
 *   ...
 * }
 * ```
 */
export function formatBibtex(article: ParsedArticle): string {
  const key = `pmid${article.pmid}`;
  const book = isBookRecord(article) ? article.book : undefined;
  // `@incollection` is a chapter in a book gathered from several contributors;
  // `@inbook` is a part attributed to the book's own author, which a Bookshelf
  // chapter is not. A whole-book record is plainly `@book`.
  const entryType = book
    ? article.recordType === 'book'
      ? 'book'
      : 'incollection'
    : firstMappedType(article.publicationTypes, BIBTEX_ENTRY_TYPE, 'article');
  const fields: [string, string][] = [];

  // Authors
  if (article.authors?.length) {
    const authorStr = article.authors.map(formatAuthorBibtex).filter(Boolean).join(' and ');
    if (authorStr) fields.push(['author', authorStr]);
  }

  // Title — strip trailing period; biblatex styles append their own.
  // A whole-book record's own title is the book title, so it is not repeated
  // as a `booktitle` below.
  const title = book && article.recordType === 'book' ? book.title : article.title;
  if (title) {
    fields.push(['title', `{${escapeBibtex(stripTrailingPeriod(title))}}`]);
  }

  // Container — the journal, or the book a chapter sits in
  const journal = article.journalInfo;
  if (journal?.title) {
    fields.push(['journal', escapeBibtex(journal.title)]);
  }
  if (book && article.recordType === 'book-chapter' && book.title) {
    fields.push(['booktitle', escapeBibtex(book.title)]);
  }
  if (book?.editors?.length) {
    const editorStr = book.editors.map(formatAuthorBibtex).filter(Boolean).join(' and ');
    if (editorStr) fields.push(['editor', editorStr]);
  }
  if (book?.publisher) fields.push(['publisher', escapeBibtex(book.publisher)]);
  if (book?.publisherLocation) fields.push(['address', escapeBibtex(book.publisherLocation)]);
  if (book?.edition) fields.push(['edition', escapeBibtex(book.edition)]);
  if (book?.collectionTitle) fields.push(['series', escapeBibtex(book.collectionTitle)]);

  // Year
  const year = getYear(article);
  if (year !== 'n.d.') {
    fields.push(['year', year]);
  }

  // Volume
  if (journal?.volume) {
    fields.push(['volume', escapeBibtex(journal.volume)]);
  }

  // Number (issue)
  if (journal?.issue) {
    fields.push(['number', escapeBibtex(journal.issue)]);
  }

  // Pages — or, with no pagination, biblatex's `eid` for the article number.
  // Classic BibTeX has no article-number field and overloading `pages` is
  // imprecise; `eid` is broadly supported (acmart included).
  if (journal?.pages) {
    fields.push(['pages', escapeBibtex(journal.pages)]);
  } else if (!book) {
    const locator = articleLocator(journal);
    if (locator) fields.push(['eid', escapeBibtex(locator)]);
  }

  // ISSN, or a book's ISBNs — a book commonly carries a print and an
  // electronic one, and dropping either loses a real identifier
  const issn = journal?.issn ?? journal?.eIssn;
  if (issn) {
    fields.push(['issn', escapeBibtex(issn)]);
  }
  if (book?.isbns?.length) {
    fields.push(['isbn', book.isbns.map(escapeBibtex).join(', ')]);
  }

  // DOI
  const doi = citableDoi(article);
  if (doi) {
    fields.push(['doi', doi]);
  }

  // PMID
  fields.push(['pmid', article.pmid]);

  // PMCID
  if (article.pmcId) {
    fields.push(['pmcid', article.pmcId]);
  }

  // Bookshelf permalink — where the book is actually readable
  if (book) {
    const url = bookshelfUrl(book);
    if (url) fields.push(['url', url]);
  }

  // Keywords — merge article keywords with MeSH descriptor names
  const keywordSet = new Set<string>();
  for (const k of article.keywords ?? []) keywordSet.add(k);
  for (const m of article.meshTerms ?? []) {
    if (m.descriptorName) keywordSet.add(m.descriptorName);
  }
  // Brace-wrap each term so MeSH descriptors that carry internal commas in
  // their inverted form (e.g. "Databases, Protein") stay a single keyword —
  // biblatex's comma-separated list parser reads a braced item as one element.
  if (keywordSet.size > 0) {
    const keywords = [...keywordSet].map((k) => `{${escapeBibtex(k)}}`).join(', ');
    fields.push(['keywords', keywords]);
  }

  // Build entry
  const maxKeyLen = Math.max(...fields.map(([k]) => k.length));
  const fieldLines = fields.map(([k, v]) => `  ${k.padEnd(maxKeyLen)} = {${v}}`).join(',\n');

  return `@${entryType}{${key},\n${fieldLines}\n}`;
}

// ---------------------------------------------------------------------------
// RIS
// ---------------------------------------------------------------------------

/**
 * Format a PubMed article as a RIS record.
 *
 * Each tag is 2 characters, followed by two spaces, a dash, two spaces, then the value.
 * Record ends with `ER  - ` (trailing spaces per spec).
 */
export function formatRis(article: ParsedArticle): string {
  const lines: string[] = [];

  const tag = (code: string, value: string | undefined): void => {
    if (value) lines.push(`${code}  - ${value}`);
  };

  const book = isBookRecord(article) ? article.book : undefined;
  // Type of reference — the record type for a book, else the publication types
  const refType = book
    ? article.recordType === 'book'
      ? 'BOOK'
      : 'CHAP'
    : firstMappedType(article.publicationTypes, RIS_REFERENCE_TYPE, 'JOUR');
  lines.push(`TY  - ${refType}`);

  // Authors — one AU tag per author
  if (article.authors?.length) {
    for (const author of article.authors) {
      if (author.collectiveName) {
        tag('AU', author.collectiveName);
      } else {
        const last = author.lastName ?? '';
        const first = author.firstName ?? '';
        if (last || first) {
          tag('AU', first ? `${last}, ${first}` : last);
        }
      }
    }
  }

  // Title
  tag('TI', article.title);

  // Container — the journal, or the book a chapter sits in. `BT` is the book
  // title; on a whole-book record it would only repeat `TI`, so it is omitted.
  const journal = article.journalInfo;
  if (journal?.title) {
    tag('JF', journal.title);
  }
  if (journal?.isoAbbreviation) {
    tag('JO', journal.isoAbbreviation);
  }
  if (book) {
    if (article.recordType === 'book-chapter') tag('BT', book.title);
    for (const editor of book.editors ?? []) {
      const last = editor.lastName ?? '';
      const first = editor.firstName ?? '';
      if (editor.collectiveName) tag('A2', editor.collectiveName);
      else if (last || first) tag('A2', first ? `${last}, ${first}` : last);
    }
    tag('PB', book.publisher);
    tag('CY', book.publisherLocation);
    tag('ET', book.edition);
    tag('T3', book.collectionTitle);
  }

  // Year
  const year = getYear(article);
  if (year !== 'n.d.') {
    tag('PY', year);
  }

  // Volume & Issue
  tag('VL', journal?.volume);
  tag('IS', journal?.issue);

  // Pages — split into start/end, expanding PubMed's truncated-end convention.
  // With no pagination, the article number goes on `C7` (the attested RIS
  // convention for Article Number), never on SP/EP, which hold absolute pages.
  if (journal?.pages) {
    const { start, end } = splitPages(journal.pages);
    tag('SP', start);
    tag('EP', end);
  } else if (!book) {
    tag('C7', articleLocator(journal));
  }

  // SN carries the ISSN for a serial and the ISBN for a book; a book with both
  // a print and an electronic ISBN gets one line each.
  tag('SN', journal?.issn ?? journal?.eIssn);
  for (const isbn of book?.isbns ?? []) tag('SN', isbn);

  // DOI (without URL prefix — RIS DO tag holds the bare DOI)
  tag('DO', citableDoi(article));

  // Accession number (PMID)
  tag('AN', article.pmid);

  // PubMed URL
  lines.push(`UR  - https://pubmed.ncbi.nlm.nih.gov/${article.pmid}/`);

  // PMC URL (when available)
  if (article.pmcId) {
    lines.push(`UR  - https://pmc.ncbi.nlm.nih.gov/articles/${article.pmcId}/`);
  }

  // Bookshelf URL — where a book record is actually readable
  if (book) {
    const url = bookshelfUrl(book);
    if (url) lines.push(`UR  - ${url}`);
  }

  // Keywords — merge article keywords with MeSH descriptor names
  const keywordSet = new Set<string>();
  for (const k of article.keywords ?? []) keywordSet.add(k);
  for (const m of article.meshTerms ?? []) {
    if (m.descriptorName) keywordSet.add(m.descriptorName);
  }
  for (const kw of keywordSet) {
    tag('KW', kw);
  }

  // Abstract — collapse internal whitespace so blank lines don't break strict
  // RIS parsers that terminate records at blank lines
  if (article.abstractText) {
    tag('AB', collapseWhitespace(article.abstractText));
  }

  // End of record (trailing space per RIS spec)
  lines.push('ER  - ');

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Vancouver (ICMJE / NLM)
// ---------------------------------------------------------------------------

/**
 * Format a single author in Vancouver style: `Surname AB` — surname, a space,
 * then initials with no periods or internal spaces. Collective/group authors
 * return their name directly.
 */
function formatAuthorVancouver(author: ParsedArticleAuthor): string {
  if (author.collectiveName) return author.collectiveName;
  const last = author.lastName ?? '';
  const initialsSource =
    author.initials ??
    author.firstName
      ?.split(/[\s-]+/)
      .filter(Boolean)
      .map((part) => part[0])
      .join('');
  // Letters only (Unicode-aware), uppercased, no separators: "AB", not "A. B."
  const initials = initialsSource
    ? Array.from(initialsSource)
        .filter((c) => /\p{L}/u.test(c))
        .join('')
        .toUpperCase()
    : '';
  if (!last) return initials;
  if (!initials) return last;
  return `${last} ${initials}`;
}

/**
 * Format the full author list for Vancouver: list every author for six or
 * fewer; for seven or more, list the first six followed by `et al.` (ICMJE).
 */
function formatAuthorsVancouver(authors: ParsedArticleAuthor[]): string {
  const names = authors.map(formatAuthorVancouver).filter(Boolean);
  if (names.length === 0) return '';
  if (names.length <= 6) return names.join(', ');
  return `${names.slice(0, 6).join(', ')}, et al.`;
}

/**
 * Format a PubMed article as a Vancouver (ICMJE/NLM) reference — the numbered
 * style used by NEJM, Lancet, JAMA, BMJ, and most biomedical journals.
 *
 * Pattern (the leading list number is the consumer's responsibility — entries
 * are formatted independently, so this returns the unnumbered reference body):
 * ```
 * Surname AB, Surname CD, et al. Article title. Abbrev J Name. Year;Vol(Issue):Pages. doi: 10.x/y
 * ```
 * Journal name uses the NLM/ISO abbreviation when available; pages are used as
 * PubMed supplies them (often elided, e.g. "583-9"); the DOI carries no trailing
 * period so it stays copy-pasteable. An article number replaces nothing — with
 * no pagination it trails the source as an NLM note (`. pii: 2400512.`).
 */
/**
 * Format a Bookshelf record as a Vancouver (NLM) reference, following *Citing
 * Medicine* 2e Ch. 22 §C, Contributions to Books on the Internet:
 * ```
 * Authors. Chapter title. In: Editors, editors. Book title [Internet].
 * Place: Publisher; date. Available from: URL
 * ```
 * A whole-book record drops the contribution and the `In:`, taking the book
 * title as its own. `[cited …]` and the extent (`[about 41 p.]`) are part of the
 * NLM pattern but neither is derivable from an EFetch record, so both are
 * omitted rather than invented. Editors stand in for absent authors on a whole
 * book, which is the NLM form for an edited work.
 */
function formatVancouverBook(article: BookRecord): string {
  const { book } = article;
  const segments: string[] = [];
  const authorStr = article.authors?.length ? formatAuthorsVancouver(article.authors) : '';
  const editorStr = book.editors?.length ? formatAuthorsVancouver(book.editors) : '';

  if (authorStr) segments.push(terminate(authorStr));

  if (article.recordType === 'book-chapter') {
    if (article.title) segments.push(`${stripTrailingPeriod(article.title)}.`);
    segments.push(editorStr ? `In: ${editorStr}, editors.` : 'In:');
  } else if (!authorStr && editorStr) {
    segments.push(`${editorStr}, editors.`);
  }

  const container = bookTitleWithMedium(book);
  if (container) segments.push(`${stripTrailingPeriod(container)}.`);

  const source = [bookImprint(book), bookDateSpan(book)].filter(Boolean).join('; ');
  if (source) segments.push(`${source}.`);

  // No trailing period — it would be read as part of the URL
  const url = bookshelfUrl(book);
  if (url) segments.push(`Available from: ${url}`);

  return segments.join(' ');
}

export function formatVancouver(article: ParsedArticle): string {
  if (isBookRecord(article)) return formatVancouverBook(article);
  const segments: string[] = [];

  // Authors — terminate with a period unless the list already ends in "et al."
  const authorStr = article.authors?.length ? formatAuthorsVancouver(article.authors) : '';
  if (authorStr) {
    segments.push(terminate(authorStr));
  }

  // Title — sentence case as supplied, single terminating period
  if (article.title) {
    segments.push(`${stripTrailingPeriod(article.title)}.`);
  }

  // Journal — NLM/ISO abbreviation preferred, full title as fallback
  const journal = article.journalInfo;
  const journalName = journal?.isoAbbreviation ?? journal?.title;
  if (journalName) {
    segments.push(`${stripTrailingPeriod(journalName)}.`);
  }

  // Source — "Year;Volume(Issue):Pages."
  const year = getYear(article);
  let source = year !== 'n.d.' ? year : '';
  if (journal?.volume) {
    source += source ? `;${journal.volume}` : journal.volume;
    if (journal.issue) source += `(${journal.issue})`;
    if (journal.pages) source += `:${journal.pages}`;
  } else if (journal?.pages) {
    source += source ? `:${journal.pages}` : journal.pages;
  }
  if (source) segments.push(`${source}.`);

  // Article number — NLM's note form for a publisher locator that is not
  // pagination ("Euro Surveill. 2008 May 8;13(19). pii: 18863."): a trailing
  // note after Year;Volume(Issue), never inside the colon slot.
  const locator = articleLocator(journal);
  if (locator) {
    const label = journal?.elocationIdType;
    segments.push(label ? `${label}: ${locator}.` : `${locator}.`);
  }

  // DOI — NLM "doi: <doi>" form; no trailing period (would corrupt the DOI)
  if (article.doi) {
    segments.push(`doi: ${article.doi}`);
  }

  return segments.join(' ');
}

// ---------------------------------------------------------------------------
// Dispatchers
// ---------------------------------------------------------------------------

/**
 * Format a single article in the requested citation style.
 * Throws on unsupported style.
 */
export function formatCitation(article: ParsedArticle, style: CitationStyle): string {
  switch (style) {
    case 'apa':
      return formatApa(article);
    case 'mla':
      return formatMla(article);
    case 'bibtex':
      return formatBibtex(article);
    case 'ris':
      return formatRis(article);
    case 'vancouver':
      return formatVancouver(article);
  }
}

/**
 * Format a single article in multiple citation styles.
 * Returns a record keyed by style name.
 */
export function formatCitations(
  article: ParsedArticle,
  styles: CitationStyle[],
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const style of styles) {
    result[style] = formatCitation(article, style);
  }
  return result;
}
