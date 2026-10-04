/**
 * @fileoverview Every corpus fixture is well-formed: a `meta.json` naming its own
 * directory, EFetch URL and an open license its `source.xml` states; a source of
 * reviewable size for the PMC ID it claims; `expect.json` and `expected.md` beside
 * it; and an `ATTRIBUTION.md` in step with every `meta.json`.
 * @module tests/corpus/meta.test
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ATTRIBUTION_PATH, renderAttribution } from './attribution.js';
import { efetchUrl, fixtureMetaSchema, listFixtures } from './fixtures.js';
import { listPubmedFixtures, pubmedFixtureMetaSchema } from './pubmed-fixtures.js';

const MAX_SOURCE_BYTES = 1024 * 1024;
const fixtures = listFixtures();

describe('corpus fixtures', () => {
  it('exist', () => {
    expect(fixtures.length).toBeGreaterThan(0);
  });

  it('are credited in ATTRIBUTION.md exactly as their meta.json files render', () => {
    const metas = fixtures.map((f) => fixtureMetaSchema.parse(f.meta));
    const pubmedMetas = listPubmedFixtures().map((f) => pubmedFixtureMetaSchema.parse(f.meta));
    expect(readFileSync(ATTRIBUTION_PATH, 'utf8')).toBe(renderAttribution(metas, pubmedMetas));
  });
});

describe.each(fixtures)('corpus/pmc/$name', (fixture) => {
  it('has a meta.json naming its directory, EFetch URL, and an open license its source states', () => {
    const result = fixtureMetaSchema.safeParse(fixture.meta);
    expect(result.error?.issues ?? []).toEqual([]);
    const meta = fixtureMetaSchema.parse(fixture.meta);
    expect(meta.id).toBe(fixture.name);
    expect(meta.identifiers.pmcid).toBe(`PMC${fixture.numericId}`);
    expect(meta.url).toBe(efetchUrl(fixture.numericId));
    const licensePath = meta.license.url.replace(/^https:\/\//, '').replace(/\/$/, '');
    expect(readFileSync(fixture.sourcePath, 'utf8')).toContain(licensePath);
  });

  it('has a source of reviewable size for the PMC ID it claims', () => {
    expect(existsSync(fixture.sourcePath)).toBe(true);
    const { size } = statSync(fixture.sourcePath);
    expect(size).toBeGreaterThan(0);
    expect(size).toBeLessThanOrEqual(MAX_SOURCE_BYTES);
    expect(readFileSync(fixture.sourcePath, 'utf8')).toContain(
      `<article-id pub-id-type="pmcid">PMC${fixture.numericId}</article-id>`,
    );
  });

  it('has expect.json and expected.md', () => {
    expect(existsSync(join(fixture.dir, 'expect.json'))).toBe(true);
    expect(existsSync(join(fixture.dir, 'expected.md'))).toBe(true);
  });
});
