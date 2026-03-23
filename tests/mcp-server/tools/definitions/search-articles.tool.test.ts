/**
 * @fileoverview Tests for the search-articles tool.
 * @module tests/mcp-server/tools/definitions/search-articles.tool.test
 */

import { describe, expect, it, vi } from 'vitest';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';

const mockESearch = vi.fn();
const mockESummary = vi.fn();
vi.mock('@/services/ncbi/ncbi-service.js', () => ({
  getNcbiService: () => ({ eSearch: mockESearch, eSummary: mockESummary }),
}));
vi.mock('@/services/ncbi/parsing/esummary-parser.js', () => ({
  extractBriefSummaries: vi.fn(() => Promise.resolve([])),
}));

const { searchArticlesTool } = await import(
  '@/mcp-server/tools/definitions/search-articles.tool.js'
);

describe('searchArticlesTool', () => {
  it('validates input with defaults', () => {
    const input = searchArticlesTool.input.parse({ query: 'cancer' });
    expect(input.query).toBe('cancer');
    expect(input.maxResults).toBe(20);
    expect(input.offset).toBe(0);
    expect(input.sort).toBe('relevance');
    expect(input.summaryCount).toBe(0);
  });

  it('returns search results', async () => {
    mockESearch.mockResolvedValue({
      count: 100,
      idList: ['111', '222', '333'],
      retmax: 20,
      retstart: 0,
      queryTranslation: 'cancer[All Fields]',
    });

    const ctx = createMockContext();
    const input = searchArticlesTool.input.parse({ query: 'cancer' });
    const result = await searchArticlesTool.handler(input, ctx);

    expect(result.totalFound).toBe(100);
    expect(result.pmids).toEqual(['111', '222', '333']);
    expect(result.query).toBe('cancer');
    expect(result.summaries).toEqual([]);
    expect(result.searchUrl).toContain('cancer');
  });

  it('formats output', () => {
    const blocks = searchArticlesTool.format!({
      query: 'cancer',
      totalFound: 100,
      offset: 0,
      pmids: ['111', '222'],
      summaries: [],
      searchUrl: 'https://pubmed.ncbi.nlm.nih.gov/?term=cancer',
    });
    expect(blocks[0]?.text).toContain('PubMed Search Results');
    expect(blocks[0]?.text).toContain('cancer');
    expect(blocks[0]?.text).toContain('100');
  });
});
