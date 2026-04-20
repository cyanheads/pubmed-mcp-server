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

/**
 * Concatenate text content in document order without normalizing whitespace.
 * Internal helper so recursion preserves the original spacing between siblings.
 */
function concatText(input: JatsNode | JatsNodeList): string {
  const nodes = Array.isArray(input) ? input : [input];
  const parts: string[] = [];
  for (const node of nodes) {
    if (isTextNode(node)) {
      parts.push(textOf(node));
    } else {
      parts.push(concatText(childrenOf(node)));
    }
  }
  return parts.join('');
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
