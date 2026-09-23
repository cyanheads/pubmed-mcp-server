/**
 * @fileoverview Security tests for all MCP tool definitions. Covers injection
 * attempts (query injection, path traversal), oversized inputs, and an explicit
 * assertion that no secret, API key, or env value leaks into any tool output or
 * error message. All external HTTP is mocked — no real network calls.
 * @module tests/mcp-server/tools/definitions/security.test
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ParsedBriefSummary } from '@/services/ncbi/types.js';

import { textBlocks } from '../../../_helpers.js';
import {
  articleSetXml,
  GENEREVIEWS_CHAPTER_XML,
  parseArticleSetXml,
} from '../../../services/ncbi/parsing/_book-fixtures.js';

// ─── Mocks ────────────────────────────────────────────────────────────────────

const mockESearch = vi.fn();
const mockESummary = vi.fn();
const mockEFetch = vi.fn();
const mockESpell = vi.fn();
const mockELink = vi.fn();
const mockEInfo = vi.fn();
const mockECitMatch = vi.fn();
const mockIdConvert = vi.fn();
const mockExtractBriefSummaries = vi.fn((): Promise<ParsedBriefSummary[]> => Promise.resolve([]));
const mockGetUnpaywallService = vi.fn(() => undefined);
/** Loosely typed so a test can model a Europe PMC service that throws, not only an absent one. */
const mockGetEpmcService = vi.fn((): unknown => undefined);

vi.mock('@/services/ncbi/ncbi-service.js', () => ({
  getNcbiService: () => ({
    eSearch: mockESearch,
    eSummary: mockESummary,
    eFetch: mockEFetch,
    eSpell: mockESpell,
    eLink: mockELink,
    eInfo: mockEInfo,
    eCitMatch: mockECitMatch,
    idConvert: mockIdConvert,
  }),
}));
vi.mock('@/services/ncbi/parsing/esummary-parser.js', () => ({
  extractBriefSummaries: mockExtractBriefSummaries,
}));
vi.mock('@/services/unpaywall/unpaywall-service.js', () => ({
  getUnpaywallService: mockGetUnpaywallService,
}));
vi.mock('@/services/europe-pmc/europe-pmc-service.js', () => ({
  getEuropePmcService: () => mockGetEpmcService(),
}));
vi.mock('@cyanheads/mcp-ts-core/utils', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@cyanheads/mcp-ts-core/utils');
  return {
    ...actual,
    htmlExtractor: { extract: vi.fn() },
    pdfParser: { extractText: vi.fn() },
  };
});

const { searchArticlesTool } = await import(
  '@/mcp-server/tools/definitions/search-articles.tool.js'
);
const { fetchArticlesTool } = await import('@/mcp-server/tools/definitions/fetch-articles.tool.js');
const { spellCheckTool } = await import('@/mcp-server/tools/definitions/spell-check.tool.js');
const { fetchFulltextTool } = await import('@/mcp-server/tools/definitions/fetch-fulltext.tool.js');
const { lookupMeshTool } = await import('@/mcp-server/tools/definitions/lookup-mesh.tool.js');
const { convertIdsTool } = await import('@/mcp-server/tools/definitions/convert-ids.tool.js');
const { findRelatedTool } = await import('@/mcp-server/tools/definitions/find-related.tool.js');

beforeEach(() => {
  mockESearch.mockReset();
  mockESummary.mockReset();
  mockEFetch.mockReset();
  mockESpell.mockReset();
  mockELink.mockReset();
  mockEInfo.mockReset();
  mockECitMatch.mockReset();
  mockIdConvert.mockReset();
  mockExtractBriefSummaries.mockReset();
  mockExtractBriefSummaries.mockResolvedValue([]);
  mockGetUnpaywallService.mockReturnValue(undefined);
  mockGetEpmcService.mockReturnValue(undefined);
});

// ─── Input validation: injection attempts ────────────────────────────────────

