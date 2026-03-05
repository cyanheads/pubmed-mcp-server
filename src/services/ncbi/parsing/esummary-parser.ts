/**
 * @fileoverview Helper functions for parsing ESummary results from NCBI.
 * Handles different ESummary XML structures and formats the data into
 * consistent ParsedBriefSummary objects.
 * @module src/services/ncbi/parsing/esummary-parser
 */

import { logger } from '@/utils/internal/logger.js';
import type { RequestContext } from '@/utils/internal/requestContext.js';
import { requestContextService } from '@/utils/internal/requestContext.js';
import { dateParser } from '@/utils/parsing/dateParser.js';
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
import { ensureArray, getAttribute, getText } from './xml-helpers.js';

/**
 * Formats an array of ESummary authors into a string.
 * Limits to the first 3 authors and adds 'et al.' if more exist.
 * @param authors - Array of ESummary author objects (normalized).
 * @returns A string like 'Doe J, Smith A, Brown B, et al.' or empty if no authors.
 */
export function formatESummaryAuthors(authors?: XmlESummaryAuthor[]): string {
  if (!authors || authors.length === 0) return '';
  return (
    authors
      .slice(0, 3)
      .map((author) => author.name) // Assumes author.name is the string representation
      .join(', ') + (authors.length > 3 ? ', et al.' : '')
  );
}

/**
 * Standardizes date strings from ESummary to 'YYYY-MM-DD' format.
 * Uses the dateParser utility.
 * @param dateStr - Date string from ESummary (e.g., '2023/01/15', '2023 Jan 15', '2023').
 * @param parentContext - Optional parent request context for logging.
 * @returns A promise resolving to a standardized date string ('YYYY-MM-DD') or undefined if parsing fails.
 */
export async function standardizeESummaryDate(
  dateStr?: string,
  parentContext?: RequestContext,
): Promise<string | undefined> {
  if (dateStr === undefined || dateStr === null) return; // Check for null as well

  const dateInputString = String(dateStr); // Ensure it's a string

  const currentContext =
    parentContext ||
    requestContextService.createRequestContext({
      operation: 'standardizeESummaryDateInternal',
      inputDate: dateInputString, // Log the stringified version
    });
  try {
    // Pass the stringified version to the date parser
    const parsedDate = await dateParser.parseDate(dateInputString, currentContext);
    if (parsedDate) {
      return parsedDate.toISOString().split('T')[0]; // Format as YYYY-MM-DD
    }
    logger.debug(
      `standardizeESummaryDate: dateParser could not parse "${dateInputString}", returning undefined.`,
      currentContext,
    );
  } catch (e) {
    logger.warning(
      `standardizeESummaryDate: Error during dateParser.parseDate for "${dateInputString}", returning undefined.`,
      {
        ...currentContext,
        error: e instanceof Error ? e.message : String(e),
      },
    );
  }
  return; // Return undefined if parsing fails
}

/**
 * Parses authors from an ESummary DocumentSummary structure.
 * Handles various ways authors might be represented.
 * Returns an array of normalized XmlESummaryAuthor objects.
 * Internal helper function.
 */
function parseESummaryAuthorsFromDocumentSummary(
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
      const authorObj = rawAuthInput as XmlESummaryAuthorRaw; // Now typed
      // Try extracting text from the object itself (e.g., if it's { '#text': 'Author Name' })
      name = getText(authorObj, '');

      // If name is still empty, try common property names for author names
      if (!name) {
        name = getText(authorObj.Name || authorObj.name, '');
      }

      authtype = getText(authorObj.AuthType || authorObj.authtype, undefined);
      clusterid = getText(authorObj.ClusterId || authorObj.clusterid, undefined);

      // Fallback for unhandled structures: log and try to stringify
      if (!name) {
        const authInputString = JSON.stringify(authorObj);
        logger.warning(
          `Unhandled author structure in parseESummaryAuthorsFromDocumentSummary. authInput: ${authInputString.substring(0, 100)}`,
          requestContextService.createRequestContext({
            operation: 'parseESummaryAuthorsFromDocumentSummary',
            detail: 'Unhandled author structure',
          }),
        );
        // As a last resort, if it's a simple object with a single value, that might be the name
        const keys = Object.keys(authorObj);
        if (
          keys.length === 1 &&
          keys[0] &&
          typeof (authorObj as Record<string, unknown>)[keys[0]] === 'string'
        ) {
          name = (authorObj as Record<string, unknown>)[keys[0]] as string;
        } else if (authInputString.length < 100) {
          // Avoid overly long stringified objects
          name = authInputString; // Not ideal, but better than empty for debugging
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
    // authorsProp could be Array<string> or Array<XmlESummaryAuthorRaw>
    for (const item of authorsProp as (XmlESummaryAuthorRaw | string)[]) {
      processRawAuthor(item);
    }
  } else if (
    typeof authorsProp === 'object' &&
    'Author' in authorsProp && // authorsProp is { Author: ... }
    authorsProp.Author
  ) {
    const rawAuthors = ensureArray(
      authorsProp.Author as XmlESummaryAuthorRaw | XmlESummaryAuthorRaw[] | string,
    );
    for (const item of rawAuthors) {
      processRawAuthor(item);
    }
  } else if (typeof authorsProp === 'string') {
    try {
      // Attempt to parse if it looks like a JSON array string
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
          input: authorsProp.substring(0, 100),
          error: e instanceof Error ? e.message : String(e),
        }),
      );
    }
    // Fallback: split string by common delimiters
    for (const namePart of authorsProp.split(/[,;]/)) {
      const trimmed = namePart.trim();
      if (trimmed) parsedAuthors.push({ name: trimmed });
    }
  }
  return parsedAuthors.filter((author) => author.name);
}

