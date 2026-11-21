/**
 * @fileoverview A real NCBI ESummary version 2.0 body for the language codes
 * `pubmed_search_articles` summaries and `pubmed_find_related` rows carry: one
 * batch mixing a single `Lang` code, two, three out of alphabetical order, and
 * six, beside a Bookshelf book and the error entry ESummary returns for a PMID
 * it does not know. Parse it with `parseESummaryXml` from `_book-fixtures.ts`,
 * which runs the production `NcbiResponseHandler`. (#309)
 * @module tests/services/ncbi/parsing/_language-fixtures
 */

/**
 * ESummary (`db=pubmed&version=2.0&retmode=xml`) for six PMIDs, fetched
 * 2026-11-21, in NCBI's order: the GeneReviews whole book 20301295 (`eng`),
 * 34463784 (`ger`), 43020712 (`eng`, `spa`), the unknown PMID 99999999 (an
 * `<error>` entry with no `Lang`), 25881375 (`ara`, `eng`, `fre`, `ger`, `por`,
 * `spa`), and 42233801 (`por`, `eng`, `spa`). Every `Lang` element is verbatim;
 * each record is trimmed to its dates, `Source`, first four contributors,
 * `Title`, `Lang`, its `pubmed`, `pmc`, and `doi` `ArticleIds`, `DocType`,
 * `BookTitle`, and `PublisherName`, with inter-element whitespace removed. The
 * parser reads a lone code as `{ string: 'ger' }` and several as
 * `{ string: ['eng', 'spa'] }`, both shapes in this one batch.
 */
export const LANGUAGES_ESUMMARY_XML = `<?xml version="1.0" encoding="UTF-8" ?><!DOCTYPE eSummaryResult PUBLIC "-//NLM//DTD esummary pubmed 20160808//EN" "https://eutils.ncbi.nlm.nih.gov/eutils/dtd/20160808/esummary_pubmed.dtd"><eSummaryResult><DocumentSummarySet status="OK"><DbBuild/><DocumentSummary uid = "20301295"><PubDate>1993</PubDate><EPubDate/><Source/><Authors><Author><Name>Adam MP</Name><AuthType>Editor</AuthType><ClusterID/></Author><Author><Name>Bick S</Name><AuthType>Editor</AuthType><ClusterID/></Author><Author><Name>Mirzaa GM</Name><AuthType>Editor</AuthType><ClusterID/></Author><Author><Name>Wallace SE</Name><AuthType>Editor</AuthType><ClusterID/></Author></Authors><Title/><Lang><string>eng</string></Lang><ArticleIds><ArticleId><IdType>pubmed</IdType><IdTypeN>1</IdTypeN><Value>20301295</Value></ArticleId></ArticleIds><DocType>book</DocType><BookTitle>GeneReviews(&#xae;)</BookTitle><PublisherName>University of Washington, Seattle</PublisherName></DocumentSummary><DocumentSummary uid = "34463784"><PubDate>2022 Aug</PubDate><EPubDate>2021 Aug 31</EPubDate><Source>Herz</Source><Authors><Author><Name>Wintrich J</Name><AuthType>Author</AuthType><ClusterID/></Author><Author><Name>Berger AK</Name><AuthType>Author</AuthType><ClusterID/></Author><Author><Name>Bewarder Y</Name><AuthType>Author</AuthType><ClusterID/></Author><Author><Name>Emrich I</Name><AuthType>Author</AuthType><ClusterID/></Author></Authors><Title>[Update on diagnostics and treatment of heart failure].</Title><Lang><string>ger</string></Lang><ArticleIds><ArticleId><IdType>pubmed</IdType><IdTypeN>1</IdTypeN><Value>34463784</Value></ArticleId><ArticleId><IdType>pmc</IdType><IdTypeN>8</IdTypeN><Value>PMC8405859</Value></ArticleId><ArticleId><IdType>doi</IdType><IdTypeN>3</IdTypeN><Value>10.1007/s00059-021-05062-x</Value></ArticleId></ArticleIds><DocType>citation</DocType><BookTitle/><PublisherName/></DocumentSummary><DocumentSummary uid = "43020712"><PubDate>2026 Nov 12</PubDate><EPubDate>2026 Nov 12</EPubDate><Source>Arch Bronconeumol</Source><Authors><Author><Name>Okagaki N</Name><AuthType>Author</AuthType><ClusterID/></Author><Author><Name>Tsuboi T</Name><AuthType>Author</AuthType><ClusterID/></Author><Author><Name>Chihara Y</Name><AuthType>Author</AuthType><ClusterID/></Author><Author><Name>Sumi K</Name><AuthType>Author</AuthType><ClusterID/></Author></Authors><Title>Ventral Lung Injury and Pneumothorax in Patients With Amyotrophic Lateral Sclerosis Receiving Long-term Positive Pressure Ventilation.</Title><Lang><string>eng</string><string>spa</string></Lang><ArticleIds><ArticleId><IdType>pubmed</IdType><IdTypeN>1</IdTypeN><Value>43020712</Value></ArticleId><ArticleId><IdType>doi</IdType><IdTypeN>3</IdTypeN><Value>10.1016/j.arbres.2026.10.015</Value></ArticleId></ArticleIds><DocType>citation</DocType><BookTitle/><PublisherName/></DocumentSummary><DocumentSummary uid = "99999999"><error>cannot get document summary</error></DocumentSummary><DocumentSummary uid = "25881375"><PubDate>2015 Spring</PubDate><EPubDate/><Source>Int J Orthod Milwaukee</Source><Authors><Author><Name>Champagne M</Name><AuthType>Author</AuthType><ClusterID/></Author></Authors><Title>Pseudoscience in orthodontics.</Title><Lang><string>ara</string><string>eng</string><string>fre</string><string>ger</string><string>por</string><string>spa</string></Lang><ArticleIds><ArticleId><IdType>pubmed</IdType><IdTypeN>1</IdTypeN><Value>25881375</Value></ArticleId></ArticleIds><DocType>citation</DocType><BookTitle/><PublisherName/></DocumentSummary><DocumentSummary uid = "42233801"><PubDate>2026 Apr</PubDate><EPubDate>2024 Dec 30</EPubDate><Source>Cien Saude Colet</Source><Authors><Author><Name>Vasconcelos FAG</Name><AuthType>Author</AuthType><ClusterID/></Author></Authors><Title>Phenomenological approaches to qualitative research in the field of Nutrition in Brazil: a literature review.</Title><Lang><string>por</string><string>eng</string><string>spa</string></Lang><ArticleIds><ArticleId><IdType>pubmed</IdType><IdTypeN>1</IdTypeN><Value>42233801</Value></ArticleId><ArticleId><IdType>doi</IdType><IdTypeN>3</IdTypeN><Value>10.1590/1413-81232026314.15792024</Value></ArticleId></ArticleIds><DocType>citation</DocType><BookTitle/><PublisherName/></DocumentSummary></DocumentSummarySet></eSummaryResult>`;

/** Each described PMID of {@link LANGUAGES_ESUMMARY_XML} and its `Lang` codes, in NCBI's order. */
export const LANGUAGES_BY_PMID: [string, string[]][] = [
  ['20301295', ['eng']],
  ['34463784', ['ger']],
  ['43020712', ['eng', 'spa']],
  ['25881375', ['ara', 'eng', 'fre', 'ger', 'por', 'spa']],
  ['42233801', ['por', 'eng', 'spa']],
];
