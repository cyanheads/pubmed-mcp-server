/**
 * @fileoverview Tests for the spell-check tool.
 * @module tests/mcp-server/tools/definitions/spell-check.tool.test
 */

import type { ContentBlock } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError, serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NcbiApiClient } from '@/services/ncbi/api-client.js';
import type { NcbiRequestOptions, NcbiRequestParams } from '@/services/ncbi/types.js';

import { bunMarkdown, cpuMsPerCallAsync, renderedText, textBlocks } from '../../../_helpers.js';
import {
  CAPTURED_COUNTS,
  capturedCheckedEspell,
  capturedEspell,
  esearchCountBody,
  espellBody,
} from '../../../services/ncbi/_espell-fixtures.js';
import { driveUntilSettled, track } from '../../../services/ncbi/_fake-clock.js';

const mockESpell = vi.fn();
vi.mock('@/services/ncbi/ncbi-service.js', () => ({
  getNcbiService: () => ({ eSpell: mockESpell }),
}));

// The real deadline, watched so a test can read the one the handler started.
vi.mock('@/services/call-deadline.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/call-deadline.js')>();
  return { ...actual, startCallDeadline: vi.fn(actual.startCallDeadline) };
});

const { spellCheckTool } = await import('@/mcp-server/tools/definitions/spell-check.tool.js');
const { startCallDeadline } = await import('@/services/call-deadline.js');

/** The deadline the handler's latest call started. */
const startedDeadline = () => vi.mocked(startCallDeadline).mock.results.at(-1)?.value;

/**
 * The real `NcbiService` — client, response handler, and retry loop — over a
 * pacer with no start gap and no retries, so a stubbed fetch drives each
 * record-count check (#316) without a real wait between requests.
 */
