/**
 * @fileoverview Tests for the Europe PMC service.
 * @module tests/services/europe-pmc/europe-pmc-service.test
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockFetchWithTimeout = vi.fn();

vi.mock('@cyanheads/mcp-ts-core/utils', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@cyanheads/mcp-ts-core/utils');
  return {
    ...actual,
    fetchWithTimeout: mockFetchWithTimeout,
  };
});

const { EuropePmcApiClient } = await import('@/services/europe-pmc/api-client.js');
const { EuropePmcRequestQueue } = await import('@/services/europe-pmc/request-queue.js');
const { EuropePmcService } = await import('@/services/europe-pmc/europe-pmc-service.js');

function jsonResponse(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

function xmlResponse(body: string, init: ResponseInit = {}) {
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'application/xml' },
    ...init,
  });
}

/**
 * Reproduce what `fetchWithTimeout` actually does on a non-2xx: it throws a
 * status-mapped `McpError` carrying `errorSource: 'FetchHttpError'`, never
 * resolves with the failing `Response`. `expectedStatuses` only lowers the log
 * severity. Mocking a resolved 404/503 `Response` models a state the real helper
 * cannot produce, and certifies branches that never execute. (#90)
 */
function httpErrorRejection(status: number, code: JsonRpcErrorCode, body = '') {
  return new McpError(code, `Fetch failed for <upstream>. Status: ${status}`, {
    status,
    statusText: '',
    body,
    statusCode: status,
    responseBody: body,
    errorSource: 'FetchHttpError',
  });
}

function makeService(opts: { maxRetries?: number; minStartGapMs?: number } = {}) {
  const client = new EuropePmcApiClient({ timeoutMs: 20000 });
  const queue = new EuropePmcRequestQueue(opts.minStartGapMs ?? 0);
  return new EuropePmcService(client, queue, opts.maxRetries ?? 0);
}

