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
const { OPENALEX_SERVICE_ERRORS } = await import('@/services/error-contracts.js');
/** The framework helper the module mock replaces, for cases that run its timeouts. */
const { fetchWithTimeout: realFetchWithTimeout } = await vi.importActual<
  typeof import('@cyanheads/mcp-ts-core/utils')
>('@cyanheads/mcp-ts-core/utils');

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
  return new OpenAlexService(client, 0 /* no retries in tests */, 45_000);
}

/** Answers with `body` after `afterMs`, or never, until the request's signal aborts. */
function reply(init: RequestInit | undefined, body?: unknown, afterMs = 0): Promise<Response> {
  return new Promise((resolve, reject) => {
    const signal = init?.signal as AbortSignal;
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    if (body !== undefined) setTimeout(() => resolve(jsonResponse(body)), afterMs);
  });
}

/** Run a call under the fake clock; return what it threw and the instant it settled. */
async function settleTimed(call: Promise<unknown>) {
  const start = Date.now();
  let settledAfterMs: number | undefined;
  const outcome = call.then(
    () => {
      throw new Error('expected the call to fail');
    },
    (error: unknown) => {
      settledAfterMs = Date.now() - start;
      return error;
    },
  );
  await vi.runAllTimersAsync();
  return { error: await outcome, settledAfterMs };
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

    expect(result.pmids).toEqual(['77777']);
    // The batch-resolve filter carries the bare ID. Read decoded: the raw URL is
    // percent-encoded, so a full-URL ID would never appear in it literally.
    const batchUrl = new URL(mockFetchWithTimeout.mock.calls[1]?.[0] as string);
    expect(batchUrl.searchParams.get('filter')).toBe('openalex:W999');
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
    // A page shorter than per_page exhausts upstream, which makes the
    // PubMed-addressable count exact — OpenAlex's own `meta.count` (312) counts
    // citing works, including those with no PubMed record, and stands only while
    // rows remain unfetched (issue #117).
    expect(result.totalCount).toBe(2);
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

    expect(result).toEqual({
      pmids: [],
      totalCount: 0,
      droppedNoPmid: 0,
      reachCapped: false,
    });
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

    expect(result).toEqual({
      pmids: [],
      totalCount: 0,
      droppedNoPmid: 0,
      reachCapped: false,
    });
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

/**
 * Window paging and batch resolution (#117). OpenAlex serves at most 100 rows
 * per request and accepts at most 100 values in one `openalex:` OR filter, so a
 * window deeper than one request has to walk pages (cited_by) or batches
 * (references/similar) until the PubMed-addressable rows cover it.
 */
describe('OpenAlex window paging (issue #117)', () => {
  beforeEach(() => mockFetchWithTimeout.mockReset());

  /** A cited_by page of `size` rows, `withoutPmid` of them carrying no PMID. */
  function citedByPage(start: number, size: number, count: number, withoutPmid = 0) {
    return jsonResponse({
      results: Array.from({ length: size }, (_, i) =>
        makeWork(`W${start + i}`, i < withoutPmid ? null : String(start + i)),
      ),
      meta: { count },
    });
  }

  /** The decoded `filter=` values of the nth (0-based) upstream request. */
  function filterValues(callIndex: number): string[] {
    const url = decodeURIComponent(mockFetchWithTimeout.mock.calls[callIndex]?.[0] as string);
    const filter = /filter=openalex:([^&]+)/.exec(url)?.[1] ?? '';
    return filter ? filter.split('|') : [];
  }

  function workLookup(refs: string[] = [], related: string[] = []) {
    return jsonResponse({
      id: 'https://openalex.org/W2045435533',
      referenced_works: refs,
      related_works: related,
    });
  }

  it('cited_by walks pages until the requested window is covered', async () => {
    mockFetchWithTimeout
      .mockResolvedValueOnce(workLookup())
      .mockResolvedValueOnce(citedByPage(1000, 100, 17394, 3))
      .mockResolvedValueOnce(citedByPage(2000, 100, 17394, 3))
      .mockResolvedValueOnce(citedByPage(3000, 100, 17394, 3));

    const service = makeService();
    // offset 200 + maxResults 3 — the exact window the issue reports as false-empty.
    const result = await service.citedBy('22745249', 203);

    expect(mockFetchWithTimeout).toHaveBeenCalledTimes(4);
    for (const [i, page] of [1, 2, 3].entries()) {
      const url = decodeURIComponent(mockFetchWithTimeout.mock.calls[i + 1]?.[0] as string);
      expect(url).toContain('per_page=100');
      expect(url).toContain(`page=${page}`);
    }
    expect(result.pmids.length).toBe(291);
    // The window the caller asked for is populated, and its rows are new.
    expect(result.pmids.slice(200, 203)).toEqual(['3009', '3010', '3011']);
    expect(new Set(result.pmids).size).toBe(result.pmids.length);
    expect(result.droppedNoPmid).toBe(9);
    expect(result.reachCapped).toBe(false);
    // Upstream is far from exhausted, so OpenAlex's own count stands.
    expect(result.totalCount).toBe(17394);
  });

  it('cited_by keeps walking through a page that carries no PMIDs', async () => {
    mockFetchWithTimeout
      .mockResolvedValueOnce(workLookup())
      .mockResolvedValueOnce(citedByPage(1000, 100, 5000, 100))
      .mockResolvedValueOnce(citedByPage(2000, 100, 5000, 0));

    const service = makeService();
    const result = await service.citedBy('22745249', 50);

    expect(mockFetchWithTimeout).toHaveBeenCalledTimes(3);
    expect(result.pmids.slice(0, 2)).toEqual(['2000', '2001']);
    expect(result.droppedNoPmid).toBe(100);
  });

  it('cited_by reports the exact addressable total once upstream is exhausted', async () => {
    mockFetchWithTimeout
      .mockResolvedValueOnce(workLookup())
      // A page shorter than per_page is the last page.
      .mockResolvedValueOnce(citedByPage(1000, 40, 42, 2));

    const service = makeService();
    const result = await service.citedBy('22745249', 100);

    expect(mockFetchWithTimeout).toHaveBeenCalledTimes(2);
    expect(result.pmids.length).toBe(38);
    expect(result.totalCount).toBe(38);
    expect(result.droppedNoPmid).toBe(2);
    expect(result.reachCapped).toBe(false);
  });

  it('cited_by stops at the page cap and flags the unreached window', async () => {
    mockFetchWithTimeout.mockResolvedValueOnce(workLookup());
    for (let i = 0; i < 20; i++) {
      mockFetchWithTimeout.mockResolvedValueOnce(citedByPage(1000 + i * 100, 100, 90000, 100));
    }

    const service = makeService();
    const result = await service.citedBy('22745249', 50);

    // Ten pages, plus the work lookup — the walk stops rather than running forever.
    expect(mockFetchWithTimeout).toHaveBeenCalledTimes(11);
    expect(result.pmids).toEqual([]);
    expect(result.reachCapped).toBe(true);
    expect(result.totalCount).toBe(90000);
  });

  it('references resolves past the first batch, in reference-list order', async () => {
    const refs = Array.from({ length: 150 }, (_, i) => `https://openalex.org/W${1000 + i}`);
    mockFetchWithTimeout
      .mockResolvedValueOnce(workLookup(refs))
      .mockResolvedValueOnce(
        jsonResponse({
          // Returned out of order — the resolved window must follow the reference
          // list, not whatever order OpenAlex happens to answer in.
          results: Array.from({ length: 100 }, (_, i) =>
            makeWork(`W${1099 - i}`, String(2099 - i)),
          ),
          meta: { count: 100 },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          results: Array.from({ length: 50 }, (_, i) => makeWork(`W${1100 + i}`, String(2100 + i))),
          meta: { count: 50 },
        }),
      );

    const service = makeService();
    const result = await service.references('22745249', 120);

    expect(mockFetchWithTimeout).toHaveBeenCalledTimes(3);
    expect(filterValues(1)).toHaveLength(100);
    expect(filterValues(1)[0]).toBe('W1000');
    expect(filterValues(2)).toHaveLength(50);
    expect(filterValues(2)[0]).toBe('W1100');
    expect(result.pmids.slice(0, 3)).toEqual(['2000', '2001', '2002']);
    expect(result.pmids.slice(99, 102)).toEqual(['2099', '2100', '2101']);
    expect(result.pmids.length).toBe(150);
    expect(result.totalCount).toBe(150);
  });

  it('references never sends more than 100 IDs in one filter', async () => {
    const refs = Array.from({ length: 250 }, (_, i) => `https://openalex.org/W${1000 + i}`);
    mockFetchWithTimeout.mockResolvedValueOnce(workLookup(refs));
    for (let batch = 0; batch < 3; batch++) {
      mockFetchWithTimeout.mockResolvedValueOnce(
        jsonResponse({
          results: Array.from({ length: batch === 2 ? 50 : 100 }, (_, i) =>
            makeWork(`W${1000 + batch * 100 + i}`, String(2000 + batch * 100 + i)),
          ),
          meta: { count: 100 },
        }),
      );
    }

    const service = makeService();
    const result = await service.references('22745249', 240);

    for (let call = 1; call < mockFetchWithTimeout.mock.calls.length; call++) {
      const values = filterValues(call);
      expect(values.length).toBeLessThanOrEqual(100);
      const url = decodeURIComponent(mockFetchWithTimeout.mock.calls[call]?.[0] as string);
      expect(url).toContain(`per_page=${values.length}`);
    }
    expect(result.pmids.length).toBe(250);
  });

  it('references stops at the batch cap and flags the unreached window', async () => {
    const refs = Array.from({ length: 1500 }, (_, i) => `https://openalex.org/W${1000 + i}`);
    mockFetchWithTimeout.mockResolvedValueOnce(workLookup(refs));
    for (let batch = 0; batch < 20; batch++) {
      // Every resolved record lacks a PMID, so no batch ever fills the window.
      mockFetchWithTimeout.mockResolvedValueOnce(
        jsonResponse({
          results: Array.from({ length: 100 }, (_, i) =>
            makeWork(`W${1000 + batch * 100 + i}`, null),
          ),
          meta: { count: 100 },
        }),
      );
    }

    const service = makeService();
    const result = await service.references('22745249', 50);

    expect(mockFetchWithTimeout).toHaveBeenCalledTimes(11);
    expect(result.pmids).toEqual([]);
    expect(result.reachCapped).toBe(true);
    expect(result.droppedNoPmid).toBe(1000);
    // The window was never covered, so only OpenAlex's own list length is known.
    expect(result.totalCount).toBe(1500);
  });

  it('similar resolves a related_works list longer than the old 50-item prefix', async () => {
    const related = Array.from({ length: 60 }, (_, i) => `https://openalex.org/W${1000 + i}`);
    mockFetchWithTimeout.mockResolvedValueOnce(workLookup([], related)).mockResolvedValueOnce(
      jsonResponse({
        results: Array.from({ length: 60 }, (_, i) => makeWork(`W${1000 + i}`, String(2000 + i))),
        meta: { count: 60 },
      }),
    );

    const service = makeService();
    const result = await service.similar('22745249', 55);

    expect(result.pmids.length).toBe(60);
    expect(result.pmids[55]).toBe('2055');
    expect(result.totalCount).toBe(60);
  });
});

/**
 * Request-shape characterization. These pin the cheap-path cost and the
 * upstream call contract that must survive any paging change: a window the
 * first request already covers must not cost extra round trips, and the
 * batch-resolve filter must carry bare IDs in the source list's order.
 */
describe('OpenAlexService upstream request shape', () => {
  beforeEach(() => mockFetchWithTimeout.mockReset());

  it('citedBy covers a first-page window in one cites: request', async () => {
    mockFetchWithTimeout
      .mockResolvedValueOnce(
        jsonResponse({ id: 'https://openalex.org/W1', related_works: [], referenced_works: [] }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          results: Array.from({ length: 5 }, (_, i) => makeWork(`W${i}`, String(500 + i))),
          meta: { count: 900 },
        }),
      );

    const service = makeService();
    const result = await service.citedBy('31295471', 5);

    // One work lookup + one cites: page. A deeper window may cost more; this one must not.
    expect(mockFetchWithTimeout).toHaveBeenCalledTimes(2);
    const citesUrl = decodeURIComponent(mockFetchWithTimeout.mock.calls[1]?.[0] as string);
    expect(citesUrl).toContain('per_page=5');
    expect(result.pmids).toEqual(['500', '501', '502', '503', '504']);
  });

  it('references resolves a short list in one batch of bare IDs', async () => {
    mockFetchWithTimeout
      .mockResolvedValueOnce(
        jsonResponse({
          id: 'https://openalex.org/W1234',
          related_works: [],
          referenced_works: [
            'https://openalex.org/W500',
            'https://openalex.org/W600',
            'https://openalex.org/W700',
          ],
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          results: [
            makeWork('W500', '55555'),
            makeWork('W600', '66666'),
            makeWork('W700', '77777'),
          ],
          meta: { count: 3 },
        }),
      );

    const service = makeService();
    const result = await service.references('31295471', 10);

    expect(mockFetchWithTimeout).toHaveBeenCalledTimes(2);
    const batchUrl = decodeURIComponent(mockFetchWithTimeout.mock.calls[1]?.[0] as string);
    expect(batchUrl).toContain('filter=openalex:W500|W600|W700');
    expect(result.pmids).toEqual(['55555', '66666', '77777']);
  });
});

