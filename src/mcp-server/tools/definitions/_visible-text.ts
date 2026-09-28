/**
 * @fileoverview The one test every blank-input rejection shares: does a value
 * hold any character a reader could see? `String.prototype.trim` is not enough —
 * it keeps U+0085 (NEL), control characters such as U+0001 and U+007F (`\p{Cc}`),
 * every format character (`\p{Cf}`: zero-width space, word joiner, soft
 * hyphen, …), and the other default-ignorable code points (Hangul fillers such
 * as U+3164, variation selectors, the combining grapheme joiner), so a value
 * made only of those reads as nonblank and reaches the upstream as an invisible
 * term. (#176)
 * @module src/mcp-server/tools/definitions/_visible-text
 */

const VISIBLE_CHARACTER = /[^\p{White_Space}\p{Cc}\p{Cf}\p{Default_Ignorable_Code_Point}]/u;

/**
 * True when `value` has at least one character outside `\p{White_Space}`,
 * `\p{Cc}`, `\p{Cf}`, and `\p{Default_Ignorable_Code_Point}`. Pure: it strips no
 * markup and decodes no entities, so a caller that sanitizes input runs this on
 * the sanitized copy.
 */
export function hasVisibleText(value: string): boolean {
  return VISIBLE_CHARACTER.test(value);
}
