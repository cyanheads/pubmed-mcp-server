/**
 * @fileoverview Tests for the spell-check tool.
 * @module tests/mcp-server/tools/definitions/spell-check.tool.test
 */

import type { ContentBlock } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { bunMarkdown, renderedText, textBlocks } from '../../../_helpers.js';
import { capturedEspell } from '../../../services/ncbi/_espell-fixtures.js';

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

  it('fills the declared recovery hint onto a service throw that carries only its reason', async () => {
    mockESpell.mockRejectedValue(
      serviceUnavailable('NCBI request failed: socket hang up', { reason: 'ncbi_unreachable' }),
    );
    const result = await runToolContract(spellCheckTool, { query: 'astma' });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.ServiceUnavailable,
        data: {
          reason: 'ncbi_unreachable',
          recovery: {
            hint: expect.stringContaining('NCBI failed on every attempt this call made'),
          },
        },
      },
    });
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

  describe('numeric-looking queries through the real ESpell parse (#108)', () => {
    // The reported symptom was an output-validation failure after a successful
    // upstream round-trip: the coercing XML parser turned ESpell's echoed
    // `<Query>` into a number (`007` → 7, `1e5` → 100000) and the string output
    // schema rejected it. Route the tool through the real `eSpell` — request,
    // XML parse, result mapping — behind a stubbed fetch replying as NCBI does.
    let fetchSpy: ReturnType<typeof vi.spyOn> | undefined;

    beforeAll(async () => {
      const actual = await vi.importActual<typeof import('@/services/ncbi/ncbi-service.js')>(
        '@/services/ncbi/ncbi-service.js',
      );
      fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
        const url = new URL(String(input));
        if (url.hostname !== 'eutils.ncbi.nlm.nih.gov' || !url.pathname.endsWith('/espell.fcgi')) {
          throw new Error(`unexpected request ${url.hostname}${url.pathname}`);
        }
        const term = url.searchParams.get('term') ?? '';
        const body = `<?xml version="1.0" encoding="UTF-8" ?>\n<!DOCTYPE eSpellResult PUBLIC "-//NLM//DTD esearch 20060628//EN" "https://eutils.ncbi.nlm.nih.gov/eutils/dtd/20060628/espell.dtd">\n<eSpellResult>\n\t<Database>pubmed</Database>\n\t<Query>${term}</Query>\n\t<CorrectedQuery>${term}</CorrectedQuery>\n\t<SpelledQuery/>\n</eSpellResult>\n`;
        return Promise.resolve(new Response(body, { status: 200 }));
      });
      actual.initNcbiService();
      const service = actual.getNcbiService();
      mockESpell.mockImplementation((params, options) => service.eSpell(params, options));
    });

    afterAll(() => {
      fetchSpy?.mockRestore();
      mockESpell.mockReset();
    });

    it.each(['33306283', '007', '1e5'])(
      'returns %s verbatim and passes output validation on both surfaces',
      async (query) => {
        const ctx = createMockContext({ errors: spellCheckTool.errors });
        const result = await spellCheckTool.handler(spellCheckTool.input.parse({ query }), ctx);

        expect(spellCheckTool.output.parse(result)).toEqual({
          original: query,
          corrected: query,
          hasSuggestion: false,
        });
        expect(textBlocks(spellCheckTool.format!(result))[0]?.text).toContain(`\`${query}\``);
        expect(fetchSpy).toHaveBeenCalled();
      },
    );
  });

  describe('corrections rebuilt over the caller’s text through the real ESpell parse (#241)', () => {
    // Route the tool through the real `eSpell` behind a stubbed fetch that
    // replays ESpell's captured answer for each term.
    let fetchSpy: ReturnType<typeof vi.spyOn> | undefined;

    beforeAll(async () => {
      const actual = await vi.importActual<typeof import('@/services/ncbi/ncbi-service.js')>(
        '@/services/ncbi/ncbi-service.js',
      );
      fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
        const url = new URL(String(input));
        if (url.hostname !== 'eutils.ncbi.nlm.nih.gov' || !url.pathname.endsWith('/espell.fcgi')) {
          throw new Error(`unexpected request ${url.hostname}${url.pathname}`);
        }
        return Promise.resolve(
          new Response(capturedEspell(url.searchParams.get('term') ?? ''), { status: 200 }),
        );
      });
      actual.initNcbiService();
      const service = actual.getNcbiService();
      mockESpell.mockImplementation((params, options) => service.eSpell(params, options));
    });

    afterAll(() => {
      fetchSpy?.mockRestore();
      mockESpell.mockReset();
    });

    it.each([
      [
        'breast cancer[MeSH] AND tamoxifen resistence',
        'breast cancer[MeSH] AND tamoxifen resistance',
      ],
      ['BRCA1 tamoxifen resistence', 'BRCA1 tamoxifen resistance'],
      // ESpell rewrites the tag text and swaps the letter; both stay as written. (#250)
      ['risk[tiab] AND alzhiemer', 'risk[tiab] AND alzheimer'],
      ['smith j[au] AND diabetis', 'smith j[au] AND diabetes'],
      ['q fever outbreak', 'q fever outbreaks'],
      // ESpell rewrites `aged` to `age`: an indexed value stays as written, and a
      // free-text one is corrected. (#259)
      ['cancr AND aged[mh]', 'cancer AND aged[mh]'],
      ['cancr AND diabetis[tiab]', 'cancer AND diabetes[tiab]'],
    ])('keeps %j re-runnable on both surfaces', async (query, corrected) => {
      const result = await runToolContract(spellCheckTool, { query });

      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toEqual({ original: query, corrected, hasSuggestion: true });
      expect(textBlocks(result.content as ContentBlock[])[0]?.text).toBe(
        `**Suggestion:** \`${corrected}\` (original: \`${query}\`)`,
      );
    });

    // ESpell would rewrite `humen[mh]` to `human[mh]`; a misspelled indexed
    // value is kept as written too. (#259)
    it.each(['IL6', 'HbA1c', 'neoplasm[mh] AND humen[mh]'])(
      'reports no suggestion for %s, which ESpell only lowercases or rewrites',
      async (query) => {
        const result = await runToolContract(spellCheckTool, { query });

        expect(result.structuredContent).toEqual({
          original: query,
          corrected: query,
          hasSuggestion: false,
        });
        expect(textBlocks(result.content as ContentBlock[])[0]?.text).toBe(
          `No correction applied — query \`${query}\` is returned as written.`,
        );
      },
    );
  });

  describe('a query carrying Markdown-significant characters (issue #255)', () => {
    const query = 'cance* AND neuro*[tiab] AND <b>a_b_c</b> AND x`y';
    const corrected = 'cancer* AND neuro*[tiab] AND <b>a_b_c</b> AND x`y';

    it('echoes both queries exactly on the raw content[] text, structuredContent unchanged', async () => {
      mockESpell.mockResolvedValue({ original: query, corrected, hasSuggestion: true });
      const result = await runToolContract(spellCheckTool, { query });

      expect(result.structuredContent).toEqual({ original: query, corrected, hasSuggestion: true });
      expect(textBlocks(result.content as ContentBlock[])[0]?.text).toBe(
        `**Suggestion:** \`\`${corrected}\`\` (original: \`\`${query}\`\`)`,
      );
    });

    it.runIf(bunMarkdown !== undefined)('renders both queries exactly', () => {
      const suggestion = textBlocks(
        spellCheckTool.format!({ original: query, corrected, hasSuggestion: true }),
      )[0]?.text;
      const none = textBlocks(
        spellCheckTool.format!({ original: query, corrected: query, hasSuggestion: false }),
      )[0]?.text;

      expect(renderedText(suggestion ?? '')).toBe(`Suggestion: ${corrected} (original: ${query})`);
      expect(renderedText(none ?? '')).toBe(
        `No correction applied — query ${query} is returned as written.`,
      );
    });
  });

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
        data: { reason: 'blank_query' },
      });
      expect(mockESpell).not.toHaveBeenCalled();
    });

    // `.trim()` keeps U+0085 and format characters such as U+200B.
    it.each([
      ['next-line characters (U+0085)', '\u0085\u0085'],
      ['zero-width spaces', '​​'],
      ['a word joiner and a soft hyphen between spaces', ' ⁠­ '],
    ])('rejects a query of %s without calling ESpell', async (_label, query) => {
      const result = await runToolContract(spellCheckTool, { query });

      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: {
          code: JsonRpcErrorCode.ValidationError,
          data: { reason: 'blank_query', retryable: false },
        },
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
    expect(blocks[0]?.text).toBe('No correction applied — query `cancer` is returned as written.');
  });
});

