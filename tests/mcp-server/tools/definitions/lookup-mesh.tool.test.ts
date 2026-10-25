/**
 * @fileoverview Tests for the lookup-mesh tool.
 * @module tests/mcp-server/tools/definitions/lookup-mesh.tool.test
 */

import type { ContentBlock } from '@cyanheads/mcp-ts-core';
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
  } = {},
): string {
  const links = treeNums
    .map(
      (t) =>
        `\t\t<LinksType>\n\t\t\t<Parent>1000067</Parent>\n\t\t\t<TreeNum>${t}</TreeNum>\n\t\t\t<Children>\n\t\t\t</Children>\n\t\t</LinksType>\n`,
    )
    .join('');
  return [
    `<DocumentSummary uid="${uid}">`,
    `\t<DS_ScopeNote>${scopeNote}</DS_ScopeNote>`,
    '\t<DS_MeshTerms>',
    ...terms.map((t) => `\t\t<string>${t}</string>`),
    '\t</DS_MeshTerms>',
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
      /^No MeSH descriptors matched `zz\*qx zz\*qy`\. /,
    );
    const text = textBlocks(result.content as ContentBlock[])
      .map((b) => b.text)
      .join('\n');
    expect(readCommonMark(text)).toContain(
      'No MeSH descriptors matched ⟨code_inline:zz*qx zz*qy⟩. Try ⟨code_inline:pubmed_spell_check⟩',
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
      { db: 'mesh', term: 'Neoplasms[MH]', retmax: 5 },
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
      { entrezUid: '68009369', meshId: 'D009369', name: 'Neoplasms' },
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
        { entrezUid: '68009369', meshId: 'D009369', name: 'Neoplasms' },
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
          scopeNote:
            'Used with drugs, chemicals, or biological agents in accepted dosage - or with physical agents or manufactured products in normal usage - when intended for diagnostic, therapeutic, prophylactic, or anesthetic purposes. It is used also for adverse effects or complications of diagnostic, therapeutic, prophylactic, anesthetic, surgical, or other procedures.',
          entryTerms: ['adverse effects', 'side effects'],
          treeNumbers: ['Y07.020', 'Y10.020'],
        },
        {
          entrezUid: '68000019',
          meshId: 'D000019',
          name: 'Abortifacient Agents',
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
          scopeNote:
            'anti-CD19 chimeric antigen receptor (CAR) T-cell therapy for treatment of B-Cell lymphoblastic leukemia',
          entryTerms: ['tisagenlecleucel', 'CTL019', 'KYMRIAH'],
        },
        {
          // One entry term parses to a scalar; the @-pointer TreeNum is dropped (#76).
          entrezUid: '67585596',
          meshId: 'C585596',
          name: 'Jentadueto',
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
        { entrezUid: '68009369', meshId: 'D009369', name: 'Neoplasms' },
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
        '## Neoplasms\n- **MeSH ID:** D009369\n- **Entrez UID:** 68009369\n\n## 99999999\n- **Entrez UID:** 99999999',
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
        `\n## ${heading}\n- **MeSH ID:** ${descriptor.meshId}\n- **Entrez UID:** ${descriptorUid}\n${treeLine}\n- **Scope Note:** ${descriptor.scopeNote}\n- **Entry Terms:** ${heading}; `,
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
        { db: 'mesh', term: 'cancer[MH]', retmax: 5 },
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
      expect(getEnrichment(ctx).notice).toMatch(/Raise maxResults/);
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
      expect(getEnrichment(ctx).notice).toMatch(/exact-descriptor match/);
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
