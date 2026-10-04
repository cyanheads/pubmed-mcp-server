/**
 * @fileoverview Tests for the fetch-articles tool.
 * @module tests/mcp-server/tools/definitions/fetch-articles.tool.test
 */

import { z } from '@cyanheads/mcp-ts-core';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { textBlocks } from '../../../_helpers.js';
import {
  ADA_WHOLE_BOOK_XML,
  articleSetXml,
  ENDOTEXT_CHAPTER_XML,
  GENEREVIEWS_ALZHEIMER_CHAPTER_XML,
  GENEREVIEWS_CHAPTER_XML,
  JOURNAL_ARTICLE_XML,
  LACTMED_CHAPTER_XML,
  NAP_WHOLE_BOOK_XML,
  NICE_WHOLE_BOOK_XML,
  parseArticleSetXml,
  STATPEARLS_CHAPTER_XML,
} from '../../../services/ncbi/parsing/_book-fixtures.js';
import {
  ERRATUM_NOTE_ARTICLE_XML,
  PUBLISHED_ERRATUM_WITH_CITES_XML,
  PUBLISHED_ERRATUM_XML,
  RETRACTED_ARTICLE_XML,
  RETRACTION_NOTICE_XML,
} from '../../../services/ncbi/parsing/_comments-corrections-fixtures.js';

const mockEFetch = vi.fn();
vi.mock('@/services/ncbi/ncbi-service.js', () => ({
  getNcbiService: () => ({ eFetch: mockEFetch }),
}));

const { fetchArticlesTool } = await import('@/mcp-server/tools/definitions/fetch-articles.tool.js');

