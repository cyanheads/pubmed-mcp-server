/**
 * @fileoverview Shared Zod schemas reused across tool definitions, plus the
 * normalizer for the PMID form {@link pmidStringSchema} accepts. The DOI schemas
 * are built on the DOI rules in `src/services/doi.ts`.
 * @module src/mcp-server/tools/definitions/_schemas
 */

import { z } from '@cyanheads/mcp-ts-core';
import { isDoi, normalizeDoi } from '@/services/doi.js';
import { EUROPEPMC_ALL_SOURCES } from '@/services/europe-pmc/types.js';

/**
 * Zod string schema for a single PubMed ID. Accepts only digit characters.
 * The message is intentionally actionable so callers can self-correct without
 * inspecting the regex — names the domain, shows an example, and lists the
 * common failure modes we've seen in the wild (whitespace, comma-joined IDs,
 * stray prefixes like "PMID:").
 */
export const pmidStringSchema = z
  .string()
  .regex(
    /^\d+$/,
    'PMID must be a numeric identifier (e.g. "13054692"). Remove any whitespace, commas, or non-digit characters — provide each PMID separately.',
  );

/**
 * Canonical form of a PMID {@link pmidStringSchema} accepted: leading zeros
 * stripped, `0` kept for an all-zero input. NCBI reads `00000001` as PMID 1 and
 * answers with `<PMID>1</PMID>`, so a handler sends this form upstream and
 * compares upstream PMIDs against it — the schema itself stays as advertised,
 * since tool schemas carry no transforms. `0` is still no UID, so an all-zero
 * list keeps NCBI's empty-list answer. (#161)
 */
export function normalizePmid(pmid: string): string {
  return pmid.replace(/^0+(?=\d)/, '');
}

/**
 * Zod string schema for a single PMC ID. Digits, with the "PMC" prefix optional
 * and case-insensitive — both forms are accepted upstream.
 */
export const pmcidStringSchema = z
  .string()
  .regex(
    /^(?:PMC)?\d+$/i,
    'PMC ID must be digits, optionally prefixed with "PMC" (e.g. "PMC9575052" or "9575052"). Remove any whitespace or commas — provide each PMC ID separately.',
  );

/**
 * The DOI pattern, with a `test` that decides the strings its source matches by
 * {@link isDoi}, so validation stays linear in the value's length. Zod's
 * `.regex()` check calls `test` and advertises `source`, so the JSON Schema
 * pattern and the rejection's issue are what the plain pattern gives.
 */
class DoiPattern extends RegExp {
  override test(value: string): boolean {
    return isDoi(value);
  }
}

/**
 * Zod string schema for a single DOI: the "10." directory indicator, a
 * registrant prefix, "/", and a suffix.
 *
 * Every DOI character is allowed except whitespace and the comma, so the
 * suffix punctuation a real DOI carries — parens, colons, angle brackets,
 * semicolons, further slashes — passes through. The comma is excluded because
 * it is the PMC ID Converter's list delimiter in any encoding, so an element
 * carrying one is read upstream as two identifiers rather than one DOI.
 */
export const doiStringSchema = z
  .string()
  .regex(
    new DoiPattern(/^10\.[^\s,]+\/[^\s,]+$/),
    'DOI must start with "10." and contain a "/" (e.g. "10.1093/nar/gks1195"). Remove any whitespace or commas — provide each DOI separately.',
  );

/**
 * A DOI as a tool's schema accepts it: a link or `doi:` form is read as the bare
 * DOI ({@link normalizeDoi}) before {@link doiStringSchema} checks it, so the
 * handler receives the bare DOI. The fold stays off the advertised schema, which
 * remains `doiStringSchema`'s plain pattern. (#299)
 */
export const doiInputSchema = z.preprocess(
  (value) => (typeof value === 'string' ? normalizeDoi(value) : value),
  doiStringSchema,
);

/**
 * A Europe PMC source code as a tool accepts it: a lower-case code (`med`,
 * `pmc`) is folded to the code itself before the enum check, since Europe PMC
 * matches `SRC:` case-insensitively and search hits always carry the upper-case
 * form. A value that is no code (`pubmed`) is still rejected. The fold stays off
 * the advertised schema, which remains the plain enum. (#244)
 */
export const europePmcSourceInputSchema = z.preprocess(
  (value) => (typeof value === 'string' ? value.toUpperCase() : value),
  z.enum(EUROPEPMC_ALL_SOURCES),
);
