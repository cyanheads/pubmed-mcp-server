/**
 * @fileoverview Tests for the lookup-mesh tool.
 * @module tests/mcp-server/tools/definitions/lookup-mesh.tool.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it, vi } from 'vitest';

const mockESearch = vi.fn();
const mockESummary = vi.fn();
vi.mock('@/services/ncbi/ncbi-service.js', () => ({
  getNcbiService: () => ({ eSearch: mockESearch, eSummary: mockESummary }),
}));

const { lookupMeshTool } = await import('@/mcp-server/tools/definitions/lookup-mesh.tool.js');

describe('lookupMeshTool', () => {
  it('validates input with defaults', () => {
    const input = lookupMeshTool.input.parse({ term: 'Neoplasms' });
    expect(input.term).toBe('Neoplasms');
    expect(input.maxResults).toBe(10);
    expect(input.includeDetails).toBe(true);
  });

  it('returns empty results when no MeSH IDs found', async () => {
    mockESearch.mockResolvedValue({ idList: [] });

    const ctx = createMockContext();
    const input = lookupMeshTool.input.parse({ term: 'xyznonexistent' });
    const result = await lookupMeshTool.handler(input, ctx);

    expect(result.results).toEqual([]);
    expect(result.term).toBe('xyznonexistent');
  });

  it('returns parsed MeSH records', async () => {
    mockESearch.mockResolvedValue({ idList: ['68009369'] });
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
    const input = lookupMeshTool.input.parse({ term: 'Neoplasms' });
    const result = await lookupMeshTool.handler(input, ctx);

    expect(result.results).toHaveLength(1);
    expect(result.results[0]?.meshId).toBe('68009369');
    expect(result.results[0]?.name).toBe('Neoplasms');
    expect(result.results[0]?.scopeNote).toContain('abnormal growth');
  });

  it('formats output', () => {
    const blocks = lookupMeshTool.format!({
      term: 'Neoplasms',
      results: [
        {
          meshId: '68009369',
          name: 'Neoplasms',
          scopeNote: 'New abnormal growth of tissue.',
          treeNumbers: ['C04'],
        },
      ],
    });
    expect(blocks[0]?.text).toContain('MeSH Lookup');
    expect(blocks[0]?.text).toContain('Neoplasms');
    expect(blocks[0]?.text).toContain('C04');
  });
});
