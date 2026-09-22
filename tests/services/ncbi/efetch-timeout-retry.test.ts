/**
 * @fileoverview Regression for issue #153 — EFetch reports a backend timeout as an
 * `<eFetchResult><ERROR>` envelope under HTTP 400 or HTTP 200. Both must classify as a
 * transient upstream failure and be retried within the retry count and deadline, while a
 * genuine invalid-parameter 400 stays non-retryable. Issue #155 extends the same path:
 * the `proxy_stream()` backend envelopes retry like the timeout, and the all-invalid-ID
 * `ID list is empty!` envelope resolves as the empty set NCBI returns for an unknown ID.
 * Drives a real NcbiApiClient, NcbiService, and NcbiResponseHandler against a stubbed
 * global fetch.
 * @module tests/services/ncbi/efetch-timeout-retry.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createPacer } from '@cyanheads/mcp-ts-core/utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NcbiApiClient } from '@/services/ncbi/api-client.js';
import { NcbiService } from '@/services/ncbi/ncbi-service.js';
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
  // A real pacer with no limits: every attempt starts at once and no timer is armed.
  const queue = createPacer({ name: 'ncbi-test' });
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

/** Prolog NCBI puts ahead of every `<eFetchResult>` error envelope. */
const ENVELOPE_PROLOG =
  '<?xml version="1.0" encoding="UTF-8" ?>\n<!DOCTYPE eEfetchResult PUBLIC "-//NLM//DTD efetch 20131226//EN" "https://eutils.ncbi.nlm.nih.gov/eutils/dtd/20131226/efetch.dtd">\n';

function errorEnvelope(message: string): string {
  return `${ENVELOPE_PROLOG}<eFetchResult>\n\t<ERROR>${message}</ERROR>\n</eFetchResult>\n`;
}

/** NCBI's padded backend error page. Long enough to overrun the 500-byte error-body capture. */
const BACKEND_502_PAGE = `<html><head><title>502 Server Error</title></head><body><h1>Error: Server Error</h1><h2>The server encountered a temporary error and could not complete your request.<p>Please try again in 30 seconds.</h2>${'<!-- padding -->'.repeat(30)}</body></html>`;

describe('EFetch proxy_stream() backend envelopes (issue #155)', () => {
  let setTimeoutSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
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
    {
      label: 'a relayed 502 page, raw',
      message: `Error: CEFetchPApplication::proxy_stream(): ${BACKEND_502_PAGE}`,
    },
    {
      label: 'a relayed 502 page, entity-escaped',
      message: `Error: CEFetchPApplication::proxy_stream(): ${BACKEND_502_PAGE.replaceAll('<', '&lt;').replaceAll('>', '&gt;')}`,
    },
    {
      label: 'PubOne unreachable',
      message:
        'Error: CEFetchPApplication::proxy_stream(): Failed to connect to PubOne service. Try again later.',
    },
  ])(
    'retries the HTTP 400 envelope for $label to exhaustion as ncbi_unreachable',
    async ({ message }) => {
      const spy = stubFetch({ body: errorEnvelope(message), status: 400 });
      const service = buildService(2);

      const failure = service.eFetch({ db: 'pubmed', id: PMID });
      await expect(failure).rejects.toMatchObject({
        code: JsonRpcErrorCode.ServiceUnavailable,
        message: expect.stringContaining('proxy_stream()'),
        data: {
          reason: 'ncbi_unreachable',
          attempts: 3,
          ncbiErrors: [expect.stringContaining('CEFetchPApplication::proxy_stream()')],
          recovery: { hint: expect.any(String) },
        },
      });
      // Markup from the relayed page never reaches the caller-facing diagnostic.
      await expect(failure).rejects.toSatisfy(
        (error: { data: { ncbiErrors: string[] } }) =>
          !error.data.ncbiErrors.some((text) => /<[a-z!/]/i.test(text)),
      );
      expect(spy).toHaveBeenCalledTimes(3);
    },
  );

  it('recovers when a later attempt succeeds', async () => {
    const spy = stubFetch(
      {
        body: errorEnvelope(`Error: CEFetchPApplication::proxy_stream(): ${BACKEND_502_PAGE}`),
        status: 400,
      },
      { body: ARTICLE_SET, status: 200 },
    );
    const service = buildService(2);

    const result = await service.eFetch({ db: 'pubmed', id: PMID });

    expect(result.PubmedArticleSet?.PubmedArticle).toHaveLength(1);
    expect(spy).toHaveBeenCalledTimes(2);
  });
});

