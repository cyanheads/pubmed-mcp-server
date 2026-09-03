/**
 * @fileoverview Regression for issue #70 — a transient NCBI eutils HTTP 500 must
 * classify as ServiceUnavailable and be retried end to end. Drives a real NcbiApiClient
 * + NcbiService against a stubbed global fetch so the classification (which a mocked
 * `makeRequest` would bypass) is actually exercised.
 * @module tests/services/ncbi/transient-500-retry.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NcbiApiClient } from '@/services/ncbi/api-client.js';
import { NcbiService } from '@/services/ncbi/ncbi-service.js';
import type { NcbiRequestQueue } from '@/services/ncbi/request-queue.js';
import { NcbiResponseHandler } from '@/services/ncbi/response-handler.js';

// Keep httpErrorFromResponse real (it is what classifies the status); silence logging only.
vi.mock('@cyanheads/mcp-ts-core/utils', async () => {
  const actual = await vi.importActual<typeof import('@cyanheads/mcp-ts-core/utils')>(
    '@cyanheads/mcp-ts-core/utils',
  );
  return {
    ...actual,
    logger: { debug: vi.fn(), info: vi.fn(), notice: vi.fn(), warning: vi.fn(), error: vi.fn() },
    requestContextService: {
      createRequestContext: vi.fn(() => ({ requestId: 'test' })),
    },
  };
});

let fetchSpy: ReturnType<typeof vi.spyOn> | undefined;
let setTimeoutSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  // Fire backoff sleeps (< 50s) immediately; leave the ≥60s deadline timer pending so the
  // retry chain doesn't actually wait. `AbortSignal.timeout` uses an internal timer captured
  // at module load and is unaffected by this global-setTimeout spy.
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
});

function buildService(maxRetries: number): NcbiService {
  const apiClient = new NcbiApiClient({ toolIdentifier: 'test', timeoutMs: 5000 });
  const queue = {
    enqueue: vi.fn(async (task: () => Promise<unknown>) => task()),
  } as unknown as NcbiRequestQueue;
  return new NcbiService(apiClient, queue, new NcbiResponseHandler(), maxRetries, 60_000);
}

describe('transient eutils HTTP 500 (issue #70)', () => {
  it('reclassifies a 500 to ServiceUnavailable and retries it to exhaustion', async () => {
    fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('WWW Error 500', { status: 500 }));
    const service = buildService(2);

    await expect(service.eSearch({ db: 'pubmed', term: 'cancer' })).rejects.toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
    });
    // 1 initial + 2 retries — the transient 500 is now retryable.
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });

  it('does not retry a 501 (ServiceUnavailable carrying the retryable opt-out)', async () => {
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 501 }));
    const service = buildService(2);

    await expect(service.eSearch({ db: 'pubmed', term: 'cancer' })).rejects.toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      data: { retryable: false },
    });
    // `data.retryable: false` outranks the transient code → no retry.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
