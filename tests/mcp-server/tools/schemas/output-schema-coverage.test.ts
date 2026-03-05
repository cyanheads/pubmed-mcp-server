/**
 * @fileoverview Tests that tool output schemas cover all fields returned by
 * their logic at runtime. Catches the class of bug where a parser adds a field
 * but the Zod output schema is not updated — Zod strips the unknown field
 * (server-side validation passes), but zod-to-json-schema emits
 * `additionalProperties: false`, causing strict clients (e.g. claude.ai) to
 * reject the response.
 *
 * Strategy: build realistic tool output from the actual parsers, then validate
 * with `schema.strict().parse()` which rejects unknown keys instead of
 * stripping them.
 * @module tests/mcp-server/tools/schemas/output-schema-coverage
 */
import { describe, expect, it } from 'vitest';
import { pmcFetchTool } from '@/mcp-server/tools/definitions/pmc-fetch.tool.js';
import { pubmedFetchTool } from '@/mcp-server/tools/definitions/pubmed-fetch.tool.js';
import { parseFullArticle } from '@/services/ncbi/parsing/article-parser.js';
import { parsePmcArticle } from '@/services/ncbi/parsing/pmc-article-parser.js';
import type { XmlJatsArticle, XmlPubmedArticle } from '@/services/ncbi/types.js';

// ─── Fixtures ───────────────────────────────────────────────────────────────

/** Minimal but complete PubMed article XML structure that exercises all parser paths. */
const PUBMED_XML_FIXTURE: XmlPubmedArticle = {
  MedlineCitation: {
    PMID: { '#text': '12345678' },
    Article: {
      ArticleTitle: { '#text': 'Test Article Title' },
      Abstract: {
        AbstractText: { '#text': 'This is the abstract text.' },
      },
      AuthorList: {
        Author: [
          {
            LastName: { '#text': 'Smith' },
            ForeName: { '#text': 'John' },
            Initials: { '#text': 'J' },
            AffiliationInfo: [
              { Affiliation: { '#text': 'University of Testing, Department of Tests' } },
            ],
          },
        ],
      },
      Journal: {
        Title: { '#text': 'Journal of Testing' },
        ISOAbbreviation: { '#text': 'J Test' },
        JournalIssue: {
          Volume: { '#text': '42' },
          Issue: { '#text': '3' },
          PubDate: { Year: { '#text': '2025' }, Month: { '#text': 'Jan' } },
        },
      },
      PublicationTypeList: {
        PublicationType: [{ '#text': 'Journal Article' }],
      },
      ELocationID: { '#text': '10.1234/test.2025', '@_EIdType': 'doi', '@_ValidYN': 'Y' },
      ArticleDate: [
        {
          '@_DateType': 'Electronic',
          Year: { '#text': '2025' },
          Month: { '#text': '01' },
          Day: { '#text': '15' },
        },
      ],
      Pagination: { MedlinePgn: { '#text': '100-110' } },
      GrantList: {
        Grant: [
          {
            GrantID: { '#text': 'R01-TEST-001' },
            Agency: { '#text': 'NIH' },
            Country: { '#text': 'United States' },
          },
        ],
      },
    },
    KeywordList: {
      Keyword: [{ '#text': 'testing' }, { '#text': 'validation' }],
    },
    MeshHeadingList: {
      MeshHeading: [
        {
          DescriptorName: { '#text': 'Software Testing', '@_UI': 'D000001', '@_MajorTopicYN': 'Y' },
        },
      ],
    },
  },
  PubmedData: {
    ArticleIdList: {
      ArticleId: [
        { '#text': 'PMC9999999', '@_IdType': 'pmc' },
        { '#text': '10.1234/test.2025', '@_IdType': 'doi' },
      ],
    },
  },
};

