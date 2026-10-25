/**
 * @fileoverview MeSH (Medical Subject Headings) vocabulary lookup tool.
 * Searches the NCBI MeSH database with offset pagination and optionally
 * retrieves detailed records. `limit`, `retmax`, and `pageSize` are accepted as
 * aliases for `maxResults`, `retstart` for `offset`, and `term` for `query`.
 * @module src/mcp-server/tools/definitions/lookup-mesh.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { NCBI_SERVICE_ERRORS, QUERY_INPUT_ERRORS } from '@/services/error-contracts.js';
import { getNcbiService } from '@/services/ncbi/ncbi-service.js';
import { ensureArray, getOptionalText, getText } from '@/services/ncbi/parsing/xml-helpers.js';
import type { ESummaryResult } from '@/services/ncbi/types.js';
import {
  conceptMeta,
  EDAM_DATA_RETRIEVAL,
  EDAM_ONTOLOGY_TERMINOLOGY,
  SCHEMA_DEFINED_TERM,
  SCHEMA_DEFINED_TERM_SET,
} from './_concepts.js';
import { escapeMarkdownInline, markdownCodeSpan } from './_text.js';
import { hasVisibleText } from './_visible-text.js';

// ─── MeSH eSummary parsing helpers ───────────────────────────────────────────

interface MeshRecord {
  entrezUid: string;
  entryTerms?: string[];
  meshId?: string;
  name: string;
  scopeNote?: string;
  treeNumbers?: string[];
}

/** A parsed `version=2.0` MeSH summary, with the record type the pin reads (#247). */
interface MeshSummary {
  record: MeshRecord;
  recordType: string | undefined;
}

/**
 * Records the exact-heading (`[MH]`) search reads to choose its pin. A heading
 * matches one record, or two for a drug class (its pharmacological-action record
 * and its descriptor); the rest is headroom.
 */
const EXACT_MATCH_CANDIDATES = 5;

/**
 * The record's tree numbers. Two `TreeNum` values are not tree positions: a
 * supplementary concept record's mapped-heading pointer (`@218176`, #76), and the
 * record's own UI, which is the only `TreeNum` a pharmacological-action record
 * carries (#247).
 */
function extractTreeNumbers(doc: Record<string, unknown>, meshId: string | undefined): string[] {
  const idxLinks = doc.DS_IdxLinks as Record<string, unknown> | undefined;
  return ensureArray(idxLinks?.LinksType as Record<string, unknown>[] | undefined)
    .map((link) => getText(link.TreeNum))
    .filter((treeNum) => treeNum && !treeNum.startsWith('@') && treeNum !== meshId);
}

/**
 * Index a `version=2.0` MeSH eSummary by Entrez UID. The canonical UI is read from
 * `DS_MeSHUI`, which every record type carries; the Entrez UID encodes no UI for
 * records added in recent MeSH years or for pharmacological-action records. A
 * `<DocumentSummary>` holding only an `<error>` (a UID with no record) yields no
 * `meshId`. (#238)
 */
