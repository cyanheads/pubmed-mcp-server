/**
 * @fileoverview Tests for the article-parser helper functions used to extract
 * structured data from PubMed EFetch XML structures.
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
  extractPmid,
  extractPublicationTypes,
  parseFullArticle,
} from '@/services/ncbi/parsing/article-parser.js';
import type {
  XmlArticle,
  XmlArticleIdList,
  XmlAuthorList,
  XmlGrantList,
  XmlJournal,
  XmlKeywordList,
  XmlMedlineCitation,
  XmlMeshHeadingList,
  XmlPublicationTypeList,
  XmlPubmedArticle,
} from '@/services/ncbi/types.js';

// ─── extractAuthors ──────────────────────────────────────────────────────────

describe('extractAuthors', () => {
  it('returns empty authors and affiliations when authorListXml is undefined', () => {
    const result = extractAuthors(undefined);
    expect(result).toEqual({ authors: [], affiliations: [] });
  });

  it('returns empty when Author list is empty / absent', () => {
    const authorList: XmlAuthorList = {};
    const result = extractAuthors(authorList);
    expect(result).toEqual({ authors: [], affiliations: [] });
  });

  it('extracts a single author with all name fields', () => {
    const authorList: XmlAuthorList = {
      Author: {
        LastName: { '#text': 'Smith' },
        ForeName: { '#text': 'John' },
        Initials: { '#text': 'J' },
      },
    };
    const { authors, affiliations } = extractAuthors(authorList);
    expect(authors).toEqual([{ lastName: 'Smith', firstName: 'John', initials: 'J' }]);
    expect(affiliations).toEqual([]);
  });

  it('extracts a collective name author', () => {
    const authorList: XmlAuthorList = {
      Author: {
        CollectiveName: { '#text': 'The ACME Consortium' },
      },
    };
    const { authors } = extractAuthors(authorList);
    expect(authors).toEqual([{ collectiveName: 'The ACME Consortium' }]);
  });

  it('extracts an author with affiliation and deduplicates', () => {
    const authorList: XmlAuthorList = {
      Author: {
        LastName: { '#text': 'Jones' },
        ForeName: { '#text': 'Alice' },
        Initials: { '#text': 'A' },
        AffiliationInfo: [{ Affiliation: { '#text': 'Harvard Medical School, Boston, MA.' } }],
      },
    };
    const { authors, affiliations } = extractAuthors(authorList);
    expect(affiliations).toEqual(['Harvard Medical School, Boston, MA.']);
    expect(authors[0]?.affiliationIndices).toEqual([0]);
  });

  it('deduplicates shared affiliations across authors', () => {
    const sharedAffiliation = 'Department of Medicine, MIT, Cambridge, MA.';
    const authorList: XmlAuthorList = {
      Author: [
        {
          LastName: { '#text': 'Alpha' },
          ForeName: { '#text': 'Ann' },
          Initials: { '#text': 'A' },
          AffiliationInfo: [{ Affiliation: { '#text': sharedAffiliation } }],
        },
        {
          LastName: { '#text': 'Beta' },
          ForeName: { '#text': 'Bob' },
          Initials: { '#text': 'B' },
          AffiliationInfo: [{ Affiliation: { '#text': sharedAffiliation } }],
        },
      ],
    };
    const { authors, affiliations } = extractAuthors(authorList);
    expect(affiliations).toHaveLength(1);
    expect(affiliations[0]).toBe(sharedAffiliation);
    expect(authors[0]?.affiliationIndices).toEqual([0]);
    expect(authors[1]?.affiliationIndices).toEqual([0]);
  });

  it('extracts multiple authors preserving order', () => {
    const authorList: XmlAuthorList = {
      Author: [
        {
          LastName: { '#text': 'Alpha' },
          ForeName: { '#text': 'Ann' },
          Initials: { '#text': 'A' },
        },
        { LastName: { '#text': 'Beta' }, ForeName: { '#text': 'Bob' }, Initials: { '#text': 'B' } },
      ],
    };
    const { authors } = extractAuthors(authorList);
    expect(authors).toHaveLength(2);
    expect(authors[0]?.lastName).toBe('Alpha');
    expect(authors[1]?.lastName).toBe('Beta');
  });
});

// ─── extractJournalInfo ──────────────────────────────────────────────────────

describe('extractJournalInfo', () => {
  it('returns undefined when journalXml is undefined', () => {
    expect(extractJournalInfo(undefined)).toBeUndefined();
  });

  it('extracts a journal with all fields present', () => {
    const journal: XmlJournal = {
      Title: { '#text': 'Nature Medicine' },
      ISOAbbreviation: { '#text': 'Nat Med' },
      JournalIssue: {
        Volume: { '#text': '28' },
        Issue: { '#text': '3' },
        PubDate: {
          Year: { '#text': '2022' },
          Month: { '#text': 'Mar' },
          Day: { '#text': '15' },
        },
      },
    };
    const result = extractJournalInfo(journal);
    expect(result).toMatchObject({
      title: 'Nature Medicine',
      isoAbbreviation: 'Nat Med',
      volume: '28',
      issue: '3',
      publicationDate: { year: '2022', month: 'Mar', day: '15' },
    });
  });

  it('falls back to MedlineDate year when Year element is absent', () => {
    const journal: XmlJournal = {
      Title: { '#text': 'J Some Journal' },
      JournalIssue: {
        PubDate: {
          MedlineDate: { '#text': '2001 Summer' },
        },
      },
    };
    const result = extractJournalInfo(journal);
    expect(result?.publicationDate?.year).toBe('2001');
    expect(result?.publicationDate?.medlineDate).toBe('2001 Summer');
  });

  it('extracts pages from articleXml.Pagination.MedlinePgn', () => {
    const journal: XmlJournal = {
      Title: { '#text': 'Test Journal' },
      JournalIssue: { PubDate: { Year: { '#text': '2020' } } },
    };
    const article: XmlArticle = {
      Pagination: { MedlinePgn: { '#text': '100-105' } },
    };
    const result = extractJournalInfo(journal, article);
    expect(result?.pages).toBe('100-105');
  });

  it('returns empty pages when no Pagination present', () => {
    const journal: XmlJournal = {
      Title: { '#text': 'Test Journal' },
      JournalIssue: { PubDate: { Year: { '#text': '2021' } } },
    };
    const article: XmlArticle = {};
    const result = extractJournalInfo(journal, article);
    expect(result?.pages).toBe('');
  });
});

// ─── extractMeshTerms ────────────────────────────────────────────────────────

describe('extractMeshTerms', () => {
  it('returns [] when meshHeadingListXml is undefined', () => {
    expect(extractMeshTerms(undefined)).toEqual([]);
  });

  it('extracts a descriptor marked as major topic', () => {
    const list: XmlMeshHeadingList = {
      MeshHeading: {
        DescriptorName: { '#text': 'Neoplasms', '@_MajorTopicYN': 'Y', '@_UI': 'D009369' },
      },
    };
    const [term] = extractMeshTerms(list);
    expect(term?.descriptorName).toBe('Neoplasms');
    expect(term?.isMajorTopic).toBe(true);
    expect(term?.descriptorUi).toBe('D009369');
  });

  it('extracts a descriptor with a qualifier and qualifier UI', () => {
    const list: XmlMeshHeadingList = {
      MeshHeading: {
        DescriptorName: { '#text': 'Breast Neoplasms', '@_MajorTopicYN': 'N', '@_UI': 'D001943' },
        QualifierName: { '#text': 'drug therapy', '@_MajorTopicYN': 'Y', '@_UI': 'Q000188' },
      },
    };
    const [term] = extractMeshTerms(list);
    expect(term?.qualifiers).toHaveLength(1);
    expect(term?.qualifiers?.[0]?.qualifierName).toBe('drug therapy');
    expect(term?.qualifiers?.[0]?.qualifierUi).toBe('Q000188');
    expect(term?.isMajorTopic).toBe(true);
  });

  it('extracts multiple qualifiers per heading', () => {
    const list: XmlMeshHeadingList = {
      MeshHeading: {
        DescriptorName: { '#text': 'Drug Therapy', '@_MajorTopicYN': 'N', '@_UI': 'D004358' },
        QualifierName: [
          { '#text': 'adverse effects', '@_MajorTopicYN': 'Y', '@_UI': 'Q000009' },
          { '#text': 'pharmacology', '@_MajorTopicYN': 'N', '@_UI': 'Q000494' },
        ],
      },
    };
    const [term] = extractMeshTerms(list);
    expect(term?.qualifiers).toHaveLength(2);
    expect(term?.qualifiers?.[0]?.qualifierName).toBe('adverse effects');
    expect(term?.qualifiers?.[0]?.isMajorTopic).toBe(true);
    expect(term?.qualifiers?.[1]?.qualifierName).toBe('pharmacology');
    expect(term?.qualifiers?.[1]?.isMajorTopic).toBe(false);
    expect(term?.isMajorTopic).toBe(true); // Major due to first qualifier
  });

  it('extracts descriptor UI even when not a major topic', () => {
    const list: XmlMeshHeadingList = {
      MeshHeading: {
        DescriptorName: { '#text': 'Humans', '@_MajorTopicYN': 'N', '@_UI': 'D006801' },
      },
    };
    const [term] = extractMeshTerms(list);
    expect(term?.descriptorUi).toBe('D006801');
    expect(term?.isMajorTopic).toBe(false);
  });

  it('handles multiple MeshHeading entries', () => {
    const list: XmlMeshHeadingList = {
      MeshHeading: [
        { DescriptorName: { '#text': 'Humans', '@_MajorTopicYN': 'N' } },
        { DescriptorName: { '#text': 'Animals', '@_MajorTopicYN': 'N' } },
      ],
    };
    expect(extractMeshTerms(list)).toHaveLength(2);
  });
});

// ─── extractGrants ───────────────────────────────────────────────────────────

describe('extractGrants', () => {
  it('returns [] when grantListXml is undefined', () => {
    expect(extractGrants(undefined)).toEqual([]);
  });

  it('extracts a grant with all fields', () => {
    const grantList: XmlGrantList = {
      Grant: {
        GrantID: { '#text': 'R01-CA123456' },
        Agency: { '#text': 'National Cancer Institute' },
        Country: { '#text': 'United States' },
      },
    };
    expect(extractGrants(grantList)).toEqual([
      { grantId: 'R01-CA123456', agency: 'National Cancer Institute', country: 'United States' },
    ]);
  });

  it('extracts a grant with partial fields and omits absent keys', () => {
    const grantList: XmlGrantList = {
      Grant: {
        Agency: { '#text': 'Wellcome Trust' },
        Country: { '#text': 'United Kingdom' },
      },
    };
    const [grant] = extractGrants(grantList);
    expect(grant).toEqual({ agency: 'Wellcome Trust', country: 'United Kingdom' });
    expect(grant).not.toHaveProperty('grantId');
  });

  it('extracts multiple grants', () => {
    const grantList: XmlGrantList = {
      Grant: [
        { GrantID: { '#text': 'G1' }, Agency: { '#text': 'NIH' }, Country: { '#text': 'US' } },
        { GrantID: { '#text': 'G2' }, Agency: { '#text': 'NSF' }, Country: { '#text': 'US' } },
      ],
    };
    expect(extractGrants(grantList)).toHaveLength(2);
  });
});

// ─── extractDoi ──────────────────────────────────────────────────────────────

describe('extractDoi', () => {
  it('returns undefined when articleXml is undefined', () => {
    expect(extractDoi(undefined)).toBeUndefined();
  });

  it('extracts DOI from ELocationID with ValidYN=Y', () => {
    const article: XmlArticle = {
      ELocationID: { '#text': '10.1000/valid', '@_EIdType': 'doi', '@_ValidYN': 'Y' },
    };
    expect(extractDoi(article)).toBe('10.1000/valid');
  });

  it('extracts DOI from ELocationID without ValidYN attribute', () => {
    const article: XmlArticle = {
      ELocationID: { '#text': '10.1000/novalidyn', '@_EIdType': 'doi' },
    };
    expect(extractDoi(article)).toBe('10.1000/novalidyn');
  });

  it('prefers ValidYN=Y ELocationID over non-validated one', () => {
    const article: XmlArticle = {
      ELocationID: [
        { '#text': '10.1000/invalid-doi', '@_EIdType': 'doi', '@_ValidYN': 'N' },
        { '#text': '10.1000/valid-doi', '@_EIdType': 'doi', '@_ValidYN': 'Y' },
      ],
    };
    expect(extractDoi(article)).toBe('10.1000/valid-doi');
  });

  it('extracts DOI from Article.ArticleIdList when no ELocationID present', () => {
    const article: XmlArticle = {
      ArticleIdList: {
        ArticleId: { '#text': '10.1000/article-id', '@_IdType': 'doi' },
      },
    };
    expect(extractDoi(article)).toBe('10.1000/article-id');
  });

  it('falls back to PubmedData.ArticleIdList when article-level sources are absent', () => {
    const article: XmlArticle = {};
    const pubmedDataIdList: XmlArticleIdList = {
      ArticleId: [
        { '#text': '38000001', '@_IdType': 'pubmed' },
        { '#text': '10.1000/pubmeddata', '@_IdType': 'doi' },
      ],
    };
    expect(extractDoi(article, pubmedDataIdList)).toBe('10.1000/pubmeddata');
  });

  it('returns undefined when no DOI exists in any location', () => {
    const article: XmlArticle = {
      ELocationID: { '#text': 'S0140-6736(23)01234-5', '@_EIdType': 'pii', '@_ValidYN': 'Y' },
    };
    expect(extractDoi(article)).toBeUndefined();
  });
});

// ─── extractPublicationTypes ─────────────────────────────────────────────────

describe('extractPublicationTypes', () => {
  it('returns [] when publicationTypeListXml is undefined', () => {
    expect(extractPublicationTypes(undefined)).toEqual([]);
  });

  it('extracts a single publication type', () => {
    const list: XmlPublicationTypeList = {
      PublicationType: { '#text': 'Journal Article', '@_UI': 'D016428' },
    };
    expect(extractPublicationTypes(list)).toEqual(['Journal Article']);
  });

  it('extracts multiple publication types', () => {
    const list: XmlPublicationTypeList = {
      PublicationType: [
        { '#text': 'Journal Article', '@_UI': 'D016428' },
        { '#text': 'Clinical Trial', '@_UI': 'D000068397' },
        { '#text': 'Randomized Controlled Trial', '@_UI': 'D016449' },
      ],
    };
    expect(extractPublicationTypes(list)).toEqual([
      'Journal Article',
      'Clinical Trial',
      'Randomized Controlled Trial',
    ]);
  });

  it('filters out empty publication type strings', () => {
    const list: XmlPublicationTypeList = {
      PublicationType: [{ '#text': 'Journal Article' }, {}],
    };
    const result = extractPublicationTypes(list);
    expect(result).toEqual(['Journal Article']);
    expect(result).toHaveLength(1);
  });
});

// ─── extractKeywords ─────────────────────────────────────────────────────────

describe('extractKeywords', () => {
  it('returns [] when keywordListsXml is undefined', () => {
    expect(extractKeywords(undefined)).toEqual([]);
  });

  it('extracts keywords from a single KeywordList', () => {
    const list: XmlKeywordList = {
      Keyword: [{ '#text': 'cancer' }, { '#text': 'immunotherapy' }],
    };
    expect(extractKeywords(list)).toEqual(['cancer', 'immunotherapy']);
  });

  it('merges keywords from multiple KeywordLists', () => {
    const lists: XmlKeywordList[] = [
      { Keyword: { '#text': 'keyword-a' } },
      { Keyword: [{ '#text': 'keyword-b' }, { '#text': 'keyword-c' }] },
    ];
    expect(extractKeywords(lists)).toEqual(['keyword-a', 'keyword-b', 'keyword-c']);
  });

  it('filters out empty keyword strings', () => {
    const list: XmlKeywordList = {
      Keyword: [{ '#text': 'valid' }, {}],
    };
    expect(extractKeywords(list)).toEqual(['valid']);
  });
});

// ─── extractAbstractText ─────────────────────────────────────────────────────

describe('extractAbstractText', () => {
  it('returns undefined when abstractXml is undefined', () => {
    expect(extractAbstractText(undefined)).toBeUndefined();
  });

  it('returns undefined when AbstractText property is absent', () => {
    const abstract = {} as XmlArticle['Abstract'];
    expect(extractAbstractText(abstract)).toBeUndefined();
  });

  it('extracts a simple text element', () => {
    const abstract: XmlArticle['Abstract'] = {
      AbstractText: { '#text': 'This is the full abstract.' },
    };
    expect(extractAbstractText(abstract)).toBe('This is the full abstract.');
  });

  it('extracts a plain string AbstractText value directly', () => {
    const abstract = {
      AbstractText: 'Plain string abstract.',
    } as unknown as XmlArticle['Abstract'];
    expect(extractAbstractText(abstract)).toBe('Plain string abstract.');
  });

  it('concatenates structured abstract sections with labels', () => {
    const abstract: XmlArticle['Abstract'] = {
      AbstractText: [
        { '#text': 'Cancer remains a major challenge.', '@_Label': 'BACKGROUND' },
        { '#text': 'We enrolled 100 patients.', '@_Label': 'METHODS' },
        { '#text': 'Survival improved significantly.', '@_Label': 'RESULTS' },
      ],
    };
    const result = extractAbstractText(abstract);
    expect(result).toContain('BACKGROUND: Cancer remains a major challenge.');
    expect(result).toContain('METHODS: We enrolled 100 patients.');
    expect(result).toContain('RESULTS: Survival improved significantly.');
  });

  it('returns undefined when all AbstractText elements resolve to empty strings', () => {
    const abstract: XmlArticle['Abstract'] = {
      AbstractText: [{}],
    };
    expect(extractAbstractText(abstract)).toBeUndefined();
  });
});

// ─── extractPmid ─────────────────────────────────────────────────────────────

describe('extractPmid', () => {
  it('returns undefined when medlineCitationXml is undefined', () => {
    expect(extractPmid(undefined)).toBeUndefined();
  });

  it('returns undefined when PMID element is absent', () => {
    const citation = {} as XmlMedlineCitation;
    expect(extractPmid(citation)).toBeUndefined();
  });

  it('extracts PMID from a text element', () => {
    const citation = {
      PMID: { '#text': '38000001' },
    } as unknown as XmlMedlineCitation;
    expect(extractPmid(citation)).toBe('38000001');
  });
});

// ─── extractArticleDates ─────────────────────────────────────────────────────

describe('extractArticleDates', () => {
  it('returns [] when articleXml is undefined', () => {
    expect(extractArticleDates(undefined)).toEqual([]);
  });

  it('returns [] when ArticleDate is absent', () => {
    const article: XmlArticle = {};
    expect(extractArticleDates(article)).toEqual([]);
  });

  it('extracts a single date with all fields', () => {
    const article: XmlArticle = {
      ArticleDate: {
        '@_DateType': 'Electronic',
        Year: { '#text': '2023' },
        Month: { '#text': '06' },
        Day: { '#text': '15' },
      },
    };
    expect(extractArticleDates(article)).toEqual([
      { dateType: 'Electronic', year: '2023', month: '06', day: '15' },
    ]);
  });

  it('extracts multiple dates', () => {
    const article: XmlArticle = {
      ArticleDate: [
        {
          '@_DateType': 'Electronic',
          Year: { '#text': '2023' },
          Month: { '#text': '01' },
          Day: { '#text': '10' },
        },
        {
          '@_DateType': 'Print',
          Year: { '#text': '2023' },
          Month: { '#text': '03' },
          Day: { '#text': '01' },
        },
      ],
    };
    const result = extractArticleDates(article);
    expect(result).toHaveLength(2);
    expect(result[0]?.dateType).toBe('Electronic');
    expect(result[1]?.dateType).toBe('Print');
  });
});

// ─── parseFullArticle ────────────────────────────────────────────────────────

describe('parseFullArticle', () => {
  const makeFullArticle = (): XmlPubmedArticle => ({
    MedlineCitation: {
      PMID: { '#text': '12345678' },
      Article: {
        ArticleTitle: { '#text': 'A Test Article' },
        Abstract: { AbstractText: { '#text': 'Abstract text here.' } },
        AuthorList: {
          Author: {
            LastName: { '#text': 'Doe' },
            ForeName: { '#text': 'Jane' },
            Initials: { '#text': 'J' },
          },
        },
        Journal: {
          Title: { '#text': 'Test Journal' },
          ISOAbbreviation: { '#text': 'Test J' },
          JournalIssue: {
            Volume: { '#text': '10' },
            Issue: { '#text': '2' },
            PubDate: { Year: { '#text': '2023' } },
          },
        },
        PublicationTypeList: {
          PublicationType: { '#text': 'Journal Article' },
        },
        GrantList: {
          Grant: {
            GrantID: { '#text': 'R01-GM000001' },
            Agency: { '#text': 'NIGMS' },
            Country: { '#text': 'US' },
          },
        },
        ELocationID: { '#text': '10.9999/test.2023', '@_EIdType': 'doi', '@_ValidYN': 'Y' },
        KeywordList: {
          Keyword: { '#text': 'test keyword' },
        },
      },
      MeshHeadingList: {
        MeshHeading: {
          DescriptorName: { '#text': 'Models, Theoretical', '@_MajorTopicYN': 'N' },
        },
      },
    },
    PubmedData: {
      ArticleIdList: {
        ArticleId: [
          { '#text': '12345678', '@_IdType': 'pubmed' },
          { '#text': '10.9999/test.2023', '@_IdType': 'doi' },
        ],
      },
    },
  });

  it('combines all extractors into a ParsedArticle', () => {
    const result = parseFullArticle(makeFullArticle());
    expect(result.pmid).toBe('12345678');
    expect(result.title).toBe('A Test Article');
    expect(result.abstractText).toBe('Abstract text here.');
    expect(result.authors).toHaveLength(1);
    expect(result.authors?.[0]?.lastName).toBe('Doe');
    expect(result.journalInfo?.title).toBe('Test Journal');
    expect(result.publicationTypes).toEqual(['Journal Article']);
    expect(result.keywords).toEqual(['test keyword']);
    expect(result.doi).toBe('10.9999/test.2023');
  });

  it('includes meshTerms by default (includeMesh=true)', () => {
    const result = parseFullArticle(makeFullArticle());
    expect(result.meshTerms).toBeDefined();
    expect(result.meshTerms).toHaveLength(1);
    expect(result.meshTerms?.[0]?.descriptorName).toBe('Models, Theoretical');
  });

  it('excludes meshTerms when includeMesh=false', () => {
    const result = parseFullArticle(makeFullArticle(), { includeMesh: false });
    expect(result.meshTerms).toBeUndefined();
  });

  it('excludes grantList by default (includeGrants defaults to false)', () => {
    const result = parseFullArticle(makeFullArticle());
    expect(result.grantList).toBeUndefined();
  });

  it('includes grantList when includeGrants=true', () => {
    const result = parseFullArticle(makeFullArticle(), { includeGrants: true });
    expect(result.grantList).toBeDefined();
    expect(result.grantList).toHaveLength(1);
    expect(result.grantList?.[0]?.grantId).toBe('R01-GM000001');
  });

  it('returns empty pmid string when PMID is absent from MedlineCitation', () => {
    const article = makeFullArticle();
    (article.MedlineCitation as Partial<XmlMedlineCitation>).PMID =
      undefined as unknown as XmlMedlineCitation['PMID'];
    const result = parseFullArticle(article);
    expect(result.pmid).toBe('');
  });
});
