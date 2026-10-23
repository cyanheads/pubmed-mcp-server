/**
 * @fileoverview `pubmed_fetch_articles` and `pubmed_format_citations` on record fields,
 * through the contract boundary on both surfaces: a collective author's own affiliation
 * (#212) and its investigators (#216), journal fields the record does not carry (#213), a
 * grant with no `GrantID` (#214), databank accessions (#257), the linking ISSN (#253),
 * and text NCBI double-encodes (#255). The EFetch body runs through the production
 * response handler and article parser; only the NCBI service call is replaced.
 * @module tests/mcp-server/tools/definitions/fetch-articles.record-fields.test
 */

import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  articleSetXml,
  parseArticleSetXml,
} from '../../../services/ncbi/parsing/_book-fixtures.js';
import {
  APOS_TITLE_XML,
  R_AND_D_ABSTRACT_XML,
  R_AND_D_AFFILIATION_XML,
  R_AND_D_KEYWORD_XML,
} from '../../../services/ncbi/parsing/_entity-fixtures.js';

const mockEFetch = vi.fn();
vi.mock('@/services/ncbi/ncbi-service.js', () => ({
  getNcbiService: () => ({ eFetch: mockEFetch }),
}));

const { fetchArticlesTool } = await import('@/mcp-server/tools/definitions/fetch-articles.tool.js');
const { formatCitationsTool } = await import(
  '@/mcp-server/tools/definitions/format-citations.tool.js'
);

/** A journal record: `journal` is the inner XML of `<Journal>`, `extra` follows the title. */
function record(pmid: string, journal: string, extra = '') {
  return `<PubmedArticle><MedlineCitation Status="MEDLINE" Owner="NLM"><PMID Version="1">${pmid}</PMID><Article PubModel="Print-Electronic"><Journal>${journal}</Journal><ArticleTitle>A Pilot Study.</ArticleTitle>${extra}<AuthorList CompleteYN="Y"><Author ValidYN="Y"><LastName>Ali</LastName><ForeName>Sharib</ForeName><Initials>S</Initials><AffiliationInfo><Affiliation>Big Data Institute, Oxford.</Affiliation></AffiliationInfo></Author><Author ValidYN="Y"><CollectiveName>TGU Investigators</CollectiveName><AffiliationInfo><Affiliation>Translational Gastroenterology Unit, Oxford.</Affiliation></AffiliationInfo></Author><Author ValidYN="Y"><CollectiveName>Steering Committee</CollectiveName></Author></AuthorList><PublicationTypeList><PublicationType UI="D016428">Journal Article</PublicationType></PublicationTypeList></Article></MedlineCitation><PubmedData><ArticleIdList><ArticleId IdType="pubmed">${pmid}</ArticleId><ArticleId IdType="doi">10.1/x.${pmid}</ArticleId></ArticleIdList></PubmedData></PubmedArticle>`;
}

const GRANTS = `<GrantList CompleteYN="Y"><Grant><Acronym>DH_</Acronym><Agency>Department of Health</Agency><Country>United Kingdom</Country></Grant><Grant><GrantID>206314/Z/17/Z</GrantID><Acronym>WT_</Acronym><Agency>Wellcome Trust</Agency><Country>United Kingdom</Country></Grant><Grant><GrantID>R01 CA1</GrantID><Agency>NCI NIH HHS</Agency><Country>United States</Country></Grant><Grant><Agency>Example Foundation</Agency></Grant></GrantList>`;

/** Volume and date, no Issue and no Pagination. */
const NO_ISSUE = record(
  '31844417',
  '<ISSN IssnType="Electronic">1689-1392</ISSN><JournalIssue CitedMedium="Internet"><Volume>24</Volume><PubDate><Year>2019</Year></PubDate></JournalIssue><Title>Cellular &amp; molecular biology letters</Title><ISOAbbreviation>Cell Mol Biol Lett</ISOAbbreviation>',
  GRANTS,
);
/** A title and a date only: no ISOAbbreviation, Volume, Issue or Pagination. */
const TITLE_ONLY = record(
  '40000001',
  '<JournalIssue CitedMedium="Internet"><PubDate><Year>2020</Year></PubDate></JournalIssue><Title>Journal of Examples</Title>',
);
/** Every journal field present. */
const FULL = record(
  '40000002',
  '<ISSN IssnType="Print">0016-5085</ISSN><JournalIssue CitedMedium="Internet"><Volume>161</Volume><Issue>3</Issue><PubDate><Year>2021</Year><Month>Sep</Month></PubDate></JournalIssue><Title>Gastroenterology</Title><ISOAbbreviation>Gastroenterology</ISOAbbreviation>',
  '<Pagination><StartPage>865</StartPage><MedlinePgn>865-878.e8</MedlinePgn></Pagination>',
);

