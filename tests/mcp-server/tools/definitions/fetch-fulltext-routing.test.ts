/**
 * @fileoverview End-to-end coverage for how `pubmed_fetch_fulltext` routes
 * identifiers through its tier chain and titles what the Unpaywall tier serves,
 * run through the real handler, the real NcbiService, EuropePmcService and
 * UnpaywallService, and the real HTML and PDF extractors behind a stubbed global
 * fetch.
 *
 * The stub answers the way the live upstreams do: the PMC ID Converter echoes
 * one casing — the spelling submitted last — for DOIs that differ only in case,
 * PMC EFetch reads each id as the number it spells, returns one article per
 * distinct one, and rejects an all-zero list as empty, Europe PMC answers a
 * `DOI:"…"` / `PMCID:…` / `EXT_ID:… AND SRC:MED` search with its record, and
 * Unpaywall returns a DOI object carrying `title`, `journal_name` and `year`
 * beside its OA locations. The Unpaywall records are built from the documented
 * DOI-object shape (every bibliographic field nullable) and the values the
 * medRxiv preprint 10.64898/2026.08.13.26360411 is reported to carry, not
 * captured from a live response.
 *
 * Covers DOI matching and dispatch (#166), per-PMCID dispatch on the `pmcids`
 * branch with zero-padded PMC IDs run in canonical form (#170), the title / journal / year an Unpaywall-served article carries and
 * the order its title sources are consulted in (#144), and tier failures
 * staying on the chain rather than reaching the caller as an error (#168).
 * @module tests/mcp-server/tools/definitions/fetch-fulltext-routing.test
 */

import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { textBlocks } from '../../../_helpers.js';

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

// Before the tool modules load: the fulltext tool and every service read the
// server config once, at import or init time.
vi.stubEnv('NCBI_API_KEY', '');
vi.stubEnv('NCBI_REQUEST_DELAY_MS', '50');
vi.stubEnv('EUROPEPMC_ENABLED', 'true');
vi.stubEnv('EUROPEPMC_REQUEST_DELAY_MS', '50');
vi.stubEnv('EUROPEPMC_MAX_RETRIES', '0');
vi.stubEnv('UNPAYWALL_EMAIL', 'oa@example.com');

const { initNcbiService } = await import('@/services/ncbi/ncbi-service.js');
const { initEuropePmcService } = await import('@/services/europe-pmc/europe-pmc-service.js');
const { initUnpaywallService } = await import('@/services/unpaywall/unpaywall-service.js');
const { fetchFulltextTool } = await import('@/mcp-server/tools/definitions/fetch-fulltext.tool.js');

// ─── Fixtures ────────────────────────────────────────────────────────────────

/** A PMC article, from the live converter's answer for 10.1093/nar/gks1195. */
const GENBANK = { pmid: 23193287, pmcid: 'PMC3531190', doi: '10.1093/nar/gks1195' };
/** A second, unrelated PMC article. */
const SECOND = { pmid: 30000001, pmcid: 'PMC7000001', doi: '10.1000/second' };

/** The medRxiv preprint the #144 report reproduces with: no PMC copy, no EPMC fullTextXML. */
const PREPRINT_DOI = '10.64898/2026.08.13.26360411';
const PREPRINT_TITLE =
  'Global genomics in over 4 million individuals prioritizes therapeutic targets for heart failure and its subtypes';
const PREPRINT_PDF_URL = `https://www.medrxiv.org/content/${PREPRINT_DOI}v1.full.pdf`;
const PREPRINT_LANDING_URL = `https://www.medrxiv.org/content/${PREPRINT_DOI}v1`;

/** Converter answers keyed by the lower-cased identifier; `null` models a dropped record. */
type ConverterEntry = { pmid?: number; pmcid?: string; doi?: string } | null;

interface EpmcHit {
  doi?: string;
  id: string;
  pmcid?: string;
  pmid?: string;
  source: string;
  title?: string;
}

type OaContent = { kind: 'pdf'; body: Uint8Array } | { kind: 'html'; body: string };

const converter = new Map<string, ConverterEntry>();
/**
 * `requested-id` spellings the converter echoes in place of the one sent, keyed
 * by the lower-cased DOI. The live converter answers a request carrying several
 * casings of one DOI with the last one for every record, so a record's echo is
 * not always the casing sent for it.
 */
const converterEchoes = new Map<string, string>();
const pmcJats = new Map<string, string>();
const epmcHits = new Map<string, EpmcHit>();
const epmcFullText = new Map<string, string>();
const unpaywallRecords = new Map<string, Record<string, unknown>>();
const oaContent = new Map<string, OaContent>();
/** Upstream endpoints the stub answers with a 503, keyed by a URL prefix. */
const failing = new Set<string>();

