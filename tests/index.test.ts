/**
 * @fileoverview Tests for the server entry point.
 * @module tests/index.test
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

const createApp = vi.fn(async () => undefined);
const initNcbiService = vi.fn();

const searchArticlesTool = { id: 'search-articles-tool' };
const fetchArticlesTool = { id: 'fetch-articles-tool' };
const fetchFulltextTool = { id: 'fetch-fulltext-tool' };
const formatCitationsTool = { id: 'format-citations-tool' };
const findRelatedTool = { id: 'find-related-tool' };
const spellCheckTool = { id: 'spell-check-tool' };
const lookupMeshTool = { id: 'lookup-mesh-tool' };
const lookupCitationTool = { id: 'lookup-citation-tool' };
const convertIdsTool = { id: 'convert-ids-tool' };
const databaseInfoResource = { id: 'database-info-resource' };
const researchPlanPrompt = { id: 'research-plan-prompt' };

vi.mock('@cyanheads/mcp-ts-core', () => ({
  createApp,
}));

vi.mock('@/services/ncbi/ncbi-service.js', () => ({
  initNcbiService,
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

async function loadModule() {
  await import('@/index.js');
}

describe('server entry point', () => {
  afterEach(() => {
    createApp.mockClear();
    initNcbiService.mockClear();
    vi.resetModules();
  });

  it('registers all tools, resources, and prompts with createApp', async () => {
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
    ]);
    expect(appConfig.resources).toEqual([databaseInfoResource]);
    expect(appConfig.prompts).toEqual([researchPlanPrompt]);
    expect(appConfig.setup).toEqual(expect.any(Function));
  });

  it('initializes the NCBI service in the app setup hook', async () => {
    await loadModule();

    const appConfig = createApp.mock.calls[0]?.[0] as {
      setup: () => void;
    };

    appConfig.setup();

    expect(initNcbiService).toHaveBeenCalledOnce();
  });
});
