/**
 * @fileoverview Full-text fetch tool. Primary source is PubMed Central (NCBI
 * EFetch, `db=pmc`). When a PMID has no PMC copy but does have a DOI,
 * transparently falls back to Unpaywall to retrieve a legally-deposited
 * open-access copy (HTML or PDF). Output uses a discriminated union on
 * `source` so callers can reason about structural reliability per article.
 * @module src/mcp-server/tools/definitions/fetch-fulltext.tool
 */

import { type Context, tool, z } from '@cyanheads/mcp-ts-core';
import { htmlExtractor, pdfParser } from '@cyanheads/mcp-ts-core/utils';
import { getNcbiService } from '@/services/ncbi/ncbi-service.js';
import { extractDoi, extractPmid } from '@/services/ncbi/parsing/article-parser.js';
import { parsePmcArticle } from '@/services/ncbi/parsing/pmc-article-parser.js';
import { findAll, findOne, type JatsNodeList } from '@/services/ncbi/parsing/pmc-xml-helpers.js';
import { ensureArray } from '@/services/ncbi/parsing/xml-helpers.js';
import type {
  ParsedPmcArticle,
  XmlPubmedArticle,
  XmlPubmedArticleSet,
} from '@/services/ncbi/types.js';
import type {
  UnpaywallContent,
  UnpaywallLocation,
  UnpaywallResolution,
} from '@/services/unpaywall/types.js';
import { getUnpaywallService } from '@/services/unpaywall/unpaywall-service.js';
import { conceptMeta, EDAM_DATA_RETRIEVAL, SCHEMA_SCHOLARLY_ARTICLE } from './_concepts.js';
import { pmidStringSchema } from './_schemas.js';

function normalizePmcId(id: string): string {
  return id.replace(/^PMC/i, '');
}

function filterSections(
  sections: ParsedPmcArticle['sections'],
  sectionFilter: string[],
): ParsedPmcArticle['sections'] {
  const lowerFilter = sectionFilter.map((s) => s.toLowerCase());
  return sections.filter(
    (s) => s.title && lowerFilter.some((f) => s.title?.toLowerCase().includes(f)),
  );
}

// ─── Schemas ─────────────────────────────────────────────────────────────────

const SubsectionSchema = z
  .object({
    title: z.string().optional().describe('Subsection heading'),
    label: z.string().optional().describe('Subsection label'),
    text: z.string().describe('Subsection body text'),
  })
  .describe('Article subsection');

const SectionSchema = z
  .object({
    title: z.string().optional().describe('Section heading'),
    label: z.string().optional().describe('Section label'),
    text: z.string().describe('Section body text'),
    subsections: z.array(SubsectionSchema).optional().describe('Nested subsections'),
  })
  .describe('Article body section');

const AuthorSchema = z
  .object({
    collectiveName: z.string().optional().describe('Group name'),
    givenNames: z.string().optional().describe('Given names'),
    lastName: z.string().optional().describe('Last name'),
  })
  .describe('Author entry');

const JournalSchema = z
  .object({
    title: z.string().optional().describe('Journal title'),
    issn: z.string().optional().describe('ISSN'),
    volume: z.string().optional().describe('Volume number'),
    issue: z.string().optional().describe('Issue number'),
    pages: z.string().optional().describe('Page range'),
  })
  .describe('Journal information');

const ReferenceSchema = z
  .object({
    citation: z.string().describe('Citation text'),
    id: z.string().optional().describe('Reference ID'),
    label: z.string().optional().describe('Reference label'),
  })
  .describe('Reference entry');

const PublicationDateSchema = z
  .object({
    year: z.string().optional().describe('Publication year'),
    month: z.string().optional().describe('Publication month'),
    day: z.string().optional().describe('Publication day'),
  })
  .describe('Publication date');

const PmcArticleSchema = z
  .object({
    source: z.literal('pmc').describe('Content came from PubMed Central as structured JATS XML'),
    pmcId: z.string().describe('PMC ID'),
    pmcUrl: z.string().describe('PMC URL'),
    pmid: z.string().optional().describe('PubMed ID'),
    pubmedUrl: z.string().optional().describe('PubMed URL'),
    doi: z.string().optional().describe('DOI'),
    title: z.string().optional().describe('Article title'),
    abstract: z.string().optional().describe('Abstract'),
    authors: z.array(AuthorSchema).optional().describe('Authors'),
    affiliations: z.array(z.string()).optional().describe('Author affiliations'),
    journal: JournalSchema.optional(),
    keywords: z.array(z.string()).optional().describe('Keywords'),
    articleType: z.string().optional().describe('Article type'),
    publicationDate: PublicationDateSchema.optional(),
    sections: z.array(SectionSchema).describe('Article body sections'),
    references: z.array(ReferenceSchema).optional().describe('Reference list'),
  })
  .describe('Structured PMC full-text article — reliable section/reference structure');

