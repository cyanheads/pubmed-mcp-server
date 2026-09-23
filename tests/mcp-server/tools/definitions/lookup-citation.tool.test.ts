/**
 * @fileoverview Tests for the lookup-citation tool.
 * @module tests/mcp-server/tools/definitions/lookup-citation.tool.test
 */

import type { ContentBlock } from '@cyanheads/mcp-ts-core';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

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
      { db: 'pubmed', id: '8400044' },
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
    mockExtractBriefSummaries.mockResolvedValue([
      { pmid: '111', authors: 'Gerstein HC, Colhoun HM' },
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
    expect(mockESummary).toHaveBeenCalledWith({ db: 'pubmed', id: '111,222' }, expect.anything());
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
      ['year', { journal: 'N Engl J Med', year: '20|24' }],
      ['firstPage', { journal: 'N Engl J Med', year: '2024', firstPage: '88|9' }],
    ])('rejects a pipe in %s', async (field, citation) => {
      const parsed = lookupCitationTool.input.safeParse({ citations: [citation] });

      expect(parsed.success).toBe(false);
      expect(parsed.error?.issues[0]?.path).toEqual(['citations', 0, field]);
      expect(parsed.error?.issues[0]?.message).toMatch(/pipe/i);
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

  it('parses a single object under `citations`', () => {
    const input = lookupCitationTool.input.parse({ citations: PNAS });
    expect(input.citations).toEqual(PNAS);
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
    expect(mockECitMatch).not.toHaveBeenCalled();
  });

  it('rejects `citation` once its inputAliases entry is removed', async () => {
    expect(lookupCitationTool.inputAliases).toEqual({ citation: 'citations' });
    const { inputAliases: _declared, ...undeclared } = lookupCitationTool;
    const result = await runToolContract(undeclared, { citation: PNAS } as never);

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('Unrecognized key: "citation"');
  });

  describe('validation messages survive the union', () => {
    it('names the field and the pipe rule for a single object', () => {
      const parsed = lookupCitationTool.input.safeParse({
        citations: { journal: 'N Engl|J Med', year: '2024' },
      });

      expect(parsed.success).toBe(false);
      expect(parsed.error?.issues).toHaveLength(1);
      expect(parsed.error?.issues[0]?.path).toEqual(['citations', 'journal']);
      expect(parsed.error?.issues[0]?.message).toMatch(/pipe/i);
    });

    it('requires journal or year on a single object', () => {
      const parsed = lookupCitationTool.input.safeParse({ citations: { authorName: 'smith j' } });

      expect(parsed.success).toBe(false);
      expect(parsed.error?.issues[0]?.path).toEqual(['citations']);
      expect(parsed.error?.issues[0]?.message).toMatch(/journal or year/);
    });

    it('names the element index for a bad entry deep in an array', () => {
      const parsed = lookupCitationTool.input.safeParse({
        citations: [NATURE, PNAS, { journal: 'Lancet', year: '20|21' }],
      });

      expect(parsed.success).toBe(false);
      expect(parsed.error?.issues).toHaveLength(1);
      expect(parsed.error?.issues[0]?.path).toEqual(['citations', 2, 'year']);
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

    // A wrong-typed value inside an element fails both branches outright, so it
    // arrives as one union issue; the caller-facing text must still name the
    // element, the field, and what was wrong with it.
    it('names the element and field of a wrong-typed value inside an array', async () => {
      const result = await callRaw({ citations: [NATURE, { journal: 5, year: '1991' }] });

      expect(result.isError).toBe(true);
      const text = textOf(result);
      expect(text).toContain('1.journal: Invalid input: expected string, received number');
      expect(mockECitMatch).not.toHaveBeenCalled();
    });

    it('still bounds the array at 25 citations and rejects an empty one', () => {
      const many = Array.from({ length: 26 }, () => NATURE);
      expect(lookupCitationTool.input.safeParse({ citations: many }).success).toBe(false);
      expect(lookupCitationTool.input.safeParse({ citations: [] }).success).toBe(false);
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
