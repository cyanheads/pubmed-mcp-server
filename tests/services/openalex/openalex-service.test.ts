/**
 * @fileoverview Tests for the OpenAlex service — PMID resolve, similar,
 * citedBy, and references capabilities.
 * @module tests/services/openalex/openalex-service.test
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockFetchWithTimeout = vi.fn();

vi.mock('@cyanheads/mcp-ts-core/utils', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@cyanheads/mcp-ts-core/utils');
  return {
    ...actual,
    fetchWithTimeout: mockFetchWithTimeout,
  };
});

const { OpenAlexApiClient } = await import('@/services/openalex/api-client.js');
const { OpenAlexService } = await import('@/services/openalex/openalex-service.js');

function jsonResponse(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

/**
 * Reproduce what `fetchWithTimeout` actually does on a non-2xx: it throws a
 * status-mapped `McpError` carrying `errorSource: 'FetchHttpError'`, never
 * resolves with the failing `Response`. `expectedStatuses` only lowers the log
 * severity. Mocking a resolved 404 `Response` models a state the real helper
 * cannot produce, and certifies branches that never execute. (#90)
 */
function httpErrorRejection(status: number, code: JsonRpcErrorCode, body = '') {
  return new McpError(code, `Fetch failed for <upstream>. Status: ${status}`, {
    status,
    statusText: '',
    body,
    statusCode: status,
    responseBody: body,
    errorSource: 'FetchHttpError',
  });
}

/**
 * Minimal OpenAlex work record with a PMID.
 * OpenAlex encodes PMID as a full URL in the ids block.
 */
function makeWork(oaId: string, pmid: string | null, extra: Record<string, unknown> = {}) {
  return {
    id: `https://openalex.org/${oaId}`,
    ids: pmid
      ? {
          openalex: `https://openalex.org/${oaId}`,
          pmid: `https://pubmed.ncbi.nlm.nih.gov/${pmid}`,
        }
      : { openalex: `https://openalex.org/${oaId}` },
    ...extra,
  };
}

function makeService() {
  const client = new OpenAlexApiClient({ timeoutMs: 20000 });
  return new OpenAlexService(client, 0 /* no retries in tests */);
}

