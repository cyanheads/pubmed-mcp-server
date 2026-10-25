/**
 * @fileoverview Tests for `pubmed_fetch_citation_metrics`. Calls run through
 * `runToolContract` against the real iCite service and client, with only the
 * global `fetch` stubbed (iCite host only) and retries off, so request
 * splitting, PMID normalization, the never-sent cases, request-order restore,
 * notices, and both response surfaces are exercised together.
 * @module tests/mcp-server/tools/definitions/fetch-citation-metrics.tool.test
 */

import type { ContentBlock } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { readCommonMark, textBlocks } from '../../../_helpers.js';
import {
  fetchedUrl,
  jsonResponse,
  pubsFrom,
  SAMPLE_ROWS,
  sampleRow,
  stubIciteFetch,
} from '../../../services/icite/_icite-fixtures.js';

vi.mock('@/services/icite/icite-service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/icite/icite-service.js')>();
  const { IciteApiClient } = await import('@/services/icite/api-client.js');
  // The real service with retries off, so a failure surfaces on its first attempt.
  const service = new actual.IciteService(new IciteApiClient(), 20_000, 0);
  return { ...actual, getIciteService: () => service };
});

const { fetchCitationMetricsTool } = await import(
  '@/mcp-server/tools/definitions/fetch-citation-metrics.tool.js'
);

type Structured = {
  records: { pmid: string; title?: string; rcrProvisional?: boolean }[];
  unavailablePmids?: string[];
  overLimit?: { limit: number; pmids: string[] };
  notice?: string;
};

