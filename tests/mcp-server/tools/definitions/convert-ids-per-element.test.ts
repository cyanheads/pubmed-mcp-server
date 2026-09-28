/**
 * @fileoverview Regression for issue #165 — `pubmed_convert_ids` answers each
 * submitted element with its own record, in submission order, carrying the
 * caller's own string as `requestedId`, for every `idType`.
 *
 * Runs the real handler and NcbiService behind a stubbed global fetch whose ID
 * Converter answers the way the live one does: a bare-digit PMCID arrives
 * PMC-prefixed (the service canonicalizes it, #73) and is echoed that way, a
 * PMCID is echoed upper-cased, a repeated identifier is answered once, DOIs
 * that differ only in case share one echo — the spelling submitted last — and a
 * miss still carries the identifier it was asked about.
 * @module tests/mcp-server/tools/definitions/convert-ids-per-element.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { textBlocks } from '../../../_helpers.js';

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

vi.stubEnv('NCBI_API_KEY', '');
vi.stubEnv('NCBI_REQUEST_DELAY_MS', '50');

const { initNcbiService } = await import('@/services/ncbi/ncbi-service.js');
const { convertIdsTool } = await import('@/mcp-server/tools/definitions/convert-ids.tool.js');

/** The one PMC article the stub knows, from the live converter's answer. */
const GENBANK = { pmid: 23193287, pmcid: 'PMC3531190', doi: '10.1093/nar/gks1195' };

/** A DOI the stub's converter drops from its answer, to model a missing record. */
const DROPPED_DOI = '10.5555/dropped';

type IdType = 'pmid' | 'pmcid' | 'doi';

/** How the live converter matches an identifier to an article. */
function matches(idType: IdType, id: string): boolean {
  switch (idType) {
    case 'pmid':
      return id === String(GENBANK.pmid);
    case 'pmcid':
      return id.toUpperCase() === GENBANK.pmcid;
    case 'doi':
      return id.toLowerCase() === GENBANK.doi;
  }
}

/** The converter's echo of one submitted identifier, given the whole request. */
function echoOf(idType: IdType, id: string, ids: string[]): string {
  if (idType === 'pmcid') return id.toUpperCase();
  if (idType === 'doi') {
    return ids.findLast((other) => other.toLowerCase() === id.toLowerCase()) ?? id;
  }
  return id;
}

function idConvert(url: URL): Response {
  const idType = url.searchParams.get('idtype') as IdType;
  const ids = (url.searchParams.get('ids') ?? '').split(',');
  const echoes = [...new Set(ids.map((id) => echoOf(idType, id, ids)))];
  const records = echoes
    .filter((echo) => echo !== DROPPED_DOI)
    .map((echo) =>
      matches(idType, echo)
        ? { ...GENBANK, 'requested-id': echo }
        : {
            ...(idType === 'pmid' ? { pmid: Number(echo) } : { [idType]: echo }),
            'requested-id': echo,
            status: 'error',
            errmsg: 'Identifier not found in PMC',
          },
    );
  return Response.json({ status: 'ok', records });
}

let fetchSpy: ReturnType<typeof vi.spyOn>;

beforeAll(() => {
  fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = new URL(String(input));
    if (url.pathname.includes('idconv')) return idConvert(url);
    throw new Error(`unexpected request ${url.href}`);
  });
  initNcbiService();
});

beforeEach(() => {
  fetchSpy.mockClear();
});

afterAll(() => {
  fetchSpy.mockRestore();
  vi.unstubAllEnvs();
});

async function convert(ids: string[], idType: IdType) {
  const ctx = createMockContext({ errors: convertIdsTool.errors });
  const result = await convertIdsTool.handler(convertIdsTool.input.parse({ ids, idType }), ctx);
  const text = textBlocks(convertIdsTool.format?.(result) ?? [])
    .map((b) => b.text)
    .join('\n');
  return { result, text };
}

/** The Requested ID column of the rendered table, top to bottom. */
const requestedColumn = (text: string) =>
  text
    .split('\n')
    .filter((line) => line.startsWith('| ') && !line.startsWith('| Requested ID'))
    .map((line) => line.split(' | ')[0]?.slice(2));

const converterRequests = (): URL[] =>
  fetchSpy.mock.calls.map((args: unknown[]) => new URL(String(args[0])));

