/**
 * @fileoverview Tests for the Europe PMC record fetch tool — the retrieval path
 * for abstracts `pubmed_europepmc_search` truncates. Parity assertions check the
 * complete abstract on both MCP surfaces: the handler's return value (which
 * becomes `structuredContent`) and the `format()` render (which becomes
 * `content[]`).
 * @module tests/mcp-server/tools/definitions/pubmed-europepmc-fetch.tool.test
 */

import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockFetchRecords = vi.fn();
const mockGetEpmc = vi.fn();

vi.mock('@/services/europe-pmc/europe-pmc-service.js', () => ({
  getEuropePmcService: () => mockGetEpmc(),
}));

const { pubmedEuropepmcFetchTool } = await import(
  '@/mcp-server/tools/definitions/pubmed-europepmc-fetch.tool.js'
);
const { pubmedEuropepmcSearchTool } = await import(
  '@/mcp-server/tools/definitions/pubmed-europepmc-search.tool.js'
);

/** Longer than the search tool's 400-character snippet budget. */
const LONG_ABSTRACT = `A composition for the treatment of cancers. ${'The invention relates to a pharmaceutical composition. '.repeat(12)}`;
const SHORT_ABSTRACT = 'A short abstract that fits inside the search snippet budget.';

const patHit = {
  id: 'KR20120031038',
  source: 'PAT',
  title: 'Composition for the treatment of cancers',
  abstractText: LONG_ABSTRACT,
  inPMC: 'N',
};

const renderedText = (result: Parameters<NonNullable<typeof pubmedEuropepmcFetchTool.format>>[0]) =>
  pubmedEuropepmcFetchTool.format?.(result)[0]?.text ?? '';

