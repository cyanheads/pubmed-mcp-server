/**
 * @fileoverview The CommonMark escape rules for upstream prose, shared by the
 * tool layer's render-time escapes (`src/mcp-server/tools/definitions/_text.ts`)
 * and the citation formatter, which writes APA and MLA as Markdown on both
 * surfaces: the pairing tests for `*`, `~`, `` ` `` and `_`, the block
 * constructs a line can open, and the per-character prose escape built on them.
 * @module src/services/markdown-escape
 */

/** Number of times `character` occurs in `text`. */
export function countOf(text: string, character: string): number {
  return text.split(character).length - 1;
}

/** A character that makes an adjacent `_` intraword, where it cannot emphasize. */
const WORD_CHAR_RE = /[0-9A-Za-z]/;

/**
 * Positions of the `_` characters that could open or close emphasis. CommonMark
 * forbids intraword `_` emphasis, so an underscore flanked by alphanumerics on
 * both sides (`TP53_mutant`) is inert and stays unescaped.
 */
export function pairableUnderscores(text: string): Set<number> {
  const positions = new Set<number>();
  for (let i = text.indexOf('_'); i !== -1; i = text.indexOf('_', i + 1)) {
    const previous = text[i - 1];
    const next = text[i + 1];
    const intraword =
      previous !== undefined &&
      next !== undefined &&
      WORD_CHAR_RE.test(previous) &&
      WORD_CHAR_RE.test(next);
    if (!intraword) positions.add(i);
  }
  return positions;
}

export const isAsciiDigit = (character: string | undefined): boolean =>
  character !== undefined && character >= '0' && character <= '9';

