#!/usr/bin/env bun
/**
 * @fileoverview Add one openly licensed PMC article to the full-text corpus under
 * `tests/corpus/fixtures/pmc/`: fetch its PMC EFetch body, confirm its license from
 * the article's own `<permissions>`, and write the bytes exactly as received plus a
 * `meta.json`, then regenerate `tests/corpus/ATTRIBUTION.md`.
 *
 * ```sh
 * bun run scripts/corpus-add.ts <PMCID> [--features a,b] [--regression cyanheads/pubmed-mcp-server#N] [--notes "…"] [--dry-run]
 * bun run scripts/corpus-add.ts --kind pubmed <PMID> [--features a,b] [--regression …] [--notes "…"] [--dry-run]
 * bun run scripts/corpus-add.ts --attribution    # regenerate ATTRIBUTION.md only
 * ```
 *
 * The license comes from `<license xlink:href>` and `<ali:license_ref>`, else from a
 * Creative Commons URL in the license prose. Allowed: CC BY and CC BY-SA at any
 * version, CC0, and the public-domain mark. Anything else — an NC or ND variant, two
 * conflicting licenses, or an "open access" statement with no license URL — exits
 * non-zero and writes nothing. So does an article PMC serves as front matter only.
 *
 * `--kind pubmed` adds a PubMed EFetch (`db=pubmed`) record to
 * `tests/corpus/fixtures/pubmed/` instead. A PubMed record carries the article's
 * abstract, so it is stored only when the article itself is openly licensed: the
 * record's own `PubmedData/ArticleIdList` names its PMCID, and the license is read
 * from that PMC article's `<permissions>` exactly as above — from the corpus's own
 * copy when that PMC article is already a fixture, otherwise from a PMC EFetch. A
 * record with no PMC copy (every Bookshelf record among them), a PMC copy that names
 * a different PMID, or a refused license exits non-zero and writes nothing.
 *
 * One EFetch per run, two for a PubMed record whose PMC copy is not in the corpus.
 * `NCBI_PACE_SCRIPT` names a shared pacing gate that takes curl arguments (one
 * serializing every NCBI request on the machine); without it the script spaces its
 * own requests at least 350 ms apart across runs, under NCBI's three-per-second
 * keyless limit. `NCBI_ADMIN_EMAIL` joins the request when set. `--features` tags
 * come from `tests/corpus/features.ts` (`PUBMED_FEATURES` for a PubMed record).
 * @module scripts/corpus-add
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { parseArgs } from 'node:util';
import { XMLParser } from 'fast-xml-parser';
import { ORDERED_XML_PARSER_OPTIONS } from '../src/services/ncbi/parsing/ordered-xml-parser-options.js';
import {
  attrOf,
  findAll,
  findAllDescendants,
  findOne,
  type JatsNode,
  type JatsNodeList,
  textContent,
} from '../src/services/ncbi/parsing/pmc-xml-helpers.js';
import { ATTRIBUTION_PATH, renderAttribution } from '../tests/corpus/attribution.js';
import { FEATURES, PUBMED_FEATURES } from '../tests/corpus/features.js';
import {
  efetchUrl,
  type FixtureMeta,
  fixtureMetaSchema,
  listFixtures,
  PMC_FIXTURES_DIR,
} from '../tests/corpus/fixtures.js';
import {
  listPubmedFixtures,
  PUBMED_FIXTURES_DIR,
  type PubmedFixtureMeta,
  pubmedEfetchUrl,
  pubmedFixtureMetaSchema,
} from '../tests/corpus/pubmed-fixtures.js';

const MIN_GAP_MS = 350;
const STAMP_PATH = join(tmpdir(), 'pubmed-corpus-add.last');

function fail(message: string): never {
  console.error(`corpus-add: ${message}`);
  process.exit(1);
}

function writeAttribution(): void {
  const metas = listFixtures().map((f) => fixtureMetaSchema.parse(f.meta));
  const pubmedMetas = listPubmedFixtures().map((f) => pubmedFixtureMetaSchema.parse(f.meta));
  writeFileSync(ATTRIBUTION_PATH, renderAttribution(metas, pubmedMetas));
  console.log(
    `wrote ${ATTRIBUTION_PATH} (${metas.length} PMC fixtures, ${pubmedMetas.length} PubMed records)`,
  );
}

// ── Fetch ───────────────────────────────────────────────────────────────────

function requestUrl(numericId: string, db: 'pmc' | 'pubmed' = 'pmc'): string {
  const params = new URLSearchParams({
    db,
    id: numericId,
    retmode: 'xml',
    tool: 'pubmed-mcp-server-corpus',
  });
  if (process.env.NCBI_ADMIN_EMAIL) params.set('email', process.env.NCBI_ADMIN_EMAIL);
  return `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?${params}`;
}

function fetchThroughGate(gate: string, url: string): Uint8Array {
  const out = join(tmpdir(), `pubmed-corpus-add-${process.pid}.xml`);
  const run = spawnSync(gate, ['-sS', '--max-time', '60', '-o', out, '-w', '%{http_code}', url], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  try {
    if (run.status !== 0) fail(`${gate} exited ${run.status} for ${url}`);
    if (run.stdout.trim() !== '200') fail(`GET ${url} returned HTTP ${run.stdout.trim()}`);
    return new Uint8Array(readFileSync(out));
  } finally {
    rmSync(out, { force: true });
  }
}

async function fetchPaced(url: string): Promise<Uint8Array> {
  const last = existsSync(STAMP_PATH) ? Number(readFileSync(STAMP_PATH, 'utf8')) : 0;
  const wait = last + MIN_GAP_MS - Date.now();
  if (wait > 0) await new Promise((done) => setTimeout(done, wait));
  writeFileSync(STAMP_PATH, String(Date.now()));
  const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (response.status !== 200) fail(`GET ${url} returned HTTP ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

/** One paced GET, through `NCBI_PACE_SCRIPT` when it is set. */
function fetchBody(url: string): Promise<Uint8Array> | Uint8Array {
  const gate = process.env.NCBI_PACE_SCRIPT;
  return gate ? fetchThroughGate(gate, url) : fetchPaced(url);
}

