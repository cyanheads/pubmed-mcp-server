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
  ParsedCommentsCorrection,
  ParsedJournalInfo,
} from '../types.js';

/** Supported citation output formats. */
export type CitationStyle = 'apa' | 'mla' | 'bibtex' | 'ris' | 'vancouver';

/**
 * NCBI `RefType`s that qualify the cited article itself — it was retracted,
 * corrected, or questioned. A link from a record that is itself a notice
 * (`RetractionOf`, `ErratumFor`) and comment or update links are not among them:
 * citing a retraction notice is not citing a retracted work. (#215)
 */
export const CITATION_NOTICE_TYPES = [
  'RetractionIn',
  'RetractedandRepublishedIn',
  'ExpressionOfConcernIn',
  'ErratumIn',
  'CorrectedandRepublishedIn',
] as const;

export type CitationNoticeType = (typeof CITATION_NOTICE_TYPES)[number];

/** A linked notice that qualifies the cited article. */
export type CitationNotice = ParsedCommentsCorrection & { refType: CitationNoticeType };

const NOTICE_TYPES: ReadonlySet<string> = new Set(CITATION_NOTICE_TYPES);

function isCitationNotice(link: ParsedCommentsCorrection): link is CitationNotice {
  return NOTICE_TYPES.has(link.refType);
}

/** The record's linked notices that qualify the cited article, in NCBI's order. */
export function citationNotices(article: ParsedArticle): CitationNotice[] {
  return (article.commentsCorrections ?? []).filter(isCitationNotice);
}

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

/** A cited date with whatever precision the record carries: month 1–12, day 1–31. */
interface CitedDate {
  day?: number;
  month?: number;
  year: string;
}

/** Vancouver (NLM) month abbreviations: three letters, no period. */
const NLM_MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const;

/** MLA 9 month forms: names longer than four letters are abbreviated. */
const MLA_MONTHS = [
  'Jan.',
  'Feb.',
  'Mar.',
  'Apr.',
  'May',
  'June',
  'July',
  'Aug.',
  'Sept.',
  'Oct.',
  'Nov.',
  'Dec.',
] as const;

/**
 * Read one of a Bookshelf chapter's own dates. Bookshelf writes months and days
 * as numbers; a month that is not one is dropped together with its day rather
 * than guessed, so the date keeps only the parts that can be stated.
 */
function chapterDateOfType(
  article: ParsedArticle,
  dateType: 'ContributionDate' | 'DateRevised',
): CitedDate | undefined {
  const date = article.articleDates?.find((d) => d.dateType === dateType);
  if (!date?.year) return;
  const month = Number(date.month);
  if (!Number.isInteger(month) || month < 1 || month > 12) return { year: date.year };
  const day = Number(date.day);
  return Number.isInteger(day) && day >= 1 && day <= 31
    ? { year: date.year, month, day }
    : { year: date.year, month };
}

/** A chapter's `ContributionDate` and `DateRevised`; both absent on any other record type. */
function chapterDates(article: ParsedArticle): {
  contributed?: CitedDate | undefined;
  revised?: CitedDate | undefined;
} {
  if (article.recordType !== 'book-chapter') return {};
  return {
    contributed: chapterDateOfType(article, 'ContributionDate'),
    revised: chapterDateOfType(article, 'DateRevised'),
  };
}

/**
 * The date a Bookshelf chapter is cited by: its last revision when it has one
 * (APA and MLA both cite a last-updated date), otherwise its contribution date.
 * Never the containing book's date, which records when the book began. (#189)
 */
function chapterDate(article: ParsedArticle): CitedDate | undefined {
  const { contributed, revised } = chapterDates(article);
  return revised ?? contributed;
}

/** `20 Dec. 2018`, `July 2025`, or `2025` — MLA 9's day-month-year order. */
function formatDateMla(date: CitedDate): string {
  const month = date.month ? MLA_MONTHS[date.month - 1] : undefined;
  return [date.day, month, date.year].filter(Boolean).join(' ');
}

/** `2018 Dec 20`, `2025 Jul`, or `2025` — NLM's year-month-day order. */
function formatDateNlm(date: CitedDate): string {
  const month = date.month ? NLM_MONTHS[date.month - 1] : undefined;
  return [date.year, month, date.day].filter(Boolean).join(' ');
}

