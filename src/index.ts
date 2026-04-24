#!/usr/bin/env node
/**
 * @fileoverview PubMed MCP server entry point.
 * @module index
 */

import { createApp } from '@cyanheads/mcp-ts-core';
import { researchPlanPrompt } from './mcp-server/prompts/definitions/research-plan.prompt.js';
import { databaseInfoResource } from './mcp-server/resources/definitions/database-info.resource.js';
import { convertIdsTool } from './mcp-server/tools/definitions/convert-ids.tool.js';
import { fetchArticlesTool } from './mcp-server/tools/definitions/fetch-articles.tool.js';
import { fetchFulltextTool } from './mcp-server/tools/definitions/fetch-fulltext.tool.js';
import { findRelatedTool } from './mcp-server/tools/definitions/find-related.tool.js';
import { formatCitationsTool } from './mcp-server/tools/definitions/format-citations.tool.js';
import { lookupCitationTool } from './mcp-server/tools/definitions/lookup-citation.tool.js';
import { lookupMeshTool } from './mcp-server/tools/definitions/lookup-mesh.tool.js';
import { searchArticlesTool } from './mcp-server/tools/definitions/search-articles.tool.js';
import { spellCheckTool } from './mcp-server/tools/definitions/spell-check.tool.js';
import { initNcbiService } from './services/ncbi/ncbi-service.js';
import { initUnpaywallService } from './services/unpaywall/unpaywall-service.js';

await createApp({
  tools: [
    searchArticlesTool,
    fetchArticlesTool,
    fetchFulltextTool,
    formatCitationsTool,
    findRelatedTool,
    spellCheckTool,
    lookupMeshTool,
    lookupCitationTool,
    convertIdsTool,
  ],
  resources: [databaseInfoResource],
  prompts: [researchPlanPrompt],
  landing: {
    tagline:
      'Search PubMed, fetch articles, generate citations, explore MeSH terms, and discover related research.',
    repoRoot: 'https://github.com/cyanheads/pubmed-mcp-server',
    links: [
      { label: 'PubMed', href: 'https://pubmed.ncbi.nlm.nih.gov/', external: true },
      {
        label: 'E-utilities docs',
        href: 'https://www.ncbi.nlm.nih.gov/books/NBK25501/',
        external: true,
      },
      {
        label: 'Get an NCBI API key',
        href: 'https://www.ncbi.nlm.nih.gov/account/settings/',
        external: true,
      },
      { label: 'MeSH Browser', href: 'https://meshb.nlm.nih.gov/', external: true },
    ],
    envExample: {
      NCBI_API_KEY: 'your-ncbi-api-key',
      NCBI_ADMIN_EMAIL: 'you@example.com',
      UNPAYWALL_EMAIL: 'you@example.com',
    },
  },
  setup() {
    initNcbiService();
    initUnpaywallService();
  },
});
