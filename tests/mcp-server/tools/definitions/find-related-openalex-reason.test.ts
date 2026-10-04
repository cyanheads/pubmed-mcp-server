/**
 * @fileoverview `pubmed_find_related` over the real OpenAlex service and client, with
 * only `fetch` faked: an OpenAlex body that is not JSON reaches the tool as
 * `openalex_invalid_response` once retries run out — in `data.attempted[]` of a fully
 * failed chain and in the `coverageFailures` of a references coverage check (#182).
 * NCBI and Europe PMC are stubbed at their accessors to route the chain.
 * @module tests/mcp-server/tools/definitions/find-related-openalex-reason.test
 */

import type { ContentBlock } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest';

import type { ParsedBriefSummary } from '@/services/ncbi/types.js';
import type { OpenAlexService as OpenAlexServiceType } from '@/services/openalex/openalex-service.js';

import { textBlocks } from '../../../_helpers.js';

const mockELink = vi.fn();
const mockESummary = vi.fn();
const mockExtractBriefSummaries = vi.fn((): Promise<ParsedBriefSummary[]> => Promise.resolve([]));
const mockEpmcReferences = vi.fn();
let openAlex: OpenAlexServiceType | undefined;

vi.mock('@/services/ncbi/ncbi-service.js', () => ({
  getNcbiService: () => ({ eLink: mockELink, eSummary: mockESummary }),
}));
vi.mock('@/services/ncbi/parsing/esummary-parser.js', () => ({
  extractBriefSummaries: mockExtractBriefSummaries,
}));
vi.mock('@/services/europe-pmc/europe-pmc-service.js', () => ({
  getEuropePmcService: () => ({ references: mockEpmcReferences }),
}));
vi.mock('@/services/openalex/openalex-service.js', async () => {
  const actual = await vi.importActual<typeof import('@/services/openalex/openalex-service.js')>(
    '@/services/openalex/openalex-service.js',
  );
  return { ...actual, getOpenAlexServiceOptional: () => openAlex };
});

const { OpenAlexService } = await import('@/services/openalex/openalex-service.js');
const { OpenAlexApiClient } = await import('@/services/openalex/api-client.js');
const { findRelatedTool } = await import('@/mcp-server/tools/definitions/find-related.tool.js');

/** One retry after the initial attempt. */
const MAX_RETRIES = 1;
const realSetTimeout = globalThis.setTimeout;
let fetchSpy: MockInstance<typeof fetch>;

/** Every OpenAlex request answers HTTP 200 with an HTML page. */
function openAlexAnswersHtml(): void {
  fetchSpy.mockImplementation(async (input) => {
    const url = input instanceof Request ? input.url : String(input);
    if (!url.startsWith('https://api.openalex.org/')) throw new Error(`unrouted fetch: ${url}`);
    return new Response('<html>oops</html>', {
      status: 200,
      headers: { 'Content-Type': 'text/html' },
    });
  });
}

function textOf(result: Awaited<ReturnType<typeof runToolContract>>): string {
  return textBlocks(result.content as ContentBlock[])
    .map((b) => b.text)
    .join('\n');
}

beforeEach(() => {
  mockELink.mockReset();
  mockESummary.mockReset();
  mockExtractBriefSummaries.mockReset();
  mockEpmcReferences.mockReset();
  fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('unmocked fetch'));
  // Fire the retry backoff at once; the request timeout keeps its real timer.
  vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void, ms?: number) => {
    if (typeof ms === 'number' && ms < 15_000) {
      fn();
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }
    return realSetTimeout(fn, ms);
  }) as unknown as typeof setTimeout);
  openAlex = new OpenAlexService(new OpenAlexApiClient({ timeoutMs: 20_000 }), MAX_RETRIES);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('pubmed_find_related reports an OpenAlex non-JSON body as openalex_invalid_response (#182)', () => {
  it('names it in data.attempted[] when every provider fails', async () => {
    mockELink.mockRejectedValue(
      new McpError(JsonRpcErrorCode.ServiceUnavailable, 'NCBI down', {
        reason: 'ncbi_unreachable',
      }),
    );
    openAlexAnswersHtml();

    const result = await runToolContract(findRelatedTool, {
      pmid: '31452104',
      relationship: 'similar',
    });

    expect(result.isError).toBe(true);
    const error = (
      result.structuredContent as {
        error: { code: number; data: { reason: string; attempted: unknown[] } };
      }
    ).error;
    expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(error.data.reason).toBe('all_providers_failed');
    expect(error.data.attempted).toEqual([
      { provider: 'ncbi', reason: 'ncbi_unreachable', message: 'NCBI down' },
      {
        provider: 'openalex',
        reason: 'openalex_invalid_response',
        message: 'OpenAlex returned a non-JSON body. (failed after 2 attempts)',
      },
    ]);
    expect(textOf(result)).toContain('openalex_invalid_response');
    expect(fetchSpy).toHaveBeenCalledTimes(MAX_RETRIES + 1);
  });

  it('names it in coverageFailures, retryable, on a references coverage check', async () => {
    // NCBI answers an empty reference list for a valid non-PMC source, Europe PMC
    // answers empty, and OpenAlex cannot be parsed.
    mockELink.mockResolvedValue({ eLinkResult: [{ LinkSet: {} }] });
    mockESummary.mockResolvedValue({ eSummaryResult: {} });
    mockExtractBriefSummaries.mockResolvedValue([{ pmid: '39248309', title: 'Non-PMC source' }]);
    mockEpmcReferences.mockResolvedValue({
      pmids: [],
      totalCount: 0,
      hitCount: 0,
      droppedNoPmid: 0,
    });
    openAlexAnswersHtml();

    const result = await runToolContract(findRelatedTool, {
      pmid: '39248309',
      relationship: 'references',
    });

    expect(result.isError).toBeFalsy();
    const structured = result.structuredContent as {
      articles: unknown[];
      coverageFailures?: unknown[];
      notice?: string;
    };
    expect(structured.articles).toEqual([]);
    expect(structured.coverageFailures).toEqual([
      { provider: 'openalex', reason: 'openalex_invalid_response', retryable: true },
    ]);
    expect(structured.notice).toContain('OpenAlex (openalex_invalid_response) did not answer');
    expect(textOf(result)).toContain('OpenAlex (openalex_invalid_response)');
    expect(fetchSpy).toHaveBeenCalledTimes(MAX_RETRIES + 1);
  });
});
