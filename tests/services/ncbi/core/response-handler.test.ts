/**
 * @fileoverview Tests for NcbiResponseHandler — NCBI response parsing and error extraction.
 * @module tests/services/ncbi/core/response-handler.test
 */
import { beforeEach, describe, expect, it } from 'vitest';

import { JsonRpcErrorCode, McpError } from '@/types-global/errors.js';
import { requestContextService } from '@/utils/internal/requestContext.js';

import { NcbiResponseHandler } from '../../../../src/services/ncbi/core/response-handler.js';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const VALID_ESEARCH_XML =
  '<eSearchResult><Count>5</Count><RetMax>5</RetMax><RetStart>0</RetStart><IdList><Id>123</Id></IdList></eSearchResult>';

const ESUMMARY_ERROR_XML = '<eSummaryResult><ERROR>Invalid uid 99999999</ERROR></eSummaryResult>';

const ELINK_ERROR_XML = '<eLinkResult><ERROR>Link not available</ERROR></eLinkResult>';

const ESEARCH_PHRASE_NOT_FOUND_XML =
  '<eSearchResult><Count>0</Count><RetMax>0</RetMax><RetStart>0</RetStart>' +
  '<IdList></IdList><ErrorList><PhraseNotFound>faketerm</PhraseNotFound></ErrorList></eSearchResult>';