/** RIS `DA` form, zero-padded: `2018/12/20`, `2025/07`, or `2025`. */
function formatDateRis(date: CitedDate): string {
  const pad = (n?: number) => (n ? String(n).padStart(2, '0') : undefined);
  return [date.year, pad(date.month), pad(date.day)].filter(Boolean).join('/');
}

/**
 * Extract the publication year from a ParsedArticle.
 * Prefers `journalInfo.publicationDate.year`, then a Bookshelf chapter's own
 * date ({@link chapterDate}), then the containing book's date, then the first
 * dated `articleDates` entry before giving up. Returns 'n.d.' (no date) when no
 * year is available.
 */
function getYear(article: ParsedArticle): string {
  const journalYear = article.journalInfo?.publicationDate?.year;
  if (journalYear) return journalYear;
  const chapterYear = chapterDate(article)?.year;
  if (chapterYear) return chapterYear;
  const bookYear = article.book?.pubDate ?? article.book?.beginningDate ?? article.book?.endingDate;
  if (bookYear) return bookYear;
  const articleYear = article.articleDates?.find((d) => d.year)?.year;
  return articleYear ?? 'n.d.';
}

/**
 * The date NLM prints for a book: a closed range for a book published over
 * several years (`1993-2026`), an open one for a book still being updated
 * (`2000-`), otherwise the single publication year.
 */
