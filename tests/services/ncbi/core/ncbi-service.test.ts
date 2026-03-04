/**
 * @fileoverview Unit tests for NcbiService — the high-level E-utility facade.
 * Verifies that each public method enqueues the correct endpoint, applies the
 * right default options, and maps raw parsed responses to typed results.
 * @module tests/services/ncbi/core/ncbi-service.test
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { requestContextService } from '@/utils/internal/requestContext.js';

import { NcbiService } from '../../../../src/services/ncbi/core/ncbi-service.js';

// ─── Mocks ───────────────────────────────────────────────────────────────────

const mockApiClient = {
  makeRequest: vi.fn(),
};

const mockQueue = {
  enqueue: vi.fn(),
};

const mockResponseHandler = {
  parseAndHandleResponse: vi.fn(),
};

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('NcbiService', () => {
  let service: NcbiService;
  let context: ReturnType<typeof requestContextService.createRequestContext>;

  beforeEach(() => {
    vi.clearAllMocks();

    // Execute the task function immediately so the full pipeline runs in tests.
    mockQueue.enqueue.mockImplementation(async (task: () => Promise<unknown>) => task());

    mockApiClient.makeRequest.mockResolvedValue('<xml/>');

    service = new NcbiService(
      mockApiClient as never,
      mockQueue as never,
      mockResponseHandler as never,
    );
    context = requestContextService.createRequestContext({ operation: 'test-ncbi-service' });
  });

  // ── eSearch ────────────────────────────────────────────────────────────────

  describe('eSearch', () => {
    it('calls performRequest with the esearch endpoint and retmode xml', async () => {
      mockResponseHandler.parseAndHandleResponse.mockReturnValue({
        eSearchResult: {
          Count: '0',
          RetMax: '0',
          RetStart: '0',
          IdList: { Id: [] },
          QueryTranslation: '',
        },
      });

      await service.eSearch({ db: 'pubmed', term: 'cancer' }, context);

      expect(mockApiClient.makeRequest).toHaveBeenCalledWith(
        'esearch',
        { db: 'pubmed', term: 'cancer' },
        context,
        { retmode: 'xml' },
      );
      expect(mockResponseHandler.parseAndHandleResponse).toHaveBeenCalledWith(
        '<xml/>',
        'esearch',
        context,
        { retmode: 'xml' },
      );
    });

    it('returns a normalized ESearchResult with parsed numeric counts and idList', async () => {
      mockResponseHandler.parseAndHandleResponse.mockReturnValue({
        eSearchResult: {
          Count: '5',
          RetMax: '5',
          RetStart: '0',
          IdList: { Id: ['1', '2', '3', '4', '5'] },
          QueryTranslation: 'cancer[MeSH]',
        },
      });

      const result = await service.eSearch({ db: 'pubmed', term: 'cancer' }, context);

      expect(result.count).toBe(5);
      expect(result.retmax).toBe(5);
      expect(result.retstart).toBe(0);
      expect(result.idList).toEqual(['1', '2', '3', '4', '5']);
      expect(result.queryTranslation).toBe('cancer[MeSH]');
    });

    it('includes queryKey and webEnv when present in the response', async () => {
      mockResponseHandler.parseAndHandleResponse.mockReturnValue({
        eSearchResult: {
          Count: '10',
          RetMax: '10',
          RetStart: '0',
          IdList: { Id: [] },
          QueryTranslation: 'test',
          QueryKey: '1',
          WebEnv: 'NCID_1_ABC',
        },
      });

      const result = await service.eSearch(
        { db: 'pubmed', term: 'test', usehistory: 'y' },
        context,
      );

      expect(result.queryKey).toBe('1');
      expect(result.webEnv).toBe('NCID_1_ABC');
    });

    it('omits queryKey and webEnv when absent from the response', async () => {
      mockResponseHandler.parseAndHandleResponse.mockReturnValue({
        eSearchResult: {
          Count: '0',
          RetMax: '0',
          RetStart: '0',
          IdList: { Id: [] },
          QueryTranslation: '',
        },
      });

      const result = await service.eSearch({ db: 'pubmed', term: 'nothing' }, context);

      expect(result).not.toHaveProperty('queryKey');
      expect(result).not.toHaveProperty('webEnv');
    });

    it('includes errorList when present in the response', async () => {
      const errorList = { PhraseNotFound: ['faketerm'] };
      mockResponseHandler.parseAndHandleResponse.mockReturnValue({
        eSearchResult: {
          Count: '0',
          RetMax: '0',
          RetStart: '0',
          IdList: { Id: [] },
          QueryTranslation: '',
          ErrorList: errorList,
        },
      });

      const result = await service.eSearch({ db: 'pubmed', term: 'faketerm' }, context);

      expect(result.errorList).toEqual(errorList);
    });

    it('includes warningList when present in the response', async () => {
      const warningList = { OutputMessage: ['Quoted phrase not found'] };
      mockResponseHandler.parseAndHandleResponse.mockReturnValue({
        eSearchResult: {
          Count: '2',
          RetMax: '2',
          RetStart: '0',
          IdList: { Id: ['10', '20'] },
          QueryTranslation: 'test',
          WarningList: warningList,
        },
      });

      const result = await service.eSearch({ db: 'pubmed', term: '"rare phrase"' }, context);

      expect(result.warningList).toEqual(warningList);
    });

    it('returns an empty idList when IdList is absent', async () => {
      mockResponseHandler.parseAndHandleResponse.mockReturnValue({
        eSearchResult: {
          Count: '0',
          RetMax: '0',
          RetStart: '0',
          QueryTranslation: '',
        },
      });

      const result = await service.eSearch({ db: 'pubmed', term: 'nothing' }, context);

      expect(result.idList).toEqual([]);
    });
  });

  // ── eSummary ───────────────────────────────────────────────────────────────

  describe('eSummary', () => {
    it('calls the esummary endpoint', async () => {
      const summaryResult = { DocSum: [] };
      mockResponseHandler.parseAndHandleResponse.mockReturnValue({
        eSummaryResult: summaryResult,
      });

      await service.eSummary({ db: 'pubmed', id: '12345' }, context);

      expect(mockApiClient.makeRequest).toHaveBeenCalledWith(
        'esummary',
        { db: 'pubmed', id: '12345' },
        context,
        { retmode: 'xml' },
      );
    });

    it('uses xml retmode by default', async () => {
      mockResponseHandler.parseAndHandleResponse.mockReturnValue({ eSummaryResult: {} });

      await service.eSummary({ db: 'pubmed', id: '12345' }, context);

      expect(mockApiClient.makeRequest).toHaveBeenCalledWith(
        'esummary',
        expect.anything(),
        context,
        { retmode: 'xml' },
      );
    });

    it('uses json retmode when version is 2.0 and retmode is json', async () => {
      mockResponseHandler.parseAndHandleResponse.mockReturnValue({ eSummaryResult: {} });

      await service.eSummary(
        { db: 'pubmed', id: '12345', version: '2.0', retmode: 'json' },
        context,
      );

      expect(mockApiClient.makeRequest).toHaveBeenCalledWith(
        'esummary',
        expect.anything(),
        context,
        { retmode: 'json' },
      );
    });

    it('returns the inner eSummaryResult directly', async () => {
      const summaryResult = { DocumentSummarySet: { DocumentSummary: [] } };
      mockResponseHandler.parseAndHandleResponse.mockReturnValue({
        eSummaryResult: summaryResult,
      });

      const result = await service.eSummary({ db: 'pubmed', id: '12345' }, context);

      expect(result).toBe(summaryResult);
    });
  });

  // ── eFetch ─────────────────────────────────────────────────────────────────

  describe('eFetch', () => {
    it('calls the efetch endpoint', async () => {
      mockResponseHandler.parseAndHandleResponse.mockReturnValue({ PubmedArticleSet: {} });

      await service.eFetch({ db: 'pubmed', id: '12345' }, context);

      expect(mockApiClient.makeRequest).toHaveBeenCalledWith(
        'efetch',
        { db: 'pubmed', id: '12345' },
        context,
        expect.objectContaining({ retmode: 'xml' }),
      );
    });

    it('uses xml retmode by default', async () => {
      mockResponseHandler.parseAndHandleResponse.mockReturnValue({});

      await service.eFetch({ db: 'pubmed', id: '12345' }, context);

      expect(mockApiClient.makeRequest).toHaveBeenCalledWith(
        'efetch',
        expect.anything(),
        context,
        expect.objectContaining({ retmode: 'xml' }),
      );
    });

    it('passes through caller-supplied options', async () => {
      mockResponseHandler.parseAndHandleResponse.mockReturnValue('raw abstract text');

      await service.eFetch({ db: 'pubmed', id: '12345' }, context, {
        retmode: 'text',
        rettype: 'abstract',
      });

      expect(mockApiClient.makeRequest).toHaveBeenCalledWith(
        'efetch',
        expect.anything(),
        context,
        expect.objectContaining({ retmode: 'text', rettype: 'abstract' }),
      );
    });

    it('forces POST when id list has more than 200 comma-separated IDs', async () => {
      mockResponseHandler.parseAndHandleResponse.mockReturnValue({});

      const ids = Array.from({ length: 201 }, (_, i) => String(i + 1)).join(',');
      await service.eFetch({ db: 'pubmed', id: ids }, context);

      expect(mockApiClient.makeRequest).toHaveBeenCalledWith(
        'efetch',
        expect.anything(),
        context,
        expect.objectContaining({ usePost: true }),
      );
    });

    it('does not force POST when id list has 200 or fewer IDs', async () => {
      mockResponseHandler.parseAndHandleResponse.mockReturnValue({});

      const ids = Array.from({ length: 200 }, (_, i) => String(i + 1)).join(',');
      await service.eFetch({ db: 'pubmed', id: ids }, context);

      const callOptions = mockApiClient.makeRequest.mock.calls[0]?.[3] as
        | Record<string, unknown>
        | undefined;
      expect(callOptions?.usePost).toBeFalsy();
    });
  });

  // ── eLink ──────────────────────────────────────────────────────────────────

  describe('eLink', () => {
    it('calls the elink endpoint with xml retmode', async () => {
      mockResponseHandler.parseAndHandleResponse.mockReturnValue({ eLinkResult: {} });

      await service.eLink({ db: 'pubmed', dbfrom: 'pubmed', id: '12345' }, context);

      expect(mockApiClient.makeRequest).toHaveBeenCalledWith(
        'elink',
        { db: 'pubmed', dbfrom: 'pubmed', id: '12345' },
        context,
        { retmode: 'xml' },
      );
      expect(mockResponseHandler.parseAndHandleResponse).toHaveBeenCalledWith(
        '<xml/>',
        'elink',
        context,
        { retmode: 'xml' },
      );
    });
  });

  // ── eSpell ─────────────────────────────────────────────────────────────────

  describe('eSpell', () => {
    it('calls the espell endpoint with xml retmode', async () => {
      mockResponseHandler.parseAndHandleResponse.mockReturnValue({
        eSpellResult: { Query: 'cancer', CorrectedQuery: 'cancer' },
      });

      await service.eSpell({ db: 'pubmed', term: 'cancer' }, context);

      expect(mockApiClient.makeRequest).toHaveBeenCalledWith(
        'espell',
        { db: 'pubmed', term: 'cancer' },
        context,
        { retmode: 'xml' },
      );
    });

    it('returns original, corrected, and hasSuggestion fields', async () => {
      mockResponseHandler.parseAndHandleResponse.mockReturnValue({
        eSpellResult: { Query: 'dibeates', CorrectedQuery: 'diabetes' },
      });

      const result = await service.eSpell({ db: 'pubmed', term: 'dibeates' }, context);

      expect(result).toMatchObject({
        original: 'dibeates',
        corrected: 'diabetes',
        hasSuggestion: true,
      });
    });

    it('sets hasSuggestion true when corrected differs from original', async () => {
      mockResponseHandler.parseAndHandleResponse.mockReturnValue({
        eSpellResult: { Query: 'cancre', CorrectedQuery: 'cancer' },
      });

      const result = await service.eSpell({ db: 'pubmed', term: 'cancre' }, context);

      expect(result.hasSuggestion).toBe(true);
    });

    it('sets hasSuggestion false when corrected equals original', async () => {
      mockResponseHandler.parseAndHandleResponse.mockReturnValue({
        eSpellResult: { Query: 'cancer', CorrectedQuery: 'cancer' },
      });

      const result = await service.eSpell({ db: 'pubmed', term: 'cancer' }, context);

      expect(result.hasSuggestion).toBe(false);
    });

    it('sets hasSuggestion false when CorrectedQuery is empty', async () => {
      mockResponseHandler.parseAndHandleResponse.mockReturnValue({
        eSpellResult: { Query: 'cancer', CorrectedQuery: '' },
      });

      const result = await service.eSpell({ db: 'pubmed', term: 'cancer' }, context);

      expect(result.hasSuggestion).toBe(false);
    });

    it('falls back corrected to original when CorrectedQuery is empty', async () => {
      mockResponseHandler.parseAndHandleResponse.mockReturnValue({
        eSpellResult: { Query: 'cancer', CorrectedQuery: '' },
      });

      const result = await service.eSpell({ db: 'pubmed', term: 'cancer' }, context);

      expect(result.corrected).toBe('cancer');
    });
  });

  // ── eInfo ──────────────────────────────────────────────────────────────────

  describe('eInfo', () => {
    it('calls the einfo endpoint with xml retmode', async () => {
      mockResponseHandler.parseAndHandleResponse.mockReturnValue({ eInfoResult: {} });

      await service.eInfo({ db: 'pubmed' }, context);

      expect(mockApiClient.makeRequest).toHaveBeenCalledWith('einfo', { db: 'pubmed' }, context, {
        retmode: 'xml',
      });
      expect(mockResponseHandler.parseAndHandleResponse).toHaveBeenCalledWith(
        '<xml/>',
        'einfo',
        context,
        { retmode: 'xml' },
      );
    });

    it('works without a db param (lists all databases)', async () => {
      mockResponseHandler.parseAndHandleResponse.mockReturnValue({ eInfoResult: {} });

      await service.eInfo({}, context);

      expect(mockApiClient.makeRequest).toHaveBeenCalledWith('einfo', {}, context, {
        retmode: 'xml',
      });
    });
  });

  // ── Queue integration ──────────────────────────────────────────────────────

  describe('queue integration', () => {
    it('passes context, endpoint, and params to queue.enqueue', async () => {
      mockResponseHandler.parseAndHandleResponse.mockReturnValue({
        eSearchResult: {
          Count: '0',
          RetMax: '0',
          RetStart: '0',
          IdList: { Id: [] },
          QueryTranslation: '',
        },
      });

      const params = { db: 'pubmed', term: 'test' };
      await service.eSearch(params, context);

      expect(mockQueue.enqueue).toHaveBeenCalledWith(
        expect.any(Function),
        context,
        'esearch',
        params,
      );
    });
  });
});
