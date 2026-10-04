/**
 * @fileoverview Retry-gate regression for the three service retry loops — NCBI's and
 * Europe PMC's on the framework `withRetry`, OpenAlex's hand-rolled. Each gates on the
 * framework's `defaultIsTransient`, so each must honor its in-band
 * `data.retryable === false` opt-out: an upstream 501
 * classifies as ServiceUnavailable — a transient code — but can never succeed on retry.
 * Also pins the shape of OpenAlex's exhausted error per code (#160).
 *
 * Every case asserts the upstream attempt count, not just the surfaced code: a gate
 * that burned its full budget before failing would still throw the same code.
 * @module tests/services/retry-gate.test
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockFetchWithTimeout = vi.fn();

// Keep `httpErrorFromResponse` real — it applies the framework's status table and
// stamps the 501 opt-out, which is the behavior under test. Silence logging only.
vi.mock('@cyanheads/mcp-ts-core/utils', async () => {
  const actual = await vi.importActual<typeof import('@cyanheads/mcp-ts-core/utils')>(
    '@cyanheads/mcp-ts-core/utils',
  );
  return {
    ...actual,
    fetchWithTimeout: mockFetchWithTimeout,
    logger: { debug: vi.fn(), info: vi.fn(), notice: vi.fn(), warning: vi.fn(), error: vi.fn() },
  };
});

const { createPacer, httpErrorFromResponse } = await import('@cyanheads/mcp-ts-core/utils');
const { NcbiApiClient } = await import('@/services/ncbi/api-client.js');
const { NcbiService } = await import('@/services/ncbi/ncbi-service.js');
const { NcbiResponseHandler } = await import('@/services/ncbi/response-handler.js');
const { EuropePmcApiClient } = await import('@/services/europe-pmc/api-client.js');
const { createEuropePmcRequestQueue } = await import('@/services/europe-pmc/request-queue.js');
const { EuropePmcService } = await import('@/services/europe-pmc/europe-pmc-service.js');
const { OpenAlexApiClient } = await import('@/services/openalex/api-client.js');
const { OpenAlexService } = await import('@/services/openalex/openalex-service.js');

/** Two retries after the initial call — an unfiltered gate makes three upstream attempts. */
const MAX_RETRIES = 2;
const EXHAUSTED_ATTEMPTS = MAX_RETRIES + 1;

/**
 * The error `fetchWithTimeout` throws on a non-2xx. Built from the real
 * `httpErrorFromResponse` — both HTTP helpers route through the same status table and
 * retryability verdict, so the fixture cannot drift from the framework.
 */
function fetchHttpError(status: number): Promise<McpError> {
  return httpErrorFromResponse(new Response('', { status }), {
    service: 'upstream',
    data: { errorSource: 'FetchHttpError' },
  });
}

/** A transient failure the upstream explicitly marks as worth retrying. */
function retryableError(): McpError {
  return new McpError(JsonRpcErrorCode.ServiceUnavailable, 'upstream hiccup', { retryable: true });
}

let fetchSpy: ReturnType<typeof vi.spyOn> | undefined;
let setTimeoutSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  mockFetchWithTimeout.mockReset();
  mockFetchWithTimeout.mockRejectedValue(new Error('unmocked fetchWithTimeout'));
  fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('unmocked fetch'));
  // Fire backoff sleeps immediately so an exhausted retry chain doesn't actually wait.
  setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((
    fn: () => void,
    ms?: number,
  ) => {
    if (typeof ms === 'number' && ms >= 50_000) {
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }
    fn();
    return 0 as unknown as ReturnType<typeof setTimeout>;
  }) as unknown as typeof setTimeout);
});

afterEach(() => {
  setTimeoutSpy.mockRestore();
  fetchSpy?.mockRestore();
  fetchSpy = undefined;
});

function buildNcbiService() {
  const apiClient = new NcbiApiClient({ toolIdentifier: 'test', timeoutMs: 5000 });
  // A real pacer with no limits: every attempt starts at once and no timer is armed.
  const queue = createPacer({ name: 'ncbi-test' });
  return new NcbiService(apiClient, queue, new NcbiResponseHandler(), MAX_RETRIES, 60_000);
}

function buildEuropePmcService() {
  const client = new EuropePmcApiClient({ timeoutMs: 20_000 });
  return new EuropePmcService(client, createEuropePmcRequestQueue(0), MAX_RETRIES);
}

