/**
 * @fileoverview Tests for the PMID normalizer shared by the PMID-taking tool
 * definitions (issue #161).
 * @module tests/mcp-server/tools/definitions/_schemas.test
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

const schemas = await import('@/mcp-server/tools/definitions/_schemas.js');

describe('normalizePmid', () => {
  it.each([
    ['00000001', '1'],
    ['0023193287', '23193287'],
    ['00000000', '0'],
    ['0', '0'],
    ['1', '1'],
    ['10', '10'],
    ['100', '100'],
    ['23193287', '23193287'],
  ])('normalizes %s to %s', (input, expected) => {
    expect(schemas.normalizePmid(input)).toBe(expected);
  });

  it('returns the canonical decimal form of the number any accepted PMID spells', () => {
    fc.assert(
      fc.property(fc.stringMatching(/^\d{1,30}$/), (pmid) => {
        expect(schemas.pmidStringSchema.safeParse(pmid).success).toBe(true);
        const normalized = schemas.normalizePmid(pmid);
        expect(normalized).toMatch(/^(0|[1-9]\d*)$/);
        expect(normalized).toBe(BigInt(pmid).toString());
        expect(schemas.normalizePmid(normalized)).toBe(normalized);
      }),
      { seed: 161 },
    );
  });
});