describe('EuropePmcService.search', () => {
  beforeEach(() => {
    mockFetchWithTimeout.mockReset();
  });

  it('parses a normal search response and exposes cursor pagination', async () => {
    mockFetchWithTimeout.mockResolvedValue(
      jsonResponse({
        hitCount: 42,
        nextCursorMark: 'NEXT_CURSOR',
        request: { cursorMark: '*', queryString: 'foo AND (SRC:"MED")' },
        resultList: {
          result: [
            {
              id: '1',
              source: 'MED',
              pmid: '1',
              title: 'A paper',
              doi: '10.1/x',
              isOpenAccess: 'Y',
              inEPMC: 'Y',
              abstractText: 'Abstract',
              firstPublicationDate: '2025-01-02',
            },
          ],
        },
      }),
    );

    const service = makeService();
    const result = await service.search({
      query: 'foo',
      sources: ['MED'],
      pageSize: 25,
      cursorMark: '*',
    });

    expect(result.hits).toHaveLength(1);
    expect(result.hits[0]?.source).toBe('MED');
    expect(result.hitCount).toBe(42);
    expect(result.nextCursorMark).toBe('NEXT_CURSOR');
    expect(result.cursorMark).toBe('*');
  });

  it('normalizes a single-hit response (scalar `result`, not array)', async () => {
    mockFetchWithTimeout.mockResolvedValue(
      jsonResponse({
        hitCount: 1,
        request: { cursorMark: '*' },
        resultList: { result: { id: 'PPR1', source: 'PPR', doi: '10.21203/x' } },
      }),
    );

    const service = makeService();
    const result = await service.search({ query: 'preprint', sources: ['PPR'] });

    expect(result.hits).toHaveLength(1);
    expect(result.hits[0]?.id).toBe('PPR1');
  });

  it('omits `nextCursorMark` when EPMC echoes the same cursor (final page sentinel)', async () => {
    mockFetchWithTimeout.mockResolvedValue(
      jsonResponse({
        hitCount: 1,
        nextCursorMark: 'CURSOR_X',
        request: { cursorMark: 'CURSOR_X' },
        resultList: { result: [{ id: '7', source: 'PMC' }] },
      }),
    );

    const service = makeService();
    const result = await service.search({ query: 'foo', cursorMark: 'CURSOR_X' });
    expect(result.nextCursorMark).toBeUndefined();
  });

  it('builds query with source filter when sources are provided', async () => {
    mockFetchWithTimeout.mockResolvedValue(jsonResponse({ hitCount: 0 }));

    const service = makeService();
    await service.search({ query: 'cancer', sources: ['MED', 'PMC', 'PPR'] });

    const url = mockFetchWithTimeout.mock.calls[0]?.[0] as string;
    const decoded = decodeURIComponent(url);
    expect(decoded).toContain('(cancer)');
    expect(decoded).toContain('SRC:"MED"');
    expect(decoded).toContain('SRC:"PMC"');
    expect(decoded).toContain('SRC:"PPR"');
  });

  it('sends an unfiltered query when sources is omitted', async () => {
    mockFetchWithTimeout.mockResolvedValue(jsonResponse({ hitCount: 0 }));
    const service = makeService();
    await service.search({ query: 'cancer' });
    const url = mockFetchWithTimeout.mock.calls[0]?.[0] as string;
    const decoded = decodeURIComponent(url);
    expect(decoded).not.toContain('SRC:');
  });

  it('URL-encodes a DOI query so slashes survive', async () => {
    mockFetchWithTimeout.mockResolvedValue(jsonResponse({ hitCount: 0 }));
    const service = makeService();
    await service.search({ query: 'DOI:"10.21203/rs.3.rs-9010375/v1"' });
    const url = mockFetchWithTimeout.mock.calls[0]?.[0] as string;
    expect(url).toContain('10.21203%2Frs.3.rs-9010375%2Fv1');
  });

  it('throws SerializationError on non-JSON body', async () => {
    mockFetchWithTimeout.mockResolvedValue(new Response('<html>not json</html>', { status: 200 }));
    const service = makeService();
    await expect(service.search({ query: 'foo' })).rejects.toMatchObject({
      data: { reason: 'europepmc_invalid_response' },
    });
  });

  it('splits diagnosis (message) from recovery hint on invalid sort — not byte-identical (#75)', async () => {
    // EPMC returns a {version}-only envelope when sort is invalid — no hitCount,
    // no request echo, no resultList. Without detection this falls through to
    // hitCount: 0 and the caller thinks the query had no matches.
    mockFetchWithTimeout.mockResolvedValue(jsonResponse({ version: '6.10' }));
    const service = makeService();
    const err = (await service
      .search({ query: 'cancer', sort: 'FIRST_PIDATE desc' })
      .catch((e: unknown) => e)) as {
      message: string;
      data: { reason: string; sort: string; recovery: { hint: string } };
    };

    expect(err.data.reason).toBe('europepmc_invalid_input');
    expect(err.data.sort).toBe('FIRST_PIDATE desc');
    // Message carries the diagnosis (names the bad field); hint carries the next step.
    expect(err.message).toContain('FIRST_PIDATE desc');
    expect(err.data.recovery.hint).toContain('documented sort');
    // The bug (#75): message and recovery hint were the same string, rendering
    // identical Error:/Recovery: blocks. They must differ now.
    expect(err.data.recovery.hint).not.toBe(err.message);
  });

  it('splits diagnosis from recovery hint on the no-sort empty envelope (#75)', async () => {
    mockFetchWithTimeout.mockResolvedValue(jsonResponse({ version: '6.10' }));
    const service = makeService();
    const err = (await service
      .search({ query: 'cancer', cursorMark: 'BAD_CURSOR' })
      .catch((e: unknown) => e)) as {
      message: string;
      data: { reason: string; cursorMark: string; recovery: { hint: string } };
    };

    expect(err.data.reason).toBe('europepmc_invalid_input');
    expect(err.data.cursorMark).toBe('BAD_CURSOR');
    expect(err.message).toContain('silently rejected');
    expect(err.data.recovery.hint).toContain('cursorMark');
    expect(err.data.recovery.hint).not.toBe(err.message);
  });

  it('surfaces EPMC `errMsg` (e.g. empty query) instead of falling through to 0 hits', async () => {
    mockFetchWithTimeout.mockResolvedValue(
      jsonResponse({
        errCode: 400,
        errMsg:
          'No search criteria provided. Please provide a search criteria which is less than 1500 characters.',
      }),
    );
    const service = makeService();
    await expect(service.search({ query: '' })).rejects.toMatchObject({
      data: {
        reason: 'europepmc_invalid_input',
        epmcErrCode: 400,
        epmcErrMsg: expect.stringContaining('No search criteria'),
        recovery: { hint: expect.stringContaining('No search criteria') },
      },
    });
  });

  it('treats a legitimate 0-hit response as success (not silent rejection)', async () => {
    mockFetchWithTimeout.mockResolvedValue(
      jsonResponse({
        hitCount: 0,
        request: { queryString: 'foo', cursorMark: '*' },
        resultList: { result: [] },
      }),
    );
    const service = makeService();
    const result = await service.search({ query: 'foo' });
    expect(result.hitCount).toBe(0);
    expect(result.hits).toEqual([]);
  });

  it('passes a sort param through to EPMC in the URL', async () => {
    mockFetchWithTimeout.mockResolvedValue(
      jsonResponse({
        hitCount: 1,
        request: { queryString: 'cancer', cursorMark: '*', sort: 'CITED desc' },
        resultList: { result: [{ id: '1', source: 'MED' }] },
      }),
    );
    const service = makeService();
    await service.search({ query: 'cancer', sort: 'CITED desc' });
    const url = mockFetchWithTimeout.mock.calls[0]?.[0] as string;
    expect(url).toContain('sort=CITED+desc');
  });

  it('throws ServiceUnavailable on 5xx', async () => {
    mockFetchWithTimeout.mockRejectedValue(
      httpErrorRejection(503, JsonRpcErrorCode.ServiceUnavailable, 'down'),
    );
    const service = makeService();
    await expect(service.search({ query: 'foo' })).rejects.toThrow(/503/);
  });

  it('throws ServiceUnavailable with europepmc_unreachable on network failure', async () => {
    mockFetchWithTimeout.mockRejectedValue(new Error('connect ETIMEDOUT'));
    const service = makeService();
    await expect(service.search({ query: 'foo' })).rejects.toMatchObject({
      data: {
        reason: 'europepmc_unreachable',
        recovery: { hint: expect.stringContaining('Europe PMC was unreachable') },
      },
    });
  });
});

