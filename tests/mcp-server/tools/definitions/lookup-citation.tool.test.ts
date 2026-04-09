/**
 * @fileoverview Tests for the lookup-citation tool.
 * @module tests/mcp-server/tools/definitions/lookup-citation.tool.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockECitMatch = vi.fn();
vi.mock('@/services/ncbi/ncbi-service.js', () => ({
  getNcbiService: () => ({ eCitMatch: mockECitMatch }),
}));

const { lookupCitationTool } = await import(
  '@/mcp-server/tools/definitions/lookup-citation.tool.js'
);

describe('lookupCitationTool', () => {
  beforeEach(() => {
    mockECitMatch.mockClear();
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

  it('maps matched results with pmid', async () => {
    mockECitMatch.mockResolvedValue([
      { key: '1', matched: true, pmid: '8400044', status: 'matched' },
    ]);

    const ctx = createMockContext();
    const input = lookupCitationTool.input.parse({
      citations: [{ journal: 'proc natl acad sci u s a', year: '1993', authorName: 'mann bj' }],
    });
    const result = await lookupCitationTool.handler(input, ctx);

    expect(result.results).toEqual([
      { key: '1', matched: true, pmid: '8400044', status: 'matched' },
    ]);
    expect(result.totalMatched).toBe(1);
    expect(result.totalSubmitted).toBe(1);
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

  it('throws when citation has no bibliographic fields', async () => {
    const ctx = createMockContext();
    const input = lookupCitationTool.input.parse({ citations: [{ key: 'empty' }] });

    await expect(lookupCitationTool.handler(input, ctx)).rejects.toThrow(
      /at least one bibliographic field/,
    );
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
    });

    expect(blocks[0]?.text).toContain('**Matched:** 1/1');
    expect(blocks[0]?.text).toContain('### ref-1');
    expect(blocks[0]?.text).toContain('**PMID:** 8400044');
    expect(blocks[0]?.text).toContain(
      'PMID is ready for downstream PubMed fetch or citation tools.',
    );
  });

  it('formats unmatched citations with recovery guidance', () => {
    const blocks = lookupCitationTool.format!({
      results: [{ key: 'ref-1', matched: false, status: 'not_found', detail: 'NOT_FOUND' }],
      totalMatched: 0,
      totalSubmitted: 1,
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
    });

    expect(blocks[0]?.text).toContain('**Status:** Ambiguous');
    expect(blocks[0]?.text).toContain('AMBIGUOUS multiple matches');
    expect(blocks[0]?.text).toContain(
      'Add more citation fields such as journal, year, volume, firstPage, or authorName, then retry.',
    );
  });
});
