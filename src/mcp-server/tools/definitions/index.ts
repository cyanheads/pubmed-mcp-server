/**
 * @fileoverview Barrel file for all tool definitions.
 * This file re-exports all tool definitions for easy import and registration.
 * It also exports an array of all definitions for automated registration.
 * @module src/mcp-server/tools/definitions
 */

import { pubmedCiteTool } from './pubmed-cite.tool.js';
import { pubmedFetchTool } from './pubmed-fetch.tool.js';
import { pubmedMeshLookupTool } from './pubmed-mesh-lookup.tool.js';
import { pubmedRelatedTool } from './pubmed-related.tool.js';
import { pubmedSearchTool } from './pubmed-search.tool.js';
import { pubmedSpellTool } from './pubmed-spell.tool.js';
import { pubmedTrendingTool } from './pubmed-trending.tool.js';

/**
 * An array containing all tool definitions for easy iteration.
 */
export const allToolDefinitions = [
  pubmedSearchTool,
  pubmedFetchTool,
  pubmedSpellTool,
  pubmedCiteTool,
  pubmedRelatedTool,
  pubmedTrendingTool,
  pubmedMeshLookupTool,
] as const;
