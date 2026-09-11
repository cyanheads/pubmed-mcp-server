/**
 * @fileoverview Helper functions for parsing detailed PubMed Article XML structures,
 * typically from EFetch results.
 * @module src/services/ncbi/parsing/article-parser
 */

import type {
  ParsedArticle,
  ParsedArticleAuthor,
  ParsedArticleDate,
  ParsedBookEditor,
  ParsedBookInfo,
  ParsedGrant,
  ParsedJournalInfo,
  ParsedMeshQualifier,
  ParsedMeshTerm,
  ParseFullArticleOptions,
  XmlAbstractText,
  XmlArticle,
  XmlArticleDate,
  XmlArticleIdList,
  XmlAuthor,
  XmlAuthorList,
  XmlBookDocument,
  XmlGrant,
  XmlGrantList,
  XmlIdentifier,
  XmlJournal,
  XmlKeyword,
  XmlKeywordList,
  XmlMedlineCitation,
  XmlMeshHeading,
  XmlMeshHeadingList,
  XmlPubDate,
  XmlPublicationType,
  XmlPublicationTypeList,
  XmlPubmedArticle,
  XmlPubmedArticleSet,
  XmlPubmedBookArticle,
} from '../types.js';
import { decodeHtmlEntities } from './text-helpers.js';
import { ensureArray, getAttribute, getText } from './xml-helpers.js';

/**
 * Result of extracting authors with deduplicated affiliations.
 */
export interface ExtractedAuthors {
  affiliations: string[];
  authors: ParsedArticleAuthor[];
}

/**
 * Extracts and formats author information from XML, deduplicating affiliations.
 * Affiliations are collected into a single array; each author references them by index.
 * This avoids repeating identical institutional strings per-author (common in multi-center papers).
 * @param authorListXml - The XML AuthorList element.
 * @returns Authors and a deduplicated affiliations list.
 */
export function extractAuthors(authorListXml?: XmlAuthorList): ExtractedAuthors {
  if (!authorListXml) return { authors: [], affiliations: [] };

  const affiliationMap = new Map<string, number>();
  const affiliationList: string[] = [];

  function getAffiliationIndex(text: string): number {
    const existing = affiliationMap.get(text);
    if (existing !== undefined) return existing;
    const idx = affiliationList.length;
    affiliationList.push(text);
    affiliationMap.set(text, idx);
    return idx;
  }

  const xmlAuthors = ensureArray(authorListXml.Author);
  const authors = xmlAuthors.map((auth: XmlAuthor): ParsedArticleAuthor => {
    const collectiveName = getText(auth.CollectiveName);
    if (collectiveName) {
      return { collectiveName };
    }

    // Collect all affiliations for this author, deduplicated at article level
    const authorAffiliationInfos = ensureArray(auth.AffiliationInfo);
    const indices: number[] = [];
    for (const info of authorAffiliationInfos) {
      const text = getText(info?.Affiliation);
      if (text) indices.push(getAffiliationIndex(text));
    }

    // Extract ORCID from Identifier elements with Source="ORCID"
    let orcid: string | undefined;
    const identifiers = ensureArray(auth.Identifier) as XmlIdentifier[];
    for (const id of identifiers) {
      if (getAttribute(id, 'Source') === 'ORCID') {
        const val = getText(id);
        if (val) {
          orcid = val;
          break;
        }
      }
    }

    return {
      lastName: getText(auth.LastName),
      firstName: getText(auth.ForeName), // XML uses ForeName
      initials: getText(auth.Initials),
      ...(indices.length > 0 && { affiliationIndices: indices }),
      ...(orcid && { orcid }),
    };
  });

  return { authors, affiliations: affiliationList };
}

