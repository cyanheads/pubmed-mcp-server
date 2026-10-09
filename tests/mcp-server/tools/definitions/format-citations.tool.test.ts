/**
 * @fileoverview Tests for the format-citations tool.
 * @module tests/mcp-server/tools/definitions/format-citations.tool.test
 */

import type { ContentBlock } from '@cyanheads/mcp-ts-core';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { toJSONSchema } from 'zod/v4/core';

import { textBlocks } from '../../../_helpers.js';
import {
  ADA_WHOLE_BOOK_XML,
  articleSetXml,
  ENDOTEXT_CHAPTER_XML,
  GENEREVIEWS_ALZHEIMER_CHAPTER_XML,
  GENEREVIEWS_CHAPTER_XML,
  JOURNAL_ARTICLE_XML,
  NAP_WHOLE_BOOK_XML,
  NICE_WHOLE_BOOK_XML,
  PROBE_REPORTS_CHAPTER_XML,
  parseArticleSetXml,
  STATPEARLS_CHAPTER_XML,
} from '../../../services/ncbi/parsing/_book-fixtures.js';
import {
  ERRATUM_NOTE_ARTICLE_XML,
  RETRACTED_ARTICLE_XML,
  RETRACTION_NOTICE_XML,
} from '../../../services/ncbi/parsing/_comments-corrections-fixtures.js';

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
    expect(text).not.toMatch(/format: Invalid input/);
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
    expect(text).toMatch(/\bformat\b.*>=\s*1 items/);
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
      Object.keys(
        (bare.structuredContent as { citations?: { citations?: Record<string, string> }[] })
          ?.citations?.[0]?.citations ?? {},
      ),
    ).toEqual(['mla']);
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

    // Exactly the requested styles, each the full citation of the fetched record
    expect(result.citations).toEqual([
      {
        pmid: '12345',
        title: 'Test Article',
        citations: {
          apa: 'Smith, J. (2024). Test Article. *Nature*, *600*.',
          bibtex: [
            '@article{pmid12345,',
            '  author  = {{Smith}, J},',
            '  title   = {{Test Article}},',
            '  journal = {Nature},',
            '  year    = {2024},',
            '  volume  = {600},',
            '  pmid    = {12345}',
            '}',
          ].join('\n'),
        },
      },
    ]);
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

  it('carries an electronic article locator into every style end to end (issue #121)', async () => {
    // PMID 39060015: no Pagination element, pii locator, DOI alongside it.
    mockEFetch.mockResolvedValue({
      PubmedArticleSet: {
        PubmedArticle: [
          {
            MedlineCitation: {
              PMID: { '#text': '39060015' },
              Article: {
                ArticleTitle: { '#text': 'Benralizumab for allergic asthma.' },
                AuthorList: {
                  Author: [
                    {
                      LastName: { '#text': 'Sehmi' },
                      ForeName: { '#text': 'Roma' },
                      Initials: { '#text': 'R' },
                    },
                  ],
                },
                Journal: {
                  Title: { '#text': 'The European respiratory journal' },
                  ISOAbbreviation: { '#text': 'Eur Respir J' },
                  JournalIssue: {
                    Volume: { '#text': '64' },
                    Issue: { '#text': '3' },
                    PubDate: { Year: { '#text': '2024' }, Month: { '#text': 'Sep' } },
                  },
                },
                ELocationID: [
                  { '#text': '2400512', '@_EIdType': 'pii', '@_ValidYN': 'Y' },
                  { '#text': '10.1183/13993003.00512-2024', '@_EIdType': 'doi', '@_ValidYN': 'Y' },
                ],
                PublicationTypeList: { PublicationType: { '#text': 'Journal Article' } },
              },
            },
          },
        ],
      },
    });

    const ctx = createMockContext({ errors: formatCitationsTool.errors });
    const input = formatCitationsTool.input.parse({
      pmids: ['39060015'],
      format: ['vancouver', 'apa', 'mla', 'bibtex', 'ris'],
    });
    const result = await formatCitationsTool.handler(input, ctx);
    const citations = result.citations[0]?.citations ?? {};

    expect(citations.vancouver).toContain(
      'Eur Respir J. 2024;64(3). pii: 2400512. doi: 10.1183/13993003.00512-2024',
    );
    expect(citations.apa).toContain('*64*(3), Article 2400512.');
    expect(citations.mla).toContain('art. 2400512');
    // The tag matters as much as the value: the locator is not pagination, so
    // `eid` has to carry it while `pages` / `SP` / `EP` stay unwritten. Matching
    // the bare `{2400512}` would pass on exactly the output this forbids.
    // Field names are padded to the widest in the entry, so match the tag
    // rather than one entry's alignment.
    expect(citations.bibtex).toMatch(/eid\s+= \{2400512\}/);
    expect(citations.bibtex).not.toContain('pages');
    expect(citations.ris).toContain('C7  - 2400512');
    expect(citations.ris).not.toContain('SP  -');
    expect(citations.ris).not.toContain('EP  -');
  });

  it('cites pagination that repeats the article number as one in APA and MLA, on both surfaces (#217)', async () => {
    // The same record as a publisher that also deposits the article number as
    // pagination: MedlinePgn and the pii locator hold one value.
    mockEFetch.mockResolvedValue({
      PubmedArticleSet: {
        PubmedArticle: [
          {
            MedlineCitation: {
              PMID: { '#text': '39060015' },
              Article: {
                ArticleTitle: { '#text': 'Benralizumab for allergic asthma.' },
                AuthorList: {
                  Author: [
                    {
                      LastName: { '#text': 'Sehmi' },
                      ForeName: { '#text': 'Roma' },
                      Initials: { '#text': 'R' },
                    },
                  ],
                },
                Journal: {
                  Title: { '#text': 'The European respiratory journal' },
                  ISOAbbreviation: { '#text': 'Eur Respir J' },
                  JournalIssue: {
                    Volume: { '#text': '64' },
                    Issue: { '#text': '3' },
                    PubDate: { Year: { '#text': '2024' }, Month: { '#text': 'Sep' } },
                  },
                },
                Pagination: { MedlinePgn: { '#text': '2400512' } },
                ELocationID: [
                  { '#text': '2400512', '@_EIdType': 'pii', '@_ValidYN': 'Y' },
                  { '#text': '10.1183/13993003.00512-2024', '@_EIdType': 'doi', '@_ValidYN': 'Y' },
                ],
                PublicationTypeList: { PublicationType: { '#text': 'Journal Article' } },
              },
            },
          },
        ],
      },
    });

    const result = await runToolContract(formatCitationsTool, {
      pmids: ['39060015'],
      format: [...CITATION_STYLES],
    });
    const citations =
      (result.structuredContent as { citations: { citations: Record<string, string> }[] })
        .citations[0]?.citations ?? {};

    expect(citations.apa).toContain(
      '*The European Respiratory Journal*, *64*(3), Article 2400512. https://doi.org/',
    );
    expect(citations.mla).toContain(
      '*The European Respiratory Journal*, vol. 64, no. 3, 2024, art. 2400512. https://doi.org/',
    );
    // Vancouver, BibTeX, and RIS print it once, as the pagination NLM gives
    expect(citations.vancouver).toContain(
      'Eur Respir J. 2024;64(3):2400512. doi: 10.1183/13993003.00512-2024',
    );
    expect(citations.vancouver).not.toContain('pii:');
    expect(citations.bibtex).toMatch(/pages\s+= \{2400512\}/);
    expect(citations.bibtex).not.toMatch(/eid\s+=/);
    expect(citations.ris).toContain('SP  - 2400512');
    expect(citations.ris).not.toContain('C7  -');

    const rendered = textBlocks(result.content as ContentBlock[])
      .map((b) => b.text)
      .join('\n');
    for (const style of CITATION_STYLES) expect(rendered, style).toContain(citations[style]);
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
    expect(blocks[0]?.text).toContain('## PMID 12345\n**Test**\n\n### APA\nSmith (2024). Test.');
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

describe('formatCitationsTool Bookshelf records (issue #114)', () => {
  beforeEach(() => {
    mockEFetch.mockReset();
  });

  /** Stage an EFetch body parsed through the production response handler. */
  function stageSet(...records: string[]) {
    mockEFetch.mockResolvedValue({
      PubmedArticleSet: parseArticleSetXml(articleSetXml(...records)),
    });
  }

  const cite = async (pmids: string[]) => {
    const ctx = createMockContext({ errors: formatCitationsTool.errors });
    const input = formatCitationsTool.input.parse({ pmids, format: [...CITATION_STYLES] });
    return { result: await formatCitationsTool.handler(input, ctx), ctx };
  };

  it('cites a Bookshelf chapter in all five styles', async () => {
    stageSet(GENEREVIEWS_CHAPTER_XML);

    const { result } = await cite(['20301425']);

    expect(result.totalFormatted).toBe(1);
    expect(result.unavailablePmids).toBeUndefined();
    const entry = result.citations[0];
    expect(entry?.pmid).toBe('20301425');
    expect(Object.keys(entry?.citations ?? {})).toEqual([...CITATION_STYLES]);

    // Dated by the chapter's own DateRevised (2026-03-25), not the book's 1993 start. (#189)
    expect(entry?.citations.apa).toBe(
      'Petrucelli, N., Daly, M. B., & Pal, T. (2026). ' +
        'BRCA1- and BRCA2-Associated Hereditary Breast and Ovarian Cancer. ' +
        'In M. P. Adam, S. Bick, G. M. Mirzaa, S. E. Wallace, & A. Amemiya (Eds.), *GeneReviews®*. ' +
        'University of Washington, Seattle. https://www.ncbi.nlm.nih.gov/books/NBK1247/',
    );
    expect(entry?.citations.mla).toBe(
      'Petrucelli, Nancie, et al. "BRCA1- and BRCA2-Associated Hereditary Breast and Ovarian Cancer." ' +
        '*GeneReviews®*, edited by Margaret P Adam, et al., University of Washington, Seattle, 25 Mar. 2026.',
    );
    expect(entry?.citations.vancouver).toBe(
      'Petrucelli N, Daly MB, Pal T. BRCA1- and BRCA2-Associated Hereditary Breast and Ovarian Cancer. ' +
        '1998 Sep 4 [updated 2026 Mar 25]. ' +
        'In: Adam MP, Bick S, Mirzaa GM, Wallace SE, Amemiya A, editors. GeneReviews® [Internet]. ' +
        'Seattle (WA): University of Washington, Seattle; 1993-2026. ' +
        'Available from: https://www.ncbi.nlm.nih.gov/books/NBK1247/',
    );
    expect(entry?.citations.bibtex).toContain('@incollection{pmid20301425,');
    expect(entry?.citations.bibtex).toContain('booktitle = {GeneReviews®}');
    expect(entry?.citations.ris).toContain('TY  - CHAP');
    expect(entry?.citations.ris).toContain('BT  - GeneReviews®');
    expect(entry?.citations.ris).toContain('A2  - Adam, Margaret P');
  });

  it('cites a whole Bookshelf book in all five styles', async () => {
    stageSet(NAP_WHOLE_BOOK_XML);

    const { result } = await cite(['42691195']);
    const entry = result.citations[0];
    const collective =
      'National Academies of Sciences, Engineering, and Medicine; Center for Advancing Science ' +
      'and Technology; Science and Technology Policy and Law Program Area';
    const title =
      'AI Infrastructure to Accelerate AI Convergence and Catalyze U.S. Scientific Innovation: ' +
      'Proceedings of a Workshop—in Brief';

    expect(entry?.title).toBe(title);
    expect(entry?.citations.apa).toBe(
      `${collective}. (2026). *${title}*. National Academies Press (US). https://doi.org/10.17226/29416`,
    );
    expect(entry?.citations.mla).toBe(
      `${collective}. *${title}*, National Academies Press (US), 2026.`,
    );
    expect(entry?.citations.vancouver).toBe(
      `${collective}. ${title}. Washington (DC): National Academies Press (US); 2026. ` +
        'Available from: https://www.ncbi.nlm.nih.gov/books/NBK624538/',
    );
    expect(entry?.citations.bibtex).toContain('@book{pmid42691195,');
    expect(entry?.citations.bibtex).toContain('isbn      = {9780309605397, 0309605393}');
    expect(entry?.citations.ris).toContain('TY  - BOOK');
    expect(entry?.citations.ris).toContain('SN  - 0309605393');
  });

  it('opens an authorless APA citation on the title on both surfaces (#139)', async () => {
    // PMID 42715368 — a whole book crediting neither authors nor editors. APA 7
    // §9.12 moves the title into the author position; the reference must not
    // start on the year on either surface a client may read.
    const expected =
      'A Practical Guide to Hypoglycemia: New Approaches to Overcoming a Persistent Barrier ' +
      'to Optimal Glycemic Management. (2026). American Diabetes Association. ' +
      'https://doi.org/10.2337/db20261';

    mockEFetch.mockResolvedValue({
      PubmedArticleSet: parseArticleSetXml(articleSetXml(ADA_WHOLE_BOOK_XML)),
    });
    const result = await runToolContract(formatCitationsTool, {
      pmids: ['42715368'],
      format: 'apa',
    });

    const structured = result.structuredContent as {
      citations?: { citations?: Record<string, string> }[];
    };
    expect(structured.citations?.[0]?.citations?.apa).toBe(expected);

    const rendered = textBlocks(result.content as ContentBlock[])
      .map((b) => b.text)
      .join('\n');
    expect(rendered).toContain(expected);
    expect(rendered).not.toContain('(2026). *A Practical Guide');
  });

  it('dates each chapter by its own date on both surfaces (#189)', async () => {
    // Real records for the issue's four PMIDs: a revised GeneReviews chapter, an
    // Endotext chapter in an open-ended book, a Probe Report contributed before
    // its book began, and a whole book.
    stageSet(
      GENEREVIEWS_ALZHEIMER_CHAPTER_XML,
      ENDOTEXT_CHAPTER_XML,
      PROBE_REPORTS_CHAPTER_XML,
      NICE_WHOLE_BOOK_XML,
    );
    const result = await runToolContract(formatCitationsTool, {
      pmids: ['20301340', '25905212', '21634080', '40825089'],
      format: [...CITATION_STYLES],
    });

    const structured = result.structuredContent as {
      citations: { pmid: string; citations: Record<string, string> }[];
    };
    const byPmid = Object.fromEntries(structured.citations.map((c) => [c.pmid, c.citations]));
    const alzheimer = byPmid['20301340'] ?? {};
    const endotext = byPmid['25905212'] ?? {};
    const probe = byPmid['21634080'] ?? {};
    const nice = byPmid['40825089'] ?? {};

    expect(alzheimer.apa).toContain('Bird, T. D. (2018).');
    expect(alzheimer.mla).toMatch(/University of Washington, Seattle, 20 Dec\. 2018\.$/);
    expect(alzheimer.bibtex).toMatch(/^ {2}year\s+= \{2018\},$/m);
    expect(alzheimer.ris).toContain('PY  - 2018\n');
    expect(alzheimer.ris).toContain('DA  - 2018/12/20\n');
    expect(alzheimer.vancouver).toBe(
      'Bird TD. Alzheimer Disease Overview. 1998 Oct 23 [updated 2018 Dec 20]. In: Adam MP, Bick S, ' +
        'Mirzaa GM, Wallace SE, Amemiya A, editors. GeneReviews® [Internet]. Seattle (WA): University ' +
        'of Washington, Seattle; 1993-2026. Available from: https://www.ncbi.nlm.nih.gov/books/NBK1161/',
    );

    expect(endotext.apa).toContain('(2025).');
    expect(endotext.apa).toContain('MDText.com, Inc. https://');
    expect(endotext.apa).not.toContain('Inc..');
    expect(endotext.mla).toMatch(/MDText\.com, Inc\., 3 July 2025\.$/);
    expect(endotext.ris).toContain('PY  - 2025\n');
    expect(endotext.ris).toContain('DA  - 2025/07/03\n');
    expect(endotext.vancouver).toContain(
      'Thyrotropin-Secreting Pituitary Adenomas. 2025 Jul 3. In:',
    );
    expect(endotext.vancouver).toContain('MDText.com, Inc.; 2000-.');

    expect(probe.apa).toContain('(2011).');
    expect(probe.mla).toMatch(/10 Feb\. 2011\.$/);
    expect(probe.vancouver).toContain('2009 Sep 1 [updated 2011 Feb 10]. In:');
    expect(probe.vancouver).toContain('; 2010-.');

    expect(nice.apa).toContain('(2025).');
    expect(nice.mla).toMatch(/, 2025\.$/);
    expect(nice.bibtex).toMatch(/^ {2}year\s+= \{2025\},$/m);
    expect(nice.ris).toContain('PY  - 2025\n');
    expect(nice.ris).not.toContain('DA  - ');
    expect(nice.vancouver).toContain('; 2025. Available from:');

    // content[] carries every one of those strings verbatim
    const rendered = textBlocks(result.content as ContentBlock[])
      .map((b) => b.text)
      .join('\n');
    for (const citations of [alzheimer, endotext, probe, nice]) {
      for (const style of CITATION_STYLES) {
        expect(citations[style], style).toBeTruthy();
        expect(rendered, style).toContain(citations[style]);
      }
    }
  });

  it('cites a mixed batch and reports no PMID unavailable', async () => {
    stageSet(JOURNAL_ARTICLE_XML, STATPEARLS_CHAPTER_XML, ADA_WHOLE_BOOK_XML);

    const { result } = await cite(['42474064', '29262038', '42715368']);

    expect(result.totalFormatted).toBe(3);
    expect(result.unavailablePmids).toBeUndefined();
    expect(result.citations.map((c) => c.pmid)).toEqual(['42474064', '29262038', '42715368']);
    expect(result.citations[0]?.citations.ris).toContain('TY  - JOUR');
    expect(result.citations[1]?.citations.ris).toContain('TY  - CHAP');
    expect(result.citations[2]?.citations.ris).toContain('TY  - BOOK');
  });

  it('states only that PubMed returned no record when nothing resolves', async () => {
    stageSet();

    const { result, ctx } = await cite(['99999999']);

    expect(result.citations).toEqual([]);
    expect(result.unavailablePmids).toEqual(['99999999']);
    const notice = getEnrichment(ctx).notice ?? '';
    expect(notice).toContain('pubmed_search_articles');
    expect(notice).not.toMatch(/invalid, unpublished, or withdrawn/i);
  });
});

describe('formatCitationsTool retraction and erratum notices (issue #215)', () => {
  beforeEach(() => {
    mockEFetch.mockReset();
  });

  /**
   * Real records through the production parser: 9500320 (two retractions, an
   * expression of concern, 26 comments), 23300797 (an erratum with a Note and no
   * PMID), and 20137807 (a retraction notice, linked only by `RetractionOf`).
   */
  const citeNoticeRecords = () => {
    mockEFetch.mockResolvedValue({
      PubmedArticleSet: parseArticleSetXml(
        articleSetXml(RETRACTED_ARTICLE_XML, ERRATUM_NOTE_ARTICLE_XML, RETRACTION_NOTICE_XML),
      ),
    });
    return runToolContract(formatCitationsTool, {
      pmids: ['9500320', '23300797', '20137807'],
      format: [...CITATION_STYLES],
    });
  };

  type Entry = { pmid: string; citations: Record<string, string>; notices?: unknown[] };

  /** The `## PMID` section of content[] for one record, up to its first style heading. */
  const head = (text: string, pmid: string) => {
    const start = text.indexOf(`## PMID ${pmid}\n`);
    return text.slice(start, text.indexOf('### APA', start));
  };

  it('carries the qualifying notices, in NCBI order, on structuredContent', async () => {
    const result = await citeNoticeRecords();

    expect(result.isError).toBeFalsy();
    const entries = (result.structuredContent as { citations: Entry[] }).citations;
    const byPmid = Object.fromEntries(entries.map((entry) => [entry.pmid, entry]));
    expect(byPmid['9500320']?.notices).toEqual([
      {
        refType: 'RetractionIn',
        refSource: 'Lancet. 2004 Mar 6;363(9411):750. doi: 10.1016/S0140-6736(04)15715-2.',
        pmid: '15016483',
      },
      {
        refType: 'RetractionIn',
        refSource: 'Lancet. 2010 Feb 6;375(9713):445. doi: 10.1016/S0140-6736(10)60175-4.',
        pmid: '20137807',
      },
      {
        refType: 'ExpressionOfConcernIn',
        refSource:
          'Eur J Gastroenterol Hepatol. 2011 Nov;23(11):1082. doi: 10.1097/MEG.0b013e328349d184.',
        pmid: '21971344',
      },
    ]);
    expect(byPmid['23300797']?.notices).toEqual([
      {
        refType: 'ErratumIn',
        refSource:
          'PLoS One. 2013;8(6). doi:10.1371/annotation/df743c15-c50e-4d00-a24d-510e15f9a73b',
        note: 'Fu\u{3b2}er, Fabian [corrected to Fu\u{df}er, Fabian]',
      },
    ]);
    expect(byPmid['20137807']).not.toHaveProperty('notices');
    // The declared output schema keeps the field rather than stripping it
    expect(formatCitationsTool.output.parse(result.structuredContent)).toEqual(
      result.structuredContent,
    );
  });

  it('renders the notices before the first style heading, warning first on a retraction', async () => {
    const result = await citeNoticeRecords();
    const text = textBlocks(result.content as ContentBlock[])
      .map((b) => b.text)
      .join('\n');

    expect(head(text, '9500320')).toBe(
      [
        '## PMID 9500320',
        '**Ileal-lymphoid-nodular hyperplasia, non-specific colitis, and pervasive developmental disorder in children.**',
        // A blank line, or Markdown folds the warning into the title's paragraph
        '',
        '**Retracted:** NCBI links a retraction notice to this article.',
        '- **RetractionIn:** Lancet. 2004 Mar 6;363(9411):750. doi: 10.1016/S0140-6736(04)15715-2. — PMID 15016483',
        '- **RetractionIn:** Lancet. 2010 Feb 6;375(9713):445. doi: 10.1016/S0140-6736(10)60175-4. — PMID 20137807',
        '- **ExpressionOfConcernIn:** Eur J Gastroenterol Hepatol. 2011 Nov;23(11):1082. doi: 10.1097/MEG.0b013e328349d184. — PMID 21971344',
        '',
        '',
      ].join('\n'),
    );
    // An erratum takes no warning; its Note shows here and in no citation string
    expect(head(text, '23300797')).toBe(
      [
        '## PMID 23300797',
        '**Different patterns of white matter degeneration using multiple diffusion indices and volumetric data in mild cognitive impairment and Alzheimer patients.**',
        '',
        '**Notices:**',
        '- **ErratumIn:** PLoS One. 2013;8(6). doi:10.1371/annotation/df743c15-c50e-4d00-a24d-510e15f9a73b — Note: Fu\u{3b2}er, Fabian \\[corrected to Fu\u{df}er, Fabian\\]',
        '',
        '',
      ].join('\n'),
    );
    // A record that is itself a notice keeps the section it had
    expect(head(text, '20137807')).toBe(
      '## PMID 20137807\n**Retraction--Ileal-lymphoid-nodular hyperplasia, non-specific colitis, and pervasive developmental disorder in children.**\n\n',
    );

    const entries = (result.structuredContent as { citations: Entry[] }).citations;
    for (const entry of entries) {
      for (const style of CITATION_STYLES) {
        expect(text, `${entry.pmid} ${style}`).toContain(entry.citations[style]);
        expect(entry.citations[style], `${entry.pmid} ${style}`).not.toContain('corrected to');
      }
    }
    const wakefield = entries.find((entry) => entry.pmid === '9500320')?.citations ?? {};
    expect(wakefield.vancouver).toContain(
      'doi: 10.1016/s0140-6736(97)11096-0. Retraction in: Lancet. 2004 Mar 6;363(9411):750.',
    );
    expect(wakefield.apa).toContain(
      '(Retraction published Lancet. 2004 Mar 6;363(9411):750. doi: 10.1016/S0140-6736(04)15715-2; Lancet. 2010',
    );
  });

  it('warns on a retracted-and-republished article, and not on an expression of concern', () => {
    const render = (refType: string) =>
      textBlocks(
        formatCitationsTool.format!({
          totalSubmitted: 1,
          totalFormatted: 1,
          citations: [
            {
              pmid: '1',
              title: 'T',
              citations: { apa: 'A.' },
              notices: [{ refType, refSource: 'J Test. 2025;1:2.', pmid: '2' }],
            },
          ],
        } as never),
      )[0]?.text ?? '';

    expect(render('RetractedandRepublishedIn')).toContain(
      '**Retracted:** NCBI links a retraction notice to this article.\n- **RetractedandRepublishedIn:** J Test. 2025;1:2. — PMID 2\n',
    );
    expect(render('CorrectedandRepublishedIn')).toContain(
      '**Notices:**\n- **CorrectedandRepublishedIn:** J Test. 2025;1:2. — PMID 2\n',
    );
    const concern = render('ExpressionOfConcernIn');
    expect(concern).toContain('**Notices:**\n- **ExpressionOfConcernIn:** J Test. 2025;1:2.');
    expect(concern).not.toContain('Retracted');
  });

  it('escapes Markdown in an upstream notice', () => {
    const text =
      textBlocks(
        formatCitationsTool.format!({
          totalSubmitted: 1,
          totalFormatted: 1,
          citations: [
            {
              pmid: '1',
              citations: { apa: 'A.' },
              notices: [
                { refType: 'ErratumIn', refSource: 'J *Bold* Res. 2020;1:2.', note: 'see [1]' },
              ],
            },
          ],
        }),
      )[0]?.text ?? '';
    expect(text).toContain('- **ErratumIn:** J \\*Bold\\* Res. 2020;1:2. — Note: see \\[1\\]');
  });

  it('renders a record with no notices exactly as before', () => {
    const text = textBlocks(
      formatCitationsTool.format!({
        totalSubmitted: 1,
        totalFormatted: 1,
        citations: [{ pmid: '1', title: 'T', citations: { apa: 'A.', vancouver: 'V.' } }],
      }),
    )[0]?.text;
    expect(text).toBe(
      '# PubMed Citations\n**Formatted:** 1/1\n\n## PMID 1\n**T**\n\n### APA\nA.\n\n### VANCOUVER\nV.',
    );
  });
});
