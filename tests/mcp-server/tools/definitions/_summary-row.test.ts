/**
 * @fileoverview Tests for the brief-summary row `pubmed_search_articles`
 * summaries and `pubmed_find_related` rows share: the builder's value table —
 * every field present and absent, each `pubDate` form — the schema it is
 * validated against, and one ESummary response read end to end through the real
 * parser. Each tool's tests prove its own wiring. (#293, #297)
 * @module tests/mcp-server/tools/definitions/_summary-row.test
 */

import { describe, expect, it } from 'vitest';

import { summaryRow, summaryRowSchema } from '@/mcp-server/tools/definitions/_summary-row.js';
import { extractBriefSummaries } from '@/services/ncbi/parsing/esummary-parser.js';
import type { ParsedBriefSummary } from '@/services/ncbi/types.js';

import { parseESummaryXml } from '../../../services/ncbi/parsing/_book-fixtures.js';

/**
 * ESummary version 2.0 for three rows of PMID 31535829's `cited_by` set, fetched
 * 2026-11-10 and trimmed to the dates, `Source`, the first four authors,
 * `Title`, `ArticleIds`, and `DocType`: 42926911 (DOI and PMCID, `2026 Oct`,
 * epub `2026 Oct 24`), 42905372 (DOI, no PMCID), and 42802242 (`2026 Dec`,
 * epub `2026 Sep 27`).
 */
const ROWS_ESUMMARY_XML = `<?xml version="1.0" encoding="UTF-8" ?><!DOCTYPE eSummaryResult PUBLIC "-//NLM//DTD esummary pubmed 20160808//EN" "https://eutils.ncbi.nlm.nih.gov/eutils/dtd/20160808/esummary_pubmed.dtd"><eSummaryResult><DocumentSummarySet status="OK"><DbBuild/><DocumentSummary uid = "42926911"><PubDate>2026 Oct</PubDate><EPubDate>2026 Oct 24</EPubDate><Source>Cureus</Source><Authors><Author><Name>Hassanien A</Name><AuthType>Author</AuthType><ClusterID/></Author><Author><Name>Elhenedy M</Name><AuthType>Author</AuthType><ClusterID/></Author><Author><Name>Elgohari M</Name><AuthType>Author</AuthType><ClusterID/></Author></Authors><Title>Concordance Between Trial Efficacy and Real-World Effectiveness of Sodium-Glucose Cotransporter 2 Inhibitors in Heart Failure With Reduced Ejection Fraction: A Systematic Review and Meta-Analysis.</Title><ArticleIds><ArticleId><IdType>pubmed</IdType><IdTypeN>1</IdTypeN><Value>42926911</Value></ArticleId><ArticleId><IdType>pmc</IdType><IdTypeN>8</IdTypeN><Value>PMC13695040</Value></ArticleId><ArticleId><IdType>pmcid</IdType><IdTypeN>5</IdTypeN><Value>pmc-id: PMC13695040;</Value></ArticleId><ArticleId><IdType>doi</IdType><IdTypeN>3</IdTypeN><Value>10.7759/cureus.118487</Value></ArticleId></ArticleIds><DocType>citation</DocType></DocumentSummary><DocumentSummary uid = "42905372"><PubDate>2026 Oct 21</PubDate><EPubDate>2026 Oct 21</EPubDate><Source>Intern Emerg Med</Source><Authors><Author><Name>Armentaro G</Name><AuthType>Author</AuthType><ClusterID/></Author><Author><Name>Pastura CA</Name><AuthType>Author</AuthType><ClusterID/></Author><Author><Name>Marino DM</Name><AuthType>Author</AuthType><ClusterID/></Author><Author><Name>Severini G</Name><AuthType>Author</AuthType><ClusterID/></Author></Authors><Title>Association between SGLT2 inhibitor use and functional outcomes in elderly patients receiving ferric carboxymaltose: a retrospective observational cohort study.</Title><ArticleIds><ArticleId><IdType>pubmed</IdType><IdTypeN>1</IdTypeN><Value>42905372</Value></ArticleId><ArticleId><IdType>doi</IdType><IdTypeN>3</IdTypeN><Value>10.1007/s11739-026-04571-z</Value></ArticleId><ArticleId><IdType>pii</IdType><IdTypeN>4</IdTypeN><Value>10.1007/s11739-026-04571-z</Value></ArticleId></ArticleIds><DocType>citation</DocType></DocumentSummary><DocumentSummary uid = "42802242"><PubDate>2026 Dec</PubDate><EPubDate>2026 Sep 27</EPubDate><Source>Diabetes Obes Metab</Source><Authors><Author><Name>Salim H</Name><AuthType>Author</AuthType><ClusterID/></Author><Author><Name>Qureshi S</Name><AuthType>Author</AuthType><ClusterID/></Author><Author><Name>Gulsin GS</Name><AuthType>Author</AuthType><ClusterID/></Author><Author><Name>Khan HR</Name><AuthType>Author</AuthType><ClusterID/></Author></Authors><Title>Effectiveness of Adding GLP-1 Receptor Agonists to SGLT2 Inhibitor Therapy in Chronic Kidney Disease: A Population Based Study.</Title><ArticleIds><ArticleId><IdType>pubmed</IdType><IdTypeN>1</IdTypeN><Value>42802242</Value></ArticleId><ArticleId><IdType>pmc</IdType><IdTypeN>8</IdTypeN><Value>PMC13730978</Value></ArticleId><ArticleId><IdType>pmcid</IdType><IdTypeN>5</IdTypeN><Value>pmc-id: PMC13730978;</Value></ArticleId><ArticleId><IdType>doi</IdType><IdTypeN>3</IdTypeN><Value>10.1111/dom.71375</Value></ArticleId></ArticleIds><DocType>citation</DocType></DocumentSummary></DocumentSummarySet></eSummaryResult>`;

