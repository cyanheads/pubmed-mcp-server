/**
 * @fileoverview Tests for the format-citations tool.
 * @module tests/mcp-server/tools/definitions/format-citations.tool.test
 */

import type { ContentBlock } from '@cyanheads/mcp-ts-core';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { toJSONSchema } from 'zod/v4/core';

import { textBlocks } from '../../../_helpers.js';

const CITATION_STYLES = ['apa', 'mla', 'bibtex', 'ris', 'vancouver'] as const;

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
    expect(input.format).toBe('apa');
  });

  it('accepts a single format as a string', () => {
    const input = formatCitationsTool.input.parse({ pmids: ['12345'], format: 'bibtex' });
    expect(input.format).toBe('bibtex');
  });

  it('accepts multiple formats as an array', () => {
    const input = formatCitationsTool.input.parse({
      pmids: ['12345'],
      format: ['apa', 'mla'],
    });
    expect(input.format).toEqual(['apa', 'mla']);
  });

  it('rejects empty format array', () => {
    expect(() => formatCitationsTool.input.parse({ pmids: ['12345'], format: [] })).toThrow();
  });

  it('rejects unknown format strings', () => {
    expect(() =>
      formatCitationsTool.input.parse({ pmids: ['12345'], format: 'chicago' }),
    ).toThrow();
  });

  it('names every accepted format in content[] when the value is invalid (issue #109)', async () => {
    const result = await runToolContract(formatCitationsTool, {
      pmids: ['23193287'],
      format: 'chicago',
    } as never);

    expect(result.isError).toBe(true);
    const text = textBlocks(result.content as ContentBlock[])
      .map((b) => b.text)
      .join('\n');
    for (const style of CITATION_STYLES) expect(text).toContain(`"${style}"`);
    // The union collapse hid the accepted values behind a bare "Invalid input".
    expect(text).not.toMatch(/Invalid input at format/);
    expect(text).toContain('Invalid option: expected one of');
  });

  it('keeps the min-items message for an empty array (issue #109)', async () => {
    // The array branch is type-compatible, so Zod reports that branch's own
    // length failure rather than the union error — a value list would add
    // nothing to "needs at least one entry".
    const result = await runToolContract(formatCitationsTool, {
      pmids: ['23193287'],
      format: [],
    } as never);

    expect(result.isError).toBe(true);
    const text = textBlocks(result.content as ContentBlock[])
      .map((b) => b.text)
      .join('\n');
    expect(text).toContain('at format');
    expect(text).toMatch(/>=\s*1 items/);
  });

  it('keeps the structured issue path on format for an invalid value (issue #109)', async () => {
    const result = await runToolContract(formatCitationsTool, {
      pmids: ['23193287'],
      format: 'chicago',
    } as never);

    const issues = (
      result.structuredContent as {
        error?: { data?: { issues?: { path?: unknown[]; message?: string }[] } };
      }
    )?.error?.data?.issues;
    expect(issues?.[0]?.path).toEqual(['format']);
    expect(issues?.[0]?.message).toContain('vancouver');
  });

  it('advertises the same inputSchema for format — bare string or array (issue #109)', () => {
    const emitted = toJSONSchema(formatCitationsTool.input as never, {
      target: 'draft-7',
      io: 'input',
    }) as { properties?: Record<string, Record<string, unknown>> };
    const format = emitted.properties?.format;

    expect(format?.default).toBe('apa');
    const branches = format?.anyOf as { type?: string; items?: { enum?: string[] } }[] | undefined;
    expect(branches).toHaveLength(2);
    expect(branches?.[0]).toMatchObject({ type: 'string', enum: [...CITATION_STYLES] });
    expect(branches?.[1]).toMatchObject({
      type: 'array',
      minItems: 1,
      items: { type: 'string', enum: [...CITATION_STYLES] },
    });
  });

  it('serves a bare string and a one-element array identically end to end (issue #109)', async () => {
    const payload = {
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
    };

    mockEFetch.mockResolvedValue(payload);
    const bare = await runToolContract(formatCitationsTool, { pmids: ['12345'], format: 'mla' });
    mockEFetch.mockResolvedValue(payload);
    const wrapped = await runToolContract(formatCitationsTool, {
      pmids: ['12345'],
      format: ['mla'],
    });

    expect(bare.isError).toBeFalsy();
    expect(bare.structuredContent).toEqual(wrapped.structuredContent);
    expect(bare.content).toEqual(wrapped.content);
    expect(
      (bare.structuredContent as { citations?: { citations?: Record<string, string> }[] })
        ?.citations?.[0]?.citations,
    ).toHaveProperty('mla');
    expect(
      textBlocks(bare.content as ContentBlock[])
        .map((b) => b.text)
        .join('\n'),
    ).toContain('### MLA');
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

  it('returns structured empty result when no articles match (no throw)', async () => {
    mockEFetch.mockResolvedValue({ PubmedArticleSet: { PubmedArticle: [] } });
    const ctx = createMockContext({ errors: formatCitationsTool.errors });
    const input = formatCitationsTool.input.parse({ pmids: ['99999'] });

    const result = await formatCitationsTool.handler(input, ctx);

    expect(result.citations).toEqual([]);
    expect(result.totalFormatted).toBe(0);
    expect(result.totalSubmitted).toBe(1);
    expect(result.unavailablePmids).toEqual(['99999']);
    // Empty-result recovery hint surfaced via ctx.enrich.notice → structuredContent + content[] (issue #59)
    const enrichment = getEnrichment(ctx);
    expect(enrichment.notice).toMatch(/no articles were returned/i);
    expect(enrichment.notice).toContain('pubmed_search_articles');
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

    const ctx = createMockContext({ errors: formatCitationsTool.errors });
    const input = formatCitationsTool.input.parse({
      pmids: ['12345'],
      format: ['apa', 'bibtex'],
    });
    const result = await formatCitationsTool.handler(input, ctx);

    expect(result.citations).toHaveLength(1);
    expect(result.citations[0]?.pmid).toBe('12345');
    expect(result.citations[0]?.citations).toHaveProperty('apa');
    expect(result.citations[0]?.citations).toHaveProperty('bibtex');
    expect(result.citations[0]?.citations.apa).toContain('Smith');
    expect(result.totalSubmitted).toBe(1);
    expect(result.totalFormatted).toBe(1);
    // notice is absent when at least one citation was produced (issue #59)
    expect(getEnrichment(ctx).notice).toBeUndefined();
  });

  it('generates a Vancouver citation for a found article (issue #61)', async () => {
    mockEFetch.mockResolvedValue({
      PubmedArticleSet: {
        PubmedArticle: [
          {
            MedlineCitation: {
              PMID: { '#text': '34265844' },
              Article: {
                ArticleTitle: { '#text': 'Highly accurate protein structure prediction' },
                AuthorList: {
                  Author: [
                    {
                      LastName: { '#text': 'Jumper' },
                      ForeName: { '#text': 'John' },
                      Initials: { '#text': 'J' },
                    },
                  ],
                },
                Journal: {
                  Title: { '#text': 'Nature' },
                  ISOAbbreviation: { '#text': 'Nature' },
                  JournalIssue: {
                    Volume: { '#text': '596' },
                    Issue: { '#text': '7873' },
                    PubDate: { Year: { '#text': '2021' } },
                  },
                },
                Pagination: { MedlinePgn: { '#text': '583-589' } },
                PublicationTypeList: { PublicationType: { '#text': 'Journal Article' } },
              },
            },
          },
        ],
      },
    });

    const ctx = createMockContext({ errors: formatCitationsTool.errors });
    const input = formatCitationsTool.input.parse({ pmids: ['34265844'], format: 'vancouver' });
    const result = await formatCitationsTool.handler(input, ctx);

    const vancouver = result.citations[0]?.citations.vancouver ?? '';
    expect(vancouver).toContain('Jumper J.');
    expect(vancouver).toContain('Nature. 2021;596(7873):583-589.');
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

    const ctx = createMockContext({ errors: formatCitationsTool.errors });
    const input = formatCitationsTool.input.parse({
      pmids: ['12345', '99999'],
      format: 'apa',
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

    const ctx = createMockContext({ errors: formatCitationsTool.errors });
    const input = formatCitationsTool.input.parse({
      pmids: ['24680'],
      format: ['apa', 'ris'],
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
    const blocks = textBlocks(
      formatCitationsTool.format!({
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
      }),
    );
    expect(blocks[0]?.text).toContain('PubMed Citations');
    expect(blocks[0]?.text).toContain('**Formatted:** 1/2');
    expect(blocks[0]?.text).toContain('**Unavailable PMIDs:** 99999');
    expect(blocks[0]?.text).toContain('APA');
  });

  it('renders the empty state; the recovery notice is enrichment, not format output', () => {
    const blocks = textBlocks(
      formatCitationsTool.format!({
        totalSubmitted: 1,
        totalFormatted: 0,
        unavailablePmids: ['99999'],
        citations: [],
      }),
    );

    const text = blocks[0]?.text ?? '';
    expect(text).toContain('**Formatted:** 0/1');
    expect(text).toContain('**Unavailable PMIDs:** 99999');
    // notice lives in enrichment (ctx.enrich.notice), not in format() text
    expect(text).not.toMatch(/no articles were returned/i);
  });

  it('formats BibTeX and RIS citations in fenced code blocks', () => {
    const blocks = textBlocks(
      formatCitationsTool.format!({
        totalSubmitted: 1,
        totalFormatted: 1,
        citations: [
          {
            pmid: '12345',
            citations: {
              bibtex: '@article{pmid12345}',
              ris: 'TY  - JOUR',
            },
          },
        ],
      }),
    );

    const text = blocks[0]?.text ?? '';
    expect(text).toContain('```bibtex\n@article{pmid12345}\n```');
    expect(text).toContain('```ris\nTY  - JOUR\n```');
  });
});
