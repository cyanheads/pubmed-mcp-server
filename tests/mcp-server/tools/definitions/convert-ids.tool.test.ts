/**
 * @fileoverview Tests for the convert-ids tool.
 * @module tests/mcp-server/tools/definitions/convert-ids.tool.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it, vi } from 'vitest';

import { textBlocks } from '../../../_helpers.js';

const mockIdConvert = vi.fn();
vi.mock('@/services/ncbi/ncbi-service.js', () => ({
  getNcbiService: () => ({ idConvert: mockIdConvert }),
}));

const { convertIdsTool } = await import('@/mcp-server/tools/definitions/convert-ids.tool.js');

describe('convertIdsTool', () => {
  it('validates input schema', () => {
    const input = convertIdsTool.input.parse({ ids: ['23193287'], idType: 'pmid' });
    expect(input.ids).toEqual(['23193287']);
    expect(input.idType).toBe('pmid');
  });

  it('rejects empty ids array', () => {
    expect(() => convertIdsTool.input.parse({ ids: [], idType: 'pmid' })).toThrow();
  });

  it('rejects more than 50 ids', () => {
    const ids = Array.from({ length: 51 }, (_, i) => String(i));
    expect(() => convertIdsTool.input.parse({ ids, idType: 'pmid' })).toThrow();
  });

  it('rejects invalid idType', () => {
    expect(() => convertIdsTool.input.parse({ ids: ['123'], idType: 'invalid' })).toThrow();
  });

  it('accepts all valid idType values with format-appropriate IDs', () => {
    expect(() => convertIdsTool.input.parse({ ids: ['23193287'], idType: 'pmid' })).not.toThrow();
    expect(() =>
      convertIdsTool.input.parse({ ids: ['PMC3531190'], idType: 'pmcid' }),
    ).not.toThrow();
    expect(() =>
      convertIdsTool.input.parse({ ids: ['10.1093/nar/gks1195'], idType: 'doi' }),
    ).not.toThrow();
  });

  it('maps successful conversion records with string coercion', async () => {
    mockIdConvert.mockResolvedValue([
      {
        'requested-id': '23193287',
        pmid: 23193287,
        pmcid: 'PMC3531190',
        doi: '10.1093/nar/gks1195',
      },
    ]);

    const ctx = createMockContext({ errors: convertIdsTool.errors });
    const input = convertIdsTool.input.parse({ ids: ['23193287'], idType: 'pmid' });
    const result = await convertIdsTool.handler(input, ctx);

    expect(result.records).toEqual([
      {
        requestedId: '23193287',
        pmid: '23193287',
        pmcid: 'PMC3531190',
        doi: '10.1093/nar/gks1195',
      },
    ]);
    expect(result.totalConverted).toBe(1);
    expect(result.totalSubmitted).toBe(1);
  });

  it('counts error records as not converted', async () => {
    mockIdConvert.mockResolvedValue([
      {
        'requested-id': '23193287',
        pmid: '23193287',
        pmcid: 'PMC3531190',
        doi: '10.1093/nar/gks1195',
      },
      { 'requested-id': '99999999', errmsg: 'Not a valid ID', status: 'error' },
    ]);

    const ctx = createMockContext({ errors: convertIdsTool.errors });
    const input = convertIdsTool.input.parse({ ids: ['23193287', '99999999'], idType: 'pmid' });
    const result = await convertIdsTool.handler(input, ctx);

    expect(result.totalConverted).toBe(1);
    expect(result.totalSubmitted).toBe(2);
    expect(result.records[1]).toEqual({ requestedId: '99999999', errmsg: 'Not a valid ID' });
  });

  describe('PMC-not-found errmsg rewrite (issue #43)', () => {
    it('rewrites the upstream "Identifier not found in PMC" wording with a recovery hint', async () => {
      mockIdConvert.mockResolvedValue([
        {
          'requested-id': '37952131',
          pmid: '37952131',
          errmsg: 'Identifier not found in PMC',
        },
      ]);

      const ctx = createMockContext({ errors: convertIdsTool.errors });
      const input = convertIdsTool.input.parse({ ids: ['37952131'], idType: 'pmid' });
      const result = await convertIdsTool.handler(input, ctx);

      expect(result.records[0]?.errmsg).toContain('pubmed_fetch_articles');
      expect(result.records[0]?.errmsg).not.toBe('Identifier not found in PMC');
    });

    it('leaves other NCBI error messages untouched', async () => {
      mockIdConvert.mockResolvedValue([
        { 'requested-id': '99999999', errmsg: 'Some other error from NCBI' },
      ]);

      const ctx = createMockContext({ errors: convertIdsTool.errors });
      const input = convertIdsTool.input.parse({ ids: ['99999999'], idType: 'pmid' });
      const result = await convertIdsTool.handler(input, ctx);

      expect(result.records[0]?.errmsg).toBe('Some other error from NCBI');
    });
  });

  it('omits undefined optional fields from records', async () => {
    mockIdConvert.mockResolvedValue([
      { 'requested-id': 'PMC3531190', pmcid: 'PMC3531190', pmid: '23193287' },
    ]);

    const ctx = createMockContext({ errors: convertIdsTool.errors });
    const input = convertIdsTool.input.parse({ ids: ['PMC3531190'], idType: 'pmcid' });
    const result = await convertIdsTool.handler(input, ctx);

    expect(result.records[0]).not.toHaveProperty('doi');
    expect(result.records[0]).not.toHaveProperty('errmsg');
  });

  it('passes idType through to service', async () => {
    mockIdConvert.mockResolvedValue([]);

    const ctx = createMockContext({ errors: convertIdsTool.errors });
    const input = convertIdsTool.input.parse({ ids: ['10.1093/nar/gks1195'], idType: 'doi' });
    await convertIdsTool.handler(input, ctx);

    expect(mockIdConvert).toHaveBeenCalledWith(
      ['10.1093/nar/gks1195'],
      'doi',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it('handles batch of multiple IDs', async () => {
    mockIdConvert.mockResolvedValue([
      { 'requested-id': '111', pmid: '111', pmcid: 'PMC1' },
      { 'requested-id': '222', pmid: '222', pmcid: 'PMC2' },
      { 'requested-id': '333', pmid: '333', pmcid: 'PMC3' },
    ]);

    const ctx = createMockContext({ errors: convertIdsTool.errors });
    const input = convertIdsTool.input.parse({ ids: ['111', '222', '333'], idType: 'pmid' });
    const result = await convertIdsTool.handler(input, ctx);

    expect(result.records).toHaveLength(3);
    expect(result.totalConverted).toBe(3);
  });

  it('formats successful conversions as markdown table', () => {
    const blocks = textBlocks(
      convertIdsTool.format!({
        records: [
          {
            requestedId: '23193287',
            pmid: '23193287',
            pmcid: 'PMC3531190',
            doi: '10.1093/nar/gks1195',
          },
        ],
        totalConverted: 1,
        totalSubmitted: 1,
      }),
    );

    expect(blocks[0]?.text).toContain('**Converted:** 1/1');
    expect(blocks[0]?.text).toContain('23193287');
    expect(blocks[0]?.text).toContain('PMC3531190');
    expect(blocks[0]?.text).toContain('10.1093/nar/gks1195');
  });

  it('renders error records in the unified table', () => {
    const blocks = textBlocks(
      convertIdsTool.format!({
        records: [{ requestedId: '99999999', errmsg: 'Not a valid ID' }],
        totalConverted: 0,
        totalSubmitted: 1,
      }),
    );

    const text = blocks[0]?.text ?? '';
    expect(text).toContain('**Converted:** 0/1');
    expect(text).toContain('| Requested ID | PMID | PMCID | DOI | Error |');
    expect(text).toContain('| 99999999 | - | - | - | Not a valid ID |');
  });

  it('renders successes and failures in one table', () => {
    const blocks = textBlocks(
      convertIdsTool.format!({
        records: [
          {
            requestedId: '23193287',
            pmid: '23193287',
            pmcid: 'PMC3531190',
            doi: '10.1093/nar/gks1195',
          },
          { requestedId: '99999999', errmsg: 'Not a valid ID' },
        ],
        totalConverted: 1,
        totalSubmitted: 2,
      }),
    );

    const text = blocks[0]?.text ?? '';
    expect(text).toContain('| 23193287 | 23193287 | PMC3531190 | 10.1093/nar/gks1195 | - |');
    expect(text).toContain('| 99999999 | - | - | - | Not a valid ID |');
  });

  it('formats dash for missing optional fields', () => {
    const blocks = textBlocks(
      convertIdsTool.format!({
        records: [{ requestedId: 'PMC3531190', pmcid: 'PMC3531190', pmid: '23193287' }],
        totalConverted: 1,
        totalSubmitted: 1,
      }),
    );

    expect(blocks[0]?.text).toContain('- |');
  });
});