describe('pubmedEuropepmcFetchTool', () => {
  beforeEach(() => {
    mockFetchRecords.mockReset();
    mockGetEpmc.mockReset();
    mockGetEpmc.mockReturnValue({ fetchRecords: mockFetchRecords });
  });

  describe('input schema', () => {
    it('accepts a source + epmcId pair', () => {
      const input = pubmedEuropepmcFetchTool.input.parse({
        records: [{ source: 'PAT', epmcId: 'KR20120031038' }],
      });
      expect(input.records).toEqual([{ source: 'PAT', epmcId: 'KR20120031038' }]);
    });

    it('rejects an empty records array', () => {
      expect(pubmedEuropepmcFetchTool.input.safeParse({ records: [] }).success).toBe(false);
    });

    it('rejects more than 25 records', () => {
      const records = Array.from({ length: 26 }, (_, i) => ({
        source: 'MED' as const,
        epmcId: String(i + 1),
      }));
      expect(pubmedEuropepmcFetchTool.input.safeParse({ records }).success).toBe(false);
    });

    it('rejects an epmcId carrying query syntax', () => {
      const parsed = pubmedEuropepmcFetchTool.input.safeParse({
        records: [{ source: 'PAT', epmcId: 'KR123 OR SRC:MED' }],
      });
      expect(parsed.success).toBe(false);
    });

    it('rejects an unknown source', () => {
      const parsed = pubmedEuropepmcFetchTool.input.safeParse({
        records: [{ source: 'CTX', epmcId: 'X1' }],
      });
      expect(parsed.success).toBe(false);
    });
  });

  it('throws with reason europepmc_disabled when the EPMC service is unavailable', async () => {
    mockGetEpmc.mockReturnValue(undefined);
    const ctx = createMockContext({ errors: pubmedEuropepmcFetchTool.errors });
    const input = pubmedEuropepmcFetchTool.input.parse({
      records: [{ source: 'PAT', epmcId: 'KR20120031038' }],
    });
    const promise = pubmedEuropepmcFetchTool.handler(input, ctx);
    await expect(promise).rejects.toThrow(/EUROPEPMC_ENABLED|service is not available/i);
    await expect(promise).rejects.toMatchObject({ data: { reason: 'europepmc_disabled' } });
  });

  it('passes the requested refs straight through to the service', async () => {
    mockFetchRecords.mockResolvedValue([patHit]);
    const ctx = createMockContext();
    const input = pubmedEuropepmcFetchTool.input.parse({
      records: [{ source: 'PAT', epmcId: 'KR20120031038' }],
    });
    await pubmedEuropepmcFetchTool.handler(input, ctx);
    expect(mockFetchRecords).toHaveBeenCalledWith(
      [{ source: 'PAT', epmcId: 'KR20120031038' }],
      ctx.signal,
    );
  });

  it('flattens EPMC `Y`/`N` flags and emits an epmcUrl', async () => {
    mockFetchRecords.mockResolvedValue([
      { id: 'PPR1', source: 'PPR', isOpenAccess: 'Y', inPMC: 'N' },
    ]);
    const ctx = createMockContext();
    const result = await pubmedEuropepmcFetchTool.handler(
      pubmedEuropepmcFetchTool.input.parse({ records: [{ source: 'PPR', epmcId: 'PPR1' }] }),
      ctx,
    );
    expect(result.records[0]?.isOpenAccess).toBe(true);
    expect(result.records[0]?.hasFullTextXml).toBe(false);
    expect(result.records[0]?.epmcUrl).toBe('https://europepmc.org/article/PPR/PPR1');
  });

  it('normalizes the abstract: strips JATS/HTML, decodes entities, drops soft hyphens', async () => {
    mockFetchRecords.mockResolvedValue([
      {
        id: 'PPR2',
        source: 'PPR',
        abstractText: '<h4>Background: </h4> Emergency &amp; clini­cal triage &lt;LLMs&gt;',
      },
    ]);
    const ctx = createMockContext();
    const result = await pubmedEuropepmcFetchTool.handler(
      pubmedEuropepmcFetchTool.input.parse({ records: [{ source: 'PPR', epmcId: 'PPR2' }] }),
      ctx,
    );
    expect(result.records[0]?.abstract).toBe('Background: Emergency & clinical triage <LLMs>');
  });

  it('keeps the results text a P value used to swallow (#94)', async () => {
    mockFetchRecords.mockResolvedValue([
      {
        id: 'PPR3',
        source: 'PPR',
        // Europe PMC ships the `<` of a P value raw, not entity-encoded, so it
        // reaches the tag strip as a literal `<`.
        abstractText:
          '<p>Change was -0.45 (95% CI, -0.67 to -0.23; P<0.001).</p><title>Conclusions</title><p>Treatment slowed decline.</p>',
      },
    ]);
    const ctx = createMockContext();
    const result = await pubmedEuropepmcFetchTool.handler(
      pubmedEuropepmcFetchTool.input.parse({ records: [{ source: 'PPR', epmcId: 'PPR3' }] }),
      ctx,
    );
    expect(result.records[0]?.abstract).toBe(
      'Change was -0.45 (95% CI, -0.67 to -0.23; P<0.001). Conclusions Treatment slowed decline.',
    );
  });

  it('omits `abstract` when Europe PMC carries none', async () => {
    mockFetchRecords.mockResolvedValue([{ id: 'PMC13294766', source: 'PMC' }]);
    const ctx = createMockContext();
    const result = await pubmedEuropepmcFetchTool.handler(
      pubmedEuropepmcFetchTool.input.parse({
        records: [{ source: 'PMC', epmcId: 'PMC13294766' }],
      }),
      ctx,
    );
    expect(result.records[0]?.abstract).toBeUndefined();
    expect(result.notFound).toBeUndefined();
  });

  describe('batch requests', () => {
    it('resolves every record in one service call and reports none missing', async () => {
      mockFetchRecords.mockResolvedValue([
        { id: 'IND609436151', source: 'AGR', abstractText: 'Agricola abstract.' },
        patHit,
        { id: 'PPR1283828', source: 'PPR', abstractText: SHORT_ABSTRACT },
      ]);
      const ctx = createMockContext();
      const input = pubmedEuropepmcFetchTool.input.parse({
        records: [
          { source: 'PAT', epmcId: 'KR20120031038' },
          { source: 'AGR', epmcId: 'IND609436151' },
          { source: 'PPR', epmcId: 'PPR1283828' },
        ],
      });
      const result = await pubmedEuropepmcFetchTool.handler(input, ctx);

      expect(mockFetchRecords).toHaveBeenCalledTimes(1);
      expect(result.records).toHaveLength(3);
      expect(result.notFound).toBeUndefined();
      expect(getEnrichment(ctx).notice).toBeUndefined();

      // Both surfaces carry all three records.
      const text = renderedText(result);
      for (const id of ['KR20120031038', 'IND609436151', 'PPR1283828']) {
        expect(result.records.map((r) => r.epmcId)).toContain(id);
        expect(text).toContain(id);
      }
    });

    it('counts a PMC request satisfied by its canonical MED record as resolved (#94)', async () => {
      // The PMCID clause resolves a PubMed-indexed article to its MED record,
      // whose `id` is the PMID — the requested PMCID arrives in `pmcid`. Keying
      // the diff on `id` alone returned the record and reported it missing in
      // the same response.
      mockFetchRecords.mockResolvedValue([
        { id: '34265844', source: 'MED', pmid: '34265844', pmcid: 'PMC8371605' },
      ]);
      const ctx = createMockContext();
      const result = await pubmedEuropepmcFetchTool.handler(
        pubmedEuropepmcFetchTool.input.parse({
          records: [{ source: 'PMC', epmcId: 'PMC8371605' }],
        }),
        ctx,
      );

      expect(result.records).toHaveLength(1);
      expect(result.records[0]?.source).toBe('MED');
      expect(result.records[0]?.pmcId).toBe('PMC8371605');
      expect(result.notFound).toBeUndefined();
      expect(getEnrichment(ctx).notice).toBeUndefined();
    });

    it('matches the response to the request case-insensitively', async () => {
      mockFetchRecords.mockResolvedValue([{ id: 'PPR1283828', source: 'PPR' }]);
      const ctx = createMockContext();
      const result = await pubmedEuropepmcFetchTool.handler(
        pubmedEuropepmcFetchTool.input.parse({
          records: [{ source: 'PPR', epmcId: 'ppr1283828' }],
        }),
        ctx,
      );
      expect(result.notFound).toBeUndefined();
    });
  });

  describe('unresolved records', () => {
    it('reports a partially-missing batch on both surfaces and in a notice', async () => {
      mockFetchRecords.mockResolvedValue([patHit]);
      const ctx = createMockContext();
      const result = await pubmedEuropepmcFetchTool.handler(
        pubmedEuropepmcFetchTool.input.parse({
          records: [
            { source: 'PAT', epmcId: 'KR20120031038' },
            { source: 'AGR', epmcId: 'IND000000000' },
          ],
        }),
        ctx,
      );

      expect(result.records).toHaveLength(1);
      expect(result.notFound).toEqual([{ source: 'AGR', epmcId: 'IND000000000' }]);
      expect(getEnrichment(ctx).notice).toContain('AGR/IND000000000');
      expect(renderedText(result)).toContain('AGR/IND000000000');
    });

    it('notices an entirely unresolved batch without throwing', async () => {
      mockFetchRecords.mockResolvedValue([]);
      const ctx = createMockContext();
      const result = await pubmedEuropepmcFetchTool.handler(
        pubmedEuropepmcFetchTool.input.parse({
          records: [{ source: 'AGR', epmcId: 'IND000000000' }],
        }),
        ctx,
      );

      expect(result.records).toEqual([]);
      expect(result.notFound).toEqual([{ source: 'AGR', epmcId: 'IND000000000' }]);
      expect(getEnrichment(ctx).notice).toMatch(/no record for any requested pair/i);
      expect(getEnrichment(ctx).notice).not.toContain('pubmed_fetch_fulltext');
    });

    it('points an unresolved PMCID-shaped id at pubmed_fetch_fulltext (#94)', async () => {
      mockFetchRecords.mockResolvedValue([]);
      const ctx = createMockContext();
      const result = await pubmedEuropepmcFetchTool.handler(
        pubmedEuropepmcFetchTool.input.parse({
          records: [{ source: 'MED', epmcId: 'PMC8371605' }],
        }),
        ctx,
      );

      expect(result.notFound).toEqual([{ source: 'MED', epmcId: 'PMC8371605' }]);
      expect(getEnrichment(ctx).notice).toContain('pubmed_fetch_fulltext');
    });

    it('carries the pubmed_fetch_fulltext pointer on a partially-missing batch (#94)', async () => {
      mockFetchRecords.mockResolvedValue([patHit]);
      const ctx = createMockContext();
      await pubmedEuropepmcFetchTool.handler(
        pubmedEuropepmcFetchTool.input.parse({
          records: [
            { source: 'PAT', epmcId: 'KR20120031038' },
            { source: 'PMC', epmcId: 'PMC00000000' },
          ],
        }),
        ctx,
      );
      expect(getEnrichment(ctx).notice).toContain('PMC/PMC00000000');
      expect(getEnrichment(ctx).notice).toContain('pubmed_fetch_fulltext');
    });
  });

  describe('truncated-abstract recovery (issue #83)', () => {
    it('returns whole an abstract the search tool truncates, on both surfaces', async () => {
      expect(LONG_ABSTRACT.length).toBeGreaterThan(400);

      // Search: bounded snippet, truncation flagged.
      const searchCtx = createMockContext();
      mockGetEpmc.mockReturnValue({
        fetchRecords: mockFetchRecords,
        search: vi
          .fn()
          .mockResolvedValue({ hits: [patHit], hitCount: 1, cursorMark: '*', query: 'cancer' }),
      });
      const searchResult = await pubmedEuropepmcSearchTool.handler(
        pubmedEuropepmcSearchTool.input.parse({ query: 'cancer', sources: ['PAT'] }),
        searchCtx,
      );
      const hit = searchResult.hits[0];
      expect(hit?.abstractTruncated).toBe(true);
      expect(hit?.abstractSnippet).toHaveLength(401);
      expect(hit?.abstractSnippet?.endsWith('…')).toBe(true);

      // Fetch by the same source + epmcId: complete abstract, both surfaces.
      mockFetchRecords.mockResolvedValue([patHit]);
      const ctx = createMockContext();
      const result = await pubmedEuropepmcFetchTool.handler(
        pubmedEuropepmcFetchTool.input.parse({
          records: [{ source: 'PAT', epmcId: hit?.epmcId ?? '' }],
        }),
        ctx,
      );

      const tail = LONG_ABSTRACT.trim().slice(-80);
      expect(result.records[0]?.abstract).toBe(LONG_ABSTRACT.trim());
      expect(result.records[0]?.abstract).toContain(tail);
      expect(renderedText(result)).toContain(LONG_ABSTRACT.trim());
      expect(renderedText(result)).toContain(tail);
    });

    it('agrees with the search snippet on an abstract under the budget', async () => {
      const searchCtx = createMockContext();
      const shortHit = { id: 'PPR1283828', source: 'PPR', abstractText: SHORT_ABSTRACT };
      mockGetEpmc.mockReturnValue({
        fetchRecords: mockFetchRecords,
        search: vi
          .fn()
          .mockResolvedValue({ hits: [shortHit], hitCount: 1, cursorMark: '*', query: 'q' }),
      });
      const searchResult = await pubmedEuropepmcSearchTool.handler(
        pubmedEuropepmcSearchTool.input.parse({ query: 'q', sources: ['PPR'] }),
        searchCtx,
      );
      expect(searchResult.hits[0]?.abstractTruncated).toBe(false);
      expect(searchResult.hits[0]?.abstractSnippet).toBe(SHORT_ABSTRACT);

      mockFetchRecords.mockResolvedValue([shortHit]);
      const ctx = createMockContext();
      const result = await pubmedEuropepmcFetchTool.handler(
        pubmedEuropepmcFetchTool.input.parse({
          records: [{ source: 'PPR', epmcId: 'PPR1283828' }],
        }),
        ctx,
      );
      expect(result.records[0]?.abstract).toBe(SHORT_ABSTRACT);
      expect(renderedText(result)).toContain(SHORT_ABSTRACT);
    });
  });

  describe('format()', () => {
    it('renders every record field', () => {
      const text = renderedText({
        records: [
          {
            source: 'MED',
            epmcId: '42',
            title: 'Title',
            authors: 'Smith J, Jones K',
            journal: 'Nature',
            pubYear: '2024',
            firstPublicationDate: '2024-03-15',
            pmid: '42',
            pmcId: 'PMC9',
            doi: '10.1/x',
            isOpenAccess: true,
            hasFullTextXml: true,
            abstract: 'Full abstract goes here',
            citedByCount: 13,
            epmcUrl: 'https://europepmc.org/article/MED/42',
          },
        ],
      });
      expect(text).toContain('Europe PMC Records');
      expect(text).toContain('Title');
      expect(text).toContain('Smith J, Jones K');
      expect(text).toContain('Nature');
      expect(text).toContain('2024-03-15');
      expect(text).toContain('PMID:** 42');
      expect(text).toContain('PMCID:** PMC9');
      expect(text).toContain('DOI:** 10.1/x');
      expect(text).toContain('Open Access:** yes');
      expect(text).toContain('Full-text XML in EPMC:** yes');
      expect(text).toContain('Cited by:** 13');
      expect(text).toContain('https://europepmc.org/article/MED/42');
      expect(text).toContain('Full abstract goes here');
    });

    it('reports an empty result set', () => {
      expect(renderedText({ records: [] })).toContain('**Returned:** 0');
    });
  });
});