describe('EuropePmcService.fetchRecords', () => {
  beforeEach(() => {
    mockFetchWithTimeout.mockReset();
  });

  /** Query as it reaches the wire, URL-decoded out of the request URL. */
  const sentQuery = () =>
    new URL(String(mockFetchWithTimeout.mock.calls[0]?.[0])).searchParams.get('query');

  it('OR-joins one unquoted EXT_ID/SRC clause per ref into a single request', async () => {
    mockFetchWithTimeout.mockResolvedValue(
      jsonResponse({
        hitCount: 2,
        resultList: {
          result: [
            { id: 'KR20120031038', source: 'PAT', abstractText: 'long patent abstract' },
            { id: 'IND609436151', source: 'AGR' },
          ],
        },
      }),
    );
    const service = makeService();
    const hits = await service.fetchRecords([
      { source: 'PAT', epmcId: 'KR20120031038' },
      { source: 'AGR', epmcId: 'IND609436151' },
    ]);

    expect(mockFetchWithTimeout).toHaveBeenCalledTimes(1);
    // Quoting the identifier or the SRC value makes Europe PMC match nothing.
    expect(sentQuery()).toBe(
      '(EXT_ID:KR20120031038 AND SRC:PAT) OR (EXT_ID:IND609436151 AND SRC:AGR)',
    );
    expect(hits.map((h) => h.id)).toEqual(['KR20120031038', 'IND609436151']);
    expect(hits[0]?.abstractText).toBe('long patent abstract');
  });

  it('requests core results sized to the batch and adds no source filter clause', async () => {
    mockFetchWithTimeout.mockResolvedValue(
      jsonResponse({ hitCount: 0, resultList: { result: [] } }),
    );
    const service = makeService();
    await service.fetchRecords([{ source: 'PPR', epmcId: 'PPR1283828' }]);

    const url = new URL(String(mockFetchWithTimeout.mock.calls[0]?.[0]));
    expect(url.searchParams.get('resultType')).toBe('core');
    expect(url.searchParams.get('pageSize')).toBe('1');
    expect(sentQuery()).toBe('(EXT_ID:PPR1283828 AND SRC:PPR)');
  });

  it('ORs a bare PMCID clause into a PMC ref so a PubMed-indexed article resolves (#94)', async () => {
    // EPMC's PMC corpus holds only articles it has no PubMed record for. Once an
    // article is indexed in PubMed its canonical record moves to MED and carries
    // the PMCID as a field, so `EXT_ID:PMC8371605 AND SRC:PMC` matches nothing.
    mockFetchWithTimeout.mockResolvedValue(
      jsonResponse({
        hitCount: 1,
        resultList: { result: [{ id: '34265844', source: 'MED', pmcid: 'PMC8371605' }] },
      }),
    );
    const service = makeService();
    const hits = await service.fetchRecords([{ source: 'PMC', epmcId: 'PMC8371605' }]);

    expect(sentQuery()).toBe('(EXT_ID:PMC8371605 AND SRC:PMC) OR (PMCID:PMC8371605)');
    expect(hits[0]?.source).toBe('MED');
    expect(hits[0]?.pmcid).toBe('PMC8371605');
  });

  it('keeps serving PMC-only records through the same OR-ed clause (#94)', async () => {
    mockFetchWithTimeout.mockResolvedValue(
      jsonResponse({
        hitCount: 1,
        resultList: { result: [{ id: 'PMC13294766', source: 'PMC' }] },
      }),
    );
    const service = makeService();
    const hits = await service.fetchRecords([{ source: 'PMC', epmcId: 'PMC13294766' }]);
    expect(hits[0]?.id).toBe('PMC13294766');
    expect(hits[0]?.source).toBe('PMC');
  });

  it('adds the PMCID clause only for PMC refs, mixing sources in one query (#94)', async () => {
    mockFetchWithTimeout.mockResolvedValue(
      jsonResponse({ hitCount: 0, resultList: { result: [] } }),
    );
    const service = makeService();
    await service.fetchRecords([
      { source: 'MED', epmcId: '36449413' },
      { source: 'PMC', epmcId: 'PMC8371605' },
      { source: 'PPR', epmcId: 'PPR1283828' },
    ]);

    expect(sentQuery()).toBe(
      '(EXT_ID:36449413 AND SRC:MED) OR (EXT_ID:PMC8371605 AND SRC:PMC) OR (PMCID:PMC8371605) OR (EXT_ID:PPR1283828 AND SRC:PPR)',
    );
  });

  it('returns only what Europe PMC resolved, leaving misses to the caller', async () => {
    mockFetchWithTimeout.mockResolvedValue(
      jsonResponse({ hitCount: 1, resultList: { result: { id: 'PPR1283828', source: 'PPR' } } }),
    );
    const service = makeService();
    const hits = await service.fetchRecords([
      { source: 'PPR', epmcId: 'PPR1283828' },
      { source: 'AGR', epmcId: 'IND000000000' },
    ]);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.id).toBe('PPR1283828');
  });
});

