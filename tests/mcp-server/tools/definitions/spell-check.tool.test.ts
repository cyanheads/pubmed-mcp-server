/**
 * @fileoverview Tests for the spell-check tool.
 * @module tests/mcp-server/tools/definitions/spell-check.tool.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it, vi } from 'vitest';

const mockESpell = vi.fn();
vi.mock('@/services/ncbi/ncbi-service.js', () => ({
  getNcbiService: () => ({ eSpell: mockESpell }),
}));

const { spellCheckTool } = await import('@/mcp-server/tools/definitions/spell-check.tool.js');

describe('spellCheckTool', () => {
  it('validates input schema', () => {
    const input = spellCheckTool.input.parse({ query: 'astma treatment' });
    expect(input.query).toBe('astma treatment');
  });

  it('rejects queries shorter than 2 chars', () => {
    expect(() => spellCheckTool.input.parse({ query: 'a' })).toThrow();
  });

  it('returns correction from NCBI', async () => {
    mockESpell.mockResolvedValue({
      original: 'astma',
      corrected: 'asthma',
      hasSuggestion: true,
    });
    const ctx = createMockContext();
    const input = spellCheckTool.input.parse({ query: 'astma' });
    const result = await spellCheckTool.handler(input, ctx);

    expect(result.original).toBe('astma');
    expect(result.corrected).toBe('asthma');
    expect(result.hasSuggestion).toBe(true);
  });

  it('returns original when no suggestion', async () => {
    mockESpell.mockResolvedValue({
      original: 'cancer',
      corrected: 'cancer',
      hasSuggestion: false,
    });
    const ctx = createMockContext();
    const input = spellCheckTool.input.parse({ query: 'cancer' });
    const result = await spellCheckTool.handler(input, ctx);

    expect(result.hasSuggestion).toBe(false);
  });

  it('formats result with suggestion', () => {
    const blocks = spellCheckTool.format!({
      original: 'astma',
      corrected: 'asthma',
      hasSuggestion: true,
    });
    expect(blocks[0]?.text).toContain('Suggestion');
    expect(blocks[0]?.text).toContain('asthma');
  });

  it('formats result without suggestion', () => {
    const blocks = spellCheckTool.format!({
      original: 'cancer',
      corrected: 'cancer',
      hasSuggestion: false,
    });
    expect(blocks[0]?.text).toContain('No suggestion');
  });
});
