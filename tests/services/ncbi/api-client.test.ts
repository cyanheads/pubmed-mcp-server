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
});
