/**
 * @fileoverview Tests for NcbiService retry logic, verifying that retries cover
 * both HTTP-level failures and XML-level NCBI errors with proper backoff.
 * @module src/services/ncbi/ncbi-service.test
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { NcbiApiClient } from './api-client.js';
import { NcbiService } from './ncbi-service.js';
import type { NcbiRequestQueue } from './request-queue.js';
import type { NcbiResponseHandler } from './response-handler.js';

vi.mock('@cyanheads/mcp-ts-core/utils', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), notice: vi.fn(), warning: vi.fn(), error: vi.fn() },
  fetchWithTimeout: vi.fn(),
  requestContextService: { createRequestContext: vi.fn() },
}));

/** Queue mock that directly executes the task — isolates retry logic from queue scheduling. */
function mockQueue(): NcbiRequestQueue {
  return {
    enqueue: vi.fn(async (task: () => Promise<unknown>) => task()),
  } as unknown as NcbiRequestQueue;
}

const MAX_RETRIES = 3;

describe('NcbiService retry logic', () => {
  const makeRequest = vi.fn();
  const parseAndHandleResponse = vi.fn();
  let service: NcbiService;
  let setTimeoutSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    makeRequest.mockReset();
    parseAndHandleResponse.mockReset();
    // Make retry backoff execute instantly for testing
    setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void) => {
      fn();
      return 0;
    }) as unknown as typeof setTimeout);

    service = new NcbiService(
      { makeRequest } as unknown as NcbiApiClient,
      mockQueue(),
      { parseAndHandleResponse } as unknown as NcbiResponseHandler,
      MAX_RETRIES,
    );
  });

  afterEach(() => {
    setTimeoutSpy.mockRestore();
  });

  it('succeeds on first attempt without retrying', async () => {
    makeRequest.mockResolvedValue('<xml/>');
    parseAndHandleResponse.mockReturnValue({ ok: true });

    const result = await service.eLink({ db: 'pubmed', id: '123' });

    expect(result).toEqual({ ok: true });
    expect(makeRequest).toHaveBeenCalledTimes(1);
    expect(parseAndHandleResponse).toHaveBeenCalledTimes(1);
  });

  it('retries on HTTP-level ServiceUnavailable (network error)', async () => {
    makeRequest
      .mockRejectedValueOnce(new McpError(JsonRpcErrorCode.ServiceUnavailable, 'ECONNRESET'))
      .mockResolvedValueOnce('<xml/>');
    parseAndHandleResponse.mockReturnValue({ ok: true });

    const result = await service.eLink({ db: 'pubmed', id: '123' });

    expect(result).toEqual({ ok: true });
    expect(makeRequest).toHaveBeenCalledTimes(2);
    expect(parseAndHandleResponse).toHaveBeenCalledTimes(1);
  });

  it('retries on XML-level ServiceUnavailable (NCBI body error)', async () => {
    makeRequest.mockResolvedValue('<xml/>');
    parseAndHandleResponse
      .mockImplementationOnce(() => {
        throw new McpError(
          JsonRpcErrorCode.ServiceUnavailable,
          'NCBI API temporarily unavailable (connection reset)',
        );
      })
      .mockReturnValueOnce({ ok: true });

    const result = await service.eLink({ db: 'pubmed', id: '123' });

    expect(result).toEqual({ ok: true });
    expect(makeRequest).toHaveBeenCalledTimes(2);
    expect(parseAndHandleResponse).toHaveBeenCalledTimes(2);
  });

  it('retries on Timeout errors', async () => {
    makeRequest
      .mockRejectedValueOnce(new McpError(JsonRpcErrorCode.Timeout, 'timed out'))
      .mockResolvedValueOnce('<xml/>');
    parseAndHandleResponse.mockReturnValue({ ok: true });

    const result = await service.eLink({ db: 'pubmed', id: '123' });

    expect(result).toEqual({ ok: true });
    expect(makeRequest).toHaveBeenCalledTimes(2);
  });

  it('retries plain Errors (unwrapped network failures)', async () => {
    makeRequest.mockRejectedValueOnce(new Error('socket hang up')).mockResolvedValueOnce('<xml/>');
    parseAndHandleResponse.mockReturnValue({ ok: true });

    const result = await service.eLink({ db: 'pubmed', id: '123' });

    expect(result).toEqual({ ok: true });
    expect(makeRequest).toHaveBeenCalledTimes(2);
  });

  it('does not retry non-transient McpErrors', async () => {
    makeRequest.mockResolvedValue('<bad>');
    parseAndHandleResponse.mockImplementation(() => {
      throw new McpError(JsonRpcErrorCode.SerializationError, 'Invalid XML');
    });

    await expect(service.eLink({ db: 'pubmed', id: '123' })).rejects.toThrow('Invalid XML');
    expect(makeRequest).toHaveBeenCalledTimes(1);
    expect(parseAndHandleResponse).toHaveBeenCalledTimes(1);
  });

  it('includes attempt count when all retries are exhausted', async () => {
    makeRequest.mockRejectedValue(
      new McpError(JsonRpcErrorCode.ServiceUnavailable, 'connection reset'),
    );

    await expect(service.eLink({ db: 'pubmed', id: '123' })).rejects.toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      message: expect.stringContaining(`failed after ${MAX_RETRIES + 1} attempts`),
    });
    expect(makeRequest).toHaveBeenCalledTimes(MAX_RETRIES + 1);
  });

  it('applies exponential backoff: 1s, 2s, 4s', async () => {
    makeRequest.mockRejectedValue(new McpError(JsonRpcErrorCode.ServiceUnavailable, 'unavailable'));

    await service.eLink({ db: 'pubmed', id: '123' }).catch(() => {});

    const retryDelays = (setTimeoutSpy.mock.calls as [unknown, unknown][])
      .map(([, ms]) => ms)
      .filter((ms): ms is number => typeof ms === 'number' && ms >= 1000);

    expect(retryDelays).toEqual([1000, 2000, 4000]);
  });
});
