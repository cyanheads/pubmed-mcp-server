/**
 * @fileoverview Unit tests for NcbiApiClient — URL construction, GET/POST selection,
 * param injection, and retry/backoff behaviour.
 * @module tests/services/ncbi/core/api-client.test
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { JsonRpcErrorCode, McpError } from '@/types-global/errors.js';
import { requestContextService } from '@/utils/internal/requestContext.js';

vi.mock('@/utils/network/fetchWithTimeout.js', () => ({
  fetchWithTimeout: vi.fn(),
}));

import { fetchWithTimeout } from '@/utils/network/fetchWithTimeout.js';

import {
  NcbiApiClient,
  type NcbiApiClientConfig,
} from '../../../../src/services/ncbi/core/api-client.js';
import { NCBI_EUTILS_BASE_URL } from '../../../../src/services/ncbi/types.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

const mockedFetch = vi.mocked(fetchWithTimeout);

const mockResponse = (text: string) => ({
  text: vi.fn().mockResolvedValue(text),
  ok: true,
  status: 200,
});

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const defaultConfig: NcbiApiClientConfig = {
  toolIdentifier: 'test-tool',
  adminEmail: 'test@example.com',
  apiKey: 'test-key',
  maxRetries: 2,
  timeoutMs: 5000,
};

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('NcbiApiClient', () => {
  let client: NcbiApiClient;
  let context: ReturnType<typeof requestContextService.createRequestContext>;

  beforeEach(() => {
    // Reset mock implementations AND call history so tests can't bleed into each other.
    mockedFetch.mockReset();
    client = new NcbiApiClient(defaultConfig);
    context = requestContextService.createRequestContext({ operation: 'test-ncbi-api-client' });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── URL construction ───────────────────────────────────────────────────────

  describe('makeRequest (URL construction)', () => {
    it('appends .fcgi to the endpoint in the constructed URL', async () => {
      mockedFetch.mockResolvedValueOnce(mockResponse('<?xml?>') as unknown as Response);

      await client.makeRequest('esearch', { db: 'pubmed' }, context);

      expect(mockedFetch).toHaveBeenCalledOnce();
      const [calledUrl] = mockedFetch.mock.calls[0]!;
      expect(calledUrl).toMatch(`${NCBI_EUTILS_BASE_URL}/esearch.fcgi`);
    });

    it('includes tool, email, and api_key in the query string', async () => {
      mockedFetch.mockResolvedValueOnce(mockResponse('ok') as unknown as Response);

      await client.makeRequest('efetch', { db: 'pubmed' }, context);

      const [calledUrl] = mockedFetch.mock.calls[0]!;
      const qs = new URL(calledUrl as string).searchParams;
      expect(qs.get('tool')).toBe('test-tool');
      expect(qs.get('email')).toBe('test@example.com');
      expect(qs.get('api_key')).toBe('test-key');
    });

    it('returns the response body text', async () => {
      mockedFetch.mockResolvedValueOnce(
        mockResponse('<result>data</result>') as unknown as Response,
      );

      const result = await client.makeRequest('esearch', { db: 'pubmed' }, context);

      expect(result).toBe('<result>data</result>');
    });

    it('filters out undefined and null param values', async () => {
      mockedFetch.mockResolvedValueOnce(mockResponse('ok') as unknown as Response);

      await client.makeRequest(
        'esearch',
        { db: 'pubmed', term: undefined, retmax: undefined },
        context,
      );

      const [calledUrl] = mockedFetch.mock.calls[0]!;
      const qs = new URL(calledUrl as string).searchParams;
      expect(qs.has('term')).toBe(false);
      expect(qs.has('retmax')).toBe(false);
      expect(qs.get('db')).toBe('pubmed');
    });

    it('passes caller-supplied params through to the URL', async () => {
      mockedFetch.mockResolvedValueOnce(mockResponse('ok') as unknown as Response);

      await client.makeRequest('esearch', { db: 'pubmed', term: 'cancer', retmax: 10 }, context);

      const [calledUrl] = mockedFetch.mock.calls[0]!;
      const qs = new URL(calledUrl as string).searchParams;
      expect(qs.get('db')).toBe('pubmed');
      expect(qs.get('term')).toBe('cancer');
      expect(qs.get('retmax')).toBe('10');
    });
  });

  // ── GET vs POST ────────────────────────────────────────────────────────────

  describe('GET vs POST selection', () => {
    it('uses GET by default for a small payload', async () => {
      mockedFetch.mockResolvedValueOnce(mockResponse('ok') as unknown as Response);

      await client.makeRequest('esearch', { db: 'pubmed', term: 'cancer' }, context);

      // GET passes URL with query string; the second arg is timeoutMs (a number), not an options obj
      const [calledUrl, , , fetchOpts] = mockedFetch.mock.calls[0]!;
      expect(typeof calledUrl).toBe('string');
      expect(calledUrl as string).toContain('?');
      expect(fetchOpts).toBeUndefined();
    });

    it('uses POST when options.usePost is true', async () => {
      mockedFetch.mockResolvedValueOnce(mockResponse('ok') as unknown as Response);

      await client.makeRequest('esearch', { db: 'pubmed', term: 'cancer' }, context, {
        usePost: true,
      });

      const [calledUrl, , , fetchOpts] = mockedFetch.mock.calls[0]!;
      // POST sends the bare base URL without a query string
      expect(calledUrl as string).not.toContain('?');
      expect(fetchOpts).toMatchObject({
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      });
    });

    it('switches to POST automatically when the encoded query string exceeds 2000 chars', async () => {
      mockedFetch.mockResolvedValueOnce(mockResponse('ok') as unknown as Response);

      // Build a param value long enough to push the encoded string past the threshold
      const longId = 'A'.repeat(2100);
      await client.makeRequest('elink', { db: 'pubmed', id: longId }, context);

      const [calledUrl, , , fetchOpts] = mockedFetch.mock.calls[0]!;
      expect(calledUrl as string).not.toContain('?');
      expect(fetchOpts).toMatchObject({ method: 'POST' });
    });

    it('sends form-encoded body with correct Content-Type on POST', async () => {
      mockedFetch.mockResolvedValueOnce(mockResponse('ok') as unknown as Response);

      await client.makeRequest('elink', { db: 'pubmed', id: 'A'.repeat(2100) }, context);

      const [, , , fetchOpts] = mockedFetch.mock.calls[0]!;
      expect(fetchOpts).toMatchObject({
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: expect.stringContaining('db=pubmed'),
      });
    });

    it('does NOT include a query string on POST requests', async () => {
      mockedFetch.mockResolvedValueOnce(mockResponse('ok') as unknown as Response);

      await client.makeRequest('esearch', { db: 'pubmed' }, context, { usePost: true });

      const [calledUrl] = mockedFetch.mock.calls[0]!;
      expect(calledUrl as string).toBe(`${NCBI_EUTILS_BASE_URL}/esearch.fcgi`);
    });
  });

  // ── Retries ────────────────────────────────────────────────────────────────

  describe('retry behaviour', () => {
    // vitest.config.ts enables fakeTimers globally, but the forks pool requires
    // explicit activation per-describe when using advanceTimersByTimeAsync.
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('retries on ServiceUnavailable McpError and eventually succeeds', async () => {
      const transientError = new McpError(JsonRpcErrorCode.ServiceUnavailable, 'upstream down');
      mockedFetch
        .mockRejectedValueOnce(transientError)
        .mockResolvedValueOnce(mockResponse('ok') as unknown as Response);

      const promise = client.makeRequest('esearch', { db: 'pubmed' }, context);
      // Advance past the first retry delay (2^0 * 200 = 200ms)
      await vi.advanceTimersByTimeAsync(200);
      const result = await promise;

      expect(result).toBe('ok');
      expect(mockedFetch).toHaveBeenCalledTimes(2);
    });

    it('retries on Timeout McpError', async () => {
      const timeoutError = new McpError(JsonRpcErrorCode.Timeout, 'request timed out');
      mockedFetch
        .mockRejectedValueOnce(timeoutError)
        .mockResolvedValueOnce(mockResponse('ok') as unknown as Response);

      const promise = client.makeRequest('esearch', { db: 'pubmed' }, context);
      await vi.advanceTimersByTimeAsync(200);
      const result = await promise;

      expect(result).toBe('ok');
      expect(mockedFetch).toHaveBeenCalledTimes(2);
    });

    it('does NOT retry on non-transient McpError (e.g. InvalidParams)', async () => {
      const nonTransient = new McpError(JsonRpcErrorCode.InvalidParams, 'bad params');
      mockedFetch.mockRejectedValueOnce(nonTransient);

      await expect(client.makeRequest('esearch', { db: 'pubmed' }, context)).rejects.toMatchObject({
        code: JsonRpcErrorCode.InvalidParams,
      });

      expect(mockedFetch).toHaveBeenCalledTimes(1);
    });

    it('throws after maxRetries is exhausted', async () => {
      const transientError = new McpError(JsonRpcErrorCode.ServiceUnavailable, 'always failing');
      // defaultConfig.maxRetries = 2, so 3 total attempts — use Once to avoid
      // persistent rejections escaping the test boundary after timers are restored.
      mockedFetch
        .mockRejectedValueOnce(transientError)
        .mockRejectedValueOnce(transientError)
        .mockRejectedValueOnce(transientError);

      // Interleave timer advancement with the promise so all async continuations
      // settle inside the test boundary before afterEach restores real timers.
      const settled = client
        .makeRequest('esearch', { db: 'pubmed' }, context)
        .catch((e: unknown) => e);

      // Advance past both retry delays in a single step (200 + 400 = 600ms).
      await vi.advanceTimersByTimeAsync(700);
      const error = await settled;

      expect(error).toBeInstanceOf(McpError);
      expect((error as McpError).code).toBe(JsonRpcErrorCode.ServiceUnavailable);
      expect((error as McpError).message).toBe('always failing');
      expect(mockedFetch).toHaveBeenCalledTimes(3);
    });

    it('uses exponential backoff: 2^attempt * 200ms', async () => {
      // Capture the scheduled delay values by intercepting the Promise-based
      // setTimeout pattern the source uses: new Promise(r => setTimeout(r, delay)).
      const delays: number[] = [];
      const realSetTimeout = globalThis.setTimeout;
      vi.spyOn(globalThis, 'setTimeout').mockImplementation(
        (fn: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => {
          if (typeof delay === 'number') delays.push(delay);
          // Use the real implementation so the promise resolves when timers advance.
          return realSetTimeout(fn as (...a: unknown[]) => void, delay, ...args);
        },
      );

      const transientError = new McpError(JsonRpcErrorCode.ServiceUnavailable, 'transient');
      // Fail twice, then succeed — exercises both retry delays
      mockedFetch
        .mockRejectedValueOnce(transientError)
        .mockRejectedValueOnce(transientError)
        .mockResolvedValueOnce(mockResponse('ok') as unknown as Response);

      const promise = client.makeRequest('esearch', { db: 'pubmed' }, context);
      await vi.advanceTimersByTimeAsync(1000);
      await promise;

      // attempt 0 → 2^0 * 200 = 200ms; attempt 1 → 2^1 * 200 = 400ms
      expect(delays).toEqual(expect.arrayContaining([200, 400]));
    });

    it('wraps plain Error failures in McpError with ServiceUnavailable after retries', async () => {
      const zeroRetryClient = new NcbiApiClient({ ...defaultConfig, maxRetries: 0 });
      mockedFetch.mockRejectedValueOnce(new Error('network reset'));

      await expect(
        zeroRetryClient.makeRequest('esearch', { db: 'pubmed' }, context),
      ).rejects.toMatchObject({
        code: JsonRpcErrorCode.ServiceUnavailable,
        message: expect.stringContaining('network reset'),
      });
    });

    it('wraps non-Error rejection values in McpError with ServiceUnavailable after retries', async () => {
      const zeroRetryClient = new NcbiApiClient({ ...defaultConfig, maxRetries: 0 });
      mockedFetch.mockRejectedValueOnce('string rejection');

      await expect(
        zeroRetryClient.makeRequest('esearch', { db: 'pubmed' }, context),
      ).rejects.toMatchObject({
        code: JsonRpcErrorCode.ServiceUnavailable,
        message: expect.stringContaining('string rejection'),
      });
    });
  });

  // ── Config edge cases ──────────────────────────────────────────────────────

  describe('config edge cases', () => {
    it('omits api_key param when not provided in config', async () => {
      const clientNoKey = new NcbiApiClient({
        toolIdentifier: 'test-tool',
        adminEmail: 'test@example.com',
        maxRetries: 0,
        timeoutMs: 5000,
      });
      mockedFetch.mockResolvedValueOnce(mockResponse('ok') as unknown as Response);

      await clientNoKey.makeRequest('esearch', { db: 'pubmed' }, context);

      const [calledUrl] = mockedFetch.mock.calls[0]!;
      const qs = new URL(calledUrl as string).searchParams;
      expect(qs.has('api_key')).toBe(false);
    });

    it('omits email param when not provided in config', async () => {
      const clientNoEmail = new NcbiApiClient({
        toolIdentifier: 'test-tool',
        apiKey: 'key',
        maxRetries: 0,
        timeoutMs: 5000,
      });
      mockedFetch.mockResolvedValueOnce(mockResponse('ok') as unknown as Response);

      await clientNoEmail.makeRequest('esearch', { db: 'pubmed' }, context);

      const [calledUrl] = mockedFetch.mock.calls[0]!;
      const qs = new URL(calledUrl as string).searchParams;
      expect(qs.has('email')).toBe(false);
    });

    it('passes timeoutMs to fetchWithTimeout', async () => {
      mockedFetch.mockResolvedValueOnce(mockResponse('ok') as unknown as Response);

      await client.makeRequest('esearch', { db: 'pubmed' }, context);

      const [, timeoutMs] = mockedFetch.mock.calls[0]!;
      expect(timeoutMs).toBe(5000);
    });
  });
});