const UnpaywallArticleSchema = z
  .object({
    source: z
      .literal('unpaywall')
      .describe(
        'Content fetched from an open-access copy indexed by Unpaywall. Best-effort — structural fidelity depends on `contentFormat`.',
      ),
    contentFormat: z
      .enum(['html-markdown', 'pdf-text'])
      .describe(
        'How `content` was extracted. html-markdown: Defuddle extracted Markdown from an HTML landing page; light section structure may survive but is not guaranteed. pdf-text: unpdf extracted plain text from a PDF; no section, reference, or heading structure.',
      ),
    pmid: z.string().describe('PubMed ID the article was resolved from'),
    pubmedUrl: z.string().describe('PubMed URL'),
    doi: z.string().describe('DOI used to locate the open-access copy'),
    sourceUrl: z.string().describe('URL the content was fetched from'),
    title: z.string().optional().describe('Detected article title when present'),
    content: z.string().describe('Full article text — Markdown or plain text per `contentFormat`'),
    wordCount: z
      .number()
      .optional()
      .describe('Approximate word count reported by the HTML extractor; absent for PDFs'),
    totalPages: z
      .number()
      .optional()
      .describe('Page count reported by the PDF extractor; absent for HTML'),
    license: z.string().optional().describe('License identifier from Unpaywall (e.g. cc-by, cc0)'),
    hostType: z
      .string()
      .optional()
      .describe('`publisher` or `repository` — where the OA copy is hosted'),
    version: z
      .string()
      .optional()
      .describe('OA version: submittedVersion | acceptedVersion | publishedVersion'),
  })
  .describe('Best-effort full text from an open-access copy');

const ArticleSchema = z
  .discriminatedUnion('source', [PmcArticleSchema, UnpaywallArticleSchema])
  .describe(
    'Full-text article; shape depends on `source` (pmc = structured, unpaywall = best-effort)',
  );

const UnavailableReasonSchema = z
  .enum([
    'no-pmc-fallback-disabled',
    'no-doi',
    'no-oa',
    'fetch-failed',
    'parse-failed',
    'service-error',
  ])
  .describe(
    `Why the PMID has no full text. no-pmc-fallback-disabled: not in PMC and UNPAYWALL_EMAIL is unset so the Unpaywall fallback is off. no-doi: not in PMC and the ID Converter returned no DOI to try Unpaywall with. no-oa: DOI exists but Unpaywall has no open-access copy indexed. fetch-failed: OA location found but the content could not be downloaded. parse-failed: content was downloaded but text extraction produced nothing usable. service-error: Unpaywall or an upstream host returned a server error.`,
  );

const UnavailableSchema = z
  .object({
    pmid: z.string().describe('PMID full text could not be returned for'),
    reason: UnavailableReasonSchema,
    detail: z.string().optional().describe('Additional context when available'),
  })
  .describe('One PMID that could not be returned with an explanation of why');

// ─── Tool Definition ─────────────────────────────────────────────────────────

