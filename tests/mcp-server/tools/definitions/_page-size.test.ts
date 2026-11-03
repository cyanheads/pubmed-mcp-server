/**
 * @fileoverview Tests for the page-size helpers shared by the tools that serve
 * an over-cap page size at the cap (issue #232): the advertised ceiling and the
 * clamp notice sentence. The per-tool suites prove only that each tool wires
 * them in.
 * @module tests/mcp-server/tools/definitions/_page-size.test
 */

import { describe, expect, it } from 'vitest';
import { pageSizeCeiling, pageSizeClampNotice } from '@/mcp-server/tools/definitions/_page-size.js';

describe('pageSizeCeiling', () => {
  it.each([
    [50, 500],
    [100, 1000],
    [1000, 10_000],
  ])('advertises ten times a cap of %i', (cap, ceiling) => {
    expect(pageSizeCeiling(cap)).toBe(ceiling);
  });
});

describe('pageSizeClampNotice', () => {
  it('names the field, the requested size, and the cap it is served at', () => {
    expect(pageSizeClampNotice('maxResults', 60, 50)).toBe(
      '`maxResults` 60 is past the per-call cap of 50, so it is served at 50.',
    );
  });

  it('appends the continuation sentence when one is given', () => {
    expect(pageSizeClampNotice('pageSize', 101, 100, 'Pass `offset: 100` for the next page.')).toBe(
      '`pageSize` 101 is past the per-call cap of 100, so it is served at 100. Pass `offset: 100` for the next page.',
    );
  });

  it('adds nothing for an empty continuation', () => {
    expect(pageSizeClampNotice('summaryCount', 51, 50, '')).toBe(
      '`summaryCount` 51 is past the per-call cap of 50, so it is served at 50.',
    );
  });
});
