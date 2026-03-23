/**
 * @fileoverview Tests for the NCBI service facade.
 * @module tests/services/ncbi/ncbi-service.test
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NcbiApiClient } from '@/services/ncbi/api-client.js';
import { NcbiService } from '@/services/ncbi/ncbi-service.js';
import type { NcbiRequestQueue } from '@/services/ncbi/request-queue.js';
import type { NcbiResponseHandler } from '@/services/ncbi/response-handler.js';

vi.mock('@cyanheads/mcp-ts-core/utils', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warning: vi.fn(), error: vi.fn() },
}));

function createMockService() {
  const mockApiClient = {
    makeRequest: vi.fn(),
  } as unknown as NcbiApiClient;

  const mockQueue = {
    enqueue: vi.fn(async (task: () => Promise<unknown>) => task()),
  } as unknown as NcbiRequestQueue;

  const mockResponseHandler = {
    parseAndHandleResponse: vi.fn(),
  } as unknown as NcbiResponseHandler;

  const service = new NcbiService(mockApiClient, mockQueue, mockResponseHandler);
  return { service, mockApiClient, mockQueue, mockResponseHandler };
}

describe('NcbiService', () => {
  describe('eSearch', () => {
    it('returns parsed search results', async () => {
      const { service, mockApiClient, mockResponseHandler } = createMockService();
      (mockApiClient.makeRequest as ReturnType<typeof vi.fn>).mockResolvedValue('<xml/>');
      (mockResponseHandler.parseAndHandleResponse as ReturnType<typeof vi.fn>).mockReturnValue({
        eSearchResult: {
          Count: '42',
          RetMax: '20',
          RetStart: '0',
          IdList: { Id: ['111', '222'] },
          QueryTranslation: 'cancer[All Fields]',
        },
      });

      const result = await service.eSearch({ db: 'pubmed', term: 'cancer' });
      expect(result.count).toBe(42);
      expect(result.retmax).toBe(20);
      expect(result.idList).toEqual(['111', '222']);
      expect(result.queryTranslation).toBe('cancer[All Fields]');
    });

    it('handles empty IdList', async () => {
      const { service, mockApiClient, mockResponseHandler } = createMockService();
      (mockApiClient.makeRequest as ReturnType<typeof vi.fn>).mockResolvedValue('<xml/>');
      (mockResponseHandler.parseAndHandleResponse as ReturnType<typeof vi.fn>).mockReturnValue({
        eSearchResult: {
          Count: '0',
          RetMax: '20',
          RetStart: '0',
          QueryTranslation: 'xyz[All Fields]',
        },
      });

      const result = await service.eSearch({ db: 'pubmed', term: 'xyz' });
      expect(result.count).toBe(0);
      expect(result.idList).toEqual([]);
    });
  });

  describe('eSpell', () => {
    it('returns correction when available', async () => {
      const { service, mockApiClient, mockResponseHandler } = createMockService();
      (mockApiClient.makeRequest as ReturnType<typeof vi.fn>).mockResolvedValue('<xml/>');
      (mockResponseHandler.parseAndHandleResponse as ReturnType<typeof vi.fn>).mockReturnValue({
        eSpellResult: {
          Query: 'astma',
          CorrectedQuery: 'asthma',
        },
      });

      const result = await service.eSpell({ db: 'pubmed', term: 'astma' });
      expect(result.original).toBe('astma');
      expect(result.corrected).toBe('asthma');
      expect(result.hasSuggestion).toBe(true);
    });

    it('returns original when no correction', async () => {
      const { service, mockApiClient, mockResponseHandler } = createMockService();
      (mockApiClient.makeRequest as ReturnType<typeof vi.fn>).mockResolvedValue('<xml/>');
      (mockResponseHandler.parseAndHandleResponse as ReturnType<typeof vi.fn>).mockReturnValue({
        eSpellResult: {
          Query: 'cancer',
          CorrectedQuery: '',
        },
      });

      const result = await service.eSpell({ db: 'pubmed', term: 'cancer' });
      expect(result.corrected).toBe('cancer');
      expect(result.hasSuggestion).toBe(false);
    });
  });

  describe('eSummary', () => {
    it('returns summary result', async () => {
      const { service, mockApiClient, mockResponseHandler } = createMockService();
      (mockApiClient.makeRequest as ReturnType<typeof vi.fn>).mockResolvedValue('<xml/>');
      const mockResult = { DocumentSummarySet: { DocumentSummary: [] } };
      (mockResponseHandler.parseAndHandleResponse as ReturnType<typeof vi.fn>).mockReturnValue({
        eSummaryResult: mockResult,
      });

      const result = await service.eSummary({ db: 'pubmed', id: '123' });
      expect(result).toEqual(mockResult);
    });
  });

  describe('eFetch', () => {
    it('delegates to performRequest with correct options', async () => {
      const { service, mockApiClient, mockResponseHandler } = createMockService();
      (mockApiClient.makeRequest as ReturnType<typeof vi.fn>).mockResolvedValue('<xml/>');
      const mockData = { PubmedArticleSet: {} };
      (mockResponseHandler.parseAndHandleResponse as ReturnType<typeof vi.fn>).mockReturnValue(
        mockData,
      );

      const result = await service.eFetch({ db: 'pubmed', id: '123' });
      expect(result).toEqual(mockData);
    });
  });

  describe('eLink', () => {
    it('returns link results', async () => {
      const { service, mockApiClient, mockResponseHandler } = createMockService();
      (mockApiClient.makeRequest as ReturnType<typeof vi.fn>).mockResolvedValue('<xml/>');
      const mockLinks = { eLinkResult: {} };
      (mockResponseHandler.parseAndHandleResponse as ReturnType<typeof vi.fn>).mockReturnValue(
        mockLinks,
      );

      const result = await service.eLink({ db: 'pubmed', dbfrom: 'pubmed', id: '123' });
      expect(result).toEqual(mockLinks);
    });
  });

  describe('eInfo', () => {
    it('returns info results', async () => {
      const { service, mockApiClient, mockResponseHandler } = createMockService();
      (mockApiClient.makeRequest as ReturnType<typeof vi.fn>).mockResolvedValue('<xml/>');
      const mockInfo = { eInfoResult: { DbInfo: {} } };
      (mockResponseHandler.parseAndHandleResponse as ReturnType<typeof vi.fn>).mockReturnValue(
        mockInfo,
      );

      const result = await service.eInfo({ db: 'pubmed' });
      expect(result).toEqual(mockInfo);
    });
  });
});

describe('initNcbiService / getNcbiService', () => {
  afterEach(() => {
    vi.resetModules();
  });

  it('throws if getNcbiService called before init', async () => {
    const { getNcbiService } = await import('@/services/ncbi/ncbi-service.js');
    expect(() => getNcbiService()).toThrow(/not initialized/);
  });
});
