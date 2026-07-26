/**
 * @fileoverview Full-text fetch tool. Resolves full-text articles through a
 * three-stage chain: NCBI PMC EFetch → Europe PMC `fullTextXML` → Unpaywall.
 * Accepts three mutually-exclusive input shapes:
 *
 *   - `pmcids` — fetch directly by PMC ID. Articles not in PMC fall through to
 *     EPMC by PMC ID, then to Unpaywall when the DOI is available.
 *   - `pmids` — resolve PMID → PMCID via PMC ID Converter, then run the chain.
 *   - `dois` — resolve DOI → PMCID via the PMC ID Converter (mirroring `pmids`),
 *     then run the chain. DOIs with no PMC counterpart fall through to EPMC
 *     search-by-DOI → fullTextXML, then Unpaywall (EPMC-only OA, preprints).
 *
 * Output uses a discriminated union on `source` (`pmc` | `unpaywall`) with an
 * extra `viaSource` discriminator that records which layer produced the
 * content. EPMC's JATS reuses the `pmc` schema shape because it's the same
 * DTD; `viaSource: 'europepmc'` distinguishes it from PMC EFetch output.
 *
 * @module src/mcp-server/tools/definitions/fetch-fulltext.tool
 */

import { type Context, tool, z } from '@cyanheads/mcp-ts-core';
import { htmlExtractor, pdfParser } from '@cyanheads/mcp-ts-core/utils';
import { getServerConfig } from '@/config/server-config.js';
import {
  EUROPEPMC_SERVICE_ERRORS,
  NCBI_SERVICE_ERRORS,
  UNPAYWALL_SERVICE_ERRORS,
} from '@/services/error-contracts.js';
import {
  type EuropePmcService,
  getEuropePmcService,
} from '@/services/europe-pmc/europe-pmc-service.js';
import type { EuropePmcSearchHit } from '@/services/europe-pmc/types.js';
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
import {
  getUnpaywallService,
  type UnpaywallService,
} from '@/services/unpaywall/unpaywall-service.js';
import { conceptMeta, EDAM_DATA_RETRIEVAL, SCHEMA_SCHOLARLY_ARTICLE } from './_concepts.js';
import { pmidStringSchema } from './_schemas.js';
import { sliceCodeUnits } from './_text.js';

function normalizePmcId(id: string): string {
  return id.replace(/^PMC/i, '');
}

function withPmcPrefix(id: string): string {
  return id.startsWith('PMC') ? id : `PMC${id}`;
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

interface PmcFilterOptions {
  includeReferences: boolean;
  maxSections?: number | undefined;
  sections?: string[] | undefined;
}

function applyPmcFilters(article: ParsedPmcArticle, filters: PmcFilterOptions): ParsedPmcArticle {
  let out = article;
  if (filters.sections?.length) {
    out = { ...out, sections: filterSections(out.sections, filters.sections) };
  }
  if (filters.maxSections !== undefined) {
    out = { ...out, sections: out.sections.slice(0, filters.maxSections) };
  }
  if (!filters.includeReferences) {
    const { references: _, ...rest } = out;
    out = rest as ParsedPmcArticle;
  }
  return out;
}

/**
 * True when a `sections` filter removed every body section from an article that
 * actually had sections upstream — the signal that the requested headings
 * matched nothing, as opposed to the article genuinely shipping no body. Only
 * the `sections` filter can zero a non-empty list: `maxSections` carries a
 * `.min(1)` floor, so it never reduces to zero. (#80)
 */
function isSectionFilterMiss(
  before: ParsedPmcArticle,
  after: ParsedPmcArticle,
  sectionFilter: string[] | undefined,
): boolean {
  return (
    Boolean(sectionFilter?.length) && before.sections.length > 0 && after.sections.length === 0
  );
}

/**
 * True when the upstream JATS carried no body sections at all — front matter and
 * abstract only. Publishers that block full-text XML download still return an
 * `<article>` with a populated `<front>`, so the parsed article looks like a hit
 * while carrying nothing to read. Distinct from {@link isSectionFilterMiss},
 * which needs a non-empty pre-filter body: the two never overlap. Evaluated
 * against the *pre-filter* article so a `sections` filter can't be mistaken for
 * an upstream absence. (#86)
 */
function isBodylessArticle(before: ParsedPmcArticle): boolean {
  return before.sections.length === 0;
}

/** Pick the best human-readable identifier for an article, for recovery notices
 *  and character-budget accounting. Treats empty strings as absent — EPMC-only
 *  records carry an empty `pmcId`. */
function articleDisplayId(a: {
  pmcId?: string | undefined;
  pmid?: string | undefined;
  doi?: string | undefined;
  epmcId?: string | undefined;
}): string {
  return [a.pmcId, a.pmid, a.doi, a.epmcId].find((v) => v && v.length > 0) ?? 'article';
}

/**
 * Compose the single recovery notice for `sections`-filter misses. Names the
 * requested terms and the affected article id(s) so the agent can distinguish a
 * filtered-empty body from one absent upstream, and points at the recovery. (#80)
 */
function buildSectionFilterMissNotice(affectedIds: string[], sectionFilter: string[]): string {
  const terms = sectionFilter.join(', ');
  const subject =
    affectedIds.length === 1 ? `article ${affectedIds[0]}` : `articles ${affectedIds.join(', ')}`;
  return `No body sections matched the requested section filter (${terms}) for ${subject}. The full text was retrieved but every body section was filtered out. Retry without \`sections\`, or filter on broader headings such as Introduction, Methods, Results, or Discussion.`;
}

/**
 * Compose the recovery notice for identifiers whose only retrievable record was
 * metadata-only — PMC or Europe PMC returned front matter with no body, and no
 * later tier recovered a full-text copy. Points at the tool that still serves
 * the abstract so the metadata isn't simply lost.
 *
 * States what the chain observed rather than asserting the article has no body:
 * a later tier may well have located an open-access copy and failed to download
 * it (`unpaywall:fetch-failed`), so the per-tier outcomes are the honest answer
 * and the notice defers to them. (#86)
 */
function buildBodylessNotice(affectedIds: string[]): string {
  const subject =
    affectedIds.length === 1 ? `article ${affectedIds[0]}` : `articles ${affectedIds.join(', ')}`;
  return `No body text could be retrieved for ${subject} — the full-text source returned front matter and abstract only, and no later tier recovered a copy. See \`triedTiers\` on the \`unavailable\` entry for what each tier reported, and use \`pubmed_fetch_articles\` for the abstract and metadata.`;
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
    source: z
      .literal('pmc')
      .describe('Structured JATS — same DTD whether sourced from NCBI PMC or Europe PMC'),
    viaSource: z
      .enum(['pmc', 'europepmc'])
      .describe(
        'Which layer produced the JATS: `pmc` for NCBI PMC EFetch (db=pmc), `europepmc` for Europe PMC `fullTextXML`. Both paths return the same JATS shape; the discriminator records origin for observability and license attribution.',
      ),
    pmcId: z
      .string()
      .optional()
      .describe(
        'PMC ID — present for NCBI PMC records and Europe PMC entries that have a PMC counterpart. Absent for EPMC-only records like preprints; use `epmcId` in that case.',
      ),
    pmcUrl: z.string().optional().describe('PMC URL — derived from `pmcId` when present'),
    pmid: z.string().optional().describe('PubMed ID'),
    pubmedUrl: z.string().optional().describe('PubMed URL'),
    doi: z
      .string()
      .optional()
      .describe(
        'DOI, cased as the tier that served this record reports it (NCBI PMC, Europe PMC, or Unpaywall). DOIs are case-insensitive by spec and no case normalization is applied here, so casing can differ between tiers and from other tools — compare case-insensitively.',
      ),
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
    epmcId: z
      .string()
      .optional()
      .describe('Europe PMC record id — present when `viaSource` is `europepmc`'),
    epmcSource: z
      .string()
      .optional()
      .describe(
        'Europe PMC source code when `viaSource` is `europepmc`. Common values: `MED` (PubMed-derived), `PMC` (PMC counterpart), `PPR` (preprint), `PAT` (patent), `AGR` (Agricola), plus less common codes (`CTX`, `CBA`, `ETH`, `HIR`). Treat as opaque — EPMC may introduce new codes.',
      ),
  })
  .describe(
    'Structured JATS full-text article. `viaSource` records whether the JATS came from NCBI PMC or Europe PMC.',
  );

