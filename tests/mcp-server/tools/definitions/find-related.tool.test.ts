/**
 * @fileoverview Tests for the find-related tool — offset pagination (#36),
 * multi-source provider fallback (#63), the total match count in the header on
 * every return path (#147), Doc Type rendering (#146), the label an exhausted
 * OpenAlex Timeout or RateLimited reports — named by its code — and the reason
 * Europe PMC declares for one, in the coverage summary and the all-providers-failed
 * attempts (#160, #315), a `maxResults` past the cap served at the cap on every
 * return path (#232), the one call deadline every step shares, with a step that
 * had no time left reported not reached (#310), and whether a retry can reach each
 * failed coverage fallback, in the trailer and the notice's retry guidance (#318).
 * @module tests/mcp-server/tools/definitions/find-related.tool.test
 */

import { type ContentBlock, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CallDeadline } from '@/services/call-deadline.js';
import type { ESummaryResult, ParsedBriefSummary } from '@/services/ncbi/types.js';

import { readCommonMark, textBlocks } from '../../../_helpers.js';
import {
  BOOK_ESUMMARY_V1_XML,
  BOOK_ESUMMARY_XML,
  CHAPTER_DATES_ESUMMARY_XML,
  parseESummaryXml,
  VERSION_PAIR_ESUMMARY_V1_XML,
  VERSION_PAIR_ESUMMARY_V2_XML,
} from '../../../services/ncbi/parsing/_book-fixtures.js';
import { APOS_TITLE_ESUMMARY_XML } from '../../../services/ncbi/parsing/_entity-fixtures.js';
import {
  LANGUAGES_BY_PMID,
  LANGUAGES_ESUMMARY_XML,
} from '../../../services/ncbi/parsing/_language-fixtures.js';

const mockELink = vi.fn();
const mockESummary = vi.fn();
const mockExtractBriefSummaries = vi.fn((): Promise<ParsedBriefSummary[]> => Promise.resolve([]));
const mockEpmcCitations = vi.fn();
const mockEpmcReferences = vi.fn();
const mockOaSimilar = vi.fn();
const mockOaCitedBy = vi.fn();
const mockOaReferences = vi.fn();

vi.mock('@/services/ncbi/ncbi-service.js', () => ({
  getNcbiService: () => ({ eLink: mockELink, eSummary: mockESummary }),
}));
vi.mock('@/services/ncbi/parsing/esummary-parser.js', () => ({
  extractBriefSummaries: mockExtractBriefSummaries,
}));
/**
 * Accessor-level mocks so a test can model an absent provider — Europe PMC
 * turned off via `EUROPEPMC_ENABLED=false`, or OpenAlex not configured — and
 * not only a provider that answers or throws.
 */
const epmcService = { citations: mockEpmcCitations, references: mockEpmcReferences };
const oaService = {
  similar: mockOaSimilar,
  citedBy: mockOaCitedBy,
  references: mockOaReferences,
};
const mockGetEpmcService = vi.fn((): unknown => epmcService);
const mockGetOaService = vi.fn((): unknown => oaService);

vi.mock('@/services/europe-pmc/europe-pmc-service.js', () => ({
  getEuropePmcService: () => mockGetEpmcService(),
}));
vi.mock('@/services/openalex/openalex-service.js', () => ({
  getOpenAlexServiceOptional: () => mockGetOaService(),
}));

const { findRelatedTool } = await import('@/mcp-server/tools/definitions/find-related.tool.js');

/**
 * The real parser, reachable past the module mock above, so a test can drive an
 * upstream ESummary body end to end instead of stubbing the parsed result.
 */
const { extractBriefSummaries: realExtractBriefSummaries } = await vi.importActual<
  typeof import('@/services/ncbi/parsing/esummary-parser.js')
>('@/services/ncbi/parsing/esummary-parser.js');

/** Build a minimal NCBI eLink response with the given PMIDs. */
function eLinkResponse(pmids: string[], linkName = 'pubmed_pubmed') {
  return {
    eLinkResult: [
      {
        LinkSet: {
          LinkSetDb: {
            LinkName: linkName,
            Link: pmids.map((id) => ({ Id: id })),
          },
        },
      },
    ],
  };
}

type FindRelatedInput = Parameters<typeof findRelatedTool.handler>[0];
type FindRelatedCtx = Parameters<typeof findRelatedTool.handler>[1];

/**
 * The deadline every upstream call is handed beside its signal. The call-deadline
 * tests at the end of this file pin its values; elsewhere any deadline will do.
 */
const aDeadline = expect.objectContaining({
  expiresAt: expect.any(Number),
  totalMs: expect.any(Number),
});

/** Structured payload the `all_providers_failed` contract entry carries. */
interface AllProvidersFailedData {
  attempted: Array<{ provider: string; reason: string; message: string }>;
  reason: string;
  recovery?: { hint: string };
  relationship: string;
}

/** Narrows a thrown `all_providers_failed` payload for assertions. */
function failureData(error: McpError): AllProvidersFailedData {
  return error.data as unknown as AllProvidersFailedData;
}

/** Runs the handler expecting an `McpError`, and returns it for assertions. */
async function rejection(input: FindRelatedInput, ctx: FindRelatedCtx): Promise<McpError> {
  try {
    await findRelatedTool.handler(input, ctx);
  } catch (error) {
    if (error instanceof McpError) return error;
    throw error;
  }
  throw new Error('Expected the handler to throw an McpError.');
}