/** What NCBI answers, HTTP 200, for a well-formed PMID it has no record for (`id=99999999`). */
const UNKNOWN_PMID_ARTICLE_SET =
  '<?xml version="1.0" ?>\n<!DOCTYPE PubmedArticleSet PUBLIC "-//NLM//DTD PubMedArticle, 1st January 2025//EN" "https://dtd.nlm.nih.gov/ncbi/pubmed/out/pubmed_250101.dtd">\n<PubmedArticleSet></PubmedArticleSet>\n';
const ID_LIST_EMPTY_ENVELOPE = errorEnvelope('ID list is empty! Possibly it has no correct IDs.');

describe('EFetch "ID list is empty" envelope (issue #155)', () => {
  it('resolves an all-invalid PubMed ID list exactly as NCBI resolves an unknown PMID', async () => {
    stubFetch({ body: UNKNOWN_PMID_ARTICLE_SET, status: 200 });
    const unknown = await buildService(2).eFetch({ db: 'pubmed', id: '99999999' });
    fetchSpy?.mockRestore();

    const spy = stubFetch({ body: ID_LIST_EMPTY_ENVELOPE, status: 400 });
    const result = await buildService(2).eFetch({ db: 'pubmed', id: '00000000' });

    expect(result).toEqual(unknown);
    expect('PubmedArticleSet' in result).toBe(true);
    // A settled answer, not a transient failure — one request, no retry.
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('keeps the envelope an empty result under the raw-XML option', async () => {
    stubFetch({ body: ID_LIST_EMPTY_ENVELOPE, status: 400 });

    const raw = await buildService(2).eFetch<string>(
      { db: 'pubmed', id: '00000000' },
      { retmode: 'xml', returnRawXml: true },
    );

    expect(raw).toMatch(/<PubmedArticleSet>\s*<\/PubmedArticleSet>/);
  });

  it('resolves an all-invalid PMC ID list to an empty pmc-articleset on the ordered-parser path', async () => {
    // NCBI's HTTP 200 answer for an unknown PMCID, minus the per-ID <error> it carries.
    stubFetch({
      body: '<?xml version="1.0"  ?><!DOCTYPE pmc-articleset PUBLIC "-//NLM//DTD ARTICLE SET 2.0//EN" "https://dtd.nlm.nih.gov/ncbi/pmc/articleset/nlm-articleset-2.0.dtd"><pmc-articleset></pmc-articleset>',
      status: 200,
    });
    const empty = await buildService(2).eFetch(
      { db: 'pmc', id: 'PMC99999999999' },
      { retmode: 'xml', useOrderedParser: true },
    );
    fetchSpy?.mockRestore();

    const spy = stubFetch({ body: ID_LIST_EMPTY_ENVELOPE, status: 400 });
    const result = await buildService(2).eFetch(
      { db: 'pmc', id: 'PMC0' },
      { retmode: 'xml', useOrderedParser: true },
    );

    expect(result).toEqual(empty);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('keeps the envelope an InvalidParams error for a database with no known empty result', async () => {
    const spy = stubFetch({ body: ID_LIST_EMPTY_ENVELOPE, status: 400 });

    await expect(buildService(2).eFetch({ db: 'gene', id: '0' })).rejects.toMatchObject({
      code: JsonRpcErrorCode.InvalidParams,
    });
    expect(spy).toHaveBeenCalledTimes(1);
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
