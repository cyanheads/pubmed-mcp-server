/**
 * @fileoverview Tests for the search-articles tool.
 * @module tests/mcp-server/tools/definitions/search-articles.tool.test
 */

import type { ContentBlock } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { toJSONSchema } from 'zod/v4/core';

import { NcbiResponseHandler } from '@/services/ncbi/response-handler.js';
import type { ParsedBriefSummary } from '@/services/ncbi/types.js';

import { bunMarkdown, readCommonMark, renderedText, textBlocks } from '../../../_helpers.js';
import {
  BOOK_ESUMMARY_XML,
  CHAPTER_DATES_ESUMMARY_XML,
  parseESummaryXml,
} from '../../../services/ncbi/parsing/_book-fixtures.js';
import {
  APOS_TITLE_ESUMMARY_XML,
  FIELD_AND_PHRASE_ESEARCH_XML,
  QUOTED_PHRASE_AMP_ESEARCH_XML,
} from '../../../services/ncbi/parsing/_entity-fixtures.js';

const mockESearch = vi.fn();
const mockESummary = vi.fn();
const mockExtractBriefSummaries = vi.fn((): Promise<ParsedBriefSummary[]> => Promise.resolve([]));
vi.mock('@/services/ncbi/ncbi-service.js', () => ({
  getNcbiService: () => ({ eSearch: mockESearch, eSummary: mockESummary }),
}));
vi.mock('@/services/ncbi/parsing/esummary-parser.js', () => ({
  extractBriefSummaries: mockExtractBriefSummaries,
}));

const { extractBriefSummaries: realExtractBriefSummaries } = await vi.importActual<
  typeof import('@/services/ncbi/parsing/esummary-parser.js')
>('@/services/ncbi/parsing/esummary-parser.js');

const { searchArticlesTool, withoutFormattingTags } = await import(
  '@/mcp-server/tools/definitions/search-articles.tool.js'
);

/** Every text block of a contract run, joined — the header, the rows, and the trailer. */
const contractText = (result: Awaited<ReturnType<typeof runToolContract>>) =>
  textBlocks(result.content as ContentBlock[])
    .map((b) => b.text)
    .join('\n');

/**
 * An ESearch body as the NCBI service hands it to the tool: parsed by the
 * production response handler, so its single entity decode has run, with each
 * diagnostic member a string array.
 */
function eSearchResultOf(xml: string) {
  const { eSearchResult } = new NcbiResponseHandler().parseAndHandleResponse<{
    eSearchResult: Record<string, unknown>;
  }>(xml, 'esearch', { retmode: 'xml' });
  const list = (value: unknown) =>
    value === undefined
      ? undefined
      : Object.fromEntries(
          Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
            key,
            (Array.isArray(entry) ? entry : [entry]).map(String),
          ]),
        );
  const errorList = list(eSearchResult.ErrorList);
  const warningList = list(eSearchResult.WarningList);
  return {
    count: Number(eSearchResult.Count),
    retmax: Number(eSearchResult.RetMax),
    retstart: Number(eSearchResult.RetStart),
    idList: [],
    queryTranslation: eSearchResult.QueryTranslation,
    ...(errorList && { errorList }),
    ...(warningList && { warningList }),
  };
}

