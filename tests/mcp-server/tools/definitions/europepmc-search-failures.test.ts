/**
 * @fileoverview Regression for issues #152 and #159 at the tool surface. Runs
 * `pubmed_europepmc_search` and `pubmed_europepmc_fetch` through their contract
 * boundary against the real EuropePmcService, EuropePmcApiClient, and framework
 * `fetchWithTimeout`, behind a stubbed global `fetch`, and asserts both consumption
 * paths — `structuredContent` and `content[]` — for a `/search` HTTP failure and
 * for Europe PMC's empty `{ version }` envelope.
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
      expect(text).toContain('(reason europepmc_invalid_input');
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
