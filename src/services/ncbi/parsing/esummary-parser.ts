/**
 * @fileoverview Helper functions for parsing ESummary results from NCBI.
 * Handles different ESummary XML structures and formats the data into
 * consistent ParsedBriefSummary objects.
 * @module src/services/ncbi/parsing/esummary-parser
 */

import type { RequestContext } from '@cyanheads/mcp-ts-core/utils';
import { logger, requestContextService, withExtra } from '@cyanheads/mcp-ts-core/utils';
import type {
  ESummaryArticleId,
  ESummaryDocSumOldXml,
  ESummaryDocumentSummary,
  ESummaryItem,
  ESummaryResult,
  ParsedBriefSummary,
  ESummaryAuthor as XmlESummaryAuthor,
  XmlESummaryAuthorRaw,
} from '../types.js';
import { decodeHtmlEntities } from './text-helpers.js';
import { ensureArray, getAttribute, getOptionalText, getText } from './xml-helpers.js';

/**
 * Formats an array of ESummary authors into a string.
 * Limits to the first 3 authors and adds 'et al.' if more exist.
 */
export function formatESummaryAuthors(authors?: XmlESummaryAuthor[]): string {
  if (!authors || authors.length === 0) return '';
  return (
    authors
      .slice(0, 3)
      .map((author) => author.name)
      .join(', ') + (authors.length > 3 ? ', et al.' : '')
  );
}

/** 3-letter month abbreviations used by NCBI ESummary PubDate/EPubDate fields. */
const MONTH_ABBREV: Record<string, string> = {
  Jan: '01',
  Feb: '02',
  Mar: '03',
  Apr: '04',
  May: '05',
  Jun: '06',
  Jul: '07',
  Aug: '08',
  Sep: '09',
  Oct: '10',
  Nov: '11',
  Dec: '12',
};

/** One end of a stated date, holding only the parts ESummary states. */
interface DatePoint {
  day?: string;
  month?: string;
  year: string;
}

/** A date or one end of a range: `2026`, `2026 Dec`, `2026 Sep 30`. Groups: year, month?, day? */
const POINT_RE = /^(\d{4})(?: ([A-Za-z]{3})(?: (\d{1,2}))?)?$/;
/** A range end that keeps the start's year and month: the `25` of `1999 Dec 18-25`. */
const DAY_END_RE = /^\d{1,2}$/;
/** A season after a year or a year range: `1996 Summer`, `1994-1995 Winter`. */
const SEASON_RE = / (?:Spring|Summer|Fall|Autumn|Winter)$/;
/** The year a value of any other shape opens with: `2017 May-June`. */
const LEADING_YEAR_RE = /^(\d{4})(?:[ /-]|$)/;

function readPoint(text: string): DatePoint | undefined {
  const [, year, monthName, day] = POINT_RE.exec(text) ?? [];
  if (year === undefined) return;
  if (monthName === undefined) return { year };
  const month = MONTH_ABBREV[monthName];
  if (!month) return;
  return day === undefined ? { year, month } : { year, month, day: day.padStart(2, '0') };
}

/**
 * A range's end, at its start's precision. The end may leave out the start's
 * year (`Sep-Oct`, `Aug 30-Sep 5`) or year and month (`Dec 18-25`), and a day
 * after a month range is dropped (`2026 Jan-Feb 01` is January to February).
 * Undefined for an end at any other precision.
 */
function readRangeEnd(text: string, start: DatePoint): DatePoint | undefined {
  const end =
    readPoint(text) ??
    readPoint(`${start.year} ${text}`) ??
    (start.day && DAY_END_RE.test(text) ? { ...start, day: text.padStart(2, '0') } : undefined);
  if (!end) return;
  if (start.day) return end.day ? end : undefined;
  if (start.month) return end.month ? { year: end.year, month: end.month } : undefined;
  return end.month ? undefined : end;
}

const isoPoint = ({ year, month, day }: DatePoint) =>
  [year, month, day].filter((part) => part !== undefined).join('-');

