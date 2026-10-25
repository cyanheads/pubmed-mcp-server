/**
 * @fileoverview Tests for the Europe PMC search tool.
 * @module tests/mcp-server/tools/definitions/pubmed-europepmc-search.tool.test
 */

import { type ContentBlock, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { bunMarkdown, readCommonMark, renderedText, textBlocks } from '../../../_helpers.js';
import {
  EPMC_APOS_TITLE_HIT,
  EPMC_ENCODED_TAGS_HIT,
} from '../../../services/ncbi/parsing/_entity-fixtures.js';

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

  it('passes a padded query to the service as written (issue #176)', async () => {
    mockSearch.mockResolvedValue({ hits: [], hitCount: 3, cursorMark: '*', query: 'malaria' });
    const ctx = createMockContext({ errors: pubmedEuropepmcSearchTool.errors });
    await pubmedEuropepmcSearchTool.handler(
      pubmedEuropepmcSearchTool.input.parse({ query: '  malaria  ' }),
      ctx,
    );
    expect(mockSearch).toHaveBeenCalledWith(expect.objectContaining({ query: '  malaria  ' }));
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
    // `hasFullTextXml` follows open-access status and the full-text id, never
    // `inPMC`: an open-access preprint has JATS, a PMC deposit outside the
    // open-access subset does not, and a record with no open-access status
    // carries neither flag. (#267)
    mockSearch.mockResolvedValue({
      hits: [
        {
          id: 'PPR2',
          source: 'PPR',
          title: 'preprint',
          isOpenAccess: 'Y',
          inPMC: 'N',
          fullTextIdList: { fullTextId: ['PPR2'] },
        },
        {
          id: 'PMC5',
          source: 'PMC',
          title: 'deposit',
          isOpenAccess: 'N',
          inPMC: 'Y',
          fullTextIdList: { fullTextId: ['PMC5'] },
        },
        { id: '7', source: 'MED', title: 'no status', inPMC: 'Y' },
      ],
      hitCount: 3,
      cursorMark: '*',
      query: 'foo',
    });
    const result = await runToolContract(pubmedEuropepmcSearchTool, { query: 'preprint' });
    const parsed = pubmedEuropepmcSearchTool.output.parse(result.structuredContent);
    expect(parsed.hits.map((h) => [h.isOpenAccess, h.hasFullTextXml])).toEqual([
      [true, true],
      [false, false],
      [undefined, undefined],
    ]);
    expect('hasFullTextXml' in (parsed.hits[2] ?? {})).toBe(false);
    const text = textBlocks(result.content)
      .map((b) => b.text)
      .join('\n');
    expect(text.match(/^\*\*Full-text XML in EPMC:\*\*.*$/gm)).toEqual([
      '**Full-text XML in EPMC:** yes',
      '**Full-text XML in EPMC:** no',
    ]);
  });

  it("relays Europe PMC's license verbatim on both surfaces, and omits it when Europe PMC supplies none (#269)", async () => {
    // A `lite` result carries no `license`; neither does a `core` record Europe PMC has none for.
    mockSearch.mockResolvedValue({
      hits: [
        { id: 'PPR1325930', source: 'PPR', title: 'Licensed', license: 'cc by' },
        { id: '7', source: 'MED', title: 'Unlicensed' },
        { id: '8', source: 'MED', title: 'Markup', license: 'cc *by* nc' },
      ],
      hitCount: 3,
      cursorMark: '*',
      query: 'foo',
    });
    const result = await runToolContract(pubmedEuropepmcSearchTool, { query: 'licensed' });

    const parsed = pubmedEuropepmcSearchTool.output.parse(result.structuredContent);
    expect(parsed.hits.map((h) => h.license)).toEqual(['cc by', undefined, 'cc *by* nc']);
    expect('license' in (parsed.hits[1] ?? {})).toBe(false);
    const text = textBlocks(result.content)
      .map((b) => b.text)
      .join('\n');
    expect(text.match(/^\*\*License:\*\*.*$/gm)).toEqual([
      '**License:** cc by',
      '**License:** cc \\*by\\* nc',
    ]);
    expect(readCommonMark(text)).toContain('⟨strong⟩License:⟨/strong⟩ cc *by* nc');
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

    it('decodes the title one layer further than the abstract, authors and journal (#272)', async () => {
      // Europe PMC escapes a title once more than the text NCBI ships, so the
      // title alone carries a residual layer; the other fields decode once.
      const value = 'Assay of &amp;lt;i&amp;gt; markers';
      mockSearch.mockResolvedValue({
        hits: [
          {
            id: 'PPR1226893',
            source: 'PPR',
            title: value,
            abstractText: value,
            authorString: value,
            journalTitle: value,
          },
        ],
        hitCount: 1,
        cursorMark: '*',
        query: 'foo',
      });
      const result = await runToolContract(pubmedEuropepmcSearchTool, { query: 'foo' });
      const parsed = pubmedEuropepmcSearchTool.output.parse(result.structuredContent);
      expect(parsed.hits[0]).toMatchObject({
        title: 'Assay of <i> markers',
        abstractSnippet: 'Assay of &lt;i&gt; markers',
        authors: 'Assay of &lt;i&gt; markers',
        journal: 'Assay of &lt;i&gt; markers',
      });
      expect(contractText(result)).toContain('\n#### Assay of \\<i> markers\n');
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
      expect(text).toContain('#### Title');
      expect(text).toContain('Smith J, Jones K');
      expect(text).toContain('**Journal:** Nature');
      expect(text).toContain('**Published:** 2024-03-15');
      expect(text).toContain('**Year:** 2024');
      expect(text).toContain('Full-text XML in EPMC:** yes');
      expect(text).toContain('**URL:** https://europepmc.org/article/MED/42');
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
    expect(contractText(result)).toContain(`**Search URL:** <${structured.searchUrl}>\n`);
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
    expect(text).toContain('**Effective Query:** `(alphafold) AND (SRC:"PPR")`');
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

describe('pubmedEuropepmcSearchTool cursor echo (issue #255)', () => {
  beforeEach(() => {
    mockSearch.mockReset();
    mockGetEpmc.mockReset();
    mockGetEpmc.mockReturnValue({ search: mockSearch });
  });

  // Europe PMC cursors are opaque base64-like tokens a caller passes back
  // verbatim; one carrying `*`, `_` or a backtick must read exactly both raw and
  // rendered.
  const cursorMark = 'AoJ*x_1_*';
  const nextCursorMark = 'AoE`q*w*';

  it('echoes both cursors exactly on the raw content[] text, structuredContent unchanged', async () => {
    mockSearch.mockResolvedValue({
      ...page(3, [], '(alphafold) AND (SRC:"PPR")'),
      cursorMark,
      nextCursorMark,
    });

    const result = await runToolContract(pubmedEuropepmcSearchTool, {
      query: 'alphafold',
      sources: ['PPR'],
      cursorMark,
    });

    expect(result.structuredContent).toMatchObject({ cursorMark, nextCursorMark });
    expect(contractText(result)).toContain(
      `**Cursor:** \`${cursorMark}\` → \`\`${nextCursorMark}\`\` (next page)\n`,
    );
  });

  it.runIf(bunMarkdown !== undefined)('renders both cursors exactly', () => {
    const text = textBlocks(
      pubmedEuropepmcSearchTool.format!({
        hits: [],
        cursorMark,
        nextCursorMark,
        searchUrl: 'https://europepmc.org/search?query=x',
        totalCount: 3,
      }),
    )[0]?.text;
    expect(renderedText(text ?? '')).toContain(
      `Cursor: ${cursorMark} → ${nextCursorMark} (next page)`,
    );
  });
});

describe('pubmedEuropepmcSearchTool blank query rejection (issue #176)', () => {
  beforeEach(() => {
    mockSearch.mockReset();
    mockGetEpmc.mockReset();
    mockGetEpmc.mockReturnValue({ search: mockSearch });
  });

  // The source wrapper trims a blank query to `() AND (SRC:"MED")`, which
  // Europe PMC answers with every record of that source — so the check runs on
  // the caller's query, before the wrapper ever sees it.
  it.each([
    ['the default sources', { query: '   ' }],
    ['an explicit MED source', { query: '   ', sources: ['MED' as const] }],
    ['tabs and newlines', { query: '\t\n ' }],
  ])(
    'rejects a whitespace-only query with %s without calling Europe PMC',
    async (_label, input) => {
      const result = await runToolContract(pubmedEuropepmcSearchTool, { ...input, pageSize: 1 });

      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: {
          code: JsonRpcErrorCode.ValidationError,
          data: { reason: 'blank_query', retryable: false },
        },
      });
      const text = readCommonMark(contractText(result));
      expect(text).toContain('`query`');
      expect(text).toMatch(/Recovery:/);
      expect(text).toMatch(/nonblank/i);
      expect(mockSearch).not.toHaveBeenCalled();
    },
  );

  // Europe PMC answers `()` with every record of the source, and searches the
  // tag name of `<b></b>` and the entity text of `&nbsp;` as words. None of
  // them is a search term the caller wrote, so each is rejected the way
  // pubmed_search_articles rejects it: after markup is stripped and entities
  // are decoded, with parentheses disregarded.
  it.each([
    ['empty parentheses', '()'],
    ['parentheses around a space', '( )'],
    ['parentheses around a zero-width space', '(​)'],
    ['nested parentheses', '(( ))'],
    ['markup with no text', '<b></b>'],
    ['a comment', '<!-- note -->'],
    ['a no-break space entity', '&nbsp;'],
    ['a zero-width space entity', '&#8203;'],
    ['a zero-width space', '​'],
    ['a next-line character (U+0085)', '\u0085'],
    ['a control character (U+0001)', '\u0001'],
  ])('rejects %s as blank_query without calling Europe PMC', async (_label, query) => {
    const result = await runToolContract(pubmedEuropepmcSearchTool, { query, pageSize: 1 });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.ValidationError,
        message: expect.stringMatching(/no search term/),
        data: { reason: 'blank_query', retryable: false },
      },
    });
    const text = readCommonMark(contractText(result));
    expect(text).toContain('`query`');
    expect(text).toMatch(/no search term/);
    // Europe PMC searches `b` and `nbsp` as words, so nothing may say it would
    // receive or treat the query as a blank term.
    expect(text).not.toMatch(/Europe PMC (would )?(receive|treat)/i);
    expect(mockSearch).not.toHaveBeenCalled();
  });

  // The sanitized copy only decides blankness; the caller's query is what runs.
  it.each([
    ['a parenthesized query with a source filter', '(asthma) AND (SRC:"MED")'],
    ['markup around a term', '<i>Plasmodium</i> falciparum'],
    ['an entity beside a term', 'Crohn&apos;s disease'],
    ['a term beside a zero-width space', '​malaria'],
  ])('sends %s to Europe PMC exactly as written', async (_label, query) => {
    mockSearch.mockResolvedValue({ hits: [], hitCount: 3, cursorMark: '*', query });

    const result = await runToolContract(pubmedEuropepmcSearchTool, { query, pageSize: 1 });

    expect(result.isError).toBeFalsy();
    expect(mockSearch).toHaveBeenCalledTimes(1);
    expect(mockSearch).toHaveBeenCalledWith(expect.objectContaining({ query }));
  });

  it('declares blank_query as a non-retryable input error', () => {
    expect(pubmedEuropepmcSearchTool.errors?.find((e) => e.reason === 'blank_query')).toMatchObject(
      { code: JsonRpcErrorCode.ValidationError, retryable: false },
    );
  });

  it('describes the rejection in the advertised `query` description', () => {
    const description = pubmedEuropepmcSearchTool.input.shape.query.description ?? '';
    expect(description).toMatch(/no search term/i);
    expect(description).toContain('`()`');
    expect(description).toContain('`<b></b>`');
    expect(description).toMatch(/rejected/);
    expect(description).toMatch(/sent as written/);
  });
});

