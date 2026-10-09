/**
 * @fileoverview Tests for the lookup-citation tool.
 * @module tests/mcp-server/tools/definitions/lookup-citation.tool.test
 */

import type { ContentBlock } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { toJSONSchema } from 'zod/v4/core';

import { textBlocks } from '../../../_helpers.js';

const mockECitMatch = vi.fn();
const mockESummary = vi.fn();
vi.mock('@/services/ncbi/ncbi-service.js', () => ({
  getNcbiService: () => ({ eCitMatch: mockECitMatch, eSummary: mockESummary }),
}));

const mockExtractBriefSummaries = vi.fn();
vi.mock('@/services/ncbi/parsing/esummary-parser.js', () => ({
  extractBriefSummaries: (...args: unknown[]) => mockExtractBriefSummaries(...args),
}));

const { lookupCitationTool } = await import(
  '@/mcp-server/tools/definitions/lookup-citation.tool.js'
);

describe('lookupCitationTool', () => {
  beforeEach(() => {
    mockECitMatch.mockClear();
    mockESummary.mockClear();
    mockExtractBriefSummaries.mockClear();
    mockESummary.mockResolvedValue({});
    mockExtractBriefSummaries.mockResolvedValue([]);
  });

  it('validates input schema', () => {
    const input = lookupCitationTool.input.parse({
      citations: [{ journal: 'Nature', year: '2020' }],
    });
    expect(input.citations).toHaveLength(1);
  });

  it('rejects empty citations array', () => {
    expect(() => lookupCitationTool.input.parse({ citations: [] })).toThrow();
  });

  it('rejects more than 25 citations', () => {
    const citations = Array.from({ length: 26 }, (_, i) => ({ journal: 'J', key: String(i) }));
    expect(() => lookupCitationTool.input.parse({ citations })).toThrow();
  });

  it('accepts citation with journal only', () => {
    expect(() =>
      lookupCitationTool.input.parse({ citations: [{ journal: 'Nature' }] }),
    ).not.toThrow();
  });

  it('accepts citation with year only', () => {
    expect(() => lookupCitationTool.input.parse({ citations: [{ year: '2020' }] })).not.toThrow();
  });

  it('rejects citation with only authorName (no journal or year) (issue #39)', () => {
    const parsed = lookupCitationTool.input.safeParse({
      citations: [{ authorName: 'smith j' }],
    });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.message).toMatch(/journal or year/);
    expect(parsed.error?.issues[0]?.path).toEqual(['citations', 0]);
  });

  it('rejects citation with only volume (no journal or year) (issue #39)', () => {
    const parsed = lookupCitationTool.input.safeParse({
      citations: [{ volume: '42' }],
    });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.message).toMatch(/journal or year/);
  });

  it('maps matched results with pmid and surfaces first author on clean match', async () => {
    mockECitMatch.mockResolvedValue([
      { key: '1', matched: true, pmid: '8400044', status: 'matched' },
    ]);
    mockExtractBriefSummaries.mockResolvedValue([
      {
        pmid: '8400044',
        authors: 'Mann BJ, Lockhart BE, Albert MJ',
        authorNames: ['Mann BJ', 'Lockhart BE', 'Albert MJ'],
      },
    ]);

    const ctx = createMockContext({ errors: lookupCitationTool.errors });
    const input = lookupCitationTool.input.parse({
      citations: [{ journal: 'proc natl acad sci u s a', year: '1993', authorName: 'mann bj' }],
    });
    const result = await lookupCitationTool.handler(input, ctx);

    expect(result.results).toEqual([
      {
        key: '1',
        matched: true,
        pmid: '8400044',
        status: 'matched',
        matchedFirstAuthor: 'Mann BJ',
      },
    ]);
    expect(result.totalMatched).toBe(1);
    expect(result.totalSubmitted).toBe(1);
    expect(result.totalWarnings).toBe(0);
    expect(mockESummary).toHaveBeenCalledWith(
      { db: 'pubmed', version: '2.0', retmode: 'xml', id: '8400044' },
      expect.objectContaining({ signal: expect.anything() }),
    );
  });

  it('flags author mismatch without dropping the PMID', async () => {
    mockECitMatch.mockResolvedValue([
      { key: 'pioneer-6', matched: true, pmid: '31189511', status: 'matched' },
    ]);
    mockExtractBriefSummaries.mockResolvedValue([
      {
        pmid: '31189511',
        authors: 'Gerstein HC, Colhoun HM, Dagenais GR, et al.',
        authorNames: ['Gerstein HC', 'Colhoun HM', 'Dagenais GR', 'Ryden L'],
      },
    ]);

    const ctx = createMockContext({ errors: lookupCitationTool.errors });
    const input = lookupCitationTool.input.parse({
      citations: [
        {
          authorName: 'husain m',
          journal: 'lancet',
          volume: '394',
          firstPage: '121',
          year: '2019',
          key: 'pioneer-6',
        },
      ],
    });
    const result = await lookupCitationTool.handler(input, ctx);

    const r = result.results[0]!;
    expect(r.pmid).toBe('31189511');
    expect(r.matched).toBe(true);
    expect(r.status).toBe('matched');
    expect(r.matchedFirstAuthor).toBe('Gerstein HC');
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings?.[0]?.code).toBe('author_mismatch');
    expect(r.warnings?.[0]?.message).toContain('husain m');
    // The message reports the full roster size so the truncated display list
    // reads as partial rather than complete.
    expect(r.warnings?.[0]?.message).toContain('4-author roster');
    expect(result.totalWarnings).toBe(1);
  });

  it('does not warn when the queried author ranks fourth or later (#87)', async () => {
    mockECitMatch.mockResolvedValue([
      { key: 'fourth-author', matched: true, pmid: '41952275', status: 'matched' },
    ]);
    // `authors` is the display string — truncated to three names by
    // formatESummaryAuthors. Paramanik S is the genuine fourth author.
    mockExtractBriefSummaries.mockResolvedValue([
      {
        pmid: '41952275',
        authors: 'Das U, Prasad SS, Sahoo T, et al.',
        authorNames: ['Das U', 'Prasad SS', 'Sahoo T', 'Paramanik S', 'Halder A', 'S P'],
      },
    ]);

    const ctx = createMockContext({ errors: lookupCitationTool.errors });
    const input = lookupCitationTool.input.parse({
      citations: [
        {
          journal: 'Plant Signal Behav',
          year: '2026',
          volume: '21',
          firstPage: '2656013',
          authorName: 'paramanik s',
          key: 'fourth-author',
        },
      ],
    });
    const result = await lookupCitationTool.handler(input, ctx);

    const r = result.results[0]!;
    expect(r.pmid).toBe('41952275');
    expect(r.matched).toBe(true);
    expect(r.warnings).toBeUndefined();
    expect(r.matchedFirstAuthor).toBe('Das U');
    expect(result.totalWarnings).toBe(0);
  });

  it('does not warn when the queried author is the last of a long roster (#87)', async () => {
    mockECitMatch.mockResolvedValue([{ key: '1', matched: true, pmid: '555', status: 'matched' }]);
    mockExtractBriefSummaries.mockResolvedValue([
      {
        pmid: '555',
        authors: 'Alpha A, Beta B, Gamma C, et al.',
        authorNames: ['Alpha A', 'Beta B', 'Gamma C', 'Delta D', 'Epsilon E', 'Omega Z'],
      },
    ]);

    const ctx = createMockContext({ errors: lookupCitationTool.errors });
    const input = lookupCitationTool.input.parse({
      citations: [{ journal: 'Nature', year: '2020', authorName: 'omega z' }],
    });
    const result = await lookupCitationTool.handler(input, ctx);

    expect(result.results[0]?.warnings).toBeUndefined();
    expect(result.totalWarnings).toBe(0);
  });

  it('does not false-positive on substring surname collisions (Smith vs Smithson)', async () => {
    mockECitMatch.mockResolvedValue([{ key: '1', matched: true, pmid: '999', status: 'matched' }]);
    mockExtractBriefSummaries.mockResolvedValue([
      { pmid: '999', authors: 'Smithson JA, Jones BB', authorNames: ['Smithson JA', 'Jones BB'] },
    ]);

    const ctx = createMockContext({ errors: lookupCitationTool.errors });
    const input = lookupCitationTool.input.parse({
      citations: [{ journal: 'Nature', year: '2020', authorName: 'smith j' }],
    });
    const result = await lookupCitationTool.handler(input, ctx);

    expect(result.results[0]?.warnings).toHaveLength(1);
    expect(result.results[0]?.warnings?.[0]?.code).toBe('author_mismatch');
  });

  it('skips author verification when authorName is not provided', async () => {
    mockECitMatch.mockResolvedValue([{ key: '1', matched: true, pmid: '111', status: 'matched' }]);
    // A full roster, so a missing authorName is the only thing keeping a warning off
    mockExtractBriefSummaries.mockResolvedValue([
      {
        pmid: '111',
        authors: 'Gerstein HC, Colhoun HM',
        authorNames: ['Gerstein HC', 'Colhoun HM'],
      },
    ]);

    const ctx = createMockContext({ errors: lookupCitationTool.errors });
    const input = lookupCitationTool.input.parse({
      citations: [{ journal: 'Nature', year: '2020', volume: '1', firstPage: '1' }],
    });
    const result = await lookupCitationTool.handler(input, ctx);

    expect(result.results[0]?.warnings).toBeUndefined();
    expect(result.results[0]?.matchedFirstAuthor).toBe('Gerstein HC');
    expect(result.totalWarnings).toBe(0);
  });

  it('skips eSummary when no results matched', async () => {
    mockECitMatch.mockResolvedValue([
      { key: '1', matched: false, pmid: null, status: 'not_found', detail: 'NOT_FOUND' },
    ]);

    const ctx = createMockContext({ errors: lookupCitationTool.errors });
    const input = lookupCitationTool.input.parse({
      citations: [{ journal: 'unknown', year: '2000', authorName: 'smith j' }],
    });
    await lookupCitationTool.handler(input, ctx);

    expect(mockESummary).not.toHaveBeenCalled();
  });

  it('batches eSummary into a single call when multiple citations match', async () => {
    mockECitMatch.mockResolvedValue([
      { key: '1', matched: true, pmid: '111', status: 'matched' },
      { key: '2', matched: true, pmid: '222', status: 'matched' },
      { key: '3', matched: false, pmid: null, status: 'not_found' },
    ]);
    mockExtractBriefSummaries.mockResolvedValue([
      { pmid: '111', authors: 'Alice AA', authorNames: ['Alice AA'] },
      { pmid: '222', authors: 'Bob BB', authorNames: ['Bob BB'] },
    ]);

    const ctx = createMockContext({ errors: lookupCitationTool.errors });
    const input = lookupCitationTool.input.parse({
      citations: [
        { journal: 'A', year: '2020', authorName: 'alice a' },
        { journal: 'B', year: '2020', authorName: 'bob b' },
        { journal: 'C', year: '2020', authorName: 'carol c' },
      ],
    });
    await lookupCitationTool.handler(input, ctx);

    expect(mockESummary).toHaveBeenCalledTimes(1);
    expect(mockESummary).toHaveBeenCalledWith(
      { db: 'pubmed', version: '2.0', retmode: 'xml', id: '111,222' },
      expect.anything(),
    );
  });

  it('flags year mismatch without dropping the PMID', async () => {
    mockECitMatch.mockResolvedValue([
      { key: '1', matched: true, pmid: '12345', status: 'matched' },
    ]);
    mockExtractBriefSummaries.mockResolvedValue([
      { pmid: '12345', authors: 'Smith JA, Jones BB', pubDate: '2021-03-15' },
    ]);

    const ctx = createMockContext({ errors: lookupCitationTool.errors });
    const input = lookupCitationTool.input.parse({
      citations: [{ journal: 'Nature', year: '2019', volume: '5', firstPage: '1' }],
    });
    const result = await lookupCitationTool.handler(input, ctx);

    const r = result.results[0]!;
    expect(r.pmid).toBe('12345');
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings?.[0]?.code).toBe('year_mismatch');
    expect(r.warnings?.[0]?.message).toContain('2019');
    expect(r.warnings?.[0]?.message).toContain('2021');
    expect(result.totalWarnings).toBe(1);
  });

  it('does not flag year when queried year matches matched article year', async () => {
    mockECitMatch.mockResolvedValue([
      { key: '1', matched: true, pmid: '12345', status: 'matched' },
    ]);
    mockExtractBriefSummaries.mockResolvedValue([
      { pmid: '12345', authors: 'Smith JA', authorNames: ['Smith JA'], pubDate: '2020-01-01' },
    ]);

    const ctx = createMockContext({ errors: lookupCitationTool.errors });
    const input = lookupCitationTool.input.parse({
      citations: [{ journal: 'Nature', year: '2020', authorName: 'smith j' }],
    });
    const result = await lookupCitationTool.handler(input, ctx);

    expect(result.results[0]?.warnings).toBeUndefined();
    expect(result.totalWarnings).toBe(0);
  });

  it('stacks author and year mismatch warnings on the same result', async () => {
    mockECitMatch.mockResolvedValue([
      { key: '1', matched: true, pmid: '31189511', status: 'matched' },
    ]);
    mockExtractBriefSummaries.mockResolvedValue([
      {
        pmid: '31189511',
        authors: 'Gerstein HC, Colhoun HM',
        authorNames: ['Gerstein HC', 'Colhoun HM'],
        pubDate: '2020-01-01',
      },
    ]);

    const ctx = createMockContext({ errors: lookupCitationTool.errors });
    const input = lookupCitationTool.input.parse({
      citations: [{ authorName: 'husain m', journal: 'lancet', volume: '394', year: '2019' }],
    });
    const result = await lookupCitationTool.handler(input, ctx);

    const codes = result.results[0]?.warnings?.map((w) => w.code).sort();
    expect(codes).toEqual(['author_mismatch', 'year_mismatch']);
    expect(result.totalWarnings).toBe(1);
  });

  it('exposes candidatePmids for AMBIGUOUS matches', async () => {
    mockECitMatch.mockResolvedValue([
      {
        key: '1',
        matched: false,
        pmid: null,
        status: 'ambiguous',
        detail: 'AMBIGUOUS 33057196,32076266,32025019',
        candidatePmids: ['33057196', '32076266', '32025019'],
      },
    ]);

    const ctx = createMockContext({ errors: lookupCitationTool.errors });
    const input = lookupCitationTool.input.parse({
      citations: [{ journal: 'Nature', year: '2020', authorName: 'zhang f' }],
    });
    const result = await lookupCitationTool.handler(input, ctx);

    expect(result.results[0]?.candidatePmids).toEqual(['33057196', '32076266', '32025019']);
    expect(result.results[0]?.detail).toBe('AMBIGUOUS 33057196,32076266,32025019');
    expect(mockESummary).not.toHaveBeenCalled();
  });

  it('preserves not_found status for unmatched results', async () => {
    mockECitMatch.mockResolvedValue([
      { key: '1', matched: false, pmid: null, status: 'not_found', detail: 'NOT_FOUND' },
    ]);

    const ctx = createMockContext({ errors: lookupCitationTool.errors });
    const input = lookupCitationTool.input.parse({
      citations: [{ journal: 'unknown journal', year: '2000' }],
    });
    const result = await lookupCitationTool.handler(input, ctx);

    expect(result.results[0]).toEqual({
      key: '1',
      matched: false,
      status: 'not_found',
      detail: 'NOT_FOUND',
    });
    expect(result.results[0]).not.toHaveProperty('pmid');
  });

  it('preserves ambiguous status and detail for recovery guidance', async () => {
    mockECitMatch.mockResolvedValue([
      {
        key: '1',
        matched: false,
        pmid: null,
        status: 'ambiguous',
        detail: 'AMBIGUOUS citation',
      },
    ]);

    const ctx = createMockContext({ errors: lookupCitationTool.errors });
    const input = lookupCitationTool.input.parse({
      citations: [{ journal: 'Nature', year: '2020' }],
    });
    const result = await lookupCitationTool.handler(input, ctx);

    expect(result.results[0]).toEqual({
      key: '1',
      matched: false,
      status: 'ambiguous',
      detail: 'AMBIGUOUS citation',
    });
  });

  it('auto-assigns sequential keys when not provided', async () => {
    mockECitMatch.mockResolvedValue([
      { key: '1', matched: true, pmid: '111', status: 'matched' },
      { key: '2', matched: true, pmid: '222', status: 'matched' },
    ]);

    const ctx = createMockContext({ errors: lookupCitationTool.errors });
    const input = lookupCitationTool.input.parse({
      citations: [
        { journal: 'Nature', year: '2020' },
        { journal: 'Science', year: '2021' },
      ],
    });
    await lookupCitationTool.handler(input, ctx);

    const call = mockECitMatch.mock.calls[0]?.[0] ?? [];
    expect(call[0]?.key).toBe('1');
    expect(call[1]?.key).toBe('2');
  });

  describe('colliding citation keys (issue #113)', () => {
    /**
     * The reproduction payload from the issue: an explicit key "2" on the first
     * citation collides with the positional key auto-assigned to the second.
     * `eCitMatch` returns one row per submitted citation in submission order,
     * each carrying the caller's (repeated) label.
     */
    const collidingInput = {
      citations: [
        {
          journal: 'Eur Respir J',
          year: '2024',
          volume: '64',
          authorName: 'Gauvreau GM',
          key: '2',
        },
        {
          journal: 'N Engl J Med',
          year: '2024',
          volume: '390',
          firstPage: '889',
          authorName: 'Wood RA',
        },
      ],
    };

    function mockCollidingMatch() {
      mockECitMatch.mockResolvedValue([
        { key: '2', matched: true, pmid: '39060015', status: 'matched' },
        { key: '2', matched: true, pmid: '38407394', status: 'matched' },
      ]);
    }

    it('keeps each result on its own PMID and verifies its own queried author', async () => {
      mockCollidingMatch();
      mockExtractBriefSummaries.mockResolvedValue([
        {
          pmid: '39060015',
          authors: 'Gauvreau GM, Davis BE',
          authorNames: ['Gauvreau GM', 'Davis BE'],
          pubDate: '2024 Jul 11',
        },
        {
          pmid: '38407394',
          authors: 'Wood RA, Togias A',
          authorNames: ['Wood RA', 'Togias A'],
          pubDate: '2024 Mar 07',
        },
      ]);

      const ctx = createMockContext({ errors: lookupCitationTool.errors });
      const result = await lookupCitationTool.handler(
        lookupCitationTool.input.parse(collidingInput),
        ctx,
      );

      expect(result.results.map((r) => r.pmid)).toEqual(['39060015', '38407394']);
      expect(result.results.map((r) => r.matchedFirstAuthor)).toEqual(['Gauvreau GM', 'Wood RA']);
      expect(result.results.map((r) => r.warnings)).toEqual([undefined, undefined]);
      expect(result.totalMatched).toBe(2);
      expect(result.totalWarnings).toBe(0);

      const text = textBlocks(lookupCitationTool.format!(result))[0]?.text ?? '';
      expect(text).toContain('39060015');
      expect(text).toContain('38407394');
      // Both citations carry key "2", so the heading needs the submission index
      // to tell the two rendered blocks apart. (#128)
      expect(text).toContain('### 1 · 2');
      expect(text).toContain('### 2 · 2');
    });

    it('renders distinct headings when a third key already ends in " (1)" (#128)', async () => {
      mockECitMatch.mockResolvedValue([
        { key: 'dup', matched: true, pmid: '39060015', status: 'matched' },
        { key: 'dup', matched: true, pmid: '38407394', status: 'matched' },
        { key: 'dup (1)', matched: true, pmid: '31189511', status: 'matched' },
      ]);
      mockExtractBriefSummaries.mockResolvedValue([
        { pmid: '39060015', authors: 'Gauvreau GM', authorNames: ['Gauvreau GM'] },
        { pmid: '38407394', authors: 'Wood RA', authorNames: ['Wood RA'] },
        { pmid: '31189511', authors: 'Gerstein HC', authorNames: ['Gerstein HC'] },
      ]);

      const ctx = createMockContext({ errors: lookupCitationTool.errors });
      const result = await lookupCitationTool.handler(
        lookupCitationTool.input.parse({
          citations: [
            { journal: 'Eur Respir J', year: '2024', authorName: 'Gauvreau GM', key: 'dup' },
            { journal: 'N Engl J Med', year: '2024', authorName: 'Wood RA', key: 'dup' },
            { journal: 'Lancet', year: '2019', authorName: 'Gerstein HC', key: 'dup (1)' },
          ],
        }),
        ctx,
      );

      // structuredContent keeps the caller's labels exactly as submitted.
      expect(result.results.map((r) => r.key)).toEqual(['dup', 'dup', 'dup (1)']);
      expect(result.results.map((r) => r.pmid)).toEqual(['39060015', '38407394', '31189511']);

      const text = textBlocks(lookupCitationTool.format!(result))[0]?.text ?? '';
      const headings = text.split('\n').filter((line) => line.startsWith('### '));
      // A " (<n>)" suffix would render the first result as "dup (1)" — the third
      // citation's own key — so the index leads instead.
      expect(headings).toEqual(['### 1 · dup', '### 2 · dup', '### 3 · dup (1)']);
      expect(new Set(headings).size).toBe(3);
    });

    it('attributes an author_mismatch warning to the citation that queried it', async () => {
      mockCollidingMatch();
      // The first citation's queried author is absent from its matched article;
      // the second citation's author is present in its own.
      mockExtractBriefSummaries.mockResolvedValue([
        {
          pmid: '39060015',
          authors: 'Lommatzsch M, Marchewski H',
          authorNames: ['Lommatzsch M', 'Marchewski H'],
          pubDate: '2024 Jul 11',
        },
        {
          pmid: '38407394',
          authors: 'Wood RA, Togias A',
          authorNames: ['Wood RA', 'Togias A'],
          pubDate: '2024 Mar 07',
        },
      ]);

      const ctx = createMockContext({ errors: lookupCitationTool.errors });
      const result = await lookupCitationTool.handler(
        lookupCitationTool.input.parse(collidingInput),
        ctx,
      );

      expect(result.results[0]?.warnings?.map((w) => w.code)).toEqual(['author_mismatch']);
      expect(result.results[0]?.warnings?.[0]?.message).toContain('Gauvreau GM');
      expect(result.results[1]?.warnings).toBeUndefined();
      expect(result.totalWarnings).toBe(1);

      const text = textBlocks(lookupCitationTool.format!(result))[0]?.text ?? '';
      expect(text).toContain('Gauvreau GM');
    });

    it('attributes a year_mismatch warning to the citation that queried it', async () => {
      mockECitMatch.mockResolvedValue([
        { key: 'dup', matched: true, pmid: '111', status: 'matched' },
        { key: 'dup', matched: true, pmid: '222', status: 'matched' },
      ]);
      mockExtractBriefSummaries.mockResolvedValue([
        { pmid: '111', authors: 'Alpha A', authorNames: ['Alpha A'], pubDate: '1999 Jan' },
        { pmid: '222', authors: 'Beta B', authorNames: ['Beta B'], pubDate: '2021 Feb' },
      ]);

      const ctx = createMockContext({ errors: lookupCitationTool.errors });
      const result = await lookupCitationTool.handler(
        lookupCitationTool.input.parse({
          citations: [
            { journal: 'Nature', year: '1999', authorName: 'Alpha A', key: 'dup' },
            { journal: 'Science', year: '2020', authorName: 'Beta B', key: 'dup' },
          ],
        }),
        ctx,
      );

      expect(result.results[0]?.warnings).toBeUndefined();
      expect(result.results[1]?.warnings?.map((w) => w.code)).toEqual(['year_mismatch']);
      expect(result.results[1]?.warnings?.[0]?.message).toContain('"2020"');
      expect(result.totalWarnings).toBe(1);
    });
  });

  describe('bdata-hazardous characters in interpolated fields (issue #125)', () => {
    /**
     * `journal`, `year`, `volume`, `firstPage`, and `authorName` are all
     * interpolated into ECitMatch's pipe-delimited `bdata` line, and the
     * citations of one request are joined with `\r`. A `|`, `\r`, or `\n` in any
     * of them shifts the field layout, so each is rejected at the schema and the
     * request never leaves the process.
     */
    it.each([
      ['journal', { journal: 'N Engl|J Med', year: '2024' }],
      ['authorName', { journal: 'N Engl J Med', year: '2024', authorName: 'Wood|RA' }],
      ['volume', { journal: 'N Engl J Med', year: '2024', volume: '39|0' }],
      ['firstPage', { journal: 'N Engl J Med', year: '2024', firstPage: '88|9' }],
    ])('rejects a pipe in %s', async (field, citation) => {
      const parsed = lookupCitationTool.input.safeParse({ citations: [citation] });

      expect(parsed.success).toBe(false);
      expect(parsed.error?.issues[0]?.path).toEqual(['citations', 0, field]);
      expect(parsed.error?.issues[0]?.message).toMatch(/pipe/i);
      expect(mockECitMatch).not.toHaveBeenCalled();
    });

    // `year` admits only four digits and space/tab padding, so its pattern
    // already excludes every bdata-hazardous character. (#187)
    it.each([['20|24'], ['20\r24'], ['2024\n']])('rejects %j in year as one issue', (year) => {
      const parsed = lookupCitationTool.input.safeParse({
        citations: [{ journal: 'N Engl J Med', year }],
      });

      expect(parsed.success).toBe(false);
      expect(parsed.error?.issues).toHaveLength(1);
      expect(parsed.error?.issues[0]?.path).toEqual(['citations', 0, 'year']);
      expect(mockECitMatch).not.toHaveBeenCalled();
    });

    it.each([
      ['carriage return', '\r'],
      ['newline', '\n'],
    ])('rejects a %s in authorName', async (_label, char) => {
      const parsed = lookupCitationTool.input.safeParse({
        citations: [{ journal: 'N Engl J Med', year: '2024', authorName: `Wood${char}RA` }],
      });

      expect(parsed.success).toBe(false);
      expect(parsed.error?.issues[0]?.path).toEqual(['citations', 0, 'authorName']);
      expect(parsed.error?.issues[0]?.message).toMatch(/line break/i);
      expect(mockECitMatch).not.toHaveBeenCalled();
    });

    it.each([
      ['carriage return', '\r'],
      ['newline', '\n'],
    ])('rejects a %s in journal', async (_label, char) => {
      const parsed = lookupCitationTool.input.safeParse({
        citations: [{ journal: `N Engl${char}J Med`, year: '2024' }],
      });

      expect(parsed.success).toBe(false);
      expect(parsed.error?.issues[0]?.path).toEqual(['citations', 0, 'journal']);
      expect(mockECitMatch).not.toHaveBeenCalled();
    });

    it('still accepts a pipe in the caller-supplied key', async () => {
      mockECitMatch.mockResolvedValue([
        { key: 'a|b', matched: true, pmid: '38407394', status: 'matched' },
      ]);
      mockExtractBriefSummaries.mockResolvedValue([
        {
          pmid: '38407394',
          authors: 'Wood RA, Togias A',
          authorNames: ['Wood RA', 'Togias A'],
          pubDate: '2024 Mar 07',
        },
      ]);

      const ctx = createMockContext({ errors: lookupCitationTool.errors });
      const result = await lookupCitationTool.handler(
        lookupCitationTool.input.parse({
          citations: [
            {
              journal: 'N Engl J Med',
              year: '2024',
              volume: '390',
              firstPage: '889',
              authorName: 'Wood RA',
              key: 'a|b',
            },
          ],
        }),
        ctx,
      );

      expect(result.results[0]).toMatchObject({
        key: 'a|b',
        matched: true,
        pmid: '38407394',
        status: 'matched',
      });

      const text = textBlocks(lookupCitationTool.format!(result))[0]?.text ?? '';
      expect(text).toContain('### 1 · a|b');
    });
  });

  it('preserves user-provided keys', async () => {
    mockECitMatch.mockResolvedValue([
      { key: 'ref-A', matched: true, pmid: '111', status: 'matched' },
    ]);

    const ctx = createMockContext({ errors: lookupCitationTool.errors });
    const input = lookupCitationTool.input.parse({
      citations: [{ journal: 'Nature', year: '2020', key: 'ref-A' }],
    });
    await lookupCitationTool.handler(input, ctx);

    expect(mockECitMatch.mock.calls[0]?.[0]?.[0]?.key).toBe('ref-A');
  });

  it('rejects citation with no bibliographic fields (issue #46)', () => {
    const parsed = lookupCitationTool.input.safeParse({ citations: [{ key: 'empty' }] });

    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.message).toMatch(/journal or year/);
    expect(parsed.error?.issues[0]?.path).toEqual(['citations', 0]);
    expect(mockECitMatch).not.toHaveBeenCalled();
  });

  it('counts matches correctly in mixed results', async () => {
    mockECitMatch.mockResolvedValue([
      { key: '1', matched: true, pmid: '111', status: 'matched' },
      { key: '2', matched: false, pmid: null, status: 'not_found', detail: 'NOT_FOUND' },
      { key: '3', matched: true, pmid: '333', status: 'matched' },
    ]);

    const ctx = createMockContext({ errors: lookupCitationTool.errors });
    const input = lookupCitationTool.input.parse({
      citations: [
        { journal: 'A', year: '2020' },
        { journal: 'B', year: '2020' },
        { journal: 'C', year: '2020' },
      ],
    });
    const result = await lookupCitationTool.handler(input, ctx);

    expect(result.totalMatched).toBe(2);
    expect(result.totalSubmitted).toBe(3);
  });

  it('maps all service results including synthesized not_found rows (issue #54)', async () => {
    // The service layer (eCitMatch) guarantees one row per submitted citation,
    // synthesizing not_found for any upstream-dropped rows. The handler must
    // pass all rows through correctly, including the synthesized ones.
    mockECitMatch.mockResolvedValue([
      { key: 'minimal', matched: false, pmid: null, status: 'not_found', detail: 'NOT_FOUND' },
      { key: 'ambiguous', matched: false, pmid: null, status: 'not_found' },
      { key: 'no-match', matched: false, pmid: null, status: 'not_found' },
    ]);

    const ctx = createMockContext({ errors: lookupCitationTool.errors });
    const input = lookupCitationTool.input.parse({
      citations: [
        { key: 'minimal', journal: 'Nature', year: '2099', volume: '999', firstPage: '1' },
        { key: 'ambiguous', journal: 'Science', year: '2020' },
        { key: 'no-match', journal: 'Lancet', year: '2021' },
      ],
    });
    const result = await lookupCitationTool.handler(input, ctx);

    expect(result.results).toHaveLength(3);
    expect(result.totalSubmitted).toBe(3);
    expect(result.results[0]?.key).toBe('minimal');
    expect(result.results[0]?.status).toBe('not_found');
    expect(result.results[1]?.key).toBe('ambiguous');
    expect(result.results[1]?.matched).toBe(false);
    expect(result.results[1]?.status).toBe('not_found');
    expect(result.results[2]?.key).toBe('no-match');
    expect(result.results[2]?.matched).toBe(false);
    expect(result.results[2]?.status).toBe('not_found');
    expect(result.totalMatched).toBe(0);
    expect(mockESummary).not.toHaveBeenCalled();
  });

  it('passes provided fields through to service', async () => {
    mockECitMatch.mockResolvedValue([{ key: '1', matched: true, pmid: '111', status: 'matched' }]);

    const ctx = createMockContext({ errors: lookupCitationTool.errors });
    const input = lookupCitationTool.input.parse({
      citations: [{ journal: 'Nature', firstPage: '42', year: '2020', authorName: 'smith' }],
    });
    await lookupCitationTool.handler(input, ctx);

    expect(mockECitMatch.mock.calls[0]?.[0]?.[0]).toMatchObject({
      journal: 'Nature',
      firstPage: '42',
      year: '2020',
      authorName: 'smith',
      key: '1',
    });
  });

  it('formats matched citations with PMID', () => {
    const blocks = textBlocks(
      lookupCitationTool.format!({
        results: [{ key: 'ref-1', matched: true, pmid: '8400044', status: 'matched' }],
        totalMatched: 1,
        totalSubmitted: 1,
        totalWarnings: 0,
      }),
    );

    expect(blocks[0]?.text).toContain('**Matched:** 1/1');
    // The 1-based submission index leads every heading, collision or not. (#128)
    expect(blocks[0]?.text).toContain('### 1 · ref-1');
    expect(blocks[0]?.text).toContain('**PMID:** 8400044');
    expect(blocks[0]?.text).toContain(
      'PMID is ready for downstream PubMed fetch or citation tools.',
    );
    expect(blocks[0]?.text).not.toContain('**Warnings:**');
  });

  it('formats matched citation with author mismatch warning', () => {
    const blocks = textBlocks(
      lookupCitationTool.format!({
        results: [
          {
            key: 'pioneer-6',
            matched: true,
            pmid: '31189511',
            status: 'matched',
            matchedFirstAuthor: 'Gerstein HC',
            warnings: [
              {
                code: 'author_mismatch',
                message: 'Queried author "husain m" not found in matched article authors.',
              },
            ],
          },
        ],
        totalMatched: 1,
        totalSubmitted: 1,
        totalWarnings: 1,
      }),
    );

    expect(blocks[0]?.text).toContain('**Warnings:** 1');
    expect(blocks[0]?.text).toContain('**First Author:** Gerstein HC');
    expect(blocks[0]?.text).toContain('[author_mismatch]');
    expect(blocks[0]?.text).toContain('author_mismatch detected');
  });

  it('formats unmatched citations with recovery guidance', () => {
    const blocks = textBlocks(
      lookupCitationTool.format!({
        results: [{ key: 'ref-1', matched: false, status: 'not_found', detail: 'NOT_FOUND' }],
        totalMatched: 0,
        totalSubmitted: 1,
        totalWarnings: 0,
      }),
    );

    expect(blocks[0]?.text).toContain('**Matched:** 0/1');
    expect(blocks[0]?.text).toContain('**Status:** No match');
    expect(blocks[0]?.text).toContain('Verify the citation details or try pubmed_search_articles.');
  });

  it('formats ambiguous citations with disambiguation guidance', () => {
    const blocks = textBlocks(
      lookupCitationTool.format!({
        results: [
          {
            key: 'ref-1',
            matched: false,
            status: 'ambiguous',
            detail: 'AMBIGUOUS multiple matches',
          },
        ],
        totalMatched: 0,
        totalSubmitted: 1,
        totalWarnings: 0,
      }),
    );

    expect(blocks[0]?.text).toContain('**Status:** Ambiguous');
    expect(blocks[0]?.text).toContain('AMBIGUOUS multiple matches');
    expect(blocks[0]?.text).toContain(
      'Add more citation fields such as journal, year, volume, firstPage, or authorName, then retry.',
    );
  });

  it('formats ambiguous citations with candidatePmids list and fetch hint', () => {
    const blocks = textBlocks(
      lookupCitationTool.format!({
        results: [
          {
            key: 'ref-1',
            matched: false,
            status: 'ambiguous',
            detail: 'AMBIGUOUS 33057196,32076266,32025019',
            candidatePmids: ['33057196', '32076266', '32025019'],
          },
        ],
        totalMatched: 0,
        totalSubmitted: 1,
        totalWarnings: 0,
      }),
    );

    expect(blocks[0]?.text).toContain('**Candidate PMIDs:** 33057196, 32076266, 32025019');
    expect(blocks[0]?.text).toContain('pubmed_fetch_articles');
  });

  it('formats matched citation with combined author + year mismatch next-step', () => {
    const blocks = textBlocks(
      lookupCitationTool.format!({
        results: [
          {
            key: 'ref-1',
            matched: true,
            pmid: '123',
            status: 'matched',
            warnings: [
              { code: 'author_mismatch', message: 'authors disagree' },
              { code: 'year_mismatch', message: 'year disagree' },
            ],
          },
        ],
        totalMatched: 1,
        totalSubmitted: 1,
        totalWarnings: 1,
      }),
    );

    expect(blocks[0]?.text).toContain('author_mismatch + year_mismatch detected');
  });
});

