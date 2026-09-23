/**
 * @fileoverview Tests for the Europe PMC service.
 * @module tests/services/europe-pmc/europe-pmc-service.test
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

const { defaultIsTransient } = await import('@cyanheads/mcp-ts-core/utils');
const { EuropePmcApiClient } = await import('@/services/europe-pmc/api-client.js');
const { EuropePmcRequestQueue } = await import('@/services/europe-pmc/request-queue.js');
const { EuropePmcService } = await import('@/services/europe-pmc/europe-pmc-service.js');
const { parsePmcArticle } = await import('@/services/ncbi/parsing/pmc-article-parser.js');

function jsonResponse(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

function xmlResponse(body: string, init: ResponseInit = {}) {
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'application/xml' },
    ...init,
  });
}

/**
 * Reproduce what `fetchWithTimeout` actually does on a non-2xx: it throws a
 * status-mapped `McpError` carrying `errorSource: 'FetchHttpError'`, never
 * resolves with the failing `Response`. `expectedStatuses` only lowers the log
 * severity. Mocking a resolved 404/503 `Response` models a state the real helper
 * cannot produce, and certifies branches that never execute. (#90)
 */
function httpErrorRejection(
  status: number,
  code: JsonRpcErrorCode,
  body = '',
  retryAfter?: string,
) {
  return new McpError(code, `Fetch failed for <upstream>. Status: ${status}`, {
    status,
    statusText: '',
    body,
    statusCode: status,
    responseBody: body,
    ...(retryAfter !== undefined && { retryAfter }),
    errorSource: 'FetchHttpError',
  });
}

function makeService(opts: { maxRetries?: number; minStartGapMs?: number } = {}) {
  const client = new EuropePmcApiClient({ timeoutMs: 20000 });
  const queue = new EuropePmcRequestQueue(opts.minStartGapMs ?? 0);
  return new EuropePmcService(client, queue, opts.maxRetries ?? 0);
}