// ── License ─────────────────────────────────────────────────────────────────

interface License {
  id: string;
  url: string;
}

type Verdict = { ok: true; license: License } | { ok: false; reason: string };

/** Map one license URL to an allowed license, a refusal, or `undefined` when it names none. */
function classifyUrl(raw: string): Verdict | undefined {
  const url = raw
    .trim()
    .toLowerCase()
    .replace(/^http:/, 'https:');
  const cc = url.match(/creativecommons\.org\/licenses\/([a-z-]+)\/(\d\.\d)(\/[a-z]{2,3})?/);
  if (cc) {
    const [, type = '', version = '', port = ''] = cc;
    if (type !== 'by' && type !== 'by-sa') {
      return {
        ok: false,
        reason: `CC ${type.toUpperCase()} ${version} is not an open license (${raw})`,
      };
    }
    return {
      ok: true,
      license: {
        id: `CC-${type.toUpperCase()}-${version}`,
        url: `https://creativecommons.org/licenses/${type}/${version}${port}/`,
      },
    };
  }
  if (/creativecommons\.org\/publicdomain\/zero\/1\.0/.test(url)) {
    return {
      ok: true,
      license: { id: 'CC0-1.0', url: 'https://creativecommons.org/publicdomain/zero/1.0/' },
    };
  }
  if (/creativecommons\.org\/publicdomain\/mark\/1\.0/.test(url)) {
    return {
      ok: true,
      license: { id: 'public-domain', url: 'https://creativecommons.org/publicdomain/mark/1.0/' },
    };
  }
  return;
}

/** Rank of each license family; an article naming several is held to the strictest. */
const strictness = (id: string) => (id.startsWith('CC-BY-SA') ? 3 : id.startsWith('CC-BY') ? 2 : 1);

/**
 * Settle the license URLs one `<permissions>` states. Any non-open license refuses
 * the article. Structured URLs (`xlink:href`, `ali:license_ref`) win over URLs found
 * in prose. Several open licenses resolve to the strictest family, which covers a CC
 * BY article license stated beside a CC0 data waiver; two different licenses in that
 * family are ambiguous and refuse it.
 */
