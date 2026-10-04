/**
 * @fileoverview Property-based fuzz coverage for all 9 PubMed tools. Generates
 * valid inputs from each tool's Zod schema plus adversarial-shape inputs, then
 * asserts the standard `FuzzReport` invariants — no crashes on Phase 1 valid
 * runs, no stack-trace / path leaks in error messages, no prototype pollution.
 *
 * Mocks `NcbiService` with permissive defaults that return minimal valid shapes
 * so every tool's handler runs through to completion. `UnpaywallService` is
 * stubbed to `undefined` so `fetch_fulltext`'s fallback path is disabled —
 * fuzzed PMIDs without PMC entries become `unavailable` rows, which still
 * validates the output schema.
 *
 * Seed pinned at 42 for reproducibility. Per-tool runs use `numRuns: 50` and
 * `numAdversarial: 30`; the whole suite is sized to fit comfortably under the
 * issue's 30-second runtime budget.
 *
 * @module tests/mcp-server/tools/definitions/tools.fuzz.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { hasVisibleText } from '@/mcp-server/tools/definitions/_visible-text.js';
import {
  createMockNcbiService,
  FUZZ_OPTIONS,
  fuzzToolStrict,
  type MockNcbiService,
} from './_fuzz-helpers.js';

let mockNcbi: MockNcbiService = createMockNcbiService();

vi.mock('@/services/ncbi/ncbi-service.js', () => ({
  getNcbiService: () => mockNcbi,
}));

vi.mock('@/services/unpaywall/unpaywall-service.js', () => ({
  getUnpaywallService: () => undefined,
}));

const { convertIdsTool } = await import('@/mcp-server/tools/definitions/convert-ids.tool.js');
const { fetchArticlesTool } = await import('@/mcp-server/tools/definitions/fetch-articles.tool.js');
const { fetchFulltextTool } = await import('@/mcp-server/tools/definitions/fetch-fulltext.tool.js');
const { findRelatedTool } = await import('@/mcp-server/tools/definitions/find-related.tool.js');
const { formatCitationsTool } = await import(
  '@/mcp-server/tools/definitions/format-citations.tool.js'
);
const { lookupCitationTool } = await import(
  '@/mcp-server/tools/definitions/lookup-citation.tool.js'
);
const { lookupMeshTool } = await import('@/mcp-server/tools/definitions/lookup-mesh.tool.js');
const { searchArticlesTool } = await import(
  '@/mcp-server/tools/definitions/search-articles.tool.js'
);
const { spellCheckTool } = await import('@/mcp-server/tools/definitions/spell-check.tool.js');

beforeEach(() => {
  // Refresh mock between tools so any per-tool implementation overrides reset.
  mockNcbi = createMockNcbiService();
});

function assertClean(report: Awaited<ReturnType<typeof fuzzToolStrict>>): void {
  expect(report.crashes, JSON.stringify(report.crashes, null, 2)).toHaveLength(0);
  expect(report.leaks, JSON.stringify(report.leaks, null, 2)).toHaveLength(0);
  expect(report.prototypePollution).toBe(false);
}

/**
 * `pubmed_convert_ids` checks each `ids` element against the sibling `idType`
 * in the handler, a pairing no arbitrary satisfies by chance — left raw, every
 * generated id is rejected before the handler runs and the valid-input phase
 * covers nothing but the rejection. Rewrite each element into a well-formed id
 * of the drawn type, keeping the arbitrary's array length, `idType` choice and
 * any extra keys it planted.
 */
function validConvertIds(raw: unknown): unknown {
  if (typeof raw !== 'object' || raw === null) return raw;
  const input = raw as { idType?: unknown; ids?: unknown };
  if (!Array.isArray(input.ids)) return raw;

  const ids = input.ids.map((_, i) => {
    if (input.idType === 'doi') return `10.1093/nar/gks${1195 + i}`;
    if (input.idType === 'pmcid') return `PMC${3531190 + i}`;
    return String(23193287 + i);
  });
  return { ...input, ids };
}

/**
 * `zodToArbitrary` draws a random primitive for a `z.preprocess` field, so left
 * raw every generated `citations` value is rejected before the handler runs
 * (cyanheads/mcp-ts-core#592). Rewrite it into an array of one to three
 * citations whose journal is the drawn value, minus the characters the schema
 * refuses, keeping any extra keys the arbitrary planted. A draw with no visible
 * character — whitespace, a zero-width space — is refused as a journal, so it
 * falls back to a real one and the case still reaches ECitMatch. (#187)
 */