/** A date or a `-`/`/` range, a year optionally followed by a season; undefined for other shapes. */
function readStatedDate(text: string): string | undefined {
  const season = SEASON_RE.exec(text);
  const body = season ? text.slice(0, season.index) : text;
  const separator = body.search(/[-/]/);
  const start = readPoint(separator === -1 ? body : body.slice(0, separator));
  // A season qualifies a year, never a month.
  if (!start || (season && start.month)) return;
  if (separator === -1) return isoPoint(start);

  const end = readRangeEnd(body.slice(separator + 1), start);
  if (!end) return;
  const from = isoPoint(start);
  const to = isoPoint(end);
  if (to < from) return;
  // Equal ends state one point: `2026 Sep-Sep` is September.
  if (to === from) return from;
  // Every month of one year is that year.
  if (from === `${start.year}-01` && to === `${start.year}-12`) return start.year;
  return `${from}/${to}`;
}

/**
 * Reads an ESummary date — `PubDate`, `EPubDate`, or part of a Bookshelf
 * `DocDate` — as ISO 8601 at the precision PubMed states it: `2026`, `2026-12`,
 * `2026-09-30`. A stated range is an interval `start/end` with both ends at the
 * start's precision: `2026 Sep-Oct` and `2026 Sep/Oct` read `2026-09/2026-10`,
 * `1994-1995 Winter` `1994/1995`, `1999 Dec 18-25` `1999-12-18/1999-12-25`, and
 * `2006 Dec 12-2007 Jan 1` `2006-12-12/2007-01-01`. A range whose ends are
 * equal reads as that one point (`2026 Sep-Sep` `2026-09`), `2026 Jan-Dec` as
 * `2026`, a season as its year, and any other value opening with a four-digit
 * year (`2017 May-June`) as that year. Undefined for a value that opens with
 * no year. (#293)
 */
export function parseNcbiDate(dateStr: string): string | undefined {
  const text = dateStr.trim().split(/\s+/).join(' ');
  return readStatedDate(text) ?? LEADING_YEAR_RE.exec(text)?.[1];
}

/** Opens the revision date inside a Bookshelf chapter's `DocDate`. */
const DOC_DATE_UPDATED = '[updated ';

/**
 * A Bookshelf chapter's own date from its ESummary `DocDate` — `1998 Oct 23
 * [updated 2018 Dec 20]`, `2025 Jul 3`, `2021 Sep`, or `2026` — read by
 * {@link parseNcbiDate}: the revision when there is one, otherwise the
 * contribution date, as `pubmed_format_citations` dates the chapter (#189). An
 * unreadable revision falls back to the contribution date; undefined when
 * neither reads, so the caller keeps the book's date rather than guessing. (#199)
 */
export function chapterDateFromDocDate(docDate: string): string | undefined {
  const updated = docDate.indexOf(DOC_DATE_UPDATED);
  const close = updated === -1 ? -1 : docDate.indexOf(']', updated);
  const revised =
    close === -1
      ? undefined
      : parseNcbiDate(docDate.slice(updated + DOC_DATE_UPDATED.length, close));
  const bracket = docDate.indexOf('[');
  return revised ?? parseNcbiDate(docDate.slice(0, bracket === -1 ? undefined : bracket));
}

/**
 * Returns the id type (e.g. 'doi', 'pmc') from an ESummary ArticleId entry,
 * normalizing across JSON (`idtype`) and XML (`IdType`) casings.
 */
function getArticleIdType(id: ESummaryArticleId): string | undefined {
  return id.idtype ?? id.IdType;
}

/**
 * Returns the raw value field from an ESummary ArticleId entry,
 * normalizing across JSON (`value`) and XML (`Value`) casings. The value may
 * be a string or number — `getText` handles both.
 */
function getArticleIdValue(id: ESummaryArticleId): unknown {
  return id.value ?? id.Value;
}

/**
 * Read the contributor list of a `DocumentSummarySet` summary.
 *
 * `authtype` and `clusterid` are omitted rather than written as empty strings
 * when the record carries neither — NCBI ships `<ClusterID/>` on every author of
 * a Bookshelf summary, and a field present with no value is the same absence to
 * every consumer. (#137)
 * @internal exported for direct unit tests
 */