function settleLicense(structured: string[], prose: string[]): Verdict {
  const classify = (urls: string[]) =>
    urls.map(classifyUrl).filter((v): v is Verdict => v !== undefined);
  const fromStructured = classify(structured);
  const fromProse = classify(prose);
  const refused = [...fromStructured, ...fromProse].find((v) => !v.ok);
  if (refused) return refused;
  const open = (fromStructured.length > 0 ? fromStructured : fromProse).flatMap((v) =>
    v.ok ? [v.license] : [],
  );
  if (open.length === 0) {
    const seen = [...structured, ...prose];
    return {
      ok: false,
      reason: `no Creative Commons or public-domain license URL in <permissions>${seen.length > 0 ? ` (saw: ${seen.join(', ')})` : ''}`,
    };
  }
  const top = Math.max(...open.map((l) => strictness(l.id)));
  const strictest = [
    ...new Map(open.filter((l) => strictness(l.id) === top).map((l) => [l.id, l])).values(),
  ];
  const [license] = strictest;
  if (strictest.length > 1 || !license) {
    return { ok: false, reason: `conflicting licenses: ${strictest.map((l) => l.id).join(', ')}` };
  }
  return { ok: true, license };
}

function readLicense(permissions: JatsNode): Verdict {
  const licenses = findAllDescendants(permissions, 'license');
  const structured = [
    ...licenses.map((node) => attrOf(node, 'xlink:href') ?? ''),
    ...findAllDescendants(permissions, 'ali:license_ref').map((node) => textContent(node)),
  ].filter(Boolean);
  const prose = licenses.flatMap((node) => [
    ...[...findAllDescendants(node, 'ext-link'), ...findAllDescendants(node, 'uri')].map(
      (link) => attrOf(link, 'xlink:href') ?? textContent(link),
    ),
    ...(textContent(node).match(/https?:\/\/[^\s"<>)]+/g) ?? []).map((url) =>
      url.replace(/[.,;:]+$/, ''),
    ),
  ]);
  return settleLicense([...new Set(structured)], [...new Set(prose.filter(Boolean))]);
}

// ── Front matter ────────────────────────────────────────────────────────────

const initials = (given: string) =>
  given
    .split(/[\s.-]+/)
    .filter(Boolean)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('');

function authorNames(articleMeta: JatsNode): string[] {
  return findAllDescendants(articleMeta, 'contrib')
    .filter((c) => (attrOf(c, 'contrib-type') ?? 'author') === 'author')
    .map((c) => {
      const collab = findOne(c, 'collab');
      if (collab) return textContent(collab);
      const name = findOne(c, 'name') ?? findOne(findOne(c, 'name-alternatives'), 'name');
      const surname = textContent(findOne(name, 'surname'));
      const given = textContent(findOne(name, 'given-names'));
      return [surname, given ? initials(given) : ''].filter(Boolean).join(' ');
    })
    .filter(Boolean);
}

const sentence = (value: string) => (/[.?!]$/.test(value) ? value : `${value}.`);

function attribution(front: JatsNode, articleMeta: JatsNode, title: string, doi?: string): string {
  const names = authorNames(articleMeta);
  const authors =
    names.length === 0
      ? ''
      : names.length > 6
        ? `${names.slice(0, 6).join(', ')}, et al.`
        : `${names.join(', ')}.`;
  const journal = textContent(
    findAllDescendants(findOne(front, 'journal-meta'), 'journal-title')[0],
  );
  const dates = findAllDescendants(articleMeta, 'pub-date');
  const dateType = (d: JatsNode) => attrOf(d, 'pub-type') ?? attrOf(d, 'date-type');
  const date =
    ['epub', 'pub', 'ppub', 'collection']
      .map((type) => dates.find((d) => dateType(d) === type))
      .find(Boolean) ?? dates[0];
  const year = textContent(findOne(date, 'year'));
  const volume = textContent(findOne(articleMeta, 'volume'));
  const issue = textContent(findOne(articleMeta, 'issue'));
  const fpage = textContent(findOne(articleMeta, 'fpage'));
  const lpage = textContent(findOne(articleMeta, 'lpage'));
  const pages = fpage
    ? [fpage, lpage].filter(Boolean).join('–')
    : textContent(findOne(articleMeta, 'elocation-id'));
  const venue = [
    journal ? `${journal}.` : '',
    [year, volume && `;${volume}`, issue && `(${issue})`, pages && `:${pages}`].join(''),
  ]
    .filter(Boolean)
    .join(' ');
  return [authors, sentence(title), venue && sentence(venue), doi && `doi:${doi}`]
    .filter(Boolean)
    .join(' ');
}

// ── PubMed records ──────────────────────────────────────────────────────────

const parseXml = (bytes: Uint8Array) =>
  new XMLParser(ORDERED_XML_PARSER_OPTIONS).parse(new TextDecoder().decode(bytes)) as JatsNodeList;

/** Text of the `ArticleId` of `type` in an `ArticleIdList`, or `''`. */
function articleIdOfType(idList: JatsNode | undefined, type: string): string {
  return textContent(findAll(idList, 'ArticleId').find((node) => attrOf(node, 'IdType') === type));
}

/** `Surname Initials` for each valid author, or the group's name for a collective one. */
function pubmedAuthorNames(article: JatsNode): string[] {
  return findAll(findOne(article, 'AuthorList'), 'Author')
    .filter((author) => attrOf(author, 'ValidYN') !== 'N')
    .map((author) => {
      const collective = textContent(findOne(author, 'CollectiveName'));
      if (collective) return collective;
      return [textContent(findOne(author, 'LastName')), textContent(findOne(author, 'Initials'))]
        .filter(Boolean)
        .join(' ');
    })
    .filter(Boolean);
}

/** The {@link attribution} line, built from a PubMed `Article`. */
function pubmedAttribution(article: JatsNode, title: string, doi: string): string {
  const names = pubmedAuthorNames(article);
  const authors =
    names.length === 0
      ? ''
      : names.length > 6
        ? `${names.slice(0, 6).join(', ')}, et al.`
        : `${names.join(', ')}.`;
  const journal = findOne(article, 'Journal');
  const issue = findOne(journal, 'JournalIssue');
  const pubDate = findOne(issue, 'PubDate');
  const year =
    textContent(findOne(pubDate, 'Year')) ||
    (textContent(findOne(pubDate, 'MedlineDate')).match(/\d{4}/)?.[0] ?? '');
  const volume = textContent(findOne(issue, 'Volume'));
  const issueNumber = textContent(findOne(issue, 'Issue'));
  const pages =
    textContent(findOne(findOne(article, 'Pagination'), 'MedlinePgn')) ||
    textContent(findAll(article, 'ELocationID').find((node) => attrOf(node, 'EIdType') !== 'doi'));
  const journalTitle = textContent(findOne(journal, 'Title'));
  const venue = [
    journalTitle ? `${journalTitle}.` : '',
    [year, volume && `;${volume}`, issueNumber && `(${issueNumber})`, pages && `:${pages}`].join(
      '',
    ),
  ]
    .filter(Boolean)
    .join(' ');
  return [authors, sentence(title), venue && sentence(venue), doi && `doi:${doi}`]
    .filter(Boolean)
    .join(' ');
}

interface AddOptions {
  dryRun: boolean;
  features: string[];
  notes: string | undefined;
  regression: string | undefined;
}

/**
 * Add one PubMed record: fetch it, read its PMCID from `PubmedData/ArticleIdList`,
 * settle the license from that PMC article's `<permissions>`, then write the record's
 * bytes and `meta.json`. Every refusal exits before anything is written.
 */
async function addPubmedRecord(pmidArg: string, options: AddOptions): Promise<void> {
  const pmid = pmidArg.replace(/^PMID:?/i, '');
  if (!/^[1-9]\d*$/.test(pmid)) fail(`not a PMID: ${pmidArg}`);
  const unknownTags = options.features.filter(
    (f) => !(PUBMED_FEATURES as readonly string[]).includes(f),
  );
  if (unknownTags.length > 0) {
    fail(
      `unknown feature tag(s): ${unknownTags.join(', ')} — add them to PUBMED_FEATURES in tests/corpus/features.ts first`,
    );
  }
  const id = `pmid${pmid}`;
  const dir = join(PUBMED_FIXTURES_DIR, id);
  if (existsSync(dir)) fail(`${dir} already exists — remove it first to re-add`);

  const bytes = await fetchBody(requestUrl(pmid, 'pubmed'));
  const set = findOne(parseXml(bytes), 'PubmedArticleSet');
  if (findOne(set, 'PubmedBookArticle')) {
    fail(
      `license refused: PMID ${pmid} is a Bookshelf record, which has no PMC copy whose <permissions> could state a license`,
    );
  }
  const record = findOne(set, 'PubmedArticle');
  const citation = findOne(record, 'MedlineCitation');
  const article = findOne(citation, 'Article');
  if (!record || !article) {
    fail(
      `PMID ${pmid}: EFetch returned no <PubmedArticle> (${new TextDecoder().decode(bytes).slice(0, 200)})`,
    );
  }
  const returnedPmid = textContent(findOne(citation, 'PMID'));
  if (returnedPmid !== pmid) fail(`PMID ${pmid}: EFetch returned PMID ${returnedPmid}`);

  const idList = findOne(findOne(record, 'PubmedData'), 'ArticleIdList');
  const pmcid = articleIdOfType(idList, 'pmc');
  if (!/^PMC\d+$/.test(pmcid)) {
    fail(`license refused: PMID ${pmid} has no PMC copy, so no <permissions> states its license`);
  }
  const pmcNumericId = pmcid.slice(3);
  const localCopy = join(PMC_FIXTURES_DIR, `pmc${pmcNumericId}`, 'source.xml');
  const pmcBytes = existsSync(localCopy)
    ? new Uint8Array(readFileSync(localCopy))
    : await fetchBody(requestUrl(pmcNumericId));
  const pmcMeta = findOne(
    findOne(findOne(findOne(parseXml(pmcBytes), 'pmc-articleset'), 'article'), 'front'),
    'article-meta',
  );
  if (!pmcMeta) fail(`${pmcid}: PMC EFetch returned no <article-meta>`);
  const pmcPmid = textContent(
    findAll(pmcMeta, 'article-id').find((node) => attrOf(node, 'pub-id-type') === 'pmid'),
  );
  if (pmcPmid && pmcPmid !== pmid) fail(`${pmcid} names PMID ${pmcPmid}, not ${pmid}`);
  const permissions = findOne(pmcMeta, 'permissions');
  if (!permissions) fail(`license refused: ${pmcid} has no <permissions>`);
  const verdict = readLicense(permissions);
  if (!verdict.ok) {
    fail(
      `license refused: ${verdict.reason}; ${pmcid}'s statement reads "${textContent(permissions).slice(0, 300)}"`,
    );
  }

  const title = textContent(findOne(article, 'ArticleTitle'));
  if (!title) fail(`PMID ${pmid}: no <ArticleTitle>`);
  const doi =
    articleIdOfType(idList, 'doi') ||
    textContent(findAll(article, 'ELocationID').find((node) => attrOf(node, 'EIdType') === 'doi'));
  const meta: PubmedFixtureMeta = {
    id,
    title,
    identifiers: { pmid, pmcid, ...(doi && { doi }) },
    url: pubmedEfetchUrl(pmid),
    retrieved: new Date().toISOString().slice(0, 10),
    license: { ...verdict.license, source: efetchUrl(pmcNumericId) },
    attribution: pubmedAttribution(article, title, doi),
    features: options.features as PubmedFixtureMeta['features'],
    ...(options.regression && { regression: options.regression }),
    ...(options.notes && { notes: options.notes }),
  };
  const check = pubmedFixtureMetaSchema.safeParse(meta);
  if (!check.success) {
    fail(`meta.json would be invalid:\n${JSON.stringify(check.error.issues, null, 2)}`);
  }
  const metaJson = `${JSON.stringify(meta, null, 2)}\n`;
  const licenseFrom = existsSync(localCopy) ? `the corpus copy of ${pmcid}` : pmcid;
  if (options.dryRun) {
    console.log(metaJson);
    console.log(
      `dry run: ${bytes.byteLength} bytes would go to ${dir} (license from ${licenseFrom})`,
    );
    return;
  }
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'source.xml'), bytes);
  writeFileSync(join(dir, 'meta.json'), metaJson);
  console.log(
    `added pubmed/${id} (${bytes.byteLength} bytes, ${verdict.license.id} from ${licenseFrom})`,
  );
  writeAttribution();
}

