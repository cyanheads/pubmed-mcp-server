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
  requestContextService: {
    createRequestContext: vi.fn(() => ({ requestId: 'test' })),
  },
}));

/** Tests use a generous deadline so only explicit deadline tests hit it. */
const TEST_DEADLINE_MS = 60_000;

function createMockService(deadlineMs = TEST_DEADLINE_MS) {
  const mockApiClient = {
    makeRequest: vi.fn(),
  } as unknown as NcbiApiClient;

  const mockQueue = {
    enqueue: vi.fn(async (task: () => Promise<unknown>) => task()),
  } as unknown as NcbiRequestQueue;

  const mockResponseHandler = {
    parseAndHandleResponse: vi.fn(),
  } as unknown as NcbiResponseHandler;

  const service = new NcbiService(mockApiClient, mockQueue, mockResponseHandler, 0, deadlineMs);
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

    it('omits errorList and warningList when upstream reports neither', async () => {
      const { service, mockApiClient, mockResponseHandler } = createMockService();
      (mockApiClient.makeRequest as ReturnType<typeof vi.fn>).mockResolvedValue('<xml/>');
      (mockResponseHandler.parseAndHandleResponse as ReturnType<typeof vi.fn>).mockReturnValue({
        eSearchResult: {
          Count: '1',
          RetMax: '1',
          RetStart: '0',
          IdList: { Id: ['111'] },
          QueryTranslation: 'cancer[All Fields]',
        },
      });

      const result = await service.eSearch({ db: 'pubmed', term: 'cancer' });
      expect(result.errorList).toBeUndefined();
      expect(result.warningList).toBeUndefined();
    });

    it('normalizes single-entry ErrorList/WarningList members to string arrays', async () => {
      const { service, mockApiClient, mockResponseHandler } = createMockService();
      (mockApiClient.makeRequest as ReturnType<typeof vi.fn>).mockResolvedValue('<xml/>');
      // NCBI collapses a one-entry list to a scalar, and parseTagValue coerces a
      // numeric-looking phrase to a number.
      (mockResponseHandler.parseAndHandleResponse as ReturnType<typeof vi.fn>).mockReturnValue({
        eSearchResult: {
          Count: '870',
          RetMax: '20',
          RetStart: '0',
          IdList: { Id: ['111'] },
          QueryTranslation: 'lecanemab[All Fields]',
          ErrorList: { FieldNotFound: 'NoSuchField' },
          WarningList: { QuotedPhraseNotFound: 2024, OutputMessage: 'No items found.' },
        },
      });

      const result = await service.eSearch({ db: 'pubmed', term: 'lecanemab[NoSuchField]' });
      expect(result.errorList).toEqual({ FieldNotFound: ['NoSuchField'] });
      expect(result.warningList).toEqual({
        QuotedPhraseNotFound: ['2024'],
        OutputMessage: ['No items found.'],
      });
    });

    it('passes multi-entry ErrorList/WarningList members through unchanged', async () => {
      const { service, mockApiClient, mockResponseHandler } = createMockService();
      (mockApiClient.makeRequest as ReturnType<typeof vi.fn>).mockResolvedValue('<xml/>');
      (mockResponseHandler.parseAndHandleResponse as ReturnType<typeof vi.fn>).mockReturnValue({
        eSearchResult: {
          Count: '0',
          RetMax: '20',
          RetStart: '0',
          QueryTranslation: 'x',
          ErrorList: { FieldNotFound: ['Aithor', 'Jrnal'], PhraseNotFound: ['nomatch'] },
          WarningList: { QuotedPhraseNotFound: ['"Notarealmeshterm"[MeSH Terms]'] },
        },
      });

      const result = await service.eSearch({ db: 'pubmed', term: 'x' });
      expect(result.errorList).toEqual({
        FieldNotFound: ['Aithor', 'Jrnal'],
        PhraseNotFound: ['nomatch'],
      });
      expect(result.warningList).toEqual({
        QuotedPhraseNotFound: ['"Notarealmeshterm"[MeSH Terms]'],
      });
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
      const service = new NcbiService(
        mockApiClient,
        mockQueue,
        new NcbiResponseHandler(),
        0,
        TEST_DEADLINE_MS,
      );

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

  it('parses AMBIGUOUS response with candidate PMIDs into candidatePmids array', async () => {
    const { service, mockApiClient, mockResponseHandler } = createMockService();
    (mockApiClient.makeRequest as ReturnType<typeof vi.fn>).mockResolvedValue('<xml/>');
    (mockResponseHandler.parseAndHandleResponse as ReturnType<typeof vi.fn>).mockReturnValue(
      'nature|2020|||zhang f|ref1|AMBIGUOUS 33057196,32076266,32025019\r\n',
    );

    const results = await service.eCitMatch([
      { journal: 'nature', year: '2020', authorName: 'zhang f', key: 'ref1' },
    ]);

    expect(results[0]).toEqual({
      key: 'ref1',
      matched: false,
      pmid: null,
      status: 'ambiguous',
      detail: 'AMBIGUOUS 33057196,32076266,32025019',
      candidatePmids: ['33057196', '32076266', '32025019'],
    });
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

  it('reconciles dropped upstream rows as not_found (issue #54)', async () => {
    // Upstream returns only 1 of 3 submitted citations — the others were dropped
    // (NCBI omits lines for citations it cannot classify).
    const { service, mockApiClient, mockResponseHandler } = createMockService();
    (mockApiClient.makeRequest as ReturnType<typeof vi.fn>).mockResolvedValue('<xml/>');
    (mockResponseHandler.parseAndHandleResponse as ReturnType<typeof vi.fn>).mockReturnValue(
      'nature|2020|||smith|ref1|12345\r\n',
    );

    const results = await service.eCitMatch([
      { journal: 'nature', year: '2020', authorName: 'smith', key: 'ref1' },
      { journal: 'science', year: '2021', key: 'ref2' },
      { journal: 'lancet', key: 'ref3' },
    ]);

    expect(results).toHaveLength(3);
    expect(results[0]).toEqual({ key: 'ref1', matched: true, pmid: '12345', status: 'matched' });
    expect(results[1]).toEqual({ key: 'ref2', matched: false, pmid: null, status: 'not_found' });
    expect(results[2]).toEqual({ key: 'ref3', matched: false, pmid: null, status: 'not_found' });
  });

  it('preserves upstream row order and fills gaps (issue #54)', async () => {
    // Upstream returns the second citation but not the first or third.
    const { service, mockApiClient, mockResponseHandler } = createMockService();
    (mockApiClient.makeRequest as ReturnType<typeof vi.fn>).mockResolvedValue('<xml/>');
    (mockResponseHandler.parseAndHandleResponse as ReturnType<typeof vi.fn>).mockReturnValue(
      '|2020||||ref2|NOT_FOUND\r\n',
    );

    const results = await service.eCitMatch([
      { journal: 'nature', key: 'ref1' },
      { year: '2020', key: 'ref2' },
      { journal: 'lancet', year: '2019', key: 'ref3' },
    ]);

    // Results must follow submission order, not upstream response order.
    expect(results).toHaveLength(3);
    expect(results[0]?.key).toBe('ref1');
    expect(results[0]?.status).toBe('not_found');
    expect(results[1]?.key).toBe('ref2');
    expect(results[1]?.status).toBe('not_found');
    expect(results[2]?.key).toBe('ref3');
    expect(results[2]?.status).toBe('not_found');
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
      TEST_DEADLINE_MS,
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

  it('SerializationError on idConvert carries reason ncbi_invalid_response + recovery', async () => {
    const { service, mockApiClient } = createIdConvertService();
    (mockApiClient.makeExternalRequest as ReturnType<typeof vi.fn>).mockResolvedValue('not json');

    await expect(service.idConvert(['123'])).rejects.toMatchObject({
      code: JsonRpcErrorCode.SerializationError,
      data: {
        reason: 'ncbi_invalid_response',
        recovery: { hint: expect.stringContaining('Retry the request') },
      },
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

  it('rewrites upstream 400 InvalidParams to ValidationError with idType-specific hint', async () => {
    const { service, mockApiClient } = createIdConvertService();
    (mockApiClient.makeExternalRequest as ReturnType<typeof vi.fn>).mockRejectedValue(
      new McpError(JsonRpcErrorCode.InvalidParams, 'NCBI returned HTTP 400 Bad Request.', {
        url: 'https://www.ncbi.nlm.nih.gov/pmc/utils/idconv/v1.0/',
        status: 400,
        body: '<html>Bad Request</html>',
      }),
    );

    await expect(service.idConvert(['not-a-real-id'], 'pmid')).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      message: expect.stringMatching(/idType="pmid".*numeric digits/i),
      data: { idType: 'pmid', idCount: 1 },
    });
  });

  it('falls back to a generic message when idtype is unknown', async () => {
    const { service, mockApiClient } = createIdConvertService();
    (mockApiClient.makeExternalRequest as ReturnType<typeof vi.fn>).mockRejectedValue(
      new McpError(JsonRpcErrorCode.InvalidParams, 'NCBI returned HTTP 400 Bad Request.'),
    );

    await expect(service.idConvert(['x'])).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      message: expect.stringContaining('unspecified'),
    });
  });

  it('does not rewrite non-400 errors', async () => {
    const { service, mockApiClient } = createIdConvertService();
    (mockApiClient.makeExternalRequest as ReturnType<typeof vi.fn>).mockRejectedValue(
      new McpError(JsonRpcErrorCode.ServiceUnavailable, 'NCBI returned HTTP 503.'),
    );

    await expect(service.idConvert(['123'], 'pmid')).rejects.toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
    });
  });

  it('canonicalizes bare-digit PMCIDs to PMC-prefixed before the request (#73)', async () => {
    const { service, mockApiClient } = createIdConvertService();
    (mockApiClient.makeExternalRequest as ReturnType<typeof vi.fn>).mockResolvedValue(
      JSON.stringify({ records: [] }),
    );

    // Mixed batch — one prefixed, one bare, one with surrounding whitespace. The
    // upstream 400s on a mixed batch unless every PMCID is in the same form.
    await service.idConvert(['PMC3531190', '3531190', ' 7925010 '], 'pmcid');

    const params = (mockApiClient.makeExternalRequest as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[1];
    expect(params?.ids).toBe('PMC3531190,PMC3531190,PMC7925010');
  });

  it('does not PMC-prefix non-pmcid id types (#73)', async () => {
    const { service, mockApiClient } = createIdConvertService();
    (mockApiClient.makeExternalRequest as ReturnType<typeof vi.fn>).mockResolvedValue(
      JSON.stringify({ records: [] }),
    );

    await service.idConvert(['23193287', '12345'], 'pmid');

    const params = (mockApiClient.makeExternalRequest as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[1];
    expect(params?.ids).toBe('23193287,12345');
  });
});

describe('NcbiService retry behavior', () => {
  let setTimeoutSpy: ReturnType<typeof vi.spyOn>;

  /**
   * Retry backoff delays are capped at 30s (37.5s with jitter). The service-level
   * deadline timer uses the same `setTimeout` but is typically ≥60s. Threshold
   * of 50s keeps backoff tests deterministic (fire immediately) while leaving
   * deadline timers pending — so only tests that explicitly set a short
   * `totalDeadlineMs` exercise the deadline path.
   */
  beforeEach(() => {
    setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((
      fn: () => void,
      ms?: number,
    ) => {
      if (typeof ms === 'number' && ms >= 50_000) {
        return 0 as unknown as ReturnType<typeof setTimeout>;
      }
      fn();
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as unknown as typeof setTimeout);
  });

  afterEach(() => {
    setTimeoutSpy.mockRestore();
  });

  function createRetryService(maxRetries: number, deadlineMs = TEST_DEADLINE_MS) {
    const mockApiClient = {
      makeRequest: vi.fn(),
    } as unknown as NcbiApiClient;

    const mockQueue = {
      enqueue: vi.fn(async (task: () => Promise<unknown>) => task()),
    } as unknown as NcbiRequestQueue;

    const mockResponseHandler = {
      parseAndHandleResponse: vi.fn(),
    } as unknown as NcbiResponseHandler;

    const service = new NcbiService(
      mockApiClient,
      mockQueue,
      mockResponseHandler,
      maxRetries,
      deadlineMs,
    );
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

  it('exhausted retries stamp reason ncbi_unreachable + recovery on the wire', async () => {
    const { service, mockApiClient } = createRetryService(1);
    const makeRequest = mockApiClient.makeRequest as ReturnType<typeof vi.fn>;
    makeRequest.mockRejectedValue(new McpError(JsonRpcErrorCode.ServiceUnavailable, 'down'));

    await expect(service.eSearch({ db: 'pubmed', term: 'test' })).rejects.toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      data: {
        reason: 'ncbi_unreachable',
        endpoint: 'esearch',
        attempts: 2,
        recovery: { hint: expect.stringContaining('NCBI was unreachable') },
      },
    });
  });

  it('exhausted retries on Timeout/RateLimited do not stamp ncbi_unreachable', async () => {
    const { service, mockApiClient } = createRetryService(1);
    const makeRequest = mockApiClient.makeRequest as ReturnType<typeof vi.fn>;
    makeRequest.mockRejectedValue(new McpError(JsonRpcErrorCode.RateLimited, 'too many'));

    await expect(service.eSearch({ db: 'pubmed', term: 'test' })).rejects.toMatchObject({
      code: JsonRpcErrorCode.RateLimited,
      data: { endpoint: 'esearch', attempts: 2 },
    });
    // Only ServiceUnavailable retries-exhausted gets stamped — RateLimited has its own
    // queue_full reason that's stamped at the queue-rejection site.
    await expect(service.eSearch({ db: 'pubmed', term: 'test' })).rejects.not.toMatchObject({
      data: { reason: 'ncbi_unreachable' },
    });
  });

  it('applies capped exponential backoff with jitter', async () => {
    const { service, mockApiClient } = createRetryService(3);
    const makeRequest = mockApiClient.makeRequest as ReturnType<typeof vi.fn>;

    makeRequest.mockRejectedValue(new McpError(JsonRpcErrorCode.ServiceUnavailable, 'unavailable'));

    await service.eSearch({ db: 'pubmed', term: 'test' }).catch(() => {});

    const retryDelays = (setTimeoutSpy.mock.calls as [unknown, unknown][])
      .map(([, ms]) => ms)
      .filter((ms): ms is number => typeof ms === 'number' && ms >= 500 && ms < 50_000);

    expect(retryDelays).toHaveLength(3);
    expect(retryDelays[0]).toBeGreaterThanOrEqual(750);
    expect(retryDelays[0]).toBeLessThanOrEqual(1250);
    expect(retryDelays[1]).toBeGreaterThanOrEqual(1500);
    expect(retryDelays[1]).toBeLessThanOrEqual(2500);
    expect(retryDelays[2]).toBeGreaterThanOrEqual(3000);
    expect(retryDelays[2]).toBeLessThanOrEqual(5000);
  });

  it('forwards signal to apiClient.makeRequest', async () => {
    const { service, mockApiClient, mockResponseHandler } = createRetryService(0);
    const makeRequest = mockApiClient.makeRequest as ReturnType<typeof vi.fn>;
    const parseResponse = mockResponseHandler.parseAndHandleResponse as ReturnType<typeof vi.fn>;

    makeRequest.mockResolvedValue('<xml/>');
    parseResponse.mockReturnValue({
      eSearchResult: {
        Count: '0',
        RetMax: '0',
        RetStart: '0',
        QueryTranslation: '',
      },
    });

    await service.eSearch({ db: 'pubmed', term: 'test' });

    const options = makeRequest.mock.calls[0]?.[2] as { signal?: AbortSignal } | undefined;
    expect(options?.signal).toBeInstanceOf(AbortSignal);
  });

  it('throws Timeout with deadline message when deadline fires before first attempt', async () => {
    // Deadline 1ms — fires immediately under the setTimeout mock (< 50_000).
    const { service, mockApiClient } = createRetryService(3, 1);
    const makeRequest = mockApiClient.makeRequest as ReturnType<typeof vi.fn>;

    // Shouldn't be reached — deadline aborts before the first attempt executes.
    makeRequest.mockRejectedValue(new McpError(JsonRpcErrorCode.ServiceUnavailable, 'down'));

    await expect(service.eSearch({ db: 'pubmed', term: 'test' })).rejects.toMatchObject({
      code: JsonRpcErrorCode.Timeout,
      message: expect.stringMatching(/deadline.*exceeded/i),
    });
    expect(makeRequest).not.toHaveBeenCalled();
  });

  it('deadline-fired error stamps reason ncbi_deadline_exceeded + recovery on the wire', async () => {
    const { service, mockApiClient } = createRetryService(3, 1);
    const makeRequest = mockApiClient.makeRequest as ReturnType<typeof vi.fn>;
    makeRequest.mockRejectedValue(new McpError(JsonRpcErrorCode.ServiceUnavailable, 'down'));

    await expect(service.eSearch({ db: 'pubmed', term: 'test' })).rejects.toMatchObject({
      code: JsonRpcErrorCode.Timeout,
      data: {
        reason: 'ncbi_deadline_exceeded',
        deadlineMs: 1,
        recovery: { hint: expect.stringContaining('Reduce batch size') },
      },
    });
  });

  it('short-circuits retry chain when caller signal aborts before invocation', async () => {
    const { service, mockApiClient } = createRetryService(3);
    const makeRequest = mockApiClient.makeRequest as ReturnType<typeof vi.fn>;

    makeRequest.mockRejectedValue(new McpError(JsonRpcErrorCode.ServiceUnavailable, 'down'));

    const controller = new AbortController();
    controller.abort(new Error('client cancelled'));

    await expect(
      service.eSearch({ db: 'pubmed', term: 'test' }, { signal: controller.signal }),
    ).rejects.toThrow(/client cancelled/);
    expect(makeRequest).not.toHaveBeenCalled();
  });

  it('short-circuits retry chain when caller signal aborts between attempts', async () => {
    const { service, mockApiClient } = createRetryService(3);
    const makeRequest = mockApiClient.makeRequest as ReturnType<typeof vi.fn>;

    const controller = new AbortController();

    // Abort after the first attempt fails, before the backoff sleep resumes.
    makeRequest.mockImplementationOnce(() => {
      controller.abort(new Error('client cancelled mid-flight'));
      return Promise.reject(new McpError(JsonRpcErrorCode.ServiceUnavailable, 'down'));
    });

    await expect(
      service.eSearch({ db: 'pubmed', term: 'test' }, { signal: controller.signal }),
    ).rejects.toThrow(/client cancelled mid-flight/);
    // Only the first attempt should have happened — no retry after abort.
    expect(makeRequest).toHaveBeenCalledTimes(1);
  });
});

/**
 * Real-timer tests for the deadline + caller-signal wiring *during* backoff
 * sleeps. The retry-behavior suite above fires all setTimeout callbacks
 * synchronously, which collapses the backoff window to zero and makes it
 * impossible to observe what happens when an abort races the sleep. These
 * tests use real timers and intentionally short delays so the races play out.
 */
describe('NcbiService signal wiring during backoff sleep', () => {
  function createRealTimerService(maxRetries: number, deadlineMs: number) {
    const mockApiClient = {
      makeRequest: vi.fn(),
      makeExternalRequest: vi.fn(),
    } as unknown as NcbiApiClient;

    const mockQueue = {
      enqueue: vi.fn(async (task: () => Promise<unknown>) => task()),
    } as unknown as NcbiRequestQueue;

    const mockResponseHandler = {
      parseAndHandleResponse: vi.fn(),
    } as unknown as NcbiResponseHandler;

    const service = new NcbiService(
      mockApiClient,
      mockQueue,
      mockResponseHandler,
      maxRetries,
      deadlineMs,
    );
    return { service, mockApiClient, mockResponseHandler };
  }

  it('throws Timeout when deadline expires during backoff sleep', async () => {
    // Backoff for attempt 0 is 750–1250ms (1000ms ±25% jitter). A 200ms
    // deadline always expires while the retry loop is sleeping.
    const { service, mockApiClient } = createRealTimerService(3, 200);
    const makeRequest = mockApiClient.makeRequest as ReturnType<typeof vi.fn>;

    // First attempt fails fast with a retryable error so the loop enters the sleep.
    makeRequest.mockRejectedValue(new McpError(JsonRpcErrorCode.ServiceUnavailable, 'down'));

    const started = Date.now();
    await expect(service.eSearch({ db: 'pubmed', term: 'test' })).rejects.toMatchObject({
      code: JsonRpcErrorCode.Timeout,
      message: expect.stringMatching(/deadline.*exceeded/i),
    });
    const elapsed = Date.now() - started;

    // Must exit at the deadline (≤ ~500ms), not after the full backoff (≥ 750ms).
    expect(elapsed).toBeLessThan(500);
    // Only one attempt fired; the chain was cancelled during the first sleep.
    expect(makeRequest).toHaveBeenCalledTimes(1);
  }, 2000);

  it('propagates caller signal abort that fires during backoff sleep', async () => {
    const { service, mockApiClient } = createRealTimerService(3, 60_000);
    const makeRequest = mockApiClient.makeRequest as ReturnType<typeof vi.fn>;

    makeRequest.mockRejectedValue(new McpError(JsonRpcErrorCode.ServiceUnavailable, 'down'));

    const controller = new AbortController();
    // Abort ~200ms in, which lands inside the first backoff sleep (750–1250ms).
    setTimeout(() => controller.abort(new Error('cancelled during sleep')), 200);

    const started = Date.now();
    await expect(
      service.eSearch({ db: 'pubmed', term: 'test' }, { signal: controller.signal }),
    ).rejects.toThrow(/cancelled during sleep/);
    const elapsed = Date.now() - started;

    expect(elapsed).toBeLessThan(500);
    expect(makeRequest).toHaveBeenCalledTimes(1);
  }, 2000);

  it('idConvert honors deadline during backoff sleep', async () => {
    // Same race as above, but through the separate runWithDeadline invocation
    // in idConvert (external-API code path).
    const { service, mockApiClient } = createRealTimerService(3, 200);
    const makeExternalRequest = mockApiClient.makeExternalRequest as ReturnType<typeof vi.fn>;

    makeExternalRequest.mockRejectedValue(
      new McpError(JsonRpcErrorCode.ServiceUnavailable, 'down'),
    );

    const started = Date.now();
    await expect(service.idConvert(['123'], 'pmid')).rejects.toMatchObject({
      code: JsonRpcErrorCode.Timeout,
      message: expect.stringMatching(/deadline.*exceeded/i),
    });
    expect(Date.now() - started).toBeLessThan(500);
    expect(makeExternalRequest).toHaveBeenCalledTimes(1);
  }, 2000);

  it('aborts queue wait when caller signal fires before dispatch', async () => {
    const mockApiClient = {
      makeRequest: vi.fn(),
    } as unknown as NcbiApiClient;
    const mockQueue = {
      enqueue: vi.fn(
        (_task: () => unknown, _ep: string, _params: unknown, signal?: AbortSignal) =>
          new Promise((_, reject) => {
            if (signal?.aborted) {
              reject(signal.reason);
              return;
            }
            signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
          }),
      ),
    } as unknown as NcbiRequestQueue;
    const mockResponseHandler = {
      parseAndHandleResponse: vi.fn(),
    } as unknown as NcbiResponseHandler;
    const service = new NcbiService(mockApiClient, mockQueue, mockResponseHandler, 3, 60_000);

    const controller = new AbortController();
    setTimeout(() => controller.abort(new Error('caller cancelled while queued')), 50);

    await expect(
      service.eSearch({ db: 'pubmed', term: 'test' }, { signal: controller.signal }),
    ).rejects.toThrow(/caller cancelled while queued/);
    expect(mockApiClient.makeRequest).not.toHaveBeenCalled();
  }, 2000);

  it('passes a deadline-aware AbortSignal as the fourth argument to queue.enqueue', async () => {
    const mockApiClient = {
      makeRequest: vi.fn().mockResolvedValue('<xml/>'),
    } as unknown as NcbiApiClient;
    const mockQueue = {
      enqueue: vi.fn(async (task: () => Promise<unknown>) => task()),
    } as unknown as NcbiRequestQueue;
    const mockResponseHandler = {
      parseAndHandleResponse: vi.fn().mockReturnValue({
        eSearchResult: { Count: '0', RetMax: '0', RetStart: '0', QueryTranslation: '' },
      }),
    } as unknown as NcbiResponseHandler;
    const service = new NcbiService(mockApiClient, mockQueue, mockResponseHandler, 0, 60_000);

    await service.eSearch({ db: 'pubmed', term: 'test' });

    const enqueueCalls = (mockQueue.enqueue as ReturnType<typeof vi.fn>).mock.calls;
    expect(enqueueCalls).toHaveLength(1);
    const signalArg = enqueueCalls[0]?.[3];
    expect(signalArg).toBeInstanceOf(AbortSignal);
    expect((signalArg as AbortSignal).aborted).toBe(false);
  });

  it('passes endpoint and params to queue.enqueue for telemetry', async () => {
    const mockApiClient = {
      makeRequest: vi.fn().mockResolvedValue('<xml/>'),
    } as unknown as NcbiApiClient;
    const mockQueue = {
      enqueue: vi.fn(async (task: () => Promise<unknown>) => task()),
    } as unknown as NcbiRequestQueue;
    const mockResponseHandler = {
      parseAndHandleResponse: vi.fn().mockReturnValue({
        eSearchResult: { Count: '0', RetMax: '0', RetStart: '0', QueryTranslation: '' },
      }),
    } as unknown as NcbiResponseHandler;
    const service = new NcbiService(mockApiClient, mockQueue, mockResponseHandler, 0, 60_000);

    await service.eSearch({ db: 'pubmed', term: 'cancer' });

    expect(mockQueue.enqueue).toHaveBeenCalledWith(
      expect.any(Function),
      'esearch',
      expect.objectContaining({ term: 'cancer', db: 'pubmed' }),
      expect.any(AbortSignal),
    );
  });

  it('idConvert throws Timeout when deadline expires while waiting in the queue', async () => {
    const mockApiClient = {
      makeRequest: vi.fn(),
      makeExternalRequest: vi.fn(),
    } as unknown as NcbiApiClient;
    const mockQueue = {
      enqueue: vi.fn(
        (_task: () => unknown, _ep: string, _params: unknown, signal?: AbortSignal) =>
          new Promise((_, reject) => {
            if (signal?.aborted) {
              reject(signal.reason);
              return;
            }
            signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
          }),
      ),
    } as unknown as NcbiRequestQueue;
    const service = new NcbiService(
      mockApiClient,
      mockQueue,
      {} as unknown as NcbiResponseHandler,
      3,
      200,
    );

    const started = Date.now();
    await expect(service.idConvert(['123'], 'pmid')).rejects.toMatchObject({
      code: JsonRpcErrorCode.Timeout,
      message: expect.stringMatching(/deadline.*exceeded/i),
      data: { reason: 'ncbi_deadline_exceeded' },
    });
    expect(Date.now() - started).toBeLessThan(500);
    expect(mockApiClient.makeExternalRequest).not.toHaveBeenCalled();
  }, 2000);

  it('idConvert aborts queue wait when caller signal fires before dispatch', async () => {
    const mockApiClient = {
      makeRequest: vi.fn(),
      makeExternalRequest: vi.fn(),
    } as unknown as NcbiApiClient;
    const mockQueue = {
      enqueue: vi.fn(
        (_task: () => unknown, _ep: string, _params: unknown, signal?: AbortSignal) =>
          new Promise((_, reject) => {
            if (signal?.aborted) {
              reject(signal.reason);
              return;
            }
            signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
          }),
      ),
    } as unknown as NcbiRequestQueue;
    const service = new NcbiService(
      mockApiClient,
      mockQueue,
      {} as unknown as NcbiResponseHandler,
      3,
      60_000,
    );

    const controller = new AbortController();
    setTimeout(() => controller.abort(new Error('idconv cancelled in queue')), 50);

    await expect(service.idConvert(['123'], 'pmid', { signal: controller.signal })).rejects.toThrow(
      /idconv cancelled in queue/,
    );
    expect(mockApiClient.makeExternalRequest).not.toHaveBeenCalled();
  }, 2000);

  it('throws Timeout when the deadline expires while waiting in the queue', async () => {
    // Queue mock that holds a task until the abort signal fires — simulating a
    // saturated worker (the deadline must abort the wait, not just the in-flight
    // request).
    const mockApiClient = {
      makeRequest: vi.fn(),
    } as unknown as NcbiApiClient;
    const mockQueue = {
      enqueue: vi.fn(
        (_task: () => unknown, _ep: string, _params: unknown, signal?: AbortSignal) =>
          new Promise((_, reject) => {
            if (signal?.aborted) {
              reject(signal.reason);
              return;
            }
            signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
          }),
      ),
    } as unknown as NcbiRequestQueue;
    const mockResponseHandler = {
      parseAndHandleResponse: vi.fn(),
    } as unknown as NcbiResponseHandler;
    const service = new NcbiService(mockApiClient, mockQueue, mockResponseHandler, 3, 200);

    const started = Date.now();
    await expect(service.eSearch({ db: 'pubmed', term: 'test' })).rejects.toMatchObject({
      code: JsonRpcErrorCode.Timeout,
      message: expect.stringMatching(/deadline.*exceeded/i),
      data: { reason: 'ncbi_deadline_exceeded' },
    });
    expect(Date.now() - started).toBeLessThan(500);
    expect(mockApiClient.makeRequest).not.toHaveBeenCalled();
  }, 2000);

  it('idConvert honors caller signal during backoff sleep', async () => {
    const { service, mockApiClient } = createRealTimerService(3, 60_000);
    const makeExternalRequest = mockApiClient.makeExternalRequest as ReturnType<typeof vi.fn>;

    makeExternalRequest.mockRejectedValue(
      new McpError(JsonRpcErrorCode.ServiceUnavailable, 'down'),
    );

    const controller = new AbortController();
    setTimeout(() => controller.abort(new Error('idconv cancelled')), 200);

    const started = Date.now();
    await expect(service.idConvert(['123'], 'pmid', { signal: controller.signal })).rejects.toThrow(
      /idconv cancelled/,
    );
    expect(Date.now() - started).toBeLessThan(500);
    expect(makeExternalRequest).toHaveBeenCalledTimes(1);
  }, 2000);
});

/**
 * Timer-leak guardrails. The deadline is implemented via `setTimeout` +
 * `clearTimeout`; forgetting to clear on any code path would let the timer
 * fire after the request resolved. These tests pin the contract: every
 * request — success or failure — clears exactly one deadline timer.
 */
describe('NcbiService deadline timer cleanup', () => {
  let setTimeoutSpy: ReturnType<typeof vi.spyOn>;
  let clearTimeoutSpy: ReturnType<typeof vi.spyOn>;
  let timerId = 0;

  beforeEach(() => {
    timerId = 0;
    setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((
      fn: () => void,
      ms?: number,
    ) => {
      timerId += 1;
      // Short timers fire immediately (backoff sleep); long ones stay pending (deadline).
      if (typeof ms === 'number' && ms < 50_000) {
        fn();
      }
      return timerId as unknown as ReturnType<typeof setTimeout>;
    }) as unknown as typeof setTimeout);
    clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');
  });

  afterEach(() => {
    setTimeoutSpy.mockRestore();
    clearTimeoutSpy.mockRestore();
  });

  function createService(maxRetries: number) {
    const mockApiClient = {
      makeRequest: vi.fn(),
    } as unknown as NcbiApiClient;
    const mockQueue = {
      enqueue: vi.fn(async (task: () => Promise<unknown>) => task()),
    } as unknown as NcbiRequestQueue;
    const mockResponseHandler = {
      parseAndHandleResponse: vi.fn(),
    } as unknown as NcbiResponseHandler;
    const service = new NcbiService(
      mockApiClient,
      mockQueue,
      mockResponseHandler,
      maxRetries,
      TEST_DEADLINE_MS,
    );
    return { service, mockApiClient, mockResponseHandler };
  }

  /** Only the deadline timer in `runWithDeadline` sets a ≥50_000ms timer. */
  const deadlineClearCount = () =>
    clearTimeoutSpy.mock.calls.filter(([id]) => typeof id === 'number' && id > 0).length;

  it('clears deadline timer on successful request', async () => {
    const { service, mockApiClient, mockResponseHandler } = createService(0);
    const makeRequest = mockApiClient.makeRequest as ReturnType<typeof vi.fn>;
    const parseResponse = mockResponseHandler.parseAndHandleResponse as ReturnType<typeof vi.fn>;

    makeRequest.mockResolvedValue('<xml/>');
    parseResponse.mockReturnValue({
      eSearchResult: { Count: '0', RetMax: '0', RetStart: '0', QueryTranslation: '' },
    });

    await service.eSearch({ db: 'pubmed', term: 'test' });

    expect(deadlineClearCount()).toBeGreaterThanOrEqual(1);
  });

  it('clears deadline timer on non-retryable error', async () => {
    const { service, mockApiClient } = createService(3);
    const makeRequest = mockApiClient.makeRequest as ReturnType<typeof vi.fn>;

    makeRequest.mockRejectedValue(new McpError(JsonRpcErrorCode.InvalidRequest, 'bad'));

    await expect(service.eSearch({ db: 'pubmed', term: 'test' })).rejects.toThrow();
    expect(deadlineClearCount()).toBeGreaterThanOrEqual(1);
  });

  it('clears deadline timer after retries exhausted', async () => {
    const { service, mockApiClient } = createService(2);
    const makeRequest = mockApiClient.makeRequest as ReturnType<typeof vi.fn>;

    makeRequest.mockRejectedValue(new McpError(JsonRpcErrorCode.ServiceUnavailable, 'down'));

    await expect(service.eSearch({ db: 'pubmed', term: 'test' })).rejects.toThrow();
    expect(deadlineClearCount()).toBeGreaterThanOrEqual(1);
  });
});

/**
 * Integration suite: real `NcbiRequestQueue` paired with a mock `NcbiApiClient`.
 * Exercises the full enqueue → deadline → retry → execute chain to lock in the
 * fixes from #50 (queue wait counts toward the deadline; concurrent calls don't
 * serialize behind a single worker).
 */
describe('NcbiService integration with real queue', () => {
  // Local import — `NcbiRequestQueue` is otherwise type-only in this file.
  let NcbiRequestQueueCtor: typeof import('@/services/ncbi/request-queue.js').NcbiRequestQueue;
  beforeEach(async () => {
    ({ NcbiRequestQueue: NcbiRequestQueueCtor } = await import('@/services/ncbi/request-queue.js'));
  });

  function createService(opts: {
    maxConcurrent: number;
    deadlineMs: number;
    requestDelayMs?: number;
    maxRetries?: number;
    apiDurationMs?: number;
  }) {
    const mockApiClient = {
      makeRequest: vi
        .fn()
        .mockImplementation(
          () => new Promise<string>((r) => setTimeout(() => r('<xml/>'), opts.apiDurationMs ?? 30)),
        ),
      makeExternalRequest: vi.fn(),
    } as unknown as NcbiApiClient;
    const realQueue = new NcbiRequestQueueCtor(opts.requestDelayMs ?? 0, opts.maxConcurrent);
    const mockResponseHandler = {
      parseAndHandleResponse: vi.fn().mockReturnValue({
        eSearchResult: { Count: '0', RetMax: '0', RetStart: '0', QueryTranslation: '' },
      }),
    } as unknown as NcbiResponseHandler;
    const service = new NcbiService(
      mockApiClient,
      realQueue,
      mockResponseHandler,
      opts.maxRetries ?? 0,
      opts.deadlineMs,
    );
    return { service, mockApiClient };
  }

  it('queue wait counts toward totalDeadlineMs (regression for issue #50)', async () => {
    const { service, mockApiClient } = createService({
      maxConcurrent: 1,
      deadlineMs: 200,
      apiDurationMs: 500,
    });

    // Blocker holds the single in-flight slot for 500ms.
    const blocker = service.eSearch({ db: 'pubmed', term: 'blocker' });

    const started = Date.now();
    await expect(service.eSearch({ db: 'pubmed', term: 'queued' })).rejects.toMatchObject({
      code: JsonRpcErrorCode.Timeout,
      data: { reason: 'ncbi_deadline_exceeded' },
    });
    const elapsed = Date.now() - started;

    // Queued call must fail at its deadline (≈200ms), not after the blocker (500ms+).
    expect(elapsed).toBeLessThan(400);
    // Queued call never reached the API client; only the blocker did.
    expect(mockApiClient.makeRequest).toHaveBeenCalledTimes(1);

    await blocker;
  }, 2000);

  it('concurrent calls execute in parallel up to maxConcurrent', async () => {
    const { service, mockApiClient } = createService({
      maxConcurrent: 3,
      deadlineMs: 60_000,
      apiDurationMs: 60,
    });

    const started = Date.now();
    await Promise.all([
      service.eSearch({ db: 'pubmed', term: 'a' }),
      service.eSearch({ db: 'pubmed', term: 'b' }),
      service.eSearch({ db: 'pubmed', term: 'c' }),
    ]);
    const elapsed = Date.now() - started;

    // 3 parallel 60ms tasks should finish around 60–100ms, not 180ms.
    expect(elapsed).toBeLessThan(150);
    expect(mockApiClient.makeRequest).toHaveBeenCalledTimes(3);
  }, 2000);

  it('a slow upstream call does not delay an independent fast call', async () => {
    // Two concurrent slots. First call hits a slow path (300ms); second uses a
    // fresh request flow that resolves in <20ms. Without concurrency, the
    // second would have to wait for the first.
    const mockApiClient = {
      makeRequest: vi
        .fn()
        .mockImplementationOnce(
          () => new Promise<string>((r) => setTimeout(() => r('<xml/>'), 300)),
        )
        .mockImplementation(() => Promise.resolve('<xml/>')),
      makeExternalRequest: vi.fn(),
    } as unknown as NcbiApiClient;
    const realQueue = new NcbiRequestQueueCtor(0, 2);
    const mockResponseHandler = {
      parseAndHandleResponse: vi.fn().mockReturnValue({
        eSearchResult: { Count: '0', RetMax: '0', RetStart: '0', QueryTranslation: '' },
      }),
    } as unknown as NcbiResponseHandler;
    const service = new NcbiService(mockApiClient, realQueue, mockResponseHandler, 0, 60_000);

    const slowStarted = Date.now();
    const slow = service.eSearch({ db: 'pubmed', term: 'slow' });

    const fastStarted = Date.now();
    await service.eSearch({ db: 'pubmed', term: 'fast' });
    const fastElapsed = Date.now() - fastStarted;

    // Fast call must complete quickly without waiting on the slow one.
    expect(fastElapsed).toBeLessThan(100);

    await slow;
    const slowElapsed = Date.now() - slowStarted;
    expect(slowElapsed).toBeGreaterThanOrEqual(280);
  }, 2000);

  it('respects maxConcurrent ceiling with many enqueued calls', async () => {
    const { service, mockApiClient } = createService({
      maxConcurrent: 2,
      deadlineMs: 60_000,
      apiDurationMs: 50,
    });
    let inFlight = 0;
    let peak = 0;
    (mockApiClient.makeRequest as ReturnType<typeof vi.fn>).mockImplementation(() => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      return new Promise<string>((r) =>
        setTimeout(() => {
          inFlight -= 1;
          r('<xml/>');
        }, 50),
      );
    });

    await Promise.all(
      Array.from({ length: 6 }, (_, i) => service.eSearch({ db: 'pubmed', term: `q-${i}` })),
    );

    expect(peak).toBe(2);
    expect(mockApiClient.makeRequest).toHaveBeenCalledTimes(6);
  }, 2000);

  it('enforces minStartGapMs across consecutive calls', async () => {
    const { service, mockApiClient } = createService({
      maxConcurrent: 4,
      deadlineMs: 60_000,
      requestDelayMs: 80,
      apiDurationMs: 5,
    });
    const startTimes: number[] = [];
    (mockApiClient.makeRequest as ReturnType<typeof vi.fn>).mockImplementation(() => {
      startTimes.push(Date.now());
      return Promise.resolve('<xml/>');
    });

    const begin = Date.now();
    await Promise.all([
      service.eSearch({ db: 'pubmed', term: 'a' }),
      service.eSearch({ db: 'pubmed', term: 'b' }),
      service.eSearch({ db: 'pubmed', term: 'c' }),
    ]);

    const offsets = startTimes.map((t) => t - begin);
    expect(offsets[0]).toBeLessThan(40);
    expect(offsets[1] as number).toBeGreaterThanOrEqual(70);
    expect(offsets[2] as number).toBeGreaterThanOrEqual(150);
  }, 2000);

  it('queue_full when load exceeds maxQueueSize + maxConcurrent', async () => {
    const mockApiClient = {
      makeRequest: vi
        .fn()
        .mockImplementation(() => new Promise<string>((r) => setTimeout(() => r('<xml/>'), 100))),
      makeExternalRequest: vi.fn(),
    } as unknown as NcbiApiClient;
    // 1 in-flight + 1 waiting = capacity of 2. The 3rd call overflows.
    const realQueue = new NcbiRequestQueueCtor(0, 1, 1);
    const mockResponseHandler = {
      parseAndHandleResponse: vi.fn().mockReturnValue({
        eSearchResult: { Count: '0', RetMax: '0', RetStart: '0', QueryTranslation: '' },
      }),
    } as unknown as NcbiResponseHandler;
    const service = new NcbiService(mockApiClient, realQueue, mockResponseHandler, 0, 60_000);

    const p1 = service.eSearch({ db: 'pubmed', term: 'a' });
    const p2 = service.eSearch({ db: 'pubmed', term: 'b' });
    await expect(service.eSearch({ db: 'pubmed', term: 'c' })).rejects.toMatchObject({
      code: JsonRpcErrorCode.RateLimited,
      data: { reason: 'queue_full' },
    });

    await Promise.all([p1, p2]);
  }, 2000);

  it('cancelling one queued call does not affect others', async () => {
    const mockApiClient = {
      makeRequest: vi
        .fn()
        .mockImplementation(() => new Promise<string>((r) => setTimeout(() => r('<xml/>'), 80))),
      makeExternalRequest: vi.fn(),
    } as unknown as NcbiApiClient;
    const realQueue = new NcbiRequestQueueCtor(0, 1);
    const mockResponseHandler = {
      parseAndHandleResponse: vi.fn().mockReturnValue({
        eSearchResult: { Count: '0', RetMax: '0', RetStart: '0', QueryTranslation: '' },
      }),
    } as unknown as NcbiResponseHandler;
    const service = new NcbiService(mockApiClient, realQueue, mockResponseHandler, 0, 60_000);

    const blocker = service.eSearch({ db: 'pubmed', term: 'blocker' });

    const controller = new AbortController();
    const cancellable = service.eSearch(
      { db: 'pubmed', term: 'cancellable' },
      { signal: controller.signal },
    );
    const survivor = service.eSearch({ db: 'pubmed', term: 'survivor' });

    controller.abort(new Error('cancel'));

    await expect(cancellable).rejects.toThrow(/cancel/);
    const [b, s] = await Promise.all([blocker, survivor]);
    expect(b).toBeDefined();
    expect(s).toBeDefined();
    expect(mockApiClient.makeRequest).toHaveBeenCalledTimes(2);
  }, 2000);
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
