/**
 * @fileoverview Tests for the fetch-fulltext tool.
 * @module tests/mcp-server/tools/definitions/fetch-fulltext.tool.test
 */

import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockEFetch = vi.fn();
const mockIdConvert = vi.fn();
const mockParsePmcArticle = vi.fn();
const mockUnpaywallResolve = vi.fn();
const mockUnpaywallFetchContent = vi.fn();
const mockGetUnpaywallService = vi.fn();
const mockEpmcSearch = vi.fn();
const mockEpmcFullTextXml = vi.fn();
const mockEpmcParseFullTextXml = vi.fn();
const mockGetEpmcService = vi.fn();
const mockHtmlExtract = vi.fn();
const mockPdfExtractText = vi.fn();

vi.mock('@/services/ncbi/ncbi-service.js', () => ({
  getNcbiService: () => ({ eFetch: mockEFetch, idConvert: mockIdConvert }),
}));
vi.mock('@/services/ncbi/parsing/pmc-article-parser.js', () => ({
  parsePmcArticle: mockParsePmcArticle,
}));
vi.mock('@/services/unpaywall/unpaywall-service.js', () => ({
  getUnpaywallService: () => mockGetUnpaywallService(),
}));
vi.mock('@/services/europe-pmc/europe-pmc-service.js', () => ({
  getEuropePmcService: () => mockGetEpmcService(),
}));
vi.mock('@cyanheads/mcp-ts-core/utils', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@cyanheads/mcp-ts-core/utils');
  return {
    ...actual,
    htmlExtractor: { extract: mockHtmlExtract },
    pdfParser: { extractText: mockPdfExtractText },
  };
});

const { fetchFulltextTool, buildFulltextDescription } = await import(
  '@/mcp-server/tools/definitions/fetch-fulltext.tool.js'
);

/**
 * Configure `mockEFetch` to dispatch by `db` — mirrors production:
 *   - `db=pmc` returns the PMC JATS body.
 *   - `db=pubmed` returns a PubmedArticleSet where each entry encodes a DOI in
 *     the canonical ELocationID[ValidYN=Y] slot, reflecting how NCBI surfaces
 *     DOIs for articles the PMC ID Converter omits.
 */
function mockEFetchBy(opts: { pmc?: unknown; pubmedDois?: Record<string, string> }) {
  mockEFetch.mockImplementation(async (params: { db: string }) => {
    if (params.db === 'pmc') {
      return opts.pmc ?? [{ 'pmc-articleset': [{ article: [] }] }];
    }
    if (params.db === 'pubmed') {
      const pmidToDoi = opts.pubmedDois ?? {};
      const articles = Object.entries(pmidToDoi).map(([pmid, doi]) => ({
        MedlineCitation: {
          PMID: { '#text': pmid },
          Article: {
            ELocationID: [{ '#text': doi, '@_EIdType': 'doi', '@_ValidYN': 'Y' }],
          },
        },
      }));
      return { PubmedArticleSet: { PubmedArticle: articles } };
    }
    throw new Error(`Unexpected eFetch db=${params.db}`);
  });
}

