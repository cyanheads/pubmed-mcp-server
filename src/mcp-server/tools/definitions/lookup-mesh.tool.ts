/**
 * @fileoverview MeSH (Medical Subject Headings) vocabulary lookup tool.
 * Searches the NCBI MeSH database with offset pagination and optionally
 * retrieves detailed records; every record carries its MeSH record type and the
 * PubMed clause that searches it. `limit`, `retmax`, and `pageSize` are accepted as
 * aliases for `maxResults`, `retstart` for `offset`, and `term` for `query`. A
 * `maxResults` past the per-call cap is served at the cap with a notice.
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
import { pageSizeCeiling, pageSizeClampNotice } from './_page-size.js';
import { escapeMarkdownInline, markdownCodeSpan } from './_text.js';
import { hasVisibleText } from './_visible-text.js';

// ─── MeSH eSummary parsing helpers ───────────────────────────────────────────

interface MeshRecord {
  entrezUid: string;
  entryTerms?: string[];
  meshId?: string;
  name: string;
  previousIndexing?: string[];
  recordType?: string;
  scopeNote?: string;
  searchTerm?: string;
  subheadings?: string[];
  treeNumbers?: string[];
  yearIntroduced?: string;
}

/**
 * A parsed `version=2.0` MeSH summary. The allowable subheadings are held beside
 * the record rather than on it: only the pinned heading match carries them. (#296)
 */
interface MeshSummary {
  record: MeshRecord;
  subheadings: string[];
}

/**
 * Records the exact-heading (`[MH]`) search reads to choose its pin. A heading
 * usually matches one record; a drug class matches two (its pharmacological-action
 * record and its descriptor), as do a heading named like a qualifier and a name
 * NCBI translates to another heading. The rest is headroom.
 */
const EXACT_MATCH_CANDIDATES = 5;

/** Records one call returns; a larger `maxResults` is served at this size. (#232) */
const MAX_RESULTS_CAP = 50;

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
 * The `<string>` entries of a summary list element such as `DS_Subheading`; an
 * empty element yields none.
 */
function stringList(element: unknown): string[] {
  return ensureArray((element as Record<string, unknown> | undefined)?.string)
    .map((entry) => getText(entry))
    .filter(Boolean);
}

/**
 * The PubMed field tag that searches a record of this type. A supplementary
 * concept matches nothing as `[mh]`, and neither does a publication type — a
 * descriptor in the `V` tree. An unrecognized type gets no tag. (#294)
 */
function searchTagFor(
  recordType: string | undefined,
  treeNumbers: readonly string[],
): string | undefined {
  switch (recordType) {
    case 'descriptor':
      return treeNumbers.some((treeNum) => treeNum.startsWith('V')) ? 'pt' : 'mh';
    case 'supplemental-record':
      return 'nm';
    case 'pharmacological-action':
      return 'pa';
    case 'qualifier':
      return 'sh';
    default:
      return undefined;
  }
}

/**
 * Index a `version=2.0` MeSH eSummary by Entrez UID. The canonical UI is read from
 * `DS_MeSHUI`, which every record type carries; the Entrez UID encodes no UI for
 * records added in recent MeSH years or for pharmacological-action records. A
 * `<DocumentSummary>` holding only an `<error>` (a UID with no record) yields no
 * `meshId`. (#238)
 *
 * The record type and the search clause derived from it are read whatever
 * `includeDetails` says, so the tree numbers are too, for the publication-type
 * check; only the details reach the record. (#282, #294)
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
    const entryTerms = stringList(doc.DS_MeshTerms);
    const heading = entryTerms[0];
    const recordType = getOptionalText(doc.DS_RecordType);
    const treeNumbers = extractTreeNumbers(doc, meshId);
    const searchTag = searchTagFor(recordType, treeNumbers);
    const searchTerm =
      heading !== undefined && searchTag !== undefined ? `"${heading}"[${searchTag}]` : undefined;
    const record: MeshRecord = {
      entrezUid,
      ...(meshId !== undefined && { meshId }),
      name: heading ?? entrezUid,
      ...(recordType !== undefined && { recordType }),
      ...(searchTerm !== undefined && { searchTerm }),
    };
    if (includeDetails) {
      const scopeNote = getOptionalText(doc.DS_ScopeNote);
      if (scopeNote) record.scopeNote = scopeNote;
      if (entryTerms.length > 0) record.entryTerms = entryTerms;
      if (treeNumbers.length > 0) record.treeNumbers = treeNumbers;
      const yearIntroduced = getOptionalText(doc.DS_YearIntroduced);
      if (yearIntroduced) record.yearIntroduced = yearIntroduced;
      const previousIndexing = stringList(doc.DS_PreviousIndexing);
      if (previousIndexing.length > 0) record.previousIndexing = previousIndexing;
    }
    summaries.set(entrezUid, {
      record,
      subheadings: includeDetails ? stringList(doc.DS_Subheading) : [],
    });
  }
  return summaries;
}

/**
 * The exact-match candidate to pin: the record the query names (`queryName`,
 * lowercased), a descriptor before a qualifier or pharmacological-action record of
 * that name; else the first descriptor, the heading an entry term maps to; else the
 * first record that is not a pharmacological action. Types and names come from
 * `summaries`, read only when there is more than one candidate; without them the
 * first candidate is pinned. (#247)
 */
