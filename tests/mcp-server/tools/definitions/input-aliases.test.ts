/**
 * @fileoverview Declared `inputAliases` (issue #156), driven through the framework's
 * real argument path. `runToolContract` calls `parseToolArguments` — the alias
 * rewrite and the strict Zod parse a `tools/call` goes through — so each case
 * exercises the declaration itself rather than a hand-built input. Upstream
 * services are stubbed; every case asserts the aliased value reached the service
 * call and both response surfaces carry the result.
 *
 * `pubmed_lookup_citation`'s `citation` alias is covered with its union schema in
 * `lookup-citation.tool.test.ts`.
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
const mockEpmcSearch = vi.fn();

vi.mock('@/services/ncbi/ncbi-service.js', () => ({
  getNcbiService: () => ({
    eFetch: mockEFetch,
    eSearch: mockESearch,
    eSummary: mockESummary,
    eLink: mockELink,
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

beforeEach(() => {
  mockEFetch.mockReset();
  mockESearch.mockReset();
  mockESummary.mockReset();
  mockELink.mockReset();
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

describe('max_results / limit → pageSize', () => {
  it.each([['max_results'], ['limit']])(
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
