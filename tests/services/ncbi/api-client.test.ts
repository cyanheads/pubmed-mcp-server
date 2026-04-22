/**
 * @fileoverview Tests for the NCBI API client (URL construction, GET/POST selection, error handling).
 * @module tests/services/ncbi/api-client.test
 */

import { McpError } from '@cyanheads/mcp-ts-core/errors';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NcbiApiClient, type NcbiApiClientConfig } from '@/services/ncbi/api-client.js';

vi.mock('@cyanheads/mcp-ts-core/utils', () => {
  const mockFetch = vi.fn();
  return {
    logger: { debug: vi.fn(), info: vi.fn(), warning: vi.fn(), error: vi.fn() },
    fetchWithTimeout: mockFetch,
    requestContextService: {
      createRequestContext: vi.fn(() => ({ requestId: 'test' })),
    },
  };
});

const { fetchWithTimeout } = await import('@cyanheads/mcp-ts-core/utils');
const mockFetch = fetchWithTimeout as ReturnType<typeof vi.fn>;

const baseConfig: NcbiApiClientConfig = {
  toolIdentifier: 'test-tool',
  timeoutMs: 5000,
};

describe('NcbiApiClient', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('makes a GET request with params', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: () => Promise.resolve('<xml/>'),
    });
    const client = new NcbiApiClient(baseConfig);
    const result = await client.makeRequest('esearch', { db: 'pubmed', term: 'cancer' });

    expect(result).toBe('<xml/>');
    expect(mockFetch).toHaveBeenCalledOnce();
    const url = mockFetch.mock.calls[0]?.[0] as string;
    expect(url).toContain('esearch.fcgi');
    expect(url).toContain('db=pubmed');
    expect(url).toContain('term=cancer');
    expect(url).toContain('tool=test-tool');
  });

  it('injects api_key and email when configured', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, status: 200, text: () => Promise.resolve('ok') });
    const client = new NcbiApiClient({
      ...baseConfig,
      apiKey: 'my-key',
      adminEmail: 'me@test.com',
    });
    await client.makeRequest('esearch', { db: 'pubmed' });

    const url = mockFetch.mock.calls[0]?.[0] as string;
    expect(url).toContain('api_key=my-key');
    expect(url).toContain('email=me%40test.com');
  });

  it('uses POST for large payloads', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, status: 200, text: () => Promise.resolve('ok') });
    const client = new NcbiApiClient(baseConfig);
    // Create a long id list to exceed POST_THRESHOLD
    const longId = Array.from({ length: 500 }, (_, i) => String(i)).join(',');
    await client.makeRequest('efetch', { db: 'pubmed', id: longId });

    // POST calls pass additional fetch options
    expect(mockFetch.mock.calls[0]?.[3]).toMatchObject({ method: 'POST' });
  });

  it('uses POST when usePost option is set', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, status: 200, text: () => Promise.resolve('ok') });
    const client = new NcbiApiClient(baseConfig);
    await client.makeRequest('efetch', { db: 'pubmed' }, { usePost: true });

    expect(mockFetch.mock.calls[0]?.[3]).toMatchObject({ method: 'POST' });
  });

  it('re-throws McpError as-is', async () => {
    const { JsonRpcErrorCode } = await import('@cyanheads/mcp-ts-core/errors');
    mockFetch.mockRejectedValueOnce(new McpError(JsonRpcErrorCode.InvalidRequest, 'bad request'));

    const client = new NcbiApiClient(baseConfig);
    await expect(client.makeRequest('esearch', { db: 'pubmed' })).rejects.toThrow('bad request');
    expect(mockFetch).toHaveBeenCalledOnce();
  });

  it('throws RateLimited for HTTP 429', async () => {
    const { JsonRpcErrorCode } = await import('@cyanheads/mcp-ts-core/errors');
    mockFetch.mockResolvedValueOnce({ ok: false, status: 429, text: () => Promise.resolve('') });
    const client = new NcbiApiClient(baseConfig);

    await expect(client.makeRequest('esearch', { db: 'pubmed' })).rejects.toMatchObject({
      code: JsonRpcErrorCode.RateLimited,
      message: expect.stringContaining('HTTP 429'),
    });
  });

  it('throws ServiceUnavailable for HTTP 5xx', async () => {
    const { JsonRpcErrorCode } = await import('@cyanheads/mcp-ts-core/errors');
    mockFetch.mockResolvedValueOnce({ ok: false, status: 503, text: () => Promise.resolve('') });
    const client = new NcbiApiClient(baseConfig);

    await expect(client.makeRequest('esearch', { db: 'pubmed' })).rejects.toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      message: expect.stringContaining('HTTP 503'),
    });
  });

  it('throws InvalidRequest for other 4xx', async () => {
    const { JsonRpcErrorCode } = await import('@cyanheads/mcp-ts-core/errors');
    mockFetch.mockResolvedValueOnce({ ok: false, status: 400, text: () => Promise.resolve('') });
    const client = new NcbiApiClient(baseConfig);

    await expect(client.makeRequest('esearch', { db: 'pubmed' })).rejects.toMatchObject({
      code: JsonRpcErrorCode.InvalidRequest,
      message: expect.stringContaining('HTTP 400'),
    });
  });

  it('wraps non-McpError as ServiceUnavailable', async () => {
    mockFetch.mockRejectedValueOnce(new Error('network error'));
    const client = new NcbiApiClient(baseConfig);

    await expect(client.makeRequest('esearch', { db: 'pubmed' })).rejects.toThrow(
      /NCBI request failed: network error/,
    );
    expect(mockFetch).toHaveBeenCalledOnce();
  });

  it('forwards options.signal to fetchWithTimeout on GET', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, status: 200, text: () => Promise.resolve('ok') });
    const controller = new AbortController();
    const client = new NcbiApiClient(baseConfig);

    await client.makeRequest('esearch', { db: 'pubmed' }, { signal: controller.signal });

    const options = mockFetch.mock.calls[0]?.[3] as { signal?: AbortSignal } | undefined;
    expect(options?.signal).toBe(controller.signal);
  });

  it('forwards options.signal to fetchWithTimeout on POST', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, status: 200, text: () => Promise.resolve('ok') });
    const controller = new AbortController();
    const client = new NcbiApiClient(baseConfig);

    await client.makeRequest(
      'efetch',
      { db: 'pubmed' },
      { usePost: true, signal: controller.signal },
    );

    const options = mockFetch.mock.calls[0]?.[3] as { method?: string; signal?: AbortSignal };
    expect(options.method).toBe('POST');
    expect(options.signal).toBe(controller.signal);
  });

  it('omits signal from fetchWithTimeout when none provided', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, status: 200, text: () => Promise.resolve('ok') });
    const client = new NcbiApiClient(baseConfig);

    await client.makeRequest('esearch', { db: 'pubmed' });

    // GET path: no init arg at all when no signal.
    const initArg = mockFetch.mock.calls[0]?.[3];
    expect(initArg).toBeUndefined();
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
