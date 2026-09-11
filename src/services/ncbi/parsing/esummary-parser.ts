/**
 * @fileoverview Helper functions for parsing ESummary results from NCBI.
 * Handles different ESummary XML structures and formats the data into
 * consistent ParsedBriefSummary objects.
 * @module src/services/ncbi/parsing/esummary-parser
 */

import type { RequestContext } from '@cyanheads/mcp-ts-core/utils';
import { dateParser, logger, requestContextService, withExtra } from '@cyanheads/mcp-ts-core/utils';
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

/**
 * Matches NCBI ESummary date formats:
 * - "2024"               → year only
 * - "2024 Jan"           → year + month
 * - "2024 Jan 15"        → year + month + day
 * - "2018 Jul-Aug"       → year + month range (dash)
 * - "2018 Jan/Feb"       → year + month range (slash)
 *
 * Groups: 1=year, 2=firstMonth?, 3=day? (second month in range is non-capturing)
 */
const NCBI_DATE_RE = /^(\d{4})(?:\s+([A-Za-z]{3})(?:[/-][A-Za-z]{3})?(?:\s+(\d{1,2}))?)?$/;

/**
 * Parses NCBI ESummary date strings into YYYY-MM-DD (or YYYY-MM-01 / YYYY-01-01
 * for partial dates). Returns undefined for unrecognized formats.
 *
 * NCBI's ESummary API returns a small set of predictable date formats. chrono-node
 * (used by the framework's dateParser) mishandles most of them — its `forwardDate`
 * option causes "2023 Dec" to resolve to a future December, ignoring the year.
 */
export function parseNcbiDate(dateStr: string): string | undefined {
  const m = NCBI_DATE_RE.exec(dateStr.trim());
  if (!m) return;

  const [, year, monthAbbrev, day] = m;
  if (!year) return;

  const month = monthAbbrev ? MONTH_ABBREV[monthAbbrev] : undefined;
  if (monthAbbrev && !month) return; // unrecognized month abbreviation

  if (month && day) return `${year}-${month}-${day.padStart(2, '0')}`;
  if (month) return `${year}-${month}-01`;
  return `${year}-01-01`;
}

/**
 * Standardizes date strings from ESummary to 'YYYY-MM-DD' format.
 * Uses a dedicated NCBI date parser for known formats, falling back to
 * chrono-node via the framework's dateParser for anything unexpected.
 */
export async function standardizeESummaryDate(
  dateStr?: string,
  parentContext?: RequestContext,
): Promise<string | undefined> {
  if (dateStr == null) return;

  const dateInputString = String(dateStr).trim();
  if (!dateInputString) return;

  const ncbiResult = parseNcbiDate(dateInputString);
  if (ncbiResult) return ncbiResult;

  const currentContext =
    parentContext ||
    requestContextService.createRequestContext({
      operation: 'standardizeESummaryDateInternal',
      additionalContext: { inputDate: dateInputString },
    });
  try {
    const parsedDate = await dateParser.parseDate(dateInputString, currentContext);
    if (parsedDate) {
      return parsedDate.toISOString().split('T')[0];
    }
    logger.debug(
      `standardizeESummaryDate: could not parse "${dateInputString}", returning undefined.`,
      currentContext,
    );
  } catch (e) {
    logger.warning(
      `standardizeESummaryDate: dateParser.parseDate error for "${dateInputString}", returning undefined.`,
      withExtra(currentContext, { error: e instanceof Error ? e.message : String(e) }),
    );
  }
  return;
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

function parseSingleDocumentSummary(docSummary: ESummaryDocumentSummary): Omit<
  ParsedBriefSummary,
  'pubDate' | 'epubDate'
> & {
  rawPubDate?: string;
  rawEPubDate?: string;
} {
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

  const title = getText(docSummary.Title);
  const source =
    getText(docSummary.Source) || getText(docSummary.FullJournalName) || getText(docSummary.SO);
  const rawPubDate = getText(docSummary.PubDate);
  const rawEPubDate = getText(docSummary.EPubDate);
  // A Bookshelf record leaves Source and FullJournalName empty and carries its
  // venue here instead, so without these a book summary renders with none. (#114)
  const bookTitle = getText(docSummary.BookTitle);
  const publisherName = getText(docSummary.PublisherName);
  const docType = getText(docSummary.DocType);

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
    ...(rawPubDate && { rawPubDate }),
    ...(rawEPubDate && { rawEPubDate }),
  };
}