interface ArticleOut {
  affiliations?: string[];
  authors: Record<string, unknown>[];
  grantList?: Record<string, unknown>[];
  investigators?: Record<string, unknown>[];
  journalInfo?: Record<string, unknown>;
}

function stage(...records: string[]) {
  mockEFetch.mockResolvedValue({ PubmedArticleSet: parseArticleSetXml(articleSetXml(...records)) });
}

async function fetchArticles(pmid: string, extra: Record<string, unknown> = {}) {
  const result = await runToolContract(fetchArticlesTool, {
    pmids: [pmid],
    includeGrants: true,
    ...extra,
  });
  expect(result.isError).toBeFalsy();
  const [article] = (result.structuredContent as { articles: ArticleOut[] }).articles;
  if (!article) throw new Error('no article returned');
  const text = result.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('\n');
  return { article, text };
}

async function cite(pmid: string) {
  const result = await runToolContract(formatCitationsTool, {
    pmids: [pmid],
    format: ['vancouver', 'ris'],
  });
  expect(result.isError).toBeFalsy();
  const [entry] = (
    result.structuredContent as { citations: { citations: Record<string, string> }[] }
  ).citations;
  if (!entry) throw new Error('no citation returned');
  const text = result.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('\n');
  return { citations: entry.citations, text };
}

beforeEach(() => {
  mockEFetch.mockReset();
});

describe("a collective author's own affiliation (#212)", () => {
  it('points the collective at its affiliation on both surfaces', async () => {
    stage(NO_ISSUE);
    const { article, text } = await fetchArticles('31844417');
    expect(article.affiliations).toEqual([
      'Big Data Institute, Oxford.',
      'Translational Gastroenterology Unit, Oxford.',
    ]);
    expect(article.authors[1]).toStrictEqual({
      collectiveName: 'TGU Investigators',
      affiliationIndices: [1],
    });
    expect(text).toContain('- TGU Investigators (collective) [aff 1]\n');
    expect(text).toContain('- [1] Translational Gastroenterology Unit, Oxford.');
  });

  it('leaves a collective with no affiliation, and a person, unchanged', async () => {
    stage(NO_ISSUE);
    const { article, text } = await fetchArticles('31844417');
    expect(article.authors[0]).toStrictEqual({
      lastName: 'Ali',
      firstName: 'Sharib',
      initials: 'S',
      affiliationIndices: [0],
    });
    expect(article.authors[2]).toStrictEqual({ collectiveName: 'Steering Committee' });
    expect(text).toContain('- Sharib Ali (S) [aff 0]\n');
    expect(text).toContain('- Steering Committee (collective)\n');
  });
});

describe("a collective author's investigators (#216)", () => {
  /** {@link NO_ISSUE} with one investigator who shares the collective's affiliation. */
  const WITH_INVESTIGATOR = NO_ISSUE.replace(
    '</Article>',
    '</Article><InvestigatorList><Investigator ValidYN="Y"><LastName>Allan</LastName><ForeName>Philip</ForeName><Initials>P</Initials><AffiliationInfo><Affiliation>Translational Gastroenterology Unit, Oxford.</Affiliation></AffiliationInfo></Investigator></InvestigatorList>',
  );

  it("points the investigator at the collective's affiliation without renumbering it", async () => {
    stage(WITH_INVESTIGATOR);
    const { article, text } = await fetchArticles('31844417', { includeInvestigators: true });
    expect(article.affiliations).toEqual([
      'Big Data Institute, Oxford.',
      'Translational Gastroenterology Unit, Oxford.',
    ]);
    expect(article.authors[1]).toStrictEqual({
      collectiveName: 'TGU Investigators',
      affiliationIndices: [1],
    });
    expect(article.investigators).toStrictEqual([
      { lastName: 'Allan', firstName: 'Philip', initials: 'P', affiliationIndices: [1] },
    ]);
    expect(text).toContain(
      '- Steering Committee (collective)\n\n**Investigators (1):**\n- Philip Allan (P) [aff 1]\n\n**Affiliations:**\n',
    );
  });

  it('never lists an investigator in a citation', async () => {
    stage(WITH_INVESTIGATOR);
    const { citations } = await cite('31844417');
    expect(citations.vancouver).toBe(
      'Ali S, TGU Investigators, Steering Committee. A Pilot Study. Cell Mol Biol Lett. 2019;24. doi: 10.1/x.31844417',
    );
    expect(citations.ris).not.toContain('Allan');
  });
});

