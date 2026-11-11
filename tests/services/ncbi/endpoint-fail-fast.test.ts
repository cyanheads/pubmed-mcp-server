/**
 * @fileoverview Regression for issue #287 — once a call to an E-utility endpoint spends
 * its whole retry ladder on `ncbi_unreachable`, later calls to that endpoint make one
 * attempt each until one succeeds, while every other endpoint keeps its full ladder.
 * Drives the production wiring (`initNcbiService`: real client, queue, retry, and
 * response handler) against a stubbed global fetch that answers per endpoint, under
 * fake timers with backoff jitter pinned, so every assertion reads when each upstream
 * request actually started.
 * @module tests/services/ncbi/endpoint-fail-fast.test
 */

import { JsonRpcErrorCode, type McpError } from '@cyanheads/mcp-ts-core/errors';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NCBI_SERVICE_ERRORS } from '@/services/error-contracts.js';
import { readCommonMark, textBlocks } from '../../_helpers.js';
import { driveUntilSettled, type Outcome, track } from './_fake-clock.js';

vi.mock('@cyanheads/mcp-ts-core/utils', async () => {
  const actual = await vi.importActual<typeof import('@cyanheads/mcp-ts-core/utils')>(
    '@cyanheads/mcp-ts-core/utils',
  );
  return {
    ...actual,
    logger: { debug: vi.fn(), info: vi.fn(), notice: vi.fn(), warning: vi.fn(), error: vi.fn() },
    requestContextService: { createRequestContext: vi.fn(() => ({ requestId: 'test' })) },
  };
});

/** Fake-clock origin. Nonzero so no scheduler reads a zero timestamp as "never started". */
const T0 = 1_000_000;

/** Request starts of a full ladder under the defaults (6 retries, 60 s deadline, no jitter). */
const LADDER = [0, 1_000, 3_000, 7_000, 15_000, 31_000];

const PMID = '23193287';

type Endpoint = 'esearch' | 'efetch' | 'idconv';

const OK_BODY: Record<Endpoint, string> = {
  esearch: `<?xml version="1.0" encoding="UTF-8" ?>\n<eSearchResult><Count>1</Count><RetMax>1</RetMax><RetStart>0</RetStart><IdList><Id>${PMID}</Id></IdList><QueryTranslation>test</QueryTranslation></eSearchResult>`,
  efetch: `<?xml version="1.0"?><PubmedArticleSet><PubmedArticle><MedlineCitation><PMID>${PMID}</PMID></MedlineCitation></PubmedArticle></PubmedArticleSet>`,
  idconv: '{"status":"ok","records":[]}',
};

const STATUS_TEXT = new Map([
  [408, 'Request Timeout'],
  [429, 'Too Many Requests'],
  [500, 'Internal Server Error'],
  [501, 'Not Implemented'],
]);

/**
 * A status answered at once; a status answered after `latencyMs` or carrying a
 * `Retry-After`; or no answer until the request is aborted.
 */
type Reply = number | { status: number; latencyMs?: number; retryAfter?: string } | 'hang';

/** The replies planned for one endpoint and the start offset (ms since T0) of each request served. */
interface Plan {
  replies: Reply[];
  starts: number[];
}

let plans: Map<Endpoint, Plan>;
/** Requests no plan covered — reported at test end, since a throw inside fetch reads as a network error. */
let unplanned: string[];

/**
 * Plans an endpoint's replies — the last one repeats — and returns the start offsets of
 * the requests served under the plan, filled in as they arrive.
 */
function answer(endpoint: Endpoint, ...replies: Reply[]): number[] {
  const plan: Plan = { replies, starts: [] };
  plans.set(endpoint, plan);
  return plan.starts;
}

function endpointOf(url: URL): Endpoint | undefined {
  if (url.pathname.startsWith('/tools/idconv/')) return 'idconv';
  return /^\/entrez\/eutils\/(esearch|efetch)\.fcgi$/.exec(url.pathname)?.[1] as
    | Endpoint
    | undefined;
}

