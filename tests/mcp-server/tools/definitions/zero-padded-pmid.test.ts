/**
 * @fileoverview Regression for issue #161 — a zero-padded PMID is the PMID it spells.
 * NCBI EFetch parses `00000001` as PMID 1 and answers with `<PMID>1</PMID>`, and
 * the PMC ID Converter parses it to `pmid: 1` but reports it "not found in PMC",
 * so every tool that diffs the caller's strings against upstream PMIDs has to
 * compare — and send — the canonical form.
 *
 * Runs each PMID consumer against the real NcbiService behind a stubbed global
 * fetch that answers the way NCBI does: numeric ID parsing, one record per
 * distinct PMID, the `ID list is empty!` envelope when nothing in the list is a
 * UID, an ID Converter that resolves only the canonical spelling and answers a
 * repeated ID once, and an ELink `pubmed_pubmed` neighbor list that leads with
 * the source article itself.
 *
 * Pinned reporting: records carry NCBI's canonical PMID; `unavailablePmids`,
 * `unavailable[].id`, `pubmed_fetch_fulltext`'s `deferred.ids`, and
 * `pubmed_convert_ids`' `requestedId` carry the caller's own string, so each
 * can be matched back to what was submitted.
 * @module tests/mcp-server/tools/definitions/zero-padded-pmid.test
 */

import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { textBlocks } from '../../../_helpers.js';
import { articleSetXml } from '../../../services/ncbi/parsing/_book-fixtures.js';

vi.mock('@cyanheads/mcp-ts-core/utils', async () => {
  const actual = await vi.importActual<typeof import('@cyanheads/mcp-ts-core/utils')>(
    '@cyanheads/mcp-ts-core/utils',
  );
  return {
    ...actual,
    logger: { debug: vi.fn(), info: vi.fn(), notice: vi.fn(), warning: vi.fn(), error: vi.fn() },
    requestContextService: { createRequestContext: vi.fn(() => ({ requestId: 'test' })) },
  };
});

// Before the tool modules load: one of them reads the server config at import time.
vi.stubEnv('NCBI_API_KEY', '');
vi.stubEnv('NCBI_REQUEST_DELAY_MS', '50');

const { initNcbiService } = await import('@/services/ncbi/ncbi-service.js');
const { fetchArticlesTool } = await import('@/mcp-server/tools/definitions/fetch-articles.tool.js');
const { formatCitationsTool } = await import(
  '@/mcp-server/tools/definitions/format-citations.tool.js'
);
const { fetchFulltextTool } = await import('@/mcp-server/tools/definitions/fetch-fulltext.tool.js');
const { findRelatedTool } = await import('@/mcp-server/tools/definitions/find-related.tool.js');
const { convertIdsTool } = await import('@/mcp-server/tools/definitions/convert-ids.tool.js');

