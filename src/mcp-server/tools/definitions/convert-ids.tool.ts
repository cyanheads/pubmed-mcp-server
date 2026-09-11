/**
 * @fileoverview Article ID conversion tool. Converts between DOI, PMID, and PMCID
 * using the NCBI PMC ID Converter API for deterministic, batch-friendly resolution.
 * @module src/mcp-server/tools/definitions/convert-ids.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { NCBI_ID_INPUT_ERRORS, NCBI_SERVICE_ERRORS } from '@/services/error-contracts.js';
import { getNcbiService } from '@/services/ncbi/ncbi-service.js';
import { conceptMeta, EDAM_ACCESSION, EDAM_ID_MAPPING } from './_concepts.js';
import { doiStringSchema, pmcidStringSchema, pmidStringSchema } from './_schemas.js';

/**
 * NCBI's PMC ID Converter returns this exact wording for any non-PMC ID — even
 * articles that exist in PubMed and have a recoverable DOI. Rewrite to point
 * the caller at the recovery path; the original is logged at debug.
 */
const PMC_NOT_FOUND_RE = /^identifier not found in pmc$/i;
const PMC_NOT_FOUND_REWRITE =
  'Not in PMC ID Converter. Article may still exist in PubMed — try pubmed_fetch_articles (PMID → DOI) or pubmed_search_articles.';

/**
 * Per-`idType` element format, checked in the handler rather than the schema:
 * a Zod `.regex()` on `ids` cannot branch on the sibling `idType` field.
 *
 * Every one of these rejects an element carrying a comma, which is what closes
 * #120 — the converter reads a comma as its list delimiter, so a packed element
 * comes back as several records and breaks the one-record-per-submitted-ID
 * contract the counts are computed from.
 */
const ID_ELEMENT_SCHEMAS = {
  doi: doiStringSchema,
  pmcid: pmcidStringSchema,
  pmid: pmidStringSchema,
} as const;

/** Cap the offending value echoed back so an oversized element can't bloat the error. */
const MAX_ECHOED_ID_LENGTH = 120;

export const convertIdsTool = tool('pubmed_convert_ids', {
  description: `Convert between article identifiers (DOI, PMID, PMCID). Accepts up to 50 IDs of a single type per request. Only resolves articles indexed in PubMed Central — for articles not in PMC, use pubmed_search_articles instead.`,
  annotations: { readOnlyHint: true, openWorldHint: true },
  _meta: conceptMeta([EDAM_ID_MAPPING, EDAM_ACCESSION]),
  sourceUrl:
    'https://github.com/cyanheads/pubmed-mcp-server/blob/main/src/mcp-server/tools/definitions/convert-ids.tool.ts',

  errors: [...NCBI_SERVICE_ERRORS, ...NCBI_ID_INPUT_ERRORS] as const,

  input: z.object({
    ids: z
      .array(z.string().min(1))
      .min(1)
      .max(50)
      .describe(
        'Article identifiers to convert — one identifier per element, all of the same type. Each element is checked against `idType` before the request: `doi` starts with "10." and carries a "/" ("10.1093/nar/gks1195"); `pmid` is digits ("23193287"); `pmcid` is digits with an optional "PMC" prefix ("PMC3531190" or "3531190"). No element may contain a comma or whitespace — a packed value like "23193287,37952131" is rejected, so split it across elements.',
      ),
    idType: z
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
            pmid: z.string().optional().describe('PubMed ID; absent if no mapping was found'),
            pmcid: z
              .string()
              .optional()
              .describe('PubMed Central ID; absent if the article has no PMC copy'),
            doi: z
              .string()
              .optional()
              .describe(
                'Digital Object Identifier, cased as the PMC ID Converter reports it; absent if no DOI is on record. DOIs are case-insensitive by spec and no case normalization is applied here, so casing can differ from a Europe PMC-sourced `doi` — compare the two case-insensitively.',
              ),
            errmsg: z
              .string()
              .optional()
              .describe(
                'Error message if conversion failed. Presence of `errmsg` is the failure signal; absence means the conversion succeeded.',
              ),
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
      idType: input.idType,
    });

    const elementSchema = ID_ELEMENT_SCHEMAS[input.idType];
    for (const id of input.ids) {
      const parsed = elementSchema.safeParse(id);
      if (parsed.success) continue;
      const shown = id.length > MAX_ECHOED_ID_LENGTH ? `${id.slice(0, MAX_ECHOED_ID_LENGTH)}…` : id;
      throw ctx.fail(
        'malformed_id',
        `Invalid ${input.idType} element "${shown}". ${parsed.error.issues[0]?.message}`,
        { ...ctx.recoveryFor('malformed_id') },
      );
    }

    const raw = await getNcbiService().idConvert(input.ids, input.idType, { signal: ctx.signal });

    // NCBI returns pmid as a number in JSON — coerce all ID fields to strings
    const records = raw.map((r) => {
      const requestedId = String(r['requested-id']);
      let errmsg: string | undefined;
      if (r.errmsg !== undefined) {
        const original = String(r.errmsg);
        if (PMC_NOT_FOUND_RE.test(original)) {
          ctx.log.debug('Rewriting PMC-not-found errmsg', { requestedId, original });
          errmsg = PMC_NOT_FOUND_REWRITE;
        } else {
          errmsg = original;
        }
      }
      return {
        requestedId,
        ...(r.pmid !== undefined && { pmid: String(r.pmid) }),
        ...(r.pmcid !== undefined && { pmcid: String(r.pmcid) }),
        ...(r.doi !== undefined && { doi: String(r.doi) }),
        ...(errmsg !== undefined && { errmsg }),
      };
    });

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
