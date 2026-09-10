/**
 * @fileoverview Parser for PMC full-text articles in JATS XML format.
 * Consumes the ordered tree shape from fast-xml-parser's `preserveOrder: true`
 * mode (see `pmc-xml-helpers.ts`) so that mixed-content elements — `<p>`,
 * `<abstract>`, `<title>` with inline `<italic>`, `<xref>`, `<sup>`, etc. —
 * read back in document order. Parsing in the default object shape scrambles
 * inline children and drops body sections for markup-heavy articles.
 * @module src/services/ncbi/parsing/pmc-article-parser
 */

import type {
  ParsedPmcArticle,
  ParsedPmcAuthor,
  ParsedPmcJournal,
  ParsedPmcReference,
  ParsedPmcSection,
  ParsedPmcTable,
  ParsedPmcTableUnextractableReason,
} from '../types.js';
import {
  attrOf,
  childrenOf,
  findAll,
  findAllDescendants,
  findOne,
  isTextNode,
  type JatsNode,
  rawTextContent,
  tagNameOf,
  textContent,
  textContentExcluding,
  textOf,
} from './pmc-xml-helpers.js';

/**
 * Block content extracted into its own field and therefore excluded from the
 * prose a paragraph contributes. A `<table-wrap>` nested inside a `<p>` would
 * otherwise be flattened into the surrounding sentence, concatenating adjacent
 * cell values into numbers that never existed. (#111)
 */
const LIFTED_BLOCK_TAGS: ReadonlySet<string> = new Set(['table-wrap']);

/** Prose of one `<p>`, with lifted block content left out. */
function paragraphText(paragraph: JatsNode): string {
  return textContentExcluding(paragraph, LIFTED_BLOCK_TAGS);
}

/** True when a lifted block sits anywhere in this subtree. */
function containsLiftedBlock(node: JatsNode): boolean {
  return childrenOf(node).some(
    (child) => LIFTED_BLOCK_TAGS.has(tagNameOf(child) ?? '') || containsLiftedBlock(child),
  );
}

/**
 * True when a `<sec>` carried block content that was extracted into its own
 * field — a `<table-wrap>` sitting beside its paragraphs, or nested inside one.
 *
 * This is what separates a section emptied by the lift from one that never had
 * readable prose. The first is a real heading a reader needs in order to place
 * the table that names it; the second is a structural wrapper — a `<sec>` around
 * a `<ref-list>`, say — which would arrive as a stray empty "References" entry
 * if every empty section survived. Only this section's own children are
 * considered: a `<table-wrap>` deeper down belongs to the nested `<sec>` that
 * holds it, and that section survives on its own account. (#111, #116)
 */
function hasLiftedBlockContent(sec: JatsNode): boolean {
  return childrenOf(sec).some((child) => {
    const tag = tagNameOf(child) ?? '';
    if (LIFTED_BLOCK_TAGS.has(tag)) return true;
    return tag === 'p' && containsLiftedBlock(child);
  });
}

// ─── Article IDs ────────────────────────────────────────────────────────────

function extractArticleId(
  articleMeta: JatsNode | undefined,
  pubIdType: string,
): string | undefined {
  if (!articleMeta) return;
  for (const idNode of findAll(articleMeta, 'article-id')) {
    if (attrOf(idNode, 'pub-id-type') === pubIdType) {
      return textContent(idNode) || undefined;
    }
  }
  return;
}

// ─── Authors & Affiliations ─────────────────────────────────────────────────

/** Extract authors from a single `<contrib-group>` node. Non-author contributors are skipped. */
export function extractJatsAuthors(contribGroup: JatsNode | undefined): ParsedPmcAuthor[] {
  if (!contribGroup) return [];

  const authors: ParsedPmcAuthor[] = [];
  for (const contrib of findAll(contribGroup, 'contrib')) {
    const contribType = attrOf(contrib, 'contrib-type');
    if (contribType && contribType !== 'author') continue;

    const collab = findOne(contrib, 'collab');
    if (collab) {
      const collectiveName = textContent(collab);
      if (collectiveName) authors.push({ collectiveName });
      continue;
    }

    const nameNode = findOne(contrib, 'name');
    if (nameNode) {
      const lastName = textContent(findOne(nameNode, 'surname')) || undefined;
      const givenNames = textContent(findOne(nameNode, 'given-names')) || undefined;
      authors.push({
        ...(lastName && { lastName }),
        ...(givenNames && { givenNames }),
      });
    }
  }

  return authors;
}

