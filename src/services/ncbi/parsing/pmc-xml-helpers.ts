/**
 * @fileoverview Helpers for fast-xml-parser output in `preserveOrder: true` mode.
 * Each element node is `{ tagName: JatsNode[] }` with an optional `:@` carrying
 * attributes; text nodes are `{ "#text": value }`. Preserving order is critical
 * for JATS mixed content (e.g. `<p>text <italic>inline</italic> more text</p>`)
 * — the default object shape collapses all text into a single string keyed by
 * `#text`, dropping inline children's position. PMC full-text articles rely on
 * this order for readable abstracts and body sections.
 * @module src/services/ncbi/parsing/pmc-xml-helpers
 */

/**
 * A node in the ordered XML tree.
 * - Element: `{ tagName: JatsNode[] }`, optionally with `:@` carrying attributes
 * - Text:    `{ "#text": string | number | boolean }`
 */
export type JatsNode = Record<string, unknown>;

/**
 * Ordered sibling list — every children array and the document root.
 * Plain `JatsNode[]` (not readonly) so `Array.isArray` narrows inputs cleanly
 * in `findOne` / `findAll`; callers should not mutate the list.
 */
export type JatsNodeList = JatsNode[];

const ATTR_KEY = ':@';
const TEXT_KEY = '#text';

/** Tag name of an element (the single non-attribute key); undefined for text nodes. */
export function tagNameOf(node: JatsNode): string | undefined {
  for (const key in node) {
    if (key !== ATTR_KEY && key !== TEXT_KEY) return key;
  }
  return;
}

/** Ordered children of an element node. Empty for text nodes or missing tags. */
export function childrenOf(node: JatsNode): JatsNodeList {
  const tag = tagNameOf(node);
  if (!tag) return [];
  const value = node[tag];
  return Array.isArray(value) ? (value as JatsNodeList) : [];
}

/** Attribute value (caller omits the `@_` prefix). */
export function attrOf(node: JatsNode, name: string): string | undefined {
  const attrs = node[ATTR_KEY] as Record<string, unknown> | undefined;
  const val = attrs?.[`@_${name}`];
  return val == null ? undefined : String(val);
}

/** True for `{ "#text": ... }` nodes. */
export function isTextNode(node: JatsNode): boolean {
  return TEXT_KEY in node;
}

/** Stringified text value of a text node. */
export function textOf(node: JatsNode): string {
  const v = node[TEXT_KEY];
  return v == null ? '' : String(v);
}

/** JATS element carrying a LaTeX rendering of a formula. */
const TEX_MATH_TAG = 'tex-math';

/** JATS container holding equivalent renderings of one object. */
const ALTERNATIVES_TAG = 'alternatives';

/**
 * JATS pointers to an external rendering: a file reference, not a rendering of
 * the object itself.
 */
const POINTER_TAGS: ReadonlySet<string> = new Set([
  'graphic',
  'inline-graphic',
  'media',
  'inline-media',
]);

/**
 * The `\begin{document}` … `\end{document}` body of a LaTeX document. The
 * closing marker is optional so a deposit that opens the document and never
 * closes it still yields its expression rather than falling back to the whole
 * document, preamble included.
 */
const TEX_DOCUMENT_BODY = /\\begin\{document\}([\s\S]*?)(?:\\end\{document\}|$)/;

/**
 * The expression a `<tex-math>` contributes: the body between
 * `\begin{document}` and `\end{document}`.
 *
 * Publishers deposit `<tex-math>` as a complete LaTeX document —
 * `\documentclass[12pt]{minimal}\usepackage{amsmath}…\begin{document}$$…$$\end{document}`
 * — and every character of that preamble reached prose before this rule
 * existed, once per formula (312 times in one Scientific Reports record). The
 * math delimiters inside the body are kept, so the expression still reads as
 * math rather than as bare tokens. A body deposited without the wrapper is
 * already the expression and is returned unchanged. (#135)
 */
function texMathExpression(raw: string): string {
  return TEX_DOCUMENT_BODY.exec(raw)?.[1] ?? raw;
}

/**
 * The single child of an `<alternatives>` whose text stands for the whole
 * element.
 *
 * `<alternatives>` offers equivalent renderings of one object — a TeX and a
 * MathML spelling of the same formula, a graphic and a marked-up table — so
 * reading every child states the object twice in the same sentence. The
 * `<tex-math>` is preferred because it survives as readable math, then any other
 * rendering that carries text, and a pointer's own `<alt-text>` only when the
 * deposit offers nothing else. Every candidate must carry text under the
 * caller's `excluded` set, which is what keeps the selection from landing on a
 * rendering that would then contribute nothing: an empty `<tex-math>`, a
 * `<graphic>` naming its file, or a child the caller excludes by tag. Returns
 * undefined when no child qualifies. (#135)
 *
 * Structural selections are unaffected: `<table-wrap>` and `<disp-formula>`
 * resolve their own `<alternatives>` children by tag.
 */
