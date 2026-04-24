/**
 * @fileoverview MeSH (Medical Subject Headings) vocabulary lookup tool.
 * Searches the NCBI MeSH database and optionally retrieves detailed records.
 * @module src/mcp-server/tools/definitions/lookup-mesh.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { getNcbiService } from '@/services/ncbi/ncbi-service.js';
import { ensureArray, getText } from '@/services/ncbi/parsing/xml-helpers.js';
import {
  conceptMeta,
  EDAM_DATA_RETRIEVAL,
  EDAM_ONTOLOGY_TERMINOLOGY,
  SCHEMA_DEFINED_TERM,
  SCHEMA_DEFINED_TERM_SET,
} from './_concepts.js';

// ─── MeSH eSummary parsing helpers ───────────────────────────────────────────

interface MeshRecord {
  entryTerms?: string[];
  meshId: string;
  name: string;
  scopeNote?: string;
  treeNumbers?: string[];
}

function findItem(
  items: Record<string, unknown>[],
  name: string,
): Record<string, unknown> | undefined {
  return items.find((it) => getText(it['@_Name']) === name);
}

function getItemText(item: Record<string, unknown> | undefined): string {
  if (!item) return '';
  const direct = getText(item, '');
  if (direct) return direct;
  const subItems = ensureArray(item.Item) as Record<string, unknown>[];
  return subItems.length > 0 ? getText(subItems[0]) : '';
}

function getItemTexts(item: Record<string, unknown> | undefined): string[] {
  if (!item) return [];
  const subItems = ensureArray(item.Item) as Record<string, unknown>[];
  return subItems.map((si) => getText(si)).filter((s) => s.length > 0);
}

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

function parseSummaryRecords(data: unknown, ids: string[], includeDetails: boolean): MeshRecord[] {
  if (!data || typeof data !== 'object') return ids.map((id) => ({ meshId: id, name: id }));
  const root = data as Record<string, unknown>;
  const summaryResult = root.eSummaryResult as Record<string, unknown> | undefined;
  const docSums = ensureArray<Record<string, unknown>>(
    (summaryResult ?? root).DocSum as Record<string, unknown>,
  );
  if (docSums.length === 0) return ids.map((id) => ({ meshId: id, name: id }));

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

// ─── Tool Definition ─────────────────────────────────────────────────────────

export const lookupMeshTool = tool('pubmed_lookup_mesh', {
  description:
    'Search and explore MeSH (Medical Subject Headings) vocabulary. Essential for building precise PubMed queries.',
  annotations: { readOnlyHint: true, openWorldHint: true },
  _meta: conceptMeta([
    SCHEMA_DEFINED_TERM,
    SCHEMA_DEFINED_TERM_SET,
    EDAM_ONTOLOGY_TERMINOLOGY,
    EDAM_DATA_RETRIEVAL,
  ]),
  sourceUrl:
    'https://github.com/cyanheads/pubmed-mcp-server/blob/main/src/mcp-server/tools/definitions/lookup-mesh.tool.ts',

  input: z.object({
    term: z.string().min(1).describe('MeSH term to look up'),
    maxResults: z.number().int().min(1).max(50).default(10).describe('Maximum results'),
    includeDetails: z
      .boolean()
      .default(true)
      .describe('Fetch full MeSH records (scope notes, tree numbers, entry terms)'),
  }),

  output: z.object({
    term: z.string().describe('Original search term'),
    results: z
      .array(
        z
          .object({
            meshId: z.string().describe('MeSH descriptor unique identifier'),
            name: z.string().describe('Descriptor name'),
            treeNumbers: z.array(z.string()).optional().describe('MeSH tree numbers'),
            scopeNote: z.string().optional().describe('Scope note'),
            entryTerms: z.array(z.string()).optional().describe('Synonyms / entry terms'),
          })
          .describe('Matching MeSH descriptor record'),
      )
      .describe('Matching MeSH records'),
  }),

  async handler(input, ctx) {
    const { term, maxResults, includeDetails } = input;
    const ncbi = getNcbiService();
    ctx.log.debug('MeSH lookup started', { term, maxResults, includeDetails });

    const hasFieldTag = /\[.+\]/.test(term);
    const callOpts = { signal: ctx.signal };
    const broadSearch = ncbi.eSearch({ db: 'mesh', term, retmax: maxResults }, callOpts);
    const exactSearch = hasFieldTag
      ? undefined
      : ncbi.eSearch({ db: 'mesh', term: `${term}[MH]`, retmax: 1 }, callOpts);
    const [broadResult, exactResult] = await Promise.all([broadSearch, exactSearch]);

    const seen = new Set<string>();
    const ids: string[] = [];
    for (const id of [...(exactResult?.idList ?? []), ...broadResult.idList]) {
      if (!seen.has(id)) {
        seen.add(id);
        ids.push(id);
      }
    }
    ids.length = Math.min(ids.length, maxResults);

    if (ids.length === 0) return { term, results: [] };

    const summaryData = await ncbi.eSummary({ db: 'mesh', id: ids.join(',') }, callOpts);
    const results = parseSummaryRecords(summaryData, ids, includeDetails);

    const termLower = term.toLowerCase();
    results.sort((a, b) => {
      const aExact = a.name.toLowerCase() === termLower ? 0 : 1;
      const bExact = b.name.toLowerCase() === termLower ? 0 : 1;
      return aExact - bExact;
    });

    return { term, results };
  },

  format: (result) => {
    const lines = [
      `# MeSH Lookup: "${result.term}"`,
      `Found **${result.results.length}** result(s).`,
    ];
    for (const r of result.results) {
      lines.push(`\n## ${r.name}`);
      lines.push(`- **MeSH ID:** ${r.meshId}`);
      if (r.treeNumbers?.length) lines.push(`- **Tree Numbers:** ${r.treeNumbers.join(', ')}`);
      if (r.scopeNote) lines.push(`- **Scope Note:** ${r.scopeNote}`);
      if (r.entryTerms?.length) lines.push(`- **Entry Terms:** ${r.entryTerms.join('; ')}`);
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