function parseSummaryRecords(
  data: ESummaryResult | undefined,
  includeDetails: boolean,
): Map<string, MeshSummary> {
  const docs = ensureArray(
    data?.DocumentSummarySet?.DocumentSummary as Record<string, unknown>[] | undefined,
  );
  const summaries = new Map<string, MeshSummary>();
  for (const doc of docs) {
    const entrezUid = getText(doc['@_uid']);
    const meshId = getOptionalText(doc.DS_MeSHUI);
    const terms = doc.DS_MeshTerms as Record<string, unknown> | undefined;
    const entryTerms = ensureArray(terms?.string)
      .map((term) => getText(term))
      .filter(Boolean);
    const record: MeshRecord = {
      entrezUid,
      ...(meshId !== undefined && { meshId }),
      name: entryTerms[0] ?? entrezUid,
    };
    if (includeDetails) {
      const scopeNote = getOptionalText(doc.DS_ScopeNote);
      if (scopeNote) record.scopeNote = scopeNote;
      if (entryTerms.length > 0) record.entryTerms = entryTerms;
      const treeNumbers = extractTreeNumbers(doc, meshId);
      if (treeNumbers.length > 0) record.treeNumbers = treeNumbers;
    }
    summaries.set(entrezUid, { record, recordType: getOptionalText(doc.DS_RecordType) });
  }
  return summaries;
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

  errors: [...NCBI_SERVICE_ERRORS, ...QUERY_INPUT_ERRORS] as const,

  // Never advertised; rewritten to the canonical key before the schema parses.
  // ESearch's own names (`retmax`, `retstart`, `term`) and sibling tools' names. (#156, #190)
  inputAliases: {
    limit: 'maxResults',
    retmax: 'maxResults',
    pageSize: 'maxResults',
    retstart: 'offset',
    term: 'query',
  },

  input: z.object({
    query: z
      .string()
      .min(1)
      .describe(
        'MeSH descriptor name or free-text term to look up. Must carry a term: a value of only whitespace or invisible characters, such as a zero-width space, is rejected rather than searched.',
      ),
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
              .optional()
              .describe(
                'Canonical MeSH unique identifier (e.g. "D003924", "C000626284", "Q000009") — resolves at the MeSH Browser and NLM linked data. A pharmacological-action record carries its descriptor\'s UI. Omitted only when eSummary returned no record for this UID.',
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
                'Navigable MeSH tree numbers (e.g. "D02.078.370.141.450"). Omitted for supplementary concept records (SCRs), which map to a heading rather than occupying a tree position, and for pharmacological-action records, whose descriptor carries the tree positions.',
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

    // ESearch on db=mesh answers a blank term with Count=0 and a WarningList
    // rather than an error, so the empty-result branch would report "no MeSH
    // descriptors matched" for a term that was never really searched. Invisible
    // characters such as a zero-width space count as blank. (#133, #176)
    if (!hasVisibleText(query)) {
      throw ctx.fail('blank_query', 'The `query` is blank — there is no term to look up.');
    }

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
      : ncbi.eSearch(
          { db: 'mesh', term: `${query}[MH]`, retmax: EXACT_MATCH_CANDIDATES },
          callOpts,
        );
    const [broadResult, exactResult] = await Promise.all([broadSearch, exactSearch]);

    const totalCount = broadResult.count;
    const exactIds = exactResult?.idList ?? [];
    const fetchSummaries = (uids: string[]) =>
      ncbi
        .eSummary({ db: 'mesh', id: uids.join(','), version: '2.0' }, callOpts)
        .then((data) => parseSummaryRecords(data, includeDetails));
    // A drug-class heading matches its pharmacological-action record ahead of its
    // descriptor. When the heading matches more than one record and this page
    // leads with the pin or holds a candidate at its rank, read the record types
    // first — the page's own summaries ride the same request — and pin the first
    // that is not a pharmacological-action record. (#247)
    const pinShapesPage = offset === 0 || exactIds.some((id) => broadResult.idList.includes(id));
    const prefetched =
      exactIds.length > 1 && pinShapesPage
        ? await fetchSummaries([...new Set([...exactIds, ...broadResult.idList])])
        : undefined;
    const pinnedUid =
      exactIds.find((id) => prefetched?.get(id)?.recordType !== 'pharmacological-action') ??
      exactIds[0];
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

    // A notice renders as authored Markdown, so the caller's query in it is a
    // code span: it reads back exactly as sent, raw and rendered. (#263)
    const quoted = markdownCodeSpan(query);
    if (ids.length === 0) {
      ctx.enrich.total(totalCount);
      let notice: string;
      if (totalCount === 0) {
        notice = `No MeSH descriptors matched ${quoted}. Try \`pubmed_spell_check\` for a suggested correction, broaden the term, or use \`pubmed_search_articles\` for free-text discovery against article metadata.`;
      } else if (consumed > 0) {
        // The window held nothing but the pinned descriptor, already served at offset 0.
        notice = `Offset ${offset} held only the exact-descriptor match for ${quoted}, which was returned on the first page.${
          hasMore ? ` Continue with offset ${nextOffset}.` : ''
        }`;
      } else {
        notice = `Offset ${offset} returned no records — ${quoted} matches ${totalCount} MeSH descriptor(s). Reset offset to 0 or lower it below ${totalCount}.`;
      }
      ctx.enrich.notice(notice);
      return { query, offset, ...(hasMore && { nextOffset }), results: [] };
    }

    const summaries = prefetched ?? (await fetchSummaries(ids));
    const results = ids.map(
      (id): MeshRecord => summaries.get(id)?.record ?? { entrezUid: id, name: id },
    );

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
        `The exact-descriptor match filled this page of ${maxResults}. Raise maxResults to see the ${totalCount} ranked match(es) for ${quoted}.`,
      );
    }
    return { query, offset, ...(hasMore && { nextOffset }), results };
  },

  format: (result) => {
    const lines = [
      // The caller's query as sent, read exactly raw and rendered. (#255)
      `# MeSH Lookup: ${markdownCodeSpan(result.query)}`,
      `Found **${result.results.length}** result(s) at offset **${result.offset}**.`,
    ];
    if (result.nextOffset !== undefined) {
      lines.push(`More available — call again with \`offset: ${result.nextOffset}\`.`);
    }
    for (const r of result.results) {
      // NLM's descriptor name, scope note and entry terms are escaped at render
      // time; structuredContent keeps them as written. The entry terms share a
      // line, so they are escaped joined. (#255)
      lines.push(`\n## ${escapeMarkdownInline(r.name)}`);
      if (r.meshId) lines.push(`- **MeSH ID:** ${r.meshId}`);
      lines.push(`- **Entrez UID:** ${r.entrezUid}`);
      if (r.treeNumbers?.length) lines.push(`- **Tree Numbers:** ${r.treeNumbers.join(', ')}`);
      if (r.scopeNote) lines.push(`- **Scope Note:** ${escapeMarkdownInline(r.scopeNote)}`);
      if (r.entryTerms?.length) {
        lines.push(`- **Entry Terms:** ${escapeMarkdownInline(r.entryTerms.join('; '))}`);
      }
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
