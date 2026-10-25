/**
 * @fileoverview Tests for the Europe PMC record fetch tool — the retrieval path
 * for abstracts `pubmed_europepmc_search` truncates. Parity assertions check the
 * complete abstract on both MCP surfaces: the handler's return value (which
 * becomes `structuredContent`) and the `format()` render (which becomes
 * `content[]`).
 * @module tests/mcp-server/tools/definitions/pubmed-europepmc-fetch.tool.test
 */

import { type ContentBlock, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  bunMarkdown,
  readCommonMark,
  textBlocks,
  renderedText as visibleText,
} from '../../../_helpers.js';
import {
  EPMC_APOS_TITLE_HIT,
  EPMC_ENCODED_TAGS_HIT,
} from '../../../services/ncbi/parsing/_entity-fixtures.js';

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
    // `hasFullTextXml` follows open-access status and the full-text id, never
    // `inPMC`: `MED 42684012` is PMC13536919, in PMC but outside the
    // open-access subset. A record with no open-access status carries neither
    // flag. (#267)
    mockFetchRecords.mockResolvedValue([
      {
        id: 'PPR1',
        source: 'PPR',
        isOpenAccess: 'Y',
        inPMC: 'N',
        fullTextIdList: { fullTextId: ['PPR1'] },
      },
      {
        id: '42684012',
        source: 'MED',
        pmcid: 'PMC13536919',
        isOpenAccess: 'N',
        inPMC: 'Y',
        fullTextIdList: { fullTextId: ['PMC13536919'] },
      },
      { id: 'KR1', source: 'PAT', inPMC: 'N' },
    ]);
    const result = await runToolContract(pubmedEuropepmcFetchTool, {
      records: [
        { source: 'PPR', epmcId: 'PPR1' },
        { source: 'MED', epmcId: '42684012' },
        { source: 'PAT', epmcId: 'KR1' },
      ],
    });
    const parsed = pubmedEuropepmcFetchTool.output.parse(result.structuredContent);
    expect(parsed.records.map((r) => [r.isOpenAccess, r.hasFullTextXml])).toEqual([
      [true, true],
      [false, false],
      [undefined, undefined],
    ]);
    expect('hasFullTextXml' in (parsed.records[2] ?? {})).toBe(false);
    expect(parsed.records[0]?.epmcUrl).toBe('https://europepmc.org/article/PPR/PPR1');
    const text = textBlocks(result.content)
      .map((b) => b.text)
      .join('\n');
    expect(text.match(/^\*\*Full-text XML in EPMC:\*\*.*$/gm)).toEqual([
      '**Full-text XML in EPMC:** yes',
      '**Full-text XML in EPMC:** no',
    ]);
  });

  it("relays Europe PMC's license verbatim on both surfaces, and omits it when Europe PMC supplies none (#269)", async () => {
    mockFetchRecords.mockResolvedValue([
      { id: 'PPR1325930', source: 'PPR', title: 'Licensed', isOpenAccess: 'Y', license: 'cc by' },
      {
        id: '42685738',
        source: 'MED',
        title: 'Not open access',
        isOpenAccess: 'N',
        license: 'cc by',
      },
      { id: 'KR1', source: 'PAT', title: 'Unlicensed' },
    ]);
    const result = await runToolContract(pubmedEuropepmcFetchTool, {
      records: [
        { source: 'PPR', epmcId: 'PPR1325930' },
        { source: 'MED', epmcId: '42685738' },
        { source: 'PAT', epmcId: 'KR1' },
      ],
    });

    const parsed = pubmedEuropepmcFetchTool.output.parse(result.structuredContent);
    expect(parsed.records.map((r) => r.license)).toEqual(['cc by', 'cc by', undefined]);
    expect('license' in (parsed.records[2] ?? {})).toBe(false);
    const text = textBlocks(result.content)
      .map((b) => b.text)
      .join('\n');
    expect(text.match(/^\*\*License:\*\*.*$/gm)).toEqual([
      '**License:** cc by',
      '**License:** cc by',
    ]);
  });

  it('counts the license toward maxResponseCharacters (#269)', async () => {
    const licensed = { id: 'PPR1', source: 'PPR', title: 'Licensed', license: 'cc by-nc-nd' };
    mockFetchRecords.mockResolvedValue([licensed]);
    const records = [{ source: 'PPR' as const, epmcId: 'PPR1' }];
    const full = await runToolContract(pubmedEuropepmcFetchTool, { records });
    const record = pubmedEuropepmcFetchTool.output.parse(full.structuredContent).records[0];
    if (!record) throw new Error('no record returned');
    const { license: _, ...unlicensed } = record;

    const cut = await runToolContract(pubmedEuropepmcFetchTool, {
      records,
      maxResponseCharacters: JSON.stringify(unlicensed).length,
    });
    expect(pubmedEuropepmcFetchTool.output.parse(cut.structuredContent).deferred).toMatchObject({
      deferredCount: 1,
      nextDeferredCharacters: JSON.stringify(record).length,
    });
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

    it('decodes the title one layer further than the abstract, authors and journal (#272)', async () => {
      // Europe PMC escapes a title once more than the text NCBI ships, so the
      // title alone carries a residual layer; the other fields decode once.
      const value = 'Assay of &amp;lt;i&amp;gt; markers';
      mockFetchRecords.mockResolvedValue([
        {
          id: 'PPR1226893',
          source: 'PPR',
          title: value,
          abstractText: value,
          authorString: value,
          journalTitle: value,
        },
      ]);
      const result = await runToolContract(pubmedEuropepmcFetchTool, {
        records: [{ source: 'PPR', epmcId: 'PPR1226893' }],
      });
      const parsed = pubmedEuropepmcFetchTool.output.parse(result.structuredContent);
      expect(parsed.records[0]).toMatchObject({
        title: 'Assay of <i> markers',
        abstract: 'Assay of &lt;i&gt; markers',
        authors: 'Assay of &lt;i&gt; markers',
        journal: 'Assay of &lt;i&gt; markers',
      });
      expect(contractText(result)).toContain('\n### Assay of \\<i> markers\n');
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

describe('pubmedEuropepmcFetchTool literal tag-shaped terms in PAT records (#256)', () => {
  beforeEach(() => {
    mockFetchRecords.mockReset();
    mockGetEpmc.mockReset();
    mockGetEpmc.mockReturnValue({ fetchRecords: mockFetchRecords });
  });

  it('keeps `HuMab<CD20>` in the complete abstract (PAT/US2011076273)', async () => {
    // Europe PMC's core record, abstract verbatim.
    const abstractText =
      'The present invention relates to a highly concentrated, stable pharmaceutical formulation of a pharmaceutically active anti-CD20 antibody, such as e.g. Rituximab, Ocrelizumab, or HuMab<CD20>, or a mixture of such antibody molecules for subcutaneous injection. In particular, the present invention relates to formulations comprising, in addition to a suitable amount of the anti-CD20 antibody, an effective amount of at least one hyaluronidase enzyme as a combined formulation or for use in form of a co-formulation. The said formulations comprise additionally at least one buffering agent, such as e.g. a histidine buffer, a stabilizer or a mixture of two or more stabilizers (e.g. a saccharide, such as e.g. [alpha],[alpha]-trehalose dihydrate or sucrose, and optionally methionine as a second stabilizer), a nonionic surfactant and an effective amount of at least one hyaluronidase enzyme. Methods for preparing such formulations and their uses thereof are also provided.';
    mockFetchRecords.mockResolvedValue([
      {
        id: 'US2011076273',
        source: 'PAT',
        title: 'Highly Concentrated Pharmaceutical Formulations',
        authorString: 'ADLER MICHAEL, MAHLER HANNS-CHRISTIAN, STAUCH OLIVER BORIS.',
        abstractText,
        pubYear: '2011',
      },
    ]);

    const result = await runToolContract(pubmedEuropepmcFetchTool, {
      records: [{ source: 'PAT', epmcId: 'US2011076273' }],
    });

    expect(result.isError).toBeFalsy();
    const { records } = result.structuredContent as { records: Array<{ abstract?: string }> };
    expect(records[0]?.abstract).toBe(abstractText);
    // Escaped in `content[]`, where a renderer would otherwise read `<CD20>`
    // as a raw HTML tag and hide it; the bracket pairs stay raw. (#255)
    const text = contractText(result);
    expect(text).toContain('Ocrelizumab, or HuMab\\<CD20>, or a mixture');
    expect(text).toContain('such as e.g. [alpha],[alpha]-trehalose dihydrate');
  });
});

describe('pubmedEuropepmcFetchTool content[] escaping of the abstract (#255)', () => {
  beforeEach(() => {
    mockFetchRecords.mockReset();
    mockGetEpmc.mockReset();
    mockGetEpmc.mockReturnValue({ fetchRecords: mockFetchRecords });
  });

  /** Europe PMC's MED/39292993 abstract, the HGVS sentence verbatim. */
  const HGVS_ABSTRACT =
    'Exome sequencing identified biallelic variants in EPB41L3 in all affected individuals: two nonsense [c.466C>T, p.(R156*); c.2776C>T, p.(R926*)] and three frameshift [c.666delT, p.(F222Lfs*46); c.2289dupC, p.(V764Rfs*19); c.948_949delTG, p.(A317Kfs*33)].';

  it('escapes paired HGVS asterisks in content[] and keeps the structured abstract plain (MED/39292993)', async () => {
    mockFetchRecords.mockResolvedValue([
      {
        id: '39292993',
        source: 'MED',
        pmid: '39292993',
        doi: '10.1093/brain/awae300',
        title: 'Biallelic EPB41L3 variants underlie a developmental disorder.',
        abstractText: HGVS_ABSTRACT,
      },
    ]);

    const result = await runToolContract(pubmedEuropepmcFetchTool, {
      records: [{ source: 'MED', epmcId: '39292993' }],
    });

    expect(result.isError).toBeFalsy();
    const { records } = result.structuredContent as { records: Array<{ abstract?: string }> };
    expect(records[0]?.abstract).toBe(HGVS_ABSTRACT);
    const text = contractText(result);
    expect(text).toContain(
      '#### Abstract\nExome sequencing identified biallelic variants in EPB41L3 in all affected individuals: two nonsense [c.466C>T, p.(R156\\*); c.2776C>T, p.(R926\\*)] and three frameshift [c.666delT, p.(F222Lfs\\*46); c.2289dupC, p.(V764Rfs\\*19); c.948_949delTG, p.(A317Kfs\\*33)].',
    );
  });

  it('escapes a block marker opening the abstract and an upstream DOI', () => {
    const text = renderedText({
      records: [
        {
          source: 'PPR',
          epmcId: 'PPR_1_',
          doi: '10.1101/[x](y)',
          abstract: '> 18 years of age; a <b>bold</b> claim',
          epmcUrl: 'https://europepmc.org/article/PPR/PPR_1_',
        },
      ],
    });

    expect(text).toContain('#### Abstract\n\\> 18 years of age; a \\<b>bold\\</b> claim');
    expect(text).toContain('**DOI:** 10.1101/\\[x\\](y)');
  });

  // A not-found pair is the caller's own (`_` and `.` pass the id schema); a
  // deferred pair is Europe PMC's, whose ids the server never validates.
  const pairs = {
    records: [],
    notFound: [{ source: 'PPR' as const, epmcId: '_a_b_' }],
    deferred: {
      maxResponseCharacters: 1,
      returnedCharacters: 0,
      deferredCount: 1,
      records: [{ source: 'PAT' as const, epmcId: 'KR*1*' }],
      nextDeferredCharacters: 500,
    },
  };

  it('quotes the not-found and deferred pairs as code spans (#263)', () => {
    expect(renderedText(pairs)).toBe(
      [
        '## Europe PMC Records',
        '**Returned:** 0',
        '**Not found:** `PPR/_a_b_`',
        '**Deferred by the response budget:** 1 record(s) — 0 of 1 budgeted characters returned; next deferred record 500 characters',
        'Re-call `pubmed_europepmc_fetch` with these as `records` (`source`/`epmcId`): `PAT/KR*1*`',
      ].join('\n'),
    );
  });

  it.runIf(bunMarkdown !== undefined)('renders every character of the pairs', () => {
    const visible = visibleText(renderedText(pairs));

    expect(visible).toContain('Not found: PPR/_a_b_');
    expect(visible).toContain('(source/epmcId): PAT/KR*1*');
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
      '{"records":[{"source":"PPR","epmcId":"PPR1283828","title":"Preprint one","authors":"Smith J.","pubYear":"2024","isOpenAccess":true,"hasFullTextXml":false,"abstract":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA","epmcUrl":"https://europepmc.org/article/PPR/PPR1283828"},{"source":"MED","epmcId":"34265844","title":"Indexed article","journal":"Nature","pmid":"34265844","pmcId":"PMC8371605","abstract":"BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB","citedByCount":3,"epmcUrl":"https://europepmc.org/article/MED/34265844"}],"notFound":[{"source":"AGR","epmcId":"IND000000000"}],"notice":"Europe PMC returned no record for 1 of 3 requested pairs: `AGR/IND000000000`. Verify each against its pubmed_europepmc_search hit — a mismatched `source` is the usual cause."}',
    );
    expect(JSON.stringify(result.content)).toBe(
      '[{"type":"text","text":"## Europe PMC Records\\n**Returned:** 2\\n**Not found:** `AGR/IND000000000`\\n\\n### Preprint one\\n**Source:** PPR | **EPMC ID:** PPR1283828\\n**Authors:** Smith J.\\n**Year:** 2024\\n**Open Access:** yes\\n**Full-text XML in EPMC:** no\\n**URL:** https://europepmc.org/article/PPR/PPR1283828\\n\\n#### Abstract\\nAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\\n\\n### Indexed article\\n**Source:** MED | **EPMC ID:** 34265844\\n**Journal:** Nature\\n**PMID:** 34265844\\n**PMCID:** PMC8371605\\n**Cited by:** 3\\n**URL:** https://europepmc.org/article/MED/34265844\\n\\n#### Abstract\\nBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"},{"type":"text","text":"\\n\\n> Europe PMC returned no record for 1 of 3 requested pairs: `AGR/IND000000000`. Verify each against its pubmed_europepmc_search hit — a mismatched `source` is the usual cause."}]',
    );
  });

  it('returns every record, with no deferral, at a ceiling equal to their summed size', async () => {
    const baseline = (await call(HITS, REFS)).structured;
    const total = sum(sizesOf(baseline));

    // No cap: past the former 1,000,000 limit the ceiling still means "no limit". (#223)
    for (const ceiling of [total, total + 1, 1_000_000, 1_000_001, Number.MAX_SAFE_INTEGER]) {
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
    // The second record alone fits this ceiling, so "no record fits" would be
    // false; the one ceiling to name is the first record's size. (#236)
    expect(notice).toBe(
      `The first record alone exceeds the requested maxResponseCharacters of ${sizes[1]}, so none were returned. 2 resolved record(s) were deferred whole: \`PPR/PPR1\`, \`MED/111\`. Re-call pubmed_europepmc_fetch with those pairs as \`records: [{ source, epmcId }]\` and maxResponseCharacters ≥ ${sizes[0]}, the size of that first record.`,
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
    expect(text).toContain('**Not found:** `AGR/IND000000000`\n');
    // One notice carries both guidances.
    const [returned = 0, next = 0] = sizes;
    expect(structured.notice).toBe(
      `Europe PMC returned no record for 1 of 3 requested pairs: \`AGR/IND000000000\`. Verify each against its pubmed_europepmc_search hit — a mismatched \`source\` is the usual cause. Response character budget reached: ${returned} of ${returned} characters returned. 1 resolved record(s) were deferred whole: \`MED/34265844\`. To continue, re-call pubmed_europepmc_fetch with those pairs as \`records: [{ source, epmcId }]\` and maxResponseCharacters ≥ ${next}, the size of the next deferred record. To return the next deferred record in this response instead, repeat this call with maxResponseCharacters ≥ ${returned + next}.`,
    );
  });

  it('carries the PMCID pointer and the deferral in one notice', async () => {
    const hits = [hit('PPR', 'PPR1', 40), hit('PAT', 'KR1', 400)];
    const refs: Pair[] = [...hits.map(pairOf), { source: 'MED', epmcId: 'PMC00000000' }];
    const sizes = sizesOf((await call(hits, refs)).structured);

    const { structured } = await call(hits, refs, { maxResponseCharacters: sizes[0] });

    const [returned = 0, next = 0] = sizes;
    expect(structured.notice).toBe(
      `Europe PMC returned no record for 1 of 3 requested pairs: \`MED/PMC00000000\`. Verify each against its pubmed_europepmc_search hit — a mismatched \`source\` is the usual cause. An id shaped like a PMCID also resolves through pubmed_fetch_fulltext, whose \`pmcids\` input takes it on its own. Response character budget reached: ${returned} of ${returned} characters returned. 1 resolved record(s) were deferred whole: \`PAT/KR1\`. To continue, re-call pubmed_europepmc_fetch with those pairs as \`records: [{ source, epmcId }]\` and maxResponseCharacters ≥ ${next}, the size of the next deferred record. To return the next deferred record in this response instead, repeat this call with maxResponseCharacters ≥ ${returned + next}.`,
    );
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
      'Re-call `pubmed_europepmc_fetch` with these as `records` (`source`/`epmcId`): `MED/111`, `PAT/KR1`',
    );
    expect(text).toContain('### Record PPR1');
    expect(text).not.toContain('### Record 111');
    expect(text).not.toContain('x'.repeat(80));
    const returned = d?.returnedCharacters ?? 0;
    const next = d?.nextDeferredCharacters ?? 0;
    expect(next).toBeGreaterThan(d?.maxResponseCharacters ?? 0);
    expect(structured.notice).toBe(
      `Response character budget reached: ${returned} of ${d?.maxResponseCharacters} characters returned. 2 resolved record(s) were deferred whole: \`MED/111\`, \`PAT/KR1\`. To continue, re-call pubmed_europepmc_fetch with those pairs as \`records: [{ source, epmcId }]\` and maxResponseCharacters ≥ ${next}, the size of the next deferred record. To return the next deferred record in this response instead, repeat this call with maxResponseCharacters ≥ ${returned + next}.`,
    );
    expect(text).toContain(structured.notice ?? '');
  });

  it('says the deferred pairs can be re-called at the current ceiling when the next record fits it (#236)', async () => {
    const hits = [hit('PPR', 'PPR1', 400), hit('MED', '111', 10)];
    const refs = hits.map(pairOf);
    const sizes = sizesOf((await call(hits, refs)).structured);
    const [returned = 0, next = 0] = sizes;
    const ceiling = returned + next - 1;

    const { structured, text } = await call(hits, refs, { maxResponseCharacters: ceiling });

    expect(structured.deferred?.records).toEqual([{ source: 'MED', epmcId: '111' }]);
    expect(next).toBeLessThan(ceiling);
    expect(structured.notice).toBe(
      `Response character budget reached: ${returned} of ${ceiling} characters returned. 1 resolved record(s) were deferred whole: \`MED/111\`. To continue, re-call pubmed_europepmc_fetch with those pairs as \`records: [{ source, epmcId }]\` at the current maxResponseCharacters of ${ceiling}, which already fits the next deferred record (${next} characters). To return the next deferred record in this response instead, repeat this call with maxResponseCharacters ≥ ${returned + next}.`,
    );
    expect(text).toContain(structured.notice ?? '');

    // The repeat ceiling is exact: at it the call returns both records.
    const repeated = await call(hits, refs, { maxResponseCharacters: returned + next });
    expect(repeated.structured.records.map((r) => r.epmcId)).toEqual(['PPR1', '111']);
    expect(repeated.structured.deferred).toBeUndefined();
  });

  it('advertises both ceilings on `nextDeferredCharacters` (#236)', () => {
    const description =
      pubmedEuropepmcFetchTool.output.shape.deferred.unwrap().shape.nextDeferredCharacters
        .description ?? '';
    expect(description).toBe(
      'Serialized size of the next deferred record — the first entry in `records`, where the response stopped — and the continuation ceiling: re-calling with the deferred pairs needs `maxResponseCharacters` ≥ this to return anything, and a smaller record further down `records` cannot be reached until this one fits. Repeating this same call needs `maxResponseCharacters` ≥ `returnedCharacters` + this to return this record as well.',
    );
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

  it('rejects a non-positive, fractional, non-numeric, or unsafe-integer ceiling (#223)', async () => {
    const records: Pair[] = [{ source: 'PPR', epmcId: 'PPR1' }];
    for (const value of [0, -1, 1.5, 'all', 9_007_199_254_740_992]) {
      // Raw wire arguments: the probe values are not all of the input type.
      const args = { records, maxResponseCharacters: value };
      const result = await runToolContract(pubmedEuropepmcFetchTool, args as never);
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: { code: JsonRpcErrorCode.InvalidParams },
      });
    }
    for (const value of [1, 1_000_000, 1_000_001, Number.MAX_SAFE_INTEGER]) {
      expect(
        pubmedEuropepmcFetchTool.input.safeParse({ records, maxResponseCharacters: value }).success,
      ).toBe(true);
    }
    expect(mockFetchRecords).not.toHaveBeenCalled();
  });

  it('advertises the safe-integer bound as the ceiling maximum, keeping the 25-record batch cap (#223)', () => {
    const schema = z.toJSONSchema(pubmedEuropepmcFetchTool.input, { io: 'input' }) as unknown as {
      properties: Record<string, Record<string, unknown>>;
    };
    expect(schema.properties.maxResponseCharacters).toMatchObject({
      type: 'integer',
      minimum: 1,
      maximum: Number.MAX_SAFE_INTEGER,
    });
    expect(schema.properties.records).toMatchObject({ maxItems: 25 });
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

describe('pubmedEuropepmcFetchTool source case and the records shape (issue #244)', () => {
  beforeEach(() => {
    mockFetchRecords.mockReset();
    mockGetEpmc.mockReset();
    mockGetEpmc.mockReturnValue({ fetchRecords: mockFetchRecords });
  });

  /** The `source` field's advertised description, unchanged by the case fold. */
  const SOURCE_DESCRIPTION =
    "Europe PMC source corpus — `MED` (PubMed), `PMC` (PubMed Central), `PPR` (preprint), `PAT` (patent), `AGR` (Agricola). Copy it from the search hit's `source`. `PMC` paired with a PMCID resolves whether or not the article is also indexed in PubMed, and a PubMed-indexed one comes back as its canonical `MED` record carrying that PMCID in `pmcId`.";

  it.each([
    ['med', '42805292', { id: '42805292', source: 'MED', pmid: '42805292', title: 'A' }],
    ['pmc', 'PMC13652117', { id: 'PMC13652117', source: 'PMC', pmcid: 'PMC13652117', title: 'B' }],
    ['Ppr', 'PPR1', { id: 'PPR1', source: 'PPR', title: 'C' }],
  ])(
    'resolves a lower-case %j source as its code, with no notFound entry',
    async (source, epmcId, hit) => {
      mockFetchRecords.mockResolvedValue([hit]);

      const result = await runToolContract(pubmedEuropepmcFetchTool, {
        records: [{ source, epmcId }] as never,
      });

      expect(result.isError).toBeFalsy();
      expect(mockFetchRecords).toHaveBeenCalledWith(
        [{ source: source.toUpperCase(), epmcId }],
        expect.anything(),
      );
      const structured = result.structuredContent as { records: unknown[]; notFound?: unknown };
      expect(structured.records).toHaveLength(1);
      expect(structured).not.toHaveProperty('notFound');
      expect(structured).not.toHaveProperty('notice');
      const text = contractText(result);
      expect(text).not.toContain('Not found');
      expect(text).toContain(`**EPMC ID:** ${epmcId}`);
    },
  );

  it('reports a lower-case miss in notFound by its folded code', async () => {
    mockFetchRecords.mockResolvedValue([]);

    const result = await runToolContract(pubmedEuropepmcFetchTool, {
      records: [{ source: 'ppr', epmcId: 'PPR404' }] as never,
    });

    expect(result.structuredContent).toMatchObject({
      notFound: [{ source: 'PPR', epmcId: 'PPR404' }],
    });
    expect(contractText(result)).toContain('**Not found:** `PPR/PPR404`');
  });

  it.each([['pubmed'], ['pmid'], ['']])(
    'still rejects the source %j, listing the source codes, with no lookup',
    async (source) => {
      const result = await runToolContract(pubmedEuropepmcFetchTool, {
        records: [{ source, epmcId: '42805292' }] as never,
      });

      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: { code: JsonRpcErrorCode.InvalidParams },
      });
      expect(readCommonMark(contractText(result))).toContain('"MED"|"PMC"|"PPR"|"PAT"|"AGR"');
      expect(mockFetchRecords).not.toHaveBeenCalled();
    },
  );

  it('advertises `source` as the plain upper-case enum on input and on `notFound`', () => {
    const plain = {
      type: 'string',
      enum: ['MED', 'PMC', 'PPR', 'PAT', 'AGR'],
      description: SOURCE_DESCRIPTION,
    };
    const input = z.toJSONSchema(pubmedEuropepmcFetchTool.input, { io: 'input' }) as unknown as {
      properties: { records: { items: { properties: Record<string, unknown> } } };
    };
    const output = z.toJSONSchema(pubmedEuropepmcFetchTool.output, {
      io: 'output',
    }) as unknown as {
      properties: { notFound: { items: { properties: Record<string, unknown> } } };
    };
    expect(input.properties.records.items.properties.source).toStrictEqual(plain);
    expect(output.properties.notFound.items.properties.source).toStrictEqual(plain);
  });

  it('names the `records: [{ source, epmcId }]` input shape in its description', () => {
    expect(pubmedEuropepmcFetchTool.description).toContain(
      'addressed as `records: [{ source, epmcId }]`, an array even for one record',
    );
    expect(pubmedEuropepmcFetchTool.description).toContain(
      "copy each hit's `source` and `epmcId` into `records` here",
    );
  });
});

describe('pubmedEuropepmcFetchTool NCBI records with a residual entity layer (#262, #272)', () => {
  beforeEach(() => {
    mockFetchRecords.mockReset();
    mockGetEpmc.mockReset();
    mockGetEpmc.mockReturnValue({ fetchRecords: mockFetchRecords });
  });

  it('returns MED/42138044’s title as pubmed_fetch_articles does and MED/42515993’s abstract with no encoded tags', async () => {
    mockFetchRecords.mockResolvedValue([EPMC_APOS_TITLE_HIT, EPMC_ENCODED_TAGS_HIT]);

    const result = await runToolContract(pubmedEuropepmcFetchTool, {
      records: [
        { source: 'MED', epmcId: '42138044' },
        { source: 'MED', epmcId: '42515993' },
      ],
    });

    const title =
      "Cervical Vestibular-Evoked Myogenic Potentials (cVEMPs) in Parkinson's Disease Patients: Prospective, Case-Control study.";
    const abstract =
      'Introduction: Pollen monitoring plays an important role in modern allergy care. Quantitatively determining airborne pollen concentrations serves as a clinically relevant tool for diagnosis, treatment, disease monitoring, and prevention. Aim: The study provides an overview of current clinical applications of pollen monitoring in allergology and otolaryngology, and its integration with new technologies that support precision medicine. Conclusions: Pollen monitoring is a clinically significant component of personalised management of allergic respiratory diseases. Integration with advanced technologies is expected to improve diagnostic accuracy, optimise allergen immunotherapy, strengthen preventive strategies, and support the ongoing development of precision medicine.</p&gt.';
    // The abstract's own layer decodes once: its encoded `&lt;b&gt;` labels are
    // stripped, and the sentence they ended keeps its break.
    const aposAbstract =
      "Introduction: Postural stability depends on the integration of various neural circuits, including somatosensory, motor, visual, vestibular, and cognitive systems, which enable flexible posture and gait control. However, the understanding of vestibular otolith function and its brain connections remains limited. Aim: To elucidate the anomalies of cervical vestibular-evoked myogenic potentials (cVEMPs) and their clinical correlation with symptoms associated with brainstem involvement in individuals with Parkinson's disease (PD).";
    const { records } = result.structuredContent as {
      records: Array<{ title?: string; abstract?: string }>;
    };
    expect(records[0]?.title).toBe(title);
    expect(records[0]?.abstract).toBe(aposAbstract);
    expect(records[1]?.abstract).toBe(abstract);
    // Neither abstract holds a character the prose escape touches, so each
    // renders as the structured value, whole.
    const text = contractText(result);
    expect(text).toContain(`\n### ${title}\n`);
    expect(text).toContain(`\n#### Abstract\n${aposAbstract}\n\n### `);
    expect(text.endsWith(`\n#### Abstract\n${abstract}`)).toBe(true);
    expect(readCommonMark(text.slice(text.lastIndexOf('#### Abstract')))).toBe(
      `⟨heading_open⟩\n\nAbstract\n\n⟨heading_close⟩\n\n${abstract}`,
    );
  });
});

describe('pubmedEuropepmcFetchTool record lines that share a paragraph (#261)', () => {
  it('keeps a lone delimiter in each of two values visible', () => {
    const text = renderedText({
      records: [
        {
          source: 'PPR',
          epmcId: 'PPR1',
          title: 'HLA-B*57:01 carriers',
          authors: 'Smith J*, Lee _K',
          journal: 'J_ Med*',
          doi: '10.1/5`x',
          license: 'cc by` 4~',
          epmcUrl: 'https://europepmc.org/article/PPR/PPR1',
        },
      ],
    });

    expect(text).toContain('\n### HLA-B*57:01 carriers\n');
    expect(readCommonMark(text.slice(text.indexOf('**Source:**')))).toBe(
      [
        '⟨strong⟩Source:⟨/strong⟩ PPR | ⟨strong⟩EPMC ID:⟨/strong⟩ PPR1',
        '⟨strong⟩Authors:⟨/strong⟩ Smith J*, Lee _K',
        '⟨strong⟩Journal:⟨/strong⟩ J_ Med*',
        '⟨strong⟩DOI:⟨/strong⟩ 10.1/5`x',
        '⟨strong⟩License:⟨/strong⟩ cc by` 4~',
        '⟨strong⟩URL:⟨/strong⟩ https://europepmc.org/article/PPR/PPR1',
      ].join('\n'),
    );
  });

  it('keeps a lone delimiter in a not-found and a deferred pair visible', () => {
    const text = renderedText({
      records: [],
      notFound: [{ source: 'PPR', epmcId: 'x._y' }],
      deferred: {
        maxResponseCharacters: 1,
        returnedCharacters: 0,
        deferredCount: 1,
        records: [{ source: 'PAT', epmcId: 'KR_' }],
        nextDeferredCharacters: 500,
      },
    });

    expect(readCommonMark(text)).toBe(
      [
        '⟨heading_open⟩\n\nEurope PMC Records\n\n⟨heading_close⟩\n',
        '⟨strong⟩Returned:⟨/strong⟩ 0',
        '⟨strong⟩Not found:⟨/strong⟩ ⟨code_inline:PPR/x._y⟩',
        '⟨strong⟩Deferred by the response budget:⟨/strong⟩ 1 record(s) — 0 of 1 budgeted characters returned; next deferred record 500 characters',
        'Re-call ⟨code_inline:pubmed_europepmc_fetch⟩ with these as ⟨code_inline:records⟩ (⟨code_inline:source⟩/⟨code_inline:epmcId⟩): ⟨code_inline:PAT/KR_⟩',
      ].join('\n'),
    );
  });
});

describe('pubmedEuropepmcFetchTool journal on core records (#274)', () => {
  beforeEach(() => {
    mockFetchRecords.mockReset();
    mockGetEpmc.mockReset();
    mockGetEpmc.mockReturnValue({ fetchRecords: mockFetchRecords });
  });

  it('reports MED/42515993’s journal from `journalInfo`, which a core record carries in place of `journalTitle`', async () => {
    // The record as Europe PMC's `core` result type returns it: no `journalTitle`.
    mockFetchRecords.mockResolvedValue([
      {
        ...EPMC_ENCODED_TAGS_HIT,
        journalInfo: {
          issue: '5',
          volume: '80',
          dateOfPublication: '2026 Jul',
          journal: {
            medlineAbbreviation: 'Otolaryngol Pol',
            title: 'Otolaryngologia polska = The Polish otolaryngology',
            essn: '2300-8423',
            issn: '0030-6657',
            isoabbreviation: 'Otolaryngol Pol',
            nlmid: '0404453',
          },
        },
      },
    ]);

    const result = await runToolContract(pubmedEuropepmcFetchTool, {
      records: [{ source: 'MED', epmcId: '42515993' }],
    });

    const { records } = result.structuredContent as { records: Array<{ journal?: string }> };
    expect(records[0]?.journal).toBe('Otolaryngol Pol');
    expect(contractText(result)).toContain('\n**Journal:** Otolaryngol Pol\n');
  });
});

describe('pubmedEuropepmcFetchTool pairs quoted as code spans (#263)', () => {
  beforeEach(() => {
    mockFetchRecords.mockReset();
    mockGetEpmc.mockReset();
    mockGetEpmc.mockReturnValue({ fetchRecords: mockFetchRecords });
  });

  /** The `> …` notice blockquote of a contract run, as a CommonMark parse reads it. */
  const noticeRead = (result: Awaited<ReturnType<typeof runToolContract>>) =>
    readCommonMark(contractText(result).slice(contractText(result).lastIndexOf('\n> ') + 1));

  it('quotes an unresolved caller id whose underscores would pair as emphasis', async () => {
    // `a._b_.c` passes the id schema; bare, `_b_` reads as emphasis.
    mockFetchRecords.mockResolvedValue([patHit]);

    const result = await runToolContract(pubmedEuropepmcFetchTool, {
      records: [
        { source: 'PAT', epmcId: 'KR20120031038' },
        { source: 'PPR', epmcId: 'a._b_.c' },
      ],
    });

    expect(noticeRead(result)).toBe(
      '⟨blockquote_open⟩\n\nEurope PMC returned no record for 1 of 2 requested pairs: ⟨code_inline:PPR/a._b_.c⟩. Verify each against its pubmed_europepmc_search hit — a mismatched ⟨code_inline:source⟩ is the usual cause.\n\n⟨blockquote_close⟩',
    );
    const structured = result.structuredContent as { notFound?: unknown; notice?: string };
    expect(structured.notFound).toEqual([{ source: 'PPR', epmcId: 'a._b_.c' }]);
    expect(structured.notice).toBe(
      'Europe PMC returned no record for 1 of 2 requested pairs: `PPR/a._b_.c`. Verify each against its pubmed_europepmc_search hit — a mismatched `source` is the usual cause.',
    );
    expect(readCommonMark(contractText(result))).toContain(
      '⟨strong⟩Not found:⟨/strong⟩ ⟨code_inline:PPR/a._b_.c⟩\n',
    );
  });

  it('quotes each deferred pair in the notice and on the re-call line', async () => {
    const hits = [
      { id: 'PPR1', source: 'PPR', title: 'One', abstractText: 'x'.repeat(200) },
      { id: 'x._y_.z', source: 'PAT', title: 'Two' },
      { id: 'a_b_', source: 'AGR', title: 'Three' },
    ];
    mockFetchRecords.mockResolvedValue(hits);

    const result = await runToolContract(pubmedEuropepmcFetchTool, {
      records: hits.map(({ id, source }) => ({ source, epmcId: id })) as never,
      maxResponseCharacters: 50,
    });

    const spans = '⟨code_inline:PPR/PPR1⟩, ⟨code_inline:PAT/x._y_.z⟩, ⟨code_inline:AGR/a_b_⟩';
    expect(noticeRead(result)).toContain(`deferred whole: ${spans}.`);
    expect(readCommonMark(contractText(result))).toContain(`: ${spans}\n`);
    const structured = result.structuredContent as { notice?: string };
    expect(structured.notice).toContain(
      '3 resolved record(s) were deferred whole: `PPR/PPR1`, `PAT/x._y_.z`, `AGR/a_b_`.',
    );
  });
});