async function call(pmids: string[]) {
  const result = await runToolContract(fetchCitationMetricsTool, { pmids });
  const text = textBlocks(result.content as ContentBlock[])
    .map((b) => b.text)
    .join('\n');
  return { result, structured: result.structuredContent as Structured, text };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('input schema', () => {
  const parse = (pmids: unknown) => fetchCitationMetricsTool.input.safeParse({ pmids }).success;

  it('accepts 1 to 1,000 PMIDs and rejects an empty or longer list', () => {
    expect(parse(['1'])).toBe(true);
    expect(parse(Array.from({ length: 1000 }, (_, i) => String(i + 1)))).toBe(true);
    expect(parse([])).toBe(false);
    expect(parse(Array.from({ length: 1001 }, (_, i) => String(i + 1)))).toBe(false);
  });

  it('rejects a PMID that is not digits', () => {
    expect(parse(['PMID:23456789'])).toBe(false);
    expect(parse(['23456789,1'])).toBe(false);
  });
});

describe('description', () => {
  it('states the RCR benchmark and points to pubmed_fetch_articles for retractions', () => {
    const { description } = fetchCitationMetricsTool;
    expect(description).toContain(
      'RCR is a field- and year-normalized citation rate benchmarked to NIH-funded papers, whose median RCR is 1.0',
    );
    expect(description).toContain(
      'iCite does not flag retractions — a retracted article keeps its metrics — so check pubmed_fetch_articles for retraction notices',
    );
  });
});

describe('batch fetch', () => {
  it('returns records in request order whatever order iCite answers in, and lists misses', async () => {
    const fetchMock = stubIciteFetch();
    const { result, structured, text } = await call(['9500320', '1', '99999999', '23456789']);

    expect(result.isError).toBeFalsy();
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchedUrl(fetchMock).searchParams.get('pmids')).toBe('9500320,1,99999999,23456789');
    expect(structured.records.map((r) => r.pmid)).toEqual(['9500320', '1', '23456789']);
    expect(structured.unavailablePmids).toEqual(['99999999']);
    const lines = text.split('\n');
    expect(lines.filter((line) => line.startsWith('### '))).toEqual([
      '### PMID 9500320',
      '### PMID 1',
      '### PMID 23456789',
    ]);
    expect(lines.slice(2, 4)).toEqual(['**Records:** 3', '**Unavailable PMIDs:** 99999999']);
  });

  it('opens content[] with the NIH iCite source credit as a live link', async () => {
    stubIciteFetch();
    const { text } = await call(['23456789']);
    expect(readCommonMark(text.split('\n').slice(0, 3).join('\n'))).toBe(
      '⟨heading_open⟩\n\nNIH iCite Citation Metrics\n\n⟨heading_close⟩\n\nSource: ⟨a⟩NIH iCite⟨/a⟩\n⟨strong⟩Records:⟨/strong⟩ 1',
    );
    expect(text).toContain('Source: [NIH iCite](https://icite.od.nih.gov/)');
  });

  it('fetches the first 200 distinct PMIDs in one request and returns the rest in overLimit', async () => {
    const fetchMock = stubIciteFetch(() => jsonResponse({ data: [] }));
    const distinct = Array.from({ length: 201 }, (_, i) => String(30_000_000 + i));
    // Duplicates and a zero-padded spelling of a fetched PMID take no slot.
    const pmids = [...distinct.slice(0, 5), '30000000', '030000001', ...distinct.slice(5)];
    const { result, structured, text } = await call(pmids);

    expect(result.isError).toBeFalsy();
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchedUrl(fetchMock).searchParams.get('pmids')?.split(',')).toEqual(
      distinct.slice(0, 200),
    );
    expect(structured.overLimit).toEqual({ limit: 200, pmids: ['30000200'] });
    expect(structured.unavailablePmids).toHaveLength(200);
    expect(structured.notice).toMatch(
      /^NIH iCite has no record for any of the first 200 distinct requested PMIDs: 30000000, /,
    );
    expect(structured.notice).toContain(
      'This call fetched the first 200 distinct PMIDs; 1 more was not fetched: 30000200. Re-call pubmed_fetch_citation_metrics with those PMIDs, at most 200 per call, to retrieve them.',
    );
    expect(text).toContain(structured.notice);
    expect(text).toContain(
      '**Over the per-call limit:** 1 PMID(s) not fetched — a call fetches the first 200 distinct PMIDs\nRe-call `pubmed_fetch_citation_metrics` with these PMIDs: 30000200',
    );
  });

  it('counts misses against the first 200 and the over-limit remainder in the plural', async () => {
    stubIciteFetch();
    const distinct = Array.from({ length: 202 }, (_, i) => String(30_000_000 + i));
    const { structured, text } = await call(['23456789', ...distinct]);

    expect(structured.records.map((r) => r.pmid)).toEqual(['23456789']);
    expect(structured.notice).toMatch(
      /^NIH iCite has no record for 199 of the first 200 distinct requested PMIDs: 30000000, /,
    );
    expect(structured.notice).toContain(
      'This call fetched the first 200 distinct PMIDs; 3 more were not fetched: 30000199, 30000200, 30000201. ',
    );
    expect(text).toContain(structured.notice);
  });

  it('omits overLimit when the call names exactly 200 distinct PMIDs', async () => {
    stubIciteFetch(() => jsonResponse({ data: [] }));
    const { structured } = await call(
      Array.from({ length: 200 }, (_, i) => String(30_000_000 + i)),
    );
    expect(structured).not.toHaveProperty('overLimit');
  });

  it('reads a zero-padded PMID as the canonical one and returns one record', async () => {
    const fetchMock = stubIciteFetch();
    const { structured } = await call(['00023456789', '23456789']);

    expect(fetchedUrl(fetchMock).searchParams.get('pmids')).toBe('23456789');
    expect(structured.records.map((r) => r.pmid)).toEqual(['23456789']);
    expect(structured).not.toHaveProperty('unavailablePmids');
  });

  it.each([[['0']], [['0000']], [['1000000001']]])(
    'never sends %j, which iCite cannot read as a PMID, and reports it unavailable',
    async (pmids) => {
      const fetchMock = stubIciteFetch();
      const { result, structured } = await call(pmids);

      expect(result.isError).toBeFalsy();
      expect(fetchMock).not.toHaveBeenCalled();
      expect(structured.records).toEqual([]);
      expect(structured.unavailablePmids).toEqual(pmids);
      expect(structured.notice).toMatch(
        new RegExp(`^NIH iCite has no record for any of the requested PMIDs: ${pmids[0]}\\. `),
      );
    },
  );

  it('sends only the readable PMIDs of a mixed batch', async () => {
    const fetchMock = stubIciteFetch();
    const { structured } = await call(['1000000001', '23456789', '0']);

    expect(fetchedUrl(fetchMock).searchParams.get('pmids')).toBe('23456789');
    expect(structured.records.map((r) => r.pmid)).toEqual(['23456789']);
    expect(structured.unavailablePmids).toEqual(['1000000001', '0']);
    expect(structured.notice).toMatch(
      /^NIH iCite has no record for 2 of 3 distinct requested PMIDs: 1000000001, 0\. /,
    );
  });

  // `0` and values over 1e9 are never sent to iCite, so a notice that called
  // them fetched misstated the call. Both surfaces carry the same notice.
  it.each([
    [['99999999', '0'], 'NIH iCite has no record for any of the requested PMIDs: 99999999, 0. '],
    [
      ['31535829', '00031535829', '99999999', '1000000001', '42504015'],
      'NIH iCite has no record for 2 of 4 distinct requested PMIDs: 99999999, 1000000001. ',
    ],
  ])('names never-sent PMIDs among the requested ones: %j', async (pmids, opening) => {
    // iCite knows 31535829 and 42504015; the fixture row is reused under each.
    const known = new Map(
      [31535829, 42504015].map((pmid) => [String(pmid), { ...sampleRow('23456789'), pmid }]),
    );
    stubIciteFetch(pubsFrom(known));
    const { structured, text } = await call(pmids);

    expect(structured.notice?.startsWith(opening)).toBe(true);
    expect(structured.notice).not.toContain('fetched PMIDs');
    expect(text).toContain(structured.notice);
  });

  it('answers an unknown PMID with an empty result and a notice on both surfaces', async () => {
    stubIciteFetch();
    const { result, structured, text } = await call(['99999999']);

    expect(result.isError).toBeFalsy();
    expect(structured.records).toEqual([]);
    expect(structured.unavailablePmids).toEqual(['99999999']);
    const notice =
      'NIH iCite has no record for any of the requested PMIDs: 99999999. iCite omits a PMID it has no record for without an error, so this does not say whether PubMed has the article; pubmed_fetch_articles confirms that.';
    expect(structured.notice).toBe(notice);
    expect(text).toContain(notice);
  });
});