function buildOpenAlexService() {
  return new OpenAlexService(new OpenAlexApiClient({ timeoutMs: 20_000 }), MAX_RETRIES);
}

describe('NcbiService retry gate', () => {
  it('fails an upstream 501 on the first attempt', async () => {
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 501 }));

    await expect(
      buildNcbiService().eSearch({ db: 'pubmed', term: 'cancer' }),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      data: { retryable: false },
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('retries an upstream 503 to exhaustion', async () => {
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 503 }));

    await expect(
      buildNcbiService().eSearch({ db: 'pubmed', term: 'cancer' }),
    ).rejects.toMatchObject({ code: JsonRpcErrorCode.ServiceUnavailable });
    expect(fetchSpy).toHaveBeenCalledTimes(EXHAUSTED_ATTEMPTS);
  });

  it('retries a transient failure explicitly marked retryable', async () => {
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(retryableError());

    await expect(
      buildNcbiService().eSearch({ db: 'pubmed', term: 'cancer' }),
    ).rejects.toMatchObject({ code: JsonRpcErrorCode.ServiceUnavailable });
    expect(fetchSpy).toHaveBeenCalledTimes(EXHAUSTED_ATTEMPTS);
  });
});

describe('EuropePmcService retry gate', () => {
  it('fails an upstream 501 on the first attempt', async () => {
    mockFetchWithTimeout.mockRejectedValue(await fetchHttpError(501));

    await expect(buildEuropePmcService().search({ query: 'cancer' })).rejects.toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      data: { retryable: false },
    });
    expect(mockFetchWithTimeout).toHaveBeenCalledTimes(1);
  });

  it('retries an upstream 503 to exhaustion', async () => {
    mockFetchWithTimeout.mockRejectedValue(await fetchHttpError(503));

    await expect(buildEuropePmcService().search({ query: 'cancer' })).rejects.toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      data: { reason: 'europepmc_unreachable' },
    });
    expect(mockFetchWithTimeout).toHaveBeenCalledTimes(EXHAUSTED_ATTEMPTS);
  });

  it('retries a transient failure explicitly marked retryable', async () => {
    mockFetchWithTimeout.mockRejectedValue(retryableError());

    await expect(buildEuropePmcService().search({ query: 'cancer' })).rejects.toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
    });
    expect(mockFetchWithTimeout).toHaveBeenCalledTimes(EXHAUSTED_ATTEMPTS);
  });
});

