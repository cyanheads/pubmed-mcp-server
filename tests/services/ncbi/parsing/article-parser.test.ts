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
  parseArticleSet,
  parseFullArticle,
} from '@/services/ncbi/parsing/article-parser.js';
import { ensureArray } from '@/services/ncbi/parsing/xml-helpers.js';
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
import {
  ADA_WHOLE_BOOK_XML,
  articleSetXml,
  GENEREVIEWS_CHAPTER_XML,
  JOURNAL_ARTICLE_XML,
  LACTMED_CHAPTER_XML,
  NAP_WHOLE_BOOK_XML,
  parseArticleSetXml,
  STATPEARLS_CHAPTER_XML,
} from './_book-fixtures.js';
import {
  ERRATUM_NOTE_ARTICLE_XML,
  PUBLISHED_ERRATUM_WITH_CITES_XML,
  PUBLISHED_ERRATUM_XML,
  RETRACTED_ARTICLE_XML,
  RETRACTION_NOTICE_XML,
} from './_comments-corrections-fixtures.js';

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

  describe('electronic article locators (ELocationID)', () => {
    // Shape of PMID 39060015 as NCBI EFetch returns it: no Pagination element,
    // a pii locator and a doi locator side by side, both ValidYN="Y".
    const eurRespirJournal = {
      ISSN: { '#text': '1399-3003', '@_IssnType': 'Electronic' },
      JournalIssue: {
        Volume: { '#text': '64' },
        Issue: { '#text': '3' },
        PubDate: { Year: { '#text': '2024' }, Month: { '#text': 'Sep' } },
      },
      Title: { '#text': 'The European respiratory journal' },
      ISOAbbreviation: { '#text': 'Eur Respir J' },
    };
    const eurRespirArticle = {
      ELocationID: [
        { '#text': '2400512', '@_EIdType': 'pii', '@_ValidYN': 'Y' },
        { '#text': '10.1183/13993003.00512-2024', '@_EIdType': 'doi', '@_ValidYN': 'Y' },
      ],
    } as XmlArticle;

    it('surfaces the locator and its type for a record with no Pagination', () => {
      const result = extractJournalInfo(eurRespirJournal, eurRespirArticle);
      expect(result?.elocationId).toBe('2400512');
      expect(result?.elocationIdType).toBe('pii');
      // Never backfilled from the locator — the record genuinely has no pages
      expect(result?.pages).toBe('');
    });

    it('leaves DOI extraction untouched — the two values live side by side', () => {
      expect(extractDoi(eurRespirArticle)).toBe('10.1183/13993003.00512-2024');
    });

    it('never surfaces a DOI-typed ELocationID as the locator', () => {
      const result = extractJournalInfo(eurRespirJournal, {
        ELocationID: {
          '#text': '10.1183/13993003.00512-2024',
          '@_EIdType': 'doi',
          '@_ValidYN': 'Y',
        },
      } as XmlArticle);
      expect(result?.elocationId).toBeUndefined();
      expect(result?.elocationIdType).toBeUndefined();
    });

    it('surfaces nothing when the only locator is marked ValidYN="N"', () => {
      const result = extractJournalInfo(eurRespirJournal, {
        ELocationID: { '#text': '2400512', '@_EIdType': 'pii', '@_ValidYN': 'N' },
      } as XmlArticle);
      expect(result?.elocationId).toBeUndefined();
      expect(result?.elocationIdType).toBeUndefined();
    });

    it('prefers a ValidYN="Y" locator over an invalidated one', () => {
      const result = extractJournalInfo(eurRespirJournal, {
        ELocationID: [
          { '#text': 'stale-locator', '@_EIdType': 'pii', '@_ValidYN': 'N' },
          { '#text': '2400512', '@_EIdType': 'pii', '@_ValidYN': 'Y' },
        ],
      } as XmlArticle);
      expect(result?.elocationId).toBe('2400512');
    });

    it('keeps both values when pagination duplicates the locator', () => {
      const result = extractJournalInfo(eurRespirJournal, {
        ELocationID: { '#text': 'e0300123', '@_EIdType': 'pii', '@_ValidYN': 'Y' },
        Pagination: { MedlinePgn: { '#text': 'e0300123' } },
      } as XmlArticle);
      expect(result?.pages).toBe('e0300123');
      expect(result?.elocationId).toBe('e0300123');
    });

    it('omits both fields for a record carrying no ELocationID', () => {
      const result = extractJournalInfo(eurRespirJournal, {
        Pagination: { MedlinePgn: { '#text': '100-110' } },
      } as XmlArticle);
      expect(result?.elocationId).toBeUndefined();
      expect(result?.elocationIdType).toBeUndefined();
    });
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

  it('decodes NCBI double-encoded entities in grant fields (#74)', () => {
    // EFetch ships `CSR&amp;amp;D`; the XML parser decodes one level to the
    // literal `CSR&amp;D`, so extractGrants must decode the residual entity.
    const grantList: XmlGrantList = {
      Grant: [
        {
          GrantID: { '#text': 'CSR&amp;D I01CX002210' },
          Agency: { '#text': 'Blood &amp; Marrow Transplant' },
          Country: { '#text': 'United States' },
        },
      ],
    };
    const result = extractGrants(grantList);
    expect(result[0]?.grantId).toBe('CSR&D I01CX002210');
    expect(result[0]?.agency).toBe('Blood & Marrow Transplant');
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

  describe('empty-array omission (issue #28)', () => {
    const bareArticle: XmlPubmedArticle = {
      MedlineCitation: {
        PMID: { '#text': '13054692' },
        Article: {
          ArticleTitle: { '#text': 'Bare article.' },
        },
      } as unknown as XmlMedlineCitation,
    };

    it('omits publicationTypes when absent from XML', () => {
      const result = parseFullArticle(bareArticle);
      expect(result.publicationTypes).toBeUndefined();
    });

    it('omits keywords when absent from XML', () => {
      const result = parseFullArticle(bareArticle);
      expect(result.keywords).toBeUndefined();
    });

    it('omits articleDates when absent from XML', () => {
      const result = parseFullArticle(bareArticle);
      expect(result.articleDates).toBeUndefined();
    });

    it('omits meshTerms when includeMesh=true but XML has none', () => {
      const result = parseFullArticle(bareArticle, { includeMesh: true });
      expect(result.meshTerms).toBeUndefined();
    });

    it('omits grantList when includeGrants=true but XML has none', () => {
      const result = parseFullArticle(bareArticle, { includeGrants: true });
      expect(result.grantList).toBeUndefined();
    });

    it('still returns non-empty arrays normally', () => {
      const populated: XmlPubmedArticle = {
        MedlineCitation: {
          PMID: { '#text': '1' },
          Article: {
            PublicationTypeList: {
              PublicationType: { '#text': 'Journal Article' },
            },
            KeywordList: {
              Keyword: [{ '#text': 'asthma' }],
            },
            ArticleDate: [
              {
                '@_DateType': 'Electronic',
                Year: { '#text': '2023' },
                Month: { '#text': '02' },
                Day: { '#text': '22' },
              },
            ],
          },
        } as unknown as XmlMedlineCitation,
      };
      const result = parseFullArticle(populated, { includeMesh: true, includeGrants: true });
      expect(result.publicationTypes).toEqual(['Journal Article']);
      expect(result.keywords).toEqual(['asthma']);
      expect(result.articleDates).toHaveLength(1);
      expect(result.meshTerms).toBeUndefined();
      expect(result.grantList).toBeUndefined();
    });
  });
});

describe('Bookshelf records (#114)', () => {
  const parseSet = (...records: string[]) =>
    parseArticleSet(parseArticleSetXml(articleSetXml(...records)));

  describe('the reproduction — PMIDs 20301425 and 29262038', () => {
    const bookOnlySet = () =>
      parseArticleSetXml(articleSetXml(GENEREVIEWS_CHAPTER_XML, STATPEARLS_CHAPTER_XML));

    it('reading PubmedArticleSet.PubmedArticle alone still yields nothing', () => {
      // The defect, pinned: the wrapper is present and no error is raised, so
      // both PMIDs fall through to `unavailablePmids` with nothing to explain it.
      expect(ensureArray(bookOnlySet().PubmedArticle)).toHaveLength(0);
    });

    it('parseArticleSet returns both records', () => {
      expect(parseArticleSet(bookOnlySet()).map((r) => r.pmid)).toEqual(['20301425', '29262038']);
    });
  });

  it('parses a single-book response, which upstream sends as a scalar', () => {
    const records = parseSet(GENEREVIEWS_CHAPTER_XML);
    expect(records).toHaveLength(1);
    expect(records[0]?.pmid).toBe('20301425');
  });

  describe('chapter with book editors (GeneReviews, PMID 20301425)', () => {
    const record = () => parseSet(GENEREVIEWS_CHAPTER_XML)[0];

    it('is a book-chapter titled by its ArticleTitle', () => {
      expect(record()?.recordType).toBe('book-chapter');
      expect(record()?.title).toBe(
        'BRCA1- and BRCA2-Associated Hereditary Breast and Ovarian Cancer',
      );
    });

    it('puts the chapter authors in authors and the book editors in book.editors', () => {
      expect(record()?.authors?.map((a) => a.lastName)).toEqual(['Petrucelli', 'Daly', 'Pal']);
      expect(record()?.book?.editors?.map((e) => e.lastName)).toEqual([
        'Adam',
        'Bick',
        'Mirzaa',
        'Wallace',
        'Amemiya',
      ]);
    });

    it('carries editors as name parts only, never affiliations', () => {
      expect(record()?.book?.editors?.[0]).toEqual({
        lastName: 'Adam',
        firstName: 'Margaret P',
        initials: 'MP',
      });
    });

    it('renders the BookTitle registered mark without the ASCII caret fallback', () => {
      expect(record()?.book?.title).toBe('GeneReviews®');
    });

    it('carries the imprint, the date range, the medium and the Bookshelf accession', () => {
      expect(record()?.book).toMatchObject({
        publisher: 'University of Washington, Seattle',
        publisherLocation: 'Seattle (WA)',
        pubDate: '1993',
        beginningDate: '1993',
        endingDate: '2026',
        medium: 'Internet',
        accession: 'NBK1247',
      });
    });

    it('never synthesizes a journal from the book', () => {
      expect(record()?.journalInfo).toBeUndefined();
    });

    it('keeps chapter-author affiliations, the abstract, keywords and dates', () => {
      expect(record()?.affiliations).toHaveLength(3);
      expect(record()?.abstractText).toContain('CLINICAL CHARACTERISTICS:');
      expect(record()?.keywords).toContain('BRCA1- and BRCA2-Associated HBOC');
      expect(record()?.publicationTypes).toEqual(['Review']);
      expect(record()?.articleDates).toEqual([
        { dateType: 'ContributionDate', year: '1998', month: '9', day: '4' },
        { dateType: 'DateRevised', year: '2026', month: '3', day: '25' },
      ]);
    });
  });

  describe('chapter with no authors and no editors (LactMed, PMID 29999637)', () => {
    const record = () => parseSet(LACTMED_CHAPTER_XML)[0];

    it('is still a book-chapter with a venue', () => {
      expect(record()?.recordType).toBe('book-chapter');
      expect(record()?.title).toBe('Carboplatin');
      expect(record()?.book?.title).toBe('Drugs and Lactation Database (LactMed®)');
    });

    it('reports no authors and no editors rather than inventing either', () => {
      expect(record()?.authors).toEqual([]);
      expect(record()?.book?.editors).toBeUndefined();
      expect(record()?.affiliations).toBeUndefined();
    });
  });

  describe('whole-book record with no ArticleTitle (ADA, PMID 42715368)', () => {
    const record = () => parseSet(ADA_WHOLE_BOOK_XML)[0];

    it('is a book whose title falls back to BookTitle', () => {
      expect(record()?.recordType).toBe('book');
      expect(record()?.title).toBe(
        'A Practical Guide to Hypoglycemia: New Approaches to Overcoming a Persistent Barrier to Optimal Glycemic Management',
      );
      expect(record()?.title).toBe(record()?.book?.title);
    });

    it('separates the book-level DOI from the record DOI and keeps the collection', () => {
      expect(record()?.book?.doi).toBe('10.2337/db20261');
      expect(record()?.doi).toBe('10.2337/db20261');
      expect(record()?.book?.collectionTitle).toBe('ADA Clinical Compendia Series');
      expect(record()?.book?.accession).toBe('NBK624619');
    });

    it('reports no authors, no editors and no medium rather than filling them in', () => {
      expect(record()?.authors).toEqual([]);
      expect(record()?.book?.editors).toBeUndefined();
      expect(record()?.book?.medium).toBeUndefined();
    });
  });

  describe('multi-ISBN whole-book record (National Academies, PMID 42691195)', () => {
    const record = () => parseSet(NAP_WHOLE_BOOK_XML)[0];

    it('keeps every ISBN verbatim, leading zero included', () => {
      expect(record()?.book?.isbns).toEqual(['9780309605397', '0309605393']);
    });

    it('promotes a book-level author list when the record has no chapter authors', () => {
      expect(record()?.authors?.[0]?.collectiveName).toContain('National Academies of Sciences');
      expect(record()?.book?.editors).toBeUndefined();
    });
  });

  describe('mixed PubmedArticle + PubmedBookArticle set', () => {
    it('returns every record, each tagged with its own recordType', () => {
      const records = parseSet(LACTMED_CHAPTER_XML, GENEREVIEWS_CHAPTER_XML, JOURNAL_ARTICLE_XML);
      expect(records.map((r) => [r.pmid, r.recordType])).toEqual([
        ['29999637', 'book-chapter'],
        ['20301425', 'book-chapter'],
        ['42474064', 'journal-article'],
      ]);
    });

    it('leaves the journal record exactly as it was, apart from the discriminator', () => {
      const journal = parseSet(JOURNAL_ARTICLE_XML, ADA_WHOLE_BOOK_XML)[0];
      expect(journal?.recordType).toBe('journal-article');
      expect(journal?.book).toBeUndefined();
      expect(journal?.journalInfo?.title).toBe(
        'Health technology assessment (Winchester, England)',
      );
      expect(journal?.journalInfo?.pages).toBe('1-32');
      expect(journal?.doi).toBe('10.3310/KGTO6391');
      expect(journal?.pmcId).toBe('PMC13403055');
      expect(journal?.meshTerms).toHaveLength(2);
    });
  });

  it('returns an empty list for an undefined set', () => {
    expect(parseArticleSet(undefined)).toEqual([]);
  });
});

describe('CommentsCorrectionsList (#178)', () => {
  const parseSet = (...records: string[]) =>
    parseArticleSet(parseArticleSetXml(articleSetXml(...records)));
  const record = (xml: string) => parseSet(xml)[0];

  describe('a 29-entry list (PMID 9500320)', () => {
    it('keeps every entry in upstream order, retraction and concern notices included', () => {
      const commentIn = (pmids: string[]) => pmids.map((pmid) => `CommentIn ${pmid}`);
      expect(
        record(RETRACTED_ARTICLE_XML)?.commentsCorrections?.map((e) => `${e.refType} ${e.pmid}`),
      ).toEqual([
        ...commentIn([
          '9500313',
          '9525390',
          '9525391',
          '9525392',
          '9525393',
          '9525394',
          '9525395',
          '9525396',
          '9643815',
          '9643816',
          '9643817',
          '9643818',
          '9643820',
          '9643821',
          '9643822',
          '9643823',
          '9683237',
          '10963264',
          '10963266',
          '10963267',
          '12086756',
          '15016482',
        ]),
        'RetractionIn 15016483',
        ...commentIn(['15022645', '15022648', '15022649', '15022650']),
        'RetractionIn 20137807',
        'ExpressionOfConcernIn 21971344',
      ]);
    });

    it('carries the RefSource citation verbatim and no note NCBI did not supply', () => {
      const entries = record(RETRACTED_ARTICLE_XML)?.commentsCorrections ?? [];
      expect(entries[0]).toEqual({
        refType: 'CommentIn',
        refSource: 'Lancet. 1998 Feb 28;351(9103):611-2. doi: 10.1016/S0140-6736(05)78423-3.',
        pmid: '9500313',
      });
      expect(entries.find((e) => e.pmid === '21971344')).toEqual({
        refType: 'ExpressionOfConcernIn',
        refSource:
          'Eur J Gastroenterol Hepatol. 2011 Nov;23(11):1082. doi: 10.1097/MEG.0b013e328349d184.',
        pmid: '21971344',
      });
    });

    it('leaves publicationTypes as NCBI supplied them', () => {
      expect(record(RETRACTED_ARTICLE_XML)?.publicationTypes).toEqual([
        'Journal Article',
        "Research Support, Non-U.S. Gov't",
        'Retracted Publication',
      ]);
    });
  });

  it('decodes a note given as numeric character references and adds no pmid (PMID 23300797)', () => {
    const parsed = record(ERRATUM_NOTE_ARTICLE_XML);
    expect(parsed?.commentsCorrections).toEqual([
      {
        refType: 'ErratumIn',
        refSource:
          'PLoS One. 2013;8(6). doi:10.1371/annotation/df743c15-c50e-4d00-a24d-510e15f9a73b',
        note: 'Fuβer, Fabian [corrected to Fußer, Fabian]',
      },
    ]);
    expect(parsed?.commentsCorrections?.[0]).not.toHaveProperty('pmid');
    // An erratum link is not a publication type; none is inferred from it.
    expect(parsed?.publicationTypes).toEqual([
      'Journal Article',
      "Research Support, Non-U.S. Gov't",
    ]);
  });

  it('omits the pmid key on an entry whose linked record has none (PMID 8643635)', () => {
    const entries = record(PUBLISHED_ERRATUM_XML)?.commentsCorrections;
    expect(entries).toEqual([
      { refType: 'ErratumIn', refSource: 'Proc Natl Acad Sci U S A 1996 Aug 20;93(17):9302' },
      {
        refType: 'ErratumFor',
        refSource:
          'Proc Natl Acad Sci U S A. 1995 Jul 18;92(15):7090-4. doi: 10.1073/pnas.92.15.7090.',
        pmid: '7624375',
      },
    ]);
    expect(Object.keys(entries?.[0] ?? {})).toEqual(['refType', 'refSource']);
  });

  describe('a one-entry list (PMID 20137807)', () => {
    it('reaches the parser as an array, not a collapsed scalar', () => {
      const set = parseArticleSetXml(articleSetXml(RETRACTION_NOTICE_XML));
      const list = ensureArray(set.PubmedArticle)[0]?.MedlineCitation.CommentsCorrectionsList;
      expect(Array.isArray(list?.CommentsCorrections)).toBe(true);
    });

    it('returns a one-element array', () => {
      expect(record(RETRACTION_NOTICE_XML)?.commentsCorrections).toEqual([
        {
          refType: 'RetractionOf',
          refSource: 'Lancet. 1998 Feb 28;351(9103):637-41. doi: 10.1016/s0140-6736(97)11096-0.',
          pmid: '9500320',
        },
      ]);
    });
  });

  it('returns a purely numeric RefSource, Note and PMID as strings', () => {
    // The flat parser coerces numeric-looking text (`parseTagValue`): a number would
    // fail the output schema's string fields, and one read back with `String()` loses
    // its spelling — `1.50` → `1.5`, `007` → `7`.
    const numeric = RETRACTION_NOTICE_XML.replace(
      /<RefSource>.*?<\/RefSource>/,
      '<RefSource>1.50</RefSource>',
    ).replace('</PMID></CommentsCorrections>', '</PMID><Note>007</Note></CommentsCorrections>');
    expect(record(numeric)?.commentsCorrections).toEqual([
      { refType: 'RetractionOf', refSource: '1.50', pmid: '9500320', note: '007' },
    ]);
  });

  it('keeps the numeric coercion of an element named Note outside the list', () => {
    // The verbatim exemption is scoped to CommentsCorrections by path, not by tag name.
    const elsewhere = RETRACTION_NOTICE_XML.replace(
      '<Article PubModel',
      '<Note>007</Note><Article PubModel',
    );
    const set = parseArticleSetXml(articleSetXml(elsewhere));
    const citation = ensureArray(set.PubmedArticle)[0]?.MedlineCitation as unknown as {
      Note?: unknown;
    };
    expect(citation.Note).toBe(7);
  });

  it('drops a Cites entry and keeps the entries on either side of it in order', () => {
    const entries = record(PUBLISHED_ERRATUM_WITH_CITES_XML)?.commentsCorrections;
    expect(entries?.map((e) => e.refType)).toEqual(['ErratumIn', 'ErratumFor']);
    expect(entries).toEqual(record(PUBLISHED_ERRATUM_XML)?.commentsCorrections);
  });

  it('omits the field when every entry is a Cites entry', () => {
    const citesOnly = PUBLISHED_ERRATUM_WITH_CITES_XML.replace(
      /<CommentsCorrections RefType="Erratum(?:In|For)">.*?<\/CommentsCorrections>/g,
      '',
    );
    expect(citesOnly).toContain('RefType="Cites"');
    expect(record(citesOnly)).not.toHaveProperty('commentsCorrections');
  });

  it('omits the field when the record carries no list', () => {
    expect(record(JOURNAL_ARTICLE_XML)).not.toHaveProperty('commentsCorrections');
  });

  it('never sets the field on a Bookshelf record', () => {
    for (const parsed of parseSet(GENEREVIEWS_CHAPTER_XML, ADA_WHOLE_BOOK_XML)) {
      expect(parsed).not.toHaveProperty('commentsCorrections');
    }
  });

  it('keeps each record’s own list in a mixed batch', () => {
    const records = parseSet(RETRACTED_ARTICLE_XML, RETRACTION_NOTICE_XML, JOURNAL_ARTICLE_XML);
    expect(records.map((r) => [r.pmid, r.commentsCorrections?.length])).toEqual([
      ['9500320', 29],
      ['20137807', 1],
      ['42474064', undefined],
    ]);
  });
});