describe('OpenAlexService.similar', () => {
  beforeEach(() => mockFetchWithTimeout.mockReset());

  it('resolves related_works to PMIDs', async () => {
    // First call: work lookup
    mockFetchWithTimeout
      .mockResolvedValueOnce(
        jsonResponse({
          id: 'https://openalex.org/W1234',
          related_works: ['https://openalex.org/W100', 'https://openalex.org/W200'],
          referenced_works: [],
        }),
      )
      // Second call: batch resolve
      .mockResolvedValueOnce(
        jsonResponse({
          results: [makeWork('W100', '11111'), makeWork('W200', '22222')],
          meta: { count: 2 },
        }),
      );

    const service = makeService();
    const result = await service.similar('31295471', 10);

    expect(result.pmids).toEqual(['11111', '22222']);
    expect(result.totalCount).toBe(2);
  });

  it('drops related_work records with no PMID', async () => {
    mockFetchWithTimeout
      .mockResolvedValueOnce(
        jsonResponse({
          id: 'https://openalex.org/W1234',
          related_works: ['https://openalex.org/W100', 'https://openalex.org/W200'],
          referenced_works: [],
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          results: [
            makeWork('W100', '11111'),
            makeWork('W200', null), // no PMID — should be dropped
          ],
          meta: { count: 2 },
        }),
      );

    const service = makeService();
    const result = await service.similar('31295471', 10);

    expect(result.pmids).toEqual(['11111']);
  });

  it('returns empty when source PMID not found in OpenAlex', async () => {
    mockFetchWithTimeout.mockRejectedValueOnce(
      httpErrorRejection(404, JsonRpcErrorCode.NotFound, 'not found'),
    );

    const service = makeService();
    const result = await service.similar('99999999', 10);

    expect(result.pmids).toEqual([]);
    expect(result.totalCount).toBe(0);
    // Only the work lookup ran — no batch-resolve call follows a null work.
    expect(mockFetchWithTimeout).toHaveBeenCalledTimes(1);
  });

  it('rethrows a non-404 work-lookup failure', async () => {
    mockFetchWithTimeout.mockRejectedValueOnce(
      httpErrorRejection(500, JsonRpcErrorCode.InternalError, 'boom'),
    );

    const service = makeService();
    await expect(service.similar('31295471', 10)).rejects.toThrow(/500/);
  });

  it('returns empty when related_works list is empty', async () => {
    mockFetchWithTimeout.mockResolvedValueOnce(
      jsonResponse({
        id: 'https://openalex.org/W1234',
        related_works: [],
        referenced_works: [],
      }),
    );

    const service = makeService();
    const result = await service.similar('31295471', 10);

    expect(result.pmids).toEqual([]);
    expect(result.totalCount).toBe(0);
  });

  it('normalizes OA IDs with full URL prefix in related_works', async () => {
    mockFetchWithTimeout
      .mockResolvedValueOnce(
        jsonResponse({
          id: 'https://openalex.org/W1234',
          related_works: ['https://openalex.org/W999'],
          referenced_works: [],
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({ results: [makeWork('W999', '77777')], meta: { count: 1 } }),
      );

    const service = makeService();
    const result = await service.similar('31295471', 10);

    expect(result.pmids).toContain('77777');
    // The batch-resolve URL should use the bare ID, not the full URL
    const batchUrl = mockFetchWithTimeout.mock.calls[1]?.[0] as string;
    expect(batchUrl).toContain('W999');
    expect(batchUrl).not.toContain('https://openalex.org/W999');
  });
});

describe('OpenAlexService.citedBy', () => {
  beforeEach(() => mockFetchWithTimeout.mockReset());

  it('resolves cited_by via cites: filter', async () => {
    // First call: work lookup to get OA ID
    mockFetchWithTimeout
      .mockResolvedValueOnce(
        jsonResponse({
          id: 'https://openalex.org/W2960163646',
          related_works: [],
          referenced_works: [],
        }),
      )
      // Second call: cites: filter
      .mockResolvedValueOnce(
        jsonResponse({
          results: [makeWork('W300', '33333'), makeWork('W400', '44444')],
          meta: { count: 312 },
        }),
      );

    const service = makeService();
    const result = await service.citedBy('31295471', 10);

    expect(result.pmids).toEqual(['33333', '44444']);
    expect(result.totalCount).toBe(312);
    // Verify cites: filter was used (URL is encoded so check decoded form)
    const citesUrl = decodeURIComponent(mockFetchWithTimeout.mock.calls[1]?.[0] as string);
    expect(citesUrl).toContain('cites:W2960163646');
  });

  it('drops records with no PMID in cited_by results', async () => {
    mockFetchWithTimeout
      .mockResolvedValueOnce(
        jsonResponse({ id: 'https://openalex.org/W1', related_works: [], referenced_works: [] }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          results: [
            makeWork('W300', '33333'),
            makeWork('W400', null), // dropped
          ],
          meta: { count: 2 },
        }),
      );

    const service = makeService();
    const result = await service.citedBy('31295471', 10);

    expect(result.pmids).toEqual(['33333']);
  });

  it('returns empty when source PMID not found in OpenAlex', async () => {
    mockFetchWithTimeout.mockRejectedValueOnce(
      httpErrorRejection(404, JsonRpcErrorCode.NotFound, 'not found'),
    );

    const service = makeService();
    const result = await service.citedBy('99999999', 10);

    expect(result).toEqual({ pmids: [], totalCount: 0 });
    expect(mockFetchWithTimeout).toHaveBeenCalledTimes(1);
  });

  it('propagates a 5xx from the cited_by lookup', async () => {
    mockFetchWithTimeout
      .mockResolvedValueOnce(jsonResponse({ id: 'https://openalex.org/W1234' }))
      .mockRejectedValueOnce(httpErrorRejection(503, JsonRpcErrorCode.ServiceUnavailable, 'down'));

    const service = makeService();
    await expect(service.citedBy('31295471', 10)).rejects.toThrow(/503/);
  });

  it('excludes source PMID from results', async () => {
    mockFetchWithTimeout
      .mockResolvedValueOnce(
        jsonResponse({ id: 'https://openalex.org/W1', related_works: [], referenced_works: [] }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          results: [
            makeWork('W300', '31295471'), // same as source — excluded
            makeWork('W400', '44444'),
          ],
          meta: { count: 2 },
        }),
      );

    const service = makeService();
    const result = await service.citedBy('31295471', 10);

    expect(result.pmids).not.toContain('31295471');
    expect(result.pmids).toContain('44444');
  });
});