describe('searchArticlesTool', () => {
  beforeEach(() => {
    mockESearch.mockReset();
    mockESummary.mockReset();
    mockExtractBriefSummaries.mockReset();
    mockExtractBriefSummaries.mockResolvedValue([]);
  });

  it('validates input with defaults', () => {
    const input = searchArticlesTool.input.parse({ query: 'cancer' });
    expect(input.query).toBe('cancer');
    expect(input.maxResults).toBe(20);
    expect(input.offset).toBe(0);
    expect(input.sort).toBe('relevance');
    expect(input.summaryCount).toBe(0);
  });

  describe('offset ceiling (issue #95)', () => {
    it('accepts an offset at PubMed’s retstart ceiling', () => {
      const result = searchArticlesTool.input.safeParse({ query: 'cancer', offset: 9998 });
      expect(result.success).toBe(true);
    });

    it('rejects an offset above the ceiling before it reaches NCBI', () => {
      const result = searchArticlesTool.input.safeParse({ query: 'cancer', offset: 9999 });
      expect(result.success).toBe(false);
    });

    it('documents the ceiling in the offset description', () => {
      expect(searchArticlesTool.input.shape.offset.description).toContain('9998');
    });
  });

  describe('dateRange handling', () => {
    it('accepts dateRange with empty strings (MCP Inspector payload)', () => {
      const result = searchArticlesTool.input.safeParse({
        query: 'cancer',
        dateRange: { minDate: '', maxDate: '' },
      });
      expect(result.success).toBe(true);
    });

    it.each([
      ['2024', '2024'],
      ['2024/01', '2024/12'],
      ['2024/01/15', '2024/12/31'],
      ['2024-01-15', '2024-12-31'],
      ['2024.01.15', '2024.12.31'],
    ])('accepts valid date formats: %s → %s', (minDate, maxDate) => {
      const result = searchArticlesTool.input.safeParse({
        query: 'cancer',
        dateRange: { minDate, maxDate },
      });
      expect(result.success).toBe(true);
    });

    it.each([
      ['not-a-date', '2024/12/31'],
      ['2024', 'also-invalid'],
      ['24', '2024'],
      ['2024/13/45abc', '2024/12/31'],
    ])('rejects invalid date formats: %s / %s', (minDate, maxDate) => {
      const result = searchArticlesTool.input.safeParse({
        query: 'cancer',
        dateRange: { minDate, maxDate },
      });
      expect(result.success).toBe(false);
    });

    it('accepts omitted dateRange', () => {
      const result = searchArticlesTool.input.safeParse({ query: 'cancer' });
      expect(result.success).toBe(true);
      expect(result.data?.dateRange).toBeUndefined();
    });

    it('skips date clause when dateRange has empty strings', async () => {
      mockESearch.mockResolvedValue({
        count: 5580000,
        idList: ['111'],
        retmax: 20,
        retstart: 0,
        queryTranslation: 'cancer[All Fields]',
      });

      const ctx = createMockContext({ errors: searchArticlesTool.errors });
      const input = searchArticlesTool.input.parse({
        query: 'cancer',
        dateRange: { minDate: '', maxDate: '' },
      });
      await searchArticlesTool.handler(input, ctx);

      const calledTerm = mockESearch.mock.calls.at(-1)?.[0]?.term as string;
      expect(calledTerm).not.toContain('[pdat]');
    });

    it('skips date clause when only minDate is empty', async () => {
      mockESearch.mockResolvedValue({
        count: 5580000,
        idList: ['111'],
        retmax: 20,
        retstart: 0,
        queryTranslation: 'cancer[All Fields]',
      });

      const ctx = createMockContext({ errors: searchArticlesTool.errors });
      const input = searchArticlesTool.input.parse({
        query: 'cancer',
        dateRange: { minDate: '', maxDate: '2024/01/01' },
      });
      await searchArticlesTool.handler(input, ctx);

      const calledTerm = mockESearch.mock.calls.at(-1)?.[0]?.term as string;
      expect(calledTerm).not.toContain('[pdat]');
    });

    describe('partial dateRange notice (issue #97)', () => {
      beforeEach(() => {
        mockESearch.mockResolvedValue({
          count: 69489,
          idList: ['111'],
          retmax: 20,
          retstart: 0,
          queryTranslation: 'crispr[All Fields]',
        });
      });

      it('discloses the dropped filter when only minDate is supplied', async () => {
        const ctx = createMockContext({ errors: searchArticlesTool.errors });
        const input = searchArticlesTool.input.parse({
          query: 'crispr',
          dateRange: { minDate: '2024', maxDate: '' },
        });
        await searchArticlesTool.handler(input, ctx);

        const notice = getEnrichment(ctx).notice as string;
        expect(notice).toContain('No date filter was applied');
        expect(notice).toContain('`minDate` ("2024")');
        expect(notice).toContain('`maxDate: "3000"`');
        expect(getEnrichment(ctx).appliedFilters).toEqual({});
      });

      it('discloses the dropped filter when only maxDate is supplied', async () => {
        const ctx = createMockContext({ errors: searchArticlesTool.errors });
        const input = searchArticlesTool.input.parse({
          query: 'crispr',
          dateRange: { minDate: '', maxDate: '2024' },
        });
        await searchArticlesTool.handler(input, ctx);

        const notice = getEnrichment(ctx).notice as string;
        expect(notice).toContain('`maxDate` ("2024")');
        // 1000, not 1800: PubMed dates records before 1800, and a later floor drops them.
        expect(notice).toContain('`minDate: "1000"`');
      });

      it('names sentinels that pass validation and reach ESearch as a range', async () => {
        const ctx = createMockContext({ errors: searchArticlesTool.errors });
        const input = searchArticlesTool.input.parse({
          query: 'crispr',
          dateRange: { minDate: '1000', maxDate: '3000' },
        });
        await searchArticlesTool.handler(input, ctx);

        expect(mockESearch.mock.calls.at(-1)?.[0]?.term).toBe(
          'crispr AND (1000[pdat] : 3000[pdat])',
        );
        expect(getEnrichment(ctx).appliedFilters).toEqual({
          dateRange: { minDate: '1000', maxDate: '3000', dateType: 'pdat' },
        });
      });

      it('describes an empty bound as dropping the whole range, with each sentinel', () => {
        const { minDate, maxDate } = searchArticlesTool.input.shape.dateRange.unwrap().shape;

        for (const bound of [minDate, maxDate]) {
          expect(bound.description).toContain(
            'Leaving it empty drops the whole date range, not just this bound',
          );
          expect(bound.description).not.toContain('disables this bound');
        }
        expect(minDate.description).toContain('such as `1000`');
        expect(maxDate.description).toContain('such as `3000`');
      });

      it('stays silent when both bounds are empty', async () => {
        const ctx = createMockContext({ errors: searchArticlesTool.errors });
        const input = searchArticlesTool.input.parse({
          query: 'crispr',
          dateRange: { minDate: '', maxDate: '' },
        });
        await searchArticlesTool.handler(input, ctx);

        expect(getEnrichment(ctx).notice).toBeUndefined();
      });

      it('stays silent when both bounds are supplied', async () => {
        const ctx = createMockContext({ errors: searchArticlesTool.errors });
        const input = searchArticlesTool.input.parse({
          query: 'crispr',
          dateRange: { minDate: '2024', maxDate: '2026' },
        });
        await searchArticlesTool.handler(input, ctx);

        expect(getEnrichment(ctx).notice).toBeUndefined();
      });
    });

    it('skips date clause when dateRange is omitted', async () => {
      mockESearch.mockResolvedValue({
        count: 5580000,
        idList: ['111'],
        retmax: 20,
        retstart: 0,
        queryTranslation: 'cancer[All Fields]',
      });

      const ctx = createMockContext({ errors: searchArticlesTool.errors });
      const input = searchArticlesTool.input.parse({ query: 'cancer' });
      await searchArticlesTool.handler(input, ctx);

      const calledTerm = mockESearch.mock.calls.at(-1)?.[0]?.term as string;
      expect(calledTerm).not.toContain('[pdat]');
      expect(calledTerm).not.toContain('[mdat]');
      expect(calledTerm).not.toContain('[edat]');
    });

    it('appends date clause when both dates are provided', async () => {
      mockESearch.mockResolvedValue({
        count: 100,
        idList: ['111'],
        retmax: 20,
        retstart: 0,
        queryTranslation: 'cancer[All Fields]',
      });

      const ctx = createMockContext({ errors: searchArticlesTool.errors });
      const input = searchArticlesTool.input.parse({
        query: 'cancer',
        dateRange: { minDate: '2020/01/01', maxDate: '2024/12/31' },
      });
      await searchArticlesTool.handler(input, ctx);

      expect(mockESearch.mock.calls.at(-1)?.[0]?.term).toBe(
        'cancer AND (2020/01/01[pdat] : 2024/12/31[pdat])',
      );
    });

    describe('accepted ranges keep their normalized clause (issue #177)', () => {
      // The regression floor for calendar and ordering validation: every range
      // here reaches ESearch exactly as it did before, for every dateType.
      it.each(
        (['pdat', 'mdat', 'edat'] as const).flatMap((dateType) =>
          [
            ['2024', '2024', '2024', '2024'],
            ['2024/06', '2024/06', '2024/06', '2024/06'],
            ['2024/1/5', '2024/1/5', '2024/1/5', '2024/1/5'],
            ['2024-01-15', '2024-01-15', '2024/01/15', '2024/01/15'],
            ['2024.01.15', '2024.01.15', '2024/01/15', '2024/01/15'],
            ['2024/02/29', '2024/02/29', '2024/02/29', '2024/02/29'],
            ['2024/1/5', '2024/01/05', '2024/1/5', '2024/01/05'],
            ['2024/06', '2024', '2024/06', '2024'],
            ['2024/06/15', '2024/06', '2024/06/15', '2024/06'],
            ['2024/06', '2024/06/01', '2024/06', '2024/06/01'],
            ['1800', '3000', '1800', '3000'],
          ].map(([minDate, maxDate, sentMin, sentMax]) => ({
            dateType,
            minDate,
            maxDate,
            sentMin,
            sentMax,
          })),
        ),
      )(
        'sends $minDate → $maxDate ($dateType) as $sentMin : $sentMax',
        async ({ dateType, minDate, maxDate, sentMin, sentMax }) => {
          mockESearch.mockResolvedValue({ count: 1, idList: ['1'], retmax: 20, retstart: 0 });
          const ctx = createMockContext({ errors: searchArticlesTool.errors });
          await searchArticlesTool.handler(
            searchArticlesTool.input.parse({
              query: 'cancer',
              dateRange: { minDate, maxDate, dateType },
            }),
            ctx,
          );

          expect(mockESearch.mock.calls[0]?.[0]?.term).toBe(
            `cancer AND (${sentMin}[${dateType}] : ${sentMax}[${dateType}])`,
          );
          expect(getEnrichment(ctx).appliedFilters).toEqual({
            dateRange: { minDate: sentMin, maxDate: sentMax, dateType },
          });
          expect(getEnrichment(ctx).notice).toBeUndefined();
        },
      );
    });

    describe('impossible dates and reversed ranges (issue #177)', () => {
      // PubMed answers either with HTTP 200, Count 0, and a FieldNotFound for the
      // valid date tag, so the check has to land before ESearch is called.
      const MIN = 'dateRange.minDate';
      const MAX = 'dateRange.maxDate';

      it.each(
        (['pdat', 'mdat', 'edat'] as const).flatMap((dateType) =>
          (
            [
              ['month 00', '2024/00', '2024/12', [MIN], /not a real calendar date/],
              ['month 13', '2024', '2024/13', [MAX], /not a real calendar date/],
              // Day 00 names no day at all; the month's day count is not the problem.
              ['day 00', '2024/06/00', '2024/12', [MIN], /calendar date: day 00 is not a day\b/],
              ['day 0', '2024/6/0', '2024/12', [MIN], /calendar date: day 0 is not a day\b/],
              ['day 32', '2024/01', '2024/01/32', [MAX], /not a real calendar date/],
              ['2023/02/29', '2023/02/29', '2023/12', [MIN], /2023\/02 has 28 days/],
              ['2023/02/30', '2023/01', '2023/02/30', [MAX], /2023\/02 has 28 days/],
              ['2024/02/30 in a leap year', '2024/02/30', '2024/12', [MIN], /has 29 days/],
              ['1900/02/29 in a century year', '1900/02/29', '1900/12', [MIN], /has 28 days/],
              ['2024/04/31', '2024/01', '2024/04/31', [MAX], /has 30 days/],
              ['both bounds impossible', '2024/99/99', '2025/99/99', [MIN, MAX], /month 99/],
              ['mixed separators', '2023-02-29', '2023.03.01', [MIN], /has 28 days/],
              ['an impossible min with an empty max', '2024/13', '', [MIN], /month 13/],
              ['an impossible max with an empty min', '', '2023/02/29', [MAX], /has 28 days/],
              ['whole years reversed', '2025', '2020', [MIN, MAX], /falls after/],
              ['days reversed', '2024/06/15', '2024/06/01', [MIN, MAX], /falls after/],
              ['a month after a day', '2024/07', '2024/06/30', [MIN, MAX], /falls after/],
            ] as const
          ).map(([label, minDate, maxDate, fields, message]) => ({
            label,
            dateType,
            minDate,
            maxDate,
            fields,
            message,
          })),
        ),
      )(
        'rejects $label ($dateType) as invalid_date_range without calling NCBI',
        async ({ dateType, minDate, maxDate, fields, message }) => {
          const result = await runToolContract(searchArticlesTool, {
            query: 'asthma',
            dateRange: { minDate, maxDate, dateType },
          });

          expect(result.isError).toBe(true);
          expect(result.structuredContent).toMatchObject({
            error: {
              code: JsonRpcErrorCode.ValidationError,
              message: expect.stringMatching(message),
              data: { reason: 'invalid_date_range', retryable: false, fields: [...fields] },
            },
          });
          const text = readCommonMark(contractText(result));
          for (const field of fields) expect(text).toContain(`\`${field}\``);
          expect(text).toMatch(message);
          expect(text).toMatch(/Recovery:/);
          expect(mockESearch).not.toHaveBeenCalled();
        },
      );

      it('shows how PubMed expands each partial bound in a reversed range', async () => {
        const result = await runToolContract(searchArticlesTool, {
          query: 'asthma',
          dateRange: { minDate: '2025', maxDate: '2020' },
        });

        const text = contractText(result);
        expect(text).toContain('2025/01/01');
        expect(text).toContain('2020/12/31');
      });

      it('accepts 2000/02/29, a leap day in a year divisible by 400', async () => {
        mockESearch.mockResolvedValue({ count: 1, idList: ['1'], retmax: 20, retstart: 0 });
        const ctx = createMockContext({ errors: searchArticlesTool.errors });
        await searchArticlesTool.handler(
          searchArticlesTool.input.parse({
            query: 'asthma',
            dateRange: { minDate: '2000/02/29', maxDate: '2000/03' },
          }),
          ctx,
        );

        expect(mockESearch.mock.calls[0]?.[0]?.term).toBe(
          'asthma AND (2000/02/29[pdat] : 2000/03[pdat])',
        );
      });

      it('declares invalid_date_range as a non-retryable input error', () => {
        const entry = searchArticlesTool.errors?.find((e) => e.reason === 'invalid_date_range');
        expect(entry).toMatchObject({ code: JsonRpcErrorCode.ValidationError, retryable: false });
      });

      it('names every impossible date in the invalid_date_range contract, day 00 included', () => {
        const entry = searchArticlesTool.errors?.find((e) => e.reason === 'invalid_date_range');
        expect(entry?.when).toMatch(/month outside 01–12/);
        expect(entry?.when).toMatch(/day 00/);
        expect(entry?.when).toMatch(/past the end of its month/);
      });

      it('describes calendar and ordering rules on the dateRange fields', () => {
        const { dateRange } = searchArticlesTool.input.shape;
        const inner = dateRange.unwrap().shape;
        expect(inner.minDate.description).toMatch(/real calendar date/i);
        expect(inner.maxDate.description).toMatch(/real calendar date/i);
        expect(dateRange.description).toMatch(/minDate.*after.*maxDate/i);
      });
    });

    it('converts dash-delimited dates to slashes for NCBI', async () => {
      mockESearch.mockResolvedValue({
        count: 100,
        idList: ['111'],
        retmax: 20,
        retstart: 0,
        queryTranslation: 'cancer[All Fields]',
      });

      const ctx = createMockContext({ errors: searchArticlesTool.errors });
      const input = searchArticlesTool.input.parse({
        query: 'cancer',
        dateRange: { minDate: '2020-01-01', maxDate: '2024-12-31' },
      });
      await searchArticlesTool.handler(input, ctx);

      expect(mockESearch.mock.calls.at(-1)?.[0]?.term).toBe(
        'cancer AND (2020/01/01[pdat] : 2024/12/31[pdat])',
      );
    });
  });

  it('returns search results', async () => {
    mockESearch.mockResolvedValue({
      count: 100,
      idList: ['111', '222', '333'],
      retmax: 20,
      retstart: 0,
      queryTranslation: 'cancer[All Fields]',
    });

    const ctx = createMockContext({ errors: searchArticlesTool.errors });
    const input = searchArticlesTool.input.parse({ query: 'cancer' });
    const result = await searchArticlesTool.handler(input, ctx);

    const enrichment = getEnrichment(ctx);
    expect(result.totalCount).toBe(100);
    expect(result.pmids).toEqual(['111', '222', '333']);
    expect(result.query).toBe('cancer');
    expect(enrichment.effectiveQuery).toBe('cancer');
    expect(enrichment.appliedFilters).toEqual({});
    expect(result.summaries).toEqual([]);
    expect(result.searchUrl).toBe('https://pubmed.ncbi.nlm.nih.gov/?term=cancer');
  });

  it('builds filtered queries and enriches summaries through WebEnv history', async () => {
    mockESearch.mockResolvedValue({
      count: 2,
      idList: ['111', '222'],
      retmax: 20,
      retstart: 5,
      queryTranslation: 'asthma[All Fields]',
      webEnv: 'NCBI_ENV',
      queryKey: '7',
    });
    mockESummary.mockResolvedValue({ eSummaryResult: {} });
    mockExtractBriefSummaries.mockResolvedValue([
      {
        pmid: '111',
        title: 'Asthma Outcomes',
        authors: 'Smith J',
        source: 'Nature',
        pubDate: '2024-01-01',
        doi: '10.1000/example',
        pmcId: 'PMC12345',
      },
    ]);

    const ctx = createMockContext({ errors: searchArticlesTool.errors });
    const input = searchArticlesTool.input.parse({
      query: 'asthma',
      offset: 5,
      summaryCount: 1,
      dateRange: { minDate: '2020-01-01', maxDate: '2024-12-31', dateType: 'mdat' },
      publicationTypes: ['Review', 'Clinical Trial'],
      author: 'Smith J',
      journal: 'Nature',
      meshTerms: ['Asthma', 'Inflammation'],
      language: 'english',
      hasAbstract: true,
      freeFullText: true,
      species: 'humans',
    });
    const result = await searchArticlesTool.handler(input, ctx);

    expect(mockESearch).toHaveBeenCalledWith(
      expect.objectContaining({
        usehistory: 'y',
        retstart: 5,
      }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );

    const expectedTerm =
      'asthma AND (2020/01/01[mdat] : 2024/12/31[mdat])' +
      ' AND ("Review"[Publication Type] OR "Clinical Trial"[Publication Type])' +
      ' AND Smith J[Author] AND "Nature"[Journal]' +
      ' AND ("Asthma"[MeSH Terms] AND "Inflammation"[MeSH Terms])' +
      ' AND english[Language] AND hasabstract[text word] AND free full text[filter]' +
      ' AND humans[MeSH Terms]';
    expect(mockESearch.mock.calls[0]?.[0]?.term).toBe(expectedTerm);
    const url = new URL(result.searchUrl);
    expect(url.origin + url.pathname).toBe('https://pubmed.ncbi.nlm.nih.gov/');
    expect(url.searchParams.get('term')).toBe(expectedTerm);

    expect(mockESummary).toHaveBeenCalledWith(
      {
        db: 'pubmed',
        version: '2.0',
        retmode: 'xml',
        WebEnv: 'NCBI_ENV',
        query_key: '7',
        retmax: 1,
        retstart: 5,
      },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(result.summaries).toEqual([
      {
        pmid: '111',
        title: 'Asthma Outcomes',
        authors: 'Smith J',
        source: 'Nature',
        pubDate: '2024-01-01',
        doi: '10.1000/example',
        pmcId: 'PMC12345',
        pmcUrl: 'https://www.ncbi.nlm.nih.gov/pmc/articles/PMC12345/',
        pubmedUrl: 'https://pubmed.ncbi.nlm.nih.gov/111/',
      },
    ]);
    const enrichment = getEnrichment(ctx);
    expect(enrichment.effectiveQuery).toBe(expectedTerm);
    expect(enrichment.appliedFilters).toEqual({
      dateRange: {
        minDate: '2020/01/01',
        maxDate: '2024/12/31',
        dateType: 'mdat',
      },
      publicationTypes: ['Review', 'Clinical Trial'],
      author: 'Smith J',
      journal: 'Nature',
      meshTerms: ['Asthma', 'Inflammation'],
      language: 'english',
      hasAbstract: true,
      freeFullText: true,
      species: 'humans',
    });
  });

  describe('species filter (issue #270)', () => {
    // PubMed's documented species filters: Humans is `humans[mh]`, Other Animals
    // is `"animals"[mh:noexp]`. An exploded `animals[MeSH Terms]` takes in the
    // Humans heading below it, so it would admit human-only studies.
    it.each([
      ['humans', 'cancer AND humans[MeSH Terms]'],
      ['animals', 'cancer AND "animals"[mh:noexp]'],
    ] as const)(
      'sends species %s as its PubMed filter clause on both surfaces',
      async (species, term) => {
        mockESearch.mockResolvedValue({ count: 1, idList: ['1'], retmax: 20, retstart: 0 });
        const result = await runToolContract(searchArticlesTool, { query: 'cancer', species });

        expect(mockESearch.mock.calls[0]?.[0]?.term).toBe(term);
        expect(result.structuredContent).toMatchObject({
          effectiveQuery: term,
          appliedFilters: { species },
        });
        expect(
          new URL((result.structuredContent as { searchUrl: string }).searchUrl).searchParams.get(
            'term',
          ),
        ).toBe(term);
        const text = readCommonMark(contractText(result));
        expect(text).toContain(`⟨strong⟩Effective Query:⟨/strong⟩ ⟨code_inline:${term}⟩`);
        expect(text).toContain(`⟨strong⟩Species:⟨/strong⟩ ${species}`);
      },
    );

    it('names both clauses and the MEDLINE-indexing limit in the species descriptions', () => {
      const input = searchArticlesTool.input.shape.species.description ?? '';
      expect(input).toContain('`humans[MeSH Terms]`');
      expect(input).toContain('`"animals"[mh:noexp]`');
      expect(input).toMatch(/MEDLINE species indexing/);
      expect(searchArticlesTool.enrichment?.appliedFilters.shape.species.description).toContain(
        '`"animals"[mh:noexp]`',
      );
    });
  });

  it('clamps history-backed summary fetches to the returned PMID page', async () => {
    mockESearch.mockResolvedValue({
      count: 10,
      idList: ['111', '222'],
      retmax: 2,
      retstart: 0,
      queryTranslation: 'asthma[All Fields]',
      webEnv: 'NCBI_ENV',
      queryKey: '7',
    });
    mockESummary.mockResolvedValue({ eSummaryResult: {} });

    const ctx = createMockContext({ errors: searchArticlesTool.errors });
    const input = searchArticlesTool.input.parse({
      query: 'asthma',
      maxResults: 2,
      summaryCount: 5,
    });
    await searchArticlesTool.handler(input, ctx);

    expect(mockESummary).toHaveBeenCalledWith(
      {
        db: 'pubmed',
        version: '2.0',
        retmode: 'xml',
        WebEnv: 'NCBI_ENV',
        query_key: '7',
        retmax: 2,
        retstart: 0,
      },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it('falls back to direct PMID summary fetch when history tokens are absent', async () => {
    mockESearch.mockResolvedValue({
      count: 2,
      idList: ['111', '222'],
      retmax: 2,
      retstart: 0,
      queryTranslation: 'asthma[All Fields]',
    });
    mockESummary.mockResolvedValue({ eSummaryResult: {} });

    const ctx = createMockContext({ errors: searchArticlesTool.errors });
    const input = searchArticlesTool.input.parse({
      query: 'asthma',
      summaryCount: 2,
    });
    await searchArticlesTool.handler(input, ctx);

    expect(mockESummary).toHaveBeenCalledWith(
      {
        db: 'pubmed',
        version: '2.0',
        retmode: 'xml',
        id: '111,222',
      },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  describe('blank query rejection (issue #122)', () => {
    // A blank term makes NCBI answer HTTP 200 with an embedded <ERROR> whose
    // text reads "Search is temporarily unavailable", which the response
    // handler classifies as a retryable outage. The rejection has to land
    // before the call so a deterministic input mistake never enters retry.
    it.each([
      ['whitespace-only', '   '],
      ['emptied by the sanitizer', '<b></b>'],
    ])('rejects a %s query without calling NCBI', async (_label, query) => {
      const ctx = createMockContext({ errors: searchArticlesTool.errors });
      const input = searchArticlesTool.input.parse({ query });

      const promise = searchArticlesTool.handler(input, ctx);
      await expect(promise).rejects.toMatchObject({
        code: JsonRpcErrorCode.ValidationError,
        data: { reason: 'blank_query' },
      });
      expect(mockESearch).not.toHaveBeenCalled();
    });

    // `.trim()` keeps U+0085 and every format character (`\p{Cf}`), and the
    // sanitizer decodes an entity to the character it names, so each of these
    // reached PubMed as an invisible term.
    it.each([
      ['a next-line character (U+0085)', '\u0085'],
      ['a zero-width space', '​'],
      ['a word joiner beside spaces', ' ⁠ '],
      ['a soft hyphen', '­'],
      ['a Mongolian vowel separator', '᠎'],
      ['a zero-width space entity', '&#8203;'],
      ['a hex word-joiner entity', '&#x2060;'],
      ['a no-break space entity', '&nbsp;'],
      ['a zero-width space in parentheses', '(​)'],
      ['a field tag beside a zero-width joiner', '[pdat]‍'],
      ['brackets around a zero-width space', '[​]'],
      ['a Hangul choseong filler (U+115F)', 'ᅟ'],
    ])('rejects a query of %s as blank_query without calling NCBI', async (_label, query) => {
      const result = await runToolContract(searchArticlesTool, { query });

      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: {
          code: JsonRpcErrorCode.ValidationError,
          data: { reason: 'blank_query', retryable: false },
        },
      });
      expect(readCommonMark(contractText(result))).toContain('`query`');
      expect(mockESearch).not.toHaveBeenCalled();
    });

    it('still searches a term wrapped in invisible characters, as written', async () => {
      mockESearch.mockResolvedValue({ count: 1, idList: ['1'], retmax: 20, retstart: 0 });
      const ctx = createMockContext({ errors: searchArticlesTool.errors });
      await searchArticlesTool.handler(
        searchArticlesTool.input.parse({ query: '​asthma\u0085' }),
        ctx,
      );

      expect(mockESearch.mock.calls[0]?.[0]?.term).toBe('​asthma\u0085');
    });

    it('mirrors the reason and recovery hint onto both error surfaces', async () => {
      const result = await runToolContract(searchArticlesTool, { query: '   ' });

      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: { code: JsonRpcErrorCode.ValidationError, data: { reason: 'blank_query' } },
      });
      const text = textBlocks(result.content as ContentBlock[])
        .map((b) => b.text)
        .join('\n');
      expect(text).toMatch(/Recovery:/);
      expect(text).toMatch(/nonblank/i);
    });

    it('declares blank_query as a non-retryable input error', () => {
      const entry = searchArticlesTool.errors?.find((e) => e.reason === 'blank_query');
      expect(entry).toMatchObject({
        code: JsonRpcErrorCode.ValidationError,
        retryable: false,
      });
    });

    it('still searches a legitimate query padded with whitespace', async () => {
      mockESearch.mockResolvedValue({ count: 3, idList: ['1'], retmax: 20, retstart: 0 });
      const ctx = createMockContext({ errors: searchArticlesTool.errors });
      const input = searchArticlesTool.input.parse({ query: '  covid  ' });
      const result = await searchArticlesTool.handler(input, ctx);

      expect(mockESearch.mock.calls[0]?.[0]?.term).toBe('  covid  ');
      expect(result.pmids).toEqual(['1']);
    });

    it('still sends a bare boolean operator to NCBI as a normal zero-result search', async () => {
      // NCBI answers `AND` with Count=0 and a WarningList, not an <ERROR> — a
      // real (if unproductive) search the empty-result guidance already covers.
      mockESearch.mockResolvedValue({ count: 0, idList: [], retmax: 20, retstart: 0 });
      const ctx = createMockContext({ errors: searchArticlesTool.errors });
      const input = searchArticlesTool.input.parse({ query: 'AND' });
      await searchArticlesTool.handler(input, ctx);

      expect(mockESearch.mock.calls[0]?.[0]?.term).toBe('AND');
      expect(getEnrichment(ctx).notice).toContain('pubmed_spell_check');
    });
  });

  describe('field-tag-only and parenthesis-only queries (issue #145)', () => {
    // A bare field tag reaches NCBI as a zero-hit search that sends the caller
    // to spell-check, and `()` draws the same embedded blank-term <ERROR> #122
    // fixed, which classifies as a retryable outage. Neither carries a term.
    it.each([
      ['a bare field tag', '[pdat]'],
      ['empty parentheses', '()'],
      ['nested parentheses around a field tag', '( [mesh] )'],
      ['several bare field tags', '[ti][tiab]'],
      ['a field tag with a multi-word name', '[Publication Type]'],
      ['a field tag in capitals', '[AU]'],
      ['a field tag with a search modifier', '[mh:noexp]'],
      ['a field tag with a proximity modifier', '[tiab:~3]'],
      ['an E-utilities field name', '[Date - Publication]'],
      ['empty brackets', '[ ]'],
    ])('rejects %s as blank_query without calling NCBI', async (_label, query) => {
      const ctx = createMockContext({ errors: searchArticlesTool.errors });
      const input = searchArticlesTool.input.parse({ query });

      await expect(searchArticlesTool.handler(input, ctx)).rejects.toMatchObject({
        code: JsonRpcErrorCode.ValidationError,
        data: { reason: 'blank_query' },
      });
      expect(mockESearch).not.toHaveBeenCalled();
    });

    it('names the stripped field tags and parentheses on both error surfaces', async () => {
      const result = await runToolContract(searchArticlesTool, { query: '[pdat]' });

      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: { code: JsonRpcErrorCode.ValidationError, data: { reason: 'blank_query' } },
      });
      const text = textBlocks(result.content as ContentBlock[])
        .map((b) => b.text)
        .join('\n');
      expect(text).toMatch(/field tag/i);
      expect(text).toMatch(/parenthes/i);
      expect(text).toMatch(/Recovery:/);
      expect(mockESearch).not.toHaveBeenCalled();
    });

    it('describes the rejection in the advertised `query` description', () => {
      const description = searchArticlesTool.input.shape.query.description ?? '';

      expect(description).toMatch(/field tag/i);
      expect(description).toMatch(/parenthes/i);
      expect(description).toContain('rejected');
    });

    // Only brackets and parentheses are stripped, never boolean operators:
    // NCBI reads an operand-less `NOT[ti]` as literal title text and returns
    // real matches, so it must still be searched.
    it('still searches an operator glued to a field tag (NOT[ti])', async () => {
      mockESearch.mockResolvedValue({
        count: 389552,
        idList: ['27889000'],
        retmax: 20,
        retstart: 0,
      });
      const ctx = createMockContext({ errors: searchArticlesTool.errors });
      const result = await searchArticlesTool.handler(
        searchArticlesTool.input.parse({ query: 'NOT[ti]' }),
        ctx,
      );

      expect(mockESearch.mock.calls[0]?.[0]?.term).toBe('NOT[ti]');
      expect(result.pmids).toEqual(['27889000']);
    });

    // PubMed searches the content of a bracket that is not a field tag as text:
    // live, `[18F]` returns 42,247 matches, `[cancer]` 5,706,079, `[smith j]`
    // 36,294 (as an author), and `[ti][ab]` 1,003,647 (`ab` is not a PubMed
    // field tag). Each carries a term, so each must reach NCBI.
    it.each([
      ['a bare radiolabel', '[18F]'],
      ['a bracketed word', '[cancer]'],
      ['a bracketed author name', '[smith j]'],
      ['a field tag beside a bracketed non-tag', '[ti][ab]'],
      ['a modifier with no field name', '[:noexp]'],
    ])('sends %s to NCBI rather than rejecting it', async (_label, query) => {
      mockESearch.mockResolvedValue({ count: 1, idList: ['1'], retmax: 20, retstart: 0 });
      const ctx = createMockContext({ errors: searchArticlesTool.errors });
      const result = await searchArticlesTool.handler(
        searchArticlesTool.input.parse({ query }),
        ctx,
      );

      expect(mockESearch.mock.calls[0]?.[0]?.term).toBe(query);
      expect(result.pmids).toEqual(['1']);
    });

    it.each([
      ['2020[pdat]'],
      ['"cancer"[ti]'],
      ['asthma NOT children'],
      ['2020[pdat] AND cancer'],
      ['(asthma[mesh]) AND (children)'],
    ])('sends %s to NCBI with the query intact', async (query) => {
      mockESearch.mockResolvedValue({ count: 1, idList: ['1'], retmax: 20, retstart: 0 });
      const ctx = createMockContext({ errors: searchArticlesTool.errors });
      await searchArticlesTool.handler(searchArticlesTool.input.parse({ query }), ctx);

      expect(mockESearch.mock.calls[0]?.[0]?.term).toBe(query);
      expect(getEnrichment(ctx).effectiveQuery).toBe(query);
    });

    it('describes a bare field tag and empty parentheses in the blank_query contract', () => {
      const entry = searchArticlesTool.errors?.find((e) => e.reason === 'blank_query');
      expect(entry?.when).toContain('[pdat]');
      expect(entry?.when).toContain('()');
    });
  });

  describe('filter values (issue #176)', () => {
    beforeEach(() => {
      mockESearch.mockResolvedValue({ count: 2, idList: ['1', '2'], retmax: 20, retstart: 0 });
    });

    /** Runs the handler with `asthma` plus the given filters; returns the term sent and the context. */
    const search = async (filters: Record<string, unknown>) => {
      const ctx = createMockContext({ errors: searchArticlesTool.errors });
      await searchArticlesTool.handler(
        searchArticlesTool.input.parse({ query: 'asthma', ...filters }),
        ctx,
      );
      return { term: mockESearch.mock.calls[0]?.[0]?.term as string, ctx };
    };

    it.each([
      ['author', { author: '  Smith J  ' }, 'asthma AND   Smith J  [Author]'],
      ['journal', { journal: '  Thorax  ' }, 'asthma AND "  Thorax  "[Journal]'],
      ['language', { language: '  english  ' }, 'asthma AND   english  [Language]'],
      [
        'publicationTypes',
        { publicationTypes: ['  Review  '] },
        'asthma AND ("  Review  "[Publication Type])',
      ],
      [
        'meshTerms',
        { meshTerms: ['  Adult  ', 'Child'] },
        'asthma AND ("  Adult  "[MeSH Terms] AND "Child"[MeSH Terms])',
      ],
    ])('still searches a padded %s value as written', async (_label, filters, term) => {
      const result = await search(filters);

      expect(result.term).toBe(term);
      expect(getEnrichment(result.ctx).appliedFilters).toEqual(filters);
    });

    // `<b>` and `<i>` are inline formatting tags with no attributes, the one
    // markup removed from what is sent; anything else is sent as written. (#260)
    it('removes inline formatting tags from a filter value', async () => {
      const result = await search({ author: '<b>Smith J</b>', meshTerms: ['<i>Asthma</i>'] });

      expect(result.term).toBe('asthma AND Smith J[Author] AND ("Asthma"[MeSH Terms])');
      expect(getEnrichment(result.ctx).appliedFilters).toEqual({
        author: 'Smith J',
        meshTerms: ['Asthma'],
      });
    });

    // Parentheses, brackets, and quotes beside a term are part of the value, so
    // the blank check that disregards them never strips them from what is sent.
    it.each([
      ['author', { author: '"Smith J"' }, 'asthma AND "Smith J"[Author]'],
      [
        'journal',
        { journal: 'Cell (Cambridge, Mass.)' },
        'asthma AND "Cell (Cambridge, Mass.)"[Journal]',
      ],
      ['language', { language: '(english)' }, 'asthma AND (english)[Language]'],
      [
        'publicationTypes element',
        { publicationTypes: ['[Review]'] },
        'asthma AND ("[Review]"[Publication Type])',
      ],
      ['meshTerms element', { meshTerms: ['"Asthma"'] }, 'asthma AND (""Asthma""[MeSH Terms])'],
    ])(
      'still searches a %s holding syntax characters beside a term',
      async (_label, filters, term) => {
        const result = await search(filters);

        expect(result.term).toBe(term);
        expect(getEnrichment(result.ctx).appliedFilters).toEqual(filters);
      },
    );

    it.each([
      ['author', { author: '' }],
      ['journal', { journal: '' }],
      ['language', { language: '' }],
      ['publicationTypes list', { publicationTypes: [] }],
      ['meshTerms list', { meshTerms: [] }],
      [
        'value in every filter at once',
        { author: '', journal: '', language: '', publicationTypes: [], meshTerms: [] },
      ],
    ])('applies no filter for an empty %s', async (_label, filters) => {
      const result = await search(filters);

      expect(result.term).toBe('asthma');
      expect(getEnrichment(result.ctx).appliedFilters).toEqual({});
      expect(getEnrichment(result.ctx).notice).toBeUndefined();
    });

    // An exactly-empty list element is the same "no filter" signal as an
    // exactly-empty scalar, so it is dropped rather than sent as `""[Tag]`.
    it.each([
      ['publicationTypes element', { publicationTypes: [''] }, 'asthma', {}],
      ['meshTerms element', { meshTerms: [''] }, 'asthma', {}],
      [
        'element beside real values',
        { publicationTypes: ['', 'Review'], meshTerms: ['Adult', ''] },
        'asthma AND ("Review"[Publication Type]) AND ("Adult"[MeSH Terms])',
        { publicationTypes: ['Review'], meshTerms: ['Adult'] },
      ],
    ])('drops an empty %s', async (_label, filters, term, appliedFilters) => {
      const result = await search(filters);

      expect(result.term).toBe(term);
      expect(getEnrichment(result.ctx).appliedFilters).toEqual(appliedFilters);
    });

    /**
     * PubMed reads parentheses, brackets, and double quotes as query syntax, so
     * a filter of only those carries no term: `asthma AND ()[Author]` answers
     * with every `asthma` match and a notice that the Author tag went
     * unrecognized. Each value is tried on every filter the check covers.
     */
    const syntaxOnlyRows = ['()', '[]', '""', '( )'].flatMap(
      (value): [string, Record<string, unknown>, string[]][] => [
        [`author of ${value}`, { author: value }, ['author']],
        [`journal of ${value}`, { journal: value }, ['journal']],
        [`language of ${value}`, { language: value }, ['language']],
        [
          `publicationTypes element of ${value}`,
          { publicationTypes: ['Review', value] },
          ['publicationTypes.1'],
        ],
        [`meshTerms element of ${value}`, { meshTerms: [value] }, ['meshTerms.0']],
      ],
    );

    it.each<[string, Record<string, unknown>, string[]]>([
      ['author', { author: '   ' }, ['author']],
      ['journal', { journal: '   ' }, ['journal']],
      ['language', { language: '   ' }, ['language']],
      ['author emptied by the sanitizer', { author: '<b></b>' }, ['author']],
      ['journal left as whitespace by the sanitizer', { journal: '<i> </i>' }, ['journal']],
      ['publicationTypes element', { publicationTypes: ['   '] }, ['publicationTypes.0']],
      ['meshTerms element', { meshTerms: ['  '] }, ['meshTerms.0']],
      ['later meshTerms element', { meshTerms: ['Adult', '  '] }, ['meshTerms.1']],
      ['element after an empty one', { publicationTypes: ['', '<b></b>'] }, ['publicationTypes.1']],
      [
        'value in several filters',
        { author: '\t', journal: 'Thorax', meshTerms: ['Adult', ' '] },
        ['author', 'meshTerms.1'],
      ],
      // Invisible to `.trim()`: U+0085, format characters, and the entities the
      // sanitizer decodes to them.
      ['author of a zero-width space', { author: '​' }, ['author']],
      ['journal of a zero-width space entity', { journal: '&#8203;' }, ['journal']],
      ['language of a word joiner', { language: '⁠' }, ['language']],
      ['meshTerms element of a next-line character', { meshTerms: ['\u0085'] }, ['meshTerms.0']],
      [
        'publicationTypes element of a soft hyphen in markup',
        { publicationTypes: ['Review', '<i>­</i>'] },
        ['publicationTypes.1'],
      ],
      ['author of a Hangul filler (U+3164)', { author: 'ㅤ' }, ['author']],
      ...syntaxOnlyRows,
      // Syntax characters left once the sanitizer strips markup or decodes an entity.
      ['author of parentheses in markup', { author: '<b>( )</b>' }, ['author']],
      ['journal of quote entities', { journal: '&quot;&quot;' }, ['journal']],
      [
        'meshTerms element of a zero-width space in brackets',
        { meshTerms: ['Adult', '[​]'] },
        ['meshTerms.1'],
      ],
    ])(
      'rejects a blank %s as blank_filter without calling NCBI',
      async (_label, filters, fields) => {
        const result = await runToolContract(searchArticlesTool, { query: 'asthma', ...filters });

        expect(result.isError).toBe(true);
        expect(result.structuredContent).toMatchObject({
          error: {
            code: JsonRpcErrorCode.ValidationError,
            data: { reason: 'blank_filter', retryable: false, fields },
          },
        });
        const text = readCommonMark(contractText(result));
        for (const field of fields) expect(text).toContain(`\`${field}\``);
        expect(text).toMatch(/Recovery:/);
        expect(mockESearch).not.toHaveBeenCalled();
      },
    );

    it('declares blank_filter as a non-retryable input error', () => {
      expect(searchArticlesTool.errors?.find((e) => e.reason === 'blank_filter')).toMatchObject({
        code: JsonRpcErrorCode.ValidationError,
        retryable: false,
      });
    });

    it('counts invisible characters as blank in the blank_filter contract', () => {
      const entry = searchArticlesTool.errors?.find((e) => e.reason === 'blank_filter');
      expect(entry?.when).toMatch(/invisible/i);
      expect(entry?.when).toMatch(/zero-width space/i);
    });

    it('counts parentheses, brackets, and double quotes as blank in the contract and the message', async () => {
      const entry = searchArticlesTool.errors?.find((e) => e.reason === 'blank_filter');
      for (const syntax of [/parenthes/i, /bracket/i, /double quote/i]) {
        expect(entry?.when).toMatch(syntax);
      }

      const text = contractText(
        await runToolContract(searchArticlesTool, { query: 'asthma', author: '()' }),
      );
      for (const syntax of [/parenthes/i, /bracket/i, /double quote/i]) {
        expect(text).toMatch(syntax);
      }
    });

    it('describes the empty-string and blank-value rules on each filter', () => {
      const { shape } = searchArticlesTool.input;
      for (const field of [
        'author',
        'journal',
        'language',
        'publicationTypes',
        'meshTerms',
      ] as const) {
        const description = shape[field].description ?? '';
        expect(description, field).toMatch(/empty string/i);
        expect(description, field).toMatch(/rejected/i);
        expect(description, field).toMatch(/parentheses, brackets, or double quotes/i);
      }
    });
  });

  describe('query and filter values reach ESearch as written (issue #260)', () => {
    beforeEach(() => {
      mockESearch.mockResolvedValue({ count: 1, idList: ['1'], retmax: 20, retstart: 0 });
    });

    /** The term ESearch was called with, the enrichment, and the searchUrl's decoded term. */
    const sent = async (input: { query: string } & Record<string, unknown>) => {
      const result = await runToolContract(searchArticlesTool, input);
      const structured = result.structuredContent as {
        effectiveQuery: string;
        appliedFilters: Record<string, unknown>;
        searchUrl: string;
      };
      return {
        term: mockESearch.mock.calls[0]?.[0]?.term as string,
        effectiveQuery: structured.effectiveQuery,
        appliedFilters: structured.appliedFilters,
        urlTerm: new URL(structured.searchUrl).searchParams.get('term'),
        text: readCommonMark(contractText(result)),
      };
    };

    // The sanitizer HTML-encoded `&`, `<`, and `>` and deleted text from a `<`
    // up to the next `>`, so PubMed ran `R&amp;D[tiab]` (9 hits, against 1,886
    // as written) and `c.1A&gt;G` (0, against 123).
    it.each([
      ['an ampersand', 'R&D[tiab] AND pharmaceutical[tiab]'],
      ['a greater-than sign', 'c.1A>G'],
      ['a less-than sign in a phrase', '"p<0.05"[tiab]'],
      ['a less-than sign before a letter', 'smith<j'],
      ['a less-than and a greater-than sign around text', 'a<b and c>d'],
      ['an HTML entity', 'caf&eacute;'],
      ['a formatting tag with attributes and its closer', '<i class="a">x</i>'],
      ['a script element beside a term', 'cancer AND <script>x</script>'],
    ])('sends a query holding %s as written', async (_label, query) => {
      const result = await sent({ query });

      expect(result.term).toBe(query);
      expect(result.effectiveQuery).toBe(query);
      expect(result.urlTerm).toBe(query);
      expect(result.appliedFilters).toEqual({});
    });

    // A formatting tag with attributes is not a pasted title's italics, so it
    // and the closer that pairs with it reach PubMed as written; a bare tag
    // inside it is still removed. The pairing rules are tabled at
    // `withoutFormattingTags`; these prove the query and a filter use it.
    it('keeps an attribute-bearing tag and its closer in the query and removes a bare one inside', async () => {
      const result = await sent({ query: '<i class="a"><i>x</i></i>[tiab]' });

      expect(result.term).toBe('<i class="a">x</i>[tiab]');
      expect(result.effectiveQuery).toBe('<i class="a">x</i>[tiab]');
      expect(result.urlTerm).toBe('<i class="a">x</i>[tiab]');
    });

    it('keeps an attribute-bearing tag and its closer in a filter value', async () => {
      const result = await sent({ query: 'asthma', journal: '<i class="a">Lancet</i>' });

      expect(result.term).toBe('asthma AND "<i class="a">Lancet</i>"[Journal]');
      expect(result.appliedFilters).toEqual({ journal: '<i class="a">Lancet</i>' });
    });

    // PubMed searches markup as text: `<i>Staphylococcus aureus</i>[tiab]`
    // matches 3 records as written and 152,258 without the tags.
    it.each([
      [
        'italics around a tagged phrase',
        '<i>Staphylococcus aureus</i>[tiab]',
        'Staphylococcus aureus[tiab]',
      ],
      [
        'every formatting tag, any case',
        '<EM>a</EM> <Strong>b</Strong> <u>c</u> <B>d</b>',
        'a b c d',
      ],
      ['a formatting tag beside an ampersand', '<i>R&D</i>[tiab]', 'R&D[tiab]'],
    ])('removes %s and sends the rest as written', async (_label, query, term) => {
      const result = await sent({ query });

      expect(result.term).toBe(term);
      expect(result.effectiveQuery).toBe(term);
      expect(result.urlTerm).toBe(term);
      expect(result.text).toContain(`⟨strong⟩Effective Query:⟨/strong⟩ ⟨code_inline:${term}⟩`);
    });

    it.each([
      [
        'journal',
        { query: 'brain', journal: 'Brain & development' },
        'brain AND "Brain & development"[Journal]',
        { journal: 'Brain & development' },
      ],
      [
        'author',
        { query: 'asthma', author: 'smith<j' },
        'asthma AND smith<j[Author]',
        { author: 'smith<j' },
      ],
      [
        'meshTerms element',
        { query: 'asthma', meshTerms: ['<i>Asthma</i>', 'T-Lymphocytes & B-Lymphocytes'] },
        'asthma AND ("Asthma"[MeSH Terms] AND "T-Lymphocytes & B-Lymphocytes"[MeSH Terms])',
        { meshTerms: ['Asthma', 'T-Lymphocytes & B-Lymphocytes'] },
      ],
      [
        'publicationTypes element',
        { query: 'asthma', publicationTypes: ['Review <b>x</b> & y'] },
        'asthma AND ("Review x & y"[Publication Type])',
        { publicationTypes: ['Review x & y'] },
      ],
      [
        'language',
        { query: 'asthma', language: 'eng>' },
        'asthma AND eng>[Language]',
        { language: 'eng>' },
      ],
    ])(
      'sends a %s value as written inside its clause',
      async (_label, input, term, appliedFilters) => {
        const result = await sent(input);

        expect(result.term).toBe(term);
        expect(result.effectiveQuery).toBe(term);
        expect(result.urlTerm).toBe(term);
        expect(result.appliedFilters).toEqual(appliedFilters);
      },
    );

    it('describes effectiveQuery as what was sent, not a sanitized copy', () => {
      const description = searchArticlesTool.enrichment?.effectiveQuery.description ?? '';
      expect(description).not.toMatch(/sanitized/i);
      expect(description).toMatch(/as written/);
      expect(description).toContain('`<i>`');
    });
  });

  describe('empty-result notice', () => {
    it('suggests spell-check when totalCount is 0 and no filters applied', async () => {
      mockESearch.mockResolvedValue({
        count: 0,
        idList: [],
        retmax: 20,
        retstart: 0,
        queryTranslation: 'xyznothingmatches[All Fields]',
      });

      const ctx = createMockContext({ errors: searchArticlesTool.errors });
      const input = searchArticlesTool.input.parse({ query: 'xyznothingmatches' });
      await searchArticlesTool.handler(input, ctx);

      const enrichment = getEnrichment(ctx);
      expect(enrichment.notice).toBeDefined();
      expect(enrichment.notice).toContain('pubmed_spell_check');
    });

    it('suggests removing filters when totalCount is 0 with filters applied', async () => {
      mockESearch.mockResolvedValue({
        count: 0,
        idList: [],
        retmax: 20,
        retstart: 0,
        queryTranslation: 'cancer[All Fields] AND ...',
      });

      const ctx = createMockContext({ errors: searchArticlesTool.errors });
      const input = searchArticlesTool.input.parse({
        query: 'cancer',
        author: 'Smith J',
        meshTerms: ['Asthma'],
      });
      await searchArticlesTool.handler(input, ctx);

      const enrichment = getEnrichment(ctx);
      expect(enrichment.notice).toBeDefined();
      expect(enrichment.notice).toContain('filters');
    });

    it('warns when offset exceeds totalCount', async () => {
      mockESearch.mockResolvedValue({
        count: 100,
        idList: [],
        retmax: 20,
        retstart: 200,
        queryTranslation: 'cancer[All Fields]',
      });

      const ctx = createMockContext({ errors: searchArticlesTool.errors });
      const input = searchArticlesTool.input.parse({ query: 'cancer', offset: 200 });
      await searchArticlesTool.handler(input, ctx);

      const enrichment = getEnrichment(ctx);
      expect(enrichment.notice).toBeDefined();
      expect(enrichment.notice).toContain('Offset 200');
      expect(enrichment.notice).toContain('totalCount (100)');
    });

    it('omits notice on a successful result page', async () => {
      mockESearch.mockResolvedValue({
        count: 100,
        idList: ['111', '222'],
        retmax: 20,
        retstart: 0,
        queryTranslation: 'cancer[All Fields]',
      });

      const ctx = createMockContext({ errors: searchArticlesTool.errors });
      const input = searchArticlesTool.input.parse({ query: 'cancer' });
      await searchArticlesTool.handler(input, ctx);

      expect(getEnrichment(ctx).notice).toBeUndefined();
    });
  });

  describe('upstream ErrorList / WarningList diagnostics (issue #96)', () => {
    it('flags an ignored field tag even when the search returned hits', async () => {
      // NCBI drops the unknown field restriction and searches free text, so the
      // count is the unrestricted one — nothing else distinguishes it.
      mockESearch.mockResolvedValue({
        count: 870,
        idList: ['111', '222'],
        retmax: 20,
        retstart: 0,
        queryTranslation: 'lecanemab[All Fields]',
        errorList: { FieldNotFound: ['NoSuchField'] },
      });

      const ctx = createMockContext({ errors: searchArticlesTool.errors });
      const input = searchArticlesTool.input.parse({ query: 'lecanemab[NoSuchField]' });
      await searchArticlesTool.handler(input, ctx);

      const notice = getEnrichment(ctx).notice as string;
      expect(notice).toContain('`NoSuchField`');
      expect(notice).toContain('free text');
    });

    it('names every ignored field tag when NCBI reports more than one', async () => {
      mockESearch.mockResolvedValue({
        count: 12,
        idList: ['111'],
        retmax: 20,
        retstart: 0,
        queryTranslation: 'smith[All Fields]',
        errorList: { FieldNotFound: ['Aithor', 'Jrnal'] },
      });

      const ctx = createMockContext({ errors: searchArticlesTool.errors });
      const input = searchArticlesTool.input.parse({ query: 'smith[Aithor] AND x[Jrnal]' });
      await searchArticlesTool.handler(input, ctx);

      const notice = getEnrichment(ctx).notice as string;
      expect(notice).toContain('`Aithor`, `Jrnal`');
    });

    it('names the unmatched clause instead of the generic filter guidance', async () => {
      mockESearch.mockResolvedValue({
        count: 0,
        idList: [],
        retmax: 20,
        retstart: 0,
        queryTranslation: 'lecanemab[All Fields]',
        warningList: {
          QuotedPhraseNotFound: ['"Notarealmeshterm"[MeSH Terms]'],
          OutputMessage: ['No items found.'],
        },
      });

      const ctx = createMockContext({ errors: searchArticlesTool.errors });
      const input = searchArticlesTool.input.parse({
        query: 'lecanemab',
        meshTerms: ['Notarealmeshterm'],
      });
      await searchArticlesTool.handler(input, ctx);

      const notice = getEnrichment(ctx).notice as string;
      expect(notice).toContain('`"Notarealmeshterm"[MeSH Terms]`');
      expect(notice).toContain('pubmed_lookup_mesh');
      // The precise clause replaces the guess-across-every-filter message.
      expect(notice).not.toContain('Try removing filters');
    });

    it('surfaces ErrorList.PhraseNotFound alongside hits', async () => {
      mockESearch.mockResolvedValue({
        count: 5,
        idList: ['111'],
        retmax: 20,
        retstart: 0,
        queryTranslation: 'x[All Fields]',
        errorList: { PhraseNotFound: ['zzznomatch'] },
      });

      const ctx = createMockContext({ errors: searchArticlesTool.errors });
      const input = searchArticlesTool.input.parse({ query: 'x zzznomatch' });
      await searchArticlesTool.handler(input, ctx);

      expect(getEnrichment(ctx).notice).toContain('`zzznomatch`');
    });

    it('ignores OutputMessage-only warnings on a normal result page', async () => {
      mockESearch.mockResolvedValue({
        count: 5580000,
        idList: ['111'],
        retmax: 20,
        retstart: 0,
        queryTranslation: 'cancer[All Fields]',
        warningList: { OutputMessage: ['Restrictions achieved. start and count adjusted to 0, 1'] },
      });

      const ctx = createMockContext({ errors: searchArticlesTool.errors });
      const input = searchArticlesTool.input.parse({ query: 'cancer' });
      await searchArticlesTool.handler(input, ctx);

      expect(getEnrichment(ctx).notice).toBeUndefined();
    });
  });

  describe('unmatched-phrase notice quotes the clause as the caller wrote it (issue #273)', () => {
    /** The notice on both surfaces: structuredContent's string and content[]'s CommonMark reading. */
    const noticeOf = async (query: string) => {
      const result = await runToolContract(searchArticlesTool, { query });
      return {
        notice: (result.structuredContent as { notice?: string }).notice ?? '',
        text: readCommonMark(contractText(result)),
      };
    };

    it('decodes the `&` ESearch double-encodes in QuotedPhraseNotFound, on both surfaces', async () => {
      mockESearch.mockResolvedValue(eSearchResultOf(QUOTED_PHRASE_AMP_ESEARCH_XML));
      const { notice, text } = await noticeOf('"zzqxw & yyqzv"[tiab] AND cancer');

      expect(notice).toContain('PubMed matched nothing for `"zzqxw & yyqzv"[tiab]`, so');
      expect(text).toContain('PubMed matched nothing for ⟨code_inline:"zzqxw & yyqzv"[tiab]⟩, so');
    });

    it('decodes a double-encoded `<` and `>` too, and leaves a FieldNotFound value as sent', async () => {
      mockESearch.mockResolvedValue(eSearchResultOf(FIELD_AND_PHRASE_ESEARCH_XML));
      const { notice, text } = await noticeOf(
        'cancer AND tumor[zz&field] AND "a<b zzqxw > c"[tiab]',
      );

      expect(notice).toContain('field tag(s) `zz&field` and');
      expect(notice).toContain('matched nothing for `"a<b zzqxw > c"[tiab]`, so');
      expect(text).toContain('⟨code_inline:zz&field⟩');
      expect(text).toContain('⟨code_inline:"a<b zzqxw > c"[tiab]⟩');
    });

    it('decodes one layer, never to a fixed point, and only in QuotedPhraseNotFound', async () => {
      // A caller who wrote `&amp;` in the phrase and the field tag: ESearch
      // ships the phrase as `&amp;amp;amp;` and the tag as `&amp;amp;`.
      mockESearch.mockResolvedValue({
        count: 0,
        idList: [],
        retmax: 0,
        retstart: 0,
        errorList: { FieldNotFound: ['zz&amp;field'] },
        warningList: { QuotedPhraseNotFound: ['"zz &amp;amp; yy"[tiab]'] },
      });
      const { notice } = await noticeOf('cancer[zz&amp;field] AND "zz &amp; yy"[tiab]');

      expect(notice).toContain('field tag(s) `zz&amp;field` and');
      expect(notice).toContain('matched nothing for `"zz &amp; yy"[tiab]`, so');
    });

    it('fences a clause holding a backtick so it reads back whole', async () => {
      mockESearch.mockResolvedValue({
        count: 0,
        idList: [],
        retmax: 0,
        retstart: 0,
        warningList: { QuotedPhraseNotFound: ['"5` UTR"[tiab]'] },
      });
      const { notice, text } = await noticeOf('"5` UTR"[tiab]');

      expect(notice).toContain('matched nothing for ``"5` UTR"[tiab]``, so');
      expect(text).toContain('matched nothing for ⟨code_inline:"5` UTR"[tiab]⟩, so');
    });
  });

  describe('notice composition across signals (issues #95, #96, #97)', () => {
    it('composes a partial dateRange with an ignored field tag on a hit-bearing page', async () => {
      mockESearch.mockResolvedValue({
        count: 870,
        idList: ['111'],
        retmax: 20,
        retstart: 0,
        queryTranslation: 'lecanemab[All Fields]',
        errorList: { FieldNotFound: ['NoSuchField'] },
      });

      const ctx = createMockContext({ errors: searchArticlesTool.errors });
      const input = searchArticlesTool.input.parse({
        query: 'lecanemab[NoSuchField]',
        dateRange: { minDate: '2024', maxDate: '' },
      });
      await searchArticlesTool.handler(input, ctx);

      const notice = getEnrichment(ctx).notice as string;
      expect(notice).toContain('No date filter was applied');
      expect(notice).toContain('`NoSuchField`');
    });

    it('composes a partial dateRange with the generic empty-result guidance', async () => {
      mockESearch.mockResolvedValue({
        count: 0,
        idList: [],
        retmax: 20,
        retstart: 0,
        queryTranslation: 'zzz[All Fields]',
      });

      const ctx = createMockContext({ errors: searchArticlesTool.errors });
      const input = searchArticlesTool.input.parse({
        query: 'zzz',
        dateRange: { minDate: '', maxDate: '2024' },
      });
      await searchArticlesTool.handler(input, ctx);

      const notice = getEnrichment(ctx).notice as string;
      expect(notice).toContain('No date filter was applied');
      expect(notice).toContain('pubmed_spell_check');
    });

    it('composes a partial dateRange with the offset-overshoot warning', async () => {
      mockESearch.mockResolvedValue({
        count: 100,
        idList: [],
        retmax: 20,
        retstart: 200,
        queryTranslation: 'cancer[All Fields]',
      });

      const ctx = createMockContext({ errors: searchArticlesTool.errors });
      const input = searchArticlesTool.input.parse({
        query: 'cancer',
        offset: 200,
        dateRange: { minDate: '2024', maxDate: '' },
      });
      await searchArticlesTool.handler(input, ctx);

      const notice = getEnrichment(ctx).notice as string;
      expect(notice).toContain('No date filter was applied');
      expect(notice).toContain('Offset 200 exceeds totalCount (100)');
    });

    it('composes an ignored field tag with the offset-overshoot warning', async () => {
      mockESearch.mockResolvedValue({
        count: 100,
        idList: [],
        retmax: 20,
        retstart: 200,
        queryTranslation: 'smith[All Fields]',
        errorList: { FieldNotFound: ['Aithor'] },
      });

      const ctx = createMockContext({ errors: searchArticlesTool.errors });
      const input = searchArticlesTool.input.parse({ query: 'smith[Aithor]', offset: 200 });
      await searchArticlesTool.handler(input, ctx);

      const notice = getEnrichment(ctx).notice as string;
      expect(notice).toContain('`Aithor`');
      expect(notice).toContain('Offset 200 exceeds totalCount (100)');
    });

    it('composes every signal that applies to an empty filtered result', async () => {
      mockESearch.mockResolvedValue({
        count: 0,
        idList: [],
        retmax: 20,
        retstart: 0,
        queryTranslation: 'smith[All Fields]',
        errorList: { FieldNotFound: ['Aithor'] },
        warningList: { QuotedPhraseNotFound: ['"Notarealmeshterm"[MeSH Terms]'] },
      });

      const ctx = createMockContext({ errors: searchArticlesTool.errors });
      const input = searchArticlesTool.input.parse({
        query: 'smith[Aithor]',
        meshTerms: ['Notarealmeshterm'],
        dateRange: { minDate: '2024', maxDate: '' },
      });
      await searchArticlesTool.handler(input, ctx);

      const notice = getEnrichment(ctx).notice as string;
      expect(notice).toContain('No date filter was applied');
      expect(notice).toContain('`Aithor`');
      expect(notice).toContain('`"Notarealmeshterm"[MeSH Terms]`');
      // Named clauses win over the generic filter guidance.
      expect(notice).not.toContain('Try removing filters');
    });
  });

  it('formats output', () => {
    const blocks = textBlocks(
      searchArticlesTool.format!({
        query: 'cancer',
        offset: 0,
        pmids: ['111', '222'],
        summaries: [],
        searchUrl: 'https://pubmed.ncbi.nlm.nih.gov/?term=cancer',
        totalCount: 2,
      }),
    );
    expect(blocks[0]?.text).toBe(
      [
        '## PubMed Search Results',
        '**Query:** `cancer`',
        '**Returned:** 2 of 2 | **Offset:** 0',
        '**Search URL:** <https://pubmed.ncbi.nlm.nih.gov/?term=cancer>',
        '',
        '**PMIDs:** 111, 222',
      ].join('\n'),
    );
  });

  describe('a query carrying Markdown-significant characters (issue #255)', () => {
    const query = 'cance* AND neuro*[tiab] AND <i>x</i> AND a_b_c_';

    it('echoes the query exactly on the raw content[] text, structuredContent unchanged', async () => {
      mockESearch.mockResolvedValue({ count: 0, retmax: 0, retstart: 0, idList: [] });
      const result = await runToolContract(searchArticlesTool, { query });

      expect((result.structuredContent as { query: string }).query).toBe(query);
      expect(contractText(result)).toContain(`**Query:** \`${query}\`\n`);
    });

    it.runIf(bunMarkdown !== undefined)('renders the query exactly', () => {
      const text = textBlocks(
        searchArticlesTool.format!({
          query,
          offset: 0,
          pmids: [],
          summaries: [],
          searchUrl: 'https://pubmed.ncbi.nlm.nih.gov/?term=x',
          totalCount: 0,
        }),
      )[0]?.text;
      expect(renderedText(text ?? '')).toContain(`Query: ${query} Returned: 0 of 0`);
    });
  });

  describe('caller echoes the server renders itself (issue #263)', () => {
    const input = {
      query: 'HLA-B*57 `x` carriers',
      maxResults: 1,
      author: 'Lee _K',
      journal: '<i class="x">J_ Med</i>',
      meshTerms: ['HLA-B*57', 'Drug*Hypersensitivity'],
      publicationTypes: ['Review`s'],
      language: 'eng~',
    };
    const effectiveQuery =
      'HLA-B*57 `x` carriers AND ("Review`s"[Publication Type]) AND Lee _K[Author] AND "<i class="x">J_ Med</i>"[Journal] AND ("HLA-B*57"[MeSH Terms] AND "Drug*Hypersensitivity"[MeSH Terms]) AND eng~[Language]';

    const run = async () => {
      mockESearch.mockResolvedValue({ count: 1, idList: ['1'], retmax: 1, retstart: 0 });
      const result = await runToolContract(searchArticlesTool, input);
      return { result, raw: contractText(result), text: readCommonMark(contractText(result)) };
    };

    it('renders the effective query as a code span that reads back exactly', async () => {
      const { result, raw, text } = await run();

      expect((result.structuredContent as { effectiveQuery: string }).effectiveQuery).toBe(
        effectiveQuery,
      );
      expect(raw).toContain(`**Effective Query:** \`\`${effectiveQuery}\`\`\n`);
      expect(text).toContain(`⟨strong⟩Effective Query:⟨/strong⟩ ⟨code_inline:${effectiveQuery}⟩`);
    });

    it('renders each applied-filter value as its own code span', async () => {
      const { text } = await run();

      expect(text).toContain('⟨strong⟩Publication types:⟨/strong⟩ ⟨code_inline:Review`s⟩');
      expect(text).toContain('⟨strong⟩Author:⟨/strong⟩ ⟨code_inline:Lee _K⟩');
      expect(text).toContain('⟨strong⟩Journal:⟨/strong⟩ ⟨code_inline:<i class="x">J_ Med</i>⟩');
      expect(text).toContain(
        '⟨strong⟩MeSH terms:⟨/strong⟩ ⟨code_inline:HLA-B*57⟩, ⟨code_inline:Drug*Hypersensitivity⟩',
      );
      expect(text).toContain('⟨strong⟩Language:⟨/strong⟩ ⟨code_inline:eng~⟩');
    });

    it('renders the Search URL as an autolink, never backslash-escaped', async () => {
      const { result, raw, text } = await run();
      const { searchUrl } = result.structuredContent as { searchUrl: string };

      expect(searchUrl).toContain('HLA-B*57');
      expect(raw).toContain(`**Search URL:** <${searchUrl}>\n`);
      const urlLine = text.split('\n').find((line) => line.startsWith('⟨strong⟩Search URL:'));
      expect(urlLine).toMatch(/^⟨strong⟩Search URL:⟨\/strong⟩ ⟨a⟩[^⟨]+⟨\/a⟩$/);
    });
  });

  it('returns the title NCBI double-encodes in ESummary decoded on both surfaces (issue #262)', async () => {
    mockExtractBriefSummaries.mockImplementation(realExtractBriefSummaries);
    mockESearch.mockResolvedValue({ count: 1, idList: ['42138044'], retmax: 20, retstart: 0 });
    mockESummary.mockResolvedValue(parseESummaryXml(APOS_TITLE_ESUMMARY_XML));

    const result = await runToolContract(searchArticlesTool, {
      query: '42138044[pmid]',
      summaryCount: 1,
    });

    const title =
      "Cervical Vestibular-Evoked Myogenic Potentials (cVEMPs) in Parkinson's Disease Patients: Prospective, Case-Control study.";
    expect(
      (result.structuredContent as { summaries: ParsedBriefSummary[] }).summaries[0]?.title,
    ).toBe(title);
    expect(contractText(result)).toContain(`\n#### ${title}\n`);
  });

  describe('count-split note (issue #44)', () => {
    it('explains the asymmetry when summaries.length < pmids.length', () => {
      const blocks = textBlocks(
        searchArticlesTool.format!({
          query: 'glp-1',
          offset: 0,
          pmids: ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10'],
          summaries: [
            { pmid: '1', title: 'A', pubmedUrl: 'https://pubmed.ncbi.nlm.nih.gov/1/' },
            { pmid: '2', title: 'B', pubmedUrl: 'https://pubmed.ncbi.nlm.nih.gov/2/' },
            { pmid: '3', title: 'C', pubmedUrl: 'https://pubmed.ncbi.nlm.nih.gov/3/' },
            { pmid: '4', title: 'D', pubmedUrl: 'https://pubmed.ncbi.nlm.nih.gov/4/' },
            { pmid: '5', title: 'E', pubmedUrl: 'https://pubmed.ncbi.nlm.nih.gov/5/' },
          ],
          searchUrl: 'https://pubmed.ncbi.nlm.nih.gov/?term=glp-1',
          totalCount: 10,
        }),
      );
      const text = blocks[0]?.text ?? '';
      expect(text).toContain('Summaries shown for top 5 of 10 PMIDs');
      expect(text).toContain('summaryCount');
    });

    it('omits the note when summaries.length === pmids.length', () => {
      const blocks = textBlocks(
        searchArticlesTool.format!({
          query: 'glp-1',
          offset: 0,
          pmids: ['1', '2'],
          summaries: [
            { pmid: '1', title: 'A', pubmedUrl: 'https://pubmed.ncbi.nlm.nih.gov/1/' },
            { pmid: '2', title: 'B', pubmedUrl: 'https://pubmed.ncbi.nlm.nih.gov/2/' },
          ],
          searchUrl: 'https://pubmed.ncbi.nlm.nih.gov/?term=glp-1',
          totalCount: 2,
        }),
      );
      expect(blocks[0]?.text).not.toContain('Summaries shown for top');
    });

    it('omits the note when summaries are empty', () => {
      const blocks = textBlocks(
        searchArticlesTool.format!({
          query: 'glp-1',
          offset: 0,
          pmids: ['1', '2'],
          summaries: [],
          searchUrl: 'https://pubmed.ncbi.nlm.nih.gov/?term=glp-1',
          totalCount: 2,
        }),
      );
      expect(blocks[0]?.text).not.toContain('Summaries shown for top');
    });

    describe('at the summaryCount cap (issue #97)', () => {
      /** `format()` sees only the result, so "at the cap" is read off the rendered summary count. */
      const pmids = (n: number) => Array.from({ length: n }, (_, i) => String(i + 1));
      const summaries = (n: number) =>
        pmids(n).map((pmid) => ({
          pmid,
          title: `Article ${pmid}`,
          pubmedUrl: `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`,
        }));

      it('points at pubmed_fetch_articles when the cap is reached', () => {
        const blocks = textBlocks(
          searchArticlesTool.format!({
            query: 'glp-1',
            offset: 0,
            pmids: pmids(60),
            summaries: summaries(50),
            searchUrl: 'https://pubmed.ncbi.nlm.nih.gov/?term=glp-1',
            totalCount: 60,
          }),
        );
        const text = blocks[0]?.text ?? '';
        expect(text).toContain('Summaries shown for top 50 of 60 PMIDs');
        expect(text).toContain('`summaryCount` is at its maximum (50)');
        expect(text).toContain('Fetch the remaining 10 with `pubmed_fetch_articles`');
        expect(text).not.toContain('Increase `summaryCount`');
      });

      it('still advises raising summaryCount below the cap', () => {
        const blocks = textBlocks(
          searchArticlesTool.format!({
            query: 'glp-1',
            offset: 0,
            pmids: pmids(60),
            summaries: summaries(49),
            searchUrl: 'https://pubmed.ncbi.nlm.nih.gov/?term=glp-1',
            totalCount: 60,
          }),
        );
        const text = blocks[0]?.text ?? '';
        expect(text).toContain('Increase `summaryCount` (max 50)');
        expect(text).not.toContain('pubmed_fetch_articles');
      });
    });
  });

  it('formats summaries with article metadata and links', () => {
    const blocks = textBlocks(
      searchArticlesTool.format!({
        query: 'asthma',
        offset: 0,
        pmids: ['111'],
        summaries: [
          {
            pmid: '111',
            title: 'Asthma Outcomes',
            authors: 'Smith J',
            source: 'Nature',
            pubDate: '2024-01-01',
            doi: '10.1000/example',
            pmcId: 'PMC12345',
            pubmedUrl: 'https://pubmed.ncbi.nlm.nih.gov/111/',
            pmcUrl: 'https://www.ncbi.nlm.nih.gov/pmc/articles/PMC12345/',
          },
        ],
        searchUrl: 'https://pubmed.ncbi.nlm.nih.gov/?term=asthma',
        totalCount: 1,
      }),
    );

    expect(blocks[0]?.text).toContain('### Summaries');
    expect(blocks[0]?.text).toContain('Asthma Outcomes');
    expect(blocks[0]?.text).toContain('**Authors:** Smith J');
    expect(blocks[0]?.text).toContain('**Source:** Nature');
    expect(blocks[0]?.text).toContain('**Published:** 2024-01-01');
    expect(blocks[0]?.text).toContain('**DOI:** 10.1000/example');
    expect(blocks[0]?.text).toContain('**PMCID:** PMC12345');
    expect(blocks[0]?.text).toContain('**PubMed:** https://pubmed.ncbi.nlm.nih.gov/111/');
    expect(blocks[0]?.text).toContain(
      '**PMC:** https://www.ncbi.nlm.nih.gov/pmc/articles/PMC12345/',
    );
  });
});

describe('searchArticlesTool format() heading escaping (issue #102)', () => {
  const render = (title?: string) =>
    textBlocks(
      searchArticlesTool.format!({
        query: 'cancer',
        offset: 0,
        pmids: ['42'],
        summaries: [
          {
            pmid: '42',
            ...(title !== undefined && { title }),
            pubmedUrl: 'https://pubmed.ncbi.nlm.nih.gov/42/',
          },
        ],
        searchUrl: 'https://pubmed.ncbi.nlm.nih.gov/?term=cancer',
        totalCount: 1,
      }),
    )[0]?.text ?? '';

  it('renders a hostile title without adding a heading or a link', () => {
    const text = render('# Injected\n[Retracted](https://evil.test) *emphasis* <i>PIP2;1</i>');
    const headings = text.split('\n').filter((line) => line.startsWith('#'));
    expect(headings).toEqual([
      '## PubMed Search Results',
      '### Summaries',
      '#### # Injected \\[Retracted\\](https://evil.test) \\*emphasis\\* \\<i>PIP2;1\\</i>',
    ]);
  });

  it('leaves a legible title untouched', () => {
    const title = 'TP53_mutant tumours at 5*g where P<0.001 in ~250 patients';
    expect(render(title)).toContain(`#### ${title}`);
  });

  it('escapes the PMID fallback heading the same way when no title is present', () => {
    expect(render(undefined)).toContain('#### 42');
  });
});

describe('searchArticlesTool format() escaping of the other summary fields (issue #255)', () => {
  it('escapes authors, editors, source, book, doc type, date and DOI', () => {
    const text =
      textBlocks(
        searchArticlesTool.format!({
          query: 'cancer',
          offset: 0,
          pmids: ['42'],
          summaries: [
            {
              pmid: '42',
              title: 'Plain title',
              authors: 'Smith *A*, Lee <b>B</b>',
              editors: ['Adam _MP_', '[Bick](x)'],
              source: 'J *Bold* Res',
              bookTitle: 'GeneReviews(®) *2*',
              publisherName: 'Univ ~WA~',
              docType: '`chapter`',
              pubDate: '2026 *Mar*',
              doi: '10.1000/[abc](def)',
              pubmedUrl: 'https://pubmed.ncbi.nlm.nih.gov/42/',
            },
          ],
          searchUrl: 'https://pubmed.ncbi.nlm.nih.gov/?term=cancer',
          totalCount: 1,
        }),
      )[0]?.text ?? '';

    expect(text).toContain('**Authors:** Smith \\*A\\*, Lee \\<b>B\\</b>');
    expect(text).toContain('**Editors:** Adam \\_MP\\_, \\[Bick\\](x)');
    expect(text).toContain('**Source:** J \\*Bold\\* Res');
    expect(text).toContain('**Book:** GeneReviews(®) \\*2\\* — Univ \\~WA\\~');
    expect(text).toContain('**Doc Type:** \\`chapter\\`');
    expect(text).toContain('**Published:** 2026 \\*Mar\\*');
    expect(text).toContain('**DOI:** 10.1000/\\[abc\\](def)');
  });

  it('keeps every lone delimiter visible across the lines of one summary (issue #261)', () => {
    const text =
      textBlocks(
        searchArticlesTool.format!({
          query: 'cancer',
          offset: 0,
          pmids: ['42'],
          summaries: [
            {
              pmid: '42',
              title: 'HLA-B*57:01 carriers',
              authors: 'Smith J*, Lee _K',
              editors: ['Doe A~'],
              source: 'J_ Med*',
              bookTitle: '5` UTR',
              publisherName: '3` end',
              docType: 'chapter~',
              pubDate: '2026 Mar',
              doi: '10.1/x_',
            },
          ],
          searchUrl: 'https://pubmed.ncbi.nlm.nih.gov/?term=cancer',
          totalCount: 1,
        }),
      )[0]?.text ?? '';

    // The heading is one inline run: its lone `*` stays raw.
    expect(text).toContain('\n#### HLA-B*57:01 carriers\n');
    expect(readCommonMark(text.slice(text.indexOf('**PMID:**')))).toBe(
      [
        '⟨strong⟩PMID:⟨/strong⟩ 42',
        '⟨strong⟩Authors:⟨/strong⟩ Smith J*, Lee _K',
        '⟨strong⟩Editors:⟨/strong⟩ Doe A~',
        '⟨strong⟩Source:⟨/strong⟩ J_ Med*',
        '⟨strong⟩Book:⟨/strong⟩ 5` UTR — 3` end',
        '⟨strong⟩Doc Type:⟨/strong⟩ chapter~',
        '⟨strong⟩Published:⟨/strong⟩ 2026 Mar',
        '⟨strong⟩DOI:⟨/strong⟩ 10.1/x_',
      ].join('\n'),
    );
  });
});

describe('searchArticlesTool Bookshelf summaries (issue #114)', () => {
  beforeEach(() => {
    mockESearch.mockReset();
    mockESummary.mockReset();
    mockExtractBriefSummaries.mockReset();
    // The real parser, so the book fields are read from an upstream ESummary
    // body rather than hand-built here.
    mockExtractBriefSummaries.mockImplementation(realExtractBriefSummaries);
    mockESearch.mockResolvedValue({
      count: 2,
      idList: ['20301425', '29262038'],
      retmax: 20,
      retstart: 0,
      queryTranslation: 'BRCA1 AND booksdocs[filter]',
    });
    mockESummary.mockResolvedValue(parseESummaryXml(BOOK_ESUMMARY_XML));
  });

  const search = async () => {
    const ctx = createMockContext({ errors: searchArticlesTool.errors });
    const input = searchArticlesTool.input.parse({
      query: 'BRCA1 AND booksdocs[filter]',
      summaryCount: 2,
    });
    return { result: await searchArticlesTool.handler(input, ctx), ctx };
  };

  it('surfaces the book venue and the editor/author split a Bookshelf record carries', async () => {
    const { result } = await search();

    expect(result.summaries[0]).toMatchObject({
      pmid: '20301425',
      // ESummary leaves Source empty on a book record — the venue is the book.
      bookTitle: 'GeneReviews(®)',
      publisherName: 'University of Washington, Seattle',
      docType: 'chapter',
      authors: 'Petrucelli N, Daly MB, Pal T',
      editors: ['Adam MP', 'Bick S', 'Mirzaa GM', 'Wallace SE', 'Amemiya A'],
    });
    expect(result.summaries[0]?.source).toBeUndefined();
    expect(result.summaries[1]).toMatchObject({
      pmid: '29262038',
      bookTitle: 'StatPearls',
      publisherName: 'StatPearls Publishing',
      docType: 'chapter',
    });
    expect(result.summaries[1]?.editors).toBeUndefined();
  });

  it('renders a Book line in place of Source, with the editors and doc type', async () => {
    const { result } = await search();
    const text = textBlocks(searchArticlesTool.format!(result))[0]?.text ?? '';

    expect(text).toContain('**Book:** GeneReviews(®) — University of Washington, Seattle');
    expect(text).toContain('**Editors:** Adam MP, Bick S, Mirzaa GM, Wallace SE, Amemiya A');
    expect(text).toContain('**Doc Type:** chapter');
    expect(text).toContain('**Authors:** Petrucelli N, Daly MB, Pal T');
    expect(text).not.toContain('**Source:**');
  });
});

describe('searchArticlesTool Bookshelf chapter dates (issue #199)', () => {
  /** PMID → expected summary date: chapters by their own date, the rest unchanged. */
  const EXPECTED: [string, string][] = [
    ['20301340', '2018-12-20'], // chapter, revised — book PubDate 1993
    ['25905212', '2025-07-03'], // chapter, contributed — book PubDate 2000
    ['36356174', '2021-09-01'], // chapter, "2021 Sep" — book PubDate 2014
    ['42330151', '2026-01-01'], // chapter, "2026" — book PubDate 2025 Dec 4
    ['40825089', '2025-07-02'], // whole book, PubDate "2025 Jul 2"
    ['42474064', '2026-07-01'], // journal article, PubDate "2026 Jul"
  ];

  beforeEach(() => {
    mockESearch.mockReset();
    mockESummary.mockReset();
    mockExtractBriefSummaries.mockReset();
    mockExtractBriefSummaries.mockImplementation(realExtractBriefSummaries);
    mockESearch.mockResolvedValue({
      count: EXPECTED.length,
      idList: EXPECTED.map(([pmid]) => pmid),
      retmax: 20,
      retstart: 0,
      queryTranslation: 'x',
    });
    mockESummary.mockResolvedValue(parseESummaryXml(CHAPTER_DATES_ESUMMARY_XML));
  });

  it('dates each summary on both surfaces, chapters by their own date', async () => {
    const result = await runToolContract(searchArticlesTool, {
      query: 'x',
      summaryCount: EXPECTED.length,
    });

    const summaries = (result.structuredContent as { summaries: ParsedBriefSummary[] }).summaries;
    expect(summaries.map((s) => [s.pmid, s.pubDate])).toEqual(EXPECTED);

    // content[]: each summary block carries the same date as its structured row
    const blocks = contractText(result).split('\n#### ').slice(1);
    expect(blocks).toHaveLength(EXPECTED.length);
    for (const [pmid, date] of EXPECTED) {
      const block = blocks.find((b) => b.includes(`**PMID:** ${pmid}\n`));
      expect(block, pmid).toContain(`**Published:** ${date}\n`);
    }
  });

  it('describes pubDate as the chapter date on a Bookshelf chapter', () => {
    const schema = toJSONSchema(searchArticlesTool.output as never) as unknown as {
      properties: { summaries: { items: { properties: { pubDate: { description?: string } } } } };
    };
    const description = schema.properties.summaries.items.properties.pubDate.description ?? '';
    expect(description).toContain('YYYY-MM-DD');
    expect(description).toContain('chapter');
  });
});

describe('searchArticlesTool total match count in the header (issue #147)', () => {
  beforeEach(() => {
    mockESearch.mockReset();
    mockESummary.mockReset();
    mockExtractBriefSummaries.mockReset();
    mockExtractBriefSummaries.mockResolvedValue([]);
  });

  const search = (count: number, idList: string[], input: Record<string, unknown> = {}) => {
    mockESearch.mockResolvedValue({ count, idList, retmax: 20, retstart: 0 });
    return runToolContract(searchArticlesTool, { query: 'alphafold protein structure', ...input });
  };

  it('puts the total beside Returned on a page capped below it', async () => {
    const result = await search(2924, ['111', '222', '333'], { maxResults: 3 });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      pmids: ['111', '222', '333'],
      totalCount: 2924,
    });
    const text = contractText(result);
    expect(text).toContain('**Returned:** 3 of 2924 | **Offset:** 0');
    // Stated once, in the header — never again as a trailer line.
    expect(text).not.toContain('2924 total');
    expect(text.match(/2924/g)).toHaveLength(1);
  });

  it('reads 0 of 0 on an empty result, with the empty-result notice intact', async () => {
    const result = await search(0, []);

    expect(result.structuredContent).toMatchObject({ pmids: [], totalCount: 0 });
    const text = contractText(result);
    expect(text).toContain('**Returned:** 0 of 0 | **Offset:** 0');
    expect(text).toContain('No results matched your query');
    expect(text).not.toContain('0 total');
  });

  it('reads 0 of the total when the offset is past the end', async () => {
    const result = await search(100, [], { offset: 200 });

    expect(result.structuredContent).toMatchObject({ pmids: [], offset: 200, totalCount: 100 });
    const text = contractText(result);
    expect(text).toContain('**Returned:** 0 of 100 | **Offset:** 200');
    expect(text).toContain('Offset 200 exceeds totalCount (100)');
  });

  it('keeps the rest of the trailer — effective query and applied filters', async () => {
    const result = await search(5, ['111'], { author: 'Smith J' });

    const text = contractText(result);
    expect(text).toContain('**Returned:** 1 of 5 | **Offset:** 0');
    expect(readCommonMark(text)).toContain(
      '⟨strong⟩Effective Query:⟨/strong⟩ ⟨code_inline:alphafold protein structure AND Smith J[Author]⟩',
    );
    expect(text).toContain('- **Author:** `Smith J`');
  });
});