describe('journal fields the record does not carry (#213)', () => {
  it('omits issue and pages when the record has neither', async () => {
    stage(NO_ISSUE);
    const { article, text } = await fetchArticles('31844417');
    expect(article.journalInfo).toStrictEqual({
      title: 'Cellular & molecular biology letters',
      isoAbbreviation: 'Cell Mol Biol Lett',
      eIssn: '1689-1392',
      volume: '24',
      publicationDate: { year: '2019' },
    });
    expect(text).toContain(
      '**Journal:** Cellular & molecular biology letters, (Cell Mol Biol Lett), 2019, **24**, eISSN 1689-1392\n',
    );
  });

  it('omits every field a title-only record lacks', async () => {
    stage(TITLE_ONLY);
    const { article, text } = await fetchArticles('40000001');
    expect(article.journalInfo).toStrictEqual({
      title: 'Journal of Examples',
      publicationDate: { year: '2020' },
    });
    expect(text).toContain('**Journal:** Journal of Examples, 2020\n');
  });

  it('keeps a record that carries every field unchanged', async () => {
    stage(FULL);
    const { article, text } = await fetchArticles('40000002');
    expect(article.journalInfo).toStrictEqual({
      title: 'Gastroenterology',
      isoAbbreviation: 'Gastroenterology',
      issn: '0016-5085',
      volume: '161',
      issue: '3',
      pages: '865-878.e8',
      publicationDate: { year: '2021', month: 'Sep' },
    });
    expect(text).toContain(
      '**Journal:** Gastroenterology, 2021 Sep, **161**(3), 865-878.e8, ISSN 0016-5085\n',
    );
  });

  it('leaves a citation with no issue unchanged', async () => {
    stage(NO_ISSUE);
    const { citations } = await cite('31844417');
    expect(citations.vancouver).toBe(
      'Ali S, TGU Investigators, Steering Committee. A Pilot Study. Cell Mol Biol Lett. 2019;24. doi: 10.1/x.31844417',
    );
    expect(citations.ris).toContain('VL  - 24\n');
    expect(citations.ris).not.toContain('IS  -');
    expect(citations.ris).not.toContain('SP  -');
  });

  it('cites the full journal title where the record has no ISO abbreviation', async () => {
    stage(TITLE_ONLY);
    const { citations, text } = await cite('40000001');
    expect(citations.vancouver).toBe(
      'Ali S, TGU Investigators, Steering Committee. A Pilot Study. Journal of Examples. 2020. doi: 10.1/x.40000001',
    );
    expect(text).toContain('Journal of Examples. 2020.');
    expect(citations.ris).toContain('JF  - Journal of Examples\n');
    expect(citations.ris).not.toContain('JO  -');
  });
});

describe('a grant with no GrantID (#214)', () => {
  it('labels the acronym after the agency instead of in the ID slot', async () => {
    stage(NO_ISSUE);
    const { article, text } = await fetchArticles('31844417');
    expect(article.grantList?.[0]).toStrictEqual({
      acronym: 'DH_',
      agency: 'Department of Health',
      country: 'United Kingdom',
    });
    expect(text).toContain('- Department of Health (DH_) — United Kingdom\n');
    expect(text).not.toContain('- DH_ —');
  });

  it('renders grants with a GrantID, and one with neither ID nor acronym, unchanged', async () => {
    stage(NO_ISSUE);
    const { text } = await fetchArticles('31844417');
    const grants = text.slice(text.indexOf('#### Grants'));
    expect(grants).toBe(
      [
        '#### Grants',
        '- Department of Health (DH_) — United Kingdom',
        '- 206314/Z/17/Z (WT_) — Wellcome Trust — United Kingdom',
        '- R01 CA1 — NCI NIH HHS — United States',
        '- Example Foundation',
      ].join('\n'),
    );
  });
});

