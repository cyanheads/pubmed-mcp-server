/**
 * @fileoverview Tests for the search-articles tool.
 * @module tests/mcp-server/tools/definitions/search-articles.tool.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it, vi } from 'vitest';

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

  describe('dateRange handling', () => {
    it('accepts dateRange with empty strings (MCP Inspector payload)', () => {
      const result = searchArticlesTool.input.safeParse({
        query: 'cancer',
        dateRange: { minDate: '', maxDate: '' },
      });
      expect(result.success).toBe(true);
    });

    it('accepts omitted dateRange', () => {
      const result = searchArticlesTool.input.safeParse({ query: 'cancer' });
      expect(result.success).toBe(true);
      expect(result.data?.dateRange).toBeUndefined();
    });

    it('skips date clause when dateRange has empty strings', async () => {
      mockESearch.mockResolvedValue({
        count: 5580000,
        idList: ['111'],
        retmax: 20,
        retstart: 0,
        queryTranslation: 'cancer[All Fields]',
      });

      const ctx = createMockContext();
      const input = searchArticlesTool.input.parse({
        query: 'cancer',
        dateRange: { minDate: '', maxDate: '' },
      });
      await searchArticlesTool.handler(input, ctx);

      const calledTerm = mockESearch.mock.calls.at(-1)?.[0]?.term as string;
      expect(calledTerm).not.toContain('[pdat]');
    });

    it('skips date clause when only minDate is empty', async () => {
      mockESearch.mockResolvedValue({
        count: 5580000,
        idList: ['111'],
        retmax: 20,
        retstart: 0,
        queryTranslation: 'cancer[All Fields]',
      });

      const ctx = createMockContext();
      const input = searchArticlesTool.input.parse({
        query: 'cancer',
        dateRange: { minDate: '', maxDate: '2024/01/01' },
      });
      await searchArticlesTool.handler(input, ctx);

      const calledTerm = mockESearch.mock.calls.at(-1)?.[0]?.term as string;
      expect(calledTerm).not.toContain('[pdat]');
    });

    it('skips date clause when dateRange is omitted', async () => {
      mockESearch.mockResolvedValue({
        count: 5580000,
        idList: ['111'],
        retmax: 20,
        retstart: 0,
        queryTranslation: 'cancer[All Fields]',
      });

      const ctx = createMockContext();
      const input = searchArticlesTool.input.parse({ query: 'cancer' });
      await searchArticlesTool.handler(input, ctx);

      const calledTerm = mockESearch.mock.calls.at(-1)?.[0]?.term as string;
      expect(calledTerm).not.toContain('[pdat]');
      expect(calledTerm).not.toContain('[mdat]');
      expect(calledTerm).not.toContain('[edat]');
    });

    it('appends date clause when both dates are provided', async () => {
      mockESearch.mockResolvedValue({
        count: 100,
        idList: ['111'],
        retmax: 20,
        retstart: 0,
        queryTranslation: 'cancer[All Fields]',
      });

      const ctx = createMockContext();
      const input = searchArticlesTool.input.parse({
        query: 'cancer',
        dateRange: { minDate: '2020/01/01', maxDate: '2024/12/31' },
      });
      await searchArticlesTool.handler(input, ctx);

      const calledTerm = mockESearch.mock.calls.at(-1)?.[0]?.term as string;
      expect(calledTerm).toContain('2020/01/01[pdat]');
      expect(calledTerm).toContain('2024/12/31[pdat]');
    });

    it('converts dash-delimited dates to slashes for NCBI', async () => {
      mockESearch.mockResolvedValue({
        count: 100,
        idList: ['111'],
        retmax: 20,
        retstart: 0,
        queryTranslation: 'cancer[All Fields]',
      });

      const ctx = createMockContext();
      const input = searchArticlesTool.input.parse({
        query: 'cancer',
        dateRange: { minDate: '2020-01-01', maxDate: '2024-12-31' },
      });
      await searchArticlesTool.handler(input, ctx);

      const calledTerm = mockESearch.mock.calls.at(-1)?.[0]?.term as string;
      expect(calledTerm).toContain('2020/01/01[pdat]');
      expect(calledTerm).toContain('2024/12/31[pdat]');
    });
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
