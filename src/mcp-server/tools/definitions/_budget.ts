/**
 * @fileoverview Whole-response character budgeting shared by the retrieval
 * tools: how many whole items fit under a character ceiling, in order. The
 * sibling of `_text.ts`, which shortens the *inside* of one item's text —
 * nothing here ever cuts into an item. (#99, #100)
 * @module src/mcp-server/tools/definitions/_budget
 */

/**
 * Characters an item contributes to the response, measured as the JSON form it
 * is serialized into for `structuredContent` — every field the record carries,
 * keys included. `JSON.stringify` returns `undefined` for values with no JSON
 * form (`undefined`, a function), which contribute nothing.
 */
export function serializedCharacters(value: unknown): number {
  return JSON.stringify(value)?.length ?? 0;
}

/** How an ordered list of items divides at a character ceiling. */
export interface WholeItemFit<T> {
  /** Items withheld to stay under the ceiling, in their original order. */
  deferred: T[];
  /** Items that fit, in their original order. */
  kept: T[];
  /** Characters the kept items account for. */
  keptCharacters: number;
  /**
   * Size of the next deferred item — `deferred[0]`, the one the cut stopped
   * at. Because the cut is a prefix cut, that item is the ceiling a caller must
   * clear to make progress: a smaller item further down the tail is unreachable
   * until the one in front of it fits. Absent when nothing was deferred.
   */
  nextDeferredCharacters?: number;
}

/**
 * Split an ordered list at the first item that would carry the running
 * character total past `maxCharacters`. That item and everything after it is
 * deferred whole; no item is ever shortened, reordered, or skipped over.
 *
 * The cut is a prefix cut on purpose: skipping a too-large item to fit a later
 * smaller one would leave the caller with a non-contiguous remainder and no way
 * to resume from the deferred list alone. Keeping the cut contiguous makes
 * re-calling with `deferred` exactly equivalent to continuing the first call.
 */
export function fitWholeItems<T>(
  items: readonly T[],
  maxCharacters: number,
  measure: (item: T) => number = serializedCharacters,
): WholeItemFit<T> {
  const kept: T[] = [];
  let keptCharacters = 0;
  let cut = items.length;

  for (const [index, item] of items.entries()) {
    const size = measure(item);
    if (keptCharacters + size > maxCharacters) {
      cut = index;
      break;
    }
    kept.push(item);
    keptCharacters += size;
  }

  const deferred = items.slice(cut);
  const [next] = deferred;
  return {
    kept,
    deferred,
    keptCharacters,
    ...(next !== undefined && { nextDeferredCharacters: measure(next) }),
  };
}
