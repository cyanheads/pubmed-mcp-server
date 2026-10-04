/**
 * @fileoverview Corpus discovery and the `meta.json` schema. Every fixture directory
 * under `tests/corpus/fixtures/pmc/` is loaded through here, so a malformed or
 * unlicensed fixture fails the suite before the tool runs.
 * @module tests/corpus/fixtures
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { z } from '@cyanheads/mcp-ts-core';
import { FEATURES } from './features.js';

export const CORPUS_DIR = resolve(import.meta.dirname);
export const PMC_FIXTURES_DIR = join(CORPUS_DIR, 'fixtures', 'pmc');

/**
 * License IDs a fixture may carry: Creative Commons Attribution and
 * Attribution-ShareAlike at any version, CC0, and the public-domain mark. NC and ND
 * variants, and "open access" with no license URL, stay out of the corpus.
 */
export const OPEN_LICENSE_ID = /^(?:CC-BY(?:-SA)?-\d\.\d|CC0-1\.0|public-domain)$/;

/** The PMC EFetch URL a fixture's `source.xml` was retrieved from. */
export function efetchUrl(numericId: string): string {
  return `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?db=pmc&id=${numericId}&retmode=xml`;
}

export const fixtureMetaSchema = z
  .object({
    id: z.string().regex(/^pmc\d+$/),
    title: z.string().min(1),
    identifiers: z
      .object({
        pmcid: z.string().regex(/^PMC\d+$/),
        pmid: z.string().regex(/^\d+$/).optional(),
        doi: z.string().optional(),
      })
      .strict(),
    url: z.url(),
    retrieved: z.iso.date(),
    license: z.object({ id: z.string().regex(OPEN_LICENSE_ID), url: z.url() }).strict(),
    attribution: z.string().min(1),
    features: z.array(z.enum(FEATURES)),
    regression: z
      .string()
      .regex(/^cyanheads\/pubmed-mcp-server#\d+$/)
      .optional(),
    notes: z.string().optional(),
  })
  .strict();

export type FixtureMeta = z.infer<typeof fixtureMetaSchema>;

export interface Fixture {
  dir: string;
  /** Raw `meta.json` content; the meta suite validates it. */
  meta: unknown;
  /** Directory name: `pmc` plus the numeric PMC ID. */
  name: string;
  /** The numeric part of the PMC ID, as EFetch takes it. */
  numericId: string;
  sourcePath: string;
}

/** Every fixture directory, in a stable order. */
export function listFixtures(): Fixture[] {
  if (!existsSync(PMC_FIXTURES_DIR)) return [];
  return readdirSync(PMC_FIXTURES_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .map((name) => {
      const dir = join(PMC_FIXTURES_DIR, name);
      const metaPath = join(dir, 'meta.json');
      return {
        dir,
        meta: existsSync(metaPath) ? JSON.parse(readFileSync(metaPath, 'utf8')) : undefined,
        name,
        numericId: name.replace(/^pmc/, ''),
        sourcePath: join(dir, 'source.xml'),
      };
    });
}