describe('a single citation object and the `citation` alias (issue #156)', () => {
  const PNAS = {
    journal: 'proc natl acad sci u s a',
    year: '1991',
    volume: '88',
    firstPage: '3248',
    authorName: 'mann bj',
  };
  const NATURE = { journal: 'Nature', year: '2020' };

  /** Raw client arguments — the alias is never part of the typed input. */
  const callRaw = (args: Record<string, unknown>) =>
    runToolContract(lookupCitationTool, args as never);

  const textOf = (result: Awaited<ReturnType<typeof runToolContract>>) =>
    textBlocks(result.content as ContentBlock[])
      .map((b) => b.text)
      .join('\n');

  beforeEach(() => {
    mockECitMatch.mockReset();
    mockESummary.mockReset();
    mockExtractBriefSummaries.mockReset();
    mockESummary.mockResolvedValue({});
    mockExtractBriefSummaries.mockResolvedValue([]);
    // One row per submitted citation, in order — what the service guarantees.
    mockECitMatch.mockImplementation(async (citations: { key: string }[]) =>
      citations.map((c, i) => ({
        key: c.key,
        matched: true,
        pmid: String(2_000_000 + i),
        status: 'matched',
      })),
    );
  });

  it('parses a single object under `citations` into a one-element array (issue #173)', () => {
    const input = lookupCitationTool.input.parse({ citations: PNAS });
    expect(input.citations).toEqual([PNAS]);
  });

  it('handles a single `citations` object as a one-element batch', async () => {
    const ctx = createMockContext({ errors: lookupCitationTool.errors });
    const result = await lookupCitationTool.handler(
      lookupCitationTool.input.parse({ citations: PNAS }),
      ctx,
    );

    expect(mockECitMatch).toHaveBeenCalledTimes(1);
    expect(mockECitMatch.mock.calls[0]?.[0]).toEqual([{ ...PNAS, key: '1' }]);
    expect(result.results).toEqual([
      { key: '1', matched: true, pmid: '2000000', status: 'matched' },
    ]);
    expect(result.totalSubmitted).toBe(1);
  });

  it('resolves `citation` with one object as a one-element `citations` array, on both surfaces', async () => {
    const result = await callRaw({ citation: PNAS });

    expect(result.isError).toBeFalsy();
    expect(mockECitMatch.mock.calls[0]?.[0]).toEqual([{ ...PNAS, key: '1' }]);
    expect(result.structuredContent).toMatchObject({
      results: [{ key: '1', pmid: '2000000', status: 'matched' }],
      totalMatched: 1,
      totalSubmitted: 1,
    });
    const text = textOf(result);
    expect(text).toContain('**Matched:** 1/1');
    expect(text).toContain('### 1 · 1');
    expect(text).toContain('**PMID:** 2000000');
  });

  it('resolves `citation` with an array exactly as `citations` with the same array', async () => {
    const aliased = await callRaw({ citation: [PNAS, NATURE] });
    const aliasedCall = mockECitMatch.mock.calls[0]?.[0];
    mockECitMatch.mockClear();
    const canonical = await callRaw({ citations: [PNAS, NATURE] });

    expect(aliased.isError).toBeFalsy();
    expect(aliasedCall).toEqual(mockECitMatch.mock.calls[0]?.[0]);
    expect(aliased).toEqual(canonical);
    expect(canonical.structuredContent).toMatchObject({ totalSubmitted: 2, totalMatched: 2 });
    expect(textOf(canonical)).toContain('### 2 · 2');
  });

  it('reads a single object the same as a one-element array on both surfaces', async () => {
    const single = await callRaw({ citations: NATURE });
    const wrapped = await callRaw({ citations: [NATURE] });

    expect(single.isError).toBeFalsy();
    expect(single).toEqual(wrapped);
  });

  it('rejects a call carrying both `citation` and `citations`', async () => {
    const result = await callRaw({ citation: PNAS, citations: [NATURE] });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('Unrecognized key: "citation"');
    expect(textOf(result)).toContain(
      'Recovery: citation is an alias of citations; send one of them, not both.',
    );
    expect(mockECitMatch).not.toHaveBeenCalled();
  });

  it('rejects `citation` once its inputAliases entry is removed', async () => {
    expect(lookupCitationTool.inputAliases).toEqual({ citation: 'citations' });
    const { inputAliases: _declared, ...undeclared } = lookupCitationTool;
    const result = await runToolContract(undeclared, { citation: PNAS } as never);

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('Unrecognized key: "citation"');
  });

  describe('validation messages for either shape', () => {
    // A lone object is wrapped before validation, so its issues carry element index 0. (#173)
    it('names the field and the pipe rule for a single object', () => {
      const parsed = lookupCitationTool.input.safeParse({
        citations: { journal: 'N Engl|J Med', year: '2024' },
      });

      expect(parsed.success).toBe(false);
      expect(parsed.error?.issues).toHaveLength(1);
      expect(parsed.error?.issues[0]?.path).toEqual(['citations', 0, 'journal']);
      expect(parsed.error?.issues[0]?.message).toMatch(/pipe/i);
    });

    it('requires journal or year on a single object', () => {
      const parsed = lookupCitationTool.input.safeParse({ citations: { authorName: 'smith j' } });

      expect(parsed.success).toBe(false);
      expect(parsed.error?.issues[0]?.path).toEqual(['citations', 0]);
      expect(parsed.error?.issues[0]?.message).toMatch(/journal or year/);
    });

    it('names the element index for a bad entry deep in an array', () => {
      const parsed = lookupCitationTool.input.safeParse({
        citations: [NATURE, PNAS, { journal: 'Lancet', year: '2021', volume: '39|7' }],
      });

      expect(parsed.success).toBe(false);
      expect(parsed.error?.issues).toHaveLength(1);
      expect(parsed.error?.issues[0]?.path).toEqual(['citations', 2, 'volume']);
      expect(parsed.error?.issues[0]?.message).toMatch(/pipe/i);
    });

    it('states both accepted shapes when the value is neither an object nor an array', () => {
      const parsed = lookupCitationTool.input.safeParse({ citations: 'Nature 2020' });

      expect(parsed.success).toBe(false);
      expect(parsed.error?.issues[0]?.path).toEqual(['citations']);
      expect(parsed.error?.issues[0]?.message).toMatch(
        /citation object or an array of 1–25 citation objects/,
      );
    });

    /**
     * A string has a `length`, so the array's length checks used to run after its
     * type check failed and report the same shape message a second time.
     */
    it.each([
      ['longer than 25 characters', 'Nature 2020;580:123-126 Smith J et al.'],
      ['of 1–25 characters', 'Nature 2020'],
      ['that is empty', ''],
    ])('reports a string %s as one shape issue', (_label, citations) => {
      const parsed = lookupCitationTool.input.safeParse({ citations });

      expect(parsed.success).toBe(false);
      expect(parsed.error?.issues).toHaveLength(1);
      expect(parsed.error?.issues[0]).toMatchObject({
        code: 'invalid_type',
        expected: 'array',
        path: ['citations'],
        message: 'Invalid input: expected a citation object or an array of 1–25 citation objects',
      });
    });

    it.each([
      ['longer than 25 characters', 'Nature 2020;580:123-126 Smith J et al.'],
      ['that is empty', ''],
    ])(
      'states the shape once, with the array recovery, for a string %s',
      async (_label, citations) => {
        const result = await callRaw({ citations });

        expect(result.isError).toBe(true);
        expect(result.structuredContent).toMatchObject({
          error: {
            code: JsonRpcErrorCode.InvalidParams,
            data: {
              reason: 'invalid_arguments',
              recovery: { hint: 'Send citations as an array, not a string.' },
            },
          },
        });
        const text = textOf(result);
        expect(text.split('expected a citation object or an array').length - 1).toBe(1);
        expect(text).toContain('Recovery: Send citations as an array, not a string.');
        expect(mockECitMatch).not.toHaveBeenCalled();
      },
    );

    /**
     * The caller-facing text must name the element, the field, and what was wrong
     * with it. A boolean, because the framework repairs an integer sent for a string.
     */
    it('names the element and field of a wrong-typed value inside an array', async () => {
      const result = await callRaw({ citations: [NATURE, { journal: true, year: '1991' }] });

      expect(result.isError).toBe(true);
      const text = textOf(result);
      expect(text).toContain(
        'citations.1.journal: Invalid input: expected string, received boolean',
      );
      expect(mockECitMatch).not.toHaveBeenCalled();
    });

    /**
     * The repair reaches a field inside an array element. Behind a top-level union
     * the whole value fails as one issue at `citations`, which it never reaches. (#173)
     */
    it('accepts an integer sent for a string field inside an array, as every tool does', async () => {
      const result = await callRaw({ citations: [NATURE, { journal: 'Lancet', year: 1991 }] });

      expect(result.isError).toBeFalsy();
      expect(mockECitMatch.mock.calls[0]?.[0]?.[1]).toMatchObject({
        journal: 'Lancet',
        year: '1991',
      });
    });

    it('still bounds the array at 25 citations and rejects an empty one', () => {
      const many = Array.from({ length: 26 }, () => NATURE);
      expect(lookupCitationTool.input.safeParse({ citations: many }).success).toBe(false);
      expect(lookupCitationTool.input.safeParse({ citations: [] }).success).toBe(false);
    });
  });

  describe('`citations` advertised as an array (issue #173)', () => {
    it('advertises `citations` as an array of 1–25 citation objects, with no anyOf', () => {
      const emitted = toJSONSchema(lookupCitationTool.input as never, {
        target: 'draft-7',
        io: 'input',
      }) as { properties?: Record<string, Record<string, unknown>>; required?: string[] };
      const citations = emitted.properties?.citations;

      expect(emitted.required).toEqual(['citations']);
      expect(citations).toMatchObject({
        type: 'array',
        minItems: 1,
        maxItems: 25,
        items: {
          type: 'object',
          properties: { journal: { type: 'string', pattern: expect.any(String) } },
        },
      });
      expect(citations).not.toHaveProperty('anyOf');
      expect(citations?.description).toEqual(expect.any(String));
    });

    it('serves a lone object, the `citation` alias, and a one-element array identically', async () => {
      const lone = await callRaw({ citations: PNAS });
      const aliased = await callRaw({ citation: PNAS });
      const wrapped = await callRaw({ citations: [PNAS] });

      expect(wrapped.isError).toBeFalsy();
      expect(lone).toEqual(wrapped);
      expect(aliased).toEqual(wrapped);
      expect(mockECitMatch.mock.calls.map((call) => call[0])).toEqual([
        [{ ...PNAS, key: '1' }],
        [{ ...PNAS, key: '1' }],
        [{ ...PNAS, key: '1' }],
      ]);
    });

    it('names both accepted shapes when `citations` is missing', async () => {
      const result = await callRaw({});

      expect(result.isError).toBe(true);
      const text = textOf(result);
      expect(text).toContain(
        'citations: Invalid input: expected a citation object or an array of 1–25 citation objects',
      );
      expect(text).not.toContain('received undefined or');
      expect(mockECitMatch).not.toHaveBeenCalled();
    });

    it('reports a bad field of a lone object under its element index', async () => {
      const result = await callRaw({ citations: { journal: 'N Engl|J Med', year: '2024' } });

      expect(result.isError).toBe(true);
      expect(textOf(result)).toMatch(/citations\.0\.journal: Cannot contain a pipe/);
      expect(mockECitMatch).not.toHaveBeenCalled();
    });
  });
});