describe('EuropePmcService.search', () => {
  beforeEach(() => {
    mockFetchWithTimeout.mockReset();
  });

  it('parses a normal search response and exposes cursor pagination', async () => {
    mockFetchWithTimeout.mockResolvedValue(
      jsonResponse({
        hitCount: 42,
        nextCursorMark: 'NEXT_CURSOR',
        request: { cursorMark: '*', queryString: 'foo AND (SRC:"MED")' },
        resultList: {
          result: [
            {
              id: '1',
              source: 'MED',
              pmid: '1',
              title: 'A paper',
              doi: '10.1/x',
              isOpenAccess: 'Y',
              inEPMC: 'Y',
              abstractText: 'Abstract',
              firstPublicationDate: '2025-01-02',
            },
          ],
        },
      }),
    );

    const service = makeService();
    const result = await service.search({
      query: 'foo',
      sources: ['MED'],
      pageSize: 25,
      cursorMark: '*',
    });

    expect(result.hits).toHaveLength(1);
    expect(result.hits[0]?.source).toBe('MED');
    expect(result.hitCount).toBe(42);
    expect(result.nextCursorMark).toBe('NEXT_CURSOR');
    expect(result.cursorMark).toBe('*');
  });

  it('normalizes a single-hit response (scalar `result`, not array)', async () => {
    mockFetchWithTimeout.mockResolvedValue(
      jsonResponse({
        hitCount: 1,
        request: { cursorMark: '*' },
        resultList: { result: { id: 'PPR1', source: 'PPR', doi: '10.21203/x' } },
      }),
    );

    const service = makeService();
    const result = await service.search({ query: 'preprint', sources: ['PPR'] });

    expect(result.hits).toHaveLength(1);
    expect(result.hits[0]?.id).toBe('PPR1');
  });

  it('omits `nextCursorMark` when EPMC echoes the same cursor (final page sentinel)', async () => {
    mockFetchWithTimeout.mockResolvedValue(
      jsonResponse({
        hitCount: 1,
        nextCursorMark: 'CURSOR_X',
        request: { cursorMark: 'CURSOR_X' },
        resultList: { result: [{ id: '7', source: 'PMC' }] },
      }),
    );

    const service = makeService();
    const result = await service.search({ query: 'foo', cursorMark: 'CURSOR_X' });
    expect(result.nextCursorMark).toBeUndefined();
  });

  it('builds query with source filter when sources are provided', async () => {
    mockFetchWithTimeout.mockResolvedValue(jsonResponse({ hitCount: 0 }));

    const service = makeService();
    await service.search({ query: 'cancer', sources: ['MED', 'PMC', 'PPR'] });

    const url = mockFetchWithTimeout.mock.calls[0]?.[0] as string;
    const decoded = decodeURIComponent(url);
    expect(decoded).toContain('(cancer)');
    expect(decoded).toContain('SRC:"MED"');
    expect(decoded).toContain('SRC:"PMC"');
    expect(decoded).toContain('SRC:"PPR"');
  });

  it('returns the query Europe PMC echoes back as the effective query', async () => {
    mockFetchWithTimeout.mockResolvedValue(
      jsonResponse({ hitCount: 2595, request: { queryString: '(alphafold) AND (SRC:"PPR")' } }),
    );

    const result = await makeService().search({ query: 'alphafold', sources: ['PPR'] });

    expect(result.query).toBe('(alphafold) AND (SRC:"PPR")');
  });

  it.each([
    ['no `request` echo at all', {}],
    ['a `request` echo with no `queryString`', { request: { cursorMark: '*' } }],
  ])('falls back to the query it sent, source filter included, on %s', async (_label, echo) => {
    mockFetchWithTimeout.mockResolvedValue(jsonResponse({ hitCount: 3, ...echo }));

    const result = await makeService().search({ query: ' alphafold ', sources: ['MED', 'PPR'] });

    const sent = new URL(mockFetchWithTimeout.mock.calls[0]?.[0] as string).searchParams.get(
      'query',
    );
    expect(result.query).toBe('(alphafold) AND (SRC:"MED" OR SRC:"PPR")');
    expect(result.query).toBe(sent);
  });

  it('sends an unfiltered query when sources is omitted', async () => {
    mockFetchWithTimeout.mockResolvedValue(jsonResponse({ hitCount: 0 }));
    const service = makeService();
    await service.search({ query: 'cancer' });
    const url = mockFetchWithTimeout.mock.calls[0]?.[0] as string;
    const decoded = decodeURIComponent(url);
    expect(decoded).not.toContain('SRC:');
  });

  it('URL-encodes a DOI query so slashes survive', async () => {
    mockFetchWithTimeout.mockResolvedValue(jsonResponse({ hitCount: 0 }));
    const service = makeService();
    await service.search({ query: 'DOI:"10.21203/rs.3.rs-9010375/v1"' });
    const url = mockFetchWithTimeout.mock.calls[0]?.[0] as string;
    expect(url).toContain('10.21203%2Frs.3.rs-9010375%2Fv1');
  });

  it('throws SerializationError on non-JSON body', async () => {
    mockFetchWithTimeout.mockResolvedValue(new Response('<html>not json</html>', { status: 200 }));
    const service = makeService();
    await expect(service.search({ query: 'foo' })).rejects.toMatchObject({
      data: { reason: 'europepmc_invalid_response' },
    });
  });

  it('splits diagnosis (message) from recovery hint on invalid sort — not byte-identical (#75)', async () => {
    // EPMC returns a {version}-only envelope when sort is invalid — no hitCount,
    // no request echo, no resultList. Without detection this falls through to
    // hitCount: 0 and the caller thinks the query had no matches.
    mockFetchWithTimeout.mockResolvedValue(jsonResponse({ version: '6.10' }));
    const service = makeService();
    const err = (await service
      .search({ query: 'cancer', sort: 'FIRST_PIDATE desc' })
      .catch((e: unknown) => e)) as {
      message: string;
      data: { reason: string; sort: string; recovery: { hint: string } };
    };

    expect(err.data.reason).toBe('europepmc_invalid_input');
    expect(err.data.sort).toBe('FIRST_PIDATE desc');
    // Message carries the diagnosis (names the bad field); hint carries the next step.
    expect(err.message).toContain('FIRST_PIDATE desc');
    expect(err.data.recovery.hint).toContain('documented sort');
    // The bug (#75): message and recovery hint were the same string, rendering
    // identical Error:/Recovery: blocks. They must differ now.
    expect(err.data.recovery.hint).not.toBe(err.message);
  });

  it('splits diagnosis from recovery hint when a cursorMark draws the envelope on every attempt (#75)', async () => {
    mockFetchWithTimeout.mockResolvedValue(jsonResponse({ version: '6.10' }));
    const service = makeService();
    const err = (await service
      .search({ query: 'cancer', cursorMark: 'BAD_CURSOR' })
      .catch((e: unknown) => e)) as {
      message: string;
      data: { reason: string; cursorMark: string; recovery: { hint: string } };
    };

    expect(err.data.reason).toBe('europepmc_invalid_input');
    expect(err.data.cursorMark).toBe('BAD_CURSOR');
    expect(err.message).toContain('BAD_CURSOR');
    expect(err.data.recovery.hint).toContain('cursorMark');
    expect(err.data.recovery.hint).not.toBe(err.message);
  });

  it('surfaces EPMC `errMsg` (e.g. empty query) instead of falling through to 0 hits', async () => {
    mockFetchWithTimeout.mockResolvedValue(
      jsonResponse({
        errCode: 400,
        errMsg:
          'No search criteria provided. Please provide a search criteria which is less than 1500 characters.',
      }),
    );
    const service = makeService();
    await expect(service.search({ query: '' })).rejects.toMatchObject({
      data: {
        reason: 'europepmc_invalid_input',
        epmcErrCode: 400,
        epmcErrMsg: expect.stringContaining('No search criteria'),
        recovery: { hint: expect.stringContaining('No search criteria') },
      },
    });
  });

  it('treats a legitimate 0-hit response as success (not silent rejection)', async () => {
    mockFetchWithTimeout.mockResolvedValue(
      jsonResponse({
        hitCount: 0,
        request: { queryString: 'foo', cursorMark: '*' },
        resultList: { result: [] },
      }),
    );
    const service = makeService();
    const result = await service.search({ query: 'foo' });
    expect(result.hitCount).toBe(0);
    expect(result.hits).toEqual([]);
  });

  it('passes a sort param through to EPMC in the URL', async () => {
    mockFetchWithTimeout.mockResolvedValue(
      jsonResponse({
        hitCount: 1,
        request: { queryString: 'cancer', cursorMark: '*', sort: 'CITED desc' },
        resultList: { result: [{ id: '1', source: 'MED' }] },
      }),
    );
    const service = makeService();
    await service.search({ query: 'cancer', sort: 'CITED desc' });
    const url = mockFetchWithTimeout.mock.calls[0]?.[0] as string;
    expect(url).toContain('sort=CITED+desc');
  });

  it('throws ServiceUnavailable on 5xx', async () => {
    mockFetchWithTimeout.mockRejectedValue(
      httpErrorRejection(503, JsonRpcErrorCode.ServiceUnavailable, 'down'),
    );
    const service = makeService();
    await expect(service.search({ query: 'foo' })).rejects.toThrow(/503/);
  });

  it('throws ServiceUnavailable with europepmc_unreachable on network failure', async () => {
    mockFetchWithTimeout.mockRejectedValue(new Error('connect ETIMEDOUT'));
    const service = makeService();
    await expect(service.search({ query: 'foo' })).rejects.toMatchObject({
      data: {
        reason: 'europepmc_unreachable',
        recovery: { hint: expect.stringContaining('Europe PMC was unreachable') },
      },
    });
  });
});