describe('OpenAlexService retry gate', () => {
  it('fails an upstream 501 on the first attempt', async () => {
    mockFetchWithTimeout.mockRejectedValue(await fetchHttpError(501));

    await expect(buildOpenAlexService().similar('31295471', 10)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      data: { retryable: false },
    });
    expect(mockFetchWithTimeout).toHaveBeenCalledTimes(1);
  });

  it('retries an upstream 503 to exhaustion', async () => {
    mockFetchWithTimeout.mockRejectedValue(await fetchHttpError(503));

    await expect(buildOpenAlexService().similar('31295471', 10)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      data: { reason: 'openalex_unreachable' },
    });
    expect(mockFetchWithTimeout).toHaveBeenCalledTimes(EXHAUSTED_ATTEMPTS);
  });

  it('retries a transient failure explicitly marked retryable', async () => {
    mockFetchWithTimeout.mockRejectedValue(retryableError());

    await expect(buildOpenAlexService().similar('31295471', 10)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
    });
    expect(mockFetchWithTimeout).toHaveBeenCalledTimes(EXHAUSTED_ATTEMPTS);
  });

  /**
   * `openalex_unreachable` is declared for `ServiceUnavailable` only. An exhausted
   * Timeout or RateLimited keeps its own code and says what it is through that code
   * and its message, carrying the attempt count and any upstream `retryAfter`. (#160)
   */
  describe('exhaustion shape (#160)', () => {
    const suffix = new RegExp(`\\(failed after ${EXHAUSTED_ATTEMPTS} attempts\\)$`);

    it('reports a single attempt in the singular when no retries are configured', async () => {
      mockFetchWithTimeout.mockRejectedValue(await fetchHttpError(503));

      const err = (await new OpenAlexService(new OpenAlexApiClient({ timeoutMs: 20_000 }), 0)
        .similar('31295471', 10)
        .catch((e: unknown) => e)) as McpError;

      expect(err.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
      expect(err.message).toMatch(/\(failed after 1 attempt\)$/);
      expect(err.data).toMatchObject({ reason: 'openalex_unreachable', attempts: 1 });
      expect(mockFetchWithTimeout).toHaveBeenCalledTimes(1);
    });

    it('keeps an exhausted 429 RateLimited with its retryAfter and no reason', async () => {
      mockFetchWithTimeout.mockRejectedValue(
        new McpError(JsonRpcErrorCode.RateLimited, 'Fetch failed. Status: 429', {
          status: 429,
          retryAfter: '5',
          errorSource: 'FetchHttpError',
        }),
      );

      const err = (await buildOpenAlexService()
        .citedBy('31295471', 25)
        .catch((e: unknown) => e)) as McpError;

      expect(err).toBeInstanceOf(McpError);
      expect(err.code).toBe(JsonRpcErrorCode.RateLimited);
      expect(err.message).toMatch(suffix);
      expect(err.data?.reason).toBeUndefined();
      expect(err.data?.recovery).toBeUndefined();
      expect(err.data?.attempts).toBe(EXHAUSTED_ATTEMPTS);
      expect(err.data?.retryAfter).toBe('5');
      expect(mockFetchWithTimeout).toHaveBeenCalledTimes(EXHAUSTED_ATTEMPTS);
    });

    it('keeps an exhausted request timeout as Timeout with no reason', async () => {
      mockFetchWithTimeout.mockRejectedValue(
        new McpError(JsonRpcErrorCode.Timeout, 'Request timed out after 20000ms.', {
          errorSource: 'FetchTimeout',
        }),
      );

      const err = (await buildOpenAlexService()
        .references('31295471', 10)
        .catch((e: unknown) => e)) as McpError;

      expect(err.code).toBe(JsonRpcErrorCode.Timeout);
      expect(err.message).toMatch(suffix);
      expect(err.data?.reason).toBeUndefined();
      expect(err.data?.recovery).toBeUndefined();
      expect(err.data?.attempts).toBe(EXHAUSTED_ATTEMPTS);
      expect(mockFetchWithTimeout).toHaveBeenCalledTimes(EXHAUSTED_ATTEMPTS);
    });

    it('keeps an exhausted 504 as Timeout with no reason', async () => {
      mockFetchWithTimeout.mockRejectedValue(await fetchHttpError(504));

      const err = (await buildOpenAlexService()
        .similar('31295471', 10)
        .catch((e: unknown) => e)) as McpError;

      expect(err.code).toBe(JsonRpcErrorCode.Timeout);
      expect(err.data?.reason).toBeUndefined();
      expect(err.data?.attempts).toBe(EXHAUSTED_ATTEMPTS);
      expect(mockFetchWithTimeout).toHaveBeenCalledTimes(EXHAUSTED_ATTEMPTS);
    });

    it('stamps an exhausted ServiceUnavailable openalex_unreachable with retryAfter', async () => {
      mockFetchWithTimeout.mockRejectedValue(
        new McpError(JsonRpcErrorCode.ServiceUnavailable, 'Fetch failed. Status: 503', {
          status: 503,
          retryAfter: '9',
          errorSource: 'FetchHttpError',
        }),
      );

      const err = (await buildOpenAlexService()
        .citedBy('31295471', 25)
        .catch((e: unknown) => e)) as McpError;

      expect(err.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
      expect(err.message).toMatch(suffix);
      expect(err.data).toMatchObject({
        reason: 'openalex_unreachable',
        attempts: EXHAUSTED_ATTEMPTS,
        retryAfter: '9',
      });
      expect(mockFetchWithTimeout).toHaveBeenCalledTimes(EXHAUSTED_ATTEMPTS);
    });
  });

  /**
   * The client stamps a body it cannot parse `openalex_invalid_response`; once retries
   * run out, the last attempt's reason is the one reported. `openalex_unreachable` is
   * only the fallback for a `ServiceUnavailable` that carries no reason. (#182)
   */
  describe('exhaustion keeps the last attempt’s reason (#182)', () => {
    const PMID = '31452104';
    const WORK = {
      id: 'https://openalex.org/W2964120015',
      related_works: ['https://openalex.org/W1'],
      referenced_works: ['https://openalex.org/W2'],
    };
    const suffix = new RegExp(`\\(failed after ${EXHAUSTED_ATTEMPTS} attempts\\)$`);
    const nonJson = () => new Response('<html>oops</html>', { status: 200 });

    /** Which client method a `fetchWithTimeout` URL belongs to. */
    function routeOf(url: string): 'work' | 'citedBy' | 'resolve' {
      const decoded = decodeURIComponent(url);
      if (decoded.includes('/works/pmid:')) return 'work';
      if (decoded.includes('filter=cites:')) return 'citedBy';
      if (decoded.includes('filter=openalex:')) return 'resolve';
      throw new Error(`unrouted OpenAlex URL: ${url}`);
    }

    /** Serve the source work as JSON and answer `failing` with a non-JSON body. */
    function failOn(failing: 'work' | 'citedBy' | 'resolve') {
      mockFetchWithTimeout.mockImplementation(async (url: string) => {
        const route = routeOf(url);
        if (route === failing) return nonJson();
        if (route === 'work') return new Response(JSON.stringify(WORK), { status: 200 });
        throw new Error(`unexpected ${route} request`);
      });
    }

    it.each([
      [
        'getWorkByPmid',
        'work',
        (s: InstanceType<typeof OpenAlexService>) => s.similar(PMID, 10),
        `getWorkByPmid(${PMID})`,
        EXHAUSTED_ATTEMPTS,
      ],
      [
        'getCitedBy',
        'citedBy',
        (s: InstanceType<typeof OpenAlexService>) => s.citedBy(PMID, 10),
        `getCitedBy(${WORK.id}, page 1)`,
        1 + EXHAUSTED_ATTEMPTS,
      ],
      [
        'resolveOaIdsToPmids',
        'resolve',
        (s: InstanceType<typeof OpenAlexService>) => s.references(PMID, 10),
        `resolveReferencedWorks(${PMID})`,
        1 + EXHAUSTED_ATTEMPTS,
      ],
    ] as const)(
      'reports an exhausted non-JSON body from %s as openalex_invalid_response',
      async (_method, route, call, label, requests) => {
        failOn(route);

        const err = (await call(buildOpenAlexService()).catch((e: unknown) => e)) as McpError;

        expect(err).toBeInstanceOf(McpError);
        expect(err.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
        expect(err.message).toBe(
          `OpenAlex returned a non-JSON body. (failed after ${EXHAUSTED_ATTEMPTS} attempts)`,
        );
        expect(err.data).toEqual({
          reason: 'openalex_invalid_response',
          label,
          attempts: EXHAUSTED_ATTEMPTS,
        });
        expect((err.cause as McpError).data?.reason).toBe('openalex_invalid_response');
        expect(mockFetchWithTimeout).toHaveBeenCalledTimes(requests);
      },
    );

    it('lets the last attempt decide: non-JSON bodies, then a reasonless 503', async () => {
      const unavailable = await fetchHttpError(503);
      mockFetchWithTimeout
        .mockImplementationOnce(async () => nonJson())
        .mockImplementationOnce(async () => nonJson())
        .mockRejectedValueOnce(unavailable);

      const err = (await buildOpenAlexService()
        .similar(PMID, 10)
        .catch((e: unknown) => e)) as McpError;

      expect(err.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
      expect(err.message).toMatch(suffix);
      expect(err.data).toMatchObject({ reason: 'openalex_unreachable', attempts: 3 });
      expect(mockFetchWithTimeout).toHaveBeenCalledTimes(EXHAUSTED_ATTEMPTS);
    });

    it('lets the last attempt decide: reasonless 503s, then a non-JSON body', async () => {
      const unavailable = await fetchHttpError(503);
      mockFetchWithTimeout
        .mockRejectedValueOnce(unavailable)
        .mockRejectedValueOnce(unavailable)
        .mockImplementationOnce(async () => nonJson());

      const err = (await buildOpenAlexService()
        .similar(PMID, 10)
        .catch((e: unknown) => e)) as McpError;

      expect(err.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
      expect(err.message).toBe(
        `OpenAlex returned a non-JSON body. (failed after ${EXHAUSTED_ATTEMPTS} attempts)`,
      );
      expect(err.data).toMatchObject({ reason: 'openalex_invalid_response', attempts: 3 });
      expect(mockFetchWithTimeout).toHaveBeenCalledTimes(EXHAUSTED_ATTEMPTS);
    });

    it('recovers when a later attempt parses', async () => {
      mockFetchWithTimeout
        .mockImplementationOnce(async () => nonJson())
        .mockImplementationOnce(async () => new Response('null', { status: 200 }));

      await expect(buildOpenAlexService().similar(PMID, 10)).resolves.toMatchObject({
        pmids: [],
        totalCount: 0,
      });
      expect(mockFetchWithTimeout).toHaveBeenCalledTimes(2);
    });
  });
});