/** ASCII punctuation — the only characters a CommonMark backslash escapes. */
const ASCII_PUNCTUATION_RE = /[!-/:-@[-`{-~]/;
/** An entity or numeric character reference a renderer decodes, tested in place at an `&`. */
const ENTITY_REFERENCE_RE = /&(?:#\d{1,7}|#[Xx][\dA-Fa-f]{1,6}|[A-Za-z][\dA-Za-z]{0,31});/y;
/**
 * A `<` a renderer reads as raw inline HTML or an autolink: an open tag (a tag
 * name, then whitespace, `/` or `>`), a closing tag, a URI autolink
 * (`<scheme:`) or an email autolink (`<local@`) — each closed by a `>` before
 * any other `<`, across lines — and a comment, declaration or processing
 * instruction (`<!`, `<?`) whatever follows, since its body may hold a `<`
 * (`<!-- a<b -->`). Tighter than the inline escape's opener in `_text.ts` on
 * purpose: PubMed's legacy `<or= 20 or > 20` cannot open a tag (`=` follows the
 * name directly), so it stays raw here, where a prose block would otherwise
 * carry the stray backslash on every such comparison. Linear: every branch
 * stops at the next `<`. (#255)
 */
const INLINE_HTML_OPENER_RE =
  /<(?=[!?]|(?:[A-Za-z][\dA-Za-z-]*(?=[\s/>])|\/[A-Za-z]|[A-Za-z][\d+.A-Za-z-]{1,31}:|[^\s<>@]+@)[^<>]*>)/g;
/**
 * A `<` opening an HTML block at a line start: a tag name followed by
 * whitespace, `/`, `>` or the line's end, or `</`, `<!`, `<?`. A block needs
 * no closing `>` on the line — `<div` alone starts one — so this is tested in
 * place, with no lookahead for a partner.
 */
const HTML_BLOCK_OPENER_RE = /<(?:[A-Za-z][\dA-Za-z-]*(?:[\s/>]|$)|[/!?])/y;
/**
 * A line holding only what a GFM table delimiter row is made of; the caller
 * also requires a `-`. Kept a single character class so a near miss
 * (`----…-x`) fails in one pass rather than backtracking.
 */
const TABLE_DELIMITER_CHARS_RE = /^[|:\- \t]*$/;
/** A setext heading's `=` underline. */
const SETEXT_EQUALS_RE = /^=+[ \t]*$/;

/**
 * Index of the character that would open a block construct on the line
 * starting at `start` in `text`, or `-1`. CommonMark reads these after up to
 * three spaces: an ATX heading (`#`–`######` then a space or the line's end), a
 * block quote (`>`), a bullet (`-`, `+`, `*` then a space or the line's end), an
 * ordered item (up to nine digits, `.` or `)`, then a space or the line's end —
 * the `.`/`)` is the character escaped), a setext underline or thematic break
 * (a run of `=` or `-`), a GFM table delimiter row, a link reference definition
 * (`[label]:`, which hides its whole line), and an HTML block
 * ({@link HTML_BLOCK_OPENER_RE}). Fences and the `*`/`_` thematic breaks need
 * no rule of their own: three backticks, tildes, asterisks or underscores
 * always reach the pairing threshold.
 */
export function lineStartMarker(text: string, start: number): number {
  const newline = text.indexOf('\n', start);
  const end = newline === -1 ? text.length : newline;
  let at = start;
  while (at < end && at - start < 3 && text[at] === ' ') at += 1;
  if (at >= end) return -1;
  const opensSpace = (index: number) => index >= end || text[index] === ' ' || text[index] === '\t';
  const character = text[at] ?? '';

  switch (character) {
    case '>':
      return at;
    case '#': {
      let run = at;
      while (run < end && run - at <= 6 && text[run] === '#') run += 1;
      return run - at <= 6 && opensSpace(run) ? at : -1;
    }
    case '+':
    case '*':
      return opensSpace(at + 1) ? at : -1;
    case '-':
    case '|':
    case ':': {
      if (character === '-' && opensSpace(at + 1)) return at;
      const line = text.slice(at, end);
      return TABLE_DELIMITER_CHARS_RE.test(line) && line.includes('-') ? at : -1;
    }
    case '=':
      return SETEXT_EQUALS_RE.test(text.slice(at, end)) ? at : -1;
    case '[': {
      // A definition's label may close on a later line of the block, and only
      // the block's first line can open one, so there any later `]:` counts.
      if (start === 0 && text.includes(']:', at)) return at;
      let close = at + 1;
      while (close < end && text[close] !== ']' && text[close] !== '[') close += 1;
      return text[close] === ']' && text[close + 1] === ':' ? at : -1;
    }
    case '<':
      HTML_BLOCK_OPENER_RE.lastIndex = at;
      return HTML_BLOCK_OPENER_RE.test(text) ? at : -1;
    default: {
      let run = at;
      while (run < end && run - at < 10 && isAsciiDigit(text[run])) run += 1;
      const digits = run - at;
      const delimiter = text[run];
      const ordered =
        digits >= 1 &&
        digits <= 9 &&
        (delimiter === '.' || delimiter === ')') &&
        opensSpace(run + 1);
      return ordered ? run : -1;
    }
  }
}

/**
 * Where a character of the text {@link escapeProse} escapes came from, one entry
 * per UTF-16 code unit:
 *
 * - {@link AUTHORED} — markup the caller wrote (a `*` it italicizes with):
 *   copied verbatim, and never counted toward a pairing test.
 * - {@link PROSE} — upstream text, escaped by the prose rules.
 * - {@link ITALIC} — upstream text inside the caller's own `*…*`: the prose
 *   rules, plus every `*`, since any of them would pair with the caller's.
 * - {@link VERBATIM} — text that must read back unescaped, such as a URL:
 *   copied verbatim, but counted toward the pairing tests, so a delimiter in it
 *   leaves none elsewhere on the line raw to pair with.
 */
const AUTHORED = 0;
const PROSE = 1;
const ITALIC = 2;
const VERBATIM = 3;

/**
 * Escape one run of prose lines — a blank-line-delimited block, joined with
 * `\n` — so a CommonMark renderer shows every character. Pairing is judged over
 * the whole run because CommonMark pairs emphasis across the lines of a
 * paragraph: two lines holding one `*` each render as one emphasis span.
 *
 * - `*`, `~` and `` ` `` are escaped only when the run holds two or more, and
 *   `_` only where two or more could open or close emphasis (not intraword). A
 *   lone delimiter stays raw.
 * - `\` is escaped only before ASCII punctuation or at a line end, the two
 *   places CommonMark consumes one.
 * - `]` is escaped only before `(` or `[`, where it would close link text.
 * - A tag-shaped `<` ({@link INLINE_HTML_OPENER_RE}) and an entity-shaped `&`
 *   are escaped.
 * - A block construct opening a line ({@link lineStartMarker}) is escaped.
 *
 * With `kinds` (one {@link AUTHORED} / {@link PROSE} / {@link ITALIC} /
 * {@link VERBATIM} entry per character), only {@link PROSE} and {@link ITALIC}
 * characters are escaped; every kind but {@link AUTHORED} is counted, except
 * that an {@link ITALIC} `*` — always escaped — is not. Without it, every
 * character is {@link PROSE}. Linear in the length of the text.
 */
export function escapeProse(text: string, kinds?: Uint8Array): string {
  const kindAt = (i: number) => (kinds === undefined ? PROSE : (kinds[i] ?? AUTHORED));
  const counts = { '*': 0, '~': 0, '`': 0 };
  if (kinds === undefined) {
    counts['*'] = countOf(text, '*');
    counts['~'] = countOf(text, '~');
    counts['`'] = countOf(text, '`');
  } else {
    for (let i = 0; i < text.length; i += 1) {
      const character = text[i];
      const kind = kindAt(i);
      if (kind === AUTHORED) continue;
      if (character === '~' || character === '`') counts[character] += 1;
      else if (character === '*' && kind !== ITALIC) counts['*'] += 1;
    }
  }
  const pairs = { '*': counts['*'] >= 2, '~': counts['~'] >= 2, '`': counts['`'] >= 2 };
  const underscores = pairableUnderscores(text);
  if (kinds !== undefined) {
    for (const position of underscores)
      if (kindAt(position) === AUTHORED) underscores.delete(position);
  }
  const underscoresPair = underscores.size >= 2;
  const tagOpeners = new Set<number>();
  for (const match of text.matchAll(INLINE_HTML_OPENER_RE)) tagOpeners.add(match.index);

  let out = '';
  let marker = lineStartMarker(text, 0);
  for (let i = 0; i < text.length; i += 1) {
    const character = text[i] ?? '';
    const kind = kindAt(i);
    if (character === '\n') {
      out += character;
      marker = lineStartMarker(text, i + 1);
      continue;
    }
    if (kind === AUTHORED || kind === VERBATIM) {
      out += character;
      continue;
    }
    const next = text[i + 1];
    let needsEscape = i === marker;
    switch (character) {
      case '\\':
        needsEscape ||= next === undefined || next === '\n' || ASCII_PUNCTUATION_RE.test(next);
        break;
      case '*':
        needsEscape ||= kind === ITALIC || pairs[character];
        break;
      case '~':
      case '`':
        needsEscape ||= pairs[character];
        break;
      case '_':
        needsEscape ||= underscoresPair && underscores.has(i);
        break;
      case ']':
        needsEscape ||= next === '(' || next === '[';
        break;
      case '<':
        needsEscape ||= tagOpeners.has(i);
        break;
      case '&':
        ENTITY_REFERENCE_RE.lastIndex = i;
        needsEscape ||= ENTITY_REFERENCE_RE.test(text);
        break;
    }
    out += needsEscape ? `\\${character}` : character;
  }
  return out;
}

/**
 * One piece of a single-line Markdown string assembled from upstream text and
 * the caller's own markup:
 *
 * - a `string` — upstream text, or the caller's plain words and punctuation
 *   around it, escaped as {@link PROSE};
 * - `{ italic }` — upstream text the caller italicizes, written `*…*`, its
 *   content {@link ITALIC};
 * - `{ verbatim }` — text passed through unescaped, such as a URL, its
 *   delimiters still counted ({@link VERBATIM}).
 */
export type MarkdownPiece = string | { readonly italic: string } | { readonly verbatim: string };

const WHITESPACE_CHAR_RE = /\s/;

/**
 * Join `pieces` into one Markdown line that renders every upstream character:
 * each whitespace run collapsed to one space and the ends trimmed (a line break
 * inside a value cannot reach the line), then {@link escapeProse} over the
 * whole line, so a pairing test counts every upstream delimiter on it and none
 * the caller wrote. Text with nothing to escape comes back exactly as
 * concatenated. Linear in the total length of the pieces.
 */
export function renderMarkdownLine(pieces: readonly MarkdownPiece[]): string {
  const units: string[] = [];
  const kinds: number[] = [];
  /** Whether the last unit kept is a collapsed space — or nothing is kept yet, which trims the start. */
  let afterSpace = true;
  const push = (chunk: string, kind: number) => {
    for (let i = 0; i < chunk.length; i += 1) {
      const unit = chunk[i] ?? '';
      const space = WHITESPACE_CHAR_RE.test(unit);
      if (space && afterSpace) continue;
      units.push(space ? ' ' : unit);
      kinds.push(kind);
      afterSpace = space;
    }
  };
  for (const piece of pieces) {
    if (typeof piece === 'string') push(piece, PROSE);
    else if ('italic' in piece) {
      push('*', AUTHORED);
      push(piece.italic, ITALIC);
      push('*', AUTHORED);
    } else push(piece.verbatim, VERBATIM);
  }
  // Trim the end: at most one collapsed space is left there.
  if (afterSpace && units.length > 0) {
    units.pop();
    kinds.pop();
  }
  return escapeProse(units.join(''), Uint8Array.from(kinds));
}
