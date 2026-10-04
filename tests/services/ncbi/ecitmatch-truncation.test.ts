/**
 * @fileoverview ECitMatch truncation recovery in `NcbiService.eCitMatch` (#193).
 * A journal-less citation ECitMatch finds no candidate for ends its response:
 * that line and every line after it come back with no row. The service reports
 * that line `not_found` and requests the lines after it again, inside one
 * deadline and one retry allowance for the whole call.
 * @module tests/services/ncbi/ecitmatch-truncation.test
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createPacer } from '@cyanheads/mcp-ts-core/utils';
import { afterEach, describe, expect, it, type Mock, vi } from 'vitest';
import type { NcbiApiClient } from '@/services/ncbi/api-client.js';
import { NcbiService } from '@/services/ncbi/ncbi-service.js';
import type { NcbiResponseHandler } from '@/services/ncbi/response-handler.js';
import type { ECitMatchCitation } from '@/services/ncbi/types.js';

vi.mock('@cyanheads/mcp-ts-core/utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@cyanheads/mcp-ts-core/utils')>();
  return {
    // Retry, pacing, and the transience verdict stay real — they bound the loop.
    createPacer: actual.createPacer,
    defaultIsTransient: actual.defaultIsTransient,
    withRetry: actual.withRetry,
    logger: { debug: vi.fn(), info: vi.fn(), notice: vi.fn(), warning: vi.fn(), error: vi.fn() },
    requestContextService: { createRequestContext: vi.fn(() => ({ requestId: 'test' })) },
  };
});

const PNAS: ECitMatchCitation = {
  journal: 'proc natl acad sci u s a',
  year: '1991',
  volume: '88',
  firstPage: '3248',
  authorName: 'mann bj',
  key: 'hit',
};
/** Journal-less, valid year, no candidate — the line ECitMatch stops at. */
const MISS: ECitMatchCitation = { year: '1991', volume: '88', firstPage: '99999', key: 'miss' };

/**
 * Stand-in for ecitmatch.cgi, from the live behavior recorded in #187 and #193:
 * it answers lines in submission order and stops at the first journal-less line
 * it finds no candidate for, returning no row for that line or any after it. A
 * journal-bearing miss is answered `NOT_FOUND;INVALID_JOURNAL` and the response
 * continues.
 */
function ecitmatchAnswer(bdata: string): string {
  const rows: string[] = [];
  for (const line of bdata.split('\r')) {
    const [journal = '', , , firstPage = ''] = line.split('|');
    const hit = journal === PNAS.journal && firstPage === PNAS.firstPage;
    if (!hit && journal === '') break;
    rows.push(`${line}${hit ? '2014248' : 'NOT_FOUND;INVALID_JOURNAL'}`);
  }
  return rows.length > 0 ? `${rows.join('\n')}\n` : '';
}

interface Harness {
  /** The bdata of every ECitMatch request, in order. */
  bdatas: () => string[];
  makeRequest: Mock;
  service: NcbiService;
}

/**
 * A service over a fake transport: `makeRequest` hands the submitted bdata to
 * the response handler, which `answer`s it as ecitmatch.cgi would. Retry,
 * pacing, and the deadline run for real.
 */
function createHarness(
  options: {
    answer?: (bdata: string) => string;
    deadlineMs?: number;
    makeRequest?: Mock;
    maxRetries?: number;
  } = {},
): Harness {
  const makeRequest =
    options.makeRequest ??
    vi.fn(async (_endpoint: string, params: { bdata?: string }) => params.bdata ?? '');
  const answer = options.answer ?? ecitmatchAnswer;
  const apiClient = { makeRequest } as unknown as NcbiApiClient;
  const responseHandler = {
    parseAndHandleResponse: vi.fn((bdata: string) => answer(bdata)),
  } as unknown as NcbiResponseHandler;
  const service = new NcbiService(
    apiClient,
    createPacer({ name: 'ncbi-test' }),
    responseHandler,
    options.maxRetries ?? 0,
    options.deadlineMs ?? 60_000,
  );
  return {
    service,
    makeRequest,
    bdatas: () => makeRequest.mock.calls.map((call) => String(call[1]?.bdata)),
  };
}

