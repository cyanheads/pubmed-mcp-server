/**
 * @fileoverview Text helpers shared by the tool definitions: the surrogate-safe
 * character cut and the word-boundary cut built on it, which bound returned text
 * to a budget, and the render-time Markdown escapes applied to upstream strings
 * interpolated into `format()` — one for an inline position, one for a table
 * cell, one for a multi-line block of prose such as an abstract or a section,
 * and one for a value that opens a line or a list item — plus the code span and
 * code fence that carry a value verbatim.
 * @module src/mcp-server/tools/definitions/_text
 */

const HIGH_SURROGATE_FIRST = 0xd800;
const HIGH_SURROGATE_LAST = 0xdbff;

/**
 * Take at most `limit` UTF-16 code units from `text` without splitting a
 * surrogate pair.
 *
 * `String.prototype.slice` cuts on a code-unit boundary, so a cut landing
 * between the high and low half of an astral character — emoji, mathematical
 * alphanumerics, CJK extensions — leaves a lone surrogate. It survives
 * `JSON.stringify` as `\ud83e` and transports fine, then renders as U+FFFD once
 * a client decodes it, and the string fails `String.prototype.isWellFormed()`.
 *
 * `limit` stays a ceiling: when the boundary would land mid-pair it backs off by
 * one code unit, so the result can come back one unit short of the allowance.
 * Callers that report character counts must measure the returned string rather
 * than assume the allowance was spent exactly. (#93)
 */
export function sliceCodeUnits(text: string, limit: number): string {
  if (limit <= 0) return '';
  if (limit >= text.length) return text;
  const last = text.charCodeAt(limit - 1);
  const splitsPair = last >= HIGH_SURROGATE_FIRST && last <= HIGH_SURROGATE_LAST;
  return text.slice(0, splitsPair ? limit - 1 : limit);
}

/** A whitespace character — the boundary a word-boundary cut backs off to. */
const WHITESPACE_RE = /\s/;

const isWhitespace = (text: string, index: number): boolean =>
  WHITESPACE_RE.test(text.charAt(index));

/**
 * Take at most `limit` UTF-16 code units from `text`, ending at the last word
 * boundary inside the allowance rather than partway through a word.
 *
 * The cut is {@link sliceCodeUnits}' cut, backed off past the partial word it
 * would end on — unless the character after it is whitespace, in which case
 * the last word is already whole — with the whitespace before that word
 * trimmed. A cut is therefore never mid-word and never ends in whitespace.
 * `limit` stays a ceiling: the result can come back several units short of it,
 * so callers reporting character counts measure the returned string. (#143)
 *
 * An allowance holding no boundary at all — one token longer than the
 * allowance, such as a sequence or a URL — is cut at the allowance instead:
 * backing off would return nothing, dropping a field that has text to give.
 */
export function sliceAtWordBoundary(text: string, limit: number): string {
  const cut = sliceCodeUnits(text, limit);
  if (cut.length === text.length) return cut;

  let end = cut.length;
  if (!isWhitespace(text, end)) {
    while (end > 0 && !isWhitespace(cut, end - 1)) end -= 1;
  }
  while (end > 0 && isWhitespace(cut, end - 1)) end -= 1;
  return end > 0 ? cut.slice(0, end) : cut.trimEnd();
}

/** Any line break, including the Unicode line and paragraph separators. */
const LINE_BREAK_RE = /[\r\n\u2028\u2029]+/g;
/**
 * A `<` that could open something a Markdown renderer reads as raw HTML or an
 * autolink: a tag-name start (a letter, `/`, `!`, or `?`), then a body carrying
 * no further angle bracket, then a closing `>`. Looser than `MARKUP_TAG_RE` in
 * `text-helpers.ts` on purpose: that pattern deletes what it matches, so its tag
 * name ends only at whitespace, `/`, or `>` to keep PubMed's `<or= 20 or > 20`
 * as text, while an escape here costs only a backslash the renderer hides, so
 * that `<` is escaped. The two agree that a `<` with no `>` after it (`n<N`) or
 * one followed by a digit (`P<0.001`) cannot open a tag and is left alone,
 * unless it opens an email autolink (`<1a@b.org>`). A comment, declaration or
 * processing instruction (`<!`, `<?`) is escaped whatever follows: its body may
 * hold a `<` (`<!-- a<b -->`).
 */