/**
 * Every client call that parses a body throws `openalex_invalid_response` on a
 * non-JSON one, under the code the contract declares for that reason.
 */
describe('openalex_invalid_response contract alignment', () => {
  beforeEach(() => mockFetchWithTimeout.mockReset());

  const declared = OPENALEX_SERVICE_ERRORS.find((e) => e.reason === 'openalex_invalid_response');
  const client = () => new OpenAlexApiClient({ timeoutMs: 20000 });

  it.each([
    ['getWorkByPmid', () => client().getWorkByPmid('31295471')],
    ['getCitedBy', () => client().getCitedBy('W1234', 5, 1)],
    ['resolveOaIdsToPmids', () => client().resolveOaIdsToPmids(['W500'])],
  ])('%s throws it under the declared code', async (_label, call) => {
    mockFetchWithTimeout.mockResolvedValue(new Response('<html>not json</html>', { status: 200 }));

    const err = (await call().catch((e: unknown) => e)) as McpError;

    expect(err).toBeInstanceOf(McpError);
    expect(err.data?.reason).toBe('openalex_invalid_response');
    expect(err.code).toBe(declared?.code);
  });
});

/**
 * A body that fails mid-stream with a rejection quoting the request URL whole, as Bun
 * 1.4 writes some of them, reaches the caller naming only the host: the query carries
 * the operator's polite-pool email.
 */
