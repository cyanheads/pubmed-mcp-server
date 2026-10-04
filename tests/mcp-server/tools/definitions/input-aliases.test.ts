/**
 * @fileoverview Declared `inputAliases` (issues #156, #190), driven through the framework's
 * real argument path. `runToolContract` calls `parseToolArguments` — the alias
 * rewrite and the strict Zod parse a `tools/call` goes through — so each case
 * exercises the declaration itself rather than a hand-built input. Upstream
 * services are stubbed; every case asserts the aliased value reached the service
 * call and both response surfaces carry the result.
 *
 * `pubmed_lookup_citation`'s `citation` alias is covered with its single-object
 * handling in `lookup-citation.tool.test.ts`.
 * @module tests/mcp-server/tools/definitions/input-aliases.test
 */

import type { ContentBlock } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { textBlocks } from '../../../_helpers.js';
import {
  articleSetXml,
  JOURNAL_ARTICLE_XML,
  parseArticleSetXml,
} from '../../../services/ncbi/parsing/_book-fixtures.js';

const mockEFetch = vi.fn();
const mockESearch = vi.fn();
const mockESummary = vi.fn();
const mockELink = vi.fn();
const mockESpell = vi.fn();
const mockEpmcSearch = vi.fn();

vi.mock('@/services/ncbi/ncbi-service.js', () => ({
  getNcbiService: () => ({
    eFetch: mockEFetch,
    eSearch: mockESearch,
    eSummary: mockESummary,
    eLink: mockELink,
    eSpell: mockESpell,
  }),
}));
vi.mock('@/services/europe-pmc/europe-pmc-service.js', () => ({
  getEuropePmcService: () => ({ search: mockEpmcSearch }),
}));
vi.mock('@/services/openalex/openalex-service.js', () => ({
  getOpenAlexServiceOptional: () => undefined,
}));

const { fetchArticlesTool } = await import('@/mcp-server/tools/definitions/fetch-articles.tool.js');
const { formatCitationsTool } = await import(
  '@/mcp-server/tools/definitions/format-citations.tool.js'
);
const { searchArticlesTool } = await import(
  '@/mcp-server/tools/definitions/search-articles.tool.js'
);
const { findRelatedTool } = await import('@/mcp-server/tools/definitions/find-related.tool.js');
const { lookupMeshTool } = await import('@/mcp-server/tools/definitions/lookup-mesh.tool.js');
const { pubmedEuropepmcSearchTool } = await import(
  '@/mcp-server/tools/definitions/pubmed-europepmc-search.tool.js'
);
const { spellCheckTool } = await import('@/mcp-server/tools/definitions/spell-check.tool.js');

/** PMID of {@link JOURNAL_ARTICLE_XML}. */
const PMID = '42474064';

/**
 * Call a tool with raw client arguments. An alias is not part of the input type
 * by design — it never appears in the advertised schema — so the arguments are
 * passed untyped, exactly as they arrive over the wire.
 */
function callRaw(
  tool: Parameters<typeof runToolContract>[0],
  args: Record<string, unknown>,
): ReturnType<typeof runToolContract> {
  return runToolContract(tool, args as never);
}

function textOf(result: Awaited<ReturnType<typeof runToolContract>>): string {
  return textBlocks(result.content as ContentBlock[])
    .map((b) => b.text)
    .join('\n');
}

/**
 * A MeSH ESearch with 30 ranked records and no exact-descriptor match, and an
 * ESummary that names each requested UID.
 */
function stubMesh(): void {
  mockESearch.mockImplementation(async (params: { term: string }) =>
    params.term.endsWith('[MH]')
      ? { count: 0, idList: [] }
      : { count: 30, idList: ['68001', '68002', '68003'] },
  );
  mockESummary.mockImplementation(async (params: { id: string }) => ({
    eSummaryResult: {
      DocSum: params.id.split(',').map((id) => ({
        Id: id,
        Item: [{ '@_Name': 'DS_MeshTerms', Item: [{ '#text': `Descriptor ${id}` }] }],
      })),
    },
  }));
}

