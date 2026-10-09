/**
 * @fileoverview Journal records carrying `MedlineCitation/InvestigatorList`, for the
 * opt-in `includeInvestigators` of `pubmed_fetch_articles`. (#216)
 *
 * The records follow PMID 34116029, whose collective author "TGU Investigators" heads a
 * 22-member list, and extend it along the PubMed DTD: `InvestigatorList` is repeatable
 * on a `MedlineCitation`, and an `Investigator` is `(LastName, ForeName?, Initials?,
 * Suffix?, Identifier*, AffiliationInfo*)`. No sampled record carries more than one list,
 * an investigator `AffiliationInfo`, or an investigator `Identifier`, so those shapes are
 * synthetic. The real 22-member list is the corpus fixture
 * `tests/corpus/fixtures/pubmed/pmid34116029/source.xml`.
 *
 * Parse them with `articleSetXml` and `parseArticleSetXml` from `_book-fixtures.ts`,
 * which run the production `NcbiResponseHandler` — so the `NCBI_ARRAY_JPATHS` entries
 * that keep a one-element list an array are exercised.
 * @module tests/services/ncbi/parsing/_investigator-fixtures
 */

/** First author's affiliation. */
export const BDI = 'Big Data Institute, Oxford.';
/** The collective author's affiliation, which an investigator shares. */
export const TGU = 'Translational Gastroenterology Unit, Oxford.';
/** An affiliation no author carries: investigators alone point at it. */
export const KENNEDY = 'Kennedy Institute, Oxford.';

/**
 * A journal record with a person author and the collective author "TGU Investigators",
 * each with one affiliation, followed by `investigatorLists` — raw XML placed where the
 * DTD puts `InvestigatorList`, after the citation's `Article`.
 */
export function consortiumRecordXml(investigatorLists: string, pmid = '40000216'): string {
  return `<PubmedArticle><MedlineCitation Status="MEDLINE" Owner="NLM"><PMID Version="1">${pmid}</PMID><Article PubModel="Print"><Journal><JournalIssue CitedMedium="Internet"><Volume>12</Volume><PubDate><Year>2024</Year></PubDate></JournalIssue><Title>Journal of Consortia</Title></Journal><ArticleTitle>A Consortium Trial.</ArticleTitle><AuthorList CompleteYN="Y"><Author ValidYN="Y"><LastName>Ali</LastName><ForeName>Sharib</ForeName><Initials>S</Initials><AffiliationInfo><Affiliation>${BDI}</Affiliation></AffiliationInfo></Author><Author ValidYN="Y"><CollectiveName>TGU Investigators</CollectiveName><AffiliationInfo><Affiliation>${TGU}</Affiliation></AffiliationInfo></Author></AuthorList><PublicationTypeList><PublicationType UI="D016428">Journal Article</PublicationType></PublicationTypeList></Article>${investigatorLists}</MedlineCitation><PubmedData><ArticleIdList><ArticleId IdType="pubmed">${pmid}</ArticleId></ArticleIdList></PubmedData></PubmedArticle>`;
}

/**
 * Two lists. The first holds a name-only investigator (the form every sampled record
 * uses) and one carrying an ORCID and two affiliations — the collective author's, and
 * one no author has. The second holds a single investigator, which the flat XML parser
 * would otherwise collapse to a scalar.
 */
export const TWO_LISTS_XML = `<InvestigatorList><Investigator ValidYN="Y"><LastName>Allan</LastName><ForeName>Philip</ForeName><Initials>P</Initials></Investigator><Investigator ValidYN="Y"><LastName>Arancibia-C&#xe1;rcamo</LastName><ForeName>Carolina</ForeName><Initials>C</Initials><Identifier Source="ORCID">0000-0002-1825-0097</Identifier><AffiliationInfo><Affiliation>${TGU}</Affiliation></AffiliationInfo><AffiliationInfo><Affiliation>${KENNEDY}</Affiliation></AffiliationInfo></Investigator></InvestigatorList><InvestigatorList><Investigator ValidYN="Y"><LastName>Walsh</LastName><ForeName>Alissa</ForeName><Initials>A</Initials><AffiliationInfo><Affiliation>${KENNEDY}</Affiliation></AffiliationInfo></Investigator></InvestigatorList>`;

/** PMID 40000216 with {@link TWO_LISTS_XML}. */
export const CONSORTIUM_XML = consortiumRecordXml(TWO_LISTS_XML);

/** The three investigators of {@link CONSORTIUM_XML}, as returned. */
export const CONSORTIUM_INVESTIGATORS = [
  { lastName: 'Allan', firstName: 'Philip', initials: 'P' },
  {
    lastName: 'Arancibia-Cárcamo',
    firstName: 'Carolina',
    initials: 'C',
    affiliationIndices: [1, 2],
    orcid: '0000-0002-1825-0097',
  },
  { lastName: 'Walsh', firstName: 'Alissa', initials: 'A', affiliationIndices: [2] },
];

/** One list holding one investigator with one affiliation: every level a singleton. */
export const SINGLETON_LIST_XML = `<InvestigatorList><Investigator ValidYN="Y"><LastName>Walsh</LastName><ForeName>Alissa</ForeName><Initials>A</Initials><AffiliationInfo><Affiliation>${KENNEDY}</Affiliation></AffiliationInfo></Investigator></InvestigatorList>`;
