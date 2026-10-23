/**
 * @fileoverview How `pubmed_fetch_fulltext`'s `outline` overflow mode divides a
 * character budget across the parts of one level — the top-level sections of an
 * article, or a section's own text and its subsection subtrees. A deposit decides
 * how many parts one level holds, so the split runs in O(n log n) in that count.
 * (#252)
 * @module src/mcp-server/tools/definitions/_outline-shares
 */

/**
 * Split `total` across parts capped at `caps`, with an excerpt floor.
 *
 * The split is even: every part is offered the same level, a part needing less
 * than the level takes its whole cap, and the characters it leaves go to the
 * parts still capped, until the budget is spent or every part holds all it can.
 * Equal shares alone would strand budget on short parts — a ten-section article
 * with two one-line sections would return well under what the caller asked
 * for. The level is the highest whole number of characters the budget affords
 * every part still capped; the few characters short of the next level go one
 * each to the first such parts in document order. A part capped at 0 takes
 * nothing.
 *
 * The floor: a part whose share would cut it (share below its cap) to fewer
 * than `floor` characters gets nothing instead, and its share goes to the rest.
 * Parts are emptied one at a time, the last such part in document order first,
 * and the shares recomputed, until every part that is cut holds at least
 * `floor`. Emptying from the end keeps the excerpts at the front of the
 * document, as `truncate` does, and settles which parts keep text when equal
 * shares put every part under the floor at once. A part that fits its share
 * whole keeps it at any length.
 *
 * Emptying a part only raises the level, so a part the level once covered whole
 * stays whole: one pass from the last part to the first, over caps sorted once,
 * reaches the same allotment the empty-and-recompute rule describes.
 */
export function outlineShares(caps: readonly number[], total: number, floor: number): number[] {
  const budget = Math.max(total, 0);
  const capOf = (i: number) => caps[i] ?? 0;
  /** Part indices by cap, smallest first — the order the level covers them whole. */
  const byCap = caps.map((_, i) => i).sort((a, b) => capOf(a) - capOf(b));
  const emptied = new Uint8Array(caps.length);

  let covered = 0; // parts of `byCap` the level has passed, emptied ones included
  let wholeCharacters = 0; // what the parts held whole take
  let cutParts = caps.length; // parts neither whole nor emptied
  let level = 0;

  /** Raise the level over every part it now covers whole. */
  const settle = () => {
    for (;;) {
      while (covered < byCap.length && emptied[byCap[covered] ?? 0]) covered += 1;
      if (cutParts === 0) return;
      level = Math.floor((budget - wholeCharacters) / cutParts);
      const smallest = capOf(byCap[covered] ?? 0);
      if (smallest > level) return;
      wholeCharacters += smallest;
      cutParts -= 1;
      covered += 1;
    }
  };

  settle();
  for (let i = caps.length - 1; i >= 0 && cutParts > 0 && level < floor; i--) {
    // A part the level covers now stays covered: the level never falls.
    if (capOf(i) <= level) continue;
    emptied[i] = 1;
    cutParts -= 1;
    settle();
  }

  let spare = budget - wholeCharacters - cutParts * level;
  return caps.map((cap, i) => {
    if (emptied[i]) return 0;
    if (cutParts === 0 || cap <= level) return cap;
    const extra = spare > 0 ? 1 : 0;
    spare -= extra;
    return level + extra;
  });
}
