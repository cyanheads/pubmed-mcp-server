/**
 * @fileoverview Every corpus fixture through the real `pubmed_fetch_fulltext` PMC path
 * (see `run-tool.ts` for the seam): the tool returns the article from exactly the one
 * EFetch it should make, every invariant and `expect.json` assertion holds, a second
 * call returns the identical result, and `content[]` matches the reviewed snapshot.
 *
 * `PUBMED_CORPUS_UPDATE=1` (`bun run corpus:snapshot`) rewrites `expected.md` instead
 * of comparing. Review every rewritten snapshot against its `source.xml` before
 * committing it.
 * @module tests/corpus/corpus.test
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { type CorpusArticle, checkExpect, fixtureExpectSchema } from './expect.js';
import { listFixtures } from './fixtures.js';
import { checkInvariants } from './invariants.js';
import {
  callFulltext,
  loadFulltextTool,
  renderedText,
  structuredStrings,
  stubEfetch,
} from './run-tool.js';

const UPDATE = process.env.PUBMED_CORPUS_UPDATE === '1';

interface FulltextOutput {
  articles: CorpusArticle[];
  totalReturned: number;
  unavailable?: unknown[];
}

let tool: Awaited<ReturnType<typeof loadFulltextTool>>;

beforeAll(async () => {
  tool = await loadFulltextTool();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe.each(listFixtures())('corpus/pmc/$name', (fixture) => {
  it('returns the article, holds every invariant and assertion, repeats exactly, and matches its snapshot', async () => {
    const bytes = new Uint8Array(readFileSync(fixture.sourcePath));
    const fetches = stubEfetch(fixture.numericId, bytes);

    const result = await callFulltext(tool, fixture.numericId);
    const again = await callFulltext(tool, fixture.numericId);

    expect(fetches.refused).toEqual([]);
    expect(fetches.served).toHaveLength(2);
    expect(result.isError ?? false).toBe(false);
    const output = result.structuredContent as unknown as FulltextOutput;
    expect(output.unavailable).toBeUndefined();
    expect(output.totalReturned).toBe(1);
    const [article] = output.articles;
    if (!article) throw new Error('no article returned');

    const text = renderedText(result);
    const snapshotPath = join(fixture.dir, 'expected.md');
    if (UPDATE) writeFileSync(snapshotPath, `${text}\n`);

    const strings = structuredStrings(result.structuredContent);
    const assertions = fixtureExpectSchema.parse(
      JSON.parse(readFileSync(join(fixture.dir, 'expect.json'), 'utf8')),
    );
    const invariantProblems = checkInvariants({
      article,
      source: new TextDecoder().decode(bytes),
      strings,
      tablesOverride: assertions.tables,
      text,
    });
    const known = assertions.knownProblems ?? [];
    const problems = [
      ...invariantProblems.filter((problem) => !known.includes(problem)),
      ...known
        .filter((problem) => !invariantProblems.includes(problem))
        .map(
          (problem) => `known problem no longer occurs — remove it from expect.json: ${problem}`,
        ),
      ...checkExpect(
        assertions,
        article,
        text,
        strings.map((s) => s.value),
      ),
    ];
    expect(problems).toEqual([]);

    expect(again).toEqual(result);

    expect(
      existsSync(snapshotPath),
      'no expected.md: run `bun run corpus:snapshot` and review it',
    ).toBe(true);
    expect(`${text}\n`).toBe(readFileSync(snapshotPath, 'utf8'));
  }, 60_000);
});