/**
 * Upstream failures (#152) and the empty `{ version }` envelope (#159) both run
 * inside the service's retry loop. These drive the real client, queue, and retry
 * loop with a stubbed `fetchWithTimeout` and zero-delay backoff, and count the
 * upstream requests — a classification that skipped or burned the retry budget
 * would still surface the same code.
 */
describe('EuropePmcService.search — upstream failures and empty envelopes (#152, #159)', () => {
  const MAX_RETRIES = 3;
  const EXHAUSTED = MAX_RETRIES + 1;
  const UNREACHABLE_HINT =
    'Retry after a brief delay; Europe PMC was unreachable. NCBI PMC and Unpaywall remain available.';

  const envelope = () => jsonResponse({ version: '6.9' });
  const results = () =>
    jsonResponse({
      hitCount: 1,
      request: { queryString: 'CRISPR', cursorMark: '*' },
      resultList: { result: [{ id: '1', source: 'MED' }] },
    });

  let setTimeoutSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mockFetchWithTimeout.mockReset();
    // Fire backoff sleeps at once so an exhausted retry chain doesn't actually wait.
    setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void) => {
      fn();
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as unknown as typeof setTimeout);
  });

  afterEach(() => {
    setTimeoutSpy.mockRestore();
  });

  const service = () => makeService({ maxRetries: MAX_RETRIES });

  describe('HTTP failures on /search (#152)', () => {
    it('retries a 404 and ends as europepmc_unreachable, never a bare NotFound', async () => {
      mockFetchWithTimeout.mockRejectedValue(
        httpErrorRejection(404, JsonRpcErrorCode.NotFound, 'nope'),
      );
      await expect(service().search({ query: 'cancer', pageSize: 1 })).rejects.toMatchObject({
        code: JsonRpcErrorCode.ServiceUnavailable,
        message: expect.stringMatching(
          new RegExp(`Status: 404.*\\(failed after ${EXHAUSTED} attempts\\)$`),
        ),
        data: { reason: 'europepmc_unreachable', recovery: { hint: UNREACHABLE_HINT } },
      });
      expect(mockFetchWithTimeout).toHaveBeenCalledTimes(EXHAUSTED);
    });

    it('returns results when a 404 clears on the next attempt', async () => {
      mockFetchWithTimeout
        .mockRejectedValueOnce(httpErrorRejection(404, JsonRpcErrorCode.NotFound))
        .mockResolvedValueOnce(results());
      const result = await service().search({ query: 'CRISPR' });
      expect(result.hitCount).toBe(1);
      expect(mockFetchWithTimeout).toHaveBeenCalledTimes(2);
    });

    it.each([500, 503])(
      'retries a %i and ends as europepmc_unreachable with the hint',
      async (status) => {
        mockFetchWithTimeout.mockRejectedValue(
          httpErrorRejection(status, JsonRpcErrorCode.ServiceUnavailable, 'down'),
        );
        await expect(service().search({ query: 'cancer' })).rejects.toMatchObject({
          code: JsonRpcErrorCode.ServiceUnavailable,
          message: expect.stringMatching(
            new RegExp(`Status: ${status}.*\\(failed after ${EXHAUSTED} attempts\\)$`),
          ),
          data: { reason: 'europepmc_unreachable', recovery: { hint: UNREACHABLE_HINT } },
        });
        expect(mockFetchWithTimeout).toHaveBeenCalledTimes(EXHAUSTED);
      },
    );

    it('carries a 503 Retry-After through to the terminal error', async () => {
      mockFetchWithTimeout.mockRejectedValue(
        httpErrorRejection(503, JsonRpcErrorCode.ServiceUnavailable, 'down', '9'),
      );
      await expect(service().search({ query: 'cancer' })).rejects.toMatchObject({
        code: JsonRpcErrorCode.ServiceUnavailable,
        data: { reason: 'europepmc_unreachable', retryAfter: '9' },
      });
    });

    /**
     * `europepmc_unreachable` is declared for `ServiceUnavailable` only. A failure
     * that keeps another transient code says what it is through that code and its
     * message, the way the NCBI service reports an exhausted Timeout or RateLimited.
     */
    const expectNoUnreachableReason = (err: McpError) => {
      expect(err.data?.reason).toBeUndefined();
      expect(err.data?.recovery).toBeUndefined();
      expect(err.data?.attempts).toBe(EXHAUSTED);
      expect(err.message).toMatch(new RegExp(`\\(failed after ${EXHAUSTED} attempts\\)$`));
    };

    it('retries a 504 and keeps Timeout, without the unreachable reason', async () => {
      mockFetchWithTimeout.mockRejectedValue(
        httpErrorRejection(504, JsonRpcErrorCode.Timeout, 'gateway timeout'),
      );
      const err = (await service()
        .search({ query: 'cancer' })
        .catch((e: unknown) => e)) as McpError;
      expect(err.code).toBe(JsonRpcErrorCode.Timeout);
      expect(err.message).toContain('Status: 504');
      expectNoUnreachableReason(err);
      expect(mockFetchWithTimeout).toHaveBeenCalledTimes(EXHAUSTED);
    });

    it('keeps a 429 RateLimited with its retryAfter and without the unreachable reason', async () => {
      mockFetchWithTimeout.mockRejectedValue(
        httpErrorRejection(429, JsonRpcErrorCode.RateLimited, '', '7'),
      );
      const err = (await service()
        .search({ query: 'cancer' })
        .catch((e: unknown) => e)) as McpError;
      expect(err.code).toBe(JsonRpcErrorCode.RateLimited);
      expect(err.data?.retryAfter).toBe('7');
      expectNoUnreachableReason(err);
      expect(mockFetchWithTimeout).toHaveBeenCalledTimes(EXHAUSTED);
    });

    it('keeps an exhausted request timeout on another endpoint as Timeout, without the reason', async () => {
      mockFetchWithTimeout.mockRejectedValue(
        new McpError(JsonRpcErrorCode.Timeout, 'Request timed out after 20000ms.', {
          errorSource: 'FetchTimeout',
        }),
      );
      const err = (await service()
        .citations('31295471', 25, 1)
        .catch((e: unknown) => e)) as McpError;
      expect(err.code).toBe(JsonRpcErrorCode.Timeout);
      expectNoUnreachableReason(err);
      expect(mockFetchWithTimeout).toHaveBeenCalledTimes(EXHAUSTED);
    });

    it('keeps another 4xx at its own code, unretried and without the unreachable reason', async () => {
      mockFetchWithTimeout.mockRejectedValue(
        httpErrorRejection(400, JsonRpcErrorCode.InvalidParams, 'bad'),
      );
      const err = await service()
        .search({ query: 'cancer' })
        .then(
          () => undefined,
          (e: unknown) => e as McpError,
        );
      expect(err?.code).toBe(JsonRpcErrorCode.InvalidParams);
      expect(err?.data?.reason).toBeUndefined();
      expect(mockFetchWithTimeout).toHaveBeenCalledTimes(1);
    });

    it('still converts a fullTextXML 404 to `not-available` without retrying (#90)', async () => {
      mockFetchWithTimeout.mockRejectedValue(
        httpErrorRejection(404, JsonRpcErrorCode.NotFound, 'nope'),
      );
      const result = await service().fullTextXml('PPR404', 'PPR');
      expect(result.kind).toBe('not-available');
      expect(mockFetchWithTimeout).toHaveBeenCalledTimes(1);
    });
  });

  describe('empty { version } envelope (#159)', () => {
    it('retries an envelope on attempt 1 and returns the results of attempt 2', async () => {
      mockFetchWithTimeout.mockResolvedValueOnce(envelope()).mockResolvedValueOnce(results());
      const result = await service().search({ query: 'CRISPR', sort: 'CITED desc' });
      expect(result.hits).toHaveLength(1);
      expect(mockFetchWithTimeout).toHaveBeenCalledTimes(2);
    });

    it('recovers from an envelope on every attempt but the last', async () => {
      mockFetchWithTimeout
        .mockResolvedValueOnce(envelope())
        .mockResolvedValueOnce(envelope())
        .mockResolvedValueOnce(envelope())
        .mockResolvedValueOnce(results());
      const result = await service().search({ query: 'CRISPR' });
      expect(result.hitCount).toBe(1);
      expect(mockFetchWithTimeout).toHaveBeenCalledTimes(EXHAUSTED);
    });

    it.each([
      ['no sort', undefined],
      ['CITED desc', 'CITED desc'],
      ['a documented field in any case and spacing', '  cited   DESC '],
      ['AUTH_FIRST asc', 'AUTH_FIRST asc'],
      ['comma-separated documented keys', 'PUB_YEAR desc, CITED desc'],
      ['comma-separated documented keys without a space', 'pub_year desc,cited DESC'],
    ])(
      'ends a persistent envelope with %s as retryable europepmc_unreachable',
      async (_label, sort) => {
        mockFetchWithTimeout.mockImplementation(() => Promise.resolve(envelope()));
        const err = (await service()
          .search({ query: 'CRISPR base editing', ...(sort && { sort }) })
          .then(
            () => undefined,
            (e: unknown) => e,
          )) as McpError;

        expect(err).toBeInstanceOf(McpError);
        expect(err.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
        expect(err.data?.reason).toBe('europepmc_unreachable');
        expect(err.data?.recovery).toEqual({ hint: UNREACHABLE_HINT });
        expect(err.message).toMatch(new RegExp(`\\(failed after ${EXHAUSTED} attempts\\)$`));
        // Upstream noise — never blame the caller's input.
        expect(err.message).not.toMatch(/sort|CITED|AUTH_FIRST|CRISPR|query/i);
        expect(err.data?.sort).toBeUndefined();
        // #75: the diagnosis and the next step stay distinct.
        expect(err.data?.recovery).not.toEqual({ hint: err.message });
        expect(defaultIsTransient(err)).toBe(true);
        expect(mockFetchWithTimeout).toHaveBeenCalledTimes(EXHAUSTED);
      },
    );

    it.each([
      ['an undocumented field', 'BOGUSFIELD desc'],
      ['a documented field with no direction', 'CITED'],
      ['an honored undocumented field', 'ID asc'],
      ['a direction that is not asc/desc', 'CITED down'],
      ['a key list with one undocumented field', 'CITED desc, BOGUSFIELD asc'],
      ['keys joined by a semicolon', 'CITED desc; PUB_YEAR asc'],
    ])('fails fast on an envelope for %s, naming the sort', async (_label, sort) => {
      mockFetchWithTimeout.mockImplementation(() => Promise.resolve(envelope()));
      const err = (await service()
        .search({ query: 'CRISPR', sort })
        .then(
          () => undefined,
          (e: unknown) => e,
        )) as McpError;

      expect(err).toBeInstanceOf(McpError);
      expect(err.code).toBe(JsonRpcErrorCode.ValidationError);
      expect(err.data?.reason).toBe('europepmc_invalid_input');
      expect(err.data?.sort).toBe(sort);
      expect(err.message).toContain(`"${sort}"`);
      const hint = (err.data?.recovery as { hint?: string } | undefined)?.hint;
      expect(hint).toContain('documented sort');
      expect(hint).not.toBe(err.message);
      expect(defaultIsTransient(err)).toBe(false);
      expect(mockFetchWithTimeout).toHaveBeenCalledTimes(1);
    });

    it('sends an undocumented sort upstream and returns its results', async () => {
      mockFetchWithTimeout.mockResolvedValue(results());
      const result = await service().search({ query: 'CRISPR', sort: 'ID asc' });
      expect(result.hits).toHaveLength(1);
      expect(String(mockFetchWithTimeout.mock.calls[0]?.[0])).toContain('sort=ID+asc');
      expect(mockFetchWithTimeout).toHaveBeenCalledTimes(1);
    });

    it('blames a pagination cursor only once the envelope persists through every attempt', async () => {
      mockFetchWithTimeout.mockImplementation(() => Promise.resolve(envelope()));
      await expect(
        service().search({ query: 'CRISPR', cursorMark: 'AoIIQDeiFSg1' }),
      ).rejects.toMatchObject({
        code: JsonRpcErrorCode.ValidationError,
        message: expect.stringContaining('"AoIIQDeiFSg1"'),
        data: {
          reason: 'europepmc_invalid_input',
          cursorMark: 'AoIIQDeiFSg1',
          recovery: { hint: expect.stringContaining('cursorMark') },
        },
      });
      expect(mockFetchWithTimeout).toHaveBeenCalledTimes(EXHAUSTED);
    });

    it('returns a cursor page whose envelope clears on retry', async () => {
      mockFetchWithTimeout.mockResolvedValueOnce(envelope()).mockResolvedValueOnce(results());
      const result = await service().search({ query: 'CRISPR', cursorMark: 'AoIIQDeiFSg1' });
      expect(result.hitCount).toBe(1);
      expect(mockFetchWithTimeout).toHaveBeenCalledTimes(2);
    });

    it('treats an HTTP-200 zero-hit answer as an empty result, not an envelope', async () => {
      mockFetchWithTimeout.mockResolvedValue(
        jsonResponse({ version: '6.9', hitCount: 0, request: { queryString: 'zzqx' } }),
      );
      const result = await service().search({ query: 'zzqx' });
      expect(result).toMatchObject({ hitCount: 0, hits: [] });
      expect(mockFetchWithTimeout).toHaveBeenCalledTimes(1);
    });

    it('fails an errMsg envelope fast as europepmc_invalid_input', async () => {
      mockFetchWithTimeout.mockResolvedValue(jsonResponse({ errCode: 400, errMsg: 'bad query' }));
      await expect(service().search({ query: 'x' })).rejects.toMatchObject({
        code: JsonRpcErrorCode.ValidationError,
        data: { reason: 'europepmc_invalid_input' },
      });
      expect(mockFetchWithTimeout).toHaveBeenCalledTimes(1);
    });

    it('fails an unparseable body fast as europepmc_invalid_response', async () => {
      mockFetchWithTimeout.mockResolvedValue(new Response('<html/>', { status: 200 }));
      await expect(service().search({ query: 'x' })).rejects.toMatchObject({
        code: JsonRpcErrorCode.SerializationError,
        data: { reason: 'europepmc_invalid_response' },
      });
      expect(mockFetchWithTimeout).toHaveBeenCalledTimes(1);
    });

    it('fetchRecords shares the envelope retry through search()', async () => {
      mockFetchWithTimeout.mockResolvedValueOnce(envelope()).mockResolvedValueOnce(results());
      const hits = await service().fetchRecords([{ source: 'MED', epmcId: '1' }]);
      expect(hits).toHaveLength(1);
      expect(mockFetchWithTimeout).toHaveBeenCalledTimes(2);
    });
  });
});