describe('fetchArticlesTool', () => {
  beforeEach(() => {
    mockEFetch.mockReset();
  });

  it('validates input schema', () => {
    const input = fetchArticlesTool.input.parse({ pmids: ['12345', '67890'] });
    expect(input.pmids).toEqual(['12345', '67890']);
    expect(input.includeMesh).toBe(true);
    expect(input.includeGrants).toBe(false);
  });

  it('rejects non-numeric PMIDs', () => {
    expect(() => fetchArticlesTool.input.parse({ pmids: ['abc'] })).toThrow();
  });

  describe('PMID validation error message (issue #27)', () => {
    it('produces an actionable message naming the PMID domain for non-numeric input', () => {
      const parsed = fetchArticlesTool.input.safeParse({ pmids: ['abc'] });
      expect(parsed.success).toBe(false);
      const message = parsed.error?.issues[0]?.message ?? '';
      expect(message).toMatch(/PMID/);
      expect(message).toMatch(/numeric/);
      expect(message).toContain('13054692');
    });

    it('produces the same actionable message when whitespace is included', () => {
      const parsed = fetchArticlesTool.input.safeParse({ pmids: ['13054692 '] });
      expect(parsed.success).toBe(false);
      expect(parsed.error?.issues[0]?.message).toMatch(/whitespace/);
    });

    it('produces the same actionable message for comma-joined PMIDs', () => {
      const parsed = fetchArticlesTool.input.safeParse({ pmids: ['13054692,20502474'] });
      expect(parsed.success).toBe(false);
      expect(parsed.error?.issues[0]?.message).toMatch(/commas/);
    });
  });

  it('reports all PMIDs as unavailable when no articles are returned (issue #20)', async () => {
    mockEFetch.mockResolvedValue({ PubmedArticleSet: null });
    const ctx = createMockContext({ errors: fetchArticlesTool.errors });
    const input = fetchArticlesTool.input.parse({ pmids: ['99999'] });
    const result = await fetchArticlesTool.handler(input, ctx);

    expect(result.articles).toEqual([]);
    expect(result.totalReturned).toBe(0);
    expect(result.unavailablePmids).toEqual(['99999']);
    // Empty-result recovery hint surfaced via ctx.enrich.notice → structuredContent + content[] (issue #58)
    const enrichment = getEnrichment(ctx);
    expect(enrichment.notice).toMatch(/no articles were returned/i);
    expect(enrichment.notice).toContain('pubmed_search_articles');
  });

  it('throws when response is missing PubmedArticleSet with reason "invalid_efetch_response"', async () => {
    mockEFetch.mockResolvedValue({});
    const ctx = createMockContext({ errors: fetchArticlesTool.errors });
    const input = fetchArticlesTool.input.parse({ pmids: ['12345'] });

    const promise = fetchArticlesTool.handler(input, ctx);
    await expect(promise).rejects.toThrow(/missing PubmedArticleSet/);
    await expect(promise).rejects.toMatchObject({ data: { reason: 'invalid_efetch_response' } });
  });

  it('invalid_efetch_response carries the contract recovery hint on the wire', async () => {
    mockEFetch.mockResolvedValue({});
    const result = await runToolContract(fetchArticlesTool, { pmids: ['12345'] });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: {
        data: {
          reason: 'invalid_efetch_response',
          requestedPmids: 1,
          recovery: { hint: expect.stringMatching(/.{20,}/) },
        },
      },
    });
  });

  it('parses articles and adds URLs', async () => {
    mockEFetch.mockResolvedValue({
      PubmedArticleSet: {
        PubmedArticle: [
          {
            MedlineCitation: {
              PMID: { '#text': '12345' },
              Article: {
                ArticleTitle: { '#text': 'Test' },
                Journal: { Title: { '#text': 'J' } },
                PublicationTypeList: {
                  PublicationType: { '#text': 'Journal Article' },
                },
              },
            },
            PubmedData: {
              ArticleIdList: {
                ArticleId: [{ '#text': 'PMC999', '@_IdType': 'pmc' }],
              },
            },
          },
        ],
      },
    });

    const ctx = createMockContext({ errors: fetchArticlesTool.errors });
    const input = fetchArticlesTool.input.parse({ pmids: ['12345'] });
    const result = await fetchArticlesTool.handler(input, ctx);

    expect(result.totalReturned).toBe(1);
    expect(result.articles[0]?.pmid).toBe('12345');
    expect(result.articles[0]?.pubmedUrl).toContain('12345');
    expect(result.articles[0]?.pmcUrl).toContain('PMC999');
    // notice is absent on a successful fetch (issue #58)
    expect(getEnrichment(ctx).notice).toBeUndefined();
  });

  it('reports unavailable PMIDs', async () => {
    mockEFetch.mockResolvedValue({
      PubmedArticleSet: {
        PubmedArticle: [
          {
            MedlineCitation: {
              PMID: { '#text': '111' },
              Article: {
                ArticleTitle: { '#text': 'Found' },
                PublicationTypeList: { PublicationType: { '#text': 'Journal Article' } },
              },
            },
          },
        ],
      },
    });

    const ctx = createMockContext({ errors: fetchArticlesTool.errors });
    const input = fetchArticlesTool.input.parse({ pmids: ['111', '222'] });
    const result = await fetchArticlesTool.handler(input, ctx);

    expect(result.unavailablePmids).toEqual(['222']);
  });

  it('preserves decoded Unicode metadata from eFetch responses', async () => {
    mockEFetch.mockResolvedValue({
      PubmedArticleSet: {
        PubmedArticle: [
          {
            MedlineCitation: {
              PMID: { '#text': '24680' },
              Article: {
                ArticleTitle: { '#text': '\u03b2-catenin in Garc\u00eda-L\u00f3pez cohorts' },
                AuthorList: {
                  Author: [
                    {
                      LastName: { '#text': 'Garc\u00eda-L\u00f3pez' },
                      ForeName: { '#text': 'Maria' },
                      Initials: { '#text': 'M' },
                      AffiliationInfo: [
                        {
                          Affiliation: { '#text': 'Uniwersytet Jagiello\u0144ski, Krak\u00f3w' },
                        },
                      ],
                    },
                  ],
                },
                Journal: {
                  Title: { '#text': 'Revista Cl\u00ednica' },
                  JournalIssue: {
                    Volume: { '#text': '12' },
                    Issue: { '#text': '4' },
                    PubDate: { Year: { '#text': '2025' } },
                  },
                },
                Pagination: { MedlinePgn: { '#text': '45\u201352' } },
                PublicationTypeList: { PublicationType: { '#text': 'Journal Article' } },
              },
            },
            PubmedData: {
              ArticleIdList: {
                ArticleId: [{ '#text': 'PMC24680', '@_IdType': 'pmc' }],
              },
            },
          },
        ],
      },
    });

    const ctx = createMockContext({ errors: fetchArticlesTool.errors });
    const input = fetchArticlesTool.input.parse({ pmids: ['24680'] });
    const result = await fetchArticlesTool.handler(input, ctx);

    expect(result.articles[0]?.title).toBe('\u03b2-catenin in Garc\u00eda-L\u00f3pez cohorts');
    expect(result.articles[0]?.authors?.[0]?.lastName).toBe('Garc\u00eda-L\u00f3pez');
    expect(result.articles[0]?.affiliations).toEqual([
      'Uniwersytet Jagiello\u0144ski, Krak\u00f3w',
    ]);
    expect(result.articles[0]?.journalInfo?.pages).toBe('45\u201352');
    expect(result.articles[0]?.pmcUrl).toContain('PMC24680');
  });

  describe('electronic article locators (issue #121)', () => {
    // PMID 39060015 as NCBI EFetch returns it: no Pagination, a pii locator and
    // a doi locator side by side.
    const eurRespirArticle = {
      MedlineCitation: {
        PMID: { '#text': '39060015' },
        Article: {
          ArticleTitle: { '#text': 'Benralizumab for allergic asthma.' },
          Journal: {
            ISSN: { '#text': '1399-3003', '@_IssnType': 'Electronic' },
            JournalIssue: {
              Volume: { '#text': '64' },
              Issue: { '#text': '3' },
              PubDate: { Year: { '#text': '2024' }, Month: { '#text': 'Sep' } },
            },
            Title: { '#text': 'The European respiratory journal' },
            ISOAbbreviation: { '#text': 'Eur Respir J' },
          },
          ELocationID: [
            { '#text': '2400512', '@_EIdType': 'pii', '@_ValidYN': 'Y' },
            { '#text': '10.1183/13993003.00512-2024', '@_EIdType': 'doi', '@_ValidYN': 'Y' },
          ],
          PublicationTypeList: { PublicationType: { '#text': 'Journal Article' } },
        },
      },
    };

    it('carries the locator and its type in structuredContent, with pages unpopulated', async () => {
      mockEFetch.mockResolvedValue({
        PubmedArticleSet: { PubmedArticle: [eurRespirArticle] },
      });
      const ctx = createMockContext({ errors: fetchArticlesTool.errors });
      const input = fetchArticlesTool.input.parse({ pmids: ['39060015'] });
      const result = await fetchArticlesTool.handler(input, ctx);

      const ji = result.articles[0]?.journalInfo;
      expect(ji?.elocationId).toBe('2400512');
      expect(ji?.elocationIdType).toBe('pii');
      // Never backfilled from the locator — the record genuinely has no pages (#213)
      expect(ji).not.toHaveProperty('pages');
      // DOI extraction is unaffected — the two values live side by side
      expect(result.articles[0]?.doi).toBe('10.1183/13993003.00512-2024');
    });

    it('renders the locator on the format() journal line', () => {
      const blocks = textBlocks(
        fetchArticlesTool.format!({
          articles: [
            {
              recordType: 'journal-article' as const,
              pmid: '39060015',
              title: 'Benralizumab for allergic asthma.',
              journalInfo: {
                isoAbbreviation: 'Eur Respir J',
                volume: '64',
                issue: '3',
                elocationId: '2400512',
                elocationIdType: 'pii',
                publicationDate: { year: '2024', month: 'Sep' },
              },
            },
          ],
          totalReturned: 1,
        }),
      );
      expect(blocks[0]?.text).toContain(
        '**Journal:** Eur Respir J, 2024 Sep, **64**(3), pii: 2400512',
      );
    });

    it('omits both fields for a record whose only locator is invalid', async () => {
      mockEFetch.mockResolvedValue({
        PubmedArticleSet: {
          PubmedArticle: [
            {
              ...eurRespirArticle,
              MedlineCitation: {
                ...eurRespirArticle.MedlineCitation,
                Article: {
                  ...eurRespirArticle.MedlineCitation.Article,
                  ELocationID: [{ '#text': '2400512', '@_EIdType': 'pii', '@_ValidYN': 'N' }],
                },
              },
            },
          ],
        },
      });
      const ctx = createMockContext({ errors: fetchArticlesTool.errors });
      const input = fetchArticlesTool.input.parse({ pmids: ['39060015'] });
      const result = await fetchArticlesTool.handler(input, ctx);

      expect(result.articles[0]?.journalInfo?.elocationId).toBeUndefined();
      expect(result.articles[0]?.journalInfo?.elocationIdType).toBeUndefined();
    });
  });

  it('uses POST for large PMID batches', async () => {
    const pmids = Array.from({ length: 100 }, (_, index) => String(index + 1));
    mockEFetch.mockResolvedValue({
      PubmedArticleSet: {
        PubmedArticle: [
          {
            MedlineCitation: {
              PMID: { '#text': '1' },
              Article: {
                ArticleTitle: { '#text': 'Found' },
                PublicationTypeList: { PublicationType: { '#text': 'Journal Article' } },
              },
            },
          },
          {},
        ],
      },
    });

    const ctx = createMockContext({ errors: fetchArticlesTool.errors });
    const input = fetchArticlesTool.input.parse({ pmids });
    const result = await fetchArticlesTool.handler(input, ctx);

    expect(mockEFetch).toHaveBeenCalledWith(
      { db: 'pubmed', id: pmids.join(','), retmode: 'xml' },
      expect.objectContaining({ retmode: 'xml', usePost: true, signal: expect.any(AbortSignal) }),
    );
    expect(result.totalReturned).toBe(1);
    expect(result.unavailablePmids).toHaveLength(99);
  });

  it('formats output', () => {
    const blocks = textBlocks(
      fetchArticlesTool.format!({
        articles: [
          {
            recordType: 'journal-article' as const,
            pmid: '12345',
            title: 'Test Article',
            abstractText: 'Abstract here.',
            affiliations: ['Example University'],
            authors: [
              { lastName: 'Smith', initials: 'J' },
              { lastName: 'Jones', initials: 'A' },
              { lastName: 'Brown', initials: 'S' },
              { lastName: 'White', initials: 'P' },
            ],
            journalInfo: {
              isoAbbreviation: 'Nat Rev',
              volume: '12',
              issue: '3',
              pages: '45-52',
              publicationDate: { year: '2024' },
            },
            publicationTypes: ['Review'],
            doi: '10.1000/example',
            pubmedUrl: 'https://pubmed.ncbi.nlm.nih.gov/12345/',
            pmcUrl: 'https://www.ncbi.nlm.nih.gov/pmc/articles/PMC12345/',
            keywords: ['asthma', 'airway'],
            meshTerms: [
              {
                descriptorName: 'Asthma',
                isMajorTopic: true,
                qualifiers: [{ qualifierName: 'therapy', isMajorTopic: true }],
              },
            ],
            grantList: [{ grantId: 'R01', agency: 'NIH', country: 'USA' }],
          },
        ],
        totalReturned: 1,
        unavailablePmids: ['99999'],
      }),
    );
    expect(blocks[0]?.text).toContain('PubMed Articles');
    expect(blocks[0]?.text).toContain('Test Article');
    expect(blocks[0]?.text).toContain('Unavailable PMIDs');
    expect(blocks[0]?.text).toContain('Affiliations');
    expect(blocks[0]?.text).toContain('Nat Rev, 2024, **12**(3), 45-52');
    expect(blocks[0]?.text).toContain('**Type:** Review');
    expect(blocks[0]?.text).toContain('**DOI:** 10.1000/example');
    expect(blocks[0]?.text).toContain(
      '**PMC:** https://www.ncbi.nlm.nih.gov/pmc/articles/PMC12345/',
    );
    expect(blocks[0]?.text).toContain('**Keywords:** asthma, airway');
    expect(blocks[0]?.text).toContain('#### MeSH Terms');
    expect(blocks[0]?.text).toContain('- Asthma (major) (therapy (major))');
    expect(blocks[0]?.text).toContain('#### Grants');
    expect(blocks[0]?.text).toContain('R01');
  });

  describe('format() content completeness (issue #26)', () => {
    const richArticle = {
      recordType: 'journal-article' as const,
      pmid: '36813558',
      title: 'Ki67 Expression.',
      abstractText: 'Abstract body.',
      affiliations: ['University of Nottingham', 'Menoufia University'],
      authors: [
        {
          lastName: 'Lashen',
          firstName: 'Ayat Gamal',
          initials: 'AG',
          affiliationIndices: [0, 1],
          orcid: '0000-0001-9494-7382',
        },
        {
          lastName: 'Toss',
          firstName: 'Michael S',
          initials: 'MS',
          affiliationIndices: [0],
        },
        { collectiveName: 'Breast Cancer Group' },
        { lastName: 'Solo', initials: 'S' },
      ],
      journalInfo: {
        isoAbbreviation: 'J Clin Pathol',
        issn: '0021-9746',
        eIssn: '1472-4146',
        volume: '76',
        issue: '6',
        pages: '357-364',
        publicationDate: { year: '2023', month: 'Jun', day: '22' },
      },
      publicationTypes: ['Journal Article', 'Review'],
      doi: '10.1136/jcp-2022-208731',
      pmcId: 'PMC10000',
      pubmedUrl: 'https://pubmed.ncbi.nlm.nih.gov/36813558/',
      pmcUrl: 'https://www.ncbi.nlm.nih.gov/pmc/articles/PMC10000/',
      articleDates: [{ dateType: 'Electronic', year: '2023', month: '02', day: '22' }],
      grantList: [
        { grantId: 'R01 EY05922', acronym: 'EY', agency: 'NEI NIH HHS', country: 'United States' },
      ],
    };

    it('renders every author with full firstName, initials, affiliation indices, and ORCID — no et al. truncation', () => {
      const blocks = textBlocks(
        fetchArticlesTool.format!({ articles: [richArticle], totalReturned: 1 }),
      );
      const text = blocks[0]?.text ?? '';

      expect(text).toContain('**Authors (4):**');
      expect(text).toContain('- Ayat Gamal Lashen (AG) [aff 0,1] · ORCID 0000-0001-9494-7382');
      expect(text).toContain('- Michael S Toss (MS) [aff 0]');
      expect(text).toContain('- Breast Cancer Group (collective)');
      expect(text).toContain('- Solo (S)');
      expect(text).not.toContain('et al.');
    });

    it('renders affiliations as a 0-based list matching the author affiliationIndices', () => {
      const blocks = textBlocks(
        fetchArticlesTool.format!({ articles: [richArticle], totalReturned: 1 }),
      );
      const text = blocks[0]?.text ?? '';

      expect(text).toContain('**Affiliations:**');
      expect(text).toContain('- [0] University of Nottingham');
      expect(text).toContain('- [1] Menoufia University');
    });

    it('renders the full publication date (year, month, day) when available', () => {
      const blocks = textBlocks(
        fetchArticlesTool.format!({ articles: [richArticle], totalReturned: 1 }),
      );
      expect(blocks[0]?.text).toContain('2023 Jun 22');
    });

    it('renders medlineDate when provided instead of year/month/day', () => {
      const seasonal = {
        ...richArticle,
        journalInfo: {
          ...richArticle.journalInfo,
          publicationDate: { medlineDate: '2000 Spring' },
        },
      };
      const blocks = textBlocks(
        fetchArticlesTool.format!({ articles: [seasonal], totalReturned: 1 }),
      );
      expect(blocks[0]?.text).toContain('2000 Spring');
    });

    it('renders the electronic ISSN (preferring eIssn over issn)', () => {
      const blocks = textBlocks(
        fetchArticlesTool.format!({ articles: [richArticle], totalReturned: 1 }),
      );
      expect(blocks[0]?.text).toContain('eISSN 1472-4146');
    });

    it('falls back to print ISSN when no eIssn is present', () => {
      const printOnly = {
        ...richArticle,
        journalInfo: { ...richArticle.journalInfo, eIssn: undefined },
      };
      const blocks = textBlocks(
        fetchArticlesTool.format!({ articles: [printOnly], totalReturned: 1 }),
      );
      expect(blocks[0]?.text).toContain('ISSN 0021-9746');
      expect(blocks[0]?.text).not.toContain('eISSN');
    });

    it('renders the raw PMCID alongside the PMC URL', () => {
      const blocks = textBlocks(
        fetchArticlesTool.format!({ articles: [richArticle], totalReturned: 1 }),
      );
      expect(blocks[0]?.text).toContain('**PMCID:** PMC10000');
    });

    it('renders articleDates with their dateType', () => {
      const blocks = textBlocks(
        fetchArticlesTool.format!({ articles: [richArticle], totalReturned: 1 }),
      );
      expect(blocks[0]?.text).toContain('**Article Dates:** Electronic 2023-02-22');
    });

    it('renders the whole journal line in field order', () => {
      // Locked byte-for-byte: a record carrying real `pages` renders the same
      // journal line regardless of electronic-article-locator handling.
      const blocks = textBlocks(
        fetchArticlesTool.format!({ articles: [richArticle], totalReturned: 1 }),
      );
      expect(blocks[0]?.text).toContain(
        '**Journal:** J Clin Pathol, 2023 Jun 22, **76**(6), 357-364, ISSN 0021-9746, eISSN 1472-4146',
      );
    });

    it('includes the grant acronym alongside the grant ID', () => {
      const blocks = textBlocks(
        fetchArticlesTool.format!({ articles: [richArticle], totalReturned: 1 }),
      );
      expect(blocks[0]?.text).toContain('R01 EY05922 (EY)');
      expect(blocks[0]?.text).toContain('NEI NIH HHS');
    });

    it('renders every author for papers with more than 3 authors', () => {
      const bigAuthorList = {
        ...richArticle,
        authors: Array.from({ length: 10 }, (_, i) => ({
          lastName: `Author${i}`,
          firstName: `First${i}`,
          initials: `F${i}`,
        })),
      };
      const blocks = textBlocks(
        fetchArticlesTool.format!({ articles: [bigAuthorList], totalReturned: 1 }),
      );
      const text = blocks[0]?.text ?? '';
      expect(text).toContain('**Authors (10):**');
      for (let i = 0; i < 10; i++) {
        expect(text).toContain(`- First${i} Author${i}`);
      }
      expect(text).not.toContain('et al.');
    });

    it('renders MeSH descriptorUi and qualifierUi alongside their names (issue #30)', () => {
      const articleWithMeshUis = {
        ...richArticle,
        meshTerms: [
          {
            descriptorName: 'Breast Neoplasms',
            descriptorUi: 'D001943',
            isMajorTopic: true,
            qualifiers: [
              {
                qualifierName: 'pathology',
                qualifierUi: 'Q000473',
                isMajorTopic: false,
              },
            ],
          },
          {
            descriptorName: 'Humans',
            descriptorUi: 'D006801',
            isMajorTopic: false,
          },
        ],
      };
      const blocks = textBlocks(
        fetchArticlesTool.format!({
          articles: [articleWithMeshUis],
          totalReturned: 1,
        }),
      );
      const text = blocks[0]?.text ?? '';
      expect(text).toContain('- Breast Neoplasms [D001943] (major) (pathology [Q000473])');
      expect(text).toContain('- Humans [D006801]');
    });
  });

  describe('format() empty result', () => {
    it('renders the empty state; the recovery notice is enrichment, not format output', () => {
      const blocks = textBlocks(
        fetchArticlesTool.format!({
          articles: [],
          totalReturned: 0,
          unavailablePmids: ['999999999'],
        }),
      );
      const text = blocks[0]?.text ?? '';
      expect(text).toContain('**Articles Returned:** 0');
      expect(text).toContain('**Unavailable PMIDs:** 999999999');
      // notice lives in enrichment (ctx.enrich.notice), not in format() text
      expect(text).not.toMatch(/no articles were returned/i);
    });
  });
});