/** The ranked (non-`[MH]`) MeSH ESearch call. */
function meshRankedCall(): Record<string, unknown> | undefined {
  return mockESearch.mock.calls.find((c) => !String(c[0].term).endsWith('[MH]'))?.[0];
}

beforeEach(() => {
  mockEFetch.mockReset();
  mockESearch.mockReset();
  mockESummary.mockReset();
  mockELink.mockReset();
  mockESpell.mockReset();
  mockEpmcSearch.mockReset();
  mockEFetch.mockResolvedValue({
    PubmedArticleSet: parseArticleSetXml(articleSetXml(JOURNAL_ARTICLE_XML)),
  });
});

describe('ids → pmids', () => {
  it('pubmed_fetch_articles resolves `ids` as `pmids`', async () => {
    const result = await callRaw(fetchArticlesTool, { ids: [PMID], includeMesh: false });

    expect(result.isError).toBeFalsy();
    expect(mockEFetch.mock.calls[0]?.[0]).toMatchObject({ db: 'pubmed', id: PMID });
    const structured = result.structuredContent as { articles: { pmid?: string }[] };
    expect(structured.articles.map((a) => a.pmid)).toEqual([PMID]);
    expect(textOf(result)).toContain(`**PMID:** ${PMID}`);
  });

  it('pubmed_format_citations resolves `ids` as `pmids`', async () => {
    const result = await callRaw(formatCitationsTool, { ids: [PMID], format: 'vancouver' });

    expect(result.isError).toBeFalsy();
    expect(mockEFetch.mock.calls[0]?.[0]).toMatchObject({ db: 'pubmed', id: PMID });
    expect(result.structuredContent).toMatchObject({ totalSubmitted: 1, totalFormatted: 1 });
    expect(textOf(result)).toContain(`## PMID ${PMID}`);
  });

  it('rejects a call carrying both the alias and the canonical key, naming the alias', async () => {
    const result = await callRaw(fetchArticlesTool, { ids: [PMID], pmids: [PMID] });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: { code: JsonRpcErrorCode.InvalidParams, data: { reason: 'invalid_arguments' } },
    });
    expect(textOf(result)).toContain('"ids"');
    expect(mockEFetch).not.toHaveBeenCalled();
  });
});

describe('limit → maxResults', () => {
  it('pubmed_search_articles resolves `limit` as `maxResults`', async () => {
    mockESearch.mockResolvedValue({ count: 40, idList: ['1', '2', '3'], retmax: 3, retstart: 0 });
    const result = await callRaw(searchArticlesTool, { query: 'asthma', limit: 3 });

    expect(result.isError).toBeFalsy();
    expect(mockESearch.mock.calls[0]?.[0]).toMatchObject({ term: 'asthma', retmax: 3 });
    expect(result.structuredContent).toMatchObject({ pmids: ['1', '2', '3'] });
    expect(textOf(result)).toContain('**Returned:** 3');
  });

  it('pubmed_search_articles already resolves the case-style `max_results` with no declaration', async () => {
    mockESearch.mockResolvedValue({ count: 40, idList: ['1', '2'], retmax: 2, retstart: 0 });
    const result = await callRaw(searchArticlesTool, { query: 'asthma', max_results: 2 });

    expect(result.isError).toBeFalsy();
    expect(mockESearch.mock.calls[0]?.[0]).toMatchObject({ retmax: 2 });
  });

  it('pubmed_find_related resolves `limit` as `maxResults`', async () => {
    mockELink.mockResolvedValue({
      eLinkResult: [
        {
          LinkSet: {
            LinkSetDb: {
              LinkName: 'pubmed_pubmed',
              Link: ['11', '12', '13', '14', '15'].map((id) => ({ Id: id })),
            },
          },
        },
      ],
    });
    // Enrichment failing degrades to bare PMIDs — the window is still the observable.
    mockESummary.mockRejectedValue(new Error('eSummary down'));
    const result = await callRaw(findRelatedTool, { pmid: '10', limit: 2 });

    expect(result.isError).toBeFalsy();
    expect(mockESummary.mock.calls[0]?.[0]).toMatchObject({ id: '11,12' });
    const structured = result.structuredContent as { articles: { pmid: string }[] };
    expect(structured.articles.map((a) => a.pmid)).toEqual(['11', '12']);
    expect(textOf(result)).toContain('**Returned:** 2');
  });

  it('pubmed_lookup_mesh resolves `limit` as `maxResults`', async () => {
    stubMesh();
    const result = await callRaw(lookupMeshTool, {
      query: 'asthma',
      limit: 2,
      includeDetails: false,
    });

    expect(result.isError).toBeFalsy();
    expect(mockESearch.mock.calls.find((c) => c[0].term === 'asthma')?.[0]).toMatchObject({
      retmax: 2,
    });
    const structured = result.structuredContent as { results: { name: string }[] };
    expect(structured.results).toHaveLength(2);
    expect(textOf(result)).toContain('Found **2** result(s)');
  });
});