describe('pubmed_convert_ids answers every submitted element (issue #165)', () => {
  it.each<[IdType, string[]]>([
    ['pmid', ['1', '23193287', '00000001', '23193287']],
    ['pmcid', ['3531190', 'pmc3531190', 'PMC3531190', '999']],
    ['doi', ['10.1093/nar/gks1195', '10.9999/none', '10.1093/NAR/GKS1195']],
  ])(
    'returns one %s record per element, in order, under the caller’s spelling',
    async (idType, ids) => {
      const { result, text } = await convert(ids, idType);

      expect(result.records.map((r) => r.requestedId)).toEqual(ids);
      expect(result.totalSubmitted).toBe(ids.length);
      expect(result.totalConverted).toBe(result.records.filter((r) => !r.errmsg).length);
      expect(requestedColumn(text)).toEqual(ids);
    },
  );

  it('reports a bare-digit PMCID as submitted, converted like its prefixed form', async () => {
    const { result } = await convert(['3531190'], 'pmcid');

    expect(result.records).toEqual([
      { requestedId: '3531190', pmid: '23193287', pmcid: 'PMC3531190', doi: '10.1093/nar/gks1195' },
    ]);
    expect(result.totalConverted).toBe(1);
  });

  it('gives each exact duplicate its own converted record and counts both', async () => {
    const { result, text } = await convert(['23193287', '23193287'], 'pmid');

    expect(result.records).toHaveLength(2);
    expect(result.records[0]).toEqual(result.records[1]);
    expect(result).toMatchObject({ totalConverted: 2, totalSubmitted: 2 });
    expect(text).toContain('**Converted:** 2/2');
  });

  it('keeps a padded and an unpadded PMID in submission order with one upstream lookup', async () => {
    const { result } = await convert(['23193287', '1', '0023193287'], 'pmid');

    expect(result.records.map((r) => [r.requestedId, r.pmid, r.pmcid])).toEqual([
      ['23193287', '23193287', 'PMC3531190'],
      ['1', '1', undefined],
      ['0023193287', '23193287', 'PMC3531190'],
    ]);
    expect(converterRequests().map((u) => u.searchParams.get('ids'))).toEqual(['23193287,1']);
  });

  it('keeps a DOI’s own casing when the converter echoes a different one', async () => {
    const { result } = await convert(['10.1093/nar/gks1195', '10.1093/NAR/GKS1195'], 'doi');

    expect(result.records.map((r) => r.requestedId)).toEqual([
      '10.1093/nar/gks1195',
      '10.1093/NAR/GKS1195',
    ]);
    expect(result.records.every((r) => r.pmcid === 'PMC3531190')).toBe(true);
  });

  it('reports an element the converter answered nothing for as a failed record', async () => {
    const { result } = await convert(['10.1093/nar/gks1195', DROPPED_DOI], 'doi');

    expect(result.records.map((r) => r.requestedId)).toEqual(['10.1093/nar/gks1195', DROPPED_DOI]);
    expect(result.records[1]?.errmsg).toMatch(/no record/i);
    expect(result).toMatchObject({ totalConverted: 1, totalSubmitted: 2 });
  });
});

/**
 * Last in the file: the 429 closes the shared NCBI cooldown gate, which would
 * hold any test after it.
 */
describe('pubmed_convert_ids throttled by the ID Converter', () => {
  /**
   * The ID Converter request carries no `api_key`, so the hint may only claim the
   * key raises the E-utilities ceiling. A Retry-After past the backoff cap stops
   * the loop on this one 429, which keeps the header as NCBI sent it: an HTTP date.
   */
  it('reports ncbi_rate_limited with a hint that holds for this endpoint', async () => {
    const retryAfter = new Date(Date.now() + 120_000).toUTCString();
    fetchSpy.mockImplementationOnce(() =>
      Promise.resolve(new Response('', { status: 429, headers: { 'retry-after': retryAfter } })),
    );

    const result = await runToolContract(convertIdsTool, { ids: ['23193287'], idType: 'pmid' });

    expect(result.isError).toBe(true);
    const { error } = result.structuredContent as {
      error: {
        code: number;
        data: { reason: string; retryAfter: string; recovery: { hint: string } };
      };
    };
    expect(error.code).toBe(JsonRpcErrorCode.RateLimited);
    expect(error.data).toMatchObject({ reason: 'ncbi_rate_limited', retryAfter });
    const { hint } = error.data.recovery;
    expect(hint).toContain('NCBI_API_KEY');
    expect(hint).toContain('E-utilities ceiling');
    expect(hint).toContain('HTTP date');
    expect(hint).not.toMatch(/NCBI's ceiling|number of seconds in `retryAfter`/);

    const text = textBlocks(result.content)
      .map((b) => b.text)
      .join('\n');
    expect(text).toContain(`Recovery: ${hint}`);
    expect(text).toContain('reason ncbi_rate_limited');
    expect(converterRequests()).toHaveLength(1);
  });
});
