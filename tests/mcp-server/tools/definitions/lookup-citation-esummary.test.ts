/**
 * @fileoverview `pubmed_lookup_citation`'s match verification against real
 * ESummary bodies (#199, #201). Only the transport is faked: the real
 * `NcbiService`, `NcbiResponseHandler` and ESummary parser run, and the fake
 * endpoint answers in the format the request names — version 2.0 when it asks
 * for `version=2.0`, the version 1 DocSum otherwise — so a request for the wrong
 * format reaches the tool's output. Both response surfaces are read from the
 * assembled tool result.
 * @module tests/mcp-server/tools/definitions/lookup-citation-esummary.test
 */

import type { ContentBlock } from '@cyanheads/mcp-ts-core';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { createPacer } from '@cyanheads/mcp-ts-core/utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NcbiApiClient } from '@/services/ncbi/api-client.js';
import { NcbiResponseHandler } from '@/services/ncbi/response-handler.js';

import { textBlocks } from '../../../_helpers.js';
import {
  VERSION_PAIR_ESUMMARY_V1_XML,
  VERSION_PAIR_ESUMMARY_V2_XML,
} from '../../../services/ncbi/parsing/_book-fixtures.js';

const harness = vi.hoisted(() => ({ service: undefined as unknown }));

vi.mock('@/services/ncbi/ncbi-service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/ncbi/ncbi-service.js')>();
  return { ...actual, getNcbiService: () => harness.service };
});

const { NcbiService } = await import('@/services/ncbi/ncbi-service.js');
const { lookupCitationTool } = await import(
  '@/mcp-server/tools/definitions/lookup-citation.tool.js'
);

/**
 * ECitMatch answers, keyed by `journal|year|volume|firstPage`. The 2026 Health
 * Technol Assess row and the Nature row are what ecitmatch.cgi returned live
 * for these fields; the other rows stand in for a match so the verification of
 * that record is pinned. Live ECitMatch answered `NOT_FOUND;INVALID_JOURNAL` to
 * every Bookshelf line tried (`genereviews|1993`, `genereviews|2018`, the NICE
 * book's title), and `NOT_FOUND` to the 2025 Health Technol Assess line.
 */
const ECITMATCH_PMIDS: Record<string, string> = {
  'health technol assess|2026|30|1': '42474064',
  'health technol assess|2025|30|1': '42474064',
  'nature|2015|526|68': '26432245',
  'genereviews|1993||': '20301340',
  'genereviews|2018||': '20301340',
  'nice technology appraisal guidance|2024||': '40825089',
  'withdrawn j|2001|1|1': '99999999',
};

/** How version 2.0 answers a UID it holds no record for, verbatim from a live response. */
const UNKNOWN_UID_V2_RECORD =
  '<DocumentSummary uid = "99999999"><error>cannot get document summary</error></DocumentSummary>';

/** ecitmatch.cgi: one row per submitted line, the line echoed with its outcome appended. */
function ecitmatchAnswer(bdata: string): string {
  return bdata
    .split('\r')
    .map((line) => {
      const [journal = '', year = '', volume = '', firstPage = ''] = line.split('|');
      const pmid = ECITMATCH_PMIDS[`${journal.toLowerCase()}|${year}|${volume}|${firstPage}`];
      return `${line}${pmid ?? 'NOT_FOUND;INVALID_JOURNAL'}`;
    })
    .join('\n');
}

const V2_RECORD = /<DocumentSummary uid = "(\d+)">[\s\S]*?<\/DocumentSummary>/g;
const V1_RECORD = /<DocSum><Id>(\d+)<\/Id>[\s\S]*?<\/DocSum>/g;

/**
 * esummary.fcgi: the requested PMIDs, in request order, in the format the
 * request names. In version 2.0, 99999999 answers with the error record
 * ESummary returns for a UID it cannot summarize; any other PMID the fixtures do
 * not hold is left out.
 */