describe('each alias is load-bearing', () => {
  // Control: the same raw call against the definition with its declaration
  // removed is rejected by name, so every success above is the declaration at
  // work and not a looser schema.
  it.each([
    ['pubmed_fetch_articles', fetchArticlesTool, { ids: [PMID] }, 'ids'],
    ['pubmed_format_citations', formatCitationsTool, { ids: [PMID] }, 'ids'],
    ['pubmed_search_articles', searchArticlesTool, { query: 'asthma', limit: 3 }, 'limit'],
    ['pubmed_find_related', findRelatedTool, { pmid: '10', limit: 2 }, 'limit'],
    ['pubmed_lookup_mesh', lookupMeshTool, { query: 'asthma', limit: 2 }, 'limit'],
    [
      'pubmed_europepmc_search',
      pubmedEuropepmcSearchTool,
      { query: 'crispr', max_results: 7 },
      'max_results',
    ],
    ['pubmed_europepmc_search', pubmedEuropepmcSearchTool, { query: 'crispr', limit: 7 }, 'limit'],
    // #190
    ['pubmed_search_articles', searchArticlesTool, { query: 'asthma', retmax: 3 }, 'retmax'],
    [
      'pubmed_search_articles',
      searchArticlesTool,
      { query: 'asthma', num_results: 3 },
      'num_results',
    ],
    ['pubmed_search_articles', searchArticlesTool, { query: 'asthma', pageSize: 3 }, 'pageSize'],
    ['pubmed_search_articles', searchArticlesTool, { term: 'asthma' }, 'term'],
    ['pubmed_search_articles', searchArticlesTool, { queryTerm: 'asthma' }, 'queryTerm'],
    ['pubmed_search_articles', searchArticlesTool, { query: 'asthma', retstart: 5 }, 'retstart'],
    [
      'pubmed_search_articles',
      searchArticlesTool,
      { query: 'asthma', sortBy: 'pub_date' },
      'sortBy',
    ],
    [
      'pubmed_europepmc_search',
      pubmedEuropepmcSearchTool,
      { query: 'crispr', maxResults: 7 },
      'maxResults',
    ],
    ['pubmed_lookup_mesh', lookupMeshTool, { query: 'asthma', retmax: 2 }, 'retmax'],
    ['pubmed_lookup_mesh', lookupMeshTool, { query: 'asthma', pageSize: 2 }, 'pageSize'],
    ['pubmed_lookup_mesh', lookupMeshTool, { query: 'asthma', retstart: 1 }, 'retstart'],
    ['pubmed_lookup_mesh', lookupMeshTool, { term: 'asthma' }, 'term'],
    ['pubmed_find_related', findRelatedTool, { pmid: '10', pageSize: 2 }, 'pageSize'],
    ['pubmed_spell_check', spellCheckTool, { term: 'asthmaa' }, 'term'],
  ] as const)(
    '%s rejects `%s` once its inputAliases entry is removed',
    async (_name, tool, args, key) => {
      expect(tool.inputAliases).toHaveProperty(key);
      const { inputAliases: _declared, ...undeclared } = tool;
      const result = await callRaw(undeclared, { ...args });

      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain(`Unrecognized key: "${key}"`);
    },
  );
});