describe('a body read failure keeps the request URL out of its message', () => {
  beforeEach(() => mockFetchWithTimeout.mockReset());

  const client = () => new OpenAlexApiClient({ email: 'ops@example.org', timeoutMs: 20000 });

  it.each([
    ['getWorkByPmid', () => client().getWorkByPmid('31295471')],
    ['getCitedBy', () => client().getCitedBy('W1234', 5, 1)],
    ['resolveOaIdsToPmids', () => client().resolveOaIdsToPmids(['W500'])],
  ])('%s', async (_label, call) => {
    const url = 'https://api.openalex.org/works?filter=cites%3AW1234&mailto=ops%40example.org';
    const rejection = Object.assign(new TypeError(`InvalidHTTPResponse fetching "${url}"`), {
      code: 'InvalidHTTPResponse',
      path: url,
    });
    const body = new ReadableStream({ start: (controller) => controller.error(rejection) });
    mockFetchWithTimeout.mockResolvedValue(new Response(body, { status: 200 }));

    const err = await call().catch((e: unknown) => e);

    // The same rejection, its classification unchanged; only its text is redacted.
    expect(err).toBe(rejection);
    expect((err as Error).message).toBe(
      'InvalidHTTPResponse fetching "https://api.openalex.org/…?…"',
    );
  });
});