const HTML_TAG_OPENER_RE = /<(?=[!?]|(?:[A-Za-z/]|[^\s<>@]+@)[^<>]*>)/g;
/**
 * An `&` opening an entity or numeric character reference, which a renderer
 * decodes: `&amp;` would show as `&`, `&lt;i&gt;` as `<i>`.
 */
const ENTITY_AMPERSAND_RE = /&(?=#\d{1,7};|#[Xx][\dA-Fa-f]{1,6};|[A-Za-z][\dA-Za-z]{0,31};)/g;
/** A character that makes an adjacent `_` intraword, where it cannot emphasize. */
const WORD_CHAR_RE = /[0-9A-Za-z]/;

function countOf(text: string, character: string): number {
  return text.split(character).length - 1;
}

function escapeEvery(text: string, pattern: RegExp): string {
  return text.replace(pattern, (match) => `\\${match}`);
}

/**
 * Positions of the `_` characters that could open or close emphasis. CommonMark
 * forbids intraword `_` emphasis, so an underscore flanked by alphanumerics on
 * both sides (`TP53_mutant`) is inert and stays unescaped.
 */
function pairableUnderscores(text: string): Set<number> {
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

/**
 * Escape the Markdown-significant characters in an upstream string that is
 * about to be interpolated *inline* into a `format()` line — a `### `/`#### `
 * heading or a `**Label:** ` line. Render-time only: the escaped form must
 * never be written back into `structuredContent`, which is a contract over the
 * plain-text value. (#102)
 *
 * Minimal by design, judged on what the reader actually sees rendered. Every
 * Markdown construct here needs a partner delimiter to form, so a delimiter is
 * escaped only when its partner is present: a lone `*` in `5*g`, a lone `~` in
 * `~250`, and an intraword `_` in `TP53_mutant` are inert and stay legible.
 * Escaping them would cost a reader of the raw text a stray backslash and buy
 * nothing. What is escaped: a tag-shaped `<` (raw HTML and autolinks), an
 * entity-shaped `&`, pairable `` ` ``/`*`/`~`/`_`, every `[` and `]`, and the backslash itself,
 * without which a trailing one in the source would neutralize the escape after
 * it. Brackets get no pairing test: sibling label lines render as one
 * paragraph, so a lone `[` in one field and a lone `]` in the next would still
 * form a link.
 *
 * Line breaks collapse to a space. That is what keeps the value inline, and
 * with it the reason `#`, `>`, and `-` need no escaping: they are structural
 * only at the start of a line, and the value never reaches one.
 */
export function escapeMarkdownInline(text: string): string {
  let escaped = text.replace(LINE_BREAK_RE, ' ').replace(/\\/g, '\\\\');
  escaped = escaped.replace(HTML_TAG_OPENER_RE, '\\<').replace(ENTITY_AMPERSAND_RE, '\\&');
  if (countOf(text, '`') >= 2) escaped = escapeEvery(escaped, /`/g);
  escaped = escapeEvery(escaped, /[[\]]/g);
  if (countOf(text, '*') >= 2) escaped = escapeEvery(escaped, /\*/g);
  if (countOf(text, '~') >= 2) escaped = escapeEvery(escaped, /~/g);

  const pairable = pairableUnderscores(escaped);
  if (pairable.size < 2) return escaped;
  return escaped.replace(/_/g, (underscore, index: number) =>
    pairable.has(index) ? `\\${underscore}` : underscore,
  );
}

/**
 * Escape an upstream string for a Markdown table cell — {@link
 * escapeMarkdownInline} plus the cell delimiter.
 *
 * `|` needs escaping here and nowhere else. Inside a row it ends the cell, so an
 * unescaped one in a value splits it and shifts every value after it one column
 * left: a grid that renders cleanly while reporting the wrong numbers under the
 * wrong headers. Outside a table it is an ordinary character, which is why the
 * inline escape leaves it alone rather than spending a backslash on every value
 * that happens to carry one.
 *
 * Line breaks are already collapsed to a space by the inline escape — a cell
 * needs that too, since a newline inside one ends the row. (#111)
 *
 * Order is load-bearing. The inline escape runs first because it is what escapes
 * the backslash; the backslashes added here for `|` are escape characters and
 * must not be escaped in turn. Reversed, the `\` this step adds is doubled by
 * the backslash pass that follows, which leaves the `|` bare and splits the cell
 * anyway — the exact defect this function exists to prevent.
 */
export function escapeMarkdownTableCell(text: string): string {
  return escapeMarkdownInline(text).replace(/\|/g, '\\|');
}

/**
 * How {@link escapeMarkdownBlock} reads the lines of the text it escapes.
 *
 * - `structured` — text the JATS parser (`pmc-article-parser.ts`) laid out: its
 *   list lines (`- ` / `N. ` markers, two spaces of indentation per nesting
 *   level), `> ` quote lines and backtick preformat fences (three or more) are
 *   Markdown the parser meant, and keep rendering as lists, quotes and code.
 * - `plain` — text with no parser structure: a PubMed or Europe PMC abstract, a
 *   PDF's extracted text. Every line is prose, so anything that would open a
 *   heading, quote, list, fence or table at a line start is escaped too.
 */
export type MarkdownBlockMode = 'plain' | 'structured';

/** A line break, captured so a split keeps the separators and a join restores them byte for byte. */
const LINE_SEPARATOR_RE = /(\r\n|\r|\n)/;
/** Text ending in a line break. */
const LINE_SEPARATOR_END_RE = /[\r\n]$/;
/** A CommonMark blank line: nothing but spaces and tabs. It ends a paragraph, and with it every emphasis pairing. */
const BLANK_LINE_RE = /^[ \t]*$/;

const isAsciiDigit = (character: string | undefined): boolean =>
  character !== undefined && character >= '0' && character <= '9';

/** Index past the run of `unit` repeated from `at` in `line`. */
function skipRepeated(line: string, at: number, unit: string): number {
  let end = at;
  while (line.startsWith(unit, end)) end += unit.length;
  return end;
}

/**
 * Length of the backtick run `line` holds, inside any number of quote levels,
 * when that run is the whole of what follows them and at least three long —
 * a preformat fence as the parser writes it — and 0 otherwise. The parser sizes
 * each fence past the longest backtick run in its content, so a fence closes
 * only on a run at least as long as the one that opened it, as CommonMark reads
 * one.
 */
function fenceLength(line: string): number {
  const at = skipRepeated(line, 0, '> ');
  const end = skipRepeated(line, at, '`');
  return end === line.length && end - at >= 3 ? end - at : 0;
}

/**
 * Length of the structure the parser opens `line` with: list indentation, `> `
 * quote markers, more indentation, then one list marker — `- ` / `N. `, or a
 * bare `-` / `N.` ending the line, for an item whose text all follows its
 * nested list. Scanned by hand: a regex over one very long run of `> ` drops
 * Bun's engine into a far slower mode.
 */
function structurePrefixLength(line: string): number {
  const at = skipRepeated(line, skipRepeated(line, skipRepeated(line, 0, '  '), '> '), '  ');
  let markerEnd = at;
  if (line[at] === '-') markerEnd = at + 1;
  else {
    while (markerEnd < line.length && markerEnd - at < 9 && isAsciiDigit(line[markerEnd])) {
      markerEnd += 1;
    }
    if (markerEnd === at || line[markerEnd] !== '.') return at;
    markerEnd += 1;
  }
  if (markerEnd === line.length) return markerEnd;
  return line[markerEnd] === ' ' ? markerEnd + 1 : at;
}

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
 * (`<!-- a<b -->`). Tighter than {@link HTML_TAG_OPENER_RE} on purpose: PubMed's legacy
 * `<or= 20 or > 20` cannot open a tag (`=` follows the name directly), so it
 * stays raw here, where a prose block would otherwise carry the stray
 * backslash on every such comparison. Linear: every branch stops at the next
 * `<`. (#255)
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

/** Width of a line's leading whitespace in columns, a tab advancing to the next multiple of four. */
function indentColumns(line: string): number {
  let columns = 0;
  for (const character of line) {
    if (character === ' ') columns += 1;
    else if (character === '\t') columns += 4 - (columns % 4);
    else break;
  }
  return columns;
}

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
function lineStartMarker(text: string, start: number): number {
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
 * Whether `text` holds a GFM task-list marker at `at` — `[ ]`, `[x]` or `[X]`,
 * then a space, a tab, a line break or the end. Opening a list item, one turns
 * the item into a checkbox and the brackets and mark never render.
 */
function opensTaskMarker(text: string, at: number): boolean {
  const mark = text[at + 1];
  const after = text[at + 3];
  return (
    text[at] === '[' &&
    (mark === ' ' || mark === 'x' || mark === 'X') &&
    text[at + 2] === ']' &&
    (after === undefined || after === ' ' || after === '\t' || after === '\n')
  );
}

/** Whether a structure prefix {@link structurePrefixLength} took off a line ends in a list marker. */
function endsInListMarker(prefix: string): boolean {
  if (prefix.endsWith('- ')) return true;
  return prefix.endsWith('. ') && isAsciiDigit(prefix[prefix.length - 3]);
}

/**
 * Escape one run of prose lines — a blank-line-delimited block, joined with
 * `\n`, any parser structure already taken off each line. Pairing is judged
 * over the whole run because CommonMark pairs emphasis across the lines of a
 * paragraph: two lines holding one `*` each render as one emphasis span.
 */
function escapeProse(text: string): string {
  const pairs = {
    '*': countOf(text, '*') >= 2,
    '~': countOf(text, '~') >= 2,
    '`': countOf(text, '`') >= 2,
  };
  const underscores = pairableUnderscores(text);
  const underscoresPair = underscores.size >= 2;
  const tagOpeners = new Set<number>();
  for (const match of text.matchAll(INLINE_HTML_OPENER_RE)) tagOpeners.add(match.index);

  let out = '';
  let marker = lineStartMarker(text, 0);
  for (let i = 0; i < text.length; i += 1) {
    const character = text[i] ?? '';
    if (character === '\n') {
      out += character;
      marker = lineStartMarker(text, i + 1);
      continue;
    }
    const next = text[i + 1];
    let needsEscape = i === marker;
    switch (character) {
      case '\\':
        needsEscape ||= next === undefined || next === '\n' || ASCII_PUNCTUATION_RE.test(next);
        break;
      case '*':
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
 * Escape a multi-line block of upstream prose — an abstract, a full-text
 * section — for `content[]`, so the rendered text shows every character the
 * plain value in `structuredContent` carries. Render-time only, like
 * {@link escapeMarkdownInline}: the escaped form never reaches
 * `structuredContent`. (#255)
 *
 * Minimal, as the inline escape is, but judged per block rather than per value:
 * - `*`, `~` and `` ` `` are escaped only in a blank-line-delimited block that
 *   holds two or more of them, and `_` only where two or more could open or
 *   close emphasis (not intraword): emphasis pairs across the lines of a
 *   paragraph, never across a blank line. A lone delimiter stays raw —
 *   `41*47 mm`, `TP53_mutant`, `NM_003482.3`, `~250`.
 * - `\` is escaped only before ASCII punctuation or at a line end, the two
 *   places CommonMark consumes one; `\frac` and `\alpha` stay raw.
 * - `]` is escaped only before `(` or `[`, where it would close link text, so
 *   citation markers `[12]` and `[1,2,3]` stay raw; a `[label]:` opening a line
 *   is escaped, since a link reference definition hides the whole line.
 * - A tag-shaped `<` — one that opens raw HTML or an autolink, closed by a `>`
 *   across the block's lines (`HuMab<CD20>`, `<i>`, `<https://…>`) — and an
 *   entity-shaped `&` (`&amp;`, `&#955;`) are escaped; `P<0.001`, `n<N` and
 *   `<or= 20` are not.
 * - A block construct opening a line is escaped: `#` headings, `>` quotes,
 *   `-`/`+`/`*` bullets, `N.`/`N)` ordered items, setext underlines, thematic
 *   breaks, table delimiter rows, HTML block starts.
 *
 * In `structured` mode that last rule reads each line after the structure the
 * parser opened it with (see {@link MarkdownBlockMode}): list indentation, `> `
 * quote markers and one `- ` / `N. ` list marker are kept as they are, and the
 * text after them is escaped as a line start — after a list marker, a GFM
 * task-list marker (`[ ]`, `[x]`, `[X]`) included, which would otherwise render
 * as a checkbox in place of its brackets. A line of three or more backticks
 * opens a preformat fence whose content passes through verbatim, blank lines
 * included, until a line of at least as many backticks closes it. A fence the
 * text never closes — a budget cut inside one — runs verbatim to the end and is
 * closed there with a copy of its opening line, so it cannot carry on past the
 * block and turn the rest of the response into code. A prose paragraph that
 * itself opens with `> `, `- ` or `1. `, or is nothing but backticks, is
 * indistinguishable from parser structure and renders as one.
 *
 * In `plain` mode every line is prose, so every line start is escaped — except
 * the lines of an indented code block (four or more columns of indentation at
 * the start of a block), which a renderer already shows verbatim and where an
 * added backslash would show.
 *
 * Linear in the length of the text.
 */
export function escapeMarkdownBlock(text: string, mode: MarkdownBlockMode): string {
  const parts = text.split(LINE_SEPARATOR_RE);
  let block: number[] = [];
  const flush = () => {
    if (block.length === 0) return;
    const lines = block.map((index) => parts[index] ?? '');
    const prefixLengths = lines.map((line) =>
      mode === 'structured' ? structurePrefixLength(line) : 0,
    );
    const escaped = escapeProse(
      lines.map((line, k) => line.slice(prefixLengths[k])).join('\n'),
    ).split('\n');
    block.forEach((index, k) => {
      const prefix = lines[k]?.slice(0, prefixLengths[k]) ?? '';
      const text = escaped[k] ?? '';
      // Text opening a parser list item like a task-list marker would render
      // as a checkbox in place of its brackets.
      const task = endsInListMarker(prefix) && opensTaskMarker(text, 0);
      parts[index] = `${prefix}${task ? '\\' : ''}${text}`;
    });
    block = [];
  };

  /** The line that opened the fence still open, `undefined` outside one. */
  let fence: string | undefined;
  let fenceRun = 0;
  // Even indices are lines, odd indices the separators between them.
  for (let index = 0; index < parts.length; index += 2) {
    const line = parts[index] ?? '';
    if (fence !== undefined) {
      if (fenceLength(line) >= fenceRun) fence = undefined;
      continue;
    }
    const run = mode === 'structured' ? fenceLength(line) : 0;
    if (run > 0) {
      flush();
      fence = line;
      fenceRun = run;
      continue;
    }
    if (BLANK_LINE_RE.test(line)) {
      flush();
      continue;
    }
    if (mode === 'plain' && block.length === 0 && indentColumns(line) >= 4) continue;
    block.push(index);
  }
  flush();
  const escaped = parts.join('');
  if (fence === undefined) return escaped;
  // Close the fence a budget cut left open, with the line that opened it.
  return LINE_SEPARATOR_END_RE.test(escaped) ? `${escaped}${fence}` : `${escaped}\n${fence}`;
}

/**
 * Escape a block construct opening `line` — for a value that starts a line of
 * its own, where {@link escapeMarkdownInline}'s contract assumes it never does,
 * such as a list item's content or continuation line. Apply it to the
 * inline-escaped value, as {@link escapeMarkdownListItem} does. The constructs
 * are the ones {@link escapeMarkdownBlock} escapes at a line start, plus a GFM
 * task-list marker (`[ ]`, `[x]`, `[X]`), which opening a list item renders as
 * a checkbox in place of its brackets. (#255)
 */
export function escapeMarkdownLineStart(line: string): string {
  // Past any leading spaces and tabs: inside a list item a tab can leave the
  // marker within the item's own indentation, where it still opens a block.
  const start = /^[ \t]*/.exec(line)?.[0].length ?? 0;
  const blockMarker = lineStartMarker(line, start);
  const marker = blockMarker === -1 && opensTaskMarker(line, start) ? start : blockMarker;
  return marker === -1 ? line : `${line.slice(0, marker)}\\${line.slice(marker)}`;
}

/**
 * Escape an upstream value that opens a list item's content — an author, an
 * affiliation, a MeSH heading, a reference: {@link escapeMarkdownInline}, then
 * {@link escapeMarkdownLineStart}, since the value sits where a `#`, `>`, `1.`
 * or `[x]` would open a heading, quote, nested list or checkbox. (#255)
 */
export function escapeMarkdownListItem(value: string): string {
  return escapeMarkdownLineStart(escapeMarkdownInline(value));
}

/** Length of the longest run of backticks in `text`. A plain loop, linear in the text. */
function longestBacktickRun(text: string): number {
  let longest = 0;
  let run = 0;
  for (let i = 0; i < text.length; i += 1) {
    run = text.charCodeAt(i) === 0x60 ? run + 1 : 0;
    if (run > longest) longest = run;
  }
  return longest;
}

/**
 * Render a value a reader copies back verbatim — a caller's query, a paging
 * cursor — as a Markdown code span, so it reads exactly as sent both raw and
 * rendered. An escape would render the value but leave its raw text carrying
 * backslashes, and a query re-run from that text (`risk\[tiab\]`) is not the
 * query that was sent. (#255)
 *
 * The fence is one backtick longer than the longest run inside the value, so
 * no run closes it early. A value opening or closing with a backtick is padded
 * with a space each side, as is one both opening and closing with a space that
 * is not all spaces: a renderer strips exactly one space from each side of
 * such a span, so the padding is what it takes away. Line breaks become
 * spaces — a renderer does the same inside a span, and a raw one would let the
 * next line open a block construct of its own. An empty value stays empty: no
 * code span can hold nothing.
 */
export function markdownCodeSpan(value: string): string {
  if (value === '') return '';
  const text = value.replace(LINE_BREAK_RE, ' ');
  const fence = '`'.repeat(longestBacktickRun(text) + 1);
  const pad =
    text.startsWith('`') ||
    text.endsWith('`') ||
    (text.startsWith(' ') && text.endsWith(' ') && text.trim() !== '');
  return pad ? `${fence} ${text} ${fence}` : `${fence}${text}${fence}`;
}

/**
 * The backtick fence for a fenced code block holding `text` verbatim: three
 * backticks, or one more than the longest backtick run in the text, so no line
 * of the content can close the block early. (#255)
 */
export function markdownCodeFence(text: string): string {
  return '`'.repeat(Math.max(3, longestBacktickRun(text) + 1));
}