function respond(endpoint: Endpoint, reply: Reply, signal: AbortSignal | undefined) {
  if (reply === 'hang') {
    return new Promise<Response>((_, reject) => {
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
  }
  const {
    status,
    latencyMs = 0,
    retryAfter,
  } = typeof reply === 'number' ? { status: reply } : reply;
  const build = () =>
    status === 200
      ? new Response(OK_BODY[endpoint], { status })
      : new Response(`<html><body>${status}</body></html>`, {
          status,
          statusText: STATUS_TEXT.get(status) ?? '',
          ...(retryAfter && { headers: { 'retry-after': retryAfter } }),
        });
  if (latencyMs === 0) return Promise.resolve(build());
  return new Promise<Response>((resolve) => setTimeout(() => resolve(build()), latencyMs));
}

type NcbiService = import('@/services/ncbi/ncbi-service.js').NcbiService;

async function buildService(env: Record<string, string> = {}): Promise<NcbiService> {
  const settings = {
    NCBI_API_KEY: '',
    NCBI_REQUEST_DELAY_MS: '50',
    // The server defaults, pinned so the ladder timings above hold.
    NCBI_MAX_RETRIES: '6',
    NCBI_TOTAL_DEADLINE_MS: '60000',
    ...env,
  };
  for (const [name, value] of Object.entries(settings)) vi.stubEnv(name, value);
  const { initNcbiService, getNcbiService } = await import('@/services/ncbi/ncbi-service.js');
  initNcbiService();
  return getNcbiService();
}

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers({ now: T0 });
  // Pin backoff jitter so a retry's sleep is exactly its exponential value.
  vi.spyOn(Math, 'random').mockReturnValue(0.5);
  plans = new Map();
  unplanned = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const url = new URL(String(input));
    const endpoint = endpointOf(url);
    const plan = endpoint && plans.get(endpoint);
    if (!endpoint || !plan) {
      unplanned.push(url.pathname);
      return Promise.reject(new Error(`no reply planned for ${url.pathname}`));
    }
    const reply = plan.replies[Math.min(plan.starts.length, plan.replies.length - 1)] as Reply;
    plan.starts.push(Date.now() - T0);
    return respond(endpoint, reply, init?.signal ?? undefined);
  });
});

