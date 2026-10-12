/**
 * @fileoverview Whole-response character budgeting shared by the retrieval
 * tools: how many whole items fit under a character ceiling, in order, and the
 * notice that tells a caller how to retrieve the rest. The sibling of
 * `_text.ts`, which shortens the *inside* of one item's text — nothing here
 * ever cuts into an item. (#99, #100, #236)
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
   * at. Because the cut is a prefix cut, it is the continuation ceiling: a call
   * for `deferred` alone returns nothing under it, and a smaller item further
   * down the tail is unreachable until the one in front of it fits. Repeating
   * the same call needs `keptCharacters` + this to return that item as well.
   * Absent when nothing was deferred.
   */
  nextDeferredCharacters?: number;
}

/** The budget state a deferral notice reports — the fields every tool's `deferred` carries. */
export interface DeferralState {
  deferredCount: number;
  maxResponseCharacters: number;
  nextDeferredCharacters: number;
  returnedCharacters: number;
}

/** How one tool names what it deferred and how to ask for it again. */
export interface DeferralWording {
  /** The deferred items as the caller re-sends them, already joined. */
  ids: string;
  /** One deferred item: `article`, `record`. */
  noun: string;
  /** The re-call after its verb — the tool and how the ids go back in. */
  recall: string;
}

/**
 * Compose the recovery notice for items the whole-response budget withheld, so
 * a caller reading only `content[]` can resume without inspecting `deferred`.
 * Each ceiling is named with the call it applies to: re-calling for the
 * deferred items needs `nextDeferredCharacters`; repeating this call needs
 * `returnedCharacters + nextDeferredCharacters`. Both exceed the current
 * ceiling whenever they are named, so the notice never asks for a raise to a
 * value at or below it. (#100, #236)
 */
export function buildDeferralNotice(state: DeferralState, wording: DeferralWording): string {
  const { maxResponseCharacters: max, nextDeferredCharacters: next } = state;
  const { ids, noun, recall } = wording;
  const listed = `${state.deferredCount} resolved ${noun}(s) were deferred whole: ${ids}.`;
  if (state.returnedCharacters === 0) {
    return `The first ${noun} alone exceeds the requested maxResponseCharacters of ${max}, so none were returned. ${listed} Re-call ${recall} and maxResponseCharacters ≥ ${next}, the size of that first ${noun}.`;
  }
  const continuation =
    next <= max
      ? `To continue, re-call ${recall} at the current maxResponseCharacters of ${max}, which already fits the next deferred ${noun} (${next} characters).`
      : `To continue, re-call ${recall} and maxResponseCharacters ≥ ${next}, the size of the next deferred ${noun}.`;
  const repeat = `To return the next deferred ${noun} in this response instead, repeat this call with maxResponseCharacters ≥ ${state.returnedCharacters + next}.`;
  return `Response character budget reached: ${state.returnedCharacters} of ${max} characters returned. ${listed} ${continuation} ${repeat}`;
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