describe('EuropePmcService.fetchRecords', () => {
  beforeEach(() => {
    mockFetchWithTimeout.mockReset();
  });

  /** Query as it reaches the wire, URL-decoded out of the request URL. */
  const sentQuery = () =>
    new URL(String(mockFetchWithTimeout.mock.calls[0]?.[0])).searchParams.get('query');

  it('OR-joins one unquoted EXT_ID/SRC clause per ref into a single request', async () => {
    mockFetchWithTimeout.mockResolvedValue(
      jsonResponse({
        hitCount: 2,
        resultList: {
          result: [
            { id: 'KR20120031038', source: 'PAT', abstractText: 'long patent abstract' },
            { id: 'IND609436151', source: 'AGR' },
          ],
        },
      }),
    );
    const service = makeService();
    const hits = await service.fetchRecords([
      { source: 'PAT', epmcId: 'KR20120031038' },
      { source: 'AGR', epmcId: 'IND609436151' },
    ]);

    expect(mockFetchWithTimeout).toHaveBeenCalledTimes(1);
    // Quoting the identifier or the SRC value makes Europe PMC match nothing.
    expect(sentQuery()).toBe(
      '(EXT_ID:KR20120031038 AND SRC:PAT) OR (EXT_ID:IND609436151 AND SRC:AGR)',
    );
    expect(hits.map((h) => h.id)).toEqual(['KR20120031038', 'IND609436151']);
    expect(hits[0]?.abstractText).toBe('long patent abstract');
  });

  it('requests core results sized to the batch and adds no source filter clause', async () => {
    mockFetchWithTimeout.mockResolvedValue(
      jsonResponse({ hitCount: 0, resultList: { result: [] } }),
    );
    const service = makeService();
    await service.fetchRecords([{ source: 'PPR', epmcId: 'PPR1283828' }]);

    const url = new URL(String(mockFetchWithTimeout.mock.calls[0]?.[0]));
    expect(url.searchParams.get('resultType')).toBe('core');
    expect(url.searchParams.get('pageSize')).toBe('1');
    expect(sentQuery()).toBe('(EXT_ID:PPR1283828 AND SRC:PPR)');
  });

  it('ORs a bare PMCID clause into a PMC ref so a PubMed-indexed article resolves (#94)', async () => {
    // EPMC's PMC corpus holds only articles it has no PubMed record for. Once an
    // article is indexed in PubMed its canonical record moves to MED and carries
    // the PMCID as a field, so `EXT_ID:PMC8371605 AND SRC:PMC` matches nothing.
    mockFetchWithTimeout.mockResolvedValue(
      jsonResponse({
        hitCount: 1,
        resultList: { result: [{ id: '34265844', source: 'MED', pmcid: 'PMC8371605' }] },
      }),
    );
    const service = makeService();
    const hits = await service.fetchRecords([{ source: 'PMC', epmcId: 'PMC8371605' }]);

    expect(sentQuery()).toBe('(EXT_ID:PMC8371605 AND SRC:PMC) OR (PMCID:PMC8371605)');
    expect(hits[0]?.source).toBe('MED');
    expect(hits[0]?.pmcid).toBe('PMC8371605');
  });

  it('keeps serving PMC-only records through the same OR-ed clause (#94)', async () => {
    mockFetchWithTimeout.mockResolvedValue(
      jsonResponse({
        hitCount: 1,
        resultList: { result: [{ id: 'PMC13294766', source: 'PMC' }] },
      }),
    );
    const service = makeService();
    const hits = await service.fetchRecords([{ source: 'PMC', epmcId: 'PMC13294766' }]);
    expect(hits[0]?.id).toBe('PMC13294766');
    expect(hits[0]?.source).toBe('PMC');
  });

  it('adds the PMCID clause only for PMC refs, mixing sources in one query (#94)', async () => {
    mockFetchWithTimeout.mockResolvedValue(
      jsonResponse({ hitCount: 0, resultList: { result: [] } }),
    );
    const service = makeService();
    await service.fetchRecords([
      { source: 'MED', epmcId: '36449413' },
      { source: 'PMC', epmcId: 'PMC8371605' },
      { source: 'PPR', epmcId: 'PPR1283828' },
    ]);

    expect(sentQuery()).toBe(
      '(EXT_ID:36449413 AND SRC:MED) OR (EXT_ID:PMC8371605 AND SRC:PMC) OR (PMCID:PMC8371605) OR (EXT_ID:PPR1283828 AND SRC:PPR)',
    );
  });

  it('returns only what Europe PMC resolved, leaving misses to the caller', async () => {
    mockFetchWithTimeout.mockResolvedValue(
      jsonResponse({ hitCount: 1, resultList: { result: { id: 'PPR1283828', source: 'PPR' } } }),
    );
    const service = makeService();
    const hits = await service.fetchRecords([
      { source: 'PPR', epmcId: 'PPR1283828' },
      { source: 'AGR', epmcId: 'IND000000000' },
    ]);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.id).toBe('PPR1283828');
  });
});

