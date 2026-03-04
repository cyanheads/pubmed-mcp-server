/**
 * @fileoverview Handles parsing of NCBI E-utility responses and NCBI-specific error extraction.
 * Creates an NCBI-specific XMLParser instance with `isArray` callback support for handling
 * NCBI's inconsistent XML structures where single-element lists are collapsed to scalars.
 * @module src/services/ncbi/core/response-handler
 */

import { XMLParser as FastXmlParser, XMLValidator } from 'fast-xml-parser';

import { JsonRpcErrorCode, McpError } from '@/types-global/errors.js';
import { logger } from '@/utils/internal/logger.js';
import type { RequestContext } from '@/utils/internal/requestContext.js';

import type { NcbiRequestOptions } from '../types.js';

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
  // MeSH eFetch structures
  'DescriptorRecordSet.DescriptorRecord',
  'ConceptList.Concept',
  'TermList.Term',
  'TreeNumberList.TreeNumber',
]);

/**
 * Ordered paths to check for NCBI error messages in parsed XML.
 * More specific paths come first so they take precedence.
 */
const ERROR_PATHS = [
  'eLinkResult.ERROR',
  'eSummaryResult.ERROR',
  'eSearchResult.ErrorList.PhraseNotFound',
  'eSearchResult.ErrorList.FieldNotFound',
  'PubmedArticleSet.ErrorList.CannotRetrievePMID',
  'ERROR',
];

/**
 * Warning paths checked when no primary errors are found.
 */
const WARNING_PATHS = [
  'eSearchResult.WarningList.QuotedPhraseNotFound',
  'eSearchResult.WarningList.OutputMessage',
];

/**
 * Walks a dotted property path on an object, returning the value at the leaf
 * or `undefined` if any segment is missing.
 */
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

/**
 * Extracts human-readable strings from a resolved path value.
 * Handles plain strings, arrays of strings, and objects with a `#text` property.
 */
function extractTextValues(source: unknown, prefix = ''): string[] {
  const items = Array.isArray(source) ? source : [source];
  const messages: string[] = [];
  for (const item of items) {
    if (typeof item === 'string') {
      messages.push(`${prefix}${item}`);
    } else if (item && typeof (item as Record<string, unknown>)['#text'] === 'string') {
      messages.push(`${prefix}${(item as Record<string, unknown>)['#text'] as string}`);
    }
  }
  return messages;
}

/**
 * Parses NCBI E-utility responses (XML, JSON, text) and checks for NCBI-specific
 * error structures embedded in response bodies.
 *
 * Uses its own XMLParser instance with an `isArray` callback — the template's
 * shared xmlParser singleton lacks this and cannot handle NCBI's inconsistent
 * single-element-vs-array XML.
 */
export class NcbiResponseHandler {
  private readonly xmlParser: FastXmlParser;

  constructor() {
    this.xmlParser = new FastXmlParser({
      ignoreAttributes: false,
      attributeNamePrefix: '@_',
      parseTagValue: true,
      isArray: (_name, jpath) => NCBI_ARRAY_JPATHS.has(jpath),
    });
  }

  /**
   * Extracts error (and optionally warning) messages from parsed NCBI XML.
   * Checks multiple known error paths in priority order, falling back to
   * warning paths when no hard errors are found.
   */
  extractNcbiErrorMessages(parsedXml: Record<string, unknown>): string[] {
    const messages: string[] = [];

    for (const path of ERROR_PATHS) {
      const value = resolvePath(parsedXml, path);
      if (value !== undefined) {
        messages.push(...extractTextValues(value));
      }
    }

    // Fall back to warnings when no primary errors were found
    if (messages.length === 0) {
      for (const path of WARNING_PATHS) {
        const value = resolvePath(parsedXml, path);
        if (value !== undefined) {
          messages.push(...extractTextValues(value, 'Warning: '));
        }
      }
    }

    return messages.length > 0 ? messages : ['Unknown NCBI API error structure.'];
  }

