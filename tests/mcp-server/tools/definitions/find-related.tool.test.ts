/**
 * @fileoverview Tests for the find-related tool.
 * @module tests/mcp-server/tools/definitions/find-related.tool.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it, vi } from 'vitest';

const mockELink = vi.fn();
const mockESummary = vi.fn();
vi.mock('@/services/ncbi/ncbi-service.js', () => ({
  getNcbiService: () => ({ eLink: mockELink, eSummary: mockESummary }),
}));
vi.mock('@/services/ncbi/parsing/esummary-parser.js', () => ({
  extractBriefSummaries: vi.fn(() => Promise.resolve([])),
}));

const { findRelatedTool } = await import('@/mcp-server/tools/definitions/find-related.tool.js');

describe('findRelatedTool', () => {
  it('validates input with defaults', () => {
    const input = findRelatedTool.input.parse({ pmid: '12345' });
    expect(input.pmid).toBe('12345');
    expect(input.relationship).toBe('similar');
    expect(input.maxResults).toBe(10);
  });

  it('rejects non-numeric PMIDs', () => {
    expect(() => findRelatedTool.input.parse({ pmid: 'abc' })).toThrow();
  });

  it('returns empty when no related articles found', async () => {
    mockELink.mockResolvedValue({
      eLinkResult: [{ LinkSet: {} }],
    });

    const ctx = createMockContext();
    const input = findRelatedTool.input.parse({ pmid: '12345' });
    const result = await findRelatedTool.handler(input, ctx);

    expect(result.articles).toEqual([]);
    expect(result.totalFound).toBe(0);
  });

  it('throws on ELink error', async () => {
    mockELink.mockResolvedValue({
      eLinkResult: [{ ERROR: 'Invalid PMID' }],
    });

    const ctx = createMockContext();
    const input = findRelatedTool.input.parse({ pmid: '12345' });
    await expect(findRelatedTool.handler(input, ctx)).rejects.toThrow(/ELink error/);
  });

  it('formats output with articles', () => {
    const blocks = findRelatedTool.format!({
      sourcePmid: '12345',
      relationship: 'similar',
      articles: [{ pmid: '111', title: 'Related Article', score: 95 }],
      totalFound: 1,
    });
    expect(blocks[0]?.text).toContain('Related Articles');
    expect(blocks[0]?.text).toContain('12345');
    expect(blocks[0]?.text).toContain('Related Article');
  });

  it('formats output with no articles', () => {
    const blocks = findRelatedTool.format!({
      sourcePmid: '12345',
      relationship: 'cited_by',
      articles: [],
      totalFound: 0,
    });
    expect(blocks[0]?.text).toContain('No related articles');
  });
});