/**
 * Picks the electronic article locator from an Article's `ELocationID` list —
 * the publisher-assigned article number carried by journals that do not
 * paginate (`<ELocationID EIdType="pii" ValidYN="Y">2400512</ELocationID>`).
 *
 * DOI-typed entries are skipped: the DOI has its own field and its own
 * selection rules in {@link extractDoi}, and a DOI is not pagination. A locator
 * explicitly marked `ValidYN="N"` is never surfaced, and a valid one wins over
 * an entry with no `ValidYN` attribute at all.
 * @param articleXml - The XML Article element.
 * @returns The locator value and its `EIdType`, or undefined when none applies.
 */
function extractELocationId(articleXml?: XmlArticle): { value: string; type?: string } | undefined {
  const candidates = ensureArray(articleXml?.ELocationID).filter(
    (eloc) =>
      getAttribute(eloc, 'EIdType') !== 'doi' &&
      getAttribute(eloc, 'ValidYN') !== 'N' &&
      getText(eloc, undefined),
  );
  const locator = candidates.find((eloc) => getAttribute(eloc, 'ValidYN') === 'Y') ?? candidates[0];
  if (!locator) return;
  const type = getAttribute(locator, 'EIdType', undefined);
  return { value: getText(locator), ...(type && { type }) };
}

/**
 * Extracts and formats journal information from XML.
 * @param journalXml - The XML Journal element from an Article.
 * @param articleXml - The XML Article element (for Pagination and ELocationID).
 * @returns Formatted journal information.
 */
export function extractJournalInfo(
  journalXml?: XmlJournal,
  articleXml?: XmlArticle,
): ParsedJournalInfo | undefined {
  if (!journalXml) return;

  const pubDate = journalXml.JournalIssue?.PubDate;
  const year = getText(pubDate?.Year, getText(pubDate?.MedlineDate, '').match(/\d{4}/)?.[0]);

  // Extract ISSN, separating print and electronic
  const issnElement = journalXml.ISSN;
  const issnValue = getText(issnElement);
  const issnType = getAttribute(issnElement, 'IssnType');
  const issn = issnType === 'Electronic' ? undefined : issnValue || undefined;
  const eIssn = issnType === 'Electronic' ? issnValue || undefined : undefined;

  const month = getText(pubDate?.Month);
  const day = getText(pubDate?.Day);
  const medlineDate = getText(pubDate?.MedlineDate);
  const locator = extractELocationId(articleXml);

  return {
    title: getText(journalXml.Title),
    isoAbbreviation: getText(journalXml.ISOAbbreviation),
    ...(issn && { issn }),
    ...(eIssn && { eIssn }),
    volume: getText(journalXml.JournalIssue?.Volume),
    issue: getText(journalXml.JournalIssue?.Issue),
    pages: getText(articleXml?.Pagination?.MedlinePgn),
    ...(locator && { elocationId: locator.value }),
    ...(locator?.type && { elocationIdType: locator.type }),
    publicationDate: {
      ...(year && { year }),
      ...(month && { month }),
      ...(day && { day }),
      ...(medlineDate && { medlineDate }),
    },
  };
}

/**
 * Extracts and formats MeSH terms from XML.
 * @param meshHeadingListXml - The XML MeshHeadingList element.
 * @returns An array of formatted MeSH term objects.
 */
export function extractMeshTerms(meshHeadingListXml?: XmlMeshHeadingList): ParsedMeshTerm[] {
  if (!meshHeadingListXml) return [];
  const meshHeadings = ensureArray(meshHeadingListXml.MeshHeading);
  return meshHeadings.map((mh: XmlMeshHeading) => {
    const isMajorDescriptor = getAttribute(mh.DescriptorName, 'MajorTopicYN') === 'Y';
    const isMajorRoot = getAttribute(mh, 'MajorTopicYN') === 'Y';
    const descriptorUi = getAttribute(mh.DescriptorName, 'UI');

    // Parse all qualifiers, not just the first
    const rawQualifiers = ensureArray(mh.QualifierName);
    const qualifiers: ParsedMeshQualifier[] = rawQualifiers.flatMap((q) => {
      const name = getText(q);
      if (!name) return [];
      const ui = getAttribute(q, 'UI');
      return {
        qualifierName: name,
        ...(ui && { qualifierUi: ui }),
        isMajorTopic: getAttribute(q, 'MajorTopicYN') === 'Y',
      } satisfies ParsedMeshQualifier;
    });

    const isMajorAnyQualifier = qualifiers.some((q) => q.isMajorTopic);

    return {
      descriptorName: getText(mh.DescriptorName),
      ...(descriptorUi && { descriptorUi }),
      ...(qualifiers.length > 0 && { qualifiers }),
      isMajorTopic: isMajorRoot || isMajorDescriptor || isMajorAnyQualifier,
    };
  });
}