const NOT_FOUND = { matched: false, pmid: null, status: 'not_found' };
const MATCHED = { matched: true, pmid: '2014248', status: 'matched' };

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('NcbiService.eCitMatch truncation recovery (#193)', () => {
  it('matches a citation placed after a journal-less miss, with one extra request', async () => {
    const { service, makeRequest, bdatas } = createHarness();

    const results = await service.eCitMatch([MISS, PNAS]);

    expect(results).toEqual([
      { key: 'miss', ...NOT_FOUND },
      { key: 'hit', ...MATCHED },
    ]);
    expect(makeRequest).toHaveBeenCalledTimes(2);
    expect(bdatas()).toEqual([
      '|1991|88|99999||1|\rproc natl acad sci u s a|1991|88|3248|mann bj|2|',
      'proc natl acad sci u s a|1991|88|3248|mann bj|2|',
    ]);
  });

  it('needs no extra request when the miss is the last line', async () => {
    const { service, makeRequest } = createHarness();

    const results = await service.eCitMatch([PNAS, MISS]);

    expect(results).toEqual([
      { key: 'hit', ...MATCHED },
      { key: 'miss', ...NOT_FOUND },
    ]);
    expect(makeRequest).toHaveBeenCalledTimes(1);
  });

  it('keeps every match when two journal-less misses each precede one', async () => {
    const { service, makeRequest, bdatas } = createHarness();

    const results = await service.eCitMatch([
      { ...MISS, key: 'miss-a' },
      { ...PNAS, key: 'hit-a' },
      { ...MISS, firstPage: '88888', key: 'miss-b' },
      { ...PNAS, key: 'hit-b' },
    ]);

    expect(results).toEqual([
      { key: 'miss-a', ...NOT_FOUND },
      { key: 'hit-a', ...MATCHED },
      { key: 'miss-b', ...NOT_FOUND },
      { key: 'hit-b', ...MATCHED },
    ]);
    expect(makeRequest).toHaveBeenCalledTimes(3);
    // Each re-request carries only the lines after the one the response stopped
    // at, under their original wire keys.
    expect(bdatas().map((bdata) => bdata.split('\r').map((line) => line.split('|')[5]))).toEqual([
      ['1', '2', '3', '4'],
      ['2', '3', '4'],
      ['4'],
    ]);
  });

  it('makes exactly one request when the response carries every row', async () => {
    const { service, makeRequest } = createHarness();

    const results = await service.eCitMatch([
      PNAS,
      { journal: 'nonexistentjournalxyz', year: '1991', volume: '88', firstPage: '3248', key: 'j' },
      { ...PNAS, key: 'hit-2' },
    ]);

    expect(results.map((r) => r.status)).toEqual(['matched', 'not_found', 'matched']);
    expect(results[1]).toMatchObject({ detail: 'NOT_FOUND;INVALID_JOURNAL' });
    expect(makeRequest).toHaveBeenCalledTimes(1);
  });

  it('spends one request per line on 25 journal-less misses — the heaviest call', async () => {
    const { service, makeRequest, bdatas } = createHarness();
    const citations = Array.from({ length: 25 }, (_, i) => ({
      ...MISS,
      firstPage: String(90_000 + i),
      key: `m${i + 1}`,
    }));

    const results = await service.eCitMatch(citations);

    expect(results).toHaveLength(25);
    expect(results.every((r) => r.status === 'not_found')).toBe(true);
    expect(results.map((r) => r.key)).toEqual(citations.map((c) => c.key));
    expect(makeRequest).toHaveBeenCalledTimes(25);
    expect(bdatas().map((bdata) => bdata.split('\r').length)).toEqual(
      Array.from({ length: 25 }, (_, i) => 25 - i),
    );
  });

  it('reports a re-requested line exactly as it reports the same line sent first', async () => {
    const first = await createHarness().service.eCitMatch([
      PNAS,
      { journal: 'nonexistentjournalxyz', year: '1991', key: 'j' },
    ]);
    const after = await createHarness().service.eCitMatch([
      MISS,
      PNAS,
      { journal: 'nonexistentjournalxyz', year: '1991', key: 'j' },
    ]);

    expect(after.slice(1)).toEqual(first);
  });

  /**
   * Live responses only ever lose a contiguous suffix. A row missing ahead of a
   * row that came back is not a stop: it stays not_found (#54) and is not
   * requested again, since nothing shows a second request would answer it.
   */
  it('reports a missing row followed by a present row as not_found without re-requesting it', async () => {
    const { service, makeRequest } = createHarness({
      answer: (bdata) =>
        bdata
          .split('\r')
          .filter((_, i) => i !== 1)
          .map((line) => `${line}2014248`)
          .join('\n'),
    });

    const results = await service.eCitMatch([
      { ...PNAS, key: 'a' },
      { ...PNAS, key: 'b' },
      { ...PNAS, key: 'c' },
    ]);

    expect(results).toEqual([
      { key: 'a', ...MATCHED },
      { key: 'b', ...NOT_FOUND },
      { key: 'c', ...MATCHED },
    ]);
    expect(makeRequest).toHaveBeenCalledTimes(1);
  });

  describe('caller cancellation', () => {
    it('stops before the next re-request once the caller aborts', async () => {
      const controller = new AbortController();
      const reason = new Error('caller cancelled');
      const makeRequest = vi.fn(async (_endpoint: string, params: { bdata?: string }) => {
        controller.abort(reason);
        return String(params.bdata);
      });
      const { service } = createHarness({ makeRequest });

      await expect(
        service.eCitMatch([MISS, PNAS, PNAS], { signal: controller.signal }),
      ).rejects.toBe(reason);
      expect(makeRequest).toHaveBeenCalledTimes(1);
    });

    it('rethrows an abort that lands while a re-request is in flight', async () => {
      const controller = new AbortController();
      const reason = new Error('caller cancelled');
      const makeRequest = vi.fn(
        (_endpoint: string, params: { bdata?: string }, options: { signal: AbortSignal }) => {
          if (makeRequest.mock.calls.length === 1) return Promise.resolve(String(params.bdata));
          queueMicrotask(() => controller.abort(reason));
          return new Promise((_, reject) =>
            options.signal.addEventListener('abort', () => reject(options.signal.reason), {
              once: true,
            }),
          );
        },
      );
      const { service } = createHarness({ makeRequest });

      await expect(service.eCitMatch([MISS, PNAS], { signal: controller.signal })).rejects.toBe(
        reason,
      );
      expect(makeRequest).toHaveBeenCalledTimes(2);
    });
  });

  describe('one budget for the whole call', () => {
    /** Each request answers after 200 ms of fake time, or rejects when its signal aborts. */
    const slowRequest = () =>
      vi.fn(
        (_endpoint: string, params: { bdata?: string }, options: { signal: AbortSignal }) =>
          new Promise((resolve, reject) => {
            const timer = setTimeout(() => resolve(String(params.bdata)), 200);
            options.signal.addEventListener(
              'abort',
              () => {
                clearTimeout(timer);
                reject(options.signal.reason);
              },
              { once: true },
            );
          }),
      );

    it('fails with ncbi_deadline_exceeded when the re-requests outlast the call’s deadline', async () => {
      vi.useFakeTimers();
      const makeRequest = slowRequest();
      // Two 200 ms requests against a 300 ms deadline: each fits on its own,
      // together they do not.
      const { service } = createHarness({ deadlineMs: 300, makeRequest });

      const settled = service.eCitMatch([MISS, PNAS]).catch((error: unknown) => error);
      // Past the 400 ms a fresh deadline per request would need, so that reading
      // settles too and fails the assertion instead of hanging.
      await vi.advanceTimersByTimeAsync(500);

      expect(await settled).toMatchObject({
        code: JsonRpcErrorCode.Timeout,
        data: { reason: 'ncbi_deadline_exceeded', deadlineMs: 300 },
      });
      expect(makeRequest).toHaveBeenCalledTimes(2);
    });

    it('completes when the deadline covers every request', async () => {
      vi.useFakeTimers();
      const { service } = createHarness({ deadlineMs: 500, makeRequest: slowRequest() });

      const settled = service.eCitMatch([MISS, PNAS]);
      await vi.advanceTimersByTimeAsync(400);

      expect((await settled).map((r) => r.status)).toEqual(['not_found', 'matched']);
    });

    it('draws every request’s retries from one allowance', async () => {
      vi.useFakeTimers();
      vi.spyOn(Math, 'random').mockReturnValue(0.5);
      let attempts = 0;
      // Each of the two requests fails transiently on its first attempt.
      const makeRequest = vi.fn(async (_endpoint: string, params: { bdata?: string }) => {
        attempts += 1;
        if (attempts === 1 || attempts === 3) {
          throw new McpError(JsonRpcErrorCode.ServiceUnavailable, 'NCBI returned HTTP 503.');
        }
        return String(params.bdata);
      });
      const { service } = createHarness({ maxRetries: 1, makeRequest });

      const settled = service.eCitMatch([MISS, PNAS]).catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(5_000);

      // The first request spent the call's one retry, so the second request's
      // transient failure ends the call.
      expect(await settled).toMatchObject({
        code: JsonRpcErrorCode.ServiceUnavailable,
        data: { reason: 'ncbi_unreachable', endpoint: 'ecitmatch.cgi', attempts: 1 },
      });
      expect(makeRequest).toHaveBeenCalledTimes(3);
    });

    it('retries a re-request while the allowance lasts', async () => {
      vi.useFakeTimers();
      vi.spyOn(Math, 'random').mockReturnValue(0.5);
      let attempts = 0;
      const makeRequest = vi.fn(async (_endpoint: string, params: { bdata?: string }) => {
        attempts += 1;
        if (attempts === 2) {
          throw new McpError(JsonRpcErrorCode.ServiceUnavailable, 'NCBI returned HTTP 503.');
        }
        return String(params.bdata);
      });
      const { service } = createHarness({ maxRetries: 1, makeRequest });

      const settled = service.eCitMatch([MISS, PNAS]);
      await vi.advanceTimersByTimeAsync(5_000);

      expect((await settled).map((r) => r.status)).toEqual(['not_found', 'matched']);
      expect(makeRequest).toHaveBeenCalledTimes(3);
    });
  });
});