function extractAffiliations(articleMeta: JatsNode | undefined): string[] {
  if (!articleMeta) return [];
  const result: string[] = [];
  for (const aff of findAll(articleMeta, 'aff')) {
    const text = textContent(aff);
    if (text) result.push(text);
  }
  return result;
}

// ─── Journal & Publication Date ─────────────────────────────────────────────

function extractJournal(
  journalMeta: JatsNode | undefined,
  articleMeta: JatsNode | undefined,
): ParsedPmcJournal | undefined {
  if (!journalMeta) return;

  const titleGroup = findOne(journalMeta, 'journal-title-group');
  const title =
    textContent(findOne(titleGroup, 'journal-title')) ||
    textContent(findOne(journalMeta, 'journal-title')) ||
    undefined;

  const firstIssn = findAll(journalMeta, 'issn')[0];
  const issn = firstIssn ? textContent(firstIssn) || undefined : undefined;

  const volume = articleMeta ? textContent(findOne(articleMeta, 'volume')) || undefined : undefined;
  const issue = articleMeta ? textContent(findOne(articleMeta, 'issue')) || undefined : undefined;
  const fpage = articleMeta ? textContent(findOne(articleMeta, 'fpage')) : '';
  const lpage = articleMeta ? textContent(findOne(articleMeta, 'lpage')) : '';
  const pages = fpage && lpage ? `${fpage}-${lpage}` : fpage || undefined;

  if (!title && !issn && !volume && !issue && !pages) return;

  return {
    ...(title && { title }),
    ...(issn && { issn }),
    ...(volume && { volume }),
    ...(issue && { issue }),
    ...(pages && { pages }),
  };
}

function extractPubDate(
  articleMeta: JatsNode | undefined,
): { day?: string; month?: string; year?: string } | undefined {
  if (!articleMeta) return;

  const dates = findAll(articleMeta, 'pub-date');
  if (dates.length === 0) return;

  const preferred =
    dates.find((d) => attrOf(d, 'pub-type') === 'epub') ??
    dates.find((d) => attrOf(d, 'pub-type') === 'ppub') ??
    dates.find((d) => attrOf(d, 'date-type') === 'pub') ??
    dates[0];

  if (!preferred) return;

  const year = textContent(findOne(preferred, 'year')) || undefined;
  if (!year) return;

  const month = textContent(findOne(preferred, 'month')) || undefined;
  const day = textContent(findOne(preferred, 'day')) || undefined;
  return {
    year,
    ...(month && { month }),
    ...(day && { day }),
  };
}

// ─── Abstract & Keywords ────────────────────────────────────────────────────

function extractAbstract(articleMeta: JatsNode | undefined): string | undefined {
  if (!articleMeta) return;
  const abstractNode = findOne(articleMeta, 'abstract');
  if (!abstractNode) return;

  const sections = findAll(abstractNode, 'sec');
  if (sections.length > 0) {
    const parts: string[] = [];
    for (const sec of sections) {
      const title = textContent(findOne(sec, 'title'));
      const text = findAll(sec, 'p')
        .map((p) => textContent(p))
        .filter(Boolean)
        .join(' ');
      if (title && text) parts.push(`${title}: ${text}`);
      else if (text) parts.push(text);
    }
    return parts.join('\n\n').trim() || undefined;
  }

  const paragraphs = findAll(abstractNode, 'p');
  if (paragraphs.length > 0) {
    return (
      paragraphs
        .map((p) => textContent(p))
        .filter(Boolean)
        .join(' ') || undefined
    );
  }

  return textContent(abstractNode) || undefined;
}

function extractKeywords(articleMeta: JatsNode | undefined): string[] {
  if (!articleMeta) return [];
  const keywords: string[] = [];
  for (const group of findAll(articleMeta, 'kwd-group')) {
    for (const kwd of findAll(group, 'kwd')) {
      const text = textContent(kwd);
      if (text) keywords.push(text);
    }
  }
  return keywords;
}

// ─── Body Sections ──────────────────────────────────────────────────────────

/**
 * Extract body sections from a `<body>` node, walking children in document order.
 * Consecutive bare `<p>` siblings are collected into an untitled section so
 * articles with mixed structure (direct paragraphs + trailing `<sec>`, common
 * in manuscript-submitted PMC deposits) preserve their main text.
 */