describe('lookupCitationTool against a Bookshelf chapter (issue #114)', () => {
  beforeEach(() => {
    mockECitMatch.mockClear();
    mockESummary.mockClear();
    mockExtractBriefSummaries.mockClear();
    mockESummary.mockResolvedValue({});
    mockECitMatch.mockResolvedValue([
      { key: 'gene-reviews', matched: true, pmid: '20301425', status: 'matched' },
    ]);
    // ESummary lists the book's editors ahead of the chapter's authors; the
    // parser keeps them apart, so `authorNames` is the chapter roster alone.
    mockExtractBriefSummaries.mockResolvedValue([
      {
        pmid: '20301425',
        authors: 'Petrucelli N, Daly MB, Pal T',
        authorNames: ['Petrucelli N', 'Daly MB', 'Pal T'],
        editors: ['Adam MP', 'Bick S', 'Mirzaa GM', 'Wallace SE', 'Amemiya A'],
        bookTitle: 'GeneReviews(®)',
        docType: 'chapter',
      },
    ]);
  });

  const lookup = async (authorName: string) => {
    const ctx = createMockContext({ errors: lookupCitationTool.errors });
    const input = lookupCitationTool.input.parse({
      citations: [{ journal: 'GeneReviews', year: '1993', authorName, key: 'gene-reviews' }],
    });
    return lookupCitationTool.handler(input, ctx);
  };

  it('does not warn when the queried author wrote the chapter', async () => {
    const result = await lookup('petrucelli n');

    expect(result.results[0]?.pmid).toBe('20301425');
    expect(result.results[0]?.matchedFirstAuthor).toBe('Petrucelli N');
    expect(result.results[0]?.warnings).toBeUndefined();
    expect(result.totalWarnings).toBe(0);
  });

  it('warns when the queried name is only a book editor, without calling editors authors', async () => {
    const result = await lookup('adam mp');

    const warning = result.results[0]?.warnings?.[0];
    expect(warning?.code).toBe('author_mismatch');
    // The roster it reports is the chapter's, and the editors it excluded are
    // never described as the article's authors.
    expect(warning?.message).toContain('3-author roster (Petrucelli N, Daly MB, Pal T)');
    expect(warning?.message).not.toContain('Adam MP');
  });
});