function pinFrom(
  candidates: readonly string[],
  summaries: ReadonlyMap<string, MeshSummary> | undefined,
  queryName: string,
): string | undefined {
  const records = candidates.map((uid) => ({ uid, record: summaries?.get(uid)?.record }));
  const named = records.filter(({ record }) => record?.name.toLowerCase() === queryName);
  const firstOf = (list: typeof records, matches: (recordType: string | undefined) => boolean) =>
    list.find(({ record }) => matches(record?.recordType))?.uid;
  const isDescriptor = (recordType: string | undefined) => recordType === 'descriptor';
  const isNotAction = (recordType: string | undefined) => recordType !== 'pharmacological-action';
  return (
    firstOf(named, isDescriptor) ??
    firstOf(named, isNotAction) ??
    firstOf(records, isDescriptor) ??
    firstOf(records, isNotAction) ??
    candidates[0]
  );
}

// ─── Tool Definition ─────────────────────────────────────────────────────────

export const lookupMeshTool = tool('pubmed_lookup_mesh', {
  description:
    "Search and explore the MeSH (Medical Subject Headings) controlled vocabulary. Returns MeSH records of every type — descriptors, supplementary concepts, qualifiers, and pharmacological actions — each with its record type and the PubMed clause that searches it, plus tree numbers, scope notes, entry terms, year introduced, previous indexing, and the exact heading match's allowable subheadings, with pagination via offset for paging past the maxResults cap.",
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
        'MeSH term (a heading, supplementary concept, or qualifier name) or free-text term to look up. Must carry a term: a value of only whitespace or invisible characters, such as a zero-width space, is rejected rather than searched.',
      ),
    maxResults: z
      .number()
      .int()
      .min(1)
      .max(pageSizeCeiling(MAX_RESULTS_CAP))
      .default(10)
      .describe(
        `Maximum results per page, up to ${MAX_RESULTS_CAP} per call. A larger value is served at ${MAX_RESULTS_CAP}, with a notice; continue from \`nextOffset\`.`,
      ),
    offset: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe(
        'Result offset for pagination (0-based). Pass the `nextOffset` from the previous response to get the following page; the exact match is pinned to the first page only.',
      ),
    includeDetails: z
      .boolean()
      .default(true)
      .describe(
        "Include each record's details: scope note, tree numbers, entry terms, year introduced, previous indexing, and — on the exact heading match only — its allowable subheadings. `recordType` and `searchTerm` are returned either way.",
      ),
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
            name: z
              .string()
              .describe(
                "The record's preferred term: a heading, qualifier, or supplementary concept name as NLM writes it.",
              ),
            recordType: z
              .string()
              .optional()
              .describe(
                'MeSH record type as NCBI reports it: "descriptor", "supplemental-record" (a supplementary concept), "pharmacological-action", or "qualifier". A drug-class heading returns two records under one name and meshId, its descriptor and its pharmacological-action record. Omitted when the summary names no type.',
              ),
            searchTerm: z
              .string()
              .optional()
              .describe(
                'PubMed clause that searches this record, for the `pubmed_search_articles` query: `"Name"[mh]` for a descriptor, `[pt]` for a publication type (a descriptor in the V tree), `[nm]` for a supplementary concept, which no `[mh]` clause matches, `[pa]` for a pharmacological action, `[sh]` for a qualifier. Omitted when recordType is absent or unrecognized.',
              ),
            treeNumbers: z
              .array(z.string())
              .optional()
              .describe(
                'Navigable MeSH tree numbers (e.g. "D02.078.370.141.450"). Omitted for supplementary concept records (SCRs), which map to a heading rather than occupying a tree position, and for pharmacological-action records, whose descriptor carries the tree positions.',
              ),
            scopeNote: z.string().optional().describe('Scope note'),
            entryTerms: z.array(z.string()).optional().describe('Synonyms / entry terms'),
            yearIntroduced: z
              .string()
              .optional()
              .describe(
                'Year the record entered MeSH, as NLM gives it, unparsed: usually a year ("2008", "2008 (1966)", "2017(1967)"), occasionally a history note. Omitted when NLM records none.',
              ),
            previousIndexing: z
              .array(z.string())
              .optional()
              .describe(
                'Headings that indexed this concept before it was introduced, each with its years (e.g. "Heart Failure, Congestive (1989-2007)"). A date-bounded search reaching back before yearIntroduced also needs them: look each up by name, without its years, and search the `searchTerm` returned. A current heading returns its own record; a retired one, which matches nothing as `[mh]`, returns the heading that holds its records. Omitted when there are none.',
              ),
            subheadings: z
              .array(z.string())
              .optional()
              .describe(
                'Qualifiers this heading accepts, each combined as `"Heading/qualifier"[mh]`; a qualifier the heading does not accept matches nothing. Present only with includeDetails, on the exact heading match pinned to the first page of a query with no field tag. Its absence on any other record does not mean the heading takes none: look that heading up by name to get its list.',
              ),
          })
          .describe('Matching MeSH record'),
      )
      .describe('Matching MeSH records'),
  }),

  // Result-set context — the upstream match count for disclosure against the maxResults
  // cap, and recovery guidance when no record matched or the offset overshot.
  // Surfaced via ctx.enrich(...) to structuredContent and content[] alike.
  enrichment: {
    totalCount: z
      .number()
      .describe('Total MeSH records matching the query upstream, before the maxResults cap'),
    notice: z
      .string()
      .optional()
      .describe(
        `Optional guidance when no MeSH records matched, the offset overshot the result set, or a \`maxResults\` past the per-call cap of ${MAX_RESULTS_CAP} was served at ${MAX_RESULTS_CAP} — suggests spell-check, free-text search, resetting the offset, or the \`nextOffset\` to continue from. Absent on a result page that needs none of these.`,
      ),
  },

  async handler(input, ctx) {
    const { query, offset, includeDetails } = input;
    // A `maxResults` past the cap is served at the cap rather than rejected, and
    // the ranked ESearch window is sized from this applied value. (#232)
    const maxResults = Math.min(input.maxResults, MAX_RESULTS_CAP);
    const ncbi = getNcbiService();
    ctx.log.debug('MeSH lookup started', { query, maxResults, offset, includeDetails });

    // ESearch on db=mesh answers a blank term with Count=0 and a WarningList
    // rather than an error, so the empty-result branch would report "no MeSH
    // records matched" for a term that was never really searched. Invisible
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
    // NCBI translates an unquoted `X[MH]`, which is what maps an entry term to its
    // heading, but it can map a heading's own name past it too:
    // `Randomized Controlled Trial[MH]` reads as "randomized controlled trials as
    // topic"[MeSH Terms] and leaves out the publication type. The quoted literal adds
    // the record the query names, in the same request. A query holding a double quote
    // can't be quoted, so it is searched unquoted alone.
    const exactTerm = query.includes('"')
      ? `${query}[MH]`
      : `(${query}[MH]) OR "${query.trim()}"[MH]`;
    // The exact match is resolved on every page, not just the first: it is
    // normally a member of the ranked list too, so every page has to know which UID to
    // hold back. The first page leads with it; later pages skip it where it ranks.
    const exactSearch = hasFieldTag
      ? undefined
      : ncbi.eSearch({ db: 'mesh', term: exactTerm, retmax: EXACT_MATCH_CANDIDATES }, callOpts);
    const [broadResult, exactResult] = await Promise.all([broadSearch, exactSearch]);

    const totalCount = broadResult.count;
    const exactIds = exactResult?.idList ?? [];
    const queryName = query.trim().toLowerCase();
    const fetchSummaries = (uids: string[]) =>
      ncbi
        .eSummary({ db: 'mesh', id: uids.join(','), version: '2.0' }, callOpts)
        .then((data) => parseSummaryRecords(data, includeDetails));
    // A query can match more than one record: a drug class its pharmacological-action
    // record ahead of its descriptor (#247), a heading named like a qualifier the
    // qualifier first, a translated name the heading it maps to beside the one it
    // names. When it does and this page leads with the pin or holds a candidate at its
    // rank, read the candidates' types and names first — the page's own summaries ride
    // the same request — and pin the record the query names.
    const pinShapesPage = offset === 0 || exactIds.some((id) => broadResult.idList.includes(id));
    const prefetched =
      exactIds.length > 1 && pinShapesPage
        ? await fetchSummaries([...new Set([...exactIds, ...broadResult.idList])])
        : undefined;
    const pinnedUid = pinFrom(exactIds, prefetched, queryName);
    const ids: string[] = [];
    if (pinnedUid !== undefined && offset === 0) ids.push(pinnedUid);
    // Count the ranked records this page consumed rather than assuming maxResults:
    // a pinned exact match outside the ranked window displaces one, and the next
    // offset has to resume exactly where this page stopped or that record is lost.
    let consumed = 0;
    for (const id of broadResult.idList) {
      // The pinned record is served once, on the first page. Count its rank slot
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
    // Only the last `ctx.enrich.notice` survives, so the page's sentences are
    // collected and emitted once, the page-size clamp first when it applied.
    const notices: string[] = [];
    if (maxResults < input.maxResults) {
      notices.push(
        pageSizeClampNotice(
          'maxResults',
          input.maxResults,
          MAX_RESULTS_CAP,
          hasMore
            ? `Pass \`offset: ${nextOffset}\`, this page's \`nextOffset\`, for the next page.`
            : undefined,
        ),
      );
    }
    if (ids.length === 0) {
      ctx.enrich.total(totalCount);
      let notice: string;
      if (totalCount === 0) {
        notice = `No MeSH records matched ${quoted}. Try \`pubmed_spell_check\` for a suggested correction, broaden the term, or use \`pubmed_search_articles\` for free-text discovery against article metadata.`;
      } else if (consumed > 0) {
        // The window held nothing but the pinned record, already served at offset 0.
        notice = `Offset ${offset} held only the exact match for ${quoted}, which was returned on the first page.${
          hasMore ? ` Continue with offset ${nextOffset}.` : ''
        }`;
      } else {
        notice = `Offset ${offset} returned no records — ${quoted} matches ${totalCount} MeSH record(s). Reset offset to 0 or lower it below ${totalCount}.`;
      }
      notices.push(notice);
      ctx.enrich.notice(notices.join(' '));
      return { query, offset, ...(hasMore && { nextOffset }), results: [] };
    }

    const summaries = prefetched ?? (await fetchSummaries(ids));
    // The pinned heading match alone carries its allowable subheadings: on every
    // result they repeat record to record and add about a third to a ten-result page,
    // while looking a heading up by name makes it the pinned match. The pin is
    // served only on the first page of a query with no field tag. (#296)
    const results = ids.map((id): MeshRecord => {
      const summary = summaries.get(id);
      if (summary === undefined) return { entrezUid: id, name: id };
      return id === pinnedUid && summary.subheadings.length > 0
        ? { ...summary.record, subheadings: summary.subheadings }
        : summary.record;
    });

    results.sort((a, b) => {
      const aExact = a.name.toLowerCase() === queryName ? 0 : 1;
      const bExact = b.name.toLowerCase() === queryName ? 0 : 1;
      return aExact - bExact;
    });

    ctx.enrich.total(totalCount);
    // A page filled entirely by the pinned exact match consumed no ranked record,
    // so there is no offset that advances — say so instead of emitting one that
    // would replay this page.
    if (consumed === 0 && totalCount > 0) {
      notices.push(
        `The exact match filled this page of ${maxResults}. Raise maxResults to see the ${totalCount} ranked match(es) for ${quoted}.`,
      );
    }
    if (notices.length > 0) ctx.enrich.notice(notices.join(' '));
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
      // NLM's names, notes and lists are escaped at render time; structuredContent
      // keeps them as written. A list shares a line, so it is escaped joined. The
      // search clause is copied back into a query, so it is a code span. (#255)
      lines.push(`\n## ${escapeMarkdownInline(r.name)}`);
      if (r.recordType) lines.push(`- **Record Type:** ${escapeMarkdownInline(r.recordType)}`);
      if (r.searchTerm) lines.push(`- **Search Term:** ${markdownCodeSpan(r.searchTerm)}`);
      if (r.meshId) lines.push(`- **MeSH ID:** ${r.meshId}`);
      lines.push(`- **Entrez UID:** ${r.entrezUid}`);
      if (r.treeNumbers?.length) lines.push(`- **Tree Numbers:** ${r.treeNumbers.join(', ')}`);
      if (r.scopeNote) lines.push(`- **Scope Note:** ${escapeMarkdownInline(r.scopeNote)}`);
      if (r.entryTerms?.length) {
        lines.push(`- **Entry Terms:** ${escapeMarkdownInline(r.entryTerms.join('; '))}`);
      }
      if (r.yearIntroduced) {
        lines.push(`- **Year Introduced:** ${escapeMarkdownInline(r.yearIntroduced)}`);
      }
      if (r.previousIndexing?.length) {
        lines.push(
          `- **Previous Indexing:** ${escapeMarkdownInline(r.previousIndexing.join('; '))}`,
        );
      }
      if (r.subheadings?.length) {
        lines.push(`- **Subheadings:** ${escapeMarkdownInline(r.subheadings.join(', '))}`);
      }
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
