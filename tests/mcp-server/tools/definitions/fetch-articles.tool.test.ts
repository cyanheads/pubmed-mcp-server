/**
 * @fileoverview Tests for the fetch-articles tool.
 * @module tests/mcp-server/tools/definitions/fetch-articles.tool.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

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
    const ctx = createMockContext();
    const input = fetchArticlesTool.input.parse({ pmids: ['99999'] });
    const result = await fetchArticlesTool.handler(input, ctx);

    expect(result.articles).toEqual([]);
    expect(result.totalReturned).toBe(0);
    expect(result.unavailablePmids).toEqual(['99999']);
  });

  it('throws when response is missing PubmedArticleSet', async () => {
    mockEFetch.mockResolvedValue({});
    const ctx = createMockContext();
    const input = fetchArticlesTool.input.parse({ pmids: ['12345'] });

    await expect(fetchArticlesTool.handler(input, ctx)).rejects.toThrow(/missing PubmedArticleSet/);
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

    const ctx = createMockContext();
    const input = fetchArticlesTool.input.parse({ pmids: ['12345'] });
    const result = await fetchArticlesTool.handler(input, ctx);

    expect(result.totalReturned).toBe(1);
    expect(result.articles[0]?.pmid).toBe('12345');
    expect(result.articles[0]?.pubmedUrl).toContain('12345');
    expect(result.articles[0]?.pmcUrl).toContain('PMC999');
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

    const ctx = createMockContext();
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

    const ctx = createMockContext();
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

    const ctx = createMockContext();
    const input = fetchArticlesTool.input.parse({ pmids });
    const result = await fetchArticlesTool.handler(input, ctx);

    expect(mockEFetch).toHaveBeenCalledWith(
      { db: 'pubmed', id: pmids.join(','), retmode: 'xml' },
      { retmode: 'xml', usePost: true },
    );
    expect(result.totalReturned).toBe(1);
    expect(result.unavailablePmids).toHaveLength(99);
  });

  it('formats output', () => {
    const blocks = fetchArticlesTool.format!({
      articles: [
        {
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
    });
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
    expect(blocks[0]?.text).toContain('- Asthma * (therapy*)');
    expect(blocks[0]?.text).toContain('#### Grants');
    expect(blocks[0]?.text).toContain('R01');
  });

  describe('format() content completeness (issue #26)', () => {
    const richArticle = {
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
    } as const;

    it('renders every author with full firstName, initials, affiliation indices, and ORCID — no et al. truncation', () => {
      const blocks = fetchArticlesTool.format!({ articles: [richArticle], totalReturned: 1 });
      const text = blocks[0]?.text ?? '';

      expect(text).toContain('**Authors (4):**');
      expect(text).toContain('- Ayat Gamal Lashen [1, 2] · ORCID: 0000-0001-9494-7382');
      expect(text).toContain('- Michael S Toss [1]');
      expect(text).toContain('- Breast Cancer Group (collective)');
      expect(text).toContain('- Solo S');
      expect(text).not.toContain('et al.');
    });

    it('renders affiliations as a 1-based numbered list matching the author markers', () => {
      const blocks = fetchArticlesTool.format!({ articles: [richArticle], totalReturned: 1 });
      const text = blocks[0]?.text ?? '';

      expect(text).toContain('**Affiliations:**');
      expect(text).toContain('1. University of Nottingham');
      expect(text).toContain('2. Menoufia University');
    });

    it('renders the full publication date (year, month, day) when available', () => {
      const blocks = fetchArticlesTool.format!({ articles: [richArticle], totalReturned: 1 });
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
      const blocks = fetchArticlesTool.format!({ articles: [seasonal], totalReturned: 1 });
      expect(blocks[0]?.text).toContain('2000 Spring');
    });

    it('renders the electronic ISSN (preferring eIssn over issn)', () => {
      const blocks = fetchArticlesTool.format!({ articles: [richArticle], totalReturned: 1 });
      expect(blocks[0]?.text).toContain('eISSN 1472-4146');
    });

    it('falls back to print ISSN when no eIssn is present', () => {
      const printOnly = {
        ...richArticle,
        journalInfo: { ...richArticle.journalInfo, eIssn: undefined },
      };
      const blocks = fetchArticlesTool.format!({ articles: [printOnly], totalReturned: 1 });
      expect(blocks[0]?.text).toContain('ISSN 0021-9746');
      expect(blocks[0]?.text).not.toContain('eISSN');
    });

    it('renders the raw PMCID alongside the PMC URL', () => {
      const blocks = fetchArticlesTool.format!({ articles: [richArticle], totalReturned: 1 });
      expect(blocks[0]?.text).toContain('**PMCID:** PMC10000');
    });

    it('renders articleDates with their dateType', () => {
      const blocks = fetchArticlesTool.format!({ articles: [richArticle], totalReturned: 1 });
      expect(blocks[0]?.text).toContain('**Article Dates:** Electronic 2023-02-22');
    });

    it('includes the grant acronym alongside the grant ID', () => {
      const blocks = fetchArticlesTool.format!({ articles: [richArticle], totalReturned: 1 });
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
      const blocks = fetchArticlesTool.format!({ articles: [bigAuthorList], totalReturned: 1 });
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
      const blocks = fetchArticlesTool.format!({
        articles: [articleWithMeshUis],
        totalReturned: 1,
      });
      const text = blocks[0]?.text ?? '';
      expect(text).toContain('- Breast Neoplasms [D001943] * (pathology [Q000473])');
      expect(text).toContain('- Humans [D006801]');
    });
  });

  describe('format() empty-result guidance', () => {
    it('adds a hint when totalReturned is zero', () => {
      const blocks = fetchArticlesTool.format!({
        articles: [],
        totalReturned: 0,
        unavailablePmids: ['999999999'],
      });
      const text = blocks[0]?.text ?? '';
      expect(text).toContain('**Unavailable PMIDs:** 999999999');
      expect(text).toMatch(/no articles were returned/i);
      expect(text).toContain('pubmed_search_articles');
    });
  });
});