export function extractBodySections(body: JatsNode | undefined): ParsedPmcSection[] {
  if (!body) return [];

  const sections: ParsedPmcSection[] = [];
  let pendingParagraphs: string[] = [];

  const flushPending = () => {
    if (pendingParagraphs.length > 0) {
      sections.push({ text: pendingParagraphs.join('\n\n') });
      pendingParagraphs = [];
    }
  };

  for (const child of childrenOf(body)) {
    const tag = tagNameOf(child);
    if (tag === 'p') {
      const text = paragraphText(child);
      if (text) pendingParagraphs.push(text);
    } else if (tag === 'sec') {
      flushPending();
      const section = extractSection(child);
      if (section) sections.push(section);
    }
  }
  flushPending();

  return sections;
}

function extractSection(sec: JatsNode): ParsedPmcSection | null {
  const title = textContent(findOne(sec, 'title')) || undefined;
  const label = textContent(findOne(sec, 'label')) || undefined;

  const textParts = findAll(sec, 'p').map(paragraphText).filter(Boolean);

  const subsections = findAll(sec, 'sec')
    .map(extractSection)
    .filter((s): s is ParsedPmcSection => s !== null);

  const text = textParts.join('\n\n');
  // A section left empty *because* its block content was lifted into `tables[]`
  // survives as a heading-only entry: the heading is what places the table for a
  // reader, and dropping it also erased the section from a `sections` filter's
  // reach. A section that never carried prose still drops. (#111)
  if (!text && subsections.length === 0 && !hasLiftedBlockContent(sec)) return null;

  return {
    ...(title && { title }),
    ...(label && { label }),
    text,
    ...(subsections.length > 0 && { subsections }),
  };
}

// ─── Tables ─────────────────────────────────────────────────────────────────

/**
 * Extract every `<table-wrap>` under `root` in document order — pass the
 * `<article>` node.
 *
 * The walk covers the whole article rather than `<body>` alone: about a quarter
 * of real tables sit in `<floats-group>`, `<back>/<sec>`, `<table-wrap-group>`
 * or `<app-group>/<app>`, so a body-scoped extractor drops them. Each table
 * names the innermost enclosing `<sec>` wherever that sits — a back-matter or
 * appendix section counts, and naming it is the reader's only positional cue
 * there. Only a table inside no `<sec>` at all, such as a `<floats-group>`
 * deposit, carries no section name.
 *
 * Only XHTML `<tr>`/`<td>`/`<th>` bodies are read. **Decision, not an
 * oversight:** across a 283-table survey of open-access records, 276 were XHTML,
 * 7 were graphic-only deposits and 0 used the CALS `<tgroup>` model. Graphic-only
 * and CALS bodies therefore take the unextractable path — returned with their
 * label and caption and a reason — rather than adding a second table model no
 * observed record needs. Revisit only if CALS shows up in the wild. (#111)
 */
export function extractPmcTables(root: JatsNode | undefined): ParsedPmcTable[] {
  if (!root) return [];
  const tables: ParsedPmcTable[] = [];
  collectTables(root, undefined, tables);
  return tables;
}

function collectTables(
  node: JatsNode,
  sectionTitle: string | undefined,
  out: ParsedPmcTable[],
): void {
  for (const child of childrenOf(node)) {
    const tag = tagNameOf(child);
    if (!tag) continue;
    if (tag === 'table-wrap') {
      out.push(parseTableWrap(child, sectionTitle));
      continue;
    }
    // An untitled <sec> keeps its parent's title rather than dropping the
    // reader's only positional cue.
    const nested =
      tag === 'sec' ? textContent(findOne(child, 'title')) || sectionTitle : sectionTitle;
    collectTables(child, nested, out);
  }
}

