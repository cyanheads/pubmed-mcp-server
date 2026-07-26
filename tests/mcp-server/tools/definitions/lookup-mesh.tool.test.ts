/**
 * @fileoverview Tests for the lookup-mesh tool.
 * @module tests/mcp-server/tools/definitions/lookup-mesh.tool.test
 */

import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockESearch = vi.fn();
const mockESummary = vi.fn();
vi.mock('@/services/ncbi/ncbi-service.js', () => ({
  getNcbiService: () => ({ eSearch: mockESearch, eSummary: mockESummary }),
}));

const { lookupMeshTool } = await import('@/mcp-server/tools/definitions/lookup-mesh.tool.js');

/** Minimal MeSH DocSum for an id, named `Descriptor <n>` off the trailing digits. */
function docSum(id: string) {
  return {
    Id: id,
    Item: [{ '@_Name': 'DS_MeshTerms', Item: [{ '#text': `Descriptor ${id}` }] }],
  };
}

/** ESummary payload covering exactly the ids the handler asked for, in order. */
function summaryFor(ids: string[]) {
  return { eSummaryResult: { DocSum: ids.map(docSum) } };
}

describe('lookupMeshTool', () => {
  beforeEach(() => {
    mockESearch.mockReset();
    mockESummary.mockReset();
  });

  it('validates input with defaults', () => {
    const input = lookupMeshTool.input.parse({ query: 'Neoplasms' });
    expect(input.query).toBe('Neoplasms');
    expect(input.maxResults).toBe(10);
    expect(input.offset).toBe(0);
    expect(input.includeDetails).toBe(true);
  });

  it('rejects a negative offset', () => {
    expect(() => lookupMeshTool.input.parse({ query: 'cancer', offset: -1 })).toThrow();
  });

  it('accepts offsets past 9998 — the retstart ceiling is PubMed-only, db=mesh has none', () => {
    // Verified against eSearch db=mesh: retstart is served all the way to the
    // match count and returns an empty page beyond it, never an ERROR.
    expect(lookupMeshTool.input.safeParse({ query: 'cancer', offset: 9999 }).success).toBe(true);
    expect(lookupMeshTool.input.safeParse({ query: 'cancer', offset: 300000 }).success).toBe(true);
  });

  it('returns empty results with a recovery notice when no MeSH IDs found', async () => {
    mockESearch.mockResolvedValue({ idList: [], count: 0 });

    const ctx = createMockContext();
    const input = lookupMeshTool.input.parse({ query: 'xyznonexistent' });
    const result = await lookupMeshTool.handler(input, ctx);
    const enrichment = getEnrichment(ctx);

    expect(result.results).toEqual([]);
    expect(result.query).toBe('xyznonexistent');
    expect(enrichment.totalCount).toBe(0);
    expect(enrichment.notice).toMatch(/xyznonexistent/);
    expect(enrichment.notice).toMatch(/spell_check|search_articles/);
  });

  it('returns parsed MeSH records', async () => {
    mockESearch.mockResolvedValue({ idList: ['68009369'], count: 1 });
    mockESummary.mockResolvedValue({
      eSummaryResult: {
        DocSum: [
          {
            Id: '68009369',
            Item: [
              {
                '@_Name': 'DS_MeshTerms',
                '@_Type': 'List',
                Item: [{ '@_Name': 'string', '@_Type': 'String', '#text': 'Neoplasms' }],
              },
              {
                '@_Name': 'DS_ScopeNote',
                '@_Type': 'String',
                '#text': 'New abnormal growth of tissue.',
              },
            ],
          },
        ],
      },
    });

    const ctx = createMockContext();
    const input = lookupMeshTool.input.parse({ query: 'Neoplasms' });
    const result = await lookupMeshTool.handler(input, ctx);

    expect(result.results).toHaveLength(1);
    expect(result.results[0]?.meshId).toBe('D009369');
    expect(result.results[0]?.entrezUid).toBe('68009369');
    expect(result.results[0]?.name).toBe('Neoplasms');
    expect(result.results[0]?.scopeNote).toContain('abnormal growth');
    expect(getEnrichment(ctx).notice).toBeUndefined();
  });

  it('deduplicates exact matches, respects maxResults, and parses detailed tree metadata', async () => {
    mockESearch.mockImplementation(async (params: { term: string }) => {
      if (params.term.endsWith('[MH]')) return { idList: ['68009369'], count: 1 };
      return { idList: ['68001234', '68009369', '68009999'], count: 3 };
    });
    mockESummary.mockResolvedValue({
      eSummaryResult: {
        DocSum: [
          {
            Id: '68001234',
            Item: [
              {
                '@_Name': 'DS_MeshTerms',
                Item: [{ '#text': 'Cancer' }],
              },
            ],
          },
          {
            Id: '68009369',
            Item: [
              {
                '@_Name': 'DS_MeshTerms',
                '@_Type': 'List',
                Item: [{ '#text': 'Neoplasms' }, { '#text': 'Tumors' }],
              },
              {
                '@_Name': 'DS_ScopeNote',
                '#text': 'New abnormal growth of tissue.',
              },
              {
                '@_Name': 'DS_IdxLinks',
                Item: [
                  { Item: [{ '@_Name': 'TreeNum', '#text': 'C04' }] },
                  { Item: [{ '@_Name': 'TreeNum', '#text': 'C04.588' }] },
                  { Item: [{ '@_Name': 'DescriptorUI', '#text': 'D009369' }] },
                ],
              },
            ],
          },
        ],
      },
    });

    const ctx = createMockContext();
    const input = lookupMeshTool.input.parse({ query: 'Neoplasms', maxResults: 2 });
    const result = await lookupMeshTool.handler(input, ctx);

    expect(mockESearch).toHaveBeenCalledWith(
      { db: 'mesh', term: 'Neoplasms', retmax: 2, retstart: 0 },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(mockESearch).toHaveBeenCalledWith(
      { db: 'mesh', term: 'Neoplasms[MH]', retmax: 1 },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(mockESummary).toHaveBeenCalledWith(
      { db: 'mesh', id: '68009369,68001234' },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(result.results.map((r) => r.meshId)).toEqual(['D009369', 'D001234']);
    expect(result.results.map((r) => r.entrezUid)).toEqual(['68009369', '68001234']);
    expect(result.results[0]).toMatchObject({
      entrezUid: '68009369',
      name: 'Neoplasms',
      scopeNote: 'New abnormal growth of tissue.',
      entryTerms: ['Neoplasms', 'Tumors'],
      treeNumbers: ['C04', 'C04.588'],
    });
  });

  it('filters non-navigable @-pointer "tree numbers" from SCRs (#76)', async () => {
    mockESearch.mockImplementation(async (params: { term: string }) =>
      params.term.endsWith('[MH]')
        ? { idList: [], count: 0 }
        : { idList: ['67585596', '68008687'], count: 2 },
    );
    mockESummary.mockResolvedValue({
      eSummaryResult: {
        DocSum: [
          {
            // Supplementary Concept Record (Jentadueto): TreeNum is a mapped-heading
            // pointer (@-prefixed), not a navigable tree number.
            Id: '67585596',
            Item: [
              { '@_Name': 'DS_MeshTerms', Item: [{ '#text': 'Jentadueto' }] },
              {
                '@_Name': 'DS_IdxLinks',
                Item: [{ Item: [{ '@_Name': 'TreeNum', '#text': '@218176' }] }],
              },
            ],
          },
          {
            // True descriptor (Metformin): a real tree number plus a stray @-pointer
            // that must still be dropped.
            Id: '68008687',
            Item: [
              { '@_Name': 'DS_MeshTerms', Item: [{ '#text': 'Metformin' }] },
              {
                '@_Name': 'DS_IdxLinks',
                Item: [
                  { Item: [{ '@_Name': 'TreeNum', '#text': 'D02.078.370.141.450' }] },
                  { Item: [{ '@_Name': 'TreeNum', '#text': '@218176' }] },
                ],
              },
            ],
          },
        ],
      },
    });

    const ctx = createMockContext();
    const input = lookupMeshTool.input.parse({ query: 'metformin' });
    const result = await lookupMeshTool.handler(input, ctx);

    const jentadueto = result.results.find((r) => r.entrezUid === '67585596');
    const metformin = result.results.find((r) => r.entrezUid === '68008687');
    // SCR with only an @-pointer → treeNumbers omitted entirely.
    expect(jentadueto?.treeNumbers).toBeUndefined();
    // Descriptor keeps the real tree number; the @-pointer is filtered out.
    expect(metformin?.treeNumbers).toEqual(['D02.078.370.141.450']);
  });

  it('skips exact MeSH search for tagged queries and omits details when requested', async () => {
    mockESearch.mockResolvedValue({ idList: ['68009369'], count: 1 });
    mockESummary.mockResolvedValue({
      DocSum: {
        Id: '68009369',
        Item: [
          {
            '@_Name': 'DS_MeshTerms',
            Item: [{ '#text': 'Neoplasms' }, { '#text': 'Tumors' }],
          },
          { '@_Name': 'DS_ScopeNote', '#text': 'New abnormal growth of tissue.' },
        ],
      },
    });

    const ctx = createMockContext();
    const input = lookupMeshTool.input.parse({
      query: 'Neoplasms[MH]',
      includeDetails: false,
    });
    const result = await lookupMeshTool.handler(input, ctx);

    expect(mockESearch).toHaveBeenCalledTimes(1);
    expect(mockESearch).toHaveBeenCalledWith(
      { db: 'mesh', term: 'Neoplasms[MH]', retmax: 10, retstart: 0 },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(result.results).toEqual([
      { entrezUid: '68009369', meshId: 'D009369', name: 'Neoplasms' },
    ]);
  });

  it('falls back to requested IDs when ESummary returns no records', async () => {
    mockESearch.mockImplementation(async (params: { term: string }) =>
      params.term.endsWith('[MH]') ? { idList: [], count: 0 } : { idList: ['68000001'], count: 1 },
    );
    mockESummary.mockResolvedValue({});

    const ctx = createMockContext();
    const input = lookupMeshTool.input.parse({ query: 'rare descriptor' });
    const result = await lookupMeshTool.handler(input, ctx);

    expect(result.results).toEqual([
      { entrezUid: '68000001', meshId: 'D000001', name: '68000001' },
    ]);
  });

  it('decodes Entrez mesh UIDs to canonical DescriptorUIs and keeps the raw UID; non-decodable UIDs fall back', async () => {
    mockESearch.mockImplementation(async (params: { term: string }) =>
      params.term.endsWith('[MH]')
        ? { idList: [], count: 0 }
        : { idList: ['68003924', '67000123', '81000628', '2025952'], count: 4 },
    );
    mockESummary.mockResolvedValue({
      eSummaryResult: {
        DocSum: [
          {
            Id: '68003924',
            Item: [{ '@_Name': 'DS_MeshTerms', Item: [{ '#text': 'Diabetes Mellitus, Type 2' }] }],
          },
          {
            Id: '67000123',
            Item: [{ '@_Name': 'DS_MeshTerms', Item: [{ '#text': 'Some Supplementary Concept' }] }],
          },
          {
            Id: '81000628',
            Item: [{ '@_Name': 'DS_MeshTerms', Item: [{ '#text': 'Therapeutic Use' }] }],
          },
          {
            Id: '2025952',
            Item: [{ '@_Name': 'DS_MeshTerms', Item: [{ '#text': 'tisagenlecleucel' }] }],
          },
        ],
      },
    });

    const ctx = createMockContext();
    const input = lookupMeshTool.input.parse({ query: 'mixed batch', includeDetails: false });
    const result = await lookupMeshTool.handler(input, ctx);

    expect(result.results.map((r) => ({ meshId: r.meshId, entrezUid: r.entrezUid }))).toEqual([
      { meshId: 'D003924', entrezUid: '68003924' }, // descriptor (D = 68)
      { meshId: 'C000123', entrezUid: '67000123' }, // supplementary concept (C = 67)
      { meshId: 'Q000628', entrezUid: '81000628' }, // qualifier (Q = 81)
      { meshId: '2025952', entrezUid: '2025952' }, // non-decodable sequential UID → raw
    ]);
  });

  /* ────────────────────────────────────────────────────────────────────────── */
  /*  totalCount (#82) and offset pagination (#84)                              */
  /* ────────────────────────────────────────────────────────────────────────── */

  describe('totalCount reports the upstream match count, not the page size (#82)', () => {
    it.each([1, 5])('reports the same total for maxResults=%i', async (maxResults) => {
      mockESearch.mockImplementation(async (params: { term: string; retmax: number }) =>
        params.term.endsWith('[MH]')
          ? { idList: [], count: 0 }
          : {
              idList: Array.from({ length: params.retmax }, (_, i) => `6800000${i}`),
              count: 4213,
            },
      );
      mockESummary.mockImplementation(async (params: { id: string }) =>
        summaryFor(params.id.split(',')),
      );

      const ctx = createMockContext();
      const input = lookupMeshTool.input.parse({
        query: 'cancer',
        maxResults,
        includeDetails: false,
      });
      const result = await lookupMeshTool.handler(input, ctx);

      expect(result.results).toHaveLength(maxResults);
      expect(getEnrichment(ctx).totalCount).toBe(4213);
    });
  });

  describe('offset pagination (#84)', () => {
    /** 7 ranked descriptors; the [MH] pin resolves to the second of them. */
    const ranked = ['68000000', '68000001', '68000002', '68000003', '68000004', '68000005'];

    function mockRanked(pinned: string | undefined, total = ranked.length) {
      mockESearch.mockImplementation(
        async (params: { term: string; retmax: number; retstart?: number }) => {
          if (params.term.endsWith('[MH]')) {
            return { idList: pinned ? [pinned] : [], count: pinned ? 1 : 0 };
          }
          const start = params.retstart ?? 0;
          return { idList: ranked.slice(start, start + params.retmax), count: total };
        },
      );
      mockESummary.mockImplementation(async (params: { id: string }) =>
        summaryFor(params.id.split(',')),
      );
    }

    it('returns the first page and points at the next offset', async () => {
      mockRanked('68000001');

      const ctx = createMockContext();
      const input = lookupMeshTool.input.parse({
        query: 'cancer',
        maxResults: 2,
        includeDetails: false,
      });
      const result = await lookupMeshTool.handler(input, ctx);

      // The pinned exact match leads; it is deduped against the ranked window.
      expect(result.results.map((r) => r.entrezUid)).toEqual(['68000001', '68000000']);
      expect(result.offset).toBe(0);
      expect(result.nextOffset).toBe(2);
      expect(getEnrichment(ctx).totalCount).toBe(6);
    });

    it('returns the next distinct records on the second page and skips the [MH] pin', async () => {
      mockRanked('68000001');

      const ctx = createMockContext();
      const input = lookupMeshTool.input.parse({
        query: 'cancer',
        maxResults: 2,
        offset: 2,
        includeDetails: false,
      });
      const result = await lookupMeshTool.handler(input, ctx);

      expect(result.results.map((r) => r.entrezUid)).toEqual(['68000002', '68000003']);
      expect(result.offset).toBe(2);
      expect(result.nextOffset).toBe(4);
      // The exact-descriptor search runs on every page — the pinned UID is what
      // later pages need in order to hold it back at its ranked position (#91).
      expect(mockESearch).toHaveBeenCalledTimes(2);
      expect(mockESearch).toHaveBeenCalledWith(
        { db: 'mesh', term: 'cancer', retmax: 2, retstart: 2 },
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
      expect(mockESearch).toHaveBeenCalledWith(
        { db: 'mesh', term: 'cancer[MH]', retmax: 1 },
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
    });

    it('resumes where the page stopped when the pin displaced a ranked record', async () => {
      // The pin is outside the ranked list, so page 1 shows it plus one ranked
      // record — the next offset must be 1, not maxResults, or 68000001 is lost.
      mockRanked('68999999');

      const first = await lookupMeshTool.handler(
        lookupMeshTool.input.parse({ query: 'cancer', maxResults: 2, includeDetails: false }),
        createMockContext(),
      );
      expect(first.results.map((r) => r.entrezUid)).toEqual(['68999999', '68000000']);
      expect(first.nextOffset).toBe(1);

      const second = await lookupMeshTool.handler(
        lookupMeshTool.input.parse({
          query: 'cancer',
          maxResults: 2,
          offset: first.nextOffset,
          includeDetails: false,
        }),
        createMockContext(),
      );
      expect(second.results.map((r) => r.entrezUid)).toEqual(['68000001', '68000002']);
    });

    it('omits nextOffset on the final partial page', async () => {
      mockRanked(undefined);

      const ctx = createMockContext();
      const input = lookupMeshTool.input.parse({
        query: 'cancer',
        maxResults: 4,
        offset: 4,
        includeDetails: false,
      });
      const result = await lookupMeshTool.handler(input, ctx);

      expect(result.results.map((r) => r.entrezUid)).toEqual(['68000004', '68000005']);
      expect(result.offset).toBe(4);
      expect(result.nextOffset).toBeUndefined();
      expect(getEnrichment(ctx).totalCount).toBe(6);
    });

    it('reports an overshooting offset instead of claiming no matches', async () => {
      mockRanked(undefined);

      const ctx = createMockContext();
      const input = lookupMeshTool.input.parse({
        query: 'cancer',
        maxResults: 5,
        offset: 500,
        includeDetails: false,
      });
      const result = await lookupMeshTool.handler(input, ctx);
      const enrichment = getEnrichment(ctx);

      expect(result.results).toEqual([]);
      expect(result.offset).toBe(500);
      expect(result.nextOffset).toBeUndefined();
      expect(enrichment.totalCount).toBe(6);
      expect(enrichment.notice).toMatch(/Offset 500/);
      expect(enrichment.notice).toMatch(/Reset offset to 0/);
      // Not the empty-result guidance — the query did match.
      expect(enrichment.notice).not.toMatch(/spell_check/);
    });

    it('flags a page the pinned exact match filled on its own', async () => {
      mockRanked('68999999');

      const ctx = createMockContext();
      const input = lookupMeshTool.input.parse({
        query: 'cancer',
        maxResults: 1,
        includeDetails: false,
      });
      const result = await lookupMeshTool.handler(input, ctx);

      expect(result.results.map((r) => r.entrezUid)).toEqual(['68999999']);
      // No offset would advance past this page, so none is offered.
      expect(result.nextOffset).toBeUndefined();
      expect(getEnrichment(ctx).notice).toMatch(/Raise maxResults/);
    });
  });

  /* ────────────────────────────────────────────────────────────────────────── */
  /*  The pinned descriptor is served exactly once across a full walk (#91)     */
  /* ────────────────────────────────────────────────────────────────────────── */

  describe('a full offset → nextOffset walk serves every descriptor exactly once (#91)', () => {
    /** 13 ranked descriptors, mirroring a real MeSH result set. */
    const ranked = Array.from({ length: 13 }, (_, i) => `6800${String(100 + i)}`);

    function mockWalk(pinned: string | undefined) {
      mockESearch.mockImplementation(
        async (params: { term: string; retmax: number; retstart?: number }) => {
          if (params.term.endsWith('[MH]')) {
            return { idList: pinned ? [pinned] : [], count: pinned ? 1 : 0 };
          }
          const start = params.retstart ?? 0;
          return { idList: ranked.slice(start, start + params.retmax), count: ranked.length };
        },
      );
      mockESummary.mockImplementation(async (params: { id: string }) =>
        summaryFor(params.id.split(',')),
      );
    }

    /** Walks offset → nextOffset from 0 until the server stops offering one. */
    async function walkAllPages(maxResults: number) {
      const pages: string[][] = [];
      let offset: number | undefined = 0;
      while (offset !== undefined) {
        if (pages.length > ranked.length) throw new Error('pagination did not terminate');
        const result = await lookupMeshTool.handler(
          lookupMeshTool.input.parse({
            query: 'cancer',
            maxResults,
            offset,
            includeDetails: false,
          }),
          createMockContext(),
        );
        pages.push(result.results.map((r) => r.entrezUid));
        offset = result.nextOffset;
      }
      return { pages, collected: pages.flat() };
    }

    it('covers the set without duplicates when the pin ranks inside the first window', async () => {
      const pin = ranked[4];
      mockWalk(pin);

      const { pages, collected } = await walkAllPages(5);

      expect(pages).toEqual([
        [pin, ranked[0], ranked[1], ranked[2], ranked[3]],
        [ranked[5], ranked[6], ranked[7], ranked[8], ranked[9]],
        [ranked[10], ranked[11], ranked[12]],
      ]);
      expect(new Set(collected).size).toBe(collected.length);
      expect([...collected].sort()).toEqual([...ranked].sort());
    });

    it('covers the set without duplicates when the pin ranks beyond the first window', async () => {
      const pin = ranked[6];
      mockWalk(pin);

      const { pages, collected } = await walkAllPages(5);

      expect(pages).toEqual([
        // The pin displaces one ranked record, so the page stops at ranked index 3.
        [pin, ranked[0], ranked[1], ranked[2], ranked[3]],
        // The pin ranks inside this window and is held back, not served twice.
        [ranked[4], ranked[5], ranked[7], ranked[8]],
        [ranked[9], ranked[10], ranked[11], ranked[12]],
      ]);
      expect(new Set(collected).size).toBe(collected.length);
      expect([...collected].sort()).toEqual([...ranked].sort());
    });

    it('covers the set without duplicates when there is no exact-descriptor match', async () => {
      mockWalk(undefined);

      const { pages, collected } = await walkAllPages(5);

      expect(pages).toEqual([ranked.slice(0, 5), ranked.slice(5, 10), ranked.slice(10, 13)]);
      expect(new Set(collected).size).toBe(collected.length);
      expect([...collected].sort()).toEqual([...ranked].sort());
    });

    it('keeps paging when a window holds nothing but the already-served pin', async () => {
      const pin = ranked[6];
      mockWalk(pin);

      const ctx = createMockContext();
      const result = await lookupMeshTool.handler(
        lookupMeshTool.input.parse({
          query: 'cancer',
          maxResults: 1,
          offset: 6,
          includeDetails: false,
        }),
        ctx,
      );

      expect(result.results).toEqual([]);
      // The rank slot is consumed, so the walk advances past it rather than stalling.
      expect(result.nextOffset).toBe(7);
      expect(getEnrichment(ctx).notice).toMatch(/exact-descriptor match/);
      expect(getEnrichment(ctx).notice).toMatch(/Continue with offset 7/);
      // Not the overshoot guidance — there are more records to read.
      expect(getEnrichment(ctx).notice).not.toMatch(/Reset offset to 0/);
    });
  });

  it('formats output with the offset and next-page hint', () => {
    const blocks = lookupMeshTool.format!({
      query: 'Neoplasms',
      offset: 10,
      nextOffset: 20,
      results: [
        {
          entrezUid: '68009369',
          meshId: 'D009369',
          name: 'Neoplasms',
          scopeNote: 'New abnormal growth of tissue.',
          treeNumbers: ['C04'],
        },
      ],
    });
    expect(blocks[0]?.text).toContain('MeSH Lookup');
    expect(blocks[0]?.text).toContain('Neoplasms');
    expect(blocks[0]?.text).toContain('C04');
    expect(blocks[0]?.text).toContain('D009369');
    expect(blocks[0]?.text).toContain('Entrez UID');
    expect(blocks[0]?.text).toContain('68009369');
    expect(blocks[0]?.text).toContain('at offset **10**');
    expect(blocks[0]?.text).toContain('`offset: 20`');
  });

  it('renders empty results; the recovery notice is enrichment, not format output', () => {
    const blocks = lookupMeshTool.format!({
      query: 'xyznonexistent',
      offset: 0,
      results: [],
    });
    expect(blocks[0]?.text).toContain('Found **0** result(s) at offset **0**.');
    expect(blocks[0]?.text).not.toContain('offset:');
  });
});