function parseSingleDocSumOldXml(docSum: ESummaryDocSumOldXml): Omit<
  ParsedBriefSummary,
  'pubDate' | 'epubDate'
> & {
  rawPubDate?: string;
  rawEPubDate?: string;
} {
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

  const title = getItemValue('Title', 'String');
  const source = getItemValue(['Source', 'FullJournalName', 'SO'], 'String');
  const rawPubDate = getItemValue(['PubDate', 'ArticleDate'], 'Date');
  const rawEPubDate = getItemValue('EPubDate', 'Date');

  return {
    pmid: String(pmid),
    ...(title !== undefined && { title }),
    authors: formatESummaryAuthors(authorsArray),
    authorNames: authorsArray.map((a) => a.name),
    ...(source !== undefined && { source }),
    ...(doiFromItems !== undefined && { doi: doiFromItems }),
    ...(pmcIdFromItems !== undefined && { pmcId: pmcIdFromItems }),
    ...(rawPubDate !== undefined && { rawPubDate }),
    ...(rawEPubDate !== undefined && { rawEPubDate }),
  };
}

/**
 * Extracts and formats brief summaries from ESummary XML result.
 * Handles both DocumentSummarySet (newer) and older DocSum structures.
 */
export async function extractBriefSummaries(
  eSummaryResult?: ESummaryResult,
  context?: RequestContext,
): Promise<ParsedBriefSummary[]> {
  if (!eSummaryResult) return [];
  const opContext =
    context ||
    requestContextService.createRequestContext({
      operation: 'extractBriefSummariesInternal',
    });

  if (eSummaryResult.ERROR) {
    logger.warning(
      'ESummary result contains an error',
      withExtra(opContext, { errorDetails: eSummaryResult.ERROR }),
    );
    return [];
  }

  let rawSummaries: (Omit<ParsedBriefSummary, 'pubDate' | 'epubDate'> & {
    rawPubDate?: string;
    rawEPubDate?: string;
  })[] = [];

  if (eSummaryResult.DocumentSummarySet?.DocumentSummary) {
    const docSummaries = ensureArray(eSummaryResult.DocumentSummarySet.DocumentSummary);
    rawSummaries = docSummaries.map(parseSingleDocumentSummary).filter((s) => s.pmid);
  } else if (eSummaryResult.DocSum) {
    const docSums = ensureArray(eSummaryResult.DocSum);
    rawSummaries = docSums.map(parseSingleDocSumOldXml).filter((s) => s.pmid);
  }

  const processedSummaries = await Promise.all(
    rawSummaries.map(async (rawSummary) => {
      const [pubDate, epubDate] = await Promise.all([
        standardizeESummaryDate(rawSummary.rawPubDate, opContext),
        standardizeESummaryDate(rawSummary.rawEPubDate, opContext),
      ]);
      return {
        pmid: rawSummary.pmid,
        ...(rawSummary.title !== undefined && { title: rawSummary.title }),
        ...(rawSummary.authors !== undefined && { authors: rawSummary.authors }),
        ...(rawSummary.authorNames !== undefined && { authorNames: rawSummary.authorNames }),
        ...(rawSummary.editors !== undefined && { editors: rawSummary.editors }),
        ...(rawSummary.source !== undefined && { source: rawSummary.source }),
        ...(rawSummary.bookTitle !== undefined && { bookTitle: rawSummary.bookTitle }),
        ...(rawSummary.publisherName !== undefined && {
          publisherName: rawSummary.publisherName,
        }),
        ...(rawSummary.docType !== undefined && { docType: rawSummary.docType }),
        ...(rawSummary.doi !== undefined && { doi: rawSummary.doi }),
        ...(rawSummary.pmcId !== undefined && { pmcId: rawSummary.pmcId }),
        ...(pubDate !== undefined && { pubDate }),
        ...(epubDate !== undefined && { epubDate }),
      } satisfies ParsedBriefSummary;
    }),
  );

  return processedSummaries;
}
