/**
 * @fileoverview Handles parsing of NCBI E-utility responses and NCBI-specific error extraction.
 * Creates an NCBI-specific XMLParser instance with `isArray` callback support for handling
 * NCBI's inconsistent XML structures where single-element lists are collapsed to scalars.
 * Also reads the `<ERROR>` envelope of a failed eutils response: a backend failure is
 * reclassified as transient, and EFetch's all-invalid-ID rejection becomes the empty set
 * NCBI returns for an unknown ID.
 * @module src/services/ncbi/response-handler
 */

import {
  McpError,
  notFound,
  serializationError,
  serviceUnavailable,
} from '@cyanheads/mcp-ts-core/errors';
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
import { XMLParser as FastXmlParser, type X2jOptions, XMLValidator } from 'fast-xml-parser';

import { recoveryFor } from '@/services/error-contracts.js';
import {
  ORDERED_XML_PARSER_OPTIONS,
  XML_PROCESS_ENTITIES_OPTIONS,
} from './parsing/ordered-xml-parser-options.js';
import { decodeHtmlEntities } from './parsing/text-helpers.js';
import type { NcbiRequestOptions } from './types.js';

/**
 * jpaths that NCBI may return as either a single value or an array.
 * The `isArray` callback forces these to always parse as arrays for consistency.
 *
 * **Convention: one entry per shape, spelling the full path from the document
 * root.** fast-xml-parser supplies that full dotted path and the lookup is an
 * exact match, so an entry naming only its last segments never fires. Where a
 * child is shared between record kinds, both ancestries are listed —
 * `PubmedArticle` and `PubmedBookArticle.BookDocument` each get their own line.
 * (#138)
 *
 * Two absences are deliberate. `<Link>` carries exactly one `<Id>`, which
 * `find-related` reads without `ensureArray`, so listing it would strand every
 * related PMID; and the JATS paths a PMC full-text response uses are governed by
 * {@link ORDERED_XML_PARSER_OPTIONS}, which declares no `isArray` at all, so an
 * entry for one here could never fire.
 *
 * Read sites still pass values through `ensureArray`, which is why correcting
 * the previously ancestor-less entries changes nothing downstream. It stays.
 */
const NCBI_ARRAY_JPATHS = new Set([
  // ESearch
  'eSearchResult.IdList.Id',
  // EFetch — journal articles
  'PubmedArticleSet.PubmedArticle',
  'PubmedArticleSet.PubmedArticle.MedlineCitation.Article.AuthorList.Author',
  'PubmedArticleSet.PubmedArticle.MedlineCitation.Article.AuthorList.Author.AffiliationInfo',
  'PubmedArticleSet.PubmedArticle.MedlineCitation.Article.GrantList.Grant',
  'PubmedArticleSet.PubmedArticle.MedlineCitation.Article.PublicationTypeList.PublicationType',
  'PubmedArticleSet.PubmedArticle.MedlineCitation.KeywordList.Keyword',
  'PubmedArticleSet.PubmedArticle.MedlineCitation.MeshHeadingList.MeshHeading',
  'PubmedArticleSet.PubmedArticle.MedlineCitation.MeshHeadingList.MeshHeading.QualifierName',
  'PubmedArticleSet.PubmedArticle.PubmedData.History.PubMedPubDate',
  // EFetch — Bookshelf records
  'PubmedArticleSet.PubmedBookArticle',
  'PubmedArticleSet.PubmedBookArticle.BookDocument.AuthorList',
  'PubmedArticleSet.PubmedBookArticle.BookDocument.AuthorList.Author',
  'PubmedArticleSet.PubmedBookArticle.BookDocument.AuthorList.Author.AffiliationInfo',
  'PubmedArticleSet.PubmedBookArticle.BookDocument.KeywordList.Keyword',
  'PubmedArticleSet.PubmedBookArticle.BookDocument.PublicationType',
  'PubmedArticleSet.PubmedBookArticle.BookDocument.Book.AuthorList',
  'PubmedArticleSet.PubmedBookArticle.BookDocument.Book.AuthorList.Author',
  'PubmedArticleSet.PubmedBookArticle.BookDocument.Book.ELocationID',
  'PubmedArticleSet.PubmedBookArticle.BookDocument.Book.Isbn',
  'PubmedArticleSet.PubmedBookArticle.PubmedBookData.History.PubMedPubDate',
  'PubmedArticleSet.DeleteCitation.PMID',
  // ELink
  'eLinkResult.LinkSet.LinkSetDb',
  'eLinkResult.LinkSet.LinkSetDb.Link',
  // EInfo
  'eInfoResult.DbInfo.FieldList.Field',
  'eInfoResult.DbInfo.LinkList.Link',
  // ESummary
  'eSummaryResult.DocSum',
  // EFetch — MeSH descriptor records
  'DescriptorRecordSet.DescriptorRecord',
  'DescriptorRecordSet.DescriptorRecord.ConceptList.Concept',
  'DescriptorRecordSet.DescriptorRecord.ConceptList.Concept.TermList.Term',
  'DescriptorRecordSet.DescriptorRecord.TreeNumberList.TreeNumber',
]);