const TOP_LEVEL_ERROR_XML = '<ERROR>Server unavailable</ERROR>';

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('NcbiResponseHandler', () => {
  let handler: NcbiResponseHandler;
  let context: ReturnType<typeof requestContextService.createRequestContext>;

  beforeEach(() => {
    handler = new NcbiResponseHandler();
    context = requestContextService.createRequestContext({ operation: 'test-ncbi-response' });
  });

  // ── extractNcbiErrorMessages ──────────────────────────────────────────────

  describe('extractNcbiErrorMessages', () => {
    it('extracts error from eLinkResult.ERROR path', () => {
      const parsed = { eLinkResult: { ERROR: 'Link not available' } };
      const messages = handler.extractNcbiErrorMessages(parsed);
      expect(messages).toEqual(['Link not available']);
    });

    it('extracts error from eSummaryResult.ERROR path', () => {
      const parsed = { eSummaryResult: { ERROR: 'Invalid uid 99999999' } };
      const messages = handler.extractNcbiErrorMessages(parsed);
      expect(messages).toEqual(['Invalid uid 99999999']);
    });

    it('extracts error from eSearchResult.ErrorList.PhraseNotFound path', () => {
      const parsed = { eSearchResult: { ErrorList: { PhraseNotFound: 'faketerm' } } };
      const messages = handler.extractNcbiErrorMessages(parsed);
      expect(messages).toEqual(['faketerm']);
    });

    it('extracts error from top-level ERROR path', () => {
      const parsed = { ERROR: 'Server unavailable' };
      const messages = handler.extractNcbiErrorMessages(parsed);
      expect(messages).toEqual(['Server unavailable']);
    });

    it('collects errors from multiple paths', () => {
      const parsed = {
        eSummaryResult: { ERROR: 'eSummary error' },
        ERROR: 'Top-level error',
      };
      const messages = handler.extractNcbiErrorMessages(parsed);
      // Both paths are checked; eSummaryResult.ERROR has higher priority and comes first
      expect(messages).toContain('eSummary error');
      expect(messages).toContain('Top-level error');
      expect(messages.length).toBe(2);
    });

    it('falls back to warning paths with "Warning: " prefix when no errors are found', () => {
      const parsed = {
        eSearchResult: {
          WarningList: { QuotedPhraseNotFound: 'some phrase' },
        },
      };
      const messages = handler.extractNcbiErrorMessages(parsed);
      expect(messages).toEqual(['Warning: some phrase']);
    });

    it('returns ["Unknown NCBI API error structure."] when no errors or warnings exist', () => {
      const parsed = { eSearchResult: { Count: '0', IdList: {} } };
      const messages = handler.extractNcbiErrorMessages(parsed);
      expect(messages).toEqual(['Unknown NCBI API error structure.']);
    });

    it('handles error value as an array of strings', () => {
      const parsed = {
        eSearchResult: {
          ErrorList: { PhraseNotFound: ['term1', 'term2'] },
        },
      };
      const messages = handler.extractNcbiErrorMessages(parsed);
      expect(messages).toEqual(['term1', 'term2']);
    });

    it('handles error value as an object with #text property', () => {
      const parsed = { ERROR: { '#text': 'Extracted from text node' } };
      const messages = handler.extractNcbiErrorMessages(parsed);
      expect(messages).toEqual(['Extracted from text node']);
    });
  });

  // ── parseAndHandleResponse — text mode ───────────────────────────────────

  describe('parseAndHandleResponse (text mode)', () => {
    it('returns the raw string as-is for retmode "text"', () => {
      const raw = 'Some plain text response from NCBI.';
      const result = handler.parseAndHandleResponse<string>(raw, 'efetch', context, {
        retmode: 'text',
      });
      expect(result).toBe(raw);
    });
  });

  // ── parseAndHandleResponse — XML mode ────────────────────────────────────

  describe('parseAndHandleResponse (XML mode)', () => {
    it('parses valid XML and returns an object', () => {
      const result = handler.parseAndHandleResponse<Record<string, unknown>>(
        VALID_ESEARCH_XML,
        'esearch',
        context,
        { retmode: 'xml' },
      );
      expect(result).toBeTruthy();
      expect(typeof result).toBe('object');
      expect(result).toHaveProperty('eSearchResult');
    });

    it('throws McpError with SerializationError code on invalid XML', () => {
      const badXml = 'this is not xml at all <<<';
      expect(() =>
        handler.parseAndHandleResponse(badXml, 'esearch', context, { retmode: 'xml' }),
      ).toThrow(McpError);

      try {
        handler.parseAndHandleResponse(badXml, 'esearch', context, { retmode: 'xml' });
      } catch (err) {
        expect(err).toBeInstanceOf(McpError);
        expect((err as McpError).code).toBe(JsonRpcErrorCode.SerializationError);
      }
    });

    it('throws McpError with ServiceUnavailable code when parsed XML contains an NCBI error structure', () => {
      expect(() =>
        handler.parseAndHandleResponse(ESUMMARY_ERROR_XML, 'esummary', context, {
          retmode: 'xml',
        }),
      ).toThrow(McpError);

      try {
        handler.parseAndHandleResponse(ESUMMARY_ERROR_XML, 'esummary', context, {
          retmode: 'xml',
        });
      } catch (err) {
        expect(err).toBeInstanceOf(McpError);
        expect((err as McpError).code).toBe(JsonRpcErrorCode.ServiceUnavailable);
        expect((err as McpError).message).toContain('NCBI API Error');
      }
    });

    it('returns raw XML string when returnRawXml is true and XML is valid without errors', () => {
      const result = handler.parseAndHandleResponse<string>(VALID_ESEARCH_XML, 'esearch', context, {
        retmode: 'xml',
        returnRawXml: true,
      });
      expect(result).toBe(VALID_ESEARCH_XML);
    });

    it('treats default retmode (no options) as XML and parses successfully', () => {
      const result = handler.parseAndHandleResponse<Record<string, unknown>>(
        VALID_ESEARCH_XML,
        'esearch',
        context,
      );
      expect(result).toBeTruthy();
      expect(typeof result).toBe('object');
      expect(result).toHaveProperty('eSearchResult');
    });

    it('throws ServiceUnavailable for eLinkResult.ERROR in XML', () => {
      try {
        handler.parseAndHandleResponse(ELINK_ERROR_XML, 'elink', context, { retmode: 'xml' });
        throw new Error('Expected to throw');
      } catch (err) {
        expect(err).toBeInstanceOf(McpError);
        expect((err as McpError).code).toBe(JsonRpcErrorCode.ServiceUnavailable);
        expect((err as McpError).message).toContain('Link not available');
      }
    });

    it('throws ServiceUnavailable for eSearchResult.ErrorList in XML', () => {
      try {
        handler.parseAndHandleResponse(ESEARCH_PHRASE_NOT_FOUND_XML, 'esearch', context, {
          retmode: 'xml',
        });
        throw new Error('Expected to throw');
      } catch (err) {
        expect(err).toBeInstanceOf(McpError);
        expect((err as McpError).code).toBe(JsonRpcErrorCode.ServiceUnavailable);
      }
    });

    it('throws ServiceUnavailable for top-level ERROR element in XML', () => {
      try {
        handler.parseAndHandleResponse(TOP_LEVEL_ERROR_XML, 'esearch', context, {
          retmode: 'xml',
        });
        throw new Error('Expected to throw');
      } catch (err) {
        expect(err).toBeInstanceOf(McpError);
        expect((err as McpError).code).toBe(JsonRpcErrorCode.ServiceUnavailable);
        expect((err as McpError).message).toContain('Server unavailable');
      }
    });
  });

  // ── parseAndHandleResponse — JSON mode ───────────────────────────────────

  describe('parseAndHandleResponse (JSON mode)', () => {
    it('parses valid JSON and returns the object', () => {
      const json = JSON.stringify({ result: { count: 5, ids: ['123', '456'] } });
      const result = handler.parseAndHandleResponse<{ result: unknown }>(json, 'esearch', context, {
        retmode: 'json',
      });
      expect(result).toEqual({ result: { count: 5, ids: ['123', '456'] } });
    });

    it('throws McpError with SerializationError code on invalid JSON', () => {
      const badJson = '{ not valid json }}}';
      expect(() =>
        handler.parseAndHandleResponse(badJson, 'esearch', context, { retmode: 'json' }),
      ).toThrow(McpError);

      try {
        handler.parseAndHandleResponse(badJson, 'esearch', context, { retmode: 'json' });
      } catch (err) {
        expect(err).toBeInstanceOf(McpError);
        expect((err as McpError).code).toBe(JsonRpcErrorCode.SerializationError);
      }
    });

    it('throws McpError with ServiceUnavailable when JSON contains an "error" field', () => {
      const errorJson = JSON.stringify({ error: 'API key not valid' });
      expect(() =>
        handler.parseAndHandleResponse(errorJson, 'esearch', context, { retmode: 'json' }),
      ).toThrow(McpError);

      try {
        handler.parseAndHandleResponse(errorJson, 'esearch', context, { retmode: 'json' });
      } catch (err) {
        expect(err).toBeInstanceOf(McpError);
        expect((err as McpError).code).toBe(JsonRpcErrorCode.ServiceUnavailable);
        expect((err as McpError).message).toContain('API key not valid');
      }
    });
  });

  // ── parseAndHandleResponse — unknown retmode ─────────────────────────────

  describe('parseAndHandleResponse (unknown retmode)', () => {
    it('returns the raw text when retmode is unrecognized', () => {
      const raw = 'some raw data';
      // Cast to satisfy the type — the source handles any string retmode at runtime
      const result = handler.parseAndHandleResponse<string>(raw, 'einfo', context, {
        retmode: 'medline' as 'text',
      });
      expect(result).toBe(raw);
    });
  });
});