function jats(pmcid: string, title: string, doi?: string): string {
  return `<article article-type="research-article"><front><article-meta>
<article-id pub-id-type="pmcid">${pmcid}</article-id>${doi ? `<article-id pub-id-type="doi">${doi}</article-id>` : ''}
<title-group><article-title>${title}</article-title></title-group>
</article-meta></front><body><sec><title>Introduction</title><p>Body text of ${pmcid}.</p></sec></body></article>`;
}

/** A one-page PDF whose text layer holds `lines`, with an exact xref table. */
function buildPdf(lines: string[]): Uint8Array {
  const stream = `BT /F1 12 Tf 72 720 Td 14 TL ${lines.map((l) => `(${l}) Tj T*`).join(' ')} ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  out += offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('');
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}

/** An HTML landing page whose `<title>` Defuddle reports as the page title. */
function landingPage(pageTitle: string): string {
  return `<html><head><title>${pageTitle}</title></head><body><article><h1>${pageTitle}</h1><p>${'Heart failure genomics body text. '.repeat(30)}</p></article></body></html>`;
}

/**
 * An Unpaywall DOI object for the preprint. Every bibliographic field defaults
 * to `null`, the documented value when Unpaywall has none; tests set the ones
 * they exercise.
 */
function preprintRecord(fields: Record<string, unknown> = {}, pdf = true): Record<string, unknown> {
  const location = {
    url: PREPRINT_LANDING_URL,
    url_for_pdf: pdf ? PREPRINT_PDF_URL : null,
    host_type: 'repository',
    license: 'cc-by',
    version: 'acceptedVersion',
  };
  return {
    doi: PREPRINT_DOI,
    is_oa: true,
    oa_status: 'green',
    genre: 'posted-content',
    publisher: 'openRxiv',
    title: null,
    journal_name: null,
    year: null,
    best_oa_location: location,
    oa_locations: [location],
    ...fields,
  };
}

/** Serve the preprint as a converter miss, an EPMC `PPR` record, and an Unpaywall OA copy. */
function servePreprint(opts: {
  record?: Record<string, unknown>;
  epmcTitle?: string;
  content?: 'pdf' | 'html';
  pageTitle?: string;
}) {
  converter.set(PREPRINT_DOI, { doi: PREPRINT_DOI });
  epmcHits.set(`DOI:"${PREPRINT_DOI}"`, {
    id: 'PPR1299678',
    source: 'PPR',
    doi: PREPRINT_DOI,
    ...(opts.epmcTitle !== undefined && { title: opts.epmcTitle }),
  });
  const html = opts.content === 'html';
  unpaywallRecords.set(PREPRINT_DOI, opts.record ?? preprintRecord({}, !html));
  if (html) {
    oaContent.set(PREPRINT_LANDING_URL, {
      kind: 'html',
      body: landingPage(opts.pageTitle ?? 'medRxiv landing page'),
    });
  } else {
    oaContent.set(PREPRINT_PDF_URL, {
      kind: 'pdf',
      body: buildPdf([PREPRINT_TITLE, 'Heart failure is a leading cause of hospitalization.']),
    });
  }
}

// ─── Upstream stub ───────────────────────────────────────────────────────────

type IdType = 'pmid' | 'pmcid' | 'doi';

function idConvert(url: URL): Response {
  const idType = url.searchParams.get('idtype') as IdType;
  const ids = (url.searchParams.get('ids') ?? '').split(',');
  /** The live converter answers DOIs that differ only in case with the last spelling sent. */
  const echoOf = (id: string) =>
    idType === 'doi'
      ? (converterEchoes.get(id.toLowerCase()) ??
        ids.findLast((other) => other.toLowerCase() === id.toLowerCase()) ??
        id)
      : idType === 'pmcid'
        ? id.toUpperCase()
        : id;
  const records = [...new Set(ids.map(echoOf))].flatMap((echo) => {
    const entry = converter.get(echo.toLowerCase());
    if (entry === null) return [];
    if (entry?.pmcid) return [{ ...entry, 'requested-id': echo }];
    return [
      {
        ...(entry ?? {}),
        ...(idType === 'pmid' ? { pmid: Number(echo) } : { [idType]: echo }),
        'requested-id': echo,
        status: 'error',
        errmsg: 'Identifier not found in PMC',
      },
    ];
  });
  return Response.json({ status: 'ok', records });
}

const EMPTY_ID_LIST =
  '<?xml version="1.0" encoding="UTF-8" ?>\n<!DOCTYPE eEfetchResult PUBLIC "-//NLM//DTD efetch 20131226//EN" "https://eutils.ncbi.nlm.nih.gov/eutils/dtd/20131226/efetch.dtd">\n<eFetchResult>\n\t<ERROR>ID list is empty! Possibly it has no correct IDs.</ERROR>\n</eFetchResult>\n';

/** NCBI's reading of an ID: the decimal number its digits spell. */
const asUid = (id: string) => BigInt(id).toString();

/**
 * PMC EFetch reads each ID as the number it spells, so `03531190` is PMC3531190,
 * answers a repeated UID once, and rejects a list with no UID in it with the
 * `ID list is empty!` envelope.
 */
function pmcEfetch(url: URL): Response {
  const uids = [...new Set((url.searchParams.get('id') ?? '').split(',').map(asUid))];
  if (uids.every((uid) => uid === '0')) return new Response(EMPTY_ID_LIST, { status: 400 });
  const articles = uids.map((uid) => pmcJats.get(uid) ?? '').join('');
  return new Response(`<?xml version="1.0"?><pmc-articleset>${articles}</pmc-articleset>`);
}

function epmcSearch(url: URL): Response {
  const hit = epmcHits.get(url.searchParams.get('query') ?? '');
  return Response.json({
    version: '6.9',
    hitCount: hit ? 1 : 0,
    request: { queryString: url.searchParams.get('query') },
    resultList: { result: hit ? [hit] : [] },
  });
}

function upstream(url: URL): Response {
  for (const prefix of failing) {
    if (url.href.startsWith(prefix)) return new Response('upstream down', { status: 503 });
  }
  if (url.pathname.includes('/idconv/')) return idConvert(url);
  if (url.pathname.endsWith('/efetch.fcgi') && url.searchParams.get('db') === 'pmc') {
    return pmcEfetch(url);
  }
  if (url.hostname === 'www.ebi.ac.uk') {
    if (url.pathname.endsWith('/search')) return epmcSearch(url);
    const fullText = url.pathname.match(/\/rest\/([^/]+)\/fullTextXML$/);
    if (fullText) {
      const xml = epmcFullText.get(decodeURIComponent(fullText[1] ?? ''));
      return xml ? new Response(xml) : new Response('not found', { status: 404 });
    }
  }
  if (url.hostname === 'api.unpaywall.org') {
    const doi = decodeURIComponent(url.pathname.replace(/^\/v2\//, ''));
    const record = unpaywallRecords.get(doi.toLowerCase());
    return record ? Response.json(record) : Response.json({ error: true }, { status: 404 });
  }
  const content = oaContent.get(url.href);
  if (content?.kind === 'pdf') return new Response(content.body);
  if (content?.kind === 'html') {
    return new Response(content.body, { headers: { 'content-type': 'text/html' } });
  }
  throw new Error(`unexpected request ${url.href}`);
}

let fetchSpy: ReturnType<typeof vi.spyOn>;

beforeAll(() => {
  fetchSpy = vi
    .spyOn(globalThis, 'fetch')
    .mockImplementation(async (input) => upstream(new URL(String(input))));
  initNcbiService();
  initEuropePmcService();
  initUnpaywallService();
});

beforeEach(() => {
  fetchSpy.mockClear();
  for (const table of [
    converter,
    converterEchoes,
    pmcJats,
    epmcHits,
    epmcFullText,
    unpaywallRecords,
    oaContent,
    failing,
  ]) {
    table.clear();
  }
});

afterAll(() => {
  fetchSpy.mockRestore();
  vi.unstubAllEnvs();
});

/** The URLs the chain requested, in order. */
const requests = (): URL[] =>
  fetchSpy.mock.calls.map((args: unknown[]) => new URL(String(args[0])));
const pmcEfetchIds = () =>
  requests()
    .filter((u) => u.pathname.endsWith('/efetch.fcgi') && u.searchParams.get('db') === 'pmc')
    .map((u) => u.searchParams.get('id'));
const converterIds = () =>
  requests()
    .filter((u) => u.pathname.includes('/idconv/'))
    .map((u) => u.searchParams.get('ids'));
const epmcQueries = () =>
  requests()
    .filter((u) => u.hostname === 'www.ebi.ac.uk' && u.pathname.endsWith('/search'))
    .map((u) => u.searchParams.get('query'));
const unpaywallLookups = () => requests().filter((u) => u.hostname === 'api.unpaywall.org');

async function fetchFulltext(input: Record<string, unknown>) {
  const ctx = createMockContext({ errors: fetchFulltextTool.errors });
  const result = await fetchFulltextTool.handler(fetchFulltextTool.input.parse(input), ctx);
  const text = textBlocks(fetchFulltextTool.format!(result))
    .map((b) => b.text)
    .join('\n');
  return { result, text, enrichment: getEnrichment(ctx) };
}

type Result = Awaited<ReturnType<typeof fetchFulltext>>['result'];

/** The article at `index`, narrowed to the Unpaywall shape. */
function unpaywallArticle(result: Result, index = 0) {
  const article = result.articles[index];
  if (article?.source !== 'unpaywall') throw new Error(`article ${index} is not unpaywall`);
  return article;
}

/** The article at `index`, narrowed to the JATS shape. */
function pmcArticle(result: Result, index = 0) {
  const article = result.articles[index];
  if (article?.source !== 'pmc') throw new Error(`article ${index} is not pmc`);
  return article;
}

function serveGenbank() {
  converter.set(GENBANK.doi, GENBANK);
  pmcJats.set('3531190', jats(GENBANK.pmcid, 'GenBank', GENBANK.doi));
}

// ─── #166: DOI routing ───────────────────────────────────────────────────────

describe('dois routing through the PMC ID Converter', () => {
  it('routes a single PMC-indexed DOI to PMC EFetch', async () => {
    serveGenbank();
    const { result } = await fetchFulltext({ dois: [GENBANK.doi] });

    expect(result.articles.map((a) => [a.viaSource, a.pmcId])).toEqual([['pmc', 'PMC3531190']]);
    expect(result.unavailable).toBeUndefined();
    expect(converterIds()).toEqual([GENBANK.doi]);
    expect(pmcEfetchIds()).toEqual(['3531190']);
    expect(epmcQueries()).toEqual([]);
  });

  it('routes two distinct PMC-indexed DOIs to one PMC EFetch call', async () => {
    serveGenbank();
    converter.set(SECOND.doi, SECOND);
    pmcJats.set('7000001', jats(SECOND.pmcid, 'Second', SECOND.doi));
    const { result } = await fetchFulltext({ dois: [GENBANK.doi, SECOND.doi] });

    expect(result.articles.map((a) => [a.viaSource, a.pmcId])).toEqual([
      ['pmc', 'PMC3531190'],
      ['pmc', 'PMC7000001'],
    ]);
    expect(pmcEfetchIds()).toEqual(['3531190,7000001']);
    expect(epmcQueries()).toEqual([]);
  });

  it('sends a DOI the converter returns no record for on to Europe PMC and Unpaywall', async () => {
    serveGenbank();
    const dropped = '10.5555/dropped';
    converter.set(dropped, null);
    const { result, text } = await fetchFulltext({ dois: [GENBANK.doi, dropped] });

    expect(result.articles.map((a) => a.pmcId)).toEqual(['PMC3531190']);
    expect(result.unavailable).toEqual([
      {
        id: dropped,
        idType: 'doi',
        reason: 'no-oa',
        triedTiers: [
          {
            tier: 'pmc',
            outcome: 'not-attempted',
            detail: 'ID Converter returned no record for this DOI',
          },
          { tier: 'europepmc', outcome: 'miss' },
          { tier: 'unpaywall', outcome: 'no-oa', detail: 'DOI unknown to Unpaywall' },
        ],
      },
    ]);
    expect(epmcQueries()).toEqual([`DOI:"${dropped}"`]);
    expect(text).toContain(`- [doi] ${dropped} — no-oa`);
  });

  it('routes every spelling of a DOI that differs only in case through PMC, fetching it once (#166)', async () => {
    serveGenbank();
    const spellings = ['10.1093/nar/gks1195', '10.1093/NAR/GKS1195'];
    const { result, text } = await fetchFulltext({ dois: spellings, maxCharacters: 200 });

    expect(result.articles.map((a) => [a.viaSource, a.pmcId])).toEqual([['pmc', 'PMC3531190']]);
    expect(result.unavailable).toBeUndefined();
    expect(pmcEfetchIds()).toEqual(['3531190']);
    // Nothing fell through: the second spelling never reached Europe PMC.
    expect(epmcQueries()).toEqual([]);
    expect(text).toContain('**Articles Returned:** 1');
    expect(text).not.toContain('Unavailable');
  });

  it('credits one converter record to every spelling among distinct DOIs (#166)', async () => {
    serveGenbank();
    converter.set(SECOND.doi, SECOND);
    pmcJats.set('7000001', jats(SECOND.pmcid, 'Second', SECOND.doi));
    const { result } = await fetchFulltext({
      dois: ['10.1093/NAR/gks1195', SECOND.doi, '10.1093/nar/GKS1195', '10.1093/nar/gks1195'],
    });

    expect(result.articles.map((a) => [a.viaSource, a.pmcId])).toEqual([
      ['pmc', 'PMC3531190'],
      ['pmc', 'PMC7000001'],
    ]);
    expect(result.unavailable).toBeUndefined();
    expect(pmcEfetchIds()).toEqual(['3531190,7000001']);
    expect(epmcQueries()).toEqual([]);
  });

  it('matches a converter record that echoes a different casing than the DOI sent (#166)', async () => {
    serveGenbank();
    const sent = '10.1093/NAR/gks1195';
    converterEchoes.set(GENBANK.doi, '10.1093/nar/GKS1195');
    const { result, text } = await fetchFulltext({ dois: [sent] });

    expect(converterIds()).toEqual([sent]);
    expect(result.articles.map((a) => [a.viaSource, a.pmcId])).toEqual([['pmc', 'PMC3531190']]);
    expect(result.unavailable).toBeUndefined();
    expect(pmcEfetchIds()).toEqual(['3531190']);
    expect(epmcQueries()).toEqual([]);
    expect(text).toContain('**Articles Returned:** 1');
    expect(text).not.toContain('Unavailable');
  });

  it('runs the fallback chain once for a non-PMC DOI and reports every spelling (#166)', async () => {
    const lower = '10.7777/closed';
    const upper = '10.7777/CLOSED';
    converter.set(lower, { doi: lower });
    const { result, text } = await fetchFulltext({ dois: [lower, upper] });

    expect(result.articles).toEqual([]);
    const chain = [
      { tier: 'pmc', outcome: 'not-attempted', detail: 'DOI has no PMC counterpart' },
      { tier: 'europepmc', outcome: 'miss' },
      { tier: 'unpaywall', outcome: 'no-oa', detail: 'DOI unknown to Unpaywall' },
    ];
    expect(result.unavailable).toEqual([
      { id: lower, idType: 'doi', reason: 'no-oa', triedTiers: chain },
      { id: upper, idType: 'doi', reason: 'no-oa', triedTiers: chain },
    ]);
    expect(epmcQueries()).toEqual([`DOI:"${lower}"`]);
    expect(unpaywallLookups()).toHaveLength(1);
    expect(text).toContain(`- [doi] ${lower} — no-oa`);
    expect(text).toContain(`- [doi] ${upper} — no-oa`);
  });

  it('recovers two different DOIs the converter places on one PMC record, fetching it once', async () => {
    serveGenbank();
    const alias = '10.9999/genbank-alias';
    converter.set(alias, { ...GENBANK, doi: alias });
    const { result, text } = await fetchFulltext({ dois: [GENBANK.doi, alias] });

    expect(result.articles.map((a) => [a.viaSource, a.pmcId])).toEqual([['pmc', 'PMC3531190']]);
    expect(result.unavailable).toBeUndefined();
    expect(pmcEfetchIds()).toEqual(['3531190']);
    expect(epmcQueries()).toEqual([]);
    expect(text).not.toContain('Unavailable');
  });

  it('reports both DOIs with the shared chain when their one PMC record is missing', async () => {
    const first = '10.9999/first';
    const second = '10.9999/second';
    converter.set(first, { pmcid: 'PMC8000001', doi: first });
    converter.set(second, { pmcid: 'PMC8000001', doi: second });
    const { result } = await fetchFulltext({ dois: [first, second] });

    expect(result.articles).toEqual([]);
    expect(pmcEfetchIds()).toEqual(['8000001']);
    const chain = [
      { tier: 'pmc', outcome: 'miss' },
      { tier: 'europepmc', outcome: 'miss' },
      { tier: 'unpaywall', outcome: 'no-oa', detail: 'DOI unknown to Unpaywall' },
    ];
    expect(result.unavailable).toEqual([
      { id: first, idType: 'doi', reason: 'no-oa', triedTiers: chain },
      { id: second, idType: 'doi', reason: 'no-oa', triedTiers: chain },
    ]);
    expect(epmcQueries()).toEqual([`DOI:"${first}"`]);
  });

  it('defers a case-variant DOI under the first spelling submitted (#166)', async () => {
    serveGenbank();
    const spellings = ['10.1093/NAR/GKS1195', '10.1093/nar/gks1195'];
    const { result, text } = await fetchFulltext({ dois: spellings, maxResponseCharacters: 1 });

    expect(result.articles).toEqual([]);
    expect(result.deferred).toMatchObject({ idType: 'doi', ids: ['10.1093/NAR/GKS1195'] });
    expect(text).toContain('as `dois`: 10.1093/NAR/GKS1195');
  });
});

// ─── pmids routing ───────────────────────────────────────────────────────────

describe('pmids routing', () => {
  it('recovers two PMIDs the converter places on one PMC record, fetching it once', async () => {
    converter.set('23193287', GENBANK);
    converter.set('23193288', { ...GENBANK, pmid: 23193288 });
    pmcJats.set('3531190', jats(GENBANK.pmcid, 'GenBank', GENBANK.doi));
    const { result } = await fetchFulltext({ pmids: ['23193287', '23193288'] });

    expect(result.articles.map((a) => [a.viaSource, a.pmcId])).toEqual([['pmc', 'PMC3531190']]);
    expect(result.unavailable).toBeUndefined();
    expect(pmcEfetchIds()).toEqual(['3531190']);
  });
});

// ─── pmcids routing ──────────────────────────────────────────────────────────

describe('pmcids routing', () => {
  it('fetches an ordinary PMC ID from PMC EFetch', async () => {
    pmcJats.set('3531190', jats(GENBANK.pmcid, 'GenBank', GENBANK.doi));
    const { result } = await fetchFulltext({ pmcids: ['PMC3531190'] });

    expect(result.articles.map((a) => [a.viaSource, a.pmcId])).toEqual([['pmc', 'PMC3531190']]);
    expect(pmcEfetchIds()).toEqual(['3531190']);
  });

  it('dispatches each PMC ID once however many spellings name it', async () => {
    const pmcid = 'PMC9000001';
    epmcHits.set(`PMCID:${pmcid}`, { id: pmcid, source: 'PMC', pmcid, doi: '10.9000/one' });
    epmcFullText.set(pmcid, jats(pmcid, 'Served by Europe PMC'));
    const { result } = await fetchFulltext({ pmcids: ['PMC9000001', 'pmc9000001', '9000001'] });

    expect(pmcEfetchIds()).toEqual(['9000001']);
    expect(epmcQueries()).toEqual([`PMCID:${pmcid}`]);
    expect(result.articles.map((a) => [a.viaSource, a.pmcId])).toEqual([
      ['europepmc', 'PMC9000001'],
    ]);
  });

  it('runs a zero-padded PMC ID as the PMC ID it spells (#170)', async () => {
    pmcJats.set('3531190', jats(GENBANK.pmcid, 'GenBank', GENBANK.doi));
    const { result, text } = await fetchFulltext({ pmcids: ['PMC03531190'], maxCharacters: 100 });

    expect(result.articles.map((a) => [a.viaSource, a.pmcId])).toEqual([['pmc', 'PMC3531190']]);
    expect(result.unavailable).toBeUndefined();
    expect(pmcEfetchIds()).toEqual(['3531190']);
    expect(epmcQueries()).toEqual([]);
    expect(text).toContain('**Articles Returned:** 1');
    expect(text).not.toContain('Unavailable');
  });

  it('fetches a PMC ID once when it is also submitted zero-padded (#170)', async () => {
    pmcJats.set('3531190', jats(GENBANK.pmcid, 'GenBank', GENBANK.doi));
    const { result, text } = await fetchFulltext({ pmcids: ['PMC3531190', 'PMC03531190'] });

    expect(result.articles.map((a) => [a.viaSource, a.pmcId])).toEqual([['pmc', 'PMC3531190']]);
    expect(result.totalReturned).toBe(1);
    expect(result.unavailable).toBeUndefined();
    expect(pmcEfetchIds()).toEqual(['3531190']);
    expect(epmcQueries()).toEqual([]);
    expect(text).toContain('**Articles Returned:** 1');
    expect(text).not.toContain('Unavailable');
  });

  it('sends a zero-padded PMC ID that misses PMC on to Europe PMC in its canonical form (#170)', async () => {
    const pmcid = 'PMC9000001';
    epmcHits.set(`PMCID:${pmcid}`, { id: pmcid, source: 'PMC', pmcid, doi: '10.9000/one' });
    epmcFullText.set(pmcid, jats(pmcid, 'Served by Europe PMC'));
    const { result, text } = await fetchFulltext({ pmcids: ['PMC09000001'] });

    expect(pmcEfetchIds()).toEqual(['9000001']);
    expect(epmcQueries()).toEqual([`PMCID:${pmcid}`]);
    expect(result.articles.map((a) => [a.viaSource, a.pmcId])).toEqual([
      ['europepmc', 'PMC9000001'],
    ]);
    expect(result.unavailable).toBeUndefined();
    expect(text).not.toContain('Unavailable');
  });

  it('defers a zero-padded PMC ID under its PMC<digits> form (#170)', async () => {
    pmcJats.set('3531190', jats(GENBANK.pmcid, 'GenBank', GENBANK.doi));
    const { result, text } = await fetchFulltext({
      pmcids: ['PMC03531190'],
      maxResponseCharacters: 1,
    });

    expect(result.articles).toEqual([]);
    expect(result.unavailable).toBeUndefined();
    expect(result.deferred).toMatchObject({ idType: 'pmcid', ids: ['PMC3531190'] });
    expect(text).toContain('as `pmcids`: PMC3531190');
    expect(text).not.toContain('Unavailable');
  });

  it('reports an all-zero PMC ID unavailable in PMC<digits> form, without an error (#170)', async () => {
    const { result, text } = await fetchFulltext({ pmcids: ['PMC0000000'] });

    expect(result.articles).toEqual([]);
    expect(result.unavailable).toEqual([
      {
        id: 'PMC0',
        idType: 'pmcid',
        reason: 'not-found',
        triedTiers: [
          { tier: 'pmc', outcome: 'miss' },
          { tier: 'europepmc', outcome: 'miss' },
          { tier: 'unpaywall', outcome: 'no-doi' },
        ],
      },
    ]);
    expect(pmcEfetchIds()).toEqual(['0']);
    expect(text).toContain('- [pmcid] PMC0 — not-found');
  });
});

// ─── #144: title, journal, and year on an Unpaywall-served article ───────────

describe('Unpaywall article metadata', () => {
  it('keeps the tier-identifying fields of a pdf-text article', async () => {
    servePreprint({ record: preprintRecord({ title: PREPRINT_TITLE }) });
    const { result } = await fetchFulltext({ dois: [PREPRINT_DOI], maxCharacters: 1500 });

    expect(unpaywallArticle(result)).toMatchObject({
      source: 'unpaywall',
      viaSource: 'unpaywall',
      contentFormat: 'pdf-text',
      doi: PREPRINT_DOI,
      sourceUrl: PREPRINT_PDF_URL,
      totalPages: 1,
      license: 'cc-by',
      hostType: 'repository',
      version: 'acceptedVersion',
    });
  });

  it('titles a pdf-text article from Unpaywall and carries its journal and year (#144)', async () => {
    servePreprint({
      record: preprintRecord({ title: PREPRINT_TITLE, journal_name: 'medRxiv', year: 2026 }),
      epmcTitle: 'A different Europe PMC title',
    });
    const { result, text } = await fetchFulltext({ dois: [PREPRINT_DOI], maxCharacters: 1500 });

    const article = unpaywallArticle(result);
    expect(article.title).toBe(PREPRINT_TITLE);
    expect(article.journalName).toBe('medRxiv');
    expect(article.year).toBe(2026);
    expect(text).toContain(`### ${PREPRINT_TITLE}`);
    expect(text).not.toContain(`### DOI ${PREPRINT_DOI}`);
    expect(text).toContain('**Journal:** medRxiv');
    expect(text).toContain('**Year:** 2026');
  });

  it('titles a pdf-text article from the Europe PMC record when Unpaywall has no title (#144)', async () => {
    servePreprint({ epmcTitle: `<i>Global</i> genomics &amp; heart failure.` });
    const { result, text } = await fetchFulltext({ dois: [PREPRINT_DOI] });

    const article = unpaywallArticle(result);
    expect(article.title).toBe('Global genomics & heart failure.');
    expect(text).toContain('### Global genomics & heart failure.');
  });

  it('prefers the Unpaywall title over the HTML page title (#144)', async () => {
    servePreprint({
      record: preprintRecord({ title: PREPRINT_TITLE }, false),
      epmcTitle: 'A different Europe PMC title',
      content: 'html',
      pageTitle: 'medRxiv landing page',
    });
    const { result } = await fetchFulltext({ dois: [PREPRINT_DOI] });

    const article = unpaywallArticle(result);
    expect(article.contentFormat).toBe('html-markdown');
    expect(article.title).toBe(PREPRINT_TITLE);
  });

  it('prefers the Europe PMC title over the HTML page title (#144)', async () => {
    servePreprint({
      epmcTitle: 'Title from Europe PMC',
      content: 'html',
      pageTitle: 'medRxiv landing page',
    });
    const { result } = await fetchFulltext({ dois: [PREPRINT_DOI] });

    expect(unpaywallArticle(result).title).toBe('Title from Europe PMC');
  });

  it('falls back to the HTML page title when no record carries one', async () => {
    servePreprint({ content: 'html', pageTitle: 'medRxiv landing page' });
    const { result, text } = await fetchFulltext({ dois: [PREPRINT_DOI] });

    expect(unpaywallArticle(result).title).toBe('medRxiv landing page');
    expect(text).toContain('### medRxiv landing page');
  });

  it('leaves a pdf-text article untitled when no source carries a title', async () => {
    servePreprint({});
    const { result, text } = await fetchFulltext({ dois: [PREPRINT_DOI] });

    const article = unpaywallArticle(result);
    expect(article).not.toHaveProperty('title');
    expect(article).not.toHaveProperty('journalName');
    expect(article).not.toHaveProperty('year');
    expect(text).toContain(`### DOI ${PREPRINT_DOI}`);
    expect(text).not.toContain('**Journal:**');
    expect(text).not.toContain('**Year:**');
  });

  it('skips a blank Unpaywall title and a non-integer year rather than reporting them (#144)', async () => {
    servePreprint({
      record: preprintRecord({ title: '   ', journal_name: '', year: '2026' }),
      epmcTitle: 'Title from Europe PMC',
    });
    const { result } = await fetchFulltext({ dois: [PREPRINT_DOI] });

    const article = unpaywallArticle(result);
    expect(article.title).toBe('Title from Europe PMC');
    expect(article).not.toHaveProperty('journalName');
    expect(article).not.toHaveProperty('year');
  });

  it('carries the Europe PMC title to Unpaywall on the pmids branch (#144)', async () => {
    const pmid = '41000001';
    converter.set(pmid, {});
    epmcHits.set(`EXT_ID:${pmid} AND SRC:MED`, {
      id: pmid,
      source: 'MED',
      pmid,
      doi: PREPRINT_DOI,
      title: 'Title from the PubMed-derived Europe PMC record',
    });
    unpaywallRecords.set(PREPRINT_DOI, preprintRecord());
    oaContent.set(PREPRINT_PDF_URL, { kind: 'pdf', body: buildPdf(['Body text.']) });
    const { result } = await fetchFulltext({ pmids: [pmid] });

    const article = unpaywallArticle(result);
    expect(article.pmid).toBe(pmid);
    expect(article.title).toBe('Title from the PubMed-derived Europe PMC record');
  });

  it('carries the Europe PMC title to Unpaywall on the pmcids branch, behind the Unpaywall title (#144)', async () => {
    const pmcid = 'PMC9100001';
    epmcHits.set(`PMCID:${pmcid}`, {
      id: '41000002',
      source: 'MED',
      pmcid,
      doi: PREPRINT_DOI,
      title: 'Title from Europe PMC',
    });
    unpaywallRecords.set(PREPRINT_DOI, preprintRecord());
    oaContent.set(PREPRINT_PDF_URL, { kind: 'pdf', body: buildPdf(['Body text.']) });

    const fromEpmc = await fetchFulltext({ pmcids: [pmcid] });
    expect(unpaywallArticle(fromEpmc.result)).toMatchObject({
      pmcId: pmcid,
      title: 'Title from Europe PMC',
    });

    unpaywallRecords.set(PREPRINT_DOI, preprintRecord({ title: PREPRINT_TITLE, year: 2026 }));
    const fromUnpaywall = await fetchFulltext({ pmcids: [pmcid] });
    expect(unpaywallArticle(fromUnpaywall.result)).toMatchObject({
      pmcId: pmcid,
      title: PREPRINT_TITLE,
      year: 2026,
    });
  });
});

