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
  ParsedPmcAsset,
  ParsedPmcAssetType,
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
  type JatsNodeList,
  rawTextContent,
  selectAlternative,
  tagNameOf,
  textContent,
  textContentExcluding,
  textOf,
} from './pmc-xml-helpers.js';

/**
 * Block content extracted into a field of its own and therefore left out of the
 * prose a section contributes. Each one nested inside a `<p>` would otherwise be
 * flattened into the surrounding sentence — a `<table-wrap>` concatenating
 * adjacent cell values into numbers that never existed, a `<fig>` gluing its
 * label and caption onto the sentence terminator before it. (#111, #130)
 */
const LIFTED_BLOCK_TAGS: ReadonlySet<string> = new Set([
  'table-wrap',
  'fig',
  'supplementary-material',
]);

/**
 * JATS block-level elements, which interrupt prose rather than reading inside
 * it. Membership decides *placement*, not representation: every one of these
 * flushes the prose run in progress and contributes at block position, whether
 * it renders (a `<list>`), lifts to its own field leaving a marker (a `<fig>`),
 * or contributes nothing (a `<table-wrap>`, already in `tables[]`). Anything not
 * named here is inline markup — `<italic>`, `<xref>`, `<sup>`,
 * `<inline-formula>` — and reads inside the sentence as it should.
 *
 * The set is the JATS block-display class rather than the tags observed in any
 * one draw: an element the walk does not enumerate degrades to flattened text at
 * block position, and getting it there is what stops the fusion. (#130)
 *
 * Membership governs only an element nested inside another. Every caller that
 * walks a container renders its children one at a time, so a direct `<sec>` or
 * `<body>` child already contributes at block position whether or not it is
 * named here; the live question per tag is what a paragraph-internal occurrence
 * should do. `address`, `related-article` and `related-object` are in the JATS
 * model both as display blocks and inline within a `<p>`, and they stay: a
 * wrong split costs a paragraph break with every character still present and in
 * order, while a wrong fusion fabricates adjacency the source never had, which
 * is the defect this walk exists to prevent — when a tag reads both ways,
 * splitting is the recoverable error.
 *
 * `<alternatives>` is the one element deliberately absent. It is a container
 * for equivalent renderings of a single object and never a block in its own
 * right, so its placement is whatever holds it: naming it here broke the
 * standard `<inline-formula><alternatives><tex-math/><mml:math/></alternatives>`
 * deposit out of the sentence it belonged to and split that sentence in two.
 * `<disp-formula>` and `<table-wrap>` resolve their own `<alternatives>`
 * children, and a `<fig>` is a block in its own right, so nothing depends on it
 * flushing the run. What it contributes is one of those renderings rather than
 * all of them — see `selectAlternative`. (#130, #135)
 */
const BLOCK_TAGS: ReadonlySet<string> = new Set([
  ...LIFTED_BLOCK_TAGS,
  'address',
  'array',
  'boxed-text',
  'chem-struct-wrap',
  'code',
  'def-list',
  'disp-formula',
  'disp-formula-group',
  'disp-quote',
  'fig-group',
  'graphic',
  'list',
  'media',
  'preformat',
  'ref-list',
  'related-article',
  'related-object',
  'speech',
  'statement',
  'table-wrap-group',
  'verse-group',
]);

/** True when a lifted block sits anywhere in this subtree. */
function containsLiftedBlock(node: JatsNode): boolean {
  return childrenOf(node).some(
    (child) => LIFTED_BLOCK_TAGS.has(tagNameOf(child) ?? '') || containsLiftedBlock(child),
  );
}