function parseTableWrap(tableWrap: JatsNode, sectionTitle: string | undefined): ParsedPmcTable {
  const id = attrOf(tableWrap, 'id');
  const label = textContent(findOne(tableWrap, 'label')) || undefined;
  const caption = textContent(findOne(tableWrap, 'caption')) || undefined;
  const footnotes = textContent(findOne(tableWrap, 'table-wrap-foot')) || undefined;

  // Some deposits offer both renderings inside <alternatives>; prefer the markup.
  const table = findOne(tableWrap, 'table') ?? findOne(findOne(tableWrap, 'alternatives'), 'table');
  const { rows, headerRowCount } = table
    ? extractTableRows(table)
    : { rows: [] as string[][], headerRowCount: 0 };

  return {
    ...(id && { id }),
    ...(label && { label }),
    ...(caption && { caption }),
    ...(sectionTitle && { sectionTitle }),
    headerRowCount,
    rows,
    ...(footnotes && { footnotes }),
    ...(rows.length === 0 && {
      unextractableReason: classifyUnextractable(tableWrap, table),
    }),
  };
}

function classifyUnextractable(
  tableWrap: JatsNode,
  table: JatsNode | undefined,
): ParsedPmcTableUnextractableReason {
  if (findOne(tableWrap, 'tgroup') || findOne(table, 'tgroup')) return 'cals-tgroup';
  if (findOne(tableWrap, 'graphic') || findOne(findOne(tableWrap, 'alternatives'), 'graphic')) {
    return 'graphic-only';
  }
  return 'no-rows';
}

/**
 * Widest grid a single table row may occupy, and the ceiling every declared
 * span is clamped to. Real deposits are far narrower — the widest row observed
 * across a live sample was 15 columns — so this bounds a malformed or hostile
 * span rather than limiting any genuine table: `colspan="99999999"` costs a
 * bounded row instead of an unbounded allocation, and a `rowspan` that large
 * carries a bounded number of rows down. How many rows a table has is set by its
 * source `<tr>` elements and needs no cap of its own. (#111)
 */
export const MAX_TABLE_COLUMNS = 512;

/** A `colspan`/`rowspan` value, clamped to a sane grid. Anything unparseable is 1. */
function spanOf(cell: JatsNode, name: 'colspan' | 'rowspan'): number {
  const declared = Number.parseInt(attrOf(cell, name) ?? '', 10);
  if (!Number.isFinite(declared) || declared < 1) return 1;
  return Math.min(declared, MAX_TABLE_COLUMNS);
}

/** A cell still owed to the rows below it by a `rowspan`. */
interface RowspanCarry {
  remaining: number;
  value: string;
}

/**
 * Read an XHTML `<table>` into rows of cell text, expanding `colspan` and
 * `rowspan` so every entry in a row is one grid column.
 *
 * A cell covering N columns occupies N entries and one covering M rows occupies
 * its column in the M rows below it, repeating its text across the cells it
 * genuinely covers. Repeating is the honest flattening: the value belongs to
 * each of those positions, and a reader scanning a column finds it there. The
 * alternative — keeping the source cell count — leaves the column a value
 * belongs to unrecoverable downstream, so a renderer padding rows from the left
 * puts values under the wrong headers. (#111)
 *
 * Header rows are those in `<thead>` plus any leading row made entirely of
 * `<th>` in a table that declares no `<thead>`.
 */
function extractTableRows(table: JatsNode): { headerRowCount: number; rows: string[][] } {
  const parsed: { cells: string[]; header: boolean }[] = [];
  /** Live `rowspan` obligations, indexed by grid column. */
  const carried: (RowspanCarry | undefined)[] = [];

  /** Consume the carried cells sitting at and after `col`, contiguously. */
  const drainCarried = (row: string[], col: number): number => {
    let at = col;
    while (at < MAX_TABLE_COLUMNS) {
      const carry = carried[at];
      if (!carry) return at;
      row[at] = carry.value;
      carry.remaining -= 1;
      if (carry.remaining <= 0) carried[at] = undefined;
      at += 1;
    }
    return at;
  };

  const pushRow = (tr: JatsNode, inHead: boolean) => {
    const row: string[] = [];
    let col = 0;
    let sourceCells = 0;
    let allHeaderCells = true;

    for (const cell of childrenOf(tr)) {
      const tag = tagNameOf(cell);
      if (tag !== 'td' && tag !== 'th') continue;
      if (tag === 'td') allHeaderCells = false;
      sourceCells += 1;

      col = drainCarried(row, col);
      const value = textContent(cell);
      const rowspan = spanOf(cell, 'rowspan');
      const width = Math.min(spanOf(cell, 'colspan'), MAX_TABLE_COLUMNS - col);
      for (let i = 0; i < width; i++) {
        row[col] = value;
        if (rowspan > 1) carried[col] = { remaining: rowspan - 1, value };
        col += 1;
      }
    }

    // Carried cells past the last source cell still hold their columns. Walk out
    // to the rightmost live obligation so they land where they belong; the gaps
    // in between are columns this row genuinely left empty.
    const rightmost = carried.reduce((last, carry, i) => (carry ? i : last), -1);
    while (col <= rightmost) col = carried[col] ? drainCarried(row, col) : col + 1;

    if (sourceCells === 0) return;
    for (let i = 0; i < row.length; i++) row[i] ??= '';
    parsed.push({ cells: row, header: inHead || allHeaderCells });
  };

  for (const child of childrenOf(table)) {
    const tag = tagNameOf(child);
    if (tag === 'tr') pushRow(child, false);
    else if (tag === 'thead' || tag === 'tbody' || tag === 'tfoot') {
      for (const tr of findAll(child, 'tr')) pushRow(tr, tag === 'thead');
    }
  }

  let headerRowCount = 0;
  while (parsed[headerRowCount]?.header) headerRowCount++;

  return { headerRowCount, rows: parsed.map((row) => row.cells) };
}

