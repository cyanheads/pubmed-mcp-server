/**
 * @fileoverview Regression for issues #152, #159, #175, and #180 at the tool
 * surface. Runs `pubmed_europepmc_search` and `pubmed_europepmc_fetch` through
 * their contract boundary against the real EuropePmcService, EuropePmcApiClient,
 * and framework `fetchWithTimeout`, behind a stubbed global `fetch`, and asserts
 * both consumption paths — `structuredContent` and `content[]` — for a `/search`
 * HTTP failure, Europe PMC's empty `{ version }` envelope, the single-source
 * query the search sends, and a 503 on a caller-supplied `cursorMark`.
 * @module tests/mcp-server/tools/definitions/europepmc-search-failures.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { textBlocks } from '../../../_helpers.js';

vi.mock('@cyanheads/mcp-ts-core/utils', async () => {
  const actual = await vi.importActual<typeof import('@cyanheads/mcp-ts-core/utils')>(
    '@cyanheads/mcp-ts-core/utils',
  );
  return {
    ...actual,
    logger: { debug: vi.fn(), info: vi.fn(), notice: vi.fn(), warning: vi.fn(), error: vi.fn() },
  };
});

const MAX_RETRIES = 2;
const EXHAUSTED = MAX_RETRIES + 1;

/** Real service stack, zero start gap. Built lazily so the accessor mock can return it. */
let service: unknown;
vi.mock('@/services/europe-pmc/europe-pmc-service.js', async () => {
  const actual = await vi.importActual<
    typeof import('@/services/europe-pmc/europe-pmc-service.js')
  >('@/services/europe-pmc/europe-pmc-service.js');
  return { ...actual, getEuropePmcService: () => service };
});

const { EuropePmcApiClient } = await import('@/services/europe-pmc/api-client.js');
const { createEuropePmcRequestQueue } = await import('@/services/europe-pmc/request-queue.js');
const { EuropePmcService } = await import('@/services/europe-pmc/europe-pmc-service.js');
const { pubmedEuropepmcSearchTool } = await import(
  '@/mcp-server/tools/definitions/pubmed-europepmc-search.tool.js'
);
const { pubmedEuropepmcFetchTool } = await import(
  '@/mcp-server/tools/definitions/pubmed-europepmc-fetch.tool.js'
);

const UNREACHABLE_HINT =
  'Retry after a brief delay; Europe PMC was unreachable. NCBI PMC and Unpaywall remain available.';

type Reply = { status: number; body?: unknown; headers?: Record<string, string> };

const ENVELOPE: Reply = { status: 200, body: { version: '6.9' } };
const RESULTS: Reply = {
  status: 200,
  body: {
    version: '6.9',
    hitCount: 1,
    request: { queryString: 'CRISPR', cursorMark: '*' },
    resultList: { result: [{ id: '31295471', source: 'MED', pmid: '31295471', title: 'A' }] },
  },
};

let fetchSpy: ReturnType<typeof vi.spyOn>;
let setTimeoutSpy: ReturnType<typeof vi.spyOn>;

/** Stub global fetch with one reply per call; the last reply repeats. */
function stubFetch(replies: Reply[]) {
  let call = 0;
  fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
    const reply = replies[Math.min(call++, replies.length - 1)] as Reply;
    const body = reply.body === undefined ? '' : JSON.stringify(reply.body);
    return Promise.resolve(
      new Response(body, {
        status: reply.status,
        headers: { 'content-type': 'application/json', ...reply.headers },
      }),
    );
  });
}

type ErrorEnvelope = {
  code: number;
  message: string;
  data?: { reason?: string; retryAfter?: string; recovery?: { hint: string } };
};

function errorOf(result: Awaited<ReturnType<typeof runToolContract>>) {
  expect(result.isError).toBe(true);
  const error = (result.structuredContent as { error: ErrorEnvelope }).error;
  const [block] = textBlocks(result.content);
  return { error, text: block?.text ?? '' };
}

const search = (input: Record<string, unknown>) =>
  runToolContract(pubmedEuropepmcSearchTool, { query: 'CRISPR', ...input });
const fetchRecords = () =>
  runToolContract(pubmedEuropepmcFetchTool, {
    records: [{ source: 'MED', epmcId: '31295471' }],
  });

