/**
 * @fileoverview Tests for the format-citations tool.
 * @module tests/mcp-server/tools/definitions/format-citations.tool.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockEFetch = vi.fn();
vi.mock('@/services/ncbi/ncbi-service.js', () => ({
  getNcbiService: () => ({ eFetch: mockEFetch }),
}));

const { formatCitationsTool } = await import(
  '@/mcp-server/tools/definitions/format-citations.tool.js'
);

describe('formatCitationsTool', () => {
  beforeEach(() => {
    mockEFetch.mockReset();
  });

  it('validates input with defaults', () => {
    const input = formatCitationsTool.input.parse({ pmids: ['12345'] });
    expect(input.styles).toEqual(['apa']);
  });

  it('rejects non-numeric PMIDs', () => {
    expect(() => formatCitationsTool.input.parse({ pmids: ['abc'] })).toThrow();
  });

  it('rejects non-numeric PMIDs with an actionable error message (issue #27)', () => {
    const parsed = formatCitationsTool.input.safeParse({ pmids: ['abc'] });
    expect(parsed.success).toBe(false);
    const message = parsed.error?.issues[0]?.message ?? '';
    expect(message).toMatch(/PMID/);
    expect(message).toMatch(/numeric/);
    expect(message).toContain('13054692');
  });

  it('throws when no articles found', async () => {
    mockEFetch.mockResolvedValue({ PubmedArticleSet: { PubmedArticle: [] } });
    const ctx = createMockContext();
    const input = formatCitationsTool.input.parse({ pmids: ['99999'] });

    await expect(formatCitationsTool.handler(input, ctx)).rejects.toThrow(/No articles found/);
  });

  it('generates citations for found articles', async () => {
    mockEFetch.mockResolvedValue({
      PubmedArticleSet: {
        PubmedArticle: [
          {
            MedlineCitation: {
              PMID: { '#text': '12345' },
              Article: {
                ArticleTitle: { '#text': 'Test Article' },
                AuthorList: {
                  Author: [
                    {
                      LastName: { '#text': 'Smith' },
                      ForeName: { '#text': 'J' },
                      Initials: { '#text': 'J' },
                    },
                  ],
                },
                Journal: {
                  Title: { '#text': 'Nature' },
                  JournalIssue: {
                    Volume: { '#text': '600' },
                    PubDate: { Year: { '#text': '2024' } },
                  },
                },
                PublicationTypeList: { PublicationType: { '#text': 'Journal Article' } },
              },
            },
          },
        ],
      },
    });

    const ctx = createMockContext();
    const input = formatCitationsTool.input.parse({
      pmids: ['12345'],
      styles: ['apa', 'bibtex'],
    });
    const result = await formatCitationsTool.handler(input, ctx);

    expect(result.citations).toHaveLength(1);
    expect(result.citations[0]?.pmid).toBe('12345');
    expect(result.citations[0]?.citations).toHaveProperty('apa');
    expect(result.citations[0]?.citations).toHaveProperty('bibtex');
    expect(result.citations[0]?.citations.apa).toContain('Smith');
    expect(result.totalSubmitted).toBe(1);
    expect(result.totalFormatted).toBe(1);
  });

  it('reports unavailable PMIDs for partial batches', async () => {
    mockEFetch.mockResolvedValue({
      PubmedArticleSet: {
        PubmedArticle: [
          {
            MedlineCitation: {
              PMID: { '#text': '12345' },
              Article: {
                ArticleTitle: { '#text': 'Test Article' },
                Journal: {
                  Title: { '#text': 'Nature' },
                  JournalIssue: {
                    Volume: { '#text': '600' },
                    PubDate: { Year: { '#text': '2024' } },
                  },
                },
                PublicationTypeList: { PublicationType: { '#text': 'Journal Article' } },
              },
            },
          },
        ],
      },
    });

    const ctx = createMockContext();
    const input = formatCitationsTool.input.parse({
      pmids: ['12345', '99999'],
      styles: ['apa'],
    });
    const result = await formatCitationsTool.handler(input, ctx);

    expect(result.totalSubmitted).toBe(2);
    expect(result.totalFormatted).toBe(1);
    expect(result.unavailablePmids).toEqual(['99999']);
  });

  it('preserves decoded Unicode metadata in generated citations', async () => {
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
              ArticleIdList: [{ '#text': '10.1000/unicode', '@_IdType': 'doi' }],
            },
          },
        ],
      },
    });

    const ctx = createMockContext();
    const input = formatCitationsTool.input.parse({
      pmids: ['24680'],
      styles: ['apa', 'ris'],
    });
    const result = await formatCitationsTool.handler(input, ctx);

    expect(result.citations[0]?.citations.apa).toContain('Garc\u00eda-L\u00f3pez, M.');
    expect(result.citations[0]?.citations.apa).toContain(
      '\u03b2-catenin in Garc\u00eda-L\u00f3pez cohorts.',
    );
    expect(result.citations[0]?.citations.apa).toContain('45\u201352');
    expect(result.citations[0]?.citations.ris).toContain('SP  - 45');
    expect(result.citations[0]?.citations.ris).toContain('EP  - 52');
  });

  it('formats output', () => {
    const blocks = formatCitationsTool.format!({
      totalSubmitted: 2,
      totalFormatted: 1,
      unavailablePmids: ['99999'],
      citations: [
        {
          pmid: '12345',
          title: 'Test',
          citations: { apa: 'Smith (2024). Test.' },
        },
      ],
    });
    expect(blocks[0]?.text).toContain('PubMed Citations');
    expect(blocks[0]?.text).toContain('**Formatted:** 1/2');
    expect(blocks[0]?.text).toContain('**Unavailable PMIDs:** 99999');
    expect(blocks[0]?.text).toContain('APA');
  });
});