// ── CLI ─────────────────────────────────────────────────────────────────────

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    attribution: { type: 'boolean' },
    'dry-run': { type: 'boolean' },
    features: { type: 'string' },
    kind: { type: 'string', default: 'pmc' },
    notes: { type: 'string' },
    regression: { type: 'string' },
  },
});

if (values.attribution) {
  writeAttribution();
  process.exit(0);
}

if (values.kind === 'pubmed') {
  const [pmidArg] = positionals;
  if (positionals.length !== 1 || !pmidArg) {
    fail(
      'usage: bun run scripts/corpus-add.ts --kind pubmed <PMID> [--features a,b] [--regression cyanheads/pubmed-mcp-server#N] [--notes "…"] [--dry-run]',
    );
  }
  await addPubmedRecord(pmidArg, {
    dryRun: values['dry-run'] ?? false,
    features: (values.features ?? '')
      .split(',')
      .map((f) => f.trim())
      .filter(Boolean),
    notes: values.notes,
    regression: values.regression,
  });
  process.exit(0);
}
if (values.kind !== 'pmc') fail(`unknown --kind ${values.kind}: pmc or pubmed`);

const [pmcidArg] = positionals;
const numericId = pmcidArg?.toUpperCase().replace(/^PMC/, '') ?? '';
if (positionals.length !== 1 || !/^\d+$/.test(numericId)) {
  fail(
    'usage: bun run scripts/corpus-add.ts <PMCID> [--features a,b] [--regression cyanheads/pubmed-mcp-server#N] [--notes "…"] [--dry-run] | --attribution',
  );
}

