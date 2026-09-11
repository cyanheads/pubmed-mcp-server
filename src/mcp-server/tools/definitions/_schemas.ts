/**
 * @fileoverview Shared Zod schemas reused across tool definitions.
 * @module src/mcp-server/tools/definitions/_schemas
 */

import { z } from '@cyanheads/mcp-ts-core';

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
    /^10\.[^\s,]+\/[^\s,]+$/,
    'DOI must start with "10." and contain a "/" (e.g. "10.1093/nar/gks1195"). Remove any whitespace or commas — provide each DOI separately.',
  );