describe('fetchArticlesTool format() heading escaping (issue #102)', () => {
  const HOSTILE_TITLE = '# Injected\n[Retracted](https://evil.test) *emphasis* <i>PIP2;1</i>';

  const render = (title: string) =>
    textBlocks(
      fetchArticlesTool.format!({
        articles: [
          {
            recordType: 'journal-article' as const,
            pmid: '42',
            title,
            pubmedUrl: 'https://pubmed.ncbi.nlm.nih.gov/42/',
          },
        ],
        totalReturned: 1,
      }),
    )[0]?.text ?? '';

  it('renders a hostile title without adding a heading or a link', () => {
    const text = render(HOSTILE_TITLE);
    const headings = text.split('\n').filter((line) => line.startsWith('#'));
    expect(headings).toEqual([
      '## PubMed Articles',
      '### # Injected \\[Retracted\\](https://evil.test) \\*emphasis\\* \\<i>PIP2;1\\</i>',
    ]);
  });

  it('leaves a legible title untouched', () => {
    const title = 'TP53_mutant tumours at 5*g where P<0.001 in ~250 patients';
    expect(render(title)).toContain(`### ${title}`);
  });

  it('escapes the PMID fallback heading the same way when no title is present', () => {
    const text =
      textBlocks(
        fetchArticlesTool.format!({
          articles: [
            {
              recordType: 'journal-article' as const,
              pmid: '42',
              pubmedUrl: 'https://pubmed.ncbi.nlm.nih.gov/42/',
            },
          ],
          totalReturned: 1,
        }),
      )[0]?.text ?? '';
    expect(text).toContain('### 42');
  });
});

