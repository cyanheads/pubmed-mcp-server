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
 * Elements whose text identifies the element around them and is never prose:
 * the `<institution-id>` (a ROR URL, a GRID or ISNI id, a Crossref Funder DOI)
 * an `<institution-wrap>` carries beside the `<institution>` name. Read as text
 * it fuses onto that name, in an affiliation
 * (`1https://ror.org/034t3zs45grid.454711.2School of …`) and in a funding
 * statement (`sponsored by the 10.13039/501100001809National Natural Science
 * Foundation of China`) alike, so no reader takes its text. (#196, #208)
 */
export const IDENTIFIER_TAGS: ReadonlySet<string> = new Set(['institution-id']);

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

/** An element's tag without its namespace prefix: `math` for `mml:math`. */
const localName = (tag: string): string => tag.slice(tag.indexOf(':') + 1);

/**
 * True for a MathML `<math>` element, matched by local name whatever its
 * namespace prefix — `<mml:math>` in PMC deposits, `<math>` elsewhere. (#207)
 */
export function isMathTag(tag: string): boolean {
  return localName(tag) === 'math';
}

/** MathML token elements, which contribute their text as deposited. */
const MATH_TOKEN_TAGS: ReadonlySet<string> = new Set(['mi', 'mn', 'mo', 'mtext', 'ms']);

/**
 * A MathML `<math>` element in a TeX-style linear form — the notation a
 * formula deposited as `<tex-math>` already reads in — so a formula keeps the
 * structure that carries its meaning instead of reading as the run of its
 * leaves (`∑j=1Nlij`, a matrix's numeric cells fused into `−4.401.20`). (#207)
 *
 * | MathML | Linear form |
 * |:--|:--|
 * | `mi`, `mn`, `mo`, `mtext`, `ms` | their text as deposited (`−` stays U+2212) |
 * | `msub`, `munder` / `msup`, `mover` | base`_{…}` / base`^{…}` |
 * | `msubsup`, `munderover`, `mmultiscripts` | base`_{…}^{…}`, per script pair; `mmultiscripts` prescripts as `{}_{…}^{…}` before the base |
 * | `mfrac` / `msqrt` / `mroot` | `\frac{…}{…}` / `\sqrt{…}` / `\sqrt[index]{…}` |
 * | `mfenced` | `open`, the children split by `separators`, `close` (defaults `(`, `,`, `)`) |
 * | `mtable` | cells split by ` & `, rows by ` \\ ` |
 * | `mspace` / `mphantom` | one space / nothing |
 * | anything else | its children in order |
 *
 * An empty script slot is left out (`x^{2}`, not `x_{}^{2}`). Whitespace-only
 * text between elements contributes nothing; any other text reads verbatim.
 * Elements match by local name, whatever their prefix. Pieces are written to
 * one buffer rather than returned and concatenated level by level, so the cost
 * stays linear in the size of the formula however deeply it nests.
 */
export function linearMath(math: JatsNode): string {
  const out: string[] = [];
  const emit = (text: string): void => {
    if (text) out.push(text);
  };
  /** Element children only: text between MathML arguments is never one of them. */
  const argsOf = (node: JatsNode): JatsNodeList =>
    childrenOf(node).filter((child) => !isTextNode(child));
  /** Write `pieces` after `open`, or nothing at all when they write nothing. */
  const unlessEmpty = (open: string, pieces: () => void, close = ''): void => {
    const start = out.length;
    out.push(open);
    pieces();
    if (out.length === start + 1) out.length = start;
    else emit(close);
  };
  const script = (mark: '_' | '^', node: JatsNode | undefined): void =>
    unlessEmpty(`${mark}{`, () => write(node), '}');
  /** Script pairs — subscript, then superscript — in document order. */
  const scriptPairs = (scripts: JatsNodeList): void => {
    for (let i = 0; i < scripts.length; i += 2) {
      script('_', scripts[i]);
      script('^', scripts[i + 1]);
    }
  };
  const write = (node: JatsNode | undefined): void => {
    if (!node) return;
    if (isTextNode(node)) {
      const text = textOf(node);
      if (VISIBLE_CHAR.test(text)) emit(text);
      return;
    }
    const name = localName(tagNameOf(node) ?? '');
    if (MATH_TOKEN_TAGS.has(name)) {
      for (const child of childrenOf(node)) {
        if (isTextNode(child)) emit(textOf(child));
        else write(child);
      }
      return;
    }
    const args = argsOf(node);
    switch (name) {
      case 'msub':
      case 'munder':
        write(args[0]);
        script('_', args[1]);
        return;
      case 'msup':
      case 'mover':
        write(args[0]);
        script('^', args[1]);
        return;
      case 'msubsup':
      case 'munderover':
        write(args[0]);
        script('_', args[1]);
        script('^', args[2]);
        return;
      case 'mmultiscripts': {
        const split = args.findIndex((arg) => localName(tagNameOf(arg) ?? '') === 'mprescripts');
        if (split !== -1) unlessEmpty('{}', () => scriptPairs(args.slice(split + 1)));
        write(args[0]);
        scriptPairs(args.slice(1, split === -1 ? undefined : split));
        return;
      }
      case 'mfrac':
        emit('\\frac{');
        write(args[0]);
        emit('}{');
        write(args[1]);
        emit('}');
        return;
      case 'msqrt':
        emit('\\sqrt{');
        for (const arg of args) write(arg);
        emit('}');
        return;
      case 'mroot':
        emit('\\sqrt[');
        write(args[1]);
        emit(']{');
        write(args[0]);
        emit('}');
        return;
      case 'mfenced': {
        const separators = [...(attrOf(node, 'separators') ?? ',').replace(/\s/g, '')];
        emit(attrOf(node, 'open') ?? '(');
        for (const [i, arg] of args.entries()) {
          if (i > 0) emit(separators[Math.min(i - 1, separators.length - 1)] ?? '');
          write(arg);
        }
        emit(attrOf(node, 'close') ?? ')');
        return;
      }
      case 'mtable':
        for (const [r, row] of args.entries()) {
          if (r > 0) emit(' \\\\ ');
          for (const [c, cell] of argsOf(row).entries()) {
            if (c > 0) emit(' & ');
            write(cell);
          }
        }
        return;
      case 'mspace':
        emit(' ');
        return;
      case 'mphantom':
        return;
      default:
        for (const child of childrenOf(node)) write(child);
    }
  };
  write(math);
  return out.join('');
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
  const carriesText = (child: JatsNode): boolean => readText(child, excluded).trim() !== '';
  return (
    children.find((child) => tagNameOf(child) === TEX_MATH_TAG && carriesText(child)) ??
    children.find((child) => !POINTER_TAGS.has(tagNameOf(child) ?? '') && carriesText(child)) ??
    children.find(carriesText)
  );
}

/**
 * Elements whose start and end are line boundaries: each holds a statement, a
 * footnote, a list or list item, or a heading of its own. A deposit marks these
 * boundaries with the element alone — `RATIOS<break/>IRR`, `</fn><fn>` — so
 * reading straight through fuses the words and numbers on either side
 * (`57 ± 2095`, `1.082.44`). Inline markup (`<sub>`, `<sup>`, `<italic>`,
 * `<xref>`) is never one: `H<sub>2</sub>O` must read `H2O`. (#185)
 */
const LINE_BOUNDARY_TAGS: ReadonlySet<string> = new Set([
  'attrib',
  'def-item',
  'def-list',
  'disp-quote',
  'fn',
  'list',
  'list-item',
  'p',
  'title',
]);

/** Empty elements that are a line boundary in themselves. (#185) */
const LINE_BREAK_TAGS: ReadonlySet<string> = new Set(['break', 'hr']);

/**
 * A marker printed beside the text it labels — a footnote's `*`, an
 * affiliation's `1`, a list item's `2.` — with nothing between them in the
 * source. (#185)
 */
const LABEL_TAG = 'label';

/** A cross-reference: in prose, usually a citation marker. (#197) */
const XREF_TAG = 'xref';

/** No separator owed. */
const NO_SEPARATOR = 0;
/** One space owed: what follows a `<label>`. */
const SPACE_SEPARATOR = 1;
/** A line boundary owed. */
const LINE_SEPARATOR = 2;
type Separator = typeof NO_SEPARATOR | typeof SPACE_SEPARATOR | typeof LINE_SEPARATOR;

/** One character of whitespace — the same class `\s+` collapses. */
const WHITESPACE_CHAR = /\s/;
/** Any character other than whitespace. */
const VISIBLE_CHAR = /\S/;

/**
 * Accumulates JATS text in document order and decides every separator the
 * markup implies in the same pass, from state it carries rather than by
 * re-reading text already emitted — so the cost stays linear in the size of the
 * subtree. A reader drives it with {@link text} for text nodes and with
 * {@link open} / {@link close} around each element's children.
 *
 * - A line-boundary element ({@link LINE_BOUNDARY_TAGS}, `<break/>`, `<hr/>`)
 *   owes a line boundary before the next content.
 * - A `<label>` that carried text owes one space, and a line boundary arriving
 *   before any further content becomes that space: `<fn><label>*</label><p>…`
 *   reads `* …`, the marker leading its line rather than standing alone on it.
 * - An `<xref>` that carries text and follows another with no source text
 *   between them is preceded by a comma: `[1,2,3,4]`, not `[1234]`, which reads
 *   as one reference. Any source text between them, whitespace included, means
 *   the source already separated them. (#197)
 *
 * An owed separator is only written between two pieces of content, so a reader
 * adds nothing at the edges of what it reads. By default the source text is
 * kept verbatim and a separator is written only where neither side carries
 * whitespace — `a<break/>b` gains a `\n`, `a <break/>b` stays as it was — so a
 * caller collapsing whitespace afterwards reads every boundary as one space. In
 * `lines` mode each text node's whitespace collapses to a space and every line
 * boundary is written as `\n`, replacing whatever spacing the source had there,
 * so the result keeps the source's line structure and nothing else. (#185)
 */
export class TextAssembler {
  readonly #lines: boolean;
  readonly #out: string[] = [];
  /** How many non-whitespace text pieces have been written. */
  #written = 0;
  /** The last character written is whitespace. */
  #endsWithSpace = false;
  #owed: Separator = NO_SEPARATOR;
  /** A `<label>` closed and nothing but whitespace has arrived since. */
  #afterLabel = false;
  /** An `<xref>` carrying text closed and no source text has arrived since. */
  #afterXref = false;
  /** A comma is owed before the open `<xref>`'s first text. */
  #commaOwed = false;
  /** {@link #written} at each open `<label>` and `<xref>`, innermost last. */
  readonly #marks: number[] = [];

  constructor(options: { lines?: boolean } = {}) {
    this.#lines = options.lines ?? false;
  }

  /** Append one text node's value. */
  text(value: string): void {
    if (value === '') return;
    this.#afterXref = false;
    if (!VISIBLE_CHAR.test(value)) {
      this.#out.push(this.#lines ? ' ' : value);
      this.#endsWithSpace = true;
      return;
    }
    if (this.#written > 0 && this.#owed !== NO_SEPARATOR) {
      const separator = this.#owed === LINE_SEPARATOR ? '\n' : ' ';
      const sourceSpaced = this.#endsWithSpace || WHITESPACE_CHAR.test(value.charAt(0));
      if (this.#lines || !sourceSpaced) this.#out.push(separator);
    } else if (this.#commaOwed) {
      this.#out.push(',');
    }
    this.#owed = NO_SEPARATOR;
    this.#afterLabel = false;
    this.#commaOwed = false;
    this.#out.push(this.#lines ? value.replace(/\s+/g, ' ') : value);
    this.#endsWithSpace = WHITESPACE_CHAR.test(value.charAt(value.length - 1));
    this.#written += 1;
  }

  /** Enter an element, before its children are read. */
  open(tag: string): void {
    if (LINE_BREAK_TAGS.has(tag) || LINE_BOUNDARY_TAGS.has(tag)) {
      this.#oweLine();
    } else if (tag === LABEL_TAG) {
      this.#marks.push(this.#written);
    } else if (tag === XREF_TAG) {
      this.#marks.push(this.#written);
      this.#commaOwed = this.#afterXref;
    }
  }

  /**
   * Leave an element, after its children are read. A close with no matching
   * mark — the run was restarted inside the element, as a prose walk does at a
   * block nested in inline markup — owes nothing.
   */
  close(tag: string): void {
    if (LINE_BOUNDARY_TAGS.has(tag)) {
      this.#oweLine();
      return;
    }
    if (tag !== LABEL_TAG && tag !== XREF_TAG) return;
    const mark = this.#marks.pop();
    if (mark === undefined) return;
    const carriedText = mark !== this.#written;
    if (tag === LABEL_TAG) {
      if (!carriedText) return;
      this.#owed = SPACE_SEPARATOR;
      this.#afterLabel = true;
      return;
    }
    this.#commaOwed = false;
    if (carriedText) this.#afterXref = true;
  }

  /** The text assembled so far. */
  toString(): string {
    const text = this.#out.join('');
    if (!this.#lines) return text;
    return text
      .replace(/ {2,}/g, ' ')
      .replace(/ ?\n ?/g, '\n')
      .trim();
  }

  #oweLine(): void {
    if (!this.#afterLabel) this.#owed = LINE_SEPARATOR;
  }
}

/**
 * Drive `sink` through a node or sibling list in document order. `excluded`
 * skips a whole subtree by tag name; omitting it reads everything else.
 *
 * Four JATS elements do not contribute the plain concatenation of their
 * subtree: a `<tex-math>` contributes only its LaTeX document body, a MathML
 * `<math>` its {@link linearMath} form, an `<alternatives>` exactly one child,
 * and an {@link IDENTIFIER_TAGS} element nothing. The rules live here, beside
 * the boundary rules {@link TextAssembler} applies, so every consumer inherits
 * them — table cells, footnotes, titles, affiliations, references. (#135, #185,
 * #207, #208)
 */
function readInto(
  input: JatsNode | JatsNodeList,
  sink: TextAssembler,
  excluded?: ReadonlySet<string>,
): void {
  for (const node of Array.isArray(input) ? input : [input]) {
    if (isTextNode(node)) {
      sink.text(textOf(node));
      continue;
    }
    const tag = tagNameOf(node) ?? '';
    if (IDENTIFIER_TAGS.has(tag) || excluded?.has(tag)) continue;
    if (tag === TEX_MATH_TAG) {
      sink.text(texMathExpression(readText(childrenOf(node))));
      continue;
    }
    if (isMathTag(tag)) {
      sink.text(linearMath(node));
      continue;
    }
    if (tag === ALTERNATIVES_TAG) {
      const chosen = selectAlternative(node, excluded);
      if (chosen) readInto(chosen, sink, excluded);
      continue;
    }
    sink.open(tag);
    readInto(childrenOf(node), sink, excluded);
    sink.close(tag);
  }
}

/** Read a subtree through a fresh {@link TextAssembler}. */
function readText(
  input: JatsNode | JatsNodeList,
  excluded?: ReadonlySet<string>,
  lines = false,
): string {
  const sink = new TextAssembler({ lines });
  readInto(input, sink, excluded);
  return sink.toString();
}

/**
 * Extract all text from a node or sibling list in document order with the
 * source spacing intact — no whitespace collapsing, no trimming. A line boundary
 * the source marks with an element alone gains a `\n`, and a `<label>` beside
 * its text a space; a boundary the source already spaced is left as it is, and
 * nothing is added at the edges of the node read. Use it when the caller assembles several
 * fragments itself and needs to collapse once over the joined result;
 * {@link textContent} is the normalizing form for everything else.
 */
export function rawTextContent(input: JatsNode | JatsNodeList | undefined): string {
  return input ? readText(input) : '';
}

/**
 * Extract all text from a node or sibling list in document order, collapsing
 * runs of whitespace to a single space and trimming the result. Use this for
 * mixed-content elements (`<p>`, `<title>`, `<abstract>`, …) where inline
 * children must read back in the order they appear in the source. A structural
 * boundary — `<break/>`, a sibling `<p>` or `<fn>`, a `<label>` beside its text —
 * reads as one space; inline markup never gains one. (#185)
 */
export function textContent(input: JatsNode | JatsNodeList | undefined): string {
  if (!input) return '';
  return readText(input).replace(/\s+/g, ' ').trim();
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
  return readText(input, excludedTags).replace(/\s+/g, ' ').trim();
}

/**
 * {@link textContent}, keeping every structural line boundary as `\n`: one line
 * per `<break/>`-separated value, paragraph, footnote, or list item, a
 * `<label>` leading its line by one space. Source whitespace inside a line —
 * pretty-printing newlines included — collapses to one space, and blank lines
 * drop out. For table cells and `<table-wrap-foot>`, whose line structure is
 * part of the value: `1.08<break/>2.44` is two estimates, not `1.082.44`.
 * (#185)
 */
export function lineTextContent(input: JatsNode | JatsNodeList | undefined): string {
  return input ? readText(input, undefined, true) : '';
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
