/**
 * @fileoverview Tests for the find-related tool — offset pagination (#36),
 * multi-source provider fallback (#63), the total match count in the header on
 * every return path (#147), Doc Type rendering (#146), and the label an
 * exhausted OpenAlex or Europe PMC Timeout or RateLimited reports — named by its
 * code — in the coverage summary and the all-providers-failed attempts (#160).
 * @module tests/mcp-server/tools/definitions/find-related.tool.test
 */

import type { ContentBlock } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ESummaryResult, ParsedBriefSummary } from '@/services/ncbi/types.js';

import { textBlocks } from '../../../_helpers.js';
import {
  BOOK_ESUMMARY_V1_XML,
  BOOK_ESUMMARY_XML,
  parseESummaryXml,
} from '../../../services/ncbi/parsing/_book-fixtures.js';

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

    expect(getEnrichment(ctx).notice).toContain('Offset 10 exceeds totalCount');
    expect(getEnrichment(ctx).notice).toContain('3');
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
        articles: [{ pmid: '111', title: 'A', authors: 'B', source: 'C', pubDate: '2024' }],
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
    expect(getEnrichment(ctx).notice).not.toContain('All providers failed');
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
    expect(getEnrichment(ctx).notice).not.toContain('All providers failed');
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

  it('all_providers_failed omits a provider excluded by epmcSupports (issue #103)', async () => {
    mockELink.mockRejectedValue(
      new McpError(JsonRpcErrorCode.ServiceUnavailable, 'NCBI down', {
        reason: 'ncbi_unreachable',
      }),
    );
    mockOaSimilar.mockRejectedValue(
      new McpError(JsonRpcErrorCode.SerializationError, 'OA garbage', {
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
      articles: [{ pmid: '2', title: '[click](https://example.test)', authors: 'A *B and C *D' }],
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
    expect(result.articles).toEqual([{ pmid: '333' }, { pmid: '444' }]);
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

      expect(mockEpmcCitations).toHaveBeenCalledWith('12345', 130, 1, expect.any(AbortSignal));
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
      );
      expect(mockEpmcReferences).toHaveBeenNthCalledWith(
        2,
        '12345',
        1000,
        2,
        expect.any(AbortSignal),
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

      expect(mockEpmcCitations).toHaveBeenNthCalledWith(1, '12345', 85, 1, expect.any(AbortSignal));
      expect(mockEpmcCitations).toHaveBeenNthCalledWith(2, '12345', 85, 2, expect.any(AbortSignal));
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
      expect(structured.notice).toContain('stopped after 10 pages');
      expect(structured.notice).toContain('lower the offset');
      const text = textBlocks(result.content as ContentBlock[])
        .map((b) => b.text)
        .join('\n');
      expect(text).toContain('lower the offset');
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

      const notice = String(getEnrichment(ctx).notice);
      expect(notice).toContain('6');
      expect(notice).toContain('no PubMed PMID');
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
      expect(structured.notice).toContain('OpenAlex paging stopped after 10 pages');
      expect(structured.notice).toContain('lower the offset');
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

      expect(mockOaReferences).toHaveBeenCalledWith('37952131', 145, expect.any(AbortSignal));
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
        new McpError(JsonRpcErrorCode.SerializationError, 'OA garbage', {
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
          new OpenAlexService(new OpenAlexApiClient({ timeoutMs: 20_000 }), 0),
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

    /**
     * The same labels through the real Europe PMC service and its pacer. A 429
     * whose Retry-After outlasts the backoff cap fails on its first attempt with
     * no reason at all, so it too is named by its code.
     */
    it.each([
      ['exhausted 504', 'timed_out', { status: 504 }],
      ['exhausted 429', 'rate_limited', { status: 429, headers: { 'retry-after': '5' } }],
      [
        '429 with a Retry-After past the backoff cap',
        'rate_limited',
        { status: 429, headers: { 'retry-after': '120' } },
      ],
    ])('labels a Europe PMC %s as %s, still retryable', async (_label, reason, init) => {
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
        ),
      );
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
        expect(fetchSpy).toHaveBeenCalledTimes(1);
      } finally {
        fetchSpy.mockRestore();
      }
    });

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
      },
      {
        pmid: '111',
        title: 'Second Related Article',
        authors: 'Smith J',
        source: 'Nature',
        pubDate: '2024',
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
          },
        ],
      }),
    );
    expect(blocks[0]?.text).toContain('Related Articles');
    expect(blocks[0]?.text).toContain('12345');
    expect(blocks[0]?.text).toContain('Related Article');
    expect(blocks[0]?.text).toContain('*Smith J*');
    expect(blocks[0]?.text).toContain('Nature, 2024');
  });

  it('formats output with no articles', () => {
    const blocks = textBlocks(
      findRelatedTool.format!({
        sourcePmid: '12345',
        relationship: 'cited_by',
        offset: 0,
        totalCount: 0,
        articles: [],
      }),
    );
    expect(blocks[0]?.text).toContain('No related articles');
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
    expect(text).toContain(
      'GeneReviews(®) — University of Washington, Seattle, chapter, 1993-01-01',
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
    expect(contractText(result)).toContain('**Source:** openalex');
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