/**
 * True when a `<sec>` carried block content that was extracted into its own
 * field — a `<table-wrap>` or `<fig>` sitting beside its paragraphs, or nested
 * inside one.
 *
 * This is what separates a section emptied by the lift from one that never had
 * readable prose. The first is a real heading a reader needs in order to place
 * the table or figure that names it; the second is a structural wrapper — a
 * `<sec>` around a `<ref-list>`, say — which would arrive as a stray empty
 * "References" entry if every empty section survived. Only this section's own
 * children are considered: a `<table-wrap>` deeper down belongs to the nested
 * `<sec>` that holds it, and that section survives on its own account.
 * (#111, #116, #130)
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
  // Article number for the roughly half of PMC deposits that carry
  // <elocation-id> and no <fpage>. Distinct from pages, never a stand-in for it.
  const elocationId = articleMeta
    ? textContent(findOne(articleMeta, 'elocation-id')) || undefined
    : undefined;

  if (!title && !issn && !volume && !issue && !pages && !elocationId) return;

  return {
    ...(title && { title }),
    ...(issn && { issn }),
    ...(volume && { volume }),
    ...(issue && { issue }),
    ...(pages && { pages }),
    ...(elocationId && { elocationId }),
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

/**
 * Read the article's own abstract.
 *
 * JATS permits several `<abstract>` elements under `<article-meta>`,
 * distinguished by `@abstract-type`, and publishers routinely deposit a
 * graphical abstract, author highlights or an executive summary alongside the
 * real one — 21 of 68 records in a validation draw carry more than one, and in
 * 4 of those the first is not the untyped element. The untyped one is the
 * article's own abstract, so it is preferred and a typed one used only when the
 * record deposits nothing else, mirroring the ladder {@link extractPubDate}
 * applies to `<pub-date>`. (#134)
 *
 * Content is read through the same flow walk the body uses, so a `<fig>` in an
 * abstract leaves its marker and its caption reaches `assets[]` alone —
 * {@link extractPmcAssets} already walks `<front>` — instead of concatenating
 * into the prose, and a `<list>` renders as list lines rather than a token run.
 */
function extractAbstract(articleMeta: JatsNode | undefined): string | undefined {
  if (!articleMeta) return;

  const abstracts = findAll(articleMeta, 'abstract');
  const abstractNode = abstracts.find((node) => !attrOf(node, 'abstract-type')) ?? abstracts[0];
  if (!abstractNode) return;

  const sections = findAll(abstractNode, 'sec');
  if (sections.length > 0) {
    const parts: string[] = [];
    for (const sec of sections) {
      const title = textContent(findOne(sec, 'title'));
      const text = abstractProse(sec);
      if (title && text) parts.push(`${title}: ${text}`);
      else if (text) parts.push(text);
    }
    return parts.join('\n\n').trim() || undefined;
  }

  return abstractProse(abstractNode) || undefined;
}

/**
 * The prose of an `<abstract>` or one of its `<sec>`s: every child but the
 * heading the caller reports separately, space-joined. The single space is the
 * spacing the paragraph-only read this replaces already produced, so a record
 * depositing one untyped abstract of plain `<p>`s comes back byte-identical.
 */
