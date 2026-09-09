/**
 * @fileoverview Tests for the whole-response character budget shared by
 * `pubmed_fetch_articles` and `pubmed_fetch_fulltext` (issues #99, #100).
 * @module tests/mcp-server/tools/definitions/_budget.test
 */

import { describe, expect, it } from 'vitest';

const { fitWholeItems, serializedCharacters } = await import(
  '@/mcp-server/tools/definitions/_budget.js'
);

/** Items measured by an explicit size so the arithmetic is readable. */
const sized = (...sizes: number[]) => sizes.map((size, i) => ({ id: `item-${i}`, size }));
const bySize = (item: { size: number }) => item.size;

describe('serializedCharacters', () => {
  it('measures the JSON form of a record, keys included', () => {
    expect(serializedCharacters({ a: 'xy' })).toBe(JSON.stringify({ a: 'xy' }).length);
  });

  it('counts a value JSON.stringify drops as zero', () => {
    expect(serializedCharacters(undefined)).toBe(0);
  });
});

describe('fitWholeItems', () => {
  it('keeps every item when the ceiling covers them all', () => {
    const items = sized(10, 20, 30);
    const fit = fitWholeItems(items, 100, bySize);

    expect(fit.kept).toEqual(items);
    expect(fit.deferred).toEqual([]);
    expect(fit.keptCharacters).toBe(60);
    expect(fit.nextDeferredCharacters).toBeUndefined();
  });

  it('keeps every item when the total exactly meets the ceiling', () => {
    const items = sized(10, 20, 30);
    const fit = fitWholeItems(items, 60, bySize);

    expect(fit.deferred).toEqual([]);
    expect(fit.keptCharacters).toBe(60);
  });

  it('defers the item that would cross the ceiling by one character', () => {
    const items = sized(10, 20, 30);
    const fit = fitWholeItems(items, 59, bySize);

    expect(fit.kept).toEqual(items.slice(0, 2));
    expect(fit.deferred).toEqual(items.slice(2));
    expect(fit.keptCharacters).toBe(30);
    expect(fit.nextDeferredCharacters).toBe(30);
  });

  it('cuts at the first item that does not fit, never skipping ahead to a smaller one', () => {
    const items = sized(10, 500, 1);
    const fit = fitWholeItems(items, 100, bySize);

    // Item 2 would fit in the remaining 90 characters, but taking it would
    // reorder the response and split the deferred tail into a non-contiguous
    // list the caller cannot resume from.
    expect(fit.kept.map((i) => i.id)).toEqual(['item-0']);
    expect(fit.deferred.map((i) => i.id)).toEqual(['item-1', 'item-2']);
    // The 1-character tail item is unreachable until item-1 fits, so reporting
    // the smallest deferred size would name a ceiling that makes no progress.
    expect(fit.nextDeferredCharacters).toBe(500);
  });

  it('defers everything when the ceiling is under the first item', () => {
    const items = sized(40, 5);
    const fit = fitWholeItems(items, 1, bySize);

    expect(fit.kept).toEqual([]);
    expect(fit.deferred).toEqual(items);
    expect(fit.keptCharacters).toBe(0);
    expect(fit.nextDeferredCharacters).toBe(40);
  });

  it('defers everything for a zero or negative ceiling', () => {
    for (const ceiling of [0, -10]) {
      const fit = fitWholeItems(sized(1, 2), ceiling, bySize);
      expect(fit.kept).toEqual([]);
      expect(fit.deferred).toHaveLength(2);
    }
  });

  it('returns empty results for an empty list', () => {
    const fit = fitWholeItems([], 100, bySize);

    expect(fit.kept).toEqual([]);
    expect(fit.deferred).toEqual([]);
    expect(fit.keptCharacters).toBe(0);
    expect(fit.nextDeferredCharacters).toBeUndefined();
  });

  it('measures items by their serialized size when no measure is supplied', () => {
    const records = [{ a: 'x' }, { b: 'y' }];
    const one = serializedCharacters(records[0]);
    const fit = fitWholeItems(records, one);

    expect(fit.kept).toEqual([records[0]]);
    expect(fit.deferred).toEqual([records[1]]);
    expect(fit.keptCharacters).toBe(one);
  });
});