describe('pubmedEuropepmcSearchTool blank cursorMark rejection (issue #180)', () => {
  beforeEach(() => {
    mockSearch.mockReset();
    mockGetEpmc.mockReset();
    mockGetEpmc.mockReturnValue({ search: mockSearch });
  });

  // Europe PMC answers a whitespace cursor with HTTP 503, its outage status —
  // and an invisible one the same way, which `.trim()` does not catch.
  it.each([
    ['spaces', '   '],
    ['a tab', '\t'],
    ['a newline between spaces', ' \n '],
    ['a next-line character (U+0085)', '\u0085'],
    ['a zero-width space', '​'],
    ['a word joiner between spaces', ' ⁠ '],
    ['a control character (U+0001)', '\u0001'],
  ])('rejects a cursorMark of %s without calling Europe PMC', async (_label, cursorMark) => {
    const result = await runToolContract(pubmedEuropepmcSearchTool, {
      query: 'malaria',
      cursorMark,
      pageSize: 1,
    });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.ValidationError,
        message: expect.stringContaining('`cursorMark`'),
        data: {
          reason: 'blank_cursor',
          retryable: false,
          recovery: { hint: expect.stringContaining('`nextCursorMark`') },
        },
      },
    });
    const text = readCommonMark(contractText(result));
    expect(text).toContain('`cursorMark`');
    expect(text).toMatch(/Recovery: .*`nextCursorMark`/);
    expect(text).toContain('(reason blank_cursor · not retryable');
    expect(mockSearch).not.toHaveBeenCalled();
  });

  it('passes an exactly-empty cursorMark to the service as written', async () => {
    mockSearch.mockResolvedValue({ hits: [], hitCount: 0, cursorMark: '', query: 'malaria' });

    const result = await runToolContract(pubmedEuropepmcSearchTool, {
      query: 'malaria',
      cursorMark: '',
    });

    expect(result.isError).toBeFalsy();
    expect(mockSearch).toHaveBeenCalledWith(expect.objectContaining({ cursorMark: '' }));
  });

  it('declares blank_cursor as a non-retryable input error', () => {
    expect(
      pubmedEuropepmcSearchTool.errors?.find((e) => e.reason === 'blank_cursor'),
    ).toMatchObject({ code: JsonRpcErrorCode.ValidationError, retryable: false });
  });

  it('counts invisible characters as blank in the blank_cursor contract', () => {
    const entry = pubmedEuropepmcSearchTool.errors?.find((e) => e.reason === 'blank_cursor');
    expect(entry?.when).toMatch(/invisible/i);
  });

  it('describes cursor handling in the advertised `cursorMark` description', () => {
    const description = pubmedEuropepmcSearchTool.input.shape.cursorMark.description ?? '';
    expect(description).toMatch(/whitespace-only/i);
    expect(description).toContain('europepmc_invalid_input');
    expect(description).toMatch(/verbatim/);
    expect(description).toContain(
      'Under relevance ranking (no `sort`), a record can reappear on the next page, so de-duplicate hits by `epmcId` across pages.',
    );
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

describe('pubmedEuropepmcSearchTool entity-encoded title markup (issue #181)', () => {
  beforeEach(() => {
    mockSearch.mockReset();
    mockGetEpmc.mockReset();
    mockGetEpmc.mockReturnValue({ search: mockSearch });
  });

  it('reads a MED title clean on both surfaces', async () => {
    // Europe PMC's core record for MED/42631465: the PubMed title's `<b>`
    // arrives entity-encoded, the abstract's `<h4>` raw.
    mockSearch.mockResolvedValue(
      page(
        1,
        [
          {
            id: '42631465',
            source: 'MED',
            pmid: '42631465',
            title:
              '&lt;b&gt;Molecular mechanism of ephedrine-regulated ferroptosis in asthma via PKM2-ACSL4 lactylation&lt;/b&gt;.',
            authorString: 'Zhao L, Xia R, Zeng S, Yan X.',
            journalTitle: 'Pakistan journal of pharmaceutical sciences',
            abstractText: '<h4>Background</h4>Asthma is a chronic airway inflammatory disease.',
          },
        ],
        'EXT_ID:42631465 AND SRC:MED',
      ),
    );

    const result = await runToolContract(pubmedEuropepmcSearchTool, {
      query: 'EXT_ID:42631465 AND SRC:MED',
      pageSize: 1,
    });

    expect(result.isError).toBeFalsy();
    const title =
      'Molecular mechanism of ephedrine-regulated ferroptosis in asthma via PKM2-ACSL4 lactylation.';
    const { hits } = result.structuredContent as {
      hits: Array<{ title?: string; abstractSnippet?: string }>;
    };
    expect(hits[0]?.title).toBe(title);
    expect(hits[0]?.abstractSnippet).toBe(
      'Background Asthma is a chronic airway inflammatory disease.',
    );
    const text = contractText(result);
    expect(text).toContain(`#### ${title}`);
    expect(text).not.toMatch(/<\/?b>|\\</);
  });
});

describe('pubmedEuropepmcSearchTool literal tag-shaped terms in PAT records (issue #256)', () => {
  beforeEach(() => {
    mockSearch.mockReset();
    mockGetEpmc.mockReset();
    mockGetEpmc.mockReturnValue({ search: mockSearch });
  });

  it('keeps `HuMab<CD20>` in the abstract snippet (PAT/US2011076273)', async () => {
    // The opening of Europe PMC's core abstract for PAT/US2011076273, verbatim.
    mockSearch.mockResolvedValue(
      page(
        1,
        [
          {
            id: 'US2011076273',
            source: 'PAT',
            title: 'Highly Concentrated Pharmaceutical Formulations',
            abstractText:
              'The present invention relates to a highly concentrated, stable pharmaceutical formulation of a pharmaceutically active anti-CD20 antibody, such as e.g. Rituximab, Ocrelizumab, or HuMab<CD20>, or a mixture of such antibody molecules for subcutaneous injection.',
          },
        ],
        'EXT_ID:US2011076273 AND SRC:PAT',
      ),
    );

    const result = await runToolContract(pubmedEuropepmcSearchTool, {
      query: 'EXT_ID:US2011076273',
      sources: ['PAT'],
      pageSize: 1,
    });

    expect(result.isError).toBeFalsy();
    const { hits } = result.structuredContent as { hits: Array<{ abstractSnippet?: string }> };
    expect(hits[0]?.abstractSnippet).toContain('Ocrelizumab, or HuMab<CD20>, or a mixture');
    // Escaped in `content[]`, where a renderer would otherwise read `<CD20>`
    // as a raw HTML tag and hide it. (#255)
    expect(contractText(result)).toContain('Ocrelizumab, or HuMab\\<CD20>, or a mixture');
  });
});

describe('pubmedEuropepmcSearchTool content[] escaping of the abstract snippet (issue #255)', () => {
  beforeEach(() => {
    mockSearch.mockReset();
    mockGetEpmc.mockReset();
    mockGetEpmc.mockReturnValue({ search: mockSearch });
  });

  it('escapes paired HGVS asterisks in the snippet and keeps the structured snippet plain', async () => {
    const abstractText =
      'Biallelic variants: [c.666delT, p.(F222Lfs*46); c.2289dupC, p.(V764Rfs*19)] in EPB41L3.';
    mockSearch.mockResolvedValue(
      page(
        1,
        [{ id: '39292993', source: 'MED', pmid: '39292993', title: 'EPB41L3', abstractText }],
        'EXT_ID:39292993 AND SRC:MED',
      ),
    );

    const result = await runToolContract(pubmedEuropepmcSearchTool, {
      query: 'EXT_ID:39292993',
      sources: ['MED'],
      pageSize: 1,
    });

    expect(result.isError).toBeFalsy();
    const { hits } = result.structuredContent as { hits: Array<{ abstractSnippet?: string }> };
    expect(hits[0]?.abstractSnippet).toBe(abstractText);
    expect(contractText(result)).toContain(
      '\nBiallelic variants: [c.666delT, p.(F222Lfs\\*46); c.2289dupC, p.(V764Rfs\\*19)] in EPB41L3.',
    );
  });

  it('escapes a block marker opening the snippet and an upstream DOI', async () => {
    mockSearch.mockResolvedValue(
      page(
        1,
        [
          {
            id: 'PPR1',
            source: 'PPR',
            doi: '10.1101/[x](y)',
            title: 'A preprint',
            abstractText: '# 3 cohorts were enrolled',
          },
        ],
        'PPR1',
      ),
    );

    const result = await runToolContract(pubmedEuropepmcSearchTool, { query: 'PPR1' });

    const text = contractText(result);
    expect(text).toContain('\n\\# 3 cohorts were enrolled');
    expect(text).toContain('**DOI:** 10.1101/\\[x\\](y)');
  });

  it('sets the truncation note apart, so a backtick the cut left lone cannot pair with its code spans', async () => {
    mockSearch.mockResolvedValue(
      page(
        1,
        [{ id: 'PAT1', source: 'PAT', title: 't', abstractText: `The 5\` UTR ${'b'.repeat(900)}` }],
        'foo',
      ),
    );

    const result = await runToolContract(pubmedEuropepmcSearchTool, { query: 'foo' });

    const text = contractText(result);
    expect(text).toContain('The 5` UTR b');
    expect(text).toMatch(/b…\n\n_Abstract truncated at 400 characters/);
  });
});

describe('pubmedEuropepmcSearchTool source case and the fetch hand-off (issue #244)', () => {
  beforeEach(() => {
    mockSearch.mockReset();
    mockGetEpmc.mockReset();
    mockGetEpmc.mockReturnValue({ search: mockSearch });
    mockSearch.mockResolvedValue(
      page(
        2,
        [
          { id: 'PPR1', source: 'PPR', title: 'A preprint' },
          { id: '111', source: 'MED', title: 'An article', pmid: '111' },
        ],
        '(sepsis) AND (SRC:"MED" OR SRC:"PPR")',
      ),
    );
  });

  it('searches lower-case `sources` exactly as it searches the upper-case codes', async () => {
    const lower = await runToolContract(pubmedEuropepmcSearchTool, {
      query: 'sepsis',
      sources: ['med', 'ppr'] as never,
    });
    const upper = await runToolContract(pubmedEuropepmcSearchTool, {
      query: 'sepsis',
      sources: ['MED', 'PPR'],
    });

    expect(lower.isError).toBeFalsy();
    expect(mockSearch).toHaveBeenCalledTimes(2);
    expect(mockSearch.mock.calls[0]?.[0]).toMatchObject({ sources: ['MED', 'PPR'] });
    expect(mockSearch.mock.calls[1]?.[0]).toMatchObject({ sources: ['MED', 'PPR'] });
    expect(lower.structuredContent).toEqual(upper.structuredContent);
    expect(contractText(lower)).toBe(contractText(upper));
    expect(contractText(lower)).toContain('**Sources:** MED, PPR');
  });

  it.each([['pubmed'], ['pmid'], ['']])(
    'still rejects %j, listing the source codes, with no search',
    async (value) => {
      const result = await runToolContract(pubmedEuropepmcSearchTool, {
        query: 'sepsis',
        sources: [value] as never,
      });

      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: { code: JsonRpcErrorCode.InvalidParams },
      });
      expect(readCommonMark(contractText(result))).toContain('"MED"|"PMC"|"PPR"|"PAT"|"AGR"');
      expect(mockSearch).not.toHaveBeenCalled();
    },
  );

  it('advertises `sources` items as the plain upper-case enum', () => {
    const schema = z.toJSONSchema(pubmedEuropepmcSearchTool.input, { io: 'input' }) as unknown as {
      properties: Record<string, Record<string, unknown>>;
    };
    // Serialized, so key order counts: the advertised bytes are what must not move.
    expect(JSON.stringify(schema.properties.sources?.items)).toBe(
      JSON.stringify({ type: 'string', enum: ['MED', 'PMC', 'PPR', 'PAT', 'AGR'] }),
    );
  });

  it('names the `records` shape on every text that hands a hit to the fetch tool', async () => {
    const shape = '`pubmed_europepmc_fetch` as `records: [{ source, epmcId }]`';
    const hitShape = pubmedEuropepmcSearchTool.output.shape.hits.element.shape;
    expect(pubmedEuropepmcSearchTool.description).toContain(shape);
    expect(hitShape.epmcId.description).toContain(shape);
    expect(hitShape.abstractTruncated.description).toContain(shape);

    mockSearch.mockResolvedValue(
      page(1, [{ id: 'PPR1', source: 'PPR', abstractText: 'x'.repeat(900) }], 'q'),
    );
    const result = await runToolContract(pubmedEuropepmcSearchTool, { query: 'sepsis' });
    expect(contractText(result)).toContain(
      '_Abstract truncated at 400 characters — pass this hit to `pubmed_europepmc_fetch` as `records: [{ source, epmcId }]` for the complete text._',
    );
  });

  it('documents FIRST_IDATE_D and the relevance rewrite in the `sort` description (#239)', () => {
    const description = pubmedEuropepmcSearchTool.input.shape.sort.description ?? '';
    expect(description).toContain('`FIRST_IDATE_D` (date first indexed in Europe PMC)');
    expect(description).toContain('`relevance` or `relevance desc` is sent as no sort');
    expect(description).toContain(
      'a key without a direction, an empty key, or an extra word fails with `europepmc_invalid_input` before the request',
    );
  });
});

