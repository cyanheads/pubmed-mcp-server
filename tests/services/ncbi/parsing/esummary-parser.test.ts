/**
 * @fileoverview Tests for ESummary parsing functions, with extensive coverage
 * of NCBI date format handling.
 * @module tests/services/ncbi/parsing/esummary-parser.test
 */

import { describe, expect, it } from 'vitest';
import {
  chapterDateFromDocDate,
  extractBriefSummaries,
  formatESummaryAuthors,
  parseESummaryAuthorsFromDocumentSummary,
  parseNcbiDate,
} from '@/services/ncbi/parsing/esummary-parser.js';
import { ensureArray } from '@/services/ncbi/parsing/xml-helpers.js';
import type { ESummaryAuthor, ESummaryResult } from '@/services/ncbi/types.js';
import {
  BOOK_ESUMMARY_V1_XML,
  BOOK_ESUMMARY_XML,
  CHAPTER_DATES_ESUMMARY_XML,
  parseESummaryXml,
} from './_book-fixtures.js';
import { APOS_TITLE_ESUMMARY_XML } from './_entity-fixtures.js';

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
  /**
   * Every `PubDate` shape in a 2,868-record ESummary sample, read at the
   * precision PubMed states it: ISO 8601, a stated range as an interval
   * `start/end`. Each PMID is a sampled record carrying that value. (#293)
   */
  describe('reads every sampled ESummary PubDate shape at its stated precision (#293)', () => {
    it.each([
      ['2026', '42999664', '2026'],
      ['2026 Dec', '42802242', '2026-12'],
      ['2026 Sep 30', '42813705', '2026-09-30'],
      ['2026 Sep-Oct', '42949620', '2026-09/2026-10'],
      ['2026 Jan-Feb 01', '43002090', '2026-01/2026-02'],
      ['2026 Jan-Dec', '42987129', '2026'],
      ['1996 Summer', '10159187', '1996'],
      ['1994-1995 Winter', '10140181', '1994/1995'],
      ['1999 Dec 18-25', '10660326', '1999-12-18/1999-12-25'],
      ['2000 Aug 30-Sep 5', '12073922', '2000-08-30/2000-09-05'],
      ['2006 Dec 12-2007 Jan 1', '17212296', '2006-12-12/2007-01-01'],
      ['2017 May-June', '30040342', '2017'],
    ])('reads %j (PMID %s) as %j', (raw, _pmid, expected) => {
      expect(parseNcbiDate(raw)).toBe(expected);
    });

    it('reads a slash month range as the dash one', () => {
      expect(parseNcbiDate('2026 Sep/Oct')).toBe('2026-09/2026-10');
    });

    it.each(['Spring', 'Summer', 'Fall', 'Autumn', 'Winter'])(
      'reads any season (%s) as its year',
      (season) => {
        expect(parseNcbiDate(`1996 ${season}`)).toBe('1996');
      },
    );

    it('reads an electronic publication date to the day', () => {
      // Every one of the sample's 927 EPubDate values has this shape.
      expect(parseNcbiDate('2026 Sep 27')).toBe('2026-09-27');
    });
  });

  describe('a day range within one month', () => {
    it.each([
      ['2026 Sep 5-12', '2026-09-05/2026-09-12'],
      ['2026 Sep 1-5', '2026-09-01/2026-09-05'],
    ])('reads %j as %j (an interval of days)', (raw, expected) => {
      expect(parseNcbiDate(raw)).toBe(expected);
    });
  });

  describe('ranges that cross a year', () => {
    it.each([
      ['1998 Dec-1999 Jan', '1998-12/1999-01'],
      ['2000 Dec 14-2001 Jan 3', '2000-12-14/2001-01-03'],
      ['1998-1999', '1998/1999'],
    ])('reads %j as %j', (raw, expected) => {
      expect(parseNcbiDate(raw)).toBe(expected);
    });
  });

  describe('a range whose ends are equal states one point', () => {
    it.each([
      ['2026 Sep-Sep', '2026-09'],
      ['2026 Sep/Sep', '2026-09'],
      ['2026 Sep 5-5', '2026-09-05'],
      ['2026 Sep 5-Sep 5', '2026-09-05'],
    ])('reads %j as %j', (raw, expected) => {
      expect(parseNcbiDate(raw)).toBe(expected);
    });
  });

  describe('reads only the leading year of a value it cannot read as stated', () => {
    it.each([
      ['1989-89 Winter', 'a two-digit end year (sampled)', '1989'],
      ['2026 Dec-Jan', 'a range ending before it starts', '2026'],
      ['2026 Jan 15-Feb', 'a range whose ends differ in precision', '2026'],
      ['2026 Jan-15', 'a day ending a month', '2026'],
      ['2006 Dec 12-2007 January 1', 'a day ending on a spelled-out month', '2006'],
      ['2026 Sep-Oct-Nov', 'two separators', '2026'],
      ['2026 Sep Summer', 'a season on a month', '2026'],
      ['2023 December', 'a month spelled out', '2023'],
      ['2023 De', 'a short month', '2023'],
      ['2023 Xyz', 'an unknown month', '2023'],
      ['2023-12-10', 'an ISO date', '2023'],
    ])('reads %j (%s) as %j', (raw, _shape, expected) => {
      expect(parseNcbiDate(raw)).toBe(expected);
    });
  });

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

  describe('year + month (partial dates), at month precision', () => {
    it.each([
      ['2023 Dec', '2023-12'],
      ['2021 Jun', '2021-06'],
      ['2024 Oct', '2024-10'],
      ['2018 Jun', '2018-06'],
      ['2010 Nov', '2010-11'],
      ['1995 Dec', '1995-12'],
      ['2005 Dec', '2005-12'],
      ['2022 Jan', '2022-01'],
      ['2019 Mar', '2019-03'],
      ['2020 Jul', '2020-07'],
      ['2017 Aug', '2017-08'],
      ['2016 Sep', '2016-09'],
    ])('parses "%s" → "%s"', (input, expected) => {
      expect(parseNcbiDate(input)).toBe(expected);
    });
  });

  describe('year only, at year precision', () => {
    it.each([
      ['2024', '2024'],
      ['2013', '2013'],
      ['1993', '1993'],
      ['2012', '2012'],
      ['2000', '2000'],
      ['1978', '1978'],
    ])('parses "%s" → "%s"', (input, expected) => {
      expect(parseNcbiDate(input)).toBe(expected);
    });
  });

  describe('month range — dash separator', () => {
    it.each([
      ['2018 Jul-Aug', '2018-07/2018-08'],
      ['2010 Nov-Dec', '2010-11/2010-12'],
      ['2010 Sep-Oct', '2010-09/2010-10'],
      ['2015 Jan-Feb', '2015-01/2015-02'],
      ['2020 Mar-Apr', '2020-03/2020-04'],
    ])('parses "%s" → "%s" (an interval of months)', (input, expected) => {
      expect(parseNcbiDate(input)).toBe(expected);
    });
  });

  describe('month range — slash separator', () => {
    it.each([
      ['2018 Jan/Feb', '2018-01/2018-02'],
      ['2019 May/Jun', '2019-05/2019-06'],
      ['2021 Nov/Dec', '2021-11/2021-12'],
    ])('parses "%s" → "%s" (an interval of months)', (input, expected) => {
      expect(parseNcbiDate(input)).toBe(expected);
    });
  });

  describe('whitespace handling', () => {
    it('trims leading/trailing whitespace', () => {
      expect(parseNcbiDate('  2023 Dec  ')).toBe('2023-12');
    });

    it('handles single space between components', () => {
      expect(parseNcbiDate('2023 Dec 10')).toBe('2023-12-10');
    });

    it('reads a whitespace run between components as one space', () => {
      expect(parseNcbiDate('2023  Dec\t10')).toBe('2023-12-10');
      expect(parseNcbiDate('1994-1995  Winter')).toBe('1994/1995');
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
      expect(parseNcbiDate(`2020 ${abbrev}`)).toBe(`2020-${num}`);
    });
  });

  describe('returns undefined for a value that does not open with a year', () => {
    it.each([
      [''],
      ['   '],
      ['not a date'],
      ['December 2023'],
      ['12/10/2023'],
      ['10 Dec 2023'],
      ['Spring 2025'],
      ['20'],
      ['123'],
      ['12345'],
      ['2023abc'],
    ])('rejects "%s"', (input) => {
      expect(parseNcbiDate(input)).toBeUndefined();
    });
  });

  describe('keeps the stated year, never a later one', () => {
    it.each([
      ['29860986', '2018 Jun', '2018-06'],
      ['39134804', '2024 Oct', '2024-10'],
      ['29763212', '2012', '2012'],
      ['21137135', '2010 Nov-Dec', '2010-11/2010-12'],
    ])('PMID %s: %j → %j', (_pmid, raw, expected) => {
      expect(parseNcbiDate(raw)).toBe(expected);
    });
  });
});

