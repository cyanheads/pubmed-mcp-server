/**
 * @fileoverview fast-xml-parser options shared by every JATS parser instance in
 * this server. PMC EFetch and Europe PMC both serve JATS Z39.96 and both feed
 * `parsePmcArticle`, so their parsers must agree field-for-field: a divergence
 * makes the same article render differently depending on which upstream
 * answered. Dependency-free leaf — it imports a type and nothing else — so any
 * service can import it without introducing a cycle.
 * @module src/services/ncbi/parsing/ordered-xml-parser-options
 */

import type { X2jOptions } from 'fast-xml-parser';

/**
 * NCBI and Europe PMC responses routinely carry numeric character references
 * for punctuation and diacritics, especially in page ranges and author names.
 * Keep entity processing enabled, but cap aggregate expansion so a hostile or
 * malformed payload cannot turn entity resolution into a denial of service. The
 * ceiling is high enough for trusted bibliographic payloads.
 */
export const XML_PROCESS_ENTITIES_OPTIONS = {
  enabled: true,
  maxTotalExpansions: 100_000,
} as const;

/**
 * Options for the JATS mixed-content parsers. `preserveOrder` keeps document
 * order so inline markup in `<p>`, `<abstract>`, `<title>` doesn't collapse into
 * reordered text. `trimValues: false` retains spacing between text nodes and
 * adjacent inline children. `parseTagValue: false` keeps bibliographic tokens
 * verbatim — page ranges like `4002.e26`, zero-padded pages, and reference
 * labels like `1.` would otherwise coerce to `Number` (→ `4.002e+29`, `123`,
 * `1`); every value on this path is `String()`-ed downstream, so coercion is
 * pure downside. Entity decoding is unaffected (governed by `processEntities` /
 * `htmlEntities`), so page-range en-dashes still resolve. (#69, #127)
 */
export const ORDERED_XML_PARSER_OPTIONS = {
  preserveOrder: true,
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  parseTagValue: false,
  trimValues: false,
  processEntities: XML_PROCESS_ENTITIES_OPTIONS,
  htmlEntities: true,
} as const satisfies X2jOptions;
