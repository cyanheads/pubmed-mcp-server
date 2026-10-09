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
const { createEuropePmcRequestQueue } = await import('@/services/europe-pmc/request-queue.js');
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

/** The error a 503 ends as when no retries are configured. */
const UNREACHABLE_AFTER_ONE_503 = {
  code: JsonRpcErrorCode.ServiceUnavailable,
  message: expect.stringMatching(/Status: 503 \(failed after 1 attempt\)$/),
  data: { reason: 'europepmc_unreachable', attempts: 1 },
};

function makeService(opts: { maxRetries?: number; minStartGapMs?: number } = {}) {
  const client = new EuropePmcApiClient({ timeoutMs: 20000 });
  const queue = createEuropePmcRequestQueue(opts.minStartGapMs ?? 0);
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

    const sent = new URL(String(mockFetchWithTimeout.mock.calls[0]?.[0])).searchParams.get('query');
    expect(sent).toBe('(cancer) AND (SRC:"MED" OR SRC:"PMC" OR SRC:"PPR")');
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
        retryable: false,
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
    await expect(service.search({ query: 'foo' })).rejects.toMatchObject(UNREACHABLE_AFTER_ONE_503);
  });

  it('throws ServiceUnavailable with europepmc_unreachable on network failure', async () => {
    mockFetchWithTimeout.mockRejectedValue(new Error('connect ETIMEDOUT'));
    const service = makeService();
    await expect(service.search({ query: 'foo' })).rejects.toMatchObject({
      data: {
        reason: 'europepmc_unreachable',
      },
    });
  });

  it('sends an exactly-empty cursorMark as written (Europe PMC reads it as the first page)', async () => {
    mockFetchWithTimeout.mockResolvedValue(jsonResponse({ hitCount: 0 }));
    const result = await makeService().search({ query: 'malaria', cursorMark: '' });

    const url = new URL(String(mockFetchWithTimeout.mock.calls[0]?.[0]));
    expect(url.searchParams.get('cursorMark')).toBe('');
    expect(result.cursorMark).toBe('');
  });
});

/**
 * Europe PMC matches nothing when a query is exactly one `EXT_ID` clause ANDed
 * with one `SRC` clause and either value is quoted, so a one-entry `sources`
 * list repeats its source (#175). Asserted on the query as it reaches the wire.
 */
