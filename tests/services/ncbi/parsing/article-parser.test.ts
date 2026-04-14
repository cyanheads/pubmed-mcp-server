/**
 * @fileoverview Tests for PubMed article XML parsing functions.
 * @module tests/services/ncbi/parsing/article-parser.test
 */

import { describe, expect, it } from 'vitest';
import {
  extractAbstractText,
  extractArticleDates,
  extractAuthors,
  extractDoi,
  extractGrants,
  extractJournalInfo,
  extractKeywords,
  extractMeshTerms,
  extractPmcId,
  extractPmid,
  extractPublicationTypes,
  parseFullArticle,
} from '@/services/ncbi/parsing/article-parser.js';
import type {
  XmlArticle,
  XmlArticleIdList,
  XmlAuthorList,
  XmlGrantList,
  XmlKeywordList,
  XmlMedlineCitation,
  XmlMeshHeadingList,
  XmlPublicationTypeList,
  XmlPubmedArticle,
} from '@/services/ncbi/types.js';

describe('extractAuthors', () => {
  it('returns empty for undefined input', () => {
    const result = extractAuthors(undefined);
    expect(result).toEqual({ authors: [], affiliations: [] });
  });

  it('extracts individual authors with names', () => {
    const authorList: XmlAuthorList = {
      Author: [
        {
          LastName: { '#text': 'Smith' },
          ForeName: { '#text': 'John' },
          Initials: { '#text': 'J' },
        },
        {
          LastName: { '#text': 'Doe' },
          ForeName: { '#text': 'Jane' },
          Initials: { '#text': 'JA' },
        },
      ],
    };
    const result = extractAuthors(authorList);
    expect(result.authors).toHaveLength(2);
    expect(result.authors[0]).toEqual({ lastName: 'Smith', firstName: 'John', initials: 'J' });
  });

  it('handles collective names', () => {
    const authorList: XmlAuthorList = {
      Author: [{ CollectiveName: { '#text': 'WHO Study Group' } }],
    };
    const result = extractAuthors(authorList);
    expect(result.authors[0]).toEqual({ collectiveName: 'WHO Study Group' });
  });

  it('deduplicates affiliations', () => {
    const sharedAffiliation = { Affiliation: { '#text': 'MIT, Cambridge, MA' } };
    const authorList: XmlAuthorList = {
      Author: [
        {
          LastName: { '#text': 'A' },
          ForeName: { '#text': 'B' },
          Initials: { '#text': 'B' },
          AffiliationInfo: [sharedAffiliation],
        },
        {
          LastName: { '#text': 'C' },
          ForeName: { '#text': 'D' },
          Initials: { '#text': 'D' },
          AffiliationInfo: [sharedAffiliation],
        },
      ],
    };
    const result = extractAuthors(authorList);
    expect(result.affiliations).toHaveLength(1);
    expect(result.affiliations[0]).toBe('MIT, Cambridge, MA');
    expect(result.authors[0]?.affiliationIndices).toEqual([0]);
    expect(result.authors[1]?.affiliationIndices).toEqual([0]);
  });

  it('extracts ORCID from identifiers', () => {
    const authorList: XmlAuthorList = {
      Author: [
        {
          LastName: { '#text': 'Smith' },
          ForeName: { '#text': 'John' },
          Initials: { '#text': 'J' },
          Identifier: { '@_Source': 'ORCID', '#text': '0000-0001-2345-6789' },
        },
      ],
    };
    const result = extractAuthors(authorList);
    expect(result.authors[0]?.orcid).toBe('0000-0001-2345-6789');
  });

  it('handles a single author (not array)', () => {
    const authorList: XmlAuthorList = {
      Author: {
        LastName: { '#text': 'Solo' },
        ForeName: { '#text': 'Han' },
        Initials: { '#text': 'H' },
      },
    };
    const result = extractAuthors(authorList);
    expect(result.authors).toHaveLength(1);
    expect(result.authors[0]?.lastName).toBe('Solo');
  });
});

describe('extractJournalInfo', () => {
  it('returns undefined for undefined input', () => {
    expect(extractJournalInfo(undefined)).toBeUndefined();
  });

  it('extracts journal fields', () => {
    const result = extractJournalInfo(
      {
        Title: { '#text': 'Nature' },
        ISOAbbreviation: { '#text': 'Nat' },
        JournalIssue: {
          Volume: { '#text': '600' },
          Issue: { '#text': '3' },
          PubDate: { Year: { '#text': '2024' }, Month: { '#text': 'Mar' } },
        },
      },
      { Pagination: { MedlinePgn: { '#text': '100-110' } } } as XmlArticle,
    );
    expect(result?.title).toBe('Nature');
    expect(result?.volume).toBe('600');
    expect(result?.issue).toBe('3');
    expect(result?.pages).toBe('100-110');
    expect(result?.publicationDate?.year).toBe('2024');
  });
});