export function selectAlternative(
  node: JatsNode,
  excluded?: ReadonlySet<string>,
): JatsNode | undefined {
  const children = childrenOf(node);
  const carriesText = (child: JatsNode): boolean => concatText(child, excluded).trim() !== '';
  return (
    children.find((child) => tagNameOf(child) === TEX_MATH_TAG && carriesText(child)) ??
    children.find((child) => !POINTER_TAGS.has(tagNameOf(child) ?? '') && carriesText(child)) ??
    children.find(carriesText)
  );
}

/**
 * Concatenate text content in document order without normalizing whitespace.
 * Internal helper so recursion preserves the original spacing between siblings.
 * `excluded` skips a whole subtree by tag name; omitting it reads everything.
 *
 * Two JATS elements do not contribute the plain concatenation of their subtree:
 * a `<tex-math>` contributes only its LaTeX document body, and an
 * `<alternatives>` contributes exactly one child. Both rules live here so every
 * prose consumer inherits them — paragraphs, table cells, captions, abstracts.
 * (#135)
 */
function concatText(input: JatsNode | JatsNodeList, excluded?: ReadonlySet<string>): string {
  const nodes = Array.isArray(input) ? input : [input];
  const parts: string[] = [];
  for (const node of nodes) {
    if (isTextNode(node)) {
      parts.push(textOf(node));
      continue;
    }
    const tag = tagNameOf(node) ?? '';
    if (excluded?.has(tag)) continue;
    if (tag === TEX_MATH_TAG) {
      parts.push(texMathExpression(concatText(childrenOf(node))));
      continue;
    }
    if (tag === ALTERNATIVES_TAG) {
      const chosen = selectAlternative(node, excluded);
      if (chosen) parts.push(concatText(chosen, excluded));
      continue;
    }
    parts.push(concatText(childrenOf(node), excluded));
  }
  return parts.join('');
}

/**
 * Extract all text from a node or sibling list in document order with the
 * source spacing intact — no whitespace collapsing, no trimming. Use it when
 * the caller assembles several fragments itself and needs to collapse once over
 * the joined result; {@link textContent} is the normalizing form for everything
 * else.
 */
export function rawTextContent(input: JatsNode | JatsNodeList | undefined): string {
  return input ? concatText(input) : '';
}

/**
 * Extract all text from a node or sibling list in document order, collapsing
 * runs of whitespace to a single space and trimming the result. Use this for
 * mixed-content elements (`<p>`, `<title>`, `<abstract>`, …) where inline
 * children must read back in the order they appear in the source.
 */
export function textContent(input: JatsNode | JatsNodeList | undefined): string {
  if (!input) return '';
  return concatText(input).replace(/\s+/g, ' ').trim();
}

/**
 * {@link textContent}, with the subtree of any element named in `excludedTags`
 * left out. Block content a publisher nests inside a `<p>` — a `<table-wrap>` in
 * particular — would otherwise be flattened into the paragraph, running every
 * cell together into values that never existed. Such content is extracted
 * separately and must not appear in the prose twice.
 */
export function textContentExcluding(
  input: JatsNode | JatsNodeList | undefined,
  excludedTags: ReadonlySet<string>,
): string {
  if (!input) return '';
  return concatText(input, excludedTags).replace(/\s+/g, ' ').trim();
}

/** First direct child with the given tag name. */
export function findOne(
  input: JatsNode | JatsNodeList | undefined,
  tagName: string,
): JatsNode | undefined {
  if (!input) return;
  const children = Array.isArray(input) ? input : childrenOf(input);
  return children.find((c) => tagNameOf(c) === tagName);
}

/** All direct children with the given tag name. */
export function findAll(input: JatsNode | JatsNodeList | undefined, tagName: string): JatsNode[] {
  if (!input) return [];
  const children = Array.isArray(input) ? input : childrenOf(input);
  return children.filter((c) => tagNameOf(c) === tagName);
}

/**
 * Every descendant element with the given tag name, in document order.
 * {@link findAll} matches direct children only, which is right for reading a
 * known JATS shape; this is for containers publishers place at varying depths
 * (a `<ref-list>` under `<back>` in one deposit and under `body/sec/sec` in the
 * next). The walk keeps descending through a match, so a container nested
 * inside another of the same tag is reported too. Each node is visited once, so
 * the result never repeats a node.
 */
export function findAllDescendants(
  input: JatsNode | JatsNodeList | undefined,
  tagName: string,
): JatsNode[] {
  if (!input) return [];
  const found: JatsNode[] = [];
  const visit = (nodes: JatsNodeList): void => {
    for (const node of nodes) {
      if (tagNameOf(node) === tagName) found.push(node);
      visit(childrenOf(node));
    }
  };
  visit(Array.isArray(input) ? input : childrenOf(input));
  return found;
}
