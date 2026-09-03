/**
 * @fileoverview Retry-gate regression for the three hand-rolled service retry loops
 * (NCBI, OpenAlex, Europe PMC). Each decides transience from the error code alone, so
 * each must also honor the framework's in-band `data.retryable === false` opt-out the
 * way `withRetry`'s `defaultIsTransient` does: an upstream 501 classifies as
 * ServiceUnavailable — a transient code — but can never succeed on retry.
 *
 * Every case asserts the upstream attempt count, not just the surfaced code: a gate
 * that burned its full budget before failing would still throw the same code.
 * @module tests/services/retry-policy.test
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

const { httpErrorFromResponse } = await import('@cyanheads/mcp-ts-core/utils');
const { NcbiApiClient } = await import('@/services/ncbi/api-client.js');
const { NcbiService } = await import('@/services/ncbi/ncbi-service.js');
const { NcbiResponseHandler } = await import('@/services/ncbi/response-handler.js');
const { EuropePmcApiClient } = await import('@/services/europe-pmc/api-client.js');
const { EuropePmcRequestQueue } = await import('@/services/europe-pmc/request-queue.js');
const { EuropePmcService } = await import('@/services/europe-pmc/europe-pmc-service.js');
const { OpenAlexApiClient } = await import('@/services/openalex/api-client.js');
const { OpenAlexService } = await import('@/services/openalex/openalex-service.js');

type NcbiRequestQueue = import('@/services/ncbi/request-queue.js').NcbiRequestQueue;

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
  const queue = {
    enqueue: vi.fn(async (task: () => Promise<unknown>) => task()),
  } as unknown as NcbiRequestQueue;
  return new NcbiService(apiClient, queue, new NcbiResponseHandler(), MAX_RETRIES, 60_000);
}

function buildEuropePmcService() {
  const client = new EuropePmcApiClient({ timeoutMs: 20_000 });
  return new EuropePmcService(client, new EuropePmcRequestQueue(0), MAX_RETRIES);
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
});
