/**
 * @fileoverview Tests for the search-articles tool.
 * @module tests/mcp-server/tools/definitions/search-articles.tool.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockESearch = vi.fn();
const mockESummary = vi.fn();
const mockExtractBriefSummaries = vi.fn(() => Promise.resolve([]));
vi.mock('@/services/ncbi/ncbi-service.js', () => ({
  getNcbiService: () => ({ eSearch: mockESearch, eSummary: mockESummary }),
}));
vi.mock('@/services/ncbi/parsing/esummary-parser.js', () => ({
  extractBriefSummaries: mockExtractBriefSummaries,
}));

const { searchArticlesTool } = await import(
  '@/mcp-server/tools/definitions/search-articles.tool.js'
);

describe('searchArticlesTool', () => {
  beforeEach(() => {
    mockESearch.mockReset();
    mockESummary.mockReset();
    mockExtractBriefSummaries.mockReset();
    mockExtractBriefSummaries.mockResolvedValue([]);
  });

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

    it.each([
      ['2024', '2024'],
      ['2024/01', '2024/12'],
      ['2024/01/15', '2024/12/31'],
      ['2024-01-15', '2024-12-31'],
      ['2024.01.15', '2024.12.31'],
    ])('accepts valid date formats: %s → %s', (minDate, maxDate) => {
      const result = searchArticlesTool.input.safeParse({
        query: 'cancer',
        dateRange: { minDate, maxDate },
      });
      expect(result.success).toBe(true);
    });

    it.each([
      ['not-a-date', '2024/12/31'],
      ['2024', 'also-invalid'],
      ['24', '2024'],
      ['2024/13/45abc', '2024/12/31'],
    ])('rejects invalid date formats: %s / %s', (minDate, maxDate) => {
      const result = searchArticlesTool.input.safeParse({
        query: 'cancer',
        dateRange: { minDate, maxDate },
      });
      expect(result.success).toBe(false);
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
    expect(result.effectiveQuery).toBe('cancer');
    expect(result.appliedFilters).toEqual({});
    expect(result.summaries).toEqual([]);
    expect(result.searchUrl).toContain('cancer');
  });

  it('builds filtered queries and enriches summaries through WebEnv history', async () => {
    mockESearch.mockResolvedValue({
      count: 2,
      idList: ['111', '222'],
      retmax: 20,
      retstart: 5,
      queryTranslation: 'asthma[All Fields]',
      webEnv: 'NCBI_ENV',
      queryKey: '7',
    });
    mockESummary.mockResolvedValue({ eSummaryResult: {} });
    mockExtractBriefSummaries.mockResolvedValue([
      {
        pmid: '111',
        title: 'Asthma Outcomes',
        authors: 'Smith J',
        source: 'Nature',
        pubDate: '2024-01-01',
        doi: '10.1000/example',
        pmcId: 'PMC12345',
      },
    ]);

    const ctx = createMockContext();
    const input = searchArticlesTool.input.parse({
      query: 'asthma',
      offset: 5,
      summaryCount: 1,
      dateRange: { minDate: '2020-01-01', maxDate: '2024-12-31', dateType: 'mdat' },
      publicationTypes: ['Review', 'Clinical Trial'],
      author: 'Smith J',
      journal: 'Nature',
      meshTerms: ['Asthma', 'Inflammation'],
      language: 'english',
      hasAbstract: true,
      freeFullText: true,
      species: 'humans',
    });
    const result = await searchArticlesTool.handler(input, ctx);

    expect(mockESearch).toHaveBeenCalledWith(
      expect.objectContaining({
        usehistory: 'y',
        retstart: 5,
      }),
    );

    const calledTerm = mockESearch.mock.calls[0]?.[0]?.term as string;
    expect(calledTerm).toContain('2020/01/01[mdat]');
    expect(calledTerm).toContain('2024/12/31[mdat]');
    expect(calledTerm).toContain(
      '"Review"[Publication Type] OR "Clinical Trial"[Publication Type]',
    );
    expect(calledTerm).toContain('Smith J[Author]');
    expect(calledTerm).toContain('"Nature"[Journal]');
    expect(calledTerm).toContain('"Asthma"[MeSH Terms] AND "Inflammation"[MeSH Terms]');
    expect(calledTerm).toContain('english[Language]');
    expect(calledTerm).toContain('hasabstract[text word]');
    expect(calledTerm).toContain('free full text[filter]');
    expect(calledTerm).toContain('humans[MeSH Terms]');

    expect(mockESummary).toHaveBeenCalledWith({
      db: 'pubmed',
      version: '2.0',
      retmode: 'xml',
      WebEnv: 'NCBI_ENV',
      query_key: '7',
      retmax: 1,
      retstart: 5,
    });
    expect(result.summaries).toEqual([
      {
        pmid: '111',
        title: 'Asthma Outcomes',
        authors: 'Smith J',
        source: 'Nature',
        pubDate: '2024-01-01',
        doi: '10.1000/example',
        pmcId: 'PMC12345',
        pmcUrl: 'https://www.ncbi.nlm.nih.gov/pmc/articles/PMC12345/',
        pubmedUrl: 'https://pubmed.ncbi.nlm.nih.gov/111/',
      },
    ]);
    expect(result.effectiveQuery).toContain('2020/01/01[mdat]');
    expect(result.appliedFilters).toEqual({
      dateRange: {
        minDate: '2020/01/01',
        maxDate: '2024/12/31',
        dateType: 'mdat',
      },
      publicationTypes: ['Review', 'Clinical Trial'],
      author: 'Smith J',
      journal: 'Nature',
      meshTerms: ['Asthma', 'Inflammation'],
      language: 'english',
      hasAbstract: true,
      freeFullText: true,
      species: 'humans',
    });
  });

  it('clamps history-backed summary fetches to the returned PMID page', async () => {
    mockESearch.mockResolvedValue({
      count: 10,
      idList: ['111', '222'],
      retmax: 2,
      retstart: 0,
      queryTranslation: 'asthma[All Fields]',
      webEnv: 'NCBI_ENV',
      queryKey: '7',
    });
    mockESummary.mockResolvedValue({ eSummaryResult: {} });

    const ctx = createMockContext();
    const input = searchArticlesTool.input.parse({
      query: 'asthma',
      maxResults: 2,
      summaryCount: 5,
    });
    await searchArticlesTool.handler(input, ctx);

    expect(mockESummary).toHaveBeenCalledWith({
      db: 'pubmed',
      version: '2.0',
      retmode: 'xml',
      WebEnv: 'NCBI_ENV',
      query_key: '7',
      retmax: 2,
      retstart: 0,
    });
  });

  it('falls back to direct PMID summary fetch when history tokens are absent', async () => {
    mockESearch.mockResolvedValue({
      count: 2,
      idList: ['111', '222'],
      retmax: 2,
      retstart: 0,
      queryTranslation: 'asthma[All Fields]',
    });
    mockESummary.mockResolvedValue({ eSummaryResult: {} });

    const ctx = createMockContext();
    const input = searchArticlesTool.input.parse({
      query: 'asthma',
      summaryCount: 2,
    });
    await searchArticlesTool.handler(input, ctx);

    expect(mockESummary).toHaveBeenCalledWith({
      db: 'pubmed',
      version: '2.0',
      retmode: 'xml',
      id: '111,222',
    });
  });

  describe('empty-result notice', () => {
    it('suggests spell-check when totalFound is 0 and no filters applied', async () => {
      mockESearch.mockResolvedValue({
        count: 0,
        idList: [],
        retmax: 20,
        retstart: 0,
        queryTranslation: 'xyznothingmatches[All Fields]',
      });

      const ctx = createMockContext();
      const input = searchArticlesTool.input.parse({ query: 'xyznothingmatches' });
      const result = await searchArticlesTool.handler(input, ctx);

      expect(result.notice).toBeDefined();
      expect(result.notice).toContain('pubmed_spell_check');
    });

    it('suggests removing filters when totalFound is 0 with filters applied', async () => {
      mockESearch.mockResolvedValue({
        count: 0,
        idList: [],
        retmax: 20,
        retstart: 0,
        queryTranslation: 'cancer[All Fields] AND ...',
      });

      const ctx = createMockContext();
      const input = searchArticlesTool.input.parse({
        query: 'cancer',
        author: 'Smith J',
        meshTerms: ['Asthma'],
      });
      const result = await searchArticlesTool.handler(input, ctx);

      expect(result.notice).toBeDefined();
      expect(result.notice).toContain('filters');
    });

    it('warns when offset exceeds totalFound', async () => {
      mockESearch.mockResolvedValue({
        count: 100,
        idList: [],
        retmax: 20,
        retstart: 200,
        queryTranslation: 'cancer[All Fields]',
      });

      const ctx = createMockContext();
      const input = searchArticlesTool.input.parse({ query: 'cancer', offset: 200 });
      const result = await searchArticlesTool.handler(input, ctx);

      expect(result.notice).toBeDefined();
      expect(result.notice).toContain('Offset 200');
      expect(result.notice).toContain('totalFound (100)');
    });

    it('omits notice on a successful result page', async () => {
      mockESearch.mockResolvedValue({
        count: 100,
        idList: ['111', '222'],
        retmax: 20,
        retstart: 0,
        queryTranslation: 'cancer[All Fields]',
      });

      const ctx = createMockContext();
      const input = searchArticlesTool.input.parse({ query: 'cancer' });
      const result = await searchArticlesTool.handler(input, ctx);

      expect(result.notice).toBeUndefined();
    });
  });

  it('formats output', () => {
    const blocks = searchArticlesTool.format!({
      query: 'cancer',
      effectiveQuery: 'cancer',
      appliedFilters: {},
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

  it('formats summaries with article metadata and links', () => {
    const blocks = searchArticlesTool.format!({
      query: 'asthma',
      effectiveQuery: 'asthma AND (2020/01/01[mdat] : 2024/12/31[mdat]) AND "Nature"[Journal]',
      appliedFilters: {
        dateRange: {
          minDate: '2020/01/01',
          maxDate: '2024/12/31',
          dateType: 'mdat',
        },
        journal: 'Nature',
      },
      totalFound: 2,
      offset: 0,
      pmids: ['111'],
      summaries: [
        {
          pmid: '111',
          title: 'Asthma Outcomes',
          authors: 'Smith J',
          source: 'Nature',
          pubDate: '2024-01-01',
          doi: '10.1000/example',
          pubmedUrl: 'https://pubmed.ncbi.nlm.nih.gov/111/',
          pmcUrl: 'https://www.ncbi.nlm.nih.gov/pmc/articles/PMC12345/',
        },
      ],
      searchUrl: 'https://pubmed.ncbi.nlm.nih.gov/?term=asthma',
    });

    expect(blocks[0]?.text).toContain('### Summaries');
    expect(blocks[0]?.text).toContain('**Effective Query:**');
    expect(blocks[0]?.text).toContain('### Applied Filters');
    expect(blocks[0]?.text).toContain('**Date Range (mdat):** 2020/01/01 to 2024/12/31');
    expect(blocks[0]?.text).toContain('**Journal:** Nature');
    expect(blocks[0]?.text).toContain('Asthma Outcomes');
    expect(blocks[0]?.text).toContain('**Authors:** Smith J');
    expect(blocks[0]?.text).toContain('**Source:** Nature');
    expect(blocks[0]?.text).toContain('**Published:** 2024-01-01');
    expect(blocks[0]?.text).toContain('**DOI:** 10.1000/example');
    expect(blocks[0]?.text).toContain('**PubMed:** https://pubmed.ncbi.nlm.nih.gov/111/');
    expect(blocks[0]?.text).toContain(
      '**PMC:** https://www.ncbi.nlm.nih.gov/pmc/articles/PMC12345/',
    );
  });
});
