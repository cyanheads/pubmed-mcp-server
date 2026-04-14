/**
 * @fileoverview Tests for the NCBI response handler (XML/JSON/text parsing and error detection).
 * @module tests/services/ncbi/response-handler.test
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { describe, expect, it, vi } from 'vitest';
import { NcbiResponseHandler } from '@/services/ncbi/response-handler.js';

vi.mock('@cyanheads/mcp-ts-core/utils', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
  },
}));

function createHandler() {
  return new NcbiResponseHandler();
}

describe('NcbiResponseHandler', () => {
  describe('parseAndHandleResponse - text mode', () => {
    it('returns raw text for retmode=text', () => {
      const handler = createHandler();
      const result = handler.parseAndHandleResponse<string>('raw text', 'efetch', {
        retmode: 'text',
      });
      expect(result).toBe('raw text');
    });
  });

  describe('parseAndHandleResponse - xml mode', () => {
    it('parses valid XML', () => {
      const handler = createHandler();
      const xml = '<?xml version="1.0"?><eSearchResult><Count>42</Count></eSearchResult>';
      const result = handler.parseAndHandleResponse<Record<string, unknown>>(xml, 'esearch', {
        retmode: 'xml',
      });
      expect(result).toHaveProperty('eSearchResult');
      expect((result.eSearchResult as Record<string, unknown>).Count).toBe(42);
    });

    it('parses XML with more than 1000 numeric character references', () => {
      const handler = createHandler();
      const xml = `<?xml version="1.0"?><root><value>${'&#x2013;'.repeat(1001)}</value></root>`;
      const result = handler.parseAndHandleResponse<Record<string, unknown>>(xml, 'efetch', {
        retmode: 'xml',
      });

      expect((result.root as Record<string, unknown>).value).toBe('–'.repeat(1001));
    });

    it('decodes mixed decimal and hexadecimal numeric entities', () => {
      const handler = createHandler();
      const xml =
        '<?xml version="1.0"?><root><value>Caf&#233; &#x2013; &#x3b2;-catenin</value></root>';
      const result = handler.parseAndHandleResponse<Record<string, unknown>>(xml, 'efetch', {
        retmode: 'xml',
      });

      expect((result.root as Record<string, unknown>).value).toBe(
        'Caf\u00e9 \u2013 \u03b2-catenin',
      );
    });

    it('throws on invalid XML', () => {
      const handler = createHandler();
      expect(() =>
        handler.parseAndHandleResponse('<broken>xml', 'esearch', { retmode: 'xml' }),
      ).toThrow(/invalid XML/i);
    });

    it('throws on NCBI error in XML response', () => {
      const handler = createHandler();
      const xml =
        '<?xml version="1.0"?><eSummaryResult><ERROR>Invalid uid</ERROR></eSummaryResult>';
      expect(() => handler.parseAndHandleResponse(xml, 'esummary', { retmode: 'xml' })).toThrow(
        /NCBI API Error/,
      );
    });

    it('returns raw XML when returnRawXml is true', () => {
      const handler = createHandler();
      const xml = '<?xml version="1.0"?><root><data>hello</data></root>';
      const result = handler.parseAndHandleResponse<string>(xml, 'efetch', {
        retmode: 'xml',
        returnRawXml: true,
      });
      expect(result).toBe(xml);
    });

    it('wraps XML parser failures as serialization errors', () => {
      const handler = createHandler() as NcbiResponseHandler & {
        xmlParser: { parse: (input: string) => never };
      };
      handler.xmlParser = {
        parse: () => {
          throw new Error('synthetic parser failure');
        },
      };

      try {
        handler.parseAndHandleResponse(
          '<?xml version="1.0"?><root><data>hello</data></root>',
          'efetch',
          {
            retmode: 'xml',
          },
        );
        throw new Error('Expected parseAndHandleResponse to throw');
      } catch (error: unknown) {
        expect(error).toBeInstanceOf(McpError);
        expect(error).toMatchObject({
          code: JsonRpcErrorCode.SerializationError,
          message: expect.stringContaining('synthetic parser failure'),
        });
      }
    });
  });

  describe('parseAndHandleResponse - json mode', () => {
    it('parses valid JSON', () => {
      const handler = createHandler();
      const json = '{"result":{"count":10}}';
      const result = handler.parseAndHandleResponse<{ result: { count: number } }>(
        json,
        'esearch',
        { retmode: 'json' },
      );
      expect(result.result.count).toBe(10);
    });

    it('throws on invalid JSON', () => {
      const handler = createHandler();
      expect(() =>
        handler.parseAndHandleResponse('not json', 'esearch', { retmode: 'json' }),
      ).toThrow(/Failed to parse/);
    });

    it('throws on JSON response with error field', () => {
      const handler = createHandler();
      const json = '{"error":"Invalid ID"}';
      expect(() => handler.parseAndHandleResponse(json, 'esearch', { retmode: 'json' })).toThrow(
        /NCBI API Error.*Invalid ID/,
      );
    });
  });

  describe('parseAndHandleResponse - default xml', () => {
    it('defaults to xml when no options', () => {
      const handler = createHandler();
      const xml = '<?xml version="1.0"?><root><value>1</value></root>';
      const result = handler.parseAndHandleResponse<Record<string, unknown>>(xml, 'test');
      expect(result).toHaveProperty('root');
    });
  });

  describe('extractNcbiErrorMessages', () => {
    it('extracts error from eSummaryResult.ERROR', () => {
      const handler = createHandler();
      const messages = handler.extractNcbiErrorMessages({
        eSummaryResult: { ERROR: 'bad uid' },
      });
      expect(messages).toEqual(['bad uid']);
    });

    it('extracts warnings when no errors present', () => {
      const handler = createHandler();
      const messages = handler.extractNcbiErrorMessages({
        eSearchResult: {
          WarningList: { QuotedPhraseNotFound: 'some phrase' },
        },
      });
      expect(messages.some((m) => m.includes('Warning'))).toBe(true);
    });

    it('returns unknown error message for empty structure', () => {
      const handler = createHandler();
      const messages = handler.extractNcbiErrorMessages({});
      expect(messages).toEqual(['Unknown NCBI API error.']);
    });
  });
});
