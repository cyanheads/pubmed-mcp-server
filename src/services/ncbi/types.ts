/**
 * @fileoverview Type definitions for NCBI E-utilities XML structures and parsed results.
 * Used for parsing data from EFetch, ESummary, and ESearch endpoints.
 * @module src/services/ncbi/types
 */

// ─── NCBI API Constants & Request Types ─────────────────────────────────────

/** Base URL for all NCBI E-utility endpoints. */
export const NCBI_EUTILS_BASE_URL = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils';

/** Base URL for the PMC ID Converter API (separate from E-utilities). */
export const NCBI_PMC_IDCONV_URL = 'https://pmc.ncbi.nlm.nih.gov/tools/idconv/api/v1/articles/';

/**
 * Common NCBI E-utility request parameters.
 * Specific endpoints extend this with their own fields via the index signature.
 */
export interface NcbiRequestParams {
  /** Target database (e.g. 'pubmed', 'pmc'). Optional for einfo when listing all databases. */
  db?: string;
  [key: string]: string | number | undefined;
}

/**
 * Options controlling how an NCBI request is made and how the response is handled.
 */
export interface NcbiRequestOptions {
  /** Desired response format. */
  retmode?: 'xml' | 'json' | 'text';
  /** Specific return type (e.g. 'abstract', 'medline'). */
  rettype?: string;
  /** When true and retmode is 'xml', return the raw XML string after error checking. */
  returnRawXml?: boolean;
  /**
   * Parse XML in `preserveOrder: true` mode (returns `JatsNodeList`). Required
   * for JATS mixed-content responses (PMC full-text) where inline element order
   * must be preserved in the output. Leave false for all other E-utilities.
   */
  useOrderedParser?: boolean;
  /** Force HTTP POST (for large payloads). */
  usePost?: boolean;
}

/**
 * Options for the parseFullArticle convenience function.
 */
export interface ParseFullArticleOptions {
  includeGrants?: boolean;
  includeMesh?: boolean;
}

// ─── XML Element Types (PubMed DTD) ─────────────────────────────────────────

// Basic type for elements that primarily contain text but might have attributes.
// Attribute keys are prefixed with '@_' by fast-xml-parser (e.g. '@_UI', '@_MajorTopicYN').
export interface XmlTextElement {
  '#text'?: string;
  [key: string]: unknown;
}

// Specific XML element types based on PubMed DTD (simplified)

export type XmlPMID = XmlTextElement; // e.g., <PMID Version="1">12345</PMID>

export interface XmlArticleDate extends XmlTextElement {
  '@_DateType'?: string;
  Day?: XmlTextElement;
  Month?: XmlTextElement;
  Year?: XmlTextElement;
}

export interface XmlIdentifier extends XmlTextElement {
  '@_Source'?: string; // e.g. 'ORCID', 'ISNI'
}

export interface XmlAuthor {
  AffiliationInfo?: {
    Affiliation?: XmlTextElement;
  }[];
  CollectiveName?: XmlTextElement; // For group authors
  ForeName?: XmlTextElement;
  Identifier?: XmlIdentifier[] | XmlIdentifier; // For ORCID etc.
  Initials?: XmlTextElement;
  LastName?: XmlTextElement;
}

export interface XmlAuthorList {
  '@_CompleteYN'?: 'Y' | 'N';
  Author?: XmlAuthor[] | XmlAuthor;
}

export interface XmlPublicationType extends XmlTextElement {
  '@_UI'?: string;
}

export interface XmlPublicationTypeList {
  PublicationType: XmlPublicationType[] | XmlPublicationType;
}

export interface XmlELocationID extends XmlTextElement {
  '@_EIdType'?: string; // 'doi', 'pii'
  '@_ValidYN'?: 'Y' | 'N';
}

export interface XmlArticleId extends XmlTextElement {
  '@_IdType'?: string; // 'doi', 'pubmed', 'pmc', 'mid', etc.
}

export interface XmlArticleIdList {
  ArticleId: XmlArticleId[] | XmlArticleId;
}

export interface XmlAbstractText extends XmlTextElement {
  '@_Label'?: string;
  '@_NlmCategory'?: string; // e.g., 'BACKGROUND', 'METHODS', 'RESULTS', 'CONCLUSIONS'
}