function esummaryAnswer(params: { id?: string; version?: string }): string {
  const v2 = params.version === '2.0';
  const xml = v2 ? VERSION_PAIR_ESUMMARY_V2_XML : VERSION_PAIR_ESUMMARY_V1_XML;
  const records = new Map(
    [...xml.matchAll(v2 ? V2_RECORD : V1_RECORD)].map((m) => [m[1] as string, m[0]]),
  );
  if (v2) records.set('99999999', UNKNOWN_UID_V2_RECORD);
  const head = xml.slice(0, xml.search(v2 ? /<DocumentSummary uid/ : /<DocSum>/));
  const body = (params.id ?? '')
    .split(',')
    .map((id) => records.get(id) ?? '')
    .join('');
  return `${head}${body}${v2 ? '</DocumentSummarySet></eSummaryResult>' : '</eSummaryResult>'}`;
}

const makeRequest = vi.fn(async (endpoint: string, params: Record<string, string>) => {
  if (endpoint === 'ecitmatch.cgi') return ecitmatchAnswer(String(params.bdata));
  if (endpoint === 'esummary') return esummaryAnswer(params);
  throw new Error(`unmocked request: ${endpoint}`);
});

const esummaryRequests = () =>
  makeRequest.mock.calls.filter(([endpoint]) => endpoint === 'esummary').map(([, p]) => p);

type LookupResult = {
  key: string;
  pmid?: string;
  matched: boolean;
  status: string;
  matchedFirstAuthor?: string;
  warnings?: { code: string; message: string }[];
};

const call = (citations: unknown[]) =>
  runToolContract(lookupCitationTool, { citations } as never).then((result) => ({
    structured: result.structuredContent as {
      results: LookupResult[];
      totalMatched: number;
      totalSubmitted: number;
      totalWarnings: number;
    },
    text: textBlocks(result.content as ContentBlock[])
      .map((b) => b.text)
      .join('\n'),
    isError: result.isError,
  }));

