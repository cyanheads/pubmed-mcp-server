#!/usr/bin/env node
/**
 * @fileoverview PubMed MCP server entry point.
 * @module index
 */

import { createApp } from '@cyanheads/mcp-ts-core';
import { researchPlanPrompt } from './mcp-server/prompts/definitions/research-plan.prompt.js';
import { databaseInfoResource } from './mcp-server/resources/definitions/database-info.resource.js';
import { fetchArticlesTool } from './mcp-server/tools/definitions/fetch-articles.tool.js';
import { fetchFulltextTool } from './mcp-server/tools/definitions/fetch-fulltext.tool.js';
import { findRelatedTool } from './mcp-server/tools/definitions/find-related.tool.js';
import { formatCitationsTool } from './mcp-server/tools/definitions/format-citations.tool.js';
import { lookupMeshTool } from './mcp-server/tools/definitions/lookup-mesh.tool.js';
import { searchArticlesTool } from './mcp-server/tools/definitions/search-articles.tool.js';
import { spellCheckTool } from './mcp-server/tools/definitions/spell-check.tool.js';
import { initNcbiService } from './services/ncbi/ncbi-service.js';

await createApp({
  tools: [
    searchArticlesTool,
    fetchArticlesTool,
    fetchFulltextTool,
    formatCitationsTool,
    findRelatedTool,
    spellCheckTool,
    lookupMeshTool,
  ],
  resources: [databaseInfoResource],
  prompts: [researchPlanPrompt],
  setup() {
    initNcbiService();
  },
});
