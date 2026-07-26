/**
 * @fileoverview Tests for the find-related tool — offset pagination (#36) and
 * multi-source provider fallback (#63).
 * @module tests/mcp-server/tools/definitions/find-related.tool.test
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockELink = vi.fn();
const mockESummary = vi.fn();
const mockExtractBriefSummaries = vi.fn(() => Promise.resolve([]));
const mockEpmcCitations = vi.fn();
const mockEpmcReferences = vi.fn();
const mockOaSimilar = vi.fn();
const mockOaCitedBy = vi.fn();
const mockOaReferences = vi.fn();

vi.mock('@/services/ncbi/ncbi-service.js', () => ({
  getNcbiService: () => ({ eLink: mockELink, eSummary: mockESummary }),
}));
vi.mock('@/services/ncbi/parsing/esummary-parser.js', () => ({
  extractBriefSummaries: mockExtractBriefSummaries,
}));
vi.mock('@/services/europe-pmc/europe-pmc-service.js', () => ({
  getEuropePmcService: () => ({
    citations: mockEpmcCitations,
    references: mockEpmcReferences,
  }),
}));
vi.mock('@/services/openalex/openalex-service.js', () => ({
  getOpenAlexServiceOptional: () => ({
    similar: mockOaSimilar,
    citedBy: mockOaCitedBy,
    references: mockOaReferences,
  }),
}));

const { findRelatedTool } = await import('@/mcp-server/tools/definitions/find-related.tool.js');

/** Build a minimal NCBI eLink response with the given PMIDs. */
function eLinkResponse(pmids: string[], linkName = 'pubmed_pubmed') {
  return {
    eLinkResult: [
      {
        LinkSet: {
          LinkSetDb: {
            LinkName: linkName,
            Link: pmids.map((id) => ({ Id: id })),
          },
        },
      },
    ],
  };
}