// ─── References ─────────────────────────────────────────────────────────────

/**
 * `pub-id-type` → human label, so the trailing identifiers in a rendered
 * `<element-citation>` read as `PMID 37657419` rather than a bare number run.
 */
const PUB_ID_LABELS: Readonly<Record<string, string>> = {
  pmid: 'PMID',
  doi: 'DOI',
  pmcid: 'PMCID',
};

/** Render one `<person-group>` child — a `<name>`, `<collab>`, or `<etal>`. */
function renderCitationName(node: JatsNode): string {
  const tag = tagNameOf(node);
  if (tag === 'name' || tag === 'string-name') {
    const surname = textContent(findOne(node, 'surname'));
    const given = textContent(findOne(node, 'given-names'));
    return [surname, given].filter(Boolean).join(' ') || textContent(node);
  }
  if (tag === 'collab') return textContent(node);
  if (tag === 'etal') return 'et al.';
  return '';
}

/**
 * Render a structured `<element-citation>` as a readable, delimited string.
 * Its child elements carry no punctuation between them, so a flat
 * `textContent()` runs every field together (`DomanJ.L.…Cell18618…`). Walk the
 * direct children in document order, joining author names with `, ` and
 * labeling typed `<pub-id>`s, so the output reads as a citation rather than a
 * token run. (#69)
 */
function renderElementCitation(node: JatsNode): string {
  const parts: string[] = [];
  for (const child of childrenOf(node)) {
    const tag = tagNameOf(child);
    if (tag === 'person-group') {
      const names = childrenOf(child).map(renderCitationName).filter(Boolean);
      if (names.length > 0) parts.push(names.join(', '));
    } else if (tag === 'pub-id') {
      const value = textContent(child);
      if (value) {
        const label = PUB_ID_LABELS[attrOf(child, 'pub-id-type') ?? ''];
        parts.push(label ? `${label} ${value}` : value);
      }
    } else {
      // Element field (source, volume, year, fpage, …) or a bare text node;
      // textContent renders both, and empty results drop out of the join.
      const text = textContent(child);
      if (text) parts.push(text);
    }
  }
  return parts.join(' ');
}

/**
 * Author-name wrappers a `<mixed-citation>` can carry as a direct child. Their
 * parts routinely sit adjacent with zero characters between them, so the
 * sibling-element spacing rule has to reach inside them rather than stopping at
 * the wrapper. Scoped to these three deliberately: recursing into arbitrary
 * elements would change how inline markup inside `<article-title>` and friends
 * renders. (#124)
 */
const NAME_WRAPPER_TAGS: ReadonlySet<string> = new Set(['name', 'string-name', 'person-group']);

/**
 * Serialize a `<name>` / `<string-name>` / `<person-group>` subtree, applying
 * the same rule `renderMixedCitation` applies to its own children: a single
 * space between two adjacent elements that carry nothing between them, and
 * source text emitted verbatim. `<person-group>` separates its names with real
 * `, ` text nodes and `<string-name>` usually separates surname from given
 * names with a newline, so a fixed separator would double punctuation the
 * source already has — spacing only the zero-gap transitions leaves those
 * records byte-identical. Returns raw text; the caller collapses whitespace
 * once over the finished citation.
 */