describe('summaryRow', () => {
  it.each<[string, ParsedBriefSummary, Record<string, unknown>]>([
    [
      'a journal article with every field',
      {
        pmid: '42802242',
        title: 'Effectiveness of Adding GLP-1 Receptor Agonists.',
        authors: 'Salim H, Qureshi S, Gulsin GS, et al.',
        authorNames: ['Salim H', 'Qureshi S', 'Gulsin GS', 'Khan HR'],
        source: 'Diabetes Obes Metab',
        docType: 'citation',
        pubDate: '2026-12',
        epubDate: '2026-09-27',
        doi: '10.1111/dom.71375',
        pmcId: 'PMC13730978',
      },
      {
        pmid: '42802242',
        title: 'Effectiveness of Adding GLP-1 Receptor Agonists.',
        authors: 'Salim H, Qureshi S, Gulsin GS, et al.',
        source: 'Diabetes Obes Metab',
        docType: 'citation',
        pubDate: '2026-12',
        epubDate: '2026-09-27',
        doi: '10.1111/dom.71375',
        pmcId: 'PMC13730978',
        pmcUrl: 'https://www.ncbi.nlm.nih.gov/pmc/articles/PMC13730978/',
        pubmedUrl: 'https://pubmed.ncbi.nlm.nih.gov/42802242/',
      },
    ],
    [
      'a Bookshelf chapter: book venue and editors, no journal',
      {
        pmid: '20301425',
        title: 'BRCA1- and BRCA2-Associated Hereditary Breast and Ovarian Cancer.',
        authors: 'Petrucelli N, Daly MB, Pal T',
        bookTitle: 'GeneReviews(®)',
        publisherName: 'University of Washington, Seattle',
        docType: 'chapter',
        editors: ['Adam MP', 'Bick S'],
        pubDate: '2025-03-20',
      },
      {
        pmid: '20301425',
        title: 'BRCA1- and BRCA2-Associated Hereditary Breast and Ovarian Cancer.',
        authors: 'Petrucelli N, Daly MB, Pal T',
        bookTitle: 'GeneReviews(®)',
        publisherName: 'University of Washington, Seattle',
        docType: 'chapter',
        editors: ['Adam MP', 'Bick S'],
        pubDate: '2025-03-20',
        pubmedUrl: 'https://pubmed.ncbi.nlm.nih.gov/20301425/',
      },
    ],
    [
      'a DOI with no PMC copy: no pmcId, no pmcUrl',
      { pmid: '42905372', title: 'Association study.', doi: '10.1007/s11739-026-04571-z' },
      {
        pmid: '42905372',
        title: 'Association study.',
        doi: '10.1007/s11739-026-04571-z',
        pubmedUrl: 'https://pubmed.ncbi.nlm.nih.gov/42905372/',
      },
    ],
    [
      'a PMID ESummary did not describe',
      { pmid: '333' },
      { pmid: '333', pubmedUrl: 'https://pubmed.ncbi.nlm.nih.gov/333/' },
    ],
  ])('builds %s', (_label, summary, expected) => {
    const row = summaryRow(summary);

    expect(row).toStrictEqual(expected);
    expect(summaryRowSchema.parse(row)).toStrictEqual(expected);
  });

  it.each([
    ['a year', '2026'],
    ['a month', '2026-12'],
    ['a day', '2026-09-30'],
    ['a month interval', '2026-09/2026-10'],
    ['a year interval', '1994/1995'],
    ['a cross-year day interval', '2006-12-12/2007-01-01'],
  ])('carries a pubDate of %s (%s) as the parse states it', (_label, pubDate) => {
    const row = summaryRow({ pmid: '1', title: 'T', pubDate });

    expect(row.title).toBe('T');
    expect(row.pubDate).toBe(pubDate);
    expect(row).not.toHaveProperty('epubDate');
  });

  it('never carries the full author roster, which only verification reads', () => {
    const row = summaryRow({
      pmid: '1',
      authors: 'A, B, C, et al.',
      authorNames: ['A', 'B', 'C', 'D'],
    });

    expect(row.authors).toBe('A, B, C, et al.');
    expect(row).not.toHaveProperty('authorNames');
  });
});

