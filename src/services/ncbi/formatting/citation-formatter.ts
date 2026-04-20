/**
 * @fileoverview Hand-rolled citation formatters for PubMed articles.
 * Supports APA 7th, MLA 9th, BibTeX, and RIS formats.
 * Pure TypeScript, zero dependencies, Workers-compatible.
 * @module src/services/ncbi/formatting/citation-formatter
 */

import type { ParsedArticle, ParsedArticleAuthor } from '../types.js';

/** Supported citation output formats. */
export type CitationStyle = 'apa' | 'mla' | 'bibtex' | 'ris';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extract the publication year from a ParsedArticle.
 * Prefers `journalInfo.publicationDate.year`; falls back to the earliest
 * `articleDates` entry (typically the electronic pub date) before giving up.
 * Returns 'n.d.' (no date) when no year is available.
 */
function getYear(article: ParsedArticle): string {
  const journalYear = article.journalInfo?.publicationDate?.year;
  if (journalYear) return journalYear;
  const articleYear = article.articleDates?.find((d) => d.year)?.year;
  return articleYear ?? 'n.d.';
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
 * Collapse internal whitespace (including embedded newlines from structured
 * abstracts) to single spaces. Strict RIS parsers treat blank lines as record
 * terminators, so abstract text must be flattened before emission.
 */
function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** PubMed `PublicationType` → BibTeX entry type. Defaults to `article`. */
const BIBTEX_ENTRY_TYPE: Record<string, string> = {
  Book: 'book',
  'Book Chapter': 'inbook',
  Preprint: 'misc',
};

/** PubMed `PublicationType` → RIS reference type. Defaults to `JOUR`. */
const RIS_REFERENCE_TYPE: Record<string, string> = {
  Book: 'BOOK',
  'Book Chapter': 'CHAP',
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
  // Extract only letter characters, format each as "X." separated by spaces
  const formatted = initials
    .replace(/[^A-Za-z]/g, '')
    .split('')
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
 * Format a PubMed article as an APA 7th edition citation.
 *
 * Pattern:
 * ```
 * Authors (Year). Title. *Journal*, *Volume*(Issue), Pages. https://doi.org/DOI
 * ```
 */
export function formatApa(article: ParsedArticle): string {
  const parts: string[] = [];

  // Authors — ensure trailing period (individual author initials end with '.',
  // but collective names do not, which would otherwise produce "Name (Year).")
  const authorStr = article.authors?.length ? formatAuthorsApa(article.authors) : '';

  if (authorStr) {
    parts.push(authorStr.endsWith('.') ? authorStr : `${authorStr}.`);
  }

  // Year
  const year = getYear(article);
  parts.push(`(${year}).`);

  // Title — use as-is from PubMed (sentence case already assumed)
  if (article.title) {
    // Strip trailing period from title if present; we add our own
    const title = article.title.replace(/\.\s*$/, '');
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
export function formatMla(article: ParsedArticle): string {
  const parts: string[] = [];

  // Authors
  const authorStr = article.authors?.length ? formatAuthorsMla(article.authors) : '';

  if (authorStr) {
    // Ensure author string ends with period
    parts.push(authorStr.endsWith('.') ? authorStr : `${authorStr}.`);
  }

  // Title in quotes
  if (article.title) {
    const title = article.title.replace(/\.\s*$/, '');
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
  const entryType = firstMappedType(article.publicationTypes, BIBTEX_ENTRY_TYPE, 'article');
  const fields: [string, string][] = [];

  // Authors
  if (article.authors?.length) {
    const authorStr = article.authors.map(formatAuthorBibtex).filter(Boolean).join(' and ');
    if (authorStr) fields.push(['author', authorStr]);
  }

  // Title — strip trailing period; biblatex styles append their own
  if (article.title) {
    const title = article.title.replace(/\.\s*$/, '');
    fields.push(['title', `{${escapeBibtex(title)}}`]);
  }

  // Journal
  const journal = article.journalInfo;
  if (journal?.title) {
    fields.push(['journal', escapeBibtex(journal.title)]);
  }

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

  // Pages
  if (journal?.pages) {
    fields.push(['pages', escapeBibtex(journal.pages)]);
  }

  // ISSN
  const issn = journal?.issn ?? journal?.eIssn;
  if (issn) {
    fields.push(['issn', escapeBibtex(issn)]);
  }

  // DOI
  if (article.doi) {
    fields.push(['doi', article.doi]);
  }

  // PMID
  fields.push(['pmid', article.pmid]);

  // PMCID
  if (article.pmcId) {
    fields.push(['pmcid', article.pmcId]);
  }

  // Keywords — merge article keywords with MeSH descriptor names
  const keywordSet = new Set<string>();
  for (const k of article.keywords ?? []) keywordSet.add(k);
  for (const m of article.meshTerms ?? []) {
    if (m.descriptorName) keywordSet.add(m.descriptorName);
  }
  if (keywordSet.size > 0) {
    fields.push(['keywords', escapeBibtex([...keywordSet].join(', '))]);
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

  // Type of reference — map from PubMed publication types
  const refType = firstMappedType(article.publicationTypes, RIS_REFERENCE_TYPE, 'JOUR');
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

  // Journal
  const journal = article.journalInfo;
  if (journal?.title) {
    tag('JF', journal.title);
  }
  if (journal?.isoAbbreviation) {
    tag('JO', journal.isoAbbreviation);
  }

  // Year
  const year = getYear(article);
  if (year !== 'n.d.') {
    tag('PY', year);
  }

  // Volume & Issue
  tag('VL', journal?.volume);
  tag('IS', journal?.issue);

  // Pages — split into start/end, expanding PubMed's truncated-end convention
  if (journal?.pages) {
    const { start, end } = splitPages(journal.pages);
    tag('SP', start);
    tag('EP', end);
  }

  // ISSN — prefer print ISSN, fall back to electronic
  tag('SN', journal?.issn ?? journal?.eIssn);

  // DOI (without URL prefix — RIS DO tag holds the bare DOI)
  tag('DO', article.doi);

  // Accession number (PMID)
  tag('AN', article.pmid);

  // PubMed URL
  lines.push(`UR  - https://pubmed.ncbi.nlm.nih.gov/${article.pmid}/`);

  // PMC URL (when available)
  if (article.pmcId) {
    lines.push(`UR  - https://pmc.ncbi.nlm.nih.gov/articles/${article.pmcId}/`);
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