describe('EuropePmcService.fullTextXml', () => {
  beforeEach(() => {
    mockFetchWithTimeout.mockReset();
  });

  it('returns `found` with raw XML on 200', async () => {
    mockFetchWithTimeout.mockResolvedValue(
      xmlResponse('<?xml version="1.0"?><article><body>hi</body></article>'),
    );
    const service = makeService();
    const result = await service.fullTextXml('PPR1', 'PPR');
    expect(result).toEqual({
      kind: 'found',
      xml: '<?xml version="1.0"?><article><body>hi</body></article>',
      epmcId: 'PPR1',
      source: 'PPR',
    });
  });

  it('returns `not-available` for 404', async () => {
    mockFetchWithTimeout.mockRejectedValue(
      httpErrorRejection(404, JsonRpcErrorCode.NotFound, 'nope'),
    );
    const service = makeService();
    const result = await service.fullTextXml('PPR404', 'PPR');
    expect(result.kind).toBe('not-available');
  });

  it('returns `not-available` for an empty 200 body (issue safety net)', async () => {
    mockFetchWithTimeout.mockResolvedValue(xmlResponse('   '));
    const service = makeService();
    const result = await service.fullTextXml('EMPTY1', 'PMC');
    expect(result.kind).toBe('not-available');
  });

  it('throws ServiceUnavailable on 5xx', async () => {
    mockFetchWithTimeout.mockRejectedValue(
      httpErrorRejection(503, JsonRpcErrorCode.ServiceUnavailable, 'down'),
    );
    const service = makeService();
    await expect(service.fullTextXml('X', 'PMC')).rejects.toThrow(/503/);
  });

  it('never gives a search 404 the fullTextXML `not-available` treatment', async () => {
    // The 404 → `not-available` conversion is scoped to fullTextXml (#90). A
    // failed search is not "no record" — it is an outage, surfaced as
    // `europepmc_unreachable` rather than a bare NotFound. (#152)
    mockFetchWithTimeout.mockRejectedValue(
      httpErrorRejection(404, JsonRpcErrorCode.NotFound, 'nope'),
    );
    const service = makeService();
    await expect(service.search({ query: 'foo' })).rejects.toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      message: expect.stringMatching(/Status: 404.*\(failed after 1 attempts\)$/),
      data: { reason: 'europepmc_unreachable' },
    });
  });

  it('uses the single-id URL pattern, not source/id', async () => {
    mockFetchWithTimeout.mockResolvedValue(xmlResponse('<article/>'));
    const service = makeService();
    await service.fullTextXml('PPR123', 'PPR');
    const url = mockFetchWithTimeout.mock.calls[0]?.[0] as string;
    expect(url).toMatch(/\/PPR123\/fullTextXML$/);
    expect(url).not.toContain('/PPR/PPR123/');
  });
});