function citationArrays(raw: unknown): unknown {
  if (typeof raw !== 'object' || raw === null) return raw;
  const input = raw as { citations?: unknown };
  const drawn = String(input.citations ?? '').replace(/[|\r\n]/g, ' ');
  const citations = Array.from({ length: (drawn.length % 3) + 1 }, (_, i) => ({
    journal: hasVisibleText(drawn) ? drawn : 'proc natl acad sci u s a',
    year: String(1991 + i),
  }));
  return { ...input, citations };
}

describe('Tool fuzz coverage', () => {
  it('pubmed_spell_check survives fuzz', async () => {
    const report = await fuzzToolStrict(spellCheckTool, FUZZ_OPTIONS);
    assertClean(report);
  });

  it('pubmed_lookup_mesh survives fuzz', async () => {
    const report = await fuzzToolStrict(lookupMeshTool, FUZZ_OPTIONS);
    assertClean(report);
  });

  it('pubmed_search_articles survives fuzz', async () => {
    const report = await fuzzToolStrict(searchArticlesTool, FUZZ_OPTIONS);
    assertClean(report);
    // Arbitrary dates and filter strings often fail the handler's calendar and
    // blank-value checks, which count as declared failures. Reaching ESearch
    // is what keeps the phase from being only those rejections. (#176, #177)
    expect(mockNcbi.eSearch).toHaveBeenCalled();
  });

  it('pubmed_fetch_articles survives fuzz', async () => {
    const report = await fuzzToolStrict(fetchArticlesTool, FUZZ_OPTIONS);
    assertClean(report);
    // The mixed EFetch set only covers the book branch while the book record
    // actually reaches the handler — otherwise the phase fuzzes journal
    // articles alone and reports clean for the wrong reason. (#114)
    const ctx = createMockContext({ errors: fetchArticlesTool.errors });
    const result = await fetchArticlesTool.handler(
      fetchArticlesTool.input.parse({ pmids: ['20301425'] }),
      ctx,
    );
    expect(result.articles.map((a) => a.recordType)).toContain('book-chapter');
    // Same check for the linked-notice branch of `format()`. (#178)
    expect(result.articles.some((a) => a.commentsCorrections?.length)).toBe(true);
  });

  it('pubmed_fetch_fulltext survives fuzz', async () => {
    const report = await fuzzToolStrict(fetchFulltextTool, FUZZ_OPTIONS);
    assertClean(report);
    // The `dois` element pattern narrows what the arbitrary can produce; the
    // phase is only worth anything while generated input still reaches the
    // resolution chain.
    expect(mockNcbi.idConvert).toHaveBeenCalled();
  });

  it('pubmed_find_related survives fuzz', async () => {
    const report = await fuzzToolStrict(findRelatedTool, FUZZ_OPTIONS);
    assertClean(report);
  });

  it('pubmed_format_citations survives fuzz', async () => {
    const report = await fuzzToolStrict(formatCitationsTool, FUZZ_OPTIONS);
    assertClean(report);
    // Same non-vacuity check: the book branch of every formatter is only
    // exercised while a Bookshelf record reaches the handler. (#114)
    const ctx = createMockContext({ errors: formatCitationsTool.errors });
    const result = await formatCitationsTool.handler(
      formatCitationsTool.input.parse({ pmids: ['20301425'], format: 'vancouver' }),
      ctx,
    );
    expect(result.citations.map((c) => c.pmid)).toContain('20301425');
  });

  it('pubmed_lookup_citation survives fuzz', async () => {
    const report = await fuzzToolStrict(lookupCitationTool, {
      ...FUZZ_OPTIONS,
      mapInput: citationArrays,
    });
    assertClean(report);
    // The five bibliographic fields advertise a `pattern` arbitrary strings can
    // fail, and `citations` is a `z.preprocess` field the arbitrary cannot draw.
    // Reaching ECitMatch is what keeps the phase from degenerating into a run of
    // schema rejections. (#125, #173)
    expect(mockNcbi.eCitMatch).toHaveBeenCalled();
  });

  it('pubmed_convert_ids survives fuzz', async () => {
    const report = await fuzzToolStrict(convertIdsTool, {
      ...FUZZ_OPTIONS,
      mapInput: validConvertIds,
    });
    assertClean(report);
    // A run whose every input is rejected pre-flight says nothing about the
    // handler. Reaching the service is what makes the phase non-vacuous.
    expect(mockNcbi.idConvert).toHaveBeenCalled();
  });
});
