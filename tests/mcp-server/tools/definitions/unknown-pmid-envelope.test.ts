/**
 * @fileoverview Regression for issue #155 at the tool surface — an all-invalid PMID
 * list, which NCBI EFetch answers with an HTTP 400 `ID list is empty!` envelope, must
 * read exactly as a well-formed PMID NCBI has no record for (`99999999`, HTTP 200 and
 * an empty `PubmedArticleSet`): no error, every PMID reported unavailable. Runs each
 * EFetch consumer against the real NcbiService behind a stubbed global fetch.
 * @module tests/mcp-server/tools/definitions/unknown-pmid-envelope.test
 */

import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { textBlocks } from '../../../_helpers.js';

vi.mock('@cyanheads/mcp-ts-core/utils', async () => {
  const actual = await vi.importActual<typeof import('@cyanheads/mcp-ts-core/utils')>(
    '@cyanheads/mcp-ts-core/utils',
  );
  return {
    ...actual,
    logger: { debug: vi.fn(), info: vi.fn(), notice: vi.fn(), warning: vi.fn(), error: vi.fn() },
    requestContextService: { createRequestContext: vi.fn(() => ({ requestId: 'test' })) },
  };
});

// Before the tool modules load: one of them reads the server config at import time.
vi.stubEnv('NCBI_API_KEY', '');
vi.stubEnv('NCBI_REQUEST_DELAY_MS', '50');

const { initNcbiService } = await import('@/services/ncbi/ncbi-service.js');
const { fetchArticlesTool } = await import('@/mcp-server/tools/definitions/fetch-articles.tool.js');
const { formatCitationsTool } = await import(
  '@/mcp-server/tools/definitions/format-citations.tool.js'
);
const { fetchFulltextTool } = await import('@/mcp-server/tools/definitions/fetch-fulltext.tool.js');

/** Syntactically valid, but no PubMed UID — NCBI rejects the whole list. */
const INVALID = '00000000';
/** Well-formed and unassigned — NCBI answers with an empty set. */
const UNKNOWN = '99999999';

/** NCBI's replies, verbatim apart from whitespace, for each ID above. */
const EFETCH_REPLIES: Record<string, { body: string; status: number }> = {
  [INVALID]: {
    status: 400,
    body: '<?xml version="1.0" encoding="UTF-8" ?>\n<!DOCTYPE eEfetchResult PUBLIC "-//NLM//DTD efetch 20131226//EN" "https://eutils.ncbi.nlm.nih.gov/eutils/dtd/20131226/efetch.dtd">\n<eFetchResult>\n\t<ERROR>ID list is empty! Possibly it has no correct IDs.</ERROR>\n</eFetchResult>\n',
  },
  [UNKNOWN]: {
    status: 200,
    body: '<?xml version="1.0" ?>\n<!DOCTYPE PubmedArticleSet PUBLIC "-//NLM//DTD PubMedArticle, 1st January 2025//EN" "https://dtd.nlm.nih.gov/ncbi/pubmed/out/pubmed_250101.dtd">\n<PubmedArticleSet></PubmedArticleSet>\n',
  },
};

let fetchSpy: ReturnType<typeof vi.spyOn>;

beforeAll(() => {
  fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
    const url = new URL(String(input));
    const id = url.searchParams.get('id') ?? url.searchParams.get('ids') ?? '';
    if (url.pathname.endsWith('/efetch.fcgi')) {
      const reply = EFETCH_REPLIES[id];
      if (!reply) throw new Error(`unexpected EFetch id ${id}`);
      return Promise.resolve(new Response(reply.body, { status: reply.status }));
    }
    if (url.pathname.includes('idconv')) {
      // The ID Converter's answer for an ID it cannot resolve: a record with no pmid.
      const records = id.split(',').map((requested) => ({
        'requested-id': requested,
        status: 'error',
        errmsg: 'invalid article id',
      }));
      return Promise.resolve(Response.json({ status: 'ok', records }));
    }
    throw new Error(`unexpected request ${url.pathname}`);
  });
  initNcbiService();
});

afterAll(() => {
  fetchSpy.mockRestore();
  vi.unstubAllEnvs();
});

