/**
 * @fileoverview MeSH (Medical Subject Headings) vocabulary lookup tool.
 * Searches the NCBI MeSH database with offset pagination and optionally
 * retrieves detailed records.
 * @module src/mcp-server/tools/definitions/lookup-mesh.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { NCBI_SERVICE_ERRORS } from '@/services/error-contracts.js';
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
  entrezUid: string;
  entryTerms?: string[];
  meshId: string;
  name: string;
  scopeNote?: string;
  treeNumbers?: string[];
}

/**
 * NCBI Entrez mesh UIDs encode the canonical MeSH DescriptorUI as the ASCII code of the
 * UI's letter prefix followed by its 6-digit number: D=68, C=67 (supplementary concept),
 * Q=81 (qualifier). So `68003924` → `D003924`. Modern supplementary-concept records receive
 * plain sequential UIDs that don't encode a UI (e.g. `2025952`); those aren't decodable, so
 * the raw Entrez UID is returned unchanged.
 */
const ENTREZ_UID_PREFIX: Record<string, string> = { '67': 'C', '68': 'D', '81': 'Q' };

function decodeMeshDescriptorUi(entrezUid: string): string {
  if (/^\d{8}$/.test(entrezUid)) {
    const letter = ENTREZ_UID_PREFIX[entrezUid.slice(0, 2)];
    if (letter) return `${letter}${entrezUid.slice(2)}`;
  }
  return entrezUid;
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
    // Supplementary Concept Records (SCRs) surface a non-navigable mapped-heading
    // pointer (e.g. "@218176") in the same TreeNum field. Drop it so treeNumbers
    // holds only real, navigable MeSH tree numbers. (#76)
    if (val && !val.startsWith('@')) treeNums.push(val);
  }
  return treeNums;
}