describe('EuropePmcService.parseFullTextXml', () => {
  it('parses well-formed JATS into an article JatsNode', () => {
    const service = makeService();
    const xml = `<?xml version="1.0"?>
<article article-type="research-article">
  <front><article-meta><title-group><article-title>Hi</article-title></title-group></article-meta></front>
  <body><sec><title>Intro</title><p>Body</p></sec></body>
</article>`;
    const node = service.parseFullTextXml(xml);
    expect(node).toBeDefined();
    expect(node && 'article' in node).toBe(true);
  });

  it('returns undefined when the body has no <article>', () => {
    const service = makeService();
    const xml = `<?xml version="1.0"?><wrapper><note>nothing here</note></wrapper>`;
    const node = service.parseFullTextXml(xml);
    expect(node).toBeUndefined();
  });

  it('throws SerializationError on malformed XML', () => {
    const service = makeService();
    expect(() => service.parseFullTextXml('<article><body>')).toThrowError(
      /invalid XML from Europe PMC/i,
    );
  });

  /**
   * The EPMC parser once ran with `parseTagValue: true` while the NCBI ordered
   * parser ran with it off, so the same article rendered different citation
   * strings depending on which upstream served it. These pin the configs to a
   * single shared definition. (#127)
   */
  describe('bibliographic tokens are verbatim (regression #127)', () => {
    const parse = (xml: string) => {
      const node = makeService().parseFullTextXml(xml);
      if (!node) throw new Error('expected an <article> node');
      return parsePmcArticle(node);
    };

    /** `extractJournal` needs a `<journal-meta>` before it reports any field. */
    const withJournal = (articleMetaInner: string) =>
      `<article><front>` +
      `<journal-meta><journal-title-group><journal-title>J Test</journal-title></journal-title-group></journal-meta>` +
      `<article-meta>${articleMetaInner}</article-meta>` +
      `</front></article>`;

    it('keeps a page range with a decimal-looking suffix verbatim', () => {
      const article = parse(withJournal('<fpage>4002.e26</fpage>'));
      expect(article.journal?.pages).toBe('4002.e26');
    });

    it('keeps a zero-padded inline token verbatim', () => {
      const article = parse(
        `<article><body><sec><title>Results</title><p>Agent <bold>007</bold> reporting.</p></sec></body></article>`,
      );
      expect(article.sections[0]?.text).toBe('Agent 007 reporting.');
    });

    it('still renders a genuinely numeric field as its source string', () => {
      const article = parse(withJournal('<volume>186</volume>'));
      expect(article.journal?.volume).toBe('186');
    });

    it('keeps a reference label’s trailing period', () => {
      // PMC12973387's six reference labels are `1.`–`6.`; coercion dropped the
      // period and rendered them `1`–`6`.
      const article = parse(
        `<article><back><ref-list><ref id="bib1"><label>1.</label>` +
          `<mixed-citation>Nybakken JW. Marine Biology. 2001.</mixed-citation></ref></ref-list></back></article>`,
      );
      expect(article.references?.[0]?.label).toBe('1.');
    });
  });
});