/** EFetch requests the stub has seen for one ID. */
const efetchCallsFor = (id: string) =>
  fetchSpy.mock.calls.filter((args: unknown[]) => {
    const url = new URL(String(args[0]));
    return url.pathname.endsWith('/efetch.fcgi') && url.searchParams.get('id') === id;
  }).length;

describe('pubmed_fetch_articles with an all-invalid PMID list (issue #155)', () => {
  async function run(pmid: string) {
    const ctx = createMockContext({ errors: fetchArticlesTool.errors });
    const result = await fetchArticlesTool.handler(
      fetchArticlesTool.input.parse({ pmids: [pmid] }),
      ctx,
    );
    return { result, ctx };
  }

  it('reports the PMID unavailable instead of failing', async () => {
    const { result, ctx } = await run(INVALID);

    expect(fetchArticlesTool.output.parse(result)).toEqual({
      articles: [],
      totalReturned: 0,
      unavailablePmids: [INVALID],
    });
    expect(getEnrichment(ctx)?.notice).toMatch(/No articles were returned/);
    expect(efetchCallsFor(INVALID)).toBe(1);
  });

  it('reads the same as an unknown well-formed PMID on both surfaces', async () => {
    const invalid = await run(INVALID);
    const unknown = await run(UNKNOWN);

    expect(invalid.result).toEqual({ ...unknown.result, unavailablePmids: [INVALID] });
    expect(getEnrichment(invalid.ctx)).toEqual(getEnrichment(unknown.ctx));

    const text = textBlocks(fetchArticlesTool.format?.(invalid.result) ?? [])
      .map((block) => block.text)
      .join('\n');
    const unknownText = textBlocks(fetchArticlesTool.format?.(unknown.result) ?? [])
      .map((block) => block.text)
      .join('\n');
    expect(text).toContain('**Articles Returned:** 0');
    expect(text).toContain(`**Unavailable PMIDs:** ${INVALID}`);
    expect(text).toBe(unknownText.replaceAll(UNKNOWN, INVALID));
  });
});

describe('pubmed_format_citations with an all-invalid PMID list (issue #155)', () => {
  async function run(pmid: string) {
    const ctx = createMockContext({ errors: formatCitationsTool.errors });
    const result = await formatCitationsTool.handler(
      formatCitationsTool.input.parse({ pmids: [pmid] }),
      ctx,
    );
    return { result, ctx };
  }

  it('reports the PMID unavailable and reads the same as an unknown PMID', async () => {
    const invalid = await run(INVALID);
    const unknown = await run(UNKNOWN);

    expect(formatCitationsTool.output.parse(invalid.result)).toEqual({
      citations: [],
      totalSubmitted: 1,
      totalFormatted: 0,
      unavailablePmids: [INVALID],
    });
    expect(invalid.result).toEqual({ ...unknown.result, unavailablePmids: [INVALID] });
    expect(getEnrichment(invalid.ctx)).toEqual(getEnrichment(unknown.ctx));

    const text = textBlocks(formatCitationsTool.format?.(invalid.result) ?? [])
      .map((block) => block.text)
      .join('\n');
    expect(text).toContain(INVALID);
    expect(text).toBe(
      textBlocks(formatCitationsTool.format?.(unknown.result) ?? [])
        .map((block) => block.text)
        .join('\n')
        .replaceAll(UNKNOWN, INVALID),
    );
  });
});

describe('pubmed_fetch_fulltext PubMed DOI lookup with an all-invalid PMID (issue #155)', () => {
  async function unavailableEntry(pmid: string) {
    const ctx = createMockContext({ errors: fetchFulltextTool.errors });
    const result = await fetchFulltextTool.handler(
      fetchFulltextTool.input.parse({ pmids: [pmid] }),
      ctx,
    );
    return result.unavailable?.[0];
  }

  it('settles the lookup as no-doi, as for an unknown PMID, not doi-lookup-failed', async () => {
    const invalid = await unavailableEntry(INVALID);
    const unknown = await unavailableEntry(UNKNOWN);

    expect(invalid).toMatchObject({ id: INVALID, reason: 'no-doi' });
    expect(invalid?.triedTiers.at(-1)).toEqual({ tier: 'unpaywall', outcome: 'no-doi' });
    expect(invalid).toEqual({ ...unknown, id: INVALID });
  });
});
