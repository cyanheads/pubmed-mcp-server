/**
 * @fileoverview Tests for the NCBI API client (URL construction, GET/POST selection, error
 * handling, and the `http.client.request.duration` point each request records).
 * @module tests/services/ncbi/api-client.test
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import {
  createPacer,
  fetchWithTimeout,
  getMeter,
  logger,
  type RequestContext,
} from '@cyanheads/mcp-ts-core/utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NcbiApiClient, type NcbiApiClientConfig } from '@/services/ncbi/api-client.js';
import { NcbiService } from '@/services/ncbi/ncbi-service.js';
import { NcbiResponseHandler } from '@/services/ncbi/response-handler.js';
import { NCBI_EUTILS_BASE_URL, NCBI_PMC_IDCONV_URL } from '@/services/ncbi/types.js';

// Every request goes out through plain `globalThis.fetch`, which the suites spy.
// httpErrorFromResponse stays real (via `...actual`) so status→code classification
// is exercised, not mocked. The context stub keeps its operation and fields, so a test can
// read what each log record carries.
vi.mock('@cyanheads/mcp-ts-core/utils', async () => {
  const actual = await vi.importActual<typeof import('@cyanheads/mcp-ts-core/utils')>(
    '@cyanheads/mcp-ts-core/utils',
  );
  return {
    ...actual,
    logger: { debug: vi.fn(), info: vi.fn(), warning: vi.fn(), error: vi.fn() },
    requestContextService: {
      createRequestContext: vi.fn(
        (params?: { operation?: string; additionalContext?: Record<string, unknown> }) => ({
          requestId: 'test',
          ...(params?.operation && { operation: params.operation }),
          ...(params?.additionalContext && { extra: params.additionalContext }),
        }),
      ),
    },
  };
});

const baseConfig: NcbiApiClientConfig = {
  toolIdentifier: 'test-tool',
  timeoutMs: 5000,
};

/**
 * Every histogram created in this file, in creation order, with the points recorded on
 * it. No meter provider is registered under test, so the framework's `createHistogram` —
 * the one the client calls and the one `fetchWithTimeout` calls — takes its instrument
 * from the OTel API's no-op meter, a single shared instance; spying on that meter
 * captures both. Installed before any test runs, because each caller creates its
 * instrument once, on first use, and keeps it.
 */
const histograms: {
  name: string;
  options: unknown;
  points: { seconds: number; attributes: Record<string, unknown> }[];
}[] = [];
vi.spyOn(getMeter(), 'createHistogram').mockImplementation((name, options) => {
  const histogram: (typeof histograms)[number] = { name, options, points: [] };
  histograms.push(histogram);
  return {
    record: (seconds, attributes) => {
      histogram.points.push({ seconds, attributes: { ...attributes } });
    },
  };
});

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
    const surfaced = new McpError(JsonRpcErrorCode.InvalidRequest, 'bad request');
    fetchSpy.mockRejectedValueOnce(surfaced);

    const client = new NcbiApiClient(baseConfig);
    await expect(client.makeRequest('esearch', { db: 'pubmed' })).rejects.toBe(surfaced);
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
    // retry; httpErrorFromResponse classifies the failing Response makeRequest holds.
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
    const { JsonRpcErrorCode } = await import('@cyanheads/mcp-ts-core/errors');
    fetchSpy.mockRejectedValueOnce(new Error('network error'));
    const client = new NcbiApiClient(baseConfig);

    await expect(client.makeRequest('esearch', { db: 'pubmed' })).rejects.toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      message: 'NCBI request failed: network error',
    });
    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it('wrapped non-McpError carries reason ncbi_unreachable, the endpoint, and nothing else', async () => {
    fetchSpy.mockRejectedValueOnce(new Error('ECONNRESET'));
    const client = new NcbiApiClient(baseConfig);

    const error = await client.makeRequest('esearch', { db: 'pubmed' }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(McpError);
    // Exact, so a request URL added to the data fails here.
    expect((error as McpError).data).toEqual({ reason: 'ncbi_unreachable', endpoint: 'esearch' });
  });

  it('wrapped non-McpError on external request also carries reason', async () => {
    fetchSpy.mockRejectedValueOnce(new Error('ETIMEDOUT'));
    const client = new NcbiApiClient(baseConfig);

    await expect(
      client.makeExternalRequest('https://www.ncbi.nlm.nih.gov/pmc/utils/idconv/v1.0/', {
        ids: '10.1093/nar/gks1195',
      }),
    ).rejects.toMatchObject({
      data: {
        reason: 'ncbi_unreachable',
      },
    });
  });
});

