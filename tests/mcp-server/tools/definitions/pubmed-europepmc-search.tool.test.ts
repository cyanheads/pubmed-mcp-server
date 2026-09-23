/**
 * @fileoverview Tests for the Europe PMC search tool.
 * @module tests/mcp-server/tools/definitions/pubmed-europepmc-search.tool.test
 */

import type { ContentBlock } from '@cyanheads/mcp-ts-core';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { textBlocks } from '../../../_helpers.js';

const mockSearch = vi.fn();
const mockGetEpmc = vi.fn();

vi.mock('@/services/europe-pmc/europe-pmc-service.js', () => ({
  getEuropePmcService: () => mockGetEpmc(),
}));

const { pubmedEuropepmcSearchTool } = await import(
  '@/mcp-server/tools/definitions/pubmed-europepmc-search.tool.js'
);

describe('pubmedEuropepmcSearchTool', () => {
  beforeEach(() => {
    mockSearch.mockReset();
    mockGetEpmc.mockReset();
    mockGetEpmc.mockReturnValue({ search: mockSearch });
  });

  it('parses valid input with defaults', () => {
    const input = pubmedEuropepmcSearchTool.input.parse({ query: 'cancer' });
    expect(input.query).toBe('cancer');
    expect(input.pageSize).toBe(25);
    expect(input.cursorMark).toBe('*');
    expect(input.resultType).toBe('core');
    expect(input.sources).toBeUndefined();
  });

  it('rejects empty query', () => {
    const parsed = pubmedEuropepmcSearchTool.input.safeParse({ query: '' });
    expect(parsed.success).toBe(false);
  });

  it('rejects pageSize beyond 100', () => {
    const parsed = pubmedEuropepmcSearchTool.input.safeParse({ query: 'foo', pageSize: 200 });
    expect(parsed.success).toBe(false);
  });

  it('accepts explicit sources including PAT and AGR', () => {
    const input = pubmedEuropepmcSearchTool.input.parse({
      query: 'foo',
      sources: ['MED', 'PMC', 'PPR', 'PAT', 'AGR'],
    });
    expect(input.sources).toEqual(['MED', 'PMC', 'PPR', 'PAT', 'AGR']);
  });

  it('throws with reason europepmc_disabled when EPMC service is unavailable', async () => {
    mockGetEpmc.mockReturnValue(undefined);
    const ctx = createMockContext({ errors: pubmedEuropepmcSearchTool.errors });
    const input = pubmedEuropepmcSearchTool.input.parse({ query: 'foo' });
    const promise = pubmedEuropepmcSearchTool.handler(input, ctx);
    await expect(promise).rejects.toThrow(/EUROPEPMC_ENABLED|service is not available/i);
    await expect(promise).rejects.toMatchObject({
      data: { reason: 'europepmc_disabled' },
    });
  });

  it('passes default sources (MED, PMC, PPR) when none provided', async () => {
    mockSearch.mockResolvedValue({ hits: [], hitCount: 0, cursorMark: '*' });
    const ctx = createMockContext({ errors: pubmedEuropepmcSearchTool.errors });
    const input = pubmedEuropepmcSearchTool.input.parse({ query: 'foo' });
    await pubmedEuropepmcSearchTool.handler(input, ctx);
    expect(mockSearch).toHaveBeenCalledWith(
      expect.objectContaining({ sources: ['MED', 'PMC', 'PPR'] }),
    );
  });

  it('passes through explicit sources', async () => {
    mockSearch.mockResolvedValue({ hits: [], hitCount: 0, cursorMark: '*' });
    const ctx = createMockContext({ errors: pubmedEuropepmcSearchTool.errors });
    const input = pubmedEuropepmcSearchTool.input.parse({
      query: 'foo',
      sources: ['PPR', 'PAT'],
    });
    await pubmedEuropepmcSearchTool.handler(input, ctx);
    expect(mockSearch).toHaveBeenCalledWith(expect.objectContaining({ sources: ['PPR', 'PAT'] }));
  });

  it('passes cursorMark through and reports nextCursorMark when present', async () => {
    mockSearch.mockResolvedValue({
      hits: [{ id: '1', source: 'MED', title: 'A', pmid: '1' }],
      hitCount: 50,
      cursorMark: '*',
      nextCursorMark: 'CURSOR_NEXT',
      query: 'foo',
    });
    const ctx = createMockContext({ errors: pubmedEuropepmcSearchTool.errors });
    const input = pubmedEuropepmcSearchTool.input.parse({ query: 'foo' });
    const result = await pubmedEuropepmcSearchTool.handler(input, ctx);
    expect(result.cursorMark).toBe('*');
    expect(result.nextCursorMark).toBe('CURSOR_NEXT');
    expect(result.hits).toHaveLength(1);
    expect(result.hits[0]?.epmcId).toBe('1');
  });

  it('flattens EPMC `Y`/`N` flags into booleans (isOpenAccess, hasFullTextXml)', async () => {
    mockSearch.mockResolvedValue({
      hits: [{ id: '2', source: 'PPR', title: 'preprint', isOpenAccess: 'Y', inPMC: 'N' }],
      hitCount: 1,
      cursorMark: '*',
      query: 'foo',
    });
    const ctx = createMockContext({ errors: pubmedEuropepmcSearchTool.errors });
    const input = pubmedEuropepmcSearchTool.input.parse({ query: 'preprint' });
    const result = await pubmedEuropepmcSearchTool.handler(input, ctx);
    expect(result.hits[0]?.isOpenAccess).toBe(true);
    expect(result.hits[0]?.hasFullTextXml).toBe(false);
  });

  it('truncates long abstracts and emits a notice when no hits returned', async () => {
    const longAbstract = 'a'.repeat(900);
    mockSearch.mockResolvedValueOnce({
      hits: [{ id: '3', source: 'MED', title: 'long', abstractText: longAbstract }],
      hitCount: 1,
      cursorMark: '*',
      query: 'foo',
    });
    const ctx = createMockContext({ errors: pubmedEuropepmcSearchTool.errors });
    const result1 = await pubmedEuropepmcSearchTool.handler(
      pubmedEuropepmcSearchTool.input.parse({ query: 'foo' }),
      ctx,
    );
    expect(result1.hits[0]?.abstractSnippet).toBeDefined();
    expect(result1.hits[0]?.abstractSnippet?.length).toBeLessThanOrEqual(401);
    expect(result1.hits[0]?.abstractSnippet?.endsWith('…')).toBe(true);

    mockSearch.mockResolvedValueOnce({ hits: [], hitCount: 0, cursorMark: '*', query: 'foo' });
    await pubmedEuropepmcSearchTool.handler(
      pubmedEuropepmcSearchTool.input.parse({ query: 'no matches' }),
      ctx,
    );
    expect(getEnrichment(ctx).notice).toMatch(/No results/);
  });

  describe('abstractTruncated disclosure (issue #83)', () => {
    const runWith = async (abstractText: string | undefined) => {
      mockSearch.mockResolvedValue({
        hits: [{ id: '7', source: 'PAT', title: 't', ...(abstractText && { abstractText }) }],
        hitCount: 1,
        cursorMark: '*',
        query: 'foo',
      });
      return pubmedEuropepmcSearchTool.handler(
        pubmedEuropepmcSearchTool.input.parse({ query: 'foo' }),
        createMockContext({ errors: pubmedEuropepmcSearchTool.errors }),
      );
    };

    it('flags a cut abstract and points at the fetch tool in content[]', async () => {
      const result = await runWith('b'.repeat(900));
      const hit = result.hits[0];
      expect(hit?.abstractTruncated).toBe(true);
      expect(hit?.abstractSnippet).toHaveLength(401);

      const text = textBlocks(pubmedEuropepmcSearchTool.format!(result))[0]?.text ?? '';
      expect(text).toContain('Abstract truncated at 400 characters');
      expect(text).toContain('pubmed_europepmc_fetch');
    });

    it('reports false for an abstract that fits, with no truncation note', async () => {
      const result = await runWith('short abstract');
      expect(result.hits[0]?.abstractTruncated).toBe(false);
      expect(result.hits[0]?.abstractSnippet).toBe('short abstract');

      const text = textBlocks(pubmedEuropepmcSearchTool.format!(result))[0]?.text ?? '';
      expect(text).toContain('short abstract');
      expect(text).not.toContain('Abstract truncated');
    });

    it('reports an abstract of exactly the budget as complete', async () => {
      const result = await runWith('c'.repeat(400));
      expect(result.hits[0]?.abstractTruncated).toBe(false);
      expect(result.hits[0]?.abstractSnippet).toHaveLength(400);
    });

    it('omits the flag entirely when Europe PMC carries no abstract', async () => {
      const result = await runWith(undefined);
      expect(result.hits[0]?.abstractSnippet).toBeUndefined();
      expect(result.hits[0]?.abstractTruncated).toBeUndefined();
    });

    describe('surrogate-safe snippet cuts (issue #93)', () => {
      /** DNA emoji U+1F9EC — one code point, two UTF-16 code units. */
      const ASTRAL = '\u{1F9EC}';

      it('backs the cut off a code unit rather than splitting a surrogate pair', async () => {
        // Code unit 399 is the high surrogate, so a 400-unit cut would split it.
        const result = await runWith(`${'a'.repeat(399)}${ASTRAL}${'b'.repeat(100)}`);

        const snippet = result.hits[0]?.abstractSnippet ?? '';
        expect(snippet).toBe(`${'a'.repeat(399)}…`);
        expect(snippet.isWellFormed()).toBe(true);
        expect(result.hits[0]?.abstractTruncated).toBe(true);
      });

      it('keeps an astral character whole when the cut lands just after it', async () => {
        // Code units 398–399 are the pair, so a 400-unit cut ends on the low half.
        const result = await runWith(`${'a'.repeat(398)}${ASTRAL}${'b'.repeat(100)}`);

        const snippet = result.hits[0]?.abstractSnippet ?? '';
        expect(snippet).toBe(`${'a'.repeat(398)}${ASTRAL}…`);
        expect(snippet.isWellFormed()).toBe(true);
      });

      it('spends the full budget when the cut lands just before an astral character', async () => {
        const result = await runWith(`${'a'.repeat(400)}${ASTRAL}${'b'.repeat(100)}`);

        const snippet = result.hits[0]?.abstractSnippet ?? '';
        expect(snippet).toBe(`${'a'.repeat(400)}…`);
        expect(snippet.isWellFormed()).toBe(true);
      });
    });
  });

  it('normalizes abstractSnippet: strips JATS/HTML, decodes entities, drops soft hyphens (#74)', async () => {
    mockSearch.mockResolvedValue({
      hits: [
        {
          id: '4',
          source: 'MED',
          title: 't',
          abstractText: '<h4>Background: </h4> Emergency &amp; clini­cal triage &lt;LLMs&gt;',
        },
      ],
      hitCount: 1,
      cursorMark: '*',
      query: 'foo',
    });
    const ctx = createMockContext({ errors: pubmedEuropepmcSearchTool.errors });
    const result = await pubmedEuropepmcSearchTool.handler(
      pubmedEuropepmcSearchTool.input.parse({ query: 'foo' }),
      ctx,
    );
    const snippet = result.hits[0]?.abstractSnippet ?? '';
    expect(snippet).not.toContain('<h4>');
    expect(snippet).not.toContain('&amp;');
    expect(snippet).not.toContain('­');
    expect(snippet).toBe('Background: Emergency & clinical triage <LLMs>');
  });

  describe('title / authors / journal normalization (#102)', () => {
    const searchOne = async (hit: Record<string, unknown>) => {
      mockSearch.mockResolvedValue({
        hits: [{ id: 'PPR1226893', source: 'PPR', ...hit }],
        hitCount: 1,
        cursorMark: '*',
        query: 'foo',
      });
      const ctx = createMockContext({ errors: pubmedEuropepmcSearchTool.errors });
      return pubmedEuropepmcSearchTool.handler(
        pubmedEuropepmcSearchTool.input.parse({ query: 'foo' }),
        ctx,
      );
    };

    it('strips JATS/HTML markup from the title, the live PPR vector', async () => {
      const result = await searchOne({
        title: '<i>PIP2;1</i>  aquaporin promotes early stomatal closure in grapevine leaves',
      });
      expect(result.hits[0]?.title).toBe(
        'PIP2;1 aquaporin promotes early stomatal closure in grapevine leaves',
      );
    });

    it('normalizes authors and journal the same way', async () => {
      const result = await searchOne({
        authorString: 'Smith J, Jones K &amp; Lee  M.',
        journalTitle: 'Journal of <i>Plant</i> Physi­ology',
      });
      expect(result.hits[0]?.authors).toBe('Smith J, Jones K & Lee M.');
      expect(result.hits[0]?.journal).toBe('Journal of Plant Physiology');
    });

    it('decodes entities once, never twice', async () => {
      const result = await searchOne({ title: 'Assay of &amp;lt;i&amp;gt; markers' });
      expect(result.hits[0]?.title).toBe('Assay of &lt;i&gt; markers');
    });

    it('leaves a statistical comparison in the title intact', async () => {
      const result = await searchOne({ title: 'Decline slowed where P<0.001 and IL-6 > baseline' });
      expect(result.hits[0]?.title).toBe('Decline slowed where P<0.001 and IL-6 > baseline');
    });

    it('omits the fields entirely when Europe PMC carries none', async () => {
      const result = await searchOne({});
      expect(result.hits[0]?.title).toBeUndefined();
      expect(result.hits[0]?.authors).toBeUndefined();
      expect(result.hits[0]?.journal).toBeUndefined();
    });

    it('documents the normalization in the output schema descriptions', () => {
      const shape = pubmedEuropepmcSearchTool.output.shape.hits.element.shape;
      for (const field of ['title', 'authors', 'journal'] as const) {
        expect(shape[field].description).toMatch(/markup stripped/i);
      }
    });
  });

  describe('Markdown escaping in content[] (#102)', () => {
    const render = (hit: Record<string, unknown>) =>
      textBlocks(
        pubmedEuropepmcSearchTool.format!({
          hits: [
            {
              source: 'PPR',
              epmcId: 'PPR1',
              epmcUrl: 'https://europepmc.org/article/PPR/PPR1',
              ...hit,
            },
          ],
          cursorMark: '*',
          searchUrl: 'https://europepmc.org/search?query=x',
          totalCount: 1,
        }),
      )[0]?.text ?? '';

    it('renders a hostile title without adding a heading or a link', () => {
      const text = render({
        title: '# Injected\n[Retracted](https://evil.test) *emphasis* <i>PIP2;1</i>',
      });

      const headings = text.split('\n').filter((line) => line.startsWith('#'));
      expect(headings).toEqual([
        '## Europe PMC Search Results',
        '### Hits',
        '#### # Injected \\[Retracted\\](https://evil.test) \\*emphasis\\* \\<i>PIP2;1\\</i>',
      ]);
    });

    it('escapes the Authors and Journal label lines too', () => {
      const text = render({
        authors: 'Smith J, [Anon](https://evil.test), Jones K',
        journal: 'Journal of *Plant* <i>Physiology</i>',
      });
      expect(text).toContain('**Authors:** Smith J, \\[Anon\\](https://evil.test), Jones K');
      expect(text).toContain('**Journal:** Journal of \\*Plant\\* \\<i>Physiology\\</i>');
    });

    it('leaves a legible title untouched', () => {
      const title = 'TP53_mutant tumours at 5*g where P<0.001 in ~250 patients';
      expect(render({ title })).toContain(`#### ${title}`);
    });

    it('never writes the escaped form back into structuredContent', async () => {
      mockSearch.mockResolvedValue({
        hits: [{ id: 'PPR1', source: 'PPR', title: '[Retracted] *Nature* study' }],
        hitCount: 1,
        cursorMark: '*',
        query: 'foo',
      });
      const ctx = createMockContext({ errors: pubmedEuropepmcSearchTool.errors });
      const result = await pubmedEuropepmcSearchTool.handler(
        pubmedEuropepmcSearchTool.input.parse({ query: 'foo' }),
        ctx,
      );

      expect(result.hits[0]?.title).toBe('[Retracted] *Nature* study');
      const text = textBlocks(pubmedEuropepmcSearchTool.format!(result))[0]?.text ?? '';
      expect(text).toContain('#### \\[Retracted\\] \\*Nature\\* study');
    });
  });

  it('emits an epmcUrl per hit', async () => {
    mockSearch.mockResolvedValue({
      hits: [{ id: 'PPR9', source: 'PPR' }],
      hitCount: 1,
      cursorMark: '*',
      query: 'foo',
    });
    const ctx = createMockContext({ errors: pubmedEuropepmcSearchTool.errors });
    const result = await pubmedEuropepmcSearchTool.handler(
      pubmedEuropepmcSearchTool.input.parse({ query: 'foo' }),
      ctx,
    );
    expect(result.hits[0]?.epmcUrl).toBe('https://europepmc.org/article/PPR/PPR9');
  });

  it('describes sort without promising that undocumented fields are rejected (#159)', () => {
    const description = pubmedEuropepmcSearchTool.input.shape.sort.description ?? '';
    expect(description).not.toMatch(/outside the documented set are rejected/);
    expect(description).toContain('case-insensitively');
    expect(description).toContain('europepmc_invalid_input');
  });

  describe('PPR date-sort advisory (issue #67)', () => {
    const pprHit = { id: 'PPR1', source: 'PPR', firstPublicationDate: '2026-03-13' };

    it('advises when P_PDATE_D sort is requested for a PPR-only result set', async () => {
      mockSearch.mockResolvedValue({ hits: [pprHit], hitCount: 5, cursorMark: '*', query: 'q' });
      const ctx = createMockContext({ errors: pubmedEuropepmcSearchTool.errors });
      await pubmedEuropepmcSearchTool.handler(
        pubmedEuropepmcSearchTool.input.parse({
          query: 'q',
          sources: ['PPR'],
          sort: 'P_PDATE_D desc',
        }),
        ctx,
      );
      const notice = getEnrichment(ctx).notice ?? '';
      expect(notice).toContain('P_PDATE_D');
      expect(notice).toContain('PPR');
      expect(notice).toContain('PUB_YEAR');
      expect(notice).toContain('firstPublicationDate');
    });

    it('is case-insensitive on the sort field token', async () => {
      mockSearch.mockResolvedValue({ hits: [pprHit], hitCount: 5, cursorMark: '*', query: 'q' });
      const ctx = createMockContext({ errors: pubmedEuropepmcSearchTool.errors });
      await pubmedEuropepmcSearchTool.handler(
        pubmedEuropepmcSearchTool.input.parse({
          query: 'q',
          sources: ['PPR'],
          sort: 'p_pdate_d asc',
        }),
        ctx,
      );
      expect(getEnrichment(ctx).notice).toContain('P_PDATE_D');
    });

    it('does NOT advise when the result set spans non-PPR sources', async () => {
      mockSearch.mockResolvedValue({ hits: [pprHit], hitCount: 5, cursorMark: '*', query: 'q' });
      const ctx = createMockContext({ errors: pubmedEuropepmcSearchTool.errors });
      // Default sources (MED, PMC, PPR) — not PPR-only.
      await pubmedEuropepmcSearchTool.handler(
        pubmedEuropepmcSearchTool.input.parse({ query: 'q', sort: 'P_PDATE_D desc' }),
        ctx,
      );
      expect(getEnrichment(ctx).notice).toBeUndefined();
    });

    it('does NOT advise for PUB_YEAR sort on PPR-only (EPMC honors it)', async () => {
      mockSearch.mockResolvedValue({ hits: [pprHit], hitCount: 5, cursorMark: '*', query: 'q' });
      const ctx = createMockContext({ errors: pubmedEuropepmcSearchTool.errors });
      await pubmedEuropepmcSearchTool.handler(
        pubmedEuropepmcSearchTool.input.parse({
          query: 'q',
          sources: ['PPR'],
          sort: 'PUB_YEAR desc',
        }),
        ctx,
      );
      expect(getEnrichment(ctx).notice).toBeUndefined();
    });

    it('does NOT advise for PPR-only without a sort', async () => {
      mockSearch.mockResolvedValue({ hits: [pprHit], hitCount: 5, cursorMark: '*', query: 'q' });
      const ctx = createMockContext({ errors: pubmedEuropepmcSearchTool.errors });
      await pubmedEuropepmcSearchTool.handler(
        pubmedEuropepmcSearchTool.input.parse({ query: 'q', sources: ['PPR'] }),
        ctx,
      );
      expect(getEnrichment(ctx).notice).toBeUndefined();
    });

    it('empty-result notice takes precedence over the date-sort advisory', async () => {
      mockSearch.mockResolvedValue({ hits: [], hitCount: 0, cursorMark: '*', query: 'q' });
      const ctx = createMockContext({ errors: pubmedEuropepmcSearchTool.errors });
      await pubmedEuropepmcSearchTool.handler(
        pubmedEuropepmcSearchTool.input.parse({
          query: 'q',
          sources: ['PPR'],
          sort: 'P_PDATE_D desc',
        }),
        ctx,
      );
      expect(getEnrichment(ctx).notice).toMatch(/No results/);
    });
  });

  describe('format()', () => {
    it('renders hits with all key fields', () => {
      const blocks = textBlocks(
        pubmedEuropepmcSearchTool.format!({
          hits: [
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
              citedByCount: 13,
              abstractSnippet: 'Abstract goes here',
              abstractTruncated: false,
              epmcUrl: 'https://europepmc.org/article/MED/42',
            },
          ],
          cursorMark: '*',
          nextCursorMark: 'NEXT',
          searchUrl: 'https://europepmc.org/search?query=cancer',
          totalCount: 1,
        }),
      );
      const text = blocks[0]?.text ?? '';
      expect(text).toContain('Europe PMC Search Results');
      expect(text).toContain('next page');
      expect(text).toContain('Title');
      expect(text).toContain('Smith J, Jones K');
      expect(text).toContain('PMID:** 42');
      expect(text).toContain('PMCID:** PMC9');
      expect(text).toContain('DOI:** 10.1/x');
      expect(text).toContain('Open Access:** yes');
      expect(text).toContain('Cited by:** 13');
      expect(text).toContain('Abstract goes here');
    });

    it('marks the final page when no nextCursorMark', () => {
      const blocks = textBlocks(
        pubmedEuropepmcSearchTool.format!({
          hits: [],
          cursorMark: 'CURSOR_X',
          searchUrl: 'https://europepmc.org/search?query=x',
          totalCount: 0,
        }),
      );
      const text = blocks[0]?.text ?? '';
      expect(text).toContain('final page');
    });
  });
});