describe('fetchFulltextTool', () => {
  beforeEach(() => {
    mockEFetch.mockReset();
    mockIdConvert.mockReset();
    mockParsePmcArticle.mockReset();
    mockUnpaywallResolve.mockReset();
    mockUnpaywallFetchContent.mockReset();
    mockGetUnpaywallService.mockReset();
    mockEpmcSearch.mockReset();
    mockEpmcFullTextXml.mockReset();
    mockEpmcParseFullTextXml.mockReset();
    mockGetEpmcService.mockReset();
    mockHtmlExtract.mockReset();
    mockPdfExtractText.mockReset();
    mockGetUnpaywallService.mockReturnValue(undefined);
    mockGetEpmcService.mockReturnValue(undefined);
  });

  describe('input validation', () => {
    it('accepts pmcids', () => {
      const input = fetchFulltextTool.input.parse({ pmcids: ['PMC1234567'] });
      expect(input.pmcids).toEqual(['PMC1234567']);
    });

    it('accepts dois (issue #52)', () => {
      const input = fetchFulltextTool.input.parse({ dois: ['10.1000/example'] });
      expect(input.dois).toEqual(['10.1000/example']);
    });

    it('rejects non-numeric PMIDs with an actionable error message (issue #27)', () => {
      const parsed = fetchFulltextTool.input.safeParse({ pmids: ['abc'] });
      expect(parsed.success).toBe(false);
      const message = parsed.error?.issues[0]?.message ?? '';
      expect(message).toMatch(/PMID/);
      expect(message).toMatch(/numeric/);
      expect(message).toContain('13054692');
    });

    it('rejects input with no input branch (issue #46)', () => {
      const parsed = fetchFulltextTool.input.safeParse({});
      expect(parsed.success).toBe(false);
      expect(parsed.error?.issues[0]?.message).toMatch(/exactly one of/);
    });

    it('rejects input with two branches set (issue #46)', () => {
      const parsed = fetchFulltextTool.input.safeParse({
        pmcids: ['PMC1'],
        pmids: ['12345'],
      });
      expect(parsed.success).toBe(false);
      expect(parsed.error?.issues[0]?.message).toMatch(/exactly one of/);
    });

    it('rejects input with all three branches set', () => {
      const parsed = fetchFulltextTool.input.safeParse({
        pmcids: ['PMC1'],
        pmids: ['12345'],
        dois: ['10.1/x'],
      });
      expect(parsed.success).toBe(false);
    });

    it('rejects input with pmids and dois set together', () => {
      const parsed = fetchFulltextTool.input.safeParse({
        pmids: ['12345'],
        dois: ['10.1/x'],
      });
      expect(parsed.success).toBe(false);
    });
  });

  describe('buildFulltextDescription (config-aware tiers, issue #65)', () => {
    it('advertises Europe PMC and Unpaywall when both tiers are enabled', () => {
      const d = buildFulltextDescription({ europePmc: true, unpaywall: true });
      expect(d).toContain('Europe PMC');
      expect(d).toContain('Unpaywall');
      expect(d).toContain('ID Converter');
    });

    it('advertises only Europe PMC when Unpaywall is disabled', () => {
      const d = buildFulltextDescription({ europePmc: true, unpaywall: false });
      expect(d).toContain('Europe PMC');
      expect(d).not.toContain('Unpaywall');
    });

    it('advertises only Unpaywall when Europe PMC is disabled', () => {
      const d = buildFulltextDescription({ europePmc: false, unpaywall: true });
      expect(d).toContain('Unpaywall');
      expect(d).not.toContain('Europe PMC');
    });

    it('advertises no fallback when both tiers are disabled', () => {
      const d = buildFulltextDescription({ europePmc: false, unpaywall: false });
      expect(d).not.toContain('Europe PMC');
      expect(d).not.toContain('Unpaywall');
      expect(d).toContain('PubMed Central only');
    });

    it('always names the three input shapes and the ID Converter DOI path', () => {
      for (const tiers of [
        { europePmc: true, unpaywall: true },
        { europePmc: true, unpaywall: false },
        { europePmc: false, unpaywall: true },
        { europePmc: false, unpaywall: false },
      ]) {
        const d = buildFulltextDescription(tiers);
        expect(d).toContain('`pmcids`');
        expect(d).toContain('`pmids`');
        expect(d).toContain('`dois`');
        expect(d).toContain('ID Converter');
      }
    });
  });

  describe('PMC path (existing behavior)', () => {
    it('fetches by PMC IDs and tags articles with viaSource=pmc', async () => {
      mockParsePmcArticle.mockReturnValue({
        pmcId: 'PMC1234567',
        pmcUrl: 'https://www.ncbi.nlm.nih.gov/pmc/articles/PMC1234567/',
        title: 'Full Text Article',
        sections: [{ title: 'Introduction', text: 'Body text.' }],
      });
      mockEFetch.mockResolvedValue([{ 'pmc-articleset': [{ article: [] }] }]);

      const ctx = createMockContext();
      const input = fetchFulltextTool.input.parse({ pmcids: ['PMC1234567'] });
      const result = await fetchFulltextTool.handler(input, ctx);

      expect(mockEFetch).toHaveBeenCalledWith(
        { db: 'pmc', id: '1234567', retmode: 'xml' },
        expect.objectContaining({
          retmode: 'xml',
          useOrderedParser: true,
          usePost: false,
          signal: expect.any(AbortSignal),
        }),
      );
      expect(result.totalReturned).toBe(1);
      const first = result.articles[0];
      expect(first?.source).toBe('pmc');
      if (first?.source === 'pmc') {
        expect(first.viaSource).toBe('pmc');
        expect(first.pmcId).toBe('PMC1234567');
        expect(first.title).toBe('Full Text Article');
      }
    });

    it('falls through to next tier when PMC EFetch returns a malformed payload', async () => {
      // The chain's contract is graceful fallback — a malformed PMC response
      // gets stamped as pmc:service-error and downstream tiers still run.
      mockEFetch.mockResolvedValue([]);

      const ctx = createMockContext();
      const input = fetchFulltextTool.input.parse({ pmcids: ['PMC1'] });
      const result = await fetchFulltextTool.handler(input, ctx);

      expect(result.totalReturned).toBe(0);
      expect(result.unavailable).toEqual([
        {
          id: 'PMC1',
          idType: 'pmcid',
          reason: 'service-error',
          triedTiers: [
            {
              tier: 'pmc',
              outcome: 'service-error',
              detail: 'PMC EFetch response missing pmc-articleset wrapper',
            },
            { tier: 'europepmc', outcome: 'not-attempted', detail: 'EUROPEPMC_ENABLED=false' },
            { tier: 'unpaywall', outcome: 'not-attempted', detail: 'UNPAYWALL_EMAIL is not set' },
          ],
        },
      ]);
    });

    it('routes pmcids batch to fallback tiers when PMC EFetch throws', async () => {
      mockEFetch.mockRejectedValue(new Error('NCBI 503'));

      const ctx = createMockContext();
      const input = fetchFulltextTool.input.parse({ pmcids: ['PMC1', 'PMC2'] });
      const result = await fetchFulltextTool.handler(input, ctx);

      expect(result.totalReturned).toBe(0);
      expect(result.unavailable).toEqual([
        {
          id: 'PMC1',
          idType: 'pmcid',
          reason: 'service-error',
          triedTiers: [
            { tier: 'pmc', outcome: 'service-error', detail: 'NCBI 503' },
            { tier: 'europepmc', outcome: 'not-attempted', detail: 'EUROPEPMC_ENABLED=false' },
            { tier: 'unpaywall', outcome: 'not-attempted', detail: 'UNPAYWALL_EMAIL is not set' },
          ],
        },
        {
          id: 'PMC2',
          idType: 'pmcid',
          reason: 'service-error',
          triedTiers: [
            { tier: 'pmc', outcome: 'service-error', detail: 'NCBI 503' },
            { tier: 'europepmc', outcome: 'not-attempted', detail: 'EUROPEPMC_ENABLED=false' },
            { tier: 'unpaywall', outcome: 'not-attempted', detail: 'UNPAYWALL_EMAIL is not set' },
          ],
        },
      ]);
    });

    it('reports unavailable PMC IDs when the chain finds nothing', async () => {
      mockEFetch.mockResolvedValue([{ 'pmc-articleset': [] }]);

      const ctx = createMockContext();
      const input = fetchFulltextTool.input.parse({ pmcids: ['PMC9999999'] });
      const result = await fetchFulltextTool.handler(input, ctx);

      expect(result.totalReturned).toBe(0);
      expect(result.articles).toEqual([]);
      expect(result.unavailable).toEqual([
        {
          id: 'PMC9999999',
          idType: 'pmcid',
          reason: 'not-found',
          triedTiers: [
            { tier: 'pmc', outcome: 'miss' },
            { tier: 'europepmc', outcome: 'not-attempted', detail: 'EUROPEPMC_ENABLED=false' },
            { tier: 'unpaywall', outcome: 'not-attempted', detail: 'UNPAYWALL_EMAIL is not set' },
          ],
        },
      ]);
    });

    it('normalizes direct PMC IDs and uses POST for large batches', async () => {
      mockParsePmcArticle.mockReturnValue({
        pmcId: 'PMC111',
        pmcUrl: 'https://www.ncbi.nlm.nih.gov/pmc/articles/PMC111/',
        title: 'Direct PMC Article',
        sections: [{ title: 'Introduction', text: 'Body.' }],
      });
      mockEFetch.mockResolvedValue([{ 'pmc-articleset': [{ article: [] }] }]);

      const ctx = createMockContext();
      const input = fetchFulltextTool.input.parse({
        pmcids: ['PMC111', '222', '333', '444', '555', '666'],
      });
      const result = await fetchFulltextTool.handler(input, ctx);

      expect(mockEFetch).toHaveBeenCalledWith(
        { db: 'pmc', id: '111,222,333,444,555,666', retmode: 'xml' },
        expect.objectContaining({
          retmode: 'xml',
          useOrderedParser: true,
          usePost: true,
          signal: expect.any(AbortSignal),
        }),
      );
      const expectedPmcMissChain = [
        { tier: 'pmc', outcome: 'miss' },
        { tier: 'europepmc', outcome: 'not-attempted', detail: 'EUROPEPMC_ENABLED=false' },
        { tier: 'unpaywall', outcome: 'not-attempted', detail: 'UNPAYWALL_EMAIL is not set' },
      ];
      expect(result.unavailable).toEqual([
        { id: 'PMC222', idType: 'pmcid', reason: 'not-found', triedTiers: expectedPmcMissChain },
        { id: 'PMC333', idType: 'pmcid', reason: 'not-found', triedTiers: expectedPmcMissChain },
        { id: 'PMC444', idType: 'pmcid', reason: 'not-found', triedTiers: expectedPmcMissChain },
        { id: 'PMC555', idType: 'pmcid', reason: 'not-found', triedTiers: expectedPmcMissChain },
        { id: 'PMC666', idType: 'pmcid', reason: 'not-found', triedTiers: expectedPmcMissChain },
      ]);
    });
  });

  describe('pmids → resolution chain', () => {
    it('resolves PMIDs via idConvert and applies section/reference filtering', async () => {
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
      mockEFetch.mockResolvedValue([{ 'pmc-articleset': [{ article: [] }] }]);

      const ctx = createMockContext();
      const input = fetchFulltextTool.input.parse({
        pmids: ['12345', '99999'],
        sections: ['intro'],
        maxSections: 1,
      });
      const result = await fetchFulltextTool.handler(input, ctx);

      expect(result.unavailable).toEqual([
        {
          id: '99999',
          idType: 'pmid',
          reason: 'no-pmc-fallback-disabled',
          triedTiers: [
            { tier: 'pmc', outcome: 'not-attempted', detail: 'PMID has no PMC counterpart' },
            { tier: 'europepmc', outcome: 'not-attempted', detail: 'EUROPEPMC_ENABLED=false' },
            { tier: 'unpaywall', outcome: 'not-attempted', detail: 'UNPAYWALL_EMAIL is not set' },
          ],
        },
      ]);
      const pmc = result.articles[0];
      expect(pmc?.source).toBe('pmc');
      if (pmc?.source === 'pmc') {
        expect(pmc.viaSource).toBe('pmc');
        expect(pmc.sections).toEqual([{ title: 'Introduction', text: 'Intro text.' }]);
        expect(pmc.references).toBeUndefined();
      }
    });

    it('returns empty when no PMIDs resolve and all fallbacks are disabled', async () => {
      mockIdConvert.mockResolvedValue([{ 'requested-id': '99999', pmid: '99999' }]);
      const ctx = createMockContext();
      const input = fetchFulltextTool.input.parse({ pmids: ['99999'] });
      const result = await fetchFulltextTool.handler(input, ctx);

      expect(result.totalReturned).toBe(0);
      expect(result.unavailable).toEqual([
        {
          id: '99999',
          idType: 'pmid',
          reason: 'no-pmc-fallback-disabled',
          triedTiers: [
            { tier: 'pmc', outcome: 'not-attempted', detail: 'PMID has no PMC counterpart' },
            { tier: 'europepmc', outcome: 'not-attempted', detail: 'EUROPEPMC_ENABLED=false' },
            { tier: 'unpaywall', outcome: 'not-attempted', detail: 'UNPAYWALL_EMAIL is not set' },
          ],
        },
      ]);
    });
  });

  describe('Europe PMC fallback (issue #52)', () => {
    function withEpmcMock() {
      mockGetEpmcService.mockReturnValue({
        search: mockEpmcSearch,
        fullTextXml: mockEpmcFullTextXml,
        parseFullTextXml: mockEpmcParseFullTextXml,
      });
    }

    it('recovers a PMID via Europe PMC fullTextXML when PMC misses it', async () => {
      // PMID had no PMC counterpart per the ID Converter, but the same article
      // surfaces in EPMC under SRC:MED with a `pmcid` — EPMC's fullTextXML is
      // PMC-keyed, so the chain looks up the JATS via that PMC ID.
      withEpmcMock();
      mockIdConvert.mockResolvedValue([{ 'requested-id': '42', pmid: '42' }]);
      mockEpmcSearch.mockResolvedValue({
        hits: [{ id: '42', source: 'MED', pmid: '42', pmcid: 'PMC42', doi: '10.1/x' }],
        hitCount: 1,
        cursorMark: '*',
      });
      mockEpmcFullTextXml.mockResolvedValue({
        kind: 'found',
        xml: '<article/>',
        epmcId: 'PMC42',
        source: 'MED',
      });
      mockEpmcParseFullTextXml.mockReturnValue({ article: [{ body: [] }] });
      mockParsePmcArticle.mockReturnValue({
        pmcId: 'PMC42',
        pmcUrl: 'https://www.ncbi.nlm.nih.gov/pmc/articles/PMC42/',
        title: 'EPMC-served article',
        sections: [{ title: 'Background', text: 'Body' }],
      });

      const ctx = createMockContext();
      const input = fetchFulltextTool.input.parse({ pmids: ['42'] });
      const result = await fetchFulltextTool.handler(input, ctx);

      expect(mockEpmcFullTextXml).toHaveBeenCalledWith('PMC42', 'MED', expect.any(AbortSignal));
      expect(result.totalReturned).toBe(1);
      const article = result.articles[0];
      expect(article?.source).toBe('pmc');
      if (article?.source === 'pmc') {
        expect(article.viaSource).toBe('europepmc');
        expect(article.epmcId).toBe('42');
        expect(article.epmcSource).toBe('MED');
        expect(article.pmid).toBe('42');
        expect(article.pmcId).toBe('PMC42');
      }
      expect(result.unavailable).toBeUndefined();
    });

    it('skips fullTextXML for preprint hits with no PMC counterpart', async () => {
      withEpmcMock();
      mockGetUnpaywallService.mockReturnValue({
        resolve: mockUnpaywallResolve,
        fetchContent: mockUnpaywallFetchContent,
      });
      mockIdConvert.mockResolvedValue([
        { 'requested-id': '10.21203/x', errmsg: 'Identifier not found in PMC' },
      ]);
      mockEpmcSearch.mockResolvedValue({
        hits: [{ id: 'PPR42', source: 'PPR', doi: '10.21203/x' }],
        hitCount: 1,
        cursorMark: '*',
      });
      mockUnpaywallResolve.mockResolvedValue({ kind: 'no-oa', reason: 'no oa' });

      const ctx = createMockContext();
      const input = fetchFulltextTool.input.parse({ dois: ['10.21203/x'] });
      const result = await fetchFulltextTool.handler(input, ctx);

      // No PMC ID on the PPR hit → fullTextXML is never called.
      expect(mockEpmcFullTextXml).not.toHaveBeenCalled();
      expect(result.totalReturned).toBe(0);
      expect(result.unavailable).toEqual([
        {
          id: '10.21203/x',
          idType: 'doi',
          reason: 'no-oa',
          triedTiers: [
            { tier: 'pmc', outcome: 'not-attempted', detail: 'DOI has no PMC counterpart' },
            {
              tier: 'europepmc',
              outcome: 'no-fulltext',
              detail: 'EPMC source PPR has no PMC counterpart',
            },
            { tier: 'unpaywall', outcome: 'no-oa', detail: 'no oa' },
          ],
        },
      ]);
    });

    it('removes EPMC-recovered PMCIDs from the unavailable list', async () => {
      withEpmcMock();
      mockEpmcSearch.mockResolvedValue({
        hits: [{ id: 'PMC9999', source: 'PMC', pmcid: 'PMC9999', doi: '10.1/x' }],
        hitCount: 1,
        cursorMark: '*',
      });
      mockEpmcFullTextXml.mockResolvedValue({
        kind: 'found',
        xml: '<article/>',
        epmcId: 'PMC9999',
        source: 'PMC',
      });
      mockEpmcParseFullTextXml.mockReturnValue({ article: [{ body: [] }] });
      mockParsePmcArticle.mockReturnValue({
        pmcId: 'PMC9999',
        pmcUrl: 'https://www.ncbi.nlm.nih.gov/pmc/articles/PMC9999/',
        title: 'EPMC-served PMC article',
        sections: [{ title: 'Introduction', text: 'Body.' }],
      });
      mockEFetch.mockResolvedValue([{ 'pmc-articleset': [] }]);

      const ctx = createMockContext();
      const input = fetchFulltextTool.input.parse({ pmcids: ['PMC9999'] });
      const result = await fetchFulltextTool.handler(input, ctx);

      expect(result.totalReturned).toBe(1);
      expect(result.articles[0]?.source).toBe('pmc');
      if (result.articles[0]?.source === 'pmc') {
        expect(result.articles[0].viaSource).toBe('europepmc');
      }
      expect(result.unavailable).toBeUndefined();
    });

    it('falls through to Unpaywall when EPMC has no full text for the record', async () => {
      withEpmcMock();
      mockGetUnpaywallService.mockReturnValue({
        resolve: mockUnpaywallResolve,
        fetchContent: mockUnpaywallFetchContent,
      });
      mockIdConvert.mockResolvedValue([{ 'requested-id': '42', pmid: '42' }]);
      mockEFetchBy({ pubmedDois: { '42': '10.1000/example' } });
      mockEpmcSearch.mockResolvedValue({
        hits: [{ id: 'PPR42', source: 'PPR', pmid: '42', doi: '10.1000/example' }],
        hitCount: 1,
        cursorMark: '*',
      });
      mockEpmcFullTextXml.mockResolvedValue({ kind: 'not-available', reason: 'no XML' });
      mockUnpaywallResolve.mockResolvedValue({
        kind: 'found',
        location: { url: 'https://repo.example.org/paper', license: 'cc-by' },
      });
      mockUnpaywallFetchContent.mockResolvedValue({
        kind: 'html',
        fetchedUrl: 'https://repo.example.org/paper',
        body: '<html><body>Body</body></html>',
      });
      mockHtmlExtract.mockResolvedValue({ title: 'A paper', content: 'Body content' });

      const ctx = createMockContext();
      const input = fetchFulltextTool.input.parse({ pmids: ['42'] });
      const result = await fetchFulltextTool.handler(input, ctx);

      expect(result.totalReturned).toBe(1);
      const article = result.articles[0];
      expect(article?.source).toBe('unpaywall');
      if (article?.source === 'unpaywall') {
        expect(article.viaSource).toBe('unpaywall');
        expect(article.pmid).toBe('42');
        expect(article.doi).toBe('10.1000/example');
      }
    });

    it('continues chain when EPMC search throws', async () => {
      withEpmcMock();
      mockGetUnpaywallService.mockReturnValue({
        resolve: mockUnpaywallResolve,
        fetchContent: mockUnpaywallFetchContent,
      });
      mockIdConvert.mockResolvedValue([{ 'requested-id': '42', pmid: '42' }]);
      mockEFetchBy({ pubmedDois: { '42': '10.1000/example' } });
      mockEpmcSearch.mockRejectedValue(new Error('EPMC 503'));
      mockUnpaywallResolve.mockResolvedValue({
        kind: 'found',
        location: { url: 'https://repo.example.org/paper' },
      });
      mockUnpaywallFetchContent.mockResolvedValue({
        kind: 'html',
        fetchedUrl: 'https://repo.example.org/paper',
        body: '<html><body>Body</body></html>',
      });
      mockHtmlExtract.mockResolvedValue({ content: 'Body content' });

      const ctx = createMockContext();
      const input = fetchFulltextTool.input.parse({ pmids: ['42'] });
      const result = await fetchFulltextTool.handler(input, ctx);

      expect(result.totalReturned).toBe(1);
      expect(result.articles[0]?.source).toBe('unpaywall');
    });

    it('recovers a pmid via EPMC when PMC EFetch misses the converter-resolved PMCID', async () => {
      // Regression: PMID had a PMCID per the ID Converter (so it went into the
      // PMC EFetch batch), but PMC didn't return the article. The chain must
      // route this pmid into the EPMC stage with its known doi hint preserved.
      withEpmcMock();
      mockGetUnpaywallService.mockReturnValue({
        resolve: mockUnpaywallResolve,
        fetchContent: mockUnpaywallFetchContent,
      });
      mockIdConvert.mockResolvedValue([
        { 'requested-id': '42', pmid: '42', pmcid: 'PMC42', doi: '10.1/x' },
      ]);
      // PMC EFetch returns no articles so the converter-resolved PMCID misses.
      mockEFetch.mockResolvedValue([{ 'pmc-articleset': [] }]);
      mockEpmcSearch.mockResolvedValue({
        hits: [{ id: '42', source: 'MED', pmid: '42', pmcid: 'PMC42', doi: '10.1/x' }],
        hitCount: 1,
        cursorMark: '*',
      });
      mockEpmcFullTextXml.mockResolvedValue({
        kind: 'found',
        xml: '<article/>',
        epmcId: 'PMC42',
        source: 'MED',
      });
      mockEpmcParseFullTextXml.mockReturnValue({ article: [{ body: [] }] });
      mockParsePmcArticle.mockReturnValue({
        pmcId: 'PMC42',
        pmcUrl: 'https://www.ncbi.nlm.nih.gov/pmc/articles/PMC42/',
        title: 'EPMC-recovered article',
        sections: [{ title: 'Introduction', text: 'Body.' }],
      });

      const ctx = createMockContext();
      const input = fetchFulltextTool.input.parse({ pmids: ['42'] });
      const result = await fetchFulltextTool.handler(input, ctx);

      expect(mockEpmcSearch).toHaveBeenCalled();
      expect(result.totalReturned).toBe(1);
      const article = result.articles[0];
      expect(article?.source).toBe('pmc');
      if (article?.source === 'pmc') {
        expect(article.viaSource).toBe('europepmc');
        expect(article.pmid).toBe('42');
      }
      expect(result.unavailable).toBeUndefined();
    });

    it('falls all the way to Unpaywall when PMC misses a converter-resolved PMCID and EPMC has no fulltext', async () => {
      withEpmcMock();
      mockGetUnpaywallService.mockReturnValue({
        resolve: mockUnpaywallResolve,
        fetchContent: mockUnpaywallFetchContent,
      });
      mockIdConvert.mockResolvedValue([
        { 'requested-id': '42', pmid: '42', pmcid: 'PMC42', doi: '10.1/x' },
      ]);
      mockEFetch.mockResolvedValue([{ 'pmc-articleset': [] }]);
      mockEpmcSearch.mockResolvedValue({ hits: [], hitCount: 0, cursorMark: '*' });
      mockUnpaywallResolve.mockResolvedValue({
        kind: 'found',
        location: { url: 'https://repo.example.org/paper' },
      });
      mockUnpaywallFetchContent.mockResolvedValue({
        kind: 'html',
        fetchedUrl: 'https://repo.example.org/paper',
        body: '<html><body>Body</body></html>',
      });
      mockHtmlExtract.mockResolvedValue({ content: 'Body content' });

      const ctx = createMockContext();
      const input = fetchFulltextTool.input.parse({ pmids: ['42'] });
      const result = await fetchFulltextTool.handler(input, ctx);

      // The DOI hint from idConvert should mean no PubMed metadata round-trip.
      expect(mockEFetch).toHaveBeenCalledTimes(1);
      expect(mockUnpaywallResolve).toHaveBeenCalledWith('10.1/x', expect.any(AbortSignal));
      expect(result.totalReturned).toBe(1);
      const article = result.articles[0];
      expect(article?.source).toBe('unpaywall');
      if (article?.source === 'unpaywall') {
        expect(article.pmid).toBe('42');
        expect(article.doi).toBe('10.1/x');
      }
    });
  });

  describe('Unpaywall fallback for pmids (regression)', () => {
    beforeEach(() => {
      mockGetUnpaywallService.mockReturnValue({
        resolve: mockUnpaywallResolve,
        fetchContent: mockUnpaywallFetchContent,
      });
    });

    it('returns no-doi when neither the ID Converter nor PubMed metadata surfaces a DOI', async () => {
      mockIdConvert.mockResolvedValue([{ 'requested-id': '42', pmid: '42' }]);
      mockEFetchBy({ pubmedDois: {} });

      const ctx = createMockContext();
      const input = fetchFulltextTool.input.parse({ pmids: ['42'] });
      const result = await fetchFulltextTool.handler(input, ctx);

      expect(result.totalReturned).toBe(0);
      expect(result.unavailable).toEqual([
        {
          id: '42',
          idType: 'pmid',
          reason: 'no-doi',
          triedTiers: [
            { tier: 'pmc', outcome: 'not-attempted', detail: 'PMID has no PMC counterpart' },
            { tier: 'europepmc', outcome: 'not-attempted', detail: 'EUROPEPMC_ENABLED=false' },
            { tier: 'unpaywall', outcome: 'no-doi' },
          ],
        },
      ]);
      expect(mockUnpaywallResolve).not.toHaveBeenCalled();
    });

    it('sources the DOI from PubMed metadata when ID Converter omits it', async () => {
      mockIdConvert.mockResolvedValue([
        { 'requested-id': '42', pmid: '42', errmsg: 'Identifier not found in PMC' },
      ]);
      mockEFetchBy({ pubmedDois: { '42': '10.1000/example' } });
      mockUnpaywallResolve.mockResolvedValue({
        kind: 'found',
        location: { url: 'https://repo.example.org/paper', license: 'cc-by' },
      });
      mockUnpaywallFetchContent.mockResolvedValue({
        kind: 'html',
        fetchedUrl: 'https://repo.example.org/paper',
        body: '<html><body>hi</body></html>',
      });
      mockHtmlExtract.mockResolvedValue({ title: 'A Paper', content: 'hi' });

      const ctx = createMockContext();
      const input = fetchFulltextTool.input.parse({ pmids: ['42'] });
      const result = await fetchFulltextTool.handler(input, ctx);

      expect(mockUnpaywallResolve).toHaveBeenCalledWith('10.1000/example', expect.any(AbortSignal));
      expect(result.totalReturned).toBe(1);
      const article = result.articles[0];
      expect(article?.source).toBe('unpaywall');
      if (article?.source === 'unpaywall') {
        expect(article.viaSource).toBe('unpaywall');
        expect(article.doi).toBe('10.1000/example');
        expect(article.pmid).toBe('42');
      }
    });

    it('returns no-oa when Unpaywall has no open-access copy', async () => {
      mockIdConvert.mockResolvedValue([{ 'requested-id': '42', pmid: '42' }]);
      mockEFetchBy({ pubmedDois: { '42': '10.1000/example' } });
      mockUnpaywallResolve.mockResolvedValue({
        kind: 'no-oa',
        reason: 'No open-access copy indexed',
      });

      const ctx = createMockContext();
      const input = fetchFulltextTool.input.parse({ pmids: ['42'] });
      const result = await fetchFulltextTool.handler(input, ctx);

      expect(result.unavailable).toEqual([
        {
          id: '42',
          idType: 'pmid',
          reason: 'no-oa',
          triedTiers: [
            { tier: 'pmc', outcome: 'not-attempted', detail: 'PMID has no PMC counterpart' },
            { tier: 'europepmc', outcome: 'not-attempted', detail: 'EUROPEPMC_ENABLED=false' },
            { tier: 'unpaywall', outcome: 'no-oa', detail: 'No open-access copy indexed' },
          ],
        },
      ]);
    });

    it('returns service-error when Unpaywall lookup fails', async () => {
      mockIdConvert.mockResolvedValue([{ 'requested-id': '42', pmid: '42' }]);
      mockEFetchBy({ pubmedDois: { '42': '10.1000/example' } });
      mockUnpaywallResolve.mockRejectedValue(new Error('Unpaywall 503'));

      const ctx = createMockContext();
      const input = fetchFulltextTool.input.parse({ pmids: ['42'] });
      const result = await fetchFulltextTool.handler(input, ctx);

      expect(mockUnpaywallFetchContent).not.toHaveBeenCalled();
      expect(result.unavailable).toEqual([
        {
          id: '42',
          idType: 'pmid',
          reason: 'service-error',
          triedTiers: [
            { tier: 'pmc', outcome: 'not-attempted', detail: 'PMID has no PMC counterpart' },
            { tier: 'europepmc', outcome: 'not-attempted', detail: 'EUROPEPMC_ENABLED=false' },
            { tier: 'unpaywall', outcome: 'service-error', detail: 'Unpaywall 503' },
          ],
        },
      ]);
    });

    it('returns fetch-failed when the content download throws', async () => {
      mockIdConvert.mockResolvedValue([{ 'requested-id': '42', pmid: '42' }]);
      mockEFetchBy({ pubmedDois: { '42': '10.1000/example' } });
      mockUnpaywallResolve.mockResolvedValue({
        kind: 'found',
        location: { url: 'https://repo.example.org/paper' },
      });
      mockUnpaywallFetchContent.mockRejectedValue(new Error('HTTP 503'));

      const ctx = createMockContext();
      const input = fetchFulltextTool.input.parse({ pmids: ['42'] });
      const result = await fetchFulltextTool.handler(input, ctx);

      expect(result.unavailable).toEqual([
        {
          id: '42',
          idType: 'pmid',
          reason: 'fetch-failed',
          triedTiers: [
            { tier: 'pmc', outcome: 'not-attempted', detail: 'PMID has no PMC counterpart' },
            { tier: 'europepmc', outcome: 'not-attempted', detail: 'EUROPEPMC_ENABLED=false' },
            { tier: 'unpaywall', outcome: 'fetch-failed', detail: 'HTTP 503' },
          ],
        },
      ]);
    });

    it('returns an unpaywall article with contentFormat=html-markdown when HTML extraction succeeds', async () => {
      mockIdConvert.mockResolvedValue([{ 'requested-id': '42', pmid: '42' }]);
      mockEFetchBy({ pubmedDois: { '42': '10.1000/example' } });
      mockUnpaywallResolve.mockResolvedValue({
        kind: 'found',
        location: {
          url: 'https://repo.example.org/paper',
          host_type: 'repository',
          license: 'cc-by',
          version: 'acceptedVersion',
        },
      });
      mockUnpaywallFetchContent.mockResolvedValue({
        kind: 'html',
        fetchedUrl: 'https://repo.example.org/paper',
        body: '<html><body><article>Main body</article></body></html>',
      });
      mockHtmlExtract.mockResolvedValue({
        title: 'A Paper',
        content: '# A Paper\n\nMain body',
        wordCount: 2,
      });

      const ctx = createMockContext();
      const input = fetchFulltextTool.input.parse({ pmids: ['42'] });
      const result = await fetchFulltextTool.handler(input, ctx);

      expect(result.totalReturned).toBe(1);
      const article = result.articles[0];
      expect(article?.source).toBe('unpaywall');
      if (article?.source === 'unpaywall') {
        expect(article.contentFormat).toBe('html-markdown');
        expect(article.pmid).toBe('42');
        expect(article.doi).toBe('10.1000/example');
        expect(article.sourceUrl).toBe('https://repo.example.org/paper');
        expect(article.title).toBe('A Paper');
        expect(article.content).toContain('Main body');
        expect(article.license).toBe('cc-by');
        expect(article.hostType).toBe('repository');
        expect(article.version).toBe('acceptedVersion');
        expect(article.wordCount).toBe(2);
        expect(article.totalPages).toBeUndefined();
      }
    });

    it('returns an unpaywall article with contentFormat=pdf-text when PDF extraction succeeds', async () => {
      mockIdConvert.mockResolvedValue([{ 'requested-id': '42', pmid: '42' }]);
      mockEFetchBy({ pubmedDois: { '42': '10.1000/example' } });
      mockUnpaywallResolve.mockResolvedValue({
        kind: 'found',
        location: {
          url: 'https://arxiv.org/abs/2401.0001',
          url_for_pdf: 'https://arxiv.org/pdf/2401.0001.pdf',
          host_type: 'repository',
          license: 'cc0',
          version: 'submittedVersion',
        },
      });
      mockUnpaywallFetchContent.mockResolvedValue({
        kind: 'pdf',
        fetchedUrl: 'https://arxiv.org/pdf/2401.0001.pdf',
        body: new Uint8Array([0x25, 0x50, 0x44, 0x46]),
      });
      mockPdfExtractText.mockResolvedValue({ totalPages: 7, text: 'Paper text' });

      const ctx = createMockContext();
      const input = fetchFulltextTool.input.parse({ pmids: ['42'] });
      const result = await fetchFulltextTool.handler(input, ctx);

      expect(result.totalReturned).toBe(1);
      const article = result.articles[0];
      expect(article?.source).toBe('unpaywall');
      if (article?.source === 'unpaywall') {
        expect(article.contentFormat).toBe('pdf-text');
        expect(article.content).toBe('Paper text');
        expect(article.totalPages).toBe(7);
        expect(article.wordCount).toBeUndefined();
        expect(article.license).toBe('cc0');
        expect(article.sourceUrl).toBe('https://arxiv.org/pdf/2401.0001.pdf');
      }
    });

    it('flags parse-failed when HTML extraction produces empty content', async () => {
      mockIdConvert.mockResolvedValue([{ 'requested-id': '42', pmid: '42' }]);
      mockEFetchBy({ pubmedDois: { '42': '10.1000/example' } });
      mockUnpaywallResolve.mockResolvedValue({
        kind: 'found',
        location: { url: 'https://repo.example.org/paper' },
      });
      mockUnpaywallFetchContent.mockResolvedValue({
        kind: 'html',
        fetchedUrl: 'https://repo.example.org/paper',
        body: '<html></html>',
      });
      mockHtmlExtract.mockResolvedValue({ content: '   ' });

      const ctx = createMockContext();
      const input = fetchFulltextTool.input.parse({ pmids: ['42'] });
      const result = await fetchFulltextTool.handler(input, ctx);

      expect(result.unavailable).toEqual([
        {
          id: '42',
          idType: 'pmid',
          reason: 'parse-failed',
          triedTiers: [
            { tier: 'pmc', outcome: 'not-attempted', detail: 'PMID has no PMC counterpart' },
            { tier: 'europepmc', outcome: 'not-attempted', detail: 'EUROPEPMC_ENABLED=false' },
            {
              tier: 'unpaywall',
              outcome: 'parse-failed',
              detail: expect.stringContaining('empty'),
            },
          ],
        },
      ]);
    });

    it('flags parse-failed when PDF extraction produces empty text', async () => {
      mockIdConvert.mockResolvedValue([{ 'requested-id': '42', pmid: '42' }]);
      mockEFetchBy({ pubmedDois: { '42': '10.1000/example' } });
      mockUnpaywallResolve.mockResolvedValue({
        kind: 'found',
        location: { url_for_pdf: 'https://repo.example.org/paper.pdf' },
      });
      mockUnpaywallFetchContent.mockResolvedValue({
        kind: 'pdf',
        fetchedUrl: 'https://repo.example.org/paper.pdf',
        body: new Uint8Array([0x25, 0x50, 0x44, 0x46]),
      });
      mockPdfExtractText.mockResolvedValue({ totalPages: 3, text: '   ' });

      const ctx = createMockContext();
      const input = fetchFulltextTool.input.parse({ pmids: ['42'] });
      const result = await fetchFulltextTool.handler(input, ctx);

      expect(result.unavailable).toEqual([
        {
          id: '42',
          idType: 'pmid',
          reason: 'parse-failed',
          triedTiers: [
            { tier: 'pmc', outcome: 'not-attempted', detail: 'PMID has no PMC counterpart' },
            { tier: 'europepmc', outcome: 'not-attempted', detail: 'EUROPEPMC_ENABLED=false' },
            {
              tier: 'unpaywall',
              outcome: 'parse-failed',
              detail: expect.stringContaining('PDF extraction'),
            },
          ],
        },
      ]);
    });

    it('flags parse-failed when content extraction throws', async () => {
      mockIdConvert.mockResolvedValue([{ 'requested-id': '42', pmid: '42' }]);
      mockEFetchBy({ pubmedDois: { '42': '10.1000/example' } });
      mockUnpaywallResolve.mockResolvedValue({
        kind: 'found',
        location: { url: 'https://repo.example.org/paper' },
      });
      mockUnpaywallFetchContent.mockResolvedValue({
        kind: 'html',
        fetchedUrl: 'https://repo.example.org/paper',
        body: '<html><body>broken</body></html>',
      });
      mockHtmlExtract.mockRejectedValue(new Error('extractor crashed'));

      const ctx = createMockContext();
      const input = fetchFulltextTool.input.parse({ pmids: ['42'] });
      const result = await fetchFulltextTool.handler(input, ctx);

      expect(result.unavailable).toEqual([
        {
          id: '42',
          idType: 'pmid',
          reason: 'parse-failed',
          triedTiers: [
            { tier: 'pmc', outcome: 'not-attempted', detail: 'PMID has no PMC counterpart' },
            { tier: 'europepmc', outcome: 'not-attempted', detail: 'EUROPEPMC_ENABLED=false' },
            { tier: 'unpaywall', outcome: 'parse-failed', detail: 'extractor crashed' },
          ],
        },
      ]);
    });

    it('combines PMC hits with Unpaywall fallback in a single response', async () => {
      mockIdConvert.mockResolvedValue([
        { 'requested-id': '1', pmid: '1', pmcid: 'PMC100' },
        { 'requested-id': '2', pmid: '2' },
      ]);
      mockParsePmcArticle.mockReturnValue({
        pmcId: 'PMC100',
        pmcUrl: 'https://www.ncbi.nlm.nih.gov/pmc/articles/PMC100/',
        pmid: '1',
        title: 'PMC Hit',
        sections: [{ title: 'Introduction', text: 'Body.' }],
      });
      mockEFetchBy({
        pmc: [{ 'pmc-articleset': [{ article: [] }] }],
        pubmedDois: { '2': '10.1000/two' },
      });
      mockUnpaywallResolve.mockResolvedValue({
        kind: 'found',
        location: { url: 'https://repo.example.org/two' },
      });
      mockUnpaywallFetchContent.mockResolvedValue({
        kind: 'html',
        fetchedUrl: 'https://repo.example.org/two',
        body: '<html><body>Two</body></html>',
      });
      mockHtmlExtract.mockResolvedValue({ title: 'Two', content: 'Two content' });

      const ctx = createMockContext();
      const input = fetchFulltextTool.input.parse({ pmids: ['1', '2'] });
      const result = await fetchFulltextTool.handler(input, ctx);

      expect(result.totalReturned).toBe(2);
      expect(result.articles.map((a) => a.source)).toEqual(['pmc', 'unpaywall']);
      expect(result.unavailable).toBeUndefined();
    });
  });

  describe('dois input branch (issue #52)', () => {
    function withEpmcAndUnpaywall() {
      mockGetEpmcService.mockReturnValue({
        search: mockEpmcSearch,
        fullTextXml: mockEpmcFullTextXml,
        parseFullTextXml: mockEpmcParseFullTextXml,
      });
      mockGetUnpaywallService.mockReturnValue({
        resolve: mockUnpaywallResolve,
        fetchContent: mockUnpaywallFetchContent,
      });
    }

    it('resolves dois via the PMC ID Converter and skips PMC EFetch when no PMCID resolves', async () => {
      withEpmcAndUnpaywall();
      mockIdConvert.mockResolvedValue([
        { 'requested-id': '10.1000/test', errmsg: 'Identifier not found in PMC' },
      ]);
      mockEpmcSearch.mockResolvedValue({ hits: [], hitCount: 0, cursorMark: '*' });
      mockUnpaywallResolve.mockResolvedValue({ kind: 'no-oa', reason: 'no oa' });

      const ctx = createMockContext();
      const input = fetchFulltextTool.input.parse({ dois: ['10.1000/test'] });
      await fetchFulltextTool.handler(input, ctx);

      // DOI input now resolves through the converter (idtype='doi'); a DOI with
      // no PMC counterpart still skips the PMC EFetch stage.
      expect(mockIdConvert).toHaveBeenCalledWith(
        ['10.1000/test'],
        'doi',
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
      const pmcCalls = mockEFetch.mock.calls.filter(
        ([params]: [{ db: string }]) => params.db === 'pmc',
      );
      expect(pmcCalls).toHaveLength(0);
    });

    it('recovers a DOI via Europe PMC fullTextXML', async () => {
      // EPMC's fullTextXML endpoint is PMC-keyed, so EPMC recovery for a DOI
      // requires a hit with a PMC counterpart (`pmcid`). Preprints (`PPR`) and
      // MED-only records have no PMC ID and never return JATS via EPMC.
      withEpmcAndUnpaywall();
      // The converter can't place this DOI in PMC, so it falls to EPMC-by-DOI.
      mockIdConvert.mockResolvedValue([
        { 'requested-id': '10.1/x', errmsg: 'Identifier not found in PMC' },
      ]);
      mockEpmcSearch.mockResolvedValue({
        hits: [{ id: '42', source: 'MED', pmid: '42', pmcid: 'PMC42', doi: '10.1/x' }],
        hitCount: 1,
        cursorMark: '*',
      });
      mockEpmcFullTextXml.mockResolvedValue({
        kind: 'found',
        xml: '<article/>',
        epmcId: 'PMC42',
        source: 'MED',
      });
      mockEpmcParseFullTextXml.mockReturnValue({ article: [{ body: [] }] });
      mockParsePmcArticle.mockReturnValue({
        pmcId: 'PMC42',
        pmcUrl: 'https://www.ncbi.nlm.nih.gov/pmc/articles/PMC42/',
        title: 'EPMC-served article',
        sections: [{ title: 'Methods', text: 'Methods body' }],
        doi: '10.1/x',
      });

      const ctx = createMockContext();
      const input = fetchFulltextTool.input.parse({ dois: ['10.1/x'] });
      const result = await fetchFulltextTool.handler(input, ctx);

      expect(mockEpmcSearch).toHaveBeenCalledWith(
        expect.objectContaining({ query: 'DOI:"10.1/x"' }),
      );
      expect(mockEpmcFullTextXml).toHaveBeenCalledWith('PMC42', 'MED', expect.any(AbortSignal));
      expect(result.totalReturned).toBe(1);
      const article = result.articles[0];
      expect(article?.source).toBe('pmc');
      if (article?.source === 'pmc') {
        expect(article.viaSource).toBe('europepmc');
        expect(article.epmcId).toBe('42');
        expect(article.epmcSource).toBe('MED');
        expect(article.doi).toBe('10.1/x');
        expect(article.pmcId).toBe('PMC42');
      }
      expect(result.unavailable).toBeUndefined();
    });

    it('falls through to Unpaywall when EPMC has no fullTextXML for the DOI', async () => {
      withEpmcAndUnpaywall();
      mockIdConvert.mockResolvedValue([
        { 'requested-id': '10.1000/test', errmsg: 'Identifier not found in PMC' },
      ]);
      mockEpmcSearch.mockResolvedValue({ hits: [], hitCount: 0, cursorMark: '*' });
      mockUnpaywallResolve.mockResolvedValue({
        kind: 'found',
        location: { url: 'https://repo.example.org/paper', license: 'cc-by' },
      });
      mockUnpaywallFetchContent.mockResolvedValue({
        kind: 'html',
        fetchedUrl: 'https://repo.example.org/paper',
        body: '<html><body>Body</body></html>',
      });
      mockHtmlExtract.mockResolvedValue({ content: 'Body content', title: 'Paper' });

      const ctx = createMockContext();
      const input = fetchFulltextTool.input.parse({ dois: ['10.1000/test'] });
      const result = await fetchFulltextTool.handler(input, ctx);

      expect(result.totalReturned).toBe(1);
      const article = result.articles[0];
      expect(article?.source).toBe('unpaywall');
      if (article?.source === 'unpaywall') {
        expect(article.viaSource).toBe('unpaywall');
        expect(article.doi).toBe('10.1000/test');
        // No PMID in dois branch
        expect(article.pmid).toBeUndefined();
        expect(article.pubmedUrl).toBeUndefined();
      }
      expect(result.unavailable).toBeUndefined();
    });

    it('reports unavailable when both EPMC and Unpaywall fail', async () => {
      withEpmcAndUnpaywall();
      mockIdConvert.mockResolvedValue([
        { 'requested-id': '10.1000/missing', errmsg: 'Identifier not found in PMC' },
      ]);
      mockEpmcSearch.mockResolvedValue({ hits: [], hitCount: 0, cursorMark: '*' });
      mockUnpaywallResolve.mockResolvedValue({ kind: 'no-oa', reason: 'no oa' });

      const ctx = createMockContext();
      const input = fetchFulltextTool.input.parse({ dois: ['10.1000/missing'] });
      const result = await fetchFulltextTool.handler(input, ctx);

      expect(result.totalReturned).toBe(0);
      expect(result.unavailable).toEqual([
        {
          id: '10.1000/missing',
          idType: 'doi',
          reason: 'no-oa',
          triedTiers: [
            { tier: 'pmc', outcome: 'not-attempted', detail: 'DOI has no PMC counterpart' },
            { tier: 'europepmc', outcome: 'miss' },
            { tier: 'unpaywall', outcome: 'no-oa', detail: 'no oa' },
          ],
        },
      ]);
    });

    it('reports unavailable when EPMC is disabled and Unpaywall is unset', async () => {
      // EPMC and Unpaywall services are undefined (disabled); only the converter
      // runs, and it can't place this DOI in PMC.
      mockIdConvert.mockResolvedValue([
        { 'requested-id': '10.1000/foo', errmsg: 'Identifier not found in PMC' },
      ]);
      const ctx = createMockContext();
      const input = fetchFulltextTool.input.parse({ dois: ['10.1000/foo'] });
      const result = await fetchFulltextTool.handler(input, ctx);
      expect(result.totalReturned).toBe(0);
      expect(result.unavailable).toEqual([
        {
          id: '10.1000/foo',
          idType: 'doi',
          reason: 'no-pmc-fallback-disabled',
          triedTiers: [
            { tier: 'pmc', outcome: 'not-attempted', detail: 'DOI has no PMC counterpart' },
            { tier: 'europepmc', outcome: 'not-attempted', detail: 'EUROPEPMC_ENABLED=false' },
            { tier: 'unpaywall', outcome: 'not-attempted', detail: 'UNPAYWALL_EMAIL is not set' },
          ],
        },
      ]);
    });
  });

  describe('dois → PMC ID Converter resolution (issue #64)', () => {
    function withEpmcAndUnpaywall() {
      mockGetEpmcService.mockReturnValue({
        search: mockEpmcSearch,
        fullTextXml: mockEpmcFullTextXml,
        parseFullTextXml: mockEpmcParseFullTextXml,
      });
      mockGetUnpaywallService.mockReturnValue({
        resolve: mockUnpaywallResolve,
        fetchContent: mockUnpaywallFetchContent,
      });
    }

    it('resolves a DOI to its PMCID and returns structured JATS', async () => {
      // The reported bug: a DOI whose PMC copy is reachable only via the ID
      // Converter (EPMC search-by-DOI returns the preprint PPR, which has no PMC
      // counterpart). Converter → PMCID → PMC EFetch must return the JATS.
      mockIdConvert.mockResolvedValue([
        { 'requested-id': '10.1101/2025.09.12.675873', pmcid: 'PMC13060058', pmid: '41959413' },
      ]);
      mockParsePmcArticle.mockReturnValue({
        pmcId: 'PMC13060058',
        pmcUrl: 'https://www.ncbi.nlm.nih.gov/pmc/articles/PMC13060058/',
        pmid: '41959413',
        doi: '10.1101/2025.09.12.675873',
        title: 'Converter-resolved article',
        sections: [{ title: 'Results', text: 'Body.' }],
      });
      mockEFetch.mockResolvedValue([{ 'pmc-articleset': [{ article: [] }] }]);

      const ctx = createMockContext();
      const input = fetchFulltextTool.input.parse({ dois: ['10.1101/2025.09.12.675873'] });
      const result = await fetchFulltextTool.handler(input, ctx);

      expect(mockIdConvert).toHaveBeenCalledWith(
        ['10.1101/2025.09.12.675873'],
        'doi',
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
      // The resolved PMCID is routed into the PMC EFetch batch (digits only).
      expect(mockEFetch).toHaveBeenCalledWith(
        { db: 'pmc', id: '13060058', retmode: 'xml' },
        expect.objectContaining({ retmode: 'xml', useOrderedParser: true }),
      );
      expect(result.totalReturned).toBe(1);
      const article = result.articles[0];
      expect(article?.source).toBe('pmc');
      if (article?.source === 'pmc') {
        expect(article.viaSource).toBe('pmc');
        expect(article.pmcId).toBe('PMC13060058');
        expect(article.doi).toBe('10.1101/2025.09.12.675873');
      }
      expect(result.unavailable).toBeUndefined();
    });

    it('handles a mixed DOI batch — some resolve to PMC, some do not', async () => {
      withEpmcAndUnpaywall();
      mockIdConvert.mockResolvedValue([
        { 'requested-id': '10.1/inpmc', pmcid: 'PMC500', pmid: '500' },
        { 'requested-id': '10.1/notinpmc', errmsg: 'Identifier not found in PMC' },
      ]);
      mockParsePmcArticle.mockReturnValue({
        pmcId: 'PMC500',
        pmcUrl: 'https://www.ncbi.nlm.nih.gov/pmc/articles/PMC500/',
        doi: '10.1/inpmc',
        title: 'In PMC',
        sections: [{ title: 'Introduction', text: 'Body.' }],
      });
      mockEFetch.mockResolvedValue([{ 'pmc-articleset': [{ article: [] }] }]);
      mockEpmcSearch.mockResolvedValue({ hits: [], hitCount: 0, cursorMark: '*' });
      mockUnpaywallResolve.mockResolvedValue({ kind: 'no-oa', reason: 'no oa' });

      const ctx = createMockContext();
      const input = fetchFulltextTool.input.parse({ dois: ['10.1/inpmc', '10.1/notinpmc'] });
      const result = await fetchFulltextTool.handler(input, ctx);

      // Only the PMC-resolved DOI is fetched from PMC (digits only).
      expect(mockEFetch).toHaveBeenCalledWith(
        { db: 'pmc', id: '500', retmode: 'xml' },
        expect.objectContaining({ retmode: 'xml' }),
      );
      expect(result.totalReturned).toBe(1);
      expect(result.articles[0]?.source).toBe('pmc');
      if (result.articles[0]?.source === 'pmc') {
        expect(result.articles[0].doi).toBe('10.1/inpmc');
      }
      // Only the unresolved DOI is unavailable, keyed by its original string.
      expect(result.unavailable).toEqual([
        {
          id: '10.1/notinpmc',
          idType: 'doi',
          reason: 'no-oa',
          triedTiers: [
            { tier: 'pmc', outcome: 'not-attempted', detail: 'DOI has no PMC counterpart' },
            { tier: 'europepmc', outcome: 'miss' },
            { tier: 'unpaywall', outcome: 'no-oa', detail: 'no oa' },
          ],
        },
      ]);
    });

    it('routes a converter-resolved DOI to Unpaywall when PMC EFetch misses the PMCID', async () => {
      withEpmcAndUnpaywall();
      mockIdConvert.mockResolvedValue([{ 'requested-id': '10.1/x', pmcid: 'PMC777', pmid: '777' }]);
      // PMC returns no article for the resolved PMCID — the chain must continue,
      // keyed by the original DOI.
      mockEFetch.mockResolvedValue([{ 'pmc-articleset': [] }]);
      mockEpmcSearch.mockResolvedValue({ hits: [], hitCount: 0, cursorMark: '*' });
      mockUnpaywallResolve.mockResolvedValue({
        kind: 'found',
        location: { url: 'https://repo.example.org/paper' },
      });
      mockUnpaywallFetchContent.mockResolvedValue({
        kind: 'html',
        fetchedUrl: 'https://repo.example.org/paper',
        body: '<html><body>Body</body></html>',
      });
      mockHtmlExtract.mockResolvedValue({ content: 'Body content' });

      const ctx = createMockContext();
      const input = fetchFulltextTool.input.parse({ dois: ['10.1/x'] });
      const result = await fetchFulltextTool.handler(input, ctx);

      // Unpaywall is queried with the original DOI.
      expect(mockUnpaywallResolve).toHaveBeenCalledWith('10.1/x', expect.any(AbortSignal));
      expect(result.totalReturned).toBe(1);
      const article = result.articles[0];
      expect(article?.source).toBe('unpaywall');
      if (article?.source === 'unpaywall') {
        expect(article.doi).toBe('10.1/x');
      }
      expect(result.unavailable).toBeUndefined();
    });

    it('falls through when the ID Converter returns no record for a DOI', async () => {
      withEpmcAndUnpaywall();
      mockIdConvert.mockResolvedValue([]);
      mockEpmcSearch.mockResolvedValue({ hits: [], hitCount: 0, cursorMark: '*' });
      mockUnpaywallResolve.mockResolvedValue({ kind: 'no-oa', reason: 'no oa' });

      const ctx = createMockContext();
      const input = fetchFulltextTool.input.parse({ dois: ['10.1/ghost'] });
      const result = await fetchFulltextTool.handler(input, ctx);

      expect(result.unavailable).toEqual([
        {
          id: '10.1/ghost',
          idType: 'doi',
          reason: 'no-oa',
          triedTiers: [
            {
              tier: 'pmc',
              outcome: 'not-attempted',
              detail: 'ID Converter returned no record for this DOI',
            },
            { tier: 'europepmc', outcome: 'miss' },
            { tier: 'unpaywall', outcome: 'no-oa', detail: 'no oa' },
          ],
        },
      ]);
    });
  });

  describe('section-filter miss notice (issue #80)', () => {
    it('emits a recovery notice when a sections filter matches no body sections', async () => {
      // The article has real body sections, but the requested filter matches
      // none of them — the body comes back empty because of the filter, not an
      // upstream absence. The article is still returned (not an error).
      mockParsePmcArticle.mockReturnValue({
        pmcId: 'PMC3531190',
        pmcUrl: 'https://www.ncbi.nlm.nih.gov/pmc/articles/PMC3531190/',
        title: 'Article with real sections',
        sections: [
          { title: 'Introduction', text: 'Intro body.' },
          { title: 'Methods', text: 'Methods body.' },
        ],
      });
      mockEFetch.mockResolvedValue([{ 'pmc-articleset': [{ article: [] }] }]);

      const ctx = createMockContext();
      const input = fetchFulltextTool.input.parse({
        pmcids: ['PMC3531190'],
        sections: ['DefinitelyNotARealSectionName'],
      });
      const result = await fetchFulltextTool.handler(input, ctx);

      // Success behavior preserved: the article is returned with an empty body.
      expect(result.totalReturned).toBe(1);
      const article = result.articles[0];
      expect(article?.source).toBe('pmc');
      if (article?.source === 'pmc') {
        expect(article.sections).toEqual([]);
      }

      const notice = getEnrichment(ctx).notice;
      expect(notice).toBeDefined();
      expect(notice).toContain('DefinitelyNotARealSectionName');
      expect(notice).toContain('PMC3531190');
      expect(notice).toMatch(/Retry without `sections`/);
      expect(notice).toMatch(/broader headings/);
    });

    it('does not emit a notice when the sections filter matches', async () => {
      mockParsePmcArticle.mockReturnValue({
        pmcId: 'PMC3531190',
        pmcUrl: 'https://www.ncbi.nlm.nih.gov/pmc/articles/PMC3531190/',
        title: 'Article with real sections',
        sections: [
          { title: 'Introduction', text: 'Intro body.' },
          { title: 'Methods', text: 'Methods body.' },
        ],
      });
      mockEFetch.mockResolvedValue([{ 'pmc-articleset': [{ article: [] }] }]);

      const ctx = createMockContext();
      const input = fetchFulltextTool.input.parse({
        pmcids: ['PMC3531190'],
        sections: ['Introduction'],
      });
      const result = await fetchFulltextTool.handler(input, ctx);

      expect(result.totalReturned).toBe(1);
      const article = result.articles[0];
      if (article?.source === 'pmc') {
        expect(article.sections).toEqual([{ title: 'Introduction', text: 'Intro body.' }]);
      }
      expect(getEnrichment(ctx).notice).toBeUndefined();
    });

    it('does not emit a notice when no sections filter is provided', async () => {
      mockParsePmcArticle.mockReturnValue({
        pmcId: 'PMC3531190',
        pmcUrl: 'https://www.ncbi.nlm.nih.gov/pmc/articles/PMC3531190/',
        title: 'Article',
        sections: [{ title: 'Introduction', text: 'Intro body.' }],
      });
      mockEFetch.mockResolvedValue([{ 'pmc-articleset': [{ article: [] }] }]);

      const ctx = createMockContext();
      const input = fetchFulltextTool.input.parse({ pmcids: ['PMC3531190'] });
      await fetchFulltextTool.handler(input, ctx);

      expect(getEnrichment(ctx).notice).toBeUndefined();
    });

    it('does not report a section-filter miss when the article had no body sections upstream', async () => {
      // Empty body is an upstream absence, not a filter miss. The record is
      // demoted as metadata-only (#86), so the notice names that recovery rather
      // than the section filter.
      mockParsePmcArticle.mockReturnValue({
        pmcId: 'PMC3531190',
        pmcUrl: 'https://www.ncbi.nlm.nih.gov/pmc/articles/PMC3531190/',
        title: 'Metadata-only article',
        sections: [],
      });
      mockEFetch.mockResolvedValue([{ 'pmc-articleset': [{ article: [] }] }]);

      const ctx = createMockContext();
      const input = fetchFulltextTool.input.parse({
        pmcids: ['PMC3531190'],
        sections: ['Introduction'],
      });
      await fetchFulltextTool.handler(input, ctx);

      const notice = getEnrichment(ctx).notice;
      expect(notice).not.toMatch(/section filter/i);
      expect(notice).toContain('front matter');
    });

    it('emits the notice for an EPMC-served article whose sections filter misses', async () => {
      // PMID has no PMC counterpart, recovers via Europe PMC fullTextXML, and the
      // requested sections filter empties its body — the miss must be detected on
      // the EPMC stage too, not only the PMC EFetch stage.
      mockGetEpmcService.mockReturnValue({
        search: mockEpmcSearch,
        fullTextXml: mockEpmcFullTextXml,
        parseFullTextXml: mockEpmcParseFullTextXml,
      });
      mockIdConvert.mockResolvedValue([{ 'requested-id': '42', pmid: '42' }]);
      mockEpmcSearch.mockResolvedValue({
        hits: [{ id: '42', source: 'MED', pmid: '42', pmcid: 'PMC42', doi: '10.1/x' }],
        hitCount: 1,
        cursorMark: '*',
      });
      mockEpmcFullTextXml.mockResolvedValue({
        kind: 'found',
        xml: '<article/>',
        epmcId: 'PMC42',
        source: 'MED',
      });
      mockEpmcParseFullTextXml.mockReturnValue({ article: [{ body: [] }] });
      mockParsePmcArticle.mockReturnValue({
        pmcId: 'PMC42',
        pmcUrl: 'https://www.ncbi.nlm.nih.gov/pmc/articles/PMC42/',
        title: 'EPMC-served article',
        sections: [{ title: 'Background', text: 'Body' }],
      });

      const ctx = createMockContext();
      const input = fetchFulltextTool.input.parse({ pmids: ['42'], sections: ['NoSuchSection'] });
      const result = await fetchFulltextTool.handler(input, ctx);

      expect(result.totalReturned).toBe(1);
      const article = result.articles[0];
      expect(article?.source).toBe('pmc');
      if (article?.source === 'pmc') {
        expect(article.viaSource).toBe('europepmc');
        expect(article.sections).toEqual([]);
      }

      const notice = getEnrichment(ctx).notice;
      expect(notice).toBeDefined();
      expect(notice).toContain('NoSuchSection');
      expect(notice).toContain('PMC42');
    });
  });

  describe('Europe PMC query shapes (issue #85)', () => {
    function withEpmcMock() {
      mockGetEpmcService.mockReturnValue({
        search: mockEpmcSearch,
        fullTextXml: mockEpmcFullTextXml,
        parseFullTextXml: mockEpmcParseFullTextXml,
      });
    }

    it('searches by unquoted EXT_ID on the pmids branch', async () => {
      // Europe PMC matches zero records for `EXT_ID:"<pmid>" AND SRC:MED`; the
      // quotes only survive while no `AND SRC:` clause follows.
      withEpmcMock();
      mockIdConvert.mockResolvedValue([{ 'requested-id': '23193287', pmid: '23193287' }]);
      mockEFetchBy({ pubmedDois: {} });
      mockEpmcSearch.mockResolvedValue({ hits: [], hitCount: 0, cursorMark: '*' });

      const ctx = createMockContext();
      const input = fetchFulltextTool.input.parse({ pmids: ['23193287'] });
      await fetchFulltextTool.handler(input, ctx);

      expect(mockEpmcSearch).toHaveBeenCalledWith(
        expect.objectContaining({ query: 'EXT_ID:23193287 AND SRC:MED' }),
      );
    });

    it('searches by unquoted PMCID with no source filter on the pmcids branch', async () => {
      // `AND SRC:PMC` excludes the record it is meant to find — EPMC's canonical
      // entry for a PMC-indexed article has `source: MED` and carries the PMCID
      // as a field.
      withEpmcMock();
      mockEFetch.mockResolvedValue([{ 'pmc-articleset': [] }]);
      mockEpmcSearch.mockResolvedValue({ hits: [], hitCount: 0, cursorMark: '*' });

      const ctx = createMockContext();
      const input = fetchFulltextTool.input.parse({ pmcids: ['PMC3531190'] });
      await fetchFulltextTool.handler(input, ctx);

      expect(mockEpmcSearch).toHaveBeenCalledWith(
        expect.objectContaining({ query: 'PMCID:PMC3531190' }),
      );
      const query = mockEpmcSearch.mock.calls[0]?.[0]?.query as string;
      expect(query).not.toContain('SRC:');
      expect(query).not.toContain('"');
    });

    it('keeps the DOI quoted on the dois branch', async () => {
      // DOIs carry slashes and dots, so `DOI:"..."` is the shape that matches.
      withEpmcMock();
      mockIdConvert.mockResolvedValue([
        { 'requested-id': '10.1523/JNEUROSCI.3043-08.2008', errmsg: 'Identifier not found in PMC' },
      ]);
      mockEpmcSearch.mockResolvedValue({ hits: [], hitCount: 0, cursorMark: '*' });

      const ctx = createMockContext();
      const input = fetchFulltextTool.input.parse({ dois: ['10.1523/JNEUROSCI.3043-08.2008'] });
      await fetchFulltextTool.handler(input, ctx);

      expect(mockEpmcSearch).toHaveBeenCalledWith(
        expect.objectContaining({ query: 'DOI:"10.1523/JNEUROSCI.3043-08.2008"' }),
      );
    });
  });

  describe('metadata-only records (issue #86)', () => {
    function withEpmcAndUnpaywall() {
      mockGetEpmcService.mockReturnValue({
        search: mockEpmcSearch,
        fullTextXml: mockEpmcFullTextXml,
        parseFullTextXml: mockEpmcParseFullTextXml,
      });
      mockGetUnpaywallService.mockReturnValue({
        resolve: mockUnpaywallResolve,
        fetchContent: mockUnpaywallFetchContent,
      });
    }

    /** PMC EFetch shape for a publisher that blocks full-text XML: an
     *  `<article>` with populated front matter and no `<body>`. */
    function withBodylessPmcArticle(pmcId: string, doi: string) {
      mockParsePmcArticle.mockReturnValue({
        pmcId,
        pmcUrl: `https://www.ncbi.nlm.nih.gov/pmc/articles/${pmcId}/`,
        doi,
        title: 'Publisher blocks XML download',
        abstract: 'Abstract text.',
        sections: [],
      });
      mockEFetch.mockResolvedValue([{ 'pmc-articleset': [{ article: [] }] }]);
    }

    it('does not count a bodyless PMC article as a hit and recovers it via Unpaywall', async () => {
      withEpmcAndUnpaywall();
      withBodylessPmcArticle('PMC2600426', '10.1523/JNEUROSCI.3043-08.2008');
      mockEpmcSearch.mockResolvedValue({
        hits: [
          {
            id: '19052211',
            source: 'MED',
            pmid: '19052211',
            pmcid: 'PMC2600426',
            doi: '10.1523/jneurosci.3043-08.2008',
          },
        ],
        hitCount: 1,
        cursorMark: '*',
      });
      mockEpmcFullTextXml.mockResolvedValue({ kind: 'not-available', reason: 'no XML' });
      mockUnpaywallResolve.mockResolvedValue({
        kind: 'found',
        location: {
          url: 'https://www.jneurosci.org/content/28/49/13202',
          url_for_pdf: 'https://www.jneurosci.org/content/jneuro/28/49/13202.full.pdf',
          host_type: 'publisher',
          version: 'publishedVersion',
        },
      });
      mockUnpaywallFetchContent.mockResolvedValue({
        kind: 'pdf',
        fetchedUrl: 'https://www.jneurosci.org/content/jneuro/28/49/13202.full.pdf',
        body: new Uint8Array([0x25, 0x50, 0x44, 0x46]),
      });
      mockPdfExtractText.mockResolvedValue({ totalPages: 12, text: 'Recovered body text' });

      const ctx = createMockContext();
      const input = fetchFulltextTool.input.parse({ pmcids: ['PMC2600426'] });
      const result = await fetchFulltextTool.handler(input, ctx);

      expect(result.totalReturned).toBe(1);
      const article = result.articles[0];
      expect(article?.source).toBe('unpaywall');
      if (article?.source === 'unpaywall') {
        expect(article.content).toBe('Recovered body text');
        expect(article.version).toBe('publishedVersion');
      }
      expect(result.unavailable).toBeUndefined();
      // Recovered — the metadata-only notice is for records nothing recovers.
      expect(getEnrichment(ctx).notice).toBeUndefined();
    });

    it('reports a bodyless PMC record as no-body with a recovery notice when nothing recovers it', async () => {
      // EPMC and Unpaywall are both unconfigured, so the chain ends at PMC.
      withBodylessPmcArticle('PMC2600426', '10.1523/JNEUROSCI.3043-08.2008');

      const ctx = createMockContext();
      const input = fetchFulltextTool.input.parse({ pmcids: ['PMC2600426'] });
      const result = await fetchFulltextTool.handler(input, ctx);

      expect(result.totalReturned).toBe(0);
      expect(result.articles).toEqual([]);
      expect(result.unavailable).toEqual([
        {
          id: 'PMC2600426',
          idType: 'pmcid',
          reason: 'no-body',
          triedTiers: [
            {
              tier: 'pmc',
              outcome: 'no-body',
              detail: 'PMC returned front matter and abstract only, with no body sections',
            },
            { tier: 'europepmc', outcome: 'not-attempted', detail: 'EUROPEPMC_ENABLED=false' },
            { tier: 'unpaywall', outcome: 'not-attempted', detail: 'UNPAYWALL_EMAIL is not set' },
          ],
        },
      ]);

      const notice = getEnrichment(ctx).notice;
      expect(notice).toContain('PMC2600426');
      expect(notice).toContain('pubmed_fetch_articles');
    });

    it('demotes a bodyless EPMC fullTextXML to no-body and continues the chain', async () => {
      withEpmcAndUnpaywall();
      mockIdConvert.mockResolvedValue([{ 'requested-id': '42', pmid: '42' }]);
      mockEFetchBy({ pubmedDois: { '42': '10.1000/example' } });
      mockEpmcSearch.mockResolvedValue({
        hits: [{ id: '42', source: 'MED', pmid: '42', pmcid: 'PMC42', doi: '10.1000/example' }],
        hitCount: 1,
        cursorMark: '*',
      });
      mockEpmcFullTextXml.mockResolvedValue({
        kind: 'found',
        xml: '<article/>',
        epmcId: 'PMC42',
        source: 'MED',
      });
      mockEpmcParseFullTextXml.mockReturnValue({ article: [{ front: [] }] });
      mockParsePmcArticle.mockReturnValue({
        pmcId: 'PMC42',
        pmcUrl: 'https://www.ncbi.nlm.nih.gov/pmc/articles/PMC42/',
        title: 'EPMC front matter only',
        sections: [],
      });
      mockUnpaywallResolve.mockResolvedValue({
        kind: 'no-oa',
        reason: 'No open-access copy indexed',
      });

      const ctx = createMockContext();
      const input = fetchFulltextTool.input.parse({ pmids: ['42'] });
      const result = await fetchFulltextTool.handler(input, ctx);

      expect(result.totalReturned).toBe(0);
      expect(result.unavailable?.[0]?.triedTiers).toEqual([
        { tier: 'pmc', outcome: 'not-attempted', detail: 'PMID has no PMC counterpart' },
        {
          tier: 'europepmc',
          outcome: 'no-body',
          detail: 'EPMC fullTextXML carried front matter and abstract only, with no body sections',
        },
        { tier: 'unpaywall', outcome: 'no-oa', detail: 'No open-access copy indexed' },
      ]);
      expect(getEnrichment(ctx).notice).toContain('42');
    });
  });

  describe('pmcids branch reaches Unpaywall (issue #88)', () => {
    function withEpmcAndUnpaywall() {
      mockGetEpmcService.mockReturnValue({
        search: mockEpmcSearch,
        fullTextXml: mockEpmcFullTextXml,
        parseFullTextXml: mockEpmcParseFullTextXml,
      });
      mockGetUnpaywallService.mockReturnValue({
        resolve: mockUnpaywallResolve,
        fetchContent: mockUnpaywallFetchContent,
      });
    }

    it('uses the DOI from the EPMC hit when EPMC has no fullTextXML', async () => {
      withEpmcAndUnpaywall();
      mockEFetch.mockResolvedValue([{ 'pmc-articleset': [] }]);
      mockEpmcSearch.mockResolvedValue({
        hits: [
          {
            id: '19052211',
            source: 'MED',
            pmid: '19052211',
            pmcid: 'PMC2600426',
            doi: '10.1523/jneurosci.3043-08.2008',
          },
        ],
        hitCount: 1,
        cursorMark: '*',
      });
      mockEpmcFullTextXml.mockResolvedValue({ kind: 'not-available', reason: 'no XML' });
      mockUnpaywallResolve.mockResolvedValue({
        kind: 'found',
        location: { url: 'https://repo.example.org/paper' },
      });
      mockUnpaywallFetchContent.mockResolvedValue({
        kind: 'html',
        fetchedUrl: 'https://repo.example.org/paper',
        body: '<html><body>Body</body></html>',
      });
      mockHtmlExtract.mockResolvedValue({ content: 'Body content' });

      const ctx = createMockContext();
      const input = fetchFulltextTool.input.parse({ pmcids: ['PMC2600426'] });
      const result = await fetchFulltextTool.handler(input, ctx);

      expect(mockUnpaywallResolve).toHaveBeenCalledWith(
        '10.1523/jneurosci.3043-08.2008',
        expect.any(AbortSignal),
      );
      // The EPMC hit already carried the DOI — no ID Converter round-trip.
      expect(mockIdConvert).not.toHaveBeenCalled();
      expect(result.totalReturned).toBe(1);
      expect(result.articles[0]?.source).toBe('unpaywall');
      expect(result.unavailable).toBeUndefined();
    });

    it('falls back to the PMC ID Converter when EPMC never resolved the record', async () => {
      withEpmcAndUnpaywall();
      mockEFetch.mockResolvedValue([{ 'pmc-articleset': [] }]);
      mockEpmcSearch.mockResolvedValue({ hits: [], hitCount: 0, cursorMark: '*' });
      mockIdConvert.mockResolvedValue([
        {
          'requested-id': 'PMC2600426',
          pmcid: 'PMC2600426',
          pmid: '19052211',
          doi: '10.1523/JNEUROSCI.3043-08.2008',
        },
      ]);
      mockUnpaywallResolve.mockResolvedValue({
        kind: 'found',
        location: { url_for_pdf: 'https://repo.example.org/paper.pdf' },
      });
      mockUnpaywallFetchContent.mockResolvedValue({
        kind: 'pdf',
        fetchedUrl: 'https://repo.example.org/paper.pdf',
        body: new Uint8Array([0x25, 0x50, 0x44, 0x46]),
      });
      mockPdfExtractText.mockResolvedValue({ totalPages: 12, text: 'Paper text' });

      const ctx = createMockContext();
      const input = fetchFulltextTool.input.parse({ pmcids: ['PMC2600426'] });
      const result = await fetchFulltextTool.handler(input, ctx);

      expect(mockIdConvert).toHaveBeenCalledWith(
        ['PMC2600426'],
        'pmcid',
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
      expect(mockUnpaywallResolve).toHaveBeenCalledWith(
        '10.1523/JNEUROSCI.3043-08.2008',
        expect.any(AbortSignal),
      );
      expect(result.totalReturned).toBe(1);
      expect(result.articles[0]?.source).toBe('unpaywall');
    });

    it('keeps no-doi for a PMCID that resolves to no DOI', async () => {
      withEpmcAndUnpaywall();
      mockEFetch.mockResolvedValue([{ 'pmc-articleset': [] }]);
      mockEpmcSearch.mockResolvedValue({ hits: [], hitCount: 0, cursorMark: '*' });
      mockIdConvert.mockResolvedValue([{ 'requested-id': 'PMC999', pmcid: 'PMC999', pmid: '999' }]);

      const ctx = createMockContext();
      const input = fetchFulltextTool.input.parse({ pmcids: ['PMC999'] });
      const result = await fetchFulltextTool.handler(input, ctx);

      expect(mockUnpaywallResolve).not.toHaveBeenCalled();
      expect(result.unavailable).toEqual([
        {
          id: 'PMC999',
          idType: 'pmcid',
          reason: 'no-doi',
          triedTiers: [
            { tier: 'pmc', outcome: 'miss' },
            { tier: 'europepmc', outcome: 'miss' },
            { tier: 'unpaywall', outcome: 'no-doi' },
          ],
        },
      ]);
    });

    it('still records not-attempted when Unpaywall is unconfigured', async () => {
      mockGetEpmcService.mockReturnValue({
        search: mockEpmcSearch,
        fullTextXml: mockEpmcFullTextXml,
        parseFullTextXml: mockEpmcParseFullTextXml,
      });
      mockEFetch.mockResolvedValue([{ 'pmc-articleset': [] }]);
      mockEpmcSearch.mockResolvedValue({ hits: [], hitCount: 0, cursorMark: '*' });

      const ctx = createMockContext();
      const input = fetchFulltextTool.input.parse({ pmcids: ['PMC999'] });
      const result = await fetchFulltextTool.handler(input, ctx);

      expect(mockIdConvert).not.toHaveBeenCalled();
      expect(result.unavailable?.[0]?.triedTiers.at(-1)).toEqual({
        tier: 'unpaywall',
        outcome: 'not-attempted',
        detail: 'UNPAYWALL_EMAIL is not set',
      });
    });
  });

  describe('pmcids branch backlinks the requested PMC ID (issue #92)', () => {
    const RECOVERED = 'PMC3006432';
    const FAILED = 'PMC2600426';
    const RECOVERED_DOI = '10.1111/j.1530-0277.1989.tb00307.x';
    const FAILED_DOI = '10.1523/jneurosci.3043-08.2008';

    /**
     * Both PMCIDs miss PMC EFetch and are indexed by EPMC with a DOI but no
     * fullTextXML, so both reach Unpaywall. Only the first one downloads.
     */
    function mockPartiallyRecoveredBatch() {
      mockGetEpmcService.mockReturnValue({
        search: mockEpmcSearch,
        fullTextXml: mockEpmcFullTextXml,
        parseFullTextXml: mockEpmcParseFullTextXml,
      });
      mockGetUnpaywallService.mockReturnValue({
        resolve: mockUnpaywallResolve,
        fetchContent: mockUnpaywallFetchContent,
      });
      mockEFetch.mockResolvedValue([{ 'pmc-articleset': [] }]);
      mockEpmcSearch.mockImplementation(async ({ query }: { query: string }) => {
        const [id, doi] = query.includes(RECOVERED)
          ? [RECOVERED, RECOVERED_DOI]
          : [FAILED, FAILED_DOI];
        return { hits: [{ id, source: 'MED', pmcid: id, doi }], hitCount: 1, cursorMark: '*' };
      });
      mockEpmcFullTextXml.mockResolvedValue({ kind: 'not-available', reason: 'no XML' });
      mockUnpaywallResolve.mockImplementation(async (doi: string) => ({
        kind: 'found',
        location: { url: `https://oa.example.org/${doi}` },
      }));
      mockUnpaywallFetchContent.mockImplementation(async (location: { url: string }) => {
        if (location.url.includes(FAILED_DOI)) throw new Error('403 Forbidden');
        return { kind: 'html', fetchedUrl: location.url, body: '<html>body</html>' };
      });
      mockHtmlExtract.mockResolvedValue({ content: 'Recovered body', wordCount: 2321 });
    }

    it('keys a recovered article to the PMC ID it was requested under', async () => {
      mockPartiallyRecoveredBatch();

      const ctx = createMockContext();
      const input = fetchFulltextTool.input.parse({ pmcids: [RECOVERED, FAILED] });
      const result = await fetchFulltextTool.handler(input, ctx);

      expect(result.totalReturned).toBe(1);
      const article = result.articles[0];
      expect(article).toMatchObject({
        source: 'unpaywall',
        pmcId: RECOVERED,
        doi: RECOVERED_DOI,
      });
      // The failure is keyed by PMCID; the success must be too, or the caller
      // cannot map either result back to what it asked for.
      expect(result.unavailable).toHaveLength(1);
      expect(result.unavailable?.[0]).toMatchObject({
        id: FAILED,
        idType: 'pmcid',
        reason: 'fetch-failed',
      });
    });

    it('renders the requested PMC ID in content[] for structuredContent parity', async () => {
      mockPartiallyRecoveredBatch();

      const ctx = createMockContext();
      const input = fetchFulltextTool.input.parse({ pmcids: [RECOVERED, FAILED] });
      const result = await fetchFulltextTool.handler(input, ctx);
      const text = fetchFulltextTool.format!(result)[0]?.text ?? '';

      expect(text).toContain(`**PMCID:** ${RECOVERED}`);
      expect(text).toContain(`[pmcid] ${FAILED}`);
    });

    it('leaves pmcId absent for the pmids branch', async () => {
      mockGetUnpaywallService.mockReturnValue({
        resolve: mockUnpaywallResolve,
        fetchContent: mockUnpaywallFetchContent,
      });
      mockIdConvert.mockResolvedValue([{ pmid: '42', doi: '10.1000/example' }]);
      mockUnpaywallResolve.mockResolvedValue({
        kind: 'found',
        location: { url: 'https://oa.example.org/paper' },
      });
      mockUnpaywallFetchContent.mockResolvedValue({
        kind: 'html',
        fetchedUrl: 'https://oa.example.org/paper',
        body: '<html>body</html>',
      });
      mockHtmlExtract.mockResolvedValue({ content: 'Body' });

      const ctx = createMockContext();
      const input = fetchFulltextTool.input.parse({ pmids: ['42'] });
      const result = await fetchFulltextTool.handler(input, ctx);

      expect(result.articles[0]).toMatchObject({ source: 'unpaywall', pmid: '42' });
      expect(result.articles[0]).not.toHaveProperty('pmcId');
    });
  });

  describe('character budget (issue #81)', () => {
    /** Stage a single PMC article with the given body sections. */
    function stagePmcArticle(sections: unknown[]) {
      mockParsePmcArticle.mockReturnValue({
        pmcId: 'PMC81',
        pmcUrl: 'https://www.ncbi.nlm.nih.gov/pmc/articles/PMC81/',
        pmid: '4242',
        doi: '10.1000/budget',
        title: 'Budgeted Article',
        sections,
      });
      mockEFetch.mockResolvedValue([{ 'pmc-articleset': [{ article: [] }] }]);
    }

    function pmcSections(result: Awaited<ReturnType<typeof fetchFulltextTool.handler>>) {
      const article = result.articles[0];
      if (article?.source !== 'pmc') throw new Error('expected a pmc article');
      return article.sections;
    }

    function stageUnpaywallBody(content: string) {
      mockIdConvert.mockResolvedValue([{ 'requested-id': '42', pmid: '42' }]);
      mockEFetchBy({ pubmedDois: { '42': '10.1000/example' } });
      mockGetUnpaywallService.mockReturnValue({
        resolve: mockUnpaywallResolve,
        fetchContent: mockUnpaywallFetchContent,
      });
      mockUnpaywallResolve.mockResolvedValue({
        kind: 'found',
        location: { url: 'https://repo.example.org/paper' },
      });
      mockUnpaywallFetchContent.mockResolvedValue({
        kind: 'html',
        fetchedUrl: 'https://repo.example.org/paper',
        body: '<html><body>Long</body></html>',
      });
      mockHtmlExtract.mockResolvedValue({ title: 'A Paper', content });
    }

    it('returns the full body and no truncation metadata when no budget is requested', async () => {
      stagePmcArticle([{ title: 'Introduction', text: 'A'.repeat(5000) }]);

      const ctx = createMockContext();
      const input = fetchFulltextTool.input.parse({ pmcids: ['PMC81'] });
      const result = await fetchFulltextTool.handler(input, ctx);

      expect(result.truncation).toBeUndefined();
      expect(pmcSections(result)[0]?.text).toHaveLength(5000);
      expect(getEnrichment(ctx).notice).toBeUndefined();
    });

    it('leaves the response untouched when the body exactly meets the budget', async () => {
      stagePmcArticle([{ title: 'Introduction', text: 'A'.repeat(100) }]);

      const ctx = createMockContext();
      const input = fetchFulltextTool.input.parse({ pmcids: ['PMC81'], maxCharacters: 100 });
      const result = await fetchFulltextTool.handler(input, ctx);

      expect(result.truncation).toBeUndefined();
      expect(pmcSections(result)[0]?.text).toHaveLength(100);
    });

    it('truncates and reports counts when the body exceeds the budget by one character', async () => {
      stagePmcArticle([{ title: 'Introduction', text: 'A'.repeat(101) }]);

      const ctx = createMockContext();
      const input = fetchFulltextTool.input.parse({ pmcids: ['PMC81'], maxCharacters: 100 });
      const result = await fetchFulltextTool.handler(input, ctx);

      expect(pmcSections(result)[0]?.text).toHaveLength(100);
      expect(result.truncation).toEqual({
        mode: 'truncate',
        maxCharacters: 100,
        originalCharacters: 101,
        returnedCharacters: 100,
        omittedSections: 0,
        articles: [
          {
            id: 'PMC81',
            source: 'pmc',
            originalCharacters: 101,
            returnedCharacters: 100,
            sections: [
              {
                title: 'Introduction',
                originalCharacters: 101,
                returnedCharacters: 100,
                truncated: true,
              },
            ],
          },
        ],
      });

      const notice = getEnrichment(ctx).notice;
      expect(notice).toContain('100 of 101 body characters');
      expect(notice).toContain('truncate mode');
    });

    it('drops sections past an exhausted budget and counts them as omitted', async () => {
      stagePmcArticle([
        { title: 'Introduction', text: 'A'.repeat(500) },
        { title: 'Methods', text: 'B'.repeat(300) },
      ]);

      const ctx = createMockContext();
      const input = fetchFulltextTool.input.parse({ pmcids: ['PMC81'], maxCharacters: 200 });
      const result = await fetchFulltextTool.handler(input, ctx);

      const sections = pmcSections(result);
      expect(sections).toHaveLength(1);
      expect(sections[0]?.title).toBe('Introduction');
      expect(sections[0]?.text).toBe('A'.repeat(200));
      expect(result.truncation?.omittedSections).toBe(1);
      // The dropped section still reports its heading and original size, so the
      // caller can see what exists without receiving it.
      expect(result.truncation?.articles[0]?.sections).toEqual([
        {
          title: 'Introduction',
          originalCharacters: 500,
          returnedCharacters: 200,
          truncated: true,
        },
        { title: 'Methods', originalCharacters: 300, returnedCharacters: 0, truncated: true },
      ]);
      expect(getEnrichment(ctx).notice).toContain('1 section(s) were dropped');
    });

    it('lets maxCharactersPerSection cap a section the total budget would have allowed', async () => {
      stagePmcArticle([
        { title: 'Introduction', text: 'A'.repeat(500) },
        { title: 'Methods', text: 'B'.repeat(500) },
      ]);

      const ctx = createMockContext();
      const input = fetchFulltextTool.input.parse({
        pmcids: ['PMC81'],
        maxCharacters: 600,
        maxCharactersPerSection: 250,
      });
      const result = await fetchFulltextTool.handler(input, ctx);

      expect(pmcSections(result).map((s) => s.text.length)).toEqual([250, 250]);
      expect(result.truncation?.returnedCharacters).toBe(500);
      expect(result.truncation?.omittedSections).toBe(0);
      expect(result.truncation?.maxCharactersPerSection).toBe(250);
    });

    it('spends the per-section budget across a section and its subsections in order', async () => {
      stagePmcArticle([
        {
          title: 'Results',
          text: 'A'.repeat(60),
          subsections: [
            { title: 'Cohort', text: 'B'.repeat(60) },
            { title: 'Outcomes', text: 'C'.repeat(60) },
          ],
        },
      ]);

      const ctx = createMockContext();
      const input = fetchFulltextTool.input.parse({
        pmcids: ['PMC81'],
        maxCharactersPerSection: 100,
      });
      const result = await fetchFulltextTool.handler(input, ctx);

      const section = pmcSections(result)[0];
      expect(section?.text).toHaveLength(60);
      expect(section?.subsections?.map((s) => s.text.length)).toEqual([40, 0]);
      expect(section?.subsections?.map((s) => s.title)).toEqual(['Cohort', 'Outcomes']);
      expect(result.truncation?.articles[0]?.sections).toEqual([
        { title: 'Results', originalCharacters: 180, returnedCharacters: 100, truncated: true },
      ]);
    });

    it('outline mode keeps every heading and identifier with an even share of the budget', async () => {
      stagePmcArticle([
        { title: 'Introduction', text: 'A'.repeat(500) },
        { title: 'Methods', text: 'B'.repeat(500) },
        { title: 'Results', text: 'C'.repeat(500) },
      ]);

      const ctx = createMockContext();
      const input = fetchFulltextTool.input.parse({
        pmcids: ['PMC81'],
        maxCharacters: 300,
        overflowMode: 'outline',
      });
      const result = await fetchFulltextTool.handler(input, ctx);

      const article = result.articles[0];
      expect(article?.source).toBe('pmc');
      if (article?.source === 'pmc') {
        expect(article.pmcId).toBe('PMC81');
        expect(article.pmid).toBe('4242');
        expect(article.doi).toBe('10.1000/budget');
        expect(article.title).toBe('Budgeted Article');
        expect(article.sections.map((s) => s.title)).toEqual([
          'Introduction',
          'Methods',
          'Results',
        ]);
        expect(article.sections.map((s) => s.text.length)).toEqual([100, 100, 100]);
      }
      expect(result.truncation?.mode).toBe('outline');
      expect(result.truncation?.omittedSections).toBe(0);
      expect(result.truncation?.returnedCharacters).toBe(300);
    });

    it('outline mode reallocates the budget a short section did not need', async () => {
      stagePmcArticle([
        { title: 'Abstract', text: 'A'.repeat(100) },
        { title: 'Methods', text: 'B'.repeat(1000) },
        { title: 'Results', text: 'C'.repeat(1000) },
      ]);

      const ctx = createMockContext();
      const input = fetchFulltextTool.input.parse({
        pmcids: ['PMC81'],
        maxCharacters: 900,
        overflowMode: 'outline',
      });
      const result = await fetchFulltextTool.handler(input, ctx);

      // An even split alone would give 300 each and strand 200 characters on the
      // 100-character section; the leftover goes back to the sections still capped.
      expect(pmcSections(result).map((s) => s.text.length)).toEqual([100, 400, 400]);
      expect(result.truncation?.returnedCharacters).toBe(900);
    });

    it('applies the budget after the sections and maxSections filters', async () => {
      stagePmcArticle([
        { title: 'Introduction', text: 'A'.repeat(500) },
        { title: 'Methods', text: 'B'.repeat(500) },
        { title: 'Discussion', text: 'C'.repeat(500) },
      ]);

      const ctx = createMockContext();
      const input = fetchFulltextTool.input.parse({
        pmcids: ['PMC81'],
        sections: ['methods', 'discussion'],
        maxSections: 1,
        maxCharacters: 10,
      });
      const result = await fetchFulltextTool.handler(input, ctx);

      const sections = pmcSections(result);
      expect(sections.map((s) => s.title)).toEqual(['Methods']);
      expect(sections[0]?.text).toBe('B'.repeat(10));
      // Only the surviving section is accounted for — the budget never sees the
      // sections the semantic filters already removed.
      expect(result.truncation?.articles[0]?.sections).toEqual([
        { title: 'Methods', originalCharacters: 500, returnedCharacters: 10, truncated: true },
      ]);
    });

    it('budgets a Europe PMC-served body and rolls its accounting into the response', async () => {
      // The EPMC tier budgets through its own accumulation path — the per-article
      // accounting and the omitted-section count travel back out of the stage
      // rather than being collected inline like the PMC tier's.
      mockGetEpmcService.mockReturnValue({
        search: mockEpmcSearch,
        fullTextXml: mockEpmcFullTextXml,
        parseFullTextXml: mockEpmcParseFullTextXml,
      });
      mockIdConvert.mockResolvedValue([{ 'requested-id': '42', pmid: '42' }]);
      mockEpmcSearch.mockResolvedValue({
        hits: [{ id: '42', source: 'MED', pmid: '42', pmcid: 'PMC42' }],
        hitCount: 1,
        cursorMark: '*',
      });
      mockEpmcFullTextXml.mockResolvedValue({
        kind: 'found',
        xml: '<article/>',
        epmcId: 'PMC42',
        source: 'MED',
      });
      mockEpmcParseFullTextXml.mockReturnValue({ article: [{ body: [] }] });
      mockParsePmcArticle.mockReturnValue({
        pmcId: 'PMC42',
        pmcUrl: 'https://www.ncbi.nlm.nih.gov/pmc/articles/PMC42/',
        title: 'EPMC-served article',
        sections: [
          { title: 'Background', text: 'A'.repeat(500) },
          { title: 'Methods', text: 'B'.repeat(500) },
        ],
      });

      const ctx = createMockContext();
      const input = fetchFulltextTool.input.parse({ pmids: ['42'], maxCharacters: 200 });
      const result = await fetchFulltextTool.handler(input, ctx);

      const article = result.articles[0];
      expect(article?.source).toBe('pmc');
      if (article?.source === 'pmc') {
        expect(article.viaSource).toBe('europepmc');
        expect(article.sections).toHaveLength(1);
        expect(article.sections[0]?.text).toBe('A'.repeat(200));
      }
      expect(result.truncation).toEqual({
        mode: 'truncate',
        maxCharacters: 200,
        originalCharacters: 1000,
        returnedCharacters: 200,
        omittedSections: 1,
        articles: [
          {
            id: 'PMC42',
            source: 'pmc',
            originalCharacters: 1000,
            returnedCharacters: 200,
            sections: [
              {
                title: 'Background',
                originalCharacters: 500,
                returnedCharacters: 200,
                truncated: true,
              },
              { title: 'Methods', originalCharacters: 500, returnedCharacters: 0, truncated: true },
            ],
          },
        ],
      });
      expect(getEnrichment(ctx).notice).toContain('200 of 1000 body characters');
    });

    it('names only the budget the request set in the truncation notice', async () => {
      stagePmcArticle([{ title: 'Introduction', text: 'A'.repeat(500) }]);

      const ctx = createMockContext();
      const input = fetchFulltextTool.input.parse({
        pmcids: ['PMC81'],
        maxCharactersPerSection: 100,
      });
      await fetchFulltextTool.handler(input, ctx);

      const notice = getEnrichment(ctx).notice;
      expect(notice).toContain('raise `maxCharactersPerSection` or narrow `sections`');
      // `maxCharacters` was never set — pointing at it would send the caller to
      // a knob that does not exist on this request.
      expect(notice).not.toContain('`maxCharacters`');
    });

    it('caps an Unpaywall body with maxCharacters', async () => {
      stageUnpaywallBody('Z'.repeat(4000));

      const result = await fetchFulltextTool.handler(
        fetchFulltextTool.input.parse({ pmids: ['42'], maxCharacters: 250 }),
        createMockContext(),
      );

      const article = result.articles[0];
      expect(article?.source).toBe('unpaywall');
      if (article?.source === 'unpaywall') expect(article.content).toBe('Z'.repeat(250));
      expect(result.truncation?.articles).toEqual([
        { id: '42', source: 'unpaywall', originalCharacters: 4000, returnedCharacters: 250 },
      ]);
    });

    it('leaves an Unpaywall body alone under maxCharactersPerSection, which is pmc-only', async () => {
      stageUnpaywallBody('Z'.repeat(4000));

      const result = await fetchFulltextTool.handler(
        fetchFulltextTool.input.parse({ pmids: ['42'], maxCharactersPerSection: 250 }),
        createMockContext(),
      );

      const article = result.articles[0];
      if (article?.source === 'unpaywall') expect(article.content).toHaveLength(4000);
      expect(result.truncation).toBeUndefined();
    });

    it('budgets a huge PMC section and an Unpaywall body in one response, on both surfaces', async () => {
      mockIdConvert.mockResolvedValue([
        { 'requested-id': '1', pmid: '1', pmcid: 'PMC100' },
        { 'requested-id': '2', pmid: '2' },
      ]);
      mockParsePmcArticle.mockReturnValue({
        pmcId: 'PMC100',
        pmcUrl: 'https://www.ncbi.nlm.nih.gov/pmc/articles/PMC100/',
        pmid: '1',
        title: 'PMC Hit',
        sections: [
          { title: 'Introduction', text: 'A'.repeat(9000) },
          { title: 'Methods', text: 'B'.repeat(9000) },
        ],
      });
      mockEFetchBy({
        pmc: [{ 'pmc-articleset': [{ article: [] }] }],
        pubmedDois: { '2': '10.1000/two' },
      });
      mockGetUnpaywallService.mockReturnValue({
        resolve: mockUnpaywallResolve,
        fetchContent: mockUnpaywallFetchContent,
      });
      mockUnpaywallResolve.mockResolvedValue({
        kind: 'found',
        location: { url: 'https://repo.example.org/two' },
      });
      mockUnpaywallFetchContent.mockResolvedValue({
        kind: 'html',
        fetchedUrl: 'https://repo.example.org/two',
        body: '<html><body>Two</body></html>',
      });
      mockHtmlExtract.mockResolvedValue({ title: 'Two', content: 'Z'.repeat(7000) });

      const ctx = createMockContext();
      const input = fetchFulltextTool.input.parse({ pmids: ['1', '2'], maxCharacters: 200 });
      const result = await fetchFulltextTool.handler(input, ctx);

      // structuredContent surface.
      expect(result.totalReturned).toBe(2);
      expect(result.truncation?.originalCharacters).toBe(25000);
      expect(result.truncation?.returnedCharacters).toBe(400);
      expect(result.truncation?.omittedSections).toBe(1);
      expect(result.truncation?.articles.map((a) => [a.id, a.source])).toEqual([
        ['PMC100', 'pmc'],
        ['2', 'unpaywall'],
      ]);
      const pmc = result.articles[0];
      if (pmc?.source === 'pmc') {
        expect(pmc.sections).toHaveLength(1);
        expect(pmc.sections[0]?.text).toHaveLength(200);
      }
      const oa = result.articles[1];
      if (oa?.source === 'unpaywall') expect(oa.content).toHaveLength(200);

      // content[] surface — the same accounting has to reach clients that never
      // read structuredContent.
      const text = fetchFulltextTool.format!(result)[0]?.text ?? '';
      expect(text).toContain('**Truncated (truncate mode):** 400 of 25000 body characters');
      expect(text).toContain('Budget applied: maxCharacters 200');
      expect(text).toContain('- PMC100 (pmc): 200 of 18000 characters');
      expect(text).toContain('Introduction — 200 of 9000 characters (truncated: true)');
      expect(text).toContain('Methods — 0 of 9000 characters (truncated: true)');
      expect(text).toContain('- 2 (unpaywall): 200 of 7000 characters');
      expect(text).toContain('Body shortened to fit the requested character budget');
      expect(text).not.toContain('A'.repeat(201));
      expect(text).not.toContain('Z'.repeat(201));
    });

    describe('surrogate-safe cuts (issue #93)', () => {
      /** DNA emoji U+1F9EC — one code point, two UTF-16 code units. */
      const ASTRAL = '\u{1F9EC}';

      it('backs a section cut off a code unit rather than splitting a surrogate pair', async () => {
        // Code unit 99 is the high surrogate, so a 100-unit cut would split it.
        stagePmcArticle([
          { title: 'Introduction', text: `${'A'.repeat(99)}${ASTRAL}${'B'.repeat(50)}` },
        ]);

        const ctx = createMockContext();
        const input = fetchFulltextTool.input.parse({ pmcids: ['PMC81'], maxCharacters: 100 });
        const result = await fetchFulltextTool.handler(input, ctx);

        const text = pmcSections(result)[0]?.text ?? '';
        expect(text).toBe('A'.repeat(99));
        expect(text.isWellFormed()).toBe(true);
        // One under the allowance, and the counts report what came back.
        expect(result.truncation?.returnedCharacters).toBe(99);
        expect(result.truncation?.articles[0]?.sections?.[0]).toEqual({
          title: 'Introduction',
          originalCharacters: 151,
          returnedCharacters: 99,
          truncated: true,
        });
      });

      it('keeps an astral character whole when the cut lands just after it', async () => {
        // Code units 98–99 are the pair, so a 100-unit cut ends on the low half.
        stagePmcArticle([
          { title: 'Introduction', text: `${'A'.repeat(98)}${ASTRAL}${'B'.repeat(50)}` },
        ]);

        const result = await fetchFulltextTool.handler(
          fetchFulltextTool.input.parse({ pmcids: ['PMC81'], maxCharacters: 100 }),
          createMockContext(),
        );

        const text = pmcSections(result)[0]?.text ?? '';
        expect(text).toBe(`${'A'.repeat(98)}${ASTRAL}`);
        expect(text.isWellFormed()).toBe(true);
        expect(result.truncation?.returnedCharacters).toBe(100);
      });

      it('spends the full allowance when the cut lands just before an astral character', async () => {
        stagePmcArticle([
          { title: 'Introduction', text: `${'A'.repeat(100)}${ASTRAL}${'B'.repeat(50)}` },
        ]);

        const result = await fetchFulltextTool.handler(
          fetchFulltextTool.input.parse({ pmcids: ['PMC81'], maxCharacters: 100 }),
          createMockContext(),
        );

        const text = pmcSections(result)[0]?.text ?? '';
        expect(text).toBe('A'.repeat(100));
        expect(text.isWellFormed()).toBe(true);
        expect(result.truncation?.returnedCharacters).toBe(100);
      });

      it('hands a section its leftover code unit when the previous field backed off', async () => {
        // The section's own text backs off one unit; that unit is still available
        // to the subsection, so the pair spends the allowance without exceeding it.
        stagePmcArticle([
          {
            title: 'Introduction',
            text: `${'A'.repeat(99)}${ASTRAL}${'B'.repeat(50)}`,
            subsections: [{ title: 'Background', text: 'C'.repeat(80) }],
          },
        ]);

        const result = await fetchFulltextTool.handler(
          fetchFulltextTool.input.parse({
            pmcids: ['PMC81'],
            maxCharacters: 100,
            maxCharactersPerSection: 100,
          }),
          createMockContext(),
        );

        const section = pmcSections(result)[0];
        expect(section?.text).toBe('A'.repeat(99));
        expect(section?.subsections?.[0]?.text).toBe('C');
        const returned =
          (section?.text.length ?? 0) + (section?.subsections?.[0]?.text.length ?? 0);
        expect(returned).toBe(100);
        expect(result.truncation?.returnedCharacters).toBe(100);
      });

      it('backs an Unpaywall body cut off a code unit and reports the real length', async () => {
        stageUnpaywallBody(`${'Z'.repeat(249)}${ASTRAL}${'Z'.repeat(200)}`);

        const result = await fetchFulltextTool.handler(
          fetchFulltextTool.input.parse({ pmids: ['42'], maxCharacters: 250 }),
          createMockContext(),
        );

        const article = result.articles[0];
        expect(article?.source).toBe('unpaywall');
        if (article?.source === 'unpaywall') {
          expect(article.content).toBe('Z'.repeat(249));
          expect(article.content.isWellFormed()).toBe(true);
        }
        expect(result.truncation?.articles).toEqual([
          { id: '42', source: 'unpaywall', originalCharacters: 451, returnedCharacters: 249 },
        ]);
      });
    });
  });

  describe('format()', () => {
    it('formats a PMC article with full metadata', () => {
      const blocks = fetchFulltextTool.format!({
        articles: [
          {
            source: 'pmc',
            viaSource: 'pmc',
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
        unavailable: [
          {
            id: '99999',
            idType: 'pmid',
            reason: 'no-oa',
            detail: 'No open-access copy indexed',
            triedTiers: [
              { tier: 'pmc', outcome: 'miss' },
              { tier: 'europepmc', outcome: 'no-fulltext' },
              { tier: 'unpaywall', outcome: 'no-oa', detail: 'No open-access copy indexed' },
            ],
          },
          {
            id: 'PMC404',
            idType: 'pmcid',
            reason: 'not-found',
            triedTiers: [{ tier: 'pmc', outcome: 'miss' }],
          },
        ],
      });

      const text = blocks[0]?.text ?? '';
      expect(text).toContain('Full-Text Articles');
      expect(text).toContain('Article');
      expect(text).toContain('Unavailable (2)');
      expect(text).toContain('[pmid] 99999 — no-oa');
      expect(text).toContain('[pmcid] PMC404 — not-found');
      expect(text).toContain('chain: pmc:miss → europepmc:no-fulltext → unpaywall:no-oa');
      expect(text).toContain('Affiliations');
      expect(text).toContain('Nature, **12**(3), 45-52');
      expect(text).toContain('Published:** 2024-01-02');
      expect(text).toContain('Keywords:** asthma, airway');
      expect(text).toContain('#### Abstract');
      expect(text).toContain('##### Background');
      expect(text).toContain('References (1)');
      expect(text).toContain('[1] Reference one');
    });

    it('labels EPMC-sourced PMC articles with the EPMC source name', () => {
      const blocks = fetchFulltextTool.format!({
        articles: [
          {
            source: 'pmc',
            viaSource: 'europepmc',
            epmcId: 'PPR42',
            epmcSource: 'PPR',
            title: 'Preprint',
            sections: [],
            doi: '10.21203/x',
          },
        ],
        totalReturned: 1,
      });

      const text = blocks[0]?.text ?? '';
      expect(text).toContain('Europe PMC (structured JATS');
      expect(text).toContain('source: PPR');
      expect(text).toContain('EPMC ID:** PPR42');
    });

    it('renders unavailable DOIs in the unified unavailable section', () => {
      const blocks = fetchFulltextTool.format!({
        articles: [],
        totalReturned: 0,
        unavailable: [
          {
            id: '10.1000/foo',
            idType: 'doi',
            reason: 'no-oa',
            triedTiers: [{ tier: 'unpaywall', outcome: 'no-oa' }],
          },
          {
            id: '10.1000/bar',
            idType: 'doi',
            reason: 'no-oa',
            triedTiers: [{ tier: 'unpaywall', outcome: 'no-oa' }],
          },
        ],
      });
      const text = blocks[0]?.text ?? '';
      expect(text).toContain('Unavailable (2)');
      expect(text).toContain('[doi] 10.1000/foo');
      expect(text).toContain('[doi] 10.1000/bar');
      expect(text).toContain('chain: unpaywall:no-oa');
    });

    it('formats an unpaywall article with viaSource=unpaywall', () => {
      const blocks = fetchFulltextTool.format!({
        articles: [
          {
            source: 'unpaywall',
            viaSource: 'unpaywall',
            contentFormat: 'html-markdown',
            pmid: '42',
            pubmedUrl: 'https://pubmed.ncbi.nlm.nih.gov/42/',
            doi: '10.1000/example',
            sourceUrl: 'https://repo.example.org/paper',
            title: 'A Paper',
            content: '# A Paper\n\nMain body',
            wordCount: 1200,
            license: 'cc-by',
            hostType: 'repository',
            version: 'acceptedVersion',
          },
        ],
        totalReturned: 1,
      });

      const text = blocks[0]?.text ?? '';
      expect(text).toContain('A Paper');
      expect(text).toContain('Unpaywall (HTML → Markdown, best-effort)');
      expect(text).toContain('License:** cc-by');
      expect(text).toContain('Main body');
    });

    it('formats a doi-input unpaywall article (no pmid)', () => {
      const blocks = fetchFulltextTool.format!({
        articles: [
          {
            source: 'unpaywall',
            viaSource: 'unpaywall',
            contentFormat: 'pdf-text',
            doi: '10.21203/x',
            sourceUrl: 'https://repo.example.org/paper.pdf',
            content: 'Paper text',
            totalPages: 7,
          },
        ],
        totalReturned: 1,
      });

      const text = blocks[0]?.text ?? '';
      expect(text).toContain('DOI 10.21203/x');
      expect(text).toContain('Pages:** 7');
      expect(text).not.toContain('PubMed:**');
    });

    it('formats an unpaywall article (pdf-text) with page count', () => {
      const blocks = fetchFulltextTool.format!({
        articles: [
          {
            source: 'unpaywall',
            viaSource: 'unpaywall',
            contentFormat: 'pdf-text',
            pmid: '42',
            pubmedUrl: 'https://pubmed.ncbi.nlm.nih.gov/42/',
            doi: '10.1000/example',
            sourceUrl: 'https://arxiv.org/pdf/2401.0001.pdf',
            content: 'Paper text',
            totalPages: 7,
            license: 'cc0',
            hostType: 'repository',
            version: 'submittedVersion',
          },
        ],
        totalReturned: 1,
      });

      const text = blocks[0]?.text ?? '';
      expect(text).toContain('Unpaywall (PDF → plain text)');
      expect(text).toContain('Pages:** 7');
      expect(text).toContain('License:** cc0');
      expect(text).toContain('Paper text');
    });

    describe('empty-result recovery guidance (issue #33)', () => {
      it('emits a recovery blockquote when totalReturned is 0', () => {
        const blocks = fetchFulltextTool.format!({
          articles: [],
          totalReturned: 0,
          unavailable: [
            {
              id: '31295471',
              idType: 'pmid',
              reason: 'no-doi',
              triedTiers: [{ tier: 'unpaywall', outcome: 'no-doi' }],
            },
          ],
        });

        const text = blocks[0]?.text ?? '';
        expect(text).toContain('**Articles Returned:** 0');
        expect(text).toContain('No full-text articles returned');
        expect(text).toContain('PMC');
        expect(text).toContain('pubmed_fetch_articles');
      });

      it('renders the unavailable list before the recovery blockquote', () => {
        const blocks = fetchFulltextTool.format!({
          articles: [],
          totalReturned: 0,
          unavailable: [
            {
              id: '31295471',
              idType: 'pmid',
              reason: 'no-doi',
              triedTiers: [{ tier: 'unpaywall', outcome: 'no-doi' }],
            },
          ],
        });

        const text = blocks[0]?.text ?? '';
        const unavailableIdx = text.indexOf('Unavailable (');
        const recoveryIdx = text.indexOf('No full-text articles returned');
        expect(unavailableIdx).toBeGreaterThan(-1);
        expect(recoveryIdx).toBeGreaterThan(unavailableIdx);
      });

      it('does NOT emit the recovery blockquote when articles are present', () => {
        const blocks = fetchFulltextTool.format!({
          articles: [
            {
              source: 'pmc',
              viaSource: 'pmc',
              pmcId: 'PMC1',
              pmcUrl: 'https://www.ncbi.nlm.nih.gov/pmc/articles/PMC1/',
              title: 'Real Article',
              authors: [],
              affiliations: [],
              keywords: [],
              sections: [],
              references: [],
            },
          ],
          totalReturned: 1,
        });

        const text = blocks[0]?.text ?? '';
        expect(text).not.toContain('No full-text articles returned');
      });
    });
  });

  describe('format content[] completeness (issue #29)', () => {
    const baseArticle = {
      source: 'pmc' as const,
      viaSource: 'pmc' as const,
      pmcId: 'PMC1',
      pmcUrl: 'https://www.ncbi.nlm.nih.gov/pmc/articles/PMC1/',
      title: 'Article',
      authors: [
        { lastName: 'Smith', givenNames: 'Jane' },
        { lastName: 'Jones', givenNames: 'Alex' },
        { lastName: 'Brown', givenNames: 'Sam' },
        { lastName: 'White', givenNames: 'Pat' },
        { collectiveName: 'Consortium X' },
      ],
      journal: { title: 'Nature', issn: '1476-4687', volume: '12', issue: '3', pages: '45-52' },
      sections: [
        {
          title: 'Introduction',
          label: '1',
          text: 'Intro body.',
          subsections: [{ title: 'Background', label: '1.1', text: 'Background.' }],
        },
        { title: 'Methods', text: 'Methods body.' },
      ],
    };

    it('renders every author with givenNames lastName — no et al. truncation', () => {
      const blocks = fetchFulltextTool.format!({ articles: [baseArticle], totalReturned: 1 });
      const text = blocks[0]?.text ?? '';

      expect(text).toContain('**Authors (5):**');
      expect(text).toContain('- Jane Smith');
      expect(text).toContain('- Alex Jones');
      expect(text).toContain('- Sam Brown');
      expect(text).toContain('- Pat White');
      expect(text).toContain('- Consortium X (collective)');
      expect(text).not.toContain('et al.');
    });

    it('renders the journal ISSN alongside other journal fields', () => {
      const blocks = fetchFulltextTool.format!({ articles: [baseArticle], totalReturned: 1 });
      expect(blocks[0]?.text).toContain('ISSN 1476-4687');
    });

    it('prefixes section and subsection headings with the JATS label when present', () => {
      const blocks = fetchFulltextTool.format!({ articles: [baseArticle], totalReturned: 1 });
      const text = blocks[0]?.text ?? '';

      expect(text).toContain('#### 1 Introduction');
      expect(text).toContain('##### 1.1 Background');
      expect(text).toContain('#### Methods');
    });
  });
});