// ─── #168: tier failures stay on the chain ───────────────────────────────────

describe('Europe PMC and Unpaywall failures', () => {
  it('report through triedTiers and never reach the caller as an error (#168)', async () => {
    converter.set(PREPRINT_DOI, { doi: PREPRINT_DOI });
    failing.add('https://www.ebi.ac.uk/');
    failing.add('https://api.unpaywall.org/');
    const { result, text } = await fetchFulltext({ dois: [PREPRINT_DOI] });

    expect(result.articles).toEqual([]);
    const [entry] = result.unavailable ?? [];
    expect(entry?.reason).toBe('service-error');
    expect(entry?.triedTiers.map((t) => `${t.tier}:${t.outcome}`)).toEqual([
      'pmc:not-attempted',
      'europepmc:service-error',
      'unpaywall:service-error',
    ]);
    expect(text).toContain(`- [doi] ${PREPRINT_DOI} — service-error`);
  });

  it('fold a failed Europe PMC fullTextXML fetch and an Unpaywall content failure into the chain (#168)', async () => {
    const pmcid = 'PMC9200001';
    epmcHits.set(`PMCID:${pmcid}`, { id: pmcid, source: 'PMC', pmcid, doi: PREPRINT_DOI });
    failing.add(`https://www.ebi.ac.uk/europepmc/webservices/rest/${pmcid}/fullTextXML`);
    unpaywallRecords.set(PREPRINT_DOI, preprintRecord());
    failing.add('https://www.medrxiv.org/');
    const { result } = await fetchFulltext({ pmcids: [pmcid] });

    expect(result.articles).toEqual([]);
    expect(result.unavailable?.[0]?.triedTiers.map((t) => `${t.tier}:${t.outcome}`)).toEqual([
      'pmc:miss',
      'europepmc:service-error',
      'unpaywall:fetch-failed',
    ]);
  });
});

describe('PMC-served article from the dois branch', () => {
  it('carries the PMC record’s own DOI casing for an upper-cased DOI', async () => {
    serveGenbank();
    const { result } = await fetchFulltext({ dois: ['10.1093/NAR/GKS1195'] });

    expect(pmcArticle(result)).toMatchObject({ pmcId: 'PMC3531190', doi: GENBANK.doi });
  });
});