describe('EuropePmcService.citations', () => {
  beforeEach(() => {
    mockFetchWithTimeout.mockReset();
  });

  it('extracts PMIDs from a citations response (MED id is the PMID)', async () => {
    // Live EPMC shape: records carry `id` + `source`, NOT a `pmid` field; for a
    // MED-source record the `id` IS the PubMed ID. A PPR (preprint) is dropped.
    mockFetchWithTimeout.mockResolvedValue(
      jsonResponse({
        hitCount: 3,
        citationList: {
          citation: [
            { id: '10001', source: 'MED', citationType: 'journal article', title: 'Citing A' },
            { id: '10002', source: 'MED', title: 'Citing B' },
            { id: 'PPR123', source: 'PPR', title: 'Preprint, no PubMed PMID' },
          ],
        },
      }),
    );

    const service = makeService();
    const result = await service.citations('31295471', 10, 1);

    expect(result.pmids).toEqual(['10001', '10002']);
    // The page covered the whole result set, so the total is the PMID-addressable
    // count, not the raw hitCount that also counts the dropped PPR row (#101).
    expect(result.totalCount).toBe(2);
    expect(result.droppedNoPmid).toBe(1);
  });

  it('drops records with no PMID (non-MED sources)', async () => {
    mockFetchWithTimeout.mockResolvedValue(
      jsonResponse({
        hitCount: 2,
        citationList: {
          citation: [
            { id: 'PAT1', source: 'PAT' },
            { id: 'AGR1', source: 'AGR' },
          ],
        },
      }),
    );
    const service = makeService();
    const result = await service.citations('12345', 10, 1);
    expect(result.pmids).toEqual([]);
    // Whole set fetched, every row dropped → nothing is PMID-addressable (#101).
    expect(result.totalCount).toBe(0);
    expect(result.droppedNoPmid).toBe(2);
  });

  it('keeps Europe PMC hitCount as the total when the page is a slice of a larger set (#101)', async () => {
    mockFetchWithTimeout.mockResolvedValue(
      jsonResponse({
        hitCount: 940,
        citationList: {
          citation: [
            { id: '10001', source: 'MED' },
            { id: 'PPR9', source: 'PPR' },
          ],
        },
      }),
    );
    const service = makeService();
    const result = await service.citations('12345', 2, 1);
    expect(result.pmids).toEqual(['10001']);
    expect(result.totalCount).toBe(940);
    expect(result.droppedNoPmid).toBe(1);
  });

  it('throws a typed input error when Europe PMC rejects the request via errMsg (#101)', async () => {
    // Reachable once pageSize can reach Europe PMC's 1000-row ceiling: 1001 is
    // rejected with a structured errMsg envelope under HTTP 200.
    mockFetchWithTimeout.mockResolvedValue(
      jsonResponse({
        errCode: 20,
        errMsg: 'pageSize must be between 1 and 1000',
      }),
    );
    const service = makeService();
    await expect(service.citations('12345', 1001, 1)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: {
        reason: 'europepmc_invalid_input',
        epmcErrCode: 20,
        epmcErrMsg: 'pageSize must be between 1 and 1000',
        recovery: { hint: expect.stringContaining('pageSize must be between 1 and 1000') },
      },
    });
  });

  it('returns empty result for sparse/empty payload', async () => {
    mockFetchWithTimeout.mockResolvedValue(
      jsonResponse({ hitCount: 0, citationList: { citation: [] } }),
    );
    const service = makeService();
    const result = await service.citations('12345', 10, 1);
    expect(result.pmids).toEqual([]);
    expect(result.totalCount).toBe(0);
  });

  it('handles missing citationList gracefully', async () => {
    mockFetchWithTimeout.mockResolvedValue(jsonResponse({ hitCount: 0 }));
    const service = makeService();
    const result = await service.citations('12345', 10, 1);
    expect(result.pmids).toEqual([]);
  });

  it('throws SerializationError on non-JSON response', async () => {
    mockFetchWithTimeout.mockResolvedValue(new Response('<html>error</html>', { status: 200 }));
    const service = makeService();
    await expect(service.citations('12345', 10, 1)).rejects.toMatchObject({
      data: { reason: 'europepmc_invalid_response' },
    });
  });

  it('throws ServiceUnavailable on 5xx', async () => {
    mockFetchWithTimeout.mockRejectedValue(
      httpErrorRejection(503, JsonRpcErrorCode.ServiceUnavailable, 'down'),
    );
    const service = makeService();
    await expect(service.citations('12345', 10, 1)).rejects.toThrow(/503/);
  });
});

