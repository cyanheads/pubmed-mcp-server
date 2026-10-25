/**
 * @fileoverview Tests for the NIH iCite service and its HTTP client: the
 * request shape (one GET, the pinned `fl` list, the URL bound), record
 * normalization over captured rows, the unrequested-record guard, and the retry
 * ladder — status mapping, reason stamping, and the total deadline. `fetch` is
 * stubbed at the global, so `fetchWithTimeout`'s real status mapping and
 * `withRetry`'s real backoff run under every case.
 * @module tests/services/icite/icite-service.test
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { IciteApiClient } from '@/services/icite/api-client.js';
import { IciteService } from '@/services/icite/icite-service.js';
import { ICITE_DEADLINE_MS } from '@/services/icite/types.js';

import {
  fetchedUrl,
  hangingUntilAborted,
  jsonResponse,
  pubsFrom,
  SAMPLE_ROWS,
  sampleRow,
  stubIciteFetch,
} from './_icite-fixtures.js';

const TIMEOUT_MS = 20_000;

function makeService(maxRetries = 0): IciteService {
  return new IciteService(new IciteApiClient(), TIMEOUT_MS, maxRetries);
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('request shape', () => {
  it('sends one GET to /api/pubs with the PMIDs in order and the pinned fl list', async () => {
    const fetchMock = stubIciteFetch();
    await makeService().fetchRecords(['9500320', '1', '23456789'], createMockContext());

    expect(fetchMock).toHaveBeenCalledOnce();
    const url = fetchedUrl(fetchMock);
    expect(`${url.origin}${url.pathname}`).toBe('https://icite.od.nih.gov/api/pubs');
    expect(url.searchParams.get('pmids')).toBe('9500320,1,23456789');
    expect(url.searchParams.get('fl')).toBe(
      'pmid,title,year,journal,doi,is_research_article,is_clinical,provisional,citation_count,citations_per_year,expected_citations_per_year,field_citation_rate,relative_citation_ratio,nih_percentile,apt,human,animal,molecular_cellular,citedByClinicalArticle,cited_by_clin',
    );
    expect([...url.searchParams.keys()]).toEqual(['pmids', 'fl']);
    expect(fetchMock.mock.calls[0]?.[1]?.method ?? 'GET').toBe('GET');
  });

  it.each([
    ['200 eight-digit PMIDs', Array.from({ length: 200 }, (_, i) => String(23_456_789 + i))],
    [
      '200 PMIDs at the largest value sent',
      Array.from({ length: 200 }, (_, i) => String(1_000_000_000 - i)),
    ],
  ])('keeps the request URL for %s under 4,000 characters', async (_label, pmids) => {
    const fetchMock = stubIciteFetch(() => jsonResponse({ data: [] }));
    await makeService().fetchRecords(pmids, createMockContext());

    expect(fetchMock).toHaveBeenCalledOnce();
    const sent = String(fetchMock.mock.calls[0]?.[0]);
    expect(sent.length).toBeLessThan(4_000);
    expect(new URL(sent).searchParams.get('pmids')?.split(',')).toEqual(pmids);
  });
});

describe('record normalization', () => {
  async function fetchOne(pmid: string) {
    stubIciteFetch();
    const [record] = await makeService().fetchRecords([pmid], createMockContext());
    return record;
  }

  it('maps a fully scored row to every field, counting cited_by_clin', async () => {
    expect(await fetchOne('23456789')).toEqual({
      pmid: '23456789',
      title:
        'Hospital volume is associated with survival but not multimodality therapy in Medicare patients with advanced head and neck cancer.',
      year: 2013,
      journal: 'Cancer',
      doi: '10.1002/cncr.27976',
      isResearchArticle: true,
      isClinical: false,
      relativeCitationRatio: 1.972190464032035,
      rcrProvisional: false,
      nihPercentile: 73,
      citationCount: 53,
      citationsPerYear: 4.076923076923077,
      expectedCitationsPerYear: 2.0672055520378247,
      fieldCitationRate: 5.24475244958888,
      apt: 0.75,
      human: 1,
      animal: 0,
      molecularCellular: 0,
      citedByClinicalArticle: true,
      clinicalCitationCount: 3,
    });
  });

  it('leaves a null RCR, percentile, expected rate, and DOI absent, with no provisional flag', async () => {
    const record = await fetchOne('14907713');
    expect(record).toEqual({
      pmid: '14907713',
      title: 'Protein measurement with the Folin phenol reagent.',
      year: 1951,
      journal: 'J Biol Chem',
      isResearchArticle: true,
      isClinical: false,
      citationCount: 289010,
      citationsPerYear: 3853.4666666666667,
      fieldCitationRate: 3.356447854153346,
      apt: 0.25,
      human: 0,
      animal: 0,
      molecularCellular: 0,
      citedByClinicalArticle: true,
      clinicalCitationCount: 1045,
    });
  });

  it.each([
    ['38538943', { relativeCitationRatio: 1.0247186630955916, rcrProvisional: true }],
    ['40140593', { relativeCitationRatio: 1.250743984792145, rcrProvisional: true }],
  ])('keeps provisional: true beside the RCR of %s', async (pmid, expected) => {
    expect(await fetchOne(pmid)).toMatchObject(expected);
  });

  it('drops provisional: false when iCite reports no RCR', async () => {
    const record = await fetchOne('40140594');
    expect(sampleRow('40140594')).toMatchObject({
      provisional: false,
      relative_citation_ratio: null,
    });
    expect(record).not.toHaveProperty('relativeCitationRatio');
    expect(record).not.toHaveProperty('rcrProvisional');
    expect(record).not.toHaveProperty('nihPercentile');
    expect(record).toMatchObject({ citationCount: 0, clinicalCitationCount: 0 });
  });

  it('reads a null cited_by_clin beside citedByClinicalArticle: false as zero clinical citations', async () => {
    expect(sampleRow('1')).toMatchObject({ citedByClinicalArticle: false, cited_by_clin: null });
    expect(await fetchOne('1')).toMatchObject({
      citedByClinicalArticle: false,
      clinicalCitationCount: 0,
      relativeCitationRatio: 3.0710986551182264,
    });
  });

  it('returns an unscored row with its identity and content fields only', async () => {
    expect(await fetchOne('42791233')).toEqual({
      pmid: '42791233',
      title:
        'Comprehensive Metabolic Profiling of Brucea javanica Oil Oral Emulsion in Rat Serum by Ultrahigh Performance Liquid Chromatography Time-of-Flight Mass Spectrometry and Its Correlation With Anti-Glioblastoma Activity.',
      year: 2026,
      journal: 'Biomed Chromatogr',
      doi: '10.1002/bmc.70628',
      isResearchArticle: true,
      isClinical: false,
      human: 0.14285714285714285,
      animal: 0.5714285714285714,
      molecularCellular: 0.2857142857142857,
    });
  });

  it('keeps the title as iCite serves it, markup included, for the tool to render', async () => {
    expect((await fetchOne('41304192'))?.title).toBe(sampleRow('41304192').title);
  });

  it('leaves the clinical count unknown when the flag is set but the list is null, and drops mistyped values', async () => {
    const rows = new Map([
      [
        '23456789',
        {
          ...sampleRow('23456789'),
          cited_by_clin: null,
          relative_citation_ratio: '1.97',
          year: null,
          title: '   ',
        },
      ],
    ]);
    stubIciteFetch(pubsFrom(rows));
    const [record] = await makeService().fetchRecords(['23456789'], createMockContext());

    expect(record).toMatchObject({ citedByClinicalArticle: true, citationCount: 53 });
    for (const key of [
      'clinicalCitationCount',
      'relativeCitationRatio',
      'rcrProvisional',
      'year',
      'title',
    ]) {
      expect(record).not.toHaveProperty(key);
    }
  });

  it('returns records in the order iCite sends them', async () => {
    stubIciteFetch();
    const records = await makeService().fetchRecords(
      ['9500320', '1', '23456789'],
      createMockContext(),
    );
    expect(records.map((r) => r.pmid)).toEqual(['1', '23456789', '9500320']);
  });
});

describe('unrequested-record guard', () => {
  it('fails as icite_invalid_response, without retrying, when iCite answers with a PMID not sent', async () => {
    // iCite's answer to a list holding no PMID it accepts: its first records from PMID 1.
    const fetchMock = stubIciteFetch(() => jsonResponse({ data: [sampleRow('1')] }));
    const error = await makeService(3)
      .fetchRecords(['23456789'], createMockContext())
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(McpError);
    expect(error).toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      data: { reason: 'icite_invalid_response', unrequestedPmid: '1' },
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('fails the same way on a record whose PMID is not a PMID', async () => {
    stubIciteFetch(() => jsonResponse({ data: [{ pmid: 0 }] }));
    await expect(
      makeService().fetchRecords(['23456789'], createMockContext()),
    ).rejects.toMatchObject({ data: { reason: 'icite_invalid_response' } });
  });
});

describe('failures and retries', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** Run a call to completion under the fake clock and return what it threw. */
  async function settle(call: Promise<unknown>): Promise<unknown> {
    const outcome = call.then(
      () => {
        throw new Error('expected the call to fail');
      },
      (error: unknown) => error,
    );
    await vi.runAllTimersAsync();
    return outcome;
  }

  it.each([
    ['a non-JSON body', () => new Response('<html>Bad gateway</html>', { status: 200 })],
    ['JSON without a data list', () => jsonResponse({ message: 'maintenance' })],
  ])('retries %s, then fails as icite_invalid_response', async (_label, reply) => {
    const fetchMock = stubIciteFetch(reply);
    const error = await settle(makeService(2).fetchRecords(['23456789'], createMockContext()));

    expect(error).toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      data: { reason: 'icite_invalid_response', retryAttempts: 3 },
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('reports HTTP 5xx on every attempt as icite_unreachable', async () => {
    const fetchMock = stubIciteFetch(() => new Response('upstream down', { status: 503 }));
    const error = await settle(makeService(2).fetchRecords(['23456789'], createMockContext()));

    expect(error).toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      data: { reason: 'icite_unreachable', retryAttempts: 3, status: 503 },
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('reports a network failure on every attempt as icite_unreachable', async () => {
    stubIciteFetch(() => Promise.reject(new TypeError('fetch failed')));
    const error = await settle(makeService(1).fetchRecords(['23456789'], createMockContext()));

    expect(error).toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      data: { reason: 'icite_unreachable', retryAttempts: 2 },
    });
  });

  it('recovers when a retry succeeds', async () => {
    let attempt = 0;
    const fetchMock = stubIciteFetch((url) =>
      ++attempt === 1 ? new Response('busy', { status: 502 }) : pubsFrom()(url),
    );
    const call = makeService(2).fetchRecords(['23456789'], createMockContext());
    await vi.runAllTimersAsync();

    await expect(call).resolves.toEqual([expect.objectContaining({ pmid: '23456789' })]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('keeps RateLimited and the Retry-After value on a 429, with no reason stamped', async () => {
    stubIciteFetch(
      () => new Response('slow down', { status: 429, headers: { 'retry-after': '2' } }),
    );
    const error = await settle(makeService(1).fetchRecords(['23456789'], createMockContext()));

    expect(error).toMatchObject({
      code: JsonRpcErrorCode.RateLimited,
      data: { retryAfter: '2', retryAttempts: 2 },
    });
    expect((error as McpError).data?.reason).toBeUndefined();
  });

  it('settles a stalled upstream within the total deadline as a Timeout', async () => {
    const fetchMock = stubIciteFetch(hangingUntilAborted);
    const start = Date.now();
    const error = await settle(makeService(3).fetchRecords(['23456789'], createMockContext()));

    expect(error).toMatchObject({
      code: JsonRpcErrorCode.Timeout,
      data: { reason: 'retry_deadline_exceeded', deadlineMs: ICITE_DEADLINE_MS },
    });
    expect(Date.now() - start).toBeLessThanOrEqual(ICITE_DEADLINE_MS);
    // 20 s + 20 s per-attempt timeouts with backoff between leave the third
    // attempt only what remains of the deadline; there is no fourth.
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("passes a caller's cancellation through without stamping a reason or retrying", async () => {
    const controller = new AbortController();
    const fetchMock = stubIciteFetch(hangingUntilAborted);
    const call = makeService(3)
      .fetchRecords(['23456789'], createMockContext({ signal: controller.signal }))
      .catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(100);
    controller.abort();
    const error = await call;

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(error).toMatchObject({ code: JsonRpcErrorCode.RequestCancelled });
    expect((error as McpError).data?.reason).toBeUndefined();
  });
});

it('fixture holds the ten captured rows the suites use', () => {
  expect([...SAMPLE_ROWS.keys()].sort()).toEqual(
    [
      '1',
      '14907713',
      '23456789',
      '35355019',
      '38538943',
      '40140593',
      '40140594',
      '41304192',
      '42791233',
      '9500320',
    ].sort(),
  );
});