describe('searchArticlesTool Doc Type rendering (issue #146)', () => {
  beforeEach(() => {
    mockESearch.mockReset();
    mockESummary.mockReset();
    mockExtractBriefSummaries.mockReset();
    mockESummary.mockResolvedValue({ eSummaryResult: {} });
  });

  /** Journal rows around one Bookshelf row, as a mixed ESummary page arrives. */
  const run = (bookDocType: string) => {
    mockESearch.mockResolvedValue({
      count: 3,
      idList: ['111', '20301425', '222'],
      retmax: 20,
      retstart: 0,
    });
    mockExtractBriefSummaries.mockResolvedValue([
      { pmid: '111', title: 'Journal A', source: 'Nature', docType: 'citation' },
      {
        pmid: '20301425',
        title: 'Book record',
        bookTitle: 'GeneReviews(®)',
        publisherName: 'University of Washington, Seattle',
        docType: bookDocType,
      },
      { pmid: '222', title: 'Journal B', source: 'Science', docType: 'citation' },
    ]);
    return runToolContract(searchArticlesTool, { query: 'brca1', summaryCount: 3 });
  };

  it('drops the line for an ordinary journal row and keeps it for the Bookshelf row', async () => {
    const result = await run('chapter');

    const text = contractText(result);
    expect(text).not.toContain('**Doc Type:** citation');
    expect(text.match(/\*\*Doc Type:\*\*/g)).toHaveLength(1);
    expect(text).toContain('**Doc Type:** chapter');
    expect(text).toContain('**Source:** Nature');
    expect(text).toContain('**Source:** Science');
  });

  it('leaves structuredContent.summaries[].docType untouched, citation included', async () => {
    const result = await run('chapter');

    const { summaries } = result.structuredContent as { summaries: { docType?: string }[] };
    expect(summaries.map((s) => s.docType)).toEqual(['citation', 'chapter', 'citation']);
  });

  it.each(['book', 'report'])('keeps rendering any other value (%s)', async (docType) => {
    const text = contractText(await run(docType));

    expect(text).toContain(`**Doc Type:** ${docType}`);
    expect(text).not.toContain('**Doc Type:** citation');
  });
});