/** Minimal PMC JATS article XML that exercises all parser paths. */
const PMC_XML_FIXTURE: XmlJatsArticle = {
  '@_article-type': 'research-article',
  front: {
    'journal-meta': {
      'journal-title-group': {
        'journal-title': { '#text': 'Journal of Testing' },
      },
      issn: { '#text': '1234-5678' },
    },
    'article-meta': {
      'article-id': [
        { '#text': 'PMC9999999', '@_pub-id-type': 'pmcid' },
        { '#text': '12345678', '@_pub-id-type': 'pmid' },
        { '#text': '10.1234/test.2025', '@_pub-id-type': 'doi' },
      ],
      'title-group': {
        'article-title': { '#text': 'Test PMC Article Title' },
      },
      'contrib-group': {
        contrib: [
          {
            '@_contrib-type': 'author',
            name: {
              surname: { '#text': 'Smith' },
              'given-names': { '#text': 'John' },
            },
          },
        ],
      },
      aff: [{ '#text': 'University of Testing' }],
      'pub-date': { '@_pub-type': 'epub', year: { '#text': '2025' }, month: { '#text': '01' } },
      volume: { '#text': '42' },
      issue: { '#text': '3' },
      fpage: { '#text': '100' },
      lpage: { '#text': '110' },
      abstract: { p: { '#text': 'This is the PMC abstract.' } },
      'kwd-group': { kwd: [{ '#text': 'testing' }] },
    },
  },
  body: {
    sec: [
      {
        title: { '#text': 'Introduction' },
        p: { '#text': 'This is the introduction section.' },
      },
    ],
  },
  back: {
    'ref-list': {
      ref: [
        {
          '@_id': 'ref1',
          label: { '#text': '1' },
          'mixed-citation': { '#text': 'Smith J. Testing. J Test. 2024;41:50-60.' },
        },
      ],
    },
  },
};

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('Output Schema Coverage', () => {
  describe('pubmed_fetch: ArticleSchema covers parseFullArticle() output', () => {
    const { outputSchema } = pubmedFetchTool;

    it('should accept full article output with all fields (includeMesh + includeGrants)', () => {
      const parsed = parseFullArticle(PUBMED_XML_FIXTURE, {
        includeMesh: true,
        includeGrants: true,
      });

      const article = {
        ...parsed,
        pubmedUrl: `https://pubmed.ncbi.nlm.nih.gov/${parsed.pmid}/`,
        ...(parsed.pmcId && {
          pmcUrl: `https://www.ncbi.nlm.nih.gov/pmc/articles/${parsed.pmcId}/`,
        }),
      };

      const output = { articles: [article], totalReturned: 1 };

      // strict() rejects unknown keys instead of stripping them
      expect(() => outputSchema.strict().parse(output)).not.toThrow();
    });

    it('should accept minimal article output (no optional fields)', () => {
      const minimalXml: XmlPubmedArticle = {
        MedlineCitation: {
          PMID: { '#text': '99999999' },
          Article: {
            ArticleTitle: { '#text': 'Minimal Article' },
          },
        },
      };

      const parsed = parseFullArticle(minimalXml, {
        includeMesh: false,
        includeGrants: false,
      });

      const article = {
        ...parsed,
        pubmedUrl: `https://pubmed.ncbi.nlm.nih.gov/${parsed.pmid}/`,
      };

      const output = { articles: [article], totalReturned: 1 };
      expect(() => outputSchema.strict().parse(output)).not.toThrow();
    });

    it('should enumerate every key from parseFullArticle in the schema', () => {
      const parsed = parseFullArticle(PUBMED_XML_FIXTURE, {
        includeMesh: true,
        includeGrants: true,
      });

      // These are the keys the tool logic adds on top of parseFullArticle
      const toolAddedKeys = new Set(['pubmedUrl', 'pmcUrl']);

      const articleSchema = outputSchema.shape.articles.element;
      const schemaKeys = new Set(Object.keys(articleSchema.shape));

      for (const key of Object.keys(parsed)) {
        expect(
          schemaKeys.has(key) || toolAddedKeys.has(key),
          `parseFullArticle() returns "${key}" but ArticleSchema does not declare it`,
        ).toBe(true);
      }
    });
  });

  describe('pubmed_pmc_fetch: ArticleSchema covers parsePmcArticle() output', () => {
    const { outputSchema } = pmcFetchTool;

    it('should accept full PMC article output with references', () => {
      const parsed = parsePmcArticle(PMC_XML_FIXTURE);

      const output = { articles: [parsed], totalReturned: 1 };
      expect(() => outputSchema.strict().parse(output)).not.toThrow();
    });

    it('should accept PMC article without optional fields', () => {
      const minimalXml: XmlJatsArticle = {
        front: {
          'article-meta': {
            'article-id': { '#text': 'PMC0000001', '@_pub-id-type': 'pmcid' },
          },
        },
        body: {
          p: { '#text': 'Body text without sections.' },
        },
      };

      const parsed = parsePmcArticle(minimalXml);
      const output = { articles: [parsed], totalReturned: 1 };
      expect(() => outputSchema.strict().parse(output)).not.toThrow();
    });

    it('should enumerate every key from parsePmcArticle in the schema', () => {
      const parsed = parsePmcArticle(PMC_XML_FIXTURE);

      const articleSchema = outputSchema.shape.articles.element;
      const schemaKeys = new Set(Object.keys(articleSchema.shape));

      for (const key of Object.keys(parsed)) {
        expect(
          schemaKeys.has(key),
          `parsePmcArticle() returns "${key}" but PMC ArticleSchema does not declare it`,
        ).toBe(true);
      }
    });
  });
});