function parseSummaryRecords(data: unknown, ids: string[], includeDetails: boolean): MeshRecord[] {
  if (!data || typeof data !== 'object')
    return ids.map((id) => ({ entrezUid: id, meshId: decodeMeshDescriptorUi(id), name: id }));
  const root = data as Record<string, unknown>;
  const summaryResult = root.eSummaryResult as Record<string, unknown> | undefined;
  const docSums = ensureArray<Record<string, unknown>>(
    (summaryResult ?? root).DocSum as Record<string, unknown>,
  );
  if (docSums.length === 0)
    return ids.map((id) => ({ entrezUid: id, meshId: decodeMeshDescriptorUi(id), name: id }));

  return docSums.map((doc) => {
    const entrezUid = getText(doc.Id);
    const meshId = decodeMeshDescriptorUi(entrezUid);
    const items = ensureArray(doc.Item) as Record<string, unknown>[];
    const name = getItemText(findItem(items, 'DS_MeshTerms')) || meshId;
    const record: MeshRecord = { entrezUid, meshId, name };
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
    'Search and explore the MeSH (Medical Subject Headings) controlled vocabulary. Returns descriptor records with tree numbers, scope notes, and entry terms, plus pagination via offset for paging past the maxResults cap.',
  annotations: { readOnlyHint: true, openWorldHint: true },
  _meta: conceptMeta([
    SCHEMA_DEFINED_TERM,
    SCHEMA_DEFINED_TERM_SET,
    EDAM_ONTOLOGY_TERMINOLOGY,
    EDAM_DATA_RETRIEVAL,
  ]),
  sourceUrl:
    'https://github.com/cyanheads/pubmed-mcp-server/blob/main/src/mcp-server/tools/definitions/lookup-mesh.tool.ts',

  errors: [...NCBI_SERVICE_ERRORS] as const,

  input: z.object({
    query: z.string().min(1).describe('MeSH descriptor name or free-text term to look up'),
    maxResults: z.number().int().min(1).max(50).default(10).describe('Maximum results'),
    offset: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe(
        'Result offset for pagination (0-based). Pass the `nextOffset` from the previous response to get the following page; the exact-descriptor match is pinned to the first page only.',
      ),
    includeDetails: z
      .boolean()
      .default(true)
      .describe('Fetch full MeSH records (scope notes, tree numbers, entry terms)'),
  }),

  output: z.object({
    query: z.string().describe('Original search query'),
    offset: z.number().describe('Result offset this page was read from'),
    nextOffset: z
      .number()
      .optional()
      .describe(
        'Offset to request for the next page. Omitted when this is the last page, so its absence is the end-of-results signal.',
      ),
    results: z
      .array(
        z
          .object({
            meshId: z
              .string()
              .describe(
                'Canonical MeSH DescriptorUI (e.g. "D003924") — resolves at the MeSH Browser and NLM linked data. Falls back to the raw Entrez UID when a record is not decodable.',
              ),
            entrezUid: z
              .string()
              .describe(
                'NCBI Entrez UID for this record — the join key for E-utilities (eSummary/eFetch db=mesh).',
              ),
            name: z.string().describe('Descriptor name'),
            treeNumbers: z
              .array(z.string())
              .optional()
              .describe(
                'Navigable MeSH tree numbers (e.g. "D02.078.370.141.450"). Omitted for supplementary concept records (SCRs), which map to a heading rather than occupying a tree position.',
              ),
            scopeNote: z.string().optional().describe('Scope note'),
            entryTerms: z.array(z.string()).optional().describe('Synonyms / entry terms'),
          })
          .describe('Matching MeSH descriptor record'),
      )
      .describe('Matching MeSH records'),
  }),

  // Result-set context — the upstream match count for disclosure against the maxResults
  // cap, and recovery guidance when no descriptor matched or the offset overshot.
  // Surfaced via ctx.enrich(...) to structuredContent and content[] alike.
  enrichment: {
    totalCount: z
      .number()
      .describe('Total MeSH descriptors matching the query upstream, before the maxResults cap'),
    notice: z
      .string()
      .optional()
      .describe(
        'Optional guidance when no descriptors matched or the offset overshot the result set — suggests spell-check, free-text search, or resetting the offset. Absent on successful result pages.',
      ),
  },

  async handler(input, ctx) {
    const { query, maxResults, offset, includeDetails } = input;
    const ncbi = getNcbiService();
    ctx.log.debug('MeSH lookup started', { query, maxResults, offset, includeDetails });

    const hasFieldTag = /\[.+\]/.test(query);
    const callOpts = { signal: ctx.signal };
    const broadSearch = ncbi.eSearch(
      { db: 'mesh', term: query, retmax: maxResults, retstart: offset },
      callOpts,
    );
    // The exact-descriptor match is resolved on every page, not just the first: it is
    // normally a member of the ranked list too, so every page has to know which UID to
    // hold back. The first page leads with it; later pages skip it where it ranks.
    const exactSearch = hasFieldTag
      ? undefined
      : ncbi.eSearch({ db: 'mesh', term: `${query}[MH]`, retmax: 1 }, callOpts);
    const [broadResult, exactResult] = await Promise.all([broadSearch, exactSearch]);

    const totalCount = broadResult.count;
    const pinnedUid = exactResult?.idList[0];
    const ids: string[] = [];
    if (pinnedUid !== undefined && offset === 0) ids.push(pinnedUid);
    // Count the ranked records this page consumed rather than assuming maxResults:
    // a pinned exact match outside the ranked window displaces one, and the next
    // offset has to resume exactly where this page stopped or that record is lost.
    let consumed = 0;
    for (const id of broadResult.idList) {
      // The pinned descriptor is served once, on the first page. Count its rank slot
      // as consumed wherever it lands so no later page hands it back a second time.
      if (id === pinnedUid) {
        consumed++;
        continue;
      }
      if (ids.length >= maxResults) break;
      consumed++;
      ids.push(id);
    }

    const nextOffset = offset + consumed;
    const hasMore = consumed > 0 && nextOffset < totalCount;

    if (ids.length === 0) {
      ctx.enrich.total(totalCount);
      let notice: string;
      if (totalCount === 0) {
        notice = `No MeSH descriptors matched "${query}". Try \`pubmed_spell_check\` for a suggested correction, broaden the term, or use \`pubmed_search_articles\` for free-text discovery against article metadata.`;
      } else if (consumed > 0) {
        // The window held nothing but the pinned descriptor, already served at offset 0.
        notice = `Offset ${offset} held only the exact-descriptor match for "${query}", which was returned on the first page.${
          hasMore ? ` Continue with offset ${nextOffset}.` : ''
        }`;
      } else {
        notice = `Offset ${offset} returned no records — "${query}" matches ${totalCount} MeSH descriptor(s). Reset offset to 0 or lower it below ${totalCount}.`;
      }
      ctx.enrich.notice(notice);
      return { query, offset, ...(hasMore && { nextOffset }), results: [] };
    }

    const summaryData = await ncbi.eSummary({ db: 'mesh', id: ids.join(',') }, callOpts);
    const results = parseSummaryRecords(summaryData, ids, includeDetails);

    const queryLower = query.toLowerCase();
    results.sort((a, b) => {
      const aExact = a.name.toLowerCase() === queryLower ? 0 : 1;
      const bExact = b.name.toLowerCase() === queryLower ? 0 : 1;
      return aExact - bExact;
    });

    ctx.enrich.total(totalCount);
    // A page filled entirely by the pinned exact match consumed no ranked record,
    // so there is no offset that advances — say so instead of emitting one that
    // would replay this page.
    if (consumed === 0 && totalCount > 0) {
      ctx.enrich.notice(
        `The exact-descriptor match filled this page of ${maxResults}. Raise maxResults to see the ${totalCount} ranked match(es) for "${query}".`,
      );
    }
    return { query, offset, ...(hasMore && { nextOffset }), results };
  },

  format: (result) => {
    const lines = [
      `# MeSH Lookup: "${result.query}"`,
      `Found **${result.results.length}** result(s) at offset **${result.offset}**.`,
    ];
    if (result.nextOffset !== undefined) {
      lines.push(`More available — call again with \`offset: ${result.nextOffset}\`.`);
    }
    for (const r of result.results) {
      lines.push(`\n## ${r.name}`);
      lines.push(`- **MeSH ID:** ${r.meshId}`);
      lines.push(`- **Entrez UID:** ${r.entrezUid}`);
      if (r.treeNumbers?.length) lines.push(`- **Tree Numbers:** ${r.treeNumbers.join(', ')}`);
      if (r.scopeNote) lines.push(`- **Scope Note:** ${r.scopeNote}`);
      if (r.entryTerms?.length) lines.push(`- **Entry Terms:** ${r.entryTerms.join('; ')}`);
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