/** Every text block of a contract run, joined — the header, the hits, and the trailer. */
const contractText = (result: Awaited<ReturnType<typeof runToolContract>>) =>
  textBlocks(result.content as ContentBlock[])
    .map((b) => b.text)
    .join('\n');

/** A search page as the service returns it: EPMC's echo carries the source wrapper. */
const page = (hitCount: number, hits: unknown[], query: string) => ({
  hits,
  hitCount,
  cursorMark: '*',
  query,
});

describe('pubmedEuropepmcSearchTool searchUrl (issue #150)', () => {
  beforeEach(() => {
    mockSearch.mockReset();
    mockGetEpmc.mockReset();
    mockGetEpmc.mockReturnValue({ search: mockSearch });
  });

  it('encodes the source-wrapped query Europe PMC ran, not the caller’s bare query', async () => {
    mockSearch.mockResolvedValue(page(2595, [], '(alphafold) AND (SRC:"PPR")'));

    const result = await runToolContract(pubmedEuropepmcSearchTool, {
      query: 'alphafold',
      sources: ['PPR'],
      pageSize: 2,
      resultType: 'lite',
    });

    const structured = result.structuredContent as { searchUrl: string; query: string };
    expect(structured.searchUrl).toBe(
      'https://europepmc.org/search?query=(alphafold)%20AND%20(SRC%3A%22PPR%22)',
    );
    expect(new URL(structured.searchUrl).searchParams.get('query')).toBe(structured.query);
    expect(contractText(result)).toContain(`**Search URL:** ${structured.searchUrl}`);
  });

  it('carries the default source wrapper when no sources are passed', async () => {
    mockSearch.mockResolvedValue(
      page(12, [], '(alphafold) AND (SRC:"MED" OR SRC:"PMC" OR SRC:"PPR")'),
    );

    const result = await runToolContract(pubmedEuropepmcSearchTool, { query: 'alphafold' });

    const { searchUrl } = result.structuredContent as { searchUrl: string };
    expect(new URL(searchUrl).searchParams.get('query')).toBe(
      '(alphafold) AND (SRC:"MED" OR SRC:"PMC" OR SRC:"PPR")',
    );
  });
});