/**
 * NCBI failing every ESearch attempt, through the real NCBI service — client, response
 * handler, request queue, and retry loop — on a fake clock. Whether the loop stops after
 * its last retry or because the next backoff would overrun the total deadline, the caller
 * gets NCBI's own message as `ncbi_unreachable`; only a deadline that actually fires is
 * `ncbi_deadline_exceeded`. (#174)
 */
describe('searchArticlesTool count-only search, maxResults: 0 (issue #191)', () => {
  beforeEach(() => {
    mockESearch.mockReset();
    mockESummary.mockReset();
    mockESummary.mockRejectedValue(new Error('unmocked eSummary'));
    mockExtractBriefSummaries.mockReset();
    mockExtractBriefSummaries.mockResolvedValue([]);
  });

  /** ESearch's answer to `retmax=0`: the full Count and an empty IdList. */
  const countOnly = (count: number, retstart = 0) =>
    mockESearch.mockResolvedValue({ count, idList: [], retmax: 0, retstart });

  it('the handler already sends retmax 0, skips ESummary, and renders 0 of the total', async () => {
    countOnly(31104);
    const ctx = createMockContext({ errors: searchArticlesTool.errors });
    const input = {
      ...searchArticlesTool.input.parse({ query: 'ferroptosis', summaryCount: 5 }),
      maxResults: 0,
    };

    const output = await searchArticlesTool.handler(input, ctx);

    expect(mockESearch).toHaveBeenCalledTimes(1);
    expect(mockESearch.mock.calls[0]?.[0]).toMatchObject({ term: 'ferroptosis', retmax: 0 });
    expect(mockESummary).not.toHaveBeenCalled();
    expect(output).toMatchObject({ pmids: [], summaries: [], totalCount: 31104 });
    expect(getEnrichment(ctx).notice).toBeUndefined();
    const text = (searchArticlesTool.format!(output)[0] as { text: string }).text;
    expect(text).toContain('**Returned:** 0 of 31104 | **Offset:** 0');
    expect(text).not.toContain('**PMIDs:**');
  });

  it.each([
    ['without summaryCount', {}],
    ['with summaryCount: 5', { summaryCount: 5 }],
  ])('returns only totalCount from one ESearch, %s', async (_label, extra) => {
    countOnly(31104);
    const result = await runToolContract(searchArticlesTool, {
      query: 'ferroptosis',
      maxResults: 0,
      ...extra,
    });

    expect(result.isError).toBeFalsy();
    expect(mockESearch).toHaveBeenCalledTimes(1);
    expect(mockESearch.mock.calls[0]?.[0]).toMatchObject({
      term: 'ferroptosis',
      retmax: 0,
      retstart: 0,
    });
    expect(mockESummary).not.toHaveBeenCalled();
    const structured = result.structuredContent as Record<string, unknown>;
    expect(structured).toMatchObject({ pmids: [], summaries: [], totalCount: 31104, offset: 0 });
    expect(structured.notice).toBeUndefined();
    const text = contractText(result);
    expect(text).toContain('**Returned:** 0 of 31104 | **Offset:** 0');
    expect(text).not.toContain('**PMIDs:**');
    expect(text).not.toContain('Summaries shown');
    expect(text).not.toContain('No results matched');
  });

  it('reports the same totalCount a maxResults: 1 call does', async () => {
    mockESearch.mockResolvedValueOnce({ count: 31104, idList: [], retmax: 0, retstart: 0 });
    mockESearch.mockResolvedValueOnce({ count: 31104, idList: ['42600474'], retmax: 1 });
    const countOnlyResult = await runToolContract(searchArticlesTool, {
      query: 'ferroptosis',
      maxResults: 0,
    });
    const oneResult = await runToolContract(searchArticlesTool, {
      query: 'ferroptosis',
      maxResults: 1,
    });

    expect(countOnlyResult.structuredContent).toMatchObject({ totalCount: 31104, pmids: [] });
    expect(oneResult.structuredContent).toMatchObject({ totalCount: 31104, pmids: ['42600474'] });
  });

  it('gives a zero-hit query the notice it gets with maxResults: 1', async () => {
    countOnly(0);
    const zero = await runToolContract(searchArticlesTool, { query: 'qqzzxx', maxResults: 0 });
    const one = await runToolContract(searchArticlesTool, { query: 'qqzzxx', maxResults: 1 });

    const zeroNotice = (zero.structuredContent as { notice?: string }).notice;
    expect(zeroNotice).toContain('No results matched your query');
    expect(zeroNotice).toBe((one.structuredContent as { notice?: string }).notice);
    expect(contractText(zero)).toContain('**Returned:** 0 of 0 | **Offset:** 0');
  });

  it('keeps the overshoot notice for an offset at or past totalCount', async () => {
    countOnly(100, 100);
    const result = await runToolContract(searchArticlesTool, {
      query: 'ferroptosis',
      maxResults: 0,
      offset: 100,
    });

    expect(mockESearch.mock.calls[0]?.[0]).toMatchObject({ retmax: 0, retstart: 100 });
    expect((result.structuredContent as { notice?: string }).notice).toBe(
      'Offset 100 exceeds totalCount (100). Reset offset to 0 or reduce it below 100 to page through results.',
    );
    expect(contractText(result)).toContain('Offset 100 exceeds totalCount (100)');
  });

  it('adds no notice for a count-only call at an offset inside the result set', async () => {
    countOnly(100, 5);
    const result = await runToolContract(searchArticlesTool, {
      query: 'ferroptosis',
      maxResults: 0,
      offset: 5,
    });

    expect(result.structuredContent).toMatchObject({ pmids: [], offset: 5, totalCount: 100 });
    expect((result.structuredContent as { notice?: string }).notice).toBeUndefined();
    expect(contractText(result)).toContain('**Returned:** 0 of 100 | **Offset:** 5');
  });

  it('gives `retmax: 0` (#190) the same result as `maxResults: 0`', async () => {
    countOnly(31104);
    const viaTarget = await runToolContract(searchArticlesTool, {
      query: 'ferroptosis',
      maxResults: 0,
    });
    const viaAlias = await runToolContract(searchArticlesTool, {
      query: 'ferroptosis',
      retmax: 0,
    } as never);

    expect(viaAlias.isError).toBeFalsy();
    expect(mockESearch.mock.calls[1]?.[0]).toEqual(mockESearch.mock.calls[0]?.[0]);
    expect(viaAlias.structuredContent).toEqual(viaTarget.structuredContent);
    expect(viaAlias.content).toEqual(viaTarget.content);
    expect(mockESummary).not.toHaveBeenCalled();
  });

  it.each([[-1], [1001]])('still rejects maxResults: %d', async (maxResults) => {
    const result = await runToolContract(searchArticlesTool, { query: 'ferroptosis', maxResults });

    expect(result.isError).toBe(true);
    expect(contractText(result)).toContain('maxResults: Too');
    expect(mockESearch).not.toHaveBeenCalled();
  });

  it('advertises maxResults with minimum 0 and says what 0 returns', () => {
    const emitted = toJSONSchema(searchArticlesTool.input as never, {
      target: 'draft-7',
      io: 'input',
    }) as { properties: Record<string, Record<string, unknown>> };

    expect(emitted.properties.maxResults).toMatchObject({
      type: 'integer',
      minimum: 0,
      maximum: 1000,
      default: 20,
    });
    expect(emitted.properties.maxResults?.description).toContain('0 returns only `totalCount`');
  });
});