describe('blank and malformed bibliographic fields (issue #187)', () => {
  const PNAS = {
    journal: 'proc natl acad sci u s a',
    year: '1991',
    volume: '88',
    firstPage: '3248',
    authorName: 'mann bj',
  };

  /** Raw client arguments, run through the framework's validation and repair. */
  const callRaw = (args: Record<string, unknown>) =>
    runToolContract(lookupCitationTool, args as never);

  const textOf = (result: Awaited<ReturnType<typeof runToolContract>>) =>
    textBlocks(result.content as ContentBlock[])
      .map((b) => b.text)
      .join('\n');

  const issuesOf = (citation: Record<string, unknown>) =>
    lookupCitationTool.input
      .safeParse({ citations: [citation] })
      .error?.issues.map((issue) => issue.path.join('.'));

  beforeEach(() => {
    mockECitMatch.mockReset();
    mockESummary.mockReset();
    mockExtractBriefSummaries.mockReset();
    mockESummary.mockResolvedValue({});
    mockECitMatch.mockImplementation(async (citations: { key: string }[]) =>
      citations.map((c) => ({ key: c.key, matched: true, pmid: '2014248', status: 'matched' })),
    );
    mockExtractBriefSummaries.mockResolvedValue([
      {
        pmid: '2014248',
        authors: 'Mann BJ, Torian BE, Vedvick TS, Petri WA Jr',
        authorNames: ['Mann BJ', 'Torian BE', 'Vedvick TS', 'Petri WA Jr'],
        pubDate: '1991 Apr 15',
      },
    ]);
  });

  describe('the reproduction inputs', () => {
    it.each([
      [
        'a whitespace journal beside an author',
        [{ journal: '   ', authorName: 'Smith J' }],
        'journal',
      ],
      ['a whitespace year', [{ year: '    ' }], 'year'],
      ['a non-numeric year', [{ year: 'banana' }], 'year'],
      ['a non-numeric year ahead of a valid citation', [{ year: 'banana' }, PNAS], 'year'],
    ])(
      'rejects %s with -32602 naming the field, before ECitMatch',
      async (_label, citations, field) => {
        const result = await callRaw({ citations });

        expect(result.isError).toBe(true);
        expect(result.structuredContent).toMatchObject({
          error: { code: JsonRpcErrorCode.InvalidParams },
        });
        expect(textOf(result)).toContain(`citations.0.${field}:`);
        expect(mockECitMatch).not.toHaveBeenCalled();
      },
    );
  });

  describe('year', () => {
    it.each([
      ['1991a'],
      ['1991-1992'],
      ['91'],
      ['1991 May'],
      ['   '],
      ['\t'],
      ['19 91'],
      ['１９９１'],
      ['1991\n'],
    ])('rejects %j with and without a journal', (year) => {
      expect(issuesOf({ year })).toEqual(['citations.0.year', 'citations.0']);
      expect(issuesOf({ ...PNAS, year })).toEqual(['citations.0.year']);
    });

    it('states the four-digit rule in the rejection', () => {
      const parsed = lookupCitationTool.input.safeParse({
        citations: [{ ...PNAS, year: '1991a' }],
      });
      expect(parsed.error?.issues[0]?.message).toBe('Must be a four-digit year, e.g. "1991".');
    });

    it.each([
      ['plain', '1991', '1991'],
      ['space-padded', ' 1991 ', ' 1991 '],
      ['tab-padded', '\t1991\t', '\t1991\t'],
    ])('accepts a %s four-digit year and sends it as given', async (_label, year, sent) => {
      const result = await callRaw({ citations: [{ ...PNAS, year }] });

      expect(result.isError).toBeFalsy();
      expect(mockECitMatch.mock.calls[0]?.[0]?.[0]).toMatchObject({ year: sent });
      expect(result.structuredContent).toMatchObject({
        results: [{ pmid: '2014248', status: 'matched' }],
        totalWarnings: 0,
      });
    });

    it('reads an exactly-empty year as unset', async () => {
      const result = await callRaw({ citations: [{ ...PNAS, year: '' }] });

      expect(result.isError).toBeFalsy();
      expect(mockECitMatch.mock.calls[0]?.[0]?.[0]?.year).toBeUndefined();
      expect(result.structuredContent).toMatchObject({
        results: [{ pmid: '2014248', status: 'matched' }],
      });
    });

    it('still accepts an integer year, which the framework sends on as its digits', async () => {
      const result = await callRaw({ citations: [{ ...PNAS, year: 1991 }] });

      expect(result.isError).toBeFalsy();
      expect(mockECitMatch.mock.calls[0]?.[0]?.[0]).toMatchObject({ year: '1991' });
      expect(textOf(result)).toContain('**PMID:** 2014248');
    });

    it('accepts a year on its own', () => {
      expect(lookupCitationTool.input.safeParse({ citations: [{ year: '1991' }] }).success).toBe(
        true,
      );
    });

    it('does not count an empty year toward the journal-or-year rule', () => {
      expect(issuesOf({ year: '', volume: '88' })).toEqual(['citations.0']);
    });

    it('advertises the four-digit pattern, and no blank wording in its description', () => {
      const emitted = toJSONSchema(lookupCitationTool.input as never, {
        target: 'draft-7',
        io: 'input',
      }) as unknown as {
        properties: {
          citations: { items: { properties: Record<string, Record<string, unknown>> } };
        };
      };
      const fields = emitted.properties.citations.items.properties;

      expect(fields.year).toMatchObject({ type: 'string', pattern: '^[ \\t]*\\d{4}[ \\t]*$' });
      for (const field of ['journal', 'year', 'volume', 'firstPage', 'authorName']) {
        expect(fields[field]?.description).toEqual(expect.any(String));
        expect(fields[field]?.description).not.toMatch(/empty|blank|unset/i);
      }
    });
  });

  describe('journal, volume, firstPage, authorName', () => {
    it.each([
      ['journal', '​'],
      ['journal', '   '],
      ['journal', ' ㅤ'],
      ['volume', '   '],
      ['firstPage', '\t'],
      ['authorName', '   '],
      ['authorName', '⁠'],
    ])('rejects %s of %j', (field, value) => {
      const parsed = lookupCitationTool.input.safeParse({
        citations: [{ ...PNAS, [field]: value }],
      });

      expect(parsed.success).toBe(false);
      expect(parsed.error?.issues).toHaveLength(1);
      expect(parsed.error?.issues[0]?.path).toEqual(['citations', 0, field]);
      expect(parsed.error?.issues[0]?.message).toBe(
        'Must contain a visible character. Omit the field rather than sending only spaces or invisible characters.',
      );
    });

    it('rejects an invisible journal as no journal for the journal-or-year rule', () => {
      expect(issuesOf({ journal: '​', authorName: 'Smith J' })).toEqual([
        'citations.0.journal',
        'citations.0',
      ]);
      expect(issuesOf({ journal: '​', year: '1991' })).toEqual(['citations.0.journal']);
    });

    it.each([
      ['journal', 'journal'],
      ['volume', 'volume'],
      ['firstPage', 'firstPage'],
      ['authorName', 'authorName'],
    ])('reads an exactly-empty %s as unset', async (_label, field) => {
      const result = await callRaw({ citations: [{ ...PNAS, [field]: '' }] });

      expect(result.isError).toBeFalsy();
      expect(mockECitMatch.mock.calls[0]?.[0]?.[0]?.[field]).toBeUndefined();
      expect(result.structuredContent).toMatchObject({
        results: [{ pmid: '2014248', status: 'matched' }],
      });
    });

    it('keeps visible values with inner or edge whitespace as sent', async () => {
      await callRaw({ citations: [{ ...PNAS, journal: ' proc natl acad sci u s a ' }] });
      expect(mockECitMatch.mock.calls[0]?.[0]?.[0]?.journal).toBe(' proc natl acad sci u s a ');
    });

    it('does not count an empty journal toward the journal-or-year rule', () => {
      expect(issuesOf({ journal: '', authorName: 'Smith J' })).toEqual(['citations.0']);
    });
  });

  it('leaves key free-form', async () => {
    for (const key of ['   ', '​', 'a|b', 'x\r\ny', '']) {
      expect(lookupCitationTool.input.safeParse({ citations: [{ ...PNAS, key }] }).success).toBe(
        true,
      );
    }
    const result = await callRaw({ citations: [{ ...PNAS, key: '   ' }] });
    expect(result.structuredContent).toMatchObject({ results: [{ key: '   ' }] });
  });

  describe('linear time on long year values', () => {
    /** CPU time of `run`, in ms — this thread's user + system time, not wall clock. */
    const cpuMs = (run: () => void): number => {
      const start = process.threadCpuUsage();
      run();
      const { user, system } = process.threadCpuUsage(start);
      return (user + system) / 1000;
    };

    const parseYear = (year: string) =>
      lookupCitationTool.input.safeParse({ citations: [{ journal: 'J', year }] });

    /** Fastest of five measurements of twenty parses each — the least noisy reading. */
    const fastestMs = (year: string): number => {
      parseYear(year);
      return Math.min(
        ...Array.from({ length: 5 }, () =>
          cpuMs(() => {
            for (let i = 0; i < 20; i++) parseYear(year);
          }),
        ),
      );
    };

    it.each([
      ['spaces, then a non-digit', (n: number) => `${' '.repeat(n - 1)}x`],
      ['a year, spaces, then a non-digit', (n: number) => `1991${' '.repeat(n - 5)}x`],
      ['alternating spaces and tabs', (n: number) => ' \t'.repeat(n / 2)],
      ['digits only', (n: number) => '1'.repeat(n)],
    ])('scales linearly from 5k to 80k characters of %s', (_label, build) => {
      const [t5k, t20k, t80k] = [5_000, 20_000, 80_000].map((n) => fastestMs(build(n)));
      // Linear work grows 16× across the span; quadratic grows 256×.
      expect((t80k ?? 0) / Math.max(t5k ?? 0, 0.001)).toBeLessThan(64);
      expect(t20k).toBeLessThan(400);
      expect(t80k).toBeLessThan(400);
      expect(parseYear(build(80_000)).success).toBe(false);
    });
  });
});