/* -------------------------------------------------------------------------- */
/*  extractBriefSummaries                                                     */
/* -------------------------------------------------------------------------- */

/**
 * ESummary version 2.0 for three PMIDs, fetched 2026-11-10 and trimmed to the
 * uid, the dates, `Source`, `Title`, and `DocType`: 42802242 (`2026 Dec`, epub
 * `2026 Sep 27`), the weekly issue 17212296 (`2006 Dec 12-2007 Jan 1`, empty
 * `EPubDate`), and 42999664, whose year-only `PubDate` the XML parser reads as
 * a number. (#293)
 */
const DATE_SHAPES_ESUMMARY_XML = `<?xml version="1.0" encoding="UTF-8" ?><!DOCTYPE eSummaryResult PUBLIC "-//NLM//DTD esummary pubmed 20160808//EN" "https://eutils.ncbi.nlm.nih.gov/eutils/dtd/20160808/esummary_pubmed.dtd"><eSummaryResult><DocumentSummarySet status="OK"><DbBuild/><DocumentSummary uid = "42802242"><PubDate>2026 Dec</PubDate><EPubDate>2026 Sep 27</EPubDate><Source>Diabetes Obes Metab</Source><Title>Effectiveness of Adding GLP-1 Receptor Agonists to SGLT2 Inhibitor Therapy in Chronic Kidney Disease: A Population Based Study.</Title><DocType>citation</DocType></DocumentSummary><DocumentSummary uid = "17212296"><PubDate>2006 Dec 12-2007 Jan 1</PubDate><EPubDate/><Source>Nurs Times</Source><Title>How to search for and use 'grey literature' in research.</Title><DocType>citation</DocType></DocumentSummary><DocumentSummary uid = "42999664"><PubDate>2026</PubDate><EPubDate>2025 Aug 26</EPubDate><Source>Artif Intell Law (Dordr)</Source><Title>Combining topic modelling and citation network analysis to study case law from the European Court of Human Rights on the right to respect for private and family life.</Title><DocType>citation</DocType></DocumentSummary></DocumentSummarySet></eSummaryResult>`;

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

  it('carries the full author roster alongside the truncated display string (#87)', async () => {
    const names = ['Das U', 'Prasad SS', 'Sahoo T', 'Paramanik S', 'Halder A', 'S P'];
    const result: ESummaryResult = {
      DocumentSummarySet: {
        DocumentSummary: [{ '@_uid': '41952275', Authors: names.map((Name) => ({ Name })) }],
      },
    };
    const summaries = await extractBriefSummaries(result);

    expect(summaries[0]?.authors).toBe('Das U, Prasad SS, Sahoo T, et al.');
    expect(summaries[0]?.authorNames).toEqual(names);
  });

  it('carries the full author roster from the old DocSum format (#87)', async () => {
    const names = ['Doe J', 'Roe R', 'Poe P', 'Moe M'];
    const result: ESummaryResult = {
      DocSum: [
        {
          Id: '67890',
          Item: [
            {
              '@_Name': 'AuthorList',
              '@_Type': 'List',
              Item: names.map((name) => ({
                '@_Name': 'Author',
                '@_Type': 'String' as const,
                '#text': name,
              })),
            },
          ],
        },
      ],
    };
    const summaries = await extractBriefSummaries(result);

    expect(summaries[0]?.authors).toBe('Doe J, Roe R, Poe P, et al.');
    expect(summaries[0]?.authorNames).toEqual(names);
  });

  it('extracts DOI and PMC ID from DocumentSummary ArticleIds (JSON/lowercase shape)', async () => {
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

  /**
   * Regression test for issue #17: when `retmode=xml&version=2.0` is used
   * (the default path for `pubmed_search_articles` summaries), fast-xml-parser
   * returns capitalized keys (`IdType`/`Value`) because those are the child
   * element names in the DTD, not attributes. The previous implementation only
   * matched lowercase keys, so DOI and PMC IDs silently dropped on every call.
   */
  it('extracts DOI and PMC ID from DocumentSummary ArticleIds (XML/capitalized shape)', async () => {
    const result: ESummaryResult = {
      DocumentSummarySet: {
        DocumentSummary: [
          {
            '@_uid': '25430774',
            Title: 'Genome editing. The new frontier of genome engineering with CRISPR-Cas9.',
            ArticleIds: {
              ArticleId: [
                { IdType: 'pubmed', IdTypeN: 1, Value: 25430774 },
                { IdType: 'doi', IdTypeN: 3, Value: '10.1126/science.1258096' },
                { IdType: 'pmc', IdTypeN: 8, Value: 'PMC9876543' },
                { IdType: 'pii', IdTypeN: 4, Value: '346/6213/1258096' },
              ],
            },
          },
        ],
      },
    };
    const summaries = await extractBriefSummaries(result);
    expect(summaries[0]?.doi).toBe('10.1126/science.1258096');
    expect(summaries[0]?.pmcId).toBe('PMC9876543');
  });

  it('prefers top-level DOI field when present', async () => {
    const result: ESummaryResult = {
      DocumentSummarySet: {
        DocumentSummary: [
          {
            '@_uid': '22222',
            Title: 'DOI In Both Places',
            DOI: '10.1000/top-level',
            ArticleIds: {
              ArticleId: [{ IdType: 'doi', IdTypeN: 3, Value: '10.1000/article-ids' }],
            },
          },
        ],
      },
    };
    const summaries = await extractBriefSummaries(result);
    expect(summaries[0]?.doi).toBe('10.1000/top-level');
  });

  it('omits doi/pmcId when ArticleIds contains neither', async () => {
    const result: ESummaryResult = {
      DocumentSummarySet: {
        DocumentSummary: [
          {
            '@_uid': '33333',
            Title: 'No IDs',
            ArticleIds: {
              ArticleId: [{ IdType: 'pubmed', IdTypeN: 1, Value: 33333 }],
            },
          },
        ],
      },
    };
    const summaries = await extractBriefSummaries(result);
    expect(summaries[0]?.doi).toBeUndefined();
    expect(summaries[0]?.pmcId).toBeUndefined();
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
      expect(summaries[0]?.pubDate).toBe('2018-06');
      expect(summaries[0]?.epubDate).toBe('2018-04-30');
    });

    it('correctly parses year-only PubDate', async () => {
      const result: ESummaryResult = {
        DocumentSummarySet: {
          DocumentSummary: [{ '@_uid': '29763212', Title: 'Test', PubDate: '2012' }],
        },
      };
      const summaries = await extractBriefSummaries(result);
      expect(summaries[0]?.pubDate).toBe('2012');
    });

    it('correctly parses month-range PubDate', async () => {
      const result: ESummaryResult = {
        DocumentSummarySet: {
          DocumentSummary: [{ '@_uid': '21137135', Title: 'Test', PubDate: '2010 Nov-Dec' }],
        },
      };
      const summaries = await extractBriefSummaries(result);
      expect(summaries[0]?.pubDate).toBe('2010-11/2010-12');
    });

    it('reads both dates from version 2.0 XML, and no epubDate from an empty EPubDate (#293)', async () => {
      const summaries = await extractBriefSummaries(parseESummaryXml(DATE_SHAPES_ESUMMARY_XML));
      expect(summaries.map(({ pmid, pubDate, epubDate }) => ({ pmid, pubDate, epubDate }))).toEqual(
        [
          { pmid: '42802242', pubDate: '2026-12', epubDate: '2026-09-27' },
          { pmid: '17212296', pubDate: '2006-12-12/2007-01-01', epubDate: undefined },
          { pmid: '42999664', pubDate: '2026', epubDate: '2025-08-26' },
        ],
      );
      expect(summaries[1]).not.toHaveProperty('epubDate');
    });

    it('omits pubDate when PubDate does not open with a year', async () => {
      const result: ESummaryResult = {
        DocumentSummarySet: {
          DocumentSummary: [{ '@_uid': '88888', Title: 'Odd Date', PubDate: 'Spring 2025' }],
        },
      };
      const summaries = await extractBriefSummaries(result);
      expect(summaries[0]).not.toHaveProperty('pubDate');
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
      expect(summaries[0]?.pubDate).toBe('2023-12');
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
    ['29860986', '2018 Jun', '2018-06'],
    ['39134804', '2024 Oct', '2024-10'],
    ['21079489', '2010 Dec', '2010-12'],
    // YYYY Mon DD — full date
    ['39361750', '2024 Oct 4', '2024-10-04'],
    ['36361634', '2022 Oct 25', '2022-10-25'],
    ['35189910', '2022 Feb 21', '2022-02-21'],
    ['30485056', '2018 Dec 1', '2018-12-01'],
    // YYYY — year only
    ['29763212', '2012', '2012'],
    ['26828341', '2015', '2015'],
    // YYYY Mon-Mon — month range (dash)
    ['21137135', '2010 Nov-Dec', '2010-11/2010-12'],
    ['20825267', '2010 Sep-Oct', '2010-09/2010-10'],
    ['21261196', '2010 Nov-Dec', '2010-11/2010-12'],
    // Seasons, day ranges, and the leading-year reading (#293)
    ['10159187', '1996 Summer', '1996'],
    ['10140181', '1994-1995 Winter', '1994/1995'],
    ['10660326', '1999 Dec 18-25', '1999-12-18/1999-12-25'],
    ['12073922', '2000 Aug 30-Sep 5', '2000-08-30/2000-09-05'],
    ['17212296', '2006 Dec 12-2007 Jan 1', '2006-12-12/2007-01-01'],
    ['30040342', '2017 May-June', '2017'],
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

  it('all epubdate values from a real search are parseable', async () => {
    const pmidsWithEpub = ['29860986', '39134804', '26694161', '35189910', '33339441'];
    const rawDates = await fetchRawNcbiDates(pmidsWithEpub);

    let checked = 0;
    for (const [pmid, raw] of rawDates) {
      if (!raw.epubdate) continue;
      const parsed = parseNcbiDate(raw.epubdate);
      expect(parsed, `epubdate "${raw.epubdate}" for PMID ${pmid} should parse`).toMatch(
        /^\d{4}-\d{2}-\d{2}$/,
      );
      checked++;
    }
    expect(checked, 'no epubdate came back to check').toBeGreaterThan(0);
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
    let checked = 0;
    for (const [pmid, raw] of rawDates) {
      if (!raw.pubdate) continue;
      const parsed = parseNcbiDate(raw.pubdate);
      if (!parsed) continue;
      const parsedYear = Number.parseInt(parsed.substring(0, 4), 10);
      expect(
        parsedYear,
        `PMID ${pmid}: parsed year ${parsedYear} from "${raw.pubdate}" should not exceed current year + 1`,
      ).toBeLessThanOrEqual(currentYear + 1);
      checked++;
    }
    expect(checked, 'no pubdate came back parsed to check').toBeGreaterThan(0);
  }, 15_000);
});

/* -------------------------------------------------------------------------- */
/*  Bookshelf records (#114)                                                  */
/* -------------------------------------------------------------------------- */

describe('Bookshelf records (#114)', () => {
  const summaries = () => extractBriefSummaries(parseESummaryXml(BOOK_ESUMMARY_XML));
  const geneReviews = async () => (await summaries()).find((s) => s.pmid === '20301425');
  const statPearls = async () => (await summaries()).find((s) => s.pmid === '29262038');

  it('builds the display string from the chapter authors, not the series editors', async () => {
    // ESummary lists the five GeneReviews editors ahead of the chapter's own
    // authors, so taking the first three names credits the wrong people.
    expect((await geneReviews())?.authors).toBe('Petrucelli N, Daly MB, Pal T');
  });

  it('keeps the editors, separately from the authors', async () => {
    expect((await geneReviews())?.editors).toEqual([
      'Adam MP',
      'Bick S',
      'Mirzaa GM',
      'Wallace SE',
      'Amemiya A',
    ]);
    expect((await geneReviews())?.authorNames).toEqual(['Petrucelli N', 'Daly MB', 'Pal T']);
  });

  it('surfaces the book as the venue, which Source and FullJournalName leave empty', async () => {
    const summary = await geneReviews();
    expect(summary?.source).toBeUndefined();
    expect(summary?.bookTitle).toBe('GeneReviews(®)');
    expect(summary?.publisherName).toBe('University of Washington, Seattle');
    expect(summary?.docType).toBe('chapter');
  });

  it('leaves a record with only authors unchanged', async () => {
    const summary = await statPearls();
    expect(summary?.authors).toBe('Casaubon JT, Kashyap S, Regan JP');
    expect(summary?.editors).toBeUndefined();
    expect(summary?.bookTitle).toBe('StatPearls');
  });

  it('still parses the title and the date', async () => {
    const summary = await geneReviews();
    expect(summary?.title).toBe(
      'BRCA1- and BRCA2-Associated Hereditary Breast and Ovarian Cancer.',
    );
    // The chapter's own revision (DocDate "… [updated 2026 Mar 25]"), not the book's 1993 (#199)
    expect(summary?.pubDate).toBe('2026-03-25');
  });

  it('adds no book fields to a journal summary', async () => {
    const result: ESummaryResult = {
      DocumentSummarySet: {
        DocumentSummary: [
          {
            '@_uid': '12345',
            Title: 'Test Article',
            Source: 'Nature',
            Authors: [{ Name: 'Smith J', AuthType: 'Author' }],
          },
        ],
      },
    };
    const [summary] = await extractBriefSummaries(result);
    expect(summary?.authors).toBe('Smith J');
    expect(summary?.bookTitle).toBeUndefined();
    expect(summary?.publisherName).toBeUndefined();
    expect(summary?.docType).toBeUndefined();
    expect(summary?.editors).toBeUndefined();
  });
});

// ─── Absent vs. empty upstream fields (#137) ─────────────────────────────────

describe('parseESummaryAuthorsFromDocumentSummary (#137)', () => {
  /** A journal DocumentSummary: NCBI ships no `AuthType` and no `ClusterID`. */
  const NO_AUTHTYPE_XML =
    '<?xml version="1.0" encoding="UTF-8" ?><eSummaryResult><DocumentSummarySet status="OK">' +
    '<DocumentSummary uid="12345"><Authors><Author><Name>Smith J</Name></Author></Authors>' +
    '<Title>Test Article</Title></DocumentSummary></DocumentSummarySet></eSummaryResult>';

  const firstSummary = (xml: string) =>
    ensureArray(parseESummaryXml(xml).DocumentSummarySet?.DocumentSummary)[0];

  it('omits authtype entirely when the record carries no AuthType', () => {
    const summary = firstSummary(NO_AUTHTYPE_XML);
    if (!summary) throw new Error('fixture did not parse');

    const authors = parseESummaryAuthorsFromDocumentSummary(summary);

    expect(authors).toEqual([{ name: 'Smith J' }]);
    expect(authors[0]).not.toHaveProperty('authtype');
    expect(authors[0]).not.toHaveProperty('clusterid');
  });

  it('keeps an AuthType the record does carry, and drops an empty ClusterID', () => {
    // Every author in the GeneReviews summary carries `<AuthType>` and an empty
    // `<ClusterID/>` — a field present with no value is the same absence.
    const summary = firstSummary(BOOK_ESUMMARY_XML);
    if (!summary) throw new Error('fixture did not parse');

    const authors = parseESummaryAuthorsFromDocumentSummary(summary);

    expect(authors[0]).toEqual({ name: 'Adam MP', authtype: 'Editor' });
    expect(authors.at(-1)).toEqual({ name: 'Pal T', authtype: 'Author' });
  });

  it('still splits editors from authors on the AuthType it kept', async () => {
    const summaries = await extractBriefSummaries(parseESummaryXml(BOOK_ESUMMARY_XML));

    expect(summaries[0]?.editors).toEqual([
      'Adam MP',
      'Bick S',
      'Mirzaa GM',
      'Wallace SE',
      'Amemiya A',
    ]);
    expect(summaries[0]?.authorNames).toEqual(['Petrucelli N', 'Daly MB', 'Pal T']);
  });
});

// ─── Bookshelf chapter dates (#199) ──────────────────────────────────────────
//
// A chapter's `PubDate` is its book's (GeneReviews: 1993). Its own dates are in
// `DocDate`, and the summary is dated the way `pubmed_format_citations` dates
// the chapter: the last revision, else the contribution date (#189).

describe('Bookshelf chapter dates (#199)', () => {
  const byPmid = async (xml: string) =>
    new Map((await extractBriefSummaries(parseESummaryXml(xml))).map((s) => [s.pmid, s]));

  it('dates a revised chapter by its revision, not its book', async () => {
    const summaries = await byPmid(CHAPTER_DATES_ESUMMARY_XML);
    // DocDate "1998 Oct 23 [updated 2018 Dec 20]", PubDate "1993"
    expect(summaries.get('20301340')?.pubDate).toBe('2018-12-20');
  });

  it('dates an unrevised chapter by its contribution date', async () => {
    const summaries = await byPmid(CHAPTER_DATES_ESUMMARY_XML);
    // DocDate "2025 Jul 3", PubDate "2000"
    expect(summaries.get('25905212')?.pubDate).toBe('2025-07-03');
  });

  it('reads a partial chapter date the way every summary date is read', async () => {
    const summaries = await byPmid(CHAPTER_DATES_ESUMMARY_XML);
    // DocDate "2021 Sep" (book PubDate "2014") and "2026" (book PubDate
    // "2025 Dec 4"): the chapter's own month or year, at that precision, as a
    // journal's "2026 Jul" reads "2026-07". (#293)
    expect(summaries.get('36356174')?.pubDate).toBe('2021-09');
    expect(summaries.get('42330151')?.pubDate).toBe('2026');
  });

  it('leaves a whole book and a journal article on their PubDate', async () => {
    const summaries = await byPmid(CHAPTER_DATES_ESUMMARY_XML);
    expect(summaries.get('40825089')).toMatchObject({ docType: 'book', pubDate: '2025-07-02' });
    expect(summaries.get('42474064')).toMatchObject({
      docType: 'citation',
      pubDate: '2026-07',
    });
  });

  it('dates the #114 fixtures by their own DocDate', async () => {
    const summaries = await byPmid(BOOK_ESUMMARY_XML);
    // "1998 Sep 4 [updated 2026 Mar 25]" and "2023 Jul 23"; PubDate "1993", "2026 Jan"
    expect(summaries.get('20301425')?.pubDate).toBe('2026-03-25');
    expect(summaries.get('29262038')?.pubDate).toBe('2023-07-23');
  });

  it('keeps the book date when a chapter DocDate is absent or unreadable', async () => {
    const withDocDate = (docDate: string) =>
      CHAPTER_DATES_ESUMMARY_XML.replace(
        '<DocDate>2025 Jul 3</DocDate>',
        docDate ? `<DocDate>${docDate}</DocDate>` : '<DocDate/>',
      );
    for (const docDate of ['', 'Spring 2025', '[updated ]']) {
      const summaries = await byPmid(withDocDate(docDate));
      expect(summaries.get('25905212')?.pubDate, docDate).toBe('2000');
    }
  });

  it('cannot read DocDate from a version 1 DocSum, which does not carry it', async () => {
    // The older format has no DocDate item, so its chapter keeps the book date.
    const summaries = await byPmid(BOOK_ESUMMARY_V1_XML);
    expect(summaries.get('20301425')?.pubDate).toBe('1993');
  });

  describe('chapterDateFromDocDate', () => {
    it.each([
      ['1998 Oct 23 [updated 2018 Dec 20]', '2018-12-20'],
      ['2025 Jul 3', '2025-07-03'],
      ['2021 Sep', '2021-09'],
      ['2026', '2026'],
      ['  2009 Sep 1  [updated 2011 Feb 10]  ', '2011-02-10'],
      ['2009 Sep 1 [updated', '2009-09-01'],
      ['1998 Oct 23 [updated Smarch]', '1998-10-23'],
      // A revision of any other shape opening with a year reads as that year (#293)
      ['1998 Oct 23 [updated 2018 Smarch 2]', '2018'],
    ])('reads %j as %j', (docDate, expected) => {
      expect(chapterDateFromDocDate(docDate)).toBe(expected);
    });

    it.each(['', 'Spring 2025', '[updated ]', '[updated Smarch 2]'])(
      'returns undefined for %j',
      (docDate) => {
        expect(chapterDateFromDocDate(docDate)).toBeUndefined();
      },
    );

    /** CPU time of `run`, in ms — this thread's user + system time, not wall clock. */
    const cpuMs = (run: () => void): number => {
      const start = process.threadCpuUsage();
      run();
      const { user, system } = process.threadCpuUsage(start);
      return (user + system) / 1000;
    };
    /** Fastest of five measurements of twenty reads each. */
    const fastestMs = (read: () => void): number => {
      read();
      return Math.min(
        ...Array.from({ length: 5 }, () =>
          cpuMs(() => {
            for (let i = 0; i < 20; i++) read();
          }),
        ),
      );
    };

    it.each([
      ['an opener with no closer, repeated', (n: number) => '[updated '.repeat(n / 9)],
      ['brackets with no marker', (n: number) => '['.repeat(n)],
      ['a year then a whitespace run', (n: number) => `2020 ${' '.repeat(n)}x`],
      ['an opener, then whitespace with no closer', (n: number) => `[updated ${' '.repeat(n)}`],
    ])('reads %s in linear CPU time', (_label, build) => {
      const small = build(5_000);
      const large = build(80_000);
      const t5k = fastestMs(() => chapterDateFromDocDate(small));
      const t80k = fastestMs(() => chapterDateFromDocDate(large));
      expect(t80k / t5k).toBeLessThan(64);
      expect(t80k).toBeLessThan(250);
    });
  });
});

/* -------------------------------------------------------------------------- */
/*  Text NCBI double-encodes (#262)                                           */
/* -------------------------------------------------------------------------- */

describe('ESummary text NCBI double-encodes, decoded one layer (#262)', () => {
  const summariesOf = (xml: string) => extractBriefSummaries(parseESummaryXml(xml));

  it('reads the apostrophe EFetch decodes in the same title (PMID 42138044)', async () => {
    const [summary] = await summariesOf(APOS_TITLE_ESUMMARY_XML);
    expect(summary?.title).toBe(
      "Cervical Vestibular-Evoked Myogenic Potentials (cVEMPs) in Parkinson's Disease Patients: Prospective, Case-Control study.",
    );
    expect(summary?.source).toBe('Otolaryngol Pol');
    expect(summary?.authors).toBe('Abbas AI, Ghanem SS, Abed EE, et al.');
  });

  it('decodes a Bookshelf book title, and the title on the version 1.0 path', async () => {
    const book = (
      await summariesOf(
        BOOK_ESUMMARY_XML.replace(
          '<BookTitle>StatPearls</BookTitle>',
          '<BookTitle>StatPearls &amp;amp; Q&amp;amp;A</BookTitle>',
        ),
      )
    ).find((s) => s.pmid === '29262038');
    expect(book?.bookTitle).toBe('StatPearls & Q&A');

    const [v1] = await summariesOf(
      BOOK_ESUMMARY_V1_XML.replace(
        'Ovarian Cancer.</Item>',
        'Ovarian Cancer: Parkinson&amp;apos;s Q&amp;amp;A.</Item>',
      ),
    );
    expect(v1?.title).toBe(
      "BRCA1- and BRCA2-Associated Hereditary Breast and Ovarian Cancer: Parkinson's Q&A.",
    );
  });

  it('decodes one layer only, leaves a bare ampersand, and reads names and sources as parsed', async () => {
    const [summary] = await summariesOf(
      APOS_TITLE_ESUMMARY_XML.replace(
        'Parkinson&amp;apos;s Disease',
        'Parkinson&amp;amp;lt;s&amp;amp;gt; AT&amp;T Disease',
      )
        .replace('<Name>Abbas AI</Name>', '<Name>R&amp;amp;D Group</Name>')
        .replace('<Source>Otolaryngol Pol</Source>', '<Source>Otolaryngol &amp;amp; Pol</Source>'),
    );
    expect(summary?.title).toContain('in Parkinson&lt;s&gt; AT&T Disease Patients');
    expect(summary?.authorNames?.[0]).toBe('R&amp;D Group');
    expect(summary?.source).toBe('Otolaryngol &amp; Pol');
  });
});
