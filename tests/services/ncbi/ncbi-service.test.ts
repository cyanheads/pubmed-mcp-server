/**
 * @fileoverview Tests for the NCBI service facade.
 * @module tests/services/ncbi/ncbi-service.test
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NcbiApiClient } from '@/services/ncbi/api-client.js';
import { NcbiService } from '@/services/ncbi/ncbi-service.js';
import type { NcbiRequestQueue } from '@/services/ncbi/request-queue.js';
import { NcbiResponseHandler } from '@/services/ncbi/response-handler.js';

vi.mock('@cyanheads/mcp-ts-core/utils', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), notice: vi.fn(), warning: vi.fn(), error: vi.fn() },
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

  const service = new NcbiService(mockApiClient, mockQueue, mockResponseHandler, 0);
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

    it('parses entity-heavy XML responses end to end', async () => {
      const mockApiClient = {
        makeRequest: vi.fn(),
      } as unknown as NcbiApiClient;
      const mockQueue = {
        enqueue: vi.fn(async (task: () => Promise<unknown>) => task()),
      } as unknown as NcbiRequestQueue;
      const service = new NcbiService(mockApiClient, mockQueue, new NcbiResponseHandler(), 0);

      const heavyTitle = `Signal${'&#x2013;'.repeat(1001)}axis`;
      (
        mockApiClient.makeRequest as ReturnType<typeof vi.fn>
      ).mockResolvedValue(`<?xml version="1.0"?>
<PubmedArticleSet>
  <PubmedArticle>
    <MedlineCitation>
      <PMID>12345</PMID>
      <Article>
        <ArticleTitle>${heavyTitle}</ArticleTitle>
        <Pagination>
          <MedlinePgn>100&#x2013;108</MedlinePgn>
        </Pagination>
        <Journal>
          <Title>Journal of Testing</Title>
          <JournalIssue>
            <PubDate>
              <Year>2024</Year>
            </PubDate>
          </JournalIssue>
        </Journal>
        <PublicationTypeList>
          <PublicationType>Journal Article</PublicationType>
        </PublicationTypeList>
      </Article>
    </MedlineCitation>
  </PubmedArticle>
</PubmedArticleSet>`);

      const result = await service.eFetch<Record<string, unknown>>({ db: 'pubmed', id: '12345' });
      const articleSet = result.PubmedArticleSet as Record<string, unknown>;
      const articles = articleSet.PubmedArticle as Record<string, unknown>[];
      const article = articles[0] as Record<string, unknown>;
      const medlineCitation = article.MedlineCitation as Record<string, unknown>;
      const parsedArticle = medlineCitation.Article as Record<string, unknown>;

      expect(articles).toHaveLength(1);
      expect(parsedArticle.ArticleTitle).toBe(`Signal${'\u2013'.repeat(1001)}axis`);
      expect((parsedArticle.Pagination as Record<string, unknown>).MedlinePgn).toBe('100\u2013108');
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

describe('NcbiService.eCitMatch', () => {
  it('formats bdata and parses matched response', async () => {
    const { service, mockApiClient, mockResponseHandler } = createMockService();
    (mockApiClient.makeRequest as ReturnType<typeof vi.fn>).mockResolvedValue('<xml/>');
    (mockResponseHandler.parseAndHandleResponse as ReturnType<typeof vi.fn>).mockReturnValue(
      'proc natl acad sci u s a|1991|88|3248|mann bj|ref1|8400044\r\n',
    );

    const results = await service.eCitMatch([
      {
        journal: 'proc natl acad sci u s a',
        year: '1991',
        volume: '88',
        firstPage: '3248',
        authorName: 'mann bj',
        key: 'ref1',
      },
    ]);

    expect(results).toEqual([{ key: 'ref1', matched: true, pmid: '8400044', status: 'matched' }]);
  });

  it('handles NOT_FOUND responses', async () => {
    const { service, mockApiClient, mockResponseHandler } = createMockService();
    (mockApiClient.makeRequest as ReturnType<typeof vi.fn>).mockResolvedValue('<xml/>');
    (mockResponseHandler.parseAndHandleResponse as ReturnType<typeof vi.fn>).mockReturnValue(
      'unknown|||||ref1|NOT_FOUND\r\n',
    );

    const results = await service.eCitMatch([{ key: 'ref1', journal: 'unknown' }]);
    expect(results).toEqual([
      { key: 'ref1', matched: false, pmid: null, status: 'not_found', detail: 'NOT_FOUND' },
    ]);
  });

  it('handles AMBIGUOUS responses', async () => {
    const { service, mockApiClient, mockResponseHandler } = createMockService();
    (mockApiClient.makeRequest as ReturnType<typeof vi.fn>).mockResolvedValue('<xml/>');
    (mockResponseHandler.parseAndHandleResponse as ReturnType<typeof vi.fn>).mockReturnValue(
      '|2020||||ref1|AMBIGUOUS\r\n',
    );

    const results = await service.eCitMatch([{ key: 'ref1', year: '2020' }]);
    expect(results).toEqual([
      { key: 'ref1', matched: false, pmid: null, status: 'ambiguous', detail: 'AMBIGUOUS' },
    ]);
  });

  it('parses multiple citations in one response', async () => {
    const { service, mockApiClient, mockResponseHandler } = createMockService();
    (mockApiClient.makeRequest as ReturnType<typeof vi.fn>).mockResolvedValue('<xml/>');
    (mockResponseHandler.parseAndHandleResponse as ReturnType<typeof vi.fn>).mockReturnValue(
      'nature|2020|||smith|ref1|12345\r\nscience|2021|||jones|ref2|NOT_FOUND\r\n',
    );

    const results = await service.eCitMatch([
      { journal: 'nature', year: '2020', authorName: 'smith', key: 'ref1' },
      { journal: 'science', year: '2021', authorName: 'jones', key: 'ref2' },
    ]);

    expect(results).toHaveLength(2);
    expect(results[0]).toEqual({ key: 'ref1', matched: true, pmid: '12345', status: 'matched' });
    expect(results[1]).toEqual({
      key: 'ref2',
      matched: false,
      pmid: null,
      status: 'not_found',
      detail: 'NOT_FOUND',
    });
  });

  it('fills empty fields with empty strings in bdata', async () => {
    const { service, mockApiClient, mockResponseHandler } = createMockService();
    (mockApiClient.makeRequest as ReturnType<typeof vi.fn>).mockResolvedValue('<xml/>');
    (mockResponseHandler.parseAndHandleResponse as ReturnType<typeof vi.fn>).mockReturnValue(
      '||||smith|ref1|12345\r\n',
    );

    await service.eCitMatch([{ authorName: 'smith', key: 'ref1' }]);

    const bdata = (mockApiClient.makeRequest as ReturnType<typeof vi.fn>).mock.calls[0]?.[1]?.bdata;
    expect(bdata).toBe('||||smith|ref1|');
  });
});

describe('NcbiService.idConvert', () => {
  function createIdConvertService() {
    const mockApiClient = {
      makeExternalRequest: vi.fn(),
    } as unknown as NcbiApiClient;

    const mockQueue = {
      enqueue: vi.fn(async (task: () => Promise<unknown>) => task()),
    } as unknown as NcbiRequestQueue;

    const service = new NcbiService(
      mockApiClient,
      mockQueue,
      {} as unknown as NcbiResponseHandler,
      0,
    );
    return { service, mockApiClient };
  }

  it('parses valid JSON response and returns records', async () => {
    const { service, mockApiClient } = createIdConvertService();
    (mockApiClient.makeExternalRequest as ReturnType<typeof vi.fn>).mockResolvedValue(
      JSON.stringify({
        status: 'ok',
        'response-date': '2026-03-31',
        request: {},
        records: [
          {
            'requested-id': '23193287',
            pmid: '23193287',
            pmcid: 'PMC3531190',
            doi: '10.1093/nar/gks1195',
          },
        ],
      }),
    );

    const records = await service.idConvert(['23193287'], 'pmid');
    expect(records).toEqual([
      {
        'requested-id': '23193287',
        pmid: '23193287',
        pmcid: 'PMC3531190',
        doi: '10.1093/nar/gks1195',
      },
    ]);
  });

  it('joins multiple IDs with commas', async () => {
    const { service, mockApiClient } = createIdConvertService();
    (mockApiClient.makeExternalRequest as ReturnType<typeof vi.fn>).mockResolvedValue(
      JSON.stringify({ records: [] }),
    );

    await service.idConvert(['111', '222', '333'], 'pmid');

    const params = (mockApiClient.makeExternalRequest as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[1];
    expect(params?.ids).toBe('111,222,333');
    expect(params?.idtype).toBe('pmid');
  });

  it('omits idtype param when not provided', async () => {
    const { service, mockApiClient } = createIdConvertService();
    (mockApiClient.makeExternalRequest as ReturnType<typeof vi.fn>).mockResolvedValue(
      JSON.stringify({ records: [] }),
    );

    await service.idConvert(['PMC123']);

    const params = (mockApiClient.makeExternalRequest as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[1];
    expect(params).not.toHaveProperty('idtype');
  });

  it('throws SerializationError on invalid JSON', async () => {
    const { service, mockApiClient } = createIdConvertService();
    (mockApiClient.makeExternalRequest as ReturnType<typeof vi.fn>).mockResolvedValue('not json');

    await expect(service.idConvert(['123'])).rejects.toMatchObject({
      code: JsonRpcErrorCode.SerializationError,
      message: expect.stringContaining('Failed to parse'),
    });
  });

  it('returns empty array when response has no records', async () => {
    const { service, mockApiClient } = createIdConvertService();
    (mockApiClient.makeExternalRequest as ReturnType<typeof vi.fn>).mockResolvedValue(
      JSON.stringify({ status: 'ok' }),
    );

    const records = await service.idConvert(['123']);
    expect(records).toEqual([]);
  });
});

describe('NcbiService retry behavior', () => {
  let setTimeoutSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // Execute retry backoff timers immediately so retry behavior stays deterministic.
    setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void) => {
      fn();
      return 0;
    }) as unknown as typeof setTimeout);
  });

  afterEach(() => {
    setTimeoutSpy.mockRestore();
  });

  function createRetryService(maxRetries: number) {
    const mockApiClient = {
      makeRequest: vi.fn(),
    } as unknown as NcbiApiClient;

    const mockQueue = {
      enqueue: vi.fn(async (task: () => Promise<unknown>) => task()),
    } as unknown as NcbiRequestQueue;

    const mockResponseHandler = {
      parseAndHandleResponse: vi.fn(),
    } as unknown as NcbiResponseHandler;

    const service = new NcbiService(mockApiClient, mockQueue, mockResponseHandler, maxRetries);
    return { service, mockApiClient, mockResponseHandler };
  }

  it('succeeds on first attempt without retrying', async () => {
    const { service, mockApiClient, mockResponseHandler } = createRetryService(3);
    const makeRequest = mockApiClient.makeRequest as ReturnType<typeof vi.fn>;
    const parseResponse = mockResponseHandler.parseAndHandleResponse as ReturnType<typeof vi.fn>;

    makeRequest.mockResolvedValue('<xml/>');
    parseResponse.mockReturnValue({
      eSearchResult: {
        Count: '1',
        RetMax: '1',
        RetStart: '0',
        IdList: { Id: ['1'] },
        QueryTranslation: '',
      },
    });

    const result = await service.eSearch({ db: 'pubmed', term: 'test' });
    expect(result.count).toBe(1);
    expect(makeRequest).toHaveBeenCalledTimes(1);
    expect(parseResponse).toHaveBeenCalledTimes(1);
  });

  it('retries on ServiceUnavailable and eventually succeeds', async () => {
    const { service, mockApiClient, mockResponseHandler } = createRetryService(2);
    const makeRequest = mockApiClient.makeRequest as ReturnType<typeof vi.fn>;
    const parseResponse = mockResponseHandler.parseAndHandleResponse as ReturnType<typeof vi.fn>;

    makeRequest
      .mockRejectedValueOnce(new McpError(JsonRpcErrorCode.ServiceUnavailable, 'unavailable'))
      .mockResolvedValueOnce('<xml/>');
    parseResponse.mockReturnValue({
      eSearchResult: {
        Count: '1',
        RetMax: '1',
        RetStart: '0',
        IdList: { Id: ['1'] },
        QueryTranslation: '',
      },
    });

    const result = await service.eSearch({ db: 'pubmed', term: 'test' });
    expect(result.count).toBe(1);
    expect(makeRequest).toHaveBeenCalledTimes(2);
  });

  it('retries on XML-level ServiceUnavailable and eventually succeeds', async () => {
    const { service, mockApiClient, mockResponseHandler } = createRetryService(2);
    const makeRequest = mockApiClient.makeRequest as ReturnType<typeof vi.fn>;
    const parseResponse = mockResponseHandler.parseAndHandleResponse as ReturnType<typeof vi.fn>;

    makeRequest.mockResolvedValue('<xml/>');
    parseResponse
      .mockImplementationOnce(() => {
        throw new McpError(
          JsonRpcErrorCode.ServiceUnavailable,
          'NCBI API temporarily unavailable (connection reset)',
        );
      })
      .mockReturnValueOnce({
        eSearchResult: {
          Count: '1',
          RetMax: '1',
          RetStart: '0',
          IdList: { Id: ['1'] },
          QueryTranslation: '',
        },
      });

    const result = await service.eSearch({ db: 'pubmed', term: 'test' });
    expect(result.count).toBe(1);
    expect(makeRequest).toHaveBeenCalledTimes(2);
    expect(parseResponse).toHaveBeenCalledTimes(2);
  });

  it('retries on RateLimited and eventually succeeds', async () => {
    const { service, mockApiClient, mockResponseHandler } = createRetryService(2);
    const makeRequest = mockApiClient.makeRequest as ReturnType<typeof vi.fn>;
    const parseResponse = mockResponseHandler.parseAndHandleResponse as ReturnType<typeof vi.fn>;

    makeRequest
      .mockRejectedValueOnce(new McpError(JsonRpcErrorCode.RateLimited, 'rate limited'))
      .mockResolvedValueOnce('<xml/>');
    parseResponse.mockReturnValue({
      eSearchResult: {
        Count: '1',
        RetMax: '1',
        RetStart: '0',
        IdList: { Id: ['1'] },
        QueryTranslation: '',
      },
    });

    const result = await service.eSearch({ db: 'pubmed', term: 'test' });
    expect(result.count).toBe(1);
    expect(makeRequest).toHaveBeenCalledTimes(2);
  });

  it('retries on Timeout and eventually succeeds', async () => {
    const { service, mockApiClient, mockResponseHandler } = createRetryService(2);
    const makeRequest = mockApiClient.makeRequest as ReturnType<typeof vi.fn>;
    const parseResponse = mockResponseHandler.parseAndHandleResponse as ReturnType<typeof vi.fn>;

    makeRequest
      .mockRejectedValueOnce(new McpError(JsonRpcErrorCode.Timeout, 'timed out'))
      .mockResolvedValueOnce('<xml/>');
    parseResponse.mockReturnValue({
      eSearchResult: {
        Count: '1',
        RetMax: '1',
        RetStart: '0',
        IdList: { Id: ['1'] },
        QueryTranslation: '',
      },
    });

    const result = await service.eSearch({ db: 'pubmed', term: 'test' });
    expect(result.count).toBe(1);
    expect(makeRequest).toHaveBeenCalledTimes(2);
  });

  it('does not retry on non-retryable errors', async () => {
    const { service, mockApiClient } = createRetryService(3);
    const makeRequest = mockApiClient.makeRequest as ReturnType<typeof vi.fn>;

    makeRequest.mockRejectedValueOnce(new McpError(JsonRpcErrorCode.InvalidRequest, 'bad request'));

    await expect(service.eSearch({ db: 'pubmed', term: 'test' })).rejects.toMatchObject({
      code: JsonRpcErrorCode.InvalidRequest,
      message: 'bad request',
    });
    expect(makeRequest).toHaveBeenCalledTimes(1);
  });

  it('does not retry plain request errors', async () => {
    const { service, mockApiClient, mockResponseHandler } = createRetryService(3);
    const makeRequest = mockApiClient.makeRequest as ReturnType<typeof vi.fn>;
    const parseResponse = mockResponseHandler.parseAndHandleResponse as ReturnType<typeof vi.fn>;

    makeRequest.mockRejectedValueOnce(new Error('socket hang up'));

    await expect(service.eSearch({ db: 'pubmed', term: 'test' })).rejects.toThrow('socket hang up');
    expect(makeRequest).toHaveBeenCalledTimes(1);
    expect(parseResponse).not.toHaveBeenCalled();
  });

  it('does not retry plain response-handling errors', async () => {
    const { service, mockApiClient, mockResponseHandler } = createRetryService(3);
    const makeRequest = mockApiClient.makeRequest as ReturnType<typeof vi.fn>;
    const parseResponse = mockResponseHandler.parseAndHandleResponse as ReturnType<typeof vi.fn>;

    makeRequest.mockResolvedValue('<xml/>');
    parseResponse.mockRejectedValueOnce(new Error('Entity expansion limit exceeded: 1001 > 1000'));

    await expect(service.eSearch({ db: 'pubmed', term: 'test' })).rejects.toThrow(
      /Entity expansion limit exceeded/,
    );
    expect(makeRequest).toHaveBeenCalledTimes(1);
    expect(parseResponse).toHaveBeenCalledTimes(1);
  });

  it('does not retry non-transient response McpErrors', async () => {
    const { service, mockApiClient, mockResponseHandler } = createRetryService(3);
    const makeRequest = mockApiClient.makeRequest as ReturnType<typeof vi.fn>;
    const parseResponse = mockResponseHandler.parseAndHandleResponse as ReturnType<typeof vi.fn>;

    makeRequest.mockResolvedValue('<bad>');
    parseResponse.mockImplementation(() => {
      throw new McpError(JsonRpcErrorCode.SerializationError, 'Invalid XML');
    });

    await expect(service.eSearch({ db: 'pubmed', term: 'test' })).rejects.toThrow('Invalid XML');
    expect(makeRequest).toHaveBeenCalledTimes(1);
    expect(parseResponse).toHaveBeenCalledTimes(1);
  });

  it('gives up after maxRetries and includes attempt count', async () => {
    const { service, mockApiClient } = createRetryService(2);
    const makeRequest = mockApiClient.makeRequest as ReturnType<typeof vi.fn>;

    makeRequest.mockRejectedValue(new McpError(JsonRpcErrorCode.ServiceUnavailable, 'unavailable'));

    await expect(service.eSearch({ db: 'pubmed', term: 'test' })).rejects.toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      message: expect.stringContaining('failed after 3 attempts'),
    });
    // 1 initial + 2 retries = 3 total
    expect(makeRequest).toHaveBeenCalledTimes(3);
  });

  it('applies capped exponential backoff with jitter', async () => {
    const { service, mockApiClient } = createRetryService(3);
    const makeRequest = mockApiClient.makeRequest as ReturnType<typeof vi.fn>;

    makeRequest.mockRejectedValue(new McpError(JsonRpcErrorCode.ServiceUnavailable, 'unavailable'));

    await service.eSearch({ db: 'pubmed', term: 'test' }).catch(() => {});

    const retryDelays = (setTimeoutSpy.mock.calls as [unknown, unknown][])
      .map(([, ms]) => ms)
      .filter((ms): ms is number => typeof ms === 'number' && ms >= 500);

    expect(retryDelays).toHaveLength(3);
    expect(retryDelays[0]).toBeGreaterThanOrEqual(750);
    expect(retryDelays[0]).toBeLessThanOrEqual(1250);
    expect(retryDelays[1]).toBeGreaterThanOrEqual(1500);
    expect(retryDelays[1]).toBeLessThanOrEqual(2500);
    expect(retryDelays[2]).toBeGreaterThanOrEqual(3000);
    expect(retryDelays[2]).toBeLessThanOrEqual(5000);
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
