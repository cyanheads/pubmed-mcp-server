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

    it('stamps an exhausted ServiceUnavailable openalex_unreachable with its hint and retryAfter', async () => {
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
        recovery: { hint: expect.stringContaining('OpenAlex was unreachable') },
        attempts: EXHAUSTED_ATTEMPTS,
        retryAfter: '9',
      });
      expect(mockFetchWithTimeout).toHaveBeenCalledTimes(EXHAUSTED_ATTEMPTS);
    });
  });
});