/**
 * Extracts and formats grant information from XML.
 * @param grantListXml - The XML GrantList element.
 * @returns An array of formatted grant objects.
 */
export function extractGrants(grantListXml?: XmlGrantList): ParsedGrant[] {
  if (!grantListXml) return [];
  const grants = ensureArray(grantListXml.Grant);
  return grants.map((g: XmlGrant): ParsedGrant => {
    // NCBI double-encodes ampersands in grant identifiers and agencies
    // (`CSR&amp;amp;D`), so the XML parser's single entity-decode pass still
    // leaves a literal `&amp;`. Decode once more here to surface display-ready
    // text (`CSR&D`) rather than making every caller re-sanitize. (#74)
    const grantId = decodeHtmlEntities(getText(g.GrantID));
    const acronym = decodeHtmlEntities(getText(g.Acronym));
    const agency = decodeHtmlEntities(getText(g.Agency));
    const country = decodeHtmlEntities(getText(g.Country));
    return {
      ...(grantId && { grantId }),
      ...(acronym && { acronym }),
      ...(agency && { agency }),
      ...(country && { country }),
    };
  });
}

/**
 * Extracts DOI from various possible locations in the XML.
 * Prioritizes ELocationID with ValidYN='Y', then any ELocationID, then ArticleIdList,
 * then PubmedData.ArticleIdList.
 * @param articleXml - The XML Article element.
 * @param pubmedDataArticleIdList - Optional ArticleIdList from PubmedData (sibling of MedlineCitation).
 * @returns The DOI string or undefined.
 */
export function extractDoi(
  articleXml?: XmlArticle,
  pubmedDataArticleIdList?: XmlArticleIdList,
): string | undefined {
  if (!articleXml) return;

  // Check ELocationID first
  const eLocationIDs = ensureArray(articleXml.ELocationID);
  // Prioritize valid DOI
  for (const eloc of eLocationIDs) {
    if (getAttribute(eloc, 'EIdType') === 'doi' && getAttribute(eloc, 'ValidYN') === 'Y') {
      const doi = getText(eloc);
      if (doi) return doi;
    }
  }
  // Fallback to any DOI in ELocationID
  for (const eloc of eLocationIDs) {
    if (getAttribute(eloc, 'EIdType') === 'doi') {
      const doi = getText(eloc);
      if (doi) return doi;
    }
  }

  // Check Article.ArticleIdList
  const articleIds = ensureArray(articleXml.ArticleIdList?.ArticleId);
  for (const aid of articleIds) {
    if (getAttribute(aid, 'IdType') === 'doi') {
      const doi = getText(aid);
      if (doi) return doi;
    }
  }

  // Fallback to PubmedData.ArticleIdList (common canonical DOI location)
  if (pubmedDataArticleIdList) {
    const pubmedDataIds = ensureArray(pubmedDataArticleIdList.ArticleId);
    for (const aid of pubmedDataIds) {
      if (getAttribute(aid, 'IdType') === 'doi') {
        const doi = getText(aid);
        if (doi) return doi;
      }
    }
  }

  return;
}