describe('fetchArticlesTool whole-response budget (issue #99)', () => {
  beforeEach(() => {
    mockEFetch.mockReset();
  });

  interface ArticleSpec {
    abstract: string;
    mesh?: boolean;
    pmid: string;
  }

  /** Stage one PubmedArticleSet entry per spec, sized by its abstract. */
  function stageArticles(specs: ArticleSpec[]) {
    mockEFetch.mockResolvedValue({
      PubmedArticleSet: {
        PubmedArticle: specs.map((spec) => ({
          MedlineCitation: {
            PMID: { '#text': spec.pmid },
            Article: {
              ArticleTitle: { '#text': `Article ${spec.pmid}` },
              Abstract: { AbstractText: { '#text': spec.abstract } },
              Journal: { Title: { '#text': 'J Budget' } },
              PublicationTypeList: { PublicationType: { '#text': 'Journal Article' } },
            },
            ...(spec.mesh && {
              MeshHeadingList: {
                MeshHeading: [
                  {
                    DescriptorName: {
                      '#text': `Topic ${spec.pmid}`,
                      '@_UI': `D${spec.pmid}`,
                      '@_MajorTopicYN': 'Y',
                    },
                    QualifierName: {
                      '#text': `therapy ${spec.pmid}`,
                      '@_UI': `Q${spec.pmid}`,
                      '@_MajorTopicYN': 'N',
                    },
                  },
                ],
              },
            }),
          },
        })),
      },
    });
  }

  const run = async (
    pmids: string[],
    extra: Record<string, unknown> = {},
    ctx = createMockContext({ errors: fetchArticlesTool.errors }),
  ) => {
    const input = fetchArticlesTool.input.parse({ pmids, ...extra });
    return { result: await fetchArticlesTool.handler(input, ctx), ctx };
  };

  /** Serialized size of each article record, the unit the budget spends. */
  const sizesOf = (result: { articles: unknown[] }) =>
    result.articles.map((a) => JSON.stringify(a).length);

  it('returns a byte-identical response when no maxResponseCharacters is supplied', async () => {
    stageArticles([
      { pmid: '111', abstract: 'A'.repeat(40), mesh: true },
      { pmid: '222', abstract: 'B'.repeat(40) },
    ]);

    const { result, ctx } = await run(['111', '222', '333']);
    const text = textBlocks(fetchArticlesTool.format!(result))[0]?.text ?? '';

    expect(JSON.stringify(result)).toBe(
      '{"articles":[{"recordType":"journal-article","pmid":"111","title":"Article 111","abstractText":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA","authors":[],"journalInfo":{"title":"J Budget"},"publicationTypes":["Journal Article"],"meshTerms":[{"descriptorName":"Topic 111","descriptorUi":"D111","qualifiers":[{"qualifierName":"therapy 111","qualifierUi":"Q111","isMajorTopic":false}],"isMajorTopic":true}],"pubmedUrl":"https://pubmed.ncbi.nlm.nih.gov/111/"},{"recordType":"journal-article","pmid":"222","title":"Article 222","abstractText":"BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB","authors":[],"journalInfo":{"title":"J Budget"},"publicationTypes":["Journal Article"],"pubmedUrl":"https://pubmed.ncbi.nlm.nih.gov/222/"}],"totalReturned":2,"unavailablePmids":["333"]}',
    );
    expect(text).toBe(
      [
        '## PubMed Articles',
        '**Articles Returned:** 2',
        '**Unavailable PMIDs:** 333',
        '',
        '### Article 111',
        '',
        '**Journal:** J Budget',
        '**Record Type:** journal-article',
        '**Type:** Journal Article',
        '**PMID:** 111',
        '**PubMed:** https://pubmed.ncbi.nlm.nih.gov/111/',
        '',
        '#### Abstract',
        'A'.repeat(40),
        '',
        '#### MeSH Terms',
        '- Topic 111 [D111] (major) (therapy 111 [Q111])',
        '',
        '### Article 222',
        '',
        '**Journal:** J Budget',
        '**Record Type:** journal-article',
        '**Type:** Journal Article',
        '**PMID:** 222',
        '**PubMed:** https://pubmed.ncbi.nlm.nih.gov/222/',
        '',
        '#### Abstract',
        'B'.repeat(40),
      ].join('\n'),
    );
    expect(getEnrichment(ctx).truncated).toBeUndefined();
  });

  it('returns every article when the batch fits the budget', async () => {
    stageArticles([
      { pmid: '111', abstract: 'A'.repeat(40) },
      { pmid: '222', abstract: 'B'.repeat(40) },
    ]);
    const baseline = (await run(['111', '222'])).result;
    const total = sizesOf(baseline).reduce((n, s) => n + s, 0);

    stageArticles([
      { pmid: '111', abstract: 'A'.repeat(40) },
      { pmid: '222', abstract: 'B'.repeat(40) },
    ]);
    const { result, ctx } = await run(['111', '222'], { maxResponseCharacters: total + 1 });

    expect(result.totalReturned).toBe(2);
    expect(result.deferred).toBeUndefined();
    expect(getEnrichment(ctx).truncated).toBeUndefined();
  });

  it('returns every article when the batch exactly meets the budget', async () => {
    const specs = [
      { pmid: '111', abstract: 'A'.repeat(40) },
      { pmid: '222', abstract: 'B'.repeat(40) },
    ];
    stageArticles(specs);
    const total = sizesOf((await run(['111', '222'])).result).reduce((n, s) => n + s, 0);

    stageArticles(specs);
    const { result } = await run(['111', '222'], { maxResponseCharacters: total });

    expect(result.totalReturned).toBe(2);
    expect(result.deferred).toBeUndefined();
  });

  it('defers the last whole article when the batch exceeds the budget by one character', async () => {
    const specs = [
      { pmid: '111', abstract: 'A'.repeat(40), mesh: true },
      { pmid: '222', abstract: 'B'.repeat(40), mesh: true },
    ];
    stageArticles(specs);
    const sizes = sizesOf((await run(['111', '222'])).result);
    const total = sizes.reduce((n, s) => n + s, 0);

    stageArticles(specs);
    const { result, ctx } = await run(['111', '222'], { maxResponseCharacters: total - 1 });

    expect(result.totalReturned).toBe(1);
    expect(result.articles.map((a) => a.pmid)).toEqual(['111']);
    expect(result.deferred).toEqual({
      maxResponseCharacters: total - 1,
      returnedCharacters: sizes[0],
      deferredCount: 1,
      ids: ['222'],
      nextDeferredCharacters: sizes[1],
    });
    // Depth: the kept article keeps its nested MeSH qualifiers, and nothing of
    // the deferred article's nested data reaches the response.
    expect(result.articles[0]?.meshTerms?.[0]?.qualifiers?.[0]?.qualifierName).toBe('therapy 111');
    expect(JSON.stringify(result.articles)).not.toContain('therapy 222');
    expect(getEnrichment(ctx).truncated).toBe(true);
    expect(getEnrichment(ctx).notice).toContain('222');
  });

  it('keeps unavailable PMIDs out of the deferred list and reports them in full', async () => {
    const specs = [
      { pmid: '111', abstract: 'A'.repeat(40) },
      { pmid: '222', abstract: 'B'.repeat(40) },
    ];
    stageArticles(specs);
    const sizes = sizesOf((await run(['111', '222'])).result);

    stageArticles(specs);
    const { result } = await run(['111', '222', '333', '444'], {
      maxResponseCharacters: sizes[0],
    });

    expect(result.unavailablePmids).toEqual(['333', '444']);
    expect(result.deferred?.ids).toEqual(['222']);
  });

  it('resumes exactly where the previous call stopped when re-called with the deferred PMIDs', async () => {
    const specs = [
      { pmid: '111', abstract: 'A'.repeat(40) },
      { pmid: '222', abstract: 'B'.repeat(60) },
      { pmid: '333', abstract: 'C'.repeat(80) },
    ];
    stageArticles(specs);
    const sizes = sizesOf((await run(['111', '222', '333'])).result);

    stageArticles(specs);
    const first = (
      await run(['111', '222', '333'], { maxResponseCharacters: (sizes[0] ?? 0) + (sizes[1] ?? 0) })
    ).result;
    expect(first.articles.map((a) => a.pmid)).toEqual(['111', '222']);
    expect(first.deferred?.ids).toEqual(['333']);

    stageArticles(specs.filter((s) => first.deferred?.ids.includes(s.pmid)));
    const second = (await run(first.deferred?.ids ?? [])).result;

    expect(second.articles.map((a) => a.pmid)).toEqual(['333']);
    expect(second.deferred).toBeUndefined();
    const seen = [...first.articles, ...second.articles].map((a) => a.pmid);
    expect(seen).toEqual(['111', '222', '333']);
    expect(new Set(seen).size).toBe(seen.length);
  });

  it('returns zero articles with the full deferred list when the budget is under the first article', async () => {
    const specs = [
      { pmid: '111', abstract: 'A'.repeat(400) },
      { pmid: '222', abstract: 'B'.repeat(40) },
    ];
    stageArticles(specs);
    const sizes = sizesOf((await run(['111', '222'])).result);
    // 222 is the smaller record, but the cut is a prefix cut: a ceiling that
    // clears 222 alone still returns nothing, so the number the caller needs is
    // 111's — the article the response stopped at.
    expect(sizes[1]).toBeLessThan(sizes[0] ?? 0);

    stageArticles(specs);
    const { result, ctx } = await run(['111', '222'], { maxResponseCharacters: sizes[1] });

    expect(result.articles).toEqual([]);
    expect(result.totalReturned).toBe(0);
    expect(result.deferred).toEqual({
      maxResponseCharacters: sizes[1],
      returnedCharacters: 0,
      deferredCount: 2,
      ids: ['111', '222'],
      nextDeferredCharacters: sizes[0],
    });
    const notice = getEnrichment(ctx).notice ?? '';
    expect(notice).toContain(String(sizes[0]));
    // 222 alone fits this ceiling, so "no article fits" would be false.
    expect(notice).toContain(
      `The first article alone exceeds the requested maxResponseCharacters of ${sizes[1]}, so none were returned.`,
    );
    expect(notice).not.toMatch(/no article fits/i);
    // The empty-result guidance is about invalid PMIDs — it must not fire here.
    expect(notice).not.toMatch(/may be invalid/i);
    expect(getEnrichment(ctx).truncated).toBe(true);
  });

  it('renders the same deferral state in content[] that structuredContent carries', async () => {
    const specs = [
      { pmid: '111', abstract: 'A'.repeat(40) },
      { pmid: '222', abstract: 'B'.repeat(40) },
    ];
    stageArticles(specs);
    const sizes = sizesOf((await run(['111', '222'])).result);

    stageArticles(specs);
    const { result } = await run(['111', '222'], { maxResponseCharacters: sizes[0] });
    const text = textBlocks(fetchArticlesTool.format!(result))[0]?.text ?? '';

    expect(text).toContain('**Articles Returned:** 1');
    expect(text).toContain(`${result.deferred?.deferredCount} article(s)`);
    expect(text).toContain(String(result.deferred?.returnedCharacters));
    expect(text).toContain(String(result.deferred?.maxResponseCharacters));
    expect(text).toContain(String(result.deferred?.nextDeferredCharacters));
    expect(text).toContain('222');
    expect(text).not.toContain('B'.repeat(40));
  });

  it('never lists a record with no PMID as deferrable, and counts what it lists', async () => {
    // A record NCBI returned without a parseable PMID is already reported in
    // `unavailablePmids`; it is not something a caller can re-request, so it
    // must not reach `deferred.ids` — and `deferredCount` must match the list
    // it ships rather than the raw number of withheld records.
    const staged = () =>
      mockEFetch.mockResolvedValue({
        PubmedArticleSet: {
          PubmedArticle: [
            {
              MedlineCitation: {
                PMID: { '#text': '111' },
                Article: { ArticleTitle: { '#text': 'Article 111' } },
              },
            },
            // No PMID node at all — `parseFullArticle` falls back to ''.
            { MedlineCitation: { Article: { ArticleTitle: { '#text': 'Nameless' } } } },
          ],
        },
      });

    staged();
    const sizes = sizesOf((await run(['111', '222'])).result);

    staged();
    const { result } = await run(['111', '222'], { maxResponseCharacters: sizes[0] });

    expect(result.totalReturned).toBe(1);
    expect(result.unavailablePmids).toEqual(['222']);
    expect(result.deferred?.ids).toEqual([]);
    expect(result.deferred?.deferredCount).toBe(0);
    expect(result.deferred?.deferredCount).toBe(result.deferred?.ids.length);

    const text = textBlocks(fetchArticlesTool.format!(result))[0]?.text ?? '';
    expect(text).toContain('**Deferred by the response budget:** 0 article(s)');
  });

  it('reports no deferral when the budget is set but nothing resolved', async () => {
    mockEFetch.mockResolvedValue({ PubmedArticleSet: null });

    const { result, ctx } = await run(['99999'], { maxResponseCharacters: 10 });

    expect(result.articles).toEqual([]);
    expect(result.deferred).toBeUndefined();
    expect(getEnrichment(ctx).notice).toMatch(/no articles were returned/i);
    expect(getEnrichment(ctx).truncated).toBeUndefined();
  });

  it('rejects a zero, negative, or fractional maxResponseCharacters', () => {
    for (const value of [0, -1, 1.5]) {
      expect(
        fetchArticlesTool.input.safeParse({ pmids: ['111'], maxResponseCharacters: value }).success,
      ).toBe(false);
    }
    expect(
      fetchArticlesTool.input.safeParse({ pmids: ['111'], maxResponseCharacters: 1 }).success,
    ).toBe(true);
  });
});