describe('EuropePmcService.search — source clause (#175)', () => {
  beforeEach(() => {
    mockFetchWithTimeout.mockReset();
    mockFetchWithTimeout.mockImplementation(() => Promise.resolve(jsonResponse({ hitCount: 0 })));
  });

  const sentQuery = () =>
    new URL(String(mockFetchWithTimeout.mock.calls[0]?.[0])).searchParams.get('query');

  /** A lone EXT_ID clause ANDed with a lone SRC clause — the shape Europe PMC answers with 0. */
  const BARE_EXT_ID_SRC_PAIR = /^\(EXT_ID:[^()]*\) AND \(SRC:"?[A-Z]+"?\)$/;

  it.each(['MED', 'PMC', 'PPR', 'PAT', 'AGR'] as const)(
    'repeats a lone %s source, so the sent query is never a bare EXT_ID + SRC pair',
    async (source) => {
      await makeService().search({ query: 'EXT_ID:32669217', sources: [source] });

      expect(sentQuery()).toBe(`(EXT_ID:32669217) AND (SRC:"${source}" OR SRC:"${source}")`);
      expect(sentQuery()).not.toMatch(BARE_EXT_ID_SRC_PAIR);
    },
  );

  it.each([
    ['an unquoted EXT_ID', 'EXT_ID:32669217', '(EXT_ID:32669217) AND (SRC:"MED" OR SRC:"MED")'],
    ['a quoted EXT_ID', 'EXT_ID:"32669217"', '(EXT_ID:"32669217") AND (SRC:"MED" OR SRC:"MED")'],
    ['free text', ' malaria ', '(malaria) AND (SRC:"MED" OR SRC:"MED")'],
  ])('gives %s the same single-source shape', async (_label, query, expected) => {
    await makeService().search({ query, sources: ['MED'] });
    expect(sentQuery()).toBe(expected);
  });

  it('reports the repeated clause it sent when Europe PMC echoes no query', async () => {
    const result = await makeService().search({ query: 'EXT_ID:PPR1283828', sources: ['PPR'] });

    expect(result.query).toBe('(EXT_ID:PPR1283828) AND (SRC:"PPR" OR SRC:"PPR")');
    expect(result.query).toBe(sentQuery());
  });

  it.each([
    [['MED', 'PMC'], '(EXT_ID:32669217) AND (SRC:"MED" OR SRC:"PMC")'],
    [['MED', 'PMC', 'PPR'], '(EXT_ID:32669217) AND (SRC:"MED" OR SRC:"PMC" OR SRC:"PPR")'],
    [
      ['MED', 'PMC', 'PPR', 'PAT', 'AGR'],
      '(EXT_ID:32669217) AND (SRC:"MED" OR SRC:"PMC" OR SRC:"PPR" OR SRC:"PAT" OR SRC:"AGR")',
    ],
  ] as const)('leaves a multi-source clause byte-identical for %j', async (sources, expected) => {
    await makeService().search({ query: 'EXT_ID:32669217', sources });
    expect(sentQuery()).toBe(expected);
  });

  it('sends the trimmed query with no source clause when sources is omitted or empty', async () => {
    await makeService().search({ query: ' EXT_ID:32669217 ' });
    await makeService().search({ query: 'EXT_ID:32669217', sources: [] });

    const sent = mockFetchWithTimeout.mock.calls.map((call) =>
      new URL(String(call[0])).searchParams.get('query'),
    );
    expect(sent).toEqual(['EXT_ID:32669217', 'EXT_ID:32669217']);
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
        data: { reason: 'europepmc_unreachable' },
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

    it.each([500, 503])('retries a %i and ends as europepmc_unreachable', async (status) => {
      mockFetchWithTimeout.mockRejectedValue(
        httpErrorRejection(status, JsonRpcErrorCode.ServiceUnavailable, 'down'),
      );
      await expect(service().search({ query: 'cancer' })).rejects.toMatchObject({
        code: JsonRpcErrorCode.ServiceUnavailable,
        message: expect.stringMatching(
          new RegExp(`Status: ${status}.*\\(failed after ${EXHAUSTED} attempts\\)$`),
        ),
        data: { reason: 'europepmc_unreachable' },
      });
      expect(mockFetchWithTimeout).toHaveBeenCalledTimes(EXHAUSTED);
    });

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
        expect(err.data?.recovery).toBeUndefined();
        expect(err.message).toMatch(new RegExp(`\\(failed after ${EXHAUSTED} attempts\\)$`));
        // Upstream noise — never blame the caller's input.
        expect(err.message).not.toMatch(/sort|CITED|AUTH_FIRST|CRISPR|query/i);
        expect(err.data?.sort).toBeUndefined();
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
      expect(err.data?.retryable).toBe(false);
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

    it('blames a pagination cursor once the envelope reaches the last attempt', async () => {
      mockFetchWithTimeout.mockImplementation(() => Promise.resolve(envelope()));
      await expect(
        service().search({ query: 'CRISPR', cursorMark: 'AoIIQDeiFSg1' }),
      ).rejects.toMatchObject({
        code: JsonRpcErrorCode.ValidationError,
        message: expect.stringContaining('"AoIIQDeiFSg1"'),
        data: {
          reason: 'europepmc_invalid_input',
          retryable: false,
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

  /**
   * Europe PMC answers a cursor it cannot decode with the same HTTP 503 it uses
   * for an outage. The first 503 on a caller-supplied cursor triggers one
   * first-page probe of the same query and a retry of the cursor; a later 503
   * convicts the cursor only when that probe was served (#180).
   */
  describe('HTTP 503 on a caller-supplied cursor (#180)', () => {
    /** Europe PMC's actual answer to an unreadable cursor. */
    const cursor503 = () =>
      httpErrorRejection(
        503,
        JsonRpcErrorCode.ServiceUnavailable,
        '{"errMsg":"Search service is temporarily unavailable. Please retry later."}',
      );

    /** The URL parameters of every request sent, in order. */
    const sent = () =>
      mockFetchWithTimeout.mock.calls.map((call) => new URL(String(call[0])).searchParams);
    const sentCursors = () => sent().map((params) => params.get('cursorMark'));

    /**
     * Answers by cursor: a first-page (`*`) request draws from `firstPage`, any
     * other from `cursorPage`; each list's last entry repeats.
     */
    function routeByCursor(
      cursorPage: Array<() => Promise<Response>>,
      firstPage: Array<() => Promise<Response>>,
    ) {
      let cursorCalls = 0;
      let firstPageCalls = 0;
      mockFetchWithTimeout.mockImplementation((url: string) => {
        const isFirstPage = new URL(url).searchParams.get('cursorMark') === '*';
        const replies = isFirstPage ? firstPage : cursorPage;
        const index = isFirstPage ? firstPageCalls++ : cursorCalls++;
        return (replies[Math.min(index, replies.length - 1)] as () => Promise<Response>)();
      });
    }

    const reject503 = () => Promise.reject(cursor503());
    const resolveResults = () => Promise.resolve(results());
    const resolveEnvelope = () => Promise.resolve(envelope());

    const settle = (promise: Promise<unknown>) =>
      promise.then(
        () => undefined,
        (e: unknown) => e as McpError,
      );

    it('fails as a non-retryable europepmc_invalid_input when the cursor draws a second 503 after the probe serves the first page', async () => {
      routeByCursor([reject503], [resolveResults]);

      const err = await settle(
        service().search({
          query: 'malaria',
          sources: ['MED'],
          cursorMark: 'abc',
          pageSize: 10,
          sort: 'CITED desc',
        }),
      );

      expect(err).toBeInstanceOf(McpError);
      expect(err?.code).toBe(JsonRpcErrorCode.ValidationError);
      expect(err?.message).toContain('cursorMark "abc"');
      expect(err?.data).toMatchObject({
        reason: 'europepmc_invalid_input',
        cursorMark: 'abc',
        retryable: false,
      });
      const hint = (err?.data?.recovery as { hint?: string } | undefined)?.hint ?? '';
      expect(hint).toContain('`nextCursorMark`');
      expect(hint).toContain('`*`');
      expect(hint).not.toBe(err?.message);
      expect(defaultIsTransient(err)).toBe(false);

      // The cursor request, one probe, then one retry of the cursor that
      // confirms it — the rest of the retry budget goes unspent.
      expect(mockFetchWithTimeout).toHaveBeenCalledTimes(3);
      const [original, probe, retry] = sent();
      expect(original?.get('cursorMark')).toBe('abc');
      expect(probe?.get('cursorMark')).toBe('*');
      expect(probe?.get('pageSize')).toBe('1');
      // The same query: source clause and sort included.
      expect(probe?.get('query')).toBe(original?.get('query'));
      expect(probe?.get('sort')).toBe('CITED desc');
      expect(retry?.toString()).toBe(original?.toString());
    });

    it('returns the cursor page when one 503 clears on the retry after the probe serves the first page', async () => {
      routeByCursor([reject503, resolveResults], [resolveResults]);

      const result = await service().search({ query: 'malaria', cursorMark: 'abc' });

      expect(result.hitCount).toBe(1);
      expect(result.cursorMark).toBe('abc');
      expect(sentCursors()).toEqual(['abc', '*', 'abc']);
    });

    it('convicts on the next 503 after a served probe, even with another failure between', async () => {
      routeByCursor([reject503, resolveEnvelope, reject503], [resolveResults]);

      const err = await settle(service().search({ query: 'malaria', cursorMark: 'abc' }));

      expect(err?.code).toBe(JsonRpcErrorCode.ValidationError);
      expect(err?.data?.reason).toBe('europepmc_invalid_input');
      expect(sentCursors()).toEqual(['abc', '*', 'abc', 'abc']);
    });

    it('skips the probe when the first 503 lands on the last attempt', async () => {
      routeByCursor(
        [resolveEnvelope, resolveEnvelope, resolveEnvelope, reject503],
        [resolveResults],
      );

      const err = await settle(service().search({ query: 'malaria', cursorMark: 'abc' }));

      expect(err?.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
      expect(err?.data?.reason).toBe('europepmc_unreachable');
      expect(sentCursors()).toEqual(Array(EXHAUSTED).fill('abc'));
    });

    it('skips the probe with no retries configured, ending as europepmc_unreachable', async () => {
      routeByCursor([reject503], [resolveResults]);

      const err = await settle(
        makeService({ maxRetries: 0 }).search({ query: 'malaria', cursorMark: 'abc' }),
      );

      expect(err?.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
      expect(err?.data?.reason).toBe('europepmc_unreachable');
      expect(err?.data?.attempts).toBe(1);
      expect(sentCursors()).toEqual(['abc']);
    });

    it('keeps the retry path, probing once, when the first page fails too', async () => {
      routeByCursor([reject503], [reject503]);

      const err = await settle(service().search({ query: 'malaria', cursorMark: 'abc' }));

      expect(err?.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
      expect(err?.data?.reason).toBe('europepmc_unreachable');
      expect(err?.data?.attempts).toBe(EXHAUSTED);
      expect(err?.message).toMatch(
        new RegExp(`Status: 503.*\\(failed after ${EXHAUSTED} attempts\\)$`),
      );
      // Every attempt of the cursor request plus one probe, right after the first failure.
      expect(sentCursors()).toEqual(['abc', '*', 'abc', 'abc', 'abc']);
    });

    it('blames the cursor for an envelope on the last attempt after earlier 503s, naming the last attempt only', async () => {
      routeByCursor([reject503, reject503, reject503, resolveEnvelope], [reject503]);

      const err = await settle(service().search({ query: 'malaria', cursorMark: 'abc' }));

      expect(err?.code).toBe(JsonRpcErrorCode.ValidationError);
      expect(err?.data).toMatchObject({
        reason: 'europepmc_invalid_input',
        cursorMark: 'abc',
        retryable: false,
      });
      expect(err?.message).toBe(
        'Europe PMC answered the last attempt for cursorMark "abc" with an empty response — the cursor is most likely invalid or expired.',
      );
      expect(sentCursors()).toEqual(['abc', '*', 'abc', 'abc', 'abc']);
    });

    it('returns the cursor page when a retry clears the 503 after a failed probe', async () => {
      routeByCursor([reject503, resolveResults], [reject503]);

      const result = await service().search({ query: 'malaria', cursorMark: 'abc' });

      expect(result.hitCount).toBe(1);
      expect(sentCursors()).toEqual(['abc', '*', 'abc']);
    });

    it('probes on the first 503 even when it lands on a later attempt', async () => {
      routeByCursor([resolveEnvelope, reject503], [resolveResults]);

      const err = await settle(service().search({ query: 'malaria', cursorMark: 'abc' }));

      expect(err?.code).toBe(JsonRpcErrorCode.ValidationError);
      expect(err?.data?.reason).toBe('europepmc_invalid_input');
      expect(sentCursors()).toEqual(['abc', 'abc', '*', 'abc']);
    });

    it('treats a probe answered with an empty envelope as a failed probe', async () => {
      routeByCursor([reject503], [resolveEnvelope]);

      const err = await settle(service().search({ query: 'malaria', cursorMark: 'abc' }));

      expect(err?.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
      expect(err?.data?.reason).toBe('europepmc_unreachable');
      expect(sentCursors()).toEqual(['abc', '*', 'abc', 'abc', 'abc']);
    });

    it.each([
      ['an explicit `*`', '*', '*'],
      ['an omitted cursor', undefined, '*'],
      ['an exactly-empty cursor', '', ''],
    ])(
      'never probes a first-page request: a 503 on %s keeps today’s europepmc_unreachable',
      async (_label, cursorMark, wire) => {
        mockFetchWithTimeout.mockImplementation(reject503);

        const err = await settle(
          service().search({ query: 'malaria', ...(cursorMark !== undefined && { cursorMark }) }),
        );

        expect(err?.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
        expect(err?.data?.reason).toBe('europepmc_unreachable');
        expect(err?.message).toMatch(
          new RegExp(`Status: 503.*\\(failed after ${EXHAUSTED} attempts\\)$`),
        );
        expect(sentCursors()).toEqual(Array(EXHAUSTED).fill(wire));
        expect(sent().every((params) => params.get('pageSize') === '25')).toBe(true);
      },
    );

    it('probes on a 503 only: a caller cursor drawing a 502 keeps today’s path', async () => {
      mockFetchWithTimeout.mockRejectedValue(
        httpErrorRejection(502, JsonRpcErrorCode.ServiceUnavailable, 'Bad Gateway'),
      );

      const err = await settle(service().search({ query: 'malaria', cursorMark: 'abc' }));

      expect(err?.data?.reason).toBe('europepmc_unreachable');
      expect(sentCursors()).toEqual(Array(EXHAUSTED).fill('abc'));
    });

    it('propagates a caller abort during the probe as cancellation, with no further request', async () => {
      const controller = new AbortController();
      const reason = new Error('caller went away');
      mockFetchWithTimeout.mockImplementation(
        (url: string, _timeoutMs: number, _ctx: unknown, init?: RequestInit) => {
          if (new URL(url).searchParams.get('cursorMark') !== '*') return reject503();
          // The probe is in flight: the caller cancels, and the fetch honors its signal.
          return new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), {
              once: true,
            });
            controller.abort(reason);
          });
        },
      );

      await expect(
        service().search({ query: 'malaria', cursorMark: 'abc', signal: controller.signal }),
      ).rejects.toBe(reason);
      expect(sentCursors()).toEqual(['abc', '*']);
    });
  });
});

/**
 * Request pacing across every Europe PMC call: at most four requests in flight,
 * starts spaced by the configured gap, no queue-depth cap, and a caller whose
 * signal fires while queued or backing off is released with its own reason.
 * Also pins the retry schedule — 1 s doubling, ±25% jitter, a 30 s cap, and an
 * upstream `Retry-After` honored in place of the computed wait.
 * Drives the real service, pacing, and retry loop with a stubbed
 * `fetchWithTimeout` under fake timers; `Math.random` is pinned so the ±25%
 * backoff jitter is exact.
 */
describe('EuropePmcService request pacing', () => {
  const results = () =>
    jsonResponse({
      hitCount: 1,
      request: { queryString: 'q', cursorMark: '*' },
      resultList: { result: [{ id: '1', source: 'MED' }] },
    });
  const unavailable = () => httpErrorRejection(503, JsonRpcErrorCode.ServiceUnavailable, 'down');

  /** A fetch the test settles by hand, so a request stays in flight until released. */
  function heldFetches() {
    const pending: Array<() => void> = [];
    mockFetchWithTimeout.mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          pending.push(() => resolve(results()));
        }),
    );
    return pending;
  }

  /** The `query` each request carried, in start order. */
  const sentQueries = () =>
    mockFetchWithTimeout.mock.calls.map((call) =>
      new URL(String(call[0])).searchParams.get('query'),
    );

  let randomSpy: ReturnType<typeof vi.spyOn>;
  let t0: number;
  /** Start instants of every upstream request, relative to the test's start. */
  let starts: number[];

  beforeEach(() => {
    vi.useFakeTimers();
    mockFetchWithTimeout.mockReset();
    randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0.5);
    t0 = Date.now();
    starts = [];
  });

  afterEach(() => {
    randomSpy.mockRestore();
    vi.useRealTimers();
  });

  /** Records each request's start instant, then answers with `reply`. */
  function recordStarts(reply: (query: string | null) => Promise<Response>) {
    mockFetchWithTimeout.mockImplementation((url: string) => {
      starts.push(Date.now() - t0);
      return reply(new URL(url).searchParams.get('query'));
    });
  }

  it('holds in-flight requests to four across search, fullTextXml, and the link calls', async () => {
    const release = heldFetches();
    const service = makeService();
    const calls = [
      service.search({ query: 'a' }),
      service.fullTextXml('PMC1', 'PMC'),
      service.citations('1', 10, 1),
      service.references('2', 10, 1),
      service.search({ query: 'e' }),
      service.fullTextXml('PMC6', 'PMC'),
    ];

    await vi.advanceTimersByTimeAsync(0);
    expect(mockFetchWithTimeout).toHaveBeenCalledTimes(4);

    release.shift()?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(mockFetchWithTimeout).toHaveBeenCalledTimes(5);

    while (release.length > 0) {
      release.shift()?.();
      await vi.advanceTimersByTimeAsync(0);
    }
    await expect(Promise.all(calls)).resolves.toHaveLength(6);
    expect(mockFetchWithTimeout).toHaveBeenCalledTimes(6);
  });

  it('spaces request starts by the configured gap', async () => {
    recordStarts(() => Promise.resolve(results()));
    const service = makeService({ minStartGapMs: 200 });

    const calls = ['a', 'b', 'c'].map((query) => service.search({ query }));
    await vi.advanceTimersByTimeAsync(1_000);

    await expect(Promise.all(calls)).resolves.toHaveLength(3);
    expect(starts).toEqual([0, 200, 400]);
  });

  it('queues callers without a depth cap, so none is shed', async () => {
    mockFetchWithTimeout.mockImplementation(() => Promise.resolve(results()));
    const service = makeService();

    const calls = Array.from({ length: 150 }, (_, i) => service.search({ query: `q${i}` }));
    await vi.advanceTimersByTimeAsync(0);

    const settled = await Promise.allSettled(calls);
    expect(settled.filter((s) => s.status === 'rejected')).toEqual([]);
    expect(mockFetchWithTimeout).toHaveBeenCalledTimes(150);
  });

  it('rejects a queued caller with its own abort reason and never sends its request', async () => {
    const release = heldFetches();
    const service = makeService();
    const inFlight = ['a', 'b', 'c', 'd'].map((query) => service.search({ query }));
    await vi.advanceTimersByTimeAsync(0);

    const controller = new AbortController();
    const queued = service.search({ query: 'queued', signal: controller.signal });
    await vi.advanceTimersByTimeAsync(0);
    const reason = new Error('caller went away');
    controller.abort(reason);

    await expect(queued).rejects.toBe(reason);
    expect(sentQueries()).not.toContain('queued');

    for (const settle of release.splice(0)) settle();
    await expect(Promise.all(inFlight)).resolves.toHaveLength(4);
    expect(mockFetchWithTimeout).toHaveBeenCalledTimes(4);
  });

  it('rejects a caller that aborts mid-backoff with its own reason, without another attempt', async () => {
    recordStarts(() => Promise.reject(unavailable()));
    const service = makeService({ maxRetries: 3 });
    const controller = new AbortController();

    const call = service.search({ query: 'a', signal: controller.signal });
    const outcome = expect(call).rejects.toBe('caller went away');
    await vi.advanceTimersByTimeAsync(500);
    controller.abort('caller went away');
    await outcome;

    await vi.advanceTimersByTimeAsync(60_000);
    expect(starts).toEqual([0]);
  });

  it('backs off 1 s, doubling per attempt, capped at 30 s', async () => {
    recordStarts(() => Promise.reject(unavailable()));
    const service = makeService({ maxRetries: 6 });

    const outcome = expect(service.search({ query: 'a' })).rejects.toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      data: { reason: 'europepmc_unreachable', attempts: 7 },
    });
    await vi.advanceTimersByTimeAsync(120_000);
    await outcome;

    // Waits of 1, 2, 4, 8, 16, then 30 s (32 s capped) between the seven attempts.
    expect(starts).toEqual([0, 1_000, 3_000, 7_000, 15_000, 31_000, 61_000]);
  });

  it('draws each backoff from ±25% of the doubled base', async () => {
    randomSpy.mockReturnValue(0);
    recordStarts(() => Promise.reject(unavailable()));
    const service = makeService({ maxRetries: 2 });

    const outcome = expect(service.search({ query: 'a' })).rejects.toMatchObject({
      data: { attempts: 3 },
    });
    await vi.advanceTimersByTimeAsync(10_000);
    await outcome;

    // 0.75 × 1 s, then 0.75 × 2 s.
    expect(starts).toEqual([0, 750, 2_250]);
  });

  it('waits an upstream Retry-After in place of the exponential backoff', async () => {
    let failed = false;
    recordStarts(() => {
      if (failed) return Promise.resolve(results());
      failed = true;
      return Promise.reject(httpErrorRejection(429, JsonRpcErrorCode.RateLimited, '', '3'));
    });
    const service = makeService({ maxRetries: 3 });

    const call = service.search({ query: 'a' });
    await vi.advanceTimersByTimeAsync(5_000);

    await expect(call).resolves.toMatchObject({ hitCount: 1 });
    expect(starts).toEqual([0, 3_000]);
  });

  it('paces the first-page probe for a 503 cursor through the queue like any request (#180)', async () => {
    mockFetchWithTimeout.mockImplementation((url: string) => {
      starts.push(Date.now() - t0);
      return new URL(url).searchParams.get('cursorMark') === '*'
        ? Promise.resolve(results())
        : Promise.reject(unavailable());
    });
    const service = makeService({ maxRetries: 3, minStartGapMs: 200 });

    const outcome = expect(service.search({ query: 'a', cursorMark: 'abc' })).rejects.toMatchObject(
      { code: JsonRpcErrorCode.ValidationError, data: { reason: 'europepmc_invalid_input' } },
    );
    await vi.advanceTimersByTimeAsync(60_000);
    await outcome;

    // The probe waits out the start gap instead of riding the failed request's
    // slot; the retry that confirms the cursor follows the 1 s backoff.
    expect(starts).toEqual([0, 200, 1_200]);
  });

  it('fails fast with the 429 and its retryAfter when Retry-After exceeds the 30 s backoff cap', async () => {
    recordStarts(() =>
      Promise.reject(httpErrorRejection(429, JsonRpcErrorCode.RateLimited, '', '120')),
    );
    const service = makeService({ maxRetries: 3 });

    const outcome = expect(service.search({ query: 'a' })).rejects.toMatchObject({
      code: JsonRpcErrorCode.RateLimited,
      message: 'Fetch failed for <upstream>. Status: 429',
      data: { retryAfter: '120' },
    });
    await vi.advanceTimersByTimeAsync(0);
    await outcome;
    expect(starts).toEqual([0]);
  });

  /**
   * A retry's backoff sleep runs outside the pacer: the failed attempt gives its
   * slot back, so four callers backing off at once leave room for a fifth. (#163)
   */
  it('lets a fifth caller start while four others are mid-backoff (#163)', async () => {
    const failedOnce = new Set<string | null>();
    recordStarts((query) => {
      if (query !== 'e' && !failedOnce.has(query)) {
        failedOnce.add(query);
        return Promise.reject(unavailable());
      }
      return Promise.resolve(results());
    });
    const service = makeService({ maxRetries: 3, minStartGapMs: 200 });

    // Four first attempts start at 0/200/400/600 ms and fail; each retries 1 s later.
    const first = ['a', 'b', 'c', 'd'].map((query) => service.search({ query }));
    await vi.advanceTimersByTimeAsync(650);
    expect(starts).toEqual([0, 200, 400, 600]);

    const fifth = service.search({ query: 'e' });
    await vi.advanceTimersByTimeAsync(200);
    // All four are still sleeping (their retries are due at 1000 ms and later).
    expect(sentQueries()).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(starts).toEqual([0, 200, 400, 600, 800]);

    await vi.advanceTimersByTimeAsync(5_000);
    await expect(Promise.all([...first, fifth])).resolves.toHaveLength(5);
  });

  /**
   * Each retry re-enters the pacer, so it waits out the start gap measured from
   * the last request any caller started — not only its own previous attempt. (#163)
   */
  it('spaces a retry attempt from the last start by any caller (#163)', async () => {
    let failed = false;
    recordStarts((query) => {
      if (query === 'a' && !failed) {
        failed = true;
        return Promise.reject(unavailable());
      }
      return Promise.resolve(results());
    });
    const service = makeService({ maxRetries: 3, minStartGapMs: 200 });

    const retrying = service.search({ query: 'a' });
    await vi.advanceTimersByTimeAsync(900);
    const other = service.search({ query: 'b' });
    await vi.advanceTimersByTimeAsync(1_000);

    await expect(Promise.all([retrying, other])).resolves.toHaveLength(2);
    // The retry is due at 1000 ms, but `b` started at 900 ms, so it waits until 1100 ms.
    expect(sentQueries()).toEqual(['a', 'b', 'a']);
    expect(starts).toEqual([0, 900, 1_100]);
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
    await expect(service.fullTextXml('X', 'PMC')).rejects.toMatchObject(UNREACHABLE_AFTER_ONE_503);
  });

  it('never gives a search 404 the fullTextXML `not-available` treatment', async () => {
    // The 404 → `not-available` conversion is scoped to fullTextXml (#90). A
    // failed search is not "no record" — it is an outage, surfaced as
    // `europepmc_unreachable` rather than a bare NotFound. (#152)
    mockFetchWithTimeout.mockRejectedValue(
      httpErrorRejection(404, JsonRpcErrorCode.NotFound, 'nope'),
    );
    const service = makeService();
    // No retries configured: one attempt, reported in the singular.
    await expect(service.search({ query: 'foo' })).rejects.toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      message: expect.stringMatching(/Status: 404.*\(failed after 1 attempt\)$/),
      data: { reason: 'europepmc_unreachable', attempts: 1 },
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
    if (!node) throw new Error('expected an <article> node');
    expect(parsePmcArticle(node)).toMatchObject({
      title: 'Hi',
      sections: [{ title: 'Intro', text: 'Body' }],
    });
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

  /**
   * Europe PMC's `fullTextXML` feeds the same `parsePmcArticle`, so a cell or
   * footer that breaks lines in the JATS reads the same as on the PMC tier.
   * The fixture is PMC11519154's Table 1, as Europe PMC serves it. (#185)
   */
  it('keeps the line structure of table cells and footnotes (PMC11519154)', () => {
    const node = makeService().parseFullTextXml(
      `<?xml version="1.0" encoding="UTF-8"?>
<article><front><article-meta><article-id pub-id-type="pmcid">PMC11519154</article-id></article-meta></front><body><sec><title>Results</title>
<table-wrap id="Tab1" position="float" orientation="portrait"><label>Table\u00a01</label><caption><p>Participant characteristics</p></caption><table frame="hsides" rules="groups"><thead><tr><th align="left" colspan="1" rowspan="1"/><th align="left" colspan="1" rowspan="1">DR-group<break/>(<italic toggle="yes">n</italic>\u2009=\u200946)</th><th align="left" colspan="1" rowspan="1">DM-group<break/>(<italic toggle="yes">n</italic>\u2009=\u200953)</th></tr></thead>
<tbody><tr><td align="left" colspan="1" rowspan="1">\u00a0\u00a0Sex (male:female)</td><td align="left" colspan="1" rowspan="1">19:27</td><td align="left" colspan="1" rowspan="1">0.108<sup>a</sup></td></tr></tbody></table>
<table-wrap-foot><p><sup>a</sup>Fisher’s exact test</p><p><sup>b</sup>Mann–Whitney test</p></table-wrap-foot></table-wrap></sec></body></article>`,
    );
    if (!node) throw new Error('expected an <article> node');
    const table = parsePmcArticle(node).tables?.[0];
    expect(table?.rows).toEqual([
      ['', 'DR-group\n(n = 46)', 'DM-group\n(n = 53)'],
      ['Sex (male:female)', '19:27', '0.108a'],
    ]);
    // Two <p>s, two lines; each marker is an inline <sup>, so it stays attached.
    expect(table?.footnotes).toBe('aFisher’s exact test\nbMann–Whitney test');
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
        retryable: false,
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
    await expect(service.citations('12345', 10, 1)).rejects.toMatchObject(
      UNREACHABLE_AFTER_ONE_503,
    );
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
    await service.references('31295471', 10, 2);
    const url = new URL(String(mockFetchWithTimeout.mock.calls[0]?.[0]));
    expect(url.pathname).toMatch(/\/MED\/31295471\/references$/);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      page: '2',
      pageSize: '10',
      format: 'json',
    });
  });
});

/**
 * A body that fails mid-stream with a rejection quoting the request URL whole, as Bun
 * 1.4 writes some of them, reaches the caller naming only the host: a search URL
 * carries the caller's query and the operator's contact email.
 */
describe('a body read failure keeps the request URL out of its message', () => {
  beforeEach(() => mockFetchWithTimeout.mockReset());

  const client = () => new EuropePmcApiClient({ email: 'ops@example.org', timeoutMs: 20000 });

  it.each([
    ['search', () => client().search({ query: 'asthma' })],
    ['fullTextXml', () => client().fullTextXml('PMC1')],
    ['citations', () => client().citations('31295471', 10, 1)],
  ])('%s', async (_label, call) => {
    const url =
      'https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=asthma&email=ops%40example.org';
    const rejection = Object.assign(new TypeError(`InvalidHTTPResponse fetching "${url}"`), {
      code: 'InvalidHTTPResponse',
      path: url,
    });
    const body = new ReadableStream({ start: (controller) => controller.error(rejection) });
    mockFetchWithTimeout.mockResolvedValue(new Response(body, { status: 200 }));

    const err = await call().catch((e: unknown) => e);

    // The same rejection, its classification unchanged; only its text is redacted.
    expect(err).toBe(rejection);
    expect((err as Error).message).toBe('InvalidHTTPResponse fetching "https://www.ebi.ac.uk/…?…"');
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