/**
 * Extracts PMC ID from ArticleIdList locations in the XML.
 * Searches Article.ArticleIdList and PubmedData.ArticleIdList for IdType='pmc'.
 * @param articleXml - The XML Article element.
 * @param pubmedDataArticleIdList - Optional ArticleIdList from PubmedData.
 * @returns The PMC ID string (e.g. 'PMC1234567') or undefined.
 */
export function extractPmcId(
  articleXml?: XmlArticle,
  pubmedDataArticleIdList?: XmlArticleIdList,
): string | undefined {
  // Check Article.ArticleIdList
  const articleIds = ensureArray(articleXml?.ArticleIdList?.ArticleId);
  for (const aid of articleIds) {
    if (getAttribute(aid, 'IdType') === 'pmc') {
      const val = getText(aid);
      if (val) return val;
    }
  }

  // Fallback to PubmedData.ArticleIdList
  if (pubmedDataArticleIdList) {
    const pubmedDataIds = ensureArray(pubmedDataArticleIdList.ArticleId);
    for (const aid of pubmedDataIds) {
      if (getAttribute(aid, 'IdType') === 'pmc') {
        const val = getText(aid);
        if (val) return val;
      }
    }
  }

  return;
}

/**
 * Extracts publication types from XML.
 * @param publicationTypeListXml - The XML PublicationTypeList element.
 * @returns An array of publication type strings.
 */
export function extractPublicationTypes(publicationTypeListXml?: XmlPublicationTypeList): string[] {
  if (!publicationTypeListXml) return [];
  const pubTypes = ensureArray(publicationTypeListXml.PublicationType);
  return pubTypes.map((pt: XmlPublicationType) => getText(pt)).filter(Boolean);
}

/**
 * Extracts keywords from XML. Handles single or multiple KeywordList elements.
 * @param keywordListsXml - The XML KeywordList element or an array of them.
 * @returns An array of keyword strings.
 */
export function extractKeywords(keywordListsXml?: XmlKeywordList[] | XmlKeywordList): string[] {
  if (!keywordListsXml) return [];
  const lists = ensureArray(keywordListsXml);
  const allKeywords: string[] = [];
  for (const list of lists) {
    for (const kw of ensureArray(list.Keyword) as XmlKeyword[]) {
      const keywordText = getText(kw);
      if (keywordText) {
        allKeywords.push(keywordText);
      }
    }
  }
  return allKeywords;
}

/**
 * Extracts abstract text from XML. Handles structured abstracts by concatenating sections.
 * If AbstractText is an array, joins them. If it's a single object/string, uses it directly.
 * Prefixes with Label if present.
 * @param abstractXml - The XML Abstract element from an Article.
 * @returns The abstract text string, or undefined if not found or empty.
 */
export function extractAbstractText(abstractXml?: XmlArticle['Abstract']): string | undefined {
  if (!abstractXml?.AbstractText) return;

  const abstractTexts = ensureArray(abstractXml.AbstractText);
  if (abstractTexts.length === 0) return;

  const processedTexts = abstractTexts
    .map((at: XmlAbstractText | string) => {
      // AbstractText can be string directly or object
      if (typeof at === 'string') {
        return at;
      }
      // If it's an object, it should have #text or Label
      const sectionText = getText(at); // Handles at['#text']
      const label = getAttribute(at, 'Label');
      if (label && sectionText) {
        return `${label.trim()}: ${sectionText.trim()}`;
      }
      return sectionText.trim();
    })
    .filter(Boolean); // Remove any empty strings resulting from empty sections

  if (processedTexts.length === 0) return;

  return processedTexts.join('\n\n').trim() || undefined; // Join sections with double newline
}

/**
 * Extracts PMID from MedlineCitation.
 * @param medlineCitationXml - The XML MedlineCitation element.
 * @returns The PMID string or undefined.
 */
export function extractPmid(medlineCitationXml?: XmlMedlineCitation): string | undefined {
  if (!medlineCitationXml?.PMID) return;
  return getText(medlineCitationXml.PMID);
}