describe('notice', () => {
  it('names unscored, no-RCR, and provisional records in one notice', async () => {
    stubIciteFetch();
    const { structured } = await call(['42791233', '14907713', '38538943', '23456789']);

    expect(structured.notice).toBe(
      'Not yet scored by iCite — no citation count or RCR: 42791233. No RCR: 14907713 — iCite computes none for papers too recent to benchmark and for some older records. Provisional RCR: 38538943 — recent papers whose RCR can change as citations accrue.',
    );
  });

  it('carries no notice when every record is final and complete', async () => {
    stubIciteFetch();
    const { result, structured } = await call(['23456789', '9500320']);
    expect(structured).not.toHaveProperty('notice');
    // content[] is format()'s block alone: no notice block follows it.
    expect(result.content).toEqual(fetchCitationMetricsTool.format!(structured as never));
  });
});

describe('format()', () => {
  const format = (result: Parameters<NonNullable<typeof fetchCitationMetricsTool.format>>[0]) =>
    textBlocks(fetchCitationMetricsTool.format!(result))[0]?.text ?? '';

  it('renders every field of a record, Not available where iCite has none', async () => {
    stubIciteFetch();
    const { structured } = await call(['14907713']);

    expect(format({ records: structured.records } as never)).toBe(
      [
        '## NIH iCite Citation Metrics',
        'Source: [NIH iCite](https://icite.od.nih.gov/)',
        '**Records:** 1',
        '',
        '### PMID 14907713',
        '**Title:** Protein measurement with the Folin phenol reagent.',
        '**Year:** 1951 | **Journal:** J Biol Chem | **DOI:** Not available',
        '**Research article:** Yes | **Clinical:** No',
        '**Relative Citation Ratio:** Not available | **NIH percentile:** Not available',
        '**Citations:** 289010 | **Citations per year:** 3853.4666666666667 | **Expected citations per year:** Not available | **Field citation rate:** 3.356447854153346',
        '**APT:** 0.25 | **Human:** 0 | **Animal:** 0 | **Molecular/cellular:** 0',
        '**Cited by a clinical article:** Yes | **Clinical citations:** 1045',
      ].join('\n'),
    );
    expect(structured.records[0]).not.toHaveProperty('rcrProvisional');
  });

  it('renders the RCR with its provisional flag', async () => {
    stubIciteFetch();
    const { text } = await call(['38538943', '23456789']);
    expect(text).toContain(
      '**Relative Citation Ratio:** 1.0247186630955916 | **RCR provisional:** Yes | **NIH percentile:** 51.2',
    );
    expect(text).toContain(
      '**Relative Citation Ratio:** 1.972190464032035 | **RCR provisional:** No | **NIH percentile:** 73',
    );
  });

  it('renders an unscored record with Not available for every metric', async () => {
    stubIciteFetch();
    const { text } = await call(['42791233']);
    expect(text).toContain(
      '**Citations:** Not available | **Citations per year:** Not available | **Expected citations per year:** Not available | **Field citation rate:** Not available',
    );
    expect(text).toContain(
      '**Cited by a clinical article:** Not available | **Clinical citations:** Not available',
    );
  });
});

