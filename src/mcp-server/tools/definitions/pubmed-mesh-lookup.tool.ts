/**
 * @fileoverview MeSH (Medical Subject Headings) vocabulary lookup tool.
 * Searches the NCBI MeSH database and optionally retrieves detailed records
 * including scope notes, tree numbers, and entry terms.
 * @module src/mcp-server/tools/definitions/pubmed-mesh-lookup.tool
 */

import type { ContentBlock } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

import { container } from '@/container/core/container.js';
import { NcbiServiceToken } from '@/container/core/tokens.js';
import type { SdkContext, ToolDefinition } from '@/mcp-server/tools/utils/toolDefinition.js';
import { withToolAuth } from '@/mcp-server/transports/auth/lib/withAuth.js';
import { ensureArray, getText } from '@/services/ncbi/parsing/xml-helpers.js';
import { markdown } from '@/utils/formatting/markdownBuilder.js';
import { logger } from '@/utils/internal/logger.js';
import type { RequestContext } from '@/utils/internal/requestContext.js';

const ncbi = () => container.resolve(NcbiServiceToken);

// ---------------------------------------------------------------------------
// Metadata
// ---------------------------------------------------------------------------

const TOOL_NAME = 'pubmed_mesh_lookup';
const TOOL_TITLE = 'MeSH Term Lookup';
const TOOL_DESCRIPTION =
  'Search and explore MeSH (Medical Subject Headings) vocabulary. Essential for building precise PubMed queries.';
const TOOL_ANNOTATIONS = {
  readOnlyHint: true,
  idempotentHint: true,
  openWorldHint: true,
} as const;

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const InputSchema = z.object({
  term: z.string().min(1).describe('MeSH term to look up'),
  maxResults: z.number().int().min(1).max(50).default(10).describe('Maximum results'),
  includeDetails: z
    .boolean()
    .default(true)
    .describe('Fetch full MeSH records (scope notes, tree numbers, entry terms)'),
});

const MeshResultItem = z.object({
  meshId: z.string().describe('MeSH descriptor unique identifier'),
  name: z.string().describe('Descriptor name'),
  treeNumbers: z.array(z.string()).optional().describe('MeSH tree number(s)'),
  scopeNote: z.string().optional().describe('Scope note describing the descriptor'),
  entryTerms: z.array(z.string()).optional().describe('Synonyms / entry terms'),
});

const OutputSchema = z.object({
  term: z.string().describe('Original search term'),
  results: z.array(MeshResultItem).describe('Matching MeSH records'),
});

type Input = z.infer<typeof InputSchema>;
type Output = z.infer<typeof OutputSchema>;

// ---------------------------------------------------------------------------
// MeSH eSummary parsing
// ---------------------------------------------------------------------------

interface MeshRecord {
  entryTerms?: string[];
  meshId: string;
  name: string;
  scopeNote?: string;
  treeNumbers?: string[];
}

/** Finds an eSummary Item by its @_Name attribute. */
function findItem(
  items: Record<string, unknown>[],
  name: string,
): Record<string, unknown> | undefined {
  return items.find((it) => getText(it['@_Name']) === name);
}

/**
 * Extracts the text value from an eSummary Item, handling both simple String
 * items (#text) and List items (nested sub-Item children).
 */
function getItemText(item: Record<string, unknown> | undefined): string {
  if (!item) return '';
  const direct = getText(item, '');
  if (direct) return direct;
  // List-type: take the first nested sub-Item
  const subItems = ensureArray(item.Item) as Record<string, unknown>[];
  return subItems.length > 0 ? getText(subItems[0]) : '';
}

/**
 * Extracts all text values from a List-type eSummary Item's sub-Items.
 */
function getItemTexts(item: Record<string, unknown> | undefined): string[] {
  if (!item) return [];
  const subItems = ensureArray(item.Item) as Record<string, unknown>[];
  return subItems.map((si) => getText(si)).filter((s) => s.length > 0);
}

/**
 * Extracts tree numbers from DS_IdxLinks, which contains nested Structure
 * items each with a TreeNum sub-item.
 */
function extractTreeNumbers(items: Record<string, unknown>[]): string[] {
  const idxLinks = findItem(items, 'DS_IdxLinks');
  if (!idxLinks) return [];
  const linkStructures = ensureArray(idxLinks.Item) as Record<string, unknown>[];
  const treeNums: string[] = [];
  for (const struct of linkStructures) {
    const structItems = ensureArray(struct.Item) as Record<string, unknown>[];
    const treeItem = findItem(structItems, 'TreeNum');
    const val = treeItem ? getText(treeItem) : '';
    if (val) treeNums.push(val);
  }
  return treeNums;
}

/**
 * Parses eSummary DocSum elements into MeshRecords.
 * Used for both basic and detailed lookups — MeSH eFetch doesn't return XML,
 * so eSummary is the only structured data source.
 */