afterEach(() => {
  expect(unplanned).toEqual([]);
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

/** Drives one call to settlement; no call outlives the 60 s deadline. */
const settle = (call: Promise<unknown>): Promise<Outcome> => driveUntilSettled(track(call), 60_000);

const search = (service: NcbiService, term = 'aspirin', signal?: AbortSignal) =>
  service.eSearch({ db: 'pubmed', term }, signal ? { signal } : undefined);

const fetchArticle = (service: NcbiService) => service.eFetch({ db: 'pubmed', id: PMID });

const convert = (service: NcbiService) => service.idConvert(['PMC3531190'], 'pmcid');

const failFastMessage = (endpoint: string) =>
  `NCBI returned HTTP 500 Internal Server Error. (failed after 1 attempt, without retrying: the previous ${endpoint} call failed on every attempt)`;

const errorOf = (outcome: Outcome): McpError => {
  if (outcome.ok) throw new Error('Expected the call to fail.');
  return outcome.error;
};

/** Spends one esearch ladder on HTTP 500s, which arms esearch. */
async function armSearch(service: NcbiService): Promise<void> {
  const starts = answer('esearch', 500);
  expect(errorOf(await settle(search(service)))).toMatchObject({
    data: { reason: 'ncbi_unreachable', attempts: 6 },
  });
  expect(starts).toEqual(LADDER);
}

describe('fail-fast on an endpoint that keeps failing (issue #287)', () => {
  it('spends one ladder, then makes one attempt per call while the endpoint keeps failing', async () => {
    const service = await buildService();
    const starts = answer('esearch', 500);

    const first = errorOf(await settle(search(service, 'aspirin cardiovascular prevention')));
    expect(first).toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      message: 'NCBI returned HTTP 500 Internal Server Error. (failed after 6 attempts)',
      data: { reason: 'ncbi_unreachable', endpoint: 'esearch', attempts: 6 },
    });
    expect(starts).toEqual(LADDER);
    expect(Date.now() - T0).toBe(31_000);

    // One start gap after the last request, then settled on its one answer: no backoff.
    const second = errorOf(await settle(search(service, 'status epilepticus')));
    expect(starts).toEqual([...LADDER, 31_050]);
    expect(Date.now() - T0).toBe(31_050);
    expect(second.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(second.message).toBe(failFastMessage('esearch'));
    expect(second.data).toEqual({ reason: 'ncbi_unreachable', endpoint: 'esearch', attempts: 1 });

    // The fail-fast failure keeps the endpoint armed.
    const third = errorOf(await settle(search(service, 'asthma')));
    expect(starts).toEqual([...LADDER, 31_050, 31_100]);
    expect(third.message).toBe(failFastMessage('esearch'));
  });

  it('leaves other endpoints their ladder, and their recovery leaves the failing one armed', async () => {
    const service = await buildService();
    await armSearch(service);

    const efetch = answer('efetch', 500, 200);
    expect(await settle(fetchArticle(service))).toEqual({ ok: true });
    expect(efetch).toEqual([31_050, 32_050]);

    const esearch = answer('esearch', 500);
    expect(errorOf(await settle(search(service))).message).toBe(failFastMessage('esearch'));
    expect(esearch).toHaveLength(1);
  });

  it('clears on a success: the armed call recovers in one attempt and the next failure retries', async () => {
    const service = await buildService();
    await armSearch(service);

    const recovered = answer('esearch', 200);
    expect(await settle(search(service))).toEqual({ ok: true });
    expect(recovered).toHaveLength(1);

    const blip = answer('esearch', 500, 200);
    expect(await settle(search(service))).toEqual({ ok: true });
    expect(blip).toHaveLength(2);
  });

  it('gives each concurrent call on an armed endpoint its own single attempt', async () => {
    const service = await buildService();
    await armSearch(service);

    const starts = answer('esearch', 500);
    const calls = ['a', 'b', 'c'].map((term) => track(search(service, term)));
    const outcomes = [];
    for (const call of calls) outcomes.push(await driveUntilSettled(call, 60_000));

    expect(outcomes.map((o) => errorOf(o).message)).toEqual([
      failFastMessage('esearch'),
      failFastMessage('esearch'),
      failFastMessage('esearch'),
    ]);
    expect(starts).toEqual([31_050, 31_100, 31_150]);
  });

  it.each<[string, Reply, Record<string, unknown>]>([
    [
      'a deadline expiry',
      'hang',
      { code: JsonRpcErrorCode.Timeout, data: { reason: 'ncbi_deadline_exceeded' } },
    ],
    [
      'a 501 it never retries',
      501,
      { code: JsonRpcErrorCode.ServiceUnavailable, data: { status: 501, retryable: false } },
    ],
  ])(
    'keeps the endpoint armed when its one attempt fails with %s',
    async (_label, reply, error) => {
      const service = await buildService();
      await armSearch(service);

      const armed = answer('esearch', reply);
      expect(errorOf(await settle(search(service)))).toMatchObject(error);
      expect(armed).toHaveLength(1);

      const next = answer('esearch', 500);
      expect(errorOf(await settle(search(service))).message).toBe(failFastMessage('esearch'));
      expect(next).toHaveLength(1);
    },
  );

  /**
   * Each call ends one way, then a call to the same endpoint answering HTTP 500 every
   * time spends whatever ladder it is given. Only a call that ends `ncbi_unreachable`
   * with its retries spent arms the endpoint.
   */
  it.each<{
    label: string;
    replies: Reply[];
    abortAtMs?: number;
    error: Record<string, unknown>;
    requests: number;
    nextRequests: number;
  }>([
    {
      label: 'HTTP 500 on every attempt',
      replies: [500],
      error: { code: JsonRpcErrorCode.ServiceUnavailable, data: { reason: 'ncbi_unreachable' } },
      requests: 6,
      nextRequests: 1,
    },
    {
      label: 'a caller abort after two 500s',
      replies: [500],
      abortAtMs: 2_000,
      error: { message: 'caller gave up' },
      requests: 2,
      nextRequests: 6,
    },
    {
      label: 'a deadline expiry',
      replies: ['hang'],
      error: { code: JsonRpcErrorCode.Timeout, data: { reason: 'ncbi_deadline_exceeded' } },
      requests: 1,
      nextRequests: 6,
    },
    {
      label: 'HTTP 429 on every attempt',
      replies: [429],
      error: {
        code: JsonRpcErrorCode.RateLimited,
        message: 'NCBI returned HTTP 429 Too Many Requests. (failed after 6 attempts)',
        data: { reason: 'ncbi_rate_limited', attempts: 6 },
      },
      requests: 6,
      nextRequests: 6,
    },
    {
      label: 'HTTP 408 on every attempt',
      replies: [408],
      error: {
        code: JsonRpcErrorCode.Timeout,
        message: 'NCBI returned HTTP 408 Request Timeout. (failed after 6 attempts)',
        data: { endpoint: 'esearch', attempts: 6 },
      },
      requests: 6,
      nextRequests: 6,
    },
    {
      label: 'a 501 it never retries',
      replies: [501],
      error: { code: JsonRpcErrorCode.ServiceUnavailable, data: { status: 501, retryable: false } },
      requests: 1,
      nextRequests: 6,
    },
  ])('after $label, the next call makes $nextRequests request(s)', async (row) => {
    const service = await buildService();
    const starts = answer('esearch', ...row.replies);

    let outcome: Outcome;
    if (row.abortAtMs === undefined) {
      outcome = await settle(search(service));
    } else {
      const caller = new AbortController();
      const call = track(search(service, 'aspirin', caller.signal));
      await vi.advanceTimersByTimeAsync(row.abortAtMs);
      caller.abort(new Error('caller gave up'));
      outcome = await driveUntilSettled(call);
    }
    expect(errorOf(outcome)).toMatchObject(row.error);
    expect(starts).toHaveLength(row.requests);

    const next = answer('esearch', 500);
    expect(errorOf(await settle(search(service)))).toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      message:
        row.nextRequests === 1
          ? failFastMessage('esearch')
          : 'NCBI returned HTTP 500 Internal Server Error. (failed after 6 attempts)',
      data: { reason: 'ncbi_unreachable', attempts: row.nextRequests },
    });
    expect(next).toHaveLength(row.nextRequests);
  });

  it('leaves the next call its ladder after a call the queue sheds as queue_full', async () => {
    // A 10 s Retry-After on EFetch closes the shared gate past a 5 s deadline, so an
    // ESearch call arriving behind it is shed before it sends anything.
    const service = await buildService({ NCBI_TOTAL_DEADLINE_MS: '5000' });
    answer('efetch', { status: 429, retryAfter: '10' });
    const throttled = errorOf(await settle(fetchArticle(service)));
    expect(throttled.data).toMatchObject({ reason: 'ncbi_rate_limited' });

    const shedStarts = answer('esearch', 500);
    expect(errorOf(await settle(search(service)))).toMatchObject({
      code: JsonRpcErrorCode.RateLimited,
      data: { reason: 'queue_full' },
    });
    expect(shedStarts).toEqual([]);

    // Past the gate, a 5 s deadline holds three attempts: 0, 1 s, 3 s.
    await vi.advanceTimersByTimeAsync(10_000);
    const next = answer('esearch', 500);
    expect(errorOf(await settle(search(service)))).toMatchObject({
      data: { reason: 'ncbi_unreachable', attempts: 3 },
    });
    expect(next).toHaveLength(3);
  });

  it('reads the armed state when a call arrives: a call queued while another arms keeps its ladder', async () => {
    // 500s that take 0.5 s and a 1 s start gap: B arrives while A's last request is in
    // flight and waits for the gap; A settles and arms esearch before B's first request.
    const service = await buildService({ NCBI_REQUEST_DELAY_MS: '1000' });
    const starts = answer('esearch', { status: 500, latencyMs: 500 });

    const a = track(search(service, 'a'));
    await vi.advanceTimersByTimeAsync(33_600);
    expect(starts).toEqual([0, 1_500, 4_000, 8_500, 17_000, 33_500]);
    const b = track(search(service, 'b'));

    expect(errorOf(await driveUntilSettled(a, 60_000)).data).toMatchObject({ attempts: 6 });
    expect(Date.now() - T0).toBe(34_000);
    expect(errorOf(await driveUntilSettled(b, 60_000))).toMatchObject({
      message: 'NCBI returned HTTP 500 Internal Server Error. (failed after 6 attempts)',
      data: { reason: 'ncbi_unreachable', attempts: 6 },
    });
    expect(starts.slice(6)).toEqual([34_500, 36_000, 38_500, 43_000, 51_500, 68_000]);

    // Arrived after A armed esearch: one attempt.
    expect(errorOf(await settle(search(service, 'c'))).message).toBe(failFastMessage('esearch'));
    expect(starts).toHaveLength(13);
  });

  it('arms and clears the PMC ID Converter alone', async () => {
    const service = await buildService();

    const idconv = answer('idconv', 500);
    expect(errorOf(await settle(convert(service)))).toMatchObject({
      data: { reason: 'ncbi_unreachable', endpoint: 'idconv', attempts: 6 },
    });
    expect(idconv).toEqual(LADDER);

    // ESearch still gets its own ladder, then arms on its own.
    const esearch = answer('esearch', 500);
    expect(errorOf(await settle(search(service))).data).toMatchObject({ attempts: 6 });
    expect(esearch).toHaveLength(6);

    const armedConvert = answer('idconv', 500);
    expect(errorOf(await settle(convert(service)))).toMatchObject({
      message: failFastMessage('idconv'),
      data: { reason: 'ncbi_unreachable', endpoint: 'idconv', attempts: 1 },
    });
    expect(armedConvert).toHaveLength(1);

    // The converter recovering clears idconv, not esearch.
    const recovered = answer('idconv', 200);
    expect(await settle(convert(service))).toEqual({ ok: true });
    expect(recovered).toHaveLength(1);

    const stillArmed = answer('esearch', 500);
    expect(errorOf(await settle(search(service))).message).toBe(failFastMessage('esearch'));
    expect(stillArmed).toHaveLength(1);

    const blip = answer('idconv', 500, 200);
    expect(await settle(convert(service))).toEqual({ ok: true });
    expect(blip).toHaveLength(2);
  });

  it('carries a fail-fast failure to both pubmed_convert_ids surfaces with the shared recovery', async () => {
    const service = await buildService();
    // Imported after initNcbiService, so the tool reads the same service instance.
    const { convertIdsTool } = await import('@/mcp-server/tools/definitions/convert-ids.tool.js');
    const recovery = NCBI_SERVICE_ERRORS.find((e) => e.reason === 'ncbi_unreachable')?.recovery;
    const starts = answer('idconv', 500);
    await settle(convert(service));

    const pending = runToolContract(convertIdsTool, { ids: ['PMC3531190'], idType: 'pmcid' });
    await driveUntilSettled(track(pending), 60_000);
    const result = await pending;

    expect(starts).toEqual([...LADDER, 31_050]);
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.ServiceUnavailable,
        message: failFastMessage('idconv'),
        data: {
          reason: 'ncbi_unreachable',
          endpoint: 'idconv',
          attempts: 1,
          recovery: { hint: recovery },
        },
      },
    });
    const text = readCommonMark(
      textBlocks(result.content)
        .map((b) => b.text)
        .join('\n'),
    );
    expect(text).toContain(`Error: ${failFastMessage('idconv')}`);
    expect(text).toContain(`Recovery: ${recovery}`);
    expect(text).toContain('reason ncbi_unreachable');
  });

  it('adds no fail-fast clause where the call makes one attempt anyway (NCBI_MAX_RETRIES=0)', async () => {
    const service = await buildService({ NCBI_MAX_RETRIES: '0' });
    const starts = answer('esearch', 500);

    for (const term of ['a', 'b']) {
      expect(errorOf(await settle(search(service, term)))).toMatchObject({
        message: 'NCBI returned HTTP 500 Internal Server Error. (failed after 1 attempt)',
        data: { reason: 'ncbi_unreachable', endpoint: 'esearch', attempts: 1 },
      });
    }
    expect(starts).toEqual([0, 50]);
  });
});