describe('searchArticlesTool against a failing NCBI backend (issue #174)', () => {
  const BACKEND_FAILURE =
    'Search Backend failed: An error occurred while processing request. Status: 500. Source: /api/search/?r= Details: Search is temporarily unavailable. Please try again later. Details: Cannot connect to SOLR';
  /** NCBI's search-backend-failure envelope, answered with HTTP 200. */
  const ENVELOPE = `<?xml version="1.0" encoding="UTF-8" ?>\n<!DOCTYPE eSearchResult PUBLIC "-//NLM//DTD esearch 20060628//EN" "https://eutils.ncbi.nlm.nih.gov/eutils/dtd/20060628/esearch.dtd">\n<eSearchResult>\n\t<ERROR>${BACKEND_FAILURE}</ERROR>\n</eSearchResult>\n`;

  /**
   * The tool bound to the real NCBI service. Every NCBI setting the case does not name is
   * blanked, which the config reads as unset, so it takes its default.
   */
  async function loadTool(env: Record<string, string>) {
    vi.resetModules();
    vi.doUnmock('@/services/ncbi/ncbi-service.js');
    vi.doUnmock('@/services/ncbi/parsing/esummary-parser.js');
    const settings = {
      NCBI_API_KEY: '',
      NCBI_REQUEST_DELAY_MS: '',
      NCBI_MAX_CONCURRENT: '',
      NCBI_MAX_RETRIES: '',
      NCBI_TIMEOUT_MS: '',
      NCBI_TOTAL_DEADLINE_MS: '',
      ...env,
    };
    for (const [name, value] of Object.entries(settings)) vi.stubEnv(name, value);
    const { initNcbiService } = await import('@/services/ncbi/ncbi-service.js');
    initNcbiService();
    const module = await import('@/mcp-server/tools/definitions/search-articles.tool.js');
    return module.searchArticlesTool;
  }

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it.each([
    { settings: 'default settings', env: {}, jitter: 'low', random: 0, attempts: 7 },
    { settings: 'default settings', env: {}, jitter: 'high', random: 0.999, attempts: 6 },
    {
      settings: 'NCBI_TOTAL_DEADLINE_MS=20000',
      env: { NCBI_TOTAL_DEADLINE_MS: '20000' },
      jitter: 'low',
      random: 0,
      attempts: 5,
    },
    {
      settings: 'NCBI_TOTAL_DEADLINE_MS=20000',
      env: { NCBI_TOTAL_DEADLINE_MS: '20000' },
      jitter: 'high',
      random: 0.999,
      attempts: 5,
    },
  ])(
    'returns NCBI’s message as ncbi_unreachable at $settings with $jitter backoff jitter',
    async ({ env, random, attempts }) => {
      vi.spyOn(Math, 'random').mockReturnValue(random);
      const fetchSpy = vi
        .spyOn(globalThis, 'fetch')
        .mockImplementation(() => Promise.resolve(new Response(ENVELOPE, { status: 200 })));
      const tool = await loadTool(env);

      const pending = runToolContract(tool, { query: 'asthma', maxResults: 1 });
      await vi.advanceTimersByTimeAsync(61_000);
      const result = await pending;

      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: {
          code: JsonRpcErrorCode.ServiceUnavailable,
          message: `NCBI API Error: ${BACKEND_FAILURE} (failed after ${attempts} attempts)`,
          data: {
            reason: 'ncbi_unreachable',
            endpoint: 'esearch',
            attempts,
            ncbiErrors: [BACKEND_FAILURE],
            recovery: {
              hint: expect.stringContaining('NCBI failed on every attempt this call made'),
            },
          },
        },
      });
      const text = contractText(result);
      expect(text).toContain(BACKEND_FAILURE);
      expect(text).toContain('NCBI failed on every attempt this call made');
      expect(text).not.toMatch(/deadline/i);
      expect(fetchSpy).toHaveBeenCalledTimes(attempts);
    },
  );

  it('reports a request the deadline aborts in flight as ncbi_deadline_exceeded, leading its hint with a retry', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(
      (_url, init) =>
        new Promise<Response>((_, reject) => {
          const signal = init?.signal as AbortSignal;
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        }),
    );
    const tool = await loadTool({ NCBI_TOTAL_DEADLINE_MS: '5000' });

    const pending = runToolContract(tool, { query: 'asthma', maxResults: 1 });
    await vi.advanceTimersByTimeAsync(5000);
    const result = await pending;

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.Timeout,
        message: 'NCBI request deadline (5000ms) exceeded',
        data: {
          reason: 'ncbi_deadline_exceeded',
          deadlineMs: 5000,
          recovery: { hint: expect.stringMatching(/^Retry\b/) },
        },
      },
    });
    const { hint } = (
      result.structuredContent as { error: { data: { recovery: { hint: string } } } }
    ).error.data.recovery;
    // A single search has no batch to reduce: batch size is only a conditional.
    expect(hint).toMatch(/For a large batch, /);
    expect(hint).not.toMatch(/^Reduce batch size/);
    expect(contractText(result)).toContain(hint);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  /** A request that never answers: it rejects with the signal's reason once that aborts. */
  const hangUntilAborted = (init?: RequestInit) =>
    new Promise<Response>((_, reject) => {
      const signal = init?.signal as AbortSignal;
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });

  const deadlineWithNcbiErrors = {
    error: {
      code: JsonRpcErrorCode.Timeout,
      message: 'NCBI request deadline (5000ms) exceeded',
      data: {
        reason: 'ncbi_deadline_exceeded',
        deadlineMs: 5000,
        ncbiErrors: [BACKEND_FAILURE],
      },
    },
  };

  it('keeps NCBI’s diagnostics when the deadline aborts a later attempt in flight', async () => {
    // Attempt 1 answers the envelope at once. After its 1s backoff, attempt 2 hangs until
    // the 5s deadline aborts it, and that abort carries no NCBI diagnostics of its own.
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    let calls = 0;
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation((_url, init) =>
        calls++ === 0
          ? Promise.resolve(new Response(ENVELOPE, { status: 200 }))
          : hangUntilAborted(init),
      );
    const tool = await loadTool({ NCBI_TOTAL_DEADLINE_MS: '5000' });

    const pending = runToolContract(tool, { query: 'asthma', maxResults: 1 });
    await vi.advanceTimersByTimeAsync(5000);
    const result = await pending;

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject(deadlineWithNcbiErrors);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('keeps NCBI’s diagnostics when the deadline expires while a later attempt is queued', async () => {
    // One request slot. Attempt 1 answers the envelope at once; during its 1s backoff a
    // second call takes the slot with a request that never settles, so attempt 2 waits in
    // the queue until the 5s deadline expires there.
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation((url) =>
        String(url).includes('term=blocker')
          ? new Promise<Response>(() => {})
          : Promise.resolve(new Response(ENVELOPE, { status: 200 })),
      );
    const tool = await loadTool({ NCBI_TOTAL_DEADLINE_MS: '5000', NCBI_MAX_CONCURRENT: '1' });

    const pending = runToolContract(tool, { query: 'asthma', maxResults: 1 });
    await vi.advanceTimersByTimeAsync(100);
    void runToolContract(tool, { query: 'blocker' });
    await vi.advanceTimersByTimeAsync(4900);
    const result = await pending;

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject(deadlineWithNcbiErrors);
    // Attempt 2 never left the queue: the call under test reached NCBI once.
    const own = fetchSpy.mock.calls.filter(([url]) => !String(url).includes('term=blocker'));
    expect(own).toHaveLength(1);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  /**
   * NCBI throttling every attempt with HTTP 429. However the loop stops on the 429 —
   * retries spent, or a Retry-After longer than the backoff cap — the caller gets
   * `ncbi_rate_limited`, NCBI's Retry-After, and a recovery naming the server's API-key
   * setting, on both surfaces.
   */
  const RATE_LIMIT_BODY = '{"error":"API rate limit exceeded","count":"4","limit":"3"}';

  it.each([
    {
      path: 'retries are spent',
      env: { NCBI_MAX_RETRIES: '1' },
      retryAfter: '1',
      message: 'NCBI returned HTTP 429. (failed after 2 attempts)',
      fetches: 2,
    },
    {
      path: 'its Retry-After outlasts the backoff cap',
      env: {},
      retryAfter: '40',
      message: 'NCBI returned HTTP 429.',
      fetches: 1,
    },
  ])(
    'reports a throttled NCBI as ncbi_rate_limited with its hint when $path',
    async ({ env, retryAfter, message, fetches }) => {
      vi.spyOn(Math, 'random').mockReturnValue(0.5);
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() =>
        Promise.resolve(
          new Response(RATE_LIMIT_BODY, {
            status: 429,
            headers: { 'content-type': 'application/json', 'retry-after': retryAfter },
          }),
        ),
      );
      const tool = await loadTool(env);

      const pending = runToolContract(tool, { query: 'asthma', maxResults: 1 });
      await vi.advanceTimersByTimeAsync(5000);
      const result = await pending;

      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: {
          code: JsonRpcErrorCode.RateLimited,
          message,
          data: {
            reason: 'ncbi_rate_limited',
            endpoint: 'esearch',
            retryAfter,
            recovery: { hint: expect.stringContaining('NCBI_API_KEY') },
          },
        },
      });
      const { hint } = (
        result.structuredContent as { error: { data: { recovery: { hint: string } } } }
      ).error.data.recovery;
      const text = readCommonMark(contractText(result));
      expect(text).toContain(message);
      expect(text).toContain(hint);
      expect(text).toContain('reason ncbi_rate_limited');
      expect(fetchSpy).toHaveBeenCalledTimes(fetches);
    },
  );
});

