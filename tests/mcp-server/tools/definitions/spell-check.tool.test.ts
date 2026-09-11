/**
 * @fileoverview Tests for the spell-check tool.
 * @module tests/mcp-server/tools/definitions/spell-check.tool.test
 */

import type { ContentBlock } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it, vi } from 'vitest';

import { textBlocks } from '../../../_helpers.js';

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
    const ctx = createMockContext({ errors: spellCheckTool.errors });
    const input = spellCheckTool.input.parse({ query: 'astma' });
    const result = await spellCheckTool.handler(input, ctx);

    expect(result.original).toBe('astma');
    expect(result.corrected).toBe('asthma');
    expect(result.hasSuggestion).toBe(true);
  });

  it('threads ctx.signal into the ESpell call so cancellation reaches NCBI (#89)', async () => {
    mockESpell.mockResolvedValue({ original: 'astma', corrected: 'asthma', hasSuggestion: true });
    const ctx = createMockContext({ errors: spellCheckTool.errors });
    const input = spellCheckTool.input.parse({ query: 'astma' });
    await spellCheckTool.handler(input, ctx);

    expect(mockESpell).toHaveBeenCalledWith(
      { db: 'pubmed', term: 'astma' },
      { signal: ctx.signal },
    );
    expect(ctx.signal).toBeInstanceOf(AbortSignal);
  });

  it('returns original when no suggestion', async () => {
    mockESpell.mockResolvedValue({
      original: 'cancer',
      corrected: 'cancer',
      hasSuggestion: false,
    });
    const ctx = createMockContext({ errors: spellCheckTool.errors });
    const input = spellCheckTool.input.parse({ query: 'cancer' });
    const result = await spellCheckTool.handler(input, ctx);

    expect(result.hasSuggestion).toBe(false);
  });

  it.each(['33306283', '007', '1e5'])(
    'passes output validation for the numeric-looking query %s on both surfaces (#108)',
    async (query) => {
      // The reported symptom was an output-validation failure after a
      // successful upstream round-trip: the XML parser handed eSpell a number
      // and the string output schema rejected it. Parse the handler's return
      // through the declared schema so the tool surface is covered too, not
      // only the service.
      mockESpell.mockResolvedValue({ original: query, corrected: query, hasSuggestion: false });
      const ctx = createMockContext({ errors: spellCheckTool.errors });
      const result = await spellCheckTool.handler(spellCheckTool.input.parse({ query }), ctx);

      expect(spellCheckTool.output.parse(result)).toEqual({
        original: query,
        corrected: query,
        hasSuggestion: false,
      });
      expect(textBlocks(spellCheckTool.format!(result))[0]?.text).toContain(`"${query}"`);
    },
  );

  describe('blank query rejection (issue #133)', () => {
    // `min(2)` counts the spaces, so a whitespace-only query used to reach
    // ESpell, which answers with an empty <ERROR/> the response handler does
    // not detect — the tool then reported the blank input as spell-checked.
    it('rejects a whitespace-only query without calling ESpell', async () => {
      const ctx = createMockContext({ errors: spellCheckTool.errors });
      const input = spellCheckTool.input.parse({ query: '  ' });

      const promise = spellCheckTool.handler(input, ctx);
      await expect(promise).rejects.toMatchObject({
        code: JsonRpcErrorCode.ValidationError,
        data: { reason: 'blank_query', recovery: { hint: expect.stringMatching(/nonblank/i) } },
      });
      expect(mockESpell).not.toHaveBeenCalled();
    });

    it('mirrors the reason and recovery hint onto both error surfaces', async () => {
      const result = await runToolContract(spellCheckTool, { query: '  ' });

      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: { code: JsonRpcErrorCode.ValidationError, data: { reason: 'blank_query' } },
      });
      const text = textBlocks(result.content as ContentBlock[])
        .map((b) => b.text)
        .join('\n');
      expect(text).toMatch(/Recovery:/);
      expect(text).toMatch(/nonblank/i);
    });

    it('declares blank_query as a non-retryable input error', () => {
      expect(spellCheckTool.errors?.find((e) => e.reason === 'blank_query')).toMatchObject({
        code: JsonRpcErrorCode.ValidationError,
        retryable: false,
      });
    });

    it('still spell-checks a legitimate query padded with whitespace', async () => {
      mockESpell.mockResolvedValue({
        original: '  covid  ',
        corrected: 'covid',
        hasSuggestion: true,
      });
      const ctx = createMockContext({ errors: spellCheckTool.errors });
      const result = await spellCheckTool.handler(
        spellCheckTool.input.parse({ query: '  covid  ' }),
        ctx,
      );

      expect(mockESpell).toHaveBeenCalledWith(
        { db: 'pubmed', term: '  covid  ' },
        { signal: ctx.signal },
      );
      expect(result.corrected).toBe('covid');
    });
  });

  it('formats result with suggestion', () => {
    const blocks = textBlocks(
      spellCheckTool.format!({
        original: 'astma',
        corrected: 'asthma',
        hasSuggestion: true,
      }),
    );
    expect(blocks[0]?.text).toContain('Suggestion');
    expect(blocks[0]?.text).toContain('asthma');
  });

  it('formats result without suggestion', () => {
    const blocks = textBlocks(
      spellCheckTool.format!({
        original: 'cancer',
        corrected: 'cancer',
        hasSuggestion: false,
      }),
    );
    expect(blocks[0]?.text).toContain('No suggestion');
  });
});