describe('findRelatedTool', () => {
  beforeEach(() => {
    mockELink.mockReset();
    mockESummary.mockReset();
    mockExtractBriefSummaries.mockReset();
    mockExtractBriefSummaries.mockResolvedValue([]);
    mockEpmcCitations.mockReset();
    mockEpmcReferences.mockReset();
    mockOaSimilar.mockReset();
    mockOaCitedBy.mockReset();
    mockOaReferences.mockReset();
    mockGetEpmcService.mockReset();
    mockGetEpmcService.mockReturnValue(epmcService);
    mockGetOaService.mockReset();
    mockGetOaService.mockReturnValue(oaService);
  });

  // ── Input schema ─────────────────────────────────────────────────────────

  it('validates input with defaults', () => {
    const input = findRelatedTool.input.parse({ pmid: '12345' });
    expect(input.pmid).toBe('12345');
    expect(input.relationship).toBe('similar');
    expect(input.maxResults).toBe(10);
    expect(input.offset).toBe(0);
  });

  it('rejects non-numeric PMIDs', () => {
    expect(() => findRelatedTool.input.parse({ pmid: 'abc' })).toThrow();
  });

  it('rejects non-numeric PMIDs with an actionable error message (issue #27)', () => {
    const parsed = findRelatedTool.input.safeParse({ pmid: 'abc' });
    expect(parsed.success).toBe(false);
    const message = parsed.error?.issues[0]?.message ?? '';
    expect(message).toMatch(/PMID/);
    expect(message).toMatch(/numeric/);
    expect(message).toContain('13054692');
  });

  // ── Offset pagination (#36) ────────────────────────────────────────────────

  it('offset=0 returns first window of PMIDs', async () => {
    const pmids = ['101', '102', '103', '104', '105'];
    mockELink.mockResolvedValue(eLinkResponse(pmids));
    mockESummary.mockResolvedValue({ eSummaryResult: {} });
    mockExtractBriefSummaries.mockResolvedValue([]);

    const ctx = createMockContext({ errors: findRelatedTool.errors });
    const input = findRelatedTool.input.parse({ pmid: '12345', maxResults: 2, offset: 0 });
    const result = await findRelatedTool.handler(input, ctx);

    expect(result.offset).toBe(0);
    expect(result.articles.map((a) => a.pmid)).toEqual(['101', '102']);
  });

  it('offset=2 returns different, non-overlapping window from offset=0', async () => {
    const pmids = ['101', '102', '103', '104', '105'];
    mockELink.mockResolvedValue(eLinkResponse(pmids));
    mockESummary.mockResolvedValue({ eSummaryResult: {} });
    mockExtractBriefSummaries.mockResolvedValue([]);

    // offset=0 run
    const ctx0 = createMockContext({ errors: findRelatedTool.errors });
    const input0 = findRelatedTool.input.parse({ pmid: '12345', maxResults: 2, offset: 0 });
    const result0 = await findRelatedTool.handler(input0, ctx0);

    // offset=2 run
    mockELink.mockResolvedValue(eLinkResponse(pmids));
    const ctx2 = createMockContext({ errors: findRelatedTool.errors });
    const input2 = findRelatedTool.input.parse({ pmid: '12345', maxResults: 2, offset: 2 });
    const result2 = await findRelatedTool.handler(input2, ctx2);

    expect(result0.articles.map((a) => a.pmid)).toEqual(['101', '102']);
    expect(result2.articles.map((a) => a.pmid)).toEqual(['103', '104']);
    // No overlap between the two windows
    const set0 = new Set(result0.articles.map((a) => a.pmid));
    for (const a of result2.articles) expect(set0.has(a.pmid)).toBe(false);
  });

  it('emits overshoot notice when offset >= totalCount on non-empty set', async () => {
    const pmids = ['101', '102', '103'];
    mockELink.mockResolvedValue(eLinkResponse(pmids));
    mockESummary.mockResolvedValue({ eSummaryResult: {} });
    mockExtractBriefSummaries.mockResolvedValue([]);

    const ctx = createMockContext({ errors: findRelatedTool.errors });
    // offset=10, totalCount=3 → overshoot
    const input = findRelatedTool.input.parse({ pmid: '12345', maxResults: 10, offset: 10 });
    await findRelatedTool.handler(input, ctx);

    expect(getEnrichment(ctx).notice).toBe(
      'Offset 10 exceeds totalCount (3). Reset offset to 0 or reduce it below 3 to page through results.',
    );
  });

  it('echoes offset in the output schema', async () => {
    mockELink.mockResolvedValue(eLinkResponse(['101', '102']));
    mockESummary.mockResolvedValue({ eSummaryResult: {} });
    mockExtractBriefSummaries.mockResolvedValue([]);

    const ctx = createMockContext({ errors: findRelatedTool.errors });
    const input = findRelatedTool.input.parse({ pmid: '12345', maxResults: 5, offset: 3 });
    const result = await findRelatedTool.handler(input, ctx);
    expect(result.offset).toBe(3);
  });

  it('format() header includes "Returned: N of T | Offset: Z"', () => {
    const blocks = textBlocks(
      findRelatedTool.format!({
        sourcePmid: '12345',
        relationship: 'similar',
        offset: 5,
        totalCount: 6,
        articles: [
          {
            pmid: '111',
            title: 'A',
            authors: 'B',
            source: 'C',
            pubDate: '2024',
            pubmedUrl: 'https://pubmed.ncbi.nlm.nih.gov/111/',
          },
        ],
      }),
    );
    const text = blocks[0]?.text ?? '';
    expect(text).toContain('**Returned:** 1 of 6 | **Offset:** 5');
    expect(text).toContain('**Relationship:** similar');
  });

  // ── Provider fallback (#63) ────────────────────────────────────────────────

  it('NCBI success: enrichment.source is "ncbi", no fallback notice', async () => {
    mockELink.mockResolvedValue(eLinkResponse(['111', '222']));
    mockESummary.mockResolvedValue({ eSummaryResult: {} });
    mockExtractBriefSummaries.mockResolvedValue([
      { pmid: '111', title: 'Art 1' },
      { pmid: '222', title: 'Art 2' },
    ]);

    const ctx = createMockContext({ errors: findRelatedTool.errors });
    const input = findRelatedTool.input.parse({ pmid: '12345', relationship: 'cited_by' });
    const result = await findRelatedTool.handler(input, ctx);

    expect(getEnrichment(ctx).source).toBe('ncbi');
    // No fallback notice (notice may still be set for other reasons, but not fallback)
    expect(getEnrichment(ctx).notice).toBeUndefined();
    expect(result.articles.length).toBe(2);
  });

  it('NCBI throws → EPMC serves cited_by: source is "europepmc", notice present', async () => {
    mockELink.mockRejectedValue(new McpError(JsonRpcErrorCode.ServiceUnavailable, 'NCBI down'));
    mockEpmcCitations.mockResolvedValue({
      pmids: ['333', '444'],
      totalCount: 50,
      hitCount: 50,
      droppedNoPmid: 0,
    });
    mockESummary.mockResolvedValue({ eSummaryResult: {} });
    mockExtractBriefSummaries.mockResolvedValue([
      { pmid: '333', title: 'EPMC Art 1' },
      { pmid: '444', title: 'EPMC Art 2' },
    ]);

    const ctx = createMockContext({ errors: findRelatedTool.errors });
    const input = findRelatedTool.input.parse({ pmid: '12345', relationship: 'cited_by' });
    const result = await findRelatedTool.handler(input, ctx);

    expect(getEnrichment(ctx).source).toBe('europepmc');
    expect(getEnrichment(ctx).notice).toBeDefined();
    expect(getEnrichment(ctx).notice).toContain('Europe PMC');
    expect(result.totalCount).toBe(2); // a page shorter than requested exhausts upstream, so the total is exact
    expect(result.articles[0]?.pmid).toBe('333');
  });

  it('NCBI throws for similar → EPMC skipped → OpenAlex serves: source is "openalex", notice present', async () => {
    mockELink.mockRejectedValue(new McpError(JsonRpcErrorCode.ServiceUnavailable, 'NCBI down'));
    // EPMC is not called for similar (epmcSupports returns false)
    mockOaSimilar.mockResolvedValue({ pmids: ['555', '666'], totalCount: 10 });
    mockESummary.mockResolvedValue({ eSummaryResult: {} });
    mockExtractBriefSummaries.mockResolvedValue([
      { pmid: '555', title: 'OA Art 1' },
      { pmid: '666', title: 'OA Art 2' },
    ]);

    const ctx = createMockContext({ errors: findRelatedTool.errors });
    const input = findRelatedTool.input.parse({ pmid: '12345', relationship: 'similar' });
    const result = await findRelatedTool.handler(input, ctx);

    expect(getEnrichment(ctx).source).toBe('openalex');
    expect(getEnrichment(ctx).notice).toBeDefined();
    expect(getEnrichment(ctx).notice).toContain('OpenAlex');
    expect(result.articles[0]?.pmid).toBe('555');
    // EPMC should NOT have been called for similar
    expect(mockEpmcCitations).not.toHaveBeenCalled();
    expect(mockEpmcReferences).not.toHaveBeenCalled();
  });

  it('NCBI throws, EPMC throws → OpenAlex serves: source is "openalex"', async () => {
    mockELink.mockRejectedValue(new McpError(JsonRpcErrorCode.ServiceUnavailable, 'NCBI down'));
    mockEpmcCitations.mockRejectedValue(
      new McpError(JsonRpcErrorCode.ServiceUnavailable, 'EPMC down'),
    );
    mockOaCitedBy.mockResolvedValue({ pmids: ['777'], totalCount: 5 });
    mockESummary.mockResolvedValue({ eSummaryResult: {} });
    mockExtractBriefSummaries.mockResolvedValue([{ pmid: '777', title: 'OA Art' }]);

    const ctx = createMockContext({ errors: findRelatedTool.errors });
    const input = findRelatedTool.input.parse({ pmid: '12345', relationship: 'cited_by' });
    const result = await findRelatedTool.handler(input, ctx);

    expect(getEnrichment(ctx).source).toBe('openalex');
    expect(result.articles[0]?.pmid).toBe('777');
  });

  it('NCBI throws, EPMC returns empty → OpenAlex serves (an empty fallback is not "served")', async () => {
    mockELink.mockRejectedValue(new McpError(JsonRpcErrorCode.ServiceUnavailable, 'NCBI down'));
    mockEpmcCitations.mockResolvedValue({
      pmids: [],
      totalCount: 0,
      hitCount: 0,
      droppedNoPmid: 0,
    });
    mockOaCitedBy.mockResolvedValue({ pmids: ['777'], totalCount: 9 });
    mockESummary.mockResolvedValue({ eSummaryResult: {} });
    mockExtractBriefSummaries.mockResolvedValue([{ pmid: '777', title: 'OA Art' }]);

    const ctx = createMockContext({ errors: findRelatedTool.errors });
    const input = findRelatedTool.input.parse({ pmid: '12345', relationship: 'cited_by' });
    const result = await findRelatedTool.handler(input, ctx);

    expect(getEnrichment(ctx).source).toBe('openalex');
    expect(result.articles[0]?.pmid).toBe('777');
  });

  it('OpenAlex serves an empty set for a PMID it does not index (issue #90)', async () => {
    // `OpenAlexApiClient.getWorkByPmid` converts an upstream 404 to `null`, so
    // `OpenAlexService.similar`'s `if (!work)` guard runs for the first time.
    // The tool degrades to an empty result set instead of reporting every
    // provider as failed.
    mockELink.mockRejectedValue(new McpError(JsonRpcErrorCode.ServiceUnavailable, 'NCBI down'));
    mockOaSimilar.mockResolvedValue({ pmids: [], totalCount: 0 });

    const ctx = createMockContext({ errors: findRelatedTool.errors });
    const input = findRelatedTool.input.parse({ pmid: '99999999', relationship: 'similar' });
    const result = await findRelatedTool.handler(input, ctx);

    expect(result.articles).toEqual([]);
    expect(getEnrichment(ctx).source).toBe('openalex');
    expect(result.totalCount).toBe(0);
    // An empty set is an answer: the caller is told OpenAlex served it.
    expect(getEnrichment(ctx).notice).toBe(
      'NCBI eLink unavailable — related articles served by OpenAlex (related_works — OpenAlex similarity, not PubMed’s neighbor algorithm).',
    );
    // No PMIDs to enrich — the eSummary round-trip is skipped entirely.
    expect(mockESummary).not.toHaveBeenCalled();
  });

  it('OpenAlex serves an empty cited_by set for a PMID it does not index (issue #90)', async () => {
    mockELink.mockRejectedValue(new McpError(JsonRpcErrorCode.ServiceUnavailable, 'NCBI down'));
    mockEpmcCitations.mockResolvedValue({
      pmids: [],
      totalCount: 0,
      hitCount: 0,
      droppedNoPmid: 0,
    });
    mockOaCitedBy.mockResolvedValue({ pmids: [], totalCount: 0 });

    const ctx = createMockContext({ errors: findRelatedTool.errors });
    const input = findRelatedTool.input.parse({ pmid: '99999999', relationship: 'cited_by' });
    const result = await findRelatedTool.handler(input, ctx);

    expect(result.articles).toEqual([]);
    expect(getEnrichment(ctx).source).toBe('openalex');
    expect(getEnrichment(ctx).notice).toBe(
      'NCBI eLink unavailable — related articles served by OpenAlex (cites: filter).',
    );
  });

  it('all eligible providers fail: throws all_providers_failed with the attempt chain (issue #103)', async () => {
    mockELink.mockRejectedValue(
      new McpError(JsonRpcErrorCode.ServiceUnavailable, 'NCBI down', {
        reason: 'ncbi_unreachable',
      }),
    );
    mockEpmcCitations.mockRejectedValue(
      new McpError(JsonRpcErrorCode.ServiceUnavailable, 'EPMC down', {
        reason: 'europepmc_unreachable',
      }),
    );
    mockOaCitedBy.mockRejectedValue(
      new McpError(JsonRpcErrorCode.ServiceUnavailable, 'OA down', {
        reason: 'openalex_unreachable',
      }),
    );

    const ctx = createMockContext({ errors: findRelatedTool.errors });
    const input = findRelatedTool.input.parse({ pmid: '12345', relationship: 'cited_by' });
    const error = await rejection(input, ctx);

    expect(error).toBeInstanceOf(McpError);
    expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    const data = failureData(error);
    expect(data.reason).toBe('all_providers_failed');
    expect(data.relationship).toBe('cited_by');
    // Every eligible provider is named with its own declared failure reason.
    expect(data.attempted).toEqual([
      { provider: 'ncbi', reason: 'ncbi_unreachable', message: 'NCBI down' },
      { provider: 'europepmc', reason: 'europepmc_unreachable', message: 'EPMC down' },
      { provider: 'openalex', reason: 'openalex_unreachable', message: 'OA down' },
    ]);
    expect(data.recovery?.hint).toContain('Retry');
    // No provider's health is asserted — only the outcomes actually observed.
    expect(data.recovery?.hint).not.toContain('remain available');
  });

  it('all_providers_failed: an NCBI network failure quoting its request URL names only the host', async () => {
    const { NcbiApiClient } = await import('@/services/ncbi/api-client.js');
    const client = new NcbiApiClient({
      toolIdentifier: 'test-tool',
      apiKey: 'sk-ncbi-secret',
      adminEmail: 'ops@example.org',
      timeoutMs: 5000,
    });
    const url =
      'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/elink.fcgi?tool=test-tool&email=ops%40example.org&api_key=sk-ncbi-secret';
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(
      Object.assign(new TypeError(`Malformed_HTTP_Response fetching "${url}"`), {
        code: 'Malformed_HTTP_Response',
        path: url,
      }),
    );
    // The real client's rejection, as the service's eLink surfaces it.
    mockELink.mockImplementation(() => client.makeRequest('elink', { db: 'pubmed' }));
    mockEpmcCitations.mockRejectedValue(
      new McpError(JsonRpcErrorCode.ServiceUnavailable, 'EPMC down', {
        reason: 'europepmc_unreachable',
      }),
    );
    mockOaCitedBy.mockRejectedValue(
      new McpError(JsonRpcErrorCode.ServiceUnavailable, 'OA down', {
        reason: 'openalex_unreachable',
      }),
    );

    try {
      const ctx = createMockContext({ errors: findRelatedTool.errors });
      const input = findRelatedTool.input.parse({ pmid: '12345', relationship: 'cited_by' });
      const error = await rejection(input, ctx);

      expect(failureData(error).attempted[0]).toEqual({
        provider: 'ncbi',
        reason: 'ncbi_unreachable',
        message:
          'NCBI request failed: Malformed_HTTP_Response fetching "https://eutils.ncbi.nlm.nih.gov/…?…"',
      });
      const wire = JSON.stringify(error.data);
      for (const fragment of ['?tool=', 'sk-ncbi-secret', 'ops%40example.org']) {
        expect(wire).not.toContain(fragment);
      }
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('all_providers_failed omits a provider excluded by epmcSupports (issue #103)', async () => {
    mockELink.mockRejectedValue(
      new McpError(JsonRpcErrorCode.ServiceUnavailable, 'NCBI down', {
        reason: 'ncbi_unreachable',
      }),
    );
    mockOaSimilar.mockRejectedValue(
      new McpError(JsonRpcErrorCode.ServiceUnavailable, 'OA garbage', {
        reason: 'openalex_invalid_response',
      }),
    );

    const ctx = createMockContext({ errors: findRelatedTool.errors });
    const input = findRelatedTool.input.parse({ pmid: '12345', relationship: 'similar' });
    const error = await rejection(input, ctx);

    const data = failureData(error);
    expect(data.attempted.map((a) => a.provider)).toEqual(['ncbi', 'openalex']);
    expect(data.attempted.some((a) => a.provider === 'europepmc')).toBe(false);
    expect(data.attempted[1]?.reason).toBe('openalex_invalid_response');
    expect(mockEpmcCitations).not.toHaveBeenCalled();
    expect(mockEpmcReferences).not.toHaveBeenCalled();
  });

  it('all_providers_failed marks a config-disabled provider as unrecoverable (issue #103)', async () => {
    // EUROPEPMC_ENABLED=false — the accessor returns undefined.
    mockGetEpmcService.mockReturnValue(undefined);
    mockELink.mockRejectedValue(
      new McpError(JsonRpcErrorCode.ServiceUnavailable, 'NCBI down', {
        reason: 'ncbi_unreachable',
      }),
    );
    mockOaCitedBy.mockRejectedValue(
      new McpError(JsonRpcErrorCode.ServiceUnavailable, 'OA down', {
        reason: 'openalex_unreachable',
      }),
    );

    const ctx = createMockContext({ errors: findRelatedTool.errors });
    const input = findRelatedTool.input.parse({ pmid: '12345', relationship: 'cited_by' });
    const error = await rejection(input, ctx);

    const data = failureData(error);
    expect(data.attempted[1]).toMatchObject({
      provider: 'europepmc',
      reason: 'provider_disabled',
    });
    // A provider that is off by configuration must not be sold as retryable.
    expect(data.recovery?.hint).toContain('Europe PMC');
    expect(data.recovery?.hint).toContain('server configuration');
    expect(data.recovery?.hint).toMatch(/will not recover/i);
  });

  it('all_providers_failed reports an unconfigured OpenAlex as provider_disabled (issue #103)', async () => {
    mockGetOaService.mockReturnValue(undefined);
    mockELink.mockRejectedValue(
      new McpError(JsonRpcErrorCode.ServiceUnavailable, 'NCBI down', {
        reason: 'ncbi_unreachable',
      }),
    );
    mockEpmcCitations.mockRejectedValue(
      new McpError(JsonRpcErrorCode.ServiceUnavailable, 'EPMC down', {
        reason: 'europepmc_unreachable',
      }),
    );

    const ctx = createMockContext({ errors: findRelatedTool.errors });
    const input = findRelatedTool.input.parse({ pmid: '12345', relationship: 'cited_by' });
    const error = await rejection(input, ctx);

    const data = failureData(error);
    expect(data.attempted.map((a) => a.provider)).toEqual(['ncbi', 'europepmc', 'openalex']);
    expect(data.attempted[2]).toMatchObject({ provider: 'openalex', reason: 'provider_disabled' });
    expect(data.recovery?.hint).toContain('OpenAlex is turned off by server configuration');
  });

  it('serves a Europe PMC empty answer when OpenAlex then fails — an answer, not an outage (issue #103)', async () => {
    mockELink.mockRejectedValue(
      new McpError(JsonRpcErrorCode.ServiceUnavailable, 'NCBI down', {
        reason: 'ncbi_unreachable',
      }),
    );
    mockEpmcCitations.mockResolvedValue({
      pmids: [],
      totalCount: 0,
      hitCount: 0,
      droppedNoPmid: 0,
    });
    mockOaCitedBy.mockRejectedValue(
      new McpError(JsonRpcErrorCode.ServiceUnavailable, 'OA down', {
        reason: 'openalex_unreachable',
      }),
    );

    const ctx = createMockContext({ errors: findRelatedTool.errors });
    const input = findRelatedTool.input.parse({ pmid: '12345', relationship: 'cited_by' });
    const result = await findRelatedTool.handler(input, ctx);

    expect(result.articles).toEqual([]);
    expect(getEnrichment(ctx).source).toBe('europepmc');
    expect(result.totalCount).toBe(0);
    expect(String(getEnrichment(ctx).notice)).toContain('Europe PMC');
  });

  it('escapes upstream title and author markup in the rendered list, never in structuredContent (#102)', () => {
    const result = {
      sourcePmid: '1',
      relationship: 'similar' as const,
      offset: 0,
      articles: [
        {
          pmid: '2',
          title: '[click](https://example.test)',
          authors: 'A *B and C *D',
          pubmedUrl: 'https://pubmed.ncbi.nlm.nih.gov/2/',
        },
      ],
    };
    const blocks = findRelatedTool.format?.(result as never) as Array<{ text: string }> | undefined;
    const text = blocks?.[0]?.text ?? '';
    expect(text).toContain('\\[click\\](https://example.test)');
    expect(text).toContain('*A \\*B and C \\*D*');
    expect(result.articles[0]?.title).toBe('[click](https://example.test)');
  });

  it('carries a Europe PMC input rejection through as its own declared reason (#101, #103)', async () => {
    mockELink.mockRejectedValue(
      new McpError(JsonRpcErrorCode.ServiceUnavailable, 'NCBI down', {
        reason: 'ncbi_unreachable',
      }),
    );
    mockEpmcCitations.mockRejectedValue(
      new McpError(JsonRpcErrorCode.ValidationError, 'Europe PMC rejected the citations request', {
        reason: 'europepmc_invalid_input',
      }),
    );
    mockOaCitedBy.mockRejectedValue(
      new McpError(JsonRpcErrorCode.ServiceUnavailable, 'OA down', {
        reason: 'openalex_unreachable',
      }),
    );

    const ctx = createMockContext({ errors: findRelatedTool.errors });
    const input = findRelatedTool.input.parse({ pmid: '12345', relationship: 'cited_by' });
    const error = await rejection(input, ctx);

    const data = failureData(error);
    expect(data.attempted[1]?.reason).toBe('europepmc_invalid_input');
    expect(data.recovery?.hint).toContain('Europe PMC (europepmc_invalid_input)');
  });

  it('labels a provider failure with no declared reason as unclassified (issue #103)', async () => {
    mockELink.mockRejectedValue(new Error('socket hang up'));
    mockOaSimilar.mockRejectedValue(new Error('socket hang up'));

    const ctx = createMockContext({ errors: findRelatedTool.errors });
    const input = findRelatedTool.input.parse({ pmid: '12345', relationship: 'similar' });
    const error = await rejection(input, ctx);

    const data = failureData(error);
    expect(data.attempted).toEqual([
      { provider: 'ncbi', reason: 'unclassified_error', message: 'socket hang up' },
      { provider: 'openalex', reason: 'unclassified_error', message: 'socket hang up' },
    ]);
  });

  it('mirrors the all-providers-failed error onto both client surfaces (issue #103)', async () => {
    mockELink.mockRejectedValue(
      new McpError(JsonRpcErrorCode.ServiceUnavailable, 'NCBI down', {
        reason: 'ncbi_unreachable',
      }),
    );
    mockEpmcCitations.mockRejectedValue(
      new McpError(JsonRpcErrorCode.ServiceUnavailable, 'EPMC down', {
        reason: 'europepmc_unreachable',
      }),
    );
    mockOaCitedBy.mockRejectedValue(
      new McpError(JsonRpcErrorCode.ServiceUnavailable, 'OA down', {
        reason: 'openalex_unreachable',
      }),
    );

    const result = await runToolContract(findRelatedTool, {
      pmid: '12345',
      relationship: 'cited_by',
    });

    expect(result.isError).toBe(true);
    const structuredError = (
      result.structuredContent as { error?: { code?: number; data?: unknown } }
    )?.error;
    expect(structuredError?.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect((structuredError?.data as AllProvidersFailedData | undefined)?.reason).toBe(
      'all_providers_failed',
    );
    const text = textBlocks(result.content as ContentBlock[])
      .map((b) => b.text)
      .join('\n');
    expect(text).toContain('Error:');
    expect(text).toContain('Recovery:');
    expect(text).not.toContain('No related articles found.');
  });

  it('returns bare PMIDs + a notice when a fallback serves but eSummary enrichment fails', async () => {
    // NCBI eLink is down → EPMC serves the PMIDs, but the window-enrichment
    // eSummary (same NCBI host) also fails → degrade to bare PMIDs rather than
    // throwing, so the chain's resilience survives the enrichment step.
    mockELink.mockRejectedValue(new McpError(JsonRpcErrorCode.ServiceUnavailable, 'NCBI down'));
    mockEpmcCitations.mockResolvedValue({
      pmids: ['333', '444'],
      totalCount: 50,
      hitCount: 50,
      droppedNoPmid: 0,
    });
    mockESummary.mockRejectedValue(new McpError(JsonRpcErrorCode.ServiceUnavailable, 'NCBI down'));

    const ctx = createMockContext({ errors: findRelatedTool.errors });
    const input = findRelatedTool.input.parse({ pmid: '12345', relationship: 'cited_by' });
    const result = await findRelatedTool.handler(input, ctx);

    expect(getEnrichment(ctx).source).toBe('europepmc');
    expect(result.articles).toEqual([
      { pmid: '333', pubmedUrl: 'https://pubmed.ncbi.nlm.nih.gov/333/' },
      { pmid: '444', pubmedUrl: 'https://pubmed.ncbi.nlm.nih.gov/444/' },
    ]);
    // Both the provenance notice and the degradation notice survive (consolidated).
    expect(getEnrichment(ctx).notice).toContain('Europe PMC');
    expect(getEnrichment(ctx).notice).toContain('PMIDs only');
  });

  // ── Declared error surface ─────────────────────────────────────────────────

  describe('declared error surface', () => {
    /** A service-layer failure carrying one of the service-contract reasons. */
    const serviceFailure = (reason: string) =>
      new McpError(JsonRpcErrorCode.ServiceUnavailable, `${reason} upstream`, { reason });

    /** The top-level `data.reason` a call surfaces, or `undefined` when it succeeds. */
    async function topLevelReason(
      input: Parameters<typeof runToolContract<typeof findRelatedTool>>[1],
    ): Promise<string | undefined> {
      const result = await runToolContract(findRelatedTool, input);
      if (!result.isError) return;
      const error = (result.structuredContent as { error?: { data?: { reason?: string } } }).error;
      return error?.data?.reason;
    }

    it('absorbs every service-layer reason — none reaches the caller as the top-level reason', async () => {
      // Every provider in the chain fails.
      mockELink.mockRejectedValue(serviceFailure('queue_full'));
      mockEpmcCitations.mockRejectedValue(serviceFailure('europepmc_invalid_response'));
      mockOaCitedBy.mockRejectedValue(serviceFailure('openalex_invalid_response'));
      expect(await topLevelReason({ pmid: '12345', relationship: 'cited_by' })).toBe(
        'all_providers_failed',
      );

      // A fallback answers, then the window-enrichment ESummary fails.
      mockEpmcCitations.mockResolvedValue({
        pmids: ['333'],
        hitCount: 1,
        droppedNoPmid: 0,
      });
      mockESummary.mockRejectedValue(serviceFailure('ncbi_deadline_exceeded'));
      expect(await topLevelReason({ pmid: '12345', relationship: 'cited_by' })).toBeUndefined();

      // NCBI answers empty and the source-PMID ESummary fails.
      mockELink.mockResolvedValue({ eLinkResult: [{ LinkSet: {} }] });
      mockESummary.mockRejectedValue(serviceFailure('ncbi_invalid_response'));
      expect(await topLevelReason({ pmid: '12345', relationship: 'similar' })).toBeUndefined();

      // A confirmed source whose reference-coverage fallbacks both fail.
      mockESummary.mockResolvedValue({ eSummaryResult: {} });
      mockExtractBriefSummaries.mockResolvedValue([{ pmid: '12345', title: 'Source' }]);
      mockEpmcReferences.mockRejectedValue(serviceFailure('europepmc_unreachable'));
      mockOaReferences.mockRejectedValue(serviceFailure('openalex_unreachable'));
      expect(await topLevelReason({ pmid: '12345', relationship: 'references' })).toBeUndefined();
    });

    it('declares only the reason the handler itself throws', () => {
      expect(findRelatedTool.errors?.map((entry) => entry.reason)).toEqual([
        'all_providers_failed',
      ]);
    });
  });

  // ── Europe PMC paging + PMID-addressable disclosure (#101) ─────────────────

  describe('Europe PMC window paging (issue #101)', () => {
    beforeEach(() => {
      mockELink.mockRejectedValue(
        new McpError(JsonRpcErrorCode.ServiceUnavailable, 'NCBI down', {
          reason: 'ncbi_unreachable',
        }),
      );
      mockESummary.mockResolvedValue({ eSummaryResult: {} });
      mockExtractBriefSummaries.mockResolvedValue([]);
    });

    it('derives pageSize from the requested window instead of the old 100-row cap', async () => {
      mockEpmcCitations.mockResolvedValue({
        pmids: Array.from({ length: 130 }, (_, i) => String(1000 + i)),
        totalCount: 130,
        hitCount: 130,
        droppedNoPmid: 0,
      });

      const ctx = createMockContext({ errors: findRelatedTool.errors });
      const input = findRelatedTool.input.parse({
        pmid: '12345',
        relationship: 'cited_by',
        maxResults: 10,
        offset: 120,
      });
      const result = await findRelatedTool.handler(input, ctx);

      expect(mockEpmcCitations).toHaveBeenCalledWith(
        '12345',
        130,
        1,
        expect.any(AbortSignal),
        aDeadline,
      );
      expect(result.articles.map((a) => a.pmid)).toEqual(
        Array.from({ length: 10 }, (_, i) => String(1120 + i)),
      );
    });

    it('caps pageSize at the 1000-row Europe PMC ceiling and advances the page', async () => {
      const page1 = Array.from({ length: 1000 }, (_, i) => String(100000 + i));
      mockEpmcReferences
        .mockResolvedValueOnce({ pmids: page1, hitCount: 4000, totalCount: 4000, droppedNoPmid: 0 })
        .mockResolvedValueOnce({
          pmids: ['9001', '9002', '9003'],
          hitCount: 4000,
          totalCount: 4000,
          droppedNoPmid: 0,
        });

      const ctx = createMockContext({ errors: findRelatedTool.errors });
      const input = findRelatedTool.input.parse({
        pmid: '12345',
        relationship: 'references',
        maxResults: 2,
        offset: 1000,
      });
      const result = await findRelatedTool.handler(input, ctx);

      expect(mockEpmcReferences).toHaveBeenNthCalledWith(
        1,
        '12345',
        1000,
        1,
        expect.any(AbortSignal),
        aDeadline,
      );
      expect(mockEpmcReferences).toHaveBeenNthCalledWith(
        2,
        '12345',
        1000,
        2,
        expect.any(AbortSignal),
        aDeadline,
      );
      // Offsets index PMID-addressable rows across pages, never raw upstream rows.
      expect(result.articles.map((a) => a.pmid)).toEqual(['9001', '9002']);
      // A short final page means upstream is exhausted, so the total is exact.
      expect(result.totalCount).toBe(1003);
    });

    it('pulls further pages when dropped rows leave the window unfilled (issue #101)', async () => {
      // offset 80, maxResults 5 → pageSize 85. Page 1 serves 85 upstream rows,
      // 5 without a PMID, so the filtered array (80 rows) ends before the window.
      const page1 = Array.from({ length: 80 }, (_, i) => String(1000 + i));
      const page2 = Array.from({ length: 84 }, (_, i) => String(2000 + i));
      mockEpmcCitations
        .mockResolvedValueOnce({ pmids: page1, hitCount: 2055, totalCount: 2055, droppedNoPmid: 5 })
        .mockResolvedValueOnce({
          pmids: page2,
          hitCount: 2055,
          totalCount: 2055,
          droppedNoPmid: 1,
        });

      const ctx = createMockContext({ errors: findRelatedTool.errors });
      const input = findRelatedTool.input.parse({
        pmid: '12345',
        relationship: 'cited_by',
        maxResults: 5,
        offset: 80,
      });
      const result = await findRelatedTool.handler(input, ctx);

      expect(mockEpmcCitations).toHaveBeenNthCalledWith(
        1,
        '12345',
        85,
        1,
        expect.any(AbortSignal),
        aDeadline,
      );
      expect(mockEpmcCitations).toHaveBeenNthCalledWith(
        2,
        '12345',
        85,
        2,
        expect.any(AbortSignal),
        aDeadline,
      );
      expect(result.articles.map((a) => a.pmid)).toEqual(['2000', '2001', '2002', '2003', '2004']);
      expect(result.totalCount).toBe(2055);
      const notice = String(getEnrichment(ctx).notice);
      expect(notice).toContain('170 upstream rows');
      expect(notice).toContain('6 with no PubMed PMID');
    });

    it('explains an empty window when the page cap is reached before the offset (issue #101)', async () => {
      // Every page is full but carries no PMID, so ten pages never reach the window.
      mockEpmcCitations.mockResolvedValue({
        pmids: [],
        hitCount: 50000,
        totalCount: 50000,
        droppedNoPmid: 20,
      });

      const result = await runToolContract(findRelatedTool, {
        pmid: '12345',
        relationship: 'cited_by',
        maxResults: 5,
        offset: 15,
      });

      expect(mockEpmcCitations).toHaveBeenCalledTimes(10);
      const structured = result.structuredContent as {
        articles: unknown[];
        notice?: string;
        totalCount?: number;
      };
      expect(structured.articles).toEqual([]);
      expect(structured.totalCount).toBe(50000);
      // A lower offset reads a prefix of the same PMID-less rows, so none is advised.
      const sentence =
        'Europe PMC paging stopped after 10 pages without finding a row that carries a PubMed PMID.';
      expect(structured.notice).toContain(sentence);
      expect(structured.notice).not.toContain('lower the offset');
      const text = textBlocks(result.content as ContentBlock[])
        .map((b) => b.text)
        .join('\n');
      expect(text).toContain(sentence);
    });

    it('advises a lower offset when the page cap stops short of the offset', async () => {
      mockEpmcCitations
        .mockResolvedValueOnce({
          pmids: ['101', '102', '103'],
          hitCount: 50000,
          totalCount: 50000,
          droppedNoPmid: 17,
        })
        .mockResolvedValue({ pmids: [], hitCount: 50000, totalCount: 50000, droppedNoPmid: 20 });

      const result = await runToolContract(findRelatedTool, {
        pmid: '12345',
        relationship: 'cited_by',
        maxResults: 5,
        offset: 15,
      });

      expect(mockEpmcCitations).toHaveBeenCalledTimes(10);
      const structured = result.structuredContent as { articles: unknown[]; notice?: string };
      expect(structured.articles).toEqual([]);
      expect(structured.notice).toContain(
        'Europe PMC paging stopped after 10 pages, having found 3 PubMed-addressable rows, without reaching offset 15; lower the offset.',
      );
    });

    it('states the rows a page holds when the page cap stops inside the window', async () => {
      mockEpmcCitations
        .mockResolvedValueOnce({
          pmids: ['101', '102'],
          hitCount: 50000,
          totalCount: 50000,
          droppedNoPmid: 3,
        })
        .mockResolvedValue({ pmids: [], hitCount: 50000, totalCount: 50000, droppedNoPmid: 5 });

      const result = await runToolContract(findRelatedTool, {
        pmid: '12345',
        relationship: 'cited_by',
        maxResults: 5,
        offset: 0,
      });

      expect(mockEpmcCitations).toHaveBeenCalledTimes(10);
      const structured = result.structuredContent as {
        articles: Array<{ pmid: string }>;
        notice?: string;
      };
      expect(structured.articles.map((a) => a.pmid)).toEqual(['101', '102']);
      expect(structured.notice).toContain(
        'Europe PMC paging stopped after 10 pages, having found 2 PubMed-addressable rows, so this page holds rows 0–1 of the 0–4 requested.',
      );
      expect(structured.notice).not.toContain('offset 0');
    });

    it('discloses how many upstream rows in the fetched page had no PubMed PMID', async () => {
      mockEpmcCitations.mockResolvedValue({
        pmids: ['333', '444'],
        totalCount: 2,
        hitCount: 2,
        droppedNoPmid: 6,
      });
      mockExtractBriefSummaries.mockResolvedValue([
        { pmid: '333', title: 'Citing A' },
        { pmid: '444', title: 'Citing B' },
      ]);

      const ctx = createMockContext({ errors: findRelatedTool.errors });
      const input = findRelatedTool.input.parse({ pmid: '12345', relationship: 'cited_by' });
      const result = await findRelatedTool.handler(input, ctx);

      expect(getEnrichment(ctx).notice).toContain(
        'Europe PMC served 8 upstream rows for this request, 6 with no PubMed PMID',
      );
      expect(result.totalCount).toBe(2);
    });

    it('never returns an empty window on a served page without an explanatory notice', async () => {
      // Issue repro: 10 upstream rows, 1 without a PMID → 9 addressable; the
      // caller pages to offset 9 expecting the 10th item.
      mockEpmcReferences.mockResolvedValue({
        pmids: Array.from({ length: 9 }, (_, i) => String(200 + i)),
        totalCount: 9,
        hitCount: 9,
        droppedNoPmid: 1,
      });

      const ctx = createMockContext({ errors: findRelatedTool.errors });
      const input = findRelatedTool.input.parse({
        pmid: '40991282',
        relationship: 'references',
        maxResults: 10,
        offset: 9,
      });
      const result = await findRelatedTool.handler(input, ctx);

      expect(result.articles).toEqual([]);
      const notice = String(getEnrichment(ctx).notice);
      expect(notice).toContain('no PubMed PMID');
      expect(notice).toContain('Offset 9 exceeds totalCount (9)');
    });

    it('carries the excluded-row notice onto both client surfaces', async () => {
      mockEpmcCitations.mockResolvedValue({
        pmids: ['333'],
        totalCount: 1,
        hitCount: 1,
        droppedNoPmid: 2,
      });
      mockExtractBriefSummaries.mockResolvedValue([{ pmid: '333', title: 'Citing A' }]);

      const result = await runToolContract(findRelatedTool, {
        pmid: '12345',
        relationship: 'cited_by',
      });

      const structured = result.structuredContent as { notice?: string; totalCount?: number };
      expect(structured.notice).toContain('no PubMed PMID');
      expect(structured.totalCount).toBe(1);
      const text = textBlocks(result.content as ContentBlock[])
        .map((b) => b.text)
        .join('\n');
      expect(text).toContain('no PubMed PMID');
      expect(text).toContain('PMID 333');
    });
  });

  // ── OpenAlex window paging disclosure (#117) ───────────────────────────────

  describe('OpenAlex window paging disclosure (issue #117)', () => {
    beforeEach(() => {
      mockELink.mockRejectedValue(
        new McpError(JsonRpcErrorCode.ServiceUnavailable, 'NCBI down', {
          reason: 'ncbi_unreachable',
        }),
      );
      mockESummary.mockResolvedValue({ eSummaryResult: {} });
      mockExtractBriefSummaries.mockResolvedValue([]);
    });

    it('names OpenAlex when its rows were excluded for carrying no PubMed PMID', async () => {
      mockOaCitedBy.mockResolvedValue({
        pmids: ['333', '444'],
        totalCount: 2,
        droppedNoPmid: 6,
        reachCapped: false,
      });

      const result = await runToolContract(findRelatedTool, {
        pmid: '12345',
        relationship: 'cited_by',
      });

      const structured = result.structuredContent as { notice?: string };
      expect(structured.notice).toContain('OpenAlex served 8 upstream rows for this request');
      expect(structured.notice).toContain('6 with no PubMed PMID');
      // Europe PMC's own exclusion wording must not be pinned on OpenAlex.
      expect(structured.notice).not.toContain('non-MED');
      const text = textBlocks(result.content as ContentBlock[])
        .map((b) => b.text)
        .join('\n');
      expect(text).toContain('no PubMed PMID');
    });

    it('explains an empty OpenAlex window when the page cap is reached', async () => {
      mockOaCitedBy.mockResolvedValue({
        pmids: [],
        totalCount: 17394,
        droppedNoPmid: 1000,
        reachCapped: true,
      });

      const result = await runToolContract(findRelatedTool, {
        pmid: '22745249',
        relationship: 'cited_by',
        maxResults: 3,
        offset: 200,
      });

      const structured = result.structuredContent as {
        articles: unknown[];
        notice?: string;
        totalCount?: number;
      };
      expect(structured.articles).toEqual([]);
      expect(structured.totalCount).toBe(17394);
      expect(structured.notice).toContain(
        'OpenAlex paging stopped after 10 pages without finding a row that carries a PubMed PMID.',
      );
      expect(structured.notice).not.toContain('lower the offset');
      const text = textBlocks(result.content as ContentBlock[])
        .map((b) => b.text)
        .join('\n');
      expect(text).toContain('OpenAlex paging stopped after 10 pages');
    });

    it('serves a deep window OpenAlex reached, non-overlapping with the first page', async () => {
      const pmids = Array.from({ length: 291 }, (_, i) => String(9000 + i));
      mockOaCitedBy.mockResolvedValue({
        pmids,
        totalCount: 17394,
        droppedNoPmid: 9,
        reachCapped: false,
      });

      const deep = createMockContext({ errors: findRelatedTool.errors });
      const deepResult = await findRelatedTool.handler(
        findRelatedTool.input.parse({
          pmid: '22745249',
          relationship: 'cited_by',
          maxResults: 3,
          offset: 200,
        }),
        deep,
      );
      const firstPage = createMockContext({ errors: findRelatedTool.errors });
      const firstResult = await findRelatedTool.handler(
        findRelatedTool.input.parse({
          pmid: '22745249',
          relationship: 'cited_by',
          maxResults: 50,
          offset: 0,
        }),
        firstPage,
      );

      expect(deepResult.articles.map((a) => a.pmid)).toEqual(['9200', '9201', '9202']);
      const covered = new Set(firstResult.articles.map((a) => a.pmid));
      for (const a of deepResult.articles) expect(covered.has(a.pmid)).toBe(false);
    });

    it('reports the exact addressable total OpenAlex resolved for references', async () => {
      mockELink.mockResolvedValue(eLinkResponse([], 'pubmed_pubmed_refs'));
      mockESummary.mockResolvedValue({ eSummaryResult: {} });
      mockExtractBriefSummaries
        .mockResolvedValueOnce([{ pmid: '37952131', title: 'Non-PMC source' }])
        .mockResolvedValueOnce([]);
      mockEpmcReferences.mockResolvedValue({
        pmids: [],
        totalCount: 0,
        hitCount: 0,
        droppedNoPmid: 0,
      });
      mockOaReferences.mockResolvedValue({
        pmids: Array.from({ length: 150 }, (_, i) => String(4000 + i)),
        totalCount: 150,
        droppedNoPmid: 12,
        reachCapped: false,
      });

      const ctx = createMockContext({ errors: findRelatedTool.errors });
      const input = findRelatedTool.input.parse({
        pmid: '37952131',
        relationship: 'references',
        maxResults: 5,
        offset: 140,
      });
      const result = await findRelatedTool.handler(input, ctx);

      expect(mockOaReferences).toHaveBeenCalledWith(
        '37952131',
        145,
        expect.any(AbortSignal),
        aDeadline,
      );
      expect(result.articles.map((a) => a.pmid)).toEqual(['4140', '4141', '4142', '4143', '4144']);
      expect(result.totalCount).toBe(150);
      expect(String(getEnrichment(ctx).notice)).toContain('12 with no PubMed PMID');
    });
  });

  // ── Reference-coverage provider failures (#118) ────────────────────────────

  describe('reference coverage failures (issue #118)', () => {
    beforeEach(() => {
      // NCBI answers successfully with an empty reference list for a valid,
      // confirmed, non-PMC source — the only way into this branch.
      mockELink.mockResolvedValue({ eLinkResult: [{ LinkSet: {} }] });
      mockESummary.mockResolvedValue({ eSummaryResult: {} });
      mockExtractBriefSummaries.mockResolvedValue([{ pmid: '39248309', title: 'Non-PMC source' }]);
    });

    const referencesInput = { pmid: '39248309', relationship: 'references' as const };

    it('discloses that coverage could not be checked when both fallbacks throw', async () => {
      mockEpmcReferences.mockRejectedValue(
        new McpError(JsonRpcErrorCode.ServiceUnavailable, 'EPMC down', {
          reason: 'europepmc_unreachable',
        }),
      );
      mockOaReferences.mockRejectedValue(
        new McpError(JsonRpcErrorCode.ServiceUnavailable, 'OA down', {
          reason: 'openalex_unreachable',
        }),
      );

      const result = await runToolContract(findRelatedTool, { ...referencesInput, maxResults: 3 });

      const structured = result.structuredContent as {
        articles: unknown[];
        coverageFailures?: Array<{ provider: string; reason: string; retryable: boolean }>;
        notice?: string;
        source?: string;
        totalCount?: number;
      };
      // NCBI answered, so the success shape is preserved exactly.
      expect(structured.articles).toEqual([]);
      expect(structured.source).toBe('ncbi');
      expect(structured.totalCount).toBe(0);
      expect(structured.coverageFailures).toEqual([
        { provider: 'europepmc', reason: 'europepmc_unreachable', retryable: true },
        { provider: 'openalex', reason: 'openalex_unreachable', retryable: true },
      ]);
      // Neither failed provider is described as having answered.
      expect(structured.notice).toContain('via NCBI.');
      expect(structured.notice).not.toContain('via NCBI, Europe PMC, or OpenAlex');
      expect(structured.notice).toContain('Reference coverage could not be fully checked');
      expect(structured.notice).toContain('Europe PMC (europepmc_unreachable)');
      expect(structured.notice).toContain('OpenAlex (openalex_unreachable)');
      expect(structured.notice).toContain('Retry after a brief delay');
      const text = textBlocks(result.content as ContentBlock[])
        .map((b) => b.text)
        .join('\n');
      expect(text).toContain('Reference coverage could not be fully checked');
      expect(text).toContain('Coverage not checked:');
      expect(text).toContain('OpenAlex (openalex_unreachable)');
    });

    it('separates the provider that answered empty from the one that failed', async () => {
      mockEpmcReferences.mockResolvedValue({
        pmids: [],
        totalCount: 0,
        hitCount: 0,
        droppedNoPmid: 0,
      });
      mockOaReferences.mockRejectedValue(
        new McpError(JsonRpcErrorCode.ServiceUnavailable, 'OA garbage', {
          reason: 'openalex_invalid_response',
        }),
      );

      const ctx = createMockContext({ errors: findRelatedTool.errors });
      await findRelatedTool.handler(findRelatedTool.input.parse(referencesInput), ctx);

      const enrichment = getEnrichment(ctx);
      expect(enrichment.coverageFailures).toEqual([
        { provider: 'openalex', reason: 'openalex_invalid_response', retryable: true },
      ]);
      const notice = String(enrichment.notice);
      expect(notice).toContain('via NCBI or Europe PMC.');
      expect(notice).toContain('OpenAlex (openalex_invalid_response) did not answer');
    });

    it('marks a configuration-disabled fallback as unrecoverable', async () => {
      // EUROPEPMC_ENABLED=false — the accessor returns undefined.
      mockGetEpmcService.mockReturnValue(undefined);
      mockOaReferences.mockResolvedValue({
        pmids: [],
        totalCount: 0,
        droppedNoPmid: 0,
        reachCapped: false,
      });

      const ctx = createMockContext({ errors: findRelatedTool.errors });
      await findRelatedTool.handler(findRelatedTool.input.parse(referencesInput), ctx);

      const enrichment = getEnrichment(ctx);
      expect(enrichment.coverageFailures).toEqual([
        { provider: 'europepmc', reason: 'provider_disabled', retryable: false },
      ]);
      const notice = String(enrichment.notice);
      expect(notice).toContain('via NCBI or OpenAlex.');
      expect(notice).toContain('turned off by server configuration');
      expect(notice).toContain('will not recover on retry');
      // Nothing to retry, so no retry guidance is offered.
      expect(notice).not.toContain('Retry after a brief delay');
    });

    it('keeps a failure on record when the other fallback serves references', async () => {
      mockExtractBriefSummaries
        .mockReset()
        .mockResolvedValueOnce([{ pmid: '39248309', title: 'Non-PMC source' }])
        .mockResolvedValueOnce([{ pmid: '888', title: 'Ref A' }]);
      mockEpmcReferences.mockRejectedValue(
        new McpError(JsonRpcErrorCode.ServiceUnavailable, 'EPMC down', {
          reason: 'europepmc_unreachable',
        }),
      );
      mockOaReferences.mockResolvedValue({
        pmids: ['888'],
        totalCount: 1,
        droppedNoPmid: 0,
        reachCapped: false,
      });

      const ctx = createMockContext({ errors: findRelatedTool.errors });
      const result = await findRelatedTool.handler(
        findRelatedTool.input.parse(referencesInput),
        ctx,
      );

      expect(result.articles.map((a) => a.pmid)).toEqual(['888']);
      expect(getEnrichment(ctx).source).toBe('openalex');
      expect(getEnrichment(ctx).coverageFailures).toEqual([
        { provider: 'europepmc', reason: 'europepmc_unreachable', retryable: true },
      ]);
      // References were found, so nothing claims the check came up short.
      expect(String(getEnrichment(ctx).notice)).not.toContain('could not be fully checked');
    });

    it('reports an unclassified fallback failure without leaking its message', async () => {
      mockEpmcReferences.mockRejectedValue(
        new Error('connect ECONNREFUSED https://www.ebi.ac.uk/europepmc/webservices/rest?key=abc'),
      );
      mockOaReferences.mockRejectedValue(new Error('socket hang up'));

      const result = await runToolContract(findRelatedTool, referencesInput);

      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain('ECONNREFUSED');
      expect(serialized).not.toContain('ebi.ac.uk');
      expect(serialized).not.toContain('socket hang up');
      const structured = result.structuredContent as {
        coverageFailures?: Array<{ reason: string; retryable: boolean }>;
      };
      expect(structured.coverageFailures).toEqual([
        { provider: 'europepmc', reason: 'unclassified_error', retryable: true },
        { provider: 'openalex', reason: 'unclassified_error', retryable: true },
      ]);
    });

    /**
     * Runs the real OpenAlex service behind a stubbed global fetch, so the reason
     * reaching the coverage summary is the one its retry loop stamps on exhaustion.
     * (#160)
     */
    it.each([
      ['429', 'rate_limited', { status: 429, headers: { 'retry-after': '5' } }],
      ['504', 'timed_out', { status: 504 }],
    ])(
      'labels an exhausted OpenAlex %s as %s, still retryable (#160)',
      async (_status, reason, init) => {
        const { OpenAlexService } = await vi.importActual<
          typeof import('@/services/openalex/openalex-service.js')
        >('@/services/openalex/openalex-service.js');
        const { OpenAlexApiClient } = await import('@/services/openalex/api-client.js');
        mockGetOaService.mockReturnValue(
          new OpenAlexService(new OpenAlexApiClient({ timeoutMs: 20_000 }), 0, 45_000),
        );
        mockEpmcReferences.mockResolvedValue({
          pmids: [],
          totalCount: 0,
          hitCount: 0,
          droppedNoPmid: 0,
        });
        const fetchSpy = vi
          .spyOn(globalThis, 'fetch')
          .mockImplementation(() => Promise.resolve(new Response('', init)));

        try {
          const result = await runToolContract(findRelatedTool, referencesInput);

          const structured = result.structuredContent as {
            coverageFailures?: Array<{ provider: string; reason: string; retryable: boolean }>;
            notice?: string;
          };
          expect(structured.coverageFailures).toEqual([
            { provider: 'openalex', reason, retryable: true },
          ]);
          expect(structured.notice).toContain(`OpenAlex (${reason}) did not answer`);
          expect(structured.notice).toContain('Retry after a brief delay');
          const text = textBlocks(result.content as ContentBlock[])
            .map((b) => b.text)
            .join('\n');
          expect(text).toContain(`OpenAlex (${reason})`);
          expect(text).not.toContain('openalex_unreachable');
          expect(text).not.toContain('unclassified_error');
          expect(fetchSpy).toHaveBeenCalledTimes(1);
        } finally {
          fetchSpy.mockRestore();
        }
      },
    );

    /** The real Europe PMC service and its pacer, with no retries, behind the stubbed fetch. */
    async function useRealEuropePmcService() {
      const { EuropePmcService } = await vi.importActual<
        typeof import('@/services/europe-pmc/europe-pmc-service.js')
      >('@/services/europe-pmc/europe-pmc-service.js');
      const { EuropePmcApiClient } = await import('@/services/europe-pmc/api-client.js');
      const { createEuropePmcRequestQueue } = await import(
        '@/services/europe-pmc/request-queue.js'
      );
      mockGetEpmcService.mockReturnValue(
        new EuropePmcService(
          new EuropePmcApiClient({ timeoutMs: 20_000 }),
          createEuropePmcRequestQueue(0),
          0,
          45_000,
        ),
      );
    }

    /**
     * Europe PMC's own declared reasons, through its real service and pacer: an
     * exhausted Timeout is `europepmc_timed_out`, and a 429 — retries spent, or
     * never retried because its Retry-After outlasts the backoff cap — is
     * `europepmc_rate_limited`. Both are declared retryable. (#315)
     */
    const EPMC_FAILURES = [
      ['exhausted 504', 'europepmc_timed_out', { status: 504 }],
      ['exhausted 429', 'europepmc_rate_limited', { status: 429, headers: { 'retry-after': '5' } }],
      [
        '429 with a Retry-After past the backoff cap',
        'europepmc_rate_limited',
        { status: 429, headers: { 'retry-after': '120' } },
      ],
    ] as const;

    it.each(EPMC_FAILURES)(
      'labels a Europe PMC %s as %s, still retryable',
      async (_label, reason, init) => {
        await useRealEuropePmcService();
        mockOaReferences.mockResolvedValue({
          pmids: [],
          totalCount: 0,
          droppedNoPmid: 0,
          reachCapped: false,
        });
        const fetchSpy = vi
          .spyOn(globalThis, 'fetch')
          .mockImplementation(() => Promise.resolve(new Response('', init)));

        try {
          const result = await runToolContract(findRelatedTool, referencesInput);

          const structured = result.structuredContent as {
            coverageFailures?: Array<{ provider: string; reason: string; retryable: boolean }>;
            notice?: string;
          };
          expect(structured.coverageFailures).toEqual([
            { provider: 'europepmc', reason, retryable: true },
          ]);
          expect(structured.notice).toContain(`Europe PMC (${reason}) did not answer`);
          expect(structured.notice).toContain('Retry after a brief delay');
          const text = textBlocks(result.content as ContentBlock[])
            .map((b) => b.text)
            .join('\n');
          expect(text).toContain(`Europe PMC (${reason}) did not answer`);
          expect(fetchSpy).toHaveBeenCalledTimes(1);
        } finally {
          fetchSpy.mockRestore();
        }
      },
    );

    it.each(EPMC_FAILURES)(
      'names a Europe PMC %s as %s in attempted[] when every provider fails',
      async (_label, reason, init) => {
        await useRealEuropePmcService();
        // What an exhausted NCBI HTTP 504 reaches the chain as.
        mockELink.mockRejectedValue(
          new McpError(JsonRpcErrorCode.Timeout, 'NCBI timed out', { reason: 'ncbi_timed_out' }),
        );
        mockOaCitedBy.mockRejectedValue(new McpError(JsonRpcErrorCode.Timeout, 'OA timed out'));
        const fetchSpy = vi
          .spyOn(globalThis, 'fetch')
          .mockImplementation(() => Promise.resolve(new Response('', init)));

        try {
          const ctx = createMockContext({ errors: findRelatedTool.errors });
          const input = findRelatedTool.input.parse({ pmid: '12345', relationship: 'cited_by' });
          const error = await rejection(input, ctx);

          expect(failureData(error).attempted).toEqual([
            { provider: 'ncbi', reason: 'ncbi_timed_out', message: 'NCBI timed out' },
            { provider: 'europepmc', reason, message: expect.stringContaining('Status: ') },
            // A reason-less Timeout is named by its code.
            { provider: 'openalex', reason: 'timed_out', message: 'OA timed out' },
          ]);
          expect(failureData(error).recovery?.hint).toContain(
            `NCBI (ncbi_timed_out), Europe PMC (${reason}), OpenAlex (timed_out)`,
          );
          expect(fetchSpy).toHaveBeenCalledTimes(1);
        } finally {
          fetchSpy.mockRestore();
        }
      },
    );

    it('reports a fallback failure the upstream marked not retryable as not retryable', async () => {
      mockEpmcReferences.mockResolvedValue({
        pmids: [],
        totalCount: 0,
        hitCount: 0,
        droppedNoPmid: 0,
      });
      mockOaReferences.mockRejectedValue(
        new McpError(JsonRpcErrorCode.ServiceUnavailable, 'Fetch failed. Status: 501', {
          status: 501,
          retryable: false,
        }),
      );

      const ctx = createMockContext({ errors: findRelatedTool.errors });
      await findRelatedTool.handler(findRelatedTool.input.parse(referencesInput), ctx);

      const enrichment = getEnrichment(ctx);
      expect(enrichment.coverageFailures).toEqual([
        { provider: 'openalex', reason: 'unclassified_error', retryable: false },
      ]);
      expect(String(enrichment.notice)).not.toContain('Retry after a brief delay');
    });

    describe('whether a retry can reach each failed fallback (issue #318)', () => {
      const epmcUnreachable = new McpError(JsonRpcErrorCode.ServiceUnavailable, 'EPMC down', {
        reason: 'europepmc_unreachable',
      });
      const epmcInvalidInput = new McpError(JsonRpcErrorCode.ValidationError, 'EPMC refused', {
        reason: 'europepmc_invalid_input',
      });
      const oaUnreachable = new McpError(JsonRpcErrorCode.ServiceUnavailable, 'OA down', {
        reason: 'openalex_unreachable',
      });
      // What the OpenAlex client rethrows for an HTTP 501: no reason, not retryable.
      const oaNotImplemented = new McpError(
        JsonRpcErrorCode.ServiceUnavailable,
        'Fetch failed. Status: 501',
        { status: 501, retryable: false },
      );

      /**
       * Both fallbacks fail as given (`undefined` turns Europe PMC off by
       * configuration): the `coverageFailures` they leave, the trailer line, and the
       * coverage sentence that ends the notice.
       */
      const SETS = [
        [
          'every failed fallback is retryable',
          epmcUnreachable,
          oaUnreachable,
          [
            { provider: 'europepmc', reason: 'europepmc_unreachable', retryable: true },
            { provider: 'openalex', reason: 'openalex_unreachable', retryable: true },
          ],
          '**Coverage not checked:** Europe PMC (europepmc_unreachable, retryable), OpenAlex (openalex_unreachable, retryable)',
          'Europe PMC (europepmc_unreachable), OpenAlex (openalex_unreachable) did not answer. Retry after a brief delay to complete the coverage check.',
        ],
        [
          'no failed fallback is retryable',
          epmcInvalidInput,
          oaNotImplemented,
          [
            { provider: 'europepmc', reason: 'europepmc_invalid_input', retryable: false },
            { provider: 'openalex', reason: 'unclassified_error', retryable: false },
          ],
          '**Coverage not checked:** Europe PMC (europepmc_invalid_input, not retryable), OpenAlex (unclassified_error, not retryable)',
          'Europe PMC (europepmc_invalid_input), OpenAlex (unclassified_error) did not answer.',
        ],
        [
          'only Europe PMC is retryable',
          epmcUnreachable,
          oaNotImplemented,
          [
            { provider: 'europepmc', reason: 'europepmc_unreachable', retryable: true },
            { provider: 'openalex', reason: 'unclassified_error', retryable: false },
          ],
          '**Coverage not checked:** Europe PMC (europepmc_unreachable, retryable), OpenAlex (unclassified_error, not retryable)',
          'Europe PMC (europepmc_unreachable), OpenAlex (unclassified_error) did not answer. Retry after a brief delay to check Europe PMC.',
        ],
        [
          'only OpenAlex is retryable, Europe PMC turned off',
          undefined,
          oaUnreachable,
          [
            { provider: 'europepmc', reason: 'provider_disabled', retryable: false },
            { provider: 'openalex', reason: 'openalex_unreachable', retryable: true },
          ],
          '**Coverage not checked:** Europe PMC (provider_disabled, not retryable), OpenAlex (openalex_unreachable, retryable)',
          'Europe PMC (provider_disabled), OpenAlex (openalex_unreachable) did not answer. Retry after a brief delay to check OpenAlex. Europe PMC is turned off by server configuration and will not recover on retry.',
        ],
      ] as const;

      async function checkCoverage(epmcFailure: McpError | undefined, oaFailure: McpError) {
        if (epmcFailure) mockEpmcReferences.mockRejectedValue(epmcFailure);
        else mockGetEpmcService.mockReturnValue(undefined);
        mockOaReferences.mockRejectedValue(oaFailure);
        const result = await runToolContract(findRelatedTool, referencesInput);
        const structured = result.structuredContent as {
          coverageFailures?: unknown[];
          notice?: string;
        };
        const notice = structured.notice ?? '';
        return {
          coverage: notice.slice(notice.indexOf('Reference coverage could not be fully checked')),
          coverageFailures: structured.coverageFailures,
          text: textBlocks(result.content as ContentBlock[])
            .map((b) => b.text)
            .join('\n'),
        };
      }

      it.each(SETS)(
        'marks every trailer entry retryable or not when %s',
        async (_label, epmc, oa, coverageFailures, trailer) => {
          const result = await checkCoverage(epmc, oa);

          expect(result.coverageFailures).toEqual(coverageFailures);
          expect(result.text.split('\n')).toContain(trailer);
        },
      );

      it.each(SETS)(
        'retries in the notice only what a retry can reach when %s',
        async (_label, epmc, oa, _coverageFailures, _trailer, outcomes) => {
          const result = await checkCoverage(epmc, oa);

          const sentence = `Reference coverage could not be fully checked — ${outcomes}`;
          expect(result.coverage).toBe(sentence);
          expect(result.text).toContain(sentence);
        },
      );
    });

    it('names an all-providers-failed attempt by its code when it carries no reason', async () => {
      mockELink.mockRejectedValue(
        new McpError(JsonRpcErrorCode.RateLimited, 'NCBI 429', { retryAfter: '2' }),
      );
      mockOaSimilar.mockRejectedValue(new McpError(JsonRpcErrorCode.Timeout, 'OA timed out'));

      const ctx = createMockContext({ errors: findRelatedTool.errors });
      const input = findRelatedTool.input.parse({ pmid: '12345', relationship: 'similar' });
      const error = await rejection(input, ctx);

      expect(failureData(error).attempted).toEqual([
        { provider: 'ncbi', reason: 'rate_limited', message: 'NCBI 429' },
        { provider: 'openalex', reason: 'timed_out', message: 'OA timed out' },
      ]);
      expect(failureData(error).recovery?.hint).toContain(
        'NCBI (rate_limited), OpenAlex (timed_out)',
      );
    });
  });

  // ── Existing behavior preserved ───────────────────────────────────────────

  it('returns empty without notice for valid source with no related articles', async () => {
    mockELink.mockResolvedValue({ eLinkResult: [{ LinkSet: {} }] });
    mockESummary.mockResolvedValue({ eSummaryResult: {} });
    mockExtractBriefSummaries.mockResolvedValue([
      { pmid: '12345', title: 'Existing article with no related items' },
    ]);

    const ctx = createMockContext({ errors: findRelatedTool.errors });
    const input = findRelatedTool.input.parse({ pmid: '12345' });
    const result = await findRelatedTool.handler(input, ctx);

    expect(result.articles).toEqual([]);
    expect(result.totalCount).toBe(0);
    expect(getEnrichment(ctx).notice).toBeUndefined();
  });

  describe('ELink <ERROR> payload', () => {
    it('disambiguates an invalid source PMID via ESummary and emits a not-found notice', async () => {
      mockELink.mockResolvedValue({ eLinkResult: [{ ERROR: 'Invalid PMID' }] });
      mockESummary.mockResolvedValue({ eSummaryResult: {} });
      mockExtractBriefSummaries.mockResolvedValue([]);

      const ctx = createMockContext({ errors: findRelatedTool.errors });
      const input = findRelatedTool.input.parse({ pmid: '99999999999' });
      const result = await findRelatedTool.handler(input, ctx);

      expect(result.totalCount).toBe(0);
      expect(result.articles).toEqual([]);
      expect(getEnrichment(ctx).notice).toContain('99999999999');
      expect(getEnrichment(ctx).notice).toContain('not found in PubMed');
    });

    it('returns empty without notice when ELink ERROR fires for a valid PMID with no related items', async () => {
      mockELink.mockResolvedValue({ eLinkResult: [{ ERROR: 'Empty result - nothing to do' }] });
      mockESummary.mockResolvedValue({ eSummaryResult: {} });
      mockExtractBriefSummaries.mockResolvedValue([
        { pmid: '12345', title: 'Valid source with no related items' },
      ]);

      const ctx = createMockContext({ errors: findRelatedTool.errors });
      const input = findRelatedTool.input.parse({ pmid: '12345' });
      const result = await findRelatedTool.handler(input, ctx);

      expect(result.totalCount).toBe(0);
      expect(getEnrichment(ctx).notice).toBeUndefined();
    });
  });

  it('uses neighbor + pubmed_pubmed linkname for similar and enriches results', async () => {
    mockELink.mockResolvedValue({
      eLinkResult: [
        {
          LinkSet: {
            LinkSetDb: {
              LinkName: 'pubmed_pubmed',
              Link: [
                { Id: '12345' }, // source PMID — filtered out
                { Id: '0' }, // sentinel — filtered out
                { Id: '222' },
                { Id: { '#text': '111' } }, // exercise the {'#text': ...} Id shape
              ],
            },
          },
        },
      ],
    });
    mockESummary.mockResolvedValue({ eSummaryResult: {} });
    mockExtractBriefSummaries.mockResolvedValue([
      {
        pmid: '222',
        title: 'First Related Article',
        authors: 'Jones A',
        source: 'Science',
        pubDate: '2023',
      },
      {
        pmid: '111',
        title: 'Second Related Article',
        authors: 'Smith J',
        source: 'Nature',
        pubDate: '2024',
      },
    ]);

    const ctx = createMockContext({ errors: findRelatedTool.errors });
    const input = findRelatedTool.input.parse({ pmid: '12345', maxResults: 2 });
    const result = await findRelatedTool.handler(input, ctx);

    expect(mockELink).toHaveBeenCalledWith(
      {
        dbfrom: 'pubmed',
        db: 'pubmed',
        id: '12345',
        cmd: 'neighbor',
        linkname: 'pubmed_pubmed',
        retmode: 'xml',
      },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(mockESummary).toHaveBeenCalledWith(
      { db: 'pubmed', version: '2.0', retmode: 'xml', id: '222,111' },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(result.totalCount).toBe(2);
    expect(result.articles).toEqual([
      {
        pmid: '222',
        title: 'First Related Article',
        authors: 'Jones A',
        source: 'Science',
        pubDate: '2023',
        pubmedUrl: 'https://pubmed.ncbi.nlm.nih.gov/222/',
      },
      {
        pmid: '111',
        title: 'Second Related Article',
        authors: 'Smith J',
        source: 'Nature',
        pubDate: '2024',
        pubmedUrl: 'https://pubmed.ncbi.nlm.nih.gov/111/',
      },
    ]);
  });

  it('uses cited_by linkname', async () => {
    mockELink.mockResolvedValue({
      eLinkResult: [
        {
          LinkSet: {
            LinkSetDb: { LinkName: 'pubmed_pubmed_citedin', Link: { Id: '222' } },
          },
        },
      ],
    });
    mockESummary.mockResolvedValue({ eSummaryResult: {} });
    mockExtractBriefSummaries.mockResolvedValue([
      { pmid: '222', title: 'Citing Article', authors: 'Taylor R' },
    ]);

    const ctx = createMockContext({ errors: findRelatedTool.errors });
    const input = findRelatedTool.input.parse({ pmid: '12345', relationship: 'cited_by' });
    const result = await findRelatedTool.handler(input, ctx);

    expect(mockELink).toHaveBeenCalledWith(
      {
        dbfrom: 'pubmed',
        db: 'pubmed',
        id: '12345',
        retmode: 'xml',
        cmd: 'neighbor',
        linkname: 'pubmed_pubmed_citedin',
      },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(result.articles[0]).toEqual({
      pmid: '222',
      title: 'Citing Article',
      authors: 'Taylor R',
      source: undefined,
      pubDate: undefined,
      pubmedUrl: 'https://pubmed.ncbi.nlm.nih.gov/222/',
    });
  });

  it('uses the references linkname for reference lookups', async () => {
    mockELink.mockResolvedValue({ eLinkResult: [{ LinkSet: {} }] });
    mockESummary.mockResolvedValue({ eSummaryResult: {} });
    mockExtractBriefSummaries.mockResolvedValue([
      { pmid: '12345', title: 'Source', pmcId: 'PMC9999' },
    ]);
    // Valid source, empty NCBI refs → the references fallback runs; keep both empty.
    mockEpmcReferences.mockResolvedValue({
      pmids: [],
      totalCount: 0,
      hitCount: 0,
      droppedNoPmid: 0,
    });
    mockOaReferences.mockResolvedValue({ pmids: [], totalCount: 0 });

    const ctx = createMockContext({ errors: findRelatedTool.errors });
    const input = findRelatedTool.input.parse({ pmid: '12345', relationship: 'references' });
    const result = await findRelatedTool.handler(input, ctx);

    expect(mockELink).toHaveBeenCalledWith(
      {
        dbfrom: 'pubmed',
        db: 'pubmed',
        id: '12345',
        retmode: 'xml',
        cmd: 'neighbor',
        linkname: 'pubmed_pubmed_refs',
      },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(result.totalCount).toBe(0);
  });

  describe('references coverage for non-PMC sources (issues #42, #63)', () => {
    it('serves references from EPMC when NCBI has none (non-PMC source, #63 coverage)', async () => {
      mockELink.mockResolvedValue({ eLinkResult: [{ LinkSet: {} }] });
      mockESummary.mockResolvedValue({ eSummaryResult: {} });
      // 1st extract = source disambiguation; 2nd = window enrichment.
      mockExtractBriefSummaries
        .mockResolvedValueOnce([{ pmid: '37952131', title: 'Non-PMC source' }])
        .mockResolvedValueOnce([
          { pmid: '888', title: 'Ref A' },
          { pmid: '999', title: 'Ref B' },
        ]);
      mockEpmcReferences.mockResolvedValue({
        pmids: ['888', '999'],
        totalCount: 149,
        hitCount: 149,
        droppedNoPmid: 0,
      });

      const ctx = createMockContext({ errors: findRelatedTool.errors });
      const input = findRelatedTool.input.parse({ pmid: '37952131', relationship: 'references' });
      const result = await findRelatedTool.handler(input, ctx);

      expect(getEnrichment(ctx).source).toBe('europepmc');
      expect(result.totalCount).toBe(2); // a page shorter than requested exhausts upstream, so the total is exact
      expect(getEnrichment(ctx).notice).toContain('Europe PMC');
      expect(result.articles.map((a) => a.pmid)).toEqual(['888', '999']);
      // EPMC served first — OpenAlex is not consulted.
      expect(mockOaReferences).not.toHaveBeenCalled();
    });

    it('serves references from OpenAlex when NCBI and EPMC both have none', async () => {
      mockELink.mockResolvedValue({ eLinkResult: [{ LinkSet: {} }] });
      mockESummary.mockResolvedValue({ eSummaryResult: {} });
      mockExtractBriefSummaries
        .mockResolvedValueOnce([{ pmid: '37952131', title: 'Non-PMC source' }])
        .mockResolvedValueOnce([{ pmid: '890', title: 'Ref X' }]);
      mockEpmcReferences.mockResolvedValue({
        pmids: [],
        totalCount: 0,
        hitCount: 0,
        droppedNoPmid: 0,
      });
      mockOaReferences.mockResolvedValue({ pmids: ['890'], totalCount: 150 });

      const ctx = createMockContext({ errors: findRelatedTool.errors });
      const input = findRelatedTool.input.parse({ pmid: '37952131', relationship: 'references' });
      const result = await findRelatedTool.handler(input, ctx);

      expect(getEnrichment(ctx).source).toBe('openalex');
      expect(getEnrichment(ctx).notice).toContain('OpenAlex');
      expect(result.articles[0]?.pmid).toBe('890');
    });

    it('notices when references are unavailable everywhere (non-PMC source)', async () => {
      mockELink.mockResolvedValue({ eLinkResult: [{ LinkSet: {} }] });
      mockESummary.mockResolvedValue({ eSummaryResult: {} });
      mockExtractBriefSummaries.mockResolvedValue([
        { pmid: '37952131', title: 'Non-PMC source' /* no pmcId */ },
      ]);
      mockEpmcReferences.mockResolvedValue({
        pmids: [],
        totalCount: 0,
        hitCount: 0,
        droppedNoPmid: 0,
      });
      mockOaReferences.mockResolvedValue({ pmids: [], totalCount: 0 });

      const ctx = createMockContext({ errors: findRelatedTool.errors });
      const input = findRelatedTool.input.parse({ pmid: '37952131', relationship: 'references' });
      const result = await findRelatedTool.handler(input, ctx);

      // EPMC + OpenAlex were both consulted before giving up.
      expect(mockEpmcReferences).toHaveBeenCalled();
      expect(mockOaReferences).toHaveBeenCalled();
      expect(result.totalCount).toBe(0);
      expect(getEnrichment(ctx).notice).toContain('37952131');
      expect(getEnrichment(ctx).notice).toContain('OpenAlex');
      expect(getEnrichment(ctx).notice).toContain('pubmed_fetch_articles');
    });

    it('notices with the PMCID when a PMC source has no references anywhere', async () => {
      mockELink.mockResolvedValue({ eLinkResult: [{ LinkSet: {} }] });
      mockESummary.mockResolvedValue({ eSummaryResult: {} });
      mockExtractBriefSummaries.mockResolvedValue([
        { pmid: '12345', title: 'PMC source', pmcId: 'PMC12345' },
      ]);
      mockEpmcReferences.mockResolvedValue({
        pmids: [],
        totalCount: 0,
        hitCount: 0,
        droppedNoPmid: 0,
      });
      mockOaReferences.mockResolvedValue({ pmids: [], totalCount: 0 });

      const ctx = createMockContext({ errors: findRelatedTool.errors });
      const input = findRelatedTool.input.parse({ pmid: '12345', relationship: 'references' });
      await findRelatedTool.handler(input, ctx);

      expect(getEnrichment(ctx).notice).toBeDefined();
      expect(getEnrichment(ctx).notice).toContain('PMCID PMC12345');
    });

    /**
     * Exact wording for the case where both fallbacks answer — not just throw-free
     * but genuinely empty. Pinned verbatim: this is the string a failed provider
     * must never be able to produce, so it has to stay stable while the failure
     * path grows its own wording.
     */
    it('words a genuine double-empty answer identically for both source kinds', async () => {
      mockELink.mockResolvedValue({ eLinkResult: [{ LinkSet: {} }] });
      mockESummary.mockResolvedValue({ eSummaryResult: {} });
      mockEpmcReferences.mockResolvedValue({
        pmids: [],
        totalCount: 0,
        hitCount: 0,
        droppedNoPmid: 0,
      });
      mockOaReferences.mockResolvedValue({ pmids: [], totalCount: 0 });

      mockExtractBriefSummaries.mockResolvedValue([{ pmid: '37952131', title: 'Non-PMC source' }]);
      const noPmcCtx = createMockContext({ errors: findRelatedTool.errors });
      await findRelatedTool.handler(
        findRelatedTool.input.parse({ pmid: '37952131', relationship: 'references' }),
        noPmcCtx,
      );
      expect(getEnrichment(noPmcCtx).notice).toBe(
        'No reference list available for PMID 37952131 via NCBI, Europe PMC, or OpenAlex. Use pubmed_fetch_articles to inspect the article record, or try relationship: "similar" / "cited_by".',
      );

      mockExtractBriefSummaries.mockResolvedValue([
        { pmid: '12345', title: 'PMC source', pmcId: 'PMC12345' },
      ]);
      const pmcCtx = createMockContext({ errors: findRelatedTool.errors });
      await findRelatedTool.handler(
        findRelatedTool.input.parse({ pmid: '12345', relationship: 'references' }),
        pmcCtx,
      );
      expect(getEnrichment(pmcCtx).notice).toBe(
        'No reference list found for PMID 12345 (PMCID PMC12345) via NCBI, Europe PMC, or OpenAlex.',
      );
    });

    it('omits notice for similar / cited_by empty results when source PMID is valid', async () => {
      mockELink.mockResolvedValue({ eLinkResult: [{ LinkSet: {} }] });
      mockESummary.mockResolvedValue({ eSummaryResult: {} });
      mockExtractBriefSummaries.mockResolvedValue([{ pmid: '12345', title: 'Valid source' }]);

      const ctx = createMockContext({ errors: findRelatedTool.errors });
      const input = findRelatedTool.input.parse({ pmid: '12345', relationship: 'similar' });
      await findRelatedTool.handler(input, ctx);

      expect(getEnrichment(ctx).notice).toBeUndefined();
      expect(mockESummary).toHaveBeenCalledTimes(1);
    });

    /**
     * ESummary as the endpoint answers: the requested PMIDs only, in the wire
     * format `version` selects, from the verbatim four-record capture pair.
     */
    function versionPairEsummary(params: {
      id?: string;
      version?: string;
    }): Promise<ESummaryResult> {
      const ids = new Set(String(params.id).split(','));
      const result = parseESummaryXml(
        params.version === '2.0' ? VERSION_PAIR_ESUMMARY_V2_XML : VERSION_PAIR_ESUMMARY_V1_XML,
      );
      const set = result.DocumentSummarySet;
      if (set) {
        set.DocumentSummary = [set.DocumentSummary].flat().filter((d) => ids.has(d['@_uid']));
      }
      if (result.DocSum) {
        result.DocSum = [result.DocSum].flat().filter((d) => ids.has(String(d.Id)));
      }
      return Promise.resolve(result);
    }

    it('treats a whole Bookshelf book, which ESummary gives no Title, as found', async () => {
      // PMID 40825089 has no similar records. ESummary 2.0 names it in BookTitle
      // beside an empty Title; the version 1 DocSum has an empty Title and no
      // BookTitle at all, so the record reads as unknown there.
      mockELink.mockResolvedValue({ eLinkResult: [{ LinkSet: {} }] });
      mockESummary.mockImplementation(versionPairEsummary);
      mockExtractBriefSummaries.mockImplementation(realExtractBriefSummaries);

      const ctx = createMockContext({ errors: findRelatedTool.errors });
      const input = findRelatedTool.input.parse({ pmid: '40825089', relationship: 'similar' });
      const result = await findRelatedTool.handler(input, ctx);

      expect(result.totalCount).toBe(0);
      expect(getEnrichment(ctx).notice).toBeUndefined();
    });

    it('still reports a source ESummary answers with an error entry as missing', async () => {
      // An unknown PMID's `<DocumentSummary>` carries only its uid and an error.
      mockELink.mockResolvedValue({ eLinkResult: [{ LinkSet: {} }] });
      mockESummary.mockResolvedValue({ eSummaryResult: {} });
      mockExtractBriefSummaries.mockResolvedValue([{ pmid: '99999999999', authorNames: [] }]);

      const ctx = createMockContext({ errors: findRelatedTool.errors });
      const input = findRelatedTool.input.parse({ pmid: '99999999999', relationship: 'similar' });
      await findRelatedTool.handler(input, ctx);

      expect(getEnrichment(ctx).notice).toContain('not found in PubMed');
    });

    it('falls back gracefully when the ESummary lookup fails (transport error)', async () => {
      mockELink.mockResolvedValue({ eLinkResult: [{ LinkSet: {} }] });
      mockESummary.mockRejectedValue(new Error('NCBI down'));

      const ctx = createMockContext({ errors: findRelatedTool.errors });
      const input = findRelatedTool.input.parse({ pmid: '12345', relationship: 'references' });
      const result = await findRelatedTool.handler(input, ctx);

      expect(result.totalCount).toBe(0);
      expect(getEnrichment(ctx).notice).toBeUndefined();
    });

    it('emits invalid-PMID notice when source ESummary returns nothing', async () => {
      mockELink.mockResolvedValue({ eLinkResult: [{ LinkSet: {} }] });
      mockESummary.mockResolvedValue({ eSummaryResult: {} });
      mockExtractBriefSummaries.mockResolvedValue([]);

      const ctx = createMockContext({ errors: findRelatedTool.errors });
      const input = findRelatedTool.input.parse({
        pmid: '99999999999',
        relationship: 'references',
      });
      await findRelatedTool.handler(input, ctx);

      expect(getEnrichment(ctx).notice).toContain('99999999999');
      expect(getEnrichment(ctx).notice).toContain('not found in PubMed');
      // Invalid-source notice supersedes the references-specific hint.
      expect(getEnrichment(ctx).notice).not.toContain('PMC');
    });

    it('renders the empty state; the recovery notice is enrichment, not format output', () => {
      const blocks = textBlocks(
        findRelatedTool.format!({
          sourcePmid: '37952131',
          relationship: 'references',
          offset: 0,
          totalCount: 0,
          articles: [],
        }),
      );
      const text = blocks[0]?.text ?? '';
      expect(text).toContain('No related articles found.');
      expect(text).not.toContain('Reference lists require');
    });
  });

  it('formats output with articles', () => {
    const blocks = textBlocks(
      findRelatedTool.format!({
        sourcePmid: '12345',
        relationship: 'similar',
        offset: 0,
        totalCount: 1,
        articles: [
          {
            pmid: '111',
            title: 'Related Article',
            authors: 'Smith J',
            source: 'Nature',
            pubDate: '2024',
            pubmedUrl: 'https://pubmed.ncbi.nlm.nih.gov/111/',
          },
        ],
      }),
    );
    expect(blocks[0]?.text).toBe(
      [
        '# Related Articles for PMID 12345',
        '**Relationship:** similar',
        '**Returned:** 1 of 1 | **Offset:** 0',
        '- **[PMID 111](<https://pubmed.ncbi.nlm.nih.gov/111/>)**',
        '  Related Article',
        '  *Smith J*',
        '  Nature, 2024',
      ].join('\n'),
    );
  });

  describe('invalid source PMID detection (issue #22)', () => {
    const invalidPmidNotice = (relationship: 'similar' | 'cited_by' | 'references') => async () => {
      mockELink.mockResolvedValue({ eLinkResult: [{ LinkSet: {} }] });
      mockESummary.mockResolvedValue({ eSummaryResult: {} });
      mockExtractBriefSummaries.mockResolvedValue([]);

      const ctx = createMockContext({ errors: findRelatedTool.errors });
      const input = findRelatedTool.input.parse({ pmid: '99999999999', relationship });
      const result = await findRelatedTool.handler(input, ctx);

      expect(result.totalCount).toBe(0);
      expect(result.articles).toEqual([]);
      expect(getEnrichment(ctx).notice).toContain('99999999999');
      expect(getEnrichment(ctx).notice).toContain('not found in PubMed');
      expect(getEnrichment(ctx).notice).toContain('pubmed_fetch_articles');
    };

    it(
      'emits notice for similar relationship when source PMID is unknown',
      invalidPmidNotice('similar'),
    );
    it(
      'emits notice for cited_by relationship when source PMID is unknown',
      invalidPmidNotice('cited_by'),
    );
    it(
      'emits notice for references relationship when source PMID is unknown',
      invalidPmidNotice('references'),
    );

    it('treats NCBI NotFound throw as confirmed missing PMID (via error code)', async () => {
      mockELink.mockResolvedValue({ eLinkResult: [{ LinkSet: {} }] });
      mockESummary.mockRejectedValue(
        new McpError(JsonRpcErrorCode.NotFound, 'NCBI API Error: cannot get summary', {
          reason: 'ncbi_resource_not_found',
          ncbiErrors: ['UID=99999999999: cannot get document summary'],
        }),
      );

      const ctx = createMockContext({ errors: findRelatedTool.errors });
      const input = findRelatedTool.input.parse({ pmid: '99999999999', relationship: 'similar' });
      await findRelatedTool.handler(input, ctx);

      expect(getEnrichment(ctx).notice).toContain('99999999999');
      expect(getEnrichment(ctx).notice).toContain('not found in PubMed');
    });

    it('does NOT emit invalid notice on transient transport failure', async () => {
      mockELink.mockResolvedValue({ eLinkResult: [{ LinkSet: {} }] });
      mockESummary.mockRejectedValue(new Error('connect ETIMEDOUT'));

      const ctx = createMockContext({ errors: findRelatedTool.errors });
      const input = findRelatedTool.input.parse({ pmid: '12345', relationship: 'similar' });
      const result = await findRelatedTool.handler(input, ctx);

      expect(result.totalCount).toBe(0);
      expect(getEnrichment(ctx).notice).toBeUndefined();
    });
  });
});

describe('findRelatedTool Bookshelf summaries (issue #114)', () => {
  beforeEach(() => {
    mockELink.mockReset();
    mockESummary.mockReset();
    mockExtractBriefSummaries.mockReset();
    mockGetEpmcService.mockReturnValue(epmcService);
    mockGetOaService.mockReturnValue(oaService);
  });

  /**
   * ESummary serves two wire formats, and only version 2.0 carries book
   * metadata — the version 1 DocSum shape has no `BookTitle`, `PublisherName`
   * or `DocType` element at all. Answering per `version` the way the endpoint
   * does is what makes these tests fail when the tool asks for the wrong
   * format, instead of only when the pass-through mapping breaks.
   */
  function esummaryByRequestedVersion(params: { version?: string }): Promise<ESummaryResult> {
    return Promise.resolve(
      parseESummaryXml(params.version === '2.0' ? BOOK_ESUMMARY_XML : BOOK_ESUMMARY_V1_XML),
    );
  }

  it('carries the book venue and editors onto both consumption surfaces', async () => {
    mockELink.mockResolvedValue(eLinkResponse(['20301425']));
    mockESummary.mockImplementation(esummaryByRequestedVersion);
    mockExtractBriefSummaries.mockImplementation(realExtractBriefSummaries);

    const ctx = createMockContext({ errors: findRelatedTool.errors });
    const input = findRelatedTool.input.parse({ pmid: '29262038', relationship: 'similar' });
    const result = await findRelatedTool.handler(input, ctx);

    expect(result.articles[0]).toMatchObject({
      pmid: '20301425',
      bookTitle: 'GeneReviews(®)',
      publisherName: 'University of Washington, Seattle',
      docType: 'chapter',
      editors: ['Adam MP', 'Bick S', 'Mirzaa GM', 'Wallace SE', 'Amemiya A'],
    });
    // The series editors must not displace the chapter's own authors, and an
    // empty upstream Source must be absent rather than an empty string.
    expect(result.articles[0]?.authors).toBe('Petrucelli N, Daly MB, Pal T');
    expect(result.articles[0]?.source).toBeUndefined();

    const text = textBlocks(findRelatedTool.format!(result))[0]?.text ?? '';
    expect(text).toContain('edited by Adam MP, Bick S, Mirzaa GM, Wallace SE, Amemiya A');
    // Dated by the chapter's own revision (DocDate "… [updated 2026 Mar 25]"),
    // not its book's 1993 start. (#199)
    expect(text).toContain(
      'GeneReviews(®) — University of Washington, Seattle, chapter, 2026-03-25',
    );
  });

  it('requests the ESummary version that carries book metadata', async () => {
    mockELink.mockResolvedValue(eLinkResponse(['20301425']));
    mockESummary.mockImplementation(esummaryByRequestedVersion);
    mockExtractBriefSummaries.mockImplementation(realExtractBriefSummaries);

    const ctx = createMockContext({ errors: findRelatedTool.errors });
    await findRelatedTool.handler(findRelatedTool.input.parse({ pmid: '29262038' }), ctx);

    expect(mockESummary).toHaveBeenCalledWith(
      expect.objectContaining({ db: 'pubmed', version: '2.0' }),
      expect.anything(),
    );
  });
});

describe('findRelatedTool Bookshelf chapter dates (issue #199)', () => {
  /** PMID → expected row date: chapters by their own date, the rest unchanged. */
  const EXPECTED: [string, string][] = [
    ['20301340', '2018-12-20'], // chapter, revised — book PubDate 1993
    ['25905212', '2025-07-03'], // chapter, contributed — book PubDate 2000
    ['36356174', '2021-09'], // chapter, "2021 Sep" — book PubDate 2014
    ['42330151', '2026'], // chapter, "2026" — book PubDate 2025 Dec 4
    ['40825089', '2025-07-02'], // whole book, PubDate "2025 Jul 2"
    ['42474064', '2026-07'], // journal article, PubDate "2026 Jul"
  ];

  beforeEach(() => {
    mockELink.mockReset();
    mockESummary.mockReset();
    mockExtractBriefSummaries.mockReset();
    mockGetEpmcService.mockReturnValue(epmcService);
    mockGetOaService.mockReturnValue(oaService);
    mockELink.mockResolvedValue(eLinkResponse(EXPECTED.map(([pmid]) => pmid)));
    mockESummary.mockResolvedValue(parseESummaryXml(CHAPTER_DATES_ESUMMARY_XML));
    mockExtractBriefSummaries.mockImplementation(realExtractBriefSummaries);
  });

  it('dates each related row on both surfaces, chapters by their own date', async () => {
    const result = await runToolContract(findRelatedTool, {
      pmid: '12345',
      relationship: 'similar',
    });

    const articles = (result.structuredContent as { articles: ParsedBriefSummary[] }).articles;
    expect(articles.map((a) => [a.pmid, a.pubDate])).toEqual(EXPECTED);

    // content[]: each row's indented metadata line ends on the same date
    const rows = textBlocks(result.content as ContentBlock[])
      .map((b) => b.text)
      .join('\n')
      .split('\n- **[PMID ')
      .slice(1);
    expect(rows).toHaveLength(EXPECTED.length);
    for (const [pmid, date] of EXPECTED) {
      const row = rows.find((r) => r.startsWith(`${pmid}]`)) ?? '';
      const meta = row
        .split('\n')
        .filter((line) => line.startsWith('  '))
        .at(-1);
      expect(meta, pmid).toMatch(new RegExp(`, ${date}$`));
    }
  });

  it('describes pubDate as the chapter date on a Bookshelf chapter', () => {
    const schema = z.toJSONSchema(findRelatedTool.output) as unknown as {
      properties: { articles: { items: { properties: { pubDate: { description?: string } } } } };
    };
    const description = schema.properties.articles.items.properties.pubDate.description ?? '';
    // At PubMed's own precision. (#293)
    expect(description).toContain('`2026-12`');
    expect(description).toContain('`start/end`');
    expect(description).not.toContain('first day');
    expect(description).toContain('chapter');
  });
});

/** Every content[] line of a row's item — its heading and indented lines — keyed by the row's PMID. */
const itemLines = (result: Awaited<ReturnType<typeof runToolContract>>, pmid: string) => {
  const lines = textBlocks(result.content as ContentBlock[])
    .map((b) => b.text)
    .join('\n')
    .split('\n');
  const start = lines.findIndex((line) => line.startsWith(`- **[PMID ${pmid}]`));
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => !line.startsWith('  '));
  return [lines[start], ...(end === -1 ? rest : rest.slice(0, end))];
};

describe('findRelatedTool row identifiers and dates (issues #293, #297)', () => {
  beforeEach(() => {
    mockELink.mockReset();
    mockESummary.mockReset();
    mockExtractBriefSummaries.mockReset();
    mockEpmcCitations.mockReset();
    mockOaSimilar.mockReset();
    mockGetEpmcService.mockReturnValue(epmcService);
    mockGetOaService.mockReturnValue(oaService);
  });

  /** The identifier fields of each structured row. */
  const identifiersOf = (result: Awaited<ReturnType<typeof runToolContract>>) =>
    (result.structuredContent as { articles: Record<string, unknown>[] }).articles.map(
      ({ pmid, doi, pmcId, pmcUrl, pubmedUrl }) => ({ pmid, doi, pmcId, pmcUrl, pubmedUrl }),
    );

  it('ESummary served: each row carries the DOI, PMC copy, and PubMed link ESummary states, on both surfaces', async () => {
    mockELink.mockResolvedValue(eLinkResponse(['20301340', '36356174', '42474064']));
    mockESummary.mockResolvedValue(parseESummaryXml(CHAPTER_DATES_ESUMMARY_XML));
    mockExtractBriefSummaries.mockImplementation(realExtractBriefSummaries);

    const result = await runToolContract(findRelatedTool, { pmid: '12345' });

    expect(result.isError).toBeFalsy();
    expect(identifiersOf(result)).toEqual([
      { pmid: '20301340', pubmedUrl: 'https://pubmed.ncbi.nlm.nih.gov/20301340/' },
      {
        pmid: '36356174',
        doi: '10.3768/rtipress.2021.rb.0028.2109',
        pubmedUrl: 'https://pubmed.ncbi.nlm.nih.gov/36356174/',
      },
      {
        pmid: '42474064',
        doi: '10.3310/KGTO6391',
        pmcId: 'PMC13403055',
        pmcUrl: 'https://pmc.ncbi.nlm.nih.gov/articles/PMC13403055/',
        pubmedUrl: 'https://pubmed.ncbi.nlm.nih.gov/42474064/',
      },
    ]);
    const { articles } = result.structuredContent as { articles: Record<string, unknown>[] };
    expect(articles[1]).not.toHaveProperty('pmcId');
    expect(articles[1]).not.toHaveProperty('pmcUrl');

    // The PubMed link stays the item heading; the DOI and PMC copy follow it.
    expect(itemLines(result, '42474064')[0]).toBe(
      '- **[PMID 42474064](<https://pubmed.ncbi.nlm.nih.gov/42474064/>)** · DOI 10.3310/KGTO6391 · [PMC13403055](<https://pmc.ncbi.nlm.nih.gov/articles/PMC13403055/>)',
    );
    expect(itemLines(result, '36356174')[0]).toBe(
      '- **[PMID 36356174](<https://pubmed.ncbi.nlm.nih.gov/36356174/>)** · DOI 10.3768/rtipress.2021.rb.0028.2109',
    );
    expect(itemLines(result, '20301340')[0]).toBe(
      '- **[PMID 20301340](<https://pubmed.ncbi.nlm.nih.gov/20301340/>)**',
    );
    expect(readCommonMark(itemLines(result, '42474064')[0] ?? '')).toContain(
      '⟨strong⟩⟨a href=https://pubmed.ncbi.nlm.nih.gov/42474064/⟩PMID 42474064⟨/a⟩⟨/strong⟩ · DOI 10.3310/KGTO6391 · ⟨a href=https://pmc.ncbi.nlm.nih.gov/articles/PMC13403055/⟩PMC13403055⟨/a⟩',
    );
  });

  it('renders the DOI as its own text, a tag-shaped `<` included, and keeps it as written in structuredContent', async () => {
    // A SICI-form DOI whose page segment opens with a letter: unescaped,
    // `<ii::AID-SIM1>` is a CommonMark autolink that drops both angle brackets.
    const doi = '10.1002/(SICI)1097-0258(19990115)18:1<ii::AID-SIM1>3.0.CO;2-#';
    mockELink.mockResolvedValue(eLinkResponse(['333']));
    mockESummary.mockResolvedValue({ eSummaryResult: {} });
    mockExtractBriefSummaries.mockResolvedValue([{ pmid: '333', title: 'Row.', doi }]);

    const result = await runToolContract(findRelatedTool, { pmid: '12345' });

    expect(identifiersOf(result)).toEqual([
      { pmid: '333', doi, pubmedUrl: 'https://pubmed.ncbi.nlm.nih.gov/333/' },
    ]);
    const heading = itemLines(result, '333')[0] ?? '';
    expect(heading).toBe(
      '- **[PMID 333](<https://pubmed.ncbi.nlm.nih.gov/333/>)** · DOI 10.1002/(SICI)1097-0258(19990115)18:1\\<ii::AID-SIM1>3.0.CO;2-#',
    );
    expect(readCommonMark(heading)).toContain(
      '⟨strong⟩⟨a href=https://pubmed.ncbi.nlm.nih.gov/333/⟩PMID 333⟨/a⟩⟨/strong⟩ · DOI 10.1002/(SICI)1097-0258(19990115)18:1<ii::AID-SIM1>3.0.CO;2-#',
    );
  });

  it('ESummary failed: each row is its PMID and PubMed link, with the degradation notice', async () => {
    mockELink.mockResolvedValue(eLinkResponse(['101', '102']));
    mockESummary.mockRejectedValue(new McpError(JsonRpcErrorCode.ServiceUnavailable, 'NCBI down'));

    const result = await runToolContract(findRelatedTool, { pmid: '12345' });

    expect(result.isError).toBeFalsy();
    expect((result.structuredContent as { articles: unknown[] }).articles).toEqual([
      { pmid: '101', pubmedUrl: 'https://pubmed.ncbi.nlm.nih.gov/101/' },
      { pmid: '102', pubmedUrl: 'https://pubmed.ncbi.nlm.nih.gov/102/' },
    ]);
    expect(itemLines(result, '101')[0]).toBe(
      '- **[PMID 101](<https://pubmed.ncbi.nlm.nih.gov/101/>)**',
    );
    expect((result.structuredContent as { notice?: string }).notice).toContain(
      'Article metadata is temporarily unavailable',
    );
  });

  it.each([
    {
      provider: 'europepmc',
      relationship: 'cited_by',
      serve: () =>
        mockEpmcCitations.mockResolvedValue({
          pmids: ['42926911', '42905372'],
          hitCount: 2,
          droppedNoPmid: 0,
        }),
    },
    {
      provider: 'openalex',
      relationship: 'similar',
      serve: () =>
        mockOaSimilar.mockResolvedValue({ pmids: ['42926911', '42905372'], totalCount: 2 }),
    },
  ] as const)(
    '$provider fallback: rows carry the identifiers from the same ESummary call',
    async ({ provider, relationship, serve }) => {
      mockELink.mockRejectedValue(new McpError(JsonRpcErrorCode.ServiceUnavailable, 'NCBI down'));
      serve();
      mockESummary.mockResolvedValue({ eSummaryResult: {} });
      mockExtractBriefSummaries.mockResolvedValue([
        {
          pmid: '42926911',
          title: 'Concordance Between Trial Efficacy and Real-World Effectiveness.',
          doi: '10.7759/cureus.118487',
          pmcId: 'PMC13695040',
        },
        { pmid: '42905372', title: 'Association study.', doi: '10.1007/s11739-026-04571-z' },
      ]);

      const result = await runToolContract(findRelatedTool, { pmid: '31535829', relationship });

      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toMatchObject({ source: provider });
      expect(identifiersOf(result)).toEqual([
        {
          pmid: '42926911',
          doi: '10.7759/cureus.118487',
          pmcId: 'PMC13695040',
          pmcUrl: 'https://pmc.ncbi.nlm.nih.gov/articles/PMC13695040/',
          pubmedUrl: 'https://pubmed.ncbi.nlm.nih.gov/42926911/',
        },
        {
          pmid: '42905372',
          doi: '10.1007/s11739-026-04571-z',
          pubmedUrl: 'https://pubmed.ncbi.nlm.nih.gov/42905372/',
        },
      ]);
      expect(itemLines(result, '42926911')[0]).toBe(
        '- **[PMID 42926911](<https://pubmed.ncbi.nlm.nih.gov/42926911/>)** · DOI 10.7759/cureus.118487 · [PMC13695040](<https://pmc.ncbi.nlm.nih.gov/articles/PMC13695040/>)',
      );
    },
  );

  it('carries the electronic publication date in the meta line, and none where ESummary has none', async () => {
    mockELink.mockResolvedValue(eLinkResponse(['42802242', '17212296']));
    mockESummary.mockResolvedValue({ eSummaryResult: {} });
    mockExtractBriefSummaries.mockResolvedValue([
      {
        pmid: '42802242',
        title: 'Effectiveness of Adding GLP-1 Receptor Agonists.',
        source: 'Diabetes Obes Metab',
        docType: 'citation',
        pubDate: '2026-12',
        epubDate: '2026-09-27',
      },
      {
        pmid: '17212296',
        title: "How to search for and use 'grey literature' in research.",
        source: 'Nurs Times',
        docType: 'citation',
        pubDate: '2006-12-12/2007-01-01',
      },
    ]);

    const result = await runToolContract(findRelatedTool, { pmid: '12345' });

    const { articles } = result.structuredContent as { articles: Record<string, unknown>[] };
    expect(articles[0]).toMatchObject({
      pmid: '42802242',
      pubDate: '2026-12',
      epubDate: '2026-09-27',
    });
    expect(articles[1]).toMatchObject({ pmid: '17212296', pubDate: '2006-12-12/2007-01-01' });
    expect(articles[1]).not.toHaveProperty('epubDate');
    expect(itemLines(result, '42802242').at(-1)).toBe(
      '  Diabetes Obes Metab, 2026-12, epub 2026-09-27',
    );
    expect(itemLines(result, '17212296').at(-1)).toBe('  Nurs Times, 2006-12-12/2007-01-01');
  });
});

describe('findRelatedTool row languages (issue #309)', () => {
  /** The PMIDs of the fixture, in NCBI's order: the unknown 99999999 among them. */
  const PMIDS = ['20301295', '34463784', '43020712', '99999999', '25881375', '42233801'];

  beforeEach(() => {
    mockELink.mockReset();
    mockESummary.mockReset();
    mockExtractBriefSummaries.mockReset();
    mockGetEpmcService.mockReturnValue(epmcService);
    mockGetOaService.mockReturnValue(oaService);
    mockELink.mockResolvedValue(eLinkResponse(PMIDS));
    mockESummary.mockResolvedValue(parseESummaryXml(LANGUAGES_ESUMMARY_XML));
    mockExtractBriefSummaries.mockImplementation(realExtractBriefSummaries);
  });

  const run = async () => {
    const result = await runToolContract(findRelatedTool, { pmid: '12345' });
    const { articles } = result.structuredContent as {
      articles: { pmid: string; languages?: string[] }[];
    };
    return { result, articles };
  };

  it("carries every code of each row on both surfaces, in NCBI's order, above the meta line", async () => {
    const { result, articles } = await run();

    expect(articles.map((a) => a.pmid)).toEqual(PMIDS);
    for (const [pmid, languages] of LANGUAGES_BY_PMID) {
      expect(articles.find((a) => a.pmid === pmid)?.languages, pmid).toEqual(languages);
      // The meta line stays the item's last line (#297); the language sits on its own just above it.
      expect(itemLines(result, pmid).at(-2), pmid).toBe(`  Language: ${languages.join(', ')}`);
    }
    expect(itemLines(result, '25881375').slice(-2)).toEqual([
      '  Language: ara, eng, fre, ger, por, spa',
      '  Int J Orthod Milwaukee, 2015',
    ]);
    expect(itemLines(result, '42233801')).toEqual([
      '- **[PMID 42233801](<https://pubmed.ncbi.nlm.nih.gov/42233801/>)** · DOI 10.1590/1413-81232026314.15792024',
      '  Phenomenological approaches to qualitative research in the field of Nutrition in Brazil: a literature review.',
      '  *Vasconcelos FAG*',
      '  Language: por, eng, spa',
      '  Cien Saude Colet, 2026-04, epub 2024-12-30',
    ]);
  });

  it('gives a row ESummary did not describe no languages on either surface', async () => {
    const { result, articles } = await run();

    expect(articles.find((a) => a.pmid === '99999999')).not.toHaveProperty('languages');
    expect(itemLines(result, '99999999')).toEqual([
      '- **[PMID 99999999](<https://pubmed.ncbi.nlm.nih.gov/99999999/>)**',
    ]);
  });
});

/** Every text block of a contract run, joined — the header, the rows, and the trailer. */
const contractText = (result: Awaited<ReturnType<typeof runToolContract>>) =>
  textBlocks(result.content as ContentBlock[])
    .map((b) => b.text)
    .join('\n');

/** A structured payload's total match count, read off the real returned result. */
const totalOf = (result: Awaited<ReturnType<typeof runToolContract>>) =>
  (result.structuredContent as { totalCount?: number }).totalCount;

describe('findRelatedTool total match count in the header (issue #147)', () => {
  beforeEach(() => {
    mockELink.mockReset();
    mockESummary.mockReset();
    mockExtractBriefSummaries.mockReset();
    mockExtractBriefSummaries.mockResolvedValue([]);
    mockEpmcCitations.mockReset();
    mockEpmcReferences.mockReset();
    mockOaSimilar.mockReset();
    mockOaCitedBy.mockReset();
    mockOaReferences.mockReset();
    mockGetEpmcService.mockReturnValue(epmcService);
    mockGetOaService.mockReturnValue(oaService);
  });

  /** NCBI answers empty and the source-PMID ESummary resolves the source as valid. */
  function validSourceWithNoLinks() {
    mockELink.mockResolvedValue({ eLinkResult: [{ LinkSet: {} }] });
    mockESummary.mockResolvedValue({ eSummaryResult: {} });
    mockExtractBriefSummaries.mockResolvedValue([{ pmid: '12345', title: 'Source' }]);
  }

  /** The header and trailer shape every return path shares. */
  function expectHeader(
    result: Awaited<ReturnType<typeof runToolContract>>,
    header: string,
    total: number,
  ) {
    expect(result.isError).toBeFalsy();
    expect(totalOf(result)).toBe(total);
    const text = contractText(result);
    expect(text).toContain(header);
    expect(text).not.toMatch(/\*\*\d+ total\*\*/);
    expect(text).not.toContain('Total Found');
  }

  it('ESummary-enriched window: N of the full neighbor set', async () => {
    mockELink.mockResolvedValue(eLinkResponse(['101', '102', '103']));
    mockESummary.mockResolvedValue({ eSummaryResult: {} });
    mockExtractBriefSummaries.mockResolvedValue([
      { pmid: '101', title: 'A' },
      { pmid: '102', title: 'B' },
    ]);

    const result = await runToolContract(findRelatedTool, { pmid: '12345', maxResults: 2 });

    expectHeader(result, '**Returned:** 2 of 3 | **Offset:** 0', 3);
  });

  it('fallback provider: the header carries the upstream total, not the window', async () => {
    mockELink.mockRejectedValue(new McpError(JsonRpcErrorCode.ServiceUnavailable, 'NCBI down'));
    mockOaSimilar.mockResolvedValue({ pmids: ['555', '666'], totalCount: 10 });
    mockESummary.mockResolvedValue({ eSummaryResult: {} });

    const result = await runToolContract(findRelatedTool, { pmid: '12345', maxResults: 2 });

    expectHeader(result, '**Returned:** 2 of 10 | **Offset:** 0', 10);
    expect(result.structuredContent).toMatchObject({ source: 'openalex' });
    // The trailer renders an enrichment string as a code span; the parse reads
    // the whole paragraph back as the label plus the literal value.
    expect(readCommonMark(contractText(result)).split('\n\n')).toContain(
      '⟨strong⟩Source:⟨/strong⟩ ⟨code_inline:openalex⟩',
    );
  });

  it('source confirmed missing: 0 of 0 with the not-found notice', async () => {
    mockELink.mockResolvedValue({ eLinkResult: [{ LinkSet: {} }] });
    mockESummary.mockResolvedValue({ eSummaryResult: {} });

    const result = await runToolContract(findRelatedTool, { pmid: '99999999' });

    expectHeader(result, '**Returned:** 0 of 0 | **Offset:** 0', 0);
    expect(contractText(result)).toContain('Source PMID 99999999 not found in PubMed');
  });

  it('references with no fallback answer: 0 of 0 with the no-reference-list notice', async () => {
    validSourceWithNoLinks();
    mockEpmcReferences.mockResolvedValue({ pmids: [], hitCount: 0, droppedNoPmid: 0 });
    mockOaReferences.mockResolvedValue({ pmids: [], totalCount: 0 });

    const result = await runToolContract(findRelatedTool, {
      pmid: '12345',
      relationship: 'references',
    });

    expectHeader(result, '**Returned:** 0 of 0 | **Offset:** 0', 0);
    expect(contractText(result)).toContain('No reference list available for PMID 12345');
  });

  it.each(['similar', 'cited_by'] as const)(
    '%s empty for a valid source: 0 of 0 with no notice',
    async (relationship) => {
      validSourceWithNoLinks();

      const result = await runToolContract(findRelatedTool, { pmid: '12345', relationship });

      expectHeader(result, '**Returned:** 0 of 0 | **Offset:** 0', 0);
      expect((result.structuredContent as { notice?: string }).notice).toBeUndefined();
    },
  );

  it('window past the end: 0 of the total at the requested offset', async () => {
    mockELink.mockResolvedValue(eLinkResponse(['101', '102', '103']));

    const result = await runToolContract(findRelatedTool, { pmid: '12345', offset: 10 });

    expectHeader(result, '**Returned:** 0 of 3 | **Offset:** 10', 3);
    expect(contractText(result)).toContain('Offset 10 exceeds totalCount (3)');
    expect(mockESummary).not.toHaveBeenCalled();
  });

  it('ESummary degraded: bare PMIDs, N of the total', async () => {
    mockELink.mockResolvedValue(eLinkResponse(['101', '102']));
    mockESummary.mockRejectedValue(new McpError(JsonRpcErrorCode.ServiceUnavailable, 'NCBI down'));

    const result = await runToolContract(findRelatedTool, { pmid: '12345' });

    expectHeader(result, '**Returned:** 2 of 2 | **Offset:** 0', 2);
    expect(contractText(result)).toContain('Article metadata is temporarily unavailable');
  });
});

describe('findRelatedTool Doc Type rendering (issue #146)', () => {
  beforeEach(() => {
    mockELink.mockReset();
    mockESummary.mockReset();
    mockExtractBriefSummaries.mockReset();
    mockGetEpmcService.mockReturnValue(epmcService);
    mockGetOaService.mockReturnValue(oaService);
    mockELink.mockResolvedValue(eLinkResponse(['111', '20301425', '222']));
    mockESummary.mockResolvedValue({ eSummaryResult: {} });
  });

  /** Journal rows around one Bookshelf row, as a mixed ESummary page arrives. */
  const run = (bookDocType: string) => {
    mockExtractBriefSummaries.mockResolvedValue([
      { pmid: '111', title: 'Journal A', source: 'Nature', docType: 'citation', pubDate: '2021' },
      {
        pmid: '20301425',
        title: 'Book record',
        bookTitle: 'GeneReviews(®)',
        publisherName: 'University of Washington, Seattle',
        docType: bookDocType,
        pubDate: '1993',
      },
      { pmid: '222', title: 'Journal B', source: 'Science', docType: 'citation', pubDate: '2022' },
    ]);
    return runToolContract(findRelatedTool, { pmid: '34265844', relationship: 'cited_by' });
  };

  it('drops the citation segment from journal rows and keeps the Bookshelf one', async () => {
    const text = contractText(await run('chapter'));

    expect(text).toContain('  Nature, 2021\n');
    expect(text).toContain('  Science, 2022');
    expect(text).not.toContain('citation');
    expect(text).toContain('  GeneReviews(®) — University of Washington, Seattle, chapter, 1993');
  });

  it('leaves structuredContent.articles[].docType untouched, citation included', async () => {
    const result = await run('chapter');

    const { articles } = result.structuredContent as { articles: { docType?: string }[] };
    expect(articles.map((a) => a.docType)).toEqual(['citation', 'chapter', 'citation']);
  });

  it.each(['book', 'report'])('keeps rendering any other value (%s)', async (docType) => {
    const text = contractText(await run(docType));

    expect(text).toContain(`University of Washington, Seattle, ${docType}, 1993`);
    expect(text).not.toContain('citation');
  });
});

describe('findRelatedTool content[] escaping of the row lines (issue #255)', () => {
  beforeEach(() => {
    mockELink.mockReset();
    mockESummary.mockReset();
    mockExtractBriefSummaries.mockReset();
    mockGetEpmcService.mockReturnValue(epmcService);
    mockGetOaService.mockReturnValue(oaService);
    mockELink.mockResolvedValue(eLinkResponse(['111', '222']));
    mockESummary.mockResolvedValue({ eSummaryResult: {} });
  });

  const rows = [
    {
      pmid: '111',
      title: '# Not a heading',
      source: 'J *Bold* Res',
      docType: 'citation',
      pubDate: '2021 *Jan*',
    },
    {
      pmid: '222',
      title: 'Book record',
      source: '> Lancet',
      bookTitle: 'Book [1](x)',
      publisherName: 'Pub _A_',
      docType: '`chapter`',
      pubDate: '1993',
    },
  ];

  it('escapes the meta line and a block marker opening a row line, structuredContent unchanged', async () => {
    mockExtractBriefSummaries.mockResolvedValue(rows);
    const result = await runToolContract(findRelatedTool, { pmid: '34265844' });

    const { articles } = result.structuredContent as { articles: Record<string, unknown>[] };
    expect(articles[0]).toMatchObject(rows[0] ?? {});
    expect(articles[1]).toMatchObject(rows[1] ?? {});

    const text = contractText(result);
    expect(text).toContain('\n  \\# Not a heading\n');
    expect(text).toContain('\n  J \\*Bold\\* Res, 2021 \\*Jan\\*');
    expect(text).toContain('\n  \\> Lancet, Book \\[1\\](x) — Pub \\_A\\_, \\`chapter\\`, 1993');
  });

  it('escapes the Language line, structuredContent unchanged (#309)', async () => {
    mockExtractBriefSummaries.mockResolvedValue([
      {
        pmid: '111',
        title: 'Row with languages',
        source: 'J Res',
        docType: 'citation',
        pubDate: '2021',
        languages: ['*eng*', '_fre_'],
      },
    ]);
    const result = await runToolContract(findRelatedTool, { pmid: '34265844' });

    const { articles } = result.structuredContent as { articles: { languages?: string[] }[] };
    expect(articles[0]?.languages).toEqual(['*eng*', '_fre_']);
    expect(contractText(result)).toContain('\n  Language: \\*eng\\*, \\_fre\\_\n');
  });

  it('keeps a lone delimiter in each value visible across the row, authors italics included (#261)', async () => {
    mockExtractBriefSummaries.mockResolvedValue([
      {
        pmid: '111',
        title: 'HLA-B*57:01 carriers',
        authors: 'Smith J*, Doe A',
        source: 'J Allergy*',
        docType: 'citation',
        pubDate: '2021',
      },
      {
        pmid: '222',
        title: '5` UTR of Lee _K',
        authors: 'Lee _K',
        source: 'J_ Med 3` end',
        docType: 'citation',
        pubDate: '~2020',
      },
    ]);
    const result = await runToolContract(findRelatedTool, { pmid: '34265844' });
    const { articles } = result.structuredContent as { articles: { title?: string }[] };
    expect(articles[0]?.title).toBe('HLA-B*57:01 carriers');

    const rows = readCommonMark(contractText(result));
    expect(rows).toContain(
      '⟨strong⟩⟨a href=https://pubmed.ncbi.nlm.nih.gov/111/⟩PMID 111⟨/a⟩⟨/strong⟩\nHLA-B*57:01 carriers\n⟨em⟩Smith J*, Doe A⟨/em⟩\nJ Allergy*, 2021\n\n⟨list_item_close⟩',
    );
    expect(rows).toContain(
      '⟨strong⟩⟨a href=https://pubmed.ncbi.nlm.nih.gov/222/⟩PMID 222⟨/a⟩⟨/strong⟩\n5` UTR of Lee _K\n⟨em⟩Lee _K⟨/em⟩\nJ_ Med 3` end, ~2020\n\n⟨list_item_close⟩',
    );
  });

  it('decodes the residual entity in an ESummary title, as pubmed_fetch_articles does (#262)', async () => {
    mockELink.mockResolvedValue(eLinkResponse(['42138044']));
    mockESummary.mockResolvedValue(parseESummaryXml(APOS_TITLE_ESUMMARY_XML));
    mockExtractBriefSummaries.mockImplementation(realExtractBriefSummaries);
    const result = await runToolContract(findRelatedTool, { pmid: '42138050' });

    const title =
      "Cervical Vestibular-Evoked Myogenic Potentials (cVEMPs) in Parkinson's Disease Patients: Prospective, Case-Control study.";
    const { articles } = result.structuredContent as { articles: { title?: string }[] };
    expect(articles[0]?.title).toBe(title);
    expect(readCommonMark(contractText(result))).toContain(`\n${title}\n`);
  });
});

describe('findRelatedTool page-size clamp (#232)', () => {
  beforeEach(() => {
    mockELink.mockReset();
    mockESummary.mockReset();
    mockESummary.mockResolvedValue({ eSummaryResult: {} });
    mockExtractBriefSummaries.mockReset();
    mockExtractBriefSummaries.mockResolvedValue([]);
    mockEpmcCitations.mockReset();
    mockEpmcReferences.mockReset();
    mockOaSimilar.mockReset();
    mockOaCitedBy.mockReset();
    mockOaReferences.mockReset();
    mockGetEpmcService.mockReturnValue(epmcService);
    mockGetOaService.mockReturnValue(oaService);
  });

  /** `count` PMIDs from 1001 up, in rank order. */
  const ranked = (count: number, from = 1001) =>
    Array.from({ length: count }, (_, i) => String(from + i));
  const CLAMPED = '`maxResults` 60 is past the per-call cap of 50, so it is served at 50.';
  const noticeOf = (result: Awaited<ReturnType<typeof runToolContract>>) =>
    (result.structuredContent as { notice?: string }).notice;
  const pmidsOf = (result: Awaited<ReturnType<typeof runToolContract>>) =>
    (result.structuredContent as { articles: { pmid: string }[] }).articles.map((a) => a.pmid);
  const ncbiDown = () =>
    mockELink.mockRejectedValue(
      new McpError(JsonRpcErrorCode.ServiceUnavailable, 'NCBI down', {
        reason: 'ncbi_unreachable',
      }),
    );

  it.each([
    [51, true],
    [500, true],
    [501, false],
    [0, false],
    [50.5, false],
  ])('parses maxResults %d: %s', (maxResults, accepted) => {
    expect(findRelatedTool.input.safeParse({ pmid: '12345', maxResults }).success).toBe(accepted);
  });

  it('rejects a maxResults past the ceiling with -32602 before any upstream call', async () => {
    const result = await runToolContract(findRelatedTool, { pmid: '12345', maxResults: 501 });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: { code: JsonRpcErrorCode.InvalidParams },
    });
    expect(contractText(result)).toContain('maxResults: Too big');
    expect(mockELink).not.toHaveBeenCalled();
  });

  it('advertises the 500 ceiling and states the per-call cap', () => {
    const schema = z.toJSONSchema(findRelatedTool.input, { io: 'input' }) as unknown as {
      properties: Record<string, Record<string, unknown>>;
    };
    expect(schema.properties.maxResults).toMatchObject({
      type: 'integer',
      minimum: 1,
      maximum: 500,
      default: 10,
    });
    expect(schema.properties.maxResults?.description).toContain('up to 50 per call');
  });

  it('serves 50 and names the next offset on both surfaces; following it reads the next 50', async () => {
    mockELink.mockResolvedValue(eLinkResponse(ranked(120)));

    const first = await runToolContract(findRelatedTool, { pmid: '12345', maxResults: 60 });

    expect(first.isError).toBeFalsy();
    // ESummary is asked for the applied window, never the requested one.
    expect(mockESummary.mock.calls[0]?.[0]).toMatchObject({ id: ranked(50).join(',') });
    expect(pmidsOf(first)).toEqual(ranked(50));
    const notice = `${CLAMPED} Pass \`offset: 50\` for the next page.`;
    expect(noticeOf(first)).toBe(notice);
    expect(contractText(first)).toContain(`> ${notice}`);

    const second = await runToolContract(findRelatedTool, {
      pmid: '12345',
      maxResults: 60,
      offset: 50,
    });

    expect(pmidsOf(second)).toEqual(ranked(50, 1051));
    expect(noticeOf(second)).toBe(`${CLAMPED} Pass \`offset: 100\` for the next page.`);
  });

  it('names no continuation when every result fits', async () => {
    mockELink.mockResolvedValue(eLinkResponse(ranked(30)));

    const result = await runToolContract(findRelatedTool, { pmid: '12345', maxResults: 60 });

    expect(pmidsOf(result)).toEqual(ranked(30));
    expect(noticeOf(result)).toBe(CLAMPED);
  });

  it('sends the same request with no notice at the cap itself', async () => {
    mockELink.mockResolvedValue(eLinkResponse(ranked(120)));

    const result = await runToolContract(findRelatedTool, { pmid: '12345', maxResults: 50 });

    expect(mockESummary.mock.calls[0]?.[0]).toMatchObject({ id: ranked(50).join(',') });
    expect(pmidsOf(result)).toEqual(ranked(50));
    expect(noticeOf(result)).toBeUndefined();
  });

  it('sizes the Europe PMC window from the applied value and joins the provenance notice', async () => {
    ncbiDown();
    mockEpmcCitations.mockResolvedValue({ pmids: ranked(50), hitCount: 400, droppedNoPmid: 0 });

    const result = await runToolContract(findRelatedTool, {
      pmid: '12345',
      relationship: 'cited_by',
      maxResults: 60,
    });

    expect(mockEpmcCitations).toHaveBeenCalledTimes(1);
    expect(mockEpmcCitations).toHaveBeenCalledWith(
      '12345',
      50,
      1,
      expect.any(AbortSignal),
      aDeadline,
    );
    expect(noticeOf(result)).toBe(
      `${CLAMPED} Pass \`offset: 50\` for the next page. NCBI eLink unavailable — related articles served by Europe PMC (citations index).`,
    );
  });

  it('sizes the OpenAlex window from the applied value', async () => {
    ncbiDown();
    mockOaSimilar.mockResolvedValue({ pmids: ranked(100), totalCount: 100 });

    const result = await runToolContract(findRelatedTool, {
      pmid: '12345',
      maxResults: 60,
      offset: 10,
    });

    expect(mockOaSimilar).toHaveBeenCalledWith('12345', 60, expect.any(AbortSignal), aDeadline);
    expect(pmidsOf(result)).toEqual(ranked(50, 1011));
    expect(noticeOf(result)).toBe(
      `${CLAMPED} Pass \`offset: 60\` for the next page. NCBI eLink unavailable — related articles served by OpenAlex (related_works — OpenAlex similarity, not PubMed’s neighbor algorithm).`,
    );
  });

  it('sizes both reference-coverage windows from the applied value and joins the no-reference notice', async () => {
    mockELink.mockResolvedValue({ eLinkResult: [{ LinkSet: {} }] });
    mockExtractBriefSummaries.mockResolvedValue([{ pmid: '12345', title: 'Source' }]);
    mockEpmcReferences.mockResolvedValue({ pmids: [], hitCount: 0, droppedNoPmid: 0 });
    mockOaReferences.mockResolvedValue({ pmids: [], totalCount: 0 });

    const result = await runToolContract(findRelatedTool, {
      pmid: '12345',
      relationship: 'references',
      maxResults: 60,
    });

    expect(mockEpmcReferences).toHaveBeenCalledWith(
      '12345',
      50,
      1,
      expect.any(AbortSignal),
      aDeadline,
    );
    expect(mockOaReferences).toHaveBeenCalledWith('12345', 50, expect.any(AbortSignal), aDeadline);
    expect(noticeOf(result)).toBe(
      `${CLAMPED} No reference list available for PMID 12345 via NCBI, Europe PMC, or OpenAlex. Use pubmed_fetch_articles to inspect the article record, or try relationship: "similar" / "cited_by".`,
    );
  });

  it('joins the source-not-found notice', async () => {
    mockELink.mockResolvedValue({ eLinkResult: [{ LinkSet: {} }] });

    const result = await runToolContract(findRelatedTool, { pmid: '99999999', maxResults: 60 });

    expect(noticeOf(result)).toBe(
      `${CLAMPED} Source PMID 99999999 not found in PubMed. Verify the ID with \`pubmed_fetch_articles\` or \`pubmed_search_articles\`.`,
    );
  });

  it('carries the clamp alone on an empty answer for a valid source', async () => {
    mockELink.mockResolvedValue({ eLinkResult: [{ LinkSet: {} }] });
    mockExtractBriefSummaries.mockResolvedValue([{ pmid: '12345', title: 'Source' }]);

    const result = await runToolContract(findRelatedTool, { pmid: '12345', maxResults: 60 });

    expect(pmidsOf(result)).toEqual([]);
    expect(noticeOf(result)).toBe(CLAMPED);
  });

  it('joins the overshoot notice and names no offset past the end', async () => {
    mockELink.mockResolvedValue(eLinkResponse(ranked(120)));

    const result = await runToolContract(findRelatedTool, {
      pmid: '12345',
      maxResults: 60,
      offset: 200,
    });

    expect(noticeOf(result)).toBe(
      `${CLAMPED} Offset 200 exceeds totalCount (120). Reset offset to 0 or reduce it below 120 to page through results.`,
    );
  });

  it('keeps the continuation beside the degraded-metadata notice', async () => {
    mockELink.mockResolvedValue(eLinkResponse(ranked(120)));
    mockESummary.mockRejectedValue(new McpError(JsonRpcErrorCode.ServiceUnavailable, 'NCBI down'));

    const result = await runToolContract(findRelatedTool, { pmid: '12345', maxResults: 60 });

    expect(pmidsOf(result)).toEqual(ranked(50));
    expect(noticeOf(result)).toBe(
      `${CLAMPED} Pass \`offset: 50\` for the next page. Article metadata is temporarily unavailable (NCBI eSummary did not respond); returning related PMIDs only. Retry for full metadata, or use pubmed_fetch_articles.`,
    );
  });

  it('names no continuation when a fallback stopped short of the window', async () => {
    ncbiDown();
    // Every 50-row page carries one PMID, so ten pages leave the window unfilled.
    mockEpmcCitations.mockImplementation(async (_pmid: string, _size: number, page: number) => ({
      pmids: [String(5000 + page)],
      hitCount: 50000,
      droppedNoPmid: 49,
    }));

    const result = await runToolContract(findRelatedTool, {
      pmid: '12345',
      relationship: 'cited_by',
      maxResults: 60,
    });

    expect(mockEpmcCitations).toHaveBeenCalledTimes(10);
    expect(pmidsOf(result)).toHaveLength(10);
    const notice = noticeOf(result) ?? '';
    expect(notice.startsWith(`${CLAMPED} NCBI eLink unavailable`)).toBe(true);
    expect(notice).toContain('Europe PMC paging stopped after 10 pages');
    expect(notice).not.toContain('Pass `offset');
  });
});

/**
 * A caller abort at each upstream step rethrows the abort, never a fallback's
 * answer or a degraded row set. The handler is called directly: `runToolContract`
 * settles any result after an abort, a success included, as `RequestCancelled`,
 * so it cannot tell a rethrow from a degraded success. Every step after the
 * cancelled one is stubbed to answer, so a step that swallowed the abort would
 * return a result.
 */
describe('findRelatedTool caller cancellation', () => {
  beforeEach(() => {
    mockELink.mockReset();
    mockESummary.mockReset();
    mockESummary.mockResolvedValue({ eSummaryResult: {} });
    mockExtractBriefSummaries.mockReset();
    mockExtractBriefSummaries.mockResolvedValue([]);
    mockEpmcCitations.mockReset();
    mockEpmcCitations.mockResolvedValue({ pmids: ['201'], hitCount: 1, droppedNoPmid: 0 });
    mockEpmcReferences.mockReset();
    mockEpmcReferences.mockResolvedValue({ pmids: ['301'], hitCount: 1, droppedNoPmid: 0 });
    mockOaSimilar.mockReset();
    mockOaSimilar.mockResolvedValue({ pmids: ['401'], totalCount: 1 });
    mockOaCitedBy.mockReset();
    mockOaCitedBy.mockResolvedValue({ pmids: ['402'], totalCount: 1 });
    mockOaReferences.mockReset();
    mockOaReferences.mockResolvedValue({ pmids: ['403'], totalCount: 1 });
    mockGetEpmcService.mockReturnValue(epmcService);
    mockGetOaService.mockReturnValue(oaService);
  });

  /**
   * A caller cancellation. `cancel` stands in for the upstream call it lands
   * on: it aborts the request's signal, then rejects with the abort reason, as
   * the services do on a caller abort.
   */
  const cancellation = () => {
    const controller = new AbortController();
    const reason = new DOMException('The caller cancelled the request.', 'AbortError');
    const cancel = () => {
      controller.abort(reason);
      return Promise.reject(reason);
    };
    return { cancel, reason, signal: controller.signal };
  };

  const run = (signal: AbortSignal, args: Record<string, unknown>) =>
    findRelatedTool.handler(
      findRelatedTool.input.parse({ pmid: '12345', ...args }),
      createMockContext({ errors: findRelatedTool.errors, signal }),
    );

  const ncbiDown = () =>
    mockELink.mockRejectedValue(
      new McpError(JsonRpcErrorCode.ServiceUnavailable, 'NCBI down', {
        reason: 'ncbi_unreachable',
      }),
    );

  it('during ELink: tries no fallback', async () => {
    const { cancel, reason, signal } = cancellation();
    mockELink.mockImplementation(cancel);

    await expect(run(signal, { relationship: 'cited_by' })).rejects.toBe(reason);
    expect(mockEpmcCitations).not.toHaveBeenCalled();
    expect(mockOaCitedBy).not.toHaveBeenCalled();
    expect(mockESummary).not.toHaveBeenCalled();
  });

  it('during the Europe PMC fallback: tries no OpenAlex', async () => {
    const { cancel, reason, signal } = cancellation();
    ncbiDown();
    mockEpmcCitations.mockImplementation(cancel);

    await expect(run(signal, { relationship: 'cited_by' })).rejects.toBe(reason);
    expect(mockOaCitedBy).not.toHaveBeenCalled();
    expect(mockESummary).not.toHaveBeenCalled();
  });

  it('during the OpenAlex fallback: never serves the Europe PMC empty answer it holds', async () => {
    const { cancel, reason, signal } = cancellation();
    ncbiDown();
    mockEpmcCitations.mockResolvedValue({ pmids: [], hitCount: 0, droppedNoPmid: 0 });
    mockOaCitedBy.mockImplementation(cancel);

    await expect(run(signal, { relationship: 'cited_by' })).rejects.toBe(reason);
  });

  it('during the source ESummary of an empty ELink set: returns no empty answer', async () => {
    const { cancel, reason, signal } = cancellation();
    mockELink.mockResolvedValue(eLinkResponse([]));
    mockESummary.mockImplementation(cancel);

    await expect(run(signal, { relationship: 'similar' })).rejects.toBe(reason);
  });

  it('during a reference-coverage fallback: tries no further provider', async () => {
    const { cancel, reason, signal } = cancellation();
    mockELink.mockResolvedValue(eLinkResponse([], 'pubmed_pubmed_refs'));
    mockExtractBriefSummaries.mockResolvedValue([{ pmid: '12345', title: 'Source article.' }]);
    mockEpmcReferences.mockImplementation(cancel);

    await expect(run(signal, { relationship: 'references' })).rejects.toBe(reason);
    expect(mockOaReferences).not.toHaveBeenCalled();
  });

  it('during the row ESummary: returns no bare-PMID rows', async () => {
    const { cancel, reason, signal } = cancellation();
    mockELink.mockResolvedValue(eLinkResponse(['101', '102']));
    mockESummary.mockImplementation(cancel);

    await expect(run(signal, {})).rejects.toBe(reason);
  });
});

/**
 * One deadline for the whole call (#310). The handler starts it before any upstream
 * call; a step that another step can still follow takes half the time left as it
 * starts, and the last takes what remains. A step with no time left is never asked and
 * is reported not reached, apart from every failure label. Faked `Date` pins the
 * deadlines handed down; faked timers stand in for upstreams that never answer, each
 * rejecting with its provider's deadline reason as its deadline expires, as the
 * services do.
 */
describe('findRelatedTool call deadline (issue #310)', () => {
  const STARTED_AT = Date.UTC(2026, 0, 1);
  /** The call's own deadline at the default config. */
  const CALL = { expiresAt: STARTED_AT + 50_000, totalMs: 50_000 };
  const NOT_REACHED_ONE = "this call's deadline ran out before it was asked.";
  const NOT_REACHED_BOTH = "this call's deadline ran out before they were asked.";

  beforeEach(() => {
    mockELink.mockReset();
    mockESummary.mockReset();
    mockESummary.mockResolvedValue({ eSummaryResult: {} });
    mockExtractBriefSummaries.mockReset();
    mockExtractBriefSummaries.mockResolvedValue([]);
    mockEpmcCitations.mockReset();
    mockEpmcReferences.mockReset();
    mockOaSimilar.mockReset();
    mockOaCitedBy.mockReset();
    mockOaReferences.mockReset();
    mockGetEpmcService.mockReturnValue(epmcService);
    mockGetOaService.mockReturnValue(oaService);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** Moves the faked clock on, as an upstream call that took `ms` would. */
  const elapse = (ms: number) => vi.setSystemTime(Date.now() + ms);
  /** Runs the call's deadline out, as a step that overran its share would. */
  const spendCallDeadline = () => vi.setSystemTime(CALL.expiresAt);
  const failure = (code: JsonRpcErrorCode, message: string, reason: string) =>
    new McpError(code, message, { reason });
  const ncbiDown = () =>
    failure(JsonRpcErrorCode.ServiceUnavailable, 'NCBI down', 'ncbi_unreachable');

  /** An upstream that never answers: it rejects with `reason` as `deadline` expires. */
  const hangUntil = (deadline: CallDeadline, reason: string) =>
    new Promise<never>((_, reject) => {
      setTimeout(
        () =>
          reject(
            new McpError(JsonRpcErrorCode.Timeout, `deadline (${deadline.totalMs}ms) exceeded`, {
              reason,
              deadlineMs: deadline.totalMs,
            }),
          ),
        deadline.expiresAt - Date.now(),
      );
    });
  const ncbiHangs = (_params: unknown, options: { deadline: CallDeadline }) =>
    hangUntil(options.deadline, 'ncbi_deadline_exceeded');
  const epmcHangs = (...args: [string, number, number, AbortSignal, CallDeadline]) =>
    hangUntil(args[4], 'europepmc_deadline_exceeded');
  const openAlexHangs = (...args: [string, number, AbortSignal, CallDeadline]) =>
    hangUntil(args[3], 'openalex_deadline_exceeded');

  describe('the deadline each step is handed', () => {
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(STARTED_AT);
    });

    it('hands ELink and each fallback half the time left as it starts, and the row ESummary the rest, beside ctx.signal', async () => {
      mockELink.mockImplementation(async () => {
        elapse(10_000);
        throw ncbiDown();
      });
      mockEpmcCitations.mockImplementation(async () => {
        elapse(4_000);
        throw failure(JsonRpcErrorCode.ServiceUnavailable, 'EPMC down', 'europepmc_unreachable');
      });
      mockOaCitedBy.mockImplementation(async () => {
        elapse(1_000);
        return { pmids: ['777'], totalCount: 1 };
      });

      const ctx = createMockContext({ errors: findRelatedTool.errors });
      await findRelatedTool.handler(
        findRelatedTool.input.parse({ pmid: '12345', relationship: 'cited_by' }),
        ctx,
      );

      // ELink starts with 50 s left and a later step: half.
      expect(mockELink.mock.calls[0]?.[1]).toEqual({
        signal: ctx.signal,
        deadline: { expiresAt: STARTED_AT + 25_000, totalMs: 25_000 },
      });
      // Europe PMC starts at 10 s with 40 s left, OpenAlex at 14 s with 36 s left:
      // the row ESummary can still follow either.
      expect(mockEpmcCitations.mock.calls[0]?.slice(3)).toEqual([
        ctx.signal,
        { expiresAt: STARTED_AT + 30_000, totalMs: 20_000 },
      ]);
      expect(mockOaCitedBy.mock.calls[0]?.slice(2)).toEqual([
        ctx.signal,
        { expiresAt: STARTED_AT + 32_000, totalMs: 18_000 },
      ]);
      // The row ESummary is the last step: the call's own deadline.
      expect(mockESummary.mock.calls[0]?.[1]).toEqual({ signal: ctx.signal, deadline: CALL });
      for (const signal of [
        mockELink.mock.calls[0]?.[1].signal,
        mockEpmcCitations.mock.calls[0]?.[3],
        mockOaCitedBy.mock.calls[0]?.[2],
        mockESummary.mock.calls[0]?.[1].signal,
      ]) {
        expect(signal).toBe(ctx.signal);
      }
    });

    it('shares the deadline down the references coverage path', async () => {
      mockELink.mockImplementation(async () => {
        elapse(2_000);
        return eLinkResponse([], 'pubmed_pubmed_refs');
      });
      mockESummary.mockImplementation(async () => {
        elapse(2_000);
        return { eSummaryResult: {} };
      });
      mockExtractBriefSummaries
        .mockResolvedValueOnce([{ pmid: '12345', title: 'Source' }])
        .mockResolvedValue([]);
      mockEpmcReferences.mockImplementation(async () => {
        elapse(2_000);
        return { pmids: [], hitCount: 0, droppedNoPmid: 0 };
      });
      mockOaReferences.mockImplementation(async () => {
        elapse(2_000);
        return { pmids: ['888'], totalCount: 1 };
      });

      const ctx = createMockContext({ errors: findRelatedTool.errors });
      const result = await findRelatedTool.handler(
        findRelatedTool.input.parse({ pmid: '12345', relationship: 'references' }),
        ctx,
      );

      expect(result.articles.map((a) => a.pmid)).toEqual(['888']);
      expect(mockELink.mock.calls[0]?.[1].deadline).toEqual({
        expiresAt: STARTED_AT + 25_000,
        totalMs: 25_000,
      });
      // The source ESummary at 2 s, with a coverage check after it.
      expect(mockESummary.mock.calls[0]?.[1].deadline).toEqual({
        expiresAt: STARTED_AT + 26_000,
        totalMs: 24_000,
      });
      expect(mockEpmcReferences.mock.calls[0]?.[4]).toEqual({
        expiresAt: STARTED_AT + 27_000,
        totalMs: 23_000,
      });
      expect(mockOaReferences.mock.calls[0]?.[3]).toEqual({
        expiresAt: STARTED_AT + 28_000,
        totalMs: 22_000,
      });
      expect(mockESummary.mock.calls[1]?.[1].deadline).toEqual(CALL);
    });

    it.each(['similar', 'cited_by'] as const)(
      'hands the source ESummary of an empty %s set the call deadline itself: no coverage check follows that relationship, though both coverage providers are configured',
      async (relationship) => {
        mockELink.mockImplementation(async () => {
          elapse(2_000);
          return eLinkResponse([]);
        });
        mockExtractBriefSummaries.mockResolvedValue([{ pmid: '12345', title: 'Source' }]);

        const ctx = createMockContext({ errors: findRelatedTool.errors });
        await findRelatedTool.handler(
          findRelatedTool.input.parse({ pmid: '12345', relationship }),
          ctx,
        );

        expect(mockESummary).toHaveBeenCalledTimes(1);
        expect(mockESummary.mock.calls[0]?.[1]).toEqual({ signal: ctx.signal, deadline: CALL });
      },
    );

    /** The source ESummary's deadline 2 s in with a coverage check after it: half the 48 s left. */
    const SOURCE_SHARE = { expiresAt: STARTED_AT + 26_000, totalMs: 24_000 };

    it.each([
      ['the call deadline itself', 'neither coverage provider is configured', false, false, CALL],
      ['half the time left', 'only Europe PMC is configured', true, false, SOURCE_SHARE],
      ['half the time left', 'only OpenAlex is configured', false, true, SOURCE_SHARE],
    ] as const)(
      'hands the source ESummary of an empty references set %s when %s',
      async (_handed, _configured, epmcConfigured, openAlexConfigured, expected) => {
        if (!epmcConfigured) mockGetEpmcService.mockReturnValue(undefined);
        if (!openAlexConfigured) mockGetOaService.mockReturnValue(undefined);
        mockELink.mockImplementation(async () => {
          elapse(2_000);
          return eLinkResponse([], 'pubmed_pubmed_refs');
        });
        mockExtractBriefSummaries.mockResolvedValue([{ pmid: '12345', title: 'Source' }]);
        mockEpmcReferences.mockResolvedValue({ pmids: [], hitCount: 0, droppedNoPmid: 0 });
        mockOaReferences.mockResolvedValue({
          pmids: [],
          totalCount: 0,
          droppedNoPmid: 0,
          reachCapped: false,
        });

        const ctx = createMockContext({ errors: findRelatedTool.errors });
        await findRelatedTool.handler(
          findRelatedTool.input.parse({ pmid: '12345', relationship: 'references' }),
          ctx,
        );

        expect(mockESummary).toHaveBeenCalledTimes(1);
        expect(mockESummary.mock.calls[0]?.[1]).toEqual({ signal: ctx.signal, deadline: expected });
      },
    );

    it.each([
      ['cited_by', mockEpmcCitations],
      ['references', mockEpmcReferences],
    ] as const)(
      'hands every page of one Europe PMC %s step the one deadline it started with',
      async (relationship, pages) => {
        mockELink.mockRejectedValue(ncbiDown());
        pages
          .mockImplementationOnce(async () => {
            elapse(1_000);
            return {
              pmids: Array.from({ length: 80 }, (_, i) => String(1000 + i)),
              hitCount: 2055,
              droppedNoPmid: 5,
            };
          })
          .mockResolvedValueOnce({
            pmids: Array.from({ length: 84 }, (_, i) => String(2000 + i)),
            hitCount: 2055,
            droppedNoPmid: 1,
          });

        await findRelatedTool.handler(
          findRelatedTool.input.parse({ pmid: '12345', relationship, maxResults: 5, offset: 80 }),
          createMockContext({ errors: findRelatedTool.errors }),
        );

        expect(pages).toHaveBeenCalledTimes(2);
        expect(pages.mock.calls[0]?.[4]).toEqual({
          expiresAt: STARTED_AT + 25_000,
          totalMs: 25_000,
        });
        expect(pages.mock.calls[1]?.[4]).toBe(pages.mock.calls[0]?.[4]);
      },
    );
  });

  describe('every upstream hung', () => {
    beforeEach(() => {
      vi.useFakeTimers({ now: STARTED_AT });
    });

    /** Runs the handler to settlement on the faked clock, and when it settled. */
    async function settle(args: Record<string, unknown>) {
      const ctx = createMockContext({ errors: findRelatedTool.errors });
      let settledAt = Number.NaN;
      let result: Awaited<ReturnType<typeof findRelatedTool.handler>> | undefined;
      let error: unknown;
      const settled = Promise.resolve(
        findRelatedTool.handler(findRelatedTool.input.parse({ pmid: '12345', ...args }), ctx),
      )
        .then(
          (value) => {
            result = value;
          },
          (thrown: unknown) => {
            error = thrown;
          },
        )
        .finally(() => {
          settledAt = Date.now() - STARTED_AT;
        });
      await vi.runAllTimersAsync();
      await settled;
      return { ctx, error, result, settledAt };
    }

    const hangEverything = () => {
      mockELink.mockImplementation(ncbiHangs);
      mockESummary.mockImplementation(ncbiHangs);
      mockEpmcCitations.mockImplementation(epmcHangs);
      mockEpmcReferences.mockImplementation(epmcHangs);
      mockOaSimilar.mockImplementation(openAlexHangs);
      mockOaCitedBy.mockImplementation(openAlexHangs);
      mockOaReferences.mockImplementation(openAlexHangs);
    };

    const cuts = {
      similar: [
        ['ncbi', 'ncbi_deadline_exceeded', 25_000],
        ['openalex', 'openalex_deadline_exceeded', 12_500],
      ],
      chain: [
        ['ncbi', 'ncbi_deadline_exceeded', 25_000],
        ['europepmc', 'europepmc_deadline_exceeded', 12_500],
        ['openalex', 'openalex_deadline_exceeded', 6_250],
      ],
    } as const;

    it.each([
      ['similar', 37_500, cuts.similar],
      ['cited_by', 43_750, cuts.chain],
      ['references', 43_750, cuts.chain],
    ] as const)(
      'settles an all-hung %s call at %d ms with all_providers_failed, each provider cut by its share',
      async (relationship, at, expected) => {
        hangEverything();

        const { error, settledAt } = await settle({ relationship });

        expect(settledAt).toBe(at);
        expect(error).toBeInstanceOf(McpError);
        const data = failureData(error as McpError);
        expect(data.reason).toBe('all_providers_failed');
        expect(data.attempted).toEqual(
          expected.map(([provider, reason, ms]) => ({
            provider,
            reason,
            message: `deadline (${ms}ms) exceeded`,
          })),
        );
        expect(mockESummary).not.toHaveBeenCalled();
      },
    );

    it('serves Europe PMC’s rows when NCBI hangs, and degrades the hung row ESummary at the call deadline', async () => {
      hangEverything();
      mockEpmcCitations.mockResolvedValue({ pmids: ['333', '444'], hitCount: 2, droppedNoPmid: 0 });

      const { ctx, result, settledAt } = await settle({ relationship: 'cited_by' });

      expect(settledAt).toBe(50_000);
      expect(getEnrichment(ctx).source).toBe('europepmc');
      expect(result?.articles).toEqual([
        { pmid: '333', pubmedUrl: 'https://pubmed.ncbi.nlm.nih.gov/333/' },
        { pmid: '444', pubmedUrl: 'https://pubmed.ncbi.nlm.nih.gov/444/' },
      ]);
      expect(String(getEnrichment(ctx).notice)).toContain('NCBI eSummary did not respond');
      expect(mockOaCitedBy).not.toHaveBeenCalled();
    });

    it('reports both reference-coverage providers cut by their shares, still retryable', async () => {
      hangEverything();
      mockELink.mockResolvedValue(eLinkResponse([], 'pubmed_pubmed_refs'));
      mockESummary.mockResolvedValue({ eSummaryResult: {} });
      mockExtractBriefSummaries.mockResolvedValue([{ pmid: '12345', title: 'Source' }]);

      const { ctx, result, settledAt } = await settle({ relationship: 'references' });

      expect(settledAt).toBe(37_500);
      expect(result?.articles).toEqual([]);
      expect(getEnrichment(ctx).coverageFailures).toEqual([
        { provider: 'europepmc', reason: 'europepmc_deadline_exceeded', retryable: true },
        { provider: 'openalex', reason: 'openalex_deadline_exceeded', retryable: true },
      ]);
    });
  });

  describe('a step with no time left', () => {
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(STARTED_AT);
    });

    it('reports the fallbacks the deadline never reached as not_reached on both surfaces, and never asks them', async () => {
      mockELink.mockImplementation(async () => {
        spendCallDeadline();
        throw failure(
          JsonRpcErrorCode.Timeout,
          'NCBI request deadline (25000ms) exceeded',
          'ncbi_deadline_exceeded',
        );
      });

      const result = await runToolContract(findRelatedTool, {
        pmid: '12345',
        relationship: 'cited_by',
      });

      expect(result.isError).toBe(true);
      const data = (result.structuredContent as { error: { data: AllProvidersFailedData } }).error
        .data;
      expect(data.attempted).toEqual([
        {
          provider: 'ncbi',
          reason: 'ncbi_deadline_exceeded',
          message: 'NCBI request deadline (25000ms) exceeded',
        },
        {
          provider: 'europepmc',
          reason: 'not_reached',
          message: `Europe PMC was not reached: ${NOT_REACHED_ONE}`,
        },
        {
          provider: 'openalex',
          reason: 'not_reached',
          message: `OpenAlex was not reached: ${NOT_REACHED_ONE}`,
        },
      ]);
      const hint = `Providers attempted: NCBI (ncbi_deadline_exceeded). Retry the transient failures after a brief delay. Europe PMC and OpenAlex were not reached: ${NOT_REACHED_BOTH}`;
      expect(data.recovery?.hint).toBe(hint);
      const text = contractText(result);
      expect(text).toContain(`Recovery: ${hint}`);
      expect(text).not.toContain('(not_reached)');
      expect(mockEpmcCitations).not.toHaveBeenCalled();
      expect(mockOaCitedBy).not.toHaveBeenCalled();
    });

    it('names a provider its share cut beside the one the deadline never reached', async () => {
      mockELink.mockRejectedValue(ncbiDown());
      mockEpmcCitations.mockImplementation(async () => {
        spendCallDeadline();
        throw failure(
          JsonRpcErrorCode.Timeout,
          'Europe PMC request deadline (25000ms) exceeded',
          'europepmc_deadline_exceeded',
        );
      });

      const error = await rejection(
        findRelatedTool.input.parse({ pmid: '12345', relationship: 'cited_by' }),
        createMockContext({ errors: findRelatedTool.errors }),
      );

      expect(failureData(error).attempted.map((a) => a.reason)).toEqual([
        'ncbi_unreachable',
        'europepmc_deadline_exceeded',
        'not_reached',
      ]);
      expect(failureData(error).recovery?.hint).toBe(
        `Providers attempted: NCBI (ncbi_unreachable), Europe PMC (europepmc_deadline_exceeded). Retry the transient failures after a brief delay. OpenAlex was not reached: ${NOT_REACHED_ONE}`,
      );
      expect(mockOaCitedBy).not.toHaveBeenCalled();
    });

    it('reports reference-coverage providers the deadline never reached as not_reached on both surfaces, and never asks them', async () => {
      mockELink.mockResolvedValue(eLinkResponse([], 'pubmed_pubmed_refs'));
      mockESummary.mockImplementation(async () => {
        spendCallDeadline();
        return { eSummaryResult: {} };
      });
      mockExtractBriefSummaries.mockResolvedValue([{ pmid: '12345', title: 'Source' }]);

      const result = await runToolContract(findRelatedTool, {
        pmid: '12345',
        relationship: 'references',
      });

      const structured = result.structuredContent as {
        articles: unknown[];
        coverageFailures?: unknown[];
        notice?: string;
      };
      expect(structured.articles).toEqual([]);
      expect(structured.coverageFailures).toEqual([
        { provider: 'europepmc', reason: 'not_reached', retryable: true },
        { provider: 'openalex', reason: 'not_reached', retryable: true },
      ]);
      const notice = `No reference list available for PMID 12345 via NCBI. Use pubmed_fetch_articles to inspect the article record, or try relationship: "similar" / "cited_by". Reference coverage could not be fully checked — Europe PMC and OpenAlex were not reached: ${NOT_REACHED_BOTH}`;
      expect(structured.notice).toBe(notice);
      const text = contractText(result);
      expect(text).toContain(`> ${notice}`);
      expect(text).toContain(
        '**Coverage not checked:** Europe PMC (not_reached, retryable), OpenAlex (not_reached, retryable)',
      );
      expect(mockEpmcReferences).not.toHaveBeenCalled();
      expect(mockOaReferences).not.toHaveBeenCalled();
    });

    it('separates a coverage provider its share cut from one the deadline never reached', async () => {
      mockELink.mockResolvedValue(eLinkResponse([], 'pubmed_pubmed_refs'));
      mockExtractBriefSummaries.mockResolvedValue([{ pmid: '12345', title: 'Source' }]);
      mockEpmcReferences.mockImplementation(async () => {
        spendCallDeadline();
        throw failure(
          JsonRpcErrorCode.Timeout,
          'Europe PMC request deadline (25000ms) exceeded',
          'europepmc_deadline_exceeded',
        );
      });

      const ctx = createMockContext({ errors: findRelatedTool.errors });
      await findRelatedTool.handler(
        findRelatedTool.input.parse({ pmid: '12345', relationship: 'references' }),
        ctx,
      );

      expect(getEnrichment(ctx).coverageFailures).toEqual([
        { provider: 'europepmc', reason: 'europepmc_deadline_exceeded', retryable: true },
        { provider: 'openalex', reason: 'not_reached', retryable: true },
      ]);
      expect(String(getEnrichment(ctx).notice)).toContain(
        `Reference coverage could not be fully checked — Europe PMC (europepmc_deadline_exceeded) did not answer. Retry after a brief delay to complete the coverage check. OpenAlex was not reached: ${NOT_REACHED_ONE}`,
      );
      expect(mockOaReferences).not.toHaveBeenCalled();
    });

    /** Turns one fallback off by configuration: Europe PMC disabled, or OpenAlex unset. */
    const turnOff = {
      'Europe PMC': () => mockGetEpmcService.mockReturnValue(undefined),
      OpenAlex: () => mockGetOaService.mockReturnValue(undefined),
    } as const;

    it.each([
      [
        'Europe PMC',
        [
          {
            provider: 'europepmc',
            reason: 'provider_disabled',
            message: 'Europe PMC is turned off by server configuration.',
          },
          {
            provider: 'openalex',
            reason: 'not_reached',
            message: `OpenAlex was not reached: ${NOT_REACHED_ONE}`,
          },
        ],
        `Providers attempted: NCBI (ncbi_deadline_exceeded), Europe PMC (provider_disabled). Retry the transient failures after a brief delay. Europe PMC is turned off by server configuration and will not recover on retry. OpenAlex was not reached: ${NOT_REACHED_ONE}`,
      ],
      [
        'OpenAlex',
        [
          {
            provider: 'europepmc',
            reason: 'not_reached',
            message: `Europe PMC was not reached: ${NOT_REACHED_ONE}`,
          },
          {
            provider: 'openalex',
            reason: 'provider_disabled',
            message: 'OpenAlex is not configured on this server.',
          },
        ],
        `Providers attempted: NCBI (ncbi_deadline_exceeded), OpenAlex (provider_disabled). Retry the transient failures after a brief delay. OpenAlex is turned off by server configuration and will not recover on retry. Europe PMC was not reached: ${NOT_REACHED_ONE}`,
      ],
    ] as const)(
      'reports a fallback %s that configuration turned off as provider_disabled on both surfaces, never not_reached, when the deadline ran out before it',
      async (disabled, fallbacks, hint) => {
        turnOff[disabled]();
        mockELink.mockImplementation(async () => {
          spendCallDeadline();
          throw failure(
            JsonRpcErrorCode.Timeout,
            'NCBI request deadline (25000ms) exceeded',
            'ncbi_deadline_exceeded',
          );
        });

        const result = await runToolContract(findRelatedTool, {
          pmid: '12345',
          relationship: 'cited_by',
        });

        expect(result.isError).toBe(true);
        const data = (result.structuredContent as { error: { data: AllProvidersFailedData } }).error
          .data;
        expect(data.attempted).toEqual([
          {
            provider: 'ncbi',
            reason: 'ncbi_deadline_exceeded',
            message: 'NCBI request deadline (25000ms) exceeded',
          },
          ...fallbacks,
        ]);
        expect(data.recovery?.hint).toBe(hint);
        expect(contractText(result)).toContain(`Recovery: ${hint}`);
        expect(mockEpmcCitations).not.toHaveBeenCalled();
        expect(mockOaCitedBy).not.toHaveBeenCalled();
      },
    );

    it.each([
      [
        'Europe PMC',
        [
          { provider: 'europepmc', reason: 'provider_disabled', retryable: false },
          { provider: 'openalex', reason: 'not_reached', retryable: true },
        ],
        `Europe PMC (provider_disabled) did not answer. Europe PMC is turned off by server configuration and will not recover on retry. OpenAlex was not reached: ${NOT_REACHED_ONE}`,
        '**Coverage not checked:** Europe PMC (provider_disabled, not retryable), OpenAlex (not_reached, retryable)',
      ],
      [
        'OpenAlex',
        [
          { provider: 'europepmc', reason: 'not_reached', retryable: true },
          { provider: 'openalex', reason: 'provider_disabled', retryable: false },
        ],
        `OpenAlex (provider_disabled) did not answer. OpenAlex is turned off by server configuration and will not recover on retry. Europe PMC was not reached: ${NOT_REACHED_ONE}`,
        '**Coverage not checked:** Europe PMC (not_reached, retryable), OpenAlex (provider_disabled, not retryable)',
      ],
    ] as const)(
      'reports a reference-coverage %s that configuration turned off as provider_disabled and not retryable on both surfaces, never not_reached, when the deadline ran out before it',
      async (disabled, coverageFailures, outcomes, trailer) => {
        turnOff[disabled]();
        mockELink.mockResolvedValue(eLinkResponse([], 'pubmed_pubmed_refs'));
        mockESummary.mockImplementation(async () => {
          spendCallDeadline();
          return { eSummaryResult: {} };
        });
        mockExtractBriefSummaries.mockResolvedValue([{ pmid: '12345', title: 'Source' }]);

        const result = await runToolContract(findRelatedTool, {
          pmid: '12345',
          relationship: 'references',
        });

        const structured = result.structuredContent as {
          coverageFailures?: unknown[];
          notice?: string;
        };
        expect(structured.coverageFailures).toEqual(coverageFailures);
        const notice = `No reference list available for PMID 12345 via NCBI. Use pubmed_fetch_articles to inspect the article record, or try relationship: "similar" / "cited_by". Reference coverage could not be fully checked — ${outcomes}`;
        expect(structured.notice).toBe(notice);
        const text = contractText(result);
        expect(text).toContain(`> ${notice}`);
        expect(text).toContain(trailer);
        expect(mockEpmcReferences).not.toHaveBeenCalled();
        expect(mockOaReferences).not.toHaveBeenCalled();
      },
    );

    it('returns bare rows with a notice of their own when no time is left for the row ESummary, and never asks it', async () => {
      mockELink.mockImplementation(async () => {
        spendCallDeadline();
        return eLinkResponse(['101', '102']);
      });

      const result = await runToolContract(findRelatedTool, { pmid: '12345' });

      const structured = result.structuredContent as { articles: unknown[]; notice?: string };
      expect(structured.articles).toEqual([
        { pmid: '101', pubmedUrl: 'https://pubmed.ncbi.nlm.nih.gov/101/' },
        { pmid: '102', pubmedUrl: 'https://pubmed.ncbi.nlm.nih.gov/102/' },
      ]);
      const notice =
        "Article metadata was not fetched — this call's deadline ran out before NCBI eSummary was asked; returning related PMIDs only. Use pubmed_fetch_articles for full metadata.";
      expect(structured.notice).toBe(notice);
      expect(contractText(result)).toContain(`> ${notice}`);
      expect(mockESummary).not.toHaveBeenCalled();
    });

    /** A caller abort that lands as the deadline runs out, in the step before `next`. */
    it.each([
      [
        'the OpenAlex fallback',
        () => {
          mockELink.mockRejectedValue(ncbiDown());
          return mockEpmcCitations;
        },
        { pmids: [], hitCount: 0, droppedNoPmid: 0 },
      ],
      ['the row ESummary', () => mockELink, eLinkResponse(['101'])],
    ] as const)(
      'rethrows a caller abort, never a not-reached outcome, when no time is left for %s',
      async (_next, stepBefore, answer) => {
        const controller = new AbortController();
        const reason = new DOMException('The caller cancelled the request.', 'AbortError');
        stepBefore().mockImplementation(async () => {
          spendCallDeadline();
          controller.abort(reason);
          return answer;
        });

        await expect(
          findRelatedTool.handler(
            findRelatedTool.input.parse({ pmid: '12345', relationship: 'cited_by' }),
            createMockContext({ errors: findRelatedTool.errors, signal: controller.signal }),
          ),
        ).rejects.toBe(reason);
        expect(mockOaCitedBy).not.toHaveBeenCalled();
        expect(mockESummary).not.toHaveBeenCalled();
      },
    );
  });
});