describe('search-articles injection', () => {
  it('rejects empty query string (min(1) constraint)', () => {
    const result = searchArticlesTool.input.safeParse({ query: '' });
    expect(result.success).toBe(false);
  });

  it('accepts a single-character query (schema only requires min length 1)', () => {
    const result = searchArticlesTool.input.safeParse({ query: 'x' });
    expect(result.success).toBe(true);
  });

  it('accepts SQL-injection-like content (sanitization runs inside handler)', async () => {
    // The tool schema does not block injection strings at the Zod layer —
    // sanitization.sanitizeString runs inside the handler. This test confirms
    // the parse boundary is correct (accepts any non-empty string) and that the
    // sanitized value is forwarded to NCBI rather than rejected silently.
    mockESearch.mockResolvedValue({
      count: 0,
      idList: [],
      retmax: 20,
      retstart: 0,
      queryTranslation: '1=1[All Fields]',
    });
    const ctx = createMockContext({ errors: searchArticlesTool.errors });
    const sqlPayload = "cancer' OR '1'='1";
    const input = searchArticlesTool.input.parse({ query: sqlPayload });
    await searchArticlesTool.handler(input, ctx);
    // The call must have been made (query was not completely dropped)
    expect(mockESearch).toHaveBeenCalled();
  });

  it('XSS-like content: sanitizeString strips HTML tags before passing to eSearch', async () => {
    // sanitization.sanitizeString({context:'text'}) removes HTML markup and
    // keeps the text it wrapped. The eSearch term must NOT contain raw tags.
    mockESearch.mockResolvedValue({ count: 0, idList: [], retmax: 20, retstart: 0 });
    const ctx = createMockContext({ errors: searchArticlesTool.errors });
    const input = searchArticlesTool.input.parse({ query: '<b onclick="alert(1)">cancer</b>' });
    await searchArticlesTool.handler(input, ctx);
    const calledTerm = mockESearch.mock.calls[0]?.[0]?.term as string;

    expect(calledTerm).toContain('cancer');
    expect(calledTerm).not.toContain('<b');
    expect(calledTerm).not.toContain('onclick');
  });

  it('XSS-like content with no text of its own is rejected before NCBI is called', async () => {
    // The sanitizer reduces markup carrying no text content to an empty string.
    // That value is not a search term, so the blank-query contract rejects it
    // rather than handing NCBI an empty term to retry on. (#122)
    const ctx = createMockContext({ errors: searchArticlesTool.errors });
    const input = searchArticlesTool.input.parse({ query: '<script>alert(1)</script>' });

    await expect(searchArticlesTool.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'blank_query' },
    });
    expect(mockESearch).not.toHaveBeenCalled();
  });

  it('rejects maxResults below 1', () => {
    const result = searchArticlesTool.input.safeParse({ query: 'cancer', maxResults: 0 });
    expect(result.success).toBe(false);
  });

  it('rejects maxResults above 1000 (schema max is 1000)', () => {
    const result = searchArticlesTool.input.safeParse({ query: 'cancer', maxResults: 1001 });
    expect(result.success).toBe(false);
  });

  it('accepts maxResults = 1000 (at boundary)', () => {
    const result = searchArticlesTool.input.safeParse({ query: 'cancer', maxResults: 1000 });
    expect(result.success).toBe(true);
  });

  it('rejects negative offset', () => {
    const result = searchArticlesTool.input.safeParse({ query: 'cancer', offset: -1 });
    expect(result.success).toBe(false);
  });
});

// ─── Input validation: oversized PMID arrays ─────────────────────────────────

describe('fetch-articles oversized input', () => {
  it('rejects an empty pmids array', () => {
    const result = fetchArticlesTool.input.safeParse({ pmids: [] });
    expect(result.success).toBe(false);
  });

  it('rejects more than 200 PMIDs', () => {
    const tooMany = Array.from({ length: 201 }, (_, i) => String(i + 1));
    const result = fetchArticlesTool.input.safeParse({ pmids: tooMany });
    expect(result.success).toBe(false);
  });

  it('accepts exactly 200 PMIDs (boundary)', () => {
    const maxBatch = Array.from({ length: 200 }, (_, i) => String(i + 1));
    const result = fetchArticlesTool.input.safeParse({ pmids: maxBatch });
    expect(result.success).toBe(true);
  });
});