describe('max_results / limit / maxResults → pageSize', () => {
  it.each([['max_results'], ['limit'], ['maxResults']])(
    'pubmed_europepmc_search resolves `%s` as `pageSize`',
    async (alias) => {
      mockEpmcSearch.mockResolvedValue({ hits: [], hitCount: 0, query: 'crispr' });
      const result = await callRaw(pubmedEuropepmcSearchTool, { query: 'crispr', [alias]: 7 });

      expect(result.isError).toBeFalsy();
      expect(mockEpmcSearch.mock.calls[0]?.[0]).toMatchObject({ query: 'crispr', pageSize: 7 });
      expect(result.structuredContent).toMatchObject({ hits: [], totalCount: 0 });
      expect(textOf(result)).toContain('crispr');
    },
  );
});

describe('E-utility and sibling names on pubmed_search_articles (#190)', () => {
  beforeEach(() => {
    mockESearch.mockResolvedValue({ count: 40, idList: ['1', '2', '3'], retmax: 3, retstart: 0 });
  });

  it.each([['retmax'], ['num_results'], ['pageSize']])(
    'resolves `%s` as `maxResults`',
    async (alias) => {
      const result = await callRaw(searchArticlesTool, { query: 'asthma', [alias]: 3 });

      expect(result.isError).toBeFalsy();
      expect(mockESearch.mock.calls[0]?.[0]).toMatchObject({ term: 'asthma', retmax: 3 });
      expect(result.structuredContent).toMatchObject({ pmids: ['1', '2', '3'] });
      expect(textOf(result)).toContain('**Returned:** 3 of 40');
    },
  );

  it.each([['term'], ['queryTerm']])('resolves `%s` as `query`', async (alias) => {
    const result = await callRaw(searchArticlesTool, { [alias]: 'ferroptosis' });

    expect(result.isError).toBeFalsy();
    expect(mockESearch.mock.calls[0]?.[0]).toMatchObject({ term: 'ferroptosis' });
    expect(result.structuredContent).toMatchObject({ query: 'ferroptosis' });
    expect(textOf(result)).toContain('**Query:** ferroptosis');
  });

  it('resolves `retstart` as `offset`', async () => {
    const result = await callRaw(searchArticlesTool, { query: 'asthma', retstart: 5 });

    expect(result.isError).toBeFalsy();
    expect(mockESearch.mock.calls[0]?.[0]).toMatchObject({ retstart: 5 });
    expect(result.structuredContent).toMatchObject({ offset: 5 });
    expect(textOf(result)).toContain('**Offset:** 5');
  });

  it('resolves `sortBy` as `sort`', async () => {
    const result = await callRaw(searchArticlesTool, { query: 'asthma', sortBy: 'pub_date' });

    expect(result.isError).toBeFalsy();
    expect(mockESearch.mock.calls[0]?.[0]).toMatchObject({ sort: 'pub_date' });
    expect(result.structuredContent).toMatchObject({ pmids: ['1', '2', '3'] });
    expect(textOf(result)).toContain('**PMIDs:** 1, 2, 3');
  });

  it('resolves every alias of one call together', async () => {
    mockESearch.mockResolvedValue({
      count: 31104,
      idList: ['6', '7', '8'],
      retmax: 3,
      retstart: 5,
    });
    const result = await callRaw(searchArticlesTool, {
      term: 'ferroptosis',
      retstart: 5,
      sortBy: 'pub_date',
      num_results: 3,
    });

    expect(result.isError).toBeFalsy();
    expect(mockESearch).toHaveBeenCalledTimes(1);
    expect(mockESearch.mock.calls[0]?.[0]).toMatchObject({
      term: 'ferroptosis',
      retmax: 3,
      retstart: 5,
      sort: 'pub_date',
    });
    expect(result.structuredContent).toMatchObject({
      query: 'ferroptosis',
      offset: 5,
      pmids: ['6', '7', '8'],
      totalCount: 31104,
    });
    expect(textOf(result)).toContain('**Returned:** 3 of 31104 | **Offset:** 5');
  });
});