describe('EuropePmcService.fullTextXml', () => {
  beforeEach(() => {
    mockFetchWithTimeout.mockReset();
  });

  it('returns `found` with raw XML on 200', async () => {
    mockFetchWithTimeout.mockResolvedValue(
      xmlResponse('<?xml version="1.0"?><article><body>hi</body></article>'),
    );
    const service = makeService();
    const result = await service.fullTextXml('PPR1', 'PPR');
    expect(result).toEqual({
      kind: 'found',
      xml: '<?xml version="1.0"?><article><body>hi</body></article>',
      epmcId: 'PPR1',
      source: 'PPR',
    });
  });

  it('returns `not-available` for 404', async () => {
    mockFetchWithTimeout.mockRejectedValue(
      httpErrorRejection(404, JsonRpcErrorCode.NotFound, 'nope'),
    );
    const service = makeService();
    const result = await service.fullTextXml('PPR404', 'PPR');
    expect(result.kind).toBe('not-available');
  });

  it('returns `not-available` for an empty 200 body (issue safety net)', async () => {
    mockFetchWithTimeout.mockResolvedValue(xmlResponse('   '));
    const service = makeService();
    const result = await service.fullTextXml('EMPTY1', 'PMC');
    expect(result.kind).toBe('not-available');
  });

  it('throws ServiceUnavailable on 5xx', async () => {
    mockFetchWithTimeout.mockRejectedValue(
      httpErrorRejection(503, JsonRpcErrorCode.ServiceUnavailable, 'down'),
    );
    const service = makeService();
    await expect(service.fullTextXml('X', 'PMC')).rejects.toThrow(/503/);
  });

  it('throws NotFound onward for a 404 on a non-fullTextXML endpoint', async () => {
    // The 404 → `not-available` conversion is scoped to fullTextXml; a 404 from
    // any other Europe PMC endpoint keeps propagating. (#90)
    mockFetchWithTimeout.mockRejectedValue(
      httpErrorRejection(404, JsonRpcErrorCode.NotFound, 'nope'),
    );
    const service = makeService();
    await expect(service.search({ query: 'foo' })).rejects.toThrow(/404/);
  });

  it('uses the single-id URL pattern, not source/id', async () => {
    mockFetchWithTimeout.mockResolvedValue(xmlResponse('<article/>'));
    const service = makeService();
    await service.fullTextXml('PPR123', 'PPR');
    const url = mockFetchWithTimeout.mock.calls[0]?.[0] as string;
    expect(url).toMatch(/\/PPR123\/fullTextXML$/);
    expect(url).not.toContain('/PPR/PPR123/');
  });
});

