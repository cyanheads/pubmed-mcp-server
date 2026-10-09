/**
 * @fileoverview Tests for the NCBI API client (URL construction, GET/POST selection, error handling).
 * @module tests/services/ncbi/api-client.test
 */

import { McpError } from '@cyanheads/mcp-ts-core/errors';
import { logger, type RequestContext } from '@cyanheads/mcp-ts-core/utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NcbiApiClient, type NcbiApiClientConfig } from '@/services/ncbi/api-client.js';
import { NCBI_PMC_IDCONV_URL } from '@/services/ncbi/types.js';

// makeRequest now uses plain `globalThis.fetch` (mirroring makeExternalRequest) so the
// 500→ServiceUnavailable reclassification in makeRequest is reachable; the suites spy the
// global. httpErrorFromResponse stays real (via `...actual`) so status→code classification
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
