/**
 * @fileoverview Helper functions for parsing detailed PubMed Article XML structures,
 * typically from EFetch results.
 * @module src/services/ncbi/parsing/article-parser
 */

import type {
  ParsedArticle,
  ParsedArticleAuthor,
  ParsedArticleDate,
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
  XmlGrant,
  XmlGrantList,
  XmlIdentifier,
  XmlJournal,
  XmlKeyword,
  XmlKeywordList,
  XmlMedlineCitation,
  XmlMeshHeading,
  XmlMeshHeadingList,
  XmlPublicationType,
  XmlPublicationTypeList,
  XmlPubmedArticle,
} from '../types.js';
import { ensureArray, getAttribute, getText } from './xml-helpers.js';

/**
 * Extracts and formats author information from XML.
 * @param authorListXml - The XML AuthorList element.
 * @returns An array of formatted author objects.
 */
export function extractAuthors(authorListXml?: XmlAuthorList): ParsedArticleAuthor[] {
  if (!authorListXml) return [];
  const authors = ensureArray(authorListXml.Author);
  return authors.map((auth: XmlAuthor): ParsedArticleAuthor => {
    const collectiveName = getText(auth.CollectiveName);
    if (collectiveName) {
      return { collectiveName };
    }

    let affiliation = '';
    const affiliations = ensureArray(auth.AffiliationInfo);
    if (affiliations.length > 0) {
      affiliation = getText(affiliations[0]?.Affiliation);
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
      ...(affiliation && { affiliation }),
      ...(orcid && { orcid }),
    };
  });
}

/**
 * Extracts and formats journal information from XML.
 * @param journalXml - The XML Journal element from an Article.
 * @param articleXml - The XML Article element (for Pagination).
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

  return {
    title: getText(journalXml.Title),
    isoAbbreviation: getText(journalXml.ISOAbbreviation),
    ...(issn && { issn }),
    ...(eIssn && { eIssn }),
    volume: getText(journalXml.JournalIssue?.Volume),
    issue: getText(journalXml.JournalIssue?.Issue),
    pages: getText(articleXml?.Pagination?.MedlinePgn),
    publicationDate: {
      ...(year && { year }),
      ...(getText(pubDate?.Month) && { month: getText(pubDate?.Month) }),
      ...(getText(pubDate?.Day) && { day: getText(pubDate?.Day) }),
      ...(getText(pubDate?.MedlineDate) && { medlineDate: getText(pubDate?.MedlineDate) }),
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
    const grantId = getText(g.GrantID);
    const acronym = getText(g.Acronym);
    const agency = getText(g.Agency);
    const country = getText(g.Country);
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
  if (!abstractXml || !abstractXml.AbstractText) return;

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
  if (!medlineCitationXml || !medlineCitationXml.PMID) return;
  return getText(medlineCitationXml.PMID);
}

/**
 * Extracts article dates from XML.
 * @param articleXml - The XML Article element.
 * @returns An array of parsed article dates.
 */
export function extractArticleDates(articleXml?: XmlArticle): ParsedArticleDate[] {
  if (!articleXml || !articleXml.ArticleDate) return [];
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
  const doi = extractDoi(article, xmlArticle.PubmedData?.ArticleIdList);

  return {
    pmid: extractPmid(medlineCitation) ?? '',
    title: getText(article?.ArticleTitle),
    ...(abstractText !== undefined && { abstractText }),
    authors: extractAuthors(article?.AuthorList),
    ...(journalInfo !== undefined && { journalInfo }),
    publicationTypes: extractPublicationTypes(article?.PublicationTypeList),
    keywords: extractKeywords(medlineCitation?.KeywordList ?? article?.KeywordList),
    ...(includeMesh && { meshTerms: extractMeshTerms(medlineCitation?.MeshHeadingList) }),
    ...(includeGrants && { grantList: extractGrants(article?.GrantList) }),
    ...(doi !== undefined && { doi }),
    articleDates: extractArticleDates(article),
  };
}
