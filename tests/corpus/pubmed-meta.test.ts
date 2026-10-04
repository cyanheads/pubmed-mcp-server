/**
 * @fileoverview Every PubMed-record fixture is well-formed: a `meta.json` naming its
 * own directory, EFetch URL, PMCID and the open license that PMC copy states; a source
 * of reviewable size holding exactly the one record it claims; and `expect.json` and
 * `expected.md` beside it. Where the PMC copy is itself a corpus fixture, its
 * `source.xml` must state the recorded license.
 * @module tests/corpus/pubmed-meta.test
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PMC_FIXTURES_DIR } from './fixtures.js';
import { listPubmedFixtures, pubmedEfetchUrl, pubmedFixtureMetaSchema } from './pubmed-fixtures.js';

const MAX_SOURCE_BYTES = 1024 * 1024;
const fixtures = listPubmedFixtures();

describe('PubMed corpus fixtures', () => {
  it('exist', () => {
    expect(fixtures.length).toBeGreaterThan(0);
  });
});

describe.each(fixtures)('corpus/pubmed/$name', (fixture) => {
  it('has a meta.json naming its directory, EFetch URL, PMCID and an open license', () => {
    const result = pubmedFixtureMetaSchema.safeParse(fixture.meta);
    expect(result.error?.issues ?? []).toEqual([]);
    const meta = pubmedFixtureMetaSchema.parse(fixture.meta);
    expect(meta.id).toBe(fixture.name);
    expect(meta.identifiers.pmid).toBe(fixture.pmid);
    expect(meta.url).toBe(pubmedEfetchUrl(fixture.pmid));
  });

  it('holds exactly the one PubmedArticle it claims, with the PMCID and DOI meta.json records', () => {
    const { size } = statSync(fixture.sourcePath);
    expect(size).toBeGreaterThan(0);
    expect(size).toBeLessThanOrEqual(MAX_SOURCE_BYTES);
    const source = readFileSync(fixture.sourcePath, 'utf8');
    const meta = pubmedFixtureMetaSchema.parse(fixture.meta);
    expect(source.match(/<PubmedArticle>/g)).toHaveLength(1);
    expect(source).toContain(`<PMID Version="1">${fixture.pmid}</PMID>`);
    expect(source).toContain(`<ArticleId IdType="pmc">${meta.identifiers.pmcid}</ArticleId>`);
    if (meta.identifiers.doi) {
      expect(source).toContain(`<ArticleId IdType="doi">${meta.identifiers.doi}</ArticleId>`);
    }
  });

  it('states its license in the corpus copy of its PMC article, when there is one', () => {
    const meta = pubmedFixtureMetaSchema.parse(fixture.meta);
    const pmcSource = join(PMC_FIXTURES_DIR, meta.identifiers.pmcid.toLowerCase(), 'source.xml');
    if (!existsSync(pmcSource)) return;
    const licensePath = meta.license.url.replace(/^https:\/\//, '').replace(/\/$/, '');
    expect(readFileSync(pmcSource, 'utf8')).toContain(licensePath);
  });

  it('has expect.json and expected.md', () => {
    expect(existsSync(join(fixture.dir, 'expect.json'))).toBe(true);
    expect(existsSync(join(fixture.dir, 'expected.md'))).toBe(true);
  });
});