describe('summaryRowSchema', () => {
  it('requires pmid and pubmedUrl and nothing else', () => {
    expect(
      summaryRowSchema.safeParse({ pmid: '1', pubmedUrl: 'https://pubmed.ncbi.nlm.nih.gov/1/' })
        .success,
    ).toBe(true);
    expect(summaryRowSchema.safeParse({ pmid: '1' }).success).toBe(false);
  });

  it('describes every pubDate form and the epubDate', () => {
    const { pubDate, epubDate } = summaryRowSchema.shape;

    for (const form of ['`2026`', '`2026-12`', '`2026-09-30`', '`start/end`', 'chapter']) {
      expect(pubDate.description).toContain(form);
    }
    expect(pubDate.description).not.toContain('first day');
    expect(epubDate.description).toContain('`YYYY-MM-DD`');
  });
});

describe('summaryRow over a real ESummary response', () => {
  it('carries the identifiers, links, and dates ESummary states, and nothing it lacks', async () => {
    const summaries = await extractBriefSummaries(parseESummaryXml(ROWS_ESUMMARY_XML));

    expect(summaries.map(summaryRow)).toStrictEqual([
      {
        pmid: '42926911',
        title:
          'Concordance Between Trial Efficacy and Real-World Effectiveness of Sodium-Glucose Cotransporter 2 Inhibitors in Heart Failure With Reduced Ejection Fraction: A Systematic Review and Meta-Analysis.',
        authors: 'Hassanien A, Elhenedy M, Elgohari M',
        source: 'Cureus',
        docType: 'citation',
        pubDate: '2026-10',
        epubDate: '2026-10-24',
        doi: '10.7759/cureus.118487',
        pmcId: 'PMC13695040',
        pmcUrl: 'https://www.ncbi.nlm.nih.gov/pmc/articles/PMC13695040/',
        pubmedUrl: 'https://pubmed.ncbi.nlm.nih.gov/42926911/',
      },
      {
        pmid: '42905372',
        title:
          'Association between SGLT2 inhibitor use and functional outcomes in elderly patients receiving ferric carboxymaltose: a retrospective observational cohort study.',
        authors: 'Armentaro G, Pastura CA, Marino DM, et al.',
        source: 'Intern Emerg Med',
        docType: 'citation',
        pubDate: '2026-10-21',
        epubDate: '2026-10-21',
        doi: '10.1007/s11739-026-04571-z',
        pubmedUrl: 'https://pubmed.ncbi.nlm.nih.gov/42905372/',
      },
      {
        pmid: '42802242',
        title:
          'Effectiveness of Adding GLP-1 Receptor Agonists to SGLT2 Inhibitor Therapy in Chronic Kidney Disease: A Population Based Study.',
        authors: 'Salim H, Qureshi S, Gulsin GS, et al.',
        source: 'Diabetes Obes Metab',
        docType: 'citation',
        pubDate: '2026-12',
        epubDate: '2026-09-27',
        doi: '10.1111/dom.71375',
        pmcId: 'PMC13730978',
        pmcUrl: 'https://www.ncbi.nlm.nih.gov/pmc/articles/PMC13730978/',
        pubmedUrl: 'https://pubmed.ncbi.nlm.nih.gov/42802242/',
      },
    ]);
  });
});
