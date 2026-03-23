/**
 * @fileoverview Tests for the NCBI API client (URL construction, retry logic, GET/POST selection).
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
  maxRetries: 0,
  timeoutMs: 5000,
};

describe('NcbiApiClient', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('makes a GET request with params', async () => {
    mockFetch.mockResolvedValueOnce({ text: () => Promise.resolve('<xml/>') });
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
    mockFetch.mockResolvedValueOnce({ text: () => Promise.resolve('ok') });
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
    mockFetch.mockResolvedValueOnce({ text: () => Promise.resolve('ok') });
    const client = new NcbiApiClient(baseConfig);
    // Create a long id list to exceed POST_THRESHOLD
    const longId = Array.from({ length: 500 }, (_, i) => String(i)).join(',');
    await client.makeRequest('efetch', { db: 'pubmed', id: longId });

    // POST calls pass additional fetch options
    expect(mockFetch.mock.calls[0]?.[3]).toMatchObject({ method: 'POST' });
  });

  it('uses POST when usePost option is set', async () => {
    mockFetch.mockResolvedValueOnce({ text: () => Promise.resolve('ok') });
    const client = new NcbiApiClient(baseConfig);
    await client.makeRequest('efetch', { db: 'pubmed' }, { usePost: true });

    expect(mockFetch.mock.calls[0]?.[3]).toMatchObject({ method: 'POST' });
  });

  it('retries on transient errors', async () => {
    const { JsonRpcErrorCode } = await import('@cyanheads/mcp-ts-core/errors');
    mockFetch
      .mockRejectedValueOnce(new McpError(JsonRpcErrorCode.ServiceUnavailable, 'down'))
      .mockResolvedValueOnce({ text: () => Promise.resolve('recovered') });

    const client = new NcbiApiClient({ ...baseConfig, maxRetries: 1 });
    const result = await client.makeRequest('esearch', { db: 'pubmed' });

    expect(result).toBe('recovered');
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('throws non-retryable McpError immediately', async () => {
    const { JsonRpcErrorCode } = await import('@cyanheads/mcp-ts-core/errors');
    mockFetch.mockRejectedValueOnce(new McpError(JsonRpcErrorCode.InvalidRequest, 'bad request'));

    const client = new NcbiApiClient({ ...baseConfig, maxRetries: 3 });
    await expect(client.makeRequest('esearch', { db: 'pubmed' })).rejects.toThrow('bad request');
    expect(mockFetch).toHaveBeenCalledOnce();
  });

  it('throws after exhausting retries', async () => {
    mockFetch.mockRejectedValue(new Error('network error'));
    const client = new NcbiApiClient({ ...baseConfig, maxRetries: 1 });

    await expect(client.makeRequest('esearch', { db: 'pubmed' })).rejects.toThrow(
      /failed after retries/,
    );
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });
});