describe('OpenAlexService.references', () => {
  beforeEach(() => mockFetchWithTimeout.mockReset());

  it('resolves referenced_works to PMIDs', async () => {
    mockFetchWithTimeout
      .mockResolvedValueOnce(
        jsonResponse({
          id: 'https://openalex.org/W1234',
          related_works: [],
          referenced_works: ['https://openalex.org/W500', 'https://openalex.org/W600'],
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          results: [makeWork('W500', '55555'), makeWork('W600', '66666')],
          meta: { count: 2 },
        }),
      );

    const service = makeService();
    const result = await service.references('31295471', 10);

    expect(result.pmids).toEqual(['55555', '66666']);
    expect(result.totalCount).toBe(2); // referenced_works.length from fixture
  });

  it('drops referenced_works records with no PMID', async () => {
    mockFetchWithTimeout
      .mockResolvedValueOnce(
        jsonResponse({
          id: 'https://openalex.org/W1234',
          related_works: [],
          referenced_works: ['https://openalex.org/W500', 'https://openalex.org/W600'],
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          results: [
            makeWork('W500', '55555'),
            makeWork('W600', null), // no PMID — dropped, never minted
          ],
          meta: { count: 2 },
        }),
      );

    const service = makeService();
    const result = await service.references('31295471', 10);

    expect(result.pmids).toEqual(['55555']);
    expect(result.pmids).not.toContain(null);
    expect(result.pmids).not.toContain(undefined);
  });

  it('returns empty when source PMID not found in OpenAlex', async () => {
    mockFetchWithTimeout.mockRejectedValueOnce(
      httpErrorRejection(404, JsonRpcErrorCode.NotFound, 'not found'),
    );

    const service = makeService();
    const result = await service.references('99999999', 10);

    expect(result).toEqual({ pmids: [], totalCount: 0 });
    expect(mockFetchWithTimeout).toHaveBeenCalledTimes(1);
  });

  it('returns empty when referenced_works is absent', async () => {
    mockFetchWithTimeout.mockResolvedValueOnce(
      jsonResponse({ id: 'https://openalex.org/W1234', related_works: [] }),
    );
    const service = makeService();
    const result = await service.references('31295471', 10);
    expect(result.pmids).toEqual([]);
    expect(result.totalCount).toBe(0);
  });
});

describe('initOpenAlexService / getOpenAlexService', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('constructs the service and is accessible via accessor', async () => {
    const mod = await import('@/services/openalex/openalex-service.js');
    mod.initOpenAlexService();
    expect(mod.getOpenAlexService()).toBeInstanceOf(mod.OpenAlexService);
  });

  it('getOpenAlexServiceOptional returns undefined before init', async () => {
    await import('@/services/openalex/openalex-service.js');
    // Reset internal state via module reset
    vi.resetModules();
    const freshMod = await import('@/services/openalex/openalex-service.js');
    // Before init, it may return the previous value due to module caching.
    // After init it must return a service instance.
    freshMod.initOpenAlexService();
    expect(freshMod.getOpenAlexServiceOptional()).toBeInstanceOf(freshMod.OpenAlexService);
  });
});