function renderNameWrapper(node: JatsNode): string {
  let rendered = '';
  let prevWasElement = false;

  for (const child of childrenOf(node)) {
    if (isTextNode(child)) {
      const raw = textOf(child);
      if (raw) {
        rendered += raw;
        prevWasElement = false;
      }
      continue;
    }

    const tag = tagNameOf(child) ?? '';
    const part = NAME_WRAPPER_TAGS.has(tag) ? renderNameWrapper(child) : rawTextContent(child);
    if (!part) continue;

    if (prevWasElement) rendered += ' ';
    rendered += part;
    prevWasElement = true;
  }

  return rendered;
}

/**
 * True when the citation text emitted so far already ends with a literal prefix
 * naming this `pub-id-type` (`doi:`, `PMID `, `pmcid.`), so prepending the label
 * would read `doi:DOI 10.1111/…`. (#115)
 */
function hasLiteralIdPrefix(rendered: string, pubIdType: string): boolean {
  const tail = rendered.trimEnd().replace(/[:.]$/, '').trimEnd();
  return tail.toLowerCase().endsWith(pubIdType.toLowerCase());
}

/**
 * Render a `<mixed-citation>` as a readable string.
 *
 * Mixed citations carry their punctuation in the text nodes between elements,
 * so a flat `textContent()` reads correctly almost everywhere. Three adjacencies
 * defeat it, all with zero characters between the elements: consecutive typed
 * `<pub-id>`s fuse into one unreadable token (#115), an inline title runs
 * straight into the volume that follows it (#123), and a `<surname>` glues onto
 * the `<given-names>` beside it inside an author-name wrapper (#124). Walk the
 * direct children so those cases can be repaired without touching `textContent`,
 * which abstracts, titles, and body paragraphs share and where zero-gap
 * adjacency is often intentional.
 *
 * Typed `<pub-id>`s are labeled (unless literal prefix text already names the
 * type), and a single space separates two adjacent elements that carry nothing
 * between them. A label is text this renderer inserts rather than source
 * content, so it is separated from whatever precedes it as well — publisher
 * styles routinely close the prose on punctuation (`… (2020).`, `…021]`) and a
 * label butted against that reads as one token. Source transitions that already
 * carry punctuation or whitespace are emitted unchanged; the trailing whitespace
 * collapse keeps a whitespace-only gap at one space.
 */
function renderMixedCitation(node: JatsNode): string {
  let rendered = '';
  let prevWasElement = false;

  for (const child of childrenOf(node)) {
    if (isTextNode(child)) {
      const raw = textOf(child);
      if (raw) {
        rendered += raw;
        prevWasElement = false;
      }
      continue;
    }

    const tag = tagNameOf(child) ?? '';
    let part: string;
    let labeled = false;
    if (tag === 'pub-id') {
      const value = textContent(child);
      if (!value) continue;
      const type = attrOf(child, 'pub-id-type') ?? '';
      const label = PUB_ID_LABELS[type];
      if (label && !hasLiteralIdPrefix(rendered, type)) {
        labeled = true;
        part = `${label} ${value}`;
      } else {
        part = value;
      }
    } else if (NAME_WRAPPER_TAGS.has(tag)) {
      part = renderNameWrapper(child);
    } else {
      part = rawTextContent(child);
    }

    if (prevWasElement || labeled) rendered += ' ';
    rendered += part;
    prevWasElement = true;
  }

  return rendered.replace(/\s+/g, ' ').trim();
}

/**
 * Extract references from anywhere under `root` — pass the `<article>` node to
 * cover a whole document, or a `<back>` node to scope the search to it.
 *
 * `<ref-list>` placement is not uniform: roughly 60% of Europe PMC deposits nest
 * it under `body/sec/sec` and the rest put it directly under `<back>`, so a
 * search scoped to a direct `<back>` child misses the majority. Every
 * `<ref-list>` descendant is collected in document order instead, and a `<ref>`
 * id already seen is skipped so a document exposing the same list under both
 * containers still yields each reference once. (#116)
 *
 * Prefers `<mixed-citation>` over `<element-citation>`, descending into
 * `<citation-alternatives>` when a ref carries both forms there rather than as
 * direct children of `<ref>`. Both forms are rendered child-by-child so adjacent
 * elements stay separable (see `renderMixedCitation` and
 * `renderElementCitation`).
 */