export interface XmlAbstract {
  AbstractText: XmlAbstractText[] | XmlAbstractText;
  CopyrightInformation?: XmlTextElement;
}

export interface XmlPagination {
  EndPage?: XmlTextElement;
  MedlinePgn?: XmlTextElement; // e.g., '10-5' or 'e123'
  StartPage?: XmlTextElement;
}

export interface XmlPubDate {
  Day?: XmlTextElement;
  MedlineDate?: XmlTextElement; // e.g., '2000 Spring', '1999-2000'
  Month?: XmlTextElement;
  Year?: XmlTextElement;
}

export interface XmlJournalIssue {
  '@_CitedMedium'?: string; // 'Internet' or 'Print'
  Issue?: XmlTextElement;
  PubDate?: XmlPubDate;
  Volume?: XmlTextElement;
}

export interface XmlJournal {
  ISOAbbreviation?: XmlTextElement; // Journal Abbreviation
  ISSN?: XmlTextElement & { '@_IssnType'?: string };
  JournalIssue?: XmlJournalIssue;
  Title?: XmlTextElement; // Full Journal Title
}

export interface XmlArticle {
  Abstract?: XmlAbstract;
  ArticleDate?: XmlArticleDate[] | XmlArticleDate;
  ArticleIdList?: XmlArticleIdList;
  ArticleTitle?: XmlTextElement | string; // Can be just string or object with #text
  AuthorList?: XmlAuthorList;
  ELocationID?: XmlELocationID[] | XmlELocationID;
  GrantList?: XmlGrantList;
  Journal?: XmlJournal;
  KeywordList?: XmlKeywordList[] | XmlKeywordList; // Can have multiple KeywordList elements
  Language?: XmlTextElement[] | XmlTextElement; // Array of languages
  Pagination?: XmlPagination;
  PublicationTypeList?: XmlPublicationTypeList;
  // Other elements like VernacularTitle, DataBankList, etc.
}

export interface XmlMeshQualifierName extends XmlTextElement {
  '@_MajorTopicYN'?: 'Y' | 'N';
  '@_UI'?: string;
}
export interface XmlMeshDescriptorName extends XmlTextElement {
  '@_MajorTopicYN'?: 'Y' | 'N';
  '@_UI'?: string;
}

export interface XmlMeshHeading {
  '@_MajorTopicYN'?: 'Y' | 'N';
  DescriptorName: XmlMeshDescriptorName;
  QualifierName?: XmlMeshQualifierName[] | XmlMeshQualifierName;
}

export interface XmlMeshHeadingList {
  MeshHeading: XmlMeshHeading[] | XmlMeshHeading;
}

export interface XmlKeyword extends XmlTextElement {
  '@_MajorTopicYN'?: 'Y' | 'N';
  '@_Owner'?: string; // NLM, NLM-AUTO, PIP, KIE, NOTNLM, NASA, HHS
}

export interface XmlKeywordList {
  '@_Owner'?: string;
  Keyword: XmlKeyword[] | XmlKeyword;
}

export interface XmlGrant {
  Acronym?: XmlTextElement;
  Agency?: XmlTextElement;
  Country?: XmlTextElement;
  GrantID?: XmlTextElement;
}

export interface XmlGrantList {
  '@_CompleteYN'?: 'Y' | 'N';
  Grant: XmlGrant[] | XmlGrant;
}

export interface XmlMedlineCitation {
  '@_Owner'?: string; // e.g., 'NLM', 'NASA', 'PIP', 'KIE', 'HSR', 'HMD', 'NOTNLM'
  '@_Status'?: string; // e.g., 'MEDLINE', 'PubMed-not-MEDLINE', 'In-Data-Review', 'In-Process', 'Publisher', 'Completed'
  Article?: XmlArticle;
  CitationSubset?: XmlTextElement[] | XmlTextElement;
  DateCompleted?: XmlArticleDate;
  DateCreated?: XmlArticleDate;
  DateRevised?: XmlArticleDate;
  GeneralNote?: (XmlTextElement & { '@_Owner'?: string })[];
  KeywordList?: XmlKeywordList[] | XmlKeywordList;
  MeshHeadingList?: XmlMeshHeadingList;
  PMID: XmlPMID;
}