/** PubMed records the stub knows, keyed by canonical PMID. Trimmed from the live records. */
const PUBMED_RECORDS: Record<string, string> = {
  '1': '<PubmedArticle><MedlineCitation Status="MEDLINE" Owner="NLM"><PMID Version="1">1</PMID><Article PubModel="Print"><Journal><ISSN IssnType="Print">0006-2944</ISSN><JournalIssue CitedMedium="Print"><Volume>13</Volume><Issue>2</Issue><PubDate><Year>1975</Year><Month>Jun</Month></PubDate></JournalIssue><Title>Biochemical medicine</Title><ISOAbbreviation>Biochem Med</ISOAbbreviation></Journal><ArticleTitle>Formate assay in body fluids: application in methanol poisoning.</ArticleTitle><Pagination><MedlinePgn>117-26</MedlinePgn></Pagination><AuthorList CompleteYN="Y"><Author ValidYN="Y"><LastName>Makar</LastName><ForeName>A B</ForeName><Initials>AB</Initials></Author><Author ValidYN="Y"><LastName>McMartin</LastName><ForeName>K E</ForeName><Initials>KE</Initials></Author></AuthorList><Language>eng</Language><PublicationTypeList><PublicationType UI="D016428">Journal Article</PublicationType></PublicationTypeList></Article></MedlineCitation><PubmedData><ArticleIdList><ArticleId IdType="pubmed">1</ArticleId><ArticleId IdType="doi">10.1016/0006-2944(75)90147-7</ArticleId></ArticleIdList></PubmedData></PubmedArticle>',
  '23193287':
    '<PubmedArticle><MedlineCitation Status="MEDLINE" Owner="NLM"><PMID Version="1">23193287</PMID><Article PubModel="Print-Electronic"><Journal><ISSN IssnType="Electronic">1362-4962</ISSN><JournalIssue CitedMedium="Internet"><Volume>41</Volume><Issue>Database issue</Issue><PubDate><Year>2013</Year><Month>Jan</Month></PubDate></JournalIssue><Title>Nucleic acids research</Title><ISOAbbreviation>Nucleic Acids Res</ISOAbbreviation></Journal><ArticleTitle>GenBank.</ArticleTitle><Pagination><MedlinePgn>D36-42</MedlinePgn></Pagination><ELocationID EIdType="doi" ValidYN="Y">10.1093/nar/gks1195</ELocationID><AuthorList CompleteYN="Y"><Author ValidYN="Y"><LastName>Benson</LastName><ForeName>Dennis A</ForeName><Initials>DA</Initials></Author></AuthorList><Language>eng</Language><PublicationTypeList><PublicationType UI="D016428">Journal Article</PublicationType></PublicationTypeList></Article></MedlineCitation><PubmedData><ArticleIdList><ArticleId IdType="pubmed">23193287</ArticleId><ArticleId IdType="pmc">PMC3531190</ArticleId><ArticleId IdType="doi">10.1093/nar/gks1195</ArticleId></ArticleIdList></PubmedData></PubmedArticle>',
};

/** PMC counterparts the stub's ID Converter knows, keyed by canonical PMID. */
const PMC_BY_PMID: Record<string, { pmcid: string; doi: string }> = {
  '23193287': { pmcid: 'PMC3531190', doi: '10.1093/nar/gks1195' },
};

/** PMC JATS the stub serves for `db=pmc`, keyed by bare PMC digits. */
const PMC_ARTICLES: Record<string, string> = {
  '3531190':
    '<article article-type="research-article"><front><article-meta><article-id pub-id-type="pmcid">PMC3531190</article-id><article-id pub-id-type="pmid">23193287</article-id><article-id pub-id-type="doi">10.1093/nar/gks1195</article-id><title-group><article-title>GenBank</article-title></title-group></article-meta></front><body><sec><title>Introduction</title><p>GenBank is a comprehensive public database of nucleotide sequences.</p></sec></body></article>',
};

const EMPTY_ID_LIST =
  '<?xml version="1.0" encoding="UTF-8" ?>\n<!DOCTYPE eEfetchResult PUBLIC "-//NLM//DTD efetch 20131226//EN" "https://eutils.ncbi.nlm.nih.gov/eutils/dtd/20131226/efetch.dtd">\n<eFetchResult>\n\t<ERROR>ID list is empty! Possibly it has no correct IDs.</ERROR>\n</eFetchResult>\n';

/** NCBI's reading of an ID: the decimal number its digits spell. */
const asUid = (id: string) => BigInt(id).toString();

/** EFetch `db=pubmed`: one record per distinct known UID, the empty-list envelope when no ID is a UID. */
function pubmedEFetch(ids: string[]): Response {
  const uids = [...new Set(ids.map(asUid))];
  if (uids.every((uid) => uid === '0')) return new Response(EMPTY_ID_LIST, { status: 400 });
  const records = uids.flatMap((uid) => PUBMED_RECORDS[uid] ?? []);
  return new Response(articleSetXml(...records), { status: 200 });
}

/** EFetch `db=pmc`: the JATS articles the stub knows. */
function pmcEFetch(ids: string[]): Response {
  const articles = ids.flatMap((id) => PMC_ARTICLES[id.replace(/^PMC/i, '')] ?? []);
  return new Response(
    `<?xml version="1.0"?><pmc-articleset>${articles.join('')}</pmc-articleset>`,
    {
      status: 200,
    },
  );
}

/**
 * PMC ID Converter: resolves only the canonical spelling, and answers a repeated
 * ID once, as the live service does.
 */