/**
 * Every request — eutils GET, eutils POST, external GET — carries one signal: the
 * client's `timeoutMs` joined with the caller's signal, so whichever fires first ends
 * the request. The fetch stub never answers; it settles only when the signal it was
 * handed aborts, as a stalled upstream does, so each outcome below is reachable only
 * through that signal.
 */
describe('NcbiApiClient request lifetime', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(
      ((_input: unknown, init?: RequestInit) =>
        new Promise<Response>((_, reject) => {
          const signal = init?.signal;
          if (!signal) {
            reject(new Error('request carried no abort signal'));
            return;
          }
          if (signal.aborted) {
            reject(signal.reason);
            return;
          }
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        })) as typeof fetch,
    );
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  type Send = (client: NcbiApiClient, signal?: AbortSignal) => Promise<string>;
  const paths: [string, Send][] = [
    ['eutils GET', (c, signal) => c.makeRequest('esearch', { db: 'pubmed' }, signal && { signal })],
    [
      'eutils POST',
      (c, signal) =>
        c.makeRequest('efetch', { db: 'pubmed' }, { usePost: true, ...(signal && { signal }) }),
    ],
    ['external GET', (c, signal) => c.makeExternalRequest(NCBI_PMC_IDCONV_URL, {}, signal)],
  ];

  /** A request the per-request timeout ended: ncbi_unreachable, caused by a `TimeoutError`. */
  const expectTimedOut = async (pending: Promise<unknown>) => {
    const { JsonRpcErrorCode } = await import('@cyanheads/mcp-ts-core/errors');
    const error = await pending.catch((e: unknown) => e);
    expect(error).toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      data: { reason: 'ncbi_unreachable' },
    });
    expect((error as McpError).cause).toMatchObject({ name: 'TimeoutError' });
  };

  it.each(paths)(
    '%s: ends a request that outlives timeoutMs',
    async (_path, send) => {
      await expectTimedOut(send(new NcbiApiClient({ ...baseConfig, timeoutMs: 20 })));
    },
    1000,
  );

  it.each(paths)(
    '%s: still ends it at timeoutMs when a caller signal is attached',
    async (_path, send) => {
      const caller = new AbortController();
      await expectTimedOut(
        send(new NcbiApiClient({ ...baseConfig, timeoutMs: 20 }), caller.signal),
      );
      expect(caller.signal.aborted).toBe(false);
    },
    1000,
  );

  it.each(paths)(
    '%s: ends an in-flight request with the caller’s reason when the caller aborts',
    async (_path, send) => {
      const { JsonRpcErrorCode } = await import('@cyanheads/mcp-ts-core/errors');
      const caller = new AbortController();
      const reason = new Error('caller cancelled');

      const pending = send(new NcbiApiClient(baseConfig), caller.signal).catch((e: unknown) => e);
      expect(fetchSpy).toHaveBeenCalledOnce();
      caller.abort(reason);
      const error = await pending;

      expect(error).toMatchObject({
        code: JsonRpcErrorCode.ServiceUnavailable,
        message: 'NCBI request failed: caller cancelled',
      });
      expect((error as McpError).cause).toBe(reason);
    },
    1000,
  );

  it('external GET: short-circuits when the caller signal is already aborted', async () => {
    const caller = new AbortController();
    caller.abort(new Error('pre-cancelled'));

    await expect(
      new NcbiApiClient(baseConfig).makeExternalRequest(NCBI_PMC_IDCONV_URL, {}, caller.signal),
    ).rejects.toMatchObject({ message: 'NCBI request failed: pre-cancelled' });
  }, 1000);
});