async function realNcbiService() {
  const { NcbiService } = await vi.importActual<typeof import('@/services/ncbi/ncbi-service.js')>(
    '@/services/ncbi/ncbi-service.js',
  );
  const { NcbiApiClient } = await import('@/services/ncbi/api-client.js');
  const { NcbiResponseHandler } = await import('@/services/ncbi/response-handler.js');
  const { createPacer } = await import('@cyanheads/mcp-ts-core/utils');
  return new NcbiService(
    new NcbiApiClient({ toolIdentifier: 'pubmed-mcp-server', timeoutMs: 30_000 }),
    createPacer({ name: 'ncbi-test' }),
    new NcbiResponseHandler(),
    0,
    60_000,
  );
}

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

  it('threads ctx.signal and the deadline it starts into the ESpell call (#89, #310)', async () => {
    mockESpell.mockResolvedValue({ original: 'astma', corrected: 'asthma', hasSuggestion: true });
    vi.mocked(startCallDeadline).mockClear();
    const ctx = createMockContext({ errors: spellCheckTool.errors });
    const input = spellCheckTool.input.parse({ query: 'astma' });
    await spellCheckTool.handler(input, ctx);

    expect(startCallDeadline).toHaveBeenCalledOnce();
    const deadline = startedDeadline();
    expect(mockESpell).toHaveBeenCalledWith(
      { db: 'pubmed', term: 'astma' },
      { signal: ctx.signal, deadline },
    );
    expect(mockESpell.mock.calls.at(-1)?.[1]?.deadline).toBe(deadline);
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

  // pubmed_search_articles names another search in these two hints; no other
  // definition spreading the shared NCBI contract does. Loaded beside it, as the
  // server loads every definition, so a rewrite of a shared entry in place shows. (#288)
  it.each([
    [
      'ncbi_unreachable',
      JsonRpcErrorCode.ServiceUnavailable,
      'Retry after a brief delay; NCBI failed on every attempt this call made.',
    ],
    [
      'ncbi_deadline_exceeded',
      JsonRpcErrorCode.Timeout,
      'Retry after a brief delay; NCBI may be under temporary load. For a large batch, split it into smaller calls.',
    ],
  ])('keeps the shared %s recovery, which names no other search', async (reason, code, hint) => {
    const { searchArticlesTool } = await import(
      '@/mcp-server/tools/definitions/search-articles.tool.js'
    );
    expect(searchArticlesTool.errors?.find((e) => e.reason === reason)?.recovery).toContain(
      'pubmed_europepmc_search',
    );
    mockESpell.mockRejectedValue(new McpError(code, 'NCBI did not answer', { reason }));
    const result = await runToolContract(spellCheckTool, { query: 'astma' });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: { code, data: { reason, recovery: { hint } } },
    });
    const text = textBlocks(result.content as ContentBlock[])
      .map((b) => b.text)
      .join('\n');
    expect(text).toContain(`Recovery: ${hint}`);
    expect(text).not.toContain('pubmed_europepmc_search');
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
    // replays ESpell's captured answer for each term, and answers every PubMed
    // record count with the same number so each replacement passes its check.
    let fetchSpy: ReturnType<typeof vi.spyOn> | undefined;

    beforeAll(async () => {
      fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
        const url = new URL(String(input));
        if (url.hostname === 'eutils.ncbi.nlm.nih.gov' && url.pathname.endsWith('/esearch.fcgi')) {
          return Promise.resolve(new Response(esearchCountBody(1), { status: 200 }));
        }
        if (url.hostname !== 'eutils.ncbi.nlm.nih.gov' || !url.pathname.endsWith('/espell.fcgi')) {
          throw new Error(`unexpected request ${url.hostname}${url.pathname}`);
        }
        return Promise.resolve(
          new Response(capturedEspell(url.searchParams.get('term') ?? ''), { status: 200 }),
        );
      });
      const service = await realNcbiService();
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

  describe('a notice naming each record-count check that did not run (#316)', () => {
    const corrections = {
      original: 'cancra cancrb',
      corrected: 'cancera cancrb',
      hasSuggestion: true,
    };
    const skip = (check: 'count' | 'mesh', word: string, replacement: string, reason: string) => ({
      check,
      word,
      replacement,
      reason,
    });

    it.each([
      [
        'a correction whose count failed',
        [skip('count', 'cancra', 'cancera', 'request_failed')],
        'Applied as ESpell wrote them; their PubMed record counts were not checked because an NCBI request failed: `cancra` → `cancera`.',
      ],
      [
        'corrections past the request limit',
        [
          skip('count', 'cancrg', 'cancerg', 'request_cap'),
          skip('count', 'cancrh', 'cancerh', 'request_cap'),
        ],
        'Applied as ESpell wrote them; their PubMed record counts were not checked because the checks reached their limit of 12 NCBI requests: `cancrg` → `cancerg`, `cancrh` → `cancerh`.',
      ],
      [
        'a correction past the time limit',
        [skip('count', 'cancra', 'cancera', 'time_limit')],
        'Applied as ESpell wrote them; their PubMed record counts were not checked because the checks ran out of time: `cancra` → `cancera`.',
      ],
      [
        'a dropped word whose MeSH lookup failed',
        [skip('mesh', 'tirzepatid', 'irzepatide', 'request_failed')],
        "Kept as written because ESpell's correction has under a tenth of their PubMed records; no MeSH-dictionary spelling was tried because an NCBI request failed: `tirzepatid` (not `irzepatide`).",
      ],
      [
        'a dropped word past the request limit',
        [skip('mesh', 'crispr', 'crispri', 'request_cap')],
        "Kept as written because ESpell's correction has under a tenth of their PubMed records; no MeSH-dictionary spelling was tried because the checks reached their limit of 12 NCBI requests: `crispr` (not `crispri`).",
      ],
      [
        'a dropped word past the time limit',
        [skip('mesh', 'crispr', 'crispri', 'time_limit')],
        "Kept as written because ESpell's correction has under a tenth of their PubMed records; no MeSH-dictionary spelling was tried because the checks ran out of time: `crispr` (not `crispri`).",
      ],
      [
        'each kind and cause in its own sentence, in the order first reported',
        [
          skip('count', 'cancra', 'cancera', 'request_failed'),
          skip('count', 'cancrg', 'cancerg', 'request_cap'),
          skip('count', 'cancrh', 'cancerh', 'request_cap'),
          skip('mesh', 'crispr', 'crispri', 'request_cap'),
        ],
        "Applied as ESpell wrote them; their PubMed record counts were not checked because an NCBI request failed: `cancra` → `cancera`. Applied as ESpell wrote them; their PubMed record counts were not checked because the checks reached their limit of 12 NCBI requests: `cancrg` → `cancerg`, `cancrh` → `cancerh`. Kept as written because ESpell's correction has under a tenth of their PubMed records; no MeSH-dictionary spelling was tried because the checks reached their limit of 12 NCBI requests: `crispr` (not `crispri`).",
      ],
      [
        'a word carrying a backtick and a line break, kept one code span',
        [skip('count', 'can`cr\nx', 'cancer', 'request_failed')],
        'Applied as ESpell wrote them; their PubMed record counts were not checked because an NCBI request failed: ``can`cr x`` → `cancer`.',
      ],
      [
        'a dropped word and its correction carrying a backtick and a line break, each kept one code span',
        [skip('mesh', 'can`cr\nx', 'can`cer', 'request_failed')],
        "Kept as written because ESpell's correction has under a tenth of their PubMed records; no MeSH-dictionary spelling was tried because an NCBI request failed: ``can`cr x`` (not ``can`cer``).",
      ],
    ])('names %s on both surfaces', async (_label, skippedChecks, notice) => {
      mockESpell.mockResolvedValue({ ...corrections, skippedChecks });
      const result = await runToolContract(spellCheckTool, { query: 'cancra cancrb' });

      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toEqual({ ...corrections, notice });
      expect(textBlocks(result.content as ContentBlock[]).map((b) => b.text)).toEqual([
        '**Suggestion:** `cancera cancrb` (original: `cancra cancrb`)',
        `\n\n> ${notice}`,
      ]);
    });

    it('adds no notice when every check ran', async () => {
      mockESpell.mockResolvedValue(corrections);
      const result = await runToolContract(spellCheckTool, { query: 'cancra cancrb' });

      expect(result.structuredContent).toEqual(corrections);
      expect(textBlocks(result.content as ContentBlock[]).map((b) => b.text)).toEqual([
        '**Suggestion:** `cancera cancrb` (original: `cancra cancrb`)',
      ]);
    });
  });

  describe('record-count checks through the real ESpell parse and the captured counts (#316)', () => {
    // Route the tool through the real `eSpell` behind a stubbed fetch that
    // replays NCBI's 2026-11-21 answers: ESpell from both dictionaries, and
    // each PubMed record count. `failing` names one request to answer with 503.
    let fetchSpy: ReturnType<typeof vi.spyOn> | undefined;
    let failing: string | undefined;

    beforeAll(async () => {
      fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
        const url = new URL(String(input));
        const term = url.searchParams.get('term') ?? '';
        const db = url.searchParams.get('db');
        if (url.hostname !== 'eutils.ncbi.nlm.nih.gov') {
          throw new Error(`unexpected request ${url.hostname}${url.pathname}`);
        }
        if (url.pathname.endsWith('/espell.fcgi') && (db === 'pubmed' || db === 'mesh')) {
          if (failing === `espell ${db} ${term}`) {
            return Promise.resolve(new Response('', { status: 503 }));
          }
          return Promise.resolve(new Response(capturedCheckedEspell(db, term), { status: 200 }));
        }
        const count = CAPTURED_COUNTS[term];
        if (url.pathname.endsWith('/esearch.fcgi') && count !== undefined) {
          return Promise.resolve(new Response(esearchCountBody(count), { status: 200 }));
        }
        throw new Error(`unexpected request ${url.pathname} for "${term}"`);
      });
      const service = await realNcbiService();
      mockESpell.mockImplementation((params, options) => service.eSpell(params, options));
    });

    afterEach(() => {
      failing = undefined;
    });

    afterAll(() => {
      fetchSpy?.mockRestore();
      mockESpell.mockReset();
    });

    it.each([
      ['tirzepatide', 'tirzepatide', false],
      ['crispr screen', 'crispr screen', false],
      ['tirzepatid', 'tirzepatide', true],
      ['"heart failure"[tiab] AND tirzepatid', '"heart failure"[tiab] AND tirzepatide', true],
      ['dexamethazone', 'dexamethasone', true],
    ])('returns %j as %j, with no notice', async (query, corrected, hasSuggestion) => {
      const result = await runToolContract(spellCheckTool, { query });

      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toEqual({ original: query, corrected, hasSuggestion });
      expect(textBlocks(result.content as ContentBlock[])).toHaveLength(1);
    });

    it('names the MeSH lookup that failed, on both surfaces', async () => {
      failing = 'espell mesh tirzepatid';
      const result = await runToolContract(spellCheckTool, { query: 'tirzepatid' });
      const notice =
        "Kept as written because ESpell's correction has under a tenth of their PubMed records; no MeSH-dictionary spelling was tried because an NCBI request failed: `tirzepatid` (not `irzepatide`).";

      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toEqual({
        original: 'tirzepatid',
        corrected: 'tirzepatid',
        hasSuggestion: false,
        notice,
      });
      expect(textBlocks(result.content as ContentBlock[]).map((b) => b.text)).toEqual([
        'No correction applied — query `tirzepatid` is returned as written.',
        `\n\n> ${notice}`,
      ]);
    });
  });

  describe('a check the tool call’s deadline cut short (#310)', () => {
    /** Fake-clock origin. Nonzero so no scheduler reads a zero timestamp as "never started". */
    const T0 = 1_000_000;

    beforeEach(() => {
      vi.useFakeTimers({ now: T0 });
    });

    afterEach(() => {
      vi.useRealTimers();
      mockESpell.mockReset();
    });

    it('names it on both surfaces without naming the 10-second limit', async () => {
      const { NcbiService } = await vi.importActual<
        typeof import('@/services/ncbi/ncbi-service.js')
      >('@/services/ncbi/ncbi-service.js');
      const { NcbiResponseHandler } = await import('@/services/ncbi/response-handler.js');
      const { createPacer } = await import('@cyanheads/mcp-ts-core/utils');
      const body = espellBody(
        '<eSpellResult>\n\t<Database>pubmed</Database>\n\t<Query>cancra</Query>\n\t<CorrectedQuery>cancera</CorrectedQuery>\n\t<SpelledQuery><Original></Original><Replaced>cancera</Replaced></SpelledQuery>\n\t<ERROR/>\n</eSpellResult>\n',
      );
      // ESpell answers 46 s into the tool call's 50 s, leaving the checks 4 s; the
      // count of `cancra` comes back at once, the count of `cancera` never does.
      const makeRequest = (
        endpoint: string,
        params: NcbiRequestParams,
        options?: NcbiRequestOptions,
      ) => {
        if (endpoint === 'espell')
          return new Promise<string>((resolve) => setTimeout(() => resolve(body), 46_000));
        if (params.term === 'cancra') return Promise.resolve(esearchCountBody(5));
        const signal = options?.signal;
        return new Promise<string>((_, reject) => {
          signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
      };
      const service = new NcbiService(
        { makeRequest } as unknown as NcbiApiClient,
        createPacer({ name: 'ncbi-test' }),
        new NcbiResponseHandler(),
        0,
        60_000,
      );
      mockESpell.mockImplementation((params, options) => service.eSpell(params, options));

      const pending = runToolContract(spellCheckTool, { query: 'cancra' });
      expect(await driveUntilSettled(track(pending), 60_000)).toEqual({ ok: true });
      const result = await pending;
      const notice =
        'Applied as ESpell wrote them; their PubMed record counts were not checked because the checks ran out of time: `cancra` → `cancera`.';

      expect(Date.now() - T0).toBe(50_000);
      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toEqual({
        original: 'cancra',
        corrected: 'cancera',
        hasSuggestion: true,
        notice,
      });
      expect(textBlocks(result.content as ContentBlock[]).map((b) => b.text)).toEqual([
        '**Suggestion:** `cancera` (original: `cancra`)',
        `\n\n> ${notice}`,
      ]);
    });
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
        { signal: ctx.signal, deadline: startedDeadline() },
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

  it('says each correction is checked against PubMed, and when a notice names one (#316)', () => {
    expect(description).toContain(
      'one with under a tenth of the PubMed records of the word it replaces is dropped and the word kept',
    );
    expect(description).toContain("ESpell's MeSH dictionary");
    expect(description).toContain('`notice` names it');
    expect(spellCheckTool.output.shape.corrected.description).toContain(
      'under a tenth of its PubMed records',
    );
    expect(spellCheckTool.enrichment?.notice.description).toContain(
      'the checks reached their limit of 12 requests, or they ran out of time (10 seconds, or less when the tool call had less time left)',
    );
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

describe('the skipped-check notice — linear time on adversarial input (#316)', () => {
  /**
   * CPU time of one tool call, through the production output parse and the
   * enrichment trailer, whose ESpell result reports `skippedChecks`; checked
   * against the absolute bound before the caller times the next size.
   */
  const msPerCall = async (size: number, skippedChecks: object[]) => {
    mockESpell.mockResolvedValue({
      original: 'cancr',
      corrected: 'cancer',
      hasSuggestion: true,
      skippedChecks,
    });
    const call = () => runToolContract(spellCheckTool, { query: 'cancr' });
    expect((await call()).structuredContent).toHaveProperty('notice');
    const ms = await cpuMsPerCallAsync(size, call);
    expect(ms).toBeLessThan(400);
    return ms;
  };

  /** One skipped check of each kind for `word`. */
  const bothKinds = (word: string) => [
    { check: 'count', word, replacement: 'cancer', reason: 'request_cap' },
    { check: 'mesh', word, replacement: 'cancer', reason: 'time_limit' },
  ];

  it.each<[string, (n: number) => object[]]>([
    ['one long line ending in a break', (n) => bothKinds(`${'§1 x'.repeat(n / 8)}\ny`)],
    ['line breaks throughout', (n) => bothKinds('  \r\n'.repeat(n / 8))],
    ['backtick runs of growing length', (n) => bothKinds('`a``b```c````d'.repeat(n / 28))],
    [
      'one short word per check',
      (n) =>
        Array.from({ length: n / 8 }, (_, i) => ({
          check: i % 2 === 0 ? 'count' : 'mesh',
          word: 'cancr',
          replacement: 'cancer',
          reason: 'request_cap',
        })),
    ],
  ])('scales linearly from 5k to 320k characters: %s', async (_label, build) => {
    // Doubling from 5k, each size checked against the absolute bound before the next runs.
    for (let n = 5_000; n <= 320_000; n *= 2) await msPerCall(n, build(n));
    // The full span, against a 5k baseline timed again beside it: the least of three pairs.
    let growth = Number.POSITIVE_INFINITY;
    for (let pair = 0; pair < 3; pair++) {
      const base = await msPerCall(5_000, build(5_000));
      const top = await msPerCall(320_000, build(320_000));
      growth = Math.min(growth, top / Math.max(base, 0.05));
    }
    // Linear work grows 64× across the span; quadratic grows 4096×.
    expect(growth).toBeLessThan(256);
  });
});