export function parseESummaryAuthorsFromDocumentSummary(
  docSummary: ESummaryDocumentSummary,
): XmlESummaryAuthor[] {
  const authorsProp = docSummary.Authors;
  if (!authorsProp) return [];

  const parsedAuthors: XmlESummaryAuthor[] = [];

  const processRawAuthor = (rawAuthInput: XmlESummaryAuthorRaw | string) => {
    let name = '';
    let authtype: string | undefined;
    let clusterid: string | undefined;

    if (typeof rawAuthInput === 'string') {
      name = rawAuthInput;
    } else if (rawAuthInput && typeof rawAuthInput === 'object') {
      const authorObj = rawAuthInput;
      name = getText(authorObj, '');

      if (!name) {
        name = getText(authorObj.Name || authorObj.name, '');
      }

      authtype = getOptionalText(authorObj.AuthType || authorObj.authtype);
      clusterid = getOptionalText(authorObj.ClusterId || authorObj.clusterid);

      if (!name) {
        const authInputString = JSON.stringify(authorObj);
        logger.warning(
          `Unhandled author structure in parseESummaryAuthorsFromDocumentSummary. authInput: ${authInputString.substring(0, 100)}`,
          requestContextService.createRequestContext({
            operation: 'parseESummaryAuthorsFromDocumentSummary',
            additionalContext: { detail: 'Unhandled author structure' },
          }),
        );
        const keys = Object.keys(authorObj);
        if (
          keys.length === 1 &&
          keys[0] &&
          typeof (authorObj as Record<string, unknown>)[keys[0]] === 'string'
        ) {
          name = (authorObj as Record<string, unknown>)[keys[0]] as string;
        } else if (authInputString.length < 100) {
          name = authInputString;
        }
      }
    }

    if (name.trim()) {
      parsedAuthors.push({
        name: name.trim(),
        ...(authtype !== undefined && { authtype }),
        ...(clusterid !== undefined && { clusterid }),
      });
    }
  };

  if (Array.isArray(authorsProp)) {
    for (const item of authorsProp as (XmlESummaryAuthorRaw | string)[]) {
      processRawAuthor(item);
    }
  } else if (typeof authorsProp === 'object' && 'Author' in authorsProp && authorsProp.Author) {
    const rawAuthors = ensureArray(
      authorsProp.Author as XmlESummaryAuthorRaw | XmlESummaryAuthorRaw[] | string,
    );
    for (const item of rawAuthors) {
      processRawAuthor(item);
    }
  } else if (typeof authorsProp === 'string') {
    try {
      if (authorsProp.startsWith('[') && authorsProp.endsWith(']')) {
        const parsedJsonAuthors = JSON.parse(authorsProp) as unknown[];
        if (Array.isArray(parsedJsonAuthors)) {
          for (const authItem of parsedJsonAuthors) {
            if (typeof authItem === 'string') {
              parsedAuthors.push({ name: authItem.trim() });
            } else if (
              typeof authItem === 'object' &&
              authItem !== null &&
              ((authItem as XmlESummaryAuthorRaw).name || (authItem as XmlESummaryAuthorRaw).Name)
            ) {
              processRawAuthor(authItem as XmlESummaryAuthorRaw);
            }
          }
          if (parsedAuthors.length > 0) return parsedAuthors;
        }
      }
    } catch (e) {
      logger.debug(
        `Failed to parse Authors string as JSON: ${authorsProp.substring(0, 100)}`,
        requestContextService.createRequestContext({
          operation: 'parseESummaryAuthorsFromString',
          additionalContext: {
            input: authorsProp.substring(0, 100),
            error: e instanceof Error ? e.message : String(e),
          },
        }),
      );
    }
    for (const namePart of authorsProp.split(/[,;]/)) {
      const trimmed = namePart.trim();
      if (trimmed) parsedAuthors.push({ name: trimmed });
    }
  }
  return parsedAuthors.filter((author) => author.name);
}

/**
 * Split an ESummary contributor list into the record's own authors and the
 * containing book's editors.
 *
 * ESummary lists a book's editors ahead of the chapter's authors, so a display
 * string built from the first few names credits the series editors instead of
 * the people who wrote the chapter — PMID 20301425 reads "Adam MP, Bick S,
 * Mirzaa GM, et al." where the authors are Petrucelli, Daly and Pal. A record
 * whose only contributors are editors keeps them: they are the best attribution
 * it has. (#114)
 */
