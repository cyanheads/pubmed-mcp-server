/**
 * @fileoverview Tests for the lookup-mesh tool.
 * @module tests/mcp-server/tools/definitions/lookup-mesh.tool.test
 */

import { type ContentBlock, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { NcbiResponseHandler } from '@/services/ncbi/response-handler.js';
import type { ESummaryResponseContainer, ESummaryResult } from '@/services/ncbi/types.js';
import {
  bunMarkdown,
  readCommonMark,
  renderedHtml,
  renderedText,
  textBlocks,
} from '../../../_helpers.js';
import { MESH_V2_RECORDS, meshSummaryXml } from './_mesh-esummary-fixtures.js';

const mockESearch = vi.fn();
const mockESummary = vi.fn();
vi.mock('@/services/ncbi/ncbi-service.js', () => ({
  getNcbiService: () => ({ eSearch: mockESearch, eSummary: mockESummary }),
}));

const { lookupMeshTool } = await import('@/mcp-server/tools/definitions/lookup-mesh.tool.js');

const responseHandler = new NcbiResponseHandler();

/** What `NcbiService.eSummary` hands the tool for a v2.0 body: the parsed `eSummaryResult`. */
function parseSummary(docs: readonly string[]): ESummaryResult {
  return responseHandler.parseAndHandleResponse<ESummaryResponseContainer>(
    meshSummaryXml(docs),
    'esummary',
    { retmode: 'xml' },
  ).eSummaryResult;
}

/** One v2.0 `<DocumentSummary>`, shaped like NCBI's, carrying the fields lookup-mesh reads. */
function meshDoc(
  uid: string,
  {
    terms = [`Descriptor ${uid}`],
    ui = `D${uid.slice(-6)}`,
    recordType = 'descriptor',
    scopeNote = '',
    treeNums = [] as string[],
    yearIntroduced = '',
    subheadings = [] as string[],
    previousIndexing = [] as string[],
  } = {},
): string {
  const links = treeNums
    .map(
      (t) =>
        `\t\t<LinksType>\n\t\t\t<Parent>1000067</Parent>\n\t\t\t<TreeNum>${t}</TreeNum>\n\t\t\t<Children>\n\t\t\t</Children>\n\t\t</LinksType>\n`,
    )
    .join('');
  const list = (tag: string, entries: string[]) =>
    [`\t<${tag}>`, ...entries.map((e) => `\t\t<string>${e}</string>`), `\t</${tag}>`].join('\n');
  return [
    `<DocumentSummary uid="${uid}">`,
    `\t<DS_YearIntroduced>${yearIntroduced}</DS_YearIntroduced>`,
    `\t<DS_ScopeNote>${scopeNote}</DS_ScopeNote>`,
    '\t<DS_MeshTerms>',
    ...terms.map((t) => `\t\t<string>${t}</string>`),
    '\t</DS_MeshTerms>',
    list('DS_Subheading', subheadings),
    list('DS_PreviousIndexing', previousIndexing),
    `\t<DS_IdxLinks>\n${links}\t</DS_IdxLinks>`,
    `\t<DS_RecordType>${recordType}</DS_RecordType>`,
    `\t<DS_MeSHUI>${ui}</DS_MeSHUI>`,
    '</DocumentSummary>',
  ].join('\n');
}

/** The captured record for a UID, or a synthetic descriptor for any other UID. */
function docFor(uid: string): string {
  return MESH_V2_RECORDS[uid] ?? meshDoc(uid);
}

/** ESummary result covering exactly the ids the handler asked for, in order. */
function summaryFor(ids: string[]) {
  return parseSummary(ids.map(docFor));
}

describe('lookupMeshTool', () => {
  beforeEach(() => {
    mockESearch.mockReset();
    mockESummary.mockReset();
  });

  it('validates input with defaults', () => {
    const input = lookupMeshTool.input.parse({ query: 'Neoplasms' });
    expect(input.query).toBe('Neoplasms');
    expect(input.maxResults).toBe(10);
    expect(input.offset).toBe(0);
    expect(input.includeDetails).toBe(true);
  });

  it('rejects a negative offset', () => {
    expect(() => lookupMeshTool.input.parse({ query: 'cancer', offset: -1 })).toThrow();
  });

  it('accepts offsets past 9998 — the retstart ceiling is PubMed-only, db=mesh has none', () => {
    // Verified against eSearch db=mesh: retstart is served all the way to the
    // match count and returns an empty page beyond it, never an ERROR.
    expect(lookupMeshTool.input.safeParse({ query: 'cancer', offset: 9999 }).success).toBe(true);
    expect(lookupMeshTool.input.safeParse({ query: 'cancer', offset: 300000 }).success).toBe(true);
  });

  it('returns empty results with a recovery notice when no MeSH IDs found', async () => {
    mockESearch.mockResolvedValue({ idList: [], count: 0 });

    const ctx = createMockContext({ errors: lookupMeshTool.errors });
    const input = lookupMeshTool.input.parse({ query: 'xyznonexistent' });
    const result = await lookupMeshTool.handler(input, ctx);
    const enrichment = getEnrichment(ctx);

    expect(result.results).toEqual([]);
    expect(result.query).toBe('xyznonexistent');
    expect(enrichment.totalCount).toBe(0);
    expect(enrichment.notice).toMatch(/xyznonexistent/);
    expect(enrichment.notice).toMatch(/spell_check|search_articles/);
  });

  it('quotes the query in a notice as a code span that reads back as sent (#263)', async () => {
    mockESearch.mockResolvedValue({ idList: [], count: 0 });
    const result = await runToolContract(lookupMeshTool, { query: 'zz*qx zz*qy' });

    expect((result.structuredContent as { notice?: string }).notice).toMatch(
      /^No MeSH records matched `zz\*qx zz\*qy`\. /,
    );
    const text = textBlocks(result.content as ContentBlock[])
      .map((b) => b.text)
      .join('\n');
    expect(readCommonMark(text)).toContain(
      'No MeSH records matched ⟨code_inline:zz*qx zz*qy⟩. Try ⟨code_inline:pubmed_spell_check⟩',
    );
  });

  it('returns parsed MeSH records', async () => {
    mockESearch.mockResolvedValue({ idList: ['68009369'], count: 1 });
    mockESummary.mockResolvedValue(
      parseSummary([
        meshDoc('68009369', { terms: ['Neoplasms'], scopeNote: 'New abnormal growth of tissue.' }),
      ]),
    );

    const ctx = createMockContext({ errors: lookupMeshTool.errors });
    const input = lookupMeshTool.input.parse({ query: 'Neoplasms' });
    const result = await lookupMeshTool.handler(input, ctx);

    expect(result.results).toHaveLength(1);
    expect(result.results[0]?.meshId).toBe('D009369');
    expect(result.results[0]?.entrezUid).toBe('68009369');
    expect(result.results[0]?.name).toBe('Neoplasms');
    expect(result.results[0]?.scopeNote).toContain('abnormal growth');
    expect(getEnrichment(ctx).notice).toBeUndefined();
  });

  it('deduplicates exact matches, respects maxResults, and parses detailed tree metadata', async () => {
    mockESearch.mockImplementation(async (params: { term: string }) => {
      if (params.term.endsWith('[MH]')) return { idList: ['68009369'], count: 1 };
      return { idList: ['68001234', '68009369', '68009999'], count: 3 };
    });
    mockESummary.mockResolvedValue(
      parseSummary([
        meshDoc('68009369', {
          terms: ['Neoplasms', 'Tumors'],
          scopeNote: 'New abnormal growth of tissue.',
          treeNums: ['C04', 'C04.588'],
        }),
        meshDoc('68001234', { terms: ['Cancer'] }),
      ]),
    );

    const ctx = createMockContext({ errors: lookupMeshTool.errors });
    const input = lookupMeshTool.input.parse({ query: 'Neoplasms', maxResults: 2 });
    const result = await lookupMeshTool.handler(input, ctx);

    expect(mockESearch).toHaveBeenCalledWith(
      { db: 'mesh', term: 'Neoplasms', retmax: 2, retstart: 0 },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(mockESearch).toHaveBeenCalledWith(
      { db: 'mesh', term: '(Neoplasms[MH]) OR "Neoplasms"[MH]', retmax: 5 },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(mockESummary).toHaveBeenCalledWith(
      { db: 'mesh', id: '68009369,68001234', version: '2.0' },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(result.results.map((r) => r.meshId)).toEqual(['D009369', 'D001234']);
    expect(result.results.map((r) => r.entrezUid)).toEqual(['68009369', '68001234']);
    expect(result.results[0]).toMatchObject({
      entrezUid: '68009369',
      name: 'Neoplasms',
      scopeNote: 'New abnormal growth of tissue.',
      entryTerms: ['Neoplasms', 'Tumors'],
      treeNumbers: ['C04', 'C04.588'],
    });
  });

  it('filters non-navigable @-pointer "tree numbers" from SCRs (#76)', async () => {
    mockESearch.mockImplementation(async (params: { term: string }) =>
      params.term.endsWith('[MH]')
        ? { idList: [], count: 0 }
        : { idList: ['67585596', '68008687'], count: 2 },
    );
    mockESummary.mockResolvedValue(
      parseSummary([
        // Supplementary Concept Record (Jentadueto), as captured: its only TreeNum is
        // a mapped-heading pointer (@-prefixed), not a navigable tree number.
        MESH_V2_RECORDS['67585596'] as string,
        // True descriptor (Metformin): a real tree number plus a stray @-pointer
        // that must still be dropped.
        meshDoc('68008687', {
          terms: ['Metformin'],
          treeNums: ['D02.078.370.141.450', '@218176'],
        }),
      ]),
    );

    const ctx = createMockContext({ errors: lookupMeshTool.errors });
    const input = lookupMeshTool.input.parse({ query: 'metformin' });
    const result = await lookupMeshTool.handler(input, ctx);

    const jentadueto = result.results.find((r) => r.entrezUid === '67585596');
    const metformin = result.results.find((r) => r.entrezUid === '68008687');
    // SCR with only an @-pointer → treeNumbers omitted entirely.
    expect(jentadueto?.treeNumbers).toBeUndefined();
    // Descriptor keeps the real tree number; the @-pointer is filtered out.
    expect(metformin?.treeNumbers).toEqual(['D02.078.370.141.450']);
  });

  it('skips exact MeSH search for tagged queries and omits details when requested', async () => {
    mockESearch.mockResolvedValue({ idList: ['68009369'], count: 1 });
    mockESummary.mockResolvedValue(summaryFor(['68009369']));

    const ctx = createMockContext({ errors: lookupMeshTool.errors });
    const input = lookupMeshTool.input.parse({
      query: 'Neoplasms[MH]',
      includeDetails: false,
    });
    const result = await lookupMeshTool.handler(input, ctx);

    expect(mockESearch).toHaveBeenCalledTimes(1);
    expect(mockESearch).toHaveBeenCalledWith(
      { db: 'mesh', term: 'Neoplasms[MH]', retmax: 10, retstart: 0 },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(result.results).toEqual([
      {
        entrezUid: '68009369',
        meshId: 'D009369',
        name: 'Neoplasms',
        recordType: 'descriptor',
        searchTerm: '"Neoplasms"[mh]',
      },
    ]);
  });

  /* ────────────────────────────────────────────────────────────────────────── */
  /*  meshId is the record's own DS_MeSHUI from the version 2.0 eSummary (#238) */
  /* ────────────────────────────────────────────────────────────────────────── */

  describe('meshId comes from DS_MeSHUI, never from the Entrez UID (#238)', () => {
    /**
     * How eSummary answers without `version=2.0`: version 1.0 `DocSum` items,
     * which carry no DS_MeSHUI.
     */
    function v1SummaryFor(uids: string[]): ESummaryResult {
      const docSums = uids.map(
        (uid) =>
          `<DocSum>\n\t<Id>${uid}</Id>\n\t<Item Name="DS_MeshTerms" Type="List">\n\t\t<Item Name="string" Type="String">Descriptor ${uid}</Item>\n\t</Item>\n</DocSum>`,
      );
      return responseHandler.parseAndHandleResponse<ESummaryResponseContainer>(
        `<?xml version="1.0" encoding="UTF-8" ?>\n<eSummaryResult>\n${docSums.join('\n')}\n</eSummaryResult>\n`,
        'esummary',
        { retmode: 'xml' },
      ).eSummaryResult;
    }

    /**
     * Run a ranked page of `uids` (no exact-heading pin) against the captured
     * records, served as eSummary would serve the `version` the tool asks for.
     */
    async function lookUp(uids: string[], includeDetails = false) {
      mockESearch.mockImplementation(async (params: { term: string }) =>
        params.term.endsWith('[MH]')
          ? { idList: [], count: 0 }
          : { idList: uids, count: uids.length },
      );
      mockESummary.mockImplementation(async (params: { id: string; version?: string }) =>
        params.version === '2.0'
          ? summaryFor(params.id.split(','))
          : v1SummaryFor(params.id.split(',')),
      );
      return lookupMeshTool.handler(
        lookupMeshTool.input.parse({ query: 'mixed batch', maxResults: 50, includeDetails }),
        createMockContext({ errors: lookupMeshTool.errors }),
      );
    }

    it('requests the version 2.0 summary, which carries DS_MeSHUI', async () => {
      const result = await lookUp(['68009369']);

      expect(mockESummary).toHaveBeenCalledWith(
        { db: 'mesh', id: '68009369', version: '2.0' },
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
      expect(result.results).toEqual([
        {
          entrezUid: '68009369',
          meshId: 'D009369',
          name: 'Neoplasms',
          recordType: 'descriptor',
          searchTerm: '"Neoplasms"[mh]',
        },
      ]);
    });

    it('reports the canonical UI for 7-digit UIDs and pharmacological-action records', async () => {
      const result = await lookUp(['2016754', '2016755', '2101083', '2016178', '82000900']);

      expect(result.results.map((r) => ({ meshId: r.meshId, entrezUid: r.entrezUid }))).toEqual([
        { meshId: 'D000072657', entrezUid: '2016754' }, // ST Elevation Myocardial Infarction
        { meshId: 'D000072658', entrezUid: '2016755' }, // Non-ST Elevated Myocardial Infarction
        { meshId: 'D000088442', entrezUid: '2101083' }, // MINOCA
        { meshId: 'Q000000981', entrezUid: '2016178' }, // diagnostic imaging (qualifier)
        { meshId: 'D000900', entrezUid: '82000900' }, // Anti-Bacterial Agents (PA record)
      ]);
    });

    it('keeps the values 8-digit UIDs reported before, and the 7-digit SCR resolves', async () => {
      const result = await lookUp(['68009369', '67000295', '81000009', '2025952']);

      expect(result.results.map((r) => ({ meshId: r.meshId, entrezUid: r.entrezUid }))).toEqual([
        { meshId: 'D009369', entrezUid: '68009369' },
        { meshId: 'C000295', entrezUid: '67000295' },
        { meshId: 'Q000009', entrezUid: '81000009' },
        { meshId: 'C000626284', entrezUid: '2025952' },
      ]);
    });

    it('gives a pharmacological-action record its descriptor UI while entrezUid keeps them apart', async () => {
      const result = await lookUp(['82000900', '68000900']);

      expect(result.results.map((r) => ({ meshId: r.meshId, entrezUid: r.entrezUid }))).toEqual([
        { meshId: 'D000900', entrezUid: '82000900' },
        { meshId: 'D000900', entrezUid: '68000900' },
      ]);
    });

    it('keeps name, scope note, entry terms, and tree numbers as the version 1 summary gave them', async () => {
      const result = await lookUp(
        ['2016754', '2016178', '81000009', '68000019', '2025952', '67585596'],
        true,
      );

      expect(result.results).toEqual([
        {
          entrezUid: '2016754',
          meshId: 'D000072657',
          name: 'ST Elevation Myocardial Infarction',
          recordType: 'descriptor',
          searchTerm: '"ST Elevation Myocardial Infarction"[mh]',
          yearIntroduced: '2017',
          previousIndexing: ['Myocardial Infarction (1999-2016)'],
          scopeNote:
            'A clinical syndrome defined by MYOCARDIAL ISCHEMIA symptoms; persistent elevation in the ST segments of the ELECTROCARDIOGRAM; and release of BIOMARKERS of myocardial NECROSIS (e.g., elevated TROPONIN levels). ST segment elevation in the ECG is often used in determining the treatment protocol (see also NON-ST ELEVATION MYOCARDIAL INFARCTION).',
          entryTerms: [
            'ST Elevation Myocardial Infarction',
            'STEMI',
            'ST Segment Elevation Myocardial Infarction',
            'ST Elevated Myocardial Infarction',
          ],
          treeNumbers: [
            'C14.280.647.500.875',
            'C14.907.585.500.875',
            'C23.550.513.355.750.875',
            'C23.550.717.489.750.875',
          ],
        },
        {
          entrezUid: '2016178',
          meshId: 'Q000000981',
          name: 'diagnostic imaging',
          recordType: 'qualifier',
          searchTerm: '"diagnostic imaging"[sh]',
          yearIntroduced: '2017(1967)',
          scopeNote:
            'Used for the visualization of an anatomical structure or for the diagnosis of disease. Commonly used imaging techniques include radiography, radionuclide imaging, thermography, tomography, and ultrasonography',
          entryTerms: [
            'diagnostic imaging',
            'radiography',
            'roentgenography',
            'X-ray',
            'X-ray diagnosis',
            'X-ray image',
            'radionuclide imaging',
            'radioisotope scanning',
            'ultrasonography',
            'echography',
            'ultrasonic diagnosis',
            'echotomography',
            'ultrasound',
          ],
          // A single LinksType parses to an object, not a one-entry array.
          treeNumbers: ['Y04.010'],
        },
        {
          entrezUid: '81000009',
          meshId: 'Q000009',
          name: 'adverse effects',
          recordType: 'qualifier',
          searchTerm: '"adverse effects"[sh]',
          yearIntroduced: '1966',
          scopeNote:
            'Used with drugs, chemicals, or biological agents in accepted dosage - or with physical agents or manufactured products in normal usage - when intended for diagnostic, therapeutic, prophylactic, or anesthetic purposes. It is used also for adverse effects or complications of diagnostic, therapeutic, prophylactic, anesthetic, surgical, or other procedures.',
          entryTerms: ['adverse effects', 'side effects'],
          treeNumbers: ['Y07.020', 'Y10.020'],
        },
        {
          entrezUid: '68000019',
          meshId: 'D000019',
          name: 'Abortifacient Agents',
          recordType: 'descriptor',
          searchTerm: '"Abortifacient Agents"[mh]',
          yearIntroduced: '1975',
          previousIndexing: ['Abortion, Induced (1970-1974)'],
          scopeNote: 'Chemical substances that interrupt pregnancy after implantation.',
          entryTerms: [
            'Abortifacient Agents',
            'Agents, Abortifacient',
            'Abortifacients',
            'Contraceptive Agents, Postconception',
            'Agents, Postconception Contraceptive',
            'Postconception Contraceptive Agents',
            'Abortifacient Effect',
            'Effect, Abortifacient',
            'Abortifacient Effects',
            'Effects, Abortifacient',
          ],
          treeNumbers: ['D27.505.696.875.131', 'D27.505.954.705.131'],
        },
        {
          entrezUid: '2025952',
          meshId: 'C000626284',
          name: 'tisagenlecleucel',
          recordType: 'supplemental-record',
          searchTerm: '"tisagenlecleucel"[nm]',
          scopeNote:
            'anti-CD19 chimeric antigen receptor (CAR) T-cell therapy for treatment of B-Cell lymphoblastic leukemia',
          entryTerms: ['tisagenlecleucel', 'CTL019', 'KYMRIAH'],
        },
        {
          // One entry term parses to a scalar; the @-pointer TreeNum is dropped (#76).
          entrezUid: '67585596',
          meshId: 'C585596',
          name: 'Jentadueto',
          recordType: 'supplemental-record',
          searchTerm: '"Jentadueto"[nm]',
          scopeNote:
            'fixed combination of linagliptin plus metformin for the treatment of type 2 diabetes',
          entryTerms: ['Jentadueto'],
        },
      ]);
    });

    it('omits meshId and names the record by its UID when eSummary holds only an error for it', async () => {
      // How version 2.0 answers a UID it has no record for, beside one it has.
      const result = await lookUp(['68009369', '99999999']);

      expect(result.results).toEqual([
        {
          entrezUid: '68009369',
          meshId: 'D009369',
          name: 'Neoplasms',
          recordType: 'descriptor',
          searchTerm: '"Neoplasms"[mh]',
        },
        { entrezUid: '99999999', name: '99999999' },
      ]);
    });

    it('omits meshId for every UID when eSummary returns no records at all', async () => {
      mockESearch.mockImplementation(async (params: { term: string }) =>
        params.term.endsWith('[MH]')
          ? { idList: [], count: 0 }
          : { idList: ['68000001'], count: 1 },
      );
      mockESummary.mockResolvedValue({});

      const result = await lookupMeshTool.handler(
        lookupMeshTool.input.parse({ query: 'rare descriptor' }),
        createMockContext({ errors: lookupMeshTool.errors }),
      );

      expect(result.results).toEqual([{ entrezUid: '68000001', name: '68000001' }]);
    });

    it('drops the MeSH ID line, not the record, on both surfaces when meshId is absent', async () => {
      mockESearch.mockImplementation(async (params: { term: string }) =>
        params.term.endsWith('[MH]')
          ? { idList: [], count: 0 }
          : { idList: ['68009369', '99999999'], count: 2 },
      );
      mockESummary.mockImplementation(async (params: { id: string }) =>
        summaryFor(params.id.split(',')),
      );

      const result = await runToolContract(lookupMeshTool, {
        query: 'neoplasms',
        includeDetails: false,
      });

      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toMatchObject({
        results: [
          { entrezUid: '68009369', meshId: 'D009369', name: 'Neoplasms' },
          { entrezUid: '99999999', name: '99999999' },
        ],
      });
      const missing = (result.structuredContent as { results: Record<string, unknown>[] })
        .results[1];
      expect(missing).not.toHaveProperty('meshId');
      const text = textBlocks(result.content as ContentBlock[])
        .map((b) => b.text)
        .join('\n');
      expect(text).toContain(
        '## Neoplasms\n- **Record Type:** descriptor\n- **Search Term:** `"Neoplasms"[mh]`\n- **MeSH ID:** D009369\n- **Entrez UID:** 68009369\n\n## 99999999\n- **Entrez UID:** 99999999',
      );
    });
  });

  /* ────────────────────────────────────────────────────────────────────────── */
  /*  A drug-class heading pins its descriptor, not its PA record (#247)       */
  /* ────────────────────────────────────────────────────────────────────────── */

  describe('a drug-class heading pins the descriptor record (#247)', () => {
    /**
     * `<heading>[MH]` on db=mesh answers a drug-class heading with its
     * pharmacological-action record first, then the descriptor — as captured
     * for both headings below.
     */
    const EXACT: Record<string, string[]> = {
      'Anti-Bacterial Agents': ['82000900', '68000900'],
      'Abortifacient Agents': ['82000019', '68000019'],
    };

    function mockHeading(heading: string, ranked: string[]) {
      mockESearch.mockImplementation(
        async (params: { term: string; retmax: number; retstart?: number }) => {
          if (params.term.endsWith('[MH]')) {
            const exact = EXACT[heading] ?? [];
            return { idList: exact.slice(0, params.retmax), count: exact.length };
          }
          const start = params.retstart ?? 0;
          return { idList: ranked.slice(start, start + params.retmax), count: ranked.length };
        },
      );
      mockESummary.mockImplementation(async (params: { id: string }) =>
        summaryFor(params.id.split(',')),
      );
    }

    it.each([
      [
        'Anti-Bacterial Agents',
        {
          entrezUid: '68000900',
          meshId: 'D000900',
          name: 'Anti-Bacterial Agents',
          scopeNote: 'Substances that inhibit the growth or reproduction of BACTERIA.',
          treeNumbers: ['D27.505.954.122.085'],
        },
        '- **Tree Numbers:** D27.505.954.122.085',
      ],
      [
        'Abortifacient Agents',
        {
          entrezUid: '68000019',
          meshId: 'D000019',
          name: 'Abortifacient Agents',
          scopeNote: 'Chemical substances that interrupt pregnancy after implantation.',
          treeNumbers: ['D27.505.696.875.131', 'D27.505.954.705.131'],
        },
        '- **Tree Numbers:** D27.505.696.875.131, D27.505.954.705.131',
      ],
    ])('pins the %s descriptor first on both surfaces', async (heading, descriptor, treeLine) => {
      const [paUid, descriptorUid] = EXACT[heading] as [string, string];
      mockHeading(heading, [paUid, descriptorUid, '68009369']);

      const result = await runToolContract(lookupMeshTool, { query: heading, maxResults: 3 });

      expect(result.isError).toBeFalsy();
      const results = (result.structuredContent as { results: Record<string, unknown>[] }).results;
      expect(results.map((r) => r.entrezUid)).toEqual([descriptorUid, paUid, '68009369']);
      expect(results[0]).toMatchObject(descriptor);
      const text = textBlocks(result.content as ContentBlock[])
        .map((b) => b.text)
        .join('\n');
      expect(text).toContain(
        `\n## ${heading}\n- **Record Type:** descriptor\n- **Search Term:** \`"${heading}"[mh]\`\n- **MeSH ID:** ${descriptor.meshId}\n- **Entrez UID:** ${descriptorUid}\n${treeLine}\n- **Scope Note:** ${descriptor.scopeNote}\n- **Entry Terms:** ${heading}; `,
      );
      // One eSummary per call, record types included.
      expect(mockESummary).toHaveBeenCalledTimes(1);
    });

    it('reports no UI-valued tree number for a pharmacological-action record in the ranked list', async () => {
      mockHeading('Anti-Bacterial Agents', ['82000900', '68000900']);

      const result = await lookupMeshTool.handler(
        lookupMeshTool.input.parse({ query: 'Anti-Bacterial Agents' }),
        createMockContext({ errors: lookupMeshTool.errors }),
      );

      expect(result.results.find((r) => r.entrezUid === '82000900')).toEqual({
        entrezUid: '82000900',
        meshId: 'D000900',
        name: 'Anti-Bacterial Agents',
        recordType: 'pharmacological-action',
        searchTerm: '"Anti-Bacterial Agents"[pa]',
        entryTerms: ['Anti-Bacterial Agents'],
      });
    });

    it('pins the first exact match, as before, when no candidate is a pharmacological-action record', async () => {
      mockESearch.mockImplementation(async (params: { term: string }) =>
        params.term.endsWith('[MH]')
          ? { idList: ['68009369', '68008687'], count: 2 }
          : { idList: ['68008687', '68009369', '68000001'], count: 3 },
      );
      mockESummary.mockImplementation(async (params: { id: string }) =>
        summaryFor(params.id.split(',')),
      );

      const result = await lookupMeshTool.handler(
        lookupMeshTool.input.parse({ query: 'Neoplasms', includeDetails: false }),
        createMockContext({ errors: lookupMeshTool.errors }),
      );

      expect(result.results.map((r) => r.entrezUid)).toEqual(['68009369', '68008687', '68000001']);
    });

    it('pins the only exact match without reading record types first', async () => {
      mockESearch.mockImplementation(async (params: { term: string }) =>
        params.term.endsWith('[MH]')
          ? { idList: ['68009369'], count: 1 }
          : { idList: ['68000001', '68009369'], count: 2 },
      );
      mockESummary.mockImplementation(async (params: { id: string }) =>
        summaryFor(params.id.split(',')),
      );

      const result = await lookupMeshTool.handler(
        lookupMeshTool.input.parse({ query: 'Neoplasms', includeDetails: false }),
        createMockContext({ errors: lookupMeshTool.errors }),
      );

      expect(result.results.map((r) => r.entrezUid)).toEqual(['68009369', '68000001']);
      expect(mockESummary).toHaveBeenCalledTimes(1);
      expect(mockESummary).toHaveBeenCalledWith(
        { db: 'mesh', id: '68009369,68000001', version: '2.0' },
        expect.anything(),
      );
    });

    it('reads no record types for a later page that holds neither exact match', async () => {
      mockHeading('Anti-Bacterial Agents', ['82000900', '68000900', '68000001', '68000002']);

      const ctx = createMockContext({ errors: lookupMeshTool.errors });
      const result = await lookupMeshTool.handler(
        lookupMeshTool.input.parse({ query: 'Anti-Bacterial Agents', offset: 9 }),
        ctx,
      );

      expect(result.results).toEqual([]);
      expect(getEnrichment(ctx).notice).toMatch(/Offset 9 returned no records/);
      expect(mockESummary).not.toHaveBeenCalled();
    });

    it('serves the descriptor once and the PA record at its rank across a full offset walk', async () => {
      const ranked = ['68000001', '82000900', '68000002', '68000900', '68000003', '68000004'];
      mockHeading('Anti-Bacterial Agents', ranked);

      const pages: string[][] = [];
      let offset: number | undefined = 0;
      while (offset !== undefined) {
        if (pages.length > ranked.length) throw new Error('pagination did not terminate');
        const page = await lookupMeshTool.handler(
          lookupMeshTool.input.parse({
            query: 'Anti-Bacterial Agents',
            maxResults: 2,
            offset,
            includeDetails: false,
          }),
          createMockContext({ errors: lookupMeshTool.errors }),
        );
        pages.push(page.results.map((r) => r.entrezUid));
        offset = page.nextOffset;
      }

      expect(pages).toEqual([
        // The descriptor leads and displaces one ranked record.
        ['68000900', '68000001'],
        // Exact-name records sort first within a page; the PA record keeps its place.
        ['82000900', '68000002'],
        // The descriptor ranks in this window and is held back, not served twice.
        ['68000003'],
        ['68000004'],
      ]);
      const collected = pages.flat();
      expect(new Set(collected).size).toBe(collected.length);
      expect([...collected].sort()).toEqual([...ranked].sort());
    });
  });

  /* ────────────────────────────────────────────────────────────────────────── */
  /*  totalCount (#82) and offset pagination (#84)                              */
  /* ────────────────────────────────────────────────────────────────────────── */

  describe('totalCount reports the upstream match count, not the page size (#82)', () => {
    it.each([1, 5])('reports the same total for maxResults=%i', async (maxResults) => {
      mockESearch.mockImplementation(async (params: { term: string; retmax: number }) =>
        params.term.endsWith('[MH]')
          ? { idList: [], count: 0 }
          : {
              idList: Array.from({ length: params.retmax }, (_, i) => `6800000${i}`),
              count: 4213,
            },
      );
      mockESummary.mockImplementation(async (params: { id: string }) =>
        summaryFor(params.id.split(',')),
      );

      const ctx = createMockContext({ errors: lookupMeshTool.errors });
      const input = lookupMeshTool.input.parse({
        query: 'cancer',
        maxResults,
        includeDetails: false,
      });
      const result = await lookupMeshTool.handler(input, ctx);

      expect(result.results).toHaveLength(maxResults);
      expect(getEnrichment(ctx).totalCount).toBe(4213);
    });
  });

  describe('offset pagination (#84)', () => {
    /** 7 ranked descriptors; the [MH] pin resolves to the second of them. */
    const ranked = ['68000000', '68000001', '68000002', '68000003', '68000004', '68000005'];

    function mockRanked(pinned: string | undefined, total = ranked.length) {
      mockESearch.mockImplementation(
        async (params: { term: string; retmax: number; retstart?: number }) => {
          if (params.term.endsWith('[MH]')) {
            return { idList: pinned ? [pinned] : [], count: pinned ? 1 : 0 };
          }
          const start = params.retstart ?? 0;
          return { idList: ranked.slice(start, start + params.retmax), count: total };
        },
      );
      mockESummary.mockImplementation(async (params: { id: string }) =>
        summaryFor(params.id.split(',')),
      );
    }

    it('returns the first page and points at the next offset', async () => {
      mockRanked('68000001');

      const ctx = createMockContext({ errors: lookupMeshTool.errors });
      const input = lookupMeshTool.input.parse({
        query: 'cancer',
        maxResults: 2,
        includeDetails: false,
      });
      const result = await lookupMeshTool.handler(input, ctx);

      // The pinned exact match leads; it is deduped against the ranked window.
      expect(result.results.map((r) => r.entrezUid)).toEqual(['68000001', '68000000']);
      expect(result.offset).toBe(0);
      expect(result.nextOffset).toBe(2);
      expect(getEnrichment(ctx).totalCount).toBe(6);
    });

    it('returns the next distinct records on the second page and skips the [MH] pin', async () => {
      mockRanked('68000001');

      const ctx = createMockContext({ errors: lookupMeshTool.errors });
      const input = lookupMeshTool.input.parse({
        query: 'cancer',
        maxResults: 2,
        offset: 2,
        includeDetails: false,
      });
      const result = await lookupMeshTool.handler(input, ctx);

      expect(result.results.map((r) => r.entrezUid)).toEqual(['68000002', '68000003']);
      expect(result.offset).toBe(2);
      expect(result.nextOffset).toBe(4);
      // The exact-descriptor search runs on every page — the pinned UID is what
      // later pages need in order to hold it back at its ranked position (#91).
      expect(mockESearch).toHaveBeenCalledTimes(2);
      expect(mockESearch).toHaveBeenCalledWith(
        { db: 'mesh', term: 'cancer', retmax: 2, retstart: 2 },
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
      expect(mockESearch).toHaveBeenCalledWith(
        { db: 'mesh', term: '(cancer[MH]) OR "cancer"[MH]', retmax: 5 },
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
    });

    it('resumes where the page stopped when the pin displaced a ranked record', async () => {
      // The pin is outside the ranked list, so page 1 shows it plus one ranked
      // record — the next offset must be 1, not maxResults, or 68000001 is lost.
      mockRanked('68999999');

      const first = await lookupMeshTool.handler(
        lookupMeshTool.input.parse({ query: 'cancer', maxResults: 2, includeDetails: false }),
        createMockContext({ errors: lookupMeshTool.errors }),
      );
      expect(first.results.map((r) => r.entrezUid)).toEqual(['68999999', '68000000']);
      expect(first.nextOffset).toBe(1);

      const second = await lookupMeshTool.handler(
        lookupMeshTool.input.parse({
          query: 'cancer',
          maxResults: 2,
          offset: first.nextOffset,
          includeDetails: false,
        }),
        createMockContext({ errors: lookupMeshTool.errors }),
      );
      expect(second.results.map((r) => r.entrezUid)).toEqual(['68000001', '68000002']);
    });

    it('omits nextOffset on the final partial page', async () => {
      mockRanked(undefined);

      const ctx = createMockContext({ errors: lookupMeshTool.errors });
      const input = lookupMeshTool.input.parse({
        query: 'cancer',
        maxResults: 4,
        offset: 4,
        includeDetails: false,
      });
      const result = await lookupMeshTool.handler(input, ctx);

      expect(result.results.map((r) => r.entrezUid)).toEqual(['68000004', '68000005']);
      expect(result.offset).toBe(4);
      expect(result.nextOffset).toBeUndefined();
      expect(getEnrichment(ctx).totalCount).toBe(6);
    });

    it('reports an overshooting offset instead of claiming no matches', async () => {
      mockRanked(undefined);

      const ctx = createMockContext({ errors: lookupMeshTool.errors });
      const input = lookupMeshTool.input.parse({
        query: 'cancer',
        maxResults: 5,
        offset: 500,
        includeDetails: false,
      });
      const result = await lookupMeshTool.handler(input, ctx);
      const enrichment = getEnrichment(ctx);

      expect(result.results).toEqual([]);
      expect(result.offset).toBe(500);
      expect(result.nextOffset).toBeUndefined();
      expect(enrichment.totalCount).toBe(6);
      expect(enrichment.notice).toMatch(/Offset 500/);
      expect(enrichment.notice).toMatch(/Reset offset to 0/);
      // Not the empty-result guidance — the query did match.
      expect(enrichment.notice).not.toMatch(/spell_check/);
    });

    it('flags a page the pinned exact match filled on its own', async () => {
      mockRanked('68999999');

      const ctx = createMockContext({ errors: lookupMeshTool.errors });
      const input = lookupMeshTool.input.parse({
        query: 'cancer',
        maxResults: 1,
        includeDetails: false,
      });
      const result = await lookupMeshTool.handler(input, ctx);

      expect(result.results.map((r) => r.entrezUid)).toEqual(['68999999']);
      // No offset would advance past this page, so none is offered.
      expect(result.nextOffset).toBeUndefined();
      expect(getEnrichment(ctx).notice).toMatch(
        /^The exact match filled this page of 1\. Raise maxResults/,
      );
    });
  });

  /* ────────────────────────────────────────────────────────────────────────── */
  /*  The pinned descriptor is served exactly once across a full walk (#91)     */
  /* ────────────────────────────────────────────────────────────────────────── */

  describe('a full offset → nextOffset walk serves every descriptor exactly once (#91)', () => {
    /** 13 ranked descriptors, mirroring a real MeSH result set. */
    const ranked = Array.from({ length: 13 }, (_, i) => `6800${String(100 + i)}`);

    function mockWalk(pinned: string | undefined) {
      mockESearch.mockImplementation(
        async (params: { term: string; retmax: number; retstart?: number }) => {
          if (params.term.endsWith('[MH]')) {
            return { idList: pinned ? [pinned] : [], count: pinned ? 1 : 0 };
          }
          const start = params.retstart ?? 0;
          return { idList: ranked.slice(start, start + params.retmax), count: ranked.length };
        },
      );
      mockESummary.mockImplementation(async (params: { id: string }) =>
        summaryFor(params.id.split(',')),
      );
    }

    /** Walks offset → nextOffset from 0 until the server stops offering one. */
    async function walkAllPages(maxResults: number) {
      const pages: string[][] = [];
      let offset: number | undefined = 0;
      while (offset !== undefined) {
        if (pages.length > ranked.length) throw new Error('pagination did not terminate');
        const result = await lookupMeshTool.handler(
          lookupMeshTool.input.parse({
            query: 'cancer',
            maxResults,
            offset,
            includeDetails: false,
          }),
          createMockContext({ errors: lookupMeshTool.errors }),
        );
        pages.push(result.results.map((r) => r.entrezUid));
        offset = result.nextOffset;
      }
      return { pages, collected: pages.flat() };
    }

    it('covers the set without duplicates when the pin ranks inside the first window', async () => {
      const pin = ranked[4];
      mockWalk(pin);

      const { pages, collected } = await walkAllPages(5);

      expect(pages).toEqual([
        [pin, ranked[0], ranked[1], ranked[2], ranked[3]],
        [ranked[5], ranked[6], ranked[7], ranked[8], ranked[9]],
        [ranked[10], ranked[11], ranked[12]],
      ]);
      expect(new Set(collected).size).toBe(collected.length);
      expect([...collected].sort()).toEqual([...ranked].sort());
    });

    it('covers the set without duplicates when the pin ranks beyond the first window', async () => {
      const pin = ranked[6];
      mockWalk(pin);

      const { pages, collected } = await walkAllPages(5);

      expect(pages).toEqual([
        // The pin displaces one ranked record, so the page stops at ranked index 3.
        [pin, ranked[0], ranked[1], ranked[2], ranked[3]],
        // The pin ranks inside this window and is held back, not served twice.
        [ranked[4], ranked[5], ranked[7], ranked[8]],
        [ranked[9], ranked[10], ranked[11], ranked[12]],
      ]);
      expect(new Set(collected).size).toBe(collected.length);
      expect([...collected].sort()).toEqual([...ranked].sort());
    });

    it('covers the set without duplicates when there is no exact-descriptor match', async () => {
      mockWalk(undefined);

      const { pages, collected } = await walkAllPages(5);

      expect(pages).toEqual([ranked.slice(0, 5), ranked.slice(5, 10), ranked.slice(10, 13)]);
      expect(new Set(collected).size).toBe(collected.length);
      expect([...collected].sort()).toEqual([...ranked].sort());
    });

    it('keeps paging when a window holds nothing but the already-served pin', async () => {
      const pin = ranked[6];
      mockWalk(pin);

      const ctx = createMockContext({ errors: lookupMeshTool.errors });
      const result = await lookupMeshTool.handler(
        lookupMeshTool.input.parse({
          query: 'cancer',
          maxResults: 1,
          offset: 6,
          includeDetails: false,
        }),
        ctx,
      );

      expect(result.results).toEqual([]);
      // The rank slot is consumed, so the walk advances past it rather than stalling.
      expect(result.nextOffset).toBe(7);
      expect(getEnrichment(ctx).notice).toMatch(/^Offset 6 held only the exact match for `/);
      expect(getEnrichment(ctx).notice).toMatch(/Continue with offset 7/);
      // Not the overshoot guidance — there are more records to read.
      expect(getEnrichment(ctx).notice).not.toMatch(/Reset offset to 0/);
    });
  });

  describe('blank query rejection (issue #133)', () => {
    // ESearch on db=mesh answers a blank term with Count=0 and a WarningList,
    // which the tool used to report as "no MeSH descriptors matched" — a
    // result shape indistinguishable from a real term that matched nothing.
    it('rejects a whitespace-only query without calling ESearch', async () => {
      const ctx = createMockContext({ errors: lookupMeshTool.errors });
      const input = lookupMeshTool.input.parse({ query: '   ' });

      const promise = lookupMeshTool.handler(input, ctx);
      await expect(promise).rejects.toMatchObject({
        code: JsonRpcErrorCode.ValidationError,
        data: { reason: 'blank_query' },
      });
      expect(mockESearch).not.toHaveBeenCalled();
    });

    // `.trim()` keeps U+0085 and format characters such as U+200B.
    it.each([
      ['a next-line character (U+0085)', '\u0085'],
      ['a zero-width space', '​'],
      ['a word joiner between spaces', ' ⁠ '],
    ])('rejects a query of %s without calling ESearch', async (_label, query) => {
      const result = await runToolContract(lookupMeshTool, { query });

      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: {
          code: JsonRpcErrorCode.ValidationError,
          data: { reason: 'blank_query', retryable: false },
        },
      });
      expect(mockESearch).not.toHaveBeenCalled();
    });

    it('mirrors the reason and recovery hint onto both error surfaces', async () => {
      const result = await runToolContract(lookupMeshTool, { query: '   ' });

      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: { code: JsonRpcErrorCode.ValidationError, data: { reason: 'blank_query' } },
      });
      const text = textBlocks(result.content as ContentBlock[])
        .map((b) => b.text)
        .join('\n');
      expect(text).toMatch(/Recovery:/);
      expect(text).toMatch(/nonblank/i);
    });

    it('declares blank_query as a non-retryable input error', () => {
      expect(lookupMeshTool.errors?.find((e) => e.reason === 'blank_query')).toMatchObject({
        code: JsonRpcErrorCode.ValidationError,
        retryable: false,
      });
    });

    it('still resolves a legitimate query padded with whitespace', async () => {
      mockESearch.mockResolvedValue({ idList: ['68009369'], count: 1 });
      mockESummary.mockResolvedValue(summaryFor(['68009369']));
      const ctx = createMockContext({ errors: lookupMeshTool.errors });
      const result = await lookupMeshTool.handler(
        lookupMeshTool.input.parse({ query: '  covid  ' }),
        ctx,
      );

      expect(mockESearch.mock.calls[0]?.[0]?.term).toBe('  covid  ');
      expect(result.results).toHaveLength(1);
    });
  });

  it('formats output with the offset and next-page hint', () => {
    const blocks = textBlocks(
      lookupMeshTool.format!({
        query: 'Neoplasms',
        offset: 10,
        nextOffset: 20,
        results: [
          {
            entrezUid: '68009369',
            meshId: 'D009369',
            name: 'Neoplasms',
            scopeNote: 'New abnormal growth of tissue.',
            treeNumbers: ['C04'],
          },
        ],
      }),
    );
    expect(blocks[0]?.text).toBe(
      [
        '# MeSH Lookup: `Neoplasms`',
        'Found **1** result(s) at offset **10**.',
        'More available — call again with `offset: 20`.',
        '',
        '## Neoplasms',
        '- **MeSH ID:** D009369',
        '- **Entrez UID:** 68009369',
        '- **Tree Numbers:** C04',
        '- **Scope Note:** New abnormal growth of tissue.',
      ].join('\n'),
    );
  });

  it('renders empty results; the recovery notice is enrichment, not format output', () => {
    const blocks = textBlocks(
      lookupMeshTool.format!({
        query: 'xyznonexistent',
        offset: 0,
        results: [],
      }),
    );
    expect(blocks[0]?.text).toContain('Found **0** result(s) at offset **0**.');
    expect(blocks[0]?.text).not.toContain('offset:');
  });

  it('escapes the descriptor name, scope note and entry terms (issue #255)', () => {
    const text =
      textBlocks(
        lookupMeshTool.format!({
          query: 'x',
          offset: 0,
          results: [
            {
              entrezUid: '68009369',
              name: 'Neoplasms, *Second* Primary',
              scopeNote:
                'Growths of 10*8*6 mm; see [Tumors](https://evil.test) and <i>Neoplasia</i>.',
              entryTerms: ['_Tumor_', 'Cancer *A', 'B*'],
            },
          ],
        }),
      )[0]?.text ?? '';

    expect(text).toContain('\n## Neoplasms, \\*Second\\* Primary\n');
    expect(text).toContain(
      '- **Scope Note:** Growths of 10\\*8\\*6 mm; see \\[Tumors\\](https://evil.test) and \\<i>Neoplasia\\</i>.',
    );
    // Pairing is judged across the joined line: one `*` in each of two terms
    // would pair once rendered side by side.
    expect(text).toContain('- **Entry Terms:** \\_Tumor\\_; Cancer \\*A; B\\*');
  });

  describe('a query carrying Markdown-significant characters (issue #255)', () => {
    const query = 'neoplasm* AND <b>tumor</b>[MH] OR a_b_c_';

    it('echoes the query exactly in the heading, structuredContent unchanged', async () => {
      mockESearch.mockResolvedValue({ count: 0, retmax: 0, retstart: 0, idList: [] });
      const result = await runToolContract(lookupMeshTool, { query });

      expect((result.structuredContent as { query: string }).query).toBe(query);
      expect(textBlocks(result.content as ContentBlock[])[0]?.text).toContain(
        `# MeSH Lookup: \`${query}\`\n`,
      );
    });

    it.runIf(bunMarkdown !== undefined)('renders the query exactly', () => {
      const text = textBlocks(lookupMeshTool.format!({ query, offset: 0, results: [] }))[0]?.text;
      expect(renderedHtml(text ?? '').split('<h1').length - 1).toBe(1);
      expect(renderedText(text ?? '')).toContain(`MeSH Lookup: ${query} Found 0`);
    });
  });
});

describe('lookupMeshTool page-size clamp (#232)', () => {
  beforeEach(() => {
    mockESearch.mockReset();
    mockESummary.mockReset();
  });

  /** `count` ranked descriptors with no exact-heading match, paged by `retstart`/`retmax`. */
  function mockRanked(count: number): string[] {
    const ranked = Array.from({ length: count }, (_, i) => String(68100000 + i));
    mockESearch.mockImplementation(
      async (params: { term: string; retmax: number; retstart?: number }) => {
        if (params.term.endsWith('[MH]')) return { idList: [], count: 0 };
        const start = params.retstart ?? 0;
        return { idList: ranked.slice(start, start + params.retmax), count };
      },
    );
    mockESummary.mockImplementation(async (params: { id: string }) =>
      summaryFor(params.id.split(',')),
    );
    return ranked;
  }

  const CLAMPED = '`maxResults` 60 is past the per-call cap of 50, so it is served at 50.';
  const run = (args: { maxResults: number; offset?: number }) =>
    runToolContract(lookupMeshTool, { query: 'cancer', includeDetails: false, ...args });
  const rankedCall = () =>
    mockESearch.mock.calls.map((c) => c[0]).find((p) => !String(p.term).endsWith('[MH]'));
  const noticeOf = (result: Awaited<ReturnType<typeof runToolContract>>) =>
    (result.structuredContent as { notice?: string }).notice;
  const uidsOf = (result: Awaited<ReturnType<typeof runToolContract>>) =>
    (result.structuredContent as { results: { entrezUid: string }[] }).results.map(
      (r) => r.entrezUid,
    );

  it.each([
    [51, true],
    [500, true],
    [501, false],
    [0, false],
  ])('parses maxResults %d: %s', (maxResults, accepted) => {
    expect(lookupMeshTool.input.safeParse({ query: 'cancer', maxResults }).success).toBe(accepted);
  });

  it('rejects a maxResults past the ceiling with -32602 before any upstream call', async () => {
    const result = await run({ maxResults: 501 });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: { code: JsonRpcErrorCode.InvalidParams },
    });
    expect(
      textBlocks(result.content as ContentBlock[])
        .map((b) => b.text)
        .join('\n'),
    ).toContain('maxResults: Too big');
    expect(mockESearch).not.toHaveBeenCalled();
  });

  it('advertises the 500 ceiling and states the per-call cap', () => {
    const schema = z.toJSONSchema(lookupMeshTool.input, { io: 'input' }) as unknown as {
      properties: Record<string, Record<string, unknown>>;
    };
    expect(schema.properties.maxResults).toMatchObject({
      type: 'integer',
      minimum: 1,
      maximum: 500,
      default: 10,
    });
    expect(schema.properties.maxResults?.description).toContain('up to 50 per call');
  });

  it('asks ESearch for 50 and names nextOffset on both surfaces; following it reads the next 50', async () => {
    const ranked = mockRanked(120);

    const first = await run({ maxResults: 60 });

    expect(rankedCall()).toMatchObject({ retmax: 50, retstart: 0 });
    expect(uidsOf(first)).toEqual(ranked.slice(0, 50));
    expect(first.structuredContent).toMatchObject({ nextOffset: 50 });
    const notice = `${CLAMPED} Pass \`offset: 50\`, this page's \`nextOffset\`, for the next page.`;
    expect(noticeOf(first)).toBe(notice);
    expect(
      textBlocks(first.content as ContentBlock[])
        .map((b) => b.text)
        .join('\n'),
    ).toContain(`> ${notice}`);

    mockESearch.mockClear();
    const second = await run({ maxResults: 60, offset: 50 });

    expect(rankedCall()).toMatchObject({ retmax: 50, retstart: 50 });
    expect(uidsOf(second)).toEqual(ranked.slice(50, 100));
  });

  it('names no continuation when every result fits', async () => {
    mockRanked(30);

    const result = await run({ maxResults: 60 });

    expect(uidsOf(result)).toHaveLength(30);
    expect(result.structuredContent).not.toHaveProperty('nextOffset');
    expect(noticeOf(result)).toBe(CLAMPED);
  });

  it.each([
    [
      'no-match',
      0,
      0,
      'No MeSH records matched `cancer`. Try `pubmed_spell_check` for a suggested correction, broaden the term, or use `pubmed_search_articles` for free-text discovery against article metadata.',
    ],
    [
      'overshoot',
      30,
      100,
      'Offset 100 returned no records — `cancer` matches 30 MeSH record(s). Reset offset to 0 or lower it below 30.',
    ],
  ])('joins the %s notice', async (_kind, count, offset, sentence) => {
    mockRanked(count);

    const result = await run({ maxResults: 60, offset });

    expect(noticeOf(result)).toBe(`${CLAMPED} ${sentence}`);
  });

  it('sends the same request with no notice at the cap itself', async () => {
    const ranked = mockRanked(120);

    const result = await run({ maxResults: 50 });

    expect(rankedCall()).toMatchObject({ retmax: 50, retstart: 0 });
    expect(uidsOf(result)).toEqual(ranked.slice(0, 50));
    expect(result.structuredContent).toMatchObject({ nextOffset: 50 });
    expect(noticeOf(result)).toBeUndefined();
  });
});

describe('lookupMeshTool record type, search term, and heading details (#282, #294, #296)', () => {
  beforeEach(() => {
    mockESearch.mockReset();
    mockESummary.mockReset();
  });

  /**
   * `exact` answers the `<query>[MH]` search, `ranked` the broad one (paged by
   * `retstart`/`retmax`); eSummary serves the captured record for each UID asked.
   */
  function mockPage(exact: string[], ranked: string[]) {
    mockESearch.mockImplementation(
      async (params: { term: string; retmax: number; retstart?: number }) => {
        if (params.term.endsWith('[MH]')) {
          return { idList: exact.slice(0, params.retmax), count: exact.length };
        }
        const start = params.retstart ?? 0;
        return { idList: ranked.slice(start, start + params.retmax), count: ranked.length };
      },
    );
    mockESummary.mockImplementation(async (params: { id: string }) =>
      summaryFor(params.id.split(',')),
    );
  }

  const resultsOf = (result: Awaited<ReturnType<typeof runToolContract>>) =>
    (result.structuredContent as { results: Record<string, unknown>[] }).results;
  const textOf = (result: Awaited<ReturnType<typeof runToolContract>>) =>
    textBlocks(result.content as ContentBlock[])
      .map((b) => b.text)
      .join('\n');
  /** The rendered block of one record: its name and the list lines under it, up to the next blank line. */
  const blockOf = (text: string, entrezUid: string) =>
    text
      .split('\n\n## ')
      .find((block) => `${block}\n`.includes(`- **Entrez UID:** ${entrezUid}\n`))
      ?.split('\n\n')[0];
  /** Anti-Bacterial Agents' allowable subheadings, as its restored fixture lists them. */
  const ANTI_BACTERIAL_SUBHEADINGS = [
    'administration and dosage',
    'adverse effects',
    'analysis',
    'biosynthesis',
    'blood',
    'cerebrospinal fluid',
    'chemical synthesis',
    'chemistry',
    'classification',
    'economics',
    'history',
    'immunology',
    'isolation and purification',
    'metabolism',
    'pharmacokinetics',
    'pharmacology',
    'poisoning',
    'radiation effects',
    'standards',
    'supply and distribution',
    'therapeutic use',
    'toxicity',
    'urine',
  ];

  it('omits tree numbers without includeDetails for every record type, in one eSummary', async () => {
    // A descriptor, a qualifier, a pharmacological-action record and an SCR, each
    // carrying a TreeNum in its summary.
    mockPage([], ['68009369', '2016178', '82000900', '67585596']);

    const result = await runToolContract(lookupMeshTool, {
      query: 'mixed types',
      includeDetails: false,
    });

    const results = resultsOf(result);
    expect(results.map((r) => r.entrezUid)).toEqual([
      '68009369',
      '2016178',
      '82000900',
      '67585596',
    ]);
    for (const record of results) expect(record).not.toHaveProperty('treeNumbers');
    expect(textOf(result)).not.toContain('Tree Numbers');
    expect(mockESummary).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])(
    'labels a supplementary concept and gives its [nm] search term (includeDetails: %s)',
    async (includeDetails) => {
      mockPage([], ['67585596']);

      const result = await runToolContract(lookupMeshTool, { query: 'jentadueto', includeDetails });

      expect(resultsOf(result)[0]).toMatchObject({
        entrezUid: '67585596',
        recordType: 'supplemental-record',
        searchTerm: '"Jentadueto"[nm]',
      });
      expect(textOf(result)).toContain(
        '\n## Jentadueto\n- **Record Type:** supplemental-record\n- **Search Term:** `"Jentadueto"[nm]`\n- **MeSH ID:** C585596\n',
      );
      expect(mockESummary).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    // A publication type is a descriptor in the V tree; [mh] matches it nowhere.
    ['68016449', 'descriptor', '"Randomized Controlled Trial"[pt]', true],
    ['68009369', 'descriptor', '"Neoplasms"[mh]', true],
    ['2025952', 'supplemental-record', '"tisagenlecleucel"[nm]', false],
    ['81000009', 'qualifier', '"adverse effects"[sh]', true],
    ['82000019', 'pharmacological-action', '"Abortifacient Agents"[pa]', false],
  ])('labels %s as %s, searched by %s, with or without details', async (uid, type, term, trees) => {
    for (const includeDetails of [false, true]) {
      mockESummary.mockClear();
      mockPage([], [uid]);

      const result = await runToolContract(lookupMeshTool, { query: 'record', includeDetails });

      const [record] = resultsOf(result);
      expect(record).toMatchObject({ entrezUid: uid, recordType: type, searchTerm: term });
      // The V check reads tree numbers on every call; they reach the record only with details.
      expect(record?.treeNumbers !== undefined).toBe(includeDetails && trees);
      expect(blockOf(textOf(result), uid)).toContain(
        `- **Record Type:** ${type}\n- **Search Term:** \`${term}\`\n`,
      );
      expect(mockESummary).toHaveBeenCalledTimes(1);
    }
  });

  it('reads the search term back from content[] as one code span', async () => {
    mockPage([], ['68016449']);

    const result = await runToolContract(lookupMeshTool, { query: 'rct', includeDetails: false });

    expect(readCommonMark(textOf(result))).toContain(
      '⟨strong⟩Search Term:⟨/strong⟩ ⟨code_inline:"Randomized Controlled Trial"[pt]⟩',
    );
  });

  it('labels a drug-class heading’s pharmacological-action record after its pinned descriptor', async () => {
    mockPage(['82000900', '68000900'], ['82000900', '68000900']);

    const result = await runToolContract(lookupMeshTool, { query: 'Anti-Bacterial Agents' });

    const results = resultsOf(result);
    expect(results.map((r) => [r.entrezUid, r.recordType, r.searchTerm])).toEqual([
      ['68000900', 'descriptor', '"Anti-Bacterial Agents"[mh]'],
      ['82000900', 'pharmacological-action', '"Anti-Bacterial Agents"[pa]'],
    ]);
    expect(results[1]).not.toHaveProperty('treeNumbers');
    expect(blockOf(textOf(result), '82000900')).toBe(
      'Anti-Bacterial Agents\n- **Record Type:** pharmacological-action\n- **Search Term:** `"Anti-Bacterial Agents"[pa]`\n- **MeSH ID:** D000900\n- **Entrez UID:** 82000900\n- **Entry Terms:** Anti-Bacterial Agents',
    );
    expect(mockESummary).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['an empty record type', ''],
    ['an unrecognized record type', 'mystery-record'],
  ])('gives %s no search term, and an empty one no record type', async (_label, recordType) => {
    mockPage([], ['68000001', '68009369']);
    mockESummary.mockImplementation(async () =>
      parseSummary([
        meshDoc('68000001', { terms: ['Odd Record'], recordType }),
        docFor('68009369'),
      ]),
    );

    const result = await runToolContract(lookupMeshTool, { query: 'odd', includeDetails: false });

    const [odd, neoplasms] = resultsOf(result);
    // The same summary labeled its other record.
    expect(neoplasms).toMatchObject({ recordType: 'descriptor', searchTerm: '"Neoplasms"[mh]' });
    expect(odd).toEqual({
      entrezUid: '68000001',
      meshId: 'D000001',
      name: 'Odd Record',
      ...(recordType ? { recordType } : {}),
    });
    const block = blockOf(textOf(result), '68000001');
    expect(block).toBe(
      `Odd Record\n${recordType ? `- **Record Type:** ${recordType}\n` : ''}- **MeSH ID:** D000001\n- **Entrez UID:** 68000001`,
    );
    expect(block).not.toContain('Search Term');
  });

  it('builds no search term from the UID of a typed record that names no term', async () => {
    mockPage([], ['68000001']);
    mockESummary.mockImplementation(async () => parseSummary([meshDoc('68000001', { terms: [] })]));

    const result = await runToolContract(lookupMeshTool, {
      query: 'unnamed',
      includeDetails: false,
    });

    // The record falls back to its UID as its name, never as a heading to search.
    expect(resultsOf(result)).toEqual([
      { entrezUid: '68000001', meshId: 'D000001', name: '68000001', recordType: 'descriptor' },
    ]);
    expect(textOf(result)).not.toContain('Search Term');
  });

  it('gives the pinned heading its subheadings and every result its year and previous indexing', async () => {
    // The descriptor is the second exact match, behind its pharmacological-action record.
    mockPage(['82000900', '68000900'], ['82000900', '68000900', '68000019']);

    const result = await runToolContract(lookupMeshTool, { query: 'Anti-Bacterial Agents' });

    const results = resultsOf(result);
    expect(results.map((r) => r.entrezUid)).toEqual(['68000900', '82000900', '68000019']);
    expect(results[0]).toMatchObject({
      yearIntroduced: '2004(1963)',
      subheadings: ANTI_BACTERIAL_SUBHEADINGS,
    });
    expect(results[0]).not.toHaveProperty('previousIndexing');
    // Empty year, previous-indexing and subheading elements omit their fields.
    expect(results[1]).toEqual({
      entrezUid: '82000900',
      meshId: 'D000900',
      name: 'Anti-Bacterial Agents',
      recordType: 'pharmacological-action',
      searchTerm: '"Anti-Bacterial Agents"[pa]',
      entryTerms: ['Anti-Bacterial Agents'],
    });
    expect(results[2]).toMatchObject({
      yearIntroduced: '1975',
      previousIndexing: ['Abortion, Induced (1970-1974)'],
    });
    expect(results[2]).not.toHaveProperty('subheadings');

    const text = textOf(result);
    expect(blockOf(text, '68000900')).toMatch(
      new RegExp(
        `\\n- \\*\\*Year Introduced:\\*\\* 2004\\(1963\\)\\n- \\*\\*Subheadings:\\*\\* ${ANTI_BACTERIAL_SUBHEADINGS.join(', ')}$`,
      ),
    );
    expect(blockOf(text, '68000019')).toMatch(
      /\n- \*\*Year Introduced:\*\* 1975\n- \*\*Previous Indexing:\*\* Abortion, Induced \(1970-1974\)$/,
    );
    expect(text.match(/- \*\*Subheadings:\*\*/g)).toHaveLength(1);
    expect(mockESummary).toHaveBeenCalledTimes(1);
  });

  it('pins a lone exact match without a record-type read and still gives it its subheadings', async () => {
    mockPage(['68000900'], ['68000001', '68000900']);

    const result = await runToolContract(lookupMeshTool, { query: 'Anti-Bacterial Agents' });

    expect(resultsOf(result)[0]).toMatchObject({
      entrezUid: '68000900',
      subheadings: ANTI_BACTERIAL_SUBHEADINGS,
    });
    expect(mockESummary).toHaveBeenCalledTimes(1);
    expect(mockESummary).toHaveBeenCalledWith(
      { db: 'mesh', id: '68000900,68000001', version: '2.0' },
      expect.anything(),
    );
  });

  it('gives the pinned heading its subheadings when the query is one of its entry terms', async () => {
    // `Antibiotics[MH]` resolves the entry term to its heading, named otherwise.
    mockPage(['68000900'], ['68000019', '68000900']);

    const result = await runToolContract(lookupMeshTool, { query: 'Antibiotics' });

    const results = resultsOf(result);
    expect(results.map((r) => r.entrezUid)).toEqual(['68000900', '68000019']);
    expect(results[0]).toMatchObject({
      name: 'Anti-Bacterial Agents',
      subheadings: ANTI_BACTERIAL_SUBHEADINGS,
    });
    expect(results[1]).not.toHaveProperty('subheadings');
    expect(blockOf(textOf(result), '68000900')).toContain(
      `\n- **Subheadings:** ${ANTI_BACTERIAL_SUBHEADINGS.join(', ')}`,
    );
  });

  it.each([
    ['no exact match', []],
    ['another heading pinned', ['68000019']],
  ])('gives an unpinned record its year but no subheadings (%s)', async (_label, exact) => {
    mockPage(exact, ['68000019', '68000900']);

    const result = await runToolContract(lookupMeshTool, { query: 'agents' });

    const antiBacterial = resultsOf(result).find((r) => r.entrezUid === '68000900');
    // The record was reached with its details read.
    expect(antiBacterial).toMatchObject({ yearIntroduced: '2004(1963)' });
    expect(antiBacterial).not.toHaveProperty('subheadings');
    expect(textOf(result)).not.toContain('Subheadings');
    expect(mockESummary).toHaveBeenCalledTimes(1);
  });

  it('gives a field-tagged query no subheadings, since it pins nothing', async () => {
    mockPage(['82000900', '68000900'], ['82000900', '68000900']);

    const result = await runToolContract(lookupMeshTool, { query: 'Anti-Bacterial Agents[MH]' });

    expect(mockESearch).toHaveBeenCalledTimes(1);
    const descriptor = resultsOf(result).find((r) => r.entrezUid === '68000900');
    expect(descriptor).toMatchObject({ yearIntroduced: '2004(1963)' });
    expect(descriptor).not.toHaveProperty('subheadings');
  });

  it('drops the year, previous indexing and subheadings with includeDetails: false', async () => {
    mockPage(['82000900', '68000900'], ['82000900', '68000900', '68000019']);

    const result = await runToolContract(lookupMeshTool, {
      query: 'Anti-Bacterial Agents',
      includeDetails: false,
    });

    const results = resultsOf(result);
    expect(results.map((r) => r.entrezUid)).toEqual(['68000900', '82000900', '68000019']);
    for (const record of results) {
      expect(record).toHaveProperty('searchTerm');
      for (const field of ['yearIntroduced', 'previousIndexing', 'subheadings']) {
        expect(record).not.toHaveProperty(field);
      }
    }
    expect(textOf(result)).not.toMatch(/Year Introduced|Previous Indexing|Subheadings/);
    expect(mockESummary).toHaveBeenCalledTimes(1);
  });

  it('serves subheadings on the first page only across a full offset walk', async () => {
    const ranked = ['68000001', '68000900', '68000002', '68000003', '68000004'];
    mockPage(['68000900'], ranked);
    // A ranked record whose summary lists one subheading, which parses to a scalar.
    mockESummary.mockImplementation(async (params: { id: string }) =>
      parseSummary(
        params.id
          .split(',')
          .map((uid) =>
            uid === '68000003' ? meshDoc(uid, { subheadings: ['blood'] }) : docFor(uid),
          ),
      ),
    );

    const pages: { uid: unknown; subheadings: unknown }[][] = [];
    let offset: number | undefined = 0;
    while (offset !== undefined) {
      if (pages.length > ranked.length) throw new Error('pagination did not terminate');
      const result: Awaited<ReturnType<typeof runToolContract>> = await runToolContract(
        lookupMeshTool,
        { query: 'Anti-Bacterial Agents', maxResults: 2, offset },
      );
      pages.push(resultsOf(result).map((r) => ({ uid: r.entrezUid, subheadings: r.subheadings })));
      offset = (result.structuredContent as { nextOffset?: number }).nextOffset;
    }

    expect(pages).toEqual([
      [
        { uid: '68000900', subheadings: ANTI_BACTERIAL_SUBHEADINGS },
        { uid: '68000001', subheadings: undefined },
      ],
      [
        { uid: '68000002', subheadings: undefined },
        { uid: '68000003', subheadings: undefined },
      ],
      [{ uid: '68000004', subheadings: undefined }],
    ]);
  });

  it('reads a one-entry subheading or previous-indexing list, which parses to a scalar', async () => {
    mockPage(['68000001'], ['68000001']);
    mockESummary.mockImplementation(async (params: { id: string }) =>
      parseSummary(
        params.id.split(',').map((uid) =>
          meshDoc(uid, {
            subheadings: ['blood'],
            previousIndexing: ['Older Heading (1966-1999)'],
          }),
        ),
      ),
    );

    const result = await runToolContract(lookupMeshTool, { query: 'Descriptor 68000001' });

    expect(resultsOf(result)).toEqual([
      expect.objectContaining({
        entrezUid: '68000001',
        subheadings: ['blood'],
        previousIndexing: ['Older Heading (1966-1999)'],
      }),
    ]);
  });

  it('renders every new field in order, escaping NLM text but not the search clause', () => {
    const text =
      textBlocks(
        lookupMeshTool.format!({
          query: 'x',
          offset: 0,
          results: [
            {
              entrezUid: '68054144',
              meshId: 'D054144',
              name: 'Heart Failure, Diastolic',
              recordType: 'descriptor',
              searchTerm: '"Heart Failure, Diastolic"[mh]',
              entryTerms: ['Heart Failure, Diastolic'],
              yearIntroduced: '2008',
              previousIndexing: [
                'Heart Failure, Congestive (1989-2007)',
                'Cardiac *Failure* (1966-1988)',
              ],
              subheadings: ['blood', 'drug therapy'],
            },
          ],
        }),
      )[0]?.text ?? '';

    expect(text).toContain(
      [
        '## Heart Failure, Diastolic',
        '- **Record Type:** descriptor',
        '- **Search Term:** `"Heart Failure, Diastolic"[mh]`',
        '- **MeSH ID:** D054144',
        '- **Entrez UID:** 68054144',
        '- **Entry Terms:** Heart Failure, Diastolic',
        '- **Year Introduced:** 2008',
        '- **Previous Indexing:** Heart Failure, Congestive (1989-2007); Cardiac \\*Failure\\* (1966-1988)',
        '- **Subheadings:** blood, drug therapy',
      ].join('\n'),
    );
  });

  it('gives every result at the page-size cap a record type and search term', async () => {
    const ranked = Array.from({ length: 120 }, (_, i) => String(68100000 + i));
    mockPage([], ranked);

    const result = await runToolContract(lookupMeshTool, {
      query: 'cancer',
      maxResults: 60,
      includeDetails: false,
    });

    const results = resultsOf(result);
    expect(results).toHaveLength(50);
    expect(results.every((r) => r.recordType === 'descriptor')).toBe(true);
    expect(textOf(result).match(/- \*\*Search Term:\*\* `"Descriptor \d+"\[mh\]`/g)).toHaveLength(
      50,
    );
  });

  describe('the pinned exact match is the record the query names', () => {
    /**
     * db=mesh ESearch as NCBI answers it: an unquoted `<query>[MH]` is translated (an
     * entry term maps to its heading; `Randomized Controlled Trial[MH]` reads as
     * `"randomized controlled trials as topic"[MeSH Terms]`), a quoted `"<query>"[MH]`
     * matches the heading it names, and a term holding both answers their union by
     * descending UID. The broad search, the query as sent, pages `ranked`.
     */
    function mockMesh(
      query: string,
      shape: { translated: string[]; literal: string[]; ranked: string[] },
    ) {
      mockESearch.mockImplementation(
        async (params: { term: string; retmax: number; retstart?: number }) => {
          if (params.term === query) {
            const start = params.retstart ?? 0;
            return {
              idList: shape.ranked.slice(start, start + params.retmax),
              count: shape.ranked.length,
            };
          }
          const literal = `"${query.trim()}"[MH]`;
          const matched = new Set([
            ...(params.term.replace(literal, '').includes(`${query}[MH]`) ? shape.translated : []),
            ...(params.term.includes(literal) ? shape.literal : []),
          ]);
          const idList = [...matched].sort((a, b) => Number(b) - Number(a));
          return { idList: idList.slice(0, params.retmax), count: idList.length };
        },
      );
      mockESummary.mockImplementation(async (params: { id: string }) =>
        summaryFor(params.id.split(',')),
      );
    }

    const exactTermFor = (query: string) =>
      mockESearch.mock.calls.map((c) => c[0].term as string).find((term) => term !== query);
    const uidsOf = (result: Awaited<ReturnType<typeof runToolContract>>) =>
      resultsOf(result).map((r) => r.entrezUid);

    /** The ESearch answers for `Randomized Controlled Trial`, captured 2026-11-10. */
    const RCT = {
      translated: ['68016032'],
      literal: ['68016449'],
      ranked: ['68018848', '68016449', '68016032', '67533972', '67482279', '2031098', '2023172'],
    };
    /** The ESearch answers for `Drug Therapy` and `drug therapy` alike, captured 2026-11-10. */
    const DRUG_THERAPY = {
      translated: ['81000188', '68004358'],
      literal: ['81000188', '68004358'],
      ranked: [
        '81000188',
        '68059250',
        '68054539',
        '68020551',
        '68017024',
        '68004360',
        '68004359',
        '68004358',
        '68000280',
        '2103232',
      ],
    };
    const DRUG_THERAPY_SUBHEADINGS = [
      'classification',
      'economics',
      'ethics',
      'history',
      'instrumentation',
      'methods',
      'mortality',
      'nursing',
      'psychology',
      'standards',
      'statistics and numerical data',
      'trends',
      'veterinary',
    ];

    it('searches a query holding a double quote as `<query>[MH]` alone', async () => {
      mockMesh('"heart attack"', { translated: ['68009203'], literal: [], ranked: ['68009203'] });

      const result = await runToolContract(lookupMeshTool, {
        query: '"heart attack"',
        includeDetails: false,
      });

      expect(exactTermFor('"heart attack"')).toBe('"heart attack"[MH]');
      expect(uidsOf(result)).toEqual(['68009203']);
    });

    it('pins nothing when neither the literal nor the translated heading matches', async () => {
      mockMesh('Jentadueto', { translated: [], literal: [], ranked: ['67585596'] });

      const result = await runToolContract(lookupMeshTool, { query: 'Jentadueto' });

      expect(resultsOf(result)).toEqual([
        expect.objectContaining({ entrezUid: '67585596', searchTerm: '"Jentadueto"[nm]' }),
      ]);
      expect(resultsOf(result)[0]).not.toHaveProperty('subheadings');
      expect(mockESummary).toHaveBeenCalledTimes(1);
    });

    /*
     * Each candidate set is ranked off the first window (`maxResults: 1`), so the
     * page holds the pin alone: the record chosen, not one the ranked list placed.
     */
    it.each([
      [
        'the first descriptor when no candidate is named as the query',
        'agents',
        ['68000900', '68000019'],
        '68000900',
      ],
      [
        'the first non-pharmacological-action record when no candidate is a descriptor',
        'agents',
        ['82000900', '81000009'],
        '81000009',
      ],
      [
        'a descriptor over a pharmacological-action record named as the query',
        'Anti-Bacterial Agents',
        ['82000900', '68000019'],
        '68000019',
      ],
      [
        'the first candidate when every one is a pharmacological-action record',
        'agents',
        ['82000900', '82000019'],
        '82000900',
      ],
      [
        'a descriptor named as the query over an earlier descriptor named otherwise',
        'Randomized Controlled Trial',
        ['68018848', '68016449'],
        '68016449',
      ],
      [
        'a qualifier named as the query over an earlier descriptor named otherwise',
        'Diagnostic Imaging',
        ['68009369', '2016178'],
        '2016178',
      ],
    ])('pins %s', async (_label, query, exact, pinned) => {
      mockMesh(query, { translated: exact, literal: [], ranked: ['68100001', ...exact] });

      const result = await runToolContract(lookupMeshTool, {
        query,
        maxResults: 1,
        includeDetails: false,
      });

      expect(uidsOf(result)).toEqual([pinned]);
      expect(mockESummary).toHaveBeenCalledTimes(1);
    });

    it('pins the publication type a query names over the topic heading it translates to', async () => {
      mockMesh('Randomized Controlled Trial', RCT);

      const result = await runToolContract(lookupMeshTool, {
        query: 'Randomized Controlled Trial',
      });

      expect(uidsOf(result)).toEqual([
        '68016449',
        '68018848',
        '68016032',
        '67533972',
        '67482279',
        '2031098',
        '2023172',
      ]);
      const [named, , topic] = resultsOf(result);
      expect(named).toMatchObject({
        name: 'Randomized Controlled Trial',
        recordType: 'descriptor',
        searchTerm: '"Randomized Controlled Trial"[pt]',
      });
      // The topic heading lists eleven subheadings; unpinned, it carries none of them.
      expect(topic).toMatchObject({ name: 'Randomized Controlled Trials as Topic' });
      expect(topic).not.toHaveProperty('subheadings');
      const text = textOf(result);
      expect(text.split('\n\n## ')[1]).toMatch(
        /^Randomized Controlled Trial\n- \*\*Record Type:\*\* descriptor\n- \*\*Search Term:\*\* `"Randomized Controlled Trial"\[pt\]`\n/,
      );
      expect(text).not.toContain('Subheadings');
      // The literal and the translated heading ride one exact search.
      expect(exactTermFor('Randomized Controlled Trial')).toBe(
        '(Randomized Controlled Trial[MH]) OR "Randomized Controlled Trial"[MH]',
      );
      expect(mockESearch).toHaveBeenCalledTimes(2);
      expect(mockESummary).toHaveBeenCalledTimes(1);
    });

    it.each([
      [{ maxResults: 1 }, ['68016449'], undefined, /^The exact match filled this page of 1\. /],
      [{ maxResults: 2 }, ['68016449', '68018848'], 2, undefined],
      // The named record ranks in this window and is held back, not served twice.
      [{ maxResults: 2, offset: 1 }, ['68016032'], 3, undefined],
      [{ maxResults: 2, offset: 7 }, [], undefined, /^Offset 7 returned no records/],
      [
        { maxResults: 60 },
        ['68016449', '68018848', '68016032', '67533972', '67482279', '2031098', '2023172'],
        undefined,
        /served at 50\.$/,
      ],
    ])(
      'serves the named record on the first page only (%o)',
      async (args, uids, nextOffset, notice) => {
        mockMesh('Randomized Controlled Trial', RCT);

        const result = await runToolContract(lookupMeshTool, {
          query: 'Randomized Controlled Trial',
          includeDetails: false,
          ...args,
        });

        expect(uidsOf(result)).toEqual(uids);
        const structured = result.structuredContent as { nextOffset?: number; notice?: string };
        expect(structured.nextOffset).toBe(nextOffset);
        if (notice) expect(structured.notice).toMatch(notice);
        else expect(structured.notice).toBeUndefined();
      },
    );

    it('walks every record once, the named one on the first page, from offset to nextOffset', async () => {
      mockMesh('Randomized Controlled Trial', RCT);

      const pages: unknown[][] = [];
      let offset: number | undefined = 0;
      while (offset !== undefined) {
        if (pages.length > RCT.ranked.length) throw new Error('pagination did not terminate');
        const result: Awaited<ReturnType<typeof runToolContract>> = await runToolContract(
          lookupMeshTool,
          { query: 'Randomized Controlled Trial', maxResults: 2, offset, includeDetails: false },
        );
        pages.push(uidsOf(result));
        offset = (result.structuredContent as { nextOffset?: number }).nextOffset;
      }

      expect(pages).toEqual([
        ['68016449', '68018848'],
        ['68016032', '67533972'],
        ['67482279', '2031098'],
        ['2023172'],
      ]);
      expect([...pages.flat()].sort()).toEqual([...RCT.ranked].sort());
    });

    it.each(['Drug Therapy', 'drug therapy'])(
      'pins the descriptor `%s` names over the qualifier of that name, with its subheadings',
      async (query) => {
        mockMesh(query, DRUG_THERAPY);

        const result = await runToolContract(lookupMeshTool, { query, maxResults: 3 });

        const results = resultsOf(result);
        expect(results.map((r) => [r.entrezUid, r.recordType])).toEqual([
          ['68004358', 'descriptor'],
          ['81000188', 'qualifier'],
          ['68059250', 'descriptor'],
        ]);
        expect(results[0]).toMatchObject({
          name: 'Drug Therapy',
          searchTerm: '"Drug Therapy"[mh]',
          subheadings: DRUG_THERAPY_SUBHEADINGS,
        });
        expect(results[1]).not.toHaveProperty('subheadings');
        expect(blockOf(textOf(result), '68004358')).toMatch(
          new RegExp(`\\n- \\*\\*Subheadings:\\*\\* ${DRUG_THERAPY_SUBHEADINGS.join(', ')}$`),
        );
        expect(textOf(result).match(/- \*\*Subheadings:\*\*/g)).toHaveLength(1);
        // The pin sits outside the ranked window and displaces one ranked record.
        expect((result.structuredContent as { nextOffset?: number }).nextOffset).toBe(2);
        expect(mockESummary).toHaveBeenCalledTimes(1);
      },
    );

    it('quotes the query without its padding and still pins the record it names', async () => {
      const query = '  Randomized Controlled Trial  ';
      mockMesh(query, RCT);

      const result = await runToolContract(lookupMeshTool, {
        query,
        maxResults: 2,
        includeDetails: false,
      });

      expect(uidsOf(result)).toEqual(['68016449', '68018848']);
      expect(exactTermFor(query)).toBe(
        '(  Randomized Controlled Trial  [MH]) OR "Randomized Controlled Trial"[MH]',
      );
    });
  });
});

/**
 * A caller abort at each upstream step rethrows the abort, never a page built
 * without the step. The handler is called directly: `runToolContract` settles
 * any result after an abort, a success included, as `RequestCancelled`, so it
 * cannot tell a rethrow from a degraded success. Every other call is stubbed to
 * answer, so a step that swallowed the abort would return a page.
 */
describe('lookupMeshTool caller cancellation', () => {
  beforeEach(() => {
    mockESearch.mockReset();
    mockESummary.mockReset();
    mockESummary.mockImplementation(async (params: { id: string }) =>
      summaryFor(params.id.split(',')),
    );
  });

  /**
   * A caller cancellation. `cancel` stands in for the upstream call it lands
   * on: it aborts the request's signal, then rejects with the abort reason, as
   * the NCBI service does on a caller abort.
   */
  const cancellation = () => {
    const controller = new AbortController();
    const reason = new DOMException('The caller cancelled the request.', 'AbortError');
    const cancel = () => {
      controller.abort(reason);
      return Promise.reject(reason);
    };
    return { cancel, reason, signal: controller.signal };
  };

  const run = (signal: AbortSignal) =>
    lookupMeshTool.handler(
      lookupMeshTool.input.parse({ query: 'Asthma' }),
      createMockContext({ errors: lookupMeshTool.errors, signal }),
    );

  /** ESearch answering the exact-match query with `exact` and the ranked query with `ranked`. */
  const searches = (exact: string[], ranked: string[]) =>
    mockESearch.mockImplementation(async (params: { term: string }) =>
      params.term.endsWith('[MH]')
        ? { idList: exact, count: exact.length }
        : { idList: ranked, count: ranked.length },
    );

  it('during the exact-match ESearch, while the ranked one answers: builds no page', async () => {
    const { cancel, reason, signal } = cancellation();
    mockESearch.mockImplementation((params: { term: string }) =>
      params.term.endsWith('[MH]')
        ? cancel()
        : Promise.resolve({ idList: ['68001249', '68009999'], count: 2 }),
    );

    await expect(run(signal)).rejects.toBe(reason);
    expect(mockESummary).not.toHaveBeenCalled();
  });

  it('during the record-type read of several exact matches: reads no page summaries', async () => {
    const { cancel, reason, signal } = cancellation();
    searches(['68001249', '68020000'], ['68001249', '68009999']);
    mockESummary.mockImplementationOnce(cancel);

    await expect(run(signal)).rejects.toBe(reason);
    expect(mockESummary).toHaveBeenCalledOnce();
  });

  it('during the page ESummary: returns no rows without their records', async () => {
    const { cancel, reason, signal } = cancellation();
    searches(['68001249'], ['68001249', '68009999']);
    mockESummary.mockImplementation(cancel);

    await expect(run(signal)).rejects.toBe(reason);
  });
});