beforeEach(() => {
  makeRequest.mockClear();
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('unmocked fetch')));
  harness.service = new NcbiService(
    { makeRequest } as unknown as NcbiApiClient,
    createPacer({ name: 'ncbi-test' }),
    new NcbiResponseHandler(),
    0,
    60_000,
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const CHAPTER = { journal: 'GeneReviews', authorName: 'bird td', key: 'chapter' };
const KGP = {
  journal: 'Nature',
  year: '2015',
  volume: '526',
  firstPage: '68',
  key: 'kgp',
};
const HTA = { journal: 'Health Technol Assess', volume: '30', firstPage: '1' };

describe('pubmed_lookup_citation reads ESummary 2.0', () => {
  it('asks once for every matched PMID in the 2.0 XML format', async () => {
    await call([
      { ...HTA, year: '2026', key: 'a' },
      { ...KGP, authorName: 'auton a' },
      { ...HTA, year: '2026', key: 'b' },
      { journal: 'Unknown J', year: '2000', key: 'miss' },
    ]);

    expect(esummaryRequests()).toEqual([
      { db: 'pubmed', version: '2.0', retmode: 'xml', id: '42474064,26432245' },
    ]);
  });

  it('leaves a PMID ESummary cannot summarize unverified without failing its batch-mates', async () => {
    const result = await call([
      { journal: 'Withdrawn J', year: '2001', volume: '1', firstPage: '1', authorName: 'x y' },
      { ...KGP, authorName: 'auton a' },
    ]);

    expect(result.isError).toBeFalsy();
    expect(result.structured.results).toEqual([
      { key: '1', matched: true, status: 'matched', pmid: '99999999' },
      {
        key: 'kgp',
        matched: true,
        status: 'matched',
        pmid: '26432245',
        matchedFirstAuthor: '1000 Genomes Project Consortium',
      },
    ]);
    expect(result.text).toContain(
      '### 1 · 1\n**PMID:** 99999999\n**Status:** Matched\n**Next Step:** PMID is ready',
    );
    expect(result.text).not.toContain('cannot get document summary');
  });

  it('asks ESummary nothing when no citation matched', async () => {
    const result = await call([{ journal: 'Unknown J', year: '2000', authorName: 'smith j' }]);

    expect(result.structured.totalMatched).toBe(0);
    expect(esummaryRequests()).toEqual([]);
  });
});

/**
 * The controls below are pinned to the output the tool produced while it asked
 * for the version 1 format, captured against these same fixtures and compared
 * as serialized JSON and text, so a changed value or key order fails.
 */
describe('records with no consortium author and no chapter date are unchanged', () => {
  it('a journal match: verified author, author mismatch, year mismatch', async () => {
    const result = await call([
      { ...HTA, year: '2026', authorName: 'lall r', key: 'verified' },
      { ...HTA, year: '2026', authorName: 'nobody x', key: 'author-off' },
      { ...HTA, year: '2025', authorName: 'smyth ma', key: 'year-off' },
    ]);
    const authorMessage =
      'Queried author "nobody x" not found in the matched article\'s 13-author roster (Smyth MA, Noordali H, Lall R, et al.). ECitMatch weights journal+volume+page and may return a PMID whose authors disagree with the query — verify before using this PMID.';
    const yearMessage =
      'Queried year "2025" does not match matched article year "2026" (pubDate 2026-07-01). ECitMatch tolerates year disagreement — verify before using this PMID.';
    const matched = { pmid: '42474064', matched: true, status: 'matched' };

    expect(JSON.stringify(result.structured)).toBe(
      JSON.stringify({
        results: [
          { key: 'verified', ...matched, matchedFirstAuthor: 'Smyth MA' },
          {
            key: 'author-off',
            ...matched,
            matchedFirstAuthor: 'Smyth MA',
            warnings: [{ code: 'author_mismatch', message: authorMessage }],
          },
          {
            key: 'year-off',
            ...matched,
            matchedFirstAuthor: 'Smyth MA',
            warnings: [{ code: 'year_mismatch', message: yearMessage }],
          },
        ],
        totalMatched: 3,
        totalSubmitted: 3,
        totalWarnings: 2,
      }),
    );
    expect(result.text).toBe(
      [
        '## Citation Lookup Results',
        '**Matched:** 3/3',
        '**Warnings:** 2',
        '',
        '### 1 · verified',
        '**PMID:** 42474064',
        '**First Author:** Smyth MA',
        '**Status:** Matched',
        '**Next Step:** PMID is ready for downstream PubMed fetch or citation tools.',
        '',
        '### 2 · author-off',
        '**PMID:** 42474064',
        '**First Author:** Smyth MA',
        '**Warnings:**',
        `- [author_mismatch] ${authorMessage}`,
        '**Status:** Matched',
        '**Next Step:** author_mismatch detected — confirm this PMID is the intended article before citing. ECitMatch weights journal+volume+page and can resolve despite author/year disagreement.',
        '',
        '### 3 · year-off',
        '**PMID:** 42474064',
        '**First Author:** Smyth MA',
        '**Warnings:**',
        `- [year_mismatch] ${yearMessage}`,
        '**Status:** Matched',
        '**Next Step:** year_mismatch detected — confirm this PMID is the intended article before citing. ECitMatch weights journal+volume+page and can resolve despite author/year disagreement.',
      ].join('\n'),
    );
  });

  it('a whole-book match: no contributors, dated by its PubDate', async () => {
    const result = await call([
      {
        journal: 'NICE technology appraisal guidance',
        year: '2024',
        authorName: 'smith j',
        key: 'book',
      },
    ]);
    const yearMessage =
      'Queried year "2024" does not match matched article year "2025" (pubDate 2025-07-02). ECitMatch tolerates year disagreement — verify before using this PMID.';

    expect(JSON.stringify(result.structured)).toBe(
      JSON.stringify({
        results: [
          {
            key: 'book',
            pmid: '40825089',
            matched: true,
            status: 'matched',
            warnings: [{ code: 'year_mismatch', message: yearMessage }],
          },
        ],
        totalMatched: 1,
        totalSubmitted: 1,
        totalWarnings: 1,
      }),
    );
    expect(result.text).toBe(
      [
        '## Citation Lookup Results',
        '**Matched:** 1/1',
        '**Warnings:** 1',
        '',
        '### 1 · book',
        '**PMID:** 40825089',
        '**Warnings:**',
        `- [year_mismatch] ${yearMessage}`,
        '**Status:** Matched',
        '**Next Step:** year_mismatch detected — confirm this PMID is the intended article before citing. ECitMatch weights journal+volume+page and can resolve despite author/year disagreement.',
      ].join('\n'),
    );
  });
});

describe('a matched Bookshelf chapter is year-checked against its own date (#199)', () => {
  it('flags a query dated by the book against the chapter revision, on both surfaces', async () => {
    const result = await call([{ ...CHAPTER, year: '1993' }]);
    const message =
      'Queried year "1993" does not match matched article year "2018" (pubDate 2018-12-20). ECitMatch tolerates year disagreement — verify before using this PMID.';

    expect(result.isError).toBeFalsy();
    expect(result.structured).toEqual({
      results: [
        {
          key: 'chapter',
          matched: true,
          status: 'matched',
          pmid: '20301340',
          matchedFirstAuthor: 'Bird TD',
          warnings: [{ code: 'year_mismatch', message }],
        },
      ],
      totalMatched: 1,
      totalSubmitted: 1,
      totalWarnings: 1,
    });
    expect(result.text).toContain(`**Warnings:**\n- [year_mismatch] ${message}`);
    expect(result.text).toContain('**Next Step:** year_mismatch detected');
  });

  it('accepts a query dated by the chapter revision, on both surfaces', async () => {
    const result = await call([{ ...CHAPTER, year: '2018' }]);

    expect(result.structured.results).toEqual([
      {
        key: 'chapter',
        matched: true,
        status: 'matched',
        pmid: '20301340',
        matchedFirstAuthor: 'Bird TD',
      },
    ]);
    expect(result.structured.totalWarnings).toBe(0);
    expect(result.text).not.toContain('year_mismatch');
    expect(result.text).toContain(
      '**First Author:** Bird TD\n**Status:** Matched\n**Next Step:** PMID is ready',
    );
  });
});

describe('a consortium author is on the verification roster (#201)', () => {
  it('names the consortium first author and verifies a query naming it, on both surfaces', async () => {
    const result = await call([{ ...KGP, authorName: '1000 Genomes Project Consortium' }]);

    expect(result.structured.results).toEqual([
      {
        key: 'kgp',
        matched: true,
        status: 'matched',
        pmid: '26432245',
        matchedFirstAuthor: '1000 Genomes Project Consortium',
      },
    ]);
    expect(result.structured.totalWarnings).toBe(0);
    expect(result.text).toContain(
      '### 1 · kgp\n**PMID:** 26432245\n**First Author:** 1000 Genomes Project Consortium\n**Status:** Matched',
    );
    expect(result.text).not.toContain('author_mismatch');
  });

  it('reports the consortium in the roster of a mismatch, on both surfaces', async () => {
    const result = await call([{ ...KGP, authorName: 'nobody x' }]);
    const message =
      'Queried author "nobody x" not found in the matched article\'s 11-author roster (1000 Genomes Project Consortium, Auton A, Brooks LD, et al.). ECitMatch weights journal+volume+page and may return a PMID whose authors disagree with the query — verify before using this PMID.';

    expect(result.structured.results[0]?.warnings).toEqual([{ code: 'author_mismatch', message }]);
    expect(result.text).toContain(`- [author_mismatch] ${message}`);
  });

  it('still verifies a named person on the same roster', async () => {
    const result = await call([{ ...KGP, authorName: 'abecasis gr' }]);

    expect(result.structured.results[0]?.warnings).toBeUndefined();
    expect(result.structured.results[0]?.matchedFirstAuthor).toBe(
      '1000 Genomes Project Consortium',
    );
  });
});
