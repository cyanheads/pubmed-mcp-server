/**
 * @fileoverview Tests for the NCBI API client (URL construction, GET/POST selection, error handling).
 * @module tests/services/ncbi/api-client.test
 */

import { McpError } from '@cyanheads/mcp-ts-core/errors';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NcbiApiClient, type NcbiApiClientConfig } from '@/services/ncbi/api-client.js';

// makeRequest now uses plain `globalThis.fetch` (mirroring makeExternalRequest) so the
// 500→ServiceUnavailable reclassification in makeRequest is reachable; the suites spy the
// global. httpErrorFromResponse stays real (via `...actual`) so status→code classification
// is exercised, not mocked.
vi.mock('@cyanheads/mcp-ts-core/utils', async () => {
  const actual = await vi.importActual<typeof import('@cyanheads/mcp-ts-core/utils')>(
    '@cyanheads/mcp-ts-core/utils',
  );
  return {
    ...actual,
    logger: { debug: vi.fn(), info: vi.fn(), warning: vi.fn(), error: vi.fn() },
    requestContextService: {
      createRequestContext: vi.fn(() => ({ requestId: 'test' })),
    },
  };
});

const baseConfig: NcbiApiClientConfig = {
  toolIdentifier: 'test-tool',
  timeoutMs: 5000,
};

describe('NcbiApiClient', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('<xml/>', { status: 200 }));
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('makes a GET request with params', async () => {
    const client = new NcbiApiClient(baseConfig);
    const result = await client.makeRequest('esearch', { db: 'pubmed', term: 'cancer' });

    expect(result).toBe('<xml/>');
    expect(fetchSpy).toHaveBeenCalledOnce();
    const url = fetchSpy.mock.calls[0]?.[0] as string;
    expect(url).toContain('esearch.fcgi');
    expect(url).toContain('db=pubmed');
    expect(url).toContain('term=cancer');
    expect(url).toContain('tool=test-tool');
    // GET path: plain fetch with no method on the init.
    const init = fetchSpy.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(init?.method).toBeUndefined();
  });

  it('injects api_key and email when configured', async () => {
    const client = new NcbiApiClient({
      ...baseConfig,
      apiKey: 'my-key',
      adminEmail: 'me@test.com',
    });
    await client.makeRequest('esearch', { db: 'pubmed' });

    const url = fetchSpy.mock.calls[0]?.[0] as string;
    expect(url).toContain('api_key=my-key');
    expect(url).toContain('email=me%40test.com');
  });

  it('uses POST for large payloads', async () => {
    const client = new NcbiApiClient(baseConfig);
    // Create a long id list to exceed POST_THRESHOLD
    const longId = Array.from({ length: 500 }, (_, i) => String(i)).join(',');
    await client.makeRequest('efetch', { db: 'pubmed', id: longId });

    const init = fetchSpy.mock.calls[0]?.[1] as RequestInit;
    expect(init.method).toBe('POST');
    expect(init.body).toContain('id=');
  });

  it('uses POST when usePost option is set', async () => {
    const client = new NcbiApiClient(baseConfig);
    await client.makeRequest('efetch', { db: 'pubmed' }, { usePost: true });

    const init = fetchSpy.mock.calls[0]?.[1] as RequestInit;
    expect(init.method).toBe('POST');
  });

  it('re-throws an McpError surfaced by fetch as-is', async () => {
    const { JsonRpcErrorCode } = await import('@cyanheads/mcp-ts-core/errors');
    fetchSpy.mockRejectedValueOnce(new McpError(JsonRpcErrorCode.InvalidRequest, 'bad request'));

    const client = new NcbiApiClient(baseConfig);
    await expect(client.makeRequest('esearch', { db: 'pubmed' })).rejects.toThrow('bad request');
    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it('throws RateLimited for HTTP 429', async () => {
    const { JsonRpcErrorCode } = await import('@cyanheads/mcp-ts-core/errors');
    fetchSpy.mockResolvedValueOnce(new Response('', { status: 429 }));
    const client = new NcbiApiClient(baseConfig);

    await expect(client.makeRequest('esearch', { db: 'pubmed' })).rejects.toMatchObject({
      code: JsonRpcErrorCode.RateLimited,
      message: expect.stringContaining('429'),
    });
  });

  it('throws ServiceUnavailable for HTTP 503', async () => {
    const { JsonRpcErrorCode } = await import('@cyanheads/mcp-ts-core/errors');
    fetchSpy.mockResolvedValueOnce(new Response('', { status: 503 }));
    const client = new NcbiApiClient(baseConfig);

    await expect(client.makeRequest('esearch', { db: 'pubmed' })).rejects.toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      message: expect.stringContaining('503'),
    });
  });

  it('classifies HTTP 500 as ServiceUnavailable so withRetry picks it up (issue #70)', async () => {
    // NCBI's eutils proxy returns 500 for transient mesh-layer failures that are safe to
    // retry. Routing getRequest/postRequest through plain fetch hands makeRequest the
    // failing Response so httpErrorFromResponse can classify it — fetchWithTimeout throws
    // on non-2xx before the response is reachable.
    const { JsonRpcErrorCode } = await import('@cyanheads/mcp-ts-core/errors');
    fetchSpy.mockResolvedValueOnce(new Response('WWW Error 500', { status: 500 }));
    const client = new NcbiApiClient(baseConfig);

    await expect(client.makeRequest('elink', { db: 'pubmed' })).rejects.toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      message: expect.stringContaining('500'),
    });
  });

  it('marks HTTP 501 non-retryable alongside ServiceUnavailable', async () => {
    // 501 Not Implemented shares ServiceUnavailable's transient code, so the in-band
    // `retryable: false` opt-out is what keeps it out of the retry loop.
    const { JsonRpcErrorCode } = await import('@cyanheads/mcp-ts-core/errors');
    fetchSpy.mockResolvedValueOnce(new Response('', { status: 501 }));
    const client = new NcbiApiClient(baseConfig);

    await expect(client.makeRequest('esearch', { db: 'pubmed' })).rejects.toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      data: { retryable: false },
    });
  });

  it('throws InvalidParams for HTTP 400', async () => {
    const { JsonRpcErrorCode } = await import('@cyanheads/mcp-ts-core/errors');
    fetchSpy.mockResolvedValueOnce(new Response('', { status: 400 }));
    const client = new NcbiApiClient(baseConfig);

    await expect(client.makeRequest('esearch', { db: 'pubmed' })).rejects.toMatchObject({
      code: JsonRpcErrorCode.InvalidParams,
      message: expect.stringContaining('400'),
    });
  });

  it('wraps non-McpError as ServiceUnavailable', async () => {
    fetchSpy.mockRejectedValueOnce(new Error('network error'));
    const client = new NcbiApiClient(baseConfig);

    await expect(client.makeRequest('esearch', { db: 'pubmed' })).rejects.toThrow(
      /NCBI request failed: network error/,
    );
    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it('wrapped non-McpError carries reason ncbi_unreachable + recovery on the wire', async () => {
    fetchSpy.mockRejectedValueOnce(new Error('ECONNRESET'));
    const client = new NcbiApiClient(baseConfig);

    await expect(client.makeRequest('esearch', { db: 'pubmed' })).rejects.toMatchObject({
      data: {
        reason: 'ncbi_unreachable',
        endpoint: 'esearch',
        recovery: { hint: expect.stringContaining('NCBI was unreachable') },
      },
    });
  });

  it('wrapped non-McpError on external request also carries reason + recovery', async () => {
    fetchSpy.mockRejectedValueOnce(new Error('ETIMEDOUT'));
    const client = new NcbiApiClient(baseConfig);

    await expect(
      client.makeExternalRequest('https://www.ncbi.nlm.nih.gov/pmc/utils/idconv/v1.0/', {
        ids: '10.1093/nar/gks1195',
      }),
    ).rejects.toMatchObject({
      data: {
        reason: 'ncbi_unreachable',
        recovery: { hint: expect.stringContaining('NCBI was unreachable') },
      },
    });
  });

  it('composes the caller signal with the per-request timeout on GET', async () => {
    const controller = new AbortController();
    const client = new NcbiApiClient(baseConfig);

    await client.makeRequest('esearch', { db: 'pubmed' }, { signal: controller.signal });

    const init = fetchSpy.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    // Aborting the caller controller cascades to the composed signal.
    controller.abort(new Error('cancelled'));
    expect(init?.signal?.aborted).toBe(true);
  });

  it('composes the caller signal with the per-request timeout on POST', async () => {
    const controller = new AbortController();
    const client = new NcbiApiClient(baseConfig);

    await client.makeRequest(
      'efetch',
      { db: 'pubmed' },
      { usePost: true, signal: controller.signal },
    );

    const init = fetchSpy.mock.calls[0]?.[1] as RequestInit;
    expect(init.method).toBe('POST');
    expect(init.signal).toBeInstanceOf(AbortSignal);
    controller.abort(new Error('cancelled'));
    expect(init.signal?.aborted).toBe(true);
  });

  it('uses only the per-request timeout signal when no caller signal is provided', async () => {
    const client = new NcbiApiClient(baseConfig);

    await client.makeRequest('esearch', { db: 'pubmed' });

    // Every request now carries a timeout signal (not aborted at call time).
    const init = fetchSpy.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(init?.signal?.aborted).toBe(false);
  });
});