/**
 * Extracts article dates from XML.
 * @param articleXml - The XML Article element.
 * @returns An array of parsed article dates.
 */
export function extractArticleDates(articleXml?: XmlArticle): ParsedArticleDate[] {
  if (!articleXml?.ArticleDate) return [];
  const articleDatesXml = ensureArray(articleXml.ArticleDate);
  return articleDatesXml.map((ad: XmlArticleDate) => ({
    dateType: getAttribute(ad, 'DateType'),
    year: getText(ad.Year),
    month: getText(ad.Month),
    day: getText(ad.Day),
  }));
}

/**
 * Parses a full PubMed article XML structure into a ParsedArticle object,
 * combining all individual extractors.
 * @param xmlArticle - The raw XML PubmedArticle element.
 * @param options - Options controlling which optional sections to include.
 * @returns A fully parsed article object.
 */
export function parseFullArticle(
  xmlArticle: XmlPubmedArticle,
  options: ParseFullArticleOptions = {},
): ParsedArticle {
  const medlineCitation = xmlArticle.MedlineCitation;
  const article = medlineCitation?.Article;
  const { includeMesh = true, includeGrants = false } = options;

  const abstractText = extractAbstractText(article?.Abstract);
  const journalInfo = extractJournalInfo(article?.Journal, article);
  const pubmedDataArticleIdList = xmlArticle.PubmedData?.ArticleIdList;
  const doi = extractDoi(article, pubmedDataArticleIdList);
  const pmcId = extractPmcId(article, pubmedDataArticleIdList);
  const { authors, affiliations } = extractAuthors(article?.AuthorList);

  const publicationTypes = extractPublicationTypes(article?.PublicationTypeList);
  const keywords = extractKeywords(medlineCitation?.KeywordList ?? article?.KeywordList);
  const articleDates = extractArticleDates(article);
  const meshTerms = includeMesh ? extractMeshTerms(medlineCitation?.MeshHeadingList) : undefined;
  const grantList = includeGrants ? extractGrants(article?.GrantList) : undefined;

  return {
    recordType: 'journal-article',
    pmid: extractPmid(medlineCitation) ?? '',
    title: getText(article?.ArticleTitle),
    ...(abstractText !== undefined && { abstractText }),
    ...(affiliations.length > 0 && { affiliations }),
    authors,
    ...(journalInfo !== undefined && { journalInfo }),
    ...(publicationTypes.length > 0 && { publicationTypes }),
    ...(keywords.length > 0 && { keywords }),
    ...(meshTerms !== undefined && meshTerms.length > 0 && { meshTerms }),
    ...(grantList !== undefined && grantList.length > 0 && { grantList }),
    ...(doi !== undefined && { doi }),
    ...(pmcId !== undefined && { pmcId }),
    ...(articleDates.length > 0 && { articleDates }),
  };
}

// ─── Bookshelf records (PubmedBookArticle) ──────────────────────────────────

/**
 * Text of an XML element, with an absent or empty element reported as absent.
 * `getText(x, undefined)` cannot do this: `undefined` triggers the parameter's
 * own `''` default, so it returns the empty string for a missing element.
 */
function optionalText(element: unknown): string | undefined {
  return getText(element) || undefined;
}

/** Year text from a `PubDate`-shaped element, falling back to a `MedlineDate` span. */
function extractYear(dateXml?: XmlPubDate): string | undefined {
  if (!dateXml) return;
  return optionalText(dateXml.Year) ?? getText(dateXml.MedlineDate).match(/\d{4}/)?.[0];
}

/** First `ArticleId` of the given `IdType`, or undefined. */
function findArticleId(
  idListXml: XmlArticleIdList | undefined,
  idType: string,
): string | undefined {
  for (const articleId of ensureArray(idListXml?.ArticleId)) {
    if (getAttribute(articleId, 'IdType') === idType) {
      const value = optionalText(articleId);
      if (value) return value;
    }
  }
  return;
}

