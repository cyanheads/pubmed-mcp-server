/**
 * @fileoverview Tests for the find-related tool.
 * @module tests/mcp-server/tools/definitions/find-related.tool.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockELink = vi.fn();
const mockESummary = vi.fn();
const mockExtractBriefSummaries = vi.fn(() => Promise.resolve([]));
vi.mock('@/services/ncbi/ncbi-service.js', () => ({
  getNcbiService: () => ({ eLink: mockELink, eSummary: mockESummary }),
}));
vi.mock('@/services/ncbi/parsing/esummary-parser.js', () => ({
  extractBriefSummaries: mockExtractBriefSummaries,
}));

const { findRelatedTool } = await import('@/mcp-server/tools/definitions/find-related.tool.js');

describe('findRelatedTool', () => {
  beforeEach(() => {
    mockELink.mockReset();
    mockESummary.mockReset();
    mockExtractBriefSummaries.mockReset();
    mockExtractBriefSummaries.mockResolvedValue([]);
  });

  it('validates input with defaults', () => {
    const input = findRelatedTool.input.parse({ pmid: '12345' });
    expect(input.pmid).toBe('12345');
    expect(input.relationship).toBe('similar');
    expect(input.maxResults).toBe(10);
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

  it('returns empty when no related articles found', async () => {
    mockELink.mockResolvedValue({
      eLinkResult: [{ LinkSet: {} }],
    });

    const ctx = createMockContext();
    const input = findRelatedTool.input.parse({ pmid: '12345' });
    const result = await findRelatedTool.handler(input, ctx);

    expect(result.articles).toEqual([]);
    expect(result.totalFound).toBe(0);
  });

  it('throws on ELink error', async () => {
    mockELink.mockResolvedValue({
      eLinkResult: [{ ERROR: 'Invalid PMID' }],
    });

    const ctx = createMockContext();
    const input = findRelatedTool.input.parse({ pmid: '12345' });
    await expect(findRelatedTool.handler(input, ctx)).rejects.toThrow(/ELink error/);
  });

  it('sorts similar articles by score and enriches them with summaries', async () => {
    mockELink.mockResolvedValue({
      eLinkResult: [
        {
          LinkSet: {
            LinkSetDb: {
              LinkName: 'pubmed_pubmed',
              Link: [
                { Id: '12345', Score: '100' },
                { Id: '0', Score: '90' },
                { Id: '222', Score: '50' },
                { Id: { '#text': '111' }, Score: { '#text': '75' } },
              ],
            },
          },
        },
      ],
    });
    mockESummary.mockResolvedValue({ eSummaryResult: {} });
    mockExtractBriefSummaries.mockResolvedValue([
      {
        pmid: '111',
        title: 'Higher Score Article',
        authors: 'Smith J',
        source: 'Nature',
        pubDate: '2024',
      },
      {
        pmid: '222',
        title: 'Lower Score Article',
        authors: 'Jones A',
        source: 'Science',
        pubDate: '2023',
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
        retmode: 'xml',
        cmd: 'neighbor_score',
      },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(mockESummary).toHaveBeenCalledWith(
      {
        db: 'pubmed',
        id: '111,222',
      },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(result.totalFound).toBe(2);
    expect(result.articles).toEqual([
      {
        pmid: '111',
        title: 'Higher Score Article',
        authors: 'Smith J',
        source: 'Nature',
        pubDate: '2024',
        score: 75,
      },
      {
        pmid: '222',
        title: 'Lower Score Article',
        authors: 'Jones A',
        source: 'Science',
        pubDate: '2023',
        score: 50,
      },
    ]);
  });

  it('uses cited_by linkname and keeps score undefined when ELink does not provide one', async () => {
    mockELink.mockResolvedValue({
      eLinkResult: [
        {
          LinkSet: {
            LinkSetDb: {
              LinkName: 'pubmed_pubmed_citedin',
              Link: { Id: '222' },
            },
          },
        },
      ],
    });
    mockESummary.mockResolvedValue({ eSummaryResult: {} });
    mockExtractBriefSummaries.mockResolvedValue([
      {
        pmid: '222',
        title: 'Citing Article',
        authors: 'Taylor R',
      },
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
      score: undefined,
    });
  });

  it('uses the references linkname for reference lookups', async () => {
    mockELink.mockResolvedValue({
      eLinkResult: [{ LinkSet: {} }],
    });

    const ctx = createMockContext();
    const input = findRelatedTool.input.parse({ pmid: '12345', relationship: 'references' });
    const result = await findRelatedTool.handler(input, ctx);

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
    expect(result.totalFound).toBe(0);
  });

  it('formats output with articles', () => {
    const blocks = findRelatedTool.format!({
      sourcePmid: '12345',
      relationship: 'similar',
      articles: [
        {
          pmid: '111',
          title: 'Related Article',
          authors: 'Smith J',
          source: 'Nature',
          pubDate: '2024',
          score: 95,
        },
      ],
      totalFound: 1,
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
      articles: [],
      totalFound: 0,
    });
    expect(blocks[0]?.text).toContain('No related articles');
  });
});