describe('extractMeshTerms', () => {
  it('returns empty for undefined input', () => {
    expect(extractMeshTerms(undefined)).toEqual([]);
  });

  it('parses MeSH headings with qualifiers', () => {
    const meshList: XmlMeshHeadingList = {
      MeshHeading: [
        {
          DescriptorName: { '#text': 'Neoplasms', '@_UI': 'D009369', '@_MajorTopicYN': 'Y' },
          QualifierName: [{ '#text': 'therapy', '@_UI': 'Q000628', '@_MajorTopicYN': 'N' }],
        },
      ],
    };
    const result = extractMeshTerms(meshList);
    expect(result).toHaveLength(1);
    expect(result[0]?.descriptorName).toBe('Neoplasms');
    expect(result[0]?.descriptorUi).toBe('D009369');
    expect(result[0]?.isMajorTopic).toBe(true);
    expect(result[0]?.qualifiers).toHaveLength(1);
    expect(result[0]?.qualifiers?.[0]?.qualifierName).toBe('therapy');
  });
});

describe('extractGrants', () => {
  it('returns empty for undefined input', () => {
    expect(extractGrants(undefined)).toEqual([]);
  });

  it('extracts grant information', () => {
    const grantList: XmlGrantList = {
      Grant: [
        {
          GrantID: { '#text': 'R01-CA12345' },
          Agency: { '#text': 'NCI NIH HHS' },
          Country: { '#text': 'United States' },
          Acronym: { '#text': 'CA' },
        },
      ],
    };
    const result = extractGrants(grantList);
    expect(result).toHaveLength(1);
    expect(result[0]?.grantId).toBe('R01-CA12345');
    expect(result[0]?.agency).toBe('NCI NIH HHS');
  });
});

describe('extractDoi', () => {
  it('returns undefined for undefined input', () => {
    expect(extractDoi(undefined)).toBeUndefined();
  });

  it('finds DOI from ELocationID with ValidYN=Y', () => {
    const article: XmlArticle = {
      ELocationID: [{ '#text': '10.1000/test', '@_EIdType': 'doi', '@_ValidYN': 'Y' }],
    };
    expect(extractDoi(article)).toBe('10.1000/test');
  });

  it('falls back to ArticleIdList', () => {
    const article: XmlArticle = {};
    const idList: XmlArticleIdList = {
      ArticleId: [{ '#text': '10.1000/fallback', '@_IdType': 'doi' }],
    };
    expect(extractDoi(article, idList)).toBe('10.1000/fallback');
  });
});

describe('extractPmcId', () => {
  it('extracts PMC ID from ArticleIdList', () => {
    const idList: XmlArticleIdList = {
      ArticleId: [{ '#text': 'PMC1234567', '@_IdType': 'pmc' }],
    };
    expect(extractPmcId({} as XmlArticle, idList)).toBe('PMC1234567');
  });
});

describe('extractPublicationTypes', () => {
  it('returns empty for undefined', () => {
    expect(extractPublicationTypes(undefined)).toEqual([]);
  });

  it('extracts publication types', () => {
    const list: XmlPublicationTypeList = {
      PublicationType: [
        { '#text': 'Journal Article', '@_UI': 'D016428' },
        { '#text': 'Review', '@_UI': 'D016454' },
      ],
    };
    expect(extractPublicationTypes(list)).toEqual(['Journal Article', 'Review']);
  });
});

describe('extractKeywords', () => {
  it('returns empty for undefined', () => {
    expect(extractKeywords(undefined)).toEqual([]);
  });

  it('extracts keywords from multiple lists', () => {
    const lists: XmlKeywordList[] = [
      { Keyword: [{ '#text': 'gene therapy' }, { '#text': 'CRISPR' }] },
      { Keyword: [{ '#text': 'genomics' }] },
    ];
    expect(extractKeywords(lists)).toEqual(['gene therapy', 'CRISPR', 'genomics']);
  });
});

