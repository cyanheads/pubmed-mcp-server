/**
 * @fileoverview Article ID conversion tool. Converts between DOI, PMID, and PMCID
 * using the NCBI PMC ID Converter API for deterministic, batch-friendly resolution.
 * @module src/mcp-server/tools/definitions/convert-ids.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { getNcbiService } from '@/services/ncbi/ncbi-service.js';
import { conceptMeta, EDAM_ACCESSION, EDAM_ID_MAPPING } from './_concepts.js';

export const convertIdsTool = tool('pubmed_convert_ids', {
  description: `Convert between article identifiers (DOI, PMID, PMCID). Accepts up to 50 IDs of a single type per request. Uses the NCBI PMC ID Converter API — only resolves articles indexed in PubMed Central. For articles not in PMC, use pubmed_search_articles instead.`,
  annotations: { readOnlyHint: true, openWorldHint: true },
  _meta: conceptMeta([EDAM_ID_MAPPING, EDAM_ACCESSION]),
  sourceUrl:
    'https://github.com/cyanheads/pubmed-mcp-server/blob/main/src/mcp-server/tools/definitions/convert-ids.tool.ts',

  input: z.object({
    ids: z
      .array(z.string().min(1))
      .min(1)
      .max(50)
      .describe(
        'Article identifiers to convert. All IDs must be the same type. DOIs: "10.1093/nar/gks1195", PMIDs: "23193287", PMCIDs: "PMC3531190".',
      ),
    idtype: z
      .enum(['pmcid', 'pmid', 'doi'])
      .describe(
        'The type of IDs being submitted. Required so the API can unambiguously resolve them.',
      ),
  }),

  output: z.object({
    records: z
      .array(
        z
          .object({
            requestedId: z.string().describe('The ID that was submitted'),
            pmid: z.string().optional().describe('PubMed ID'),
            pmcid: z.string().optional().describe('PubMed Central ID'),
            doi: z.string().optional().describe('Digital Object Identifier'),
            errmsg: z.string().optional().describe('Error message if conversion failed'),
          })
          .describe('Per-ID conversion record'),
      )
      .describe('Conversion results, one per input ID'),
    totalConverted: z.number().describe('Number of IDs successfully converted'),
    totalSubmitted: z.number().describe('Number of IDs submitted'),
  }),

  async handler(input, ctx) {
    ctx.log.info('Executing pubmed_convert_ids', {
      count: input.ids.length,
      idtype: input.idtype,
    });

    const raw = await getNcbiService().idConvert(input.ids, input.idtype, { signal: ctx.signal });

    // NCBI returns pmid as a number in JSON — coerce all ID fields to strings
    const records = raw.map((r) => ({
      requestedId: String(r['requested-id']),
      ...(r.pmid !== undefined && { pmid: String(r.pmid) }),
      ...(r.pmcid !== undefined && { pmcid: String(r.pmcid) }),
      ...(r.doi !== undefined && { doi: String(r.doi) }),
      ...(r.errmsg !== undefined && { errmsg: String(r.errmsg) }),
    }));

    const totalConverted = records.filter((r) => !r.errmsg).length;
    ctx.log.info('pubmed_convert_ids completed', {
      totalConverted,
      totalSubmitted: input.ids.length,
    });

    return { records, totalConverted, totalSubmitted: input.ids.length };
  },

  format: (result) => {
    const lines = [
      `## ID Conversion Results`,
      `**Converted:** ${result.totalConverted}/${result.totalSubmitted}`,
      '',
      '| Requested ID | PMID | PMCID | DOI | Error |',
      '|:---|:---|:---|:---|:---|',
    ];
    for (const r of result.records) {
      lines.push(
        `| ${r.requestedId} | ${r.pmid ?? '-'} | ${r.pmcid ?? '-'} | ${r.doi ?? '-'} | ${r.errmsg ?? '-'} |`,
      );
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
