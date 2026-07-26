#!/usr/bin/env node
/**
 * @fileoverview PubMed MCP server entry point.
 * @module index
 */

import { createApp } from '@cyanheads/mcp-ts-core';
import { getServerConfig } from './config/server-config.js';
import { researchPlanPrompt } from './mcp-server/prompts/definitions/research-plan.prompt.js';
import { databaseInfoResource } from './mcp-server/resources/definitions/database-info.resource.js';
import { convertIdsTool } from './mcp-server/tools/definitions/convert-ids.tool.js';
import { fetchArticlesTool } from './mcp-server/tools/definitions/fetch-articles.tool.js';
import { fetchFulltextTool } from './mcp-server/tools/definitions/fetch-fulltext.tool.js';
import { findRelatedTool } from './mcp-server/tools/definitions/find-related.tool.js';
import { formatCitationsTool } from './mcp-server/tools/definitions/format-citations.tool.js';
import { lookupCitationTool } from './mcp-server/tools/definitions/lookup-citation.tool.js';
import { lookupMeshTool } from './mcp-server/tools/definitions/lookup-mesh.tool.js';
import { pubmedEuropepmcFetchTool } from './mcp-server/tools/definitions/pubmed-europepmc-fetch.tool.js';
import { pubmedEuropepmcSearchTool } from './mcp-server/tools/definitions/pubmed-europepmc-search.tool.js';
import { searchArticlesTool } from './mcp-server/tools/definitions/search-articles.tool.js';
import { spellCheckTool } from './mcp-server/tools/definitions/spell-check.tool.js';
import { initEuropePmcService } from './services/europe-pmc/europe-pmc-service.js';
import { initNcbiService } from './services/ncbi/ncbi-service.js';
import { initOpenAlexService } from './services/openalex/openalex-service.js';
import { initUnpaywallService } from './services/unpaywall/unpaywall-service.js';

const config = getServerConfig();
const tools = [
  searchArticlesTool,
  fetchArticlesTool,
  fetchFulltextTool,
  formatCitationsTool,
  findRelatedTool,
  spellCheckTool,
  lookupMeshTool,
  lookupCitationTool,
  convertIdsTool,
  ...(config.europepmcEnabled ? [pubmedEuropepmcSearchTool, pubmedEuropepmcFetchTool] : []),
];

await createApp({
  name: 'pubmed-mcp-server',
  title: 'pubmed-mcp-server',
  tools,
  resources: [databaseInfoResource],
  prompts: [researchPlanPrompt],
  instructions:
    "Use the pubmed_* tools to search PubMed and PubMed Central, fetch article metadata and full text, format citations, and find related articles via NCBI's E-utilities. Articles are keyed by PMID (integer); PMC full text by PMCID (`PMC` prefix); most also carry a DOI. Typical flow: `pubmed_search_articles` → `pubmed_fetch_articles` → `pubmed_fetch_fulltext`. When PubMed itself comes up empty (preprints, EPMC-only OA), broaden via `pubmed_europepmc_search`, then `pubmed_europepmc_fetch` with a hit's `source` + `epmcId` for its complete abstract. Prefer deterministic resolvers when inputs are structured: `pubmed_lookup_citation` for partial references, `pubmed_convert_ids` to crosswalk IDs. Refine queries with `pubmed_lookup_mesh` and `pubmed_spell_check`.",
  landing: {
    requireAuth: false,
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
    initEuropePmcService();
    initOpenAlexService();
  },
});