const features = (values.features ?? '')
  .split(',')
  .map((f) => f.trim())
  .filter(Boolean);
const unknown = features.filter((f) => !(FEATURES as readonly string[]).includes(f));
if (unknown.length > 0) {
  fail(
    `unknown feature tag(s): ${unknown.join(', ')} — add them to tests/corpus/features.ts first`,
  );
}

const id = `pmc${numericId}`;
const dir = join(PMC_FIXTURES_DIR, id);
if (existsSync(dir)) fail(`${dir} already exists — remove it first to re-add`);

const url = requestUrl(numericId);
const gate = process.env.NCBI_PACE_SCRIPT;
const bytes = gate ? fetchThroughGate(gate, url) : await fetchPaced(url);

const source = new TextDecoder().decode(bytes);
const tree = new XMLParser(ORDERED_XML_PARSER_OPTIONS).parse(source) as JatsNodeList;
const article = findOne(findOne(tree, 'pmc-articleset'), 'article');
if (!article) fail(`PMC${numericId}: EFetch returned no <article> (${source.slice(0, 200)})`);
const front = findOne(article, 'front');
const articleMeta = findOne(front, 'article-meta');
if (!front || !articleMeta) fail(`PMC${numericId}: no <front>/<article-meta>`);
if (!findOne(article, 'body')) {
  fail(`PMC${numericId}: no <body> — PMC serves this article as front matter only`);
}