describe('EuropePmcService.references', () => {
  beforeEach(() => {
    mockFetchWithTimeout.mockReset();
  });

  it('extracts PMIDs from a references response (MED id is the PMID)', async () => {
    // Live EPMC shape: `id` + `source`, no `pmid` field; MED `id` is the PubMed ID.
    mockFetchWithTimeout.mockResolvedValue(
      jsonResponse({
        hitCount: 2,
        referenceList: {
          reference: [
            { id: '20001', source: 'MED', citationType: 'JOURNAL ARTICLE', title: 'Ref A' },
            { id: '20002', source: 'MED', title: 'Ref B' },
          ],
        },
      }),
    );

    const service = makeService();
    const result = await service.references('31295471', 10, 1);

    expect(result.pmids).toEqual(['20001', '20002']);
    expect(result.totalCount).toBe(2);
  });

  it('drops references without a PubMed PMID (non-MED sources)', async () => {
    mockFetchWithTimeout.mockResolvedValue(
      jsonResponse({
        hitCount: 3,
        referenceList: {
          reference: [
            { id: '30001', source: 'MED' },
            { id: 'PAT1', source: 'PAT' /* no PubMed PMID */ },
            { id: '30003', source: 'MED' },
          ],
        },
      }),
    );
    const service = makeService();
    const result = await service.references('12345', 10, 1);
    expect(result.pmids).toEqual(['30001', '30003']);
    // Whole set fetched: the total counts only the PMID-addressable rows (#101).
    expect(result.totalCount).toBe(2);
    expect(result.droppedNoPmid).toBe(1);
  });

  it('surfaces an errMsg envelope from the references endpoint as an input error (#101)', async () => {
    mockFetchWithTimeout.mockResolvedValue(
      jsonResponse({ errCode: 20, errMsg: 'pageSize must be between 1 and 1000' }),
    );
    const service = makeService();
    await expect(service.references('12345', 1001, 1)).rejects.toMatchObject({
      data: { reason: 'europepmc_invalid_input' },
    });
  });

  it('handles sparse/empty payload', async () => {
    mockFetchWithTimeout.mockResolvedValue(jsonResponse({}));
    const service = makeService();
    const result = await service.references('12345', 10, 1);
    expect(result.pmids).toEqual([]);
    expect(result.totalCount).toBe(0);
  });

  it('uses the correct /MED/{pmid}/references URL', async () => {
    mockFetchWithTimeout.mockResolvedValue(jsonResponse({ hitCount: 0, referenceList: {} }));
    const service = makeService();
    await service.references('31295471', 10, 1);
    const url = mockFetchWithTimeout.mock.calls[0]?.[0] as string;
    expect(url).toContain('/MED/31295471/references');
    expect(url).toContain('pageSize=10');
    expect(url).toContain('page=1');
    expect(url).toContain('format=json');
  });
});

describe('initEuropePmcService / getEuropePmcService', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('leaves the service unset when EUROPEPMC_ENABLED=false', async () => {
    vi.stubEnv('EUROPEPMC_ENABLED', 'false');

    const mod = await import('@/services/europe-pmc/europe-pmc-service.js');
    mod.initEuropePmcService();
    expect(mod.getEuropePmcService()).toBeUndefined();
  });

  it('constructs the service when EUROPEPMC_ENABLED=true (default)', async () => {
    delete process.env.EUROPEPMC_ENABLED;

    const mod = await import('@/services/europe-pmc/europe-pmc-service.js');
    mod.initEuropePmcService();
    expect(mod.getEuropePmcService()).toBeInstanceOf(mod.EuropePmcService);
  });

  it('leaves the service unset when EUROPEPMC_ENABLED=0', async () => {
    vi.stubEnv('EUROPEPMC_ENABLED', '0');

    const mod = await import('@/services/europe-pmc/europe-pmc-service.js');
    mod.initEuropePmcService();
    expect(mod.getEuropePmcService()).toBeUndefined();
  });
});
