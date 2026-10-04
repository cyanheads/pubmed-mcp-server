/**
 * @fileoverview The `expect.json` schema — per-fixture assertions for what a fixture
 * exists to prove, each verified against its `source.xml` — and the check that
 * applies them to one `pubmed_fetch_fulltext` result.
 * @module tests/corpus/expect
 */
import { z } from '@cyanheads/mcp-ts-core';

/** The fields of one returned PMC article the corpus reads. */
export interface CorpusArticle {
  abstract?: string;
  affiliations?: string[];
  assets?: { assetType: 'figure' | 'supplementary-material'; caption?: string; label?: string }[];
  authors?: { collectiveName?: string; givenNames?: string; lastName?: string }[];
  references?: { citation: string; id?: string; label?: string }[];
  sections: CorpusSection[];
  tables?: { caption?: string; footnotes?: string; label?: string; rows: string[][] }[];
  title?: string;
}

interface CorpusSection {
  label?: string;
  subsections?: CorpusSection[];
  text: string;
  title?: string;
}

export const fixtureExpectSchema = z
  .object({
    /** What the fixture proves, and why any count differs from what the source suggests. */
    why: z.string().min(1),
    title: z.string().optional(),
    authors: z.number().int().nonnegative().optional(),
    affiliations: z.number().int().nonnegative().optional(),
    /** Table count; set only with a `why` explaining a difference from the source's `<table-wrap>` count. */
    tables: z.number().int().nonnegative().optional(),
    figures: z.number().int().nonnegative().optional(),
    supplements: z.number().int().nonnegative().optional(),
    references: z.number().int().nonnegative().optional(),
    /** The returned `abstract` starts with this. */
    abstractStartsWith: z.string().optional(),
    /** Section and subsection titles that must appear in this order (others may sit between). */
    sectionTitles: z.array(z.string()).optional(),
    /** Substrings `content[]` must contain. */
    contains: z.array(z.string()).optional(),
    /** Substrings no surface may contain: neither `content[]` nor any `structuredContent` string. */
    notContains: z.array(z.string()).optional(),
    /** Substrings some single `structuredContent` string must contain. */
    structuredContains: z.array(z.string()).optional(),
    /**
     * Invariant failures caused by a reported parser defect, quoted exactly as the
     * invariant reports them. Each is tolerated only while it still occurs: once the
     * fix lands, the suite fails until the entry is removed and the snapshot
     * regenerated. Name the defect in `why`.
     */
    knownProblems: z.array(z.string()).optional(),
    /** Exact `structuredContent` cell values: `tables[table].rows[row][column]`. */
    cells: z
      .array(
        z
          .object({
            table: z.number().int().nonnegative(),
            row: z.number().int().nonnegative(),
            column: z.number().int().nonnegative(),
            text: z.string(),
          })
          .strict(),
      )
      .optional(),
  })
  .strict();

export type FixtureExpect = z.infer<typeof fixtureExpectSchema>;

/** Section and subsection titles in document order, at every depth the output carries. */
export function sectionTitles(sections: readonly CorpusSection[]): string[] {
  return sections.flatMap((section) => [
    ...(section.title ? [section.title] : []),
    ...sectionTitles(section.subsections ?? []),
  ]);
}

/** Assertions the result fails; empty when every one holds. */
export function checkExpect(
  expect: FixtureExpect,
  article: CorpusArticle,
  text: string,
  strings: readonly string[],
): string[] {
  const problems: string[] = [];
  const equal = (name: string, actual: unknown, wanted: unknown) => {
    if (wanted !== undefined && actual !== wanted) {
      problems.push(`${name}: expected ${String(wanted)}, got ${String(actual)}`);
    }
  };
  const assets = article.assets ?? [];
  equal('title', article.title, expect.title);
  equal('authors', article.authors?.length ?? 0, expect.authors);
  equal('affiliations', article.affiliations?.length ?? 0, expect.affiliations);
  equal('tables', article.tables?.length ?? 0, expect.tables);
  equal('figures', assets.filter((a) => a.assetType === 'figure').length, expect.figures);
  equal('supplements', assets.filter((a) => a.assetType !== 'figure').length, expect.supplements);
  equal('references', article.references?.length ?? 0, expect.references);

  if (expect.abstractStartsWith && !article.abstract?.startsWith(expect.abstractStartsWith)) {
    problems.push(`abstract starts "${article.abstract?.slice(0, 80)}"`);
  }
  if (expect.sectionTitles) {
    const titles = sectionTitles(article.sections);
    let at = 0;
    for (const wanted of expect.sectionTitles) {
      const found = titles.indexOf(wanted, at);
      if (found === -1) {
        problems.push(`section "${wanted}" missing or out of order`);
        break;
      }
      at = found + 1;
    }
  }
  for (const needle of expect.contains ?? []) {
    if (!text.includes(needle)) problems.push(`content[] lacks "${needle}"`);
  }
  for (const needle of expect.notContains ?? []) {
    if (text.includes(needle)) problems.push(`content[] contains "${needle}"`);
    if (strings.some((value) => value.includes(needle))) {
      problems.push(`structuredContent contains "${needle}"`);
    }
  }
  for (const needle of expect.structuredContains ?? []) {
    if (!strings.some((value) => value.includes(needle))) {
      problems.push(`no structuredContent string contains "${needle}"`);
    }
  }
  for (const { table, row, column, text: wanted } of expect.cells ?? []) {
    const actual = article.tables?.[table]?.rows[row]?.[column];
    if (actual !== wanted) {
      problems.push(
        `tables[${table}].rows[${row}][${column}]: expected ${JSON.stringify(wanted)}, got ${JSON.stringify(actual)}`,
      );
    }
  }
  return problems;
}
