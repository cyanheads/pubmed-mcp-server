/**
 * @fileoverview A real NCBI EFetch record whose pagination is NCBI's literal
 * `None`, for the page reads in `article-parser.ts` and every surface that
 * renders them. (#248)
 *
 * The constant is the upstream EFetch body for PMID 42845821 captured on
 * 2026-10-12, verbatim apart from reductions that leave `Pagination` and
 * `ELocationID` byte-for-byte intact: `ReferenceList` is removed, the
 * `AbstractText` body is truncated at a word boundary, and the author list is
 * capped at three entries.
 *
 * Parse it with `articleSetXml` and `parseArticleSetXml` from
 * `_book-fixtures.ts`, which run the production `NcbiResponseHandler`.
 * @module tests/services/ncbi/parsing/_pagination-fixtures
 */

/**
 * PMID 42845821 — `<Pagination><StartPage>None</StartPage><MedlinePgn>None</MedlinePgn></Pagination>`
 * beside a DOI-typed `ELocationID` only, so the record has no page and no
 * article number.
 */
export const NONE_PAGINATION_XML = `<PubmedArticle><MedlineCitation Status="PubMed-not-MEDLINE" Owner="NLM"><PMID Version="1">42845821</PMID><DateRevised><Year>2026</Year><Month>10</Month><Day>09</Day></DateRevised><Article PubModel="Print"><Journal><ISSN IssnType="Electronic">3050-5143</ISSN><JournalIssue CitedMedium="Internet"><Volume>2</Volume><Issue>9</Issue><PubDate><Year>2026</Year><Month>Sep</Month></PubDate></JournalIssue><Title>The Lancet. Primary care</Title><ISOAbbreviation>Lancet Prim Care</ISOAbbreviation></Journal><ArticleTitle>Refinement of a scoping tool to tackle antimicrobial resistance via a primary health care approach: insights from Kazakhstan, Sweden, and Thailand.</ArticleTitle><Pagination><StartPage>None</StartPage><MedlinePgn>None</MedlinePgn></Pagination><ELocationID EIdType="doi" ValidYN="Y">10.1016/j.lanprc.2026.100211</ELocationID><Abstract><AbstractText>WHO recommends a primary health care (PHC)-oriented health system for delivering high-quality, equitable, and efficient care in all countries. Primary care and the community serve as the frontlines</AbstractText><CopyrightInformation>&#xa9; 2026 World Health Organization.</CopyrightInformation></Abstract><AuthorList CompleteYN="Y"><Author ValidYN="Y"><LastName>Chong</LastName><ForeName>Serena W Y</ForeName><Initials>SWY</Initials><AffiliationInfo><Affiliation>Antimicrobial Resistance Department, WHO, Geneva, Switzerland.</Affiliation></AffiliationInfo></Author><Author ValidYN="Y"><LastName>Paulin</LastName><ForeName>Sarah</ForeName><Initials>S</Initials><AffiliationInfo><Affiliation>Antimicrobial Resistance Department, WHO, Geneva, Switzerland.</Affiliation></AffiliationInfo></Author><Author ValidYN="Y"><LastName>Khalid</LastName><ForeName>Faraz</ForeName><Initials>F</Initials><AffiliationInfo><Affiliation>Department of Performance, Financing and Delivery, World Health Organization, Geneva, Switzerland.</Affiliation></AffiliationInfo></Author></AuthorList><Language>eng</Language><PublicationTypeList><PublicationType UI="D016428">Journal Article</PublicationType><PublicationType UI="D016454">Review</PublicationType></PublicationTypeList></Article><MedlineJournalInfo><Country>England</Country><MedlineTA>Lancet Prim Care</MedlineTA><NlmUniqueID>9919089574606676</NlmUniqueID><ISSNLinking>3050-5143</ISSNLinking></MedlineJournalInfo><CoiStatement>SWYC is engaged as a consultant with WHO, and this manuscript was developed as part of the overall consultancy agreement with WHO. All other authors declare no competing interests.</CoiStatement></MedlineCitation><PubmedData><History><PubMedPubDate PubStatus="medline"><Year>2026</Year><Month>10</Month><Day>8</Day><Hour>11</Hour><Minute>40</Minute></PubMedPubDate><PubMedPubDate PubStatus="pubmed"><Year>2026</Year><Month>10</Month><Day>8</Day><Hour>11</Hour><Minute>39</Minute></PubMedPubDate><PubMedPubDate PubStatus="entrez"><Year>2026</Year><Month>10</Month><Day>8</Day><Hour>8</Hour><Minute>52</Minute></PubMedPubDate><PubMedPubDate PubStatus="pmc-release"><Year>2026</Year><Month>9</Month><Day>1</Day></PubMedPubDate></History><PublicationStatus>ppublish</PublicationStatus><ArticleIdList><ArticleId IdType="pubmed">42845821</ArticleId><ArticleId IdType="pmc">PMC13642074</ArticleId><ArticleId IdType="doi">10.1016/j.lanprc.2026.100211</ArticleId><ArticleId IdType="pii">S3050-5143(26)00107-X</ArticleId></ArticleIdList></PubmedData></PubmedArticle>`;

/** {@link NONE_PAGINATION_XML} with its `Pagination` element removed — the same record carrying no pagination at all. */
export const NO_PAGINATION_XML = NONE_PAGINATION_XML.replace(
  '<Pagination><StartPage>None</StartPage><MedlinePgn>None</MedlinePgn></Pagination>',
  '',
);