// ─── Input validation: PMID format enforcement ───────────────────────────────

describe('PMID injection via fetch-articles', () => {
  it('rejects PMIDs with embedded SQL injection characters', () => {
    const result = fetchArticlesTool.input.safeParse({ pmids: ["1234'; DROP TABLE pubmed--"] });
    expect(result.success).toBe(false);
  });

  it('rejects PMIDs with path-traversal characters', () => {
    const result = fetchArticlesTool.input.safeParse({ pmids: ['../../../etc/passwd'] });
    expect(result.success).toBe(false);
  });

  it('rejects PMIDs with URL-encoded sequences', () => {
    const result = fetchArticlesTool.input.safeParse({ pmids: ['%2F%2Fetc%2Fpasswd'] });
    expect(result.success).toBe(false);
  });

  it('rejects PMIDs with null bytes', () => {
    const result = fetchArticlesTool.input.safeParse({ pmids: ['12345\0'] });
    expect(result.success).toBe(false);
  });
});

// ─── Input validation: spell-check ───────────────────────────────────────────

describe('spell-check injection', () => {
  it('rejects query shorter than 2 characters', () => {
    expect(spellCheckTool.input.safeParse({ query: 'x' }).success).toBe(false);
  });

  it('accepts unicode in queries', () => {
    const result = spellCheckTool.input.safeParse({ query: 'β-catenin García' });
    expect(result.success).toBe(true);
  });

  it('passes query value verbatim to eSpell (no secret injection into params)', async () => {
    mockESpell.mockResolvedValue({ original: 'test', corrected: 'test', hasSuggestion: false });
    const ctx = createMockContext({ errors: spellCheckTool.errors });
    const input = spellCheckTool.input.parse({ query: 'test query' });
    await spellCheckTool.handler(input, ctx);
    const called = mockESpell.mock.calls[0]?.[0] as Record<string, unknown>;
    // The call parameters should ONLY contain the expected keys
    expect(Object.keys(called).sort()).toEqual(['db', 'term'].sort());
    expect(called.term).toBe('test query');
    // Must not leak API key or other env vars into the NCBI params
    expect(JSON.stringify(called)).not.toContain('api_key');
    expect(JSON.stringify(called)).not.toContain('NCBI_API_KEY');
  });
});

// ─── fetch-fulltext: input validation ────────────────────────────────────────

describe('fetch-fulltext input validation', () => {
  it('rejects PMC IDs with path traversal', () => {
    const result = fetchFulltextTool.input.safeParse({
      pmcids: ['../../../etc/passwd'],
    });
    expect(result.success).toBe(false);
  });

  it('rejects PMC IDs with shell metacharacters', () => {
    const result = fetchFulltextTool.input.safeParse({
      pmcids: ['PMC123;rm -rf /'],
    });
    expect(result.success).toBe(false);
  });

  it('rejects more than 10 PMC IDs', () => {
    const tooMany = Array.from({ length: 11 }, (_, i) => `PMC${i + 1}`);
    const result = fetchFulltextTool.input.safeParse({ pmcids: tooMany });
    expect(result.success).toBe(false);
  });

  it('rejects more than 10 PMIDs', () => {
    const tooMany = Array.from({ length: 11 }, (_, i) => String(i + 1));
    const result = fetchFulltextTool.input.safeParse({ pmids: tooMany });
    expect(result.success).toBe(false);
  });

  it('rejects more than 10 DOIs', () => {
    const tooMany = Array.from({ length: 11 }, (_, i) => `10.1000/test${i}`);
    const result = fetchFulltextTool.input.safeParse({ dois: tooMany });
    expect(result.success).toBe(false);
  });

  it('rejects DOIs shorter than 3 characters', () => {
    const result = fetchFulltextTool.input.safeParse({ dois: ['10'] });
    expect(result.success).toBe(false);
  });

  it('rejects a DOI carrying a comma, which the ID Converter would split (#120)', () => {
    const result = fetchFulltextTool.input.safeParse({ dois: ['10.1002/a,b'] });
    expect(result.success).toBe(false);
  });

  it('rejects a DOI carrying whitespace', () => {
    const result = fetchFulltextTool.input.safeParse({ dois: ['10.1093/nar /gks1195'] });
    expect(result.success).toBe(false);
  });

  it('accepts a DOI whose suffix uses the full legal punctuation set (#120)', () => {
    const result = fetchFulltextTool.input.safeParse({
      dois: ['10.1002/(SICI)1097-0258(19980815/30)17:15/16<1661::AID-SIM968>3.0.CO;2-2'],
    });
    expect(result.success).toBe(true);
  });
});