function bookDateSpan(book: ParsedBookInfo): string | undefined {
  if (book.beginningDate && book.beginningDate !== book.endingDate) {
    return `${book.beginningDate}-${book.endingDate ?? ''}`;
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
 * The electronic article locator that Vancouver, BibTeX, and RIS print in place
 * of a page range, or undefined.
 *
 * Returns a value only when the record carries no pagination. Publishers that
 * report the article number as both `Pagination` and `ELocationID` (PLoS ONE,
 * Scientific Reports) are already covered by the `pages` rendering, and printing
 * both would duplicate the number. APA and MLA use {@link articleNumber}.
 */
function articleLocator(journal?: ParsedJournalInfo): string | undefined {
  if (journal?.pages) return;
  return journal?.elocationId || undefined;
}

/**
 * The article number APA and MLA cite in place of a page range: the record's
 * non-DOI locator when it has no pagination, or when its pagination is that
 * same value — NCBI copies an article number into `MedlinePgn` (Frontiers
 * `662953`, Springer `42`). A page that matches no locator stays a page, though
 * some are article numbers the record cannot identify (an Elsevier `105471`
 * beside an `S…` pii looks exactly like a Lancet page `2413`). (#217)
 *
 * A dashless `MedlinePgn` also matches the locator with its hyphens removed:
 * American Society for Microbiology journals deposit `e0364621` beside pii
 * `e03646-21`. The locator's form is the one cited, as the publisher numbers
 * the article. Pagination holding a dash is a range and never matches. (#231)
 */
function articleNumber(journal?: ParsedJournalInfo): string | undefined {
  const locator = journal?.elocationId;
  if (!locator) return;
  const { pages } = journal;
  if (!pages || pages === locator) return locator;
  return !PAGE_DASH.test(pages) && pages === locator.replaceAll('-', '') ? locator : undefined;
}

/** A dash NLM's pagination puts between the ends of a range. */
const PAGE_DASH = /[-\u{2013}\u{2014}]/u;

/**
 * One page or range inside NLM's pagination: a start, then optionally a dash
 * and an end. An item starts only after a separator, so a long run without a
 * dash is read once rather than retried from each of its characters.
 */
const PAGE_ITEM =
  /(?<![^\s,;\u{2013}\u{2014}-])([^\s,;\u{2013}\u{2014}-]+)(?:\s*[-\u{2013}\u{2014}]\s*([^\s,;\u{2013}\u{2014}-]+))?/gu;

/** The digits a page ends on, matched from the start of their run only. */
const TRAILING_DIGITS = /(?<!\d)\d+$/;

/**
 * The end of a range as NLM's elision means it. An end made of digits is
 * written against the start's digits and takes the start's prefix (`637-41` →
 * `641`, `S5-15` → `S15`, `1255.e1-5` → `1255.e5`); any other end is already
 * whole (`878.e8`, `e65`, `xv`).
 */
function fullPageEnd(start: string, end: string): string {
  const digits = /^\d+$/.test(end) ? TRAILING_DIGITS.exec(start) : null;
  if (!digits) return end;
  const [run] = digits;
  const elided = end.length < run.length;
  return `${start.slice(0, digits.index)}${elided ? run.slice(0, run.length - end.length) : ''}${end}`;
}

/**
 * NLM's pagination with each range written in full (`637-41` → `637-641`,
 * `S5-15` → `S5-S15`), joined by `dash` or by NLM's own when none is given; the
 * rest of NLM's text stays as given — a list's separators and labels too
 * (`1407-8; author reply 1409-10` → `1407-1408; author reply 1409-1410`). APA
 * joins with an en dash (`637–641`); BibTeX keeps NLM's. (#217, #228)
 */
function expandPageRanges(pages: string, dash?: string): string {
  return pages.replace(PAGE_ITEM, (item, start: string, end: string | undefined) => {
    if (end === undefined) return item;
    const join = dash ?? item.slice(start.length, item.length - end.length);
    return `${start}${join}${fullPageEnd(start, end)}`;
  });
}

/** A token that can be a page: it carries a digit or is a Roman numeral, unlike a label (`author reply`). */
const PAGE_TOKEN = /\d|^[ivxlcdm]+$/i;

/**
 * The first and last page of NLM's pagination, for RIS `SP` and `EP`: the start
 * of the first page or range, and the end of the last range written in full or
 * the last listed page (`1308, 1310-4` → `1308`/`1314`, `xii-xv` → `xii`/`xv`,
 * `S5-15` → `S5`/`S15`). A single page or article number has no end, and a
 * label in a list (`author reply`) is not a page. NCBI's own `StartPage` and
 * `EndPage` agree on every shape. (#228)
 */
function splitPages(pages: string): { start: string | undefined; end: string | undefined } {
  const items = [...pages.matchAll(PAGE_ITEM)];
  const [, start] = items[0] ?? [];
  const pageItems = items.filter(
    ([, first = '', last]) => last !== undefined || PAGE_TOKEN.test(first),
  );
  const final = pageItems.at(-1);
  if (!final || (pageItems.length === 1 && final[2] === undefined)) {
    return { start, end: undefined };
  }
  const [, first = '', last] = final;
  return { start, end: last === undefined ? first : fullPageEnd(first, last) };
}

/**
 * Words APA 7 keeps lowercase in a title unless one opens it or its subtitle:
 * articles, coordinating conjunctions, and prepositions of three letters or
 * fewer — plus the articles, conjunctions, and prepositions of the non-English
 * journal names NLM catalogs, in NLM's unaccented spelling: Romance (`Annales
 * de dermatologie et de venereologie`), Germanic and Scandinavian (`Beitrage
 * zur gerichtlichen Medizin`), Slavic (`Akusherstvo i ginekologiia`), and the
 * Hungarian, Turkish, Finnish, Japanese, and Latin ones NLM's titles use. A
 * word that is also a romanized Chinese syllable stays out (`za` of `za zhi`,
 * `ai`, `nei`), as does one NLM uses for an abbreviation (`ed.`, `med.`).
 */
const APA_MINOR_WORDS: ReadonlySet<string> = new Set([
  ...['a', 'an', 'the', 'and', 'but', 'for', 'nor', 'or', 'so', 'yet'],
  ...['as', 'at', 'by', 'in', 'of', 'off', 'on', 'per', 'to', 'up', 'via'],
  ...['de', 'des', 'du', 'la', 'le', 'les', 'et', 'sur', 'au', 'aux', 'pour', 'par', 'dans'],
  ...['avec', 'un', 'une', 'el', 'los', 'las', 'y', 'e', 'al', 'para', 'por', 'o', 'os', 'em'],
  ...['no', 'na', 'ao', 'da', 'das', 'do', 'dos', 'di', 'del', 'della', 'dello', 'delle', 'dei'],
  ...['degli', 'alla', 'alle', 'fra', 'si', 'din', 'pentru', 'der', 'die', 'dem', 'den', 'und'],
  ...['für', 'fur', 'zu', 'zur', 'im', 'am', 'auf', 'aus', 'mit', 'uber', 'van', 'von', 'voor'],
  ...['en', 'het', 'tot', 'op', 'uit', 'te', 'og', 'och', 'af', 'til', 'fran', 'mot', 'vir'],
  ...['i', 'v', 'w', 'z', 'u', 'po', 'pro', 'nad', 've', 'es', 'az', 'ja', 'ad'],
]);

/** MLA 9 also keeps a preposition of any length lowercase. */
const MLA_MINOR_WORDS: ReadonlySet<string> = new Set([
  ...APA_MINOR_WORDS,
  ...['about', 'above', 'across', 'against', 'along', 'among', 'around', 'behind', 'below'],
  ...['beneath', 'beside', 'between', 'beyond', 'during', 'from', 'into', 'onto', 'over'],
  ...['through', 'throughout', 'toward', 'towards', 'under', 'upon', 'with', 'within'],
  ...['without'],
]);

/** One hyphen-delimited part of a word: surrounding punctuation, then lowercase letters. */
const LOWERCASE_WORD = /^([^\p{L}\p{N}]*)(\p{Ll}+(?:['\u{2019}]\p{Ll}+)*)([^\p{L}\p{N}]*)$/u;

/** A French or Italian elided particle and the word it joins (`d'ophtalmologie`, `dell'apparato`). */
const ELISION = /^(d|l|qu|dell|dall|nell|all|sull)(['\u{2019}])(.+)$/u;

/** Brands NLM writes in lowercase, which keep it (`npj quantum materials`). */
const LOWERCASE_BRANDS: ReadonlySet<string> = new Set(['npj']);

const capitalize = (word: string) => `${word.charAt(0).toUpperCase()}${word.slice(1)}`;

/**
 * Title-case a journal name, which NLM catalogs in sentence case (`Frontiers in
 * pediatrics`), for APA and MLA, which cite it in title case. Only a word part
 * written entirely in lowercase letters gains a capital — each part of a
 * hyphenated word on its own — so a name NLM already cases (`eLife`, `mBio`,
 * `JAMA`, `PloS`) and any part carrying a digit stay as written, as do a
 * lowercase brand and a single-letter prefix (`npj`, `i-Perception`, `e-SPEN`).
 * An elision capitalizes the word, not its particle (`d'Ophtalmologie`). A minor
 * word stays lowercase unless it opens the name, or a subtitle or parallel title
 * after a colon, semicolon, or ` = ` (`CA: A Cancer Journal`). (#217)
 */
function titleCaseJournal(title: string, minorWords: ReadonlySet<string>): string {
  let opensPhrase = true;
  const caseWord = (word: string, opens: boolean): string => {
    if (!opens && minorWords.has(word)) return word;
    const elision = ELISION.exec(word);
    if (!elision) return capitalize(word);
    const [, particle = '', apostrophe = '', rest = ''] = elision;
    return `${opens ? capitalize(particle) : particle}${apostrophe}${caseWord(rest, false)}`;
  };
  return title
    .split(/(\s+)/)
    .map((token) => {
      if (!/\S/.test(token)) return token;
      if (token === ':' || token === ';' || token === '=') {
        opensPhrase = true;
        return token;
      }
      const parts = token.split('-');
      const cased = parts
        .map((part, index) => {
          const match = LOWERCASE_WORD.exec(part);
          if (!match) return part;
          const [, lead = '', word = '', trail = ''] = match;
          const isPrefix = index === 0 && parts.length > 1 && word.length === 1;
          if (isPrefix || LOWERCASE_BRANDS.has(word)) return part;
          return `${lead}${caseWord(word, opensPhrase && index === 0)}${trail}`;
        })
        .join('-');
      opensPhrase = /[:;]$/.test(token);
      return cased;
    })
    .join('');
}

/** NLM's year qualifier: `Journal of women's health (2002)`. */
const YEAR_QUALIFIER = /^\d{4}$/;

/** An edition or format qualifier: `(Clinical research ed.)`, `(Landmark edition)`, `(Print)`. */
const EDITION_QUALIFIER = /(?:\bed\.|\bedition)$|(?:^|: )(?:Online|Print)$/i;

/** An abbreviation naming an edition: `Med Clin (Engl Ed)`, `Angew Chem Int Ed Engl`. */
const EDITION_ABBREVIATION = /\b(?:Ed|Edn|Edition)\b/i;

/**
 * A place qualifier, `Place, Region` with an optional year: `London, England`,
 * `New York, N.Y.`, `Chicago, Ill. : 1978`. Neither part holds a parenthesis,
 * semicolon, or digit, and the region absorbs any space before the year's
 * colon, so no two parts compete for a character and a near-miss fails in
 * linear time.
 */
const PLACE_QUALIFIER = /^[^,():;\d]+,[^():;\d]+(?::\s*\d{4})?$/;

/**
 * The parenthetical a title ends on, a nested one read as one unit
 * (`Bulletin (Hospital for Joint Diseases (New York, N.Y.))`), with the text
 * before it; undefined when the title does not end on a balanced one.
 */
function trailingParenthetical(title: string): { base: string; inner: string } | undefined {
  if (!title.endsWith(')')) return;
  let depth = 0;
  for (let i = title.length - 1; i >= 0; i--) {
    if (title[i] === ')') depth++;
    else if (title[i] === '(' && --depth === 0) {
      return { base: title.slice(0, i).trimEnd(), inner: title.slice(i + 1, -1) };
    }
  }
  return;
}

/**
 * The journal name APA and MLA cite: NLM's title less the place, year, or
 * edition NLM appends to tell same-named journals apart (`Lancet (London,
 * England)` → `Lancet`, `Journal of women's health (2002)`, `BMJ (Clinical
 * research ed.)`). The journal prints no such text. An edition stays when the
 * ISO abbreviation names it too, as it is then a journal of its own (`Medicina
 * clinica (English ed.)`, `Med Clin (Engl Ed)`). Any other parenthetical names
 * the journal and stays: an issuing body (`Proceedings (Baylor University.
 * Medical Center)`), a subject, a one-word place. Over NLM's journal list the
 * rule is wrong on 18 of the 2,005 titles NLM's catalog settles — a place-shaped
 * issuing body (`Collegian (Royal College of Nursing, Australia)`) is dropped,
 * and a place with no region (`Medical record (New York : 1934)`) is kept. (#227)
 */
function citedJournalName(title: string, isoAbbreviation?: string): string {
  const group = trailingParenthetical(title);
  if (!group?.base) return title;
  const { base, inner } = group;
  if (YEAR_QUALIFIER.test(inner)) return base;
  if (EDITION_QUALIFIER.test(inner)) {
    return EDITION_ABBREVIATION.test(isoAbbreviation ?? '') ? title : base;
  }
  return PLACE_QUALIFIER.test(inner) ? base : title;
}

/**
 * Author keywords, then MeSH descriptor names, each term once: a term equal to
 * an earlier one ignoring case is dropped, so the author's spelling and position
 * win (`Deep learning` over MeSH `Deep Learning`). (#217)
 */
function mergedKeywords(article: ParsedArticle): string[] {
  const terms = new Map<string, string>();
  const candidates = [
    ...(article.keywords ?? []),
    ...(article.meshTerms ?? []).map((m) => m.descriptorName),
  ];
  for (const term of candidates) {
    if (!term) continue;
    const key = term.toLowerCase();
    if (!terms.has(key)) terms.set(key, term);
  }
  return [...terms.values()];
}

/**
 * Collapse each whitespace run to one space and trim the ends. The parser trims
 * only a field's ends, so a line break inside a title, name, or keyword — or
 * between a structured abstract's paragraphs — would otherwise reach a
 * citation: an untagged RIS line, or a blank one that strict parsers read as
 * the end of the record. Every style writes record text through this. (#233)
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

/*
 * A generational suffix (`Jr`, `2nd`) renders verbatim as NCBI writes it, as
 * NCBI's own citation export prints it. It qualifies a surname, so a name with
 * no surname renders without it. Inverted name forms set it off with a comma
 * (`Frenck, R. W., Jr`); natural-order and NLM forms append it after a space
 * (`R. W. Frenck Jr`, `Frenck RW Jr`). (#226)
 */

/** `, Jr` for an inverted name form; `''` without a suffix or a surname. */
function invertedSuffix(author: ParsedArticleAuthor): string {
  return author.lastName && author.suffix ? `, ${author.suffix}` : '';
}

/** ` Jr` for a natural-order or NLM name form; `''` without a suffix or a surname. */
function trailingSuffix(author: ParsedArticleAuthor): string {
  return author.lastName && author.suffix ? ` ${author.suffix}` : '';
}

/**
 * Format a single author in APA style: `Last, F. M.`, or `Last, F. M., Jr`.
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
  if (!initials) return `${last}${invertedSuffix(author)}`;
  // Extract only letter characters (Unicode-aware: preserve Á, Ö, É, etc.),
  // format each as "X." separated by spaces.
  const formatted = Array.from(initials.replace(/[^\p{L}]/gu, ''))
    .map((c) => `${c}.`)
    .join(' ');
  if (!last) return formatted;
  return `${last}, ${formatted}${invertedSuffix(author)}`;
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
 * First listed author: `Last, First Middle`, or `Last, First Middle, Jr`.
 * Subsequent authors: `First Middle Last`, or `First Middle Last Jr`.
 */
function formatAuthorMla(author: ParsedArticleAuthor, isFirst: boolean): string {
  if (author.collectiveName) return author.collectiveName;
  const last = author.lastName ?? '';
  const first = author.firstName ?? '';
  if (!last) return first;
  if (isFirst) return `${first ? `${last}, ${first}` : last}${invertedSuffix(author)}`;
  return `${first ? `${first} ${last}` : last}${trailingSuffix(author)}`;
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
 * Format a single author in BibTeX style: `{Last}, First`, or the three-part
 * `{Last}, Jr, First` when the name carries a suffix — the comma after `Jr`
 * stays even with no first name, so the suffix is never read as one.
 */
function formatAuthorBibtex(author: ParsedArticleAuthor): string {
  if (author.collectiveName) return `{${escapeBibtex(author.collectiveName)}}`;
  const last = author.lastName ? escapeBibtex(author.lastName) : '';
  const first = author.firstName ? escapeBibtex(author.firstName) : '';
  if (!last) return first;
  if (author.suffix) return `{${last}}, ${escapeBibtex(author.suffix)},${first && ` ${first}`}`;
  return first ? `{${last}}, ${first}` : `{${last}}`;
}

// ---------------------------------------------------------------------------
// APA 7th Edition
// ---------------------------------------------------------------------------

/**
 * Format an editor in APA's "In E. E. Editor (Ed.)," position: initials first,
 * surname last — the inverse of the author position — and a suffix after the
 * surname (`M. P. Adam Jr`).
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
  return [initials, editor.lastName].filter(Boolean).join(' ') + trailingSuffix(editor);
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
 * A chapter's year is its own ({@link chapterDate}), not the book's. A whole-book
 * record drops the `In …` clause and italicizes its own title.
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

  // A publisher already ending in a period (`MDText.com, Inc.`) gains no second one
  if (book.publisher) parts.push(terminate(book.publisher));

  const url = bookAccessUrl(article);
  if (url) parts.push(url);

  return collapseWhitespace(parts.join(' '));
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
 * A retracted article ends on `(Retraction published <RefSource>)`. A Bookshelf
 * record routes to {@link formatApaBook}.
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
    const name = citedJournalName(journal.title, journal.isoAbbreviation);
    let journalPart = `*${titleCaseJournal(name, APA_MINOR_WORDS)}*`;
    if (journal.volume) {
      journalPart += `, *${journal.volume}*`;
      if (journal.issue) {
        journalPart += `(${journal.issue})`;
      }
    }
    // APA 7 p. 294-295: an article number takes the page range's place
    const number = articleNumber(journal);
    if (number) {
      journalPart += `, Article ${number}`;
    } else if (journal.pages) {
      journalPart += `, ${expandPageRanges(journal.pages, '\u{2013}')}`;
    }
    journalPart += '.';
    parts.push(journalPart);
  }

  // DOI — no trailing period after DOI URL
  if (article.doi) {
    parts.push(`https://doi.org/${article.doi}`);
  }

  // APA 7 notes a retraction after the DOI. Its own form names the notice's
  // year, full journal title, and location, which `RefSource` does not carry
  // apart; NCBI's exporter fills the parenthetical with `RefSource` instead.
  const retractions = citationNotices(article)
    .filter((notice) => notice.refType === 'RetractionIn')
    .map((notice) => stripTrailingPeriod(notice.refSource));
  if (retractions.length > 0) {
    parts.push(`(Retraction published ${retractions.join('; ')})`);
  }

  return collapseWhitespace(parts.join(' '));
}

// ---------------------------------------------------------------------------
// MLA 9th Edition
// ---------------------------------------------------------------------------

/** MLA renders editors first-name-first after `edited by`, as it does a non-first author. */
function formatEditorsMla(editors: ParsedBookEditor[]): string {
  const names = editors.map((editor) => formatAuthorMla(editor, false)).filter(Boolean);
  if (names.length === 0) return '';
  if (names.length === 1) return names[0] ?? '';
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names[0]}, et al.`;
}

/**
 * Format a Bookshelf record as an MLA 9th edition citation.
 *
 * ```
 * Author. "Chapter Title." *Book Title*, edited by E. Editor, Publisher, Date.
 * ```
 * A chapter's date is its own, in full (`20 Dec. 2018`); otherwise the book's
 * year. A whole-book record italicizes its own title in place of the quoted
 * chapter.
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
  const ownDate = chapterDate(article);
  const date = ownDate ? formatDateMla(ownDate) : getYear(article);
  if (date !== 'n.d.') detailParts.push(date);
  if (detailParts.length) parts.push(terminate(detailParts.join(', ')));

  return collapseWhitespace(parts.join(' '));
}

/**
 * Format a PubMed article as an MLA 9th edition citation.
 *
 * Pattern:
 * ```
 * Last, First, et al. "Title." *Journal*, vol. 12, no. 3, 2024, pp. 45-67. DOI.
 * ```
 * A Bookshelf record routes to {@link formatMlaBook}.
 */
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
    const name = citedJournalName(journal.title, journal.isoAbbreviation);
    detailParts.push(`*${titleCaseJournal(name, MLA_MINOR_WORDS)}*`);

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

    // MLA 9 codifies no article-number form; citation guides converge on
    // "art. <value>" in the page position.
    const number = articleNumber(journal);
    if (number) {
      detailParts.push(`art. ${number}`);
    } else if (journal.pages) {
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

  return collapseWhitespace(parts.join(' '));
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

  // Pages, each range written in full (#228) — or, with no pagination,
  // biblatex's `eid` for the article number. Classic BibTeX has no
  // article-number field and overloading `pages` is imprecise; `eid` is broadly
  // supported (acmart included).
  if (journal?.pages) {
    fields.push(['pages', escapeBibtex(expandPageRanges(journal.pages))]);
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

  // Keywords — article keywords merged with MeSH descriptor names. Brace-wrap
  // each term so MeSH descriptors that carry internal commas in their inverted
  // form (e.g. "Databases, Protein") stay a single keyword — biblatex's
  // comma-separated list parser reads a braced item as one element.
  const keywords = mergedKeywords(article);
  if (keywords.length > 0) {
    fields.push(['keywords', keywords.map((k) => `{${escapeBibtex(k)}}`).join(', ')]);
  }

  // Build entry — each value on its own line, whitespace runs collapsed (#233)
  const maxKeyLen = Math.max(...fields.map(([k]) => k.length));
  const fieldLines = fields
    .map(([k, v]) => `  ${k.padEnd(maxKeyLen)} = {${collapseWhitespace(v)}}`)
    .join(',\n');

  return `@${entryType}{${key},\n${fieldLines}\n}`;
}

// ---------------------------------------------------------------------------
// RIS
// ---------------------------------------------------------------------------

/**
 * An `AU` or `A2` value: `Lastname, Firstname`, or `Lastname, Firstname, Suffix`.
 * Positional, so a suffixed name with no first name keeps the empty slot
 * (`Frenck, , Jr`) rather than reading the suffix as a first name.
 */
function formatNameRis(person: ParsedArticleAuthor): string {
  if (person.collectiveName) return person.collectiveName;
  const last = person.lastName ?? '';
  const first = person.firstName ?? '';
  if (last && person.suffix) return `${last}, ${first}, ${person.suffix}`;
  return first ? `${last}, ${first}` : last;
}

/**
 * Format a PubMed article as a RIS record.
 *
 * Each tag is 2 characters, followed by two spaces, a dash, two spaces, then the value.
 * Record ends with `ER  - ` (trailing spaces per spec).
 */
export function formatRis(article: ParsedArticle): string {
  const lines: string[] = [];

  // Every value on its own tag line: a line break inside one would leave an
  // untagged line, or a blank one that ends the record for strict parsers (#233)
  const tag = (code: string, value: string | undefined): void => {
    const text = value && collapseWhitespace(value);
    if (text) lines.push(`${code}  - ${text}`);
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
  for (const author of article.authors ?? []) tag('AU', formatNameRis(author));

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
    for (const editor of book.editors ?? []) tag('A2', formatNameRis(editor));
    tag('PB', book.publisher);
    tag('CY', book.publisherLocation);
    tag('ET', book.edition);
    tag('T3', book.collectionTitle);
  }

  // Year, and a Bookshelf chapter's own date in full as `DA` (YYYY/MM/DD)
  const year = getYear(article);
  if (year !== 'n.d.') {
    tag('PY', year);
  }
  const ownDate = chapterDate(article);
  if (ownDate) tag('DA', formatDateRis(ownDate));

  // Volume & Issue
  tag('VL', journal?.volume);
  tag('IS', journal?.issue);

  // Pages — the first page and the last, written in full ({@link splitPages}).
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

  // Keywords — article keywords merged with MeSH descriptor names
  for (const kw of mergedKeywords(article)) {
    tag('KW', kw);
  }

  // Abstract — a structured abstract's paragraphs flatten onto the one line
  tag('AB', article.abstractText);

  // End of record (trailing space per RIS spec)
  lines.push('ER  - ');

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Vancouver (ICMJE / NLM)
// ---------------------------------------------------------------------------

/**
 * Format a single author in Vancouver style: `Surname AB` — surname, a space,
 * then initials with no periods or internal spaces, then any suffix after a
 * space (`Frenck RW Jr`). Collective/group authors return their name directly.
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
  return `${initials ? `${last} ${initials}` : last}${trailingSuffix(author)}`;
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
 * Format a Bookshelf record as a Vancouver (NLM) reference, following *Citing
 * Medicine* 2e Ch. 22 §C, Contributions to Books on the Internet:
 * ```
 * Authors. Chapter title. Contributed [updated Revised]. In: Editors, editors.
 * Book title [Internet]. Place: Publisher; date. Available from: URL
 * ```
 * The chapter carries its own dates (`1998 Oct 23 [updated 2018 Dec 20]`); the
 * container keeps the book's, open-ended as `2000-` while the book is still
 * updated. A whole-book record drops the contribution and the `In:`, taking the
 * book title as its own. `[cited …]` and the extent (`[about 41 p.]`) are part of
 * the NLM pattern but neither is derivable from an EFetch record, so both are
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
    const { contributed, revised } = chapterDates(article);
    const dated = [
      contributed && formatDateNlm(contributed),
      revised && `[updated ${formatDateNlm(revised)}]`,
    ].filter(Boolean);
    if (dated.length) segments.push(`${dated.join(' ')}.`);
    segments.push(editorStr ? `In: ${editorStr}, editors.` : 'In:');
  } else if (!authorStr && editorStr) {
    segments.push(`${editorStr}, editors.`);
  }

  const container = bookTitleWithMedium(book);
  if (container) segments.push(`${stripTrailingPeriod(container)}.`);

  const source = [bookImprint(book), bookDateSpan(book)].filter(Boolean).join('; ');
  if (source) segments.push(terminate(source));

  // No trailing period — it would be read as part of the URL
  const url = bookshelfUrl(book);
  if (url) segments.push(`Available from: ${url}`);

  return collapseWhitespace(segments.join(' '));
}

/**
 * The notices Vancouver notes after the reference, each with Citing Medicine's
 * label (Boxes 58–59). NCBI's own NLM export prints these two and no others.
 */
const VANCOUVER_NOTE_LABELS: Partial<Record<CitationNoticeType, string>> = {
  RetractionIn: 'Retraction in',
  ErratumIn: 'Erratum in',
};

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
 * period so it stays copy-pasteable, unless a note follows it. An article number replaces nothing — with
 * no pagination it trails the source as an NLM note (`. pii: 2400512.`). A
 * retraction or erratum follows as a note (`Retraction in: <RefSource>`). A
 * Bookshelf record routes to {@link formatVancouverBook}.
 */
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

  // Citing Medicine's retraction and erratum notes (Boxes 58–59), one per
  // notice in NCBI's order with `RefSource` verbatim, as NCBI's NLM export
  // prints them. Each ends on exactly one period: some `RefSource`s carry none.
  const notes = citationNotices(article).flatMap((notice) => {
    const label = VANCOUVER_NOTE_LABELS[notice.refType];
    return label ? [terminate(`${label}: ${notice.refSource}`)] : [];
  });

  // DOI — NLM "doi: <doi>" form with no trailing period, which a reader copying
  // it would take as part of the DOI; a note after it closes it, as in NLM's export
  if (article.doi) {
    segments.push(notes.length > 0 ? `doi: ${article.doi}.` : `doi: ${article.doi}`);
  }
  segments.push(...notes);

  return collapseWhitespace(segments.join(' '));
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
