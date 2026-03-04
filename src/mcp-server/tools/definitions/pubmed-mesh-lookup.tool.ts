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
    .default(false)
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
// MeSH XML parsing (inline — structure is simple enough)
// ---------------------------------------------------------------------------

interface MeshRecord {
  entryTerms?: string[];
  meshId: string;
  name: string;
  scopeNote?: string;
  treeNumbers?: string[];
}

/**
 * Parses MeSH DescriptorRecord elements from eFetch XML response.
 * The fast-xml-parser output has DescriptorRecordSet.DescriptorRecord which
 * may be a single object or an array.
 */
function parseMeshRecords(data: unknown): MeshRecord[] {
  if (!data || typeof data !== 'object') return [];
  const root = data as Record<string, unknown>;

  const recordSet = root.DescriptorRecordSet as Record<string, unknown> | undefined;
  const rawRecords = recordSet
    ? ensureArray<Record<string, unknown>>(recordSet.DescriptorRecord as Record<string, unknown>)
    : ensureArray<Record<string, unknown>>(root.DescriptorRecord as Record<string, unknown>);

  return rawRecords.map((rec) => {
    const descriptorName = rec.DescriptorName as Record<string, unknown> | undefined;
    const name = descriptorName ? getText(descriptorName.String) : '';
    const meshId = getText(rec.DescriptorUI);

    // Tree numbers
    const treeList = rec.TreeNumberList as Record<string, unknown> | undefined;
    const treeNumbers = treeList
      ? ensureArray(treeList.TreeNumber).map((t) => getText(t))
      : undefined;

    // Scope note and entry terms from first Concept
    const concepts = ensureArray(
      (rec.ConceptList as Record<string, unknown> | undefined)?.Concept,
    ) as Record<string, unknown>[];

    let scopeNote: string | undefined;
    let entryTerms: string[] | undefined;

    if (concepts.length > 0) {
      const firstConcept = concepts[0] as Record<string, unknown>;
      const rawNote = getText(firstConcept.ScopeNote, '');
      if (rawNote) scopeNote = rawNote;

      const termList = firstConcept.TermList as Record<string, unknown> | undefined;
      if (termList) {
        const terms = ensureArray(termList.Term) as Record<string, unknown>[];
        const names = terms.map((t) => getText(t.String)).filter((s) => s.length > 0);
        if (names.length > 0) entryTerms = names;
      }
    }

    const record: MeshRecord = { meshId, name };
    if (treeNumbers && treeNumbers.length > 0) record.treeNumbers = treeNumbers;
    if (scopeNote) record.scopeNote = scopeNote;
    if (entryTerms && entryTerms.length > 0) record.entryTerms = entryTerms;
    return record;
  });
}

/**
 * Parses eSummary DocSum elements for basic MeSH info.
 */
function parseSummaryRecords(data: unknown, ids: string[]): MeshRecord[] {
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
    const nameItem = items.find((it) => getText(it['@_Name']) === 'DS_MeshTerms');
    const name = nameItem ? getText(nameItem) : meshId;
    return { meshId, name };
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

  // Step 1: Search MeSH database for matching IDs
  const searchResult = await ncbi().eSearch({ db: 'mesh', term, retmax: maxResults }, context);

  const ids = searchResult.idList;

  if (ids.length === 0) {
    logger.debug('No MeSH results found.', { ...context, term });
    return { term, results: [] };
  }

  // Step 2: Fetch details or summaries
  let results: MeshRecord[];

  if (includeDetails) {
    const fetchData = await ncbi().eFetch(
      { db: 'mesh', id: ids.join(','), rettype: 'full', retmode: 'xml' },
      context,
    );
    results = parseMeshRecords(fetchData);
  } else {
    const summaryData = await ncbi().eSummary({ db: 'mesh', id: ids.join(',') }, context);
    results = parseSummaryRecords(summaryData, ids);
  }

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