export function extractReferences(root: JatsNode | undefined): ParsedPmcReference[] {
  if (!root) return [];

  const results: ParsedPmcReference[] = [];
  const seenIds = new Set<string>();

  for (const refList of findAllDescendants(root, 'ref-list')) {
    for (const ref of findAll(refList, 'ref')) {
      const id = attrOf(ref, 'id');
      if (id && seenIds.has(id)) continue;

      // JATS wraps the two citation forms in <citation-alternatives> (the NLM
      // construct carrying both a structured <element-citation> and a readable
      // <mixed-citation>). findOne matches direct children only, so resolve that
      // container first; refs with a direct citation node fall through to `ref`.
      const container = findOne(ref, 'citation-alternatives') ?? ref;
      const mixedCitation = findOne(container, 'mixed-citation');
      const elementCitation = findOne(container, 'element-citation');

      let citation = '';
      if (mixedCitation) {
        citation = renderMixedCitation(mixedCitation);
      } else if (elementCitation) {
        citation = renderElementCitation(elementCitation);
      }
      if (!citation) continue;

      if (id) seenIds.add(id);
      const label = textContent(findOne(ref, 'label')) || undefined;
      results.push({
        ...(id && { id }),
        ...(label && { label }),
        citation,
      });
    }
  }

  return results;
}

// ─── Main Parser ────────────────────────────────────────────────────────────

/**
 * Parse a single JATS `<article>` node (from PMC EFetch via the ordered parser)
 * into a structured `ParsedPmcArticle`. The input node is the element wrapper
 * itself — `{ article: [...], ':@': { '@_article-type': ... } }` — not the
 * outer `<pmc-articleset>`.
 */
export function parsePmcArticle(articleNode: JatsNode): ParsedPmcArticle {
  const front = findOne(articleNode, 'front');
  const articleMeta = findOne(front, 'article-meta');
  const journalMeta = findOne(front, 'journal-meta');
  const body = findOne(articleNode, 'body');

  const pmcId =
    extractArticleId(articleMeta, 'pmcid') ?? extractArticleId(articleMeta, 'pmc-uid') ?? '';
  const pmid = extractArticleId(articleMeta, 'pmid');
  const doi = extractArticleId(articleMeta, 'doi');

  const titleGroup = findOne(articleMeta, 'title-group');
  const title = textContent(findOne(titleGroup, 'article-title')) || undefined;

  const authors = collectAuthors(articleMeta);
  const affiliations = extractAffiliations(articleMeta);
  const journal = extractJournal(journalMeta, articleMeta);
  const publicationDate = extractPubDate(articleMeta);
  const abstract = extractAbstract(articleMeta);
  const keywords = extractKeywords(articleMeta);
  const sections = extractBodySections(body);
  const references = extractReferences(articleNode);
  const tables = extractPmcTables(articleNode);

  const normalizedPmcId = !pmcId ? '' : pmcId.startsWith('PMC') ? pmcId : `PMC${pmcId}`;
  const articleType = attrOf(articleNode, 'article-type');

  return {
    pmcId: normalizedPmcId,
    ...(pmid && { pmid }),
    ...(doi && { doi }),
    ...(title && { title }),
    ...(authors.length > 0 && { authors }),
    ...(affiliations.length > 0 && { affiliations }),
    ...(journal && { journal }),
    ...(publicationDate && { publicationDate }),
    ...(abstract && { abstract }),
    ...(keywords.length > 0 && { keywords }),
    sections,
    ...(references.length > 0 && { references }),
    ...(tables.length > 0 && { tables }),
    ...(articleType && { articleType }),
    pmcUrl: `https://www.ncbi.nlm.nih.gov/pmc/articles/${normalizedPmcId}/`,
    ...(pmid && { pubmedUrl: `https://pubmed.ncbi.nlm.nih.gov/${pmid}/` }),
  };
}

/** Collect authors across every `<contrib-group>` under `<article-meta>`. */
function collectAuthors(articleMeta: JatsNode | undefined): ParsedPmcAuthor[] {
  if (!articleMeta) return [];
  const result: ParsedPmcAuthor[] = [];
  for (const group of findAll(articleMeta, 'contrib-group')) {
    result.push(...extractJatsAuthors(group));
  }
  return result;
}