beforeEach(() => {
  service = new EuropePmcService(
    // Above the setTimeout stub's pass-through ceiling, so the request timer never fires.
    new EuropePmcApiClient({ timeoutMs: 60_000 }),
    createEuropePmcRequestQueue(0),
    MAX_RETRIES,
  );
  // Fire retry backoff at once; leave long timers (the request timeout) unarmed.
  setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((
    fn: () => void,
    ms?: number,
  ) => {
    if (typeof ms !== 'number' || ms < 50_000) fn();
    return 0 as unknown as ReturnType<typeof setTimeout>;
  }) as unknown as typeof setTimeout);
});

afterEach(() => {
  fetchSpy?.mockRestore();
  setTimeoutSpy.mockRestore();
});

describe.each([
  ['pubmed_europepmc_search', () => search({})],
  ['pubmed_europepmc_fetch', fetchRecords],
])('%s on a failing /search', (_name, run) => {
  it('surfaces a persistent 404 as europepmc_unreachable on both paths (#152)', async () => {
    stubFetch([{ status: 404, body: 'Not Found' }]);
    const { error, text } = errorOf(await run());

    expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(error.data?.reason).toBe('europepmc_unreachable');
    expect(error.data?.recovery?.hint).toBe(UNREACHABLE_HINT);
    expect(error.message).toMatch(
      new RegExp(`Status: 404.*\\(failed after ${EXHAUSTED} attempts\\)$`),
    );
    expect(text).toContain(`Recovery: ${UNREACHABLE_HINT}`);
    expect(text).toContain('(reason europepmc_unreachable');
    expect(fetchSpy).toHaveBeenCalledTimes(EXHAUSTED);
  });

  it('surfaces a persistent 502 the same way (#152)', async () => {
    stubFetch([{ status: 502, body: 'Bad Gateway' }]);
    const { error, text } = errorOf(await run());

    expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(error.data?.reason).toBe('europepmc_unreachable');
    expect(text).toContain(`Recovery: ${UNREACHABLE_HINT}`);
    expect(fetchSpy).toHaveBeenCalledTimes(EXHAUSTED);
  });

  it('keeps a 429 RateLimited with its retryAfter on both paths (#152)', async () => {
    stubFetch([{ status: 429, headers: { 'retry-after': '5' } }]);
    const { error, text } = errorOf(await run());

    expect(error.code).toBe(JsonRpcErrorCode.RateLimited);
    expect(error.data?.retryAfter).toBe('5');
    // `europepmc_unreachable` is declared for ServiceUnavailable only.
    expect(error.data?.reason).toBeUndefined();
    expect(text).not.toContain('europepmc_unreachable');
    expect(text).not.toContain(UNREACHABLE_HINT);
    expect(fetchSpy).toHaveBeenCalledTimes(EXHAUSTED);
  });

  it('keeps a persistent 504 as Timeout, without the unreachable reason (#152)', async () => {
    stubFetch([{ status: 504, body: 'Gateway Timeout' }]);
    const { error, text } = errorOf(await run());

    expect(error.code).toBe(JsonRpcErrorCode.Timeout);
    expect(error.message).toMatch(
      new RegExp(`Status: 504.*\\(failed after ${EXHAUSTED} attempts\\)$`),
    );
    expect(error.data?.reason).toBeUndefined();
    expect(text).not.toContain('europepmc_unreachable');
    expect(fetchSpy).toHaveBeenCalledTimes(EXHAUSTED);
  });

  it('ends a persistent empty envelope as europepmc_unreachable, naming no input (#159)', async () => {
    stubFetch([ENVELOPE]);
    const { error, text } = errorOf(await run());

    expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(error.data?.reason).toBe('europepmc_unreachable');
    expect(error.message).toMatch(new RegExp(`\\(failed after ${EXHAUSTED} attempts\\)$`));
    expect(error.message).not.toMatch(/sort|query|CRISPR|EXT_ID/i);
    expect(text).toContain(`Recovery: ${UNREACHABLE_HINT}`);
    expect(fetchSpy).toHaveBeenCalledTimes(EXHAUSTED);
  });

  it('returns records when an envelope clears on the next attempt (#159)', async () => {
    stubFetch([ENVELOPE, RESULTS]);
    const result = await run();

    expect(result.isError).toBeFalsy();
    const structured = result.structuredContent as Record<string, unknown[]>;
    expect((structured.hits ?? structured.records)?.length).toBe(1);
    expect(textBlocks(result.content)[0]?.text).toContain('31295471');
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
});

describe('pubmed_europepmc_search sort handling (#159)', () => {
  it('ends a persistent envelope on a documented sort as europepmc_unreachable', async () => {
    stubFetch([ENVELOPE]);
    const { error, text } = errorOf(await search({ sort: 'CITED desc' }));

    expect(error.data?.reason).toBe('europepmc_unreachable');
    expect(error.message).not.toContain('CITED');
    expect(text).not.toContain('CITED');
    expect(fetchSpy).toHaveBeenCalledTimes(EXHAUSTED);
  });

  it.each(['BOGUSFIELD desc', 'CITED'])(
    'fails %s fast as europepmc_invalid_input naming the sort',
    async (sort) => {
      stubFetch([ENVELOPE]);
      const { error, text } = errorOf(await search({ sort }));

      expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
      expect(error.data?.reason).toBe('europepmc_invalid_input');
      expect(error.message).toContain(`"${sort}"`);
      expect(error.data?.recovery?.hint).not.toBe(error.message);
      expect(text).toContain(`"${sort}"`);
      expect(text).toContain('Recovery: Use a documented sort');
      expect(text).toContain('(reason europepmc_invalid_input · not retryable');
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    },
  );

  it('sends an undocumented sort upstream and returns its results', async () => {
    stubFetch([RESULTS]);
    const result = await search({ sort: 'ID asc' });

    expect(result.isError).toBeFalsy();
    expect(new URL(String(fetchSpy.mock.calls[0]?.[0])).searchParams.get('sort')).toBe('ID asc');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('reports an HTTP-200 zero-hit search as an empty page, not an error', async () => {
    stubFetch([{ status: 200, body: { version: '6.9', hitCount: 0, request: {} } }]);
    const result = await search({});

    expect(result.isError).toBeFalsy();
    expect((result.structuredContent as { hits: unknown[] }).hits).toEqual([]);
    expect(textBlocks(result.content)[0]?.text).toContain('**Returned:** 0');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});

/** The URL parameters of each request the stubbed `fetch` received, in order. */
const sentParams = (): URLSearchParams[] =>
  fetchSpy.mock.calls.map((call: unknown[]) => new URL(String(call[0])).searchParams);

/** Every text block of a contract run, joined. */
const allText = (result: Awaited<ReturnType<typeof runToolContract>>) =>
  textBlocks(result.content)
    .map((block) => block.text)
    .join('\n');

describe('pubmed_europepmc_search single-source query (#175)', () => {
  /** Answers like Europe PMC: one hit, and a `request.queryString` echo of the query sent. */
  function stubEchoingFetch() {
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const queryString = new URL(String(input)).searchParams.get('query');
      const body = {
        version: '6.9',
        hitCount: 1,
        request: { queryString, cursorMark: '*' },
        resultList: { result: [{ id: '32669217', source: 'MED', pmid: '32669217' }] },
      };
      return Promise.resolve(
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    });
  }

  it.each([
    ['unquoted', 'EXT_ID:32669217'],
    ['quoted', 'EXT_ID:"32669217"'],
  ])(
    'sends a %s EXT_ID with the repeated source clause and echoes it on both paths',
    async (_label, query) => {
      stubEchoingFetch();
      const result = await search({ query, sources: ['MED'], pageSize: 1 });

      const expected = `(${query}) AND (SRC:"MED" OR SRC:"MED")`;
      expect(sentParams()[0]?.get('query')).toBe(expected);

      const structured = result.structuredContent as {
        query: string;
        searchUrl: string;
        hits: Array<{ epmcId: string }>;
      };
      expect(structured.query).toBe(expected);
      expect(new URL(structured.searchUrl).searchParams.get('query')).toBe(expected);
      expect(structured.hits.map((h) => h.epmcId)).toEqual(['32669217']);

      const text = allText(result);
      expect(text).toContain(`**Effective Query:** ${expected}`);
      expect(text).toContain(`**Search URL:** ${structured.searchUrl}`);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    },
  );
});

describe('pubmed_europepmc_search cursorMark (#180)', () => {
  /** Europe PMC's actual answer to a cursor it cannot decode. */
  const CURSOR_503: Reply = {
    status: 503,
    body: { errMsg: 'Search service is temporarily unavailable. Please retry later.' },
  };

  /**
   * Stubs global fetch by cursor: a first-page (`*`) request draws from
   * `firstPage`, any other from `cursorPage`; each list's last reply repeats.
   */
  function stubFetchByCursor(cursorPage: Reply[], firstPage: Reply[]) {
    let cursorCalls = 0;
    let firstPageCalls = 0;
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const isFirstPage = new URL(String(input)).searchParams.get('cursorMark') === '*';
      const replies = isFirstPage ? firstPage : cursorPage;
      const index = isFirstPage ? firstPageCalls++ : cursorCalls++;
      const reply = replies[Math.min(index, replies.length - 1)] as Reply;
      return Promise.resolve(
        new Response(JSON.stringify(reply.body ?? {}), {
          status: reply.status,
          headers: { 'content-type': 'application/json' },
        }),
      );
    });
  }

  it('fails an unreadable cursor as a non-retryable europepmc_invalid_input on both paths', async () => {
    stubFetchByCursor([CURSOR_503], [RESULTS]);
    const { error, text } = errorOf(await search({ query: 'malaria', cursorMark: 'abc' }));

    expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(error.message).toContain('cursorMark "abc"');
    expect(error.data).toMatchObject({
      reason: 'europepmc_invalid_input',
      cursorMark: 'abc',
      retryable: false,
    });
    const hint = error.data?.recovery?.hint ?? '';
    expect(hint).toContain('`nextCursorMark`');
    expect(hint).toContain('`*`');

    expect(text).toContain('cursorMark "abc"');
    expect(text).toContain(`Recovery: ${hint}`);
    expect(text).toContain('(reason europepmc_invalid_input · not retryable');
    expect(text).not.toContain(UNREACHABLE_HINT);

    // The cursor request, one first-page probe of the same query, and one retry
    // of the cursor that draws the 503 again — nothing else.
    expect(fetchSpy).toHaveBeenCalledTimes(3);
    const [original, probe, retry] = sentParams();
    expect(original?.get('cursorMark')).toBe('abc');
    expect(probe?.get('cursorMark')).toBe('*');
    expect(probe?.get('pageSize')).toBe('1');
    expect(probe?.get('query')).toBe(original?.get('query'));
    expect(retry?.toString()).toBe(original?.toString());
  });

  it('returns the cursor page when one 503 clears on the retry after the first page is served', async () => {
    stubFetchByCursor([CURSOR_503, RESULTS], [RESULTS]);
    const result = await search({ query: 'malaria', cursorMark: 'abc' });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      cursorMark: 'abc',
      hits: [expect.objectContaining({ epmcId: '31295471' })],
    });
    expect(allText(result)).toContain('31295471');
    expect(sentParams().map((p) => p.get('cursorMark'))).toEqual(['abc', '*', 'abc']);
  });

  it('reports an outage, not a bad cursor, when the first page fails too', async () => {
    stubFetchByCursor([CURSOR_503], [CURSOR_503]);
    const { error, text } = errorOf(await search({ query: 'malaria', cursorMark: 'abc' }));

    expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(error.data?.reason).toBe('europepmc_unreachable');
    expect(error.message).toMatch(
      new RegExp(`Status: 503.*\\(failed after ${EXHAUSTED} attempts\\)$`),
    );
    expect(text).toContain(`Recovery: ${UNREACHABLE_HINT}`);
    expect(sentParams().map((p) => p.get('cursorMark'))).toEqual(['abc', '*', 'abc', 'abc']);
  });

  it('keeps a 503 on the first page (`*`) as europepmc_unreachable with today’s attempt count', async () => {
    stubFetch([CURSOR_503]);
    const { error, text } = errorOf(await search({ query: 'malaria', cursorMark: '*' }));

    expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(error.data?.reason).toBe('europepmc_unreachable');
    expect(error.data?.recovery?.hint).toBe(UNREACHABLE_HINT);
    expect(error.message).toMatch(
      new RegExp(`Status: 503.*\\(failed after ${EXHAUSTED} attempts\\)$`),
    );
    expect(text).toContain(`Recovery: ${UNREACHABLE_HINT}`);
    expect(text).toContain('(reason europepmc_unreachable');
    expect(fetchSpy).toHaveBeenCalledTimes(EXHAUSTED);
    expect(sentParams().every((p) => p.get('cursorMark') === '*')).toBe(true);
  });

  it('pages with a nextCursorMark Europe PMC issued', async () => {
    const issued = 'AoIIQGBcPSg1NjExNjU0Mg==';
    stubFetch([
      {
        status: 200,
        body: {
          version: '6.9',
          hitCount: 2,
          nextCursorMark: 'AoIIQE0YSCg1NjExNjUxNg==',
          request: { queryString: 'malaria', cursorMark: encodeURIComponent(issued) },
          resultList: { result: [{ id: '42575114', source: 'MED', pmid: '42575114' }] },
        },
      },
    ]);
    const result = await search({ query: 'malaria', cursorMark: issued, pageSize: 1 });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      cursorMark: issued,
      nextCursorMark: 'AoIIQE0YSCg1NjExNjUxNg==',
    });
    expect(allText(result)).toContain('42575114');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(sentParams()[0]?.get('cursorMark')).toBe(issued);
  });
});