/**
 * Flatten repeatable `AuthorList` elements into the single list
 * {@link extractAuthors} expects, so affiliation indices stay consistent across
 * them instead of each list restarting its own numbering.
 */
function mergeAuthorLists(lists: XmlAuthorList[]): XmlAuthorList | undefined {
  const authors = lists.flatMap((list) => ensureArray(list.Author));
  return authors.length > 0 ? { Author: authors } : undefined;
}

/**
 * Extract the containing book from a `BookDocument`.
 *
 * `Book/AuthorList` is split on its `Type` attribute: `editors` is the only
 * value that makes a list editors, so an untyped list is read as authors —
 * mislabelling real authors as editors would put them in the wrong slot of every
 * citation style.
 * @param bookDocumentXml - The XML BookDocument element.
 * @returns The parsed book, with absent elements omitted rather than emptied.
 */
export function extractBookInfo(bookDocumentXml: XmlBookDocument): ParsedBookInfo {
  const book = bookDocumentXml.Book;
  const editorLists = ensureArray(book?.AuthorList).filter(
    (list) => getAttribute(list, 'Type') === 'editors',
  );
  const editors: ParsedBookEditor[] = extractAuthors(mergeAuthorLists(editorLists)).authors.map(
    ({ lastName, firstName, initials, collectiveName }) => ({
      ...(lastName && { lastName }),
      ...(firstName && { firstName }),
      ...(initials && { initials }),
      ...(collectiveName && { collectiveName }),
    }),
  );

  const isbns = ensureArray(book?.Isbn)
    .map(optionalText)
    .filter((isbn): isbn is string => isbn !== undefined);
  const bookDoi = ensureArray(book?.ELocationID)
    .filter((eloc) => getAttribute(eloc, 'EIdType') === 'doi')
    .map(optionalText)
    .find(Boolean);

  const title = optionalText(book?.BookTitle);
  const publisher = optionalText(book?.Publisher?.PublisherName);
  const publisherLocation = optionalText(book?.Publisher?.PublisherLocation);
  const pubDate = extractYear(book?.PubDate);
  const beginningDate = extractYear(book?.BeginningDate);
  const endingDate = extractYear(book?.EndingDate);
  const medium = optionalText(book?.Medium);
  const edition = optionalText(book?.Edition);
  const collectionTitle = optionalText(book?.CollectionTitle);
  const accession = findArticleId(bookDocumentXml.ArticleIdList, 'bookaccession');

  return {
    ...(title && { title }),
    ...(publisher && { publisher }),
    ...(publisherLocation && { publisherLocation }),
    ...(pubDate && { pubDate }),
    ...(beginningDate && { beginningDate }),
    ...(endingDate && { endingDate }),
    ...(medium && { medium }),
    ...(edition && { edition }),
    ...(collectionTitle && { collectionTitle }),
    ...(isbns.length > 0 && { isbns }),
    ...(bookDoi && { doi: bookDoi }),
    ...(editors.length > 0 && { editors }),
    ...(accession && { accession }),
  };
}

/**
 * Parse a `PubmedBookArticle` — an NCBI Bookshelf record — into the same
 * {@link ParsedArticle} shape a journal article produces.
 *
 * `ArticleTitle` is the discriminator: a record carrying one is a chapter, and
 * one without it is the whole book, whose `title` then comes from `BookTitle`.
 * `journalInfo` is never populated — a Bookshelf record has no journal, and
 * promoting the book title into one would invent a venue that does not exist.
 *
 * Chapter authors come from `BookDocument/AuthorList`; a book-level author list
 * stands in only when the chapter carries none of its own. `Sections`,
 * `ReferenceList` and `ItemList` are not read — metadata and abstract only. (#114)
 * @param xmlBookArticle - The raw XML PubmedBookArticle element.
 * @returns A parsed record with `recordType` set to `book-chapter` or `book`.
 */