describe('withoutFormattingTags — which tags are removed (issue #260)', () => {
  // A bare opener (`<i>`) is removed and so is the closer that pairs with it; an
  // opener with attributes and its closer are kept; a closer with nothing of its
  // name open is removed. Pairing runs per tag name, innermost first.
  it.each([
    ['a bare pair', '<i>x</i>', 'x'],
    ['an attribute-bearing pair', '<i class="a">x</i>', '<i class="a">x</i>'],
    ['an attribute-bearing pair, any case', '<I CLASS="a">x</i>', '<I CLASS="a">x</i>'],
    [
      'a bare pair inside an attribute-bearing one',
      '<i class="a"><i>x</i></i>',
      '<i class="a">x</i>',
    ],
    [
      'an attribute-bearing pair inside a bare one',
      '<i><i class="a">x</i></i>',
      '<i class="a">x</i>',
    ],
    ['a bare tag of another name inside', '<i class="a"><b>x</i></b>', '<i class="a">x</i>'],
    [
      'a stray closer after an attribute-bearing pair',
      '<b id="1">x</b> y</b>',
      '<b id="1">x</b> y',
    ],
    ['a closer of another name only', '<i class="a">x</b>', '<i class="a">x'],
    ['a closer before its opener', '</u>x<u title="t">', 'x<u title="t">'],
    ['an unclosed attribute-bearing opener', '<em lang="la">x', '<em lang="la">x'],
    ['bare closers with nothing open', 'x</strong></i>', 'x'],
  ])('%s', (_label, text, expected) => {
    expect(withoutFormattingTags(text)).toBe(expected);
  });
});