describe('titles', () => {
  it('strips markup from an iCite title on both surfaces', async () => {
    stubIciteFetch();
    const { structured, text } = await call(['41304192']);
    const title =
      'Microbiological Investigation and Clinical Efficacy of Professional Topical Fluoride Application on Streptococcus mutans and Selemonas sputigena in Orthodontic Patients: A Randomized Controlled Clinical Trial.';

    expect(sampleRow('41304192').title).toContain('<i>Streptococcus mutans</i>');
    expect(structured.records[0]?.title).toBe(title);
    expect(text).toContain(`**Title:** ${title}`);
  });

  it('renders a title holding Markdown syntax as the text itself', async () => {
    const title = 'Use *this* [link](https://x.test) <b>not</b> `code` here';
    stubIciteFetch(pubsFrom(new Map([['23456789', { ...sampleRow('23456789'), title }]])));
    const { structured, text } = await call(['23456789']);
    const plain = 'Use *this* [link](https://x.test) not `code` here';

    expect(structured.records[0]?.title).toBe(plain);
    const titleLine = text.split('\n').find((line) => line.startsWith('**Title:**')) ?? '';
    expect(readCommonMark(titleLine)).toBe(`⟨strong⟩Title:⟨/strong⟩ ${plain}`);
  });

  it('strips an entity-encoded line break from a title (#262)', async () => {
    const title = 'A clinically relevant&lt;br /&gt;tool for screening';
    stubIciteFetch(pubsFrom(new Map([['23456789', { ...sampleRow('23456789'), title }]])));
    const { structured } = await call(['23456789']);
    expect(structured.records[0]?.title).toBe('A clinically relevant tool for screening');
  });

  it('renders every character of title, journal, and DOI, which share one paragraph (#261)', async () => {
    const row = {
      ...sampleRow('23456789'),
      title: 'HLA-B*57:01 carriers',
      journal: 'J Allergy*',
      doi: '10.1/_x',
    };
    stubIciteFetch(pubsFrom(new Map([['23456789', row]])));
    const { structured, text } = await call(['23456789']);

    expect(structured.records[0]).toMatchObject({
      title: 'HLA-B*57:01 carriers',
      journal: 'J Allergy*',
      doi: '10.1/_x',
    });
    const block = text.slice(text.indexOf('### PMID 23456789'));
    const [, record] = readCommonMark(block).split('\n\n⟨heading_close⟩\n\n');
    expect(record?.split('\n').slice(0, 2)).toEqual([
      '⟨strong⟩Title:⟨/strong⟩ HLA-B*57:01 carriers',
      `⟨strong⟩Year:⟨/strong⟩ ${String(sampleRow('23456789').year)} | ⟨strong⟩Journal:⟨/strong⟩ J Allergy* | ⟨strong⟩DOI:⟨/strong⟩ 10.1/_x`,
    ]);
  });
});

describe('errors', () => {
  it('surfaces an unreachable iCite as icite_unreachable with the contract recovery', async () => {
    stubIciteFetch(() => new Response('down', { status: 503 }));
    const { result, text } = await call(['23456789']);

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.ServiceUnavailable,
        data: {
          reason: 'icite_unreachable',
          recovery: {
            hint: 'Retry after a brief delay; NIH iCite was unreachable. The other pubmed_* tools do not depend on it.',
          },
        },
      },
    });
    expect(text).toContain('Recovery: Retry after a brief delay; NIH iCite was unreachable.');
  });

  it('fails as icite_invalid_response when iCite answers with a PMID the call did not send', async () => {
    stubIciteFetch(() => jsonResponse({ data: [sampleRow('1')] }));
    const { result } = await call(['23456789']);

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: { data: { reason: 'icite_invalid_response' } },
    });
  });
});

it('fixture covers every PMID these cases name', () => {
  for (const pmid of ['1', '9500320', '14907713', '23456789', '38538943', '41304192', '42791233']) {
    expect(SAMPLE_ROWS.has(pmid), pmid).toBe(true);
  }
});