describe('pubmedEuropepmcSearchTool NCBI records with a residual entity layer (#262, #272)', () => {
  beforeEach(() => {
    mockSearch.mockReset();
    mockGetEpmc.mockReset();
    mockGetEpmc.mockReturnValue({ search: mockSearch });
  });

  it('returns the title as pubmed_fetch_articles does and a snippet free of encoded tags', async () => {
    mockSearch.mockResolvedValue(
      page(2, [EPMC_APOS_TITLE_HIT, EPMC_ENCODED_TAGS_HIT], '(EXT_ID:42138044) AND (SRC:"MED")'),
    );

    const result = await runToolContract(pubmedEuropepmcSearchTool, { query: 'EXT_ID:42138044' });

    const { hits } = result.structuredContent as {
      hits: Array<{ title?: string; abstractSnippet?: string }>;
    };
    const title =
      "Cervical Vestibular-Evoked Myogenic Potentials (cVEMPs) in Parkinson's Disease Patients: Prospective, Case-Control study.";
    expect(hits[0]?.title).toBe(title);
    expect(hits[1]?.abstractSnippet).toMatch(
      /^Introduction: Pollen monitoring plays an important role in modern allergy care\. Quantitatively determining airborne pollen concentrations serves as a clinically relevant tool for /,
    );
    expect(hits[1]?.abstractSnippet).not.toMatch(/<|&lt;/);
    const text = contractText(result);
    expect(text).toContain(`\n#### ${title}\n`);
    // The snippet holds no character the prose escape touches, so content[]
    // carries it as its own paragraph, whole.
    expect(text).toContain(`\n\n${hits[1]?.abstractSnippet}\n\n_Abstract truncated at `);
  });
});