function idConvert(ids: string[]): Response {
  const records = [...new Set(ids)].map((requested) => {
    const uid = asUid(requested);
    const pmc = PMC_BY_PMID[uid];
    return pmc && requested === uid
      ? { pmid: Number(uid), 'requested-id': requested, pmcid: pmc.pmcid, doi: pmc.doi }
      : {
          pmid: Number(uid),
          'requested-id': requested,
          status: 'error',
          errmsg: 'Identifier not found in PMC',
        };
  });
  return Response.json({ status: 'ok', records });
}

/** Neighbors ELink lists after the source for `pubmed_pubmed`, from the live answer for 34265844. */
const SIMILAR_NEIGHBORS = ['34599769', '34884640'];

/**
 * ELink `cmd=neighbor`: the source parsed as the number it spells, echoed in
 * `IdList`, and — for `pubmed_pubmed` — listed first among its own neighbors.
 */
function eLink(url: URL): Response {
  const uid = asUid(url.searchParams.get('id') ?? '');
  const linkName = url.searchParams.get('linkname') ?? 'pubmed_pubmed';
  const links = linkName === 'pubmed_pubmed' ? [uid, ...SIMILAR_NEIGHBORS] : SIMILAR_NEIGHBORS;
  const linkXml = links.map((id) => `<Link><Id>${id}</Id></Link>`).join('');
  return new Response(
    `<?xml version="1.0" encoding="UTF-8" ?><eLinkResult><LinkSet><DbFrom>pubmed</DbFrom><IdList><Id>${uid}</Id></IdList><LinkSetDb><DbTo>pubmed</DbTo><LinkName>${linkName}</LinkName>${linkXml}</LinkSetDb></LinkSet></eLinkResult>`,
    { status: 200 },
  );
}

/** ESummary version 2.0: one journal-article summary per distinct UID. */
function eSummary(ids: string[]): Response {
  const docs = [...new Set(ids.map(asUid))]
    .map(
      (uid) =>
        `<DocumentSummary uid="${uid}"><PubDate>2021</PubDate><Source>Nature</Source><Title>Record ${uid}.</Title><DocType>citation</DocType></DocumentSummary>`,
    )
    .join('');
  return new Response(
    `<?xml version="1.0" encoding="UTF-8" ?><eSummaryResult><DocumentSummarySet status="OK">${docs}</DocumentSummarySet></eSummaryResult>`,
    { status: 200 },
  );
}

let fetchSpy: ReturnType<typeof vi.spyOn>;

/** Every request the stub answered, as parsed URLs. */
const requests = (): URL[] =>
  fetchSpy.mock.calls.map((args: unknown[]) => new URL(String(args[0])));

beforeAll(() => {
  fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = new URL(String(input));
    const ids = (url.searchParams.get('id') ?? url.searchParams.get('ids') ?? '').split(',');
    if (url.pathname.endsWith('/efetch.fcgi')) {
      return url.searchParams.get('db') === 'pmc' ? pmcEFetch(ids) : pubmedEFetch(ids);
    }
    if (url.pathname.includes('idconv')) return idConvert(ids);
    if (url.pathname.endsWith('/elink.fcgi')) return eLink(url);
    if (url.pathname.endsWith('/esummary.fcgi')) return eSummary(ids);
    throw new Error(`unexpected request ${url.href}`);
  });
  initNcbiService();
});

beforeEach(() => {
  fetchSpy.mockClear();
});

afterAll(() => {
  fetchSpy.mockRestore();
  vi.unstubAllEnvs();
});

const textOf = (blocks: Parameters<typeof textBlocks>[0]) =>
  textBlocks(blocks)
    .map((b) => b.text)
    .join('\n');