/**
 * ESummary version-1 `<Item>` elements, at any nesting depth.
 *
 * A `DocSum` item of `Type="List"` or `Type="Structure"` holds further `<Item>`
 * children, and `lookup-mesh` walks three levels of them to reach a tree number.
 * The nesting is open-ended, so one anchored pattern covers it where a fixed
 * list of paths would silently cap the depth. Anchored at the root for the same
 * reason the set is: a suffix match would catch an unrelated `Item` elsewhere.
 * (#138)
 */
const ESUMMARY_ITEM_JPATH = /^eSummaryResult\.DocSum(?:\.Item)+$/;

/**
 * Ordered paths to check for NCBI error messages in parsed XML.
 * More specific paths come first so they take precedence.
 */
const ERROR_PATHS = [
  'eLinkResult.ERROR',
  'eSearchResult.ERROR',
  'eSummaryResult.ERROR',
  'eFetchResult.ERROR',
  'PubmedArticleSet.ErrorList.CannotRetrievePMID',
  'ERROR',
];

/**
 * NCBI `<ERROR>` messages describing a backend failure rather than the request.
 * EFetch sends the viewer-timeout envelope under HTTP 200 and HTTP 400 alike, so
 * the status cannot tell it from a malformed request; the message can. (#153)
 *
 * `proxy_stream()` is the EFetch front end's own backend-proxy method: it prefixes
 * every failure relayed from the service behind it (a 502 page, "Failed to connect
 * to PubOne service"), so a client-side 400 cannot carry it. (#155)
 */
const NCBI_TRANSIENT_ERROR_PATTERNS: RegExp[] = [
  /External viewer error/i,
  /Status:\s*Timeout/i,
  /proxy_stream\(\)/,
];

/**
 * Captures the text of each uppercase `<ERROR>` element in a raw response body. The
 * framework keeps only the first 500 bytes of an error body, so an envelope relaying a
 * backend page is cut before its `</ERROR>`: an unterminated element runs to the end of
 * the capture. Content may hold markup, raw or entity-escaped.
 */
const ERROR_TEXT_REGEX = /<ERROR(?:\s[^>]*)?>([\s\S]*?)(?:<\/ERROR>|$)/g;

/** NCBI's whole-list rejection when not one supplied ID is a real UID. (#155) */
const EMPTY_ID_LIST_PATTERN = /^ID list is empty\b/i;

/**
 * What EFetch answers, HTTP 200, when every requested ID is well-formed but unknown —
 * an empty set in the database's own wrapper. Keyed by `db`; a database missing here
 * keeps the rejection as an error.
 */
const EMPTY_EFETCH_RESULTS: Readonly<Record<string, string>> = {
  pubmed:
    '<?xml version="1.0" ?>\n<!DOCTYPE PubmedArticleSet PUBLIC "-//NLM//DTD PubMedArticle, 1st January 2025//EN" "https://dtd.nlm.nih.gov/ncbi/pubmed/out/pubmed_250101.dtd">\n<PubmedArticleSet></PubmedArticleSet>\n',
  pmc: '<?xml version="1.0" ?>\n<!DOCTYPE pmc-articleset PUBLIC "-//NLM//DTD ARTICLE SET 2.0//EN" "https://dtd.nlm.nih.gov/ncbi/pmc/articleset/nlm-articleset-2.0.dtd">\n<pmc-articleset></pmc-articleset>\n',
};

/**
 * The `<ERROR>` messages in the captured body of a non-2xx eutils response, as plain
 * text: entities decoded, markup dropped (including a tag the capture cut in half),
 * whitespace collapsed. `undefined` when the error carries no captured body.
 */