export interface XmlPubmedArticle {
  MedlineCitation: XmlMedlineCitation;
  PubmedData?: {
    History?: {
      PubMedPubDate: (XmlArticleDate & { '@_PubStatus'?: string })[];
    };
    PublicationStatus?: XmlTextElement;
    ArticleIdList?: XmlArticleIdList; // ArticleIdList can also be under PubmedData
    ReferenceList?: unknown; // Complex structure for references
  };
}

export interface XmlPubmedArticleSet {
  DeleteCitation?: {
    PMID: XmlPMID[] | XmlPMID;
  };
  PubmedArticle?: XmlPubmedArticle[] | XmlPubmedArticle;
  // Can also contain ErrorList or other elements if the request had issues
}

// ─── Parsed Object Types (application use, derived from XML) ────────────────

export interface ParsedArticleAuthor {
  affiliationIndices?: number[];
  collectiveName?: string;
  firstName?: string;
  initials?: string;
  lastName?: string;
  orcid?: string;
}

export interface ParsedArticleDate {
  dateType?: string;
  day?: string;
  month?: string;
  year?: string;
}

export interface ParsedJournalPublicationDate {
  day?: string;
  medlineDate?: string;
  month?: string;
  year?: string;
}

export interface ParsedJournalInfo {
  eIssn?: string;
  isoAbbreviation?: string;
  issn?: string;
  issue?: string;
  pages?: string;
  publicationDate?: ParsedJournalPublicationDate;
  title?: string;
  volume?: string;
}

export interface ParsedMeshQualifier {
  isMajorTopic: boolean;
  qualifierName: string;
  qualifierUi?: string;
}

export interface ParsedMeshTerm {
  descriptorName?: string;
  descriptorUi?: string;
  isMajorTopic: boolean;
  qualifiers?: ParsedMeshQualifier[];
}

export interface ParsedGrant {
  acronym?: string;
  agency?: string;
  country?: string;
  grantId?: string;
}

export interface ParsedArticle {
  abstractText?: string;
  affiliations?: string[];
  articleDates?: ParsedArticleDate[]; // Dates like 'received', 'accepted', 'revised'
  authors?: ParsedArticleAuthor[];
  doi?: string;
  grantList?: ParsedGrant[];
  journalInfo?: ParsedJournalInfo;
  keywords?: string[];
  meshTerms?: ParsedMeshTerm[];
  pmcId?: string;
  pmid: string;
  publicationTypes?: string[];
  title?: string;
  // Add other fields as needed, e.g., language, publication status
}

// ─── ESummary Types ─────────────────────────────────────────────────────────

/**
 * Represents a raw author entry as parsed from ESummary XML.
 * This type accounts for potential inconsistencies in property naming (e.g., Name/name)
 * and structure directly from the XML-to-JavaScript conversion.
 * It is intended for use as an intermediate type before normalization into ESummaryAuthor.
 */
export interface XmlESummaryAuthorRaw {
  '#text'?: string; // If the author is represented as a simple text node

  AuthType?: string; // Author type (e.g., 'Author')
  authtype?: string; // Alternative casing

  ClusterId?: string; // Cluster ID
  clusterid?: string; // Alternative casing
  Name?: string; // Primary name field (often 'LastName Initials')
  name?: string; // Alternative casing for name

  // Allow other properties as NCBI XML can be unpredictable
  [key: string]: unknown;
}

/**
 * Represents a normalized author entry after parsing from ESummary data.
 * This is the clean, canonical structure for application use.
 */
export interface ESummaryAuthor {
  authtype?: string; // Standardized: e.g., 'Author'
  clusterid?: string; // Standardized
  name: string; // Standardized: 'LastName Initials'
}

/**
 * NCBI returns ArticleId entries in two shapes depending on retmode:
 * - JSON (`retmode=json&version=2.0`): lowercase keys `{ idtype, idtypen, value }`
 * - XML  (`retmode=xml&version=2.0`):  capitalized child elements parsed as
 *   `{ IdType, IdTypeN, Value }` by fast-xml-parser.
 *
 * Both shapes are supported so callers don't have to care which retmode produced
 * the summary. Use the helpers in `esummary-parser.ts` to read them safely.
 */
export interface ESummaryArticleId {
  IdType?: string;
  IdTypeN?: number;
  idtype?: string; // e.g., 'pubmed', 'doi', 'pmc'
  idtypen?: number;
  Value?: string | number;
  value?: string | number;
  [key: string]: unknown;
}