/**
 * Parses a single ESummary DocumentSummary (newer XML format) into a raw summary object.
 * Internal helper function.
 */
function parseSingleDocumentSummary(docSummary: ESummaryDocumentSummary): Omit<
  ParsedBriefSummary,
  'pubDate' | 'epubDate'
> & {
  rawPubDate?: string;
  rawEPubDate?: string;
} {
  const pmid = docSummary['@_uid'];
  const authorsArray = parseESummaryAuthorsFromDocumentSummary(docSummary);

  // Parse ArticleIds once for DOI and PMC ID extraction
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

  let doiValue: string | undefined = getText(docSummary.DOI, undefined);
  if (!doiValue) {
    const doiEntry = idsArray.find((id) => (id as ESummaryArticleId).idtype === 'doi');
    if (doiEntry) {
      doiValue = getText((doiEntry as ESummaryArticleId).value, undefined);
    }
  }

  const pmcEntry = idsArray.find((id) => (id as ESummaryArticleId).idtype === 'pmc');
  const pmcIdValue = pmcEntry
    ? getText((pmcEntry as ESummaryArticleId).value, undefined)
    : undefined;

  const title = getText(docSummary.Title);
  const source =
    getText(docSummary.Source) || getText(docSummary.FullJournalName) || getText(docSummary.SO);
  const rawPubDate = getText(docSummary.PubDate);
  const rawEPubDate = getText(docSummary.EPubDate);

  return {
    pmid: String(pmid),
    ...(title && { title }),
    authors: formatESummaryAuthors(authorsArray),
    ...(source && { source }),
    ...(doiValue && { doi: doiValue }),
    ...(pmcIdValue && { pmcId: pmcIdValue }),
    ...(rawPubDate && { rawPubDate }),
    ...(rawEPubDate && { rawEPubDate }),
  };
}

/**
 * Parses a single ESummary DocSum (older XML item-based format) into a raw summary object.
 * Internal helper function.
 */
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
    // Fallback for authors directly under DocSum items
    return items
      .filter((i) => i['@_Name'] === 'Author' && i['@_Type'] === 'String')
      .map((a) => ({ name: getText(a, '') }));
  };

  const authorsArray = getAuthorList();

  // Parse ArticleIds list once for DOI and PMC ID extraction
  const articleIdsItem = items.find((i) => i['@_Name'] === 'ArticleIds' && i['@_Type'] === 'List');
  const articleIdsList = articleIdsItem?.Item ? ensureArray(articleIdsItem.Item) : [];

  let doiFromItems: string | undefined = getItemValue('DOI', 'String');
  if (!doiFromItems) {
    const doiIdItem = articleIdsList.find(
      (id) =>
        getAttribute(id as ESummaryItem, 'idtype') === 'doi' ||
        (id as ESummaryItem)['@_Name'] === 'doi',
    );
    if (doiIdItem) {
      doiFromItems = getText(doiIdItem);
    }
  }

  let pmcIdFromItems: string | undefined;
  const pmcIdItem = articleIdsList.find(
    (id) =>
      getAttribute(id as ESummaryItem, 'idtype') === 'pmc' ||
      (id as ESummaryItem)['@_Name'] === 'pmc',
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
 * Asynchronously standardizes dates.
 * @param eSummaryResult - The parsed XML object from ESummary (eSummaryResult part).
 * @param context - Request context for logging and passing to date standardization.
 * @returns A promise resolving to an array of parsed brief summary objects.
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
    logger.warning('ESummary result contains an error', {
      ...opContext,
      errorDetails: eSummaryResult.ERROR,
    });
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
        ...(rawSummary.source !== undefined && { source: rawSummary.source }),
        ...(rawSummary.doi !== undefined && { doi: rawSummary.doi }),
        ...(rawSummary.pmcId !== undefined && { pmcId: rawSummary.pmcId }),
        ...(pubDate !== undefined && { pubDate }),
        ...(epubDate !== undefined && { epubDate }),
      } satisfies ParsedBriefSummary;
    }),
  );

  return processedSummaries;
}