describe('NcbiApiClient.makeExternalRequest', () => {
  /**
   * `makeExternalRequest` uses `globalThis.fetch` directly (not `fetchWithTimeout`)
   * so it can read response bodies on error. When a caller signal is provided it
   * composes with the per-request `AbortSignal.timeout` via `AbortSignal.any`;
   * without one, only the timeout signal is used.
   */
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ records: [] }), { status: 200 }));
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('uses timeout signal when no external signal provided', async () => {
    const client = new NcbiApiClient(baseConfig);

    await client.makeExternalRequest('https://example.test/api', { foo: 'bar' });

    const init = fetchSpy.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    // Not aborted at call time — timeout hasn't fired.
    expect(init?.signal?.aborted).toBe(false);
  });

  it('composes external signal with internal timeout via AbortSignal.any', async () => {
    const client = new NcbiApiClient(baseConfig);
    const controller = new AbortController();

    await client.makeExternalRequest('https://example.test/api', { foo: 'bar' }, controller.signal);

    const init = fetchSpy.mock.calls[0]?.[1] as RequestInit | undefined;
    const signal = init?.signal;
    expect(signal).toBeInstanceOf(AbortSignal);

    // Aborting the external controller must cascade to the composed signal.
    controller.abort(new Error('cancelled'));
    expect(signal?.aborted).toBe(true);
  });

  it('short-circuits when external signal is pre-aborted', async () => {
    // Pre-aborted caller signal composed with a fresh timeout signal produces
    // an already-aborted composite. fetch() receives it and rejects.
    fetchSpy.mockRejectedValueOnce(new DOMException('aborted', 'AbortError'));
    const client = new NcbiApiClient(baseConfig);
    const controller = new AbortController();
    controller.abort(new Error('pre-cancelled'));

    await expect(
      client.makeExternalRequest('https://example.test/api', {}, controller.signal),
    ).rejects.toThrow();
  });
});