describe('extractAbstractText', () => {
  it('returns undefined for missing abstract', () => {
    expect(extractAbstractText(undefined)).toBeUndefined();
  });

  it('extracts simple abstract text', () => {
    const abstract = { AbstractText: { '#text': 'This is the abstract.' } };
    expect(extractAbstractText(abstract)).toBe('This is the abstract.');
  });

  it('joins structured abstract sections', () => {
    const abstract = {
      AbstractText: [
        { '#text': 'Background text', '@_Label': 'BACKGROUND' },
        { '#text': 'Methods text', '@_Label': 'METHODS' },
      ],
    };
    const result = extractAbstractText(abstract);
    expect(result).toContain('BACKGROUND: Background text');
    expect(result).toContain('METHODS: Methods text');
  });
});

describe('extractPmid', () => {
  it('extracts PMID from MedlineCitation', () => {
    const citation: XmlMedlineCitation = {
      PMID: { '#text': '12345678' },
    } as XmlMedlineCitation;
    expect(extractPmid(citation)).toBe('12345678');
  });

  it('returns undefined for missing', () => {
    expect(extractPmid(undefined)).toBeUndefined();
  });
});

describe('extractArticleDates', () => {
  it('returns empty for undefined', () => {
    expect(extractArticleDates(undefined)).toEqual([]);
  });

  it('extracts article dates', () => {
    const article: XmlArticle = {
      ArticleDate: [
        {
          '@_DateType': 'Electronic',
          Year: { '#text': '2024' },
          Month: { '#text': '03' },
          Day: { '#text': '15' },
        },
      ],
    };
    const result = extractArticleDates(article);
    expect(result).toHaveLength(1);
    expect(result[0]?.dateType).toBe('Electronic');
    expect(result[0]?.year).toBe('2024');
  });
});

describe('parseFullArticle', () => {
  it('parses a full PubmedArticle XML structure', () => {
    const xmlArticle: XmlPubmedArticle = {
      MedlineCitation: {
        PMID: { '#text': '12345' },
        Article: {
          ArticleTitle: { '#text': 'Test Article' },
          Abstract: { AbstractText: { '#text': 'Abstract here.' } },
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
            Title: { '#text': 'Test Journal' },
            JournalIssue: {
              Volume: { '#text': '10' },
              PubDate: { Year: { '#text': '2024' } },
            },
          },
          PublicationTypeList: {
            PublicationType: { '#text': 'Journal Article' },
          },
        },
      } as unknown as XmlMedlineCitation,
      PubmedData: {
        ArticleIdList: {
          ArticleId: [{ '#text': '10.1000/test', '@_IdType': 'doi' }],
        },
      },
    };

    const result = parseFullArticle(xmlArticle);
    expect(result.pmid).toBe('12345');
    expect(result.title).toBe('Test Article');
    expect(result.abstractText).toBe('Abstract here.');
    expect(result.authors).toHaveLength(1);
    expect(result.doi).toBe('10.1000/test');
    expect(result.journalInfo?.title).toBe('Test Journal');
  });

  it('preserves decoded page ranges and diacritics from parsed XML', () => {
    const xmlArticle: XmlPubmedArticle = {
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
          PublicationTypeList: {
            PublicationType: { '#text': 'Journal Article' },
          },
        },
      } as unknown as XmlMedlineCitation,
    };

    const result = parseFullArticle(xmlArticle);

    expect(result.title).toBe('\u03b2-catenin in Garc\u00eda-L\u00f3pez cohorts');
    expect(result.authors?.[0]?.lastName).toBe('Garc\u00eda-L\u00f3pez');
    expect(result.affiliations).toEqual(['Uniwersytet Jagiello\u0144ski, Krak\u00f3w']);
    expect(result.journalInfo?.pages).toBe('45\u201352');
    expect(result.journalInfo?.title).toBe('Revista Cl\u00ednica');
  });

  it('respects includeMesh and includeGrants options', () => {
    const xmlArticle: XmlPubmedArticle = {
      MedlineCitation: {
        PMID: { '#text': '1' },
        Article: {},
        MeshHeadingList: {
          MeshHeading: [{ DescriptorName: { '#text': 'Test', '@_MajorTopicYN': 'N' } }],
        },
      } as unknown as XmlMedlineCitation,
    };

    const withMesh = parseFullArticle(xmlArticle, { includeMesh: true });
    expect(withMesh.meshTerms).toBeDefined();

    const withoutMesh = parseFullArticle(xmlArticle, { includeMesh: false });
    expect(withoutMesh.meshTerms).toBeUndefined();
  });
});
