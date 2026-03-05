/**
 * @fileoverview Unit tests for ESummary parsing helpers: formatESummaryAuthors,
 * standardizeESummaryDate, and extractBriefSummaries.
 * @module tests/services/ncbi/parsing/esummary-parser.test
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock dateParser before importing any module that transitively uses it.
vi.mock('@/utils/parsing/dateParser.js', () => ({
  dateParser: {
    parseDate: vi.fn(),
  },
}));

import { dateParser } from '@/utils/parsing/dateParser.js';
import {
  extractBriefSummaries,
  formatESummaryAuthors,
  standardizeESummaryDate,
} from '../../../../src/services/ncbi/parsing/esummary-parser.js';
import type {
  ESummaryAuthor,
  ESummaryDocSumOldXml,
  ESummaryDocumentSummary,
  ESummaryResult,
} from '../../../../src/services/ncbi/types.js';

const mockParseDate = vi.mocked(dateParser.parseDate);

/** Minimal RequestContext for passing to functions that accept one. */
const testContext = {
  requestId: 'esummary-parser-test',
  timestamp: new Date().toISOString(),
};

beforeEach(() => {
  mockParseDate.mockReset();
  // Default: return null (unparseable), matching what setup.ts configures for chrono-node.
  mockParseDate.mockResolvedValue(null);
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ─── formatESummaryAuthors ───────────────────────────────────────────────────

describe('formatESummaryAuthors', () => {
  it('returns empty string for undefined input', () => {
    expect(formatESummaryAuthors(undefined)).toBe('');
  });

  it('returns empty string for an empty array', () => {
    expect(formatESummaryAuthors([])).toBe('');
  });

  it('returns a single author name when only one author is present', () => {
    const authors: ESummaryAuthor[] = [{ name: 'Smith JA' }];
    expect(formatESummaryAuthors(authors)).toBe('Smith JA');
  });

  it('comma-separates two authors', () => {
    const authors: ESummaryAuthor[] = [{ name: 'Smith JA' }, { name: 'Doe B' }];
    expect(formatESummaryAuthors(authors)).toBe('Smith JA, Doe B');
  });

  it('comma-separates exactly three authors without et al.', () => {
    const authors: ESummaryAuthor[] = [
      { name: 'Smith JA' },
      { name: 'Doe B' },
      { name: 'Brown C' },
    ];
    expect(formatESummaryAuthors(authors)).toBe('Smith JA, Doe B, Brown C');
  });

  it('truncates to three authors and appends et al. when more than three exist', () => {
    const authors: ESummaryAuthor[] = [
      { name: 'Smith JA' },
      { name: 'Doe B' },
      { name: 'Brown C' },
      { name: 'Lee D' },
      { name: 'Wang E' },
    ];
    expect(formatESummaryAuthors(authors)).toBe('Smith JA, Doe B, Brown C, et al.');
  });

  it('truncates to first three even when exactly four authors are present', () => {
    const authors: ESummaryAuthor[] = [
      { name: 'Alpha A' },
      { name: 'Beta B' },
      { name: 'Gamma C' },
      { name: 'Delta D' },
    ];
    expect(formatESummaryAuthors(authors)).toBe('Alpha A, Beta B, Gamma C, et al.');
  });
});

// ─── standardizeESummaryDate ─────────────────────────────────────────────────

describe('standardizeESummaryDate', () => {
  it('returns undefined for undefined input', async () => {
    const result = await standardizeESummaryDate(undefined, testContext);
    expect(result).toBeUndefined();
    expect(mockParseDate).not.toHaveBeenCalled();
  });

  it('returns undefined for null input (treated like undefined at runtime)', async () => {
    // The source guards against null with `if (dateStr === undefined || dateStr === null)`.
    const result = await standardizeESummaryDate(null as unknown as string, testContext);
    expect(result).toBeUndefined();
    expect(mockParseDate).not.toHaveBeenCalled();
  });

  it('returns a YYYY-MM-DD string when dateParser resolves a valid Date', async () => {
    mockParseDate.mockResolvedValue(new Date('2024-01-15T00:00:00.000Z'));
    const result = await standardizeESummaryDate('2024/01/15', testContext);
    expect(result).toBe('2024-01-15');
  });

  it('returns undefined when dateParser resolves null (unparseable date string)', async () => {
    mockParseDate.mockResolvedValue(null);
    const result = await standardizeESummaryDate('not-a-date', testContext);
    expect(result).toBeUndefined();
  });

  it('returns undefined when dateParser throws (graceful error handling)', async () => {
    mockParseDate.mockRejectedValue(new Error('chrono internal failure'));
    const result = await standardizeESummaryDate('2023 Spring', testContext);
    expect(result).toBeUndefined();
  });

  it('works without an explicit context (creates its own)', async () => {
    mockParseDate.mockResolvedValue(new Date('2023-06-01T00:00:00.000Z'));
    const result = await standardizeESummaryDate('2023/06/01');
    expect(result).toBe('2023-06-01');
  });
});

// ─── extractBriefSummaries ───────────────────────────────────────────────────

describe('extractBriefSummaries', () => {
  it('returns an empty array for undefined input', async () => {
    const result = await extractBriefSummaries(undefined, testContext);
    expect(result).toEqual([]);
  });

  it('returns an empty array when the result contains an ERROR field', async () => {
    const errResult: ESummaryResult = {
      ERROR: 'Invalid uid 99999999 at position=1',
    };
    const result = await extractBriefSummaries(errResult, testContext);
    expect(result).toEqual([]);
  });

  // ── DocumentSummarySet format (newer XML) ───────────────────────────────

  describe('DocumentSummarySet format (newer XML)', () => {
    it('parses a single DocumentSummary with all common fields', async () => {
      mockParseDate.mockResolvedValue(new Date('2024-03-10T00:00:00.000Z'));

      const docSummary: ESummaryDocumentSummary = {
        '@_uid': '38765432',
        Title: 'Advances in mRNA vaccine platforms',
        Source: 'Nat Rev Drug Discov',
        PubDate: '2024 Mar 10',
        EPubDate: '2024 Feb 28',
        Authors: [
          { Name: 'Johnson KL', authtype: 'Author' },
          { Name: 'Patel RN', authtype: 'Author' },
        ],
        DOI: '10.1038/s41573-024-00900-1',
      };

      const eSummaryResult: ESummaryResult = {
        DocumentSummarySet: { DocumentSummary: docSummary },
      };

      const results = await extractBriefSummaries(eSummaryResult, testContext);

      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({
        pmid: '38765432',
        title: 'Advances in mRNA vaccine platforms',
        source: 'Nat Rev Drug Discov',
        doi: '10.1038/s41573-024-00900-1',
        authors: 'Johnson KL, Patel RN',
        pubDate: '2024-03-10',
        epubDate: '2024-03-10',
      });
    });

    it('parses multiple DocumentSummary entries into separate results', async () => {
      // Each entry has PubDate but no EPubDate. standardizeESummaryDate returns
      // early (no parseDate call) when the date string is undefined. So exactly
      // two parseDate calls are made — one per entry's PubDate.
      mockParseDate
        .mockResolvedValueOnce(new Date('2023-11-01T00:00:00.000Z'))
        .mockResolvedValueOnce(new Date('2022-05-20T00:00:00.000Z'));

      const docSummaries: ESummaryDocumentSummary[] = [
        {
          '@_uid': '37000001',
          Title: 'First article title',
          Source: 'J Immunol',
          PubDate: '2023 Nov',
          Authors: [{ Name: 'Garcia M', authtype: 'Author' }],
        },
        {
          '@_uid': '36000002',
          Title: 'Second article title',
          Source: 'Cell',
          PubDate: '2022 May 20',
          Authors: [{ Name: 'Liu X', authtype: 'Author' }],
        },
      ];

      const eSummaryResult: ESummaryResult = {
        DocumentSummarySet: { DocumentSummary: docSummaries },
      };

      const results = await extractBriefSummaries(eSummaryResult, testContext);

      expect(results).toHaveLength(2);
      expect(results[0]?.pmid).toBe('37000001');
      expect(results[0]?.pubDate).toBe('2023-11-01');
      expect(results[1]?.pmid).toBe('36000002');
      expect(results[1]?.pubDate).toBe('2022-05-20');
    });

    it('extracts DOI from ArticleIds when DOI field is not directly present', async () => {
      mockParseDate.mockResolvedValue(null);

      const docSummary: ESummaryDocumentSummary = {
        '@_uid': '38000099',
        Title: 'DOI from ArticleIds test',
        ArticleIds: {
          ArticleId: [
            { idtype: 'pubmed', idtypen: 1, value: '38000099' },
            { idtype: 'doi', idtypen: 3, value: '10.1016/j.cell.2024.01.005' },
          ],
        },
      };

      const eSummaryResult: ESummaryResult = {
        DocumentSummarySet: { DocumentSummary: docSummary },
      };

      const results = await extractBriefSummaries(eSummaryResult, testContext);

      expect(results).toHaveLength(1);
      expect(results[0]?.doi).toBe('10.1016/j.cell.2024.01.005');
    });

    it('returns empty authors string when Authors field is absent', async () => {
      mockParseDate.mockResolvedValue(null);

      const docSummary: ESummaryDocumentSummary = {
        '@_uid': '39000001',
        Title: 'No authors article',
      };

      const eSummaryResult: ESummaryResult = {
        DocumentSummarySet: { DocumentSummary: docSummary },
      };

      const results = await extractBriefSummaries(eSummaryResult, testContext);

      expect(results).toHaveLength(1);
      expect(results[0]?.authors).toBe('');
    });

    it('omits pubDate when dateParser returns null', async () => {
      mockParseDate.mockResolvedValue(null);

      const docSummary: ESummaryDocumentSummary = {
        '@_uid': '38999888',
        PubDate: 'unparseable date string',
      };

      const eSummaryResult: ESummaryResult = {
        DocumentSummarySet: { DocumentSummary: docSummary },
      };

      const results = await extractBriefSummaries(eSummaryResult, testContext);

      expect(results).toHaveLength(1);
      expect(results[0]).not.toHaveProperty('pubDate');
    });
  });

  // ── DocSum format (older XML) ───────────────────────────────────────────

  describe('DocSum format (older XML)', () => {
    function makeItem(
      name: string,
      type: 'String' | 'Integer' | 'Date' | 'List' | 'Structure' | 'Unknown' | 'ERROR',
      text?: string,
    ) {
      return {
        '@_Name': name,
        '@_Type': type,
        ...(text !== undefined && { '#text': text }),
      };
    }

    it('parses a single DocSum with all common fields', async () => {
      mockParseDate.mockResolvedValue(new Date('2021-08-15T00:00:00.000Z'));

      const docSum: ESummaryDocSumOldXml = {
        Id: '34000111',
        Item: [
          makeItem('Title', 'String', 'CRISPR-Cas9 genome editing review'),
          makeItem('Source', 'String', 'Nat Biotechnol'),
          makeItem('PubDate', 'Date', '2021/08/15'),
          makeItem('EPubDate', 'Date', '2021/07/30'),
          {
            '@_Name': 'AuthorList',
            '@_Type': 'List',
            Item: [
              makeItem('Author', 'String', 'Chen Y'),
              makeItem('Author', 'String', 'Zhang W'),
              makeItem('Author', 'String', 'Kim SH'),
              makeItem('Author', 'String', 'Nakamura T'),
            ],
          },
          makeItem('DOI', 'String', '10.1038/s41587-021-00937-4'),
        ],
      };

      const eSummaryResult: ESummaryResult = { DocSum: docSum };

      const results = await extractBriefSummaries(eSummaryResult, testContext);

      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({
        pmid: '34000111',
        title: 'CRISPR-Cas9 genome editing review',
        source: 'Nat Biotechnol',
        doi: '10.1038/s41587-021-00937-4',
      });
      // 4 authors → first 3 + et al.
      expect(results[0]?.authors).toBe('Chen Y, Zhang W, Kim SH, et al.');
    });

    it('extracts authors from a nested AuthorList item', async () => {
      mockParseDate.mockResolvedValue(null);

      const docSum: ESummaryDocSumOldXml = {
        Id: '34000222',
        Item: [
          makeItem('Title', 'String', 'Single author paper'),
          {
            '@_Name': 'AuthorList',
            '@_Type': 'List',
            Item: [makeItem('Author', 'String', 'Müller H')],
          },
        ],
      };

      const eSummaryResult: ESummaryResult = { DocSum: docSum };

      const results = await extractBriefSummaries(eSummaryResult, testContext);

      expect(results).toHaveLength(1);
      expect(results[0]?.authors).toBe('Müller H');
    });

    it('extracts DOI from ArticleIds List item when DOI String item is absent', async () => {
      mockParseDate.mockResolvedValue(null);

      const docSum: ESummaryDocSumOldXml = {
        Id: '34000333',
        Item: [
          makeItem('Title', 'String', 'DOI from ArticleIds'),
          {
            '@_Name': 'ArticleIds',
            '@_Type': 'List',
            Item: [
              {
                '@_Name': 'doi',
                '@_Type': 'String',
                '#text': '10.1093/nar/gkab450',
              },
              {
                '@_Name': 'pubmed',
                '@_Type': 'String',
                '#text': '34000333',
              },
            ],
          },
        ],
      };

      const eSummaryResult: ESummaryResult = { DocSum: docSum };

      const results = await extractBriefSummaries(eSummaryResult, testContext);

      expect(results).toHaveLength(1);
      expect(results[0]?.doi).toBe('10.1093/nar/gkab450');
    });

    it('parses multiple DocSum entries in an array', async () => {
      // Each DocSum has PubDate but no EPubDate — two parseDate calls total.
      mockParseDate
        .mockResolvedValueOnce(new Date('2020-01-10T00:00:00.000Z'))
        .mockResolvedValueOnce(new Date('2019-06-05T00:00:00.000Z'));

      const docSums: ESummaryDocSumOldXml[] = [
        {
          Id: '31000001',
          Item: [
            makeItem('Title', 'String', 'First old-format article'),
            makeItem('PubDate', 'Date', '2020/01/10'),
          ],
        },
        {
          Id: '31000002',
          Item: [
            makeItem('Title', 'String', 'Second old-format article'),
            makeItem('PubDate', 'Date', '2019/06/05'),
          ],
        },
      ];

      const eSummaryResult: ESummaryResult = { DocSum: docSums };

      const results = await extractBriefSummaries(eSummaryResult, testContext);

      expect(results).toHaveLength(2);
      expect(results[0]?.pmid).toBe('31000001');
      expect(results[0]?.pubDate).toBe('2020-01-10');
      expect(results[1]?.pmid).toBe('31000002');
      expect(results[1]?.pubDate).toBe('2019-06-05');
    });

    it('returns empty authors string when no AuthorList item exists', async () => {
      mockParseDate.mockResolvedValue(null);

      const docSum: ESummaryDocSumOldXml = {
        Id: '34000444',
        Item: [makeItem('Title', 'String', 'No authors')],
      };

      const eSummaryResult: ESummaryResult = { DocSum: docSum };

      const results = await extractBriefSummaries(eSummaryResult, testContext);

      expect(results).toHaveLength(1);
      expect(results[0]?.authors).toBe('');
    });
  });

  it('returns an empty array when neither DocumentSummarySet nor DocSum is present', async () => {
    const eSummaryResult: ESummaryResult = {};
    const results = await extractBriefSummaries(eSummaryResult, testContext);
    expect(results).toEqual([]);
  });

  // ── Authors parsing edge cases ─────────────────────────────────────────

  describe('Authors parsing edge cases', () => {
    it('parses Authors as { Author: ... } nested object', async () => {
      mockParseDate.mockResolvedValue(null);

      const docSummary: ESummaryDocumentSummary = {
        '@_uid': '40000001',
        Title: 'Nested Author format test',
        Authors: {
          Author: [
            { Name: 'Garcia M', authtype: 'Author' },
            { Name: 'Wang X', authtype: 'Author' },
          ],
        },
      };

      const eSummaryResult: ESummaryResult = {
        DocumentSummarySet: { DocumentSummary: docSummary },
      };

      const results = await extractBriefSummaries(eSummaryResult, testContext);
      expect(results[0]?.authors).toBe('Garcia M, Wang X');
    });

    it('parses Authors as comma-separated string', async () => {
      mockParseDate.mockResolvedValue(null);

      const docSummary: ESummaryDocumentSummary = {
        '@_uid': '40000002',
        Title: 'String authors test',
        Authors: 'Smith JA, Doe B, Brown C',
      };

      const eSummaryResult: ESummaryResult = {
        DocumentSummarySet: { DocumentSummary: docSummary },
      };

      const results = await extractBriefSummaries(eSummaryResult, testContext);
      expect(results[0]?.authors).toContain('Smith JA');
      expect(results[0]?.authors).toContain('Doe B');
      expect(results[0]?.authors).toContain('Brown C');
    });

    it('extracts PMC ID from ArticleIds in DocumentSummary', async () => {
      mockParseDate.mockResolvedValue(null);

      const docSummary: ESummaryDocumentSummary = {
        '@_uid': '40000003',
        Title: 'PMC ID test',
        ArticleIds: {
          ArticleId: [
            { idtype: 'pubmed', idtypen: 1, value: '40000003' },
            { idtype: 'pmc', idtypen: 8, value: 'PMC9999999' },
          ],
        },
      };

      const eSummaryResult: ESummaryResult = {
        DocumentSummarySet: { DocumentSummary: docSummary },
      };

      const results = await extractBriefSummaries(eSummaryResult, testContext);
      expect(results[0]?.pmcId).toBe('PMC9999999');
    });

    it('falls back to FullJournalName when Source is absent', async () => {
      mockParseDate.mockResolvedValue(null);

      const docSummary: ESummaryDocumentSummary = {
        '@_uid': '40000004',
        Title: 'Source fallback test',
        FullJournalName: 'Journal of Advanced Testing',
      };

      const eSummaryResult: ESummaryResult = {
        DocumentSummarySet: { DocumentSummary: docSummary },
      };

      const results = await extractBriefSummaries(eSummaryResult, testContext);
      expect(results[0]?.source).toBe('Journal of Advanced Testing');
    });
  });
});