describe('pubmed_fetch_articles with zero-padded PMIDs', () => {
  async function fetchArticles(pmids: string[], extra: { maxResponseCharacters?: number } = {}) {
    const ctx = createMockContext({ errors: fetchArticlesTool.errors });
    const result = await fetchArticlesTool.handler(
      fetchArticlesTool.input.parse({ pmids, includeMesh: false, ...extra }),
      ctx,
    );
    return { result, ctx, text: textOf(fetchArticlesTool.format?.(result) ?? []) };
  }

  it('returns the record a padded PMID names and never also lists it unavailable', async () => {
    const { result, text } = await fetchArticles(['00000001']);

    expect(result.articles.map((a) => a.pmid)).toEqual(['1']);
    expect(result.unavailablePmids).toBeUndefined();
    expect(text).not.toContain('Unavailable PMIDs');
    expect(requests().map((u) => u.searchParams.get('id'))).toEqual(['1']);
  });

  it('treats two spellings of one PMID as one record, with neither reported unavailable', async () => {
    const { result, text } = await fetchArticles(['1', '00000001']);

    expect(result.articles.map((a) => a.pmid)).toEqual(['1']);
    expect(result.totalReturned).toBe(1);
    expect(result.unavailablePmids).toBeUndefined();
    expect(text).not.toContain('Unavailable PMIDs');
    expect(requests().map((u) => u.searchParams.get('id'))).toEqual(['1']);
  });

  it('reports only the misses in a mixed padded/unpadded/unknown batch, under the caller’s spelling', async () => {
    const { result, text } = await fetchArticles(['00000001', '23193287', '099999999', '99999999']);

    expect(result.articles.map((a) => a.pmid)).toEqual(['1', '23193287']);
    expect(result.unavailablePmids).toEqual(['099999999', '99999999']);
    expect(text).toContain('**Unavailable PMIDs:** 099999999, 99999999');
    expect(text).toContain('**PMID:** 1');
  });

  it('keeps the all-zero PMID on the empty-set path (issue #155), requested as 0', async () => {
    const { result, ctx, text } = await fetchArticles(['00000000']);

    expect(result).toEqual({ articles: [], totalReturned: 0, unavailablePmids: ['00000000'] });
    expect(getEnrichment(ctx)?.notice).toMatch(/No articles were returned/);
    expect(text).toContain('**Unavailable PMIDs:** 00000000');
    expect(requests().map((u) => u.searchParams.get('id'))).toEqual(['0']);
  });
});

describe('pubmed_format_citations with zero-padded PMIDs', () => {
  async function formatCitations(pmids: string[]) {
    const ctx = createMockContext({ errors: formatCitationsTool.errors });
    const result = await formatCitationsTool.handler(
      formatCitationsTool.input.parse({ pmids }),
      ctx,
    );
    return { result, ctx, text: textOf(formatCitationsTool.format?.(result) ?? []) };
  }

  it('cites a padded PMID without also listing it unavailable', async () => {
    const { result, text } = await formatCitations(['00000001', '23193287']);

    expect(result.citations.map((c) => c.pmid)).toEqual(['1', '23193287']);
    expect(result).toMatchObject({ totalSubmitted: 2, totalFormatted: 2 });
    expect(result.unavailablePmids).toBeUndefined();
    expect(text).toContain('**Formatted:** 2/2');
    expect(text).not.toContain('Unavailable PMIDs');
  });

  it('cites two spellings of one PMID once, with neither reported unavailable', async () => {
    const { result, text } = await formatCitations(['1', '00000001']);

    expect(result.citations.map((c) => c.pmid)).toEqual(['1']);
    expect(result).toMatchObject({ totalSubmitted: 2, totalFormatted: 1 });
    expect(result.unavailablePmids).toBeUndefined();
    expect(text).not.toContain('Unavailable PMIDs');
    expect(requests().map((u) => u.searchParams.get('id'))).toEqual(['1']);
  });

  it('reports only the misses in a mixed batch, under the caller’s spelling', async () => {
    const { result, text } = await formatCitations(['0023193287', '1', '000099999999']);

    expect(result.citations.map((c) => c.pmid)).toEqual(['23193287', '1']);
    expect(result.unavailablePmids).toEqual(['000099999999']);
    expect(text).toContain('**Unavailable PMIDs:** 000099999999');
  });

  it('keeps the all-zero PMID on the empty-set path (issue #155)', async () => {
    const { result, text } = await formatCitations(['00000000']);

    expect(result).toEqual({
      citations: [],
      totalSubmitted: 1,
      totalFormatted: 0,
      unavailablePmids: ['00000000'],
    });
    expect(text).toContain('**Unavailable PMIDs:** 00000000');
    expect(requests().map((u) => u.searchParams.get('id'))).toEqual(['0']);
  });
});