function splitContributors(contributors: XmlESummaryAuthor[]): {
  authors: XmlESummaryAuthor[];
  editors: XmlESummaryAuthor[];
} {
  const editors = contributors.filter((c) => c.authtype?.toLowerCase() === 'editor');
  const authors = contributors.filter((c) => c.authtype?.toLowerCase() !== 'editor');
  return { authors: authors.length > 0 ? authors : contributors, editors };
}

function parseSingleDocumentSummary(docSummary: ESummaryDocumentSummary): ParsedBriefSummary {
  const pmid = docSummary['@_uid'];
  const { authors: authorsArray, editors } = splitContributors(
    parseESummaryAuthorsFromDocumentSummary(docSummary),
  );

  let idsArray: ESummaryArticleId[] = [];
  const articleIdsProp = docSummary.ArticleIds;
  if (articleIdsProp) {
    idsArray = Array.isArray(articleIdsProp)
      ? articleIdsProp
      : ensureArray(
          (
            articleIdsProp as {
              ArticleId: ESummaryArticleId[] | ESummaryArticleId;
            }
          ).ArticleId,
        );
  }

  let doiValue = getOptionalText(docSummary.DOI);
  if (!doiValue) {
    const doiEntry = idsArray.find((id) => getArticleIdType(id) === 'doi');
    if (doiEntry) {
      doiValue = getOptionalText(getArticleIdValue(doiEntry));
    }
  }

  const pmcEntry = idsArray.find((id) => getArticleIdType(id) === 'pmc');
  const pmcIdValue = pmcEntry ? getOptionalText(getArticleIdValue(pmcEntry)) : undefined;

  // NCBI double-encodes some titles here as in EFetch (`Parkinson&amp;apos;s`),
  // so Title and BookTitle take the one residual decode EFetch's parser gives
  // the same fields; names and the journal read as parsed on both paths. (#262)
  const title = decodeHtmlEntities(getText(docSummary.Title));
  const source =
    getText(docSummary.Source) || getText(docSummary.FullJournalName) || getText(docSummary.SO);
  // A Bookshelf record leaves Source and FullJournalName empty and carries its
  // venue here instead, so without these a book summary renders with none. (#114)
  const bookTitle = decodeHtmlEntities(getText(docSummary.BookTitle));
  const publisherName = getText(docSummary.PublisherName);
  const docType = getText(docSummary.DocType);
  // A chapter's PubDate is its book's (GeneReviews: 1993); its own dates are in
  // DocDate, which ESummary sets on chapters only. (#199)
  const chapterDate =
    docType === 'chapter' ? chapterDateFromDocDate(getText(docSummary.DocDate)) : undefined;
  const pubDate = chapterDate ?? parseNcbiDate(getText(docSummary.PubDate));
  const epubDate = parseNcbiDate(getText(docSummary.EPubDate));

  return {
    pmid: String(pmid),
    ...(title && { title }),
    authors: formatESummaryAuthors(authorsArray),
    authorNames: authorsArray.map((a) => a.name),
    ...(editors.length > 0 && { editors: editors.map((e) => e.name) }),
    ...(source && { source }),
    ...(bookTitle && { bookTitle }),
    ...(publisherName && { publisherName }),
    ...(docType && { docType }),
    ...(doiValue && { doi: doiValue }),
    ...(pmcIdValue && { pmcId: pmcIdValue }),
    ...(pubDate && { pubDate }),
    ...(epubDate && { epubDate }),
  };
}