export function parseFullBookArticle(xmlBookArticle: XmlPubmedBookArticle): ParsedArticle {
  const bookDocument = xmlBookArticle.BookDocument;
  const book = extractBookInfo(bookDocument);

  const chapterTitle = optionalText(bookDocument?.ArticleTitle);
  const bookAuthorLists = ensureArray(bookDocument?.Book?.AuthorList).filter(
    (list) => getAttribute(list, 'Type') !== 'editors',
  );
  const chapterAuthors = extractAuthors(mergeAuthorLists(ensureArray(bookDocument?.AuthorList)));
  const { authors, affiliations } = chapterAuthors.authors.length
    ? chapterAuthors
    : extractAuthors(mergeAuthorLists(bookAuthorLists));

  const abstractText = extractAbstractText(bookDocument?.Abstract);
  const keywords = extractKeywords(bookDocument?.KeywordList);
  const publicationTypes = ensureArray(bookDocument?.PublicationType)
    .map((pubType) => getText(pubType))
    .filter(Boolean);
  const articleDates = (
    [
      ['ContributionDate', bookDocument?.ContributionDate],
      ['DateRevised', bookDocument?.DateRevised],
    ] as const
  ).flatMap(([dateType, dateXml]): ParsedArticleDate[] =>
    dateXml
      ? [
          {
            dateType,
            year: getText(dateXml.Year),
            month: getText(dateXml.Month),
            day: getText(dateXml.Day),
          },
        ]
      : [],
  );
  const doi =
    findArticleId(bookDocument?.ArticleIdList, 'doi') ??
    findArticleId(xmlBookArticle.PubmedBookData?.ArticleIdList, 'doi');

  const title = chapterTitle ?? book.title;

  return {
    recordType: chapterTitle ? 'book-chapter' : 'book',
    pmid: getText(bookDocument?.PMID),
    ...(title !== undefined && { title }),
    ...(abstractText !== undefined && { abstractText }),
    ...(affiliations.length > 0 && { affiliations }),
    authors,
    book,
    ...(publicationTypes.length > 0 && { publicationTypes }),
    ...(keywords.length > 0 && { keywords }),
    ...(doi !== undefined && { doi }),
    ...(articleDates.length > 0 && { articleDates }),
  };
}

/**
 * Parse a whole `PubmedArticleSet` — every `PubmedArticle` and every
 * `PubmedBookArticle` — into one flat record list. This is the entry point every
 * EFetch consumer should use: reading `PubmedArticleSet.PubmedArticle` alone
 * silently discards Bookshelf records, whose PMIDs then look unavailable. (#114)
 *
 * Ordering: records of one kind keep their upstream order, and the two kinds
 * appear in the order they first occur in the response. Exact interleaving is
 * not recoverable — the flat XML parser groups siblings by element name, so a
 * response alternating the two kinds collapses to two runs. A caller that needs
 * records back in the order it asked for them should key on `pmid`.
 * @param articleSet - The parsed `PubmedArticleSet` element.
 * @param options - Options forwarded to journal-article parsing.
 * @returns Parsed records; an empty array when the set holds none.
 */
export function parseArticleSet(
  articleSet: XmlPubmedArticleSet | undefined,
  options: ParseFullArticleOptions = {},
): ParsedArticle[] {
  if (!articleSet) return [];
  const records: ParsedArticle[] = [];
  for (const member of Object.keys(articleSet)) {
    if (member === 'PubmedArticle') {
      for (const xmlArticle of ensureArray(articleSet.PubmedArticle)) {
        if (xmlArticle?.MedlineCitation) records.push(parseFullArticle(xmlArticle, options));
      }
    } else if (member === 'PubmedBookArticle') {
      for (const xmlBookArticle of ensureArray(articleSet.PubmedBookArticle)) {
        if (xmlBookArticle?.BookDocument) records.push(parseFullBookArticle(xmlBookArticle));
      }
    }
  }
  return records;
}