describe('findRelatedTool', () => {
  beforeEach(() => {
    mockELink.mockReset();
    mockESummary.mockReset();
    mockExtractBriefSummaries.mockReset();
    mockExtractBriefSummaries.mockResolvedValue([]);
    mockEpmcCitations.mockReset();
    mockEpmcReferences.mockReset();
    mockOaSimilar.mockReset();
    mockOaCitedBy.mockReset();
    mockOaReferences.mockReset();
  });

  // ── Input schema ─────────────────────────────────────────────────────────

  it('validates input with defaults', () => {
    const input = findRelatedTool.input.parse({ pmid: '12345' });
    expect(input.pmid).toBe('12345');
    expect(input.relationship).toBe('similar');
    expect(input.maxResults).toBe(10);
    expect(input.offset).toBe(0);
  });

  it('rejects non-numeric PMIDs', () => {
    expect(() => findRelatedTool.input.parse({ pmid: 'abc' })).toThrow();
  });

  it('rejects non-numeric PMIDs with an actionable error message (issue #27)', () => {
    const parsed = findRelatedTool.input.safeParse({ pmid: 'abc' });
    expect(parsed.success).toBe(false);
    const message = parsed.error?.issues[0]?.message ?? '';
    expect(message).toMatch(/PMID/);
    expect(message).toMatch(/numeric/);
    expect(message).toContain('13054692');
  });

  // ── Offset pagination (#36) ────────────────────────────────────────────────

  it('offset=0 returns first window of PMIDs', async () => {
    const pmids = ['101', '102', '103', '104', '105'];
    mockELink.mockResolvedValue(eLinkResponse(pmids));
    mockESummary.mockResolvedValue({ eSummaryResult: {} });
    mockExtractBriefSummaries.mockResolvedValue([]);

    const ctx = createMockContext();
    const input = findRelatedTool.input.parse({ pmid: '12345', maxResults: 2, offset: 0 });
    const result = await findRelatedTool.handler(input, ctx);

    expect(result.offset).toBe(0);
    expect(result.articles.map((a) => a.pmid)).toEqual(['101', '102']);
  });

  it('offset=2 returns different, non-overlapping window from offset=0', async () => {
    const pmids = ['101', '102', '103', '104', '105'];
    mockELink.mockResolvedValue(eLinkResponse(pmids));
    mockESummary.mockResolvedValue({ eSummaryResult: {} });
    mockExtractBriefSummaries.mockResolvedValue([]);

    // offset=0 run
    const ctx0 = createMockContext();
    const input0 = findRelatedTool.input.parse({ pmid: '12345', maxResults: 2, offset: 0 });
    const result0 = await findRelatedTool.handler(input0, ctx0);

    // offset=2 run
    mockELink.mockResolvedValue(eLinkResponse(pmids));
    const ctx2 = createMockContext();
    const input2 = findRelatedTool.input.parse({ pmid: '12345', maxResults: 2, offset: 2 });
    const result2 = await findRelatedTool.handler(input2, ctx2);

    expect(result0.articles.map((a) => a.pmid)).toEqual(['101', '102']);
    expect(result2.articles.map((a) => a.pmid)).toEqual(['103', '104']);
    // No overlap between the two windows
    const set0 = new Set(result0.articles.map((a) => a.pmid));
    for (const a of result2.articles) expect(set0.has(a.pmid)).toBe(false);
  });

  it('emits overshoot notice when offset >= totalCount on non-empty set', async () => {
    const pmids = ['101', '102', '103'];
    mockELink.mockResolvedValue(eLinkResponse(pmids));
    mockESummary.mockResolvedValue({ eSummaryResult: {} });
    mockExtractBriefSummaries.mockResolvedValue([]);

    const ctx = createMockContext();
    // offset=10, totalCount=3 → overshoot
    const input = findRelatedTool.input.parse({ pmid: '12345', maxResults: 10, offset: 10 });
    await findRelatedTool.handler(input, ctx);

    expect(getEnrichment(ctx).notice).toContain('Offset 10 exceeds totalCount');
    expect(getEnrichment(ctx).notice).toContain('3');
  });

  it('echoes offset in the output schema', async () => {
    mockELink.mockResolvedValue(eLinkResponse(['101', '102']));
    mockESummary.mockResolvedValue({ eSummaryResult: {} });
    mockExtractBriefSummaries.mockResolvedValue([]);

    const ctx = createMockContext();
    const input = findRelatedTool.input.parse({ pmid: '12345', maxResults: 5, offset: 3 });
    const result = await findRelatedTool.handler(input, ctx);
    expect(result.offset).toBe(3);
  });

  it('format() header includes "Returned: N | Offset: Z"', () => {
    const blocks = findRelatedTool.format!({
      sourcePmid: '12345',
      relationship: 'similar',
      offset: 5,
      articles: [{ pmid: '111', title: 'A', authors: 'B', source: 'C', pubDate: '2024' }],
    });
    const text = blocks[0]?.text ?? '';
    expect(text).toContain('**Returned:** 1');
    expect(text).toContain('**Offset:** 5');
    expect(text).toContain('**Relationship:** similar');
  });

  // ── Provider fallback (#63) ────────────────────────────────────────────────

  it('NCBI success: enrichment.source is "ncbi", no fallback notice', async () => {
    mockELink.mockResolvedValue(eLinkResponse(['111', '222']));
    mockESummary.mockResolvedValue({ eSummaryResult: {} });
    mockExtractBriefSummaries.mockResolvedValue([
      { pmid: '111', title: 'Art 1' },
      { pmid: '222', title: 'Art 2' },
    ]);

    const ctx = createMockContext();
    const input = findRelatedTool.input.parse({ pmid: '12345', relationship: 'cited_by' });
    const result = await findRelatedTool.handler(input, ctx);

    expect(getEnrichment(ctx).source).toBe('ncbi');
    // No fallback notice (notice may still be set for other reasons, but not fallback)
    expect(getEnrichment(ctx).notice).toBeUndefined();
    expect(result.articles.length).toBe(2);
  });

  it('NCBI throws → EPMC serves cited_by: source is "europepmc", notice present', async () => {
    mockELink.mockRejectedValue(new McpError(JsonRpcErrorCode.ServiceUnavailable, 'NCBI down'));
    mockEpmcCitations.mockResolvedValue({ pmids: ['333', '444'], totalCount: 50 });
    mockESummary.mockResolvedValue({ eSummaryResult: {} });
    mockExtractBriefSummaries.mockResolvedValue([
      { pmid: '333', title: 'EPMC Art 1' },
      { pmid: '444', title: 'EPMC Art 2' },
    ]);

    const ctx = createMockContext();
    const input = findRelatedTool.input.parse({ pmid: '12345', relationship: 'cited_by' });
    const result = await findRelatedTool.handler(input, ctx);

    expect(getEnrichment(ctx).source).toBe('europepmc');
    expect(getEnrichment(ctx).notice).toBeDefined();
    expect(getEnrichment(ctx).notice).toContain('Europe PMC');
    expect(getEnrichment(ctx).totalCount).toBe(50);
    expect(result.articles[0]?.pmid).toBe('333');
  });

  it('NCBI throws for similar → EPMC skipped → OpenAlex serves: source is "openalex", notice present', async () => {
    mockELink.mockRejectedValue(new McpError(JsonRpcErrorCode.ServiceUnavailable, 'NCBI down'));
    // EPMC is not called for similar (epmcSupports returns false)
    mockOaSimilar.mockResolvedValue({ pmids: ['555', '666'], totalCount: 10 });
    mockESummary.mockResolvedValue({ eSummaryResult: {} });
    mockExtractBriefSummaries.mockResolvedValue([
      { pmid: '555', title: 'OA Art 1' },
      { pmid: '666', title: 'OA Art 2' },
    ]);

    const ctx = createMockContext();
    const input = findRelatedTool.input.parse({ pmid: '12345', relationship: 'similar' });
    const result = await findRelatedTool.handler(input, ctx);

    expect(getEnrichment(ctx).source).toBe('openalex');
    expect(getEnrichment(ctx).notice).toBeDefined();
    expect(getEnrichment(ctx).notice).toContain('OpenAlex');
    expect(result.articles[0]?.pmid).toBe('555');
    // EPMC should NOT have been called for similar
    expect(mockEpmcCitations).not.toHaveBeenCalled();
    expect(mockEpmcReferences).not.toHaveBeenCalled();
  });

  it('NCBI throws, EPMC throws → OpenAlex serves: source is "openalex"', async () => {
    mockELink.mockRejectedValue(new McpError(JsonRpcErrorCode.ServiceUnavailable, 'NCBI down'));
    mockEpmcCitations.mockRejectedValue(
      new McpError(JsonRpcErrorCode.ServiceUnavailable, 'EPMC down'),
    );
    mockOaCitedBy.mockResolvedValue({ pmids: ['777'], totalCount: 5 });
    mockESummary.mockResolvedValue({ eSummaryResult: {} });
    mockExtractBriefSummaries.mockResolvedValue([{ pmid: '777', title: 'OA Art' }]);

    const ctx = createMockContext();
    const input = findRelatedTool.input.parse({ pmid: '12345', relationship: 'cited_by' });
    const result = await findRelatedTool.handler(input, ctx);

    expect(getEnrichment(ctx).source).toBe('openalex');
    expect(result.articles[0]?.pmid).toBe('777');
  });

  it('NCBI throws, EPMC returns empty → OpenAlex serves (an empty fallback is not "served")', async () => {
    mockELink.mockRejectedValue(new McpError(JsonRpcErrorCode.ServiceUnavailable, 'NCBI down'));
    mockEpmcCitations.mockResolvedValue({ pmids: [], totalCount: 0 });
    mockOaCitedBy.mockResolvedValue({ pmids: ['777'], totalCount: 9 });
    mockESummary.mockResolvedValue({ eSummaryResult: {} });
    mockExtractBriefSummaries.mockResolvedValue([{ pmid: '777', title: 'OA Art' }]);

    const ctx = createMockContext();
    const input = findRelatedTool.input.parse({ pmid: '12345', relationship: 'cited_by' });
    const result = await findRelatedTool.handler(input, ctx);

    expect(getEnrichment(ctx).source).toBe('openalex');
    expect(result.articles[0]?.pmid).toBe('777');
  });

  it('OpenAlex serves an empty set for a PMID it does not index (issue #90)', async () => {
    // `OpenAlexApiClient.getWorkByPmid` converts an upstream 404 to `null`, so
    // `OpenAlexService.similar`'s `if (!work)` guard runs for the first time.
    // The tool degrades to an empty result set instead of reporting every
    // provider as failed.
    mockELink.mockRejectedValue(new McpError(JsonRpcErrorCode.ServiceUnavailable, 'NCBI down'));
    mockOaSimilar.mockResolvedValue({ pmids: [], totalCount: 0 });

    const ctx = createMockContext();
    const input = findRelatedTool.input.parse({ pmid: '99999999', relationship: 'similar' });
    const result = await findRelatedTool.handler(input, ctx);

    expect(result.articles).toEqual([]);
    expect(getEnrichment(ctx).source).toBe('openalex');
    expect(getEnrichment(ctx).totalCount).toBe(0);
    expect(getEnrichment(ctx).notice).not.toContain('All providers failed');
    // No PMIDs to enrich — the eSummary round-trip is skipped entirely.
    expect(mockESummary).not.toHaveBeenCalled();
  });

  it('OpenAlex serves an empty cited_by set for a PMID it does not index (issue #90)', async () => {
    mockELink.mockRejectedValue(new McpError(JsonRpcErrorCode.ServiceUnavailable, 'NCBI down'));
    mockEpmcCitations.mockResolvedValue({ pmids: [], totalCount: 0 });
    mockOaCitedBy.mockResolvedValue({ pmids: [], totalCount: 0 });

    const ctx = createMockContext();
    const input = findRelatedTool.input.parse({ pmid: '99999999', relationship: 'cited_by' });
    const result = await findRelatedTool.handler(input, ctx);

    expect(result.articles).toEqual([]);
    expect(getEnrichment(ctx).source).toBe('openalex');
    expect(getEnrichment(ctx).notice).not.toContain('All providers failed');
  });

  it('all providers fail: returns empty + all-fail notice', async () => {
    mockELink.mockRejectedValue(new McpError(JsonRpcErrorCode.ServiceUnavailable, 'NCBI down'));
    mockEpmcCitations.mockRejectedValue(
      new McpError(JsonRpcErrorCode.ServiceUnavailable, 'EPMC down'),
    );
    mockOaCitedBy.mockRejectedValue(new McpError(JsonRpcErrorCode.ServiceUnavailable, 'OA down'));

    const ctx = createMockContext();
    const input = findRelatedTool.input.parse({ pmid: '12345', relationship: 'cited_by' });
    const result = await findRelatedTool.handler(input, ctx);

    expect(result.articles).toEqual([]);
    expect(getEnrichment(ctx).notice).toBeDefined();
    expect(getEnrichment(ctx).notice).toContain('All providers failed');
  });

  it('returns bare PMIDs + a notice when a fallback serves but eSummary enrichment fails', async () => {
    // NCBI eLink is down → EPMC serves the PMIDs, but the window-enrichment
    // eSummary (same NCBI host) also fails → degrade to bare PMIDs rather than
    // throwing, so the chain's resilience survives the enrichment step.
    mockELink.mockRejectedValue(new McpError(JsonRpcErrorCode.ServiceUnavailable, 'NCBI down'));
    mockEpmcCitations.mockResolvedValue({ pmids: ['333', '444'], totalCount: 50 });
    mockESummary.mockRejectedValue(new McpError(JsonRpcErrorCode.ServiceUnavailable, 'NCBI down'));

    const ctx = createMockContext();
    const input = findRelatedTool.input.parse({ pmid: '12345', relationship: 'cited_by' });
    const result = await findRelatedTool.handler(input, ctx);

    expect(getEnrichment(ctx).source).toBe('europepmc');
    expect(result.articles).toEqual([{ pmid: '333' }, { pmid: '444' }]);
    // Both the provenance notice and the degradation notice survive (consolidated).
    expect(getEnrichment(ctx).notice).toContain('Europe PMC');
    expect(getEnrichment(ctx).notice).toContain('PMIDs only');
  });

  // ── Existing behavior preserved ───────────────────────────────────────────

  it('returns empty without notice for valid source with no related articles', async () => {
    mockELink.mockResolvedValue({ eLinkResult: [{ LinkSet: {} }] });
    mockESummary.mockResolvedValue({ eSummaryResult: {} });
    mockExtractBriefSummaries.mockResolvedValue([
      { pmid: '12345', title: 'Existing article with no related items' },
    ]);

    const ctx = createMockContext();
    const input = findRelatedTool.input.parse({ pmid: '12345' });
    const result = await findRelatedTool.handler(input, ctx);

    expect(result.articles).toEqual([]);
    expect(getEnrichment(ctx).totalCount).toBe(0);
    expect(getEnrichment(ctx).notice).toBeUndefined();
  });

  describe('ELink <ERROR> payload', () => {
    it('disambiguates an invalid source PMID via ESummary and emits a not-found notice', async () => {
      mockELink.mockResolvedValue({ eLinkResult: [{ ERROR: 'Invalid PMID' }] });
      mockESummary.mockResolvedValue({ eSummaryResult: {} });
      mockExtractBriefSummaries.mockResolvedValue([]);

      const ctx = createMockContext();
      const input = findRelatedTool.input.parse({ pmid: '99999999999' });
      const result = await findRelatedTool.handler(input, ctx);

      expect(getEnrichment(ctx).totalCount).toBe(0);
      expect(result.articles).toEqual([]);
      expect(getEnrichment(ctx).notice).toContain('99999999999');
      expect(getEnrichment(ctx).notice).toContain('not found in PubMed');
    });

    it('returns empty without notice when ELink ERROR fires for a valid PMID with no related items', async () => {
      mockELink.mockResolvedValue({ eLinkResult: [{ ERROR: 'Empty result - nothing to do' }] });
      mockESummary.mockResolvedValue({ eSummaryResult: {} });
      mockExtractBriefSummaries.mockResolvedValue([
        { pmid: '12345', title: 'Valid source with no related items' },
      ]);

      const ctx = createMockContext();
      const input = findRelatedTool.input.parse({ pmid: '12345' });
      await findRelatedTool.handler(input, ctx);

      expect(getEnrichment(ctx).totalCount).toBe(0);
      expect(getEnrichment(ctx).notice).toBeUndefined();
    });
  });

  it('uses neighbor + pubmed_pubmed linkname for similar and enriches results', async () => {
    mockELink.mockResolvedValue({
      eLinkResult: [
        {
          LinkSet: {
            LinkSetDb: {
              LinkName: 'pubmed_pubmed',
              Link: [
                { Id: '12345' }, // source PMID — filtered out
                { Id: '0' }, // sentinel — filtered out
                { Id: '222' },
                { Id: { '#text': '111' } }, // exercise the {'#text': ...} Id shape
              ],
            },
          },
        },
      ],
    });
    mockESummary.mockResolvedValue({ eSummaryResult: {} });
    mockExtractBriefSummaries.mockResolvedValue([
      {
        pmid: '222',
        title: 'First Related Article',
        authors: 'Jones A',
        source: 'Science',
        pubDate: '2023',
      },
      {
        pmid: '111',
        title: 'Second Related Article',
        authors: 'Smith J',
        source: 'Nature',
        pubDate: '2024',
      },
    ]);

    const ctx = createMockContext();
    const input = findRelatedTool.input.parse({ pmid: '12345', maxResults: 2 });
    const result = await findRelatedTool.handler(input, ctx);

    expect(mockELink).toHaveBeenCalledWith(
      {
        dbfrom: 'pubmed',
        db: 'pubmed',
        id: '12345',
        cmd: 'neighbor',
        linkname: 'pubmed_pubmed',
        retmode: 'xml',
      },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(mockESummary).toHaveBeenCalledWith(
      { db: 'pubmed', id: '222,111' },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(getEnrichment(ctx).totalCount).toBe(2);
    expect(result.articles).toEqual([
      {
        pmid: '222',
        title: 'First Related Article',
        authors: 'Jones A',
        source: 'Science',
        pubDate: '2023',
      },
      {
        pmid: '111',
        title: 'Second Related Article',
        authors: 'Smith J',
        source: 'Nature',
        pubDate: '2024',
      },
    ]);
  });

  it('uses cited_by linkname', async () => {
    mockELink.mockResolvedValue({
      eLinkResult: [
        {
          LinkSet: {
            LinkSetDb: { LinkName: 'pubmed_pubmed_citedin', Link: { Id: '222' } },
          },
        },
      ],
    });
    mockESummary.mockResolvedValue({ eSummaryResult: {} });
    mockExtractBriefSummaries.mockResolvedValue([
      { pmid: '222', title: 'Citing Article', authors: 'Taylor R' },
    ]);

    const ctx = createMockContext();
    const input = findRelatedTool.input.parse({ pmid: '12345', relationship: 'cited_by' });
    const result = await findRelatedTool.handler(input, ctx);

    expect(mockELink).toHaveBeenCalledWith(
      {
        dbfrom: 'pubmed',
        db: 'pubmed',
        id: '12345',
        retmode: 'xml',
        cmd: 'neighbor',
        linkname: 'pubmed_pubmed_citedin',
      },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(result.articles[0]).toEqual({
      pmid: '222',
      title: 'Citing Article',
      authors: 'Taylor R',
      source: undefined,
      pubDate: undefined,
    });
  });

  it('uses the references linkname for reference lookups', async () => {
    mockELink.mockResolvedValue({ eLinkResult: [{ LinkSet: {} }] });
    mockESummary.mockResolvedValue({ eSummaryResult: {} });
    mockExtractBriefSummaries.mockResolvedValue([
      { pmid: '12345', title: 'Source', pmcId: 'PMC9999' },
    ]);
    // Valid source, empty NCBI refs → the references fallback runs; keep both empty.
    mockEpmcReferences.mockResolvedValue({ pmids: [], totalCount: 0 });
    mockOaReferences.mockResolvedValue({ pmids: [], totalCount: 0 });

    const ctx = createMockContext();
    const input = findRelatedTool.input.parse({ pmid: '12345', relationship: 'references' });
    await findRelatedTool.handler(input, ctx);

    expect(mockELink).toHaveBeenCalledWith(
      {
        dbfrom: 'pubmed',
        db: 'pubmed',
        id: '12345',
        retmode: 'xml',
        cmd: 'neighbor',
        linkname: 'pubmed_pubmed_refs',
      },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(getEnrichment(ctx).totalCount).toBe(0);
  });

  describe('references coverage for non-PMC sources (issues #42, #63)', () => {
    it('serves references from EPMC when NCBI has none (non-PMC source, #63 coverage)', async () => {
      mockELink.mockResolvedValue({ eLinkResult: [{ LinkSet: {} }] });
      mockESummary.mockResolvedValue({ eSummaryResult: {} });
      // 1st extract = source disambiguation; 2nd = window enrichment.
      mockExtractBriefSummaries
        .mockResolvedValueOnce([{ pmid: '37952131', title: 'Non-PMC source' }])
        .mockResolvedValueOnce([
          { pmid: '888', title: 'Ref A' },
          { pmid: '999', title: 'Ref B' },
        ]);
      mockEpmcReferences.mockResolvedValue({ pmids: ['888', '999'], totalCount: 149 });

      const ctx = createMockContext();
      const input = findRelatedTool.input.parse({ pmid: '37952131', relationship: 'references' });
      const result = await findRelatedTool.handler(input, ctx);

      expect(getEnrichment(ctx).source).toBe('europepmc');
      expect(getEnrichment(ctx).totalCount).toBe(149);
      expect(getEnrichment(ctx).notice).toContain('Europe PMC');
      expect(result.articles.map((a) => a.pmid)).toEqual(['888', '999']);
      // EPMC served first — OpenAlex is not consulted.
      expect(mockOaReferences).not.toHaveBeenCalled();
    });

    it('serves references from OpenAlex when NCBI and EPMC both have none', async () => {
      mockELink.mockResolvedValue({ eLinkResult: [{ LinkSet: {} }] });
      mockESummary.mockResolvedValue({ eSummaryResult: {} });
      mockExtractBriefSummaries
        .mockResolvedValueOnce([{ pmid: '37952131', title: 'Non-PMC source' }])
        .mockResolvedValueOnce([{ pmid: '890', title: 'Ref X' }]);
      mockEpmcReferences.mockResolvedValue({ pmids: [], totalCount: 0 });
      mockOaReferences.mockResolvedValue({ pmids: ['890'], totalCount: 150 });

      const ctx = createMockContext();
      const input = findRelatedTool.input.parse({ pmid: '37952131', relationship: 'references' });
      const result = await findRelatedTool.handler(input, ctx);

      expect(getEnrichment(ctx).source).toBe('openalex');
      expect(getEnrichment(ctx).notice).toContain('OpenAlex');
      expect(result.articles[0]?.pmid).toBe('890');
    });

    it('notices when references are unavailable everywhere (non-PMC source)', async () => {
      mockELink.mockResolvedValue({ eLinkResult: [{ LinkSet: {} }] });
      mockESummary.mockResolvedValue({ eSummaryResult: {} });
      mockExtractBriefSummaries.mockResolvedValue([
        { pmid: '37952131', title: 'Non-PMC source' /* no pmcId */ },
      ]);
      mockEpmcReferences.mockResolvedValue({ pmids: [], totalCount: 0 });
      mockOaReferences.mockResolvedValue({ pmids: [], totalCount: 0 });

      const ctx = createMockContext();
      const input = findRelatedTool.input.parse({ pmid: '37952131', relationship: 'references' });
      await findRelatedTool.handler(input, ctx);

      // EPMC + OpenAlex were both consulted before giving up.
      expect(mockEpmcReferences).toHaveBeenCalled();
      expect(mockOaReferences).toHaveBeenCalled();
      expect(getEnrichment(ctx).totalCount).toBe(0);
      expect(getEnrichment(ctx).notice).toContain('37952131');
      expect(getEnrichment(ctx).notice).toContain('OpenAlex');
      expect(getEnrichment(ctx).notice).toContain('pubmed_fetch_articles');
    });

    it('notices with the PMCID when a PMC source has no references anywhere', async () => {
      mockELink.mockResolvedValue({ eLinkResult: [{ LinkSet: {} }] });
      mockESummary.mockResolvedValue({ eSummaryResult: {} });
      mockExtractBriefSummaries.mockResolvedValue([
        { pmid: '12345', title: 'PMC source', pmcId: 'PMC12345' },
      ]);
      mockEpmcReferences.mockResolvedValue({ pmids: [], totalCount: 0 });
      mockOaReferences.mockResolvedValue({ pmids: [], totalCount: 0 });

      const ctx = createMockContext();
      const input = findRelatedTool.input.parse({ pmid: '12345', relationship: 'references' });
      await findRelatedTool.handler(input, ctx);

      expect(getEnrichment(ctx).notice).toBeDefined();
      expect(getEnrichment(ctx).notice).toContain('PMCID PMC12345');
    });

    it('omits notice for similar / cited_by empty results when source PMID is valid', async () => {
      mockELink.mockResolvedValue({ eLinkResult: [{ LinkSet: {} }] });
      mockESummary.mockResolvedValue({ eSummaryResult: {} });
      mockExtractBriefSummaries.mockResolvedValue([{ pmid: '12345', title: 'Valid source' }]);

      const ctx = createMockContext();
      const input = findRelatedTool.input.parse({ pmid: '12345', relationship: 'similar' });
      await findRelatedTool.handler(input, ctx);

      expect(getEnrichment(ctx).notice).toBeUndefined();
      expect(mockESummary).toHaveBeenCalledTimes(1);
    });

    it('falls back gracefully when the ESummary lookup fails (transport error)', async () => {
      mockELink.mockResolvedValue({ eLinkResult: [{ LinkSet: {} }] });
      mockESummary.mockRejectedValue(new Error('NCBI down'));

      const ctx = createMockContext();
      const input = findRelatedTool.input.parse({ pmid: '12345', relationship: 'references' });
      await findRelatedTool.handler(input, ctx);

      expect(getEnrichment(ctx).totalCount).toBe(0);
      expect(getEnrichment(ctx).notice).toBeUndefined();
    });

    it('emits invalid-PMID notice when source ESummary returns nothing', async () => {
      mockELink.mockResolvedValue({ eLinkResult: [{ LinkSet: {} }] });
      mockESummary.mockResolvedValue({ eSummaryResult: {} });
      mockExtractBriefSummaries.mockResolvedValue([]);

      const ctx = createMockContext();
      const input = findRelatedTool.input.parse({
        pmid: '99999999999',
        relationship: 'references',
      });
      await findRelatedTool.handler(input, ctx);

      expect(getEnrichment(ctx).notice).toContain('99999999999');
      expect(getEnrichment(ctx).notice).toContain('not found in PubMed');
      // Invalid-source notice supersedes the references-specific hint.
      expect(getEnrichment(ctx).notice).not.toContain('PMC');
    });

    it('renders the empty state; the recovery notice is enrichment, not format output', () => {
      const blocks = findRelatedTool.format!({
        sourcePmid: '37952131',
        relationship: 'references',
        offset: 0,
        articles: [],
      });
      const text = blocks[0]?.text ?? '';
      expect(text).toContain('No related articles found.');
      expect(text).not.toContain('Reference lists require');
    });
  });

  it('formats output with articles', () => {
    const blocks = findRelatedTool.format!({
      sourcePmid: '12345',
      relationship: 'similar',
      offset: 0,
      articles: [
        {
          pmid: '111',
          title: 'Related Article',
          authors: 'Smith J',
          source: 'Nature',
          pubDate: '2024',
        },
      ],
    });
    expect(blocks[0]?.text).toContain('Related Articles');
    expect(blocks[0]?.text).toContain('12345');
    expect(blocks[0]?.text).toContain('Related Article');
    expect(blocks[0]?.text).toContain('*Smith J*');
    expect(blocks[0]?.text).toContain('Nature, 2024');
  });

  it('formats output with no articles', () => {
    const blocks = findRelatedTool.format!({
      sourcePmid: '12345',
      relationship: 'cited_by',
      offset: 0,
      articles: [],
    });
    expect(blocks[0]?.text).toContain('No related articles');
  });

  describe('invalid source PMID detection (issue #22)', () => {
    const invalidPmidNotice = (relationship: 'similar' | 'cited_by' | 'references') => async () => {
      mockELink.mockResolvedValue({ eLinkResult: [{ LinkSet: {} }] });
      mockESummary.mockResolvedValue({ eSummaryResult: {} });
      mockExtractBriefSummaries.mockResolvedValue([]);

      const ctx = createMockContext();
      const input = findRelatedTool.input.parse({ pmid: '99999999999', relationship });
      const result = await findRelatedTool.handler(input, ctx);

      expect(getEnrichment(ctx).totalCount).toBe(0);
      expect(result.articles).toEqual([]);
      expect(getEnrichment(ctx).notice).toContain('99999999999');
      expect(getEnrichment(ctx).notice).toContain('not found in PubMed');
      expect(getEnrichment(ctx).notice).toContain('pubmed_fetch_articles');
    };

    it(
      'emits notice for similar relationship when source PMID is unknown',
      invalidPmidNotice('similar'),
    );
    it(
      'emits notice for cited_by relationship when source PMID is unknown',
      invalidPmidNotice('cited_by'),
    );
    it(
      'emits notice for references relationship when source PMID is unknown',
      invalidPmidNotice('references'),
    );

    it('treats NCBI NotFound throw as confirmed missing PMID (via error code)', async () => {
      mockELink.mockResolvedValue({ eLinkResult: [{ LinkSet: {} }] });
      mockESummary.mockRejectedValue(
        new McpError(JsonRpcErrorCode.NotFound, 'NCBI API Error: cannot get summary', {
          reason: 'ncbi_resource_not_found',
          ncbiErrors: ['UID=99999999999: cannot get document summary'],
        }),
      );

      const ctx = createMockContext();
      const input = findRelatedTool.input.parse({ pmid: '99999999999', relationship: 'similar' });
      await findRelatedTool.handler(input, ctx);

      expect(getEnrichment(ctx).notice).toContain('99999999999');
      expect(getEnrichment(ctx).notice).toContain('not found in PubMed');
    });

    it('does NOT emit invalid notice on transient transport failure', async () => {
      mockELink.mockResolvedValue({ eLinkResult: [{ LinkSet: {} }] });
      mockESummary.mockRejectedValue(new Error('connect ETIMEDOUT'));

      const ctx = createMockContext();
      const input = findRelatedTool.input.parse({ pmid: '12345', relationship: 'similar' });
      await findRelatedTool.handler(input, ctx);

      expect(getEnrichment(ctx).totalCount).toBe(0);
      expect(getEnrichment(ctx).notice).toBeUndefined();
    });
  });
});