function ncbiErrorTexts(error: unknown): string[] | undefined {
  if (!(error instanceof McpError) || typeof error.data?.body !== 'string') return;
  return [...error.data.body.matchAll(ERROR_TEXT_REGEX)].map((match) =>
    decodeHtmlEntities(match[1] ?? '')
      .replace(/<\/?[a-z!][^>]*(?:>|$)/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim(),
  );
}

/**
 * The response NCBI would have sent had it answered an all-invalid EFetch ID list the
 * way it answers an unknown well-formed one. EFetch rejects a list in which no ID is a
 * real UID (`id=00000000`) with an HTTP 400 `ID list is empty!` envelope, but answers an
 * unassigned UID (`id=99999999`) with HTTP 200 and an empty set, so the same question —
 * "which of these exist?" — would otherwise split into an error and an answer depending
 * on the ID's spelling. Returns the empty-set document to parse in place of the error,
 * or `undefined` when the error is anything else. (#155)
 */
export function emptyEFetchResultFor(
  error: unknown,
  endpoint: string,
  db: unknown,
): string | undefined {
  if (endpoint !== 'efetch' || typeof db !== 'string') return;
  const empty = EMPTY_EFETCH_RESULTS[db];
  if (empty === undefined) return;
  return ncbiErrorTexts(error)?.some((msg) => EMPTY_ID_LIST_PATTERN.test(msg)) ? empty : undefined;
}

/**
 * Reclassifies an HTTP error from a eutils request whose captured body is an NCBI
 * `<ERROR>` envelope reporting a backend failure. The status-derived code reads such a
 * response as caller error (400 → InvalidParams), which the retry gate never retries.
 * Any other error — including a genuine invalid-parameter 400 — is returned unchanged.
 * Matches the body text rather than parsing it, since the framework captures only a
 * bounded prefix. (#153, #155)
 */
export function reclassifyNcbiHttpError(error: unknown, endpoint: string): unknown {
  const ncbiErrors = ncbiErrorTexts(error);
  if (
    !(error instanceof McpError) ||
    !ncbiErrors?.some((msg) => NCBI_TRANSIENT_ERROR_PATTERNS.some((p) => p.test(msg)))
  ) {
    return error;
  }

  return serviceUnavailable(
    `NCBI API Error: ${ncbiErrors.join('; ')}`,
    {
      reason: 'ncbi_unreachable',
      endpoint,
      status: error.data?.status,
      ncbiErrors,
      ...recoveryFor('ncbi_unreachable'),
    },
    { cause: error },
  );
}

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
 *
 * `®` and `™` map to themselves. They have no superscript codepoint because
 * they need none — the glyphs are already raised, and the `<sup>` around them
 * (`GeneReviews<sup>&#xae;</sup>`) is presentation, not content. Without an
 * entry the `^` fallback fires and a book title renders `GeneReviews^®`. (#114)
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
  '®': '®',
  '™': '™',
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

/**
 * Map one `<sup>`/`<sub>` payload, or fall back to the ASCII prefix form.
 *
 * Lookup runs on the decoded text because this pass happens before the XML
 * parser: a registered mark reaches it as `&#xae;`, not `®`, and a per-character
 * lookup over the entity's own characters can only ever miss. The fallback
 * returns the *original* content, so an unmappable payload keeps whatever
 * encoding it arrived in and the string stays valid XML for the parser that
 * follows — nothing in either table decodes to `&`, `<` or `>`.
 */
function mapInlineContent(
  content: string,
  table: Readonly<Record<string, string>>,
  asciiPrefix: string,
): string {
  let out = '';
  for (const ch of decodeHtmlEntities(content)) {
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
 * Keeps `Book/Isbn` out of fast-xml-parser's numeric coercion.
 *
 * An ISBN-10 can start with a zero (`0309605393`); coerced, it becomes the
 * number 309605393 and the leading digit is gone before any read site sees it,
 * so the record ships a wrong ISBN with no error anywhere. The processor's
 * contract does the work: returning `undefined` leaves the raw text alone,
 * while returning the value unchanged for every other tag keeps the existing
 * coercion exactly as it was. (#114)
 */
const preserveIsbnText = (tagName: string, tagValue: string): string | undefined =>
  tagName === 'Isbn' ? undefined : tagValue;

/**
 * Parses NCBI E-utility responses (XML, JSON, text) and checks for NCBI-specific
 * error structures embedded in response bodies.
 */
export class NcbiResponseHandler {
  private readonly xmlParser: FastXmlParser;
  /**
   * Parser configured for JATS mixed content (PMC full-text), built from
   * {@link ORDERED_XML_PARSER_OPTIONS} — the same constant `EuropePmcService`
   * uses, so the two JATS paths cannot drift apart. (#69, #127)
   */
  private readonly orderedXmlParser: FastXmlParser;
  /**
   * Flat, named-key parser with `parseTagValue: false`. Same shape as
   * `xmlParser` — `response.eSpellResult.Query` still resolves — but tag text
   * arrives verbatim. Used where a response echoes an arbitrary caller-supplied
   * token: ESpell's `<Query>` is the only such field today, and coercion there
   * destroys the text before application code runs (`007` → `7`, `1e5` →
   * `100000`), which no read-site `String()` can undo. `orderedXmlParser` is
   * not a substitute — it also sets `preserveOrder`, returning a node array
   * rather than the property access the ESpell read depends on. (#108)
   */
  private readonly verbatimXmlParser: FastXmlParser;

  constructor() {
    // The two flat, named-key parsers differ only in `parseTagValue`.
    const flatOptions = {
      ignoreAttributes: false,
      attributeNamePrefix: '@_',
      processEntities: XML_PROCESS_ENTITIES_OPTIONS,
      htmlEntities: true,
      isArray: (_name, jpath) => {
        // `jPathOrMatcher` is a string unless `jPath: false` is set, which it is not.
        const path = jpath as string;
        return NCBI_ARRAY_JPATHS.has(path) || ESUMMARY_ITEM_JPATH.test(path);
      },
      tagValueProcessor: preserveIsbnText,
    } satisfies X2jOptions;

    this.xmlParser = new FastXmlParser({ ...flatOptions, parseTagValue: true });
    this.verbatimXmlParser = new FastXmlParser({ ...flatOptions, parseTagValue: false });
    this.orderedXmlParser = new FastXmlParser(ORDERED_XML_PARSER_OPTIONS);
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
        additionalContext: { endpoint, errors: errorMessages },
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
          additionalContext: { endpoint, retmode },
        }),
      );
      return responseText as T;
    }

    if (retmode === 'xml') {
      logger.debug(
        'Parsing XML response from NCBI.',
        requestContextService.createRequestContext({
          operation: 'NcbiParseXml',
          additionalContext: { endpoint, retmode },
        }),
      );

      const isHtml = /^\s*<(!DOCTYPE\s+html|html[\s>])/i.test(responseText);
      if (isHtml) {
        logger.warning(
          'NCBI returned HTML instead of XML (likely rate-limited).',
          requestContextService.createRequestContext({
            operation: 'NcbiHtmlResponse',
            additionalContext: { endpoint },
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
            additionalContext: { endpoint, responseLength: responseText.length },
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
            additionalContext: {
              endpoint,
              responseSnippet: responseText.substring(0, 500),
            },
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

      // Ordered wins when both are set: it is the JATS mixed-content path, and
      // it already parses tag values verbatim.
      const parser = useOrdered
        ? this.orderedXmlParser
        : options?.useVerbatimParser
          ? this.verbatimXmlParser
          : this.xmlParser;
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
            additionalContext: {
              endpoint,
              parserError,
              responseSnippet: responseText.substring(0, 500),
            },
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
          requestContextService.createRequestContext({
            operation: 'NcbiRawXml',
            additionalContext: { endpoint },
          }),
        );
        return responseText as T;
      }

      logger.debug(
        'Successfully parsed XML response.',
        requestContextService.createRequestContext({
          operation: 'NcbiParseXmlOk',
          additionalContext: { endpoint },
        }),
      );
      return parsedXml as T;
    }

    if (retmode === 'json') {
      logger.debug(
        'Parsing JSON response from NCBI.',
        requestContextService.createRequestContext({
          operation: 'NcbiParseJson',
          additionalContext: { endpoint, retmode },
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
            additionalContext: { endpoint, error: errorMessage },
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
        requestContextService.createRequestContext({
          operation: 'NcbiParseJsonOk',
          additionalContext: { endpoint },
        }),
      );
      return parsed as T;
    }

    logger.warning(
      `Unhandled retmode "${retmode}". Returning raw response text.`,
      requestContextService.createRequestContext({
        operation: 'NcbiUnknownRetmode',
        additionalContext: { endpoint, retmode },
      }),
    );
    return responseText as T;
  }
}
