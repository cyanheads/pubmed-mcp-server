/**
 * @fileoverview Security tests for all MCP tool definitions. Covers injection
 * attempts (query injection, path traversal), oversized inputs, and an explicit
 * assertion that no secret, API key, or env value leaks into any tool output or
 * error message — for `pubmed_fetch_fulltext`'s tier details, through the real
 * NCBI, Europe PMC, and Unpaywall services. All external HTTP is mocked or
 * stubbed — no real network calls.
 * @module tests/mcp-server/tools/definitions/security.test
 */

import type { ContentBlock } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getServerConfig } from '@/config/server-config.js';
import type { IciteRecord } from '@/services/icite/types.js';
import type { ParsedBriefSummary } from '@/services/ncbi/types.js';

import { readCommonMark, textBlocks } from '../../../_helpers.js';
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
/**
 * The service accessors are loosely typed so a test can hand the tools a real
 * service, or model a Europe PMC service that throws, not only an absent one.
 */
const mockGetUnpaywallService = vi.fn((): unknown => undefined);
const mockGetEpmcService = vi.fn((): unknown => undefined);
const mockNcbiService = {
  eSearch: mockESearch,
  eSummary: mockESummary,
  eFetch: mockEFetch,
  eSpell: mockESpell,
  eLink: mockELink,
  eInfo: mockEInfo,
  eCitMatch: mockECitMatch,
  idConvert: mockIdConvert,
};
const mockGetNcbiService = vi.fn((): unknown => mockNcbiService);
const mockIciteFetchRecords = vi.fn(
  (_pmids: readonly string[]): Promise<IciteRecord[]> => Promise.resolve([]),
);

vi.mock('@/services/icite/icite-service.js', () => ({
  getIciteService: () => ({ fetchRecords: mockIciteFetchRecords }),
}));
vi.mock('@/services/ncbi/ncbi-service.js', () => ({
  getNcbiService: () => mockGetNcbiService(),
}));
vi.mock('@/services/ncbi/parsing/esummary-parser.js', () => ({
  extractBriefSummaries: mockExtractBriefSummaries,
}));
vi.mock('@/services/unpaywall/unpaywall-service.js', () => ({
  getUnpaywallService: mockGetUnpaywallService,
}));
vi.mock('@/services/unpaywall/html-extraction.js', () => ({
  extractHtml: vi.fn(),
}));
vi.mock('@/services/europe-pmc/europe-pmc-service.js', () => ({
  getEuropePmcService: () => mockGetEpmcService(),
}));
vi.mock('@cyanheads/mcp-ts-core/utils', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@cyanheads/mcp-ts-core/utils');
  return {
    ...actual,
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
const { fetchCitationMetricsTool } = await import(
  '@/mcp-server/tools/definitions/fetch-citation-metrics.tool.js'
);

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
  mockGetNcbiService.mockReturnValue(mockNcbiService);
  mockGetUnpaywallService.mockReturnValue(undefined);
  mockGetEpmcService.mockReturnValue(undefined);
  mockIciteFetchRecords.mockReset();
  mockIciteFetchRecords.mockResolvedValue([]);
});

// ─── Input validation: injection attempts ────────────────────────────────────