describe('databank accessions (#257)', () => {
  /** {@link FULL} with `banks` as its DataBankList. */
  const withBanks = (pmid: string, banks: string) =>
    record(
      pmid,
      '<ISSN IssnType="Print">0016-5085</ISSN><JournalIssue CitedMedium="Internet"><Volume>161</Volume><Issue>3</Issue><PubDate><Year>2021</Year></PubDate></JournalIssue><Title>Gastroenterology</Title>',
      `<Pagination><MedlinePgn>865-878.e8</MedlinePgn></Pagination><DataBankList CompleteYN="Y">${banks}</DataBankList>`,
    );
  const TRIAL = withBanks(
    '36857477',
    '<DataBank><DataBankName>ClinicalTrials.gov</DataBankName><AccessionNumberList><AccessionNumber>NCT03951753</AccessionNumber></AccessionNumberList></DataBank>',
  );
  const MIXED = withBanks(
    '40000003',
    '<DataBank><DataBankName>OMIM</DataBankName><AccessionNumberList><AccessionNumber>300460</AccessionNumber><AccessionNumber>0123</AccessionNumber></AccessionNumberList></DataBank><DataBank><DataBankName>figshare</DataBankName></DataBank><DataBank><DataBankName>PDB</DataBankName><AccessionNumberList><AccessionNumber>9TUW (RP.012-bound PfRIPR)</AccessionNumber></AccessionNumberList></DataBank>',
  );
  const GENBANK_ACCESSIONS = Array.from({ length: 1000 }, (_, i) => `BB${751502 + i}`);
  const LONG = withBanks(
    '15782199',
    `<DataBank><DataBankName>GENBANK</DataBankName><AccessionNumberList>${GENBANK_ACCESSIONS.map((a) => `<AccessionNumber>${a}</AccessionNumber>`).join('')}</AccessionNumberList></DataBank>`,
  );

  it('returns the trial registration on both surfaces', async () => {
    stage(TRIAL);
    const { article, text } = await fetchArticles('36857477');
    expect((article as { dataBanks?: unknown }).dataBanks).toStrictEqual([
      { name: 'ClinicalTrials.gov', accessionNumbers: ['NCT03951753'] },
    ]);
    expect(text).toContain('#### Data Banks\n');
    expect(text).toContain('- **ClinicalTrials.gov:** NCT03951753');
    expect(text).toContain('`<accession>[si]`');
  });

  it('renders every bank and accession verbatim, a bank with none included', async () => {
    stage(MIXED);
    const { article, text } = await fetchArticles('40000003');
    expect((article as { dataBanks?: unknown }).dataBanks).toStrictEqual([
      { name: 'OMIM', accessionNumbers: ['300460', '0123'] },
      { name: 'figshare' },
      { name: 'PDB', accessionNumbers: ['9TUW (RP.012-bound PfRIPR)'] },
    ]);
    const section = text.slice(text.indexOf('#### Data Banks'));
    expect(section).toContain(
      '- **OMIM:** 300460, 0123\n- **figshare**\n- **PDB:** 9TUW (RP.012-bound PfRIPR)',
    );
  });

  it('renders all 1,000 accessions of a long list', async () => {
    stage(LONG);
    const { article, text } = await fetchArticles('15782199');
    const [bank] = (article as { dataBanks?: { accessionNumbers?: string[] }[] }).dataBanks ?? [];
    expect(bank?.accessionNumbers).toHaveLength(1000);
    expect(text).toContain(`- **GENBANK:** ${GENBANK_ACCESSIONS.join(', ')}`);
  });

  it('has no dataBanks key, and no Data Banks section, for a record without a DataBankList', async () => {
    stage(FULL);
    const { article, text } = await fetchArticles('40000002');
    expect(article).not.toHaveProperty('dataBanks');
    expect(text).not.toContain('Data Banks');
  });

  it('counts dataBanks in the maxResponseCharacters size of its article', async () => {
    stage(LONG);
    const { article } = await fetchArticles('15782199');
    const result = await runToolContract(fetchArticlesTool, {
      pmids: ['15782199'],
      includeGrants: true,
      maxResponseCharacters: 1,
    });
    const { deferred } = result.structuredContent as {
      deferred: { nextDeferredCharacters: number };
    };
    expect(deferred.nextDeferredCharacters).toBe(JSON.stringify(article).length);
    expect(deferred.nextDeferredCharacters).toBeGreaterThan(GENBANK_ACCESSIONS.join('","').length);
  });
});