// ─── lookup-mesh: input validation ───────────────────────────────────────────

describe('lookup-mesh input validation', () => {
  it('rejects empty term string', () => {
    const result = lookupMeshTool.input.safeParse({ term: '' });
    expect(result.success).toBe(false);
  });

  it('rejects maxResults above 50', () => {
    const result = lookupMeshTool.input.safeParse({ term: 'cancer', maxResults: 51 });
    expect(result.success).toBe(false);
  });
});

// ─── convert-ids: input validation ───────────────────────────────────────────

describe('convert-ids input validation', () => {
  it('rejects an empty ids array', () => {
    const result = convertIdsTool.input.safeParse({ ids: [], idType: 'pmid' });
    expect(result.success).toBe(false);
  });

  it('rejects invalid idType values', () => {
    const result = convertIdsTool.input.safeParse({ ids: ['12345'], idType: 'fake' });
    expect(result.success).toBe(false);
  });
});

// ─── find-related: input validation ──────────────────────────────────────────

describe('find-related input validation', () => {
  it('rejects non-numeric PMID', () => {
    const result = findRelatedTool.input.safeParse({ pmid: 'not-a-number' });
    expect(result.success).toBe(false);
  });

  it('rejects empty PMID string', () => {
    const result = findRelatedTool.input.safeParse({ pmid: '' });
    expect(result.success).toBe(false);
  });
});

// ─── No secret/env value leaks in outputs ────────────────────────────────────