describe('pubmedEuropepmcSearchTool total match count in the header (issue #147)', () => {
  beforeEach(() => {
    mockSearch.mockReset();
    mockGetEpmc.mockReset();
    mockGetEpmc.mockReturnValue({ search: mockSearch });
  });

  const hit = (id: string) => ({ id, source: 'PPR', title: `Preprint ${id}` });

  it('puts the total beside Returned and keeps it on structuredContent', async () => {
    mockSearch.mockResolvedValue(
      page(2595, [hit('PPR1'), hit('PPR2')], '(alphafold) AND (SRC:"PPR")'),
    );

    const result = await runToolContract(pubmedEuropepmcSearchTool, {
      query: 'alphafold',
      sources: ['PPR'],
      pageSize: 2,
    });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ totalCount: 2595 });
    const text = contractText(result);
    expect(text).toContain('**Returned:** 2 of 2595\n');
    expect(text).not.toContain('Total Hits');
    expect(text).not.toContain('2595 total');
    expect(text.match(/2595/g)).toHaveLength(1);
    // The rest of the trailer stays.
    expect(text).toContain('**Effective Query:** (alphafold) AND (SRC:"PPR")');
    expect(text).toContain('**Sources:** PPR');
  });

  it('reads 0 of 0 on an empty page, with the empty-result notice intact', async () => {
    mockSearch.mockResolvedValue(page(0, [], '(zzqx) AND (SRC:"MED" OR SRC:"PMC" OR SRC:"PPR")'));

    const result = await runToolContract(pubmedEuropepmcSearchTool, { query: 'zzqx' });

    expect(result.structuredContent).toMatchObject({ hits: [], totalCount: 0 });
    const text = contractText(result);
    expect(text).toContain('**Returned:** 0 of 0\n');
    expect(text).toContain('No results matched your Europe PMC query');
  });

  it('reads the page size of the full total on the last page of a cursor walk', async () => {
    mockSearch.mockResolvedValue({
      ...page(3, [hit('PPR3')], '(alphafold) AND (SRC:"PPR")'),
      cursorMark: 'CURSOR_2',
    });

    const result = await runToolContract(pubmedEuropepmcSearchTool, {
      query: 'alphafold',
      sources: ['PPR'],
      pageSize: 2,
      cursorMark: 'CURSOR_2',
    });

    const text = contractText(result);
    expect(text).toContain('**Returned:** 1 of 3\n');
    expect(text).toContain('(final page)');
  });
});

describe('pubmedEuropepmcSearchTool query description (issue #149)', () => {
  const description = pubmedEuropepmcSearchTool.input.shape.query.description ?? '';

  it('no longer tells the caller identifier tokens must be unquoted', () => {
    expect(description).not.toMatch(/must be unquoted/i);
    expect(description).not.toMatch(/quoted form matches nothing/i);
    expect(description).toMatch(/may be quoted or unquoted/i);
  });

  it('says a PubMed-indexed article resolves under SRC:MED, not SRC:PMC', () => {
    expect(description).toContain('resolves under `SRC:MED`, not `SRC:PMC`');
  });
});