/**
 * Requests still go to the full URL, operator email and API key included, but no
 * log record or error `data` repeats it: an eutils call names its endpoint, an
 * external call its host. (mcp-ts-core 0.13.12)
 */
describe('NcbiApiClient keeps URLs out of log records and error data', () => {
  const config: NcbiApiClientConfig = {
    ...baseConfig,
    adminEmail: 'ops@example.org',
    apiKey: 'sk-ncbi-secret',
  };
  const debugCalls = vi.mocked(logger.debug);
  const logLevels = [logger.debug, logger.info, logger.warning, logger.error].map((level) =>
    vi.mocked(level),
  );
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    for (const level of logLevels) level.mockClear();
    fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('{"records":[]}', { status: 200 }));
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  /** The line each debug call writes: message, operation, and the `extra` fields flattened. */
  const debugRecords = () =>
    debugCalls.mock.calls.map(([msg, context]) => {
      const ctx = context as RequestContext;
      return { msg, operation: ctx.operation, ...ctx.extra };
    });

  /**
   * Every argument of every log call at every level, context objects whole — a URL
   * placed anywhere in a record, not only in the fields {@link debugRecords} reads.
   */
  const everyLogArgument = (): unknown[][] =>
    logLevels.flatMap((level): unknown[][] => level.mock.calls);

  const expectNoUrl = (value: unknown) => {
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    for (const fragment of [
      '://',
      'ops@example.org',
      'ops%40example.org',
      'sk-ncbi-secret',
      'tool=',
    ]) {
      expect(text).not.toContain(fragment);
    }
  };

  /** A response whose `url` is the full request URL, as a real fetch sets it. */
  const responseAt = (url: string, body: string, status: number) => {
    const response = new Response(body, { status });
    Object.defineProperty(response, 'url', { value: url });
    return response;
  };

  it.each([
    ['GET', 'esearch', {}],
    ['POST', 'efetch', { usePost: true }],
  ] as const)(
    'makeRequest names the endpoint in its %s record',
    async (method, endpoint, options) => {
      const client = new NcbiApiClient(config);
      await client.makeRequest(endpoint, { db: 'pubmed', term: 'asthma' }, options);

      expectNoUrl(everyLogArgument());
      expect(debugRecords()).toEqual([
        { msg: `NCBI HTTP request: ${method} ${endpoint}`, operation: 'NcbiHttpRequest', endpoint },
      ]);
    },
  );

  it('makeRequest keeps the URL out of a non-2xx error’s data, even when the response carries it', async () => {
    const { JsonRpcErrorCode } = await import('@cyanheads/mcp-ts-core/errors');
    // `httpErrorFromResponse` adds `data.url` only under `includeUrl: true`.
    fetchSpy.mockResolvedValueOnce(
      responseAt(
        'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?api_key=sk-ncbi-secret',
        'busy',
        503,
      ),
    );

    const error = await new NcbiApiClient(config)
      .makeRequest('esearch', { db: 'pubmed' })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(McpError);
    expect((error as McpError).data).not.toHaveProperty('url');
    expectNoUrl((error as McpError).data);
    expectNoUrl((error as McpError).message);
    expectNoUrl(everyLogArgument());
    expect(error).toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      data: { endpoint: 'esearch', status: 503, body: 'busy' },
    });
  });

  it('makeExternalRequest requests the full URL but logs only the host and the caller’s params', async () => {
    const params = { ids: 'PMC3531190,PMC1', format: 'json', idtype: 'pmcid' };
    await new NcbiApiClient(config).makeExternalRequest(NCBI_PMC_IDCONV_URL, params);

    const requested = new URL(fetchSpy.mock.calls[0]?.[0] as string);
    expect(`${requested.origin}${requested.pathname}`).toBe(NCBI_PMC_IDCONV_URL);
    expect(Object.fromEntries(requested.searchParams)).toEqual({
      tool: 'test-tool',
      email: 'ops@example.org',
      ...params,
    });

    expectNoUrl(everyLogArgument());
    expect(debugRecords()).toEqual([
      {
        msg: 'NCBI external request: GET',
        operation: 'NcbiExternalRequest',
        host: 'pmc.ncbi.nlm.nih.gov',
        params,
      },
    ]);
  });

  it('makeExternalRequest keeps the URL out of a non-2xx error’s data, even when the response carries it', async () => {
    const { JsonRpcErrorCode } = await import('@cyanheads/mcp-ts-core/errors');
    fetchSpy.mockResolvedValueOnce(
      responseAt(`${NCBI_PMC_IDCONV_URL}?tool=test-tool&email=ops%40example.org`, 'busy', 503),
    );

    const error = await new NcbiApiClient(config)
      .makeExternalRequest(NCBI_PMC_IDCONV_URL, { ids: 'PMC1' })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(McpError);
    expect((error as McpError).data).not.toHaveProperty('url');
    expectNoUrl((error as McpError).data);
    expectNoUrl((error as McpError).message);
    expectNoUrl(everyLogArgument());
    expect(error).toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      data: { host: 'pmc.ncbi.nlm.nih.gov', status: 503, body: 'busy' },
    });
  });

  it('makeExternalRequest keeps the URL out of a network failure’s message and data', async () => {
    // A connection failure holds the request URL on `path`, not in its message.
    fetchSpy.mockRejectedValueOnce(
      Object.assign(new TypeError('Unable to connect. Is the computer able to access the url?'), {
        code: 'ConnectionRefused',
        path: `${NCBI_PMC_IDCONV_URL}?tool=test-tool&email=ops%40example.org`,
      }),
    );

    const error = await new NcbiApiClient(config)
      .makeExternalRequest(NCBI_PMC_IDCONV_URL, { ids: 'PMC1' })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(McpError);
    expectNoUrl((error as McpError).data);
    expectNoUrl((error as McpError).message);
    expect((error as McpError).data).toEqual({
      reason: 'ncbi_unreachable',
      host: 'pmc.ncbi.nlm.nih.gov',
    });
  });

  /**
   * A fetch rejection shaped as Bun 1.4 writes some of them: the request URL quoted
   * whole in the message, query string and credentials included, with the same URL
   * on `path` and a transport `code`.
   */
  const rejectionQuoting = (url: string) =>
    Object.assign(
      new TypeError(
        `Malformed_HTTP_Response fetching "${url}". For more information, pass \`verbose: true\` in the second argument to fetch()`,
      ),
      { code: 'Malformed_HTTP_Response', path: url },
    );

  /** No query string, credential, or operator email in `value`, whatever its shape. */
  const expectNoUrlQuery = (value: unknown) => {
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    for (const fragment of [
      '?tool=',
      '?ids=',
      '?api_key=',
      'sk-ncbi-secret',
      'ops%40example.org',
    ]) {
      expect(text).not.toContain(fragment);
    }
  };

  /** The text of the rejection the error chains — what a log record's cause chain reads. */
  const causeMessage = (error: McpError) => {
    const { cause } = error;
    return cause instanceof Error ? cause.message : String(cause);
  };

  it.each([
    ['GET', 'esearch', {}],
    ['POST', 'efetch', { usePost: true }],
  ] as const)(
    'makeRequest %s: a network failure quoting the request URL names only its host',
    async (_method, endpoint, options) => {
      const { JsonRpcErrorCode } = await import('@cyanheads/mcp-ts-core/errors');
      const url = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/${endpoint}.fcgi?tool=test-tool&email=ops%40example.org&api_key=sk-ncbi-secret&db=pubmed`;
      const rejection = rejectionQuoting(url);
      fetchSpy.mockRejectedValueOnce(rejection);

      const error = await new NcbiApiClient(config)
        .makeRequest(endpoint, { db: 'pubmed' }, options)
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(McpError);
      const mcp = error as McpError;
      for (const text of [mcp.message, mcp.data, causeMessage(mcp), everyLogArgument()]) {
        expectNoUrlQuery(text);
      }
      expect(mcp.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
      expect(mcp.message).toBe(
        'NCBI request failed: Malformed_HTTP_Response fetching "https://eutils.ncbi.nlm.nih.gov/…?…". For more information, pass `verbose: true` in the second argument to fetch()',
      );
      expect(mcp.data).toEqual({ reason: 'ncbi_unreachable', endpoint });
      // The runtime's rejection stays the cause, transport code intact.
      expect(mcp.cause).toBe(rejection);
      expect(mcp.cause).toMatchObject({ code: 'Malformed_HTTP_Response' });
    },
  );

  it('makeRequest: a body that fails mid-stream quoting the request URL names only its host', async () => {
    const url =
      'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?tool=test-tool&email=ops%40example.org&api_key=sk-ncbi-secret';
    const rejection = rejectionQuoting(url);
    const body = new ReadableStream({ start: (controller) => controller.error(rejection) });
    fetchSpy.mockResolvedValueOnce(new Response(body, { status: 200 }));

    const error = await new NcbiApiClient(config)
      .makeRequest('efetch', { db: 'pubmed' })
      .catch((e: unknown) => e);

    const mcp = error as McpError;
    for (const text of [mcp.message, mcp.data, causeMessage(mcp)]) expectNoUrlQuery(text);
    expect(mcp.message).toContain('"https://eutils.ncbi.nlm.nih.gov/…?…"');
    expect(mcp.data).toEqual({ reason: 'ncbi_unreachable', endpoint: 'efetch' });
    expect(mcp.cause).toBe(rejection);
  });

  it('makeExternalRequest: a network failure quoting the request URL names only its host', async () => {
    const url = `${NCBI_PMC_IDCONV_URL}?tool=test-tool&email=ops%40example.org&ids=PMC1`;
    fetchSpy.mockRejectedValueOnce(rejectionQuoting(url));

    const error = await new NcbiApiClient(config)
      .makeExternalRequest(NCBI_PMC_IDCONV_URL, { ids: 'PMC1' })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(McpError);
    const mcp = error as McpError;
    for (const text of [mcp.message, mcp.data, causeMessage(mcp), everyLogArgument()]) {
      expectNoUrlQuery(text);
    }
    expect(mcp.message).toContain('"https://pmc.ncbi.nlm.nih.gov/…?…"');
    expect(mcp.data).toEqual({ reason: 'ncbi_unreachable', host: 'pmc.ncbi.nlm.nih.gov' });
    expect(mcp.cause).toMatchObject({ code: 'Malformed_HTTP_Response' });
  });

  it('a rejection whose message cannot be rewritten is chained as a redacted stand-in', async () => {
    const url = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?api_key=sk-ncbi-secret';
    fetchSpy.mockRejectedValueOnce(Object.freeze(rejectionQuoting(url)));

    const error = await new NcbiApiClient(config)
      .makeRequest('esearch', { db: 'pubmed' })
      .catch((e: unknown) => e);

    const mcp = error as McpError;
    for (const text of [mcp.message, mcp.data, causeMessage(mcp)]) expectNoUrlQuery(text);
    expect(mcp.cause).toBeInstanceOf(Error);
    expect(mcp.cause).toMatchObject({ name: 'TypeError', code: 'Malformed_HTTP_Response' });
  });

  it('a non-Error rejection quoting the request URL is redacted the same way', async () => {
    fetchSpy.mockRejectedValueOnce(
      'failed fetching https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?api_key=sk-ncbi-secret',
    );

    const error = await new NcbiApiClient(config)
      .makeRequest('esearch', { db: 'pubmed' })
      .catch((e: unknown) => e);

    const mcp = error as McpError;
    expect(mcp.message).toBe(
      'NCBI request failed: failed fetching https://eutils.ncbi.nlm.nih.gov/…?…',
    );
    expectNoUrlQuery(String(mcp.cause));
  });
});

/**
 * Each HTTP attempt records one point on the framework's `http.client.request.duration`
 * histogram, measured the way `fetchWithTimeout` measures every other upstream: from the
 * fetch to the response headers, plus the error-body capture on a non-2xx, with a status
 * only when a response arrived. `performance.now` reads the fake clock and the stubbed
 * upstream takes its time on fake timers, so every duration is exact. (#281)
 */
describe('NcbiApiClient records each request on http.client.request.duration (#281)', () => {
  const EUTILS = 'eutils.ncbi.nlm.nih.gov';
  const EINFO = '<eInfoResult><DbList><DbName>pubmed</DbName></DbList></eInfoResult>';
  const PMID = '23193287';
  const ARTICLE_SET = `<?xml version="1.0"?><PubmedArticleSet><PubmedArticle><MedlineCitation><PMID>${PMID}</PMID></MedlineCitation></PubmedArticle></PubmedArticleSet>`;

  let fetchSpy: ReturnType<typeof vi.spyOn>;
  let clockSpy: ReturnType<typeof vi.spyOn>;
  let randomSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    clockSpy = vi.spyOn(performance, 'now').mockImplementation(() => Date.now());
    randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0.5);
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('unmocked fetch'));
    for (const histogram of histograms) histogram.points.length = 0;
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    randomSpy.mockRestore();
    clockSpy.mockRestore();
    vi.useRealTimers();
  });

  const durationPoints = () =>
    histograms
      .filter((histogram) => histogram.name === 'http.client.request.duration')
      .flatMap((histogram) => histogram.points);
  const statuses = () =>
    durationPoints().map((point) => point.attributes['http.response.status_code']);

  /** A body whose read takes `ms` on the fake clock. */
  const bodyTaking = (text: string, ms: number) =>
    new ReadableStream<Uint8Array>(
      {
        pull: (controller) =>
          new Promise<void>((resolve) => {
            setTimeout(() => {
              controller.enqueue(new TextEncoder().encode(text));
              controller.close();
              resolve();
            }, ms);
          }),
      },
      { highWaterMark: 0 },
    );

  /** Answers with `status` once `headersMs` pass, its body read over `bodyMs` more. */
  const answerAfter =
    (headersMs: number, status: number, body: string, bodyMs = 0) =>
    () =>
      new Promise<Response>((resolve) => {
        setTimeout(() => resolve(new Response(bodyTaking(body, bodyMs), { status })), headersMs);
      });

  /** Answers successive requests with these replies at once, the last one repeating. */
  const answerInTurn = (...replies: [status: number, body: string][]) => {
    let call = 0;
    fetchSpy.mockImplementation(() => {
      const [status, body] = replies[Math.min(call++, replies.length - 1)] as [number, string];
      return Promise.resolve(new Response(body, { status }));
    });
  };

  /** Never answers; rejects with the abort reason when the request's signal fires. */
  const hangUntilAborted = (_input: unknown, init?: RequestInit) =>
    new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
    });

  /** Answers only when the test calls the returned `release`. */
  const holdUntilReleased = () => {
    let release: ((response: Response) => void) | undefined;
    fetchSpy.mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          release = resolve;
        }),
    );
    return (response: Response) => release?.(response);
  };

  /** Settles `pending` with the fake clock run out: its value, or what it threw. */
  const settle = async (pending: Promise<unknown>) => {
    const outcome = pending.catch((error: unknown) => error);
    await vi.runAllTimersAsync();
    return outcome;
  };

  const serviceOver = (queue = createPacer({ name: 'ncbi-test' }), totalDeadlineMs = 60_000) =>
    new NcbiService(
      new NcbiApiClient(baseConfig),
      queue,
      new NcbiResponseHandler(),
      2,
      totalDeadlineMs,
    );

  const requests: [string, (client: NcbiApiClient) => Promise<string>, Record<string, string>][] = [
    [
      'eutils GET',
      (client) => client.makeRequest('einfo', { db: 'pubmed' }),
      { 'http.request.method': 'GET', 'server.address': EUTILS },
    ],
    [
      'eutils POST',
      (client) => client.makeRequest('efetch', { db: 'pubmed' }, { usePost: true }),
      { 'http.request.method': 'POST', 'server.address': EUTILS },
    ],
    [
      'PMC ID Converter GET',
      (client) => client.makeExternalRequest(NCBI_PMC_IDCONV_URL, { ids: 'PMC1' }),
      { 'http.request.method': 'GET', 'server.address': 'pmc.ncbi.nlm.nih.gov' },
    ],
  ];

  it.each(requests)(
    '%s: records one point from the fetch to the response headers, the 2xx body read excluded',
    async (_label, send, attributes) => {
      fetchSpy.mockImplementation(answerAfter(300, 200, '<ok/>', 5_000));

      expect(await settle(send(new NcbiApiClient(baseConfig)))).toBe('<ok/>');
      expect(durationPoints()).toEqual([
        { seconds: 0.3, attributes: { ...attributes, 'http.response.status_code': 200 } },
      ]);
    },
  );

  it.each(requests)(
    '%s: a non-2xx point runs through the error-body capture',
    async (_label, send, attributes) => {
      fetchSpy.mockImplementation(answerAfter(300, 503, 'busy', 200));

      expect(await settle(send(new NcbiApiClient(baseConfig)))).toMatchObject({
        code: JsonRpcErrorCode.ServiceUnavailable,
        data: { status: 503, body: 'busy' },
      });
      expect(durationPoints()).toEqual([
        { seconds: 0.5, attributes: { ...attributes, 'http.response.status_code': 503 } },
      ]);
    },
  );

  /**
   * The client restates the instrument because the framework exports no recorder for a
   * caller that keeps plain `fetch`; a unit or description that drifted from the
   * framework's would register a second, conflicting stream under the same name.
   */
  it('records on the instrument fetchWithTimeout registers, with the attributes it records for the same request', async () => {
    fetchSpy.mockImplementation(() => Promise.resolve(new Response(EINFO, { status: 200 })));

    await new NcbiApiClient(baseConfig).makeRequest('einfo', { db: 'pubmed' });
    const framework = await fetchWithTimeout(
      `${NCBI_EUTILS_BASE_URL}/einfo.fcgi?db=pubmed`,
      5_000,
      { requestId: 'test' } as RequestContext,
    );
    await framework.text();

    const registered = histograms.filter((h) => h.name === 'http.client.request.duration');
    expect(registered).toHaveLength(2);
    const [clientInstrument, frameworkInstrument] = registered;
    expect(clientInstrument?.options).toEqual(frameworkInstrument?.options);
    expect(clientInstrument?.options).toMatchObject({ unit: 's' });
    const attributes = {
      'http.request.method': 'GET',
      'server.address': EUTILS,
      'http.response.status_code': 200,
    };
    expect(clientInstrument?.points.map((p) => p.attributes)).toEqual([attributes]);
    expect(frameworkInstrument?.points.map((p) => p.attributes)).toEqual([attributes]);
  });

  it.each([
    [
      'a per-request timeout',
      () => Promise.reject(new DOMException('The operation timed out.', 'TimeoutError')),
    ],
    ['a network failure', () => Promise.reject(new TypeError('fetch failed'))],
  ])('records %s with no status', async (_label, reply) => {
    fetchSpy.mockImplementation(reply);

    expect(
      await new NcbiApiClient(baseConfig)
        .makeRequest('einfo', { db: 'pubmed' })
        .catch((e: unknown) => e),
    ).toMatchObject({ data: { reason: 'ncbi_unreachable' } });
    expect(durationPoints()).toEqual([
      { seconds: 0, attributes: { 'http.request.method': 'GET', 'server.address': EUTILS } },
    ]);
  });

  it('records a request the caller aborts mid-flight with no status, up to the abort', async () => {
    fetchSpy.mockImplementation(hangUntilAborted);
    const caller = new AbortController();
    const pending = new NcbiApiClient(baseConfig)
      .makeRequest('einfo', { db: 'pubmed' }, { signal: caller.signal })
      .catch((e: unknown) => e);

    await vi.advanceTimersByTimeAsync(250);
    caller.abort(new Error('caller cancelled'));

    expect(await pending).toMatchObject({ message: 'NCBI request failed: caller cancelled' });
    expect(durationPoints()).toEqual([
      { seconds: 0.25, attributes: { 'http.request.method': 'GET', 'server.address': EUTILS } },
    ]);
  });

  it.each([
    ['eutils GET', (service: NcbiService) => service.eInfo({ db: 'pubmed' }), EINFO],
    [
      'eutils POST',
      (service: NcbiService) =>
        service.eFetch({ db: 'pubmed', id: PMID }, { retmode: 'xml', usePost: true }),
      ARTICLE_SET,
    ],
    [
      'PMC ID Converter GET',
      (service: NcbiService) => service.idConvert(['PMC1'], 'pmcid'),
      '{"records":[]}',
    ],
  ])(
    '%s: a call retried twice records three points, one per attempt',
    async (_label, call, body) => {
      answerInTurn([503, 'busy'], [500, 'WWW Error 500'], [200, body]);

      expect(await settle(call(serviceOver()))).not.toBeInstanceOf(Error);
      expect(fetchSpy).toHaveBeenCalledTimes(3);
      expect(statuses()).toEqual([503, 500, 200]);
    },
  );

  it('records the 200 of an NCBI <ERROR> envelope the service retries as a backend failure', async () => {
    const timeoutEnvelope =
      '<eFetchResult><ERROR>Error: External viewer error: Empty Response. Bytes read: 0 Status: Timeout</ERROR></eFetchResult>';
    answerInTurn([200, timeoutEnvelope], [200, ARTICLE_SET]);

    expect(await settle(serviceOver().eFetch({ db: 'pubmed', id: PMID }))).toHaveProperty(
      'PubmedArticleSet',
    );
    expect(statuses()).toEqual([200, 200]);
  });

  it('records the 400 of an all-invalid EFetch ID list the service resolves as an empty result', async () => {
    answerInTurn([
      400,
      '<eFetchResult><ERROR>ID list is empty! Possibly it has no correct IDs.</ERROR></eFetchResult>',
    ]);

    expect(await settle(serviceOver().eFetch({ db: 'pubmed', id: '00000000' }))).toHaveProperty(
      'PubmedArticleSet',
    );
    expect(statuses()).toEqual([400]);
  });

  it('leaves the queue wait out: a call held behind the start gap records only its own request', async () => {
    const startedAfter: number[] = [];
    const t0 = Date.now();
    const answer = answerAfter(300, 200, EINFO);
    fetchSpy.mockImplementation(() => {
      startedAfter.push(Date.now() - t0);
      return answer();
    });
    const service = serviceOver(createPacer({ name: 'ncbi-test', minStartGapMs: 3_000 }));

    await settle(Promise.all([service.eInfo({ db: 'pubmed' }), service.eInfo({ db: 'pubmed' })]));

    expect(startedAfter).toEqual([0, 3_000]);
    expect(durationPoints().map((point) => point.seconds)).toEqual([0.3, 0.3]);
  });

  it('records a request the total deadline aborts mid-flight with no status', async () => {
    fetchSpy.mockImplementation(hangUntilAborted);

    expect(await settle(serviceOver(undefined, 5_000).eInfo({ db: 'pubmed' }))).toMatchObject({
      code: JsonRpcErrorCode.Timeout,
      data: { reason: 'ncbi_deadline_exceeded' },
    });
    expect(durationPoints()).toEqual([
      { seconds: 5, attributes: { 'http.request.method': 'GET', 'server.address': EUTILS } },
    ]);
  });

  it('records nothing for a call the queue sheds, and one point for the call it runs', async () => {
    const release = holdUntilReleased();
    const service = serviceOver(
      createPacer({ name: 'ncbi-test', maxConcurrent: 1, maxQueueDepth: 0 }),
    );
    const running = service.eInfo({ db: 'pubmed' });
    await vi.advanceTimersByTimeAsync(0);

    expect(await service.eInfo({ db: 'pubmed' }).catch((e: unknown) => e)).toMatchObject({
      data: { reason: 'queue_full' },
    });
    release(new Response(EINFO, { status: 200 }));
    await running;

    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(statuses()).toEqual([200]);
  });

  it('records nothing for a call whose deadline expires while it waits in the queue', async () => {
    const release = holdUntilReleased();
    const queue = createPacer({ name: 'ncbi-test', maxConcurrent: 1 });
    const running = serviceOver(queue).eInfo({ db: 'pubmed' });
    await vi.advanceTimersByTimeAsync(0);

    const queued = serviceOver(queue, 5_000)
      .eInfo({ db: 'pubmed' })
      .catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await queued).toMatchObject({ data: { reason: 'ncbi_deadline_exceeded' } });
    release(new Response(EINFO, { status: 200 }));
    await running;

    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(statuses()).toEqual([200]);
  });
});
