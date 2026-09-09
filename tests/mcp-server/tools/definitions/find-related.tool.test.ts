/**
 * @fileoverview Tests for the find-related tool — offset pagination (#36) and
 * multi-source provider fallback (#63).
 * @module tests/mcp-server/tools/definitions/find-related.tool.test
 */

import type { ContentBlock } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ParsedBriefSummary } from '@/services/ncbi/types.js';

import { textBlocks } from '../../../_helpers.js';

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

  it('format() header includes "Returned: N | Offset: Z"', () => {
    const blocks = textBlocks(
      findRelatedTool.format!({
        sourcePmid: '12345',
        relationship: 'similar',
        offset: 5,
        articles: [{ pmid: '111', title: 'A', authors: 'B', source: 'C', pubDate: '2024' }],
      }),
    );
    const text = blocks[0]?.text ?? '';
    expect(text).toContain('**Returned:** 1');
    expect(text).toContain('**Offset:** 5');
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
    expect(getEnrichment(ctx).totalCount).toBe(2); // a page shorter than requested exhausts upstream, so the total is exact
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
    expect(getEnrichment(ctx).totalCount).toBe(0);
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
    expect(getEnrichment(ctx).totalCount).toBe(0);
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
      expect(getEnrichment(ctx).totalCount).toBe(1003);
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
      expect(getEnrichment(ctx).totalCount).toBe(2055);
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
      await findRelatedTool.handler(input, ctx);

      const notice = String(getEnrichment(ctx).notice);
      expect(notice).toContain('6');
      expect(notice).toContain('no PubMed PMID');
      expect(getEnrichment(ctx).totalCount).toBe(2);
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
    expect(getEnrichment(ctx).totalCount).toBe(0);
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

      expect(getEnrichment(ctx).totalCount).toBe(0);
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
      await findRelatedTool.handler(input, ctx);

      expect(getEnrichment(ctx).totalCount).toBe(0);
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
      { db: 'pubmed', id: '222,111' },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(getEnrichment(ctx).totalCount).toBe(2);
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
    await findRelatedTool.handler(input, ctx);

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
    expect(getEnrichment(ctx).totalCount).toBe(0);
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
      expect(getEnrichment(ctx).totalCount).toBe(2); // a page shorter than requested exhausts upstream, so the total is exact
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
      await findRelatedTool.handler(input, ctx);

      // EPMC + OpenAlex were both consulted before giving up.
      expect(mockEpmcReferences).toHaveBeenCalled();
      expect(mockOaReferences).toHaveBeenCalled();
      expect(getEnrichment(ctx).totalCount).toBe(0);
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
      await findRelatedTool.handler(input, ctx);

      expect(getEnrichment(ctx).totalCount).toBe(0);
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

      expect(getEnrichment(ctx).totalCount).toBe(0);
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
      await findRelatedTool.handler(input, ctx);

      expect(getEnrichment(ctx).totalCount).toBe(0);
      expect(getEnrichment(ctx).notice).toBeUndefined();
    });
  });
});