describe('pubmed_fetch_fulltext `pmids` with zero-padded PMIDs', () => {
  async function fetchFulltext(pmids: string[], extra: { maxResponseCharacters?: number } = {}) {
    const ctx = createMockContext({ errors: fetchFulltextTool.errors });
    const result = await fetchFulltextTool.handler(
      fetchFulltextTool.input.parse({ pmids, ...extra }),
      ctx,
    );
    return { result, ctx, text: textOf(fetchFulltextTool.format?.(result) ?? []) };
  }

  it('reaches the PMC tier for a padded PMID that has a PMC counterpart', async () => {
    const { result, text } = await fetchFulltext(['0023193287']);

    expect(result.articles).toHaveLength(1);
    expect(result.articles[0]).toMatchObject({
      source: 'pmc',
      viaSource: 'pmc',
      pmcId: 'PMC3531190',
      pmid: '23193287',
    });
    expect(result.unavailable).toBeUndefined();
    expect(text).toContain('**PMCID:** PMC3531190');
    expect(text).not.toContain('Unavailable');
    const converted = requests().filter((u) => u.pathname.includes('idconv'));
    expect(converted.map((u) => u.searchParams.get('ids'))).toEqual(['23193287']);
  });

  it('returns one article for two spellings of one PMID and reports neither unavailable', async () => {
    const { result } = await fetchFulltext(['23193287', '0023193287']);

    expect(result.articles.map((a) => a.pmid)).toEqual(['23193287']);
    expect(result.unavailable).toBeUndefined();
  });

  it('reads the same for a padded PMID with no PMC counterpart as for the unpadded one', async () => {
    const padded = await fetchFulltext(['00000001']);
    const plain = await fetchFulltext(['1']);

    expect(padded.result.unavailable).toHaveLength(1);
    expect(padded.result.unavailable?.[0]?.id).toBe('00000001');
    // Nothing about the chain may differ: the ID Converter's answer is recorded
    // on this id, and the DOI PubMed carries for PMID 1 is found, so the
    // unconfigured Unpaywall tier is reported as skipped, not as `no-doi`.
    expect(padded.result.unavailable?.[0]?.triedTiers).toEqual([
      { tier: 'pmc', outcome: 'not-attempted', detail: 'PMID has no PMC counterpart' },
      { tier: 'europepmc', outcome: 'not-attempted', detail: 'EUROPEPMC_ENABLED=false' },
      { tier: 'unpaywall', outcome: 'not-attempted', detail: 'UNPAYWALL_EMAIL is not set' },
    ]);
    expect(padded.result).toEqual({
      ...plain.result,
      unavailable: plain.result.unavailable?.map((u) => ({ ...u, id: '00000001' })),
    });
    expect(padded.text).toBe(plain.text.replace('[pmid] 1 —', '[pmid] 00000001 —'));
  });

  it('lists each caller spelling of an unrecoverable PMID, with one upstream lookup', async () => {
    const { result } = await fetchFulltext(['1', '00000001']);

    expect(result.unavailable?.map((u) => u.id)).toEqual(['1', '00000001']);
    expect(result.unavailable?.[0]?.triedTiers).toEqual(result.unavailable?.[1]?.triedTiers);
    const converted = requests().filter((u) => u.pathname.includes('idconv'));
    expect(converted.map((u) => u.searchParams.get('ids'))).toEqual(['1']);
  });

  it('hands a deferred article back under the caller’s spelling', async () => {
    const { result, text } = await fetchFulltext(['0023193287'], { maxResponseCharacters: 1 });

    expect(result.articles).toEqual([]);
    expect(result.deferred).toMatchObject({
      idType: 'pmid',
      ids: ['0023193287'],
      deferredCount: 1,
    });
    expect(text).toContain('as `pmids`: 0023193287');
  });
});

