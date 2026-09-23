/**
 * @fileoverview PubMed fetch tool. Fetches full article metadata by PubMed IDs,
 * including abstracts, authors, journal info, and MeSH terms. A zero-padded
 * PMID is fetched and matched as the PMID it spells; `ids` is accepted as an
 * alias for `pmids`.
 * @module src/mcp-server/tools/definitions/fetch-articles.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { NCBI_SERVICE_ERRORS } from '@/services/error-contracts.js';
import { getNcbiService } from '@/services/ncbi/ncbi-service.js';
import { parseArticleSet } from '@/services/ncbi/parsing/article-parser.js';
import { fitWholeItems } from './_budget.js';
import {
  conceptMeta,
  EDAM_DATA_RETRIEVAL,
  EDAM_PUBMED_ID,
  SCHEMA_SCHOLARLY_ARTICLE,
} from './_concepts.js';
import { normalizePmid, pmidStringSchema } from './_schemas.js';
import { escapeMarkdownInline } from './_text.js';

const AuthorSchema = z
  .object({
    lastName: z.string().optional().describe('Last name'),
    firstName: z.string().optional().describe('First/given name'),
    initials: z.string().optional().describe('Author initials'),
    collectiveName: z.string().optional().describe('Group/collective author name'),
    affiliationIndices: z
      .array(z.number())
      .optional()
      .describe('Indices into the top-level affiliations array'),
    orcid: z.string().optional().describe('ORCID identifier'),
  })
  .describe('Author record');

const JournalPublicationDateSchema = z
  .object({
    year: z.string().optional().describe('Publication year'),
    month: z.string().optional().describe('Publication month'),
    day: z.string().optional().describe('Publication day'),
    medlineDate: z.string().optional().describe('Non-standard date string (e.g. "2000 Spring")'),
  })
  .describe('Journal publication date');

const JournalInfoSchema = z
  .object({
    title: z.string().optional().describe('Full journal title'),
    isoAbbreviation: z.string().optional().describe('ISO journal abbreviation'),
    issn: z.string().optional().describe('Print ISSN'),
    eIssn: z.string().optional().describe('Electronic ISSN'),
    volume: z.string().optional().describe('Volume number'),
    issue: z.string().optional().describe('Issue number'),
    pages: z.string().optional().describe('Page range (e.g. "48-55")'),
    elocationId: z
      .string()
      .optional()
      .describe(
        'Electronic article locator from NCBI `ELocationID` — the publisher-assigned article number (e.g. "2400512"). Journals that assign article numbers instead of pages often omit pagination entirely, leaving this the only locator. Never a substitute for `pages`, and never the DOI: a DOI-typed `ELocationID` is reported in `doi` instead. Absent when the only locator NCBI supplies is marked invalid.',
      ),
    elocationIdType: z
      .string()
      .optional()
      .describe(
        'Type of `elocationId`, from NCBI\'s `EIdType` attribute — "pii" in practice. Free-form: NCBI does not close the set, so treat an unfamiliar value as opaque.',
      ),
    publicationDate: JournalPublicationDateSchema.optional(),
  })
  .describe(
    'Journal information. Present on `journal-article` records only — absent on `book-chapter` and `book` records, because a Bookshelf record has no journal and its book title is never reported as one; read `book` for those. (#114)',
  );

const BookEditorSchema = z
  .object({
    lastName: z
      .string()
      .optional()
      .describe(
        'Editor surname, from the book\'s `Book/AuthorList Type="editors"` entry. Absent on a group editor, which carries `collectiveName` instead.',
      ),
    firstName: z
      .string()
      .optional()
      .describe(
        'Editor given name as NCBI supplies it (`ForeName`, often "Margaret P"). Absent when NCBI carries initials only, or on a group editor.',
      ),
    initials: z
      .string()
      .optional()
      .describe(
        'Editor initials with no separators (e.g. "MP"). Absent when NCBI supplies none, or on a group editor.',
      ),
    collectiveName: z
      .string()
      .optional()
      .describe(
        'Group or committee credited as editor, when the entry names an organization rather than a person. Mutually exclusive with the name-part fields.',
      ),
  })
  .describe(
    'One editor of the containing book. Name parts only — editors are a citation credit, not a contributor record, so no affiliations or ORCID are reported for them.',
  );

const BookInfoSchema = z
  .object({
    title: z
      .string()
      .optional()
      .describe(
        'Title of the containing book, from `Book/BookTitle` (e.g. "GeneReviews®"). On a `book` record this is the same value as the record\'s own `title`.',
      ),
    publisher: z
      .string()
      .optional()
      .describe('Publisher of the book, from `Book/Publisher/PublisherName`.'),
    publisherLocation: z
      .string()
      .optional()
      .describe(
        'Place of publication, from `Book/Publisher/PublisherLocation` (e.g. "Seattle (WA)"). Absent when NCBI supplies no place.',
      ),
    pubDate: z
      .string()
      .optional()
      .describe(
        "Publication year from `Book/PubDate`. Year only — NCBI's month and day are not reported, since no citation style uses them for a book.",
      ),
    beginningDate: z
      .string()
      .optional()
      .describe(
        'First year of a continuously-updated book, from `Book/BeginningDate` (GeneReviews runs from 1993). Absent on a book published once.',
      ),
    endingDate: z
      .string()
      .optional()
      .describe(
        'Last year of a closed date range, from `Book/EndingDate`. Absent while a book is still being updated, which leaves the range open-ended.',
      ),
    medium: z
      .string()
      .optional()
      .describe(
        'Medium the book is published in, from `Book/Medium` — "Internet" wherever NCBI supplies it. Absent when NCBI supplies none; it is never defaulted.',
      ),
    edition: z
      .string()
      .optional()
      .describe(
        'Edition statement from `Book/Edition`. Rare on Bookshelf titles — absent unless NCBI supplies one.',
      ),
    collectionTitle: z
      .string()
      .optional()
      .describe(
        'Series the book belongs to, from `Book/CollectionTitle` (e.g. "ADA Clinical Compendia Series"). Absent for a book outside a series.',
      ),
    isbns: z
      .array(z.string().describe('One ISBN, verbatim as NCBI reports it — leading zeros intact'))
      .optional()
      .describe(
        'Every `Book/Isbn` on the record. A book commonly carries a print and an electronic ISBN, so this is a list. Absent for a Bookshelf title with no ISBN, which is most of them.',
      ),
    doi: z
      .string()
      .optional()
      .describe(
        'The book\'s own DOI, from `Book/ELocationID` with `EIdType="doi"`. Distinct from the record-level `doi`, which is the chapter\'s: a chapter does not inherit this one.',
      ),
    editors: z
      .array(BookEditorSchema)
      .optional()
      .describe(
        'Editors of the containing book, from `Book/AuthorList` marked `Type="editors"`. Kept out of `authors`, which carries the chapter\'s own writers. Absent when the book credits no editors.',
      ),
    accession: z
      .string()
      .optional()
      .describe(
        'NCBI Bookshelf accession from `ArticleIdList` (`bookaccession`), e.g. "NBK1247". The record is readable at `https://www.ncbi.nlm.nih.gov/books/<accession>/`.',
      ),
  })
  .describe(
    'The containing book of a `book-chapter`, or the book itself on a `book` record. Present only on those two record types, and never a stand-in for `journalInfo`.',
  );

const MeshQualifierSchema = z
  .object({
    qualifierName: z.string().describe('Qualifier/subheading name'),
    qualifierUi: z.string().optional().describe('Qualifier unique ID'),
    isMajorTopic: z.boolean().describe('Whether this qualifier is a major topic'),
  })
  .describe('MeSH qualifier/subheading');

const MeshTermSchema = z
  .object({
    descriptorName: z.string().optional().describe('MeSH descriptor name'),
    descriptorUi: z.string().optional().describe('MeSH descriptor unique ID'),
    isMajorTopic: z.boolean().describe('Whether this is a major topic of the article'),
    qualifiers: z.array(MeshQualifierSchema).optional().describe('MeSH qualifiers/subheadings'),
  })
  .describe('MeSH descriptor term');

const GrantSchema = z
  .object({
    grantId: z.string().optional().describe('Grant identifier'),
    acronym: z.string().optional().describe('Grant acronym'),
    agency: z.string().optional().describe('Funding agency'),
    country: z.string().optional().describe('Agency country'),
  })
  .describe('Grant record');

const ArticleDateSchema = z
  .object({
    dateType: z.string().optional().describe('Date type'),
    year: z.string().optional().describe('Year'),
    month: z.string().optional().describe('Month'),
    day: z.string().optional().describe('Day'),
  })
  .describe('Dated article event');

const FetchedArticleSchema = z
  .object({
    recordType: z
      .enum(['journal-article', 'book-chapter', 'book'])
      .describe(
        'Which kind of PubMed record this is, set from the XML element it arrived in: `journal-article` for an ordinary article, `book-chapter` for an NCBI Bookshelf chapter, `book` for a whole Bookshelf book. Read this to tell the three apart — `publicationTypes` cannot, because PubMed labels a Bookshelf record "Review" or "Study Guide". `journalInfo` is present only on `journal-article`; `book` only on the other two.',
      ),
    pmid: z.string().optional().describe('PubMed ID'),
    title: z
      .string()
      .optional()
      .describe(
        'Article title — the chapter title on a `book-chapter`, and the book title on a `book` record, where it repeats `book.title`.',
      ),
    abstractText: z.string().optional().describe('Abstract text'),
    affiliations: z.array(z.string()).optional().describe('Deduplicated author affiliations'),
    authors: z
      .array(AuthorSchema)
      .optional()
      .describe(
        "Author list. On a `book-chapter` these are the chapter's own authors, never the book's editors, which are in `book.editors`. Empty on a Bookshelf record that credits neither.",
      ),
    journalInfo: JournalInfoSchema.optional(),
    book: BookInfoSchema.optional(),
    doi: z
      .string()
      .optional()
      .describe(
        "DOI, cased as NCBI reports it (usually the publisher's mixed case). DOIs are case-insensitive by spec and no case normalization is applied here, so the same DOI can arrive in a different case from `pubmed_europepmc_search` and `pubmed_europepmc_fetch` (NCBI `10.1056/NEJMoa2212948`, Europe PMC `10.1056/nejmoa2212948`) — a byte-for-byte comparison across the two reports a false mismatch.",
      ),
    pmcId: z.string().optional().describe('PMC ID'),
    pubmedUrl: z.string().optional().describe('PubMed article URL'),
    pmcUrl: z.string().optional().describe('PMC full text URL'),
    publicationTypes: z.array(z.string()).optional().describe('Publication types'),
    keywords: z.array(z.string()).optional().describe('Keywords'),
    meshTerms: z.array(MeshTermSchema).optional().describe('MeSH terms'),
    grantList: z.array(GrantSchema).optional().describe('Grant information'),
    articleDates: z.array(ArticleDateSchema).optional().describe('Article dates'),
  })
  .describe('Parsed PubMed article');

const DeferredSchema = z
  .object({
    maxResponseCharacters: z
      .number()
      .describe('The `maxResponseCharacters` ceiling this response was budgeted against'),
    returnedCharacters: z
      .number()
      .describe('Serialized characters the returned article records account for'),
    deferredCount: z
      .number()
      .describe('Articles that resolved but were withheld to stay under the ceiling'),
    ids: z
      .array(z.string())
      .describe(
        'PMIDs of the deferred articles, in response order. Re-call `pubmed_fetch_articles` with these as `pmids` and the same other inputs to retrieve them. Never contains a PMID from `unavailablePmids`.',
      ),
    nextDeferredCharacters: z
      .number()
      .describe(
        'Serialized size of the next deferred article — the first entry in `ids`, where the response stopped. Raise `maxResponseCharacters` to at least this to make progress; a smaller article further down `ids` cannot be reached until this one fits.',
      ),
  })
  .describe(
    'Continuation state for articles the whole-response budget withheld. Present only when `maxResponseCharacters` deferred at least one article.',
  );

export const fetchArticlesTool = tool('pubmed_fetch_articles', {
  description:
    'Fetch full article metadata by PubMed IDs. Returns detailed article information including abstract, authors, journal, MeSH terms. Set `maxResponseCharacters` to bound the whole response: articles past the ceiling are deferred whole and listed in `deferred.ids` for a follow-up call.',
  annotations: { readOnlyHint: true, openWorldHint: true },
  _meta: conceptMeta([SCHEMA_SCHOLARLY_ARTICLE, EDAM_DATA_RETRIEVAL, EDAM_PUBMED_ID]),
  sourceUrl:
    'https://github.com/cyanheads/pubmed-mcp-server/blob/main/src/mcp-server/tools/definitions/fetch-articles.tool.ts',

  errors: [
    ...NCBI_SERVICE_ERRORS,
    {
      reason: 'invalid_efetch_response',
      code: JsonRpcErrorCode.SerializationError,
      when: 'NCBI EFetch returned a payload missing the PubmedArticleSet wrapper.',
      recovery:
        'Retry once; if it persists, NCBI returned malformed data — try fewer PMIDs at once.',
    },
  ] as const,

  // Never advertised; rewritten to the canonical key before the schema parses. (#156)
  inputAliases: { ids: 'pmids' },

  input: z.object({
    pmids: z.array(pmidStringSchema).min(1).max(200).describe('PubMed IDs to fetch'),
    includeMesh: z.boolean().default(true).describe('Include MeSH terms'),
    includeGrants: z.boolean().default(false).describe('Include grant information'),
    maxResponseCharacters: z
      .number()
      .int()
      .min(1)
      .max(1_000_000)
      .optional()
      .describe(
        'Opt-in ceiling for the whole response, in characters. Each article is measured as the JSON record it is returned as — title, abstract, authors, journal, MeSH terms, grants, identifiers, every field it carries. Articles are kept in response order until the next one would cross the ceiling; that article and the rest are deferred whole (never partially populated) and listed in `deferred.ids`. Response envelope fields — counts, `unavailablePmids`, `deferred` itself — are not counted. Omit to return every resolved article.',
      ),
  }),

  output: z.object({
    articles: z.array(FetchedArticleSchema).describe('Parsed articles'),
    totalReturned: z
      .number()
      .describe(
        'Number of articles in this response. Under a `maxResponseCharacters` budget this counts the kept articles only; `deferred.deferredCount` covers the rest.',
      ),
    unavailablePmids: z
      .array(z.string())
      .optional()
      .describe(
        'PMIDs PubMed returned no record for. That is all this reports: PubMed omits an unknown PMID silently, with no error and no reason, so the absence says nothing about whether the PMID exists. Reported in full regardless of where a `maxResponseCharacters` cutoff lands — these are misses, not deferrals. Use `pubmed_search_articles` to find PMIDs that do resolve.',
      ),
    deferred: DeferredSchema.optional(),
  }),

  // Recovery guidance for two cases — no articles returned at all, and articles
  // the whole-response budget deferred (#99). Agent-facing context surfaced via
  // ctx.enrich to both structuredContent and content[]; absent on a plain success.
  enrichment: {
    notice: z
      .string()
      .optional()
      .describe(
        'Optional guidance when no articles were returned — points to discovery tools — or when `maxResponseCharacters` deferred articles, naming how to retrieve them. Absent on successful unbudgeted fetches.',
      ),
    truncated: z
      .boolean()
      .optional()
      .describe(
        'True when `maxResponseCharacters` withheld at least one resolved article. Absent when the response carries every article that resolved. The continuation state is in `deferred`.',
      ),
  },

  async handler(input, ctx) {
    ctx.log.info('Executing pubmed_fetch', { pmidCount: input.pmids.length });

    // NCBI reads `00000001` as PMID 1 and answers with `<PMID>1</PMID>`, so the
    // request and the unavailability diff below both use the canonical form;
    // `unavailablePmids` still reports the caller's own spelling. (#161)
    const requested = [...new Set(input.pmids.map(normalizePmid))];

    const xmlData = await getNcbiService().eFetch(
      { db: 'pubmed', id: requested.join(','), retmode: 'xml' },
      { retmode: 'xml', usePost: requested.length >= 100, signal: ctx.signal },
    );

    if (!xmlData || !('PubmedArticleSet' in xmlData)) {
      throw ctx.fail(
        'invalid_efetch_response',
        'Invalid EFetch response from NCBI: missing PubmedArticleSet',
        { requestedPmids: input.pmids.length, ...ctx.recoveryFor('invalid_efetch_response') },
      );
    }

    // Reads both members of the set. Taking `PubmedArticleSet.PubmedArticle`
    // alone discards every NCBI Bookshelf record, whose PMIDs then surface as
    // unavailable even though PubMed returned them. (#114)
    const articles = parseArticleSet(xmlData.PubmedArticleSet, {
      includeMesh: input.includeMesh,
      includeGrants: input.includeGrants,
    }).map((parsed) => ({
      ...parsed,
      pubmedUrl: `https://pubmed.ncbi.nlm.nih.gov/${parsed.pmid}/`,
      ...(parsed.pmcId && {
        pmcUrl: `https://www.ncbi.nlm.nih.gov/pmc/articles/${parsed.pmcId}/`,
      }),
    }));

    const returnedPmids = new Set(articles.map((a) => a.pmid).filter(Boolean));
    const unavailable = input.pmids.filter((id) => !returnedPmids.has(normalizePmid(id)));

    // Whole-response budget: fill with complete records in response order and
    // hand the remainder back as PMIDs the caller can re-submit. Without
    // `maxResponseCharacters` nothing is measured and the response is exactly
    // what it was before the budget existed. (#99)
    const ceiling = input.maxResponseCharacters;
    const fit = ceiling === undefined ? undefined : fitWholeItems(articles, ceiling);
    const returned = fit?.kept ?? articles;
    const nextDeferredCharacters = fit?.nextDeferredCharacters;
    // A record whose PMID never parsed is already reported in `unavailablePmids`
    // and is not something a caller can re-request, so it is not deferrable —
    // the count is the list's length so the two can never disagree.
    const deferredIds = (fit?.deferred ?? []).map((a) => a.pmid).filter((id) => id.length > 0);
    const deferred =
      ceiling !== undefined && fit && nextDeferredCharacters !== undefined
        ? {
            maxResponseCharacters: ceiling,
            returnedCharacters: fit.keptCharacters,
            deferredCount: deferredIds.length,
            ids: deferredIds,
            nextDeferredCharacters,
          }
        : undefined;

    ctx.log.info('pubmed_fetch completed', {
      requested: input.pmids.length,
      returned: returned.length,
      ...(deferred && { deferred: deferred.deferredCount }),
    });
    // Keyed on what resolved, not on what the budget kept: a batch emptied by a
    // small ceiling is a budget outcome, not a batch of invalid PMIDs.
    if (articles.length === 0) {
      ctx.enrich.notice(
        'No articles were returned: PubMed matched no record to any of these PMIDs. It omits a PMID it does not recognize silently, without an error or a reason, so nothing more than that is known here. Try pubmed_search_articles to discover PMIDs that resolve.',
      );
    }
    if (deferred) {
      ctx.enrich({ truncated: true });
      ctx.enrich.notice(buildDeferralNotice(deferred));
    }
    return {
      articles: returned,
      totalReturned: returned.length,
      ...(unavailable.length > 0 && { unavailablePmids: unavailable }),
      ...(deferred && { deferred }),
    };
  },

  format: (result) => {
    const lines = [`## PubMed Articles`, `**Articles Returned:** ${result.totalReturned}`];
    if (result.unavailablePmids?.length) {
      lines.push(`**Unavailable PMIDs:** ${result.unavailablePmids.join(', ')}`);
    }
    if (result.deferred) {
      const d = result.deferred;
      lines.push(
        `**Deferred by the response budget:** ${d.deferredCount} article(s) — ${d.returnedCharacters} of ${d.maxResponseCharacters} budgeted characters returned; next deferred article ${d.nextDeferredCharacters} characters`,
        `Re-call \`pubmed_fetch_articles\` with these PMIDs: ${d.ids.join(', ')}`,
      );
    }
    for (const a of result.articles) {
      // Render-time only — `structuredContent.articles[].title` keeps the
      // plain-text value the NCBI parser produced. (#102)
      lines.push(`\n### ${escapeMarkdownInline(a.title ?? a.pmid ?? 'Unknown')}`);

      if (a.authors?.length) {
        lines.push(`\n**Authors (${a.authors.length}):**`);
        for (const au of a.authors) {
          lines.push(`- ${formatAuthor(au)}`);
        }
      }

      if (a.affiliations?.length) {
        lines.push(`\n**Affiliations:**`);
        for (const [i, aff] of a.affiliations.entries()) {
          lines.push(`- [${i}] ${aff}`);
        }
      }

      const ji = a.journalInfo;
      if (ji) {
        const parts: string[] = [];
        if (ji.title) parts.push(ji.title);
        if (ji.isoAbbreviation && ji.isoAbbreviation !== ji.title) {
          parts.push(ji.title ? `(${ji.isoAbbreviation})` : ji.isoAbbreviation);
        }
        const pubDateStr = formatPublicationDate(ji.publicationDate);
        if (pubDateStr) parts.push(pubDateStr);
        if (ji.volume) parts.push(`**${ji.volume}**${ji.issue ? `(${ji.issue})` : ''}`);
        if (ji.pages) parts.push(ji.pages);
        if (ji.elocationId) {
          parts.push(
            ji.elocationIdType ? `${ji.elocationIdType}: ${ji.elocationId}` : ji.elocationId,
          );
        }
        if (ji.issn) parts.push(`ISSN ${ji.issn}`);
        if (ji.eIssn) parts.push(`eISSN ${ji.eIssn}`);
        if (parts.length) lines.push(`\n**Journal:** ${parts.join(', ')}`);
      }

      // Venue block for a Bookshelf record. `journalInfo` is never set on one,
      // so a book would otherwise render as a bare title with no publisher,
      // date or permalink — the fields a citation actually needs. (#114)
      const bk = a.book;
      if (bk) {
        const bookLines: string[] = [];
        // On a whole-book record the heading above already is the book title;
        // the medium marker then stands alone rather than repeating it.
        if (a.recordType !== 'book' && bk.title) {
          bookLines.push(`**Book:** ${bk.medium ? `${bk.title} [${bk.medium}]` : bk.title}`);
        } else if (bk.medium) {
          bookLines.push(`**Medium:** ${bk.medium}`);
        }
        if (bk.editors?.length) {
          bookLines.push('', `**Editors (${bk.editors.length}):**`);
          for (const ed of bk.editors) {
            bookLines.push(`- ${formatAuthor(ed)}`);
          }
        }
        if (bk.publisher) bookLines.push(`**Publisher:** ${bk.publisher}`);
        if (bk.publisherLocation) bookLines.push(`**Publisher Location:** ${bk.publisherLocation}`);
        // A book published over several years carries a closed range
        // (GeneReviews 1993–2026); otherwise the single publication year. A
        // publication year that differs from the range's start is kept beside it.
        const range =
          bk.beginningDate && bk.endingDate && bk.beginningDate !== bk.endingDate
            ? `${bk.beginningDate}–${bk.endingDate}`
            : undefined;
        const bookDate =
          range && bk.pubDate && bk.pubDate !== bk.beginningDate
            ? `${bk.pubDate} (${range})`
            : (range ?? bk.pubDate ?? bk.beginningDate ?? bk.endingDate);
        if (bookDate) bookLines.push(`**Published:** ${bookDate}`);
        if (bk.edition) bookLines.push(`**Edition:** ${bk.edition}`);
        if (bk.collectionTitle) bookLines.push(`**Collection:** ${bk.collectionTitle}`);
        if (bk.isbns?.length) bookLines.push(`**ISBN:** ${bk.isbns.join(', ')}`);
        if (bk.doi) bookLines.push(`**Book DOI:** ${bk.doi}`);
        if (bk.accession) {
          bookLines.push(`**Bookshelf:** https://www.ncbi.nlm.nih.gov/books/${bk.accession}/`);
        }
        if (bookLines.length > 0) lines.push('', ...bookLines);
      }

      lines.push(`**Record Type:** ${a.recordType}`);
      if (a.publicationTypes?.length) lines.push(`**Type:** ${a.publicationTypes.join(', ')}`);
      if (a.pmid) lines.push(`**PMID:** ${a.pmid}`);
      if (a.doi) lines.push(`**DOI:** ${a.doi}`);
      if (a.pmcId) lines.push(`**PMCID:** ${a.pmcId}`);
      if (a.pubmedUrl) lines.push(`**PubMed:** ${a.pubmedUrl}`);
      if (a.pmcUrl) lines.push(`**PMC:** ${a.pmcUrl}`);

      if (a.articleDates?.length) {
        lines.push(`**Article Dates:** ${a.articleDates.map(formatArticleDate).join('; ')}`);
      }

      if (a.abstractText) lines.push(`\n#### Abstract\n${a.abstractText}`);
      if (a.keywords?.length) lines.push(`\n**Keywords:** ${a.keywords.join(', ')}`);
      if (a.meshTerms?.length) {
        lines.push(`\n#### MeSH Terms`);
        for (const m of a.meshTerms) {
          const descriptor = m.descriptorUi
            ? `${m.descriptorName} [${m.descriptorUi}]`
            : m.descriptorName;
          const major = m.isMajorTopic ? ' (major)' : '';
          const qualifiers = m.qualifiers?.length
            ? ` (${m.qualifiers
                .map((q) => {
                  const name = q.qualifierUi
                    ? `${q.qualifierName} [${q.qualifierUi}]`
                    : q.qualifierName;
                  return `${name}${q.isMajorTopic ? ' (major)' : ''}`;
                })
                .join(', ')})`
            : '';
          lines.push(`- ${descriptor}${major}${qualifiers}`);
        }
      }
      if (a.grantList?.length) {
        lines.push(`\n#### Grants`);
        for (const g of a.grantList) {
          const grantId =
            g.grantId && g.acronym ? `${g.grantId} (${g.acronym})` : (g.grantId ?? g.acronym ?? '');
          const parts = [grantId, g.agency, g.country].filter(Boolean);
          lines.push(`- ${parts.join(' — ')}`);
        }
      }
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});

/**
 * Compose the recovery notice for a response the whole-response budget bounded.
 * Names what was spent, which PMIDs are still retrievable, and the ceiling the
 * next call has to clear — so a caller reading only `content[]` can resume
 * without inspecting `deferred`. (#99)
 */