export interface ESummaryHistory {
  date: string; // Date string
  pubstatus: string; // e.g., 'pubmed', 'medline', 'entrez'
}

// For the older DocSum <Item Name="..." Type="..."> structure.
// Attribute keys use '@_' prefix per fast-xml-parser config.
export interface ESummaryItem {
  '@_Name': string;
  '@_Type': 'String' | 'Integer' | 'Date' | 'List' | 'Structure' | 'Unknown' | 'ERROR';
  '#text'?: string; // Value of the item
  Item?: ESummaryItem[] | ESummaryItem; // For nested lists
  [key: string]: unknown; // Other attributes like @_idtype for ArticleIds
}

export interface ESummaryDocSumOldXml {
  Id: string; // PMID
  Item: ESummaryItem[];
}

// For the newer DocumentSummarySet structure (often from retmode=xml with version=2.0)
export interface ESummaryDocumentSummary {
  '@_uid': string; // PMID
  ArticleIds?: ESummaryArticleId[] | { ArticleId: ESummaryArticleId[] | ESummaryArticleId };
  Attributes?: string[];
  Authors?:
    | XmlESummaryAuthorRaw[] // Array of raw author entries
    | { Author: XmlESummaryAuthorRaw[] | XmlESummaryAuthorRaw } // Object containing raw author entries
    | string; // Or a simple string for authors
  DOI?: string; // Sometimes directly available
  EPubDate?: string;
  ESSN?: string;
  FullJournalName?: string;
  History?: ESummaryHistory[] | { PubMedPubDate: ESummaryHistory[] | ESummaryHistory };
  ISSN?: string;
  Issue?: string;
  Lang?: string[];
  LastAuthor?: string;
  Pages?: string;
  PubDate?: string;
  PubStatus?: string;
  PubType?: string[]; // Array of publication types
  RecordStatus?: string;
  References?: unknown[]; // Usually empty or complex
  SO?: string; // Source Abbreviation
  SortTitle?: string;
  Source?: string;
  Title?: string;
  Volume?: string;
  [key: string]: unknown; // For other dynamic fields
}

export interface ESummaryDocumentSummarySet {
  DocumentSummary: ESummaryDocumentSummary[] | ESummaryDocumentSummary;
}

export interface ESummaryResult {
  DocSum?: ESummaryDocSumOldXml[] | ESummaryDocSumOldXml; // Older XML format
  DocumentSummarySet?: ESummaryDocumentSummarySet; // Newer XML format
  ERROR?: string; // Error message if present
  [key: string]: unknown; // For other potential top-level elements like 'dbinfo'
}

export interface ESummaryResponseContainer {
  eSummaryResult: ESummaryResult;
  // header?: unknown; // If there's a header part in the response
}

// Parsed brief summary (application-level)
export interface ParsedBriefSummary {
  authors?: string; // Formatted string
  doi?: string;
  epubDate?: string; // Standardized YYYY-MM-DD
  pmcId?: string;
  pmid: string;
  pubDate?: string; // Standardized YYYY-MM-DD
  source?: string;
  title?: string;
}

// ─── ESearch Types ──────────────────────────────────────────────────────────

export interface ESearchResultIdList {
  Id: string[];
}

export interface ESearchTranslation {
  From: string;
  To: string;
}

export interface ESearchTranslationSet {
  Translation: ESearchTranslation[];
}

export interface ESearchWarningList {
  FieldNotFound?: string[];
  OutputMessage?: string[];
  PhraseNotFound?: string[];
  QuotedPhraseNotFound?: string[];
}
export interface ESearchErrorList {
  FieldNotFound?: string[];
  PhraseNotFound?: string[];
}

export interface ESearchResultContent {
  Count: string;
  ErrorList?: ESearchErrorList;
  IdList?: ESearchResultIdList;
  QueryKey?: string;
  QueryTranslation: string;
  RetMax: string;
  RetStart: string;
  TranslationSet?: ESearchTranslationSet;
  TranslationStack?: unknown; // Usually complex, define if needed
  WarningList?: ESearchWarningList;
  WebEnv?: string;
}

export interface ESearchResponseContainer {
  eSearchResult: ESearchResultContent;
  // header?: unknown;
}