describe('fetchArticlesTool Bookshelf records (issue #114)', () => {
  beforeEach(() => {
    mockEFetch.mockReset();
  });

  /** Stage an EFetch body parsed through the production response handler. */
  function stageSet(...records: string[]) {
    mockEFetch.mockResolvedValue({
      PubmedArticleSet: parseArticleSetXml(articleSetXml(...records)),
    });
  }

  const run = async (pmids: string[], extra: Record<string, unknown> = {}) => {
    const ctx = createMockContext({ errors: fetchArticlesTool.errors });
    const input = fetchArticlesTool.input.parse({ pmids, ...extra });
    return { result: await fetchArticlesTool.handler(input, ctx), ctx };
  };

  const render = (result: Parameters<NonNullable<typeof fetchArticlesTool.format>>[0]) =>
    textBlocks(fetchArticlesTool.format!(result))[0]?.text ?? '';

  it('returns a record for every Bookshelf PMID instead of reporting them unavailable', async () => {
    stageSet(GENEREVIEWS_CHAPTER_XML, STATPEARLS_CHAPTER_XML);

    const { result } = await run(['20301425', '29262038']);

    expect(result.unavailablePmids).toBeUndefined();
    expect(result.totalReturned).toBe(2);
    expect(result.articles.map((a) => a.pmid)).toEqual(['20301425', '29262038']);
  });

  it('carries recordType, book metadata and an absent journalInfo across a mixed set', async () => {
    stageSet(JOURNAL_ARTICLE_XML, GENEREVIEWS_CHAPTER_XML, ADA_WHOLE_BOOK_XML);

    const { result } = await run(['42474064', '20301425', '42715368']);

    expect(result.totalReturned).toBe(3);
    expect(result.unavailablePmids).toBeUndefined();
    expect(result.articles.map((a) => [a.pmid, a.recordType])).toEqual([
      ['42474064', 'journal-article'],
      ['20301425', 'book-chapter'],
      ['42715368', 'book'],
    ]);

    const [journal, chapter, book] = result.articles;
    expect(journal?.journalInfo?.title).toBe('Health technology assessment (Winchester, England)');
    expect(journal?.book).toBeUndefined();

    // A book record carries no journal — the book title is never promoted into one.
    expect(chapter?.journalInfo).toBeUndefined();
    expect(book?.journalInfo).toBeUndefined();

    expect(chapter?.title).toBe('BRCA1- and BRCA2-Associated Hereditary Breast and Ovarian Cancer');
    expect(chapter?.book).toMatchObject({
      title: 'GeneReviews®',
      publisher: 'University of Washington, Seattle',
      publisherLocation: 'Seattle (WA)',
      pubDate: '1993',
      beginningDate: '1993',
      endingDate: '2026',
      medium: 'Internet',
      accession: 'NBK1247',
    });
    // Chapter authors stay in `authors`; the series editors stay in `book.editors`.
    expect(chapter?.authors?.map((au) => au.lastName)).toEqual(['Petrucelli', 'Daly', 'Pal']);
    expect(chapter?.book?.editors?.map((ed) => ed.lastName)).toEqual([
      'Adam',
      'Bick',
      'Mirzaa',
      'Wallace',
      'Amemiya',
    ]);

    expect(book?.book).toMatchObject({
      collectionTitle: 'ADA Clinical Compendia Series',
      doi: '10.2337/db20261',
      accession: 'NBK624619',
    });
  });

  it('renders the book venue in content[] for every record kind', async () => {
    stageSet(JOURNAL_ARTICLE_XML, GENEREVIEWS_CHAPTER_XML, NAP_WHOLE_BOOK_XML);

    const { result } = await run(['42474064', '20301425', '42691195']);
    const text = render(result);

    expect(text).toContain('**Record Type:** journal-article');
    expect(text).toContain('**Record Type:** book-chapter');
    expect(text).toContain('**Record Type:** book');

    // Chapter — containing book, its medium, editors, imprint, date range, permalink.
    expect(text).toContain('**Book:** GeneReviews® [Internet]');
    expect(text).toContain('**Editors (5):**');
    expect(text).toContain('- Margaret P Adam (MP)');
    expect(text).toContain('**Publisher:** University of Washington, Seattle');
    expect(text).toContain('**Publisher Location:** Seattle (WA)');
    expect(text).toContain('**Published:** 1993–2026');
    expect(text).toContain('**Bookshelf:** https://www.ncbi.nlm.nih.gov/books/NBK1247/');

    // Whole book — both ISBNs, the series, the book DOI.
    expect(text).toContain('**ISBN:** 9780309605397, 0309605393');
    expect(text).toContain(
      '**Collection:** The National Academies Collection: Reports funded by National Institutes of Health',
    );
    expect(text).toContain('**Book DOI:** 10.17226/29416');

    // A book record never renders a journal line.
    const journalLines = text.split('\n').filter((line) => line.startsWith('**Journal:**'));
    expect(journalLines).toHaveLength(1);
  });

  it('renders a whole-book title once — as the heading, not again as the book line', async () => {
    stageSet(ADA_WHOLE_BOOK_XML);

    const { result } = await run(['42715368']);
    const text = render(result);
    const title =
      'A Practical Guide to Hypoglycemia: New Approaches to Overcoming a Persistent Barrier to Optimal Glycemic Management';

    expect(result.articles[0]?.title).toBe(title);
    expect(result.articles[0]?.book?.title).toBe(title);
    expect(text.split(title)).toHaveLength(2);
    expect(text).not.toContain('**Book:**');
  });

  it('reports a chapter that credits neither authors nor editors without inventing either', async () => {
    stageSet(LACTMED_CHAPTER_XML);

    const { result } = await run(['29999637']);
    const text = render(result);

    expect(result.articles[0]?.authors).toEqual([]);
    expect(result.articles[0]?.book?.editors).toBeUndefined();
    expect(text).not.toContain('**Editors');
    expect(text).not.toContain('**Authors');
    // LactMed begins in 2006 and is still updated, so the range stays open. (#189)
    expect(text).toContain('**Published:** 2006–\n');
  });

  it('zero-pads numeric Article Dates parts in content[] only', async () => {
    // The XML parser reads `<Month>07</Month>` as the number 7, and Bookshelf
    // writes `<Month>7</Month>` outright; structuredContent keeps that value.
    stageSet(
      ENDOTEXT_CHAPTER_XML,
      JOURNAL_ARTICLE_XML.replace(
        '<Pagination>',
        '<ArticleDate DateType="Electronic"><Year>2026</Year><Month>07</Month><Day>03</Day></ArticleDate><Pagination>',
      ),
    );
    const { result } = await run(['25905212', '42474064']);

    expect(result.articles[0]?.articleDates?.[0]).toMatchObject({ month: '7', day: '3' });
    expect(result.articles[1]?.articleDates?.[0]).toMatchObject({ month: '7', day: '3' });
    const text = render(result);
    expect(text).toContain('**Article Dates:** ContributionDate 2025-07-03\n');
    expect(text).toContain('**Article Dates:** Electronic 2026-07-03\n');
  });

  describe('book date line (#189)', () => {
    const publishedLine = (text: string) =>
      text.split('\n').find((line) => line.startsWith('**Published:**'));

    it('writes an open-ended book as its start year and a dash', async () => {
      stageSet(ENDOTEXT_CHAPTER_XML);
      const { result } = await run(['25905212']);

      expect(result.articles[0]?.book).toMatchObject({ pubDate: '2000', beginningDate: '2000' });
      expect(result.articles[0]?.book?.endingDate).toBeUndefined();
      expect(publishedLine(render(result))).toBe('**Published:** 2000–');
    });

    it('keeps a closed range and a single publication year as they were', async () => {
      stageSet(GENEREVIEWS_ALZHEIMER_CHAPTER_XML, NICE_WHOLE_BOOK_XML);
      const { result } = await run(['20301340', '40825089']);
      const [chapter, book] = render(result).split('**Record Type:**');

      expect(publishedLine(chapter ?? '')).toBe('**Published:** 1993–2026');
      expect(publishedLine(book ?? '')).toBe('**Published:** 2025');
    });

    it('keeps a publication year that differs from an open range beside it', async () => {
      stageSet(
        ENDOTEXT_CHAPTER_XML.replace(
          '<PubDate><Year>2000</Year></PubDate>',
          '<PubDate><Year>2026</Year></PubDate>',
        ),
      );
      const { result } = await run(['25905212']);

      expect(publishedLine(render(result))).toBe('**Published:** 2026 (2000–)');
    });

    it('lists the chapter dates beside the book date', async () => {
      stageSet(GENEREVIEWS_ALZHEIMER_CHAPTER_XML);
      const { result } = await run(['20301340']);

      expect(render(result)).toContain(
        '**Article Dates:** ContributionDate 1998-10-23; DateRevised 2018-12-20',
      );
    });

    it("describes articleDates as a Bookshelf record's own ContributionDate and DateRevised", () => {
      const schema = z.toJSONSchema(fetchArticlesTool.output) as unknown as {
        properties: {
          articles: { items: { properties: { articleDates: { description?: string } } } };
        };
      };
      const description = schema.properties.articles.items.properties.articleDates.description;
      expect(description).toContain('`ContributionDate`');
      expect(description).toContain('`DateRevised`');
      expect(description).toContain('Bookshelf');
    });
  });

  it('parses a single-book response that arrives as a scalar rather than an array', async () => {
    const set = parseArticleSetXml(articleSetXml(STATPEARLS_CHAPTER_XML));
    const single = Array.isArray(set.PubmedBookArticle)
      ? set.PubmedBookArticle[0]
      : set.PubmedBookArticle;
    mockEFetch.mockResolvedValue({ PubmedArticleSet: { PubmedBookArticle: single } });

    const { result } = await run(['29262038']);

    expect(result.totalReturned).toBe(1);
    expect(result.articles[0]?.recordType).toBe('book-chapter');
    expect(result.articles[0]?.book?.title).toBe('StatPearls');
  });

  it('defers a book record whole under the response budget and lists it for re-request', async () => {
    stageSet(STATPEARLS_CHAPTER_XML, NAP_WHOLE_BOOK_XML);

    const baseline = (await run(['29262038', '42691195'])).result;
    const firstSize = JSON.stringify(baseline.articles[0]).length;

    const { result, ctx } = await run(['29262038', '42691195'], {
      maxResponseCharacters: firstSize,
    });

    expect(result.totalReturned).toBe(1);
    expect(result.articles[0]?.pmid).toBe('29262038');
    expect(result.deferred?.ids).toEqual(['42691195']);
    expect(result.deferred?.deferredCount).toBe(1);
    expect(result.unavailablePmids).toBeUndefined();
    expect(getEnrichment(ctx).truncated).toBe(true);
    expect(render(result)).toContain('Re-call `pubmed_fetch_articles` with these PMIDs: 42691195');
  });

  it('states only that PubMed returned no record when a batch resolves nothing', async () => {
    stageSet();

    const { result, ctx } = await run(['99999999']);

    expect(result.articles).toEqual([]);
    expect(result.unavailablePmids).toEqual(['99999999']);
    const notice = getEnrichment(ctx).notice ?? '';
    expect(notice).toContain('pubmed_search_articles');
    expect(notice).not.toMatch(/invalid, unpublished, or withdrawn/i);
  });
});

