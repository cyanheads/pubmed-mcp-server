/**
 * @fileoverview Handles parsing of NCBI E-utility responses and NCBI-specific error extraction.
 * Creates an NCBI-specific XMLParser instance with `isArray` callback support for handling
 * NCBI's inconsistent XML structures where single-element lists are collapsed to scalars.
 * @module src/services/ncbi/response-handler
 */

import { notFound, serializationError, serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
import { logger, requestContextService } from '@cyanheads/mcp-ts-core/utils';
/**
 * fast-xml-parser 5.8.0 marks the in-tree `XMLValidator` as `@deprecated` in
 * favor of the new sibling package `fast-xml-validator`. The export still
 * works; we stay on it until the sibling has real adoption (was 17 days old
 * with 1 star at 5.8.0 release). Both call sites strip `<!DOCTYPE ...>`
 * before `XMLValidator.validate`, so the tightened DOCTYPE entity validation
 * 5.8.0 adds via `xml-naming` cannot reach us. Revisit when the sibling
 * matures.
 */
// biome-ignore lint/suspicious/noDeprecatedImports: staying on in-tree XMLValidator — see block comment above
import { XMLParser as FastXmlParser, XMLValidator } from 'fast-xml-parser';

import { recoveryFor } from '@/services/error-contracts.js';
import type { NcbiRequestOptions } from './types.js';

/**
 * jpaths that NCBI may return as either a single value or an array.
 * The `isArray` callback forces these to always parse as arrays for consistency.
 */
const NCBI_ARRAY_JPATHS = new Set([
  'IdList.Id',
  'eSearchResult.IdList.Id',
  'PubmedArticleSet.PubmedArticle',
  'PubmedArticleSet.DeleteCitation.PMID',
  'AuthorList.Author',
  'AffiliationInfo',
  'MeshHeadingList.MeshHeading',
  'MeshHeading.QualifierName',
  'GrantList.Grant',
  'KeywordList.Keyword',
  'PublicationTypeList.PublicationType',
  'History.PubMedPubDate',
  'LinkSet.LinkSetDb.Link',
  'Link.Id',
  'DbInfo.FieldList.Field',
  'DbInfo.LinkList.Link',
  'eSummaryResult.DocSum',
  'DocSum.Item',
  'DescriptorRecordSet.DescriptorRecord',
  'ConceptList.Concept',
  'TermList.Term',
  'TreeNumberList.TreeNumber',
  'pmc-articleset.article',
  'article-meta.article-id',
  'article-meta.pub-date',
  'contrib-group.contrib',
  'kwd-group.kwd',
  'body.sec',
  'sec.sec',
  'sec.p',
  'ref-list.ref',
]);

/**
 * Ordered paths to check for NCBI error messages in parsed XML.
 * More specific paths come first so they take precedence.
 */
const ERROR_PATHS = [
  'eLinkResult.ERROR',
  'eSearchResult.ERROR',
  'eSummaryResult.ERROR',
  'PubmedArticleSet.ErrorList.CannotRetrievePMID',
  'ERROR',
];

/**
 * NCBI error messages indicating the requested record doesn't exist (permanent
 * failure). Throwing NotFound for these prevents the retry loop from hammering
 * NCBI on what is fundamentally a "no such record" response.
 */
const NCBI_NOT_FOUND_PATTERNS: RegExp[] = [
  /cannot get document summary/i,
  /UID=\S+:\s*not found/i,
  /Empty id list/i,
];

const WARNING_PATHS = [
  'eSearchResult.ErrorList.PhraseNotFound',
  'eSearchResult.ErrorList.FieldNotFound',
  'eSearchResult.WarningList.QuotedPhraseNotFound',
  'eSearchResult.WarningList.OutputMessage',
];

/**
 * NCBI responses routinely contain numeric character references for punctuation
 * and diacritics, especially in page ranges and author names. Keep entity
 * processing enabled, but raise the aggregate expansion ceiling high enough for
 * trusted PubMed payloads.
 */
const NCBI_PROCESS_ENTITIES_OPTIONS = {
  enabled: true,
  maxTotalExpansions: 100_000,
} as const;

function resolvePath(obj: unknown, path: string): unknown {
  let current: unknown = obj;
  for (const part of path.split('.')) {
    if (current && typeof current === 'object' && part in (current as Record<string, unknown>)) {
      current = (current as Record<string, unknown>)[part];
    } else {
      return;
    }
  }
  return current;
}

function extractTextValues(source: unknown, prefix = ''): string[] {
  const items = Array.isArray(source) ? source : [source];
  const messages: string[] = [];
  for (const item of items) {
    if (typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean') {
      messages.push(`${prefix}${String(item)}`);
    } else if (item && typeof (item as Record<string, unknown>)['#text'] === 'string') {
      messages.push(`${prefix}${(item as Record<string, unknown>)['#text'] as string}`);
    }
  }
  return messages;
}

/**
 * Replaces raw NCBI C++ exception traces with a concise, actionable message.
 * The internal details are logged but not surfaced to the caller.
 */
function sanitizeNcbiError(message: string): string {
  if (/NCBI C\+\+ Exception|CException|CTxRawClient/i.test(message)) {
    if (/closed connection|EOF|Read failed/i.test(message)) {
      return 'NCBI API temporarily unavailable (connection reset) — try again in a few seconds.';
    }
    return 'NCBI API returned an internal error — try again in a few seconds.';
  }
  return message;
}

/**
 * Matches `<ERROR>` (uppercase, optionally with attributes) for a cheap
 * pre-parse check in ordered mode. Intentionally case-sensitive: NCBI's
 * E-utilities use `<ERROR>` for response-level failures, while PMC EFetch
 * uses lowercase `<error id="…">` to flag a single unavailable PMCID. The
 * latter is data (a missing ID), not a transport error, so it falls through
 * to the caller which reports it via the unified `unavailable[]` list.
 */
const ERROR_TAG_REGEX = /<ERROR(?:\s[^>]*)?>/;

/**
 * Unicode superscript map. Covers digits, common operators, and the few
 * letters that have superscript codepoints (n, i). `−` (U+2212, the proper
 * minus) is normalized to U+207B alongside ASCII `-`.
 */
const SUPERSCRIPT_MAP: Readonly<Record<string, string>> = {
  '0': '⁰',
  '1': '¹',
  '2': '²',
  '3': '³',
  '4': '⁴',
  '5': '⁵',
  '6': '⁶',
  '7': '⁷',
  '8': '⁸',
  '9': '⁹',
  '+': '⁺',
  '-': '⁻',
  '−': '⁻',
  '=': '⁼',
  '(': '⁽',
  ')': '⁾',
  n: 'ⁿ',
  i: 'ⁱ',
};

/**
 * Unicode subscript map. Covers digits and operators; alphabetic subscripts
 * are limited in Unicode and rarely appear in MEDLINE so they fall through
 * to the `_X` ASCII fallback.
 */
const SUBSCRIPT_MAP: Readonly<Record<string, string>> = {
  '0': '₀',
  '1': '₁',
  '2': '₂',
  '3': '₃',
  '4': '₄',
  '5': '₅',
  '6': '₆',
  '7': '₇',
  '8': '₈',
  '9': '₉',
  '+': '₊',
  '-': '₋',
  '−': '₋',
  '=': '₌',
  '(': '₍',
  ')': '₎',
};

function mapInlineContent(
  content: string,
  table: Readonly<Record<string, string>>,
  asciiPrefix: string,
): string {
  let out = '';
  for (const ch of content) {
    const mapped = table[ch];
    if (mapped === undefined) return `${asciiPrefix}${content}`;
    out += mapped;
  }
  return out;
}

/**
 * Flattens inline mixed-content markup (`<sup>`, `<sub>`, `<inf>`, `<i>`,
 * `<b>`, `<u>`, `<sc>`) inside PubMed/MEDLINE XML before fast-xml-parser
 * runs. The non-ordered parser used for EFetch responses doesn't preserve
 * mixed content — `1.73 m<sup>2</sup>` parses to `{ '#text': '1.73 m', sup:
 * 2 }`, and `extractAbstractText` only reads `#text`, so the superscript
 * digit is silently dropped from abstracts and titles.
 *
 * Numeric and operator characters map to Unicode (²/³/⁻²/₂…); anything else
 * falls back to a `^X` / `_X` ASCII prefix so the content survives in a
 * recognizable form. Italic / bold / underline / small-caps tags are
 * stripped (content kept) since they don't carry meaning in our text
 * rendering. Only invoked on the regular parser path; the PMC JATS path
 * already preserves inline markup via `preserveOrder: true`.
 *
 * @internal exported for direct unit tests
 */
export function flattenInlineMarkup(xml: string): string {
  return xml
    .replace(/<sup>([^<]*)<\/sup>/g, (_, c: string) => mapInlineContent(c, SUPERSCRIPT_MAP, '^'))
    .replace(/<sub>([^<]*)<\/sub>/g, (_, c: string) => mapInlineContent(c, SUBSCRIPT_MAP, '_'))
    .replace(/<inf>([^<]*)<\/inf>/g, (_, c: string) => mapInlineContent(c, SUBSCRIPT_MAP, '_'))
    .replace(/<\/?(?:i|b|u|sc)>/g, '');
}

/**
 * Parses NCBI E-utility responses (XML, JSON, text) and checks for NCBI-specific
 * error structures embedded in response bodies.
 */
export class NcbiResponseHandler {
  private readonly xmlParser: FastXmlParser;
  /**
   * Parser configured for JATS mixed content (PMC full-text). `preserveOrder`
   * keeps document order so inline markup in `<p>`, `<abstract>`, `<title>`
   * doesn't collapse into reordered text. `trimValues: false` retains spacing
   * between text nodes and adjacent inline children. `parseTagValue: false`
   * keeps bibliographic tokens verbatim — page ranges like `4002.e26` and
   * zero-padded pages would otherwise coerce to `Number` (→ `4.002e+29`, `123`);
   * every value on this path is `String()`-ed downstream, so coercion is pure
   * downside. Entity decoding is unaffected (it's governed by `processEntities`/
   * `htmlEntities`), so page-range en-dashes still resolve. (#69)
   */
  private readonly orderedXmlParser: FastXmlParser;

  constructor() {
    this.xmlParser = new FastXmlParser({
      ignoreAttributes: false,
      attributeNamePrefix: '@_',
      parseTagValue: true,
      processEntities: NCBI_PROCESS_ENTITIES_OPTIONS,
      htmlEntities: true,
      isArray: (_name, jpath) => NCBI_ARRAY_JPATHS.has(jpath as string),
    });
    this.orderedXmlParser = new FastXmlParser({
      preserveOrder: true,
      ignoreAttributes: false,
      attributeNamePrefix: '@_',
      parseTagValue: false,
      trimValues: false,
      processEntities: NCBI_PROCESS_ENTITIES_OPTIONS,
      htmlEntities: true,
    });
  }

  /**
   * Extract a structured error from a parsed NCBI XML body and throw it as
   * `notFound()` for permanent "no such record" responses or `serviceUnavailable()`
   * for transient backend failures. Never returns.
   *
   * NCBI returns "cannot get document summary" / "Empty id list" for invalid
   * UIDs — these are permanent (the record doesn't exist), so we surface them
   * as NotFound so the retry loop short-circuits instead of hammering NCBI.
   */
  private throwNcbiError(parsedXml: Record<string, unknown>, endpoint: string): never {
    const errorMessages = this.extractNcbiErrorMessages(parsedXml);
    logger.error(
      'NCBI API returned an error in XML response.',
      requestContextService.createRequestContext({
        operation: 'NcbiXmlError',
        endpoint,
        errors: errorMessages,
      }),
    );

    if (errorMessages.some((msg) => NCBI_NOT_FOUND_PATTERNS.some((p) => p.test(msg)))) {
      throw notFound(`NCBI API Error: ${errorMessages.join('; ')}`, {
        reason: 'ncbi_resource_not_found',
        endpoint,
        ncbiErrors: errorMessages,
        ...recoveryFor('ncbi_resource_not_found'),
      });
    }

    throw serviceUnavailable(`NCBI API Error: ${errorMessages.join('; ')}`, {
      reason: 'ncbi_unreachable',
      endpoint,
      ncbiErrors: errorMessages,
      ...recoveryFor('ncbi_unreachable'),
    });
  }

  extractNcbiErrorMessages(parsedXml: Record<string, unknown>): string[] {
    const messages: string[] = [];

    for (const path of ERROR_PATHS) {
      const value = resolvePath(parsedXml, path);
      if (value !== undefined) {
        messages.push(...extractTextValues(value));
      }
    }

    if (messages.length === 0) {
      for (const path of WARNING_PATHS) {
        const value = resolvePath(parsedXml, path);
        if (value !== undefined) {
          messages.push(...extractTextValues(value, 'Warning: '));
        }
      }
    }

    return messages.length > 0 ? messages.map(sanitizeNcbiError) : ['Unknown NCBI API error.'];
  }

  parseAndHandleResponse<T>(
    responseText: string,
    endpoint: string,
    options?: NcbiRequestOptions,
  ): T {
    const retmode = options?.retmode ?? 'xml';

    if (retmode === 'text') {
      logger.debug(
        'Received text response from NCBI.',
        requestContextService.createRequestContext({
          operation: 'NcbiParseText',
          endpoint,
          retmode,
        }),
      );
      return responseText as T;
    }

    if (retmode === 'xml') {
      logger.debug(
        'Parsing XML response from NCBI.',
        requestContextService.createRequestContext({
          operation: 'NcbiParseXml',
          endpoint,
          retmode,
        }),
      );

      const isHtml = /^\s*<(!DOCTYPE\s+html|html[\s>])/i.test(responseText);
      if (isHtml) {
        logger.warning(
          'NCBI returned HTML instead of XML (likely rate-limited).',
          requestContextService.createRequestContext({
            operation: 'NcbiHtmlResponse',
            endpoint,
          }),
        );
        throw serviceUnavailable(
          'NCBI API returned an HTML response instead of XML — likely rate-limited.',
          { reason: 'ncbi_unreachable', endpoint, ...recoveryFor('ncbi_unreachable') },
        );
      }

      // NCBI's eLink (and occasionally other endpoints) drops the root element
      // when the upstream backend connection fails mid-response, yielding just
      // `<?xml ... ?>` + DOCTYPE with no body. JSON retmode reveals the same
      // failure as a TXCLIENT EOF in an `ERROR` field; XML just truncates.
      // Reclassify as transient ServiceUnavailable so the retry chain recovers,
      // rather than SerializationError which short-circuits retries.
      const bodyMinusProlog = responseText
        .replace(/<\?xml[^?]*\?>/gi, '')
        .replace(/<!DOCTYPE[^>]*>/gi, '')
        .trim();
      if (bodyMinusProlog.length === 0) {
        logger.warning(
          'NCBI returned a prolog-only XML response (upstream backend failure).',
          requestContextService.createRequestContext({
            operation: 'NcbiEmptyResponse',
            endpoint,
            responseLength: responseText.length,
          }),
        );
        throw serviceUnavailable(
          'NCBI returned an empty response body — the upstream backend likely failed mid-request.',
          { reason: 'ncbi_unreachable', endpoint, ...recoveryFor('ncbi_unreachable') },
        );
      }

      const xmlForValidation = responseText.replace(/<!DOCTYPE[^>]*>/gi, '');
      const validationResult = XMLValidator.validate(xmlForValidation);
      if (validationResult !== true) {
        logger.error(
          'Invalid XML response from NCBI.',
          requestContextService.createRequestContext({
            operation: 'NcbiInvalidXml',
            endpoint,
            responseSnippet: responseText.substring(0, 500),
          }),
        );
        throw serializationError('Received invalid XML from NCBI.', {
          reason: 'ncbi_invalid_response',
          endpoint,
          responseSnippet: responseText.substring(0, 200),
          ...recoveryFor('ncbi_invalid_response'),
        });
      }

      const useOrdered = options?.useOrderedParser ?? false;

      if (useOrdered && ERROR_TAG_REGEX.test(responseText)) {
        // Ordered parser lacks the named-key shape error extraction relies on.
        // Errors are rare, so fall back to the regular parser just to surface a
        // structured message.
        const errorParsed = this.xmlParser.parse(responseText) as Record<string, unknown>;
        this.throwNcbiError(errorParsed, endpoint);
      }

      const parser = useOrdered ? this.orderedXmlParser : this.xmlParser;
      // Pre-flatten <sup>/<sub>/<inf>/<i>/<b>/<u>/<sc> on the regular parser
      // path. The ordered parser walks mixed content correctly via
      // preserveOrder; the regular parser does not.
      const xmlForParse = useOrdered ? responseText : flattenInlineMarkup(responseText);
      let parsedXml: unknown;
      try {
        parsedXml = parser.parse(xmlForParse);
      } catch (error: unknown) {
        const parserError = error instanceof Error ? error.message : String(error);
        logger.error(
          'Failed to parse validated XML response from NCBI.',
          requestContextService.createRequestContext({
            operation: 'NcbiXmlParseError',
            endpoint,
            parserError,
            responseSnippet: responseText.substring(0, 500),
          }),
        );
        throw serializationError(
          `Failed to parse XML response from NCBI: ${parserError}`,
          {
            reason: 'ncbi_invalid_response',
            endpoint,
            parserError,
            responseSnippet: responseText.substring(0, 200),
            ...recoveryFor('ncbi_invalid_response'),
          },
          { cause: error },
        );
      }

      if (!useOrdered) {
        const parsedObj = parsedXml as Record<string, unknown>;
        const hasError = ERROR_PATHS.some((path) => resolvePath(parsedObj, path) !== undefined);
        if (hasError) {
          this.throwNcbiError(parsedObj, endpoint);
        }
      }

      if (options?.returnRawXml) {
        logger.debug(
          'Returning raw XML string after validation.',
          requestContextService.createRequestContext({ operation: 'NcbiRawXml', endpoint }),
        );
        return responseText as T;
      }

      logger.debug(
        'Successfully parsed XML response.',
        requestContextService.createRequestContext({ operation: 'NcbiParseXmlOk', endpoint }),
      );
      return parsedXml as T;
    }

    if (retmode === 'json') {
      logger.debug(
        'Parsing JSON response from NCBI.',
        requestContextService.createRequestContext({
          operation: 'NcbiParseJson',
          endpoint,
          retmode,
        }),
      );

      let parsed: unknown;
      try {
        parsed = JSON.parse(responseText);
      } catch (error: unknown) {
        throw serializationError(
          'Failed to parse NCBI JSON response.',
          {
            reason: 'ncbi_invalid_response',
            endpoint,
            responseSnippet: responseText.substring(0, 200),
            ...recoveryFor('ncbi_invalid_response'),
          },
          { cause: error },
        );
      }

      if (parsed && typeof parsed === 'object' && 'error' in parsed) {
        const errorMessage = String((parsed as Record<string, unknown>).error);
        logger.error(
          'NCBI API returned an error in JSON response.',
          requestContextService.createRequestContext({
            operation: 'NcbiJsonError',
            endpoint,
            error: errorMessage,
          }),
        );
        if (NCBI_NOT_FOUND_PATTERNS.some((p) => p.test(errorMessage))) {
          throw notFound(`NCBI API Error: ${errorMessage}`, {
            reason: 'ncbi_resource_not_found',
            endpoint,
            ncbiErrors: [errorMessage],
            ...recoveryFor('ncbi_resource_not_found'),
          });
        }
        throw serviceUnavailable(`NCBI API Error: ${errorMessage}`, {
          reason: 'ncbi_unreachable',
          endpoint,
          ncbiError: errorMessage,
          ...recoveryFor('ncbi_unreachable'),
        });
      }

      logger.debug(
        'Successfully parsed JSON response.',
        requestContextService.createRequestContext({ operation: 'NcbiParseJsonOk', endpoint }),
      );
      return parsed as T;
    }

    logger.warning(
      `Unhandled retmode "${retmode}". Returning raw response text.`,
      requestContextService.createRequestContext({
        operation: 'NcbiUnknownRetmode',
        endpoint,
        retmode,
      }),
    );
    return responseText as T;
  }
}