const UnpaywallArticleSchema = z
  .object({
    source: z
      .literal('unpaywall')
      .describe(
        'Content fetched from an open-access copy indexed by Unpaywall. Best-effort — structural fidelity depends on `contentFormat`.',
      ),
    viaSource: z
      .literal('unpaywall')
      .describe('Layer that produced this article. Constant `unpaywall` for this branch.'),
    contentFormat: z
      .enum(['html-markdown', 'pdf-text'])
      .describe(
        'How `content` was extracted. html-markdown: Defuddle extracted Markdown from an HTML landing page; light section structure may survive but is not guaranteed. pdf-text: unpdf extracted plain text from a PDF; no section, reference, or heading structure.',
      ),
    pmcId: z
      .string()
      .optional()
      .describe(
        'PMC ID this article was requested under, in `PMC<digits>` form — present for `pmcids` input, absent for `pmids` and `dois` input. Ties the article back to the requested identifier, which `unavailable[]` keys on for the ids that found nothing.',
      ),
    pmid: z
      .string()
      .optional()
      .describe('PubMed ID when input was `pmids`; absent for `pmcids` and `dois` input'),
    pubmedUrl: z.string().optional().describe('PubMed URL — present when `pmid` is set'),
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
    'Full-text article; shape depends on `source` (pmc = structured JATS, unpaywall = best-effort)',
  );

const UnavailableReasonSchema = z
  .enum([
    'not-found',
    'no-pmc-fallback-disabled',
    'no-epmc-fulltext',
    'no-body',
    'no-doi',
    'no-oa',
    'fetch-failed',
    'parse-failed',
    'service-error',
  ])
  .describe(
    'Why no full text was returned. not-found: upstream returned no record for this ID. no-pmc-fallback-disabled: every tier was skipped (`triedTiers` is all `not-attempted`) — typically because EPMC (`EUROPEPMC_ENABLED`) and Unpaywall (`UNPAYWALL_EMAIL`) are not configured. no-epmc-fulltext: EPMC indexed the record but publishes no fullTextXML. no-body: the record was retrieved but carries front matter and abstract only, with no body sections — use `pubmed_fetch_articles` for the metadata. no-doi: no DOI to query Unpaywall. no-oa: Unpaywall has no OA copy. fetch-failed: download failed. parse-failed: extraction empty. service-error: upstream server failure (threw, timed out, or returned malformed data).',
  );

const TierOutcomeSchema = z
  .enum([
    'not-attempted',
    'miss',
    'no-fulltext',
    'no-body',
    'no-doi',
    'no-oa',
    'fetch-failed',
    'parse-failed',
    'service-error',
  ])
  .describe(
    'Per-tier outcome. not-attempted: tier was skipped. miss: tier returned no record. no-fulltext: EPMC indexed the record but publishes no fullTextXML. no-body: the tier returned a record with front matter and abstract but no body sections, so the chain continued. no-doi: no DOI to query Unpaywall. no-oa: Unpaywall reports no open-access copy. fetch-failed: OA copy download failed. parse-failed: extraction produced empty content. service-error: tier service threw.',
  );

const TriedTierSchema = z
  .object({
    tier: z.enum(['pmc', 'europepmc', 'unpaywall']).describe('Which tier in the resolution chain'),
    outcome: TierOutcomeSchema,
    detail: z.string().optional().describe('Tier-specific context when available'),
  })
  .describe('One tier the resolution chain attempted, with its outcome');

const UnavailableSchema = z
  .object({
    id: z
      .string()
      .describe('Identifier the chain could not resolve — PMID, PMCID, or DOI per `idType`'),
    idType: z.enum(['pmid', 'pmcid', 'doi']).describe('Which input branch the id came from'),
    reason: UnavailableReasonSchema,
    triedTiers: z
      .array(TriedTierSchema)
      .describe(
        'Per-tier outcomes the chain produced for this id, in execution order. Covers `pmc`, `europepmc`, and `unpaywall` — the same tiers the tool description references. Tiers that the chain skipped appear as `outcome: not-attempted` with a `detail` explaining why.',
      ),
  })
  .describe('One identifier that could not be returned, with the full chain it traversed');

// ─── Character-budget schemas ────────────────────────────────────────────────

const TruncatedSectionSchema = z
  .object({
    title: z.string().optional().describe('Section heading, when the section carries one'),
    originalCharacters: z
      .number()
      .describe('Body characters this section carried before the budget pass'),
    returnedCharacters: z
      .number()
      .describe(
        'Body characters this section carries in the response. Zero means the section was dropped in `truncate` mode, or kept as a heading-only entry in `outline` mode.',
      ),
    truncated: z
      .boolean()
      .describe('True when the section returned fewer characters than it originally carried'),
  })
  .describe('Character accounting for one body section of a budgeted article');

const TruncatedArticleSchema = z
  .object({
    id: z
      .string()
      .describe(
        'Identifier for the article — PMCID, PMID, DOI, or Europe PMC id, whichever the article carries first',
      ),
    source: z
      .enum(['pmc', 'unpaywall'])
      .describe(
        'Which output shape was budgeted: `pmc` budgets body sections and subsections, `unpaywall` budgets the single `content` body',
      ),
    originalCharacters: z
      .number()
      .describe('Body characters this article carried before the budget pass'),
    returnedCharacters: z.number().describe('Body characters this article carries in the response'),
    sections: z
      .array(TruncatedSectionSchema)
      .optional()
      .describe(
        'Per-section accounting for `source: pmc` articles, in document order, including sections dropped for budget. Absent for `source: unpaywall`, whose body has no section structure.',
      ),
  })
  .describe('Character accounting for one article the budget shortened');

const TruncationSchema = z
  .object({
    mode: z
      .enum(['truncate', 'outline'])
      .describe('The `overflowMode` that produced these results'),
    maxCharacters: z.number().optional().describe('The `maxCharacters` budget applied, when set'),
    maxCharactersPerSection: z
      .number()
      .optional()
      .describe('The `maxCharactersPerSection` budget applied, when set'),
    originalCharacters: z
      .number()
      .describe('Body characters the shortened articles carried before the budget pass'),
    returnedCharacters: z
      .number()
      .describe('Body characters the shortened articles carry in this response'),
    omittedSections: z
      .number()
      .describe(
        'Body sections dropped entirely because an article budget was exhausted before reaching them. Always 0 in `outline` mode, which keeps every heading.',
      ),
    articles: z
      .array(TruncatedArticleSchema)
      .describe('Per-article accounting, covering only the articles the budget shortened'),
  })
  .describe(
    'Character accounting for full text the budget shortened. Present only when a budget actually removed characters — its absence means every returned article carries its full post-filter body.',
  );

// ─── Character budget ────────────────────────────────────────────────────────

/** The character budget a request asked for, lifted off the parsed input. */
interface BudgetOptions {
  maxCharacters?: number | undefined;
  maxCharactersPerSection?: number | undefined;
  overflowMode: 'truncate' | 'outline';
}

/** One article's accounting, before the stage stamps on `id` and `source`. */
type UnkeyedTruncation = Omit<z.infer<typeof TruncatedArticleSchema>, 'id' | 'source'>;

/** True when the request asked for any budget at all. Without one, every budget
 *  helper returns its input untouched so the response is byte-identical. */
function budgetRequested(budget: BudgetOptions): boolean {
  return budget.maxCharacters !== undefined || budget.maxCharactersPerSection !== undefined;
}

/** Body characters a top-level section carries — its own text plus its subsections'. */
function sectionCharacters(section: ParsedPmcArticle['sections'][number]): number {
  return (
    section.text.length + (section.subsections?.reduce((n, sub) => n + sub.text.length, 0) ?? 0)
  );
}

/**
 * Shorten an ordered list of text fields so their combined length fits
 * `allowance`. Fields are filled in order, so earlier fields survive whole and
 * later ones absorb the shortfall — the section's own text before its
 * subsections. Cuts at the character boundary with no appended marker so the
 * reported `returnedCharacters` is exact; `format()` carries the human-visible
 * note. A cut that would split a surrogate pair backs off a code unit, so a
 * field can return one character under its share — counts are measured off the
 * returned text, never off the allowance. (#93)
 */
function fitFields(fields: string[], allowance: number): string[] {
  let remaining = Math.max(allowance, 0);
  return fields.map((text) => {
    const kept = sliceCodeUnits(text, remaining);
    remaining -= kept.length;
    return kept;
  });
}

/**
 * Split `total` evenly across sections, then hand the leftover from sections
 * that need less than their share back to the ones still capped, until the
 * budget is spent or every section holds all it can. Equal shares alone would
 * strand budget on short sections — a ten-section article with two one-line
 * sections would return well under what the caller asked for.
 */
function evenShares(caps: number[], total: number): number[] {
  const allowances = caps.map(() => 0);
  let remaining = total;

  while (remaining > 0) {
    const hungry = caps.reduce<number[]>((acc, cap, i) => {
      if ((allowances[i] ?? 0) < cap) acc.push(i);
      return acc;
    }, []);
    if (hungry.length === 0) break;

    const share = Math.floor(remaining / hungry.length);
    // Fewer characters left than sections still wanting them: hand out the
    // remainder one character at a time so the budget is fully spent.
    for (const i of hungry) {
      const want = (caps[i] ?? 0) - (allowances[i] ?? 0);
      const give = Math.min(share === 0 ? 1 : share, want, remaining);
      allowances[i] = (allowances[i] ?? 0) + give;
      remaining -= give;
      if (remaining === 0) break;
    }
  }
  return allowances;
}

/**
 * Decide how many characters each top-level section may keep.
 *
 * `truncate` fills sections greedily in document order: early sections keep
 * their full text and sections reached after the budget is spent get nothing.
 * `outline` spreads `maxCharacters` across every section instead, so each
 * heading survives with an excerpt rather than the budget being consumed by the
 * first sections. `maxCharactersPerSection` caps each section under either mode.
 */
function allotSectionBudgets(sizes: number[], budget: BudgetOptions): number[] {
  const perSection = budget.maxCharactersPerSection;
  const total = budget.maxCharacters;

  if (budget.overflowMode === 'outline' && total !== undefined) {
    return evenShares(
      sizes.map((size) => Math.min(perSection ?? size, size)),
      total,
    );
  }

  let remaining = total ?? sizes.reduce((sum, size) => sum + size, 0);
  return sizes.map((size) => {
    const allowance = Math.min(perSection ?? size, size, remaining);
    remaining -= allowance;
    return allowance;
  });
}

/**
 * Apply the character budget to a JATS article's body. Runs as a pure
 * post-processing pass after `applyPmcFilters`, so `sections` / `maxSections` /
 * `includeReferences` and the empty-body signals they feed are unaffected.
 * Titles, abstracts, identifiers, and references are never counted or cut —
 * the budget only spends on body text, keeping every article citable.
 *
 * Returns the article untouched (same object identity) when no budget was
 * requested or nothing exceeded it. A section left with zero characters is
 * dropped in `truncate` mode and counted as omitted; `outline` keeps it as a
 * heading-only entry. Dropped sections still appear in the accounting so the
 * caller can see which headings exist. (#81)
 */
function applyPmcBudget<T extends { sections: ParsedPmcArticle['sections'] }>(
  article: T,
  budget: BudgetOptions,
): { article: T; omittedSections: number; truncation?: UnkeyedTruncation } {
  if (!budgetRequested(budget) || article.sections.length === 0) {
    return { article, omittedSections: 0 };
  }

  const sizes = article.sections.map(sectionCharacters);
  const originalCharacters = sizes.reduce((sum, size) => sum + size, 0);
  const allowances = allotSectionBudgets(sizes, budget);

  const kept: ParsedPmcArticle['sections'] = [];
  const sectionReports: z.infer<typeof TruncatedSectionSchema>[] = [];
  let omittedSections = 0;
  let returnedCharacters = 0;

  article.sections.forEach((section, i) => {
    const original = sizes[i] ?? 0;
    const fitted = fitFields(
      [section.text, ...(section.subsections?.map((sub) => sub.text) ?? [])],
      allowances[i] ?? 0,
    );
    const returned = fitted.reduce((sum, text) => sum + text.length, 0);
    returnedCharacters += returned;
    sectionReports.push({
      ...(section.title !== undefined && { title: section.title }),
      originalCharacters: original,
      returnedCharacters: returned,
      truncated: returned < original,
    });

    if (returned === 0 && original > 0 && budget.overflowMode === 'truncate') {
      omittedSections += 1;
      return;
    }
    kept.push({
      ...section,
      text: fitted[0] ?? '',
      ...(section.subsections && {
        subsections: section.subsections.map((sub, j) => ({ ...sub, text: fitted[j + 1] ?? '' })),
      }),
    });
  });

  if (returnedCharacters === originalCharacters && omittedSections === 0) {
    return { article, omittedSections: 0 };
  }

  return {
    article: { ...article, sections: kept },
    omittedSections,
    truncation: { originalCharacters, returnedCharacters, sections: sectionReports },
  };
}

/**
 * Apply the character budget to an Unpaywall body. That body is one
 * unstructured blob — HTML-as-Markdown or PDF-as-text — so only `maxCharacters`
 * applies, and `outline` mode has no headings to preserve and behaves like
 * `truncate`. (#81)
 */
function applyContentBudget(
  content: string,
  budget: BudgetOptions,
): { content: string; truncation?: UnkeyedTruncation } {
  const cap = budget.maxCharacters;
  if (cap === undefined || content.length <= cap) return { content };
  const kept = sliceCodeUnits(content, cap);
  return {
    content: kept,
    truncation: { originalCharacters: content.length, returnedCharacters: kept.length },
  };
}

/**
 * Compose the recovery notice for a budgeted response. Names what was spent and
 * where the detail lives so an agent reading only `content[]` knows the body it
 * received is partial. (#81)
 */
function buildTruncationNotice(truncation: z.infer<typeof TruncationSchema>): string {
  const subject =
    truncation.articles.length === 1 ? '1 article' : `${truncation.articles.length} articles`;
  const omitted =
    truncation.omittedSections > 0
      ? ` ${truncation.omittedSections} section(s) were dropped once the budget ran out.`
      : '';
  // Name only the budgets the request actually set — pointing at `maxCharacters`
  // when the caller only capped per-section sends them to a knob that is unset.
  const knobs = [
    truncation.maxCharacters !== undefined ? '`maxCharacters`' : undefined,
    truncation.maxCharactersPerSection !== undefined ? '`maxCharactersPerSection`' : undefined,
  ].filter((k): k is string => k !== undefined);
  return `Full text was shortened to fit the requested character budget: ${truncation.returnedCharacters} of ${truncation.originalCharacters} body characters returned across ${subject} in ${truncation.mode} mode.${omitted} See \`truncation\` for per-article and per-section counts, and raise ${knobs.join(' or ')} or narrow \`sections\` to retrieve more.`;
}

// ─── Tool Definition ─────────────────────────────────────────────────────────

/**
 * Compose the tool description for the fallback tiers enabled in this
 * deployment. PMC EFetch is always present; Europe PMC (`EUROPEPMC_ENABLED`)
 * and Unpaywall (`UNPAYWALL_EMAIL`) are optional, so the advertised chain must
 * match what the server can actually deliver — otherwise the model requests
 * recoveries that silently can't happen.
 */
export function buildFulltextDescription(tiers: {
  europePmc: boolean;
  unpaywall: boolean;
}): string {
  const base =
    'Fetch full-text articles from PubMed Central with structured sections and references.';
  const epmcClause =
    'Europe PMC `fullTextXML` (structured JATS for records with a PMC counterpart)';
  const unpaywallClause =
    'Unpaywall — publisher-hosted or institutional open-access copies as HTML-as-Markdown or PDF-as-text';

  let fallback: string;
  if (tiers.europePmc && tiers.unpaywall) {
    fallback = `When PMC misses, transparently falls back to ${epmcClause}, then to ${unpaywallClause}.`;
  } else if (tiers.europePmc) {
    fallback = `When PMC misses, transparently falls back to ${epmcClause}.`;
  } else if (tiers.unpaywall) {
    fallback = `When PMC misses, falls back to ${unpaywallClause}.`;
  } else {
    fallback =
      'Full text is sourced from PubMed Central only; articles not in PMC return no full text in this configuration.';
  }

  const doiTail =
    tiers.europePmc && tiers.unpaywall
      ? '; preprints and EPMC-only OA fall through to the Europe PMC and Unpaywall layers'
      : tiers.europePmc
        ? '; preprints with a PMC counterpart recover via Europe PMC'
        : tiers.unpaywall
          ? '; DOIs with no PMC copy recover via Unpaywall open access'
          : '';
  const input = `Provide exactly one of \`pmcids\` (PMC IDs directly), \`pmids\` (PubMed IDs, auto-resolved), or \`dois\` (DOIs, auto-resolved to PMC via the ID Converter${doiTail}).`;

  return `${base} ${fallback} ${input}`;
}

const serverConfig = getServerConfig();

export const fetchFulltextTool = tool('pubmed_fetch_fulltext', {
  description: buildFulltextDescription({
    europePmc: serverConfig.europepmcEnabled,
    unpaywall: Boolean(serverConfig.unpaywallEmail),
  }),
  annotations: { readOnlyHint: true, openWorldHint: true },
  _meta: conceptMeta([SCHEMA_SCHOLARLY_ARTICLE, EDAM_DATA_RETRIEVAL]),
  sourceUrl:
    'https://github.com/cyanheads/pubmed-mcp-server/blob/main/src/mcp-server/tools/definitions/fetch-fulltext.tool.ts',

  errors: [
    ...NCBI_SERVICE_ERRORS,
    ...UNPAYWALL_SERVICE_ERRORS,
    ...EUROPEPMC_SERVICE_ERRORS,
  ] as const,

  input: z
    .object({
      pmcids: z
        .array(
          z
            .string()
            .regex(
              /^(?:PMC)?\d+$/i,
              'PMC ID must be digits, optionally prefixed with "PMC" (e.g. "PMC9575052" or "9575052")',
            ),
        )
        .min(1)
        .max(10)
        .optional()
        .describe(
          'PMC IDs to fetch (e.g. ["PMC9575052"]). Provide exactly one of `pmcids`, `pmids`, or `dois`. PMC IDs with no retrievable full text fall through to Europe PMC, then to Unpaywall on the DOI the chain resolves for them.',
        ),
      pmids: z
        .array(pmidStringSchema)
        .min(1)
        .max(10)
        .optional()
        .describe(
          'PubMed IDs. Provide exactly one of `pmcids`, `pmids`, or `dois`. Articles in PMC are returned as structured JATS; articles not in PMC fall through to Europe PMC (when EPMC has a `fullTextXML`), then to Unpaywall when `UNPAYWALL_EMAIL` is set and a DOI is available.',
        ),
      dois: z
        .array(z.string().min(3))
        .min(1)
        .max(10)
        .optional()
        .describe(
          'DOIs to resolve (e.g. ["10.21203/rs.3.rs-9010375/v1"]). Provide exactly one of `pmcids`, `pmids`, or `dois`. Resolved to a PMCID via the PMC ID Converter and returned as structured JATS when the article is in PMC; DOIs with no PMC counterpart (preprints, EPMC-only OA) fall through to Europe PMC, then Unpaywall, when those layers are enabled.',
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
      maxCharacters: z
        .number()
        .int()
        .min(1)
        .max(1_000_000)
        .optional()
        .describe(
          'Per-article budget for body text, in characters. Counts `source=pmc` section and subsection text, or the `source=unpaywall` `content` body; titles, abstracts, identifiers, and references are never counted or shortened. Applied after `sections`, `maxSections`, and `includeReferences`, so semantic filtering is unaffected. The response-wide ceiling is this value times the number of articles returned. Omit for the full body.',
        ),
      maxCharactersPerSection: z
        .number()
        .int()
        .min(1)
        .max(1_000_000)
        .optional()
        .describe(
          'Budget for a single top-level body section, in characters, counting the section text plus its subsections. Combine with `maxCharacters` to cap both one section and the article; the tighter of the two wins. Applies to `source=pmc` results only.',
        ),
      overflowMode: z
        .enum(['truncate', 'outline'])
        .default('truncate')
        .describe(
          'How to spend `maxCharacters` across an article that exceeds it. truncate: fill sections in document order, so early sections stay whole and sections past the budget are dropped (counted in `truncation.omittedSections`). outline: split the budget evenly so every section keeps its heading, and an excerpt as far as the budget reaches — use it to survey what an article contains before requesting specific `sections`. Ignored when no budget is set, and identical for `source=unpaywall` bodies, which have no headings to preserve.',
        ),
    })
    .refine((v) => [v.pmcids, v.pmids, v.dois].filter((b) => b !== undefined).length === 1, {
      message: 'Provide exactly one of `pmcids`, `pmids`, or `dois` (not zero, not more).',
    }),

  output: z.object({
    articles: z.array(ArticleSchema).describe('Full-text articles'),
    totalReturned: z.number().describe('Number of articles returned'),
    unavailable: z
      .array(UnavailableSchema)
      .optional()
      .describe(
        'Per-identifier explanations for any requested PMIDs, PMCIDs, or DOIs with no returnable full text. `idType` discriminates which branch the id came from.',
      ),
    truncation: TruncationSchema.optional(),
  }),

  // Recovery guidance for three cases — a `sections` filter that removed every
  // body section (#80), a record the chain could only retrieve as front matter
  // (#86), and a body the character budget shortened (#81). Agent-facing context
  // surfaced via ctx.enrich.notice() to structuredContent and content[]; absent
  // when none applies.
  enrichment: {
    notice: z
      .string()
      .optional()
      .describe(
        'Optional guidance for a partial or empty body. A `sections`-filter miss names the requested terms and affected article id(s) and suggests retrying without `sections` or using broader headings. A metadata-only record names the id(s) the chain could retrieve as front matter only and points at `pubmed_fetch_articles` for the abstract. A budgeted response names the characters returned versus carried and points at `truncation`. Absent when none of those applies.',
      ),
  },

  async handler(input, ctx) {
    ctx.log.info('Executing pubmed_fetch_fulltext', {
      hasPmcids: !!input.pmcids,
      hasPmids: !!input.pmids,
      hasDois: !!input.dois,
      idCount: (input.pmcids ?? input.pmids ?? input.dois)?.length,
    });

    // ── Chain tracking ──────────────────────────────────────────────────────
    // Per-input-id tier history (the `triedTiers` array on unavailable entries).
    // Keys: pmid for `pmids` input, prefixed PMCID for `pmcids` input, doi for
    // `dois` input. `recoveredIds` collects ids the chain produced an article
    // for, so we can skip them when building `unavailable[]`.
    const chainByInput = new Map<string, z.infer<typeof TriedTierSchema>[]>();
    const recoveredIds = new Set<string>();
    // Back-map from a converter-resolved prefixed PMCID to the input id that
    // seeded it — a PMID for `pmids` input, a DOI for `dois` input — so the PMC
    // and EPMC stages attribute recoveries and misses to the original input id.
    const pmcidToInputId = new Map<string, string>();
    // DOI hints captured during pmids→pmcid routing so PMC-misses on the pmids
    // branch can still reach Unpaywall without re-fetching from PubMed metadata.
    const pmidContext = new Map<string, PmidCandidate>();
    // Ids of returned articles whose `sections` filter removed every body
    // section — collected across the PMC and EPMC stages to drive one recovery
    // notice via ctx.enrich.notice (#80).
    const sectionFilterMisses: string[] = [];
    // Input ids whose PMC or EPMC record carried no body sections at all. Those
    // records are not full-text hits, so the chain continues past them; ids still
    // unrecovered at the end drive the metadata-only recovery notice (#86).
    const bodylessInputIds = new Set<string>();
    // Per-article character accounting collected across all three stages, plus
    // the running count of sections the budget dropped. Empty when no budget was
    // requested or nothing exceeded it (#81).
    const truncatedArticles: z.infer<typeof TruncatedArticleSchema>[] = [];
    let omittedSections = 0;

    const budget: BudgetOptions = {
      overflowMode: input.overflowMode,
      ...(input.maxCharacters !== undefined && { maxCharacters: input.maxCharacters }),
      ...(input.maxCharactersPerSection !== undefined && {
        maxCharactersPerSection: input.maxCharactersPerSection,
      }),
    };

    const idType: 'pmid' | 'pmcid' | 'doi' = input.pmids ? 'pmid' : input.pmcids ? 'pmcid' : 'doi';

    // ── Branch routing → produce buckets the staged chain consumes ──────────
    let pmcIds: string[] = [];
    let pmidFallbackCandidates: PmidCandidate[] = [];
    let pmcidFallbackCandidates: PmcidCandidate[] = [];
    let doiCandidates: DoiCandidate[] = [];

    if (input.pmids) {
      for (const id of input.pmids) chainByInput.set(id, []);
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
          const normalized = normalizePmcId(String(r.pmcid));
          pmcIds.push(normalized);
          pmcidToInputId.set(withPmcPrefix(normalized), pmid);
          pmidContext.set(pmid, { pmid, ...(r.doi && { doi: r.doi }) });
        } else {
          chainByInput.get(pmid)?.push({
            tier: 'pmc',
            outcome: 'not-attempted',
            detail: 'PMID has no PMC counterpart',
          });
          pmidFallbackCandidates.push({ pmid, ...(r.doi && { doi: r.doi }) });
        }
      }
      for (const requested of input.pmids) {
        if (!seen.has(requested)) {
          chainByInput.get(requested)?.push({
            tier: 'pmc',
            outcome: 'not-attempted',
            detail: 'ID Converter returned no record for this PMID',
          });
          pmidFallbackCandidates.push({ pmid: requested });
        }
      }
    } else if (input.pmcids) {
      for (const id of input.pmcids) chainByInput.set(withPmcPrefix(normalizePmcId(id)), []);
      pmcIds = input.pmcids.map(normalizePmcId);
    } else if (input.dois) {
      // Mirror the `pmids` branch: resolve DOI → PMCID via the PMC ID Converter
      // so PMC-indexed DOIs reach PMC EFetch instead of going straight to the
      // EPMC/Unpaywall fallback (which misses articles whose only OA copy is the
      // PMC JATS). DOIs the converter can't place in PMC seed `doiCandidates`.
      const requestedDois = new Set(input.dois);
      for (const doi of input.dois) chainByInput.set(doi, []);
      const records = await getNcbiService().idConvert(
        input.dois,
        'doi',
        ctx.signal ? { signal: ctx.signal } : undefined,
      );
      const seen = new Set<string>();
      for (const r of records) {
        // The converter echoes the submitted id verbatim in `requested-id`;
        // match on it, not `r.doi` (DOIs aren't case-stable across the API).
        const doi = String(r['requested-id']);
        if (!requestedDois.has(doi)) continue;
        seen.add(doi);
        if (r.pmcid) {
          const normalized = normalizePmcId(String(r.pmcid));
          pmcIds.push(normalized);
          pmcidToInputId.set(withPmcPrefix(normalized), doi);
        } else {
          chainByInput.get(doi)?.push({
            tier: 'pmc',
            outcome: 'not-attempted',
            detail: 'DOI has no PMC counterpart',
          });
          doiCandidates.push({ doi });
        }
      }
      for (const requested of input.dois) {
        if (!seen.has(requested)) {
          chainByInput.get(requested)?.push({
            tier: 'pmc',
            outcome: 'not-attempted',
            detail: 'ID Converter returned no record for this DOI',
          });
          doiCandidates.push({ doi: requested });
        }
      }
    }

    // Route PMC-missed prefixed PMCIDs into the fallback buckets so EPMC and
    // (for pmids/dois) Unpaywall still get a chance. For pmids input we look up
    // the captured DOI hint via `pmidContext` to avoid an extra PubMed eFetch
    // when available; the converter often returns the DOI alongside a PMCID
    // match. For dois input the original DOI is the fallback key directly.
    const routePmcMissesToFallback = (missingPrefixed: string[]) => {
      if (missingPrefixed.length === 0) return;
      if (input.pmcids) {
        pmcidFallbackCandidates = missingPrefixed.map((pmcid) => ({ pmcid }));
      } else if (input.pmids) {
        for (const prefixed of missingPrefixed) {
          const pmid = pmcidToInputId.get(prefixed);
          if (pmid) pmidFallbackCandidates.push(pmidContext.get(pmid) ?? { pmid });
        }
      } else if (input.dois) {
        for (const prefixed of missingPrefixed) {
          const doi = pmcidToInputId.get(prefixed);
          if (doi) doiCandidates.push({ doi });
        }
      }
    };

    // ── Stage 1: PMC EFetch ─────────────────────────────────────────────────
    // Wrapped so transient NCBI failures fall through to EPMC/Unpaywall rather
    // than sinking the whole batch — the chain's contract is graceful fallback.
    let pmcArticles: z.infer<typeof PmcArticleSchema>[] = [];

    if (pmcIds.length > 0) {
      try {
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
        if (!articleSet) {
          throw new Error('PMC EFetch response missing pmc-articleset wrapper');
        }

        // A parsed article with no body sections is front matter only — PMC
        // returns one whenever the publisher blocks full-text XML download. It
        // is not a hit: it never enters `articles[]`, and its id is routed to
        // the remaining tiers like any other PMC miss. (#86)
        const bodylessPmcIds = new Set<string>();
        const parsed: z.infer<typeof PmcArticleSchema>[] = [];
        for (const node of findAll(articleSet, 'article')) {
          const before = parsePmcArticle(node);
          if (isBodylessArticle(before)) {
            if (before.pmcId) bodylessPmcIds.add(before.pmcId);
            continue;
          }
          const after = applyPmcFilters(before, input);
          if (isSectionFilterMiss(before, after, input.sections)) {
            sectionFilterMisses.push(articleDisplayId(after));
          }
          const budgeted = applyPmcBudget(after, budget);
          omittedSections += budgeted.omittedSections;
          if (budgeted.truncation) {
            truncatedArticles.push({
              id: articleDisplayId(after),
              source: 'pmc',
              ...budgeted.truncation,
            });
          }
          parsed.push({ source: 'pmc' as const, viaSource: 'pmc' as const, ...budgeted.article });
        }
        pmcArticles = parsed;

        const returnedPmcIds = new Set(
          pmcArticles.map((a) => a.pmcId).filter((id): id is string => !!id),
        );
        for (const prefixed of returnedPmcIds) {
          recoveredIds.add(pmcidToInputId.get(prefixed) ?? prefixed);
        }
        const missing = pmcIds
          .map((id) => withPmcPrefix(id))
          .filter((id) => !returnedPmcIds.has(id));
        for (const prefixed of missing) {
          const inputId = pmcidToInputId.get(prefixed) ?? prefixed;
          if (bodylessPmcIds.has(prefixed)) {
            bodylessInputIds.add(inputId);
            chainByInput.get(inputId)?.push({
              tier: 'pmc',
              outcome: 'no-body',
              detail: 'PMC returned front matter and abstract only, with no body sections',
            });
          } else {
            chainByInput.get(inputId)?.push({ tier: 'pmc', outcome: 'miss' });
          }
        }
        routePmcMissesToFallback(missing);
      } catch (error: unknown) {
        const detail = error instanceof Error ? error.message : String(error);
        ctx.log.warning('PMC EFetch failed; chain continues with next layer', {
          pmcIdCount: pmcIds.length,
          error: detail,
        });
        const allPrefixed = pmcIds.map(withPmcPrefix);
        for (const prefixed of allPrefixed) {
          const inputId = pmcidToInputId.get(prefixed) ?? prefixed;
          chainByInput.get(inputId)?.push({ tier: 'pmc', outcome: 'service-error', detail });
        }
        routePmcMissesToFallback(allPrefixed);
      }
    }

    // ── Stage 2: Europe PMC fullTextXML ─────────────────────────────────────
    const epmc = getEuropePmcService();
    const epmcOutcomes = epmc
      ? await runEpmcStage(epmc, {
          pmidFallbackCandidates,
          pmcidFallbackCandidates,
          doiCandidates,
          input,
          budget,
          ctx,
        })
      : {
          articles: [],
          remainingPmid: pmidFallbackCandidates,
          remainingPmcid: pmcidFallbackCandidates,
          remainingDoi: doiCandidates,
          pmidOutcomes: new Map<string, EpmcCandidateOutcome>(),
          pmcidOutcomes: new Map<string, EpmcCandidateOutcome>(),
          doiOutcomes: new Map<string, EpmcCandidateOutcome>(),
          sectionFilterMisses: [],
          truncatedArticles: [],
          omittedSections: 0,
        };

    pmcArticles = pmcArticles.concat(epmcOutcomes.articles);
    truncatedArticles.push(...epmcOutcomes.truncatedArticles);
    omittedSections += epmcOutcomes.omittedSections;

    // Fold EPMC outcomes into each id's chain. EPMC-served articles count as
    // recovered, so their ids are added to `recoveredIds` here.
    if (!epmc) {
      const epmcDisabledEntry = {
        tier: 'europepmc' as const,
        outcome: 'not-attempted' as const,
        detail: 'EUROPEPMC_ENABLED=false',
      };
      for (const c of pmidFallbackCandidates) chainByInput.get(c.pmid)?.push(epmcDisabledEntry);
      for (const c of pmcidFallbackCandidates) {
        const prefixed = withPmcPrefix(c.pmcid);
        chainByInput.get(pmcidToInputId.get(prefixed) ?? prefixed)?.push(epmcDisabledEntry);
      }
      for (const c of doiCandidates) chainByInput.get(c.doi)?.push(epmcDisabledEntry);
    } else {
      const foldEpmcOutcome = (inputId: string, outcome: EpmcCandidateOutcome) => {
        if (outcome.kind === 'hit') {
          recoveredIds.add(inputId);
          return;
        }
        if (outcome.kind === 'no-body') bodylessInputIds.add(inputId);
        chainByInput.get(inputId)?.push(epmcTierFromOutcome(outcome));
      };
      for (const [pmid, outcome] of epmcOutcomes.pmidOutcomes) foldEpmcOutcome(pmid, outcome);
      for (const [prefixed, outcome] of epmcOutcomes.pmcidOutcomes) {
        foldEpmcOutcome(pmcidToInputId.get(prefixed) ?? prefixed, outcome);
      }
      for (const [doi, outcome] of epmcOutcomes.doiOutcomes) foldEpmcOutcome(doi, outcome);
    }

    pmidFallbackCandidates = epmcOutcomes.remainingPmid;
    pmcidFallbackCandidates = epmcOutcomes.remainingPmcid;
    doiCandidates = epmcOutcomes.remainingDoi;
    sectionFilterMisses.push(...epmcOutcomes.sectionFilterMisses);

    // ── Stage 3: Unpaywall fallback ─────────────────────────────────────────
    const unpaywall = getUnpaywallService();
    const fallbackArticles: z.infer<typeof UnpaywallArticleSchema>[] = [];

    // `pmcids` input reaches Unpaywall on the DOI the chain already holds: the
    // EPMC stage searches by PMCID and its hit carries one, captured on non-hit
    // outcomes too. PMCIDs EPMC never resolved fall back to the PMC ID
    // Converter, which returns DOIs for PMC-indexed records. (#88)
    if (pmcidFallbackCandidates.length > 0) {
      if (!unpaywall) {
        for (const c of pmcidFallbackCandidates) {
          const prefixed = withPmcPrefix(c.pmcid);
          chainByInput.get(pmcidToInputId.get(prefixed) ?? prefixed)?.push({
            tier: 'unpaywall',
            outcome: 'not-attempted',
            detail: 'UNPAYWALL_EMAIL is not set',
          });
        }
      } else {
        const needDoi = pmcidFallbackCandidates
          .filter((c) => !c.doi)
          .map((c) => withPmcPrefix(c.pmcid));
        if (needDoi.length > 0) {
          try {
            const records = await getNcbiService().idConvert(
              needDoi,
              'pmcid',
              ctx.signal ? { signal: ctx.signal } : undefined,
            );
            const doiByPmcid = new Map<string, string>();
            for (const r of records) {
              if (r.pmcid && r.doi) {
                doiByPmcid.set(withPmcPrefix(normalizePmcId(String(r.pmcid))), String(r.doi));
              }
            }
            pmcidFallbackCandidates = pmcidFallbackCandidates.map((c) => {
              if (c.doi) return c;
              const doi = doiByPmcid.get(withPmcPrefix(c.pmcid));
              return doi ? { ...c, doi } : c;
            });
          } catch (error: unknown) {
            ctx.log.warning('Failed to resolve PMCID → DOI for the Unpaywall fallback', {
              error: error instanceof Error ? error.message : String(error),
              pmcidCount: needDoi.length,
            });
          }
        }

        const outcomes = await Promise.all(
          pmcidFallbackCandidates.map(async (candidate) => {
            // The prefixed PMCID is the id `unavailable[]` keys on, so stamping
            // it on the article makes a partially-recovered batch report its
            // successes and its failures under the same identifier. (#92)
            const pmcId = withPmcPrefix(candidate.pmcid);
            return {
              pmcId,
              result: candidate.doi
                ? await resolveUnpaywall({ pmcId, doi: candidate.doi, budget }, unpaywall, ctx)
                : ({ unavailable: { reason: 'no-doi' } } as FallbackOutcome),
            };
          }),
        );
        for (const { pmcId, result } of outcomes) {
          const inputId = pmcidToInputId.get(pmcId) ?? pmcId;
          if ('article' in result) {
            fallbackArticles.push(result.article);
            if (result.truncation) truncatedArticles.push(result.truncation);
            recoveredIds.add(inputId);
          } else {
            const u = result.unavailable;
            chainByInput.get(inputId)?.push({
              tier: 'unpaywall',
              outcome: unpaywallReasonToTierOutcome(u.reason),
              ...(u.detail && { detail: u.detail }),
            });
          }
        }
      }
    }

    if (pmidFallbackCandidates.length > 0) {
      // The PMC ID Converter only returns DOIs for articles it has in PMC, so
      // candidates here are missing DOIs by default. Pull them from PubMed
      // metadata (db=pubmed) before dispatching to Unpaywall.
      const needDoi = pmidFallbackCandidates.filter((c) => !c.doi).map((c) => c.pmid);
      if (needDoi.length > 0) {
        try {
          const doiMap = await fetchPubmedDois(needDoi, ctx.signal);
          pmidFallbackCandidates = pmidFallbackCandidates.map((c) => {
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

      if (!unpaywall) {
        for (const c of pmidFallbackCandidates) {
          chainByInput.get(c.pmid)?.push({
            tier: 'unpaywall',
            outcome: 'not-attempted',
            detail: 'UNPAYWALL_EMAIL is not set',
          });
        }
      } else {
        const outcomes = await Promise.all(
          pmidFallbackCandidates.map(async (candidate) => ({
            candidate,
            result: candidate.doi
              ? await resolveUnpaywall(
                  { pmid: candidate.pmid, doi: candidate.doi, budget },
                  unpaywall,
                  ctx,
                )
              : ({ unavailable: { reason: 'no-doi' } } as FallbackOutcome),
          })),
        );
        for (const { candidate, result } of outcomes) {
          if ('article' in result) {
            fallbackArticles.push(result.article);
            if (result.truncation) truncatedArticles.push(result.truncation);
            recoveredIds.add(candidate.pmid);
          } else {
            const u = result.unavailable;
            chainByInput.get(candidate.pmid)?.push({
              tier: 'unpaywall',
              outcome: unpaywallReasonToTierOutcome(u.reason),
              ...(u.detail && { detail: u.detail }),
            });
          }
        }
      }
    }

    if (doiCandidates.length > 0) {
      if (!unpaywall) {
        for (const c of doiCandidates) {
          chainByInput.get(c.doi)?.push({
            tier: 'unpaywall',
            outcome: 'not-attempted',
            detail: 'UNPAYWALL_EMAIL is not set',
          });
        }
      } else {
        // `resolveUnpaywall` catches its own failures so this Promise.all
        // doesn't reject under normal operation.
        const outcomes = await Promise.all(
          doiCandidates.map(async (c) => ({
            doi: c.doi,
            result: await resolveUnpaywall({ doi: c.doi, budget }, unpaywall, ctx),
          })),
        );
        for (const { doi, result } of outcomes) {
          if ('article' in result) {
            fallbackArticles.push(result.article);
            if (result.truncation) truncatedArticles.push(result.truncation);
            recoveredIds.add(doi);
          } else {
            const u = result.unavailable;
            chainByInput.get(doi)?.push({
              tier: 'unpaywall',
              outcome: unpaywallReasonToTierOutcome(u.reason),
              ...(u.detail && { detail: u.detail }),
            });
          }
        }
      }
    }

    // ── Assemble unavailable[] from chains ──────────────────────────────────
    const unavailable: z.infer<typeof UnavailableSchema>[] = [];
    for (const [id, chain] of chainByInput) {
      if (recoveredIds.has(id)) continue;
      unavailable.push({
        id,
        idType,
        reason: reasonFromChain(chain),
        triedTiers: chain,
      });
    }

    const articles = [...pmcArticles, ...fallbackArticles];

    ctx.log.info('pubmed_fetch_fulltext completed', {
      requested: (input.pmids ?? input.pmcids ?? input.dois)?.length ?? 0,
      returned: articles.length,
      pmcHits: pmcArticles.filter((a) => a.viaSource === 'pmc').length,
      epmcHits: pmcArticles.filter((a) => a.viaSource === 'europepmc').length,
      unpaywallHits: fallbackArticles.length,
      unavailable: unavailable.length,
    });

    // Rolled up only when the budget actually removed characters, so an
    // under-budget request returns exactly what it did before the budget
    // controls existed. (#81)
    const truncation: z.infer<typeof TruncationSchema> | undefined =
      truncatedArticles.length > 0
        ? {
            mode: input.overflowMode,
            ...(input.maxCharacters !== undefined && { maxCharacters: input.maxCharacters }),
            ...(input.maxCharactersPerSection !== undefined && {
              maxCharactersPerSection: input.maxCharactersPerSection,
            }),
            originalCharacters: truncatedArticles.reduce((n, a) => n + a.originalCharacters, 0),
            returnedCharacters: truncatedArticles.reduce((n, a) => n + a.returnedCharacters, 0),
            omittedSections,
            articles: truncatedArticles,
          }
        : undefined;

    // Only the last ctx.enrich.notice survives, so the applicable fragments are
    // collected and emitted once.
    const notices: string[] = [];
    if (input.sections?.length && sectionFilterMisses.length > 0) {
      notices.push(buildSectionFilterMissNotice(sectionFilterMisses, input.sections));
    }
    const unrecoveredBodyless = [...bodylessInputIds].filter((id) => !recoveredIds.has(id));
    if (unrecoveredBodyless.length > 0) notices.push(buildBodylessNotice(unrecoveredBodyless));
    if (truncation) notices.push(buildTruncationNotice(truncation));
    if (notices.length > 0) ctx.enrich.notice(notices.join(' '));

    return {
      articles,
      totalReturned: articles.length,
      ...(unavailable.length > 0 && { unavailable }),
      ...(truncation && { truncation }),
    };
  },

  format: (result) => {
    const lines = [`## Full-Text Articles`, `**Articles Returned:** ${result.totalReturned}`];

    if (result.unavailable?.length) {
      lines.push(`\n**Unavailable (${result.unavailable.length}):**`);
      for (const u of result.unavailable) {
        lines.push(`- [${u.idType}] ${u.id} — ${u.reason}`);
        const chain = u.triedTiers
          .map((t) => {
            const detail = t.detail ? sanitizeChainDetail(t.detail) : undefined;
            return `${t.tier}:${t.outcome}${detail ? ` (${detail})` : ''}`;
          })
          .join(' → ');
        if (chain) lines.push(`  chain: ${chain}`);
      }
    }

    if (result.totalReturned === 0) {
      lines.push(
        `\n> No full-text articles returned. Articles must be open-access and indexed in PMC, Europe PMC, or recoverable via Unpaywall to retrieve full text. For metadata and abstracts only, use \`pubmed_fetch_articles\`.`,
      );
    }

    if (result.truncation) formatTruncation(result.truncation, lines);

    const truncationById = new Map(result.truncation?.articles.map((t) => [t.id, t]) ?? []);
    for (const a of result.articles) {
      lines.push('');
      const t = truncationById.get(articleDisplayId(a));
      if (a.source === 'pmc') formatPmcArticle(a, lines, t);
      else formatUnpaywallArticle(a, lines, t);
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});

// ─── Handler helpers ─────────────────────────────────────────────────────────

/** A PMID not present in PMC, optionally paired with a DOI for Unpaywall lookup. */
type PmidCandidate = { pmid: string; doi?: string };

/**
 * A PMCID requested directly but not returned by PMC EFetch, optionally paired
 * with a DOI for the Unpaywall lookup. The DOI arrives from the Europe PMC hit
 * the stage already made, or from the PMC ID Converter when EPMC never resolved
 * the record. (#88)
 */
type PmcidCandidate = { pmcid: string; doi?: string };

/** A DOI candidate for direct DOI input. */
type DoiCandidate = { doi: string };

/** Reason + optional detail returned by the Unpaywall resolver; the handler
 *  stamps `id`/`idType`/`triedTiers` on top when building unavailable entries. */
type UnpaywallResolverFailure = {
  reason: z.infer<typeof UnavailableReasonSchema>;
  detail?: string;
};

type FallbackOutcome =
  | {
      article: z.infer<typeof UnpaywallArticleSchema>;
      truncation?: z.infer<typeof TruncatedArticleSchema>;
    }
  | { unavailable: UnpaywallResolverFailure };

interface EpmcStageInput {
  budget: BudgetOptions;
  ctx: Context;
  doiCandidates: DoiCandidate[];
  input: PmcFilterOptions;
  pmcidFallbackCandidates: PmcidCandidate[];
  pmidFallbackCandidates: PmidCandidate[];
}

/** Per-candidate EPMC outcome the handler folds into each id's `triedTiers` chain. */
type EpmcCandidateOutcome =
  | { kind: 'hit' }
  | { kind: 'miss' }
  | { kind: 'no-fulltext'; detail?: string }
  | { kind: 'no-body'; detail: string }
  | { kind: 'service-error'; detail: string };

interface EpmcStageOutput {
  articles: z.infer<typeof PmcArticleSchema>[];
  /** Per-doi outcome (keyed by doi string). */
  doiOutcomes: Map<string, EpmcCandidateOutcome>;
  /** Body sections the character budget dropped across EPMC-served articles. */
  omittedSections: number;
  /** Per-PMCID outcome (keyed by `PMC<digits>` prefixed form). */
  pmcidOutcomes: Map<string, EpmcCandidateOutcome>;
  /** Per-pmid outcome (keyed by pmid string). */
  pmidOutcomes: Map<string, EpmcCandidateOutcome>;
  remainingDoi: DoiCandidate[];
  remainingPmcid: PmcidCandidate[];
  remainingPmid: PmidCandidate[];
  /** Ids of EPMC-served articles whose `sections` filter removed every body section. */
  sectionFilterMisses: string[];
  /** Character accounting for EPMC-served articles the budget shortened. */
  truncatedArticles: z.infer<typeof TruncatedArticleSchema>[];
}

/**
 * Run the Europe PMC step against everything that fell through PMC EFetch
 * plus any direct DOI input. Each candidate goes through search-by-best-id →
 * fullTextXML. Hits become `source: 'pmc'` articles with `viaSource: 'europepmc'`;
 * misses flow through to the Unpaywall stage unchanged.
 *
 * Candidates run in parallel — the EPMC request queue caps concurrency so this
 * stays polite without serializing. Errors are caught and logged inside the
 * helpers; a transient EPMC failure must not block the downstream Unpaywall
 * fallback.
 */
async function runEpmcStage(
  epmc: EuropePmcService,
  args: EpmcStageInput,
): Promise<EpmcStageOutput> {
  type CandidateRun<C> = {
    c: C;
    outcome: EpmcCandidateOutcome;
    article?: z.infer<typeof PmcArticleSchema>;
    sectionFilterMiss?: boolean;
    /** DOI carried by the EPMC hit, captured on non-hit outcomes too so the
     *  Unpaywall stage can use it for `pmcids` input. (#88) */
    doi?: string;
    /** Character accounting when the budget shortened this article. (#81) */
    truncation?: z.infer<typeof TruncatedArticleSchema>;
    omittedSections?: number;
  };

  const runOne = async <C>(
    c: C,
    query: string,
    contextPmid: string | undefined,
  ): Promise<CandidateRun<C>> => {
    const search = await searchEpmcSafe(epmc, query, args.ctx);
    if (search.kind === 'error') {
      return { c, outcome: { kind: 'service-error', detail: search.detail } };
    }
    if (search.kind === 'miss') return { c, outcome: { kind: 'miss' } };
    const doi = search.hit.doi ? { doi: search.hit.doi } : {};
    const fetched = await fetchEpmcArticle(epmc, search.hit, args, contextPmid);
    if (fetched.kind === 'error') {
      return { c, ...doi, outcome: { kind: 'service-error', detail: fetched.detail } };
    }
    if (fetched.kind === 'no-fulltext') {
      return {
        c,
        ...doi,
        outcome: { kind: 'no-fulltext', ...(fetched.detail && { detail: fetched.detail }) },
      };
    }
    if (fetched.kind === 'no-body') {
      return { c, ...doi, outcome: { kind: 'no-body', detail: fetched.detail } };
    }
    return {
      c,
      ...doi,
      outcome: { kind: 'hit' },
      article: fetched.article,
      sectionFilterMiss: fetched.sectionFilterMiss,
      omittedSections: fetched.omittedSections,
      ...(fetched.truncation && { truncation: fetched.truncation }),
    };
  };

  /**
   * Query shapes are load-bearing and not interchangeable with their quoted
   * variants. Europe PMC matches zero records for `EXT_ID:"<pmid>" AND SRC:MED`
   * and `PMCID:"PMC<digits>"` — the quotes only survive as long as no `AND SRC:`
   * clause follows. `SRC:PMC` is likewise wrong for a PMCID lookup: EPMC's
   * canonical record for a PMC-indexed article has `source: MED` and carries the
   * PMCID as a field, so the filter excludes the very record being sought. DOIs
   * keep their quotes — they carry slashes and dots that need them. (#85)
   */
  const fetchForPmid = (c: PmidCandidate) => runOne(c, `EXT_ID:${c.pmid} AND SRC:MED`, c.pmid);
  const fetchForPmcid = (c: PmcidCandidate) => {
    const normalized = withPmcPrefix(c.pmcid);
    return runOne({ c, normalized }, `PMCID:${normalized}`, undefined);
  };
  const fetchForDoi = (c: DoiCandidate) => runOne(c, `DOI:"${c.doi}"`, undefined);

  const [pmidResults, pmcidResults, doiResults] = await Promise.all([
    Promise.all(args.pmidFallbackCandidates.map(fetchForPmid)),
    Promise.all(args.pmcidFallbackCandidates.map(fetchForPmcid)),
    Promise.all(args.doiCandidates.map(fetchForDoi)),
  ]);

  const articles: z.infer<typeof PmcArticleSchema>[] = [];
  const remainingPmid: PmidCandidate[] = [];
  const remainingPmcid: PmcidCandidate[] = [];
  const remainingDoi: DoiCandidate[] = [];
  const pmidOutcomes = new Map<string, EpmcCandidateOutcome>();
  const pmcidOutcomes = new Map<string, EpmcCandidateOutcome>();
  const doiOutcomes = new Map<string, EpmcCandidateOutcome>();
  const sectionFilterMisses: string[] = [];
  const truncatedArticles: z.infer<typeof TruncatedArticleSchema>[] = [];
  let omittedSections = 0;

  const collectHit = (run: {
    article: z.infer<typeof PmcArticleSchema>;
    sectionFilterMiss?: boolean;
    truncation?: z.infer<typeof TruncatedArticleSchema>;
    omittedSections?: number;
  }) => {
    articles.push(run.article);
    if (run.sectionFilterMiss) sectionFilterMisses.push(articleDisplayId(run.article));
    if (run.truncation) truncatedArticles.push(run.truncation);
    omittedSections += run.omittedSections ?? 0;
  };

  for (const run of pmidResults) {
    pmidOutcomes.set(run.c.pmid, run.outcome);
    if (run.article) collectHit({ ...run, article: run.article });
    else remainingPmid.push(run.c);
  }
  for (const run of pmcidResults) {
    pmcidOutcomes.set(run.c.normalized, run.outcome);
    if (run.article) collectHit({ ...run, article: run.article });
    else remainingPmcid.push(run.doi && !run.c.c.doi ? { ...run.c.c, doi: run.doi } : run.c.c);
  }
  for (const run of doiResults) {
    doiOutcomes.set(run.c.doi, run.outcome);
    if (run.article) collectHit({ ...run, article: run.article });
    else remainingDoi.push(run.c);
  }

  return {
    articles,
    remainingPmid,
    remainingPmcid,
    remainingDoi,
    pmidOutcomes,
    pmcidOutcomes,
    doiOutcomes,
    sectionFilterMisses,
    truncatedArticles,
    omittedSections,
  };
}

type EpmcSearchResult =
  | { kind: 'hit'; hit: EuropePmcSearchHit }
  | { kind: 'miss' }
  | { kind: 'error'; detail: string };

/**
 * Single-hit Europe PMC search with discriminated outcomes so the chain can
 * record `miss` vs `service-error` separately. Errors are logged and swallowed
 * so transient EPMC failures fall through to the next stage instead of
 * aborting the chain.
 */
async function searchEpmcSafe(
  epmc: EuropePmcService,
  query: string,
  ctx: Context,
): Promise<EpmcSearchResult> {
  try {
    const result = await epmc.search({
      query,
      resultType: 'core',
      pageSize: 1,
      ...(ctx.signal && { signal: ctx.signal }),
    });
    return result.hits[0] ? { kind: 'hit', hit: result.hits[0] } : { kind: 'miss' };
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    ctx.log.warning('Europe PMC search failed; chain continues with next layer', {
      query,
      error: detail,
    });
    return { kind: 'error', detail };
  }
}

type EpmcFetchResult =
  | {
      kind: 'article';
      article: z.infer<typeof PmcArticleSchema>;
      sectionFilterMiss: boolean;
      omittedSections: number;
      truncation?: z.infer<typeof TruncatedArticleSchema>;
    }
  | { kind: 'no-fulltext'; detail?: string }
  | { kind: 'no-body'; detail: string }
  | { kind: 'error'; detail: string };

/**
 * Fetch and parse the JATS for an EPMC hit. Returns a discriminated outcome so
 * the chain can record `no-fulltext` (record exists but EPMC publishes no JATS)
 * separately from `service-error` (transient failure). Preprints/patents and
 * MED-only records without a PMC counterpart short-circuit to `no-fulltext`
 * since EPMC's fullTextXML endpoint is PMC-keyed.
 */
async function fetchEpmcArticle(
  epmc: EuropePmcService,
  hit: EuropePmcSearchHit,
  args: EpmcStageInput,
  contextPmid?: string,
): Promise<EpmcFetchResult> {
  // EPMC's fullTextXML endpoint is PMC-keyed (URL: `/{PMC<digits>}/fullTextXML`).
  // For PMC-source hits, `hit.id` already is the PMC ID; for MED hits, `hit.pmcid`
  // carries the counterpart when one exists. Preprints (PPR) and patents (PAT)
  // have no PMC ID, so fullTextXML is never available.
  const pmcLookupId = hit.pmcid ?? (hit.source === 'PMC' ? hit.id : undefined);
  if (!pmcLookupId) {
    return { kind: 'no-fulltext', detail: `EPMC source ${hit.source} has no PMC counterpart` };
  }

  try {
    const result = await epmc.fullTextXml(pmcLookupId, hit.source, args.ctx.signal ?? undefined);
    if (result.kind === 'not-available') {
      return { kind: 'no-fulltext', detail: 'EPMC fullTextXML not available for this record' };
    }

    const articleNode = epmc.parseFullTextXml(result.xml);
    if (!articleNode) {
      return { kind: 'no-fulltext', detail: 'EPMC fullTextXML payload had no <article> element' };
    }

    const beforeFilter = parsePmcArticle(articleNode);
    if (isBodylessArticle(beforeFilter)) {
      return {
        kind: 'no-body',
        detail: 'EPMC fullTextXML carried front matter and abstract only, with no body sections',
      };
    }

    const parsed = applyPmcFilters(beforeFilter, args.input);
    const sectionFilterMiss = isSectionFilterMiss(beforeFilter, parsed, args.input.sections);
    const budgeted = applyPmcBudget(parsed, args.budget);

    // `parsePmcArticle` always returns string fields (sometimes empty). Strip
    // empty `pmcId`/`pmcUrl` for EPMC-only records (preprints) so the schema's
    // optional shape is respected — agents read `epmcId`/`epmcSource` for those.
    const { pmcId, pmcUrl, ...rest } = budgeted.article;
    const pmid = rest.pmid ?? hit.pmid ?? contextPmid;
    const doi = rest.doi ?? hit.doi;

    const article = {
      source: 'pmc' as const,
      viaSource: 'europepmc' as const,
      ...rest,
      ...(pmcId && { pmcId, pmcUrl }),
      ...(pmid && {
        pmid,
        pubmedUrl: rest.pubmedUrl ?? `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`,
      }),
      ...(doi && { doi }),
      epmcId: hit.id,
      epmcSource: hit.source,
    };

    return {
      kind: 'article',
      sectionFilterMiss,
      article,
      omittedSections: budgeted.omittedSections,
      ...(budgeted.truncation && {
        truncation: {
          id: articleDisplayId(article),
          source: 'pmc' as const,
          ...budgeted.truncation,
        },
      }),
    };
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    args.ctx.log.warning('Europe PMC fullTextXML failed; chain continues with next layer', {
      epmcId: hit.id,
      source: hit.source,
      error: detail,
    });
    return { kind: 'error', detail };
  }
}

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

/**
 * Resolve a DOI to an open-access article via Unpaywall. `pmcId` and `pmid`,
 * when set, are stamped onto the resulting article so the branch that requested
 * it carries its identifier through — Unpaywall itself only knows the DOI.
 */
async function resolveUnpaywall(
  args: { pmcId?: string; pmid?: string; doi: string; budget: BudgetOptions },
  service: UnpaywallService,
  ctx: Context,
): Promise<FallbackOutcome> {
  const { pmcId, pmid, doi, budget } = args;
  const requestedIds = { ...(pmcId && { pmcId }), ...(pmid && { pmid }) };

  /** Budget the extracted body, then pair the article with its accounting. */
  const budgeted = (
    build: (content: string) => z.infer<typeof UnpaywallArticleSchema>,
    content: string,
  ): FallbackOutcome => {
    const capped = applyContentBudget(content, budget);
    const article = build(capped.content);
    return {
      article,
      ...(capped.truncation && {
        truncation: {
          id: articleDisplayId(article),
          source: 'unpaywall' as const,
          ...capped.truncation,
        },
      }),
    };
  };

  let resolution: UnpaywallResolution;
  try {
    resolution = await service.resolve(doi, ctx.signal);
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    ctx.log.warning('Unpaywall DOI resolve failed', { doi, error: detail });
    return { unavailable: { reason: 'service-error', detail } };
  }

  if (resolution.kind === 'no-oa') {
    return { unavailable: { reason: 'no-oa', detail: resolution.reason } };
  }

  let content: UnpaywallContent;
  try {
    content = await service.fetchContent(resolution.location, ctx.signal);
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    ctx.log.warning('Unpaywall content fetch failed', { doi, error: detail });
    return { unavailable: { reason: 'fetch-failed', detail } };
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
            reason: 'parse-failed',
            detail: 'HTML extraction produced empty content',
          },
        };
      }
      return budgeted(
        (text) =>
          buildUnpaywallArticle({
            ...requestedIds,
            doi,
            sourceUrl: content.fetchedUrl,
            location: resolution.location,
            contentFormat: 'html-markdown',
            content: text,
            title: extracted.title,
            wordCount: extracted.wordCount,
          }),
        body,
      );
    }

    const extracted = await pdfParser.extractText(content.body, { mergePages: true });
    const text = typeof extracted.text === 'string' ? extracted.text.trim() : '';
    if (!text) {
      return {
        unavailable: { reason: 'parse-failed', detail: 'PDF extraction produced empty text' },
      };
    }
    return budgeted(
      (body) =>
        buildUnpaywallArticle({
          ...requestedIds,
          doi,
          sourceUrl: content.fetchedUrl,
          location: resolution.location,
          contentFormat: 'pdf-text',
          content: body,
          totalPages: extracted.totalPages,
        }),
      text,
    );
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    ctx.log.warning('Unpaywall content extraction failed', { pmid, doi, detail });
    return { unavailable: { reason: 'parse-failed', detail } };
  }
}

function buildUnpaywallArticle(args: {
  pmcId?: string;
  pmid?: string;
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
    viaSource: 'unpaywall',
    contentFormat: args.contentFormat,
    ...(args.pmcId && { pmcId: args.pmcId }),
    ...(args.pmid && {
      pmid: args.pmid,
      pubmedUrl: `https://pubmed.ncbi.nlm.nih.gov/${args.pmid}/`,
    }),
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

/**
 * Convert an EPMC stage outcome into the `triedTiers` entry stored on
 * `chainByInput`. `hit` is filtered before calling — the chain only records
 * failure outcomes since recovered ids never appear in `unavailable[]`.
 */
function epmcTierFromOutcome(
  outcome: Exclude<EpmcCandidateOutcome, { kind: 'hit' }>,
): z.infer<typeof TriedTierSchema> {
  switch (outcome.kind) {
    case 'miss':
      return { tier: 'europepmc', outcome: 'miss' };
    case 'no-fulltext':
      return {
        tier: 'europepmc',
        outcome: 'no-fulltext',
        ...(outcome.detail && { detail: outcome.detail }),
      };
    case 'no-body':
      return { tier: 'europepmc', outcome: 'no-body', detail: outcome.detail };
    case 'service-error':
      return { tier: 'europepmc', outcome: 'service-error', detail: outcome.detail };
  }
}

/**
 * Map an Unpaywall-resolver `UnavailableReason` to its `TierOutcome`
 * counterpart. The two enums overlap on the values the Unpaywall path can
 * actually emit (`no-doi`, `no-oa`, `fetch-failed`, `parse-failed`,
 * `service-error`). Defensive branches cover values the resolver returns under
 * dead-code safety checks but never in normal flow.
 */
function unpaywallReasonToTierOutcome(
  reason: z.infer<typeof UnavailableReasonSchema>,
): z.infer<typeof TierOutcomeSchema> {
  switch (reason) {
    case 'no-body':
    case 'no-doi':
    case 'no-oa':
    case 'fetch-failed':
    case 'parse-failed':
    case 'service-error':
      return reason;
    case 'no-pmc-fallback-disabled':
      return 'not-attempted';
    case 'no-epmc-fulltext':
      return 'no-fulltext';
    case 'not-found':
      return 'miss';
  }
}

/**
 * Derive the terminal `reason` shown on the unavailable entry from its chain.
 * Skips `not-attempted` entries when summarizing — those record config state,
 * not content state, so they make a misleading `reason` when an earlier tier
 * produced a real signal (`pmc:miss`, `unpaywall:no-oa`, etc.). Only when every
 * tier was skipped does `reason` fall back to `no-pmc-fallback-disabled`.
 */
function reasonFromChain(
  chain: z.infer<typeof TriedTierSchema>[],
): z.infer<typeof UnavailableReasonSchema> {
  let lastSignal: z.infer<typeof TriedTierSchema> | undefined;
  for (const t of chain) {
    if (t.outcome !== 'not-attempted') lastSignal = t;
  }
  if (!lastSignal) return 'no-pmc-fallback-disabled';

  const key = `${lastSignal.tier}:${lastSignal.outcome}` as const;
  switch (key) {
    case 'pmc:miss':
    case 'europepmc:miss':
      return 'not-found';
    case 'europepmc:no-fulltext':
      return 'no-epmc-fulltext';
    case 'pmc:no-body':
    case 'europepmc:no-body':
      return 'no-body';
    case 'unpaywall:no-doi':
      return 'no-doi';
    case 'unpaywall:no-oa':
      return 'no-oa';
    case 'unpaywall:fetch-failed':
      return 'fetch-failed';
    case 'unpaywall:parse-failed':
      return 'parse-failed';
    case 'pmc:service-error':
    case 'unpaywall:service-error':
    case 'europepmc:service-error':
      return 'service-error';
    default:
      return 'not-found';
  }
}

// ─── format() helpers ────────────────────────────────────────────────────────

/**
 * Render the response-level character accounting. Every field is rendered
 * unconditionally so `content[]` readers see the same budget detail
 * `structuredContent` readers get. Counts are printed raw — no thousands
 * separators — so the numbers stay greppable. (#81)
 */
function formatTruncation(t: z.infer<typeof TruncationSchema>, lines: string[]): void {
  lines.push(
    `\n**Truncated (${t.mode} mode):** ${t.returnedCharacters} of ${t.originalCharacters} body characters returned across ${t.articles.length} article(s); ${t.omittedSections} section(s) omitted`,
  );
  const budgets = [
    t.maxCharacters === undefined ? undefined : `maxCharacters ${t.maxCharacters}`,
    t.maxCharactersPerSection === undefined
      ? undefined
      : `maxCharactersPerSection ${t.maxCharactersPerSection}`,
  ].filter((b): b is string => b !== undefined);
  if (budgets.length) lines.push(`Budget applied: ${budgets.join(', ')}`);

  for (const a of t.articles) {
    lines.push(
      `- ${a.id} (${a.source}): ${a.returnedCharacters} of ${a.originalCharacters} characters`,
    );
    for (const s of a.sections ?? []) {
      lines.push(
        `  - ${s.title ?? 'untitled section'} — ${s.returnedCharacters} of ${s.originalCharacters} characters (truncated: ${s.truncated})`,
      );
    }
  }
}

/** Per-article inline marker so a reader of one article's body knows it is partial. */
function truncationNote(t: z.infer<typeof TruncatedArticleSchema>): string {
  return `\n> Body shortened to fit the requested character budget — ${t.returnedCharacters} of ${t.originalCharacters} characters returned. See \`truncation\` for per-section counts.`;
}

function formatPmcArticle(
  a: z.infer<typeof PmcArticleSchema>,
  lines: string[],
  truncation?: z.infer<typeof TruncatedArticleSchema>,
): void {
  lines.push(`### ${a.title ?? a.pmcId}`);
  const sourceLabel =
    a.viaSource === 'europepmc'
      ? `Europe PMC (structured JATS${a.epmcSource ? `, source: ${a.epmcSource}` : ''})`
      : 'PMC (structured JATS)';
  lines.push(`**Source:** ${sourceLabel}`);

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
  if (a.pmcId) lines.push(`**PMCID:** ${a.pmcId}`);
  if (a.epmcId) lines.push(`**EPMC ID:** ${a.epmcId}${a.epmcSource ? ` (${a.epmcSource})` : ''}`);
  if (a.pmid) lines.push(`**PMID:** ${a.pmid}`);
  if (a.doi) lines.push(`**DOI:** ${a.doi}`);
  if (a.pmcUrl) lines.push(`**PMC:** ${a.pmcUrl}`);
  if (a.pubmedUrl) lines.push(`**PubMed:** ${a.pubmedUrl}`);
  if (a.keywords?.length) lines.push(`**Keywords:** ${a.keywords.join(', ')}`);
  if (truncation) lines.push(truncationNote(truncation));
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

function formatUnpaywallArticle(
  a: z.infer<typeof UnpaywallArticleSchema>,
  lines: string[],
  truncation?: z.infer<typeof TruncatedArticleSchema>,
): void {
  const requestedId = a.pmcId ? `PMCID ${a.pmcId}` : a.pmid ? `PMID ${a.pmid}` : `DOI ${a.doi}`;
  const heading = a.title ?? requestedId;
  const formatLabel =
    a.contentFormat === 'html-markdown'
      ? 'Unpaywall (HTML → Markdown, best-effort)'
      : 'Unpaywall (PDF → plain text)';
  lines.push(`### ${heading}`);
  lines.push(`**Source:** ${formatLabel}`);
  if (a.pmcId) lines.push(`**PMCID:** ${a.pmcId}`);
  if (a.pmid) lines.push(`**PMID:** ${a.pmid}`);
  lines.push(`**DOI:** ${a.doi}`);
  if (a.pubmedUrl) lines.push(`**PubMed:** ${a.pubmedUrl}`);
  lines.push(`**OA Copy:** ${a.sourceUrl}`);
  if (a.license) lines.push(`**License:** ${a.license}`);
  if (a.hostType) lines.push(`**Host Type:** ${a.hostType}`);
  if (a.version) lines.push(`**Version:** ${a.version}`);
  if (a.wordCount !== undefined) lines.push(`**Word Count:** ${a.wordCount}`);
  if (a.totalPages !== undefined) lines.push(`**Pages:** ${a.totalPages}`);
  lines.push(
    `\n> Section structure is not guaranteed for this source. Treat the content as best-effort raw text. OA location metadata courtesy of Unpaywall (https://unpaywall.org).`,
  );
  if (truncation) lines.push(truncationNote(truncation));
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

/**
 * Strip absolute URLs from chain detail strings. Upstream errors (e.g.
 * `Fetch failed for <eutils URL>. Status: 400`) leak endpoint paths and query
 * strings without adding actionable signal — the status code is the useful
 * part. The raw detail is preserved in `structuredContent` for clients that
 * want it.
 */
function sanitizeChainDetail(detail: string): string {
  return detail.replace(/https?:\/\/\S+/g, '<upstream>');
}
