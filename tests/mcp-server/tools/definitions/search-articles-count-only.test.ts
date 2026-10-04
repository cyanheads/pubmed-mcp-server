/**
 * @fileoverview `pubmed_search_articles` with `maxResults: 0` (issue #191) against the
 * real NCBI service, with only `fetch` faked. Pins what reaches the wire — one ESearch
 * carrying `retmax=0` and no ESummary — and that NCBI's `retmax=0` answer (the full
 * Count beside an empty `<IdList/>`) parses to an empty page with its total.
 * @module tests/mcp-server/tools/definitions/search-articles-count-only.test
 */

import type { ContentBlock } from '@cyanheads/mcp-ts-core';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest';

import { textBlocks } from '../../../_helpers.js';

/** NCBI's answer to `esearch.fcgi?db=pubmed&term=ferroptosis&retmax=0&usehistory=y`, 2026-10-04. */
const RETMAX_ZERO_XML = `<?xml version="1.0" encoding="UTF-8" ?>
<!DOCTYPE eSearchResult PUBLIC "-//NLM//DTD esearch 20060628//EN" "https://eutils.ncbi.nlm.nih.gov/eutils/dtd/20060628/esearch.dtd">
<eSearchResult><Count>31104</Count><RetMax>0</RetMax><RetStart>0</RetStart><QueryKey>1</QueryKey><WebEnv>MCID_6ac211bc3853deca930be558</WebEnv><IdList/><TranslationSet><Translation>     <From>ferroptosis</From>     <To>"ferroptosis"[MeSH Terms] OR "ferroptosis"[All Fields]</To>    </Translation></TranslationSet><QueryTranslation>"ferroptosis"[MeSH Terms] OR "ferroptosis"[All Fields]</QueryTranslation></eSearchResult>
`;

let fetchSpy: MockInstance<typeof fetch>;

/** The tool bound to the real NCBI service, every NCBI setting at its default. */
async function loadTool() {
  for (const name of [
    'NCBI_API_KEY',
    'NCBI_REQUEST_DELAY_MS',
    'NCBI_MAX_CONCURRENT',
    'NCBI_MAX_RETRIES',
    'NCBI_TIMEOUT_MS',
    'NCBI_TOTAL_DEADLINE_MS',
  ]) {
    vi.stubEnv(name, '');
  }
  const { initNcbiService } = await import('@/services/ncbi/ncbi-service.js');
  initNcbiService();
  const module = await import('@/mcp-server/tools/definitions/search-articles.tool.js');
  return module.searchArticlesTool;
}

/** Each requested URL, in order. */
function requestedUrls(): URL[] {
  return fetchSpy.mock.calls.map(
    ([input]) => new URL(input instanceof Request ? input.url : String(input)),
  );
}

beforeEach(() => {
  vi.resetModules();
  fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('unmocked fetch'));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('pubmed_search_articles count-only search on the wire (issue #191)', () => {
  it.each([
    ['without summaryCount', {}],
    ['with summaryCount: 5', { summaryCount: 5 }],
  ])('sends one ESearch with retmax=0 and no ESummary, %s', async (_label, extra) => {
    fetchSpy.mockImplementation(() =>
      Promise.resolve(new Response(RETMAX_ZERO_XML, { status: 200 })),
    );
    const tool = await loadTool();

    const result = await runToolContract(tool, { query: 'ferroptosis', maxResults: 0, ...extra });

    expect(result.isError).toBeFalsy();
    const urls = requestedUrls();
    expect(urls).toHaveLength(1);
    expect(urls[0]?.pathname).toBe('/entrez/eutils/esearch.fcgi');
    expect(urls[0]?.searchParams.get('retmax')).toBe('0');
    expect(urls[0]?.searchParams.get('term')).toBe('ferroptosis');
    expect(result.structuredContent).toMatchObject({
      pmids: [],
      summaries: [],
      totalCount: 31104,
      offset: 0,
    });
    expect((result.structuredContent as { notice?: string }).notice).toBeUndefined();
    const text = textBlocks(result.content as ContentBlock[])
      .map((b) => b.text)
      .join('\n');
    expect(text).toContain('**Returned:** 0 of 31104 | **Offset:** 0');
    expect(text).not.toContain('**PMIDs:**');
  });
});