describe('search-articles injection', () => {
  it('rejects an empty query with no subject filter before NCBI is called (#245)', async () => {
    // An exactly-empty query parses as no query; with no subject filter the
    // handler refuses it rather than searching on nothing.
    const ctx = createMockContext({ errors: searchArticlesTool.errors });
    const input = searchArticlesTool.input.parse({ query: '' });

    await expect(searchArticlesTool.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'no_search_term' },
    });
    expect(mockESearch).not.toHaveBeenCalled();
  });

  it('accepts a single-character query (the schema sets no minimum length)', () => {
    const result = searchArticlesTool.input.safeParse({ query: 'x' });
    expect(result.success).toBe(true);
  });

  it('accepts SQL-injection-like content and forwards it to NCBI as written', async () => {
    // The tool schema does not block injection strings at the Zod layer, and the
    // handler sends the query as written: PubMed reads it as search text. This
    // test confirms the parse boundary is correct (accepts any non-empty string)
    // and that the value reaches NCBI unchanged rather than rejected silently.
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
    expect(mockESearch.mock.calls[0]?.[0]?.term).toBe(sqlPayload);
  });

  it('XSS-like content is search text: sent to eSearch as written, never as HTML', async () => {
    // ESearch receives the query as written — PubMed searches markup as text and
    // never renders it — so an attribute-bearing tag and the `</b>` that closes
    // it reach it unchanged. The term travels as one URL-encoded `term`
    // parameter, so it cannot add or override another. Before #260 the
    // sanitizer's output was sent, which also HTML-encoded `&`, `<`, and `>` in
    // legitimate queries (`R&D` → `R&amp;D`).
    mockESearch.mockResolvedValue({ count: 0, idList: [], retmax: 20, retstart: 0 });
    const ctx = createMockContext({ errors: searchArticlesTool.errors });
    const query = '<b onclick="alert(1)">cancer</b>';
    const input = searchArticlesTool.input.parse({ query });
    await searchArticlesTool.handler(input, ctx);

    expect(mockESearch.mock.calls[0]?.[0]?.term).toBe(query);
    expect(getEnrichment(ctx).effectiveQuery).toBe(query);
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

  it('accepts maxResults 0 as a count-only search and rejects -1 (#191)', () => {
    const zero = searchArticlesTool.input.safeParse({ query: 'cancer', maxResults: 0 });
    const negative = searchArticlesTool.input.safeParse({ query: 'cancer', maxResults: -1 });
    expect(zero.success).toBe(true);
    expect(negative.success).toBe(false);
  });

  it('rejects maxResults above the 10000 ceiling (#232)', () => {
    const result = searchArticlesTool.input.safeParse({ query: 'cancer', maxResults: 10_001 });
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

describe('fetch-citation-metrics oversized input', () => {
  it('sends the first 200 of the 1000 PMIDs a call may name and returns the rest unfetched', async () => {
    const pmids = Array.from({ length: 1000 }, (_, i) => String(30_000_000 + i));
    const ctx = createMockContext({ errors: fetchCitationMetricsTool.errors });
    const result = await fetchCitationMetricsTool.handler(
      fetchCitationMetricsTool.input.parse({ pmids }),
      ctx,
    );
    expect(mockIciteFetchRecords).toHaveBeenCalledOnce();
    expect(mockIciteFetchRecords.mock.calls[0]?.[0]).toEqual(pmids.slice(0, 200));
    expect(result.overLimit).toEqual({ limit: 200, pmids: pmids.slice(200) });
  });
});

// ─── Input validation: PMID format enforcement ───────────────────────────────

describe.each([
  ['fetch-articles', (pmids: string[]) => fetchArticlesTool.input.safeParse({ pmids })],
  [
    'fetch-citation-metrics',
    (pmids: string[]) => fetchCitationMetricsTool.input.safeParse({ pmids }),
  ],
] as const)('PMID injection via %s', (_name, parse) => {
  it('rejects PMIDs with embedded SQL injection characters', () => {
    expect(parse(["1234'; DROP TABLE pubmed--"]).success).toBe(false);
  });

  it('rejects PMIDs with path-traversal characters', () => {
    expect(parse(['../../../etc/passwd']).success).toBe(false);
  });

  it('rejects PMIDs with URL-encoded sequences', () => {
    expect(parse(['%2F%2Fetc%2Fpasswd']).success).toBe(false);
  });

  it('rejects PMIDs with null bytes', () => {
    expect(parse(['12345\0']).success).toBe(false);
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

  // 11–50 are accepted and split at the per-call fetch limit; the ceiling
  // bounds input size against absurd lists. (#222)
  it('rejects more than 50 PMC IDs', () => {
    const ids = Array.from({ length: 51 }, (_, i) => `PMC${i + 1}`);
    expect(fetchFulltextTool.input.safeParse({ pmcids: ids.slice(0, 50) }).success).toBe(true);
    expect(fetchFulltextTool.input.safeParse({ pmcids: ids }).success).toBe(false);
  });

  it('rejects more than 50 PMIDs', () => {
    const ids = Array.from({ length: 51 }, (_, i) => String(i + 1));
    expect(fetchFulltextTool.input.safeParse({ pmids: ids.slice(0, 50) }).success).toBe(true);
    expect(fetchFulltextTool.input.safeParse({ pmids: ids }).success).toBe(false);
  });

  it('rejects more than 50 DOIs', () => {
    const ids = Array.from({ length: 51 }, (_, i) => `10.1000/test${i}`);
    expect(fetchFulltextTool.input.safeParse({ dois: ids.slice(0, 50) }).success).toBe(true);
    expect(fetchFulltextTool.input.safeParse({ dois: ids }).success).toBe(false);
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
  it('rejects an empty query string', () => {
    const result = lookupMeshTool.input.safeParse({ query: '' });
    expect(result.success).toBe(false);
  });

  it('rejects maxResults above the 500 ceiling and accepts 500 (#232)', () => {
    const over = lookupMeshTool.input.safeParse({ query: 'cancer', maxResults: 501 });
    const atMax = lookupMeshTool.input.safeParse({ query: 'cancer', maxResults: 500 });
    expect(over.success).toBe(false);
    expect(atMax.success).toBe(true);
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

// ─── fetch-fulltext tier details: redacted at the source ─────────────────────

/**
 * `pubmed_fetch_fulltext` prints each tier's `detail` on `content[]` exactly as
 * `structuredContent` carries it, so what keeps a credential off both surfaces is
 * the services' own redaction of every request URL a failure message can quote.
 * The real NCBI, Europe PMC, and Unpaywall services run here behind a stubbed
 * global fetch, built with credentials nothing else in this suite uses, and every
 * request a tier sends fails: by HTTP status, and by a rejection quoting the whole
 * request URL, as Bun's `Malformed_HTTP_Response` does. (#318)
 */
describe('fetch-fulltext tier details carry no credential on either surface (#318)', () => {
  const NCBI_API_KEY = 'LeakCheckNcbiKey7f3a';
  const NCBI_TOOL = 'leakcheck-tool-7f3a';
  const NCBI_EMAIL = 'leakcheck-ncbi@example.org';
  const EPMC_EMAIL = 'leakcheck-epmc@example.org';
  const UNPAYWALL_EMAIL = 'leakcheck-unpaywall@example.org';
  /** Each credential in a form URL encoding leaves intact: an email by its local part. */
  const CREDENTIALS = [
    NCBI_API_KEY,
    NCBI_TOOL,
    'leakcheck-ncbi',
    'leakcheck-epmc',
    'leakcheck-unpaywall',
  ];
  const LEAK_MARKERS = [...CREDENTIALS, 'api_key=', 'email=', 'tool='];

  /** Unpaywall fails to resolve it. */
  const RESOLVE_DOI = '10.5555/oa-resolve-fails';
  /** Europe PMC lists an open-access preprint for it and Unpaywall an OA copy; both downloads fail. */
  const CONTENT_DOI = '10.5555/oa-content-fails';
  const OA_COPY = 'https://publisher.example/article/1?token=publisher-token';

  type FailureMode = 'status' | 'rejection';
  const requested: string[] = [];

  /** A failed request: an error status, or a rejection quoting the whole request URL. */
  function fail(url: URL, mode: FailureMode, status: number): Response {
    if (mode === 'status') return new Response('upstream down', { status });
    throw new Error(`Malformed_HTTP_Response fetching "${url.href}"`);
  }

  /**
   * The ID Converter places the PMID and the DOIs outside PMC, so each runs the
   * whole chain. Every other request fails, apart from the two answers that send
   * Europe PMC and Unpaywall on to downloads that then fail.
   */
  function upstream(url: URL, mode: FailureMode): Response {
    const idtype = url.searchParams.get('idtype');
    if (url.pathname.includes('/idconv/') && (idtype === 'pmid' || idtype === 'doi')) {
      const ids = (url.searchParams.get('ids') ?? '').split(',');
      return Response.json({
        status: 'ok',
        records: ids.map((id) => ({
          'requested-id': id,
          ...(idtype === 'pmid' ? { pmid: Number(id) } : { doi: id }),
          status: 'error',
          errmsg: 'Identifier not found in PMC',
        })),
      });
    }
    const query = url.searchParams.get('query') ?? '';
    if (url.hostname === 'www.ebi.ac.uk' && url.pathname.endsWith('/search')) {
      if (query.includes(CONTENT_DOI)) {
        return Response.json({
          hitCount: 1,
          request: { queryString: query },
          resultList: {
            result: [
              {
                id: 'PPR900001',
                source: 'PPR',
                doi: CONTENT_DOI,
                title: 'Preprint',
                isOpenAccess: 'Y',
                fullTextIdList: { fullTextId: ['PPR900001'] },
              },
            ],
          },
        });
      }
    }
    if (
      url.hostname === 'api.unpaywall.org' &&
      decodeURIComponent(url.pathname).endsWith(CONTENT_DOI)
    ) {
      return Response.json({
        doi: CONTENT_DOI,
        is_oa: true,
        best_oa_location: { url: OA_COPY, url_for_pdf: OA_COPY },
      });
    }
    return fail(url, mode, url.hostname === 'publisher.example' ? 403 : 503);
  }

  /** Hands the tools real services carrying the credentials above, every other setting as configured. */
  async function useRealServices() {
    const [{ NcbiService }, { EuropePmcService }, { UnpaywallService }] = await Promise.all([
      vi.importActual<typeof import('@/services/ncbi/ncbi-service.js')>(
        '@/services/ncbi/ncbi-service.js',
      ),
      vi.importActual<typeof import('@/services/europe-pmc/europe-pmc-service.js')>(
        '@/services/europe-pmc/europe-pmc-service.js',
      ),
      vi.importActual<typeof import('@/services/unpaywall/unpaywall-service.js')>(
        '@/services/unpaywall/unpaywall-service.js',
      ),
    ]);
    const { NcbiApiClient } = await import('@/services/ncbi/api-client.js');
    const { createNcbiRequestQueue } = await import('@/services/ncbi/request-queue.js');
    const { NcbiResponseHandler } = await import('@/services/ncbi/response-handler.js');
    const { EuropePmcApiClient } = await import('@/services/europe-pmc/api-client.js');
    const { createEuropePmcRequestQueue } = await import('@/services/europe-pmc/request-queue.js');
    const config = getServerConfig();
    mockGetNcbiService.mockReturnValue(
      new NcbiService(
        new NcbiApiClient({
          apiKey: NCBI_API_KEY,
          adminEmail: NCBI_EMAIL,
          toolIdentifier: NCBI_TOOL,
          timeoutMs: config.timeoutMs,
        }),
        createNcbiRequestQueue({
          minStartGapMs: config.requestDelayMs,
          maxConcurrent: config.maxConcurrent,
        }),
        new NcbiResponseHandler(),
        config.maxRetries,
        config.totalDeadlineMs,
      ),
    );
    mockGetEpmcService.mockReturnValue(
      new EuropePmcService(
        new EuropePmcApiClient({ email: EPMC_EMAIL, timeoutMs: config.europepmcTimeoutMs }),
        createEuropePmcRequestQueue(config.europepmcRequestDelayMs),
        config.europepmcMaxRetries,
        config.europepmcTotalDeadlineMs,
      ),
    );
    mockGetUnpaywallService.mockReturnValue(
      new UnpaywallService(UNPAYWALL_EMAIL, config.unpaywallTimeoutMs),
    );
  }

  /**
   * Runs `call` on a fake clock, firing its timers one at a time until it settles,
   * so every tier's retries and backoff run inside the call's one deadline.
   */
  async function settleOnFakeClock<T>(call: () => Promise<T>): Promise<T> {
    let outcome: { value: T } | { error: unknown } | undefined;
    call().then(
      (value) => {
        outcome = { value };
      },
      (error: unknown) => {
        outcome = { error };
      },
    );
    const startedAt = Date.now();
    for (;;) {
      // The chain from one tier's last timer to the next tier's first runs longer
      // than one step's own flush.
      await vi.advanceTimersByTimeAsync(0);
      if (outcome !== undefined) break;
      const elapsedMs = Date.now() - startedAt;
      if (elapsedMs > 60_000) throw new Error(`Call still pending ${elapsedMs}ms in.`);
      if (vi.getTimerCount() === 0) {
        throw new Error(`Call still pending ${elapsedMs}ms in, with no timer left to fire.`);
      }
      await vi.advanceTimersToNextTimerAsync();
    }
    if ('error' in outcome) throw outcome.error;
    return outcome.value;
  }

  it.each(['status', 'rejection'] as const)(
    'every tier failing by %s leaves no credential on either surface, and content[] reads each detail as structuredContent carries it',
    async (mode) => {
      requested.length = 0;
      const fetchSpy = vi
        .spyOn(globalThis, 'fetch')
        .mockImplementation(async (input: Parameters<typeof fetch>[0]) => {
          const url = new URL(String(input));
          requested.push(url.href);
          return upstream(url, mode);
        });
      vi.useFakeTimers();
      try {
        // The request pacers read the clock, so the services are built on the faked one.
        await useRealServices();
        const result = await settleOnFakeClock(() =>
          runToolContract(fetchFulltextTool, {
            pmcids: ['PMC7612345'],
            pmids: ['12345678'],
            dois: [RESOLVE_DOI, CONTENT_DOI],
          }),
        );

        expect(result.isError).toBeFalsy();
        const { unavailable = [] } = result.structuredContent as {
          unavailable?: Array<{
            triedTiers: Array<{ tier: string; outcome: string; detail?: string }>;
          }>;
        };
        const failedTiers = new Set(
          unavailable.flatMap((u) =>
            u.triedTiers.filter((t) => t.detail).map((t) => `${t.tier}:${t.outcome}`),
          ),
        );
        expect([...failedTiers]).toEqual(
          expect.arrayContaining([
            'pmc:service-error',
            'europepmc:service-error',
            'unpaywall:doi-lookup-failed',
            'unpaywall:service-error',
            'unpaywall:fetch-failed',
          ]),
        );
        // Both downloads ran, and every credential rode a request URL, so a detail
        // quoting one would carry it.
        expect(requested.some((u) => u.endsWith('/PPR900001/fullTextXML'))).toBe(true);
        expect(requested.some((u) => u.startsWith('https://publisher.example/'))).toBe(true);
        expect(CREDENTIALS.filter((c) => !requested.some((u) => u.includes(c)))).toEqual([]);

        const surfaces = JSON.stringify(result);
        expect(LEAK_MARKERS.filter((marker) => surfaces.includes(marker))).toEqual([]);

        const text = textBlocks(result.content as ContentBlock[])
          .map((b) => b.text)
          .join('\n');
        const lines = readCommonMark(text).split('\n');
        for (const { triedTiers } of unavailable) {
          const chain = triedTiers
            .map((t) => `${t.tier}:${t.outcome}${t.detail ? ` (${t.detail})` : ''}`)
            .join(' → ');
          expect(lines).toContain(`chain: ${chain}`);
        }
      } finally {
        vi.useRealTimers();
        fetchSpy.mockRestore();
      }
    },
  );
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

  it('fetch-citation-metrics format() neutralizes Markdown and HTML in an iCite title and journal', async () => {
    mockIciteFetchRecords.mockResolvedValue([
      {
        pmid: '23456789',
        title: '# Injected\n[Click me](https://evil.test) <b onclick="x">bold</b> *a',
        journal: '[J](https://evil.test)*',
        doi: '10.1/<i>x</i>',
      },
    ]);
    const ctx = createMockContext({ errors: fetchCitationMetricsTool.errors });
    const result = await fetchCitationMetricsTool.handler(
      fetchCitationMetricsTool.input.parse({ pmids: ['23456789'] }),
      ctx,
    );
    const text = textBlocks(fetchCitationMetricsTool.format!(result))[0]?.text ?? '';
    const read = readCommonMark(text.slice(text.indexOf('### PMID 23456789')));

    // The title's tags are stripped as markup; every other character reads back
    // as text, with no heading, link, emphasis, or raw HTML formed from it.
    expect(read.split('\n').slice(0, 8)).toEqual([
      '⟨heading_open h3⟩',
      '',
      'PMID 23456789',
      '',
      '⟨heading_close h3⟩',
      '',
      '⟨strong⟩Title:⟨/strong⟩ # Injected [Click me](https://evil.test) bold *a',
      '⟨strong⟩Year:⟨/strong⟩ Not available | ⟨strong⟩Journal:⟨/strong⟩ [J](https://evil.test)* | ⟨strong⟩DOI:⟨/strong⟩ 10.1/<i>x</i>',
    ]);
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

  it('fetch-citation-metrics Zod schema rejects an own __proto__ key by name, unpolluted', () => {
    const malicious = JSON.parse('{"pmids":["12345"],"__proto__":{"iciteHacked":true}}');
    const result = fetchCitationMetricsTool.input.safeParse(malicious);
    expect(result.error?.issues).toEqual([
      expect.objectContaining({ code: 'unrecognized_keys', keys: ['__proto__'] }),
    ]);
    expect((Object.prototype as Record<string, unknown>).iciteHacked).toBeUndefined();
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

  it('fetch-citation-metrics handles an iCite answer with no records', async () => {
    const ctx = createMockContext({ errors: fetchCitationMetricsTool.errors });
    const result = await fetchCitationMetricsTool.handler(
      fetchCitationMetricsTool.input.parse({ pmids: ['99999'] }),
      ctx,
    );
    expect(result).toEqual({ records: [], unavailablePmids: ['99999'] });
    expect(textBlocks(fetchCitationMetricsTool.format!(result))[0]?.text).toBe(
      '## NIH iCite Citation Metrics\nSource: [NIH iCite](https://icite.od.nih.gov/)\n**Records:** 0\n**Unavailable PMIDs:** 99999',
    );
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

    // An output-only ceiling drives no allocation or upstream request, so it
    // takes no cap below the safe-integer bound `.int()` already enforces. (#223)
    it(`${name} accepts any safe-integer ceiling past the former 1,000,000 cap`, () => {
      for (const value of [1_000_000, 1_000_001, Number.MAX_SAFE_INTEGER]) {
        expect(parse(value).success).toBe(true);
      }
      expect(parse(Number.MAX_SAFE_INTEGER + 1).success).toBe(false);
    });

    it(`${name} rejects a non-numeric ceiling`, () => {
      for (const value of ['1000', null, [], {}]) {
        expect(parse(value).success).toBe(false);
      }
    });
  }
});