function parseSingleDocSumOldXml(docSum: ESummaryDocSumOldXml): ParsedBriefSummary {
  const pmid = docSum.Id;
  const items = ensureArray(docSum.Item);

  const getItemValue = (
    name: string | string[],
    type?: ESummaryItem['@_Type'],
  ): string | undefined => {
    const namesToTry = ensureArray(name);
    for (const n of namesToTry) {
      const item = items.find(
        (i) => i['@_Name'] === n && (type ? i['@_Type'] === type : true) && i['@_Type'] !== 'ERROR',
      );
      if (item) {
        const textVal = getText(item);
        if (textVal !== undefined) return String(textVal);
      }
    }
    return;
  };

  const getAuthorList = (): XmlESummaryAuthor[] => {
    const authorListItem = items.find(
      (i) => i['@_Name'] === 'AuthorList' && i['@_Type'] === 'List',
    );
    if (authorListItem?.Item) {
      return ensureArray(authorListItem.Item)
        .filter((a) => a['@_Name'] === 'Author' && a['@_Type'] === 'String')
        .map((a) => ({ name: getText(a, '') }));
    }
    return items
      .filter((i) => i['@_Name'] === 'Author' && i['@_Type'] === 'String')
      .map((a) => ({ name: getText(a, '') }));
  };

  const authorsArray = getAuthorList();

  const articleIdsItem = items.find((i) => i['@_Name'] === 'ArticleIds' && i['@_Type'] === 'List');
  const articleIdsList = articleIdsItem?.Item ? ensureArray(articleIdsItem.Item) : [];

  let doiFromItems: string | undefined = getItemValue('DOI', 'String');
  if (!doiFromItems) {
    const doiIdItem = articleIdsList.find(
      (id) => getAttribute(id, 'idtype') === 'doi' || id['@_Name'] === 'doi',
    );
    if (doiIdItem) {
      doiFromItems = getText(doiIdItem);
    }
  }

  let pmcIdFromItems: string | undefined;
  const pmcIdItem = articleIdsList.find(
    (id) => getAttribute(id, 'idtype') === 'pmc' || id['@_Name'] === 'pmc',
  );
  if (pmcIdItem) {
    pmcIdFromItems = getText(pmcIdItem);
  }

  const rawTitle = getItemValue('Title', 'String');
  const title = rawTitle === undefined ? undefined : decodeHtmlEntities(rawTitle);
  const source = getItemValue(['Source', 'FullJournalName', 'SO'], 'String');
  const pubDate = parseNcbiDate(getItemValue(['PubDate', 'ArticleDate'], 'Date') ?? '');
  const epubDate = parseNcbiDate(getItemValue('EPubDate', 'Date') ?? '');

  return {
    pmid: String(pmid),
    ...(title !== undefined && { title }),
    authors: formatESummaryAuthors(authorsArray),
    authorNames: authorsArray.map((a) => a.name),
    ...(source !== undefined && { source }),
    ...(doiFromItems !== undefined && { doi: doiFromItems }),
    ...(pmcIdFromItems !== undefined && { pmcId: pmcIdFromItems }),
    ...(pubDate && { pubDate }),
    ...(epubDate && { epubDate }),
  };
}

function readBriefSummaries(
  eSummaryResult: ESummaryResult | undefined,
  context: RequestContext | undefined,
): ParsedBriefSummary[] {
  if (!eSummaryResult) return [];

  if (eSummaryResult.ERROR) {
    logger.warning(
      'ESummary result contains an error',
      withExtra(
        context ??
          requestContextService.createRequestContext({
            operation: 'extractBriefSummariesInternal',
          }),
        { errorDetails: eSummaryResult.ERROR },
      ),
    );
    return [];
  }

  if (eSummaryResult.DocumentSummarySet?.DocumentSummary) {
    const docSummaries = ensureArray(eSummaryResult.DocumentSummarySet.DocumentSummary);
    return docSummaries.map(parseSingleDocumentSummary).filter((s) => s.pmid);
  }
  if (eSummaryResult.DocSum) {
    const docSums = ensureArray(eSummaryResult.DocSum);
    return docSums.map(parseSingleDocSumOldXml).filter((s) => s.pmid);
  }
  return [];
}

/**
 * Extracts and formats brief summaries from ESummary XML result.
 * Handles both DocumentSummarySet (newer) and older DocSum structures. The
 * parse is synchronous; the promise keeps the signature its callers await.
 */
export function extractBriefSummaries(
  eSummaryResult?: ESummaryResult,
  context?: RequestContext,
): Promise<ParsedBriefSummary[]> {
  return Promise.try(readBriefSummaries, eSummaryResult, context);
}