describe('an integer field in either `citations` shape (issue #198)', () => {
  const PNAS = {
    journal: 'proc natl acad sci u s a',
    year: '1991',
    volume: '88',
    firstPage: '3248',
    authorName: 'mann bj',
  };

  /** Raw client arguments, through the framework's validation and integer repair. */
  const callRaw = (args: Record<string, unknown>) =>
    runToolContract(lookupCitationTool, args as never);

  const textOf = (result: Awaited<ReturnType<typeof runToolContract>>) =>
    textBlocks(result.content as ContentBlock[])
      .map((b) => b.text)
      .join('\n');

  /** The same citation sent as a lone object and as a one-element array. */
  const bothShapes = async (citation: Record<string, unknown>) => ({
    single: await callRaw({ citations: citation }),
    array: await callRaw({ citations: [citation] }),
  });

  beforeEach(() => {
    mockECitMatch.mockReset();
    mockESummary.mockReset();
    mockExtractBriefSummaries.mockReset();
    mockESummary.mockResolvedValue({});
    mockECitMatch.mockImplementation(async (citations: { key: string }[]) =>
      citations.map((c) => ({ key: c.key, matched: true, pmid: '2014248', status: 'matched' })),
    );
    mockExtractBriefSummaries.mockResolvedValue([
      {
        pmid: '2014248',
        authors: 'Mann BJ, Torian BE, Vedvick TS, et al.',
        authorNames: ['Mann BJ', 'Torian BE', 'Vedvick TS', 'Petri WA Jr'],
        pubDate: '1991 Apr 15',
      },
    ]);
  });

  it('resolves the reproduction the same as a lone object and as an array, on both surfaces', async () => {
    const { single, array } = await bothShapes({ journal: 'Lancet', year: 1991 });
    const asString = await callRaw({ citations: [{ journal: 'Lancet', year: '1991' }] });

    expect(single.isError).toBeFalsy();
    expect(single.structuredContent).toEqual(array.structuredContent);
    expect(textOf(single)).toBe(textOf(array));
    expect(single).toEqual(asString);
    expect(mockECitMatch.mock.calls.map((call) => call[0])).toEqual([
      [{ journal: 'Lancet', year: '1991', key: '1' }],
      [{ journal: 'Lancet', year: '1991', key: '1' }],
      [{ journal: 'Lancet', year: '1991', key: '1' }],
    ]);
  });

  it.each([
    ['year', 1991, '1991'],
    ['volume', 88, '88'],
    ['firstPage', 3248, '3248'],
    ['journal', 1234, '1234'],
    ['authorName', 5, '5'],
    ['key', 7, '7'],
    ['volume', -5, '-5'],
    ['firstPage', 0, '0'],
    ['firstPage', Number.MAX_SAFE_INTEGER, '9007199254740991'],
  ])('reads %s %d as %j in both shapes', async (field, value, sent) => {
    const { single, array } = await bothShapes({ ...PNAS, [field]: value });

    expect(single.isError).toBeFalsy();
    expect(single).toEqual(array);
    for (const call of mockECitMatch.mock.calls) {
      expect(call[0]?.[0]?.[field]).toBe(sent);
    }
    expect(mockECitMatch).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['year', 1991.5],
    ['year', -0],
    ['volume', 2 ** 53],
    ['firstPage', 1e21],
  ])('rejects %s %d in both shapes, as the framework repair does', async (field, value) => {
    const { single, array } = await bothShapes({ ...PNAS, [field]: value });

    for (const result of [single, array]) {
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: { code: JsonRpcErrorCode.InvalidParams },
      });
      expect(textOf(result)).toContain(
        `citations.0.${field}: Invalid input: expected string, received number`,
      );
    }
    expect(mockECitMatch).not.toHaveBeenCalled();
  });

  it('holds an integer year to the four-digit rule in both shapes', async () => {
    const { single, array } = await bothShapes({ ...PNAS, year: 19911 });

    for (const result of [single, array]) {
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain('citations.0.year: Must be a four-digit year, e.g. "1991".');
    }
    expect(mockECitMatch).not.toHaveBeenCalled();
  });

  describe('#187 rules on string years, unchanged', () => {
    it('rejects "19x1" under citations.0.year in both shapes', async () => {
      const { single, array } = await bothShapes({ year: '19x1' });

      for (const result of [single, array]) {
        expect(result.isError).toBe(true);
        expect(result.structuredContent).toMatchObject({
          error: { code: JsonRpcErrorCode.InvalidParams },
        });
        expect(textOf(result)).toContain('citations.0.year: Must be a four-digit year');
      }
      expect(mockECitMatch).not.toHaveBeenCalled();
    });

    it('reads an empty year as unset in both shapes', async () => {
      const alone = await bothShapes({ year: '' });
      for (const result of [alone.single, alone.array]) {
        expect(result.isError).toBe(true);
        expect(textOf(result)).toContain('citations.0: Each citation must include');
        expect(textOf(result)).not.toContain('citations.0.year');
      }
      expect(mockECitMatch).not.toHaveBeenCalled();

      const withJournal = await bothShapes({ ...PNAS, year: '' });
      expect(withJournal.single.isError).toBeFalsy();
      expect(withJournal.single).toEqual(withJournal.array);
      expect(mockECitMatch.mock.calls.map((call) => call[0]?.[0]?.year)).toEqual([
        undefined,
        undefined,
      ]);
    });
  });
});