describe('pubmed_find_related with a zero-padded source PMID', () => {
  async function findRelated(pmid: string, relationship: 'similar' | 'cited_by' = 'similar') {
    const ctx = createMockContext({ errors: findRelatedTool.errors });
    const result = await findRelatedTool.handler(
      findRelatedTool.input.parse({ pmid, relationship }),
      ctx,
    );
    return { result, text: textOf(findRelatedTool.format?.(result) ?? []) };
  }

  it('never lists the source article among its own similar articles', async () => {
    const { result, text } = await findRelated('0034265844');

    expect(result.articles.map((a) => a.pmid)).toEqual(SIMILAR_NEIGHBORS);
    expect(result.totalCount).toBe(SIMILAR_NEIGHBORS.length);
    expect(text).not.toContain('[PMID 34265844]');
    expect(text).toContain(`**Returned:** 2 of 2`);
  });

  it('answers exactly as the unpadded source does, apart from the echoed source PMID', async () => {
    const padded = await findRelated('0034265844');
    const plain = await findRelated('34265844');

    expect(padded.result).toEqual({ ...plain.result, sourcePmid: '0034265844' });
    expect(padded.text).toBe(
      plain.text.replace(
        'Related Articles for PMID 34265844',
        'Related Articles for PMID 0034265844',
      ),
    );
  });

  it('echoes the caller’s spelling as sourcePmid', async () => {
    const { result, text } = await findRelated('0034265844', 'cited_by');

    expect(result.sourcePmid).toBe('0034265844');
    expect(text).toContain('# Related Articles for PMID 0034265844');
  });
});

describe('pubmed_convert_ids with zero-padded PMIDs', () => {
  async function convert(ids: string[]) {
    const ctx = createMockContext({ errors: convertIdsTool.errors });
    const result = await convertIdsTool.handler(
      convertIdsTool.input.parse({ ids, idType: 'pmid' }),
      ctx,
    );
    return { result, text: textOf(convertIdsTool.format?.(result) ?? []) };
  }

  it('resolves a padded PMID of a PMC article, reported under the caller’s spelling', async () => {
    const { result, text } = await convert(['0023193287']);

    expect(result).toEqual({
      records: [
        {
          requestedId: '0023193287',
          pmid: '23193287',
          pmcid: 'PMC3531190',
          doi: '10.1093/nar/gks1195',
        },
      ],
      totalConverted: 1,
      totalSubmitted: 1,
    });
    expect(text).toContain('| 0023193287 | 23193287 | PMC3531190 | 10.1093/nar/gks1195 | - |');
    const converted = requests().filter((u) => u.pathname.includes('idconv'));
    expect(converted.map((u) => u.searchParams.get('ids'))).toEqual(['23193287']);
  });

  it('answers two spellings of one PMID with one record each, from one upstream lookup', async () => {
    const { result } = await convert(['23193287', '0023193287']);

    expect(result.records.map((r) => r.requestedId)).toEqual(['23193287', '0023193287']);
    expect(result.records.every((r) => r.pmcid === 'PMC3531190' && !r.errmsg)).toBe(true);
    expect(result).toMatchObject({ totalConverted: 2, totalSubmitted: 2 });
    const converted = requests().filter((u) => u.pathname.includes('idconv'));
    expect(converted.map((u) => u.searchParams.get('ids'))).toEqual(['23193287']);
  });

  it('reports a padded PMID with no PMC copy the same way as the unpadded one', async () => {
    const padded = await convert(['00000001']);
    const plain = await convert(['1']);

    expect(padded.result).toEqual({
      ...plain.result,
      records: plain.result.records.map((r) => ({ ...r, requestedId: '00000001' })),
    });
    expect(padded.result.records[0]?.errmsg).toMatch(/^Not in PMC ID Converter/);
  });

  it('keeps an input order that mixes padded, unpadded, and unknown PMIDs', async () => {
    const { result } = await convert(['00000001', '23193287', '000099999999']);

    expect(result.records.map((r) => r.requestedId)).toEqual([
      '00000001',
      '23193287',
      '000099999999',
    ]);
    expect(result.records.map((r) => r.pmid)).toEqual(['1', '23193287', '99999999']);
    expect(result).toMatchObject({ totalConverted: 1, totalSubmitted: 3 });
  });
});