describe('pubmedEuropepmcSearchTool hit lines that share a paragraph (#261)', () => {
  it('keeps a lone delimiter in each of two values visible', () => {
    const text =
      textBlocks(
        pubmedEuropepmcSearchTool.format!({
          hits: [
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
          cursorMark: '*',
          searchUrl: 'https://europepmc.org/search?query=x',
          totalCount: 1,
        }),
      )[0]?.text ?? '';

    expect(text).toContain('\n#### HLA-B*57:01 carriers\n');
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
});

describe('pubmedEuropepmcSearchTool effective query and Search URL (#263)', () => {
  beforeEach(() => {
    mockSearch.mockReset();
    mockGetEpmc.mockReset();
    mockGetEpmc.mockReturnValue({ search: mockSearch });
  });

  it('renders the effective query as a code span and the Search URL as an autolink', async () => {
    const echoed = '(TITLE:"HLA-B*57" AND `x` AND a_b_) AND (SRC:"MED")';
    mockSearch.mockResolvedValue(page(0, [], echoed));

    const result = await runToolContract(pubmedEuropepmcSearchTool, {
      query: 'TITLE:"HLA-B*57" AND `x` AND a_b_',
      sources: ['MED'],
    });

    const { searchUrl } = result.structuredContent as { searchUrl: string };
    const raw = contractText(result);
    expect(raw).toContain(`**Effective Query:** \`\`${echoed}\`\`\n`);
    expect(raw).toContain(`**Search URL:** <${searchUrl}>\n`);
    const text = readCommonMark(raw);
    expect(text).toContain(`⟨strong⟩Effective Query:⟨/strong⟩ ⟨code_inline:${echoed}⟩`);
    const urlLine = text.split('\n').find((line) => line.startsWith('⟨strong⟩Search URL:'));
    expect(urlLine).toMatch(/^⟨strong⟩Search URL:⟨\/strong⟩ ⟨a⟩[^⟨]+⟨\/a⟩$/);
  });
});

describe('pubmedEuropepmcSearchTool journal on core results (#274)', () => {
  beforeEach(() => {
    mockSearch.mockReset();
    mockGetEpmc.mockReset();
    mockGetEpmc.mockReturnValue({ search: mockSearch });
  });

  it('reports a core hit’s journal from `journalInfo`, which core results carry in place of `journalTitle`', async () => {
    // MED/42515993 as Europe PMC's `core` result type returns it: no `journalTitle`.
    const coreHit = {
      id: '42515993',
      source: 'MED',
      pmid: '42515993',
      title: 'The role of pollen monitoring in allergology and otolaryngology.',
      journalInfo: {
        volume: '80',
        journal: {
          medlineAbbreviation: 'Otolaryngol Pol',
          title: 'Otolaryngologia polska = The Polish otolaryngology',
          isoabbreviation: 'Otolaryngol Pol',
        },
      },
    };
    mockSearch.mockResolvedValue(page(1, [coreHit], '(EXT_ID:42515993) AND (SRC:"MED")'));

    const result = await runToolContract(pubmedEuropepmcSearchTool, {
      query: 'EXT_ID:42515993',
      sources: ['MED'],
      resultType: 'core',
    });

    const { hits } = result.structuredContent as { hits: Array<{ journal?: string }> };
    expect(hits[0]?.journal).toBe('Otolaryngol Pol');
    expect(contractText(result)).toContain('\n**Journal:** Otolaryngol Pol\n');
  });
});
