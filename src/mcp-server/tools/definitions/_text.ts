/**
 * @fileoverview Text-cutting helper shared by the tool definitions that bound
 * returned text to a character budget.
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