describe('no secret leaks in tool outputs', () => {
  const SECRET_KEY = 'SECRET_API_KEY_SHOULD_NOT_APPEAR_1234567890';

  beforeEach(() => {
    // Simulate a set API key in the environment
    process.env.NCBI_API_KEY = SECRET_KEY;
  });

  afterEach(() => {
    delete process.env.NCBI_API_KEY;
  });

  it('search-articles output does not contain the NCBI API key', async () => {
    mockESearch.mockResolvedValue({
      count: 1,
      idList: ['12345'],
      retmax: 20,
      retstart: 0,
      queryTranslation: 'cancer[All Fields]',
    });
    const ctx = createMockContext({ errors: searchArticlesTool.errors });
    const input = searchArticlesTool.input.parse({ query: 'cancer' });
    const result = await searchArticlesTool.handler(input, ctx);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(SECRET_KEY);
  });

  it('fetch-articles output does not contain the NCBI API key', async () => {
    // A mixed set: an EFetch batch can return a journal article and an NCBI
    // Bookshelf record side by side, and the book branch renders a different
    // set of fields, so both belong in the leak surface. (#114)
    mockEFetch.mockResolvedValue({
      PubmedArticleSet: {
        PubmedArticle: [
          {
            MedlineCitation: {
              PMID: { '#text': '12345' },
              Article: {
                ArticleTitle: { '#text': 'Test' },
                PublicationTypeList: { PublicationType: { '#text': 'Journal Article' } },
              },
            },
          },
        ],
        PubmedBookArticle: parseArticleSetXml(articleSetXml(GENEREVIEWS_CHAPTER_XML))
          .PubmedBookArticle,
      },
    });
    const ctx = createMockContext({ errors: fetchArticlesTool.errors });
    const input = fetchArticlesTool.input.parse({ pmids: ['12345', '20301425'] });
    const result = await fetchArticlesTool.handler(input, ctx);

    expect(result.articles.map((a) => a.recordType)).toEqual(['journal-article', 'book-chapter']);
    expect(JSON.stringify(result)).not.toContain(SECRET_KEY);
    expect(textBlocks(fetchArticlesTool.format!(result))[0]?.text).not.toContain(SECRET_KEY);
  });

  it('find-related all-providers-failed error does not contain the NCBI API key', async () => {
    // Every eligible provider fails: NCBI throws, Europe PMC is turned off, and
    // OpenAlex is unconfigured. The thrown error carries the whole attempt chain
    // — provider messages included — so it is a leak surface like any output.
    mockELink.mockRejectedValue(
      new McpError(JsonRpcErrorCode.ServiceUnavailable, 'NCBI request failed', {
        reason: 'ncbi_unreachable',
      }),
    );

    const ctx = createMockContext({ errors: findRelatedTool.errors });
    const input = findRelatedTool.input.parse({ pmid: '12345', relationship: 'cited_by' });
    let thrown: unknown;
    try {
      await findRelatedTool.handler(input, ctx);
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(McpError);
    const error = thrown as McpError;
    expect((error.data as { reason?: string } | undefined)?.reason).toBe('all_providers_failed');
    const serialized = `${error.message} ${JSON.stringify(error.data)}`;
    expect(serialized).not.toContain(SECRET_KEY);
    expect(serialized).not.toMatch(/\/Users\//);
  });

  it('find-related coverage-failure output does not contain the NCBI API key', async () => {
    // NCBI answers with an empty reference list for a valid non-PMC source, then
    // the Europe PMC coverage fallback throws. The failure is reported on a
    // success payload, so it is a leak surface exactly like the failed-chain error.
    mockELink.mockResolvedValue({ eLinkResult: [{ LinkSet: {} }] });
    mockESummary.mockResolvedValue({ eSummaryResult: {} });
    mockExtractBriefSummaries.mockResolvedValue([
      { pmid: '39248309', title: 'Non-PMC source' } as ParsedBriefSummary,
    ]);
    mockGetEpmcService.mockReturnValue({
      references: vi
        .fn()
        .mockRejectedValue(
          new McpError(
            JsonRpcErrorCode.ServiceUnavailable,
            `Europe PMC request failed: https://www.ebi.ac.uk/europepmc/webservices/rest/MED/39248309/references?api_key=${SECRET_KEY}`,
            { reason: 'europepmc_unreachable' },
          ),
        ),
    });

    const ctx = createMockContext({ errors: findRelatedTool.errors });
    const input = findRelatedTool.input.parse({ pmid: '39248309', relationship: 'references' });
    const result = await findRelatedTool.handler(input, ctx);

    const serialized = `${JSON.stringify(result)} ${JSON.stringify(getEnrichment(ctx))}`;
    expect(serialized).toContain('europepmc_unreachable');
    expect(serialized).not.toContain(SECRET_KEY);
    expect(serialized).not.toContain('ebi.ac.uk');
    expect(serialized).not.toMatch(/\/Users\//);
  });

  it('spell-check output does not contain the NCBI API key', async () => {
    mockESpell.mockResolvedValue({
      original: 'astma',
      corrected: 'asthma',
      hasSuggestion: true,
    });
    const ctx = createMockContext({ errors: spellCheckTool.errors });
    const input = spellCheckTool.input.parse({ query: 'astma' });
    const result = await spellCheckTool.handler(input, ctx);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(SECRET_KEY);
  });
});

// ─── format() output: no internal path leaks ─────────────────────────────────

describe('format() output sanitization', () => {
  it('search-articles format() does not expose internal file paths', () => {
    const blocks = textBlocks(
      searchArticlesTool.format!({
        query: 'cancer',
        offset: 0,
        pmids: ['12345'],
        summaries: [],
        searchUrl: 'https://pubmed.ncbi.nlm.nih.gov/?term=cancer',
        totalCount: 1,
      }),
    );
    const text = blocks[0]?.text ?? '';
    // Output should not contain absolute filesystem paths
    expect(text).not.toMatch(/\/Users\//);
    expect(text).not.toMatch(/\/home\//);
    expect(text).not.toMatch(/C:\\/);
  });

  it('fetch-articles format() does not expose stack traces or internal paths', () => {
    const blocks = textBlocks(
      fetchArticlesTool.format!({
        articles: [
          {
            recordType: 'journal-article' as const,
            pmid: '12345',
            title: 'Test Article',
            pubmedUrl: 'https://pubmed.ncbi.nlm.nih.gov/12345/',
          },
        ],
        totalReturned: 1,
      }),
    );
    const text = blocks[0]?.text ?? '';
    expect(text).not.toMatch(/at Object\./);
    expect(text).not.toMatch(/Error:/);
    expect(text).not.toMatch(/\/Users\//);
  });

  it('fetch-fulltext format() sanitizes upstream URLs in chain details', () => {
    const blocks = textBlocks(
      fetchFulltextTool.format!({
        articles: [],
        totalReturned: 0,
        unavailable: [
          {
            id: 'PMC9999',
            idType: 'pmcid',
            reason: 'service-error',
            triedTiers: [
              {
                tier: 'pmc',
                outcome: 'service-error',
                detail:
                  'Fetch failed for https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?db=pmc&id=9999&api_key=MYSECRET. Status: 500',
              },
            ],
          },
        ],
      }),
    );
    const text = blocks[0]?.text ?? '';
    // The sanitizeChainDetail helper should replace the URL with <upstream>
    expect(text).not.toContain('eutils.ncbi.nlm.nih.gov');
    expect(text).not.toContain('api_key=MYSECRET');
    expect(text).toContain('<upstream>');
  });

  it('fetch-fulltext format() sanitizes chain details on an entry with unqueried tiers', () => {
    const blocks = textBlocks(
      fetchFulltextTool.format!({
        articles: [],
        totalReturned: 0,
        unavailable: [
          {
            id: '40058719',
            idType: 'pmid',
            reason: 'no-epmc-fulltext',
            triedTiers: [
              {
                tier: 'europepmc',
                outcome: 'no-fulltext',
                detail:
                  'No fullTextXML at https://www.ebi.ac.uk/europepmc/webservices/rest/search?email=ops@example.test',
              },
              {
                tier: 'unpaywall',
                outcome: 'not-attempted',
                detail:
                  'UNPAYWALL_EMAIL is not set; would have queried https://api.unpaywall.org/v2?email=ops@example.test',
              },
            ],
            unqueriedTiers: ['unpaywall'],
          },
        ],
      }),
    );
    const text = blocks[0]?.text ?? '';
    expect(text).toContain('no-epmc-fulltext');
    // The unqueried-tier line reads its label out of the same chain detail, so
    // it has to go through the same sanitizer.
    expect(text).toContain('Not queried: Unpaywall');
    expect(text).not.toContain('ebi.ac.uk');
    expect(text).not.toContain('api.unpaywall.org');
    expect(text).not.toContain('ops@example.test');
    expect(text).toContain('<upstream>');
  });

  it('fetch-articles format() neutralizes Markdown markup in an upstream title', () => {
    const blocks = textBlocks(
      fetchArticlesTool.format!({
        articles: [
          {
            recordType: 'journal-article' as const,
            pmid: '12345',
            title: '# Injected\n[Click me](https://evil.test) <img src=x>',
            pubmedUrl: 'https://pubmed.ncbi.nlm.nih.gov/12345/',
          },
        ],
        totalReturned: 1,
      }),
    );
    const text = blocks[0]?.text ?? '';
    // No injected heading line, no clickable link, no raw HTML element.
    expect(text.split('\n').filter((line) => line.startsWith('#'))).toEqual([
      '## PubMed Articles',
      '### # Injected \\[Click me\\](https://evil.test) \\<img src=x>',
    ]);
  });

  it('search-articles format() neutralizes Markdown markup in an upstream summary title', () => {
    const blocks = textBlocks(
      searchArticlesTool.format!({
        query: 'cancer',
        offset: 0,
        pmids: ['12345'],
        summaries: [
          {
            pmid: '12345',
            title: '# Injected\n[Click me](https://evil.test)',
            pubmedUrl: 'https://pubmed.ncbi.nlm.nih.gov/12345/',
          },
        ],
        searchUrl: 'https://pubmed.ncbi.nlm.nih.gov/?term=cancer',
        totalCount: 1,
      }),
    );
    const text = blocks[0]?.text ?? '';
    expect(text.split('\n').filter((line) => line.startsWith('#'))).toEqual([
      '## PubMed Search Results',
      '### Summaries',
      '#### # Injected \\[Click me\\](https://evil.test)',
    ]);
  });

  it('fetch-fulltext format() neutralizes Markdown markup in an upstream title', () => {
    const blocks = textBlocks(
      fetchFulltextTool.format!({
        articles: [
          {
            source: 'pmc',
            viaSource: 'pmc',
            pmcId: 'PMC1',
            title: '# Injected\n[Click me](https://evil.test)',
            sections: [],
          },
        ],
        totalReturned: 1,
      }),
    );
    const text = blocks[0]?.text ?? '';
    expect(text.split('\n').filter((line) => line.startsWith('#'))).toEqual([
      '## Full-Text Articles',
      '### # Injected \\[Click me\\](https://evil.test)',
    ]);
  });

  it('fetch-fulltext format() neutralizes Markdown markup in an Unpaywall title and journal name', () => {
    const blocks = textBlocks(
      fetchFulltextTool.format!({
        articles: [
          {
            source: 'unpaywall',
            viaSource: 'unpaywall',
            contentFormat: 'pdf-text',
            doi: '10.1000/x',
            sourceUrl: 'https://repo.example.org/x.pdf',
            title: '# Injected\n[Click me](https://evil.test)',
            journalName: '[Journal](https://evil.test)',
            year: 2026,
            content: 'Body.',
          },
        ],
        totalReturned: 1,
      }),
    );
    const text = blocks[0]?.text ?? '';
    expect(text).toContain('### # Injected \\[Click me\\](https://evil.test)');
    expect(text).toContain('**Journal:** \\[Journal\\](https://evil.test)');
    expect(text).toContain('**Year:** 2026');
  });

  it('fetch-fulltext format() neutralizes Markdown markup in an asset label, caption, and href', () => {
    const blocks = textBlocks(
      fetchFulltextTool.format!({
        articles: [
          {
            source: 'pmc',
            viaSource: 'pmc',
            pmcId: 'PMC1',
            title: 'Asset-bearing article',
            sections: [],
            assets: [
              {
                assetType: 'figure',
                label: '# Fig. 1',
                caption: '[Click me](https://evil.test)\n## Injected heading',
                id: '*Fig1*',
                sectionTitle: '[METHODS](https://evil.test)',
                href: 'bin/g001.jpg\n### Injected',
              },
            ],
          },
        ],
        totalReturned: 1,
      }),
    );
    const text = blocks[0]?.text ?? '';

    // Every heading in the output is one the renderer wrote. A line break inside
    // any asset field collapses to a space, so no upstream `#` reaches the start
    // of a line and mints a heading of its own.
    expect(text.split('\n').filter((line) => line.startsWith('#'))).toEqual([
      '## Full-Text Articles',
      '### Asset-bearing article',
      '#### Assets (1)',
      '##### # Fig. 1 — \\[Click me\\](https://evil.test) ## Injected heading',
    ]);
    // No clickable link forms from the caption, the section name, or the pointer.
    expect(text).not.toMatch(/[^\\]\[Click me\]\(/);
    expect(text).toContain('Section: \\[METHODS\\](https://evil.test)');
    expect(text).toContain('file: bin/g001.jpg ### Injected');
  });
});

// ─── No prototype pollution ───────────────────────────────────────────────────

describe('no prototype pollution via tool inputs', () => {
  it('search-articles Zod schema rejects __proto__ as a field', () => {
    const malicious = JSON.parse('{"query":"cancer","__proto__":{"polluted":true}}');
    const result = searchArticlesTool.input.safeParse(malicious);
    // Zod strips unknown fields — the parse should succeed (unknown keys ignored)
    // but Object.prototype must not be polluted
    expect((Object.prototype as Record<string, unknown>).polluted).toBeUndefined();
    if (result.success) {
      // Verify __proto__ is not an OWN property of the parsed output
      expect(Object.hasOwn(result.data, '__proto__')).toBe(false);
    }
  });

  it('fetch-articles Zod schema does not pollute Object.prototype via pmids', () => {
    const malicious = JSON.parse('{"pmids":["12345"],"__proto__":{"hacked":true}}');
    fetchArticlesTool.input.safeParse(malicious);
    expect((Object.prototype as Record<string, unknown>).hacked).toBeUndefined();
  });
});

// ─── Edge: empty / minimal results ───────────────────────────────────────────

describe('empty result edge cases', () => {
  it('search-articles handles zero-count result gracefully', async () => {
    mockESearch.mockResolvedValue({
      count: 0,
      idList: [],
      retmax: 20,
      retstart: 0,
      queryTranslation: 'xyznonexistent[All Fields]',
    });
    const ctx = createMockContext({ errors: searchArticlesTool.errors });
    const result = await searchArticlesTool.handler(
      searchArticlesTool.input.parse({ query: 'xyznonexistent' }),
      ctx,
    );
    expect(result.pmids).toEqual([]);
    expect(result.summaries).toEqual([]);
  });

  it('fetch-articles handles PubmedArticleSet with empty array', async () => {
    mockEFetch.mockResolvedValue({
      PubmedArticleSet: { PubmedArticle: [] },
    });
    const ctx = createMockContext({ errors: fetchArticlesTool.errors });
    const result = await fetchArticlesTool.handler(
      fetchArticlesTool.input.parse({ pmids: ['99999'] }),
      ctx,
    );
    expect(result.articles).toEqual([]);
    expect(result.unavailablePmids).toEqual(['99999']);
  });

  it('fetch-articles handles a set whose book member is an empty array (#114)', async () => {
    mockEFetch.mockResolvedValue({
      PubmedArticleSet: { PubmedArticle: [], PubmedBookArticle: [] },
    });
    const ctx = createMockContext({ errors: fetchArticlesTool.errors });
    const result = await fetchArticlesTool.handler(
      fetchArticlesTool.input.parse({ pmids: ['99999'] }),
      ctx,
    );
    expect(result.articles).toEqual([]);
    expect(result.unavailablePmids).toEqual(['99999']);
  });
});

// ─── Input validation: whole-response character ceiling ──────────────────────

describe('maxResponseCharacters bounds', () => {
  const cases = [
    [
      'fetch-articles',
      (v: unknown) => fetchArticlesTool.input.safeParse({ pmids: ['1'], maxResponseCharacters: v }),
    ],
    [
      'fetch-fulltext',
      (v: unknown) =>
        fetchFulltextTool.input.safeParse({ pmcids: ['PMC1'], maxResponseCharacters: v }),
    ],
  ] as const;

  for (const [name, parse] of cases) {
    it(`${name} rejects a non-positive or fractional ceiling`, () => {
      for (const value of [0, -1, -1_000_000, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
        expect(parse(value).success).toBe(false);
      }
    });

    it(`${name} rejects a ceiling above the 1,000,000 cap`, () => {
      expect(parse(1_000_001).success).toBe(false);
      expect(parse(1_000_000).success).toBe(true);
    });

    it(`${name} rejects a non-numeric ceiling`, () => {
      for (const value of ['1000', null, [], {}]) {
        expect(parse(value).success).toBe(false);
      }
    });
  }
});
