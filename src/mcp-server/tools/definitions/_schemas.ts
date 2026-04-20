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
