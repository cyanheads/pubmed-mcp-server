/**
 * @fileoverview Tests for the fetch-fulltext tool.
 * @module tests/mcp-server/tools/definitions/fetch-fulltext.tool.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockEFetch = vi.fn();
const mockIdConvert = vi.fn();
const mockParsePmcArticle = vi.fn();
const mockUnpaywallResolve = vi.fn();
const mockUnpaywallFetchContent = vi.fn();
const mockGetUnpaywallService = vi.fn();
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
vi.mock('@cyanheads/mcp-ts-core/utils', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@cyanheads/mcp-ts-core/utils');
  return {
    ...actual,
    htmlExtractor: { extract: mockHtmlExtract },
    pdfParser: { extractText: mockPdfExtractText },
  };
});

const { fetchFulltextTool } = await import('@/mcp-server/tools/definitions/fetch-fulltext.tool.js');

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
    mockHtmlExtract.mockReset();
    mockPdfExtractText.mockReset();
    mockGetUnpaywallService.mockReturnValue(undefined);
  });

  it('validates input with pmcids', () => {
    const input = fetchFulltextTool.input.parse({ pmcids: ['PMC1234567'] });
    expect(input.pmcids).toEqual(['PMC1234567']);
  });

  it('rejects non-numeric PMIDs with an actionable error message (issue #27)', () => {
    const parsed = fetchFulltextTool.input.safeParse({ pmids: ['abc'] });
    expect(parsed.success).toBe(false);
    const message = parsed.error?.issues[0]?.message ?? '';
    expect(message).toMatch(/PMID/);
    expect(message).toMatch(/numeric/);
    expect(message).toContain('13054692');
  });

  it('rejects input with neither pmcids nor pmids (issue #46)', () => {
    const parsed = fetchFulltextTool.input.safeParse({});
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.message).toMatch(/exactly one of `pmcids` or `pmids`/);
  });

  it('rejects input with both pmcids and pmids (issue #46)', () => {
    const parsed = fetchFulltextTool.input.safeParse({
      pmcids: ['PMC1'],
      pmids: ['12345'],
    });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.message).toMatch(/exactly one of `pmcids` or `pmids`/);
  });

  it('fetches by PMC IDs', async () => {
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
      expect(first.pmcId).toBe('PMC1234567');
      expect(first.title).toBe('Full Text Article');
    }
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
    mockEFetch.mockResolvedValue([{ 'pmc-articleset': [{ article: [] }] }]);

    const ctx = createMockContext();
    const input = fetchFulltextTool.input.parse({
      pmids: ['12345', '99999'],
      sections: ['intro'],
      maxSections: 1,
    });
    const result = await fetchFulltextTool.handler(input, ctx);

    expect(mockEFetch).toHaveBeenCalledWith(
      { db: 'pmc', id: '777', retmode: 'xml' },
      expect.objectContaining({
        retmode: 'xml',
        useOrderedParser: true,
        usePost: false,
        signal: expect.any(AbortSignal),
      }),
    );
    expect(result.unavailable).toEqual([
      {
        pmid: '99999',
        reason: 'no-pmc-fallback-disabled',
        detail: expect.stringContaining('UNPAYWALL_EMAIL'),
      },
    ]);
    const pmc = result.articles[0];
    expect(pmc?.source).toBe('pmc');
    if (pmc?.source === 'pmc') {
      expect(pmc.sections).toEqual([{ title: 'Introduction', text: 'Intro text.' }]);
      expect(pmc.references).toBeUndefined();
    }
  });

  it('normalizes direct PMC IDs, uses POST for large requests, and reports missing PMC IDs', async () => {
    mockParsePmcArticle.mockReturnValue({
      pmcId: 'PMC111',
      pmcUrl: 'https://www.ncbi.nlm.nih.gov/pmc/articles/PMC111/',
      title: 'Direct PMC Article',
      sections: [],
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
    expect(result.unavailablePmcIds).toEqual(['PMC222', 'PMC333', 'PMC444', 'PMC555', 'PMC666']);
  });

  it('reports all PMC IDs as unavailable when the article set is empty (issue #20)', async () => {
    mockEFetch.mockResolvedValue([{ 'pmc-articleset': [] }]);

    const ctx = createMockContext();
    const input = fetchFulltextTool.input.parse({ pmcids: ['PMC9999999'] });
    const result = await fetchFulltextTool.handler(input, ctx);

    expect(result.totalReturned).toBe(0);
    expect(result.articles).toEqual([]);
    expect(result.unavailablePmcIds).toEqual(['PMC9999999']);
  });

  it('returns empty when no PMIDs resolve and fallback is disabled', async () => {
    mockIdConvert.mockResolvedValue([{ 'requested-id': '99999', pmid: '99999' }]);
    const ctx = createMockContext();
    const input = fetchFulltextTool.input.parse({ pmids: ['99999'] });
    const result = await fetchFulltextTool.handler(input, ctx);

    expect(result.totalReturned).toBe(0);
    expect(result.unavailable).toEqual([
      {
        pmid: '99999',
        reason: 'no-pmc-fallback-disabled',
        detail: expect.stringContaining('UNPAYWALL_EMAIL'),
      },
    ]);
  });

  it('throws when PMC EFetch response is missing the article set', async () => {
    mockEFetch.mockResolvedValue([]);

    const ctx = createMockContext();
    const input = fetchFulltextTool.input.parse({ pmcids: ['PMC1'] });

    await expect(fetchFulltextTool.handler(input, ctx)).rejects.toThrow(/missing pmc-articleset/);
  });

  describe('Unpaywall fallback', () => {
    beforeEach(() => {
      mockGetUnpaywallService.mockReturnValue({
        resolve: mockUnpaywallResolve,
        fetchContent: mockUnpaywallFetchContent,
      });
    });

    it('returns no-doi when neither the ID Converter nor PubMed metadata surfaces a DOI', async () => {
      mockIdConvert.mockResolvedValue([{ 'requested-id': '42', pmid: '42' }]);
      mockEFetchBy({ pubmedDois: {} }); // PubMed returns no DOI either

      const ctx = createMockContext();
      const input = fetchFulltextTool.input.parse({ pmids: ['42'] });
      const result = await fetchFulltextTool.handler(input, ctx);

      expect(result.totalReturned).toBe(0);
      expect(result.unavailable).toEqual([{ pmid: '42', reason: 'no-doi' }]);
      expect(mockUnpaywallResolve).not.toHaveBeenCalled();
    });

    it('sources the DOI from PubMed metadata when ID Converter omits it (regression for field-test)', async () => {
      // The PMC ID Converter returns {pmid, errmsg} — no DOI — for non-PMC PMIDs.
      // The handler must fall through to eFetch db=pubmed to get the DOI, then
      // dispatch to Unpaywall with it.
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

      expect(mockEFetch).toHaveBeenCalledWith(
        expect.objectContaining({ db: 'pubmed', id: '42' }),
        expect.any(Object),
      );
      expect(mockUnpaywallResolve).toHaveBeenCalledWith('10.1000/example', expect.any(AbortSignal));
      expect(result.totalReturned).toBe(1);
      const article = result.articles[0];
      expect(article?.source).toBe('unpaywall');
      if (article?.source === 'unpaywall') {
        expect(article.doi).toBe('10.1000/example');
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

      expect(result.totalReturned).toBe(0);
      expect(result.unavailable).toEqual([
        { pmid: '42', reason: 'no-oa', detail: 'No open-access copy indexed' },
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
        { pmid: '42', reason: 'fetch-failed', detail: 'HTTP 503' },
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
        { pmid: '42', reason: 'parse-failed', detail: expect.stringContaining('empty') },
      ]);
    });

    it('combines PMC hits with Unpaywall fallback results in a single response', async () => {
      mockIdConvert.mockResolvedValue([
        { 'requested-id': '1', pmid: '1', pmcid: 'PMC100' },
        { 'requested-id': '2', pmid: '2' },
      ]);
      mockParsePmcArticle.mockReturnValue({
        pmcId: 'PMC100',
        pmcUrl: 'https://www.ncbi.nlm.nih.gov/pmc/articles/PMC100/',
        pmid: '1',
        title: 'PMC Hit',
        sections: [],
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

  describe('format()', () => {
    it('formats a PMC article with full metadata', () => {
      const blocks = fetchFulltextTool.format!({
        articles: [
          {
            source: 'pmc',
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
        unavailable: [{ pmid: '99999', reason: 'no-oa', detail: 'No open-access copy indexed' }],
        unavailablePmcIds: ['PMC404'],
      });

      const text = blocks[0]?.text ?? '';
      expect(text).toContain('Full-Text Articles');
      expect(text).toContain('Article');
      expect(text).toContain('Unavailable PMIDs');
      expect(text).toContain('99999 — no-oa');
      expect(text).toContain('Unavailable PMC IDs');
      expect(text).toContain('Affiliations');
      expect(text).toContain('Nature, **12**(3), 45-52');
      expect(text).toContain('Published:** 2024-01-02');
      expect(text).toContain('Keywords:** asthma, airway');
      expect(text).toContain('#### Abstract');
      expect(text).toContain('##### Background');
      expect(text).toContain('References (1)');
      expect(text).toContain('[1] Reference one');
    });

    it('formats an unpaywall article (html-markdown) with source, license, and attribution', () => {
      const blocks = fetchFulltextTool.format!({
        articles: [
          {
            source: 'unpaywall',
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
      expect(text).toContain('Host Type:** repository');
      expect(text).toContain('Version:** acceptedVersion');
      expect(text).toContain('Word Count:** 1200');
      expect(text).toContain('courtesy of Unpaywall');
      expect(text).toContain('Main body');
    });

    it('formats an unpaywall article (pdf-text) with page count', () => {
      const blocks = fetchFulltextTool.format!({
        articles: [
          {
            source: 'unpaywall',
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
  });

  describe('format content[] completeness (issue #29)', () => {
    const baseArticle = {
      source: 'pmc' as const,
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
