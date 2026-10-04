/**
 * @fileoverview Tests for the Europe PMC record fetch tool — the retrieval path
 * for abstracts `pubmed_europepmc_search` truncates. Parity assertions check the
 * complete abstract on both MCP surfaces: the handler's return value (which
 * becomes `structuredContent`) and the `format()` render (which becomes
 * `content[]`).
 * @module tests/mcp-server/tools/definitions/pubmed-europepmc-fetch.tool.test
 */

import type { ContentBlock } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { textBlocks } from '../../../_helpers.js';

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
  textBlocks(pubmedEuropepmcFetchTool.format!(result))[0]?.text ?? '';

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
    const ctx = createMockContext({ errors: pubmedEuropepmcFetchTool.errors });
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
    const ctx = createMockContext({ errors: pubmedEuropepmcFetchTool.errors });
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
    const ctx = createMockContext({ errors: pubmedEuropepmcFetchTool.errors });
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
    const ctx = createMockContext({ errors: pubmedEuropepmcFetchTool.errors });
    const result = await pubmedEuropepmcFetchTool.handler(
      pubmedEuropepmcFetchTool.input.parse({ records: [{ source: 'PPR', epmcId: 'PPR3' }] }),
      ctx,
    );
    expect(result.records[0]?.abstract).toBe(
      'Change was -0.45 (95% CI, -0.67 to -0.23; P<0.001). Conclusions Treatment slowed decline.',
    );
  });

  describe('title / authors / journal normalization (#102)', () => {
    const fetchOne = async (hit: Record<string, unknown>) => {
      mockFetchRecords.mockResolvedValue([{ id: 'PPR1226893', source: 'PPR', ...hit }]);
      const ctx = createMockContext({ errors: pubmedEuropepmcFetchTool.errors });
      return pubmedEuropepmcFetchTool.handler(
        pubmedEuropepmcFetchTool.input.parse({
          records: [{ source: 'PPR', epmcId: 'PPR1226893' }],
        }),
        ctx,
      );
    };

    it('strips JATS/HTML markup from the title, the live PPR vector', async () => {
      const result = await fetchOne({
        title: '<i>PIP2;1</i>  aquaporin promotes early stomatal closure in grapevine leaves',
      });
      expect(result.records[0]?.title).toBe(
        'PIP2;1 aquaporin promotes early stomatal closure in grapevine leaves',
      );
    });

    it('normalizes authors and journal the same way', async () => {
      const result = await fetchOne({
        authorString: 'Smith J, Jones K &amp; Lee  M.',
        journalTitle: 'Journal of <i>Plant</i> Physi­ology',
      });
      expect(result.records[0]?.authors).toBe('Smith J, Jones K & Lee M.');
      expect(result.records[0]?.journal).toBe('Journal of Plant Physiology');
    });

    it('decodes entities once, never twice', async () => {
      // A double-encoded upstream value collapses one level and stops there —
      // a second pass would turn `&lt;` into a structural `<`.
      const result = await fetchOne({ title: 'Assay of &amp;lt;i&amp;gt; markers' });
      expect(result.records[0]?.title).toBe('Assay of &lt;i&gt; markers');
    });

    it('leaves a statistical comparison in the title intact', async () => {
      const result = await fetchOne({
        title: 'Decline slowed where P<0.001 and IL-6 > baseline',
      });
      expect(result.records[0]?.title).toBe('Decline slowed where P<0.001 and IL-6 > baseline');
    });

    it('omits the fields entirely when Europe PMC carries none', async () => {
      const result = await fetchOne({});
      expect(result.records[0]?.title).toBeUndefined();
      expect(result.records[0]?.authors).toBeUndefined();
      expect(result.records[0]?.journal).toBeUndefined();
    });

    it('drops a title that normalizes to nothing rather than emitting an empty string', async () => {
      const result = await fetchOne({ title: '<i></i>' });
      expect(result.records[0]?.title).toBeUndefined();
    });

    it('documents the normalization in the output schema descriptions', () => {
      const shape = pubmedEuropepmcFetchTool.output.shape.records.element.shape;
      for (const field of ['title', 'authors', 'journal'] as const) {
        expect(shape[field].description).toMatch(/markup stripped/i);
      }
    });
  });

  describe('Markdown escaping in content[] (#102)', () => {
    const HOSTILE_TITLE = '# Injected\n[Retracted](https://evil.test) *emphasis* <i>PIP2;1</i>';

    it('renders a hostile title without adding a heading or a link', () => {
      const text = renderedText({
        records: [
          {
            source: 'PPR',
            epmcId: 'PPR1',
            title: HOSTILE_TITLE,
            epmcUrl: 'https://europepmc.org/article/PPR/PPR1',
          },
        ],
      });

      // The injected `# Injected` stays inside the record's own heading line
      // instead of becoming a second one: the line break is neutralized, and a
      // `#` that is no longer at the start of a line cannot open a heading.
      const headings = text.split('\n').filter((line) => line.startsWith('#'));
      expect(headings).toEqual([
        '## Europe PMC Records',
        '### # Injected \\[Retracted\\](https://evil.test) \\*emphasis\\* \\<i>PIP2;1\\</i>',
      ]);
    });

    it('escapes the Authors and Journal label lines too', () => {
      const text = renderedText({
        records: [
          {
            source: 'PPR',
            epmcId: 'PPR1',
            authors: 'Smith J, [Anon](https://evil.test), Jones K',
            journal: 'Journal of *Plant* <i>Physiology</i>',
            epmcUrl: 'https://europepmc.org/article/PPR/PPR1',
          },
        ],
      });
      expect(text).toContain('**Authors:** Smith J, \\[Anon\\](https://evil.test), Jones K');
      expect(text).toContain('**Journal:** Journal of \\*Plant\\* \\<i>Physiology\\</i>');
    });

    it('leaves a legible title untouched on both surfaces', () => {
      const title = 'TP53_mutant tumours at 5*g where P<0.001 in ~250 patients';
      const record = {
        source: 'PPR' as const,
        epmcId: 'PPR1',
        title,
        epmcUrl: 'https://europepmc.org/article/PPR/PPR1',
      };
      expect(renderedText({ records: [record] })).toContain(`### ${title}`);
    });

    it('never writes the escaped form back into structuredContent', async () => {
      mockFetchRecords.mockResolvedValue([
        { id: 'PPR1', source: 'PPR', title: '[Retracted] *Nature* study' },
      ]);
      const ctx = createMockContext({ errors: pubmedEuropepmcFetchTool.errors });
      const result = await pubmedEuropepmcFetchTool.handler(
        pubmedEuropepmcFetchTool.input.parse({ records: [{ source: 'PPR', epmcId: 'PPR1' }] }),
        ctx,
      );

      expect(result.records[0]?.title).toBe('[Retracted] *Nature* study');
      expect(renderedText(result)).toContain('### \\[Retracted\\] \\*Nature\\* study');
    });
  });

  it('omits `abstract` when Europe PMC carries none', async () => {
    mockFetchRecords.mockResolvedValue([{ id: 'PMC13294766', source: 'PMC' }]);
    const ctx = createMockContext({ errors: pubmedEuropepmcFetchTool.errors });
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
      const ctx = createMockContext({ errors: pubmedEuropepmcFetchTool.errors });
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
      const ctx = createMockContext({ errors: pubmedEuropepmcFetchTool.errors });
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
      const ctx = createMockContext({ errors: pubmedEuropepmcFetchTool.errors });
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
      const ctx = createMockContext({ errors: pubmedEuropepmcFetchTool.errors });
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
      const ctx = createMockContext({ errors: pubmedEuropepmcFetchTool.errors });
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
      const ctx = createMockContext({ errors: pubmedEuropepmcFetchTool.errors });
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
      const ctx = createMockContext({ errors: pubmedEuropepmcFetchTool.errors });
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
      const searchCtx = createMockContext({ errors: pubmedEuropepmcSearchTool.errors });
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
      const ctx = createMockContext({ errors: pubmedEuropepmcFetchTool.errors });
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
      const searchCtx = createMockContext({ errors: pubmedEuropepmcSearchTool.errors });
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
      const ctx = createMockContext({ errors: pubmedEuropepmcFetchTool.errors });
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

/** Every text block of a contract run, joined. */
const contractText = (result: Awaited<ReturnType<typeof runToolContract>>) =>
  textBlocks(result.content as ContentBlock[])
    .map((b) => b.text)
    .join('\n');

describe('pubmedEuropepmcFetchTool markup in MED records (#181, #195)', () => {
  beforeEach(() => {
    mockFetchRecords.mockReset();
    mockGetEpmc.mockReset();
    mockGetEpmc.mockReturnValue({ fetchRecords: mockFetchRecords });
  });

  it('removes entity-encoded title markup on both surfaces', async () => {
    // Europe PMC's core record for MED/42631465 and MED/42721223: the PubMed
    // title's inline elements arrive entity-encoded, the abstract's raw.
    mockFetchRecords.mockResolvedValue([
      {
        id: '42631465',
        source: 'MED',
        pmid: '42631465',
        title:
          '&lt;b&gt;Molecular mechanism of ephedrine-regulated ferroptosis in asthma via PKM2-ACSL4 lactylation&lt;/b&gt;.',
        authorString: 'Zhao L, Xia R, Zeng S, Yan X.',
        journalTitle: 'Pakistan journal of pharmaceutical sciences',
      },
      {
        id: '42721223',
        source: 'MED',
        pmid: '42721223',
        title:
          'Application of [&lt;sup&gt;18&lt;/sup&gt;F]NaF and [&lt;sup&gt;18&lt;/sup&gt;F]FDG PET/CT to Assess Molecular Calcification and Glucose Metabolism in Thyroid Cartilage.',
        abstractText: '<h4>Methods</h4>Deuterium oxide (D<sub>2</sub>O) labelling.',
      },
    ]);

    const result = await runToolContract(pubmedEuropepmcFetchTool, {
      records: [
        { source: 'MED', epmcId: '42631465' },
        { source: 'MED', epmcId: '42721223' },
      ],
    });

    expect(result.isError).toBeFalsy();
    const { records } = result.structuredContent as {
      records: Array<{ title?: string; abstract?: string }>;
    };
    expect(records.map((r) => r.title)).toEqual([
      'Molecular mechanism of ephedrine-regulated ferroptosis in asthma via PKM2-ACSL4 lactylation.',
      'Application of [18F]NaF and [18F]FDG PET/CT to Assess Molecular Calcification and Glucose Metabolism in Thyroid Cartilage.',
    ]);
    expect(records[1]?.abstract).toBe('Methods Deuterium oxide (D2O) labelling.');

    const text = contractText(result);
    expect(text).toContain(
      '### Molecular mechanism of ephedrine-regulated ferroptosis in asthma via PKM2-ACSL4 lactylation.',
    );
    expect(text).toContain('### Application of \\[18F\\]NaF and \\[18F\\]FDG PET/CT');
    expect(text).not.toMatch(/<\/?(b|sup|sub)>|\\</);
  });

  it('keeps legacy `<or=` notation in the abstract on both surfaces', async () => {
    mockFetchRecords.mockResolvedValue([
      {
        id: '19108738',
        source: 'MED',
        pmid: '19108738',
        abstractText:
          '<h4>Results</h4>In sample set I, the expression of a peak at mass-to-charge ratio 9198 (relative intensity <or= 20 or > 20), identified as haptoglobin (Hp) alpha-1 chain, was strongly associated with recurrence free survival.<h4>Conclusion</h4>Not a predictor.',
      },
    ]);

    const result = await runToolContract(pubmedEuropepmcFetchTool, {
      records: [{ source: 'MED', epmcId: '19108738' }],
    });

    const expected =
      'Results In sample set I, the expression of a peak at mass-to-charge ratio 9198 (relative intensity <or= 20 or > 20), identified as haptoglobin (Hp) alpha-1 chain, was strongly associated with recurrence free survival. Conclusion Not a predictor.';
    const { records } = result.structuredContent as { records: Array<{ abstract?: string }> };
    expect(records[0]?.abstract).toBe(expected);
    expect(contractText(result)).toContain(expected);
  });
});

describe('pubmedEuropepmcFetchTool whole-response budget (#188)', () => {
  beforeEach(() => {
    mockFetchRecords.mockReset();
    mockGetEpmc.mockReset();
    mockGetEpmc.mockReturnValue({ fetchRecords: mockFetchRecords });
  });

  interface Pair {
    epmcId: string;
    source: 'AGR' | 'MED' | 'PAT' | 'PMC' | 'PPR';
  }

  interface FetchOutput {
    deferred?: {
      deferredCount: number;
      maxResponseCharacters: number;
      nextDeferredCharacters: number;
      records: Pair[];
      returnedCharacters: number;
    };
    notFound?: Pair[];
    notice?: string;
    records: Array<Pair & { abstract?: string }>;
    truncated?: boolean;
  }

  /** A resolved Europe PMC hit whose serialized size is set by its abstract. */
  const hit = (source: Pair['source'], id: string, abstractLength: number, extra = {}) => ({
    id,
    source,
    title: `Record ${id}`,
    abstractText: 'x'.repeat(abstractLength),
    ...extra,
  });

  const pairOf = (h: { id: string; source: Pair['source'] }): Pair => ({
    source: h.source,
    epmcId: h.id,
  });

  /** Run the assembled tool against one staged Europe PMC response. */
  const call = async (
    hits: Array<{ id: string; source: string }>,
    records: Pair[],
    extra: Record<string, unknown> = {},
  ) => {
    mockFetchRecords.mockResolvedValue(hits);
    const result = await runToolContract(pubmedEuropepmcFetchTool, { records, ...extra });
    expect(result.isError).toBeFalsy();
    return { structured: result.structuredContent as FetchOutput, text: contractText(result) };
  };

  /** Serialized size of each returned record — the unit the budget spends. */
  const sizesOf = (output: FetchOutput) => output.records.map((r) => JSON.stringify(r).length);
  const sum = (values: number[]) => values.reduce((n, v) => n + v, 0);

  // Europe PMC's order, not the request's: the cut runs over this order.
  const HITS = [hit('PPR', 'PPR1', 40), hit('MED', '111', 80), hit('PAT', 'KR1', 120)];
  const REFS: Pair[] = [
    { source: 'MED', epmcId: '111' },
    { source: 'PAT', epmcId: 'KR1' },
    { source: 'PPR', epmcId: 'PPR1' },
  ];

  it('returns byte-identical output on both surfaces when no budget is set', async () => {
    mockFetchRecords.mockResolvedValue([
      {
        id: 'PPR1283828',
        source: 'PPR',
        title: 'Preprint one',
        authorString: 'Smith J.',
        abstractText: 'A'.repeat(40),
        isOpenAccess: 'Y',
        inPMC: 'N',
        pubYear: '2024',
      },
      {
        id: '34265844',
        source: 'MED',
        pmid: '34265844',
        pmcid: 'PMC8371605',
        title: 'Indexed article',
        journalTitle: 'Nature',
        abstractText: 'B'.repeat(40),
        citedByCount: 3,
      },
    ]);

    const result = await runToolContract(pubmedEuropepmcFetchTool, {
      records: [
        { source: 'PMC', epmcId: 'PMC8371605' },
        { source: 'PPR', epmcId: 'PPR1283828' },
        { source: 'AGR', epmcId: 'IND000000000' },
      ],
    });

    expect(JSON.stringify(result.structuredContent)).toBe(
      '{"records":[{"source":"PPR","epmcId":"PPR1283828","title":"Preprint one","authors":"Smith J.","pubYear":"2024","isOpenAccess":true,"hasFullTextXml":false,"abstract":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA","epmcUrl":"https://europepmc.org/article/PPR/PPR1283828"},{"source":"MED","epmcId":"34265844","title":"Indexed article","journal":"Nature","pmid":"34265844","pmcId":"PMC8371605","abstract":"BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB","citedByCount":3,"epmcUrl":"https://europepmc.org/article/MED/34265844"}],"notFound":[{"source":"AGR","epmcId":"IND000000000"}],"notice":"Europe PMC returned no record for 1 of 3 requested pairs: AGR/IND000000000. Verify each against its pubmed_europepmc_search hit — a mismatched `source` is the usual cause."}',
    );
    expect(JSON.stringify(result.content)).toBe(
      '[{"type":"text","text":"## Europe PMC Records\\n**Returned:** 2\\n**Not found:** AGR/IND000000000\\n\\n### Preprint one\\n**Source:** PPR | **EPMC ID:** PPR1283828\\n**Authors:** Smith J.\\n**Year:** 2024\\n**Open Access:** yes\\n**Full-text XML in EPMC:** no\\n**URL:** https://europepmc.org/article/PPR/PPR1283828\\n\\n#### Abstract\\nAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\\n\\n### Indexed article\\n**Source:** MED | **EPMC ID:** 34265844\\n**Journal:** Nature\\n**PMID:** 34265844\\n**PMCID:** PMC8371605\\n**Cited by:** 3\\n**URL:** https://europepmc.org/article/MED/34265844\\n\\n#### Abstract\\nBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"},{"type":"text","text":"\\n\\n> Europe PMC returned no record for 1 of 3 requested pairs: AGR/IND000000000. Verify each against its pubmed_europepmc_search hit — a mismatched `source` is the usual cause."}]',
    );
  });

  it('returns every record, with no deferral, at a ceiling equal to their summed size', async () => {
    const baseline = (await call(HITS, REFS)).structured;
    const total = sum(sizesOf(baseline));

    for (const ceiling of [total, total + 1, 1_000_000]) {
      const { structured, text } = await call(HITS, REFS, { maxResponseCharacters: ceiling });
      expect(structured.records.map((r) => r.epmcId)).toEqual(['PPR1', '111', 'KR1']);
      expect(structured.deferred).toBeUndefined();
      expect(structured.truncated).toBeUndefined();
      expect(structured.notice).toBeUndefined();
      expect(text).not.toContain('Deferred');
    }
  });

  it('does not count `notFound` against the ceiling', async () => {
    const total = sum(sizesOf((await call(HITS, REFS)).structured));
    const { structured } = await call(
      HITS,
      [...REFS, { source: 'AGR', epmcId: 'IND000000000' }, { source: 'PPR', epmcId: 'PPR404' }],
      { maxResponseCharacters: total },
    );
    expect(structured.records).toHaveLength(3);
    expect(structured.notFound).toHaveLength(2);
    expect(structured.deferred).toBeUndefined();
  });

  it('defers the last record whole at one character under the summed size', async () => {
    const sizes = sizesOf((await call(HITS, REFS)).structured);
    const total = sum(sizes);

    const { structured } = await call(HITS, REFS, { maxResponseCharacters: total - 1 });

    expect(structured.records.map((r) => r.epmcId)).toEqual(['PPR1', '111']);
    expect(structured.deferred).toEqual({
      maxResponseCharacters: total - 1,
      returnedCharacters: (sizes[0] ?? 0) + (sizes[1] ?? 0),
      deferredCount: 1,
      records: [{ source: 'PAT', epmcId: 'KR1' }],
      nextDeferredCharacters: sizes[2],
    });
    expect(structured.truncated).toBe(true);
    expect(JSON.stringify(structured.records)).not.toContain('x'.repeat(120));
  });

  it('cuts a full 25-record batch to a prefix and resumes it exactly from `deferred.records`', async () => {
    // Europe PMC's order differs from the request's, and sizes vary.
    const all = Array.from({ length: 25 }, (_, i) =>
      hit('PPR', `PPR${100 + i}`, 50 + ((i * 37) % 400)),
    );
    const responseOrder = [...all].reverse();
    const requested = all.map(pairOf);

    const unbudgeted = (await call(responseOrder, requested)).structured;
    const sizes = sizesOf(unbudgeted);
    const ceiling = sum(sizes.slice(0, 10)) + Math.floor((sizes[10] ?? 0) / 2);

    const first = await call(responseOrder, requested, { maxResponseCharacters: ceiling });
    expect(first.structured.records).toEqual(unbudgeted.records.slice(0, 10));
    expect(first.structured.deferred?.returnedCharacters).toBe(sum(sizes.slice(0, 10)));
    expect(first.structured.deferred?.deferredCount).toBe(15);
    expect(first.structured.deferred?.records).toEqual(
      unbudgeted.records.slice(10).map(({ source, epmcId }) => ({ source, epmcId })),
    );
    expect(first.structured.deferred?.nextDeferredCharacters).toBe(sizes[10]);

    const deferredPairs = first.structured.deferred?.records ?? [];
    const remaining = responseOrder.filter((h) =>
      deferredPairs.some((p) => p.epmcId === h.id && p.source === h.source),
    );
    const second = await call(remaining, deferredPairs);
    expect(mockFetchRecords).toHaveBeenLastCalledWith(deferredPairs, expect.anything());
    expect(second.structured.deferred).toBeUndefined();
    expect(second.structured.notFound).toBeUndefined();

    const seen = [...first.structured.records, ...second.structured.records].map((r) => r.epmcId);
    expect(seen).toHaveLength(25);
    expect(new Set(seen)).toEqual(new Set(all.map((h) => h.id)));
  });

  it('returns zero records under the first record, naming its size, never an empty upstream', async () => {
    const hits = [hit('PPR', 'PPR1', 400), hit('MED', '111', 10)];
    const refs = hits.map(pairOf);
    const sizes = sizesOf((await call(hits, refs)).structured);
    // The cut is a prefix cut: the smaller second record is unreachable until
    // the first fits, so the number the caller needs is the first's size.
    expect(sizes[1]).toBeLessThan(sizes[0] ?? 0);

    const { structured, text } = await call(hits, refs, { maxResponseCharacters: sizes[1] });

    expect(structured.records).toEqual([]);
    expect(structured.notFound).toBeUndefined();
    expect(structured.deferred).toEqual({
      maxResponseCharacters: sizes[1],
      returnedCharacters: 0,
      deferredCount: 2,
      records: refs,
      nextDeferredCharacters: sizes[0],
    });
    expect(structured.truncated).toBe(true);
    const notice = structured.notice ?? '';
    expect(notice).toContain(`at least ${sizes[0]}`);
    // The second record alone fits this ceiling, so "no record fits" would be false.
    expect(notice).toContain(
      `The first record alone exceeds the requested maxResponseCharacters of ${sizes[1]}, so none were returned.`,
    );
    expect(notice).not.toMatch(/no record fits/i);
    expect(notice).not.toMatch(/returned no record/i);
    expect(text).toContain('**Returned:** 0');
    expect(text).not.toMatch(/returned no record/i);
  });

  it('computes `notFound` before the cut and keeps it disjoint from `deferred.records`', async () => {
    // A PMC request answered by its canonical MED record, which the budget defers.
    const hits = [
      hit('PPR', 'PPR1', 40),
      hit('MED', '34265844', 200, { pmid: '34265844', pmcid: 'PMC8371605' }),
    ];
    const refs: Pair[] = [
      { source: 'PPR', epmcId: 'PPR1' },
      { source: 'PMC', epmcId: 'PMC8371605' },
      { source: 'AGR', epmcId: 'IND000000000' },
    ];
    const sizes = sizesOf((await call(hits, refs)).structured);

    const { structured, text } = await call(hits, refs, { maxResponseCharacters: sizes[0] });

    expect(structured.records.map((r) => r.epmcId)).toEqual(['PPR1']);
    expect(structured.deferred?.records).toEqual([{ source: 'MED', epmcId: '34265844' }]);
    expect(structured.notFound).toEqual([{ source: 'AGR', epmcId: 'IND000000000' }]);
    expect(text).toContain('**Not found:** AGR/IND000000000\n');
    // One notice carries both guidances.
    const notice = structured.notice ?? '';
    expect(notice).toContain('Europe PMC returned no record for 1 of 3 requested pairs');
    expect(notice).toContain('AGR/IND000000000');
    expect(notice).toContain('deferred whole: MED/34265844');
    expect(notice).toContain(`at least ${sizes[1]}`);
  });

  it('carries the PMCID pointer and the deferral in one notice', async () => {
    const hits = [hit('PPR', 'PPR1', 40), hit('PAT', 'KR1', 400)];
    const refs: Pair[] = [...hits.map(pairOf), { source: 'MED', epmcId: 'PMC00000000' }];
    const sizes = sizesOf((await call(hits, refs)).structured);

    const { structured } = await call(hits, refs, { maxResponseCharacters: sizes[0] });

    const notice = structured.notice ?? '';
    expect(notice).toContain('MED/PMC00000000');
    expect(notice).toContain('pubmed_fetch_fulltext');
    expect(notice).toContain('deferred whole: PAT/KR1');
  });

  it('renders the same deferral state in content[] that structuredContent carries', async () => {
    const sizes = sizesOf((await call(HITS, REFS)).structured);

    const { structured, text } = await call(HITS, REFS, { maxResponseCharacters: sizes[0] });
    const d = structured.deferred;

    expect(text).toContain('**Returned:** 1\n');
    expect(text).toContain(
      `**Deferred by the response budget:** 2 record(s) — ${d?.returnedCharacters} of ${d?.maxResponseCharacters} budgeted characters returned; next deferred record ${d?.nextDeferredCharacters} characters`,
    );
    expect(text).toContain(
      'Re-call `pubmed_europepmc_fetch` with these as `records` (`source`/`epmcId`): MED/111, PAT/KR1',
    );
    expect(text).toContain('### Record PPR1');
    expect(text).not.toContain('### Record 111');
    expect(text).not.toContain('x'.repeat(80));
    expect(structured.notice).toBe(
      `Response character budget reached: ${d?.returnedCharacters} of ${d?.maxResponseCharacters} characters returned. 2 resolved record(s) were deferred whole: MED/111, PAT/KR1. Re-call pubmed_europepmc_fetch with those pairs as \`records\` to retrieve them, or raise maxResponseCharacters to at least ${d?.nextDeferredCharacters} — the size of the next deferred record.`,
    );
    expect(text).toContain(structured.notice ?? '');
  });

  it('reports no deferral when the budget is set but nothing resolved', async () => {
    const { structured } = await call([], [{ source: 'AGR', epmcId: 'IND000000000' }], {
      maxResponseCharacters: 10,
    });
    expect(structured.records).toEqual([]);
    expect(structured.deferred).toBeUndefined();
    expect(structured.truncated).toBeUndefined();
    expect(structured.notice).toMatch(/no record for any requested pair/i);
  });

  it('rejects a ceiling outside 1–1,000,000 or a fractional one', async () => {
    const records: Pair[] = [{ source: 'PPR', epmcId: 'PPR1' }];
    for (const value of [0, -1, 1.5, 1_000_001]) {
      const result = await runToolContract(pubmedEuropepmcFetchTool, {
        records,
        maxResponseCharacters: value,
      });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: { code: JsonRpcErrorCode.InvalidParams },
      });
    }
    for (const value of [1, 1_000_000]) {
      expect(
        pubmedEuropepmcFetchTool.input.safeParse({ records, maxResponseCharacters: value }).success,
      ).toBe(true);
    }
    expect(mockFetchRecords).not.toHaveBeenCalled();
  });

  it('advertises the budget and its continuation in the tool and field descriptions', () => {
    expect(pubmedEuropepmcFetchTool.description).toContain('maxResponseCharacters');
    expect(pubmedEuropepmcFetchTool.description).toContain('deferred.records');
    const ceiling = pubmedEuropepmcFetchTool.input.shape.maxResponseCharacters.description ?? '';
    expect(ceiling).toMatch(/deferred whole/);
    expect(ceiling).toContain('`notFound`');
    expect(pubmedEuropepmcFetchTool.output.shape.notFound.description).toMatch(/not deferrals/);
  });
});
