/**
 * @fileoverview `pubmed_lookup_citation` over the real `NcbiService.eCitMatch`
 * when ECitMatch truncates its response at a journal-less miss (#193). Only the
 * transport is faked, so the re-request loop runs, and both response surfaces
 * are read from the assembled tool result.
 * @module tests/mcp-server/tools/definitions/lookup-citation-truncation.test
 */

import type { ContentBlock } from '@cyanheads/mcp-ts-core';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { createPacer } from '@cyanheads/mcp-ts-core/utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NcbiApiClient } from '@/services/ncbi/api-client.js';
import type { NcbiResponseHandler } from '@/services/ncbi/response-handler.js';

import { textBlocks } from '../../../_helpers.js';

const harness = vi.hoisted(() => ({ service: undefined as unknown }));

vi.mock('@/services/ncbi/ncbi-service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/ncbi/ncbi-service.js')>();
  return { ...actual, getNcbiService: () => harness.service };
});

vi.mock('@/services/ncbi/parsing/esummary-parser.js', () => ({
  extractBriefSummaries: async () => [
    {
      pmid: '2014248',
      authors: 'Mann BJ, Torian BE, Vedvick TS, et al.',
      authorNames: ['Mann BJ', 'Torian BE', 'Vedvick TS', 'Petri WA Jr'],
      pubDate: '1991 Apr 15',
    },
  ],
}));

const { NcbiService } = await import('@/services/ncbi/ncbi-service.js');
const { lookupCitationTool } = await import(
  '@/mcp-server/tools/definitions/lookup-citation.tool.js'
);

const PNAS = {
  journal: 'proc natl acad sci u s a',
  year: '1991',
  volume: '88',
  firstPage: '3248',
  authorName: 'mann bj',
  key: 'hit',
};
const MISS = { year: '1991', volume: '88', firstPage: '99999', key: 'miss' };

/**
 * ecitmatch.cgi as observed live: lines answered in order, stopping at the first
 * journal-less line with no candidate.
 */
function ecitmatchAnswer(bdata: string): string {
  const rows: string[] = [];
  for (const line of bdata.split('\r')) {
    const [journal = '', , , firstPage = ''] = line.split('|');
    const hit = journal === PNAS.journal && firstPage === PNAS.firstPage;
    if (!hit && journal === '') break;
    rows.push(`${line}${hit ? '2014248' : 'NOT_FOUND;INVALID_JOURNAL'}`);
  }
  return rows.join('\n');
}

const makeRequest = vi.fn(async (endpoint: string, params: { bdata?: string }) =>
  endpoint === 'ecitmatch.cgi' ? String(params.bdata) : '<eSummaryResult/>',
);
const ecitmatchRequests = () =>
  makeRequest.mock.calls.filter(([endpoint]) => endpoint === 'ecitmatch.cgi').length;

const call = (citations: unknown[]) =>
  runToolContract(lookupCitationTool, { citations } as never).then((result) => ({
    structured: result.structuredContent as {
      results: Record<string, unknown>[];
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
  harness.service = new NcbiService(
    { makeRequest } as unknown as NcbiApiClient,
    createPacer({ name: 'ncbi-test' }),
    {
      parseAndHandleResponse: (text: string, endpoint: string) =>
        endpoint === 'ecitmatch.cgi' ? ecitmatchAnswer(text) : { eSummaryResult: {} },
    } as unknown as NcbiResponseHandler,
    0,
    60_000,
  );
});

describe('pubmed_lookup_citation after a journal-less miss (#193)', () => {
  const MISS_RESULT = { key: 'miss', matched: false, status: 'not_found' };
  const HIT_RESULT = {
    key: 'hit',
    matched: true,
    status: 'matched',
    pmid: '2014248',
    matchedFirstAuthor: 'Mann BJ',
  };

  it('matches the citation after the miss, on both surfaces', async () => {
    const result = await call([MISS, PNAS]);

    expect(result.isError).toBeFalsy();
    expect(result.structured).toEqual({
      results: [MISS_RESULT, HIT_RESULT],
      totalMatched: 1,
      totalSubmitted: 2,
      totalWarnings: 0,
    });
    expect(result.text).toContain('**Matched:** 1/2');
    expect(result.text).toContain('### 1 · miss\n**Status:** No match');
    expect(result.text).toContain(
      '### 2 · hit\n**PMID:** 2014248\n**First Author:** Mann BJ\n**Status:** Matched',
    );
    expect(ecitmatchRequests()).toBe(2);
  });

  it('answers each citation the same in either order', async () => {
    const missFirst = await call([MISS, PNAS]);
    const hitFirst = await call([PNAS, MISS]);

    expect(hitFirst.structured.results).toEqual([HIT_RESULT, MISS_RESULT]);
    expect(missFirst.structured.results).toEqual([...hitFirst.structured.results].reverse());
    expect(hitFirst.text).toContain('### 1 · hit\n**PMID:** 2014248');
    expect(hitFirst.text).toContain('### 2 · miss\n**Status:** No match');
    // A miss in the last line needs no second request.
    expect(ecitmatchRequests()).toBe(3);
  });

  it('keeps every match when two misses each precede one', async () => {
    const result = await call([
      { ...MISS, key: 'miss-a' },
      { ...PNAS, key: 'hit-a' },
      { ...MISS, firstPage: '88888', key: 'miss-b' },
      { ...PNAS, key: 'hit-b' },
    ]);

    expect(result.structured.results.map((r) => [r.key, r.status, r.pmid])).toEqual([
      ['miss-a', 'not_found', undefined],
      ['hit-a', 'matched', '2014248'],
      ['miss-b', 'not_found', undefined],
      ['hit-b', 'matched', '2014248'],
    ]);
    expect(result.text).toContain('**Matched:** 2/4');
    expect(ecitmatchRequests()).toBe(3);
  });
});