describe('E-utility and sibling names on pubmed_lookup_mesh (#190)', () => {
  beforeEach(stubMesh);

  it.each([['retmax'], ['pageSize']])('resolves `%s` as `maxResults`', async (alias) => {
    const result = await callRaw(lookupMeshTool, {
      query: 'asthma',
      [alias]: 2,
      includeDetails: false,
    });

    expect(result.isError).toBeFalsy();
    expect(meshRankedCall()).toMatchObject({ db: 'mesh', term: 'asthma', retmax: 2 });
    const structured = result.structuredContent as { results: { name: string }[] };
    expect(structured.results.map((r) => r.name)).toEqual(['Descriptor 68001', 'Descriptor 68002']);
    expect(textOf(result)).toContain('Found **2** result(s)');
  });

  it('resolves `retstart` as `offset`', async () => {
    const result = await callRaw(lookupMeshTool, {
      query: 'asthma',
      retstart: 4,
      includeDetails: false,
    });

    expect(result.isError).toBeFalsy();
    expect(meshRankedCall()).toMatchObject({ term: 'asthma', retstart: 4 });
    expect(result.structuredContent).toMatchObject({ offset: 4 });
  });

  it('resolves `term` as `query`', async () => {
    const result = await callRaw(lookupMeshTool, { term: 'asthma', includeDetails: false });

    expect(result.isError).toBeFalsy();
    expect(meshRankedCall()).toMatchObject({ term: 'asthma' });
    expect(result.structuredContent).toMatchObject({ query: 'asthma' });
    expect(textOf(result)).toContain('asthma');
  });
});

describe('sibling names on pubmed_find_related and pubmed_spell_check (#190)', () => {
  it('pubmed_find_related resolves `pageSize` as `maxResults`', async () => {
    mockELink.mockResolvedValue({
      eLinkResult: [
        {
          LinkSet: {
            LinkSetDb: {
              LinkName: 'pubmed_pubmed',
              Link: ['11', '12', '13', '14', '15'].map((id) => ({ Id: id })),
            },
          },
        },
      ],
    });
    mockESummary.mockRejectedValue(new Error('eSummary down'));
    const result = await callRaw(findRelatedTool, { pmid: '10', pageSize: 3 });

    expect(result.isError).toBeFalsy();
    expect(mockESummary.mock.calls[0]?.[0]).toMatchObject({ id: '11,12,13' });
    const structured = result.structuredContent as { articles: { pmid: string }[] };
    expect(structured.articles.map((a) => a.pmid)).toEqual(['11', '12', '13']);
    expect(textOf(result)).toContain('**Returned:** 3');
  });

  it('pubmed_spell_check resolves `term` as `query`', async () => {
    mockESpell.mockResolvedValue({
      original: 'asthmaa',
      corrected: 'asthma',
      hasSuggestion: true,
    });
    const result = await callRaw(spellCheckTool, { term: 'asthmaa' });

    expect(result.isError).toBeFalsy();
    expect(mockESpell.mock.calls[0]?.[0]).toEqual({ db: 'pubmed', term: 'asthmaa' });
    expect(result.structuredContent).toEqual({
      original: 'asthmaa',
      corrected: 'asthma',
      hasSuggestion: true,
    });
    expect(textOf(result)).toContain('**Suggestion:** "asthma" (original: "asthmaa")');
  });
});

