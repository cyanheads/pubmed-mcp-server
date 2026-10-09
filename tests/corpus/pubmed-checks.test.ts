/**
 * @fileoverview The PubMed corpus checks can fail. One real fixture (pmid34116029:
 * collective author and its investigators, structured abstract, MeSH, grants, a
 * notice) is run through the tools once; each case then changes the source the output
 * is judged against, the output itself, or one `expect.json` pin, and the change must
 * surface as the named problem. A check that stayed silent here would pass any output.
 * @module tests/corpus/pubmed-checks.test
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { checkPubmedExpect, type PubmedExpect, pubmedExpectSchema } from './pubmed-expect.js';
import { listPubmedFixtures } from './pubmed-fixtures.js';
import {
  checkPubmedInvariants,
  type PubmedCorpusArticle,
  type PubmedCorpusCitation,
  type PubmedInvariantInput,
} from './pubmed-invariants.js';
import { callFetchArticles, callFormatCitations, loadPubmedTools } from './pubmed-run-tools.js';
import { renderedText, structuredStrings, stubEfetch } from './run-tool.js';

const fixture = listPubmedFixtures().find((f) => f.name === 'pmid34116029');
if (!fixture) throw new Error('pmid34116029 fixture missing');

let input: PubmedInvariantInput;
let pins: PubmedExpect;
let surfaces: string[];

beforeAll(async () => {
  const tools = await loadPubmedTools();
  const bytes = new Uint8Array(readFileSync(fixture.sourcePath));
  stubEfetch(fixture.pmid, bytes, 'pubmed');
  const articles = await callFetchArticles(tools, fixture.pmid);
  const citations = await callFormatCitations(tools, fixture.pmid);
  const article = (articles.structuredContent as { articles: PubmedCorpusArticle[] }).articles[0];
  const citation = (citations.structuredContent as { citations: PubmedCorpusCitation[] })
    .citations[0];
  if (!article || !citation) throw new Error('no record returned');
  input = {
    article,
    articleSurfaces: {
      strings: structuredStrings(articles.structuredContent),
      text: renderedText(articles),
    },
    citation,
    citationSurfaces: {
      strings: structuredStrings(citations.structuredContent),
      text: renderedText(citations),
    },
    source: new TextDecoder().decode(bytes),
  };
  pins = pubmedExpectSchema.parse(
    JSON.parse(readFileSync(join(fixture.dir, 'expect.json'), 'utf8')),
  );
  surfaces = [input.articleSurfaces.text, input.citationSurfaces.text];
});

afterAll(() => {
  vi.unstubAllGlobals();
});

describe('PubMed corpus invariants', () => {
  it('report exactly the known problems on the unchanged fixture', () => {
    expect(checkPubmedInvariants(input)).toEqual(pins.knownProblems);
  });

  it.each([
    [
      'a GrantID that lost its leading zero',
      (s: string) => s.replace('<GrantID>29021</GrantID>', '<GrantID>029021</GrantID>'),
      'grant 3 grantId is "029021" in the source, "29021" returned',
    ],
    [
      'a volume that lost its leading zero',
      (s: string) => s.replace('<Volume>161</Volume>', '<Volume>0161</Volume>'),
      'journal volume is "0161" in the source, "161" returned',
    ],
    [
      'an abstract word the output does not hold',
      (s: string) => s.replace('highly operator dependent.', 'highly operator dependent today.'),
      'abstract not read in content[]: "operator dependent ‸ today We"',
    ],
    [
      'a title word the output does not hold',
      (s: string) => s.replace('A Pilot Study on', 'A Small Pilot Study on'),
      'title does not read as the source\'s: "A ‸ Small Pilot"',
    ],
    [
      'a MeSH heading the output lacks',
      (s: string) =>
        s.replace(
          '</MeshHeadingList>',
          '<MeshHeading><DescriptorName UI="D000001" MajorTopicYN="N">Calcimycin</DescriptorName></MeshHeading></MeshHeadingList>',
        ),
      '21 MeSH headings in the source, 20 returned',
    ],
    [
      'a starred qualifier the output leaves unstarred',
      (s: string) =>
        s.replace(
          '<QualifierName UI="Q000145" MajorTopicYN="N">classification',
          '<QualifierName UI="Q000145" MajorTopicYN="Y">classification',
        ),
      'MeSH 2 qualifiers is [["classification","Q000145",true],["pathology","Q000473",true],["therapy","Q000628",false]] in the source, [["classification","Q000145",false],["pathology","Q000473",true],["therapy","Q000628",false]] returned',
    ],
    [
      'a second linked notice',
      (s: string) =>
        s.replace(
          '</CommentsCorrectionsList>',
          '<CommentsCorrections RefType="ErratumIn"><RefSource>Gastroenterology. 2022.</RefSource></CommentsCorrections></CommentsCorrectionsList>',
        ),
      '2 linked notices in the source, 1 returned',
    ],
    [
      'a different DOI',
      (s: string) => s.replaceAll('10.1053/j.gastro.2021.05.059', '10.1053/j.gastro.2021.05.060'),
      'apa: no DOI',
    ],
    [
      'a different author surname',
      (s: string) => s.replace('<LastName>Ali</LastName>', '<LastName>Alli</LastName>'),
      'author 0 lastName is "Alli" in the source, "Ali" returned',
    ],
    [
      'a different investigator surname',
      (s: string) => s.replace('<LastName>Allan</LastName>', '<LastName>Allen</LastName>'),
      'investigator 0 lastName is "Allen" in the source, "Allan" returned',
    ],
    [
      'an investigator the output lacks',
      (s: string) =>
        s.replace(
          '</InvestigatorList>',
          '<Investigator ValidYN="Y"><LastName>Zhou</LastName><ForeName>Wei</ForeName><Initials>W</Initials></Investigator></InvestigatorList>',
        ),
      '23 investigators in the source, 22 returned',
    ],
    [
      'an investigator affiliation the output lacks',
      (s: string) =>
        s.replace(
          '<Initials>P</Initials></Investigator>',
          '<Initials>P</Initials><AffiliationInfo><Affiliation>Kennedy Institute, Oxford.</Affiliation></AffiliationInfo></Investigator>',
        ),
      'investigator 0 affiliations is ["Kennedy Institute, Oxford."] in the source, [] returned',
    ],
  ])('flag %s', (_case, mutate, problem) => {
    expect(checkPubmedInvariants({ ...input, source: mutate(input.source) })).toContain(problem);
  });

  it('flag a tag and an entity left in the output', () => {
    const text = `${input.articleSurfaces.text}\nC&amp;M cm<sup>2</sup>`;
    const problems = checkPubmedInvariants({
      ...input,
      articleSurfaces: { ...input.articleSurfaces, text },
    });
    expect(problems).toContain(
      'pubmed_fetch_articles: leaked XML tag at content[]: "<sup>2</sup>"',
    );
    expect(problems).toContain('pubmed_fetch_articles: undecoded entity at content[]: "&amp;"');
  });
});

describe('PubMed expect.json pins', () => {
  it('hold on the unchanged fixture', () => {
    expect(
      checkPubmedExpect(pins, input.article, input.citation, input.articleSurfaces.text, surfaces),
    ).toEqual([]);
  });

  it.each([
    ['title', { title: 'A Pilot Study.' }],
    ['abstractLabels', { abstractLabels: ['BACKGROUND', 'METHODS', 'RESULTS', 'CONCLUSIONS'] }],
    ['authors', { authors: 9 }],
    ['collectiveNames', { collectiveNames: ['TGU Investigator'] }],
    ['orcids', { orcids: ['0000-0000-0000-0000'] }],
    ['affiliations', { affiliations: 8 }],
    ['journal', { journal: { pages: '865-878' } }],
    ['journal.publicationDate', { journal: { publicationDate: { month: 'Oct' } } }],
    ['doi', { doi: '10.1053/j.gastro.2021.05.060' }],
    ['pmcId', { pmcId: 'PMC7617122' }],
    ['publicationTypes', { publicationTypes: ['Journal Article'] }],
    ['meshMajor', { meshMajor: ['Barrett Esophagus'] }],
    ['grantIds', { grantIds: ['DH_'] }],
    ['commentsCorrections', { commentsCorrections: [{ refType: 'CommentOn', pmid: '34197829' }] }],
    ['articleDates', { articleDates: 'Electronic 2021-06-09' }],
    ['contains', { contains: ['TGU Investigators (group)'] }],
    ['notContains', { notContains: ['TGU Investigators'] }],
    ['citations', { citations: { vancouver: ['Gastroenterology. 2021;161(4)'] } }],
  ] as [string, Partial<PubmedExpect>][])('fail on a wrong %s', (_key, wrong) => {
    const problems = checkPubmedExpect(
      { why: 'mutated', ...wrong },
      input.article,
      input.citation,
      input.articleSurfaces.text,
      surfaces,
    );
    expect(problems).toHaveLength(1);
  });
});