describe('EuropePmcService.parseFullTextXml', () => {
  it('parses well-formed JATS into an article JatsNode', () => {
    const service = makeService();
    const xml = `<?xml version="1.0"?>
<article article-type="research-article">
  <front><article-meta><title-group><article-title>Hi</article-title></title-group></article-meta></front>
  <body><sec><title>Intro</title><p>Body</p></sec></body>
</article>`;
    const node = service.parseFullTextXml(xml);
    expect(node).toBeDefined();
    expect(node && 'article' in node).toBe(true);
  });

  it('returns undefined when the body has no <article>', () => {
    const service = makeService();
    const xml = `<?xml version="1.0"?><wrapper><note>nothing here</note></wrapper>`;
    const node = service.parseFullTextXml(xml);
    expect(node).toBeUndefined();
  });

  it('throws SerializationError on malformed XML', () => {
    const service = makeService();
    expect(() => service.parseFullTextXml('<article><body>')).toThrowError(
      /invalid XML from Europe PMC/i,
    );
  });
});

describe('EuropePmcService.citations', () => {
  beforeEach(() => {
    mockFetchWithTimeout.mockReset();
  });

  it('extracts PMIDs from a citations response (MED id is the PMID)', async () => {
    // Live EPMC shape: records carry `id` + `source`, NOT a `pmid` field; for a
    // MED-source record the `id` IS the PubMed ID. A PPR (preprint) is dropped.
    mockFetchWithTimeout.mockResolvedValue(
      jsonResponse({
        hitCount: 3,
        citationList: {
          citation: [
            { id: '10001', source: 'MED', citationType: 'journal article', title: 'Citing A' },
            { id: '10002', source: 'MED', title: 'Citing B' },
            { id: 'PPR123', source: 'PPR', title: 'Preprint, no PubMed PMID' },
          ],
        },
      }),
    );

    const service = makeService();
    const result = await service.citations('31295471', 10, 1);

    expect(result.pmids).toEqual(['10001', '10002']);
    expect(result.totalCount).toBe(3);
  });

  it('drops records with no PMID (non-MED sources)', async () => {
    mockFetchWithTimeout.mockResolvedValue(
      jsonResponse({
        hitCount: 2,
        citationList: {
          citation: [
            { id: 'PAT1', source: 'PAT' },
            { id: 'AGR1', source: 'AGR' },
          ],
        },
      }),
    );
    const service = makeService();
    const result = await service.citations('12345', 10, 1);
    expect(result.pmids).toEqual([]);
    expect(result.totalCount).toBe(2);
  });

  it('returns empty result for sparse/empty payload', async () => {
    mockFetchWithTimeout.mockResolvedValue(
      jsonResponse({ hitCount: 0, citationList: { citation: [] } }),
    );
    const service = makeService();
    const result = await service.citations('12345', 10, 1);
    expect(result.pmids).toEqual([]);
    expect(result.totalCount).toBe(0);
  });

  it('handles missing citationList gracefully', async () => {
    mockFetchWithTimeout.mockResolvedValue(jsonResponse({ hitCount: 0 }));
    const service = makeService();
    const result = await service.citations('12345', 10, 1);
    expect(result.pmids).toEqual([]);
  });

  it('throws SerializationError on non-JSON response', async () => {
    mockFetchWithTimeout.mockResolvedValue(new Response('<html>error</html>', { status: 200 }));
    const service = makeService();
    await expect(service.citations('12345', 10, 1)).rejects.toMatchObject({
      data: { reason: 'europepmc_invalid_response' },
    });
  });

  it('throws ServiceUnavailable on 5xx', async () => {
    mockFetchWithTimeout.mockRejectedValue(
      httpErrorRejection(503, JsonRpcErrorCode.ServiceUnavailable, 'down'),
    );
    const service = makeService();
    await expect(service.citations('12345', 10, 1)).rejects.toThrow(/503/);
  });
});

