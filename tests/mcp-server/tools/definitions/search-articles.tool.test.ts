/**
 * @fileoverview Tests for the search-articles tool.
 * @module tests/mcp-server/tools/definitions/search-articles.tool.test
 */

import type { ContentBlock } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ParsedBriefSummary } from '@/services/ncbi/types.js';

import { textBlocks } from '../../../_helpers.js';
import {
  BOOK_ESUMMARY_XML,
  parseESummaryXml,
} from '../../../services/ncbi/parsing/_book-fixtures.js';

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

const { searchArticlesTool } = await import(
  '@/mcp-server/tools/definitions/search-articles.tool.js'
);

/** Every text block of a contract run, joined — the header, the rows, and the trailer. */
const contractText = (result: Awaited<ReturnType<typeof runToolContract>>) =>
  textBlocks(result.content as ContentBlock[])
    .map((b) => b.text)
    .join('\n');

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

    it('rejects an offset above the ceiling before it reaches NCBI', async () => {
      const result = searchArticlesTool.input.safeParse({ query: 'cancer', offset: 9999 });
      expect(result.success).toBe(false);
      expect(mockESearch).not.toHaveBeenCalled();
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
        expect(notice).toContain('`minDate: "1800"`');
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

      const calledTerm = mockESearch.mock.calls.at(-1)?.[0]?.term as string;
      expect(calledTerm).toContain('2020/01/01[pdat]');
      expect(calledTerm).toContain('2024/12/31[pdat]');
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
          const text = contractText(result);
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

      const calledTerm = mockESearch.mock.calls.at(-1)?.[0]?.term as string;
      expect(calledTerm).toContain('2020/01/01[pdat]');
      expect(calledTerm).toContain('2024/12/31[pdat]');
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
    expect(result.searchUrl).toContain('cancer');
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

    const calledTerm = mockESearch.mock.calls[0]?.[0]?.term as string;
    expect(calledTerm).toContain('2020/01/01[mdat]');
    expect(calledTerm).toContain('2024/12/31[mdat]');
    expect(calledTerm).toContain(
      '"Review"[Publication Type] OR "Clinical Trial"[Publication Type]',
    );
    expect(calledTerm).toContain('Smith J[Author]');
    expect(calledTerm).toContain('"Nature"[Journal]');
    expect(calledTerm).toContain('"Asthma"[MeSH Terms] AND "Inflammation"[MeSH Terms]');
    expect(calledTerm).toContain('english[Language]');
    expect(calledTerm).toContain('hasabstract[text word]');
    expect(calledTerm).toContain('free full text[filter]');
    expect(calledTerm).toContain('humans[MeSH Terms]');

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
    expect(enrichment.effectiveQuery).toContain('2020/01/01[mdat]');
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
      expect(contractText(result)).toContain('`query`');
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

      expect(mockESearch.mock.calls[0]?.[0]?.term).toContain('covid');
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

    it('sends a markup-wrapped filter value as its text', async () => {
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
        const text = contractText(result);
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
    expect(blocks[0]?.text).toContain('PubMed Search Results');
    expect(blocks[0]?.text).toContain('cancer');
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
    expect(text).toContain('**Effective Query:** alphafold protein structure AND Smith J[Author]');
    expect(text).toContain('- **Author:** Smith J');
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
      const text = contractText(result);
      expect(text).toContain(message);
      expect(text).toContain(hint);
      expect(text).toContain('reason ncbi_rate_limited');
      expect(fetchSpy).toHaveBeenCalledTimes(fetches);
    },
  );
});
