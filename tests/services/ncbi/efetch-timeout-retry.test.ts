/**
 * @fileoverview Regression for issue #153 — EFetch reports a backend timeout as an
 * `<eFetchResult><ERROR>` envelope under HTTP 400 or HTTP 200. Both must classify as a
 * transient upstream failure and be retried within the retry count and deadline, while a
 * genuine invalid-parameter 400 stays non-retryable. Drives a real NcbiApiClient,
 * NcbiService, and NcbiResponseHandler against a stubbed global fetch.
 * @module tests/services/ncbi/efetch-timeout-retry.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NcbiApiClient } from '@/services/ncbi/api-client.js';
import { NcbiService } from '@/services/ncbi/ncbi-service.js';
import type { NcbiRequestQueue } from '@/services/ncbi/request-queue.js';
import { NcbiResponseHandler } from '@/services/ncbi/response-handler.js';

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

const PMID = '23193287';
const TIMEOUT_MESSAGE =
  'Error: External viewer error: Empty Response. Bytes read: 0 Status: Timeout';
const TIMEOUT_ENVELOPE = `<eFetchResult><ERROR>${TIMEOUT_MESSAGE}</ERROR></eFetchResult>`;
const INVALID_ID_ENVELOPE = '<eFetchResult><ERROR>Invalid id parameter</ERROR></eFetchResult>';
const ARTICLE_SET = `<?xml version="1.0"?><PubmedArticleSet><PubmedArticle><MedlineCitation><PMID>${PMID}</PMID></MedlineCitation></PubmedArticle></PubmedArticleSet>`;

type Reply = { body: string; status: number };

let fetchSpy: ReturnType<typeof vi.spyOn> | undefined;

/** Stubs fetch with one reply per call; the last reply repeats once the list runs out. */
function stubFetch(...replies: Reply[]): ReturnType<typeof vi.spyOn> {
  let call = 0;
  fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
    const reply = replies[Math.min(call++, replies.length - 1)] as Reply;
    return Promise.resolve(new Response(reply.body, { status: reply.status }));
  });
  return fetchSpy;
}

function buildService(maxRetries: number, totalDeadlineMs = 60_000): NcbiService {
  const apiClient = new NcbiApiClient({ toolIdentifier: 'test', timeoutMs: 5000 });
  const queue = {
    enqueue: vi.fn(async (task: () => Promise<unknown>) => task()),
  } as unknown as NcbiRequestQueue;
  return new NcbiService(apiClient, queue, new NcbiResponseHandler(), maxRetries, totalDeadlineMs);
}

function requestedUrls(spy: ReturnType<typeof vi.spyOn>): string[] {
  return spy.mock.calls.map((args: unknown[]) => String(args[0]));
}

afterEach(() => {
  fetchSpy?.mockRestore();
  fetchSpy = undefined;
});

describe('EFetch backend-timeout envelope (issue #153)', () => {
  let setTimeoutSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // Fire backoff sleeps immediately; leave the 60s deadline timer pending.
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
  });

  it.each([
    { status: 400, label: 'HTTP 400' },
    { status: 200, label: 'HTTP 200' },
  ])(
    'retries the timeout envelope under $label to exhaustion as ServiceUnavailable',
    async ({ status }) => {
      const spy = stubFetch({ body: TIMEOUT_ENVELOPE, status });
      const service = buildService(2);

      await expect(service.eFetch({ db: 'pubmed', id: PMID })).rejects.toMatchObject({
        code: JsonRpcErrorCode.ServiceUnavailable,
        message: expect.stringContaining('Status: Timeout'),
        data: {
          reason: 'ncbi_unreachable',
          attempts: 3,
          ncbiErrors: [TIMEOUT_MESSAGE],
          recovery: { hint: expect.any(String) },
        },
      });
      expect(spy).toHaveBeenCalledTimes(3);
    },
  );

  it('recovers on a later successful response, re-requesting the same ID each attempt', async () => {
    const spy = stubFetch(
      { body: TIMEOUT_ENVELOPE, status: 400 },
      { body: TIMEOUT_ENVELOPE, status: 200 },
      { body: ARTICLE_SET, status: 200 },
    );
    const service = buildService(2);

    const result = await service.eFetch({ db: 'pubmed', id: PMID });

    expect(result.PubmedArticleSet?.PubmedArticle).toHaveLength(1);
    expect(spy).toHaveBeenCalledTimes(3);
    for (const url of requestedUrls(spy)) {
      expect(new URL(url).searchParams.get('id')).toBe(PMID);
    }
  });

  it('keeps a genuine invalid-parameter 400 non-retryable', async () => {
    const spy = stubFetch({ body: INVALID_ID_ENVELOPE, status: 400 });
    const service = buildService(2);

    await expect(service.eFetch({ db: 'pubmed', id: 'not-a-pmid' })).rejects.toMatchObject({
      code: JsonRpcErrorCode.InvalidParams,
    });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('keeps an empty-bodied 400 non-retryable', async () => {
    const spy = stubFetch({ body: '', status: 400 });
    const service = buildService(2);

    await expect(service.eFetch({ db: 'pubmed', id: PMID })).rejects.toMatchObject({
      code: JsonRpcErrorCode.InvalidParams,
    });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('parses an ordinary PubmedArticleSet on the first attempt', async () => {
    const spy = stubFetch({ body: ARTICLE_SET, status: 200 });
    const service = buildService(2);

    const result = await service.eFetch({ db: 'pubmed', id: PMID });

    expect(result.PubmedArticleSet?.PubmedArticle).toHaveLength(1);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('names the timeout on the ordered-parser path instead of an unknown error', async () => {
    const spy = stubFetch({ body: TIMEOUT_ENVELOPE, status: 200 });
    const service = buildService(1);

    await expect(
      service.eFetch({ db: 'pmc', id: 'PMC3531190' }, { retmode: 'xml', useOrderedParser: true }),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      message: expect.stringContaining('Status: Timeout'),
      data: { ncbiErrors: [TIMEOUT_MESSAGE] },
    });
    expect(spy).toHaveBeenCalledTimes(2);
  });
});

describe('EFetch backend-timeout envelope under the service deadline (issue #153)', () => {
  let randomSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // Remove backoff jitter: attempt 0 fails at ~0ms, sleeps 1000ms; attempt 1 fails at
    // ~1000ms and sleeps 2000ms, which the 1500ms deadline interrupts.
    randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0.5);
  });

  afterEach(() => {
    randomSpy.mockRestore();
  });

  it('stops retrying when the total deadline expires mid-backoff', async () => {
    const spy = stubFetch({ body: TIMEOUT_ENVELOPE, status: 400 });
    const service = buildService(10, 1500);

    await expect(service.eFetch({ db: 'pubmed', id: PMID })).rejects.toMatchObject({
      code: JsonRpcErrorCode.Timeout,
      data: { reason: 'ncbi_deadline_exceeded', deadlineMs: 1500 },
    });
    expect(spy).toHaveBeenCalledTimes(2);
  }, 5000);
});