describe('EuropePmcService.references', () => {
  beforeEach(() => {
    mockFetchWithTimeout.mockReset();
  });

  it('extracts PMIDs from a references response (MED id is the PMID)', async () => {
    // Live EPMC shape: `id` + `source`, no `pmid` field; MED `id` is the PubMed ID.
    mockFetchWithTimeout.mockResolvedValue(
      jsonResponse({
        hitCount: 2,
        referenceList: {
          reference: [
            { id: '20001', source: 'MED', citationType: 'JOURNAL ARTICLE', title: 'Ref A' },
            { id: '20002', source: 'MED', title: 'Ref B' },
          ],
        },
      }),
    );

    const service = makeService();
    const result = await service.references('31295471', 10, 1);

    expect(result.pmids).toEqual(['20001', '20002']);
    expect(result.totalCount).toBe(2);
  });

  it('drops references without a PubMed PMID (non-MED sources)', async () => {
    mockFetchWithTimeout.mockResolvedValue(
      jsonResponse({
        hitCount: 3,
        referenceList: {
          reference: [
            { id: '30001', source: 'MED' },
            { id: 'PAT1', source: 'PAT' /* no PubMed PMID */ },
            { id: '30003', source: 'MED' },
          ],
        },
      }),
    );
    const service = makeService();
    const result = await service.references('12345', 10, 1);
    expect(result.pmids).toEqual(['30001', '30003']);
    expect(result.totalCount).toBe(3);
  });

  it('handles sparse/empty payload', async () => {
    mockFetchWithTimeout.mockResolvedValue(jsonResponse({}));
    const service = makeService();
    const result = await service.references('12345', 10, 1);
    expect(result.pmids).toEqual([]);
    expect(result.totalCount).toBe(0);
  });

  it('uses the correct /MED/{pmid}/references URL', async () => {
    mockFetchWithTimeout.mockResolvedValue(jsonResponse({ hitCount: 0, referenceList: {} }));
    const service = makeService();
    await service.references('31295471', 10, 1);
    const url = mockFetchWithTimeout.mock.calls[0]?.[0] as string;
    expect(url).toContain('/MED/31295471/references');
    expect(url).toContain('pageSize=10');
    expect(url).toContain('page=1');
    expect(url).toContain('format=json');
  });
});

describe('initEuropePmcService / getEuropePmcService', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('leaves the service unset when EUROPEPMC_ENABLED=false', async () => {
    vi.stubEnv('EUROPEPMC_ENABLED', 'false');

    const mod = await import('@/services/europe-pmc/europe-pmc-service.js');
    mod.initEuropePmcService();
    expect(mod.getEuropePmcService()).toBeUndefined();
  });

  it('constructs the service when EUROPEPMC_ENABLED=true (default)', async () => {
    delete process.env.EUROPEPMC_ENABLED;

    const mod = await import('@/services/europe-pmc/europe-pmc-service.js');
    mod.initEuropePmcService();
    expect(mod.getEuropePmcService()).toBeInstanceOf(mod.EuropePmcService);
  });

  it('leaves the service unset when EUROPEPMC_ENABLED=0', async () => {
    vi.stubEnv('EUROPEPMC_ENABLED', '0');

    const mod = await import('@/services/europe-pmc/europe-pmc-service.js');
    mod.initEuropePmcService();
    expect(mod.getEuropePmcService()).toBeUndefined();
  });
});