/**
 * An integer reaches the handler as its decimal string wherever a citation can
 * sit — a lone object the schema wraps into an array, any element up to the
 * 25-citation cap, either side of the `citation` alias, beside a blank field —
 * and both surfaces read exactly as the same call with the digits spelled out.
 * Whatever is rejected stays rejected under the same path. (#198)
 */
describe('integer fields in every citation position (#198)', () => {
  const PNAS = {
    journal: 'proc natl acad sci u s a',
    year: '1991',
    volume: '88',
    firstPage: '3248',
    authorName: 'mann bj',
  };
  /** One citation with an integer in every field, zero and a negative among them. */
  const ALL_INTEGERS = {
    journal: 1234,
    year: 1991,
    volume: -5,
    firstPage: 0,
    authorName: 5,
    key: 7,
  };

  const callRaw = (args: Record<string, unknown>) =>
    runToolContract(lookupCitationTool, args as never);

  const textOf = (result: Awaited<ReturnType<typeof runToolContract>>) =>
    textBlocks(result.content as ContentBlock[])
      .map((b) => b.text)
      .join('\n');

  /** The same value with every number spelled as its digits. */
  const spelled = (value: unknown): unknown => {
    if (typeof value === 'number') return String(value);
    if (Array.isArray(value)) return value.map(spelled);
    if (typeof value === 'object' && value !== null) {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, spelled(v)]));
    }
    return value;
  };

  /** 25 citations — the cap — with integers in the first, a middle, and the last. */
  const atCap = Array.from(
    { length: 25 },
    (_, i): Record<string, unknown> => ({
      journal: 'J',
      year: '2000',
      key: `k${i}`,
    }),
  );
  atCap[0] = { ...ALL_INTEGERS, key: 100 };
  atCap[12] = { journal: 'J', year: 2012, firstPage: 0, key: 112 };
  atCap[24] = { journal: 9, year: 2024, volume: Number.MAX_SAFE_INTEGER, key: 124 };

  beforeEach(() => {
    mockECitMatch.mockReset();
    mockESummary.mockReset();
    mockExtractBriefSummaries.mockReset();
    mockESummary.mockResolvedValue({});
    mockExtractBriefSummaries.mockResolvedValue([]);
    mockECitMatch.mockImplementation(async (citations: { key: string }[]) =>
      citations.map((c, i) => ({
        key: c.key,
        matched: true,
        pmid: String(3_000_000 + i),
        status: 'matched',
      })),
    );
  });

  it('hands the handler every field of an all-integer lone object as its digits', async () => {
    const result = await callRaw({ citations: ALL_INTEGERS });

    expect(result.isError).toBeFalsy();
    expect(mockECitMatch.mock.calls[0]?.[0]).toEqual([
      { journal: '1234', year: '1991', volume: '-5', firstPage: '0', authorName: '5', key: '7' },
    ]);
    expect(result.structuredContent).toMatchObject({
      results: [{ key: '7', pmid: '3000000', status: 'matched' }],
    });
    expect(textOf(result)).toContain('### 1 · 7');
  });

  it.each<[string, Record<string, unknown>]>([
    ['an all-integer lone object', { citations: ALL_INTEGERS }],
    ['an all-integer lone object under the `citation` alias', { citation: ALL_INTEGERS }],
    ['25 citations with integers in the first, middle, and last', { citations: atCap }],
    [
      'an array under the `citation` alias with integers in its second element',
      { citation: [PNAS, { ...PNAS, year: 1991, volume: 88 }] },
    ],
    [
      'integers beside exactly-empty fields',
      { citations: { journal: '', year: 1991, volume: 88, firstPage: '', authorName: '' } },
    ],
    [
      'integers spread across elements of a three-citation array',
      {
        citations: [
          { journal: 'Nature', year: 2020, key: 1 },
          PNAS,
          { journal: 'Lancet', year: '2021', volume: 397, firstPage: -1, key: 3 },
        ],
      },
    ],
  ])('reads %s exactly as the same call with the digits spelled out', async (_label, args) => {
    const withIntegers = await callRaw(structuredClone(args));
    const handedIntegers = mockECitMatch.mock.calls[0]?.[0];
    mockECitMatch.mockClear();
    const withDigits = await callRaw(spelled(args) as Record<string, unknown>);

    expect(withIntegers.isError).toBeFalsy();
    expect(handedIntegers).toEqual(mockECitMatch.mock.calls[0]?.[0]);
    expect(withIntegers).toEqual(withDigits);
    for (const citation of handedIntegers as Record<string, unknown>[]) {
      for (const value of Object.values(citation)) {
        expect(['string', 'undefined']).toContain(typeof value);
      }
    }
  });

  it('keeps the last element of a capped array at its own digits', async () => {
    await callRaw({ citations: atCap });

    const handed = mockECitMatch.mock.calls[0]?.[0] as Record<string, unknown>[];
    expect(handed).toHaveLength(25);
    expect(handed[12]).toMatchObject({ year: '2012', firstPage: '0', key: '112' });
    expect(handed[24]).toMatchObject({ journal: '9', volume: '9007199254740991', key: '124' });
  });

  it.each<[string, Record<string, unknown>, string]>([
    [
      'a fractional volume in a lone object',
      { citations: { ...PNAS, volume: 0.5 } },
      'citations.0.volume: Invalid input: expected string, received number',
    ],
    [
      'a negative fractional key deep in an array',
      { citations: [PNAS, PNAS, { ...PNAS, key: -1.5 }] },
      'citations.2.key: Invalid input: expected string, received number',
    ],
    [
      'a negative zero under the `citation` alias',
      { citation: { ...PNAS, firstPage: -0 } },
      'citations.0.firstPage: Invalid input: expected string, received number',
    ],
    [
      'an unsafe integer as a journal',
      { citations: [{ ...PNAS, journal: 2 ** 53 }] },
      'citations.0.journal: Invalid input: expected string, received number',
    ],
  ])('rejects %s under its own path', async (_label, args, line) => {
    const result = await callRaw(args);

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: { code: JsonRpcErrorCode.InvalidParams },
    });
    expect(textOf(result)).toContain(line);
    expect(mockECitMatch).not.toHaveBeenCalled();
  });

  it.each<[string, Record<string, unknown>, string, string]>([
    [
      'an integer year beside a piped journal',
      { citations: [PNAS, { journal: 'a|b', year: 1991, volume: 7 }] },
      'citations.1.journal: Cannot contain a pipe',
      'citations.1.year',
    ],
    [
      'integers in a citation with no journal or year',
      { citations: { volume: 88, firstPage: 3248 } },
      'citations.0: Each citation must include at least a journal or year',
      'citations.0.volume',
    ],
    [
      '26 citations with integer years',
      { citations: Array.from({ length: 26 }, (_, i) => ({ journal: 'J', year: 2000 + i })) },
      'citations: Invalid input: expected a citation object or an array of 1–25 citation objects',
      'expected string',
    ],
  ])('rejects %s for its other fault alone', async (_label, args, reported, unreported) => {
    const result = await callRaw(args);

    expect(result.isError).toBe(true);
    const text = textOf(result);
    expect(text).toContain(reported);
    expect(text).not.toContain(unreported);
    expect(mockECitMatch).not.toHaveBeenCalled();
  });

  /**
   * The framework's own repair would hand these on as `expected string, received
   * number`: it rejects a repaired value that fails the field's check with the
   * original type error. The tool's own conversion keeps the four-digit rule.
   */
  it.each<[string, Record<string, unknown>, string[]]>([
    ['zero in a lone object', { citations: { ...PNAS, year: 0 } }, ['citations.0.year']],
    [
      'a five-digit year deep in an array',
      { citations: [PNAS, PNAS, { ...PNAS, year: 19911 }] },
      ['citations.2.year'],
    ],
    [
      'a negative year under the `citation` alias',
      { citation: [PNAS, { ...PNAS, year: -5 }] },
      ['citations.1.year'],
    ],
    [
      'the largest safe integer as a year',
      { citations: [{ ...PNAS, year: Number.MAX_SAFE_INTEGER }] },
      ['citations.0.year'],
    ],
    [
      'a two-digit year with no journal',
      { citations: { year: 88, volume: '12' } },
      ['citations.0.year', 'citations.0: Each citation must include'],
    ],
  ])('holds %s to the four-digit rule', async (_label, args, paths) => {
    const result = await callRaw(args);

    expect(result.isError).toBe(true);
    const text = textOf(result);
    expect(text).toContain(`${paths[0]}: Must be a four-digit year, e.g. "1991".`);
    for (const path of paths.slice(1)) expect(text).toContain(path);
    expect(text).not.toContain('expected string, received number');
    expect(mockECitMatch).not.toHaveBeenCalled();
  });

  it('advertises every citation field, `key` included, as an optional plain string', () => {
    const emitted = toJSONSchema(lookupCitationTool.input as never, {
      target: 'draft-7',
      io: 'input',
    }) as unknown as {
      properties: { citations: { items: Record<string, unknown> } };
    };
    const { items } = emitted.properties.citations;

    expect(items).not.toHaveProperty('required');
    expect(items).not.toHaveProperty('additionalProperties');
    expect((items.properties as Record<string, unknown>).key).toEqual({
      description:
        'Arbitrary label to track this citation in results. Auto-assigned if omitted. Echoed back unchanged and never sent to NCBI, so any character is accepted here.',
      type: 'string',
    });
    for (const field of ['journal', 'year', 'volume', 'firstPage', 'authorName']) {
      expect((items.properties as Record<string, Record<string, unknown>>)[field]).toMatchObject({
        type: 'string',
        pattern: expect.any(String),
      });
    }
  });
});