  /**
   * Parses raw response text from an NCBI E-utility call based on the requested
   * `retmode` and checks for NCBI-specific errors embedded in the response body.
   *
   * @param responseText - The raw HTTP response body as a string.
   * @param endpoint - The E-utility endpoint name (for error context).
   * @param context - Request context for structured logging.
   * @param options - Request options, primarily `retmode` and `returnRawXml`.
   * @returns The parsed data — object for XML/JSON, raw string for text.
   * @throws {McpError} On parse failures or NCBI-reported errors.
   */
  parseAndHandleResponse<T>(
    responseText: string,
    endpoint: string,
    context: RequestContext,
    options?: NcbiRequestOptions,
  ): T {
    const retmode = options?.retmode ?? 'xml';

    // --- Text mode: return as-is ---
    if (retmode === 'text') {
      logger.debug('Received text response from NCBI.', { ...context, endpoint, retmode });
      return responseText as T;
    }

    // --- XML mode ---
    if (retmode === 'xml') {
      logger.debug('Parsing XML response from NCBI.', { ...context, endpoint, retmode });

      // Strip DOCTYPE declarations before validation — NCBI MeSH eFetch (and others)
      // include DTD references that XMLValidator rejects.
      const xmlForValidation = responseText.replace(/<!DOCTYPE[^>]*>/gi, '');
      const validationResult = XMLValidator.validate(xmlForValidation);
      if (validationResult !== true) {
        logger.error('Invalid XML response from NCBI.', {
          ...context,
          endpoint,
          responseSnippet: responseText.substring(0, 500),
        });
        throw new McpError(JsonRpcErrorCode.SerializationError, 'Received invalid XML from NCBI.', {
          endpoint,
          responseSnippet: responseText.substring(0, 200),
        });
      }

      const parsedXml = this.xmlParser.parse(responseText) as Record<string, unknown>;

      // Check for error indicators in the parsed structure
      const hasError =
        resolvePath(parsedXml, 'eSearchResult.ErrorList') !== undefined ||
        resolvePath(parsedXml, 'eLinkResult.ERROR') !== undefined ||
        resolvePath(parsedXml, 'eSummaryResult.ERROR') !== undefined ||
        resolvePath(parsedXml, 'PubmedArticleSet.ErrorList') !== undefined ||
        resolvePath(parsedXml, 'ERROR') !== undefined;

      if (hasError) {
        const errorMessages = this.extractNcbiErrorMessages(parsedXml);
        logger.error('NCBI API returned an error in XML response.', {
          ...context,
          endpoint,
          errors: errorMessages,
        });
        throw new McpError(
          JsonRpcErrorCode.ServiceUnavailable,
          `NCBI API Error: ${errorMessages.join('; ')}`,
          { endpoint, ncbiErrors: errorMessages },
        );
      }

      // Return raw XML string if requested, otherwise return parsed object
      if (options?.returnRawXml) {
        logger.debug('Returning raw XML string after validation.', { ...context, endpoint });
        return responseText as T;
      }

      logger.debug('Successfully parsed XML response.', { ...context, endpoint });
      return parsedXml as T;
    }

    // --- JSON mode ---
    if (retmode === 'json') {
      logger.debug('Parsing JSON response from NCBI.', { ...context, endpoint, retmode });

      let parsed: unknown;
      try {
        parsed = JSON.parse(responseText);
      } catch {
        throw new McpError(
          JsonRpcErrorCode.SerializationError,
          'Failed to parse NCBI JSON response.',
          { endpoint, responseSnippet: responseText.substring(0, 200) },
        );
      }

      if (parsed && typeof parsed === 'object' && 'error' in parsed) {
        const errorMessage = String((parsed as Record<string, unknown>).error);
        logger.error('NCBI API returned an error in JSON response.', {
          ...context,
          endpoint,
          error: errorMessage,
        });
        throw new McpError(JsonRpcErrorCode.ServiceUnavailable, `NCBI API Error: ${errorMessage}`, {
          endpoint,
          ncbiError: errorMessage,
        });
      }

      logger.debug('Successfully parsed JSON response.', { ...context, endpoint });
      return parsed as T;
    }

    // Unrecognized retmode — return raw text with a warning
    logger.warning(`Unhandled retmode "${retmode}". Returning raw response text.`, {
      ...context,
      endpoint,
      retmode,
    });
    return responseText as T;
  }
}
