/**
 * @fileoverview Tests for the fetch-fulltext tool.
 * @module tests/mcp-server/tools/definitions/fetch-fulltext.tool.test
 */

import { describe, expect, it, vi } from 'vitest';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';

const mockEFetch = vi.fn();
const mockELink = vi.fn();
vi.mock('@/services/ncbi/ncbi-service.js', () => ({
  getNcbiService: () => ({ eFetch: mockEFetch, eLink: mockELink }),
}));

const { fetchFulltextTool } = await import(
  '@/mcp-server/tools/definitions/fetch-fulltext.tool.js'
);

describe('fetchFulltextTool', () => {
  it('validates input with pmcids', () => {
    const input = fetchFulltextTool.input.parse({ pmcids: ['PMC1234567'] });
    expect(input.pmcids).toEqual(['PMC1234567']);
  });

  it('throws when neither pmcids nor pmids provided', async () => {
    const ctx = createMockContext();
    const input = fetchFulltextTool.input.parse({});
    await expect(fetchFulltextTool.handler(input, ctx)).rejects.toThrow(
      /Either pmcids or pmids/,
    );
  });

  it('throws when both pmcids and pmids provided', async () => {
    const ctx = createMockContext();
    const input = fetchFulltextTool.input.parse({
      pmcids: ['PMC1'],
      pmids: ['12345'],
    });
    await expect(fetchFulltextTool.handler(input, ctx)).rejects.toThrow(
      /not both/,
    );
  });

  it('fetches by PMC IDs', async () => {
    mockEFetch.mockResolvedValue({
      'pmc-articleset': {
        article: [
          {
            front: {
              'article-meta': {
                'article-id': [
                  { '@_pub-id-type': 'pmcid', '#text': 'PMC1234567' },
                ],
                'title-group': { 'article-title': 'Full Text Article' },
              },
            },
            body: { sec: [{ title: 'Introduction', p: 'Body text.' }] },
          },
        ],
      },
    });

    const ctx = createMockContext();
    const input = fetchFulltextTool.input.parse({ pmcids: ['PMC1234567'] });
    const result = await fetchFulltextTool.handler(input, ctx);

    expect(result.totalReturned).toBe(1);
    expect(result.articles[0]?.pmcId).toBe('PMC1234567');
    expect(result.articles[0]?.title).toBe('Full Text Article');
  });

  it('returns empty when no PMIDs resolve', async () => {
    mockELink.mockResolvedValue({ eLinkResult: [] });
    const ctx = createMockContext();
    const input = fetchFulltextTool.input.parse({ pmids: ['99999'] });
    const result = await fetchFulltextTool.handler(input, ctx);

    expect(result.totalReturned).toBe(0);
    expect(result.unavailablePmids).toEqual(['99999']);
  });

  it('formats output', () => {
    const blocks = fetchFulltextTool.format!({
      articles: [
        {
          pmcId: 'PMC1',
          pmcUrl: 'https://www.ncbi.nlm.nih.gov/pmc/articles/PMC1/',
          title: 'Article',
          sections: [{ text: 'Body.' }],
        },
      ],
      totalReturned: 1,
    });
    expect(blocks[0]?.text).toContain('PMC Full-Text');
    expect(blocks[0]?.text).toContain('Article');
  });
});
