/**
 * @fileoverview PubMed-record corpus discovery and its `meta.json` schema. Every
 * fixture directory under `tests/corpus/fixtures/pubmed/` holds one PubMed EFetch
 * (`db=pubmed`) response for one PMID, stored only when the article's PMC copy
 * states an open license; the license and the PMC EFetch it was read from are
 * recorded here.
 * @module tests/corpus/pubmed-fixtures
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from '@cyanheads/mcp-ts-core';
import { PUBMED_FEATURES } from './features.js';
import { CORPUS_DIR, efetchUrl, OPEN_LICENSE_ID } from './fixtures.js';

export const PUBMED_FIXTURES_DIR = join(CORPUS_DIR, 'fixtures', 'pubmed');

/** The PubMed EFetch URL a fixture's `source.xml` was retrieved from. */
export function pubmedEfetchUrl(pmid: string): string {
  return `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?db=pubmed&id=${pmid}&retmode=xml`;
}

export const pubmedFixtureMetaSchema = z
  .object({
    id: z.string().regex(/^pmid\d+$/),
    title: z.string().min(1),
    identifiers: z
      .object({
        pmid: z.string().regex(/^\d+$/),
        pmcid: z.string().regex(/^PMC\d+$/),
        doi: z.string().optional(),
      })
      .strict(),
    url: z.url(),
    retrieved: z.iso.date(),
    license: z
      .object({
        id: z.string().regex(OPEN_LICENSE_ID),
        url: z.url(),
        /** The PMC EFetch whose `<permissions>` stated the license. */
        source: z.url(),
      })
      .strict(),
    attribution: z.string().min(1),
    features: z.array(z.enum(PUBMED_FEATURES)),
    regression: z
      .string()
      .regex(/^cyanheads\/pubmed-mcp-server#\d+$/)
      .optional(),
    notes: z.string().optional(),
  })
  .strict()
  .refine((meta) => meta.license.source === efetchUrl(meta.identifiers.pmcid.slice(3)), {
    message: 'license.source must be the PMC EFetch URL of identifiers.pmcid',
    path: ['license', 'source'],
  });

export type PubmedFixtureMeta = z.infer<typeof pubmedFixtureMetaSchema>;

export interface PubmedFixture {
  dir: string;
  /** Raw `meta.json` content; the meta suite validates it. */
  meta: unknown;
  /** Directory name: `pmid` plus the PMID. */
  name: string;
  pmid: string;
  sourcePath: string;
}

/** Every PubMed fixture directory, in a stable order. */
export function listPubmedFixtures(): PubmedFixture[] {
  if (!existsSync(PUBMED_FIXTURES_DIR)) return [];
  return readdirSync(PUBMED_FIXTURES_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .map((name) => {
      const dir = join(PUBMED_FIXTURES_DIR, name);
      const metaPath = join(dir, 'meta.json');
      return {
        dir,
        meta: existsSync(metaPath) ? JSON.parse(readFileSync(metaPath, 'utf8')) : undefined,
        name,
        pmid: name.replace(/^pmid/, ''),
        sourcePath: join(dir, 'source.xml'),
      };
    });
}
