/**
 * @fileoverview The PubMed fixtures' `expect.json` schema — per-fixture assertions for
 * what a record exists to prove, each verified against its `source.xml` — and the
 * check that applies them to one `pubmed_fetch_articles` record and its
 * `pubmed_format_citations` entry.
 * @module tests/corpus/pubmed-expect
 */
import { z } from '@cyanheads/mcp-ts-core';
import type { PubmedCorpusArticle, PubmedCorpusCitation } from './pubmed-invariants.js';
import { CITATION_STYLES } from './pubmed-run-tools.js';

const substrings = z.array(z.string().min(1));

export const pubmedExpectSchema = z
  .object({
    /** What the record proves, and why any pin differs from what the source suggests. */
    why: z.string().min(1),
    title: z.string().optional(),
    /** Each `\n\n`-separated abstract paragraph starts with `<label>: `, in this order. */
    abstractLabels: z.array(z.string()).optional(),
    authors: z.number().int().nonnegative().optional(),
    /** `collectiveName` of each group author, in author order. */
    collectiveNames: z.array(z.string()).optional(),
    /** `orcid` of each author that carries one, in author order. */
    orcids: z.array(z.string()).optional(),
    affiliations: z.number().int().nonnegative().optional(),
    /** Exact `journalInfo` fields; `publicationDate` compared field by field. */
    journal: z
      .object({
        title: z.string(),
        isoAbbreviation: z.string(),
        issn: z.string(),
        eIssn: z.string(),
        volume: z.string(),
        issue: z.string(),
        pages: z.string(),
        elocationId: z.string(),
        elocationIdType: z.string(),
        publicationDate: z
          .object({ year: z.string(), month: z.string(), day: z.string() })
          .partial()
          .strict(),
      })
      .partial()
      .strict()
      .optional(),
    doi: z.string().optional(),
    pmcId: z.string().optional(),
    publicationTypes: z.array(z.string()).optional(),
    /** Descriptor names flagged as a major topic, in MeSH order. */
    meshMajor: z.array(z.string()).optional(),
    /** `grantId` of every grant, in order; `null` for a grant with none. */
    grantIds: z.array(z.string().nullable()).optional(),
    commentsCorrections: z
      .array(z.object({ refType: z.string(), pmid: z.string().optional() }).strict())
      .optional(),
    /** `content[]`'s `**Article Dates:**` value. */
    articleDates: z.string().optional(),
    /** Substrings the `pubmed_fetch_articles` `content[]` must contain. */
    contains: substrings.optional(),
    /** Substrings no surface of either tool may contain. */
    notContains: substrings.optional(),
    /** Substrings each style's citation must contain, verified field by field against the source. */
    citations: z
      .object(Object.fromEntries(CITATION_STYLES.map((s) => [s, substrings.optional()])))
      .strict()
      .optional(),
    /**
     * Invariant failures caused by a reported parser defect, quoted exactly as the
     * invariant reports them. Each is tolerated only while it still occurs: once the fix
     * lands, the suite fails until the entry is removed and the snapshot regenerated.
     * Name the defect in `why`.
     */
    knownProblems: z.array(z.string()).optional(),
  })
  .strict();

export type PubmedExpect = z.infer<typeof pubmedExpectSchema>;

/** Assertions the results fail; empty when every one holds. */
export function checkPubmedExpect(
  expect: PubmedExpect,
  article: PubmedCorpusArticle,
  citation: PubmedCorpusCitation,
  text: string,
  everySurface: readonly string[],
): string[] {
  const problems: string[] = [];
  const same = (name: string, actual: unknown, wanted: unknown) => {
    if (wanted !== undefined && JSON.stringify(actual) !== JSON.stringify(wanted)) {
      problems.push(`${name}: expected ${JSON.stringify(wanted)}, got ${JSON.stringify(actual)}`);
    }
  };
  const authors = article.authors ?? [];
  same('title', article.title, expect.title);
  same('authors', authors.length, expect.authors);
  same(
    'collectiveNames',
    authors.flatMap((a) => a.collectiveName ?? []),
    expect.collectiveNames,
  );
  same(
    'orcids',
    authors.flatMap((a) => a.orcid ?? []),
    expect.orcids,
  );
  same('affiliations', article.affiliations?.length ?? 0, expect.affiliations);
  same('doi', article.doi, expect.doi);
  same('pmcId', article.pmcId, expect.pmcId);
  same('publicationTypes', article.publicationTypes, expect.publicationTypes);
  same(
    'meshMajor',
    (article.meshTerms ?? []).filter((m) => m.isMajorTopic).map((m) => m.descriptorName),
    expect.meshMajor,
  );
  same(
    'grantIds',
    (article.grantList ?? []).map((g) => g.grantId ?? null),
    expect.grantIds,
  );
  same(
    'commentsCorrections',
    article.commentsCorrections?.map(({ refType, pmid }) => ({ refType, ...(pmid && { pmid }) })),
    expect.commentsCorrections,
  );
  if (expect.journal) {
    const { publicationDate, ...fields } = expect.journal;
    for (const [key, wanted] of Object.entries(fields)) {
      same(`journal.${key}`, article.journalInfo?.[key as keyof typeof fields], wanted);
    }
    for (const [key, wanted] of Object.entries(publicationDate ?? {})) {
      same(
        `journal.publicationDate.${key}`,
        article.journalInfo?.publicationDate?.[key as keyof typeof publicationDate],
        wanted,
      );
    }
  }
  if (expect.abstractLabels) {
    const labels = (article.abstractText ?? '')
      .split('\n\n')
      .map((paragraph) => /^([^:\n]+): /.exec(paragraph)?.[1] ?? '');
    same('abstractLabels', labels, expect.abstractLabels);
  }
  if (expect.articleDates !== undefined) {
    same('articleDates', /^\*\*Article Dates:\*\* (.*)$/m.exec(text)?.[1], expect.articleDates);
  }
  for (const needle of expect.contains ?? []) {
    if (!text.includes(needle)) problems.push(`pubmed_fetch_articles content[] lacks "${needle}"`);
  }
  for (const needle of expect.notContains ?? []) {
    if (everySurface.some((value) => value.includes(needle))) {
      problems.push(`a surface contains "${needle}"`);
    }
  }
  for (const style of CITATION_STYLES) {
    for (const needle of expect.citations?.[style] ?? []) {
      if (!citation.citations[style]?.includes(needle)) {
        problems.push(`${style} citation lacks "${needle}"`);
      }
    }
  }
  return problems;
}