describe('withoutFormattingTags — linear time on adversarial input (issue #260)', () => {
  /** CPU time of `run`, in ms — this thread's user + system time, not wall clock. */
  const cpuMs = (run: () => void): number => {
    const start = process.threadCpuUsage();
    run();
    const { user, system } = process.threadCpuUsage(start);
    return (user + system) / 1000;
  };

  /** Fastest of three single-call measurements after one warm-up call. */
  const fastestMs = (text: string): number => {
    withoutFormattingTags(text);
    return Math.min(...Array.from({ length: 3 }, () => cpuMs(() => withoutFormattingTags(text))));
  };

  /** The text is sent unchanged: it holds no complete formatting tag, or only kept ones. */
  const unchanged = (text: string) => text;
  const removed = () => '';

  it.each<[string, (n: number) => string, (text: string, n: number) => string]>([
    ['an opener with no closing bracket, repeated', (n) => '<i'.repeat(n / 2), unchanged],
    [
      'a closer prefix that never completes, repeated',
      (n) => '</stron'.repeat(Math.floor(n / 7)),
      unchanged,
    ],
    ['nested openers', (n) => `${'<a'.repeat(n / 4)}${'>'.repeat(n / 2)}`, unchanged],
    ['a formatting tag at every position', (n) => '<i>'.repeat(Math.floor(n / 3)), removed],
    [
      'an attribute-bearing opener, repeated',
      (n) => '<i class="a">'.repeat(Math.floor(n / 13)),
      unchanged,
    ],
    ['a closer with nothing open, repeated', (n) => '</i>'.repeat(n / 4), removed],
    [
      'attribute-bearing and bare openers, then their closers',
      (n) =>
        `${'<i class="a"><i>'.repeat(Math.floor(n / 32))}${'</i></i>'.repeat(Math.floor(n / 16))}`,
      // Each kept opener keeps one closer; the bare openers' closers and the
      // closers left over once nothing is open are removed.
      (_text, n) =>
        `${'<i class="a">'.repeat(Math.floor(n / 32))}${'</i>'.repeat(Math.floor(n / 32))}`,
    ],
    ['an attribute-bearing opener that never closes', (n) => '<i a'.repeat(n / 4), unchanged],
    ['one long line ending in a break', (n) => `${'§1 x'.repeat(n / 4)}\ny`, unchanged],
    ['line breaks throughout', (n) => '  \r\n'.repeat(n / 4), unchanged],
  ])('scales linearly from 5k to 320k characters: %s', (_label, build, sent) => {
    // Doubling from 5k, each size checked against the outcome and the absolute
    // bound before the next runs.
    const times: number[] = [];
    for (let n = 5_000; n <= 320_000; n *= 2) {
      const text = build(n);
      expect(withoutFormattingTags(text)).toBe(sent(text, n));
      const ms = fastestMs(text);
      expect(ms).toBeLessThan(200);
      times.push(ms);
    }
    // Linear work grows 64× across the span; quadratic grows 4096×.
    expect((times.at(-1) ?? 0) / Math.max(times[0] ?? 0, 0.05)).toBeLessThan(256);
  });
});
