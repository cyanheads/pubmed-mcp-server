/**
 * @fileoverview Tests for ESummary parsing functions, with extensive coverage
 * of NCBI date format handling.
 * @module tests/services/ncbi/parsing/esummary-parser.test
 */

import { describe, expect, it } from 'vitest';
import {
  extractBriefSummaries,
  formatESummaryAuthors,
  parseNcbiDate,
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

/* -------------------------------------------------------------------------- */
/*  parseNcbiDate — unit tests for the dedicated NCBI date parser             */
/* -------------------------------------------------------------------------- */

describe('parseNcbiDate', () => {
  describe('year + month + day (full dates)', () => {
    it.each([
      ['2021 Dec 10', '2021-12-10'],
      ['2024 Oct 29', '2024-10-29'],
      ['2018 Apr 30', '2018-04-30'],
      ['2020 Jan 1', '2020-01-01'],
      ['2015 Dec 15', '2015-12-15'],
      ['2018 Dec 1', '2018-12-01'],
      ['2022 Feb 21', '2022-02-21'],
      ['2023 Jan 20', '2023-01-20'],
    ])('parses "%s" → "%s"', (input, expected) => {
      expect(parseNcbiDate(input)).toBe(expected);
    });
  });

  describe('year + month (partial dates)', () => {
    it.each([
      ['2023 Dec', '2023-12-01'],
      ['2021 Jun', '2021-06-01'],
      ['2024 Oct', '2024-10-01'],
      ['2018 Jun', '2018-06-01'],
      ['2010 Nov', '2010-11-01'],
      ['1995 Dec', '1995-12-01'],
      ['2005 Dec', '2005-12-01'],
      ['2022 Jan', '2022-01-01'],
      ['2019 Mar', '2019-03-01'],
      ['2020 Jul', '2020-07-01'],
      ['2017 Aug', '2017-08-01'],
      ['2016 Sep', '2016-09-01'],
    ])('parses "%s" → "%s"', (input, expected) => {
      expect(parseNcbiDate(input)).toBe(expected);
    });
  });

  describe('year only', () => {
    it.each([
      ['2024', '2024-01-01'],
      ['2013', '2013-01-01'],
      ['1993', '1993-01-01'],
      ['2012', '2012-01-01'],
      ['2000', '2000-01-01'],
      ['1978', '1978-01-01'],
    ])('parses "%s" → "%s"', (input, expected) => {
      expect(parseNcbiDate(input)).toBe(expected);
    });
  });

  describe('month range — dash separator', () => {
    it.each([
      ['2018 Jul-Aug', '2018-07-01'],
      ['2010 Nov-Dec', '2010-11-01'],
      ['2010 Sep-Oct', '2010-09-01'],
      ['2015 Jan-Feb', '2015-01-01'],
      ['2020 Mar-Apr', '2020-03-01'],
    ])('parses "%s" → "%s" (uses first month)', (input, expected) => {
      expect(parseNcbiDate(input)).toBe(expected);
    });
  });

  describe('month range — slash separator', () => {
    it.each([
      ['2018 Jan/Feb', '2018-01-01'],
      ['2019 May/Jun', '2019-05-01'],
      ['2021 Nov/Dec', '2021-11-01'],
    ])('parses "%s" → "%s" (uses first month)', (input, expected) => {
      expect(parseNcbiDate(input)).toBe(expected);
    });
  });

  describe('whitespace handling', () => {
    it('trims leading/trailing whitespace', () => {
      expect(parseNcbiDate('  2023 Dec  ')).toBe('2023-12-01');
    });

    it('handles single space between components', () => {
      expect(parseNcbiDate('2023 Dec 10')).toBe('2023-12-10');
    });
  });

  describe('all 12 months', () => {
    const months = [
      ['Jan', '01'],
      ['Feb', '02'],
      ['Mar', '03'],
      ['Apr', '04'],
      ['May', '05'],
      ['Jun', '06'],
      ['Jul', '07'],
      ['Aug', '08'],
      ['Sep', '09'],
      ['Oct', '10'],
      ['Nov', '11'],
      ['Dec', '12'],
    ] as const;

    it.each(months)('recognizes %s as month %s', (abbrev, num) => {
      expect(parseNcbiDate(`2020 ${abbrev}`)).toBe(`2020-${num}-01`);
    });
  });

  describe('returns undefined for unrecognized formats', () => {
    it.each([
      [''],
      ['not a date'],
      ['December 2023'],
      ['2023-12-10'],
      ['12/10/2023'],
      ['10 Dec 2023'],
      ['2023 December'],
      ['2023 De'],
      ['2023 Xyz'],
      ['20'],
      ['123'],
      ['12345'],
    ])('rejects "%s"', (input) => {
      expect(parseNcbiDate(input)).toBeUndefined();
    });
  });

  describe('preserves year fidelity (the chrono-node bug)', () => {
    it('does not forward-date "2018 Jun" to a future year', () => {
      const result = parseNcbiDate('2018 Jun');
      expect(result).toBe('2018-06-01');
      expect(result).toMatch(/^2018-/);
    });

    it('does not forward-date "2023 Dec" to a future year', () => {
      const result = parseNcbiDate('2023 Dec');
      expect(result).toBe('2023-12-01');
      expect(result).toMatch(/^2023-/);
    });

    it('does not forward-date "2018 Jul-Aug" to a future year', () => {
      const result = parseNcbiDate('2018 Jul-Aug');
      expect(result).toBe('2018-07-01');
      expect(result).toMatch(/^2018-/);
    });

    it('parses year-only "2024" instead of returning null', () => {
      expect(parseNcbiDate('2024')).toBe('2024-01-01');
    });
  });
});

/* -------------------------------------------------------------------------- */
/*  standardizeESummaryDate — integration with the full parsing pipeline      */
/* -------------------------------------------------------------------------- */

describe('standardizeESummaryDate', () => {
  it('returns undefined for null/undefined', async () => {
    expect(await standardizeESummaryDate(undefined)).toBeUndefined();
    expect(await standardizeESummaryDate(null as unknown as string)).toBeUndefined();
  });

  it('returns undefined for empty string', async () => {
    expect(await standardizeESummaryDate('')).toBeUndefined();
    expect(await standardizeESummaryDate('   ')).toBeUndefined();
  });

  describe('handles all NCBI date formats via parseNcbiDate fast path', () => {
    it.each([
      ['2023 Dec', '2023-12-01'],
      ['2021 Dec 10', '2021-12-10'],
      ['2024', '2024-01-01'],
      ['2018 Jul-Aug', '2018-07-01'],
      ['2018 Jan/Feb', '2018-01-01'],
      ['2010 Nov-Dec', '2010-11-01'],
      ['2018 Apr 30', '2018-04-30'],
      ['2018 Dec 1', '2018-12-01'],
    ])('parses "%s" → "%s"', async (input, expected) => {
      expect(await standardizeESummaryDate(input)).toBe(expected);
    });
  });

  describe('year fidelity through the full pipeline', () => {
    it('PMID 29860986: "2018 Jun" → 2018, not a future year', async () => {
      const result = await standardizeESummaryDate('2018 Jun');
      expect(result).toBe('2018-06-01');
    });

    it('PMID 39134804: "2024 Oct" → 2024-10-01', async () => {
      const result = await standardizeESummaryDate('2024 Oct');
      expect(result).toBe('2024-10-01');
    });

    it('PMID 29763212: "2012" → 2012-01-01', async () => {
      const result = await standardizeESummaryDate('2012');
      expect(result).toBe('2012-01-01');
    });

    it('PMID 21137135: "2010 Nov-Dec" → 2010-11-01', async () => {
      const result = await standardizeESummaryDate('2010 Nov-Dec');
      expect(result).toBe('2010-11-01');
    });
  });
});

/* -------------------------------------------------------------------------- */
/*  extractBriefSummaries                                                     */
/* -------------------------------------------------------------------------- */

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

  describe('date parsing through extractBriefSummaries', () => {
    it('correctly parses "YYYY Mon" PubDate in DocumentSummarySet', async () => {
      const result: ESummaryResult = {
        DocumentSummarySet: {
          DocumentSummary: [
            {
              '@_uid': '29860986',
              Title: 'Test',
              PubDate: '2018 Jun',
              EPubDate: '2018 Apr 30',
            },
          ],
        },
      };
      const summaries = await extractBriefSummaries(result);
      expect(summaries[0]?.pubDate).toBe('2018-06-01');
      expect(summaries[0]?.epubDate).toBe('2018-04-30');
    });

    it('correctly parses year-only PubDate', async () => {
      const result: ESummaryResult = {
        DocumentSummarySet: {
          DocumentSummary: [{ '@_uid': '29763212', Title: 'Test', PubDate: '2012' }],
        },
      };
      const summaries = await extractBriefSummaries(result);
      expect(summaries[0]?.pubDate).toBe('2012-01-01');
    });

    it('correctly parses month-range PubDate', async () => {
      const result: ESummaryResult = {
        DocumentSummarySet: {
          DocumentSummary: [{ '@_uid': '21137135', Title: 'Test', PubDate: '2010 Nov-Dec' }],
        },
      };
      const summaries = await extractBriefSummaries(result);
      expect(summaries[0]?.pubDate).toBe('2010-11-01');
    });

    it('omits pubDate/epubDate when absent', async () => {
      const result: ESummaryResult = {
        DocumentSummarySet: {
          DocumentSummary: [{ '@_uid': '99999', Title: 'No Dates' }],
        },
      };
      const summaries = await extractBriefSummaries(result);
      expect(summaries[0]?.pubDate).toBeUndefined();
      expect(summaries[0]?.epubDate).toBeUndefined();
    });

    it('correctly parses dates in old DocSum format', async () => {
      const result: ESummaryResult = {
        DocSum: [
          {
            Id: '12345',
            Item: [
              { '@_Name': 'Title', '@_Type': 'String', '#text': 'Test' },
              { '@_Name': 'PubDate', '@_Type': 'Date', '#text': '2023 Dec' },
              { '@_Name': 'EPubDate', '@_Type': 'Date', '#text': '2023 Nov 15' },
            ],
          },
        ],
      };
      const summaries = await extractBriefSummaries(result);
      expect(summaries[0]?.pubDate).toBe('2023-12-01');
      expect(summaries[0]?.epubDate).toBe('2023-11-15');
    });
  });
});

