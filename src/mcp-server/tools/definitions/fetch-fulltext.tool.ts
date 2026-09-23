/**
 * @fileoverview Full-text fetch tool. Resolves full-text articles through a
 * three-stage chain: NCBI PMC EFetch → Europe PMC `fullTextXML` → Unpaywall.
 * Accepts three mutually-exclusive input shapes:
 *
 *   - `pmcids` — fetch directly by PMC ID, once per record however it is
 *     spelled (`PMC123`, `pmc123`, `123`, zero-padded `PMC0123`), and reported
 *     in `PMC<digits>` form. Articles not in PMC fall through to EPMC by PMC ID,
 *     then to Unpaywall when the DOI is available.
 *   - `pmids` — resolve PMID → PMCID via PMC ID Converter, then run the chain.
 *     A zero-padded PMID runs as the PMID it spells; `unavailable[]` and
 *     `deferred.ids` report it as the caller wrote it.
 *   - `dois` — resolve DOI → PMCID via the PMC ID Converter (mirroring `pmids`),
 *     then run the chain. DOIs with no PMC counterpart fall through to EPMC
 *     search-by-DOI → fullTextXML, then Unpaywall (EPMC-only OA, preprints).
 *     DOIs are case-insensitive: every casing of one DOI runs the chain once,
 *     and `unavailable[]` reports each casing as the caller wrote it.
 *
 * Output uses a discriminated union on `source` (`pmc` | `unpaywall`) with an
 * extra `viaSource` discriminator that records which layer produced the
 * content. EPMC's JATS reuses the `pmc` schema shape because it's the same
 * DTD; `viaSource: 'europepmc'` distinguishes it from PMC EFetch output. An
 * Unpaywall article takes its title from Unpaywall's record, else the Europe
 * PMC record the chain searched, else (HTML only) the page itself.
 *
 * Europe PMC and Unpaywall failures are folded into each id's `triedTiers`
 * rather than thrown, so the declared `errors[]` covers the NCBI ID routing
 * alone.
 *
 * @module src/mcp-server/tools/definitions/fetch-fulltext.tool
 */