function parseSummaryRecords(data: unknown, ids: string[], includeDetails: boolean): MeshRecord[] {
  if (!data || typeof data !== 'object') {
    return ids.map((id) => ({ meshId: id, name: id }));
  }

  const root = data as Record<string, unknown>;
  const summaryResult = root.eSummaryResult as Record<string, unknown> | undefined;
  const docSums = ensureArray<Record<string, unknown>>(
    (summaryResult ?? root).DocSum as Record<string, unknown>,
  );

  if (docSums.length === 0) {
    return ids.map((id) => ({ meshId: id, name: id }));
  }

  return docSums.map((doc) => {
    const meshId = getText(doc.Id);
    const items = ensureArray(doc.Item) as Record<string, unknown>[];
    const name = getItemText(findItem(items, 'DS_MeshTerms')) || meshId;

    const record: MeshRecord = { meshId, name };

    if (includeDetails) {
      const scopeNote = getItemText(findItem(items, 'DS_ScopeNote'));
      if (scopeNote) record.scopeNote = scopeNote;

      const entryTerms = getItemTexts(findItem(items, 'DS_MeshTerms'));
      if (entryTerms.length > 0) record.entryTerms = entryTerms;

      const treeNumbers = extractTreeNumbers(items);
      if (treeNumbers.length > 0) record.treeNumbers = treeNumbers;
    }

    return record;
  });
}

// ---------------------------------------------------------------------------
// Logic
// ---------------------------------------------------------------------------

async function meshLookupLogic(
  input: Input,
  context: RequestContext,
  _sdkContext: SdkContext,
): Promise<Output> {
  const { term, maxResults, includeDetails } = input;

  logger.debug('MeSH lookup started.', { ...context, term, maxResults, includeDetails });

  // Step 1: Search MeSH database for matching IDs.
  // NCBI's bare-term eSearch often returns subtree terms instead of the exact heading
  // (e.g. "Triple Negative Breast Neoplasms" instead of "Neoplasms"). When the term
  // doesn't already contain field tags, run a parallel [MH] exact-heading search and
  // merge those IDs first so the exact descriptor always appears in the results.
  const hasFieldTag = /\[.+\]/.test(term);
  const broadSearch = ncbi().eSearch({ db: 'mesh', term, retmax: maxResults }, context);
  const exactSearch = hasFieldTag
    ? undefined
    : ncbi().eSearch({ db: 'mesh', term: `${term}[MH]`, retmax: 1 }, context);
  const [broadResult, exactResult] = await Promise.all([broadSearch, exactSearch]);

  // Merge: exact-match IDs first, then broad IDs (deduplicated), capped at maxResults
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const id of [...(exactResult?.idList ?? []), ...broadResult.idList]) {
    if (!seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  }
  ids.length = Math.min(ids.length, maxResults);

  if (ids.length === 0) {
    logger.debug('No MeSH results found.', { ...context, term });
    return { term, results: [] };
  }

  // Step 2: Fetch summaries (eSummary is the only structured source — MeSH eFetch returns plain text)
  const summaryData = await ncbi().eSummary({ db: 'mesh', id: ids.join(',') }, context);
  const results = parseSummaryRecords(summaryData, ids, includeDetails);

  // Step 3: Stable-sort exact name matches to the top (belt-and-suspenders with the
  // ID-level ordering above, since eSummary may return results in a different order).
  const termLower = term.toLowerCase();
  results.sort((a, b) => {
    const aExact = a.name.toLowerCase() === termLower ? 0 : 1;
    const bExact = b.name.toLowerCase() === termLower ? 0 : 1;
    return aExact - bExact;
  });

  logger.debug('MeSH lookup completed.', { ...context, term, resultCount: results.length });

  return { term, results };
}

// ---------------------------------------------------------------------------
// Response Formatter
// ---------------------------------------------------------------------------

function formatResponse(result: Output): ContentBlock[] {
  const md = markdown();
  md.text(`# MeSH Lookup: "${result.term}"\n\n`);

  if (result.results.length === 0) {
    md.text('No matching MeSH terms found.\n');
    return [{ type: 'text', text: md.build() }];
  }

  md.text(`Found **${result.results.length}** result(s).\n\n`);

  for (const r of result.results) {
    md.text(`## ${r.name}\n`);
    md.text(`- **MeSH ID:** ${r.meshId}\n`);
    if (r.treeNumbers && r.treeNumbers.length > 0) {
      md.text(`- **Tree Numbers:** ${r.treeNumbers.join(', ')}\n`);
    }
    if (r.scopeNote) {
      md.text(`- **Scope Note:** ${r.scopeNote}\n`);
    }
    if (r.entryTerms && r.entryTerms.length > 0) {
      md.text(`- **Entry Terms:** ${r.entryTerms.join('; ')}\n`);
    }
    md.text('\n');
  }

  return [{ type: 'text', text: md.build() }];
}

// ---------------------------------------------------------------------------
// Definition
// ---------------------------------------------------------------------------

export const pubmedMeshLookupTool: ToolDefinition<typeof InputSchema, typeof OutputSchema> = {
  name: TOOL_NAME,
  title: TOOL_TITLE,
  description: TOOL_DESCRIPTION,
  annotations: TOOL_ANNOTATIONS,
  inputSchema: InputSchema,
  outputSchema: OutputSchema,
  logic: withToolAuth(['tool:pubmed_mesh_lookup:read'], meshLookupLogic),
  responseFormatter: formatResponse,
};
