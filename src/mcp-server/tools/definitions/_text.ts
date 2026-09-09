/**
 * @fileoverview Text helpers shared by the tool definitions: the surrogate-safe
 * character cut used to bound returned text to a budget, and the render-time
 * Markdown escape applied to upstream strings interpolated into `format()`.
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

/** Any line break, including the Unicode line and paragraph separators. */
const LINE_BREAK_RE = /[\r\n\u2028\u2029]+/g;
/**
 * A `<` that opens something a Markdown renderer will read as raw HTML or an
 * autolink: a tag-name start, then a body carrying no further angle bracket,
 * then a closing `>`. Deliberately the same shape as `MARKUP_TAG_RE` in
 * `text-helpers.ts` — a `<` with no `>` after it (`n<N`) or one followed by a
 * digit (`P<0.001`) cannot open a tag and is left alone.
 */
const HTML_TAG_OPENER_RE = /<(?=[A-Za-z/!?][^<>]*>)/g;
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
 * nothing. What is escaped: a tag-shaped `<` (raw HTML and autolinks),
 * pairable `` ` ``/`*`/`~`/`_`, every `[` and `]`, and the backslash itself,
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
  escaped = escaped.replace(HTML_TAG_OPENER_RE, '\\<');
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
