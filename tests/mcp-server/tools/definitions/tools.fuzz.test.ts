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

import { beforeEach, describe, expect, it, vi } from 'vitest';
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
  });

  it('pubmed_fetch_articles survives fuzz', async () => {
    const report = await fuzzToolStrict(fetchArticlesTool, FUZZ_OPTIONS);
    assertClean(report);
  });

  it('pubmed_fetch_fulltext survives fuzz', async () => {
    const report = await fuzzToolStrict(fetchFulltextTool, FUZZ_OPTIONS);
    assertClean(report);
  });

  it('pubmed_find_related survives fuzz', async () => {
    const report = await fuzzToolStrict(findRelatedTool, FUZZ_OPTIONS);
    assertClean(report);
  });

  it('pubmed_format_citations survives fuzz', async () => {
    const report = await fuzzToolStrict(formatCitationsTool, FUZZ_OPTIONS);
    assertClean(report);
  });

  it('pubmed_lookup_citation survives fuzz', async () => {
    const report = await fuzzToolStrict(lookupCitationTool, FUZZ_OPTIONS);
    assertClean(report);
  });

  it('pubmed_convert_ids survives fuzz', async () => {
    const report = await fuzzToolStrict(convertIdsTool, FUZZ_OPTIONS);
    assertClean(report);
  });
});