function abstractProse(node: JatsNode): string {
  const prose = childrenOf(node).filter((child) => {
    const tag = tagNameOf(child);
    return tag !== 'title' && tag !== 'label';
  });
  return flowBlocks(prose, STATEMENT_BLOCK_TAGS).join(' ');
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

// ─── Block Rendering ────────────────────────────────────────────────────────

/** Indent one nesting level of a `<list>`/`<def-list>` nested in a `<list-item>`. */
const NESTED_LIST_INDENT = '  ';

/** A prose run under construction plus the finished blocks emitted before it. */
interface Flow {
  out: string[];
  run: string;
}

/** Close the prose run in progress, discarding it when it holds only whitespace. */
function flushRun(flow: Flow): void {
  const text = flow.run.replace(/\s+/g, ' ').trim();
  if (text) flow.out.push(text);
  flow.run = '';
}

/**
 * Walk a mixed-content child list, accumulating inline text into a prose run and
 * emitting every block-level element at its own document position instead.
 *
 * The recursion through non-block elements is what makes the split reliable: a
 * `<fig>` nested two elements deep inside a `<p>` still flushes the sentence
 * before it rather than being flattened into the middle of one. Inline markup —
 * `<italic>`, `<xref>`, `<sup>` — is transparent here and reads in place, which
 * is the behavior {@link textContent} already gave paragraphs. (#130)
 *
 * `blockTags` names what interrupts the run: {@link BLOCK_TAGS} for article
 * prose, {@link STATEMENT_BLOCK_TAGS} for a container whose `<title>` and `<p>`
 * children are separate statements rather than one continuous sentence.
 *
 * `<tex-math>` and `<alternatives>` are the two elements whose text is not the
 * concatenation of their subtree, so this walk defers to the shared rule rather
 * than reading their children one at a time: a `<tex-math>` contributes its
 * LaTeX document body via `rawTextContent`, and an `<alternatives>` re-enters
 * this walk with its single chosen child, which keeps a `<disp-formula>` found
 * there at block position. (#135)
 */
function walkFlow(nodes: JatsNodeList, flow: Flow, blockTags: ReadonlySet<string>): void {
  for (const node of nodes) {
    if (isTextNode(node)) {
      flow.run += textOf(node);
      continue;
    }
    const tag = tagNameOf(node) ?? '';
    if (tag === 'alternatives') {
      const chosen = selectAlternative(node);
      if (chosen) walkFlow([chosen], flow, blockTags);
      continue;
    }
    if (tag === 'tex-math') {
      flow.run += rawTextContent(node);
      continue;
    }
    if (blockTags.has(tag)) {
      flushRun(flow);
      const rendered = renderBlock(node);
      if (rendered) flow.out.push(rendered);
      continue;
    }
    walkFlow(childrenOf(node), flow, blockTags);
  }
}

/** Ordered text blocks contributed by one `<p>` — or any other flow container. */
function flowBlocks(nodes: JatsNodeList, blockTags: ReadonlySet<string> = BLOCK_TAGS): string[] {
  const flow: Flow = { out: [], run: '' };
  walkFlow(nodes, flow, blockTags);
  flushRun(flow);
  return flow.out;
}

/**
 * Block tags for a container whose `<title>` and `<p>` children each carry a
 * statement of their own — a `<caption>`, an `<abstract>`, an abstract `<sec>`.
 * Their children carry no punctuation between them, so the concatenating read
 * ran a caption's title straight into its first sentence
 * (`…observational constraints6.Cloud susceptibilities…`, 60 of 342 captions in
 * a 68-record draw) and would run two sibling paragraphs together. Only a
 * `<title>` or `<p>` boundary separates: inline markup between two text runs
 * stays transparent, so `Expression of <italic>NF1</italic> across 12 tissues.`
 * still reads as one sentence. (#111, #130, #134)
 */
const STATEMENT_BLOCK_TAGS: ReadonlySet<string> = new Set([...BLOCK_TAGS, 'title', 'p']);

/** A `<caption>`'s title and paragraphs, each rendered as section prose is, space-joined. */
function renderCaption(caption: JatsNode | undefined): string | undefined {
  if (!caption) return;
  return flowBlocks(childrenOf(caption), STATEMENT_BLOCK_TAGS).join(' ') || undefined;
}

/**
 * Render one block element as the text it contributes to the enclosing section.
 *
 * The default arm is the point of the dispatch: an element this parser does not
 * enumerate degrades to its flattened text at block position rather than to
 * silence, and never lands inside a neighbouring sentence. `<table-wrap>`,
 * `<fig>` and `<supplementary-material>` are carried by `tables[]` / `assets[]`,
 * so the first contributes nothing and the other two leave a marker where they
 * sat; `<ref-list>` is carried by `references[]` and likewise contributes
 * nothing, which is what keeps a `<sec>` that only wraps one from surviving as
 * an empty "References" heading. (#116, #130)
 */
function renderBlock(node: JatsNode): string {
  switch (tagNameOf(node)) {
    case 'table-wrap':
    case 'ref-list':
      return '';
    case 'fig':
      return assetMarker(node, 'Figure');
    case 'supplementary-material':
      return assetMarker(node, 'Supplementary');
    case 'list':
      return renderList(node, 0);
    case 'def-list':
      return renderDefList(node, 0);
    case 'disp-quote':
      return renderDispQuote(node);
    case 'boxed-text':
      return renderBoxedText(node);
    case 'preformat':
      return renderPreformat(node);
    case 'disp-formula':
      return renderDispFormula(node);
    default:
      return flowBlocks(childrenOf(node)).join('\n\n');
  }
}

/**
 * The `<graphic>`/`<media>` pointer an asset hangs its file on, and the element
 * a deposit may hang the label and caption on instead of on the asset itself.
 */
function assetPointer(node: JatsNode): JatsNode | undefined {
  return findOne(node, 'graphic') ?? findOne(node, 'media');
}

/**
 * An asset's display label: its own `<label>`, else one the deposit hung on the
 * pointer. Shared by {@link assetMarker} and {@link parseAsset} so the marker
 * left in the section text and the `label` reported in `assets[]` cannot
 * disagree — the tool layer removes the marker by rebuilding it from that label,
 * so a label resolved one way here and another way there strands the marker in
 * the prose under `includeAssets: false`. (#130)
 */
function assetLabel(node: JatsNode): string | undefined {
  return (
    textContent(findOne(node, 'label')) ||
    textContent(findOne(assetPointer(node), 'label')) ||
    undefined
  );
}

/**
 * The marker a lifted asset leaves at the position it occupied. Prose refers to
 * figures and supplements by label far more often than to tables, so removing
 * the anchor while leaving every `<xref>` pointing at it would cost more than
 * the ~18 characters the marker spends. (#130)
 */
function assetMarker(node: JatsNode, kind: 'Figure' | 'Supplementary'): string {
  const label = assetLabel(node);
  return label ? `[${kind}: ${label}]` : `[${kind}]`;
}

/**
 * Render a `<list>`: `@list-type` picks the item marker (`order` numbers,
 * `simple` leaves the item bare, everything else bullets), the optional
 * `<title>` takes a line of its own above the items, and a `<list>` or
 * `<def-list>` nested inside a `<list-item>` — both in the JATS content model —
 * indents one level per depth. (#130)
 */
function renderList(list: JatsNode, depth: number): string {
  const pad = NESTED_LIST_INDENT.repeat(depth);
  const listType = attrOf(list, 'list-type');
  const lines: string[] = [];

  const title = textContent(findOne(list, 'title'));
  if (title) lines.push(`${pad}${title}`);

  let ordinal = 0;
  for (const item of findAll(list, 'list-item')) {
    ordinal += 1;
    const marker = listType === 'simple' ? '' : listType === 'order' ? `${ordinal}. ` : '- ';
    const parts: string[] = [];
    const nested: string[] = [];
    for (const child of childrenOf(item)) {
      const tag = tagNameOf(child);
      if (tag === 'label') continue;
      if (tag === 'list') nested.push(renderList(child, depth + 1));
      else if (tag === 'def-list') nested.push(renderDefList(child, depth + 1));
      else parts.push(...flowBlocks([child]));
    }
    const text = parts.join(' ');
    if (text) lines.push(`${pad}${marker}${text}`);
    for (const block of nested) if (block) lines.push(block);
  }

  return lines.join('\n');
}

/** Render a `<def-list>`: its title on a line of its own, then `- term — definition` per item. */
function renderDefList(defList: JatsNode, depth: number): string {
  const pad = NESTED_LIST_INDENT.repeat(depth);
  const lines: string[] = [];

  const title = textContent(findOne(defList, 'title'));
  if (title) lines.push(`${pad}${title}`);

  for (const item of findAll(defList, 'def-item')) {
    const term = textContent(findOne(item, 'term'));
    const definition = textContent(findOne(item, 'def'));
    const entry = [term, definition].filter(Boolean).join(' — ');
    if (entry) lines.push(`${pad}- ${entry}`);
  }

  return lines.join('\n');
}

/** Render a `<disp-quote>`: every line quoted, its `<attrib>` as a trailing attribution line. */
function renderDispQuote(quote: JatsNode): string {
  const lines: string[] = [];
  for (const child of childrenOf(quote)) {
    if (tagNameOf(child) === 'attrib') continue;
    for (const block of flowBlocks([child])) {
      for (const line of block.split('\n')) lines.push(`> ${line}`);
    }
  }
  const attrib = textContent(findOne(quote, 'attrib'));
  if (attrib) lines.push(`> — ${attrib}`);
  return lines.join('\n');
}

/**
 * Render a `<boxed-text>` by flattening it. Almost every one is a section
 * container rather than a captioned box — 13 of the 14 in a 68-record draw carry
 * `<sec>` children and nothing else — so rendering it as a caption plus
 * paragraphs would drop the nested headings entirely. (#130)
 */
function renderBoxedText(boxedText: JatsNode): string {
  const blocks: string[] = [];
  for (const child of childrenOf(boxedText)) {
    if (tagNameOf(child) === 'sec') blocks.push(...flattenSec(child));
    else blocks.push(...flowBlocks([child]));
  }
  return blocks.join('\n\n');
}

/**
 * A `<sec>` subtree as flat text blocks: each heading on its own line above its
 * prose, descendants following in document order. Used where a section has no
 * node of its own to live in — inside a `<boxed-text>` — mirroring how the tool
 * layer flattens sections past the depth its schema carries.
 */
function flattenSec(sec: JatsNode): string[] {
  const title = textContent(findOne(sec, 'title'));
  const label = textContent(findOne(sec, 'label'));
  const heading = title ? (label ? `${label} ${title}` : title) : '';

  const blocks: string[] = [];
  const nested: string[] = [];
  for (const child of childrenOf(sec)) {
    const tag = tagNameOf(child);
    if (tag === 'title' || tag === 'label') continue;
    if (tag === 'sec') nested.push(...flattenSec(child));
    else blocks.push(...flowBlocks([child]));
  }

  const head = [heading, blocks.join('\n\n')].filter(Boolean).join('\n');
  return [...(head ? [head] : []), ...nested];
}

/**
 * Render a `<preformat>` as a fenced block, read raw. It carries
 * `xml:space="preserve"` and, in legacy deposits, the whole article as OCR text
 * whose meaning lives in its line breaks and column spacing — {@link textContent}
 * collapses both. Only the surrounding whitespace is trimmed, which is the XML
 * indentation the element was serialized with rather than content. (#130)
 */
function renderPreformat(preformat: JatsNode): string {
  const raw = rawTextContent(preformat).trim();
  return raw ? `\`\`\`\n${raw}\n\`\`\`` : '';
}

/** Children of a `<disp-formula>` that are not its fallback text. */
const DISP_FORMULA_NON_BODY: ReadonlySet<string> = new Set(['label', 'graphic', 'media']);

/**
 * Render a `<disp-formula>`: its label, then a `<tex-math>` where the deposit
 * carries one (directly or under `<alternatives>`) and the flattened content
 * otherwise — usually `<mml:math>`, which is 69 of the 78 formulae in a
 * 68-record draw against 3 for `<tex-math>`. A graphic-only deposit has no
 * fallback text and contributes nothing at all rather than a bare label on an
 * otherwise empty line. (#130)
 *
 * A `<tex-math>` contributes only the expression between `\begin{document}` and
 * `\end{document}`; `textContent` applies that rule, so the LaTeX preamble
 * publishers wrap around every formula never reaches the rendered line. (#135)
 */
function renderDispFormula(formula: JatsNode): string {
  const texMath =
    findOne(formula, 'tex-math') ?? findOne(findOne(formula, 'alternatives'), 'tex-math');
  const body = textContent(texMath) || textContentExcluding(formula, DISP_FORMULA_NON_BODY);
  if (!body) return '';
  const label = textContent(findOne(formula, 'label'));
  return [label, body].filter(Boolean).join(' ');
}

// ─── Body Sections ──────────────────────────────────────────────────────────

/**
 * Extract body sections from a `<body>` node, walking children in document order.
 * Consecutive bare `<p>` siblings — and any block element sitting directly under
 * `<body>` — are collected into an untitled section so articles with mixed
 * structure (direct paragraphs + trailing `<sec>`, common in
 * manuscript-submitted PMC deposits) preserve their main text.
 *
 * A `<body>` whose whole content is one block and no `<sec>` therefore yields a
 * section carrying that block's text, rather than the empty list the tool layer
 * reads as an article with no body at all. Legacy
 * `<preformat preformat-type="pmc-ocr-text">` deposits, which put the entire
 * article in one such element, are the case that matters. (#130)
 */
export function extractBodySections(body: JatsNode | undefined): ParsedPmcSection[] {
  if (!body) return [];

  const sections: ParsedPmcSection[] = [];
  let pendingBlocks: string[] = [];

  const flushPending = () => {
    if (pendingBlocks.length > 0) {
      sections.push({ text: pendingBlocks.join('\n\n') });
      pendingBlocks = [];
    }
  };

  for (const child of childrenOf(body)) {
    if (tagNameOf(child) === 'sec') {
      flushPending();
      const section = extractSection(child);
      if (section) sections.push(section);
      continue;
    }
    pendingBlocks.push(...flowBlocks([child]));
  }
  flushPending();

  return sections;
}

/**
 * Read one `<sec>`, walking every child in document order. The first `<title>`
 * and `<label>` are the section's own metadata, a `<sec>` is a subsection, and
 * everything else — `<p>` and block elements alike — contributes text at the
 * position it occupies. Reading `<p>` and `<sec>` alone is what dropped a
 * section's lists, figures, formulae and boxed text outright. (#130)
 */
function extractSection(sec: JatsNode): ParsedPmcSection | null {
  let title: string | undefined;
  let label: string | undefined;
  const textParts: string[] = [];
  const subsections: ParsedPmcSection[] = [];

  for (const child of childrenOf(sec)) {
    const tag = tagNameOf(child);
    if (tag === 'title') {
      title ??= textContent(child) || undefined;
      continue;
    }
    if (tag === 'label') {
      label ??= textContent(child) || undefined;
      continue;
    }
    if (tag === 'sec') {
      const subsection = extractSection(child);
      if (subsection) subsections.push(subsection);
      continue;
    }
    textParts.push(...flowBlocks([child]));
  }

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
  collectSectioned(root, undefined, tables, (child, tag, sectionTitle) =>
    tag === 'table-wrap' ? parseTableWrap(child, sectionTitle) : undefined,
  );
  return tables;
}

/**
 * Walk a subtree in document order, collecting whatever `take` recognizes and
 * carrying the innermost enclosing `<sec>` title down to it. An untitled `<sec>`
 * keeps its parent's title rather than dropping the reader's only positional
 * cue, and an element inside no `<sec>` at all gets none. A recognized element
 * is not descended into — it parses its own subtree.
 *
 * Shared by the table and asset walks so the section-title rule has one
 * definition and cannot drift between them.
 */
function collectSectioned<T>(
  node: JatsNode,
  sectionTitle: string | undefined,
  out: T[],
  take: (child: JatsNode, tag: string, sectionTitle: string | undefined) => T | undefined,
): void {
  for (const child of childrenOf(node)) {
    const tag = tagNameOf(child);
    if (!tag) continue;
    const collected = take(child, tag, sectionTitle);
    if (collected) {
      out.push(collected);
      continue;
    }
    const nested =
      tag === 'sec' ? textContent(findOne(child, 'title')) || sectionTitle : sectionTitle;
    collectSectioned(child, nested, out, take);
  }
}

function parseTableWrap(tableWrap: JatsNode, sectionTitle: string | undefined): ParsedPmcTable {
  const id = attrOf(tableWrap, 'id');
  const label = textContent(findOne(tableWrap, 'label')) || undefined;
  const caption = renderCaption(findOne(tableWrap, 'caption'));
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

// ─── Assets ─────────────────────────────────────────────────────────────────

/**
 * Extract every `<fig>` and `<supplementary-material>` under `root` in document
 * order — pass the `<article>` node.
 *
 * Whole-article, for the reason the table walk is: 17% of figures and 23% of
 * supplementary material sit outside `<body>` entirely — `<floats-group>`
 * deposits, `<back>/<sec>` and `<app-group>/<app>` placements, and figures
 * hanging off the abstract in `<front>`. Each asset names the innermost
 * enclosing `<sec>` wherever that sits, an untitled one inheriting its parent's
 * title, so the reader keeps a positional cue; an asset inside no `<sec>` at all
 * carries no section name. (#130)
 */
export function extractPmcAssets(root: JatsNode | undefined): ParsedPmcAsset[] {
  if (!root) return [];
  const assets: ParsedPmcAsset[] = [];
  collectSectioned(root, undefined, assets, (child, tag, sectionTitle) => {
    const assetType = ASSET_TAG_TYPES[tag];
    return assetType ? parseAsset(child, assetType, sectionTitle) : undefined;
  });
  return assets;
}

/** Tags lifted into `assets[]`, mapped to the type they are reported as. */
const ASSET_TAG_TYPES: Readonly<Record<string, ParsedPmcAssetType>> = {
  fig: 'figure',
  'supplementary-material': 'supplementary-material',
};

function parseAsset(
  node: JatsNode,
  assetType: ParsedPmcAssetType,
  sectionTitle: string | undefined,
): ParsedPmcAsset {
  const id = attrOf(node, 'id');
  // Both `fig` and `supplementary-material` carry the pointer on a child
  // element: a `<graphic>` for images, a `<media>` for everything else.
  const pointer = assetPointer(node);
  const href = pointer ? attrOf(pointer, 'xlink:href') : undefined;
  // `label?, caption?` are in the JATS content model of `<media>` and
  // `<graphic>` as well as of the asset element, and a common deposit style
  // hangs them there instead — 19 of 84 supplementary items in a 68-record draw
  // carry their caption on the `<media>` and nothing on the element itself.
  // Reading direct children alone returns a pointer with no text at all. The
  // asset's own label and caption win where it deposits them. (#130)
  const label = assetLabel(node);
  const caption =
    renderCaption(findOne(node, 'caption')) ?? renderCaption(findOne(pointer, 'caption'));

  return {
    assetType,
    ...(id && { id }),
    ...(label && { label }),
    ...(caption && { caption }),
    ...(sectionTitle && { sectionTitle }),
    ...(href && { href }),
  };
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
  const assets = extractPmcAssets(articleNode);

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
    ...(assets.length > 0 && { assets }),
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
