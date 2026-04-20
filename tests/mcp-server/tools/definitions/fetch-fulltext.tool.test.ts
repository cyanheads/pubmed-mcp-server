/**
 * @fileoverview Tests for the fetch-fulltext tool.
 * @module tests/mcp-server/tools/definitions/fetch-fulltext.tool.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockEFetch = vi.fn();
const mockIdConvert = vi.fn();
const mockParsePmcArticle = vi.fn();
vi.mock('@/services/ncbi/ncbi-service.js', () => ({
  getNcbiService: () => ({ eFetch: mockEFetch, idConvert: mockIdConvert }),
}));
vi.mock('@/services/ncbi/parsing/pmc-article-parser.js', () => ({
  parsePmcArticle: mockParsePmcArticle,
}));

const { fetchFulltextTool } = await import('@/mcp-server/tools/definitions/fetch-fulltext.tool.js');

describe('fetchFulltextTool', () => {
  beforeEach(() => {
    mockEFetch.mockReset();
    mockIdConvert.mockReset();
    mockParsePmcArticle.mockReset();
  });

  it('validates input with pmcids', () => {
    const input = fetchFulltextTool.input.parse({ pmcids: ['PMC1234567'] });
    expect(input.pmcids).toEqual(['PMC1234567']);
  });

  it('throws when neither pmcids nor pmids provided', async () => {
    const ctx = createMockContext();
    const input = fetchFulltextTool.input.parse({});
    await expect(fetchFulltextTool.handler(input, ctx)).rejects.toThrow(/Either pmcids or pmids/);
  });

  it('throws when both pmcids and pmids provided', async () => {
    const ctx = createMockContext();
    const input = fetchFulltextTool.input.parse({
      pmcids: ['PMC1'],
      pmids: ['12345'],
    });
    await expect(fetchFulltextTool.handler(input, ctx)).rejects.toThrow(/not both/);
  });

  it('fetches by PMC IDs', async () => {
    mockParsePmcArticle.mockReturnValue({
      pmcId: 'PMC1234567',
      pmcUrl: 'https://www.ncbi.nlm.nih.gov/pmc/articles/PMC1234567/',
      title: 'Full Text Article',
      sections: [{ title: 'Introduction', text: 'Body text.' }],
    });
    mockEFetch.mockResolvedValue({
      'pmc-articleset': {
        article: [{ mock: 'article' }],
      },
    });

    const ctx = createMockContext();
    const input = fetchFulltextTool.input.parse({ pmcids: ['PMC1234567'] });
    const result = await fetchFulltextTool.handler(input, ctx);

    expect(result.totalReturned).toBe(1);
    expect(result.articles[0]?.pmcId).toBe('PMC1234567');
    expect(result.articles[0]?.title).toBe('Full Text Article');
  });

  it('resolves PMIDs to PMC IDs and applies section/reference filtering', async () => {
    mockIdConvert.mockResolvedValue([
      { 'requested-id': '12345', pmid: '12345', pmcid: 'PMC777' },
      { 'requested-id': '99999', pmid: '99999' },
    ]);
    mockParsePmcArticle.mockReturnValue({
      pmcId: 'PMC777',
      pmcUrl: 'https://www.ncbi.nlm.nih.gov/pmc/articles/PMC777/',
      pmid: '12345',
      title: 'Resolved Article',
      sections: [
        { title: 'Introduction', text: 'Intro text.' },
        { title: 'Methods', text: 'Methods text.' },
      ],
      references: [{ label: '1', citation: 'Reference one' }],
    });
    mockEFetch.mockResolvedValue({
      'pmc-articleset': {
        article: [{ mock: 'article' }],
      },
    });

    const ctx = createMockContext();
    const input = fetchFulltextTool.input.parse({
      pmids: ['12345', '99999'],
      sections: ['intro'],
      maxSections: 1,
    });
    const result = await fetchFulltextTool.handler(input, ctx);

    expect(mockEFetch).toHaveBeenCalledWith(
      { db: 'pmc', id: '777', retmode: 'xml' },
      { retmode: 'xml', usePost: false },
    );
    expect(result.unavailablePmids).toEqual(['99999']);
    expect(result.articles[0]?.sections).toEqual([{ title: 'Introduction', text: 'Intro text.' }]);
    expect(result.articles[0]?.references).toBeUndefined();
  });

  it('normalizes direct PMC IDs, uses POST for large requests, and reports missing PMC IDs', async () => {
    mockParsePmcArticle.mockReturnValue({
      pmcId: 'PMC111',
      pmcUrl: 'https://www.ncbi.nlm.nih.gov/pmc/articles/PMC111/',
      title: 'Direct PMC Article',
      sections: [],
    });
    mockEFetch.mockResolvedValue({
      'pmc-articleset': {
        article: [{ mock: 'article' }],
      },
    });

    const ctx = createMockContext();
    const input = fetchFulltextTool.input.parse({
      pmcids: ['PMC111', '222', '333', '444', '555', '666'],
    });
    const result = await fetchFulltextTool.handler(input, ctx);

    expect(mockEFetch).toHaveBeenCalledWith(
      { db: 'pmc', id: '111,222,333,444,555,666', retmode: 'xml' },
      { retmode: 'xml', usePost: true },
    );
    expect(result.unavailablePmcIds).toEqual(['PMC222', 'PMC333', 'PMC444', 'PMC555', 'PMC666']);
  });

  it('returns empty when no PMIDs resolve', async () => {
    mockIdConvert.mockResolvedValue([{ 'requested-id': '99999', pmid: '99999' }]);
    const ctx = createMockContext();
    const input = fetchFulltextTool.input.parse({ pmids: ['99999'] });
    const result = await fetchFulltextTool.handler(input, ctx);

    expect(result.totalReturned).toBe(0);
    expect(result.unavailablePmids).toEqual(['99999']);
  });

  it('throws when PMC EFetch response is missing the article set', async () => {
    mockEFetch.mockResolvedValue({});

    const ctx = createMockContext();
    const input = fetchFulltextTool.input.parse({ pmcids: ['PMC1'] });

    await expect(fetchFulltextTool.handler(input, ctx)).rejects.toThrow(/missing pmc-articleset/);
  });

  it('formats output', () => {
    const blocks = fetchFulltextTool.format!({
      articles: [
        {
          pmcId: 'PMC1',
          pmcUrl: 'https://www.ncbi.nlm.nih.gov/pmc/articles/PMC1/',
          title: 'Article',
          pmid: '12345',
          pubmedUrl: 'https://pubmed.ncbi.nlm.nih.gov/12345/',
          authors: [
            { lastName: 'Smith', givenNames: 'Jane' },
            { lastName: 'Jones', givenNames: 'Alex' },
            { lastName: 'Brown', givenNames: 'Sam' },
            { lastName: 'White', givenNames: 'Pat' },
          ],
          affiliations: ['Example University'],
          journal: { title: 'Nature', volume: '12', issue: '3', pages: '45-52' },
          articleType: 'Research Article',
          publicationDate: { year: '2024', month: '01', day: '02' },
          doi: '10.1000/example',
          keywords: ['asthma', 'airway'],
          abstract: 'Abstract text.',
          sections: [
            {
              title: 'Introduction',
              text: 'Body.',
              subsections: [{ title: 'Background', text: 'Background text.' }],
            },
          ],
          references: [{ label: '1', citation: 'Reference one' }],
        },
      ],
      totalReturned: 1,
      unavailablePmids: ['99999'],
      unavailablePmcIds: ['PMC404'],
    });
    expect(blocks[0]?.text).toContain('PMC Full-Text');
    expect(blocks[0]?.text).toContain('Article');
    expect(blocks[0]?.text).toContain('Unavailable PMIDs');
    expect(blocks[0]?.text).toContain('Unavailable PMC IDs');
    expect(blocks[0]?.text).toContain('Smith Jane, Jones Alex, Brown Sam, et al.');
    expect(blocks[0]?.text).toContain('Affiliations');
    expect(blocks[0]?.text).toContain('Nature, **12**(3), 45-52');
    expect(blocks[0]?.text).toContain('Published:** 2024-01-02');
    expect(blocks[0]?.text).toContain('Keywords:** asthma, airway');
    expect(blocks[0]?.text).toContain('#### Abstract');
    expect(blocks[0]?.text).toContain('##### Background');
    expect(blocks[0]?.text).toContain('References (1)');
    expect(blocks[0]?.text).toContain('[1] Reference one');
  });
});
