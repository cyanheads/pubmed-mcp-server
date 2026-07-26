/**
 * @fileoverview Tests for the search-articles tool.
 * @module tests/mcp-server/tools/definitions/search-articles.tool.test
 */

import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
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

  describe('offset ceiling (issue #95)', () => {
    it('accepts an offset at PubMed’s retstart ceiling', () => {
      const result = searchArticlesTool.input.safeParse({ query: 'cancer', offset: 9998 });
      expect(result.success).toBe(true);
    });

    it('rejects an offset above the ceiling before it reaches NCBI', async () => {
      const result = searchArticlesTool.input.safeParse({ query: 'cancer', offset: 9999 });
      expect(result.success).toBe(false);
      expect(mockESearch).not.toHaveBeenCalled();
    });

    it('documents the ceiling in the offset description', () => {
      expect(searchArticlesTool.input.shape.offset.description).toContain('9998');
    });
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

    describe('partial dateRange notice (issue #97)', () => {
      beforeEach(() => {
        mockESearch.mockResolvedValue({
          count: 69489,
          idList: ['111'],
          retmax: 20,
          retstart: 0,
          queryTranslation: 'crispr[All Fields]',
        });
      });

      it('discloses the dropped filter when only minDate is supplied', async () => {
        const ctx = createMockContext();
        const input = searchArticlesTool.input.parse({
          query: 'crispr',
          dateRange: { minDate: '2024', maxDate: '' },
        });
        await searchArticlesTool.handler(input, ctx);

        const notice = getEnrichment(ctx).notice as string;
        expect(notice).toContain('No date filter was applied');
        expect(notice).toContain('`minDate` ("2024")');
        expect(notice).toContain('`maxDate: "3000"`');
        expect(getEnrichment(ctx).appliedFilters).toEqual({});
      });

      it('discloses the dropped filter when only maxDate is supplied', async () => {
        const ctx = createMockContext();
        const input = searchArticlesTool.input.parse({
          query: 'crispr',
          dateRange: { minDate: '', maxDate: '2024' },
        });
        await searchArticlesTool.handler(input, ctx);

        const notice = getEnrichment(ctx).notice as string;
        expect(notice).toContain('`maxDate` ("2024")');
        expect(notice).toContain('`minDate: "1800"`');
      });

      it('stays silent when both bounds are empty', async () => {
        const ctx = createMockContext();
        const input = searchArticlesTool.input.parse({
          query: 'crispr',
          dateRange: { minDate: '', maxDate: '' },
        });
        await searchArticlesTool.handler(input, ctx);

        expect(getEnrichment(ctx).notice).toBeUndefined();
      });

      it('stays silent when both bounds are supplied', async () => {
        const ctx = createMockContext();
        const input = searchArticlesTool.input.parse({
          query: 'crispr',
          dateRange: { minDate: '2024', maxDate: '2026' },
        });
        await searchArticlesTool.handler(input, ctx);

        expect(getEnrichment(ctx).notice).toBeUndefined();
      });
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

    const enrichment = getEnrichment(ctx);
    expect(enrichment.totalCount).toBe(100);
    expect(result.pmids).toEqual(['111', '222', '333']);
    expect(result.query).toBe('cancer');
    expect(enrichment.effectiveQuery).toBe('cancer');
    expect(enrichment.appliedFilters).toEqual({});
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
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
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

    expect(mockESummary).toHaveBeenCalledWith(
      {
        db: 'pubmed',
        version: '2.0',
        retmode: 'xml',
        WebEnv: 'NCBI_ENV',
        query_key: '7',
        retmax: 1,
        retstart: 5,
      },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
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
    const enrichment = getEnrichment(ctx);
    expect(enrichment.effectiveQuery).toContain('2020/01/01[mdat]');
    expect(enrichment.appliedFilters).toEqual({
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

    expect(mockESummary).toHaveBeenCalledWith(
      {
        db: 'pubmed',
        version: '2.0',
        retmode: 'xml',
        WebEnv: 'NCBI_ENV',
        query_key: '7',
        retmax: 2,
        retstart: 0,
      },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
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

    expect(mockESummary).toHaveBeenCalledWith(
      {
        db: 'pubmed',
        version: '2.0',
        retmode: 'xml',
        id: '111,222',
      },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  describe('empty-result notice', () => {
    it('suggests spell-check when totalCount is 0 and no filters applied', async () => {
      mockESearch.mockResolvedValue({
        count: 0,
        idList: [],
        retmax: 20,
        retstart: 0,
        queryTranslation: 'xyznothingmatches[All Fields]',
      });

      const ctx = createMockContext();
      const input = searchArticlesTool.input.parse({ query: 'xyznothingmatches' });
      await searchArticlesTool.handler(input, ctx);

      const enrichment = getEnrichment(ctx);
      expect(enrichment.notice).toBeDefined();
      expect(enrichment.notice).toContain('pubmed_spell_check');
    });

    it('suggests removing filters when totalCount is 0 with filters applied', async () => {
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
      await searchArticlesTool.handler(input, ctx);

      const enrichment = getEnrichment(ctx);
      expect(enrichment.notice).toBeDefined();
      expect(enrichment.notice).toContain('filters');
    });

    it('warns when offset exceeds totalCount', async () => {
      mockESearch.mockResolvedValue({
        count: 100,
        idList: [],
        retmax: 20,
        retstart: 200,
        queryTranslation: 'cancer[All Fields]',
      });

      const ctx = createMockContext();
      const input = searchArticlesTool.input.parse({ query: 'cancer', offset: 200 });
      await searchArticlesTool.handler(input, ctx);

      const enrichment = getEnrichment(ctx);
      expect(enrichment.notice).toBeDefined();
      expect(enrichment.notice).toContain('Offset 200');
      expect(enrichment.notice).toContain('totalCount (100)');
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
      await searchArticlesTool.handler(input, ctx);

      expect(getEnrichment(ctx).notice).toBeUndefined();
    });
  });

  describe('upstream ErrorList / WarningList diagnostics (issue #96)', () => {
    it('flags an ignored field tag even when the search returned hits', async () => {
      // NCBI drops the unknown field restriction and searches free text, so the
      // count is the unrestricted one — nothing else distinguishes it.
      mockESearch.mockResolvedValue({
        count: 870,
        idList: ['111', '222'],
        retmax: 20,
        retstart: 0,
        queryTranslation: 'lecanemab[All Fields]',
        errorList: { FieldNotFound: ['NoSuchField'] },
      });

      const ctx = createMockContext();
      const input = searchArticlesTool.input.parse({ query: 'lecanemab[NoSuchField]' });
      await searchArticlesTool.handler(input, ctx);

      const notice = getEnrichment(ctx).notice as string;
      expect(notice).toContain('`NoSuchField`');
      expect(notice).toContain('free text');
    });

    it('names every ignored field tag when NCBI reports more than one', async () => {
      mockESearch.mockResolvedValue({
        count: 12,
        idList: ['111'],
        retmax: 20,
        retstart: 0,
        queryTranslation: 'smith[All Fields]',
        errorList: { FieldNotFound: ['Aithor', 'Jrnal'] },
      });

      const ctx = createMockContext();
      const input = searchArticlesTool.input.parse({ query: 'smith[Aithor] AND x[Jrnal]' });
      await searchArticlesTool.handler(input, ctx);

      const notice = getEnrichment(ctx).notice as string;
      expect(notice).toContain('`Aithor`, `Jrnal`');
    });

    it('names the unmatched clause instead of the generic filter guidance', async () => {
      mockESearch.mockResolvedValue({
        count: 0,
        idList: [],
        retmax: 20,
        retstart: 0,
        queryTranslation: 'lecanemab[All Fields]',
        warningList: {
          QuotedPhraseNotFound: ['"Notarealmeshterm"[MeSH Terms]'],
          OutputMessage: ['No items found.'],
        },
      });

      const ctx = createMockContext();
      const input = searchArticlesTool.input.parse({
        query: 'lecanemab',
        meshTerms: ['Notarealmeshterm'],
      });
      await searchArticlesTool.handler(input, ctx);

      const notice = getEnrichment(ctx).notice as string;
      expect(notice).toContain('`"Notarealmeshterm"[MeSH Terms]`');
      expect(notice).toContain('pubmed_lookup_mesh');
      // The precise clause replaces the guess-across-every-filter message.
      expect(notice).not.toContain('Try removing filters');
    });

    it('surfaces ErrorList.PhraseNotFound alongside hits', async () => {
      mockESearch.mockResolvedValue({
        count: 5,
        idList: ['111'],
        retmax: 20,
        retstart: 0,
        queryTranslation: 'x[All Fields]',
        errorList: { PhraseNotFound: ['zzznomatch'] },
      });

      const ctx = createMockContext();
      const input = searchArticlesTool.input.parse({ query: 'x zzznomatch' });
      await searchArticlesTool.handler(input, ctx);

      expect(getEnrichment(ctx).notice).toContain('`zzznomatch`');
    });

    it('ignores OutputMessage-only warnings on a normal result page', async () => {
      mockESearch.mockResolvedValue({
        count: 5580000,
        idList: ['111'],
        retmax: 20,
        retstart: 0,
        queryTranslation: 'cancer[All Fields]',
        warningList: { OutputMessage: ['Restrictions achieved. start and count adjusted to 0, 1'] },
      });

      const ctx = createMockContext();
      const input = searchArticlesTool.input.parse({ query: 'cancer' });
      await searchArticlesTool.handler(input, ctx);

      expect(getEnrichment(ctx).notice).toBeUndefined();
    });
  });

  describe('notice composition across signals (issues #95, #96, #97)', () => {
    it('composes a partial dateRange with an ignored field tag on a hit-bearing page', async () => {
      mockESearch.mockResolvedValue({
        count: 870,
        idList: ['111'],
        retmax: 20,
        retstart: 0,
        queryTranslation: 'lecanemab[All Fields]',
        errorList: { FieldNotFound: ['NoSuchField'] },
      });

      const ctx = createMockContext();
      const input = searchArticlesTool.input.parse({
        query: 'lecanemab[NoSuchField]',
        dateRange: { minDate: '2024', maxDate: '' },
      });
      await searchArticlesTool.handler(input, ctx);

      const notice = getEnrichment(ctx).notice as string;
      expect(notice).toContain('No date filter was applied');
      expect(notice).toContain('`NoSuchField`');
    });

    it('composes a partial dateRange with the generic empty-result guidance', async () => {
      mockESearch.mockResolvedValue({
        count: 0,
        idList: [],
        retmax: 20,
        retstart: 0,
        queryTranslation: 'zzz[All Fields]',
      });

      const ctx = createMockContext();
      const input = searchArticlesTool.input.parse({
        query: 'zzz',
        dateRange: { minDate: '', maxDate: '2024' },
      });
      await searchArticlesTool.handler(input, ctx);

      const notice = getEnrichment(ctx).notice as string;
      expect(notice).toContain('No date filter was applied');
      expect(notice).toContain('pubmed_spell_check');
    });

    it('composes a partial dateRange with the offset-overshoot warning', async () => {
      mockESearch.mockResolvedValue({
        count: 100,
        idList: [],
        retmax: 20,
        retstart: 200,
        queryTranslation: 'cancer[All Fields]',
      });

      const ctx = createMockContext();
      const input = searchArticlesTool.input.parse({
        query: 'cancer',
        offset: 200,
        dateRange: { minDate: '2024', maxDate: '' },
      });
      await searchArticlesTool.handler(input, ctx);

      const notice = getEnrichment(ctx).notice as string;
      expect(notice).toContain('No date filter was applied');
      expect(notice).toContain('Offset 200 exceeds totalCount (100)');
    });

    it('composes an ignored field tag with the offset-overshoot warning', async () => {
      mockESearch.mockResolvedValue({
        count: 100,
        idList: [],
        retmax: 20,
        retstart: 200,
        queryTranslation: 'smith[All Fields]',
        errorList: { FieldNotFound: ['Aithor'] },
      });

      const ctx = createMockContext();
      const input = searchArticlesTool.input.parse({ query: 'smith[Aithor]', offset: 200 });
      await searchArticlesTool.handler(input, ctx);

      const notice = getEnrichment(ctx).notice as string;
      expect(notice).toContain('`Aithor`');
      expect(notice).toContain('Offset 200 exceeds totalCount (100)');
    });

    it('composes every signal that applies to an empty filtered result', async () => {
      mockESearch.mockResolvedValue({
        count: 0,
        idList: [],
        retmax: 20,
        retstart: 0,
        queryTranslation: 'smith[All Fields]',
        errorList: { FieldNotFound: ['Aithor'] },
        warningList: { QuotedPhraseNotFound: ['"Notarealmeshterm"[MeSH Terms]'] },
      });

      const ctx = createMockContext();
      const input = searchArticlesTool.input.parse({
        query: 'smith[Aithor]',
        meshTerms: ['Notarealmeshterm'],
        dateRange: { minDate: '2024', maxDate: '' },
      });
      await searchArticlesTool.handler(input, ctx);

      const notice = getEnrichment(ctx).notice as string;
      expect(notice).toContain('No date filter was applied');
      expect(notice).toContain('`Aithor`');
      expect(notice).toContain('`"Notarealmeshterm"[MeSH Terms]`');
      // Named clauses win over the generic filter guidance.
      expect(notice).not.toContain('Try removing filters');
    });
  });

  it('formats output', () => {
    const blocks = searchArticlesTool.format!({
      query: 'cancer',
      offset: 0,
      pmids: ['111', '222'],
      summaries: [],
      searchUrl: 'https://pubmed.ncbi.nlm.nih.gov/?term=cancer',
    });
    expect(blocks[0]?.text).toContain('PubMed Search Results');
    expect(blocks[0]?.text).toContain('cancer');
  });

  describe('count-split note (issue #44)', () => {
    it('explains the asymmetry when summaries.length < pmids.length', () => {
      const blocks = searchArticlesTool.format!({
        query: 'glp-1',
        offset: 0,
        pmids: ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10'],
        summaries: [
          { pmid: '1', title: 'A', pubmedUrl: 'https://pubmed.ncbi.nlm.nih.gov/1/' },
          { pmid: '2', title: 'B', pubmedUrl: 'https://pubmed.ncbi.nlm.nih.gov/2/' },
          { pmid: '3', title: 'C', pubmedUrl: 'https://pubmed.ncbi.nlm.nih.gov/3/' },
          { pmid: '4', title: 'D', pubmedUrl: 'https://pubmed.ncbi.nlm.nih.gov/4/' },
          { pmid: '5', title: 'E', pubmedUrl: 'https://pubmed.ncbi.nlm.nih.gov/5/' },
        ],
        searchUrl: 'https://pubmed.ncbi.nlm.nih.gov/?term=glp-1',
      });
      const text = blocks[0]?.text ?? '';
      expect(text).toContain('Summaries shown for top 5 of 10 PMIDs');
      expect(text).toContain('summaryCount');
    });

    it('omits the note when summaries.length === pmids.length', () => {
      const blocks = searchArticlesTool.format!({
        query: 'glp-1',
        offset: 0,
        pmids: ['1', '2'],
        summaries: [
          { pmid: '1', title: 'A', pubmedUrl: 'https://pubmed.ncbi.nlm.nih.gov/1/' },
          { pmid: '2', title: 'B', pubmedUrl: 'https://pubmed.ncbi.nlm.nih.gov/2/' },
        ],
        searchUrl: 'https://pubmed.ncbi.nlm.nih.gov/?term=glp-1',
      });
      expect(blocks[0]?.text).not.toContain('Summaries shown for top');
    });

    it('omits the note when summaries are empty', () => {
      const blocks = searchArticlesTool.format!({
        query: 'glp-1',
        offset: 0,
        pmids: ['1', '2'],
        summaries: [],
        searchUrl: 'https://pubmed.ncbi.nlm.nih.gov/?term=glp-1',
      });
      expect(blocks[0]?.text).not.toContain('Summaries shown for top');
    });

    describe('at the summaryCount cap (issue #97)', () => {
      /** `format()` sees only the result, so "at the cap" is read off the rendered summary count. */
      const pmids = (n: number) => Array.from({ length: n }, (_, i) => String(i + 1));
      const summaries = (n: number) =>
        pmids(n).map((pmid) => ({
          pmid,
          title: `Article ${pmid}`,
          pubmedUrl: `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`,
        }));

      it('points at pubmed_fetch_articles when the cap is reached', () => {
        const blocks = searchArticlesTool.format!({
          query: 'glp-1',
          offset: 0,
          pmids: pmids(60),
          summaries: summaries(50),
          searchUrl: 'https://pubmed.ncbi.nlm.nih.gov/?term=glp-1',
        });
        const text = blocks[0]?.text ?? '';
        expect(text).toContain('Summaries shown for top 50 of 60 PMIDs');
        expect(text).toContain('`summaryCount` is at its maximum (50)');
        expect(text).toContain('Fetch the remaining 10 with `pubmed_fetch_articles`');
        expect(text).not.toContain('Increase `summaryCount`');
      });

      it('still advises raising summaryCount below the cap', () => {
        const blocks = searchArticlesTool.format!({
          query: 'glp-1',
          offset: 0,
          pmids: pmids(60),
          summaries: summaries(49),
          searchUrl: 'https://pubmed.ncbi.nlm.nih.gov/?term=glp-1',
        });
        const text = blocks[0]?.text ?? '';
        expect(text).toContain('Increase `summaryCount` (max 50)');
        expect(text).not.toContain('pubmed_fetch_articles');
      });
    });
  });

  it('formats summaries with article metadata and links', () => {
    const blocks = searchArticlesTool.format!({
      query: 'asthma',
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
          pmcId: 'PMC12345',
          pubmedUrl: 'https://pubmed.ncbi.nlm.nih.gov/111/',
          pmcUrl: 'https://www.ncbi.nlm.nih.gov/pmc/articles/PMC12345/',
        },
      ],
      searchUrl: 'https://pubmed.ncbi.nlm.nih.gov/?term=asthma',
    });

    expect(blocks[0]?.text).toContain('### Summaries');
    expect(blocks[0]?.text).toContain('Asthma Outcomes');
    expect(blocks[0]?.text).toContain('**Authors:** Smith J');
    expect(blocks[0]?.text).toContain('**Source:** Nature');
    expect(blocks[0]?.text).toContain('**Published:** 2024-01-01');
    expect(blocks[0]?.text).toContain('**DOI:** 10.1000/example');
    expect(blocks[0]?.text).toContain('**PMCID:** PMC12345');
    expect(blocks[0]?.text).toContain('**PubMed:** https://pubmed.ncbi.nlm.nih.gov/111/');
    expect(blocks[0]?.text).toContain(
      '**PMC:** https://www.ncbi.nlm.nih.gov/pmc/articles/PMC12345/',
    );
  });
});