import { type Context, tool, z } from '@cyanheads/mcp-ts-core';
import { htmlExtractor, pdfParser } from '@cyanheads/mcp-ts-core/utils';
import { getServerConfig } from '@/config/server-config.js';
import { NCBI_SERVICE_ERRORS } from '@/services/error-contracts.js';
import {
  type EuropePmcService,
  getEuropePmcService,
} from '@/services/europe-pmc/europe-pmc-service.js';
import type { EuropePmcSearchHit } from '@/services/europe-pmc/types.js';
import { getNcbiService } from '@/services/ncbi/ncbi-service.js';
import { extractDoi, extractPmid } from '@/services/ncbi/parsing/article-parser.js';
import { parsePmcArticle } from '@/services/ncbi/parsing/pmc-article-parser.js';
import { findAll, findOne, type JatsNodeList } from '@/services/ncbi/parsing/pmc-xml-helpers.js';
import { toDisplayText } from '@/services/ncbi/parsing/text-helpers.js';
import { ensureArray } from '@/services/ncbi/parsing/xml-helpers.js';
import type {
  ParsedPmcArticle,
  ParsedPmcAsset,
  ParsedPmcTable,
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
import { fitWholeItems } from './_budget.js';
import { conceptMeta, EDAM_DATA_RETRIEVAL, SCHEMA_SCHOLARLY_ARTICLE } from './_concepts.js';
import { doiStringSchema, normalizePmid, pmcidStringSchema, pmidStringSchema } from './_schemas.js';
import { escapeMarkdownInline, escapeMarkdownTableCell, sliceAtWordBoundary } from './_text.js';

/**
 * Canonical digits of a PMC ID {@link pmcidStringSchema} accepted: the `PMC`
 * prefix dropped in any case, and leading zeros stripped the way
 * {@link normalizePmid} strips them. PMC EFetch reads `03531190` as PMC3531190
 * and answers with that record, so every `pmcids` path keys on this form — and
 * reports it back as `PMC<digits>`. An all-zero ID keeps `0`, which EFetch
 * still answers with its empty-list envelope. (#170)
 */
function normalizePmcId(id: string): string {
  return normalizePmid(id.replace(/^PMC/i, ''));
}

function withPmcPrefix(id: string): string {
  return id.startsWith('PMC') ? id : `PMC${id}`;
}

/** Case-insensitive substring match of one section heading against the filter. */
function matchesSectionFilter(title: string | undefined, lowerFilter: string[]): boolean {
  const lowered = title?.toLowerCase();
  return lowered !== undefined && lowerFilter.some((f) => lowered.includes(f));
}

function lowerCase(s: string): string {
  return s.toLowerCase();
}

/**
 * Prune a section tree to the branches a `sections` filter selects, matching
 * titles at every nesting depth rather than the top level alone. (#126)
 *
 * A section whose own title matches is returned whole — object identity
 * included, so an unfiltered subtree is never rebuilt. A section kept only
 * because a descendant matched becomes a breadcrumb: its `title` and `label`
 * survive so the match can be placed in the document, its own `text` is cleared
 * because the caller filtered that prose away, and it carries just the matching
 * branch of its subsections. Promoting the match to the top level instead would
 * make `maxSections` — which caps genuine top-level sections — count nested
 * content as top-level.
 */
function pruneSections(sections: ParsedSection[], lowerFilter: string[]): ParsedSection[] {
  const kept: ParsedSection[] = [];
  for (const section of sections) {
    if (matchesSectionFilter(section.title, lowerFilter)) {
      kept.push(section);
      continue;
    }
    const subsections = pruneSections(section.subsections ?? [], lowerFilter);
    if (subsections.length > 0) kept.push({ ...section, text: '', subsections });
  }
  return kept;
}

/**
 * Titles of the sections a `sections` filter actually selected — a section that
 * matched directly plus everything beneath it. Breadcrumb ancestors are left
 * out: their own text was cleared because the caller did not ask for it, and a
 * table sitting in one was not asked for either. Walks the *pruned* tree, so a
 * top-level section the `maxSections` slice removed contributes nothing.
 */
function matchedSectionTitles(sections: ParsedSection[], lowerFilter: string[]): Set<string> {
  const titles = new Set<string>();
  const walk = (nodes: ParsedSection[], inherited: boolean) => {
    for (const section of nodes) {
      const matched = inherited || matchesSectionFilter(section.title, lowerFilter);
      if (matched && section.title) titles.add(section.title);
      walk(section.subsections ?? [], matched);
    }
  };
  walk(sections, false);
  return titles;
}

interface PmcFilterOptions {
  includeAssets: boolean;
  includeReferences: boolean;
  includeTables: boolean;
  maxSections?: number | undefined;
  sections?: string[] | undefined;
}

/** One body section at any nesting level, as the parser produces it. */
type ParsedSection = ParsedPmcArticle['sections'][number];

/**
 * Render a section subtree as text blocks, in document order: each section's
 * heading on its own line above its text. Used for the levels past
 * {@link MAX_SECTION_DEPTH}, which have no node of their own to live in. (#112)
 */
function flattenSectionText(section: ParsedSection): string[] {
  const heading = section.title ? formatHeading(section.label, section.title) : undefined;
  const block = [heading, section.text].filter(Boolean).join('\n');
  return [...(block ? [block] : []), ...(section.subsections ?? []).flatMap(flattenSectionText)];
}

/**
 * Clamp a section tree to the depth the output schema declares. A section at the
 * deepest level absorbs its descendants into its own text instead of carrying
 * them as subsections the schema would strip on validation — silently, from both
 * `structuredContent` and `content[]`. Shallower trees pass through untouched.
 * (#112)
 */
function clampSectionDepth(sections: ParsedSection[], depth = 1): ParsedSection[] {
  return sections.map((section) => {
    const subsections = section.subsections;
    if (!subsections?.length) return section;
    if (depth < MAX_SECTION_DEPTH) {
      return { ...section, subsections: clampSectionDepth(subsections, depth + 1) };
    }
    const { subsections: _dropped, ...rest } = section;
    const tail = subsections.flatMap(flattenSectionText);
    return { ...rest, text: [section.text, ...tail].filter(Boolean).join('\n\n') };
  });
}

/** Anything carrying the optional table list — the article, before or after filtering. */
type WithTables = { tables?: ParsedPmcTable[] | undefined };

/**
 * Replace an article's table list, dropping the field entirely when nothing is
 * left. An empty array would read as "this article has no tables", which is the
 * one thing an absent field already says and a filtered-to-nothing list does
 * not mean.
 */
function withTables<T extends WithTables>(article: T, tables: ParsedPmcTable[]): T {
  const { tables: _replaced, ...rest } = article;
  return (tables.length > 0 ? { ...rest, tables } : rest) as T;
}

/**
 * Narrow the table list to what the request asked for. `includeTables: false`
 * is the wholesale off switch. An active `sections` filter narrows tables with
 * it: a table names the section it sat in — body, back matter or appendix
 * alike — so it survives when that section did, and a table that names no
 * section, such as a `<floats-group>` deposit, is dropped because the caller
 * asked for named headings and it belongs to none. With no `sections` filter
 * every table is returned. (#111)
 */
function applyTableFilters(article: ParsedPmcArticle, filters: PmcFilterOptions): ParsedPmcArticle {
  if (!article.tables?.length) return article;
  if (!filters.includeTables) return withTables(article, []);
  if (!filters.sections?.length) return article;

  const surviving = matchedSectionTitles(article.sections, filters.sections.map(lowerCase));
  return withTables(
    article,
    article.tables.filter((t) => t.sectionTitle !== undefined && surviving.has(t.sectionTitle)),
  );
}

/** Anything carrying the optional asset list — the article, before or after filtering. */
type WithAssets = { assets?: ParsedPmcAsset[] | undefined };

/**
 * Replace an article's asset list, dropping the field entirely when nothing is
 * left — the same rule {@link withTables} follows, and for the same reason: an
 * empty array claims the article deposits no figures, which a filtered-to-nothing
 * list does not mean.
 */
function withAssets<T extends WithAssets>(article: T, assets: ParsedPmcAsset[]): T {
  const { assets: _replaced, ...rest } = article;
  return (assets.length > 0 ? { ...rest, assets } : rest) as T;
}

/**
 * The positional marker the parser leaves in section text where an asset was
 * lifted out — `[Figure: Fig. 1]`, `[Supplementary: Table S3]`, or the bare
 * `[Figure]` / `[Supplementary]` when the deposit carries no label.
 *
 * Mirrors `assetMarker` in `pmc-article-parser.ts`, which is the only producer.
 * The two must stay byte-identical: this is what {@link stripAssetMarkers}
 * removes, and a marker built any other way would leave the real one in place.
 * Derived per asset rather than matched as a pattern, so prose that happens to
 * carry a bracketed word is never touched. (#130)
 */
function assetMarkerText(asset: ParsedPmcAsset): string {
  const kind = asset.assetType === 'figure' ? 'Figure' : 'Supplementary';
  return asset.label ? `[${kind}: ${asset.label}]` : `[${kind}]`;
}

/**
 * Remove every marker in `markers` from one text field and close the gap it
 * leaves: trailing whitespace on a line the marker ended, and the blank line a
 * marker that stood alone as its own block leaves behind.
 */
function stripAssetMarkers(text: string, markers: readonly string[]): string {
  if (!text) return text;
  let out = text;
  for (const marker of markers) out = out.split(marker).join('');
  if (out === text) return text;
  return out
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Strip asset markers from a section and every subsection beneath it. */
function sectionWithoutMarkers(section: ParsedSection, markers: readonly string[]): ParsedSection {
  const text = stripAssetMarkers(section.text, markers);
  const subsections = section.subsections?.map((sub) => sectionWithoutMarkers(sub, markers));
  if (text === section.text && subsections === undefined) return section;
  return { ...section, text, ...(subsections && { subsections }) };
}

/**
 * Narrow the asset list to what the request asked for, mirroring {@link
 * applyTableFilters}: `includeAssets: false` is the wholesale off switch, and an
 * active `sections` filter keeps an asset whose named section survived while
 * dropping one that names no section at all — a `<floats-group>` deposit — since
 * the caller asked for named headings and it belongs to none.
 *
 * Where it goes beyond the table counterpart: turning assets off also removes the
 * positional markers the parser left in the section text. The marker is the
 * lift's anchor, and without the array to resolve it against it points at
 * nothing. Prose-shaped blocks — lists, quotes, formulae — are section text
 * rather than assets and this switch never touches them. (#130)
 */
function applyAssetFilters(article: ParsedPmcArticle, filters: PmcFilterOptions): ParsedPmcArticle {
  const assets = article.assets;
  if (!assets?.length) return article;

  if (!filters.includeAssets) {
    const markers = assets.map(assetMarkerText);
    return withAssets(
      { ...article, sections: article.sections.map((s) => sectionWithoutMarkers(s, markers)) },
      [],
    );
  }
  if (!filters.sections?.length) return article;

  const surviving = matchedSectionTitles(article.sections, filters.sections.map(lowerCase));
  return withAssets(
    article,
    assets.filter((a) => a.sectionTitle !== undefined && surviving.has(a.sectionTitle)),
  );
}

/**
 * Apply the requested section/reference/table/asset filters, then clamp the
 * section tree to the depth the output schema carries. All of it runs here so every path
 * producing a `pmc` article — PMC EFetch and the Europe PMC stage — shares one
 * shape, and the budget helpers downstream count the text that will actually
 * survive validation. (#112)
 *
 * Order is load-bearing. Tables and assets are matched against the section tree
 * *after* `filterSections` and the `maxSections` slice, so they narrow with
 * exactly what the response returns, and *before* `clampSectionDepth`, which
 * folds sections past {@link MAX_SECTION_DEPTH} into a parent's text — their
 * titles vanish from the output while a table or figure still names them, so a
 * title set built after the clamp would drop entries that should have survived.
 * Stripping the asset markers also has to precede the clamp, or a marker in a
 * folded-away section survives in the text it was folded into. (#111, #130)
 */
function applyPmcFilters(article: ParsedPmcArticle, filters: PmcFilterOptions): ParsedPmcArticle {
  let out = article;
  if (filters.sections?.length) {
    out = { ...out, sections: pruneSections(out.sections, filters.sections.map(lowerCase)) };
  }
  if (filters.maxSections !== undefined) {
    out = { ...out, sections: out.sections.slice(0, filters.maxSections) };
  }
  if (!filters.includeReferences) {
    const { references: _, ...rest } = out;
    out = rest as ParsedPmcArticle;
  }
  out = applyTableFilters(out, filters);
  out = applyAssetFilters(out, filters);
  return { ...out, sections: clampSectionDepth(out.sections) };
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
 *
 * States the scope the filter actually searches — section and subsection titles
 * at every depth — so a caller who named a nested heading learns the term itself
 * matched nothing, rather than being left to suspect the filter never looked
 * that deep. (#126)
 */
function buildSectionFilterMissNotice(affectedIds: string[], sectionFilter: string[]): string {
  const terms = sectionFilter.join(', ');
  const subject =
    affectedIds.length === 1 ? `article ${affectedIds[0]}` : `articles ${affectedIds.join(', ')}`;
  return `No section or subsection title, at any nesting depth, matched the requested section filter (${terms}) for ${subject}. The full text was retrieved but every body section was filtered out. Retry without \`sections\`, or filter on broader headings such as Introduction, Methods, Results, or Discussion.`;
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

/**
 * How many `<sec>` levels the output schema carries as structured nodes. JATS
 * nesting is unbounded and the parser recurses without a cap, so the schema is
 * what decides how deep a section survives output validation — anything past it
 * used to be dropped silently from both output surfaces (#112). Sections deeper
 * than this are now flattened into the deepest surviving node's text instead, so
 * no body content is lost at any depth.
 *
 * Two is the ceiling the tool's own contract can verify, not a guess at how deep
 * real records nest: `format-parity`'s sentinel walker stops after 8 schema hops,
 * and `articles[]` → the article union → `sections[]` → `subsections[]` already
 * spends them all. A third `subsections` level puts its own elements out of the
 * walker's reach, so `format()` parity for that subtree would ship unverified.
 * Levels are inlined rather than expressed with `z.lazy()` regardless — a
 * self-referential schema emits `$defs`/`$ref`, which Gemini rejects.
 */
const MAX_SECTION_DEPTH = 2;

const SubsectionSchema = z
  .object({
    title: z.string().optional().describe('Subsection heading'),
    label: z.string().optional().describe('Subsection label'),
    text: z
      .string()
      .describe(
        'Subsection body text. Sections nested deeper than this level are folded in here in document order, each heading rendered on its own line above its text.',
      ),
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
    elocationId: z
      .string()
      .optional()
      .describe(
        'Electronic article locator from JATS `<elocation-id>` — the publisher-assigned article number (e.g. "e20542"). Journals that assign article numbers deposit no `<fpage>`, so this is the only locator on roughly half of PMC records. Never a substitute for `pages`; JATS carries no type attribute, so there is no counterpart to the `elocationIdType` that `pubmed_fetch_articles` reports.',
      ),
  })
  .describe('Journal information');

const ReferenceSchema = z
  .object({
    citation: z.string().describe('Citation text'),
    id: z.string().optional().describe('Reference ID'),
    label: z.string().optional().describe('Reference label'),
  })
  .describe('Reference entry');

/**
 * One `<table-wrap>`, hung off the article rather than off a section.
 *
 * The article is the only level that can hold every table: roughly a quarter of
 * real `<table-wrap>` elements sit in `<floats-group>`, `<back>`, a
 * `<table-wrap-group>` or an appendix, with no `<sec>` to attach to. A table
 * inside a section names it in {@link sectionTitle} instead of being placed by
 * position.
 *
 * The shape also lands exactly on the `format-parity` sentinel walker's eight-hop
 * budget — `articles[]` → the article union → `tables[]` → `rows[][]` — with no
 * headroom, and a section-hung variant would spend a hop the existing
 * `sections[]` → `subsections[]` chain already needs. Re-run
 * `bun run lint:mcp` after any change here; a level added anywhere inside puts
 * its own leaves out of the walker's reach and ships their `format()` parity
 * unverified. (#111, #112)
 */
const TableSchema = z
  .object({
    label: z.string().optional().describe('Table label as printed, e.g. `TABLE 1`'),
    caption: z.string().optional().describe('Caption text, with the label excluded'),
    id: z
      .string()
      .optional()
      .describe('JATS `id` attribute — the target body-text cross-references point at'),
    sectionTitle: z
      .string()
      .optional()
      .describe(
        'Title of the innermost section enclosing the table, wherever that section sits — body, `<back>` matter, or an appendix all count, and in back matter the section name is the only positional cue there is. Absent only for a table inside no section at all, such as a `<floats-group>` deposit.',
      ),
    headerRowCount: z
      .number()
      .describe(
        'How many leading `rows` entries are header rows — a `<thead>` block, or leading rows made entirely of `<th>`. 0 when the table declares none. Several header rows stack: read one column top to bottom for its full header path.',
      ),
    rows: z
      .array(z.array(z.string()).describe('One row, as cell text by grid column'))
      .describe(
        'Cell text by row, in document order, one entry per grid column. `colspan` and `rowspan` are expanded, so a cell covering several columns or rows repeats its text across each cell it covers and a well-formed table is rectangular — align on position from the left, and read a repeated value as one spanning cell rather than several measurements. Empty when `unextractableReason` is set.',
      ),
    footnotes: z.string().optional().describe('`<table-wrap-foot>` text, flattened to one string'),
    unextractableReason: z
      .enum(['cals-tgroup', 'graphic-only', 'no-rows'])
      .optional()
      .describe(
        'Why `rows` is empty — set only then. graphic-only: the table was deposited as an image with no underlying markup. cals-tgroup: the table uses the CALS `<tgroup>` model, which this server does not extract (0 of 283 tables in an open-access survey used it). no-rows: the markup carried no rows. The label and caption are still returned, so a table that could not be read is visible rather than silently missing.',
      ),
  })
  .describe('One table from the article, with its cells, caption, and owning section');

/**
 * One `<fig>` or `<supplementary-material>`, hung off the article beside
 * {@link TableSchema} and for the same reason: a sixth of them sit in
 * `<floats-group>`, `<back>` or an appendix with no `<sec>` to attach to, so an
 * asset inside a section names it in {@link sectionTitle} rather than being
 * placed by position.
 *
 * Scalar leaves only. `articles[]` → the article union → `assets[]` → a leaf is
 * six of the eight hops the `format-parity` sentinel walker allows; a nested
 * object here (a `files[]` list, say) spends the remaining two and leaves nothing
 * for a later field. Re-run `bun run lint:mcp` after any change to this shape.
 *
 * There is no media-type field and no per-asset unextractable reason: `mimetype`
 * appears on no observed deposit, and an uncaptioned supplement is still fully
 * described by its `id` and `href`, unlike a table that promises cells and
 * carries none. (#130)
 */
const AssetSchema = z
  .object({
    assetType: z
      .enum(['figure', 'supplementary-material'])
      .describe(
        'Which captioned element this came from — `figure` for a `<fig>`, `supplementary-material` for a `<supplementary-material>` deposit',
      ),
    label: z.string().optional().describe('Display label as printed, e.g. `Fig. 1`'),
    caption: z.string().optional().describe('Caption text, with the label excluded'),
    id: z
      .string()
      .optional()
      .describe('JATS `id` attribute — the target body-text cross-references point at'),
    sectionTitle: z
      .string()
      .optional()
      .describe(
        'Title of the innermost section enclosing the asset, wherever that section sits — body, `<back>` matter, or an appendix all count. Absent for an asset inside no section at all, such as a `<floats-group>` deposit.',
      ),
    href: z
      .string()
      .optional()
      .describe(
        'The `<graphic>`/`<media>` `@xlink:href` exactly as deposited — a pointer into the PMC deposit (`MOL2-20-1253-g001.jpg`), not a fetchable URL. No absolute form of it resolves; read the rendered article at `pmcUrl` instead. Absent when the deposit names no file.',
      ),
  })
  .describe('One figure or supplementary-material item, with its caption, pointer, and section');

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
    tables: z
      .array(TableSchema)
      .optional()
      .describe(
        'Every `<table-wrap>` the article carries, in document order — from the body and from `<floats-group>`, `<back>` and appendices alike. Absent when the article deposits none, when `includeTables` is false, or when a `sections` filter left none standing.',
      ),
    assets: z
      .array(AssetSchema)
      .optional()
      .describe(
        'Every `<fig>` and `<supplementary-material>` the article carries, in document order — from the body and from `<floats-group>`, `<back>` and appendices alike. Each one lifted from the body leaves a `[Figure: <label>]` or `[Supplementary: <label>]` marker at its position in the section text, so reading order survives the lift. Absent when the article deposits none, when `includeAssets` is false, or when a `sections` filter left none standing.',
      ),
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
    title: z
      .string()
      .optional()
      .describe(
        "Article title, from the first source that carries one: Unpaywall's record for the DOI, then the Europe PMC record when the chain searched Europe PMC for this id, then — for `html-markdown` content only — the title detected on the page. Absent when none of them has a title.",
      ),
    journalName: z
      .string()
      .optional()
      .describe(
        "Journal or repository name from Unpaywall's record for the DOI (e.g. `medRxiv` for a medRxiv preprint). Absent when Unpaywall has none.",
      ),
    year: z
      .number()
      .optional()
      .describe(
        "Publication year from Unpaywall's record for the DOI. Absent when Unpaywall has none.",
      ),
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

/** A returned article of either shape — the unit the whole-response budget defers. */
type FulltextArticle = z.infer<typeof ArticleSchema>;

const UnavailableReasonSchema = z
  .enum([
    'not-found',
    'no-pmc-fallback-disabled',
    'no-epmc-fulltext',
    'no-body',
    'no-doi',
    'doi-lookup-failed',
    'no-oa',
    'fetch-failed',
    'parse-failed',
    'service-error',
  ])
  .describe(
    'Why no full text was returned — the most specific signal any tier that answered reported. not-found: upstream returned no record for this ID. no-pmc-fallback-disabled: every tier was skipped (`triedTiers` is all `not-attempted`) — typically because EPMC (`EUROPEPMC_ENABLED`) and Unpaywall (`UNPAYWALL_EMAIL`) are not configured. no-epmc-fulltext: EPMC indexed the record but publishes no fullTextXML. no-body: the record was retrieved but carries front matter and abstract only, with no body sections — use `pubmed_fetch_articles` for the metadata. no-doi: the DOI lookup ran and this record has none, so Unpaywall could not be queried. doi-lookup-failed: the DOI lookup itself errored, so whether a DOI exists is unknown and Unpaywall was never reached — retry the request; unlike no-doi this is a transient failure, not a settled answer. no-oa: Unpaywall has no OA copy. fetch-failed: download failed. parse-failed: extraction empty. service-error: upstream server failure (threw, timed out, or returned malformed data). A reason never means the chain ran to completion — read `unqueriedTiers` for that.',
  );

const UnqueriedTierSchema = z
  .enum(['europepmc', 'unpaywall'])
  .describe('A fallback tier this deployment has not configured');

const TierOutcomeSchema = z
  .enum([
    'not-attempted',
    'miss',
    'no-fulltext',
    'no-body',
    'no-doi',
    'doi-lookup-failed',
    'no-oa',
    'fetch-failed',
    'parse-failed',
    'service-error',
  ])
  .describe(
    'Per-tier outcome. not-attempted: tier was skipped. miss: tier returned no record. no-fulltext: EPMC indexed the record but publishes no fullTextXML. no-body: the tier returned a record with front matter and abstract but no body sections, so the chain continued. no-doi: the DOI lookup ran and this record has none, so Unpaywall could not be queried. doi-lookup-failed: the DOI lookup itself errored, so whether a DOI exists is unknown and Unpaywall was never reached — retry the request. no-oa: Unpaywall reports no open-access copy. fetch-failed: OA copy download failed. parse-failed: extraction produced empty content. service-error: tier service threw.',
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
    unqueriedTiers: z
      .array(UnqueriedTierSchema)
      .optional()
      .describe(
        'Tiers the chain skipped because this deployment has not configured them, and that could have served this id — the search was incomplete, and a deployment with these tiers configured may still resolve the id. `triedTiers` carries which environment variable each one is waiting on. Absent when every tier that could have served the id was actually queried; a tier skipped because it was inapplicable to this id (no DOI for Unpaywall) is never listed.',
      ),
  })
  .describe('One identifier that could not be returned, with the full chain it traversed');

// ─── Character-budget schemas ────────────────────────────────────────────────

/**
 * Character accounting for one subsection. Its own type rather than a
 * self-reference for the reason {@link SubsectionSchema} is inlined: a
 * `z.lazy()` schema emits `$defs`/`$ref`. The article schema carries sections
 * two levels deep, so the ledger does too.
 *
 * The chain `truncation` → `articles[]` → `sections[]` → `subsections[]` → a
 * leaf is eight schema hops, the most the `format-parity` sentinel walker
 * reaches. Re-run `bun run lint:mcp` after any change to this shape. (#143)
 */
const TruncatedSubsectionSchema = z
  .object({
    title: z.string().optional().describe('Subsection heading, when the subsection carries one'),
    label: z
      .string()
      .optional()
      .describe('Subsection label as printed (e.g. `2.1`), when the subsection carries one'),
    originalCharacters: z
      .number()
      .describe('Body characters this subsection carried before the budget pass'),
    returnedCharacters: z
      .number()
      .describe(
        'Body characters this subsection carries in the response. Zero means it was dropped in `truncate` mode and counted in `omittedSections`, or kept as a heading-only entry in `outline` mode, marked as such in the rendered text.',
      ),
    truncated: z
      .boolean()
      .describe('True when the subsection returned fewer characters than it originally carried'),
  })
  .describe('Character accounting for one subsection of a shortened section');

const TruncatedSectionSchema = z
  .object({
    title: z.string().optional().describe('Section heading, when the section carries one'),
    label: z
      .string()
      .optional()
      .describe('Section label as printed (e.g. `2`), when the section carries one'),
    originalCharacters: z
      .number()
      .describe('Body characters this section carried before the budget pass'),
    returnedCharacters: z
      .number()
      .describe(
        'Body characters this section carries in the response. Zero means the section was dropped in `truncate` mode, or kept as a heading-only entry in `outline` mode, marked as such in the rendered text.',
      ),
    truncated: z
      .boolean()
      .describe('True when the section returned fewer characters than it originally carried'),
    subsections: z
      .array(TruncatedSubsectionSchema)
      .optional()
      .describe(
        'Per-subsection accounting for a shortened section, in document order, including subsections dropped for budget — where inside the section the cut landed. Absent when the section was returned whole or carries no subsections.',
      ),
  })
  .describe('Character accounting for one body section of a budgeted article');

/** One ledger entry at either level — the shape the budget pass builds and `format()` walks. */
type SectionLedgerEntry = z.infer<typeof TruncatedSubsectionSchema> & {
  subsections?: SectionLedgerEntry[] | undefined;
};

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
        'Per-section accounting for `source: pmc` articles, in document order, including sections dropped for budget; a shortened section lists its subsections. Absent for `source: unpaywall`, whose body has no section structure.',
      ),
    omittedTables: z
      .number()
      .optional()
      .describe(
        'Tables this article dropped whole because the budget left no room for them. A table is never cut mid-row, so it is either returned complete or counted here. Absent when none were dropped.',
      ),
    omittedTableNames: z
      .array(z.string())
      .optional()
      .describe(
        "The dropped tables by name, in document order — each table's label, else its `id`, else `table <n>` for its position in the article. Names the tables a bare count only hints at, the way `deferred.ids` names deferred articles. Every table from the first that did not fit onward is here: admission stops at that table rather than skipping ahead to a smaller one, so these are contiguous. Absent when none were dropped.",
      ),
    omittedAssets: z
      .number()
      .optional()
      .describe(
        'Figures and supplementary items this article dropped whole because the budget left no room once sections and tables were served. An asset is never returned with a truncated caption, so it is either returned complete or counted here. Absent when none were dropped.',
      ),
    omittedAssetNames: z
      .array(z.string())
      .optional()
      .describe(
        "The dropped assets by name, in document order — each asset's label, else its `id`, else `asset <n>` for its position in the article. Contiguous for the same reason `omittedTableNames` is: admission stops at the first asset that did not fit rather than skipping ahead to a smaller one. Absent when none were dropped.",
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
        'Body sections and subsections dropped entirely because an article budget was exhausted before reaching them. A dropped section counts once, together with its subsections. Always 0 in `outline` mode, which keeps every heading.',
      ),
    omittedTables: z
      .number()
      .optional()
      .describe(
        'Tables dropped whole across every budgeted article, because the budget left no room once body sections were served. Absent when none were dropped. Re-request the affected articles with a higher `maxCharacters`, or with `sections` narrowed, to receive them.',
      ),
    omittedAssets: z
      .number()
      .optional()
      .describe(
        'Figures and supplementary items dropped whole across every budgeted article, because the budget left no room once body sections and tables were served. Absent when none were dropped. Re-request the affected articles with a higher `maxCharacters`, or with `sections` narrowed, to receive them.',
      ),
    articles: z
      .array(TruncatedArticleSchema)
      .describe('Per-article accounting, covering only the articles the budget shortened'),
  })
  .describe(
    'Character accounting for full text the budget shortened. Present only when a budget actually removed characters — its absence means every returned article carries its full post-filter body.',
  );

const DeferredSchema = z
  .object({
    maxResponseCharacters: z
      .number()
      .describe('The `maxResponseCharacters` ceiling this response was budgeted against'),
    returnedCharacters: z
      .number()
      .describe('Serialized characters the returned article records account for'),
    deferredCount: z
      .number()
      .describe('Articles the chain resolved but withheld to stay under the ceiling'),
    idType: z
      .enum(['pmid', 'pmcid', 'doi'])
      .describe(
        'Which input branch the deferred ids belong to — re-submit them as `pmids`, `pmcids`, or `dois` respectively. Matches the `idType` on `unavailable` entries.',
      ),
    ids: z
      .array(z.string())
      .describe(
        'Identifiers of the deferred articles, in response order, keyed as they were requested (PMC IDs in `PMC<digits>` form). Re-call `pubmed_fetch_fulltext` with these under the `idType` branch and the same other inputs. Never contains an id from `unavailable`.',
      ),
    nextDeferredCharacters: z
      .number()
      .describe(
        'Serialized size of the next deferred article — the first entry in `ids`, where the response stopped. Raise `maxResponseCharacters` to at least this to make progress; a smaller article further down `ids` cannot be reached until this one fits.',
      ),
  })
  .describe(
    'Continuation state for articles the whole-response budget withheld. Present only when `maxResponseCharacters` deferred at least one article.',
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

/** Every text field in a section subtree, in document order, own text first. */
function sectionTextFields(section: ParsedSection): string[] {
  return [section.text, ...(section.subsections ?? []).flatMap(sectionTextFields)];
}

/** Combined length of the strings given, skipping the absent ones. */
function totalLength(parts: readonly (string | undefined)[]): number {
  return parts.reduce((n, part) => n + (part?.length ?? 0), 0);
}

/**
 * Body characters a section carries — its own text plus every nested
 * subsection's. Measured off {@link sectionTextFields} rather than its own walk,
 * so the count the budget reports as `originalCharacters` is always taken over
 * exactly the fields {@link fitFields} shortens.
 */
function sectionCharacters(section: ParsedSection): number {
  return totalLength(sectionTextFields(section));
}

/**
 * Characters a table costs the budget: everything it renders — label, caption,
 * every cell, footnotes. The whole figure is what admitting the table spends,
 * and a table is admitted or dropped whole, so there is no partial measure to
 * take. (#111)
 */
function tableCharacters(table: ParsedPmcTable): number {
  return totalLength([table.label, table.caption, table.footnotes, ...table.rows.flat()]);
}

/**
 * Characters an asset costs the budget: the text it carries — label, caption,
 * and the `href` pointer. Positional metadata is excluded, exactly as {@link
 * tableCharacters} excludes `sectionTitle` and `id`: it places the asset rather
 * than being content the caller asked for. An asset is admitted or dropped
 * whole — a caption cut in half is a caption that says something else — so there
 * is no partial measure to take. (#130)
 */
function assetCharacters(asset: ParsedPmcAsset): number {
  return totalLength([asset.label, asset.caption, asset.href]);
}

/**
 * Admit tables, then assets, in document order until the allowance is spent,
 * then drop the rest whole and name them. The split is {@link fitWholeItems}'s
 * prefix cut, the same one `maxResponseCharacters` applies to whole articles.
 *
 * Admission stops at the first entry that does not fit rather than skipping past
 * it to a smaller one further down: the returned set stays a document-order
 * prefix, so a caller reading it knows where the response stopped instead of
 * receiving a late entry with nothing saying the earlier ones exist. An entry
 * that does not fit is never cut either — half a grid reads as a complete table
 * carrying values that were never deposited, the defect the table extraction
 * exists to fix, and half a caption says something the deposit does not.
 * (#111, #130)
 */
function fitWholeNamed<T>(
  items: readonly T[],
  allowance: number,
  measure: (item: T) => number,
  name: (item: T, index: number) => string,
): { kept: T[]; omittedNames: string[]; spent: number } {
  const fit = fitWholeItems(items, allowance, measure);
  return {
    kept: fit.kept,
    omittedNames: fit.deferred.map((item, i) => name(item, fit.kept.length + i)),
    spent: fit.keptCharacters,
  };
}

/**
 * True when the budget emptied a node that had text — which `truncate` mode
 * drops, at any depth, and `outline` mode keeps as a heading-only entry. A node
 * that never carried text is kept either way: there was nothing to cut.
 */
function isBudgetEmptied(entry: SectionLedgerEntry): boolean {
  return entry.returnedCharacters === 0 && entry.originalCharacters > 0;
}

/**
 * Sections and subsections `truncate` mode dropped, read off the ledger. A
 * dropped node counts once and takes its subtree with it, so its subsections
 * are not counted again. Shared by the budget pass and the deferral roll-back
 * so both count by one rule. (#81, #143)
 */
function countDroppedSections(
  entries: readonly SectionLedgerEntry[],
  mode: 'truncate' | 'outline',
): number {
  if (mode !== 'truncate') return 0;
  return entries.reduce(
    (n, entry) =>
      n + (isBudgetEmptied(entry) ? 1 : countDroppedSections(entry.subsections ?? [], mode)),
    0,
  );
}

/**
 * Rebuild a section subtree from `fitted` — one entry per node, in the document
 * order {@link sectionTextFields} produced them, `cursor` walking the flat list
 * across the whole subtree — together with its ledger entry.
 *
 * In `truncate` mode a node the budget emptied is dropped (`kept` is absent) at
 * every depth, where only a top-level section used to be: a subsection left as
 * a heading over nothing is a stub, not content. `outline` mode keeps it, and
 * `format()` marks it. The entry lists its subsections only when this node was
 * shortened, which is where they say something a whole section's entry does
 * not. (#81, #143)
 */
function fitSectionTree(
  section: ParsedSection,
  fitted: string[],
  cursor: { i: number },
  mode: 'truncate' | 'outline',
): { entry: SectionLedgerEntry; kept?: ParsedSection } {
  const text = fitted[cursor.i++] ?? '';
  const children = (section.subsections ?? []).map((sub) =>
    fitSectionTree(sub, fitted, cursor, mode),
  );
  const originalCharacters = sectionCharacters(section);
  const returnedCharacters = children.reduce(
    (n, child) => n + child.entry.returnedCharacters,
    text.length,
  );
  const truncated = returnedCharacters < originalCharacters;
  const entry: SectionLedgerEntry = {
    ...(section.title !== undefined && { title: section.title }),
    ...(section.label !== undefined && { label: section.label }),
    originalCharacters,
    returnedCharacters,
    truncated,
    ...(truncated && children.length > 0 && { subsections: children.map((c) => c.entry) }),
  };
  if (mode === 'truncate' && isBudgetEmptied(entry)) return { entry };

  const { subsections: _replaced, ...rest } = section;
  const subsections = children.flatMap((child) => (child.kept ? [child.kept] : []));
  return {
    entry,
    kept: { ...rest, text, ...(subsections.length > 0 && { subsections }) },
  };
}

/**
 * Shorten an ordered list of text fields so their combined length fits
 * `allowance`. Fields are filled in order, so earlier fields survive whole — the
 * section's own text before its subsections — and the first field that does not
 * fit is cut at the last word boundary inside what is left. Every field after
 * that cut is past it and returns empty, the way a top-level section past the
 * budget does, even when the cut left a few characters unspent: handing those
 * on would open the next subsection with a fragment of its first word. (#143)
 *
 * No marker is appended, so the reported `returnedCharacters` is exact;
 * `format()` carries the human-visible note. Counts are measured off the
 * returned text, never off the allowance, which stays a ceiling. (#93)
 */
function fitFields(fields: string[], allowance: number): string[] {
  let remaining = Math.max(allowance, 0);
  return fields.map((text) => {
    if (text.length <= remaining) {
      remaining -= text.length;
      return text;
    }
    const kept = sliceAtWordBoundary(text, remaining);
    remaining = 0;
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
 * `includeReferences` / `includeTables` and the empty-body signals they feed are
 * unaffected. Titles, abstracts, identifiers, and references are never counted
 * or cut — the budget spends on body text and table content, keeping every
 * article citable.
 *
 * Body sections are served first, then tables, then assets, each spending what
 * `maxCharacters` has left, in document order: an item that does not fit is
 * dropped whole and counted, never truncated into a partial grid or a caption cut
 * short. With no `maxCharacters` — a bare `maxCharactersPerSection` request —
 * nothing bounds either list and every entry is kept. (#111, #130)
 *
 * Returns the article untouched (same object identity) when no budget was
 * requested or nothing exceeded it. A section or subsection left with zero
 * characters is dropped in `truncate` mode and counted as omitted; `outline`
 * keeps it as a heading-only entry. Dropped nodes still appear in the accounting
 * so the caller can see which headings exist. (#81, #143)
 */
function applyPmcBudget<
  T extends { sections: ParsedPmcArticle['sections'] } & WithTables & WithAssets,
>(
  article: T,
  budget: BudgetOptions,
): { article: T; omittedSections: number; truncation?: UnkeyedTruncation } {
  const tables = article.tables ?? [];
  const assets = article.assets ?? [];
  if (
    !budgetRequested(budget) ||
    (article.sections.length === 0 && tables.length === 0 && assets.length === 0)
  ) {
    return { article, omittedSections: 0 };
  }

  const sizes = article.sections.map(sectionCharacters);
  const tablesOriginal = tables.reduce((sum, table) => sum + tableCharacters(table), 0);
  const assetsOriginal = assets.reduce((sum, asset) => sum + assetCharacters(asset), 0);
  const originalCharacters =
    sizes.reduce((sum, size) => sum + size, 0) + tablesOriginal + assetsOriginal;
  const allowances = allotSectionBudgets(sizes, budget);

  const kept: ParsedPmcArticle['sections'] = [];
  const sectionReports: SectionLedgerEntry[] = [];
  let returnedCharacters = 0;

  article.sections.forEach((section, i) => {
    const fitted = fitFields(sectionTextFields(section), allowances[i] ?? 0);
    const fit = fitSectionTree(section, fitted, { i: 0 }, budget.overflowMode);
    returnedCharacters += fit.entry.returnedCharacters;
    sectionReports.push(fit.entry);
    if (fit.kept) kept.push(fit.kept);
  });
  const omittedSections = countDroppedSections(sectionReports, budget.overflowMode);

  // Sections are served first, then tables, then assets — each spending whatever
  // `maxCharacters` has left. A bare per-section budget sets no total, so nothing
  // bounds either list.
  const remainingAllowance = () =>
    budget.maxCharacters === undefined
      ? Number.POSITIVE_INFINITY
      : Math.max(budget.maxCharacters - returnedCharacters, 0);

  const fittedTables = fitWholeNamed(
    tables,
    remainingAllowance(),
    tableCharacters,
    tableDisplayName,
  );
  returnedCharacters += fittedTables.spent;
  const omittedTables = fittedTables.omittedNames.length;

  const fittedAssets = fitWholeNamed(
    assets,
    remainingAllowance(),
    assetCharacters,
    assetDisplayName,
  );
  returnedCharacters += fittedAssets.spent;
  const omittedAssets = fittedAssets.omittedNames.length;

  if (
    returnedCharacters === originalCharacters &&
    omittedSections === 0 &&
    omittedTables === 0 &&
    omittedAssets === 0
  ) {
    return { article, omittedSections: 0 };
  }

  return {
    article: withAssets(
      withTables({ ...article, sections: kept }, fittedTables.kept),
      fittedAssets.kept,
    ),
    omittedSections,
    truncation: {
      originalCharacters,
      returnedCharacters,
      sections: sectionReports,
      ...(omittedTables > 0 && {
        omittedTables,
        omittedTableNames: fittedTables.omittedNames,
      }),
      ...(omittedAssets > 0 && {
        omittedAssets,
        omittedAssetNames: fittedAssets.omittedNames,
      }),
    },
  };
}

/**
 * Apply the character budget to an Unpaywall body. That body is one
 * unstructured blob — HTML-as-Markdown or PDF-as-text — so only `maxCharacters`
 * applies, and `outline` mode has no headings to preserve and behaves like
 * `truncate`. The cut ends at a word boundary, as a section cut does. (#81, #143)
 */
function applyContentBudget(
  content: string,
  budget: BudgetOptions,
): { content: string; truncation?: UnkeyedTruncation } {
  const cap = budget.maxCharacters;
  if (cap === undefined || content.length <= cap) return { content };
  const kept = sliceAtWordBoundary(content, cap);
  return {
    content: kept,
    truncation: { originalCharacters: content.length, returnedCharacters: kept.length },
  };
}

type UnextractableTableReason = NonNullable<z.infer<typeof TableSchema>['unextractableReason']>;

/** Why a table arrived with no rows, in the reader's terms. */
const UNEXTRACTABLE_TABLE_EXPLANATIONS: Record<UnextractableTableReason, string> = {
  'cals-tgroup': 'it uses the CALS `<tgroup>` model, which this server does not extract',
  'graphic-only': 'it was deposited as an image, with no underlying markup to read',
  'no-rows': 'its markup carried no rows',
};

/** One returned table that carries no cell values, and the article it came from. */
interface UnextractableTableEntry {
  articleId: string;
  name: string;
  reason: UnextractableTableReason;
}

/** How a table is named in a notice: its label, else its id, else its position. */
function tableDisplayName(
  table: { id?: string | undefined; label?: string | undefined },
  index: number,
): string {
  return table.label ?? table.id ?? `table ${index + 1}`;
}

/** How an asset is named in a notice: its label, else its id, else its position. */
function assetDisplayName(
  asset: { id?: string | undefined; label?: string | undefined },
  index: number,
): string {
  return asset.label ?? asset.id ?? `asset ${index + 1}`;
}

/**
 * Collect the returned tables that carry no cell values. Read off the articles
 * the response actually ships — after every filter and both budgets — so a table
 * the `sections` filter removed, or one belonging to a deferred article, is
 * never named as though the caller received it. (#111)
 */
function collectUnextractableTables(articles: FulltextArticle[]): UnextractableTableEntry[] {
  const entries: UnextractableTableEntry[] = [];
  for (const article of articles) {
    if (article.source !== 'pmc') continue;
    for (const [index, table] of (article.tables ?? []).entries()) {
      const reason = table.unextractableReason;
      if (!reason) continue;
      entries.push({
        articleId: articleDisplayId(article),
        name: tableDisplayName(table, index),
        reason,
      });
    }
  }
  return entries;
}

/**
 * Compose the recovery notice for tables returned with a label and caption but
 * no cells. Without it a table-bearing response carries no response-level signal
 * that some of the numbers the caller asked for are absent — the per-table
 * `unextractableReason` only helps a reader who already went looking at that
 * table. One notice covers the whole response, aggregated across articles, the
 * way the `sections`-filter miss notice does. (#111)
 *
 * The wording turns on recoverability: nothing the caller changes produces these
 * cells, because the markup does not exist upstream. Tables the character budget
 * dropped are the opposite case — recoverable by raising `maxCharacters` — so
 * they stay with the rest of the budget accounting in {@link
 * buildTruncationNotice} rather than being mixed in here.
 */
function buildUnextractableTablesNotice(entries: UnextractableTableEntry[]): string {
  const subject = entries.length === 1 ? '1 table was' : `${entries.length} tables were`;
  const named = entries.map((e) => `${e.name} (${e.articleId}, ${e.reason})`).join(', ');
  const reasons = [...new Set(entries.map((e) => e.reason))]
    .map((reason) => `${reason} — ${UNEXTRACTABLE_TABLE_EXPLANATIONS[reason]}`)
    .join('; ');
  return `${subject} returned with a label and caption but no cell values: ${named}. Re-calling will not recover the cells (${reasons}); see \`unextractableReason\` on each table.`;
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
  // Tables are admitted after sections and only whole, so a dropped one is
  // absent rather than partial — say so, and name them: a bare count leaves the
  // reader unable to tell which numbers are missing from what they received.
  const droppedNames = truncation.articles.flatMap((a) => a.omittedTableNames ?? []);
  const omittedTables = truncation.omittedTables
    ? ` ${truncation.omittedTables} table(s) were dropped whole rather than cut mid-row: ${droppedNames.join(', ')}.`
    : '';
  // Assets are admitted last and only whole — a caption cut in half says
  // something the deposit does not — so name them on the same terms.
  const droppedAssetNames = truncation.articles.flatMap((a) => a.omittedAssetNames ?? []);
  const omittedAssets = truncation.omittedAssets
    ? ` ${truncation.omittedAssets} figure/supplementary item(s) were dropped whole rather than returned with a shortened caption: ${droppedAssetNames.join(', ')}.`
    : '';
  // Name only the budgets the request actually set — pointing at `maxCharacters`
  // when the caller only capped per-section sends them to a knob that is unset.
  const knobs = [
    truncation.maxCharacters !== undefined ? '`maxCharacters`' : undefined,
    truncation.maxCharactersPerSection !== undefined ? '`maxCharactersPerSection`' : undefined,
  ].filter((k): k is string => k !== undefined);
  return `Full text was shortened to fit the requested character budget: ${truncation.returnedCharacters} of ${truncation.originalCharacters} body characters returned across ${subject} in ${truncation.mode} mode.${omitted}${omittedTables}${omittedAssets} See \`truncation\` for per-article and per-section counts, and raise ${knobs.join(' or ')} or narrow \`sections\` to retrieve more.`;
}

/**
 * Compose the recovery notice for articles the whole-response budget withheld.
 * Names what was spent, which identifiers are still retrievable, and the ceiling
 * the next call has to clear — so a caller reading only `content[]` can resume
 * without inspecting `deferred`. (#100)
 */
function buildDeferralNotice(deferred: z.infer<typeof DeferredSchema>): string {
  const spent =
    deferred.returnedCharacters === 0
      ? `No article fits the requested maxResponseCharacters of ${deferred.maxResponseCharacters}, so none were returned.`
      : `Response character budget reached: ${deferred.returnedCharacters} of ${deferred.maxResponseCharacters} characters returned.`;
  return `${spent} ${deferred.deferredCount} resolved article(s) were deferred whole: ${deferred.ids.join(', ')}. Re-call pubmed_fetch_fulltext with those ids under \`${deferred.idType}s\` to retrieve them, or raise maxResponseCharacters to at least ${deferred.nextDeferredCharacters} — the size of the next deferred article.`;
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
    'Fetch full-text articles from PubMed Central with structured sections, tables, and references.';
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
  const budget =
    'Two independent character controls: `maxCharacters` caps body text per article, `maxResponseCharacters` caps the whole response and defers articles past the ceiling whole, listing them in `deferred.ids` for a follow-up call.';

  return `${base} ${fallback} ${input} ${budget}`;
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

  // Only the ID routing's `idConvert` calls run unwrapped. Every Europe PMC and
  // Unpaywall call sits behind a catch that folds the failure into
  // `unavailable[].triedTiers`, so their service reasons never reach a caller
  // and are not declared here. (#168)
  errors: [...NCBI_SERVICE_ERRORS] as const,

  input: z
    .object({
      pmcids: z
        .array(pmcidStringSchema)
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
        .array(doiStringSchema)
        .min(1)
        .max(10)
        .optional()
        .describe(
          'DOIs to resolve (e.g. ["10.21203/rs.3.rs-9010375/v1"]), one per element. Provide exactly one of `pmcids`, `pmids`, or `dois`. Resolved to a PMCID via the PMC ID Converter and returned as structured JATS when the article is in PMC; DOIs with no PMC counterpart (preprints, EPMC-only OA) fall through to Europe PMC, then Unpaywall, when those layers are enabled.',
        ),
      includeReferences: z
        .boolean()
        .default(false)
        .describe('Include reference list. Applies to `source=pmc` results only.'),
      includeTables: z
        .boolean()
        .default(true)
        .describe(
          "Include the article's tables — cells, captions, labels and footnotes. On by default because a dropped table takes its numbers with it. Table-dense articles pay for it: rendered tables typically add 12–17% to an article record and can more than double it. Set false to omit them, or cap the cost with `maxCharacters`, which drops tables it cannot fit whole. Applies to `source=pmc` results only.",
        ),
      includeAssets: z
        .boolean()
        .default(true)
        .describe(
          "Include the article's figures and supplementary material — `assets[]`, each with its label, caption, enclosing section and deposit pointer. On by default because it is cheaper than tables: a median asset-bearing article grows about 10%, and the body prose already refers to these by label. Set false to omit them, which also removes the `[Figure: …]` / `[Supplementary: …]` markers from the section text, since without the array they point at nothing. Prose-shaped blocks — lists, definition lists, block quotes, boxed text, preformatted blocks, displayed formulae — are section text rather than assets and this switch never affects them. Applies to `source=pmc` results only.",
        ),
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
          'Filter to specific sections by title (e.g. ["Introduction", "Methods", "Results", "Discussion"]). A term matches a section or subsection title at any nesting depth, case-insensitively, as a substring — "resul" matches "Results". A section whose own title matches is returned whole; one kept only because a nested subsection matched keeps its heading as a breadcrumb, with its own text cleared and only the matching branch beneath it. Tables and assets narrow with the filter: one whose section did not survive, or that names no section, is dropped. Applies to `source=pmc` results only.',
        ),
      maxCharacters: z
        .number()
        .int()
        .min(1)
        .max(1_000_000)
        .optional()
        .describe(
          'Per-article budget for body text, in characters. Counts `source=pmc` section and subsection text — which carries the inline blocks the parser renders in place, such as lists, definition lists, block quotes, boxed text, preformatted blocks and displayed formulae — plus table label, caption, cell and footnote text and asset label, caption and `href` text; or the `source=unpaywall` `content` body. Titles, abstracts, identifiers, and references are never counted or shortened. Shortened text ends at the last word boundary inside its allowance, so it can come back a few characters under it. The counted unit is that text alone — the Markdown grid `content[]` renders around the cells (pipes, padding, the divider row, headings) is scaffolding this budget does not measure, so a table renders longer than it costs here. Sections are served first, then tables, then assets, each spending what is left, in document order — admission stops at the first entry that does not fit, and every entry from there on is dropped whole rather than cut mid-row or returned with a shortened caption, counted in `truncation.omittedTables` / `truncation.omittedAssets` and named in `truncation.articles[].omittedTableNames` / `omittedAssetNames`. Applied after `sections`, `maxSections`, `includeReferences`, `includeTables`, and `includeAssets`, so semantic filtering is unaffected. This knob alone bounds only bodies: the response-wide ceiling it implies is this value times the number of articles returned, plus every uncounted field. Use `maxResponseCharacters` for a true whole-response ceiling. Omit for the full body.',
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
      maxResponseCharacters: z
        .number()
        .int()
        .min(1)
        .max(1_000_000)
        .optional()
        .describe(
          'Opt-in ceiling for the whole response, in characters — the true response-wide counterpart to the per-article `maxCharacters`. Each article is measured as the JSON record it is returned as, after every filter and the per-article body budget: title, abstract, body sections, references, identifiers, license and source metadata — every field it carries. One ledger covers all tiers, so PMC-, Europe PMC-, and Unpaywall-served articles spend the same budget. Articles are kept in response order until the next one would cross the ceiling; that article and the rest are deferred whole (never partially populated) and listed in `deferred.ids`. Response envelope fields — counts, `unavailable`, `truncation`, `deferred` itself — are not counted. Omit to return every resolved article.',
        ),
      overflowMode: z
        .enum(['truncate', 'outline'])
        .default('truncate')
        .describe(
          'How to spend `maxCharacters` across an article that exceeds it. truncate: fill sections in document order, so early sections stay whole, the section the budget runs out in is cut, and every section or subsection past that point is dropped (counted in `truncation.omittedSections`). outline: split the budget evenly so every section and subsection keeps its heading, and an excerpt as far as the budget reaches — a heading the budget left empty is marked as such in the rendered text. Use it to survey what an article contains before requesting specific `sections`. Ignored when no budget is set, and identical for `source=unpaywall` bodies, which have no headings to preserve.',
        ),
    })
    .refine((v) => [v.pmcids, v.pmids, v.dois].filter((b) => b !== undefined).length === 1, {
      message: 'Provide exactly one of `pmcids`, `pmids`, or `dois` (not zero, not more).',
    }),

  output: z.object({
    articles: z.array(ArticleSchema).describe('Full-text articles'),
    totalReturned: z
      .number()
      .describe(
        'Number of articles in this response. Under a `maxResponseCharacters` budget this counts the kept articles only; `deferred.deferredCount` covers the rest.',
      ),
    unavailable: z
      .array(UnavailableSchema)
      .optional()
      .describe(
        'Per-identifier explanations for any requested PMIDs, PMCIDs, or DOIs with no returnable full text. `idType` discriminates which branch the id came from. Distinct from `deferred`: nothing here is retrievable by re-calling, and an id never appears in both.',
      ),
    truncation: TruncationSchema.optional(),
    deferred: DeferredSchema.optional(),
  }),

  // Recovery guidance for five cases — a `sections` filter that removed every
  // body section (#80), a record the chain could only retrieve as front matter
  // (#86), a table returned with no cell values (#111), a body the per-article
  // character budget shortened (#81), and articles the whole-response budget
  // withheld (#100). Agent-facing context surfaced via
  // ctx.enrich.notice() to structuredContent and content[]; absent when none
  // applies.
  enrichment: {
    notice: z
      .string()
      .optional()
      .describe(
        'Optional guidance for a partial or empty body. A `sections`-filter miss names the requested terms and affected article id(s) and suggests retrying without `sections` or using broader headings. A metadata-only record names the id(s) the chain could retrieve as front matter only and points at `pubmed_fetch_articles` for the abstract. A table returned with no cell values names the affected table(s), the article each came from, and why the cells cannot be recovered. A budgeted response names the characters returned versus carried and points at `truncation`. A response-wide budget that deferred articles names the ids to re-request. Absent when none of those applies.',
      ),
    truncated: z
      .boolean()
      .optional()
      .describe(
        'True when a character budget shortened at least one returned body, or withheld a whole article. Absent when every resolved article is present with its full post-filter body. The per-article body accounting is in `truncation`; the withheld ids are in `deferred`.',
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
    // Per-input-id set of tiers this deployment has not configured AND that
    // could have served that id — the `unqueriedTiers` array on unavailable
    // entries. Insertion order is chain order, so the array reads in the order
    // the tiers would have run. A tier skipped as inapplicable is never marked;
    // that is a settled answer, not an incomplete search. (#110)
    const unqueriedByInput = new Map<string, Set<z.infer<typeof UnqueriedTierSchema>>>();
    const markUnqueried = (inputId: string, tier: z.infer<typeof UnqueriedTierSchema>) => {
      const tiers = unqueriedByInput.get(inputId) ?? new Set<z.infer<typeof UnqueriedTierSchema>>();
      tiers.add(tier);
      unqueriedByInput.set(inputId, tiers);
    };
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
    // The input id each returned article was requested under, so the
    // whole-response budget can hand deferred articles back as identifiers the
    // caller can re-submit rather than whatever id the article happens to
    // carry — a `pmids` request recovers articles keyed by PMCID. (#100)
    const inputIdByArticle = new Map<FulltextArticle, string>();
    // The caller's own spellings of each chain key, so `unavailable[]` and
    // `deferred.ids` report what was submitted. The `pmids` branch fills it — a
    // PMID's chain runs on its canonical form — and so does the `dois` branch,
    // whose chain runs once per DOI however many casings name it. Both also
    // fold in an input id that resolves to a PMC record another one already
    // claimed (see `routeToPmc`). Any other key is its own spelling. (#161, #166)
    const callerIds = new Map<string, string[]>();
    const addCallerId = (key: string, spelling: string) => {
      const spellings = callerIds.get(key) ?? [];
      if (!spellings.includes(spelling)) spellings.push(spelling);
      callerIds.set(key, spellings);
    };

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

    // Send a converter-resolved PMCID to PMC EFetch under the input id that
    // named it. A second input id the converter places on the same PMC record
    // — two DOIs for one article — joins the first one's chain as another
    // spelling of it: the record is fetched once, and both ids are recovered,
    // or reported unavailable with that chain, rather than the later id taking
    // the PMCID over and leaving the earlier one with an empty chain.
    const routeToPmc = (inputId: string, pmcid: string) => {
      const normalized = normalizePmcId(pmcid);
      const prefixed = withPmcPrefix(normalized);
      const owner = pmcidToInputId.get(prefixed);
      if (owner === undefined) {
        pmcIds.push(normalized);
        pmcidToInputId.set(prefixed, inputId);
        return;
      }
      if (owner === inputId) return;
      for (const spelling of callerIds.get(inputId) ?? [inputId]) addCallerId(owner, spelling);
      callerIds.delete(inputId);
      chainByInput.delete(inputId);
    };

    if (input.pmids) {
      // The ID Converter parses `00000001` as PMID 1 yet reports it "not found
      // in PMC", and every later stage answers with NCBI's own PMID, so the chain
      // runs once per distinct PMID in its canonical form. (#161)
      for (const id of input.pmids) addCallerId(normalizePmid(id), id);
      const pmids = [...callerIds.keys()];
      for (const id of pmids) chainByInput.set(id, []);
      const records = await getNcbiService().idConvert(
        pmids,
        'pmid',
        ctx.signal ? { signal: ctx.signal } : undefined,
      );
      const seen = new Set<string>();
      for (const r of records) {
        if (r.pmid === undefined) continue;
        const pmid = String(r.pmid);
        seen.add(pmid);
        if (r.pmcid) {
          routeToPmc(pmid, String(r.pmcid));
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
      for (const requested of pmids) {
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
      // `PMC123`, `pmc123`, `123` and `PMC0123` name one record; it runs the
      // chain once. (#170)
      pmcIds = [...new Set(input.pmcids.map(normalizePmcId))];
      for (const id of pmcIds) chainByInput.set(withPmcPrefix(id), []);
    } else if (input.dois) {
      // Mirror the `pmids` branch: resolve DOI → PMCID via the PMC ID Converter
      // so PMC-indexed DOIs reach PMC EFetch instead of going straight to the
      // EPMC/Unpaywall fallback (which misses articles whose only OA copy is the
      // PMC JATS). DOIs the converter can't place in PMC seed `doiCandidates`.
      //
      // DOIs are case-insensitive, and the converter echoes one casing in
      // `requested-id` for DOIs that differ only in case, so every casing of a
      // DOI shares one chain, keyed by the first spelling submitted, and
      // converter records are matched to it case-insensitively. (#166)
      const chainKeyByDoi = new Map<string, string>();
      for (const doi of input.dois) {
        const key = chainKeyByDoi.get(doi.toLowerCase()) ?? doi;
        chainKeyByDoi.set(doi.toLowerCase(), key);
        addCallerId(key, doi);
      }
      const dois = [...callerIds.keys()];
      for (const doi of dois) chainByInput.set(doi, []);
      const records = await getNcbiService().idConvert(
        dois,
        'doi',
        ctx.signal ? { signal: ctx.signal } : undefined,
      );
      const seen = new Set<string>();
      for (const r of records) {
        // Match on the echoed `requested-id`, not `r.doi`: the record's own DOI
        // can be cased differently from anything the caller sent.
        const doi = chainKeyByDoi.get(String(r['requested-id']).toLowerCase());
        if (doi === undefined) continue;
        seen.add(doi);
        if (r.pmcid) {
          routeToPmc(doi, String(r.pmcid));
        } else {
          chainByInput.get(doi)?.push({
            tier: 'pmc',
            outcome: 'not-attempted',
            detail: 'DOI has no PMC counterpart',
          });
          doiCandidates.push({ doi });
        }
      }
      for (const requested of dois) {
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
          const article = {
            source: 'pmc' as const,
            viaSource: 'pmc' as const,
            ...budgeted.article,
          };
          parsed.push(article);
          if (article.pmcId) {
            inputIdByArticle.set(article, pmcidToInputId.get(article.pmcId) ?? article.pmcId);
          }
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
          articleInputIds: new Map<z.infer<typeof PmcArticleSchema>, string>(),
        };

    pmcArticles = pmcArticles.concat(epmcOutcomes.articles);
    truncatedArticles.push(...epmcOutcomes.truncatedArticles);
    omittedSections += epmcOutcomes.omittedSections;
    for (const [article, candidateId] of epmcOutcomes.articleInputIds) {
      inputIdByArticle.set(article, pmcidToInputId.get(candidateId) ?? candidateId);
    }

    // Fold EPMC outcomes into each id's chain. EPMC-served articles count as
    // recovered, so their ids are added to `recoveredIds` here.
    if (!epmc) {
      const epmcDisabledEntry = {
        tier: 'europepmc' as const,
        outcome: 'not-attempted' as const,
        detail: 'EUROPEPMC_ENABLED=false',
      };
      // EPMC searches by PMID, PMCID, and DOI alike, so it could have served
      // every candidate that reached this stage — no applicability test.
      const skipEpmc = (inputId: string) => {
        chainByInput.get(inputId)?.push(epmcDisabledEntry);
        markUnqueried(inputId, 'europepmc');
      };
      for (const c of pmidFallbackCandidates) skipEpmc(c.pmid);
      for (const c of pmcidFallbackCandidates) {
        const prefixed = withPmcPrefix(c.pmcid);
        skipEpmc(pmcidToInputId.get(prefixed) ?? prefixed);
      }
      for (const c of doiCandidates) skipEpmc(c.doi);
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

    // Detail of a DOI-backfill lookup that threw, per branch. A candidate still
    // DOI-less after one of these is an unknown, not a settled absence: it
    // reports `doi-lookup-failed` rather than `no-doi`. (#119)
    let pmcidDoiLookupFailure: string | undefined;
    let pmidDoiLookupFailure: string | undefined;

    /** The Unpaywall tier entry for a candidate that reached the stage with no DOI. */
    const doilessTierEntry = (failure: string | undefined): z.infer<typeof TriedTierSchema> => ({
      tier: 'unpaywall',
      outcome: failure ? 'doi-lookup-failed' : 'no-doi',
      ...(failure && { detail: failure }),
    });

    // `pmcids` input reaches Unpaywall on the DOI the chain already holds: the
    // EPMC stage searches by PMCID and its hit carries one, captured on non-hit
    // outcomes too. PMCIDs EPMC never resolved fall back to the PMC ID
    // Converter, which returns DOIs for PMC-indexed records. (#88)
    if (pmcidFallbackCandidates.length > 0) {
      if (!unpaywall) {
        // The PMCID → DOI lookup below only runs when Unpaywall is configured,
        // so a candidate arrives here with a DOI only if the EPMC stage handed
        // one over. An absent DOI therefore means "never looked up", not "this
        // record has none" — the tier stays a genuine unknown and is marked.
        for (const c of pmcidFallbackCandidates) {
          const prefixed = withPmcPrefix(c.pmcid);
          const inputId = pmcidToInputId.get(prefixed) ?? prefixed;
          chainByInput.get(inputId)?.push({
            tier: 'unpaywall',
            outcome: 'not-attempted',
            detail: 'UNPAYWALL_EMAIL is not set',
          });
          markUnqueried(inputId, 'unpaywall');
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
            pmcidDoiLookupFailure = error instanceof Error ? error.message : String(error);
            ctx.log.warning('Failed to resolve PMCID → DOI for the Unpaywall fallback', {
              error: pmcidDoiLookupFailure,
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
                ? await resolveUnpaywall(
                    { pmcId, doi: candidate.doi, epmcTitle: candidate.title, budget },
                    unpaywall,
                    ctx,
                  )
                : undefined,
            };
          }),
        );
        for (const { pmcId, result } of outcomes) {
          const inputId = pmcidToInputId.get(pmcId) ?? pmcId;
          if (result === undefined) {
            chainByInput.get(inputId)?.push(doilessTierEntry(pmcidDoiLookupFailure));
          } else if ('article' in result) {
            fallbackArticles.push(result.article);
            inputIdByArticle.set(result.article, inputId);
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
          pmidDoiLookupFailure = error instanceof Error ? error.message : String(error);
          ctx.log.warning('Failed to batch-fetch DOIs from PubMed for Unpaywall fallback', {
            error: pmidDoiLookupFailure,
            pmidCount: needDoi.length,
          });
        }
      }

      if (!unpaywall) {
        // `fetchPubmedDois` has already run, so a candidate with no DOI could
        // not have reached Unpaywall configured or not — that is `no-doi`, a
        // real answer, not an incomplete search. Unless the lookup itself
        // threw, in which case the DOI state is unknown rather than absent.
        for (const c of pmidFallbackCandidates) {
          if (!c.doi) {
            chainByInput.get(c.pmid)?.push(doilessTierEntry(pmidDoiLookupFailure));
            continue;
          }
          chainByInput.get(c.pmid)?.push({
            tier: 'unpaywall',
            outcome: 'not-attempted',
            detail: 'UNPAYWALL_EMAIL is not set',
          });
          markUnqueried(c.pmid, 'unpaywall');
        }
      } else {
        const outcomes = await Promise.all(
          pmidFallbackCandidates.map(async (candidate) => ({
            candidate,
            result: candidate.doi
              ? await resolveUnpaywall(
                  { pmid: candidate.pmid, doi: candidate.doi, epmcTitle: candidate.title, budget },
                  unpaywall,
                  ctx,
                )
              : undefined,
          })),
        );
        for (const { candidate, result } of outcomes) {
          if (result === undefined) {
            chainByInput.get(candidate.pmid)?.push(doilessTierEntry(pmidDoiLookupFailure));
          } else if ('article' in result) {
            fallbackArticles.push(result.article);
            inputIdByArticle.set(result.article, candidate.pmid);
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
        // Every candidate on this branch is a DOI, so Unpaywall applies to all
        // of them.
        for (const c of doiCandidates) {
          chainByInput.get(c.doi)?.push({
            tier: 'unpaywall',
            outcome: 'not-attempted',
            detail: 'UNPAYWALL_EMAIL is not set',
          });
          markUnqueried(c.doi, 'unpaywall');
        }
      } else {
        // `resolveUnpaywall` catches its own failures so this Promise.all
        // doesn't reject under normal operation.
        const outcomes = await Promise.all(
          doiCandidates.map(async (c) => ({
            doi: c.doi,
            result: await resolveUnpaywall(
              { doi: c.doi, epmcTitle: c.title, budget },
              unpaywall,
              ctx,
            ),
          })),
        );
        for (const { doi, result } of outcomes) {
          if ('article' in result) {
            fallbackArticles.push(result.article);
            inputIdByArticle.set(result.article, doi);
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
      const unqueried = unqueriedByInput.get(id);
      for (const callerId of callerIds.get(id) ?? [id]) {
        unavailable.push({
          id: callerId,
          idType,
          reason: reasonFromChain(chain),
          triedTiers: chain,
          ...(unqueried?.size && { unqueriedTiers: [...unqueried] }),
        });
      }
    }

    // Whole-response budget: fill with complete records in response order and
    // hand the rest back as identifiers the caller can re-submit. One ledger for
    // every tier — a PMC-served article and an Unpaywall-served one spend the
    // same characters. Without `maxResponseCharacters` nothing is measured and
    // the response is exactly what it was before the budget existed. (#100)
    const resolved: FulltextArticle[] = [...pmcArticles, ...fallbackArticles];
    const ceiling = input.maxResponseCharacters;
    const fit = ceiling === undefined ? undefined : fitWholeItems(resolved, ceiling);
    const articles = fit?.kept ?? resolved;
    const nextDeferredCharacters = fit?.nextDeferredCharacters;
    const deferred =
      ceiling !== undefined && nextDeferredCharacters !== undefined && fit
        ? {
            maxResponseCharacters: ceiling,
            returnedCharacters: fit.keptCharacters,
            deferredCount: fit.deferred.length,
            idType,
            // Every recovery site records the input id; `articleDisplayId` is
            // the total-function fallback, not an expected path.
            ids: fit.deferred.map((a) => {
              const id = inputIdByArticle.get(a) ?? articleDisplayId(a);
              return callerIds.get(id)?.[0] ?? id;
            }),
            nextDeferredCharacters,
          }
        : undefined;

    // A deferred article takes its body accounting out of the response with it —
    // those counts describe text the caller never received.
    if (fit) {
      for (const article of fit.deferred) {
        const id = articleDisplayId(article);
        const index = truncatedArticles.findIndex((t) => t.id === id);
        if (index === -1) continue;
        const [dropped] = truncatedArticles.splice(index, 1);
        if (dropped) {
          omittedSections -= countDroppedSections(dropped.sections ?? [], input.overflowMode);
        }
      }
    }

    ctx.log.info('pubmed_fetch_fulltext completed', {
      requested: (input.pmids ?? input.pmcids ?? input.dois)?.length ?? 0,
      returned: articles.length,
      pmcHits: pmcArticles.filter((a) => a.viaSource === 'pmc').length,
      epmcHits: pmcArticles.filter((a) => a.viaSource === 'europepmc').length,
      unpaywallHits: fallbackArticles.length,
      unavailable: unavailable.length,
      ...(deferred && { deferred: deferred.deferredCount }),
    });

    // Summed off the per-article entries rather than carried through every
    // stage, so a deferred article's dropped tables leave the roll-up together
    // with its entry when the splice above removes it. (#111)
    const omittedTables = truncatedArticles.reduce((n, a) => n + (a.omittedTables ?? 0), 0);
    const omittedAssets = truncatedArticles.reduce((n, a) => n + (a.omittedAssets ?? 0), 0);

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
            ...(omittedTables > 0 && { omittedTables }),
            ...(omittedAssets > 0 && { omittedAssets }),
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
    const unextractableTables = collectUnextractableTables(articles);
    if (unextractableTables.length > 0) {
      notices.push(buildUnextractableTablesNotice(unextractableTables));
    }
    if (truncation) {
      notices.push(buildTruncationNotice(truncation));
      ctx.enrich({ truncated: true });
    }
    if (deferred) {
      notices.push(buildDeferralNotice(deferred));
      ctx.enrich({ truncated: true });
    }
    if (notices.length > 0) ctx.enrich.notice(notices.join(' '));

    return {
      articles,
      totalReturned: articles.length,
      ...(unavailable.length > 0 && { unavailable }),
      ...(truncation && { truncation }),
      ...(deferred && { deferred }),
    };
  },

  format: (result) => {
    const lines = [`## Full-Text Articles`, `**Articles Returned:** ${result.totalReturned}`];

    if (result.unavailable?.length) {
      lines.push(`\n**Unavailable (${result.unavailable.length}):**`);
      let anyUnqueried = false;
      for (const u of result.unavailable) {
        lines.push(`- [${u.idType}] ${u.id} — ${u.reason}`);
        if (u.unqueriedTiers?.length) {
          anyUnqueried = true;
          lines.push(`  Not queried: ${formatUnqueriedTiers(u.unqueriedTiers, u.triedTiers)}`);
        }
        const chain = u.triedTiers
          .map((t) => {
            const detail = t.detail ? sanitizeChainDetail(t.detail) : undefined;
            return `${t.tier}:${t.outcome}${detail ? ` (${detail})` : ''}`;
          })
          .join(' → ');
        if (chain) lines.push(`  chain: ${chain}`);
      }
      // One explanation for the whole list — repeating it per entry buries the
      // ids it qualifies.
      if (anyUnqueried) {
        lines.push(
          `\n> Tiers marked "Not queried" were skipped because this deployment has not configured them, so those searches are incomplete — a deployment with those tiers configured may still resolve the affected ids.`,
        );
      }
    }

    if (result.deferred) {
      const d = result.deferred;
      lines.push(
        `\n**Deferred by the response budget:** ${d.deferredCount} article(s) — ${d.returnedCharacters} of ${d.maxResponseCharacters} budgeted characters returned; next deferred article ${d.nextDeferredCharacters} characters`,
        `Re-call \`pubmed_fetch_fulltext\` with these ${d.idType} ids as \`${d.idType}s\`: ${d.ids.join(', ')}`,
      );
    }

    // An empty response under a budget is a deferral, not an absence — the
    // articles resolved and the ids above retrieve them.
    if (result.totalReturned === 0 && !result.deferred) {
      lines.push(
        `\n> No full-text articles returned. Articles must be open-access and indexed in PMC, Europe PMC, or recoverable via Unpaywall to retrieve full text. For metadata and abstracts only, use \`pubmed_fetch_articles\`.`,
      );
    }

    if (result.truncation) formatTruncation(result.truncation, lines);

    const truncationById = new Map(result.truncation?.articles.map((t) => [t.id, t]) ?? []);
    for (const a of result.articles) {
      lines.push('');
      const t = truncationById.get(articleDisplayId(a));
      if (a.source === 'pmc') formatPmcArticle(a, lines, t, result.truncation?.mode);
      else formatUnpaywallArticle(a, lines, t);
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});

// ─── Handler helpers ─────────────────────────────────────────────────────────

/**
 * What a Europe PMC search hit tells the Unpaywall stage about a candidate it
 * did not serve: the record's DOI and its display title, captured whatever the
 * fetch outcome was. The title is the article's fallback when Unpaywall's own
 * record carries none. (#88, #144)
 */
type EpmcHitCarry = { doi?: string; title?: string };

/** A PMID not present in PMC, optionally paired with a DOI for Unpaywall lookup. */
type PmidCandidate = { pmid: string } & EpmcHitCarry;

/**
 * A PMCID requested directly but not returned by PMC EFetch, optionally paired
 * with a DOI for the Unpaywall lookup. The DOI arrives from the Europe PMC hit
 * the stage already made, or from the PMC ID Converter when EPMC never resolved
 * the record. (#88)
 */
type PmcidCandidate = { pmcid: string } & EpmcHitCarry;

/** A DOI candidate for direct DOI input. */
type DoiCandidate = { doi: string } & EpmcHitCarry;

/**
 * Merge what a Europe PMC hit carried onto a candidate bound for Unpaywall. A
 * DOI the candidate already holds wins — for `dois` input it is the caller's
 * own identifier.
 */
function carryEpmcHit<C extends EpmcHitCarry>(candidate: C, hit: EpmcHitCarry): C {
  return {
    ...candidate,
    ...(hit.doi && !candidate.doi && { doi: hit.doi }),
    ...(hit.title && { title: hit.title }),
  };
}

/** Display-ready plain text, or `undefined` when nothing is left once markup is stripped. */
function nonEmptyDisplayText(raw: string | undefined): string | undefined {
  return (raw && toDisplayText(raw)) || undefined;
}

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
  /** Candidate id (pmid, prefixed PMCID, or doi) each EPMC-served article came from. */
  articleInputIds: Map<z.infer<typeof PmcArticleSchema>, string>;
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
  /** The DOI and title the hit carried sit on the run itself, set on non-hit outcomes too. */
  type CandidateRun<C> = EpmcHitCarry & {
    c: C;
    outcome: EpmcCandidateOutcome;
    article?: z.infer<typeof PmcArticleSchema>;
    sectionFilterMiss?: boolean;
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
    const title = nonEmptyDisplayText(search.hit.title);
    const hit: EpmcHitCarry = {
      ...(search.hit.doi && { doi: search.hit.doi }),
      ...(title && { title }),
    };
    const fetched = await fetchEpmcArticle(epmc, search.hit, args, contextPmid);
    if (fetched.kind === 'error') {
      return { c, ...hit, outcome: { kind: 'service-error', detail: fetched.detail } };
    }
    if (fetched.kind === 'no-fulltext') {
      return {
        c,
        ...hit,
        outcome: { kind: 'no-fulltext', ...(fetched.detail && { detail: fetched.detail }) },
      };
    }
    if (fetched.kind === 'no-body') {
      return { c, ...hit, outcome: { kind: 'no-body', detail: fetched.detail } };
    }
    return {
      c,
      ...hit,
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
  const articleInputIds = new Map<z.infer<typeof PmcArticleSchema>, string>();
  const remainingPmid: PmidCandidate[] = [];
  const remainingPmcid: PmcidCandidate[] = [];
  const remainingDoi: DoiCandidate[] = [];
  const pmidOutcomes = new Map<string, EpmcCandidateOutcome>();
  const pmcidOutcomes = new Map<string, EpmcCandidateOutcome>();
  const doiOutcomes = new Map<string, EpmcCandidateOutcome>();
  const sectionFilterMisses: string[] = [];
  const truncatedArticles: z.infer<typeof TruncatedArticleSchema>[] = [];
  let omittedSections = 0;

  const collectHit = (
    candidateId: string,
    run: {
      article: z.infer<typeof PmcArticleSchema>;
      sectionFilterMiss?: boolean;
      truncation?: z.infer<typeof TruncatedArticleSchema>;
      omittedSections?: number;
    },
  ) => {
    articles.push(run.article);
    articleInputIds.set(run.article, candidateId);
    if (run.sectionFilterMiss) sectionFilterMisses.push(articleDisplayId(run.article));
    if (run.truncation) truncatedArticles.push(run.truncation);
    omittedSections += run.omittedSections ?? 0;
  };

  for (const run of pmidResults) {
    pmidOutcomes.set(run.c.pmid, run.outcome);
    if (run.article) collectHit(run.c.pmid, { ...run, article: run.article });
    // What the EPMC hit carried is evidence the next stage needs, whatever the
    // fetch outcome was: its DOI spares Unpaywall a PubMed metadata round-trip
    // (#119), and its title backs up Unpaywall's own record (#144).
    else remainingPmid.push(carryEpmcHit(run.c, run));
  }
  for (const run of pmcidResults) {
    pmcidOutcomes.set(run.c.normalized, run.outcome);
    if (run.article) collectHit(run.c.normalized, { ...run, article: run.article });
    else remainingPmcid.push(carryEpmcHit(run.c.c, run));
  }
  for (const run of doiResults) {
    doiOutcomes.set(run.c.doi, run.outcome);
    if (run.article) collectHit(run.c.doi, { ...run, article: run.article });
    else remainingDoi.push(carryEpmcHit(run.c, run));
  }

  return {
    articles,
    articleInputIds,
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
 *
 * The article's title is the first one found in Unpaywall's own record, then
 * `epmcTitle` — the Europe PMC record the chain searched for this id — then,
 * for HTML content only, the title the extractor detects on the page. None is
 * ever invented: with no source carrying one, the article has no title. The
 * journal name and year come from Unpaywall's record alone. (#144)
 */
async function resolveUnpaywall(
  args: {
    pmcId?: string;
    pmid?: string;
    doi: string;
    epmcTitle?: string | undefined;
    budget: BudgetOptions;
  },
  service: UnpaywallService,
  ctx: Context,
): Promise<FallbackOutcome> {
  const { pmcId, pmid, doi, epmcTitle, budget } = args;
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

  const recordTitle = nonEmptyDisplayText(resolution.title) ?? epmcTitle;
  const record = {
    ...requestedIds,
    doi,
    sourceUrl: content.fetchedUrl,
    location: resolution.location,
    journalName: nonEmptyDisplayText(resolution.journalName),
    year: resolution.year,
  };

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
            ...record,
            contentFormat: 'html-markdown',
            content: text,
            title: recordTitle ?? extracted.title,
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
          ...record,
          contentFormat: 'pdf-text',
          content: body,
          title: recordTitle,
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
  journalName?: string | undefined;
  year?: number | undefined;
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
    ...(args.journalName && { journalName: args.journalName }),
    ...(args.year !== undefined && { year: args.year }),
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
    case 'doi-lookup-failed':
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
 * Derive the `reason` shown on the unavailable entry from its chain: the most
 * specific content signal the last tier that actually answered reported.
 *
 * Skipped tiers are deliberately not folded in here. A configuration note in
 * place of the content signal would erase the one specific thing the chain
 * learned; the incompleteness is reported alongside it, on `unqueriedTiers`,
 * where it adds to the answer instead of replacing it. A chain where no tier
 * was attempted at all has no signal to report and stays
 * `no-pmc-fallback-disabled`.
 */
function reasonFromChain(
  chain: z.infer<typeof TriedTierSchema>[],
): z.infer<typeof UnavailableReasonSchema> {
  let lastSignal: z.infer<typeof TriedTierSchema> | undefined;
  for (const t of chain) {
    if (t.outcome !== 'not-attempted') lastSignal = t;
  }
  if (!lastSignal) return 'no-pmc-fallback-disabled';

  // Unpaywall answering `no-doi` for an id the content tiers never found adds
  // nothing: record absence is the specific signal, so it stays `not-found`.
  if (lastSignal.tier === 'unpaywall' && lastSignal.outcome === 'no-doi') {
    const lastContentSignal = chain.findLast(
      (t) => t.tier !== 'unpaywall' && t.outcome !== 'not-attempted',
    );
    if (lastContentSignal?.outcome === 'miss') return 'not-found';
  }

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
    // Its own case, never folded into the `unpaywall:no-doi` → `not-found`
    // collapse above: that collapse says record absence is the specific signal,
    // and a lookup that never answered has established no absence at all. (#119)
    case 'unpaywall:doi-lookup-failed':
      return 'doi-lookup-failed';
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

/** Human-readable tier names for the unqueried-tier line. */
const UNQUERIED_TIER_LABELS: Record<z.infer<typeof UnqueriedTierSchema>, string> = {
  europepmc: 'Europe PMC',
  unpaywall: 'Unpaywall',
};

/**
 * Name each unqueried tier with the reason its chain entry gave for skipping it,
 * so a `content[]` reader learns which setting is missing without decoding the
 * chain line. The detail goes through the same sanitizer the chain does — it is
 * the same upstream string. (#110)
 */
function formatUnqueriedTiers(
  tiers: z.infer<typeof UnqueriedTierSchema>[],
  chain: z.infer<typeof TriedTierSchema>[],
): string {
  return tiers
    .map((tier) => {
      const detail = chain.find((t) => t.tier === tier && t.outcome === 'not-attempted')?.detail;
      const label = UNQUERIED_TIER_LABELS[tier];
      return detail ? `${label} (${sanitizeChainDetail(detail)})` : label;
    })
    .join(', ');
}

/**
 * Render the response-level character accounting. Every field is rendered
 * unconditionally so `content[]` readers see the same budget detail
 * `structuredContent` readers get. Counts are printed raw — no thousands
 * separators — so the numbers stay greppable. (#81)
 */
function formatTruncation(t: z.infer<typeof TruncationSchema>, lines: string[]): void {
  const tablesOmitted =
    t.omittedTables === undefined ? '' : `; ${t.omittedTables} table(s) omitted whole`;
  const assetsOmitted =
    t.omittedAssets === undefined ? '' : `; ${t.omittedAssets} asset(s) omitted whole`;
  lines.push(
    `\n**Truncated (${t.mode} mode):** ${t.returnedCharacters} of ${t.originalCharacters} body characters returned across ${t.articles.length} article(s); ${t.omittedSections} section(s) omitted${tablesOmitted}${assetsOmitted}`,
  );
  const budgets = [
    t.maxCharacters === undefined ? undefined : `maxCharacters ${t.maxCharacters}`,
    t.maxCharactersPerSection === undefined
      ? undefined
      : `maxCharactersPerSection ${t.maxCharactersPerSection}`,
  ].filter((b): b is string => b !== undefined);
  if (budgets.length) lines.push(`Budget applied: ${budgets.join(', ')}`);

  for (const a of t.articles) {
    const tablesDropped =
      a.omittedTables === undefined
        ? ''
        : `, ${a.omittedTables} table(s) dropped whole: ${(a.omittedTableNames ?? []).join(', ')}`;
    const assetsDropped =
      a.omittedAssets === undefined
        ? ''
        : `, ${a.omittedAssets} asset(s) dropped whole: ${(a.omittedAssetNames ?? []).join(', ')}`;
    lines.push(
      `- ${a.id} (${a.source}): ${a.returnedCharacters} of ${a.originalCharacters} characters${tablesDropped}${assetsDropped}`,
    );
    for (const s of a.sections ?? []) formatLedgerEntry(s, lines, t.mode, 1);
  }
}

/**
 * One section's ledger line, then its subsections' one level deeper. The line
 * names the section by {@link sectionHeading}, so it reads exactly as the
 * section's heading does in the body. An entry the budget emptied says what
 * became of it — dropped in `truncate` mode, kept as a bare heading in
 * `outline` mode. (#143, #148)
 */
function formatLedgerEntry(
  entry: SectionLedgerEntry,
  lines: string[],
  mode: 'truncate' | 'outline',
  depth: number,
): void {
  const fate = isBudgetEmptied(entry)
    ? mode === 'truncate'
      ? ' — dropped'
      : ' — heading only'
    : '';
  lines.push(
    `${'  '.repeat(depth)}- ${sectionHeading(entry)} — ${entry.returnedCharacters} of ${entry.originalCharacters} characters (truncated: ${entry.truncated})${fate}`,
  );
  for (const sub of entry.subsections ?? []) formatLedgerEntry(sub, lines, mode, depth + 1);
}

/** Per-article inline marker so a reader of one article's body knows it is partial. */
function truncationNote(t: z.infer<typeof TruncatedArticleSchema>): string {
  return `\n> Body shortened to fit the requested character budget — ${t.returnedCharacters} of ${t.originalCharacters} characters returned. See \`truncation\` for per-section counts.`;
}

/**
 * The marker an `outline`-mode heading carries when the budget left it no text,
 * so it reads as withheld rather than as a heading over nothing. (#143)
 */
function emptiedSectionNote(originalCharacters: number): string {
  return `> Text omitted to fit the requested character budget — 0 of ${originalCharacters} characters returned.`;
}

function formatPmcArticle(
  a: z.infer<typeof PmcArticleSchema>,
  lines: string[],
  truncation?: z.infer<typeof TruncatedArticleSchema>,
  mode?: 'truncate' | 'outline',
): void {
  // Render-time only — `structuredContent.articles[].title` keeps the
  // plain-text value the JATS parser produced. (#102)
  lines.push(`### ${escapeMarkdownInline(a.title ?? articleDisplayId(a))}`);
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
    if (a.journal.elocationId) parts.push(a.journal.elocationId);
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

  // `outline` mode keeps every section and subsection, so each one lines up
  // with its ledger entry by position. `truncate` mode drops the emptied ones —
  // positions no longer line up, and nothing left needs a marker.
  const ledger = mode === 'outline' ? truncation?.sections : undefined;
  a.sections.forEach((sec, i) => {
    formatSection(sec, lines, 4, ledger?.[i]);
  });

  if (a.tables?.length) formatTables(a.tables, lines);

  if (a.assets?.length) formatAssets(a.assets, lines);

  if (a.references?.length) {
    lines.push(`\n#### References (${a.references.length})`);
    for (const ref of a.references) {
      const tag = [ref.label, ref.id].filter(Boolean).join(' ');
      lines.push(`- ${tag ? `[${tag}] ` : ''}${ref.citation}`);
    }
  }
}

/**
 * Render every table as a Markdown grid, so a `content[]` reader gets the same
 * cells `structuredContent` carries rather than a note that tables exist. (#111)
 *
 * Cell text goes through {@link escapeMarkdownTableCell} — the inline escape
 * plus the `|` a cell cannot carry raw. The parser expands `colspan` and
 * `rowspan`, so a well-formed table arrives rectangular and every value renders
 * under the header it belongs to; a row still short of the widest is padded on
 * the right with empty cells only, never a neighbour's value.
 */
function formatTables(tables: z.infer<typeof TableSchema>[], lines: string[]): void {
  lines.push(`\n#### Tables (${tables.length})`);
  for (const table of tables) {
    const heading = [table.label, table.caption].filter(Boolean).join(' — ');
    lines.push(`\n##### ${escapeMarkdownInline(heading || 'Table')}`);

    const meta = [
      table.sectionTitle ? `Section: ${escapeMarkdownInline(table.sectionTitle)}` : undefined,
      table.id ? `id: ${escapeMarkdownInline(table.id)}` : undefined,
      describeHeaderRows(table),
    ].filter((part): part is string => part !== undefined);
    if (meta.length) lines.push(`*${meta.join(' · ')}*`);

    if (table.unextractableReason) {
      lines.push(
        `\n> Table body could not be read (${table.unextractableReason}) — ${UNEXTRACTABLE_TABLE_EXPLANATIONS[table.unextractableReason]}. The label and caption above are all this deposit carries; no cell values exist to return.`,
      );
    }
    if (table.rows.length > 0) lines.push(...renderTableGrid(table.rows, table.headerRowCount));
    if (table.footnotes) lines.push(`\nFootnotes: ${escapeMarkdownInline(table.footnotes)}`);
  }
}

/**
 * Render every figure and supplementary item, so a `content[]` reader gets the
 * same caption, pointer and placement `structuredContent` carries rather than a
 * count saying they exist. Each field of `AssetSchema` appears here — that is
 * what `format-parity` verifies. (#130)
 *
 * Label, caption and `href` go through {@link escapeMarkdownInline}: the parser
 * stores the raw upstream text, and a caption carrying `[`, `*` or a tag-shaped
 * `<` would otherwise form a link, emphasis or raw HTML at the render boundary.
 *
 * The note about `href` is worth its line: the value is a filename inside the PMC
 * deposit, and an agent that reads it as a URL will spend a request on a 404 for
 * every figure in the article.
 */
function formatAssets(assets: z.infer<typeof AssetSchema>[], lines: string[]): void {
  lines.push(`\n#### Assets (${assets.length})`);
  lines.push(
    `\n> \`file\` is the pointer exactly as deposited — a name inside the PMC deposit, not a fetchable URL. Open the article at the PMC link above to view it.`,
  );
  for (const asset of assets) {
    const heading = [asset.label, asset.caption].filter(Boolean).join(' — ');
    lines.push(`\n##### ${escapeMarkdownInline(heading || 'Asset')}`);

    const meta = [
      asset.assetType,
      asset.sectionTitle ? `Section: ${escapeMarkdownInline(asset.sectionTitle)}` : undefined,
      asset.id ? `id: ${escapeMarkdownInline(asset.id)}` : undefined,
      asset.href ? `file: ${escapeMarkdownInline(asset.href)}` : undefined,
    ].filter((part): part is string => part !== undefined);
    lines.push(`*${meta.join(' · ')}*`);
  }
}

/**
 * The meta-line clause describing a table's header rows.
 *
 * A Markdown grid carries exactly one header row, so a table declaring several
 * has them folded into it — say how many were folded, or the grid understates
 * what the deposit declared. A table declaring none still needs the empty header
 * row Markdown requires above the divider; naming that keeps a reader from
 * taking the blank row for a header the publisher deposited and left empty.
 */
function describeHeaderRows(table: z.infer<typeof TableSchema>): string | undefined {
  if (table.rows.length === 0) return;
  if (table.headerRowCount === 0) return 'header rows: none declared — every row below is data';
  if (table.headerRowCount === 1) return 'header rows: 1';
  return `header rows: ${table.headerRowCount} (folded into one)`;
}

/**
 * Join one grid column's header cells into the single header path Markdown can
 * carry. Consecutive repeats — what expanding a `colspan` produces — collapse to
 * one, so a group header spanning three columns reads once per column rather
 * than three times in each.
 */
function foldHeaderColumn(headerRows: string[][], column: number): string {
  const path: string[] = [];
  for (const row of headerRows) {
    const cell = row[column] ?? '';
    if (cell && cell !== path.at(-1)) path.push(cell);
  }
  return path.join(' · ');
}

/** One table's rows as Markdown grid lines, preceded by a blank line. */
function renderTableGrid(rows: string[][], headerRowCount: number): string[] {
  const columns = rows.reduce((widest, row) => Math.max(widest, row.length), 0);
  const renderRow = (cells: string[]) =>
    `| ${Array.from({ length: columns }, (_, i) => escapeMarkdownTableCell(cells[i] ?? '')).join(' | ')} |`;
  const headerRows = rows.slice(0, headerRowCount);
  const header = Array.from({ length: columns }, (_, i) => foldHeaderColumn(headerRows, i));
  return [
    '',
    renderRow(header),
    `| ${Array.from({ length: columns }, () => '---').join(' | ')} |`,
    ...rows.slice(headerRowCount).map(renderRow),
  ];
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
  lines.push(`### ${escapeMarkdownInline(heading)}`);
  lines.push(`**Source:** ${formatLabel}`);
  if (a.journalName) lines.push(`**Journal:** ${escapeMarkdownInline(a.journalName)}`);
  if (a.year !== undefined) lines.push(`**Year:** ${a.year}`);
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

/** How a section with no title and no label is named — in its body heading and its ledger line. */
const UNTITLED_SECTION_LABEL = 'untitled section';

/**
 * The name a section goes by in `content[]`: its label and title, else its
 * label alone, else {@link UNTITLED_SECTION_LABEL}. The body heading and the
 * truncation ledger line both take it from here, so the two always read the
 * same. Render-time escaped like every other upstream string interpolated into
 * a line, so a title's `*`, `_`, `` ` `` or `[` cannot restyle the heading;
 * `structuredContent` keeps the plain title. (#148, #169)
 */
function sectionHeading(section: {
  label?: string | undefined;
  title?: string | undefined;
}): string {
  if (section.title) return escapeMarkdownInline(formatHeading(section.label, section.title));
  return section.label ? escapeMarkdownInline(section.label) : UNTITLED_SECTION_LABEL;
}

/**
 * A body section at any nesting level. The schema inlines one type per level so
 * the emitted JSON Schema stays `$ref`-free, and every one of those types is a
 * subset of this shape, so the renderer takes it for all of them.
 */
interface RenderableSection {
  label?: string | undefined;
  subsections?: RenderableSection[] | undefined;
  text: string;
  title?: string | undefined;
}

/**
 * Render one body section and everything nested under it, one markdown heading
 * level per nesting level. Walks the full depth the output schema carries, so
 * `content[]` shows every section `structuredContent` does. Headings stop
 * deepening at `######`, the deepest markdown supports. (#112)
 *
 * Every section gets a heading — an untitled one included, under the name the
 * truncation ledger gives it — so its text never runs on from the block before
 * it. `ledger` is the section's `outline`-mode accounting, when there is one: a
 * section it shows the budget emptied carries a marker under its heading.
 * (#143, #148)
 */
function formatSection(
  section: RenderableSection,
  lines: string[],
  depth: number,
  ledger?: SectionLedgerEntry,
): void {
  lines.push(`\n${'#'.repeat(Math.min(depth, 6))} ${sectionHeading(section)}`);
  if (section.text) lines.push(section.text);
  else if (ledger && isBudgetEmptied(ledger)) {
    lines.push(emptiedSectionNote(ledger.originalCharacters));
  }
  section.subsections?.forEach((sub, i) => {
    formatSection(sub, lines, depth + 1, ledger?.subsections?.[i]);
  });
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