// Fully parsed and typed result for ESearch
export interface ESearchResult {
  count: number;
  errorList?: ESearchErrorList;
  idList: string[];
  queryKey?: string;
  queryTranslation: string;
  retmax: number;
  retstart: number;
  warningList?: ESearchWarningList;
  webEnv?: string;
}

// ─── ESpell Types ───────────────────────────────────────────────────────────

/** Normalized ESpell result. */
export interface ESpellResult {
  corrected: string;
  hasSuggestion: boolean;
  original: string;
}

/** Raw parsed XML container for eSpellResult. */
export interface ESpellResponseContainer {
  eSpellResult: {
    Query?: string;
    CorrectedQuery?: string;
    SpelledQuery?: unknown;
  };
}

// ─── EFetch Types ───────────────────────────────────────────────────────────

// Fully parsed and typed result for EFetch
export interface EFetchArticleSet {
  articles: ParsedArticle[];
  // Add any other top-level fields from the parsed EFetch result if necessary
}

// ─── Parsed PMC Types (application use) ─────────────────────────────────────
//
// Note: PMC EFetch responses are parsed in `preserveOrder: true` mode (see
// `pmc-xml-helpers.ts`) because JATS mixed-content elements lose document order
// otherwise. The ordered shape is exposed as `JatsNode` / `JatsNodeList`; no
// structural types live here for it.

/** Parsed full-text article from PMC. */
export interface ParsedPmcArticle {
  abstract?: string;
  affiliations?: string[];
  articleType?: string;
  authors?: ParsedPmcAuthor[];
  doi?: string;
  journal?: ParsedPmcJournal;
  keywords?: string[];
  pmcId: string;
  pmcUrl: string;
  pmid?: string;
  publicationDate?: { year?: string; month?: string; day?: string };
  pubmedUrl?: string;
  references?: ParsedPmcReference[];
  sections: ParsedPmcSection[];
  title?: string;
}

/** Parsed PMC author. */
export interface ParsedPmcAuthor {
  collectiveName?: string;
  givenNames?: string;
  lastName?: string;
}

/** Parsed PMC journal info. */
export interface ParsedPmcJournal {
  issn?: string;
  issue?: string;
  pages?: string;
  title?: string;
  volume?: string;
}

/** Parsed PMC article section. */
export interface ParsedPmcSection {
  label?: string;
  subsections?: ParsedPmcSection[];
  text: string;
  title?: string;
}

/** Parsed PMC reference. */
export interface ParsedPmcReference {
  citation: string;
  id?: string;
  label?: string;
}

// ─── ECitMatch Types ──────────────────────────────────────────────────────────

/** Single citation for ECitMatch lookup. */
export interface ECitMatchCitation {
  /** Author name (e.g., "mann bj") */
  authorName?: string | undefined;
  /** First page number */
  firstPage?: string | undefined;
  /** Journal title or ISO abbreviation */
  journal?: string | undefined;
  /** Arbitrary key for tracking this citation in results */
  key: string;
  /** Volume number */
  volume?: string | undefined;
  /** Publication year */
  year?: string | undefined;
}

/** Single result from ECitMatch lookup. */
export interface ECitMatchResult {
  /** Raw non-match detail returned by ECitMatch when present */
  detail?: string;
  /** The tracking key from the input citation */
  key: string;
  /** Whether a PMID was found */
  matched: boolean;
  /** Matched PubMed ID, or null if no match */
  pmid: string | null;
  /** Lookup outcome classification for recovery guidance */
  status: 'matched' | 'not_found' | 'ambiguous';
}

// ─── PMC ID Converter Types ──────────────────────────────────────────────────

/** Single record from the PMC ID Converter API response. */
export interface IdConvertRecord {
  /** Digital Object Identifier */
  doi?: string;
  /** Error message if conversion failed for this ID */
  errmsg?: string;
  /** PubMed Central ID (e.g., "PMC1234567") */
  pmcid?: string;
  /** PubMed ID (numeric string) */
  pmid?: string;
  /** The ID that was originally requested */
  'requested-id': string;
  /** Record-level status: present only on error records */
  status?: string;
}

/** JSON response from the PMC ID Converter API. */
export interface IdConvertResponse {
  records: IdConvertRecord[];
  request: Record<string, unknown>;
  'response-date': string;
  status: string;
}
