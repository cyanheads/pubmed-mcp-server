/**
 * @fileoverview Tests for the server entry point.
 * @module tests/index.test
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const createApp = vi.fn(async (_config: Record<string, unknown>) => undefined);
const initNcbiService = vi.fn();
const initUnpaywallService = vi.fn();
const initEuropePmcService = vi.fn();
const initOpenAlexService = vi.fn();
const initIciteService = vi.fn();
const getServerConfig = vi.fn(() => ({ europepmcEnabled: true }));

const searchArticlesTool = { id: 'search-articles-tool' };
const fetchArticlesTool = { id: 'fetch-articles-tool' };
const fetchFulltextTool = { id: 'fetch-fulltext-tool' };
const formatCitationsTool = { id: 'format-citations-tool' };
const findRelatedTool = { id: 'find-related-tool' };
const spellCheckTool = { id: 'spell-check-tool' };
const lookupMeshTool = { id: 'lookup-mesh-tool' };
const lookupCitationTool = { id: 'lookup-citation-tool' };
const convertIdsTool = { id: 'convert-ids-tool' };
const fetchCitationMetricsTool = { id: 'fetch-citation-metrics-tool' };
const pubmedEuropepmcSearchTool = { id: 'pubmed-europepmc-search-tool' };
const pubmedEuropepmcFetchTool = { id: 'pubmed-europepmc-fetch-tool' };
const databaseInfoResource = { id: 'database-info-resource' };
const researchPlanPrompt = { id: 'research-plan-prompt' };

vi.mock('@cyanheads/mcp-ts-core', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    createApp,
  };
});

vi.mock('@/config/server-config.js', () => ({
  getServerConfig,
}));

vi.mock('@/services/ncbi/ncbi-service.js', () => ({
  initNcbiService,
}));

vi.mock('@/services/unpaywall/unpaywall-service.js', () => ({
  initUnpaywallService,
}));

vi.mock('@/services/europe-pmc/europe-pmc-service.js', () => ({
  initEuropePmcService,
}));

vi.mock('@/services/openalex/openalex-service.js', () => ({
  initOpenAlexService,
}));

vi.mock('@/services/icite/icite-service.js', () => ({
  initIciteService,
}));

vi.mock('@/mcp-server/prompts/definitions/research-plan.prompt.js', () => ({
  researchPlanPrompt,
}));

vi.mock('@/mcp-server/resources/definitions/database-info.resource.js', () => ({
  databaseInfoResource,
}));

vi.mock('@/mcp-server/tools/definitions/search-articles.tool.js', () => ({
  searchArticlesTool,
}));

vi.mock('@/mcp-server/tools/definitions/fetch-articles.tool.js', () => ({
  fetchArticlesTool,
}));

vi.mock('@/mcp-server/tools/definitions/fetch-fulltext.tool.js', () => ({
  fetchFulltextTool,
}));

vi.mock('@/mcp-server/tools/definitions/format-citations.tool.js', () => ({
  formatCitationsTool,
}));

vi.mock('@/mcp-server/tools/definitions/find-related.tool.js', () => ({
  findRelatedTool,
}));

vi.mock('@/mcp-server/tools/definitions/spell-check.tool.js', () => ({
  spellCheckTool,
}));

vi.mock('@/mcp-server/tools/definitions/lookup-mesh.tool.js', () => ({
  lookupMeshTool,
}));

vi.mock('@/mcp-server/tools/definitions/lookup-citation.tool.js', () => ({
  lookupCitationTool,
}));

vi.mock('@/mcp-server/tools/definitions/convert-ids.tool.js', () => ({
  convertIdsTool,
}));

vi.mock('@/mcp-server/tools/definitions/fetch-citation-metrics.tool.js', () => ({
  fetchCitationMetricsTool,
}));

vi.mock('@/mcp-server/tools/definitions/pubmed-europepmc-search.tool.js', () => ({
  pubmedEuropepmcSearchTool,
}));

vi.mock('@/mcp-server/tools/definitions/pubmed-europepmc-fetch.tool.js', () => ({
  pubmedEuropepmcFetchTool,
}));

async function loadModule() {
  await import('@/index.js');
}

describe('server entry point', () => {
  beforeEach(() => {
    getServerConfig.mockReturnValue({ europepmcEnabled: true });
  });

  afterEach(() => {
    createApp.mockClear();
    initNcbiService.mockClear();
    initUnpaywallService.mockClear();
    initEuropePmcService.mockClear();
    initOpenAlexService.mockClear();
    initIciteService.mockClear();
    getServerConfig.mockClear();
    vi.resetModules();
  });

  it('registers all tools, resources, and prompts with createApp (EPMC enabled)', async () => {
    await loadModule();

    expect(createApp).toHaveBeenCalledOnce();

    const appConfig = createApp.mock.calls[0]?.[0] as {
      tools: unknown[];
      resources: unknown[];
      prompts: unknown[];
      setup: () => void;
    };

    expect(appConfig.tools).toEqual([
      searchArticlesTool,
      fetchArticlesTool,
      fetchFulltextTool,
      formatCitationsTool,
      findRelatedTool,
      spellCheckTool,
      lookupMeshTool,
      lookupCitationTool,
      convertIdsTool,
      fetchCitationMetricsTool,
      pubmedEuropepmcSearchTool,
      pubmedEuropepmcFetchTool,
    ]);
    expect(appConfig.resources).toEqual([databaseInfoResource]);
    expect(appConfig.prompts).toEqual([researchPlanPrompt]);
    expect(appConfig.setup).toEqual(expect.any(Function));
  });

  it('omits both EPMC tools when EUROPEPMC_ENABLED is false', async () => {
    getServerConfig.mockReturnValue({ europepmcEnabled: false });
    await loadModule();
    const appConfig = createApp.mock.calls[0]?.[0] as { tools: unknown[] };
    expect(appConfig.tools).not.toContain(pubmedEuropepmcSearchTool);
    expect(appConfig.tools).not.toContain(pubmedEuropepmcFetchTool);
    expect(appConfig.tools).toContain(fetchCitationMetricsTool);
    expect(appConfig.tools).toHaveLength(10);
  });

  it('names the citation-metrics tool and credits NIH iCite in its instructions', async () => {
    await loadModule();

    const appConfig = createApp.mock.calls[0]?.[0] as { instructions: string };
    expect(appConfig.instructions).toContain(
      "For an article's citation influence, `pubmed_fetch_citation_metrics` returns its Relative Citation Ratio, NIH percentile, and citation counts (Source: NIH iCite, https://icite.od.nih.gov/).",
    );
  });

  it('names the `records` input shape where its instructions hand a Europe PMC hit to the fetch tool (#244)', async () => {
    await loadModule();

    const appConfig = createApp.mock.calls[0]?.[0] as { instructions: string };
    expect(appConfig.instructions).toContain(
      'then `pubmed_europepmc_fetch` with `records: [{ source, epmcId }]` copied from a hit',
    );
  });

  it('initializes every upstream service in the app setup hook', async () => {
    await loadModule();

    const appConfig = createApp.mock.calls[0]?.[0] as {
      setup: () => void;
    };

    appConfig.setup();

    expect(initNcbiService).toHaveBeenCalledOnce();
    expect(initUnpaywallService).toHaveBeenCalledOnce();
    expect(initEuropePmcService).toHaveBeenCalledOnce();
    expect(initOpenAlexService).toHaveBeenCalledOnce();
    expect(initIciteService).toHaveBeenCalledOnce();
  });
});