describe('spellCheckTool description (issue #151)', () => {
  const { description } = spellCheckTool;

  it('names PubMed and ESpell', () => {
    expect(description).toContain('PubMed');
    expect(description).toContain('ESpell');
  });

  it('says when to reach for it and what to do with the answer', () => {
    expect(description).toContain('zero-hit or thin `pubmed_search_articles` result');
    expect(description).toContain('`hasSuggestion` is false');
    expect(description).toContain('Re-run the search with `corrected`');
  });

  it('says the value of an indexed field is kept and a free-text one corrected (#259)', () => {
    expect(description).toContain('`aged[mh]`');
    expect(description).toMatch(/value of an indexed field[^.]*is kept as written/);
    expect(description).toMatch(/free-text fields such as `\[tiab\]`[^.]*are corrected/);
    expect(spellCheckTool.output.shape.corrected.description).toContain('values of indexed fields');
  });

  it('carries a worked example that matches ESpell’s own answer', async () => {
    const example = description.match(/`([^`]+)` → `([^`]+)`/);
    expect(example?.slice(1)).toEqual([
      'alzhiemer diseese treatmnt outcomse',
      'alzheimer disease treatment outcomes',
    ]);
    // Run the example through the tool against ESpell's recorded answer.
    mockESpell.mockResolvedValue({
      original: 'alzhiemer diseese treatmnt outcomse',
      corrected: 'alzheimer disease treatment outcomes',
      hasSuggestion: true,
    });
    const result = await runToolContract(spellCheckTool, {
      query: 'alzhiemer diseese treatmnt outcomse',
    });
    expect(result.structuredContent).toMatchObject({
      corrected: example?.[2],
      hasSuggestion: true,
    });
    expect(textBlocks(result.content as ContentBlock[])[0]?.text).toContain(
      `**Suggestion:** \`${example?.[2]}\``,
    );
  });
});