/* -------------------------------------------------------------------------- */
/*  Live NCBI API integration tests                                           */
/*  These hit the real ESummary endpoint with known PMIDs and verify that      */
/*  dates parsed through the full pipeline match expected values.              */
/*  Skipped in CI (no NCBI_API_KEY) — run locally with:                       */
/*    NCBI_INTEGRATION=1 bun run test -- esummary-parser                      */
/* -------------------------------------------------------------------------- */

const LIVE = process.env.NCBI_INTEGRATION === '1';

interface NcbiJsonSummary {
  epubdate: string;
  pubdate: string;
  title: string;
  uid: string;
}

interface NcbiJsonResult {
  result: { uids: string[] } & Record<string, NcbiJsonSummary>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function fetchRawNcbiDates(
  pmids: string[],
): Promise<Map<string, { pubdate: string; epubdate: string }>> {
  const url = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?db=pubmed&id=${pmids.join(',')}&retmode=json`;
  const res = await fetch(url);
  const data = (await res.json()) as NcbiJsonResult;
  const map = new Map<string, { pubdate: string; epubdate: string }>();
  for (const uid of data.result.uids) {
    const entry = data.result[uid];
    if (entry) map.set(uid, { pubdate: entry.pubdate, epubdate: entry.epubdate });
  }
  return map;
}

describe.skipIf(!LIVE)('NCBI API integration: date parsing', () => {
  /**
   * Known PMIDs with verified date formats from the live API.
   * Each entry: [pmid, expected raw pubdate pattern, expected parsed result]
   */
  const knownArticles: [string, string, string][] = [
    // YYYY Mon — most common format
    ['29860986', '2018 Jun', '2018-06-01'],
    ['39134804', '2024 Oct', '2024-10-01'],
    ['21079489', '2010 Dec', '2010-12-01'],
    // YYYY Mon DD — full date
    ['39361750', '2024 Oct 4', '2024-10-04'],
    ['36361634', '2022 Oct 25', '2022-10-25'],
    ['35189910', '2022 Feb 21', '2022-02-21'],
    ['30485056', '2018 Dec 1', '2018-12-01'],
    // YYYY — year only
    ['29763212', '2012', '2012-01-01'],
    ['26828341', '2015', '2015-01-01'],
    // YYYY Mon-Mon — month range (dash)
    ['21137135', '2010 Nov-Dec', '2010-11-01'],
    ['20825267', '2010 Sep-Oct', '2010-09-01'],
    ['21261196', '2010 Nov-Dec', '2010-11-01'],
  ];

  it('fetches raw dates from NCBI and verifies parseNcbiDate produces correct results', async () => {
    const pmids = knownArticles.map(([pmid]) => pmid);
    const rawDates = await fetchRawNcbiDates(pmids);

    for (const [pmid, expectedRaw, expectedParsed] of knownArticles) {
      const raw = rawDates.get(pmid);
      expect(raw, `PMID ${pmid} not returned by API`).toBeDefined();
      expect(raw!.pubdate).toBe(expectedRaw);

      const parsed = parseNcbiDate(raw!.pubdate);
      expect(parsed, `parseNcbiDate failed for PMID ${pmid} raw="${raw!.pubdate}"`).toBe(
        expectedParsed,
      );
    }
  }, 15_000);

  it('standardizeESummaryDate produces correct results for all live dates', async () => {
    const pmids = knownArticles.map(([pmid]) => pmid);
    const rawDates = await fetchRawNcbiDates(pmids);

    for (const [pmid, , expectedParsed] of knownArticles) {
      const raw = rawDates.get(pmid);
      const parsed = await standardizeESummaryDate(raw!.pubdate);
      expect(parsed, `standardizeESummaryDate failed for PMID ${pmid}`).toBe(expectedParsed);
    }
  }, 15_000);

  it('all epubdate values from a real search are parseable', async () => {
    const pmidsWithEpub = ['29860986', '39134804', '26694161', '35189910', '33339441'];
    const rawDates = await fetchRawNcbiDates(pmidsWithEpub);

    for (const [pmid, raw] of rawDates) {
      if (!raw.epubdate) continue;
      const parsed = await standardizeESummaryDate(raw.epubdate);
      expect(parsed, `epubdate "${raw.epubdate}" for PMID ${pmid} should parse`).toBeDefined();
      expect(parsed).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  }, 15_000);

  it('no parsed date from known PMIDs produces a future year', async () => {
    // Use a broad set of PMIDs spanning decades — avoids a second esearch call that triggers rate limits
    // Pause to avoid NCBI rate limiting (3 req/sec without API key)
    await sleep(1500);
    const broadPmids = [
      '29860986',
      '39134804',
      '39361750',
      '36361634',
      '34740608',
      '35189910',
      '33339441',
      '36656942',
      '29763212',
      '30285347',
      '21137135',
      '20825267',
      '21261196',
      '30525364',
      '30485056',
      '26828341',
      '26694161',
      '8675674',
    ];
    const rawDates = await fetchRawNcbiDates(broadPmids);

    const currentYear = new Date().getFullYear();
    for (const [pmid, raw] of rawDates) {
      if (!raw.pubdate) continue;
      const parsed = parseNcbiDate(raw.pubdate);
      if (!parsed) continue;
      const parsedYear = Number.parseInt(parsed.substring(0, 4), 10);
      expect(
        parsedYear,
        `PMID ${pmid}: parsed year ${parsedYear} from "${raw.pubdate}" should not exceed current year + 1`,
      ).toBeLessThanOrEqual(currentYear + 1);
    }
  }, 15_000);
});
