/**
 * @fileoverview Every PubMed-record fixture through the real `pubmed_fetch_articles`
 * and `pubmed_format_citations` tools (see `pubmed-run-tools.ts` for the seam): both
 * return the record from exactly the EFetches they should make, every invariant and
 * `expect.json` assertion holds, a second call of each returns the identical result,
 * and both tools' `content[]` match the reviewed snapshot.
 *
 * `PUBMED_CORPUS_UPDATE=1` (`bun run corpus:snapshot`) rewrites `expected.md` instead
 * of comparing. Review every rewritten snapshot against its `source.xml` before
 * committing it.
 * @module tests/corpus/pubmed-corpus.test
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { checkPubmedExpect, pubmedExpectSchema } from './pubmed-expect.js';
import { listPubmedFixtures } from './pubmed-fixtures.js';
import {
  checkPubmedInvariants,
  type PubmedCorpusArticle,
  type PubmedCorpusCitation,
} from './pubmed-invariants.js';
import {
  CITATION_STYLES,
  callFetchArticles,
  callFormatCitations,
  loadPubmedTools,
  type PubmedTools,
  renderPubmedSnapshot,
} from './pubmed-run-tools.js';
import { renderedText, structuredStrings, stubEfetch } from './run-tool.js';

const UPDATE = process.env.PUBMED_CORPUS_UPDATE === '1';

interface FetchArticlesOutput {
  articles: PubmedCorpusArticle[];
  totalReturned: number;
  unavailablePmids?: string[];
}

interface FormatCitationsOutput {
  citations: PubmedCorpusCitation[];
  totalFormatted: number;
  totalSubmitted: number;
  unavailablePmids?: string[];
}

let tools: PubmedTools;

beforeAll(async () => {
  tools = await loadPubmedTools();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe.each(listPubmedFixtures())('corpus/pubmed/$name', (fixture) => {
  it('returns the record from both tools, holds every invariant and assertion, repeats exactly, and matches its snapshot', async () => {
    const bytes = new Uint8Array(readFileSync(fixture.sourcePath));
    const fetches = stubEfetch(fixture.pmid, bytes, 'pubmed');

    const articles = await callFetchArticles(tools, fixture.pmid);
    const articlesAgain = await callFetchArticles(tools, fixture.pmid);
    const citations = await callFormatCitations(tools, fixture.pmid);
    const citationsAgain = await callFormatCitations(tools, fixture.pmid);

    expect(fetches.refused).toEqual([]);
    expect(fetches.served).toHaveLength(4);
    expect(articles.isError ?? false).toBe(false);
    expect(citations.isError ?? false).toBe(false);
    const articleOutput = articles.structuredContent as unknown as FetchArticlesOutput;
    expect(articleOutput.totalReturned).toBe(1);
    expect(articleOutput.unavailablePmids).toBeUndefined();
    const citationOutput = citations.structuredContent as unknown as FormatCitationsOutput;
    expect(citationOutput.totalFormatted).toBe(1);
    expect(citationOutput.unavailablePmids).toBeUndefined();
    const [article] = articleOutput.articles;
    const [citation] = citationOutput.citations;
    if (!article || !citation) throw new Error('no record returned');
    expect(article.recordType).toBe('journal-article');
    expect(Object.keys(citation.citations)).toEqual([...CITATION_STYLES]);

    const snapshot = renderPubmedSnapshot(fixture.pmid, articles, citations);
    const snapshotPath = join(fixture.dir, 'expected.md');
    if (UPDATE) writeFileSync(snapshotPath, snapshot);

    const articleSurfaces = {
      strings: structuredStrings(articles.structuredContent),
      text: renderedText(articles),
    };
    const citationSurfaces = {
      strings: structuredStrings(citations.structuredContent),
      text: renderedText(citations),
    };
    const assertions = pubmedExpectSchema.parse(
      JSON.parse(readFileSync(join(fixture.dir, 'expect.json'), 'utf8')),
    );
    const invariantProblems = checkPubmedInvariants({
      article,
      articleSurfaces,
      citation,
      citationSurfaces,
      source: new TextDecoder().decode(bytes),
    });
    const known = assertions.knownProblems ?? [];
    const problems = [
      ...invariantProblems.filter((problem) => !known.includes(problem)),
      ...known
        .filter((problem) => !invariantProblems.includes(problem))
        .map(
          (problem) => `known problem no longer occurs — remove it from expect.json: ${problem}`,
        ),
      ...checkPubmedExpect(assertions, article, citation, articleSurfaces.text, [
        articleSurfaces.text,
        citationSurfaces.text,
        ...articleSurfaces.strings.map((s) => s.value),
        ...citationSurfaces.strings.map((s) => s.value),
      ]),
    ];
    expect(problems).toEqual([]);

    expect(articlesAgain).toEqual(articles);
    expect(citationsAgain).toEqual(citations);

    expect(
      existsSync(snapshotPath),
      'no expected.md: run `bun run corpus:snapshot` and review it',
    ).toBe(true);
    expect(snapshot).toBe(readFileSync(snapshotPath, 'utf8'));
  }, 60_000);
});
