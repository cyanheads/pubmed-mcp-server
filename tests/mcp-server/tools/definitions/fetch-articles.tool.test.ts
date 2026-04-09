/**
 * @fileoverview Tests for the fetch-articles tool.
 * @module tests/mcp-server/tools/definitions/fetch-articles.tool.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockEFetch = vi.fn();
vi.mock('@/services/ncbi/ncbi-service.js', () => ({
  getNcbiService: () => ({ eFetch: mockEFetch }),
}));

const { fetchArticlesTool } = await import('@/mcp-server/tools/definitions/fetch-articles.tool.js');

describe('fetchArticlesTool', () => {
  beforeEach(() => {
    mockEFetch.mockReset();
  });

  it('validates input schema', () => {
    const input = fetchArticlesTool.input.parse({ pmids: ['12345', '67890'] });
    expect(input.pmids).toEqual(['12345', '67890']);
    expect(input.includeMesh).toBe(true);
    expect(input.includeGrants).toBe(false);
  });

  it('rejects non-numeric PMIDs', () => {
    expect(() => fetchArticlesTool.input.parse({ pmids: ['abc'] })).toThrow();
  });

  it('returns empty when no articles found', async () => {
    mockEFetch.mockResolvedValue({ PubmedArticleSet: null });
    const ctx = createMockContext();
    const input = fetchArticlesTool.input.parse({ pmids: ['99999'] });
    const result = await fetchArticlesTool.handler(input, ctx);

    expect(result.articles).toEqual([]);
    expect(result.totalReturned).toBe(0);
  });

  it('throws when response is missing PubmedArticleSet', async () => {
    mockEFetch.mockResolvedValue({});
    const ctx = createMockContext();
    const input = fetchArticlesTool.input.parse({ pmids: ['12345'] });

    await expect(fetchArticlesTool.handler(input, ctx)).rejects.toThrow(/missing PubmedArticleSet/);
  });

  it('parses articles and adds URLs', async () => {
    mockEFetch.mockResolvedValue({
      PubmedArticleSet: {
        PubmedArticle: [
          {
            MedlineCitation: {
              PMID: { '#text': '12345' },
              Article: {
                ArticleTitle: { '#text': 'Test' },
                Journal: { Title: { '#text': 'J' } },
                PublicationTypeList: {
                  PublicationType: { '#text': 'Journal Article' },
                },
              },
            },
            PubmedData: {
              ArticleIdList: {
                ArticleId: [{ '#text': 'PMC999', '@_IdType': 'pmc' }],
              },
            },
          },
        ],
      },
    });

    const ctx = createMockContext();
    const input = fetchArticlesTool.input.parse({ pmids: ['12345'] });
    const result = await fetchArticlesTool.handler(input, ctx);

    expect(result.totalReturned).toBe(1);
    expect(result.articles[0]?.pmid).toBe('12345');
    expect(result.articles[0]?.pubmedUrl).toContain('12345');
    expect(result.articles[0]?.pmcUrl).toContain('PMC999');
  });

  it('reports unavailable PMIDs', async () => {
    mockEFetch.mockResolvedValue({
      PubmedArticleSet: {
        PubmedArticle: [
          {
            MedlineCitation: {
              PMID: { '#text': '111' },
              Article: {
                ArticleTitle: { '#text': 'Found' },
                PublicationTypeList: { PublicationType: { '#text': 'Journal Article' } },
              },
            },
          },
        ],
      },
    });

    const ctx = createMockContext();
    const input = fetchArticlesTool.input.parse({ pmids: ['111', '222'] });
    const result = await fetchArticlesTool.handler(input, ctx);

    expect(result.unavailablePmids).toEqual(['222']);
  });

  it('uses POST for large PMID batches', async () => {
    const pmids = Array.from({ length: 100 }, (_, index) => String(index + 1));
    mockEFetch.mockResolvedValue({
      PubmedArticleSet: {
        PubmedArticle: [
          {
            MedlineCitation: {
              PMID: { '#text': '1' },
              Article: {
                ArticleTitle: { '#text': 'Found' },
                PublicationTypeList: { PublicationType: { '#text': 'Journal Article' } },
              },
            },
          },
          {},
        ],
      },
    });

    const ctx = createMockContext();
    const input = fetchArticlesTool.input.parse({ pmids });
    const result = await fetchArticlesTool.handler(input, ctx);

    expect(mockEFetch).toHaveBeenCalledWith(
      { db: 'pubmed', id: pmids.join(','), retmode: 'xml' },
      { retmode: 'xml', usePost: true },
    );
    expect(result.totalReturned).toBe(1);
    expect(result.unavailablePmids).toHaveLength(99);
  });

  it('formats output', () => {
    const blocks = fetchArticlesTool.format!({
      articles: [
        {
          pmid: '12345',
          title: 'Test Article',
          abstractText: 'Abstract here.',
          affiliations: ['Example University'],
          authors: [
            { lastName: 'Smith', initials: 'J' },
            { lastName: 'Jones', initials: 'A' },
            { lastName: 'Brown', initials: 'S' },
            { lastName: 'White', initials: 'P' },
          ],
          journalInfo: {
            isoAbbreviation: 'Nat Rev',
            volume: '12',
            issue: '3',
            pages: '45-52',
            publicationDate: { year: '2024' },
          },
          publicationTypes: ['Review'],
          doi: '10.1000/example',
          pubmedUrl: 'https://pubmed.ncbi.nlm.nih.gov/12345/',
          pmcUrl: 'https://www.ncbi.nlm.nih.gov/pmc/articles/PMC12345/',
          keywords: ['asthma', 'airway'],
          meshTerms: [
            {
              descriptorName: 'Asthma',
              isMajorTopic: true,
              qualifiers: [{ qualifierName: 'therapy', isMajorTopic: true }],
            },
          ],
          grantList: [{ grantId: 'R01', agency: 'NIH', country: 'USA' }],
        },
      ],
      totalReturned: 1,
      unavailablePmids: ['99999'],
    });
    expect(blocks[0]?.text).toContain('PubMed Articles');
    expect(blocks[0]?.text).toContain('Test Article');
    expect(blocks[0]?.text).toContain('Unavailable PMIDs');
    expect(blocks[0]?.text).toContain('Smith J, Jones A, Brown S, et al.');
    expect(blocks[0]?.text).toContain('Affiliations');
    expect(blocks[0]?.text).toContain('Nat Rev, 2024, **12**(3), 45-52');
    expect(blocks[0]?.text).toContain('**Type:** Review');
    expect(blocks[0]?.text).toContain('**DOI:** 10.1000/example');
    expect(blocks[0]?.text).toContain(
      '**PMC:** https://www.ncbi.nlm.nih.gov/pmc/articles/PMC12345/',
    );
    expect(blocks[0]?.text).toContain('**Keywords:** asthma, airway');
    expect(blocks[0]?.text).toContain('#### MeSH Terms');
    expect(blocks[0]?.text).toContain('- Asthma * (therapy*)');
    expect(blocks[0]?.text).toContain('#### Grants');
    expect(blocks[0]?.text).toContain('R01');
  });
});
