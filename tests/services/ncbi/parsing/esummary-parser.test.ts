/**
 * @fileoverview Tests for ESummary parsing functions.
 * @module tests/services/ncbi/parsing/esummary-parser.test
 */

import { describe, expect, it } from 'vitest';
import {
  extractBriefSummaries,
  formatESummaryAuthors,
  standardizeESummaryDate,
} from '@/services/ncbi/parsing/esummary-parser.js';
import type { ESummaryAuthor, ESummaryResult } from '@/services/ncbi/types.js';

describe('formatESummaryAuthors', () => {
  it('returns empty string for no authors', () => {
    expect(formatESummaryAuthors(undefined)).toBe('');
    expect(formatESummaryAuthors([])).toBe('');
  });

  it('formats a single author', () => {
    const authors: ESummaryAuthor[] = [{ name: 'Smith J' }];
    expect(formatESummaryAuthors(authors)).toBe('Smith J');
  });

  it('formats up to 3 authors', () => {
    const authors: ESummaryAuthor[] = [
      { name: 'Smith J' },
      { name: 'Doe JA' },
      { name: 'Johnson R' },
    ];
    expect(formatESummaryAuthors(authors)).toBe('Smith J, Doe JA, Johnson R');
  });

  it('adds et al. for more than 3 authors', () => {
    const authors: ESummaryAuthor[] = [
      { name: 'Smith J' },
      { name: 'Doe JA' },
      { name: 'Johnson R' },
      { name: 'Williams M' },
    ];
    const result = formatESummaryAuthors(authors);
    expect(result).toBe('Smith J, Doe JA, Johnson R, et al.');
  });
});

describe('standardizeESummaryDate', () => {
  it('returns undefined for null/undefined', async () => {
    expect(await standardizeESummaryDate(undefined)).toBeUndefined();
    expect(await standardizeESummaryDate(null as unknown as string)).toBeUndefined();
  });
});

describe('extractBriefSummaries', () => {
  it('returns empty array for undefined input', async () => {
    expect(await extractBriefSummaries(undefined)).toEqual([]);
  });

  it('returns empty array when result has ERROR', async () => {
    const result: ESummaryResult = { ERROR: 'Something went wrong' };
    expect(await extractBriefSummaries(result)).toEqual([]);
  });

  it('parses DocumentSummarySet format', async () => {
    const result: ESummaryResult = {
      DocumentSummarySet: {
        DocumentSummary: [
          {
            '@_uid': '12345',
            Title: 'Test Article',
            Source: 'Nature',
            Authors: [{ Name: 'Smith J' }],
          },
        ],
      },
    };
    const summaries = await extractBriefSummaries(result);
    expect(summaries).toHaveLength(1);
    expect(summaries[0]?.pmid).toBe('12345');
    expect(summaries[0]?.title).toBe('Test Article');
    expect(summaries[0]?.source).toBe('Nature');
  });

  it('parses old DocSum format', async () => {
    const result: ESummaryResult = {
      DocSum: [
        {
          Id: '67890',
          Item: [
            { '@_Name': 'Title', '@_Type': 'String', '#text': 'Old Format Article' },
            { '@_Name': 'Source', '@_Type': 'String', '#text': 'Science' },
            {
              '@_Name': 'AuthorList',
              '@_Type': 'List',
              Item: [{ '@_Name': 'Author', '@_Type': 'String', '#text': 'Doe J' }],
            },
          ],
        },
      ],
    };
    const summaries = await extractBriefSummaries(result);
    expect(summaries).toHaveLength(1);
    expect(summaries[0]?.pmid).toBe('67890');
    expect(summaries[0]?.title).toBe('Old Format Article');
  });

  it('extracts DOI and PMC ID from DocumentSummary ArticleIds', async () => {
    const result: ESummaryResult = {
      DocumentSummarySet: {
        DocumentSummary: [
          {
            '@_uid': '11111',
            Title: 'Article With IDs',
            ArticleIds: {
              ArticleId: [
                { idtype: 'doi', idtypen: 3, value: '10.1000/test' },
                { idtype: 'pmc', idtypen: 8, value: 'PMC999' },
              ],
            },
          },
        ],
      },
    };
    const summaries = await extractBriefSummaries(result);
    expect(summaries[0]?.doi).toBe('10.1000/test');
    expect(summaries[0]?.pmcId).toBe('PMC999');
  });
});