/**
 * One total deadline bounds each OpenAlex call — every request, attempt, and backoff
 * the public method makes — and the tool call's deadline, passed beside the signal,
 * shortens it when that leaves less time. The real `fetchWithTimeout` runs over a
 * stubbed `fetch` under the fake clock. (#310)
 */
describe('OpenAlex total deadline (#310)', () => {
  /** `EUROPEPMC_TOTAL_DEADLINE_MS`'s default, which OpenAlex borrows. */
  const TOTAL_DEADLINE_MS = 45_000;
  const WORK = {
    id: 'https://openalex.org/W1234',
    related_works: ['https://openalex.org/W500'],
    referenced_works: ['https://openalex.org/W501'],
  };
  const fetchStub = vi.fn<typeof fetch>();

  const service = (maxRetries = 3) =>
    new OpenAlexService(
      new OpenAlexApiClient({ timeoutMs: 20_000 }),
      maxRetries,
      TOTAL_DEADLINE_MS,
    );
  const deadlineWith = (leftMs: number, totalMs: number) => ({
    expiresAt: Date.now() + leftMs,
    totalMs,
  });

  /** Which client call a request belongs to. */
  function routeOf(input: string | URL | Request): 'work' | 'citedBy' | 'resolve' {
    const url = decodeURIComponent(input instanceof Request ? input.url : String(input));
    if (url.includes('/works/pmid:')) return 'work';
    if (url.includes('filter=cites:')) return 'citedBy';
    return 'resolve';
  }

  /** Every request hangs until its signal aborts. */
  const hangEverything = () => fetchStub.mockImplementation((_input, init) => reply(init));

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    fetchStub.mockReset();
    mockFetchWithTimeout.mockReset();
    mockFetchWithTimeout.mockImplementation(realFetchWithTimeout);
    vi.stubGlobal('fetch', fetchStub);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('settles an all-hung call at its total deadline as openalex_deadline_exceeded', async () => {
    hangEverything();
    const { error, settledAfterMs } = await settleTimed(service().similar('31295471', 10));

    expect(error).toBeInstanceOf(McpError);
    expect(error).toMatchObject({
      code: JsonRpcErrorCode.Timeout,
      message: `OpenAlex request deadline (${TOTAL_DEADLINE_MS}ms) exceeded`,
      data: {
        reason: 'openalex_deadline_exceeded',
        label: 'getWorkByPmid(31295471)',
        deadlineMs: TOTAL_DEADLINE_MS,
      },
    });
    expect(settledAfterMs).toBe(TOTAL_DEADLINE_MS);
    // 20 s + 1 s backoff + 20 s + 2 s backoff leave the third attempt the last 2 s.
    expect(fetchStub).toHaveBeenCalledTimes(3);
  });

  it('runs a service built by initOpenAlexService under the configured total deadline', async () => {
    hangEverything();
    const mod = await import('@/services/openalex/openalex-service.js');
    mod.initOpenAlexService();
    const { error, settledAfterMs } = await settleTimed(
      mod.getOpenAlexService().references('31295471', 10),
    );

    expect(error).toMatchObject({
      data: { reason: 'openalex_deadline_exceeded', deadlineMs: TOTAL_DEADLINE_MS },
    });
    expect(settledAfterMs).toBe(TOTAL_DEADLINE_MS);
  });

  it('settles at the instant a tool call deadline runs out when it leaves less time, reporting its length', async () => {
    hangEverything();
    const { error, settledAfterMs } = await settleTimed(
      service().citedBy('31295471', 10, undefined, deadlineWith(30_000, 60_000)),
    );

    expect(error).toMatchObject({
      code: JsonRpcErrorCode.Timeout,
      message: 'OpenAlex request deadline (60000ms) exceeded',
      data: { reason: 'openalex_deadline_exceeded', deadlineMs: 60_000 },
    });
    expect(settledAfterMs).toBe(30_000);
    // A 20 s attempt, 1 s of backoff, and the second attempt cut at 30 s.
    expect(fetchStub).toHaveBeenCalledTimes(2);
  });

  it('still ends at its own total deadline, reporting its length, when the call has more time left', async () => {
    hangEverything();
    const { error, settledAfterMs } = await settleTimed(
      service().references('31295471', 10, undefined, deadlineWith(120_000, 120_000)),
    );

    expect(error).toMatchObject({
      data: { reason: 'openalex_deadline_exceeded', deadlineMs: TOTAL_DEADLINE_MS },
    });
    expect(settledAfterMs).toBe(TOTAL_DEADLINE_MS);
  });

  it('holds every request a method sends to the one deadline set when the method starts', async () => {
    // The work lookup answers at 10 s; resolving its related works then hangs.
    fetchStub.mockImplementation((input, init) =>
      routeOf(input) === 'work' ? reply(init, WORK, 10_000) : reply(init),
    );
    const { error, settledAfterMs } = await settleTimed(service().similar('31295471', 10));

    expect(error).toMatchObject({
      data: {
        reason: 'openalex_deadline_exceeded',
        label: 'resolveRelatedWorks(31295471)',
        deadlineMs: TOTAL_DEADLINE_MS,
      },
    });
    expect(settledAfterMs).toBe(TOTAL_DEADLINE_MS);
    expect(fetchStub.mock.calls.map(([input]) => routeOf(input))).toEqual([
      'work',
      'resolve',
      'resolve',
    ]);
  });

  it('cuts a cited-by page walk at the tool call deadline, past the first page', async () => {
    // A full first page with no PubMed PMIDs, so the walk goes on to page 2.
    const firstPage = {
      results: Array.from({ length: 10 }, (_, i) => makeWork(`W${700 + i}`, null)),
      meta: { count: 50 },
    };
    let pages = 0;
    // The work lookup answers at 5 s, page 1 at 12 s, and page 2 hangs.
    fetchStub.mockImplementation((input, init) => {
      if (routeOf(input) === 'work') return reply(init, WORK, 5_000);
      return ++pages === 1 ? reply(init, firstPage, 7_000) : reply(init);
    });
    const { error, settledAfterMs } = await settleTimed(
      service().citedBy('31295471', 10, undefined, deadlineWith(30_000, 60_000)),
    );

    expect(error).toMatchObject({
      data: {
        reason: 'openalex_deadline_exceeded',
        label: `getCitedBy(${WORK.id}, page 2)`,
        deadlineMs: 60_000,
      },
    });
    expect(settledAfterMs).toBe(30_000);
  });

  it('sends nothing more once an earlier request of the method spent the deadline', async () => {
    // The work lookup answers 1 ms before the deadline runs out.
    fetchStub.mockImplementation((input, init) =>
      routeOf(input) === 'work' ? reply(init, WORK, 19_999) : reply(init),
    );
    const { error } = await settleTimed(
      service().references('31295471', 10, undefined, deadlineWith(20_000, 60_000)),
    );

    expect(error).toMatchObject({
      data: {
        reason: 'openalex_deadline_exceeded',
        label: 'resolveReferencedWorks(31295471)',
        deadlineMs: 60_000,
      },
    });
    expect(fetchStub.mock.calls.map(([input]) => routeOf(input))).toEqual(['work']);
  });

  it.each([0, 1])(
    'sends nothing and arms no timer on a deadline with %i ms left',
    async (leftMs) => {
      // A work lookup that answers at once: a call that sent it would resolve, not fail.
      fetchStub.mockImplementation(async () => jsonResponse(null));
      const error = await service()
        .similar('31295471', 10, undefined, deadlineWith(leftMs, 60_000))
        .catch((e: unknown) => e);

      expect(error).toMatchObject({
        code: JsonRpcErrorCode.Timeout,
        data: { reason: 'openalex_deadline_exceeded', deadlineMs: 60_000 },
      });
      expect(fetchStub).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("rethrows the caller's own abort reason under a deadline, never the deadline", async () => {
    hangEverything();
    const controller = new AbortController();
    const reason = new DOMException('The client went away', 'AbortError');
    const call = service()
      .citedBy('31295471', 10, controller.signal, deadlineWith(30_000, 60_000))
      .catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(100);
    controller.abort(reason);

    expect(await call).toBe(reason);
    expect(fetchStub).toHaveBeenCalledOnce();
  });

  it("rethrows the caller's own abort reason on a spent deadline, sending nothing and arming no timer", async () => {
    // A work lookup that answers at once: a call that sent it would resolve, not fail.
    fetchStub.mockImplementation(async () => jsonResponse(null));
    const reason = new DOMException('The client went away', 'AbortError');
    const error = await service()
      .similar('31295471', 10, AbortSignal.abort(reason), deadlineWith(0, 60_000))
      .catch((e: unknown) => e);

    expect(error).toBe(reason);
    expect(fetchStub).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('reports a timeout as an exhausted Timeout, never retry_deadline_exceeded, when the next backoff would not fit', async () => {
    hangEverything();
    // The first attempt times out at 20 s with 500 ms left: a 1 s backoff cannot fit.
    const { error } = await settleTimed(
      service().similar('31295471', 10, undefined, deadlineWith(20_500, 60_000)),
    );

    expect(error).toBeInstanceOf(McpError);
    const err = error as McpError;
    expect(err.code).toBe(JsonRpcErrorCode.Timeout);
    expect(err.message).toMatch(/\(failed after 1 attempt\)$/);
    expect(err.data).toEqual({ label: 'getWorkByPmid(31295471)', attempts: 1 });
    expect(fetchStub).toHaveBeenCalledOnce();
  });
});

describe('initOpenAlexService / getOpenAlexService', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    mockFetchWithTimeout.mockReset();
  });

  it('runs on the Europe PMC per-request timeout and retry count, not NCBI’s', async () => {
    vi.stubEnv('EUROPEPMC_TIMEOUT_MS', '5000');
    vi.stubEnv('EUROPEPMC_MAX_RETRIES', '1');
    vi.stubEnv('NCBI_TIMEOUT_MS', '8000');
    vi.stubEnv('NCBI_MAX_RETRIES', '4');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const t0 = Date.now();
    const starts: number[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>((_input, init) => {
        starts.push(Date.now() - t0);
        return reply(init);
      }),
    );
    mockFetchWithTimeout.mockImplementation(realFetchWithTimeout);
    // Fresh modules, so the server config is parsed from the stubbed environment.
    vi.resetModules();
    const mod = await import('@/services/openalex/openalex-service.js');
    mod.initOpenAlexService();

    const { error, settledAfterMs } = await settleTimed(
      mod.getOpenAlexService().similar('31295471', 10),
    );

    expect(error).toMatchObject({ code: JsonRpcErrorCode.Timeout });
    expect((error as McpError).data).toEqual({ label: 'getWorkByPmid(31295471)', attempts: 2 });
    // Two 5 s attempts with the 1 s backoff between them.
    expect(starts).toEqual([0, 6_000]);
    expect(settledAfterMs).toBe(11_000);
  });

  it('constructs the service and is accessible via accessor', async () => {
    const mod = await import('@/services/openalex/openalex-service.js');
    mod.initOpenAlexService();
    expect(mod.getOpenAlexService()).toBeInstanceOf(mod.OpenAlexService);
  });

  it('getOpenAlexServiceOptional returns undefined before init, then the initialized service', async () => {
    // A fresh module instance, so no earlier test's init is visible.
    vi.resetModules();
    const freshMod = await import('@/services/openalex/openalex-service.js');

    expect(freshMod.getOpenAlexServiceOptional()).toBeUndefined();
    expect(() => freshMod.getOpenAlexService()).toThrow(/not initialized/);

    freshMod.initOpenAlexService();
    expect(freshMod.getOpenAlexServiceOptional()).toBe(freshMod.getOpenAlexService());
  });
});