export const fetchFulltextTool = tool('pubmed_fetch_fulltext', {
  description:
    'Fetch full-text articles. Primary source is PubMed Central (structured JATS with sections and references). When a PMID has no PMC copy, transparently falls back to Unpaywall (open-access copies hosted by publishers or institutional repositories) and returns best-effort HTML-as-Markdown or PDF-as-text. Set UNPAYWALL_EMAIL to enable the fallback. Accepts PMC IDs directly or PubMed IDs (auto-resolved via the PMC ID Converter).',
  annotations: { readOnlyHint: true, openWorldHint: true },
  _meta: conceptMeta([SCHEMA_SCHOLARLY_ARTICLE, EDAM_DATA_RETRIEVAL]),
  sourceUrl:
    'https://github.com/cyanheads/pubmed-mcp-server/blob/main/src/mcp-server/tools/definitions/fetch-fulltext.tool.ts',

  input: z.object({
    pmcids: z
      .array(z.string())
      .min(1)
      .max(10)
      .optional()
      .describe('PMC IDs to fetch (e.g. ["PMC9575052"]). Provide this OR pmids, not both.'),
    pmids: z
      .array(pmidStringSchema)
      .min(1)
      .max(10)
      .optional()
      .describe(
        'PubMed IDs. Articles in PMC are returned as structured JATS. Articles not in PMC are retrieved from Unpaywall when UNPAYWALL_EMAIL is set and a DOI is available. Provide this OR pmcids, not both.',
      ),
    includeReferences: z
      .boolean()
      .default(false)
      .describe('Include reference list. Applies to `source=pmc` results only.'),
    maxSections: z
      .number()
      .int()
      .min(1)
      .max(50)
      .optional()
      .describe('Maximum top-level body sections. Applies to `source=pmc` results only.'),
    sections: z
      .array(z.string())
      .optional()
      .describe(
        'Filter to specific sections by title, case-insensitive (e.g. ["Introduction", "Methods", "Results", "Discussion"]). Applies to `source=pmc` results only.',
      ),
  }),

  output: z.object({
    articles: z.array(ArticleSchema).describe('Full-text articles'),
    totalReturned: z.number().describe('Number of articles returned'),
    unavailable: z
      .array(UnavailableSchema)
      .optional()
      .describe('Per-PMID explanations for any requested PMIDs with no returnable full text'),
    unavailablePmcIds: z
      .array(z.string())
      .optional()
      .describe('PMC IDs requested directly that returned no data'),
  }),

  async handler(input, ctx) {
    ctx.log.info('Executing pubmed_fetch_fulltext', {
      hasPmcids: !!input.pmcids,
      hasPmids: !!input.pmids,
      idCount: (input.pmcids ?? input.pmids)?.length,
    });

    if (!input.pmcids && !input.pmids) throw new Error('Either pmcids or pmids must be provided');
    if (input.pmcids && input.pmids) throw new Error('Provide pmcids or pmids, not both');

    // ── PMID path: resolve to PMC + collect unresolved PMIDs for Unpaywall fallback ──
    let pmcIds: string[] = [];
    let fallbackCandidates: FallbackCandidate[] = [];

    if (input.pmids) {
      const records = await getNcbiService().idConvert(
        input.pmids,
        'pmid',
        ctx.signal ? { signal: ctx.signal } : undefined,
      );
      const seen = new Set<string>();
      for (const r of records) {
        if (r.pmid === undefined) continue;
        const pmid = String(r.pmid);
        seen.add(pmid);
        if (r.pmcid) {
          pmcIds.push(normalizePmcId(String(r.pmcid)));
        } else {
          fallbackCandidates.push({ pmid, ...(r.doi && { doi: r.doi }) });
        }
      }
      // Any requested PMIDs the converter didn't return at all: treat as fallback candidates.
      for (const requested of input.pmids) {
        if (!seen.has(requested)) fallbackCandidates.push({ pmid: requested });
      }
    } else {
      pmcIds = (input.pmcids ?? []).map(normalizePmcId);
    }

    // ── PMC fetch ───────────────────────────────────────────────────────────
    let pmcArticles: z.infer<typeof PmcArticleSchema>[] = [];
    let unavailablePmcIds: string[] | undefined;

    if (pmcIds.length > 0) {
      const xmlData = await getNcbiService().eFetch<JatsNodeList>(
        { db: 'pmc', id: pmcIds.join(','), retmode: 'xml' },
        {
          retmode: 'xml',
          useOrderedParser: true,
          usePost: pmcIds.length > 5,
          signal: ctx.signal,
        },
      );

      const articleSet = findOne(xmlData, 'pmc-articleset');
      if (!articleSet) throw new Error('Invalid PMC EFetch response: missing pmc-articleset');

      let parsed = findAll(articleSet, 'article').map(parsePmcArticle);

      if (input.sections?.length) {
        const sectionFilter = input.sections;
        parsed = parsed.map((a) => ({ ...a, sections: filterSections(a.sections, sectionFilter) }));
      }
      if (input.maxSections !== undefined) {
        parsed = parsed.map((a) => ({ ...a, sections: a.sections.slice(0, input.maxSections) }));
      }
      if (!input.includeReferences) {
        parsed = parsed.map(({ references: _, ...rest }) => rest as ParsedPmcArticle);
      }

      pmcArticles = parsed.map((a) => ({ source: 'pmc' as const, ...a }));

      const returnedPmcIds = new Set(pmcArticles.map((a) => a.pmcId));
      const missing = pmcIds.map((id) => `PMC${id}`).filter((id) => !returnedPmcIds.has(id));
      if (missing.length > 0) unavailablePmcIds = missing;
    }

    // ── Unpaywall fallback for PMIDs not in PMC ─────────────────────────────
    const unpaywall = getUnpaywallService();
    const unavailable: z.infer<typeof UnavailableSchema>[] = [];
    const fallbackArticles: z.infer<typeof UnpaywallArticleSchema>[] = [];

    if (fallbackCandidates.length > 0) {
      if (!unpaywall) {
        for (const c of fallbackCandidates) {
          unavailable.push({
            pmid: c.pmid,
            reason: 'no-pmc-fallback-disabled',
            detail: 'Article not in PMC and UNPAYWALL_EMAIL is not set',
          });
        }
      } else {
        // The PMC ID Converter only returns DOIs for articles it has in PMC, so
        // candidates here are missing DOIs by default. Pull them from PubMed
        // metadata (db=pubmed) before dispatching to Unpaywall.
        const needDoi = fallbackCandidates.filter((c) => !c.doi).map((c) => c.pmid);
        if (needDoi.length > 0) {
          try {
            const doiMap = await fetchPubmedDois(needDoi, ctx.signal);
            fallbackCandidates = fallbackCandidates.map((c) => {
              if (c.doi) return c;
              const doi = doiMap.get(c.pmid);
              return doi ? { ...c, doi } : c;
            });
          } catch (error: unknown) {
            ctx.log.warning('Failed to batch-fetch DOIs from PubMed for Unpaywall fallback', {
              error: error instanceof Error ? error.message : String(error),
              pmidCount: needDoi.length,
            });
          }
        }

        const outcomes = await Promise.allSettled(
          fallbackCandidates.map((c) => resolveViaUnpaywall(c, ctx)),
        );
        for (const outcome of outcomes) {
          if (outcome.status === 'fulfilled') {
            if ('article' in outcome.value) fallbackArticles.push(outcome.value.article);
            else unavailable.push(outcome.value.unavailable);
          } else {
            ctx.log.warning('Unpaywall fallback crashed unexpectedly', {
              error:
                outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason),
            });
          }
        }
      }
    }

    const articles = [...pmcArticles, ...fallbackArticles];

    ctx.log.info('pubmed_fetch_fulltext completed', {
      requested: (input.pmids ?? input.pmcids)?.length ?? 0,
      returned: articles.length,
      pmcHits: pmcArticles.length,
      unpaywallHits: fallbackArticles.length,
      unavailable: unavailable.length,
    });

    return {
      articles,
      totalReturned: articles.length,
      ...(unavailable.length > 0 && { unavailable }),
      ...(unavailablePmcIds && { unavailablePmcIds }),
    };
  },

  format: (result) => {
    const lines = [`## Full-Text Articles`, `**Articles Returned:** ${result.totalReturned}`];

    if (result.unavailable?.length) {
      lines.push(`\n**Unavailable PMIDs (${result.unavailable.length}):**`);
      for (const u of result.unavailable) {
        lines.push(`- ${u.pmid} — ${u.reason}${u.detail ? `: ${u.detail}` : ''}`);
      }
    }
    if (result.unavailablePmcIds?.length) {
      lines.push(`**Unavailable PMC IDs:** ${result.unavailablePmcIds.join(', ')}`);
    }

    for (const a of result.articles) {
      lines.push('');
      if (a.source === 'pmc') formatPmcArticle(a, lines);
      else formatUnpaywallArticle(a, lines);
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});

// ─── Handler helpers ─────────────────────────────────────────────────────────

/** A PMID not present in PMC, optionally paired with a DOI for Unpaywall lookup. */
type FallbackCandidate = { pmid: string; doi?: string };

type FallbackOutcome =
  | { article: z.infer<typeof UnpaywallArticleSchema> }
  | { unavailable: z.infer<typeof UnavailableSchema> };

/**
 * Batch-fetch DOIs from PubMed metadata for PMIDs that lack one after the PMC
 * ID Converter roundtrip. The Converter only returns DOIs for articles already
 * in PMC, so non-PMC PMIDs arrive here with `doi: undefined` — yet the DOI is
 * present in PubMed's own record (ELocationID / ArticleIdList) and is required
 * to query Unpaywall. One eFetch call covers the whole batch.
 */
async function fetchPubmedDois(
  pmids: string[],
  signal?: AbortSignal,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (pmids.length === 0) return out;

  const xmlData = await getNcbiService().eFetch<{ PubmedArticleSet?: XmlPubmedArticleSet }>(
    { db: 'pubmed', id: pmids.join(','), retmode: 'xml' },
    { retmode: 'xml', usePost: pmids.length >= 100, ...(signal && { signal }) },
  );

  const articles = xmlData?.PubmedArticleSet?.PubmedArticle
    ? (ensureArray(xmlData.PubmedArticleSet.PubmedArticle) as XmlPubmedArticle[])
    : [];

  for (const article of articles) {
    if (!article?.MedlineCitation) continue;
    const pmid = extractPmid(article.MedlineCitation);
    if (!pmid) continue;
    const doi = extractDoi(article.MedlineCitation.Article, article.PubmedData?.ArticleIdList);
    if (doi) out.set(pmid, doi);
  }
  return out;
}

async function resolveViaUnpaywall(
  candidate: FallbackCandidate,
  ctx: Context,
): Promise<FallbackOutcome> {
  const { pmid, doi } = candidate;
  const service = getUnpaywallService();

  if (!doi) return { unavailable: { pmid, reason: 'no-doi' } };
  if (!service) return { unavailable: { pmid, reason: 'no-pmc-fallback-disabled' } };

  let resolution: UnpaywallResolution;
  try {
    resolution = await service.resolve(doi, ctx.signal);
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    return { unavailable: { pmid, reason: 'service-error', detail } };
  }

  if (resolution.kind === 'no-oa') {
    return { unavailable: { pmid, reason: 'no-oa', detail: resolution.reason } };
  }

  let content: UnpaywallContent;
  try {
    content = await service.fetchContent(resolution.location, ctx.signal);
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    return { unavailable: { pmid, reason: 'fetch-failed', detail } };
  }

  try {
    if (content.kind === 'html') {
      const extracted = await htmlExtractor.extract(content.body, {
        url: content.fetchedUrl,
        format: 'markdown',
      });
      const body = extracted.content.trim();
      if (!body) {
        return {
          unavailable: {
            pmid,
            reason: 'parse-failed',
            detail: 'HTML extraction produced empty content',
          },
        };
      }
      return {
        article: buildUnpaywallArticle({
          pmid,
          doi,
          sourceUrl: content.fetchedUrl,
          location: resolution.location,
          contentFormat: 'html-markdown',
          content: body,
          title: extracted.title,
          wordCount: extracted.wordCount,
        }),
      };
    }

    const extracted = await pdfParser.extractText(content.body, { mergePages: true });
    const text = typeof extracted.text === 'string' ? extracted.text.trim() : '';
    if (!text) {
      return {
        unavailable: {
          pmid,
          reason: 'parse-failed',
          detail: 'PDF extraction produced empty text',
        },
      };
    }
    return {
      article: buildUnpaywallArticle({
        pmid,
        doi,
        sourceUrl: content.fetchedUrl,
        location: resolution.location,
        contentFormat: 'pdf-text',
        content: text,
        totalPages: extracted.totalPages,
      }),
    };
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    ctx.log.warning('Unpaywall content extraction failed', { pmid, doi, detail });
    return { unavailable: { pmid, reason: 'parse-failed', detail } };
  }
}

function buildUnpaywallArticle(args: {
  pmid: string;
  doi: string;
  sourceUrl: string;
  location: UnpaywallLocation;
  contentFormat: 'html-markdown' | 'pdf-text';
  content: string;
  title?: string | undefined;
  wordCount?: number | undefined;
  totalPages?: number | undefined;
}): z.infer<typeof UnpaywallArticleSchema> {
  const { location } = args;
  return {
    source: 'unpaywall',
    contentFormat: args.contentFormat,
    pmid: args.pmid,
    pubmedUrl: `https://pubmed.ncbi.nlm.nih.gov/${args.pmid}/`,
    doi: args.doi,
    sourceUrl: args.sourceUrl,
    content: args.content,
    ...(args.title && { title: args.title }),
    ...(args.wordCount !== undefined && { wordCount: args.wordCount }),
    ...(args.totalPages !== undefined && { totalPages: args.totalPages }),
    ...(location.license && { license: location.license }),
    ...(location.host_type && { hostType: location.host_type }),
    ...(location.version && { version: location.version }),
  };
}

// ─── format() helpers ────────────────────────────────────────────────────────

function formatPmcArticle(a: z.infer<typeof PmcArticleSchema>, lines: string[]): void {
  lines.push(`### ${a.title ?? a.pmcId}`);
  lines.push(`**Source:** PMC (structured JATS)`);

  if (a.authors?.length) {
    lines.push(`\n**Authors (${a.authors.length}):**`);
    for (const au of a.authors) lines.push(`- ${formatPmcAuthor(au)}`);
  }

  if (a.affiliations?.length) {
    lines.push(`\n**Affiliations:**`);
    for (const [i, aff] of a.affiliations.entries()) lines.push(`${i + 1}. ${aff}`);
  }

  if (a.journal) {
    const parts: string[] = [];
    if (a.journal.title) parts.push(a.journal.title);
    if (a.journal.volume)
      parts.push(`**${a.journal.volume}**${a.journal.issue ? `(${a.journal.issue})` : ''}`);
    if (a.journal.pages) parts.push(a.journal.pages);
    if (a.journal.issn) parts.push(`ISSN ${a.journal.issn}`);
    if (parts.length) lines.push(`\n**Journal:** ${parts.join(', ')}`);
  }
  if (a.articleType) lines.push(`**Type:** ${a.articleType}`);
  if (a.publicationDate) {
    const d = a.publicationDate;
    const dateParts = [d.year, d.month, d.day].filter(Boolean);
    if (dateParts.length) lines.push(`**Published:** ${dateParts.join('-')}`);
  }
  lines.push(`**PMCID:** ${a.pmcId}`);
  if (a.pmid) lines.push(`**PMID:** ${a.pmid}`);
  if (a.doi) lines.push(`**DOI:** ${a.doi}`);
  lines.push(`**PMC:** ${a.pmcUrl}`);
  if (a.pubmedUrl) lines.push(`**PubMed:** ${a.pubmedUrl}`);
  if (a.keywords?.length) lines.push(`**Keywords:** ${a.keywords.join(', ')}`);
  if (a.abstract) lines.push(`\n#### Abstract\n${a.abstract}`);

  for (const sec of a.sections) {
    if (sec.title) lines.push(`\n#### ${formatHeading(sec.label, sec.title)}`);
    if (sec.text) lines.push(sec.text);
    if (sec.subsections?.length) {
      for (const sub of sec.subsections) {
        if (sub.title) lines.push(`\n##### ${formatHeading(sub.label, sub.title)}`);
        if (sub.text) lines.push(sub.text);
      }
    }
  }

  if (a.references?.length) {
    lines.push(`\n#### References (${a.references.length})`);
    for (const ref of a.references) {
      const tag = [ref.label, ref.id].filter(Boolean).join(' ');
      lines.push(`- ${tag ? `[${tag}] ` : ''}${ref.citation}`);
    }
  }
}

function formatUnpaywallArticle(a: z.infer<typeof UnpaywallArticleSchema>, lines: string[]): void {
  const heading = a.title ?? `PMID ${a.pmid}`;
  const formatLabel =
    a.contentFormat === 'html-markdown'
      ? 'Unpaywall (HTML → Markdown, best-effort)'
      : 'Unpaywall (PDF → plain text)';
  lines.push(`### ${heading}`);
  lines.push(`**Source:** ${formatLabel}`);
  lines.push(`**PMID:** ${a.pmid}`);
  lines.push(`**DOI:** ${a.doi}`);
  lines.push(`**PubMed:** ${a.pubmedUrl}`);
  lines.push(`**OA Copy:** ${a.sourceUrl}`);
  if (a.license) lines.push(`**License:** ${a.license}`);
  if (a.hostType) lines.push(`**Host Type:** ${a.hostType}`);
  if (a.version) lines.push(`**Version:** ${a.version}`);
  if (a.wordCount !== undefined) lines.push(`**Word Count:** ${a.wordCount}`);
  if (a.totalPages !== undefined) lines.push(`**Pages:** ${a.totalPages}`);
  lines.push(
    `\n> Section structure is not guaranteed for this source. Treat the content as best-effort raw text. OA location metadata courtesy of Unpaywall (https://unpaywall.org).`,
  );
  lines.push(`\n#### Full Text\n${a.content}`);
}

type FormattedPmcAuthor = {
  collectiveName?: string | undefined;
  givenNames?: string | undefined;
  lastName?: string | undefined;
};

function formatPmcAuthor(au: FormattedPmcAuthor): string {
  const parts: string[] = [];
  if (au.collectiveName) parts.push(`${au.collectiveName} (collective)`);
  const name = [au.givenNames, au.lastName].filter(Boolean).join(' ');
  if (name) parts.push(name);
  return parts.join(' — ') || 'Unknown';
}

function formatHeading(label: string | undefined, title: string): string {
  return label ? `${label} ${title}` : title;
}