function buildDeferralNotice(deferred: z.infer<typeof DeferredSchema>): string {
  const spent =
    deferred.returnedCharacters === 0
      ? `No article fits the requested maxResponseCharacters of ${deferred.maxResponseCharacters}, so none were returned.`
      : `Response character budget reached: ${deferred.returnedCharacters} of ${deferred.maxResponseCharacters} characters returned.`;
  return `${spent} ${deferred.deferredCount} resolved article(s) were deferred whole: ${deferred.ids.join(', ')}. Re-call pubmed_fetch_articles with those PMIDs to retrieve them, or raise maxResponseCharacters to at least ${deferred.nextDeferredCharacters} — the size of the next deferred article.`;
}

type FormattedAuthor = {
  collectiveName?: string | undefined;
  lastName?: string | undefined;
  firstName?: string | undefined;
  initials?: string | undefined;
  affiliationIndices?: number[] | undefined;
  orcid?: string | undefined;
};

function formatAuthor(au: FormattedAuthor): string {
  const parts: string[] = [];
  if (au.collectiveName) parts.push(`${au.collectiveName} (collective)`);

  const name = [au.firstName, au.lastName].filter(Boolean).join(' ');
  if (name) parts.push(name);
  else if (au.initials) parts.push(au.initials);
  if (au.initials && name) parts.push(`(${au.initials})`);

  if (au.affiliationIndices?.length) {
    parts.push(`[aff ${au.affiliationIndices.join(',')}]`);
  }
  if (au.orcid) parts.push(`· ORCID ${au.orcid}`);
  return parts.join(' ') || 'Unknown';
}

type FormattedPubDate = {
  year?: string | undefined;
  month?: string | undefined;
  day?: string | undefined;
  medlineDate?: string | undefined;
};

function formatPublicationDate(pd: FormattedPubDate | undefined): string | undefined {
  if (!pd) return;
  const ymd = [pd.year, pd.month, pd.day].filter(Boolean).join(' ');
  if (pd.medlineDate && ymd) return `${pd.medlineDate} (${ymd})`;
  return pd.medlineDate || ymd || undefined;
}

type FormattedArticleDate = {
  dateType?: string | undefined;
  year?: string | undefined;
  month?: string | undefined;
  day?: string | undefined;
};

function formatArticleDate(ad: FormattedArticleDate): string {
  const datePart = [ad.year, ad.month, ad.day].filter(Boolean).join('-');
  return ad.dateType ? `${ad.dateType} ${datePart}` : datePart;
}