describe('an alias sent with its target is still rejected (#190)', () => {
  it.each([
    ['pubmed_search_articles', searchArticlesTool, { query: 'asthma', term: 'copd' }, 'term'],
    [
      'pubmed_search_articles',
      searchArticlesTool,
      { query: 'asthma', maxResults: 3, retmax: 5 },
      'retmax',
    ],
    [
      'pubmed_search_articles',
      searchArticlesTool,
      { query: 'asthma', offset: 0, retstart: 5 },
      'retstart',
    ],
    [
      'pubmed_search_articles',
      searchArticlesTool,
      { query: 'asthma', sort: 'relevance', sortBy: 'pub_date' },
      'sortBy',
    ],
    [
      'pubmed_europepmc_search',
      pubmedEuropepmcSearchTool,
      { query: 'crispr', pageSize: 5, maxResults: 7 },
      'maxResults',
    ],
    ['pubmed_lookup_mesh', lookupMeshTool, { query: 'asthma', offset: 0, retstart: 2 }, 'retstart'],
    ['pubmed_lookup_mesh', lookupMeshTool, { query: 'asthma', term: 'copd' }, 'term'],
    [
      'pubmed_find_related',
      findRelatedTool,
      { pmid: '10', maxResults: 2, pageSize: 3 },
      'pageSize',
    ],
    ['pubmed_spell_check', spellCheckTool, { query: 'asthma', term: 'copd' }, 'term'],
  ] as const)('%s rejects `%s` beside its target', async (_name, tool, args, key) => {
    const result = await callRaw(tool, { ...args });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: { code: JsonRpcErrorCode.InvalidParams, data: { reason: 'invalid_arguments' } },
    });
    expect(textOf(result)).toContain(`Unrecognized key: "${key}"`);
    expect(mockESearch).not.toHaveBeenCalled();
    expect(mockEpmcSearch).not.toHaveBeenCalled();
    expect(mockELink).not.toHaveBeenCalled();
    expect(mockESpell).not.toHaveBeenCalled();
  });
});

describe("an aliased value meets its target's bounds (#190)", () => {
  it.each([
    [
      'pubmed_europepmc_search',
      pubmedEuropepmcSearchTool,
      { query: 'crispr', maxResults: 101 },
      'pageSize',
      'maxResults',
    ],
    [
      'pubmed_search_articles',
      searchArticlesTool,
      { query: 'asthma', retmax: 1001 },
      'maxResults',
      'retmax',
    ],
    [
      'pubmed_search_articles',
      searchArticlesTool,
      { query: 'asthma', retstart: 9999 },
      'offset',
      'retstart',
    ],
    [
      'pubmed_lookup_mesh',
      lookupMeshTool,
      { query: 'asthma', pageSize: 51 },
      'maxResults',
      'pageSize',
    ],
    [
      'pubmed_find_related',
      findRelatedTool,
      { pmid: '10', pageSize: 51 },
      'maxResults',
      'pageSize',
    ],
    ['pubmed_spell_check', spellCheckTool, { term: 'a' }, 'query', 'term'],
  ] as const)(
    '%s rejects an out-of-bounds `%s` with the target message and the rewrite named',
    async (_name, tool, args, target, alias) => {
      const result = await callRaw(tool, { ...args });

      expect(result.isError).toBe(true);
      const text = textOf(result);
      expect(text).toContain(`${target}: Too`);
      expect(text).toContain(`Validated ${alias} as ${target}.`);
      expect(text).not.toContain(`Unrecognized key: "${alias}"`);
      expect(mockESearch).not.toHaveBeenCalled();
      expect(mockEpmcSearch).not.toHaveBeenCalled();
      expect(mockELink).not.toHaveBeenCalled();
      expect(mockESpell).not.toHaveBeenCalled();
    },
  );
});