describe('the journal linking ISSN (#253)', () => {
  /** {@link NO_ISSUE} — electronic ISSN 1689-1392 — with ISSN-L 1425-8153. */
  const LINKED = NO_ISSUE.replace(
    '</Article>',
    '</Article><MedlineJournalInfo><Country>England</Country><MedlineTA>Cell Mol Biol Lett</MedlineTA><NlmUniqueID>9607427</NlmUniqueID><ISSNLinking>1425-8153</ISSNLinking></MedlineJournalInfo>',
  );

  it('cites ISSN-L in BibTeX and RIS', async () => {
    stage(LINKED);
    const result = await runToolContract(formatCitationsTool, {
      pmids: ['31844417'],
      format: ['bibtex', 'ris'],
    });
    const [entry] = (
      result.structuredContent as { citations: { citations: Record<string, string> }[] }
    ).citations;
    expect(entry?.citations.bibtex).toMatch(/^ {2}issn\s+= \{1425-8153\},$/m);
    expect(entry?.citations.ris).toContain('\nSN  - 1425-8153\n');
    expect(entry?.citations.ris).not.toContain('1689-1392');
  });

  it('keeps the pubmed_fetch_articles record, and its measured size, unchanged', async () => {
    stage(LINKED);
    const { article, text } = await fetchArticles('31844417');
    expect(article.journalInfo).toStrictEqual({
      title: 'Cellular & molecular biology letters',
      isoAbbreviation: 'Cell Mol Biol Lett',
      eIssn: '1689-1392',
      volume: '24',
      publicationDate: { year: '2019' },
    });
    expect(text).not.toContain('1425-8153');
    const budgeted = await runToolContract(fetchArticlesTool, {
      pmids: ['31844417'],
      includeGrants: true,
      maxResponseCharacters: 1,
    });
    const { deferred } = budgeted.structuredContent as {
      deferred: { nextDeferredCharacters: number };
    };
    expect(deferred.nextDeferredCharacters).toBe(JSON.stringify(article).length);
  });
});

describe('text NCBI double-encodes (#255)', () => {
  interface DecodedOut extends ArticleOut {
    abstractText?: string;
    keywords?: string[];
    title?: string;
  }

  it('returns R&D in the abstract on both surfaces (PMID 30893882)', async () => {
    stage(R_AND_D_ABSTRACT_XML);
    const { article, text } = await fetchArticles('30893882');
    expect((article as DecodedOut).abstractText).toContain(
      'several research and development (R&D) programs have been led',
    );
    expect(text).toContain('several research and development (R&D) programs have been led');
    expect(text).not.toContain('&amp;');
  });

  it("returns Parkinson's and P < 0.001 on both surfaces (PMID 42138044)", async () => {
    stage(APOS_TITLE_XML);
    const { article, text } = await fetchArticles('42138044');
    const out = article as DecodedOut;
    expect(out.title).toBe(
      "Cervical Vestibular-Evoked Myogenic Potentials (cVEMPs) in Parkinson's Disease Patients: Prospective, Case-Control study.",
    );
    expect(out.abstractText).toContain('difference (P < 0.001) was found');
    expect(text).toContain("in Parkinson's Disease Patients");
    expect(text).toContain('difference (P < 0.001) was found');
    expect(text).not.toMatch(/&(?:amp;)?(?:apos|lt);/);
  });

  it('returns R&D as a keyword and an affiliation on both surfaces', async () => {
    stage(R_AND_D_KEYWORD_XML);
    const keyword = await fetchArticles('35945103');
    expect((keyword.article as DecodedOut).keywords).toContain('R&D');
    expect(keyword.text).toMatch(/\bR&D\b.*\badvanced therapy medicinal products/);

    stage(R_AND_D_AFFILIATION_XML);
    const affiliation = await fetchArticles('35796717');
    expect(affiliation.article.affiliations?.[2]).toBe(
      'Biologics Engineering, R&D, AstraZeneca, Cambridge, UK.',
    );
    expect(affiliation.text).toContain(
      '- [2] Biologics Engineering, R&D, AstraZeneca, Cambridge, UK.',
    );
  });

  it('cites the decoded title and keyword', async () => {
    stage(APOS_TITLE_XML);
    const title = await cite('42138044');
    expect(title.citations.vancouver).toContain(
      "Myogenic Potentials (cVEMPs) in Parkinson's Disease Patients: Prospective, Case-Control study. Otolaryngol Pol.",
    );
    expect(title.citations.ris).toContain(
      "\nTI  - Cervical Vestibular-Evoked Myogenic Potentials (cVEMPs) in Parkinson's Disease Patients: Prospective, Case-Control study\n",
    );
    expect(title.text).toContain("in Parkinson's Disease Patients");

    stage(R_AND_D_KEYWORD_XML);
    const keyword = await cite('35945103');
    expect(keyword.citations.ris).toContain('\nKW  - R&D\n');
    expect(keyword.citations.ris).not.toContain('&amp;');
  });

  it('escapes the decoded ampersand for BibTeX', async () => {
    stage(R_AND_D_KEYWORD_XML);
    const result = await runToolContract(formatCitationsTool, {
      pmids: ['35945103'],
      format: ['bibtex'],
    });
    const [entry] = (
      result.structuredContent as { citations: { citations: Record<string, string> }[] }
    ).citations;
    expect(entry?.citations.bibtex).toContain('R\\&D');
    expect(entry?.citations.bibtex).not.toContain('&amp;');
  });
});