describe('fetchArticlesTool comments and corrections (issue #178)', () => {
  beforeEach(() => {
    mockEFetch.mockReset();
  });

  /** Stage an EFetch body parsed through the production response handler. */
  function stageSet(...records: string[]) {
    mockEFetch.mockResolvedValue({
      PubmedArticleSet: parseArticleSetXml(articleSetXml(...records)),
    });
  }

  interface ArticleOut {
    commentsCorrections?: { note?: string; pmid?: string; refSource: string; refType: string }[];
    pmid?: string;
    publicationTypes?: string[];
  }

  /** Call through the contract boundary: output validation, format(), both surfaces. */
  async function call(pmids: string[], extra: Record<string, unknown> = {}) {
    const result = await runToolContract(fetchArticlesTool, { pmids, ...extra });
    expect(result.isError).toBeFalsy();
    const structured = result.structuredContent as {
      articles: ArticleOut[];
      deferred?: { ids: string[]; maxResponseCharacters: number; returnedCharacters: number };
    };
    const text = result.content
      .flatMap((block) => (block.type === 'text' ? [block.text] : []))
      .join('\n');
    return { structured, text };
  }

  /** The rendered comments-and-corrections block of one record, heading included. */
  const sectionOf = (text: string) => {
    const start = text.indexOf('#### Comments and Corrections');
    if (start === -1) return '';
    const end = text.indexOf('\n#### ', start + 1);
    return text.slice(start, end === -1 ? undefined : end);
  };
  const entryLines = (section: string) => section.split('\n').filter((l) => l.startsWith('- '));

  it('lists all 29 entries of PMID 9500320 on both surfaces, notices included', async () => {
    stageSet(RETRACTED_ARTICLE_XML);

    const { structured, text } = await call(['9500320']);
    const entries = structured.articles[0]?.commentsCorrections ?? [];

    expect(entries).toHaveLength(29);
    expect(entries).toContainEqual({
      refType: 'RetractionIn',
      refSource: 'Lancet. 2004 Mar 6;363(9411):750. doi: 10.1016/S0140-6736(04)15715-2.',
      pmid: '15016483',
    });
    expect(entries).toContainEqual({
      refType: 'RetractionIn',
      refSource: 'Lancet. 2010 Feb 6;375(9713):445. doi: 10.1016/S0140-6736(10)60175-4.',
      pmid: '20137807',
    });
    expect(entries).toContainEqual({
      refType: 'ExpressionOfConcernIn',
      refSource:
        'Eur J Gastroenterol Hepatol. 2011 Nov;23(11):1082. doi: 10.1097/MEG.0b013e328349d184.',
      pmid: '21971344',
    });

    const section = sectionOf(text);
    expect(section.split('\n')[0]).toBe('#### Comments and Corrections (29)');
    expect(section).toContain('`pubmed_fetch_articles`');
    const lines = entryLines(section);
    expect(lines).toHaveLength(29);
    expect(lines[0]).toBe(
      '- **CommentIn:** Lancet. 1998 Feb 28;351(9103):611-2. doi: 10.1016/S0140-6736(05)78423-3. — PMID 9500313',
    );
    expect(lines).toContain(
      '- **RetractionIn:** Lancet. 2004 Mar 6;363(9411):750. doi: 10.1016/S0140-6736(04)15715-2. — PMID 15016483',
    );
    expect(lines).toContain(
      '- **RetractionIn:** Lancet. 2010 Feb 6;375(9713):445. doi: 10.1016/S0140-6736(10)60175-4. — PMID 20137807',
    );
    expect(lines[28]).toBe(
      '- **ExpressionOfConcernIn:** Eur J Gastroenterol Hepatol. 2011 Nov;23(11):1082. doi: 10.1097/MEG.0b013e328349d184. — PMID 21971344',
    );
    // Every structured entry has its rendered line, in the same order.
    expect(lines.map((l) => l.match(/PMID (\d+)$/)?.[1])).toEqual(entries.map((e) => e.pmid));
    // The notices sit ahead of the abstract they qualify.
    expect(text.indexOf('#### Comments and Corrections')).toBeLessThan(
      text.indexOf('#### Abstract'),
    );
  });

  it('carries the decoded note without a pmid, and escapes it only in content[] (PMID 23300797)', async () => {
    stageSet(ERRATUM_NOTE_ARTICLE_XML);

    const { structured, text } = await call(['23300797']);

    expect(structured.articles[0]?.commentsCorrections).toEqual([
      {
        refType: 'ErratumIn',
        refSource:
          'PLoS One. 2013;8(6). doi:10.1371/annotation/df743c15-c50e-4d00-a24d-510e15f9a73b',
        note: 'Fuβer, Fabian [corrected to Fußer, Fabian]',
      },
    ]);
    const section = sectionOf(text);
    expect(entryLines(section)).toEqual([
      '- **ErratumIn:** PLoS One. 2013;8(6). doi:10.1371/annotation/df743c15-c50e-4d00-a24d-510e15f9a73b — Note: Fuβer, Fabian \\[corrected to Fußer, Fabian\\]',
    ]);
    // No entry links a PubMed record, so nothing points at a PMID to fetch.
    expect(section).not.toContain('PMID');
    expect(section).not.toContain('pubmed_fetch_articles');
  });

  it('renders no PubMed link for an entry without a pmid and keeps the one that has it (PMID 8643635)', async () => {
    stageSet(PUBLISHED_ERRATUM_XML);

    const { structured, text } = await call(['8643635']);
    const entries = structured.articles[0]?.commentsCorrections ?? [];

    expect(entries[0]).not.toHaveProperty('pmid');
    expect(entries[1]?.pmid).toBe('7624375');
    expect(entryLines(sectionOf(text))).toEqual([
      '- **ErratumIn:** Proc Natl Acad Sci U S A 1996 Aug 20;93(17):9302',
      '- **ErratumFor:** Proc Natl Acad Sci U S A. 1995 Jul 18;92(15):7090-4. doi: 10.1073/pnas.92.15.7090. — PMID 7624375',
    ]);
  });

  it('returns a one-element array for a one-entry list (PMID 20137807)', async () => {
    stageSet(RETRACTION_NOTICE_XML);

    const { structured, text } = await call(['20137807']);

    expect(structured.articles[0]?.commentsCorrections).toEqual([
      {
        refType: 'RetractionOf',
        refSource: 'Lancet. 1998 Feb 28;351(9103):637-41. doi: 10.1016/s0140-6736(97)11096-0.',
        pmid: '9500320',
      },
    ]);
    expect(sectionOf(text).split('\n')[0]).toBe('#### Comments and Corrections (1)');
    expect(entryLines(sectionOf(text))).toEqual([
      '- **RetractionOf:** Lancet. 1998 Feb 28;351(9103):637-41. doi: 10.1016/s0140-6736(97)11096-0. — PMID 9500320',
    ]);
  });

  it('emits no Cites entry on either surface', async () => {
    stageSet(PUBLISHED_ERRATUM_WITH_CITES_XML);

    const { structured, text } = await call(['8643635']);

    expect(structured.articles[0]?.commentsCorrections?.map((e) => e.refType)).toEqual([
      'ErratumIn',
      'ErratumFor',
    ]);
    expect(JSON.stringify(structured)).not.toContain('1111111');
    expect(text).not.toContain('Synthetic bibliography entry');
    expect(text).not.toContain('Cites');
  });

  it('omits the field and the block for a record with no list and for a Bookshelf record', async () => {
    stageSet(JOURNAL_ARTICLE_XML, GENEREVIEWS_CHAPTER_XML);

    const { structured, text } = await call(['42474064', '20301425']);

    expect(structured.articles).toHaveLength(2);
    for (const article of structured.articles) {
      expect(article).not.toHaveProperty('commentsCorrections');
    }
    expect(text).not.toContain('Comments and Corrections');
  });

  it('leaves publicationTypes exactly as NCBI supplied them on every record', async () => {
    stageSet(
      RETRACTED_ARTICLE_XML,
      ERRATUM_NOTE_ARTICLE_XML,
      PUBLISHED_ERRATUM_XML,
      RETRACTION_NOTICE_XML,
    );

    const { structured } = await call(['9500320', '23300797', '8643635', '20137807']);

    expect(structured.articles.map((a) => [a.pmid, a.publicationTypes])).toEqual([
      ['9500320', ['Journal Article', "Research Support, Non-U.S. Gov't", 'Retracted Publication']],
      ['23300797', ['Journal Article', "Research Support, Non-U.S. Gov't"]],
      ['8643635', ['Published Erratum']],
      ['20137807', ['Retraction Notice']],
    ]);
  });

  it('escapes Markdown in upstream text for content[] and leaves structuredContent verbatim', () => {
    const entry = {
      refType: 'CommentIn',
      refSource: 'J *Hostile* 2020;1:1.\n#### Injected',
      pmid: '42',
      note: 'see [here](https://evil.test) <b>now</b>',
    };
    const text =
      textBlocks(
        fetchArticlesTool.format!({
          articles: [
            {
              recordType: 'journal-article' as const,
              pmid: '1',
              commentsCorrections: [entry],
            },
          ],
          totalReturned: 1,
        }),
      )[0]?.text ?? '';

    expect(text.split('\n').filter((line) => line.startsWith('#'))).toEqual([
      '## PubMed Articles',
      '### 1',
      '#### Comments and Corrections (1)',
    ]);
    expect(entryLines(sectionOf(text))).toEqual([
      '- **CommentIn:** J \\*Hostile\\* 2020;1:1. #### Injected — PMID 42 — Note: see \\[here\\](https://evil.test) \\<b>now\\</b>',
    ]);
    // format() never writes back into the structured record.
    expect(entry.refSource).toBe('J *Hostile* 2020;1:1.\n#### Injected');
  });

  describe('under maxResponseCharacters', () => {
    const sizeOf = (article: ArticleOut) => JSON.stringify(article).length;

    it('counts the field in the record size the budget spends', async () => {
      stageSet(RETRACTED_ARTICLE_XML, JOURNAL_ARTICLE_XML);
      const baseline = (await call(['9500320', '42474064'])).structured.articles;
      const heavy = baseline[0] as ArticleOut;
      const { commentsCorrections, ...withoutField } = heavy;
      expect(commentsCorrections).toHaveLength(29);
      const fullSize = sizeOf(heavy);
      const sizeWithoutField = sizeOf(withoutField);
      expect(fullSize).toBeGreaterThan(sizeWithoutField);

      // A ceiling that would fit the record only if the field were not counted defers it.
      stageSet(RETRACTED_ARTICLE_XML, JOURNAL_ARTICLE_XML);
      const cut = (await call(['9500320', '42474064'], { maxResponseCharacters: sizeWithoutField }))
        .structured;
      expect(cut.articles).toEqual([]);
      expect(cut.deferred?.ids).toEqual(['9500320', '42474064']);

      // The full record size, field included, is exactly what keeps it.
      stageSet(RETRACTED_ARTICLE_XML, JOURNAL_ARTICLE_XML);
      const kept = (await call(['9500320', '42474064'], { maxResponseCharacters: fullSize }))
        .structured;
      expect(kept.articles.map((a) => a.pmid)).toEqual(['9500320']);
      expect(kept.articles[0]?.commentsCorrections).toHaveLength(29);
      expect(kept.deferred?.returnedCharacters).toBe(fullSize);
      expect(kept.deferred?.returnedCharacters).toBeLessThanOrEqual(
        kept.deferred?.maxResponseCharacters ?? 0,
      );
      expect(kept.deferred?.ids).toEqual(['42474064']);
    });
  });
});