const permissions = findOne(articleMeta, 'permissions');
if (!permissions) fail(`license refused: PMC${numericId} has no <permissions>`);
const verdict = readLicense(permissions);
if (!verdict.ok) {
  fail(
    `license refused: ${verdict.reason}; statement reads "${textContent(permissions).slice(0, 300)}"`,
  );
}

const articleId = (type: string) =>
  textContent(
    findAll(articleMeta, 'article-id').find((node) => attrOf(node, 'pub-id-type') === type),
  );
const pmid = articleId('pmid');
const doi = articleId('doi');
const title = textContent(findOne(findOne(articleMeta, 'title-group'), 'article-title'));
if (!title) fail(`PMC${numericId}: no <article-title>`);

const meta: FixtureMeta = {
  id,
  title,
  identifiers: {
    pmcid: `PMC${numericId}`,
    ...(/^\d+$/.test(pmid) && { pmid }),
    ...(doi && { doi }),
  },
  url: efetchUrl(numericId),
  retrieved: new Date().toISOString().slice(0, 10),
  license: verdict.license,
  attribution: attribution(front, articleMeta, title, doi || undefined),
  features: features as FixtureMeta['features'],
  ...(values.regression && { regression: values.regression }),
  ...(values.notes && { notes: values.notes }),
};
const check = fixtureMetaSchema.safeParse(meta);
if (!check.success)
  fail(`meta.json would be invalid:\n${JSON.stringify(check.error.issues, null, 2)}`);

const metaJson = `${JSON.stringify(meta, null, 2)}\n`;
if (values['dry-run']) {
  console.log(metaJson);
  console.log(`dry run: ${bytes.byteLength} bytes would go to ${dir}`);
  process.exit(0);
}

mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, 'source.xml'), bytes);
writeFileSync(join(dir, 'meta.json'), metaJson);
console.log(`added pmc/${id} (${bytes.byteLength} bytes, ${verdict.license.id})`);
writeAttribution();
