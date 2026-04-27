/**
 * @fileoverview Tests for the lookup-citation tool.
 * @module tests/mcp-server/tools/definitions/lookup-citation.tool.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

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

  it('accepts citation with only one field', () => {
    expect(() =>
      lookupCitationTool.input.parse({ citations: [{ journal: 'Nature' }] }),
    ).not.toThrow();
  });

  it('maps matched results with pmid and surfaces first author on clean match', async () => {
    mockECitMatch.mockResolvedValue([
      { key: '1', matched: true, pmid: '8400044', status: 'matched' },
    ]);
    mockExtractBriefSummaries.mockResolvedValue([
      { pmid: '8400044', authors: 'Mann BJ, Lockhart BE, Albert MJ' },
    ]);

    const ctx = createMockContext();
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
      { pmid: '31189511', authors: 'Gerstein HC, Colhoun HM, Dagenais GR, et al.' },
    ]);

    const ctx = createMockContext();
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
    expect(result.totalWarnings).toBe(1);
  });

  it('does not false-positive on substring surname collisions (Smith vs Smithson)', async () => {
    mockECitMatch.mockResolvedValue([{ key: '1', matched: true, pmid: '999', status: 'matched' }]);
    mockExtractBriefSummaries.mockResolvedValue([
      { pmid: '999', authors: 'Smithson JA, Jones BB' },
    ]);

    const ctx = createMockContext();
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

    const ctx = createMockContext();
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

    const ctx = createMockContext();
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
      { pmid: '111', authors: 'Alice AA' },
      { pmid: '222', authors: 'Bob BB' },
    ]);

    const ctx = createMockContext();
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

    const ctx = createMockContext();
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
      { pmid: '12345', authors: 'Smith JA', pubDate: '2020-01-01' },
    ]);

    const ctx = createMockContext();
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
      { pmid: '31189511', authors: 'Gerstein HC, Colhoun HM', pubDate: '2020-01-01' },
    ]);

    const ctx = createMockContext();
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

    const ctx = createMockContext();
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

    const ctx = createMockContext();
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

    const ctx = createMockContext();
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

    const ctx = createMockContext();
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

  it('preserves user-provided keys', async () => {
    mockECitMatch.mockResolvedValue([
      { key: 'ref-A', matched: true, pmid: '111', status: 'matched' },
    ]);

    const ctx = createMockContext();
    const input = lookupCitationTool.input.parse({
      citations: [{ journal: 'Nature', year: '2020', key: 'ref-A' }],
    });
    await lookupCitationTool.handler(input, ctx);

    expect(mockECitMatch.mock.calls[0]?.[0]?.[0]?.key).toBe('ref-A');
  });

  it('rejects citation with no bibliographic fields (issue #46)', () => {
    const parsed = lookupCitationTool.input.safeParse({ citations: [{ key: 'empty' }] });

    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.message).toMatch(/at least one bibliographic field/);
    expect(parsed.error?.issues[0]?.path).toEqual(['citations', 0]);
    expect(mockECitMatch).not.toHaveBeenCalled();
  });

  it('counts matches correctly in mixed results', async () => {
    mockECitMatch.mockResolvedValue([
      { key: '1', matched: true, pmid: '111', status: 'matched' },
      { key: '2', matched: false, pmid: null, status: 'not_found', detail: 'NOT_FOUND' },
      { key: '3', matched: true, pmid: '333', status: 'matched' },
    ]);

    const ctx = createMockContext();
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

  it('passes provided fields through to service', async () => {
    mockECitMatch.mockResolvedValue([{ key: '1', matched: true, pmid: '111', status: 'matched' }]);

    const ctx = createMockContext();
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
    const blocks = lookupCitationTool.format!({
      results: [{ key: 'ref-1', matched: true, pmid: '8400044', status: 'matched' }],
      totalMatched: 1,
      totalSubmitted: 1,
      totalWarnings: 0,
    });

    expect(blocks[0]?.text).toContain('**Matched:** 1/1');
    expect(blocks[0]?.text).toContain('### ref-1');
    expect(blocks[0]?.text).toContain('**PMID:** 8400044');
    expect(blocks[0]?.text).toContain(
      'PMID is ready for downstream PubMed fetch or citation tools.',
    );
    expect(blocks[0]?.text).not.toContain('**Warnings:**');
  });

  it('formats matched citation with author mismatch warning', () => {
    const blocks = lookupCitationTool.format!({
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
    });

    expect(blocks[0]?.text).toContain('**Warnings:** 1');
    expect(blocks[0]?.text).toContain('**First Author:** Gerstein HC');
    expect(blocks[0]?.text).toContain('[author_mismatch]');
    expect(blocks[0]?.text).toContain('author_mismatch detected');
  });

  it('formats unmatched citations with recovery guidance', () => {
    const blocks = lookupCitationTool.format!({
      results: [{ key: 'ref-1', matched: false, status: 'not_found', detail: 'NOT_FOUND' }],
      totalMatched: 0,
      totalSubmitted: 1,
      totalWarnings: 0,
    });

    expect(blocks[0]?.text).toContain('**Matched:** 0/1');
    expect(blocks[0]?.text).toContain('**Status:** No match');
    expect(blocks[0]?.text).toContain('Verify the citation details or try pubmed_search_articles.');
  });

  it('formats ambiguous citations with disambiguation guidance', () => {
    const blocks = lookupCitationTool.format!({
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
    });

    expect(blocks[0]?.text).toContain('**Status:** Ambiguous');
    expect(blocks[0]?.text).toContain('AMBIGUOUS multiple matches');
    expect(blocks[0]?.text).toContain(
      'Add more citation fields such as journal, year, volume, firstPage, or authorName, then retry.',
    );
  });

  it('formats ambiguous citations with candidatePmids list and fetch hint', () => {
    const blocks = lookupCitationTool.format!({
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
    });

    expect(blocks[0]?.text).toContain('**Candidate PMIDs:** 33057196, 32076266, 32025019');
    expect(blocks[0]?.text).toContain('pubmed_fetch_articles');
  });

  it('formats matched citation with combined author + year mismatch next-step', () => {
    const blocks = lookupCitationTool.format!({
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
    });

    expect(blocks[0]?.text).toContain('author_mismatch + year_mismatch detected');
  });
});
