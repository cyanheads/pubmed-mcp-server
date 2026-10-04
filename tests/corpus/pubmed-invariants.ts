/**
 * @fileoverview Properties every PubMed fixture's `pubmed_fetch_articles` and
 * `pubmed_format_citations` results must have, checked against the fixture's own
 * `source.xml`. The source side is read with plain regular expressions, never the
 * parser under test, so a parser fault cannot hide by being applied to both sides.
 * Each check returns the problems it found, so one run reports every broken invariant.
 * @module tests/corpus/pubmed-invariants
 */
import {
  decodeText,
  leakedTag,
  MISSING_TOKENS,
  renderedMissing,
  sourceElementNames,
  sourceTokens,
  undecodedEntity,
} from './invariants.js';
import { CITATION_STYLES } from './pubmed-run-tools.js';

/** The fields of one returned `pubmed_fetch_articles` record the corpus reads. */
export interface PubmedCorpusArticle {
  abstractText?: string;
  affiliations?: string[];
  articleDates?: { dateType?: string; day?: string; month?: string; year?: string }[];
  authors?: {
    affiliationIndices?: number[];
    collectiveName?: string;
    firstName?: string;
    initials?: string;
    lastName?: string;
    orcid?: string;
  }[];
  commentsCorrections?: { note?: string; pmid?: string; refSource: string; refType: string }[];
  doi?: string;
  grantList?: { acronym?: string; agency?: string; country?: string; grantId?: string }[];
  journalInfo?: {
    elocationId?: string;
    elocationIdType?: string;
    eIssn?: string;
    isoAbbreviation?: string;
    issn?: string;
    issue?: string;
    pages?: string;
    publicationDate?: { day?: string; medlineDate?: string; month?: string; year?: string };
    title?: string;
    volume?: string;
  };
  keywords?: string[];
  meshTerms?: {
    descriptorName?: string;
    descriptorUi?: string;
    isMajorTopic: boolean;
    qualifiers?: { isMajorTopic: boolean; qualifierName: string; qualifierUi?: string }[];
  }[];
  pmcId?: string;
  pmid?: string;
  publicationTypes?: string[];
  recordType: string;
  title?: string;
}

/** One `pubmed_format_citations` entry. */
export interface PubmedCorpusCitation {
  citations: Record<string, string>;
  pmid: string;
  title?: string;
}

/** A tool's two surfaces: `content[]` text and every `structuredContent` string. */
export interface Surfaces {
  strings: { path: string; value: string }[];
  text: string;
}

export interface PubmedInvariantInput {
  article: PubmedCorpusArticle;
  articleSurfaces: Surfaces;
  citation: PubmedCorpusCitation;
  citationSurfaces: Surfaces;
  /** The fixture's `source.xml`, decoded. */
  source: string;
}

// ── Reading the source ──────────────────────────────────────────────────────

interface SourceElement {
  attrs: string;
  inner: string;
}

/** Every `<tag …>…</tag>` in `xml`; `<Article>` never matches `<ArticleTitle>`. */
function elements(xml: string, tag: string): SourceElement[] {
  return [...xml.matchAll(new RegExp(`<${tag}(\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'g'))].map(
    (m) => ({ attrs: m[1] ?? '', inner: m[2] ?? '' }),
  );
}

/** The inner XML of the first `<tag>` in `xml`, or `''`. */
const inner = (xml: string, tag: string) => elements(xml, tag)[0]?.inner ?? '';

function attr(attrs: string, name: string): string | undefined {
  const value = new RegExp(`\\s${name}="([^"]*)"`).exec(attrs)?.[1];
  return value === undefined ? undefined : decodeText(value);
}

/**
 * The text a reader sees: markup dropped, entities decoded — twice, since NCBI
 * double-encodes an ampersand in some fields (`CSR&amp;amp;D`) — whitespace collapsed.
 */
function plain(xml: string): string {
  return decodeText(decodeText(xml.replace(/<[^>]*>/g, '')))
    .replace(/\s+/g, ' ')
    .trim();
}

const texts = (xml: string, tag: string) =>
  elements(xml, tag)
    .map((e) => plain(e.inner))
    .filter(Boolean);

/** The text of the first `<tag>` in `xml`; `undefined` when it is absent or empty. */
function textOf(xml: string, tag: string): string | undefined {
  const element = elements(xml, tag)[0];
  return element ? plain(element.inner) || undefined : undefined;
}

/** The parts of the source every check reads. */
function sourceParts(source: string) {
  const article = inner(source, 'Article');
  const citation = inner(source, 'MedlineCitation');
  return {
    article,
    authors: elements(inner(article, 'AuthorList'), 'Author').filter(
      (e) => attr(e.attrs, 'ValidYN') !== 'N',
    ),
    authorList: inner(article, 'AuthorList'),
    headings: elements(inner(citation, 'MeshHeadingList'), 'MeshHeading'),
    grants: elements(inner(article, 'GrantList'), 'Grant'),
    keywords: texts(inner(citation, 'KeywordList'), 'Keyword'),
    notices: elements(inner(citation, 'CommentsCorrectionsList'), 'CommentsCorrections').filter(
      (e) => attr(e.attrs, 'RefType') !== 'Cites',
    ),
  };
}

// ── Comparing text ──────────────────────────────────────────────────────────

const FOLD: Record<string, string> = Object.fromEntries([
  ...[...'⁰¹²³⁴⁵⁶⁷⁸⁹'].map((ch, i) => [ch, String(i)]),
  ...[...'₀₁₂₃₄₅₆₇₈₉'].map((ch, i) => [ch, String(i)]),
  ['ⁿ', 'n'],
  ['ⁱ', 'i'],
]);

/**
 * The words of `value`, space-joined: Unicode super- and subscript digits folded back
 * to ASCII, everything but letters and digits treated as a separator. Two texts that
 * read the same compare equal whatever their punctuation, markdown escaping or
 * super/subscript rendering (`cm<sup>2</sup>` and `cm²`); a dropped or fused word does
 * not (`miR223<sup>-/<i>y</i></sup>` is `miR223 y`, a parse that loses the
 * superscript is `miR223`).
 */
export function words(value: string): string {
  const folded = [...value].map((ch) => FOLD[ch] ?? ch).join('');
  return ` ${folded.match(/[\p{L}\p{N}]+/gu)?.join(' ') ?? ''} `;
}

const reads = (haystack: string, needle: string) => words(haystack).includes(words(needle));
const readsIgnoringCase = (haystack: string, needle: string) =>
  words(haystack).toLowerCase().includes(words(needle).toLowerCase());

/**
 * Where `needle` stops reading in `haystacks`: the longest prefix of its words that some
 * one haystack holds, and the two words around the first that does not fit —
 * `mice miR223 ‸ y developed`. Prefix containment is monotonic, so a binary search
 * finds it.
 */
function divergence(haystacks: readonly string[], needle: string): string {
  const wanted = words(needle).trim().split(' ');
  const spaced = haystacks.map(words);
  const holds = (n: number) => {
    const prefix = ` ${wanted.slice(0, n).join(' ')} `;
    return spaced.some((h) => h.includes(prefix));
  };
  let [low, high] = [0, wanted.length];
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (holds(mid)) low = mid;
    else high = mid - 1;
  }
  const before = wanted.slice(Math.max(0, low - 2), low);
  return [...before, '‸', ...wanted.slice(low, low + 2)].join(' ');
}

// ── Checks ──────────────────────────────────────────────────────────────────

/** Source texts that must reach both surfaces of `pubmed_fetch_articles`, labelled. */
function conservedTexts(source: string): { field: string; value: string }[] {
  const { article, authors, authorList, grants, headings, keywords, notices } = sourceParts(source);
  const journal = inner(article, 'Journal');
  const out: { field: string; value: string }[] = [];
  const add = (field: string, values: string[]) => {
    for (const value of values) out.push({ field, value });
  };

  add('title', texts(article, 'ArticleTitle'));
  for (const { attrs, inner: xml } of elements(inner(article, 'Abstract'), 'AbstractText')) {
    const label = attr(attrs, 'Label');
    const text = plain(xml);
    if (text) out.push({ field: 'abstract', value: label ? `${label}: ${text}` : text });
  }
  for (const author of authors) {
    for (const tag of ['CollectiveName', 'LastName', 'ForeName', 'Initials']) {
      add('author', texts(author.inner, tag));
    }
  }
  add('affiliation', texts(authorList, 'Affiliation'));
  for (const tag of ['Title', 'ISOAbbreviation', 'ISSN', 'Volume', 'Issue']) {
    add(`journal ${tag}`, texts(journal, tag));
  }
  add('pages', texts(article, 'MedlinePgn'));
  add('keyword', keywords);
  add('publication type', texts(article, 'PublicationType'));
  for (const tag of ['DescriptorName', 'QualifierName']) {
    for (const heading of headings) {
      add(tag, texts(heading.inner, tag));
      add(
        `${tag} UI`,
        elements(heading.inner, tag).flatMap((e) => attr(e.attrs, 'UI') ?? []),
      );
    }
  }
  for (const grant of grants) {
    for (const tag of ['GrantID', 'Acronym', 'Agency', 'Country']) {
      add(tag, texts(grant.inner, tag));
    }
  }
  for (const notice of notices) {
    add('notice', [...texts(notice.inner, 'RefSource'), ...texts(notice.inner, 'Note')]);
  }
  return out;
}

/** The record's identifiers as the source states them. */
function sourceIds(source: string) {
  const ids = inner(source, 'PubmedData');
  const ofType = (type: string) =>
    elements(ids, 'ArticleId')
      .filter((e) => attr(e.attrs, 'IdType') === type)
      .map((e) => plain(e.inner))[0];
  const elocationDoi = elements(inner(source, 'Article'), 'ELocationID')
    .filter((e) => attr(e.attrs, 'EIdType') === 'doi')
    .map((e) => plain(e.inner))[0];
  return {
    doi: elocationDoi ?? ofType('doi'),
    pmc: ofType('pmc'),
    pmid: textOf(source, 'PMID'),
  };
}

/**
 * Field-by-field agreement with the source: the title and each abstract section read the
 * same; every author's name parts, ORCID and affiliations; the journal fields, verbatim
 * (a volume, page or locator coerced to a number loses its leading zeros); each article
 * date; each MeSH heading with its qualifiers and major-topic flags — a heading is major
 * when PubMed stars the heading, its descriptor or any qualifier, as PubMed's `[majr]`
 * search reads it; each grant; each linked notice; publication types and keywords, in
 * order.
 */
function fieldProblems(source: string, article: PubmedCorpusArticle): string[] {
  const problems: string[] = [];
  const parts = sourceParts(source);
  const differs = (what: string, wanted: unknown, got: unknown) => {
    if (JSON.stringify(wanted ?? null) !== JSON.stringify(got ?? null)) {
      problems.push(
        `${what} is ${JSON.stringify(wanted)} in the source, ${JSON.stringify(got)} returned`,
      );
    }
  };
  /** Date parts: the parser reads `<Month>05</Month>` as 5, which is the same date. */
  const sameNumber = (what: string, wanted: string | undefined, got: string | undefined) => {
    const numeric = (v?: string) => (v !== undefined && /^\d+$/.test(v) ? Number(v) : v);
    differs(what, numeric(wanted), numeric(got));
  };

  const title = textOf(parts.article, 'ArticleTitle') ?? '';
  if (words(title) !== words(article.title ?? '')) {
    const at = divergence([article.title ?? ''], title);
    problems.push(`title does not read as the source's: "${at}"`);
  }
  const sections = elements(inner(parts.article, 'Abstract'), 'AbstractText')
    .map(({ attrs, inner: xml }) => ({ label: attr(attrs, 'Label'), text: plain(xml) }))
    .filter((s) => s.text);
  const paragraphs = article.abstractText?.split('\n\n') ?? [];
  differs('abstract sections', sections.length, paragraphs.length);
  for (const [i, { label, text }] of sections.entries()) {
    const wanted = label ? `${label}: ${text}` : text;
    if (words(wanted) !== words(paragraphs[i] ?? '')) {
      const at = divergence([paragraphs[i] ?? ''], wanted);
      problems.push(`abstract section ${i} does not read as the source's: "${at}"`);
    }
  }

  for (const [i, { inner: xml }] of parts.authors.entries()) {
    const got = article.authors?.[i];
    const collective = textOf(xml, 'CollectiveName');
    if (collective) {
      differs(`author ${i} collectiveName`, collective, got?.collectiveName);
    } else {
      differs(`author ${i} lastName`, textOf(xml, 'LastName'), got?.lastName);
      differs(`author ${i} firstName`, textOf(xml, 'ForeName'), got?.firstName);
      differs(`author ${i} initials`, textOf(xml, 'Initials'), got?.initials);
    }
    const orcid = elements(xml, 'Identifier').find((e) => attr(e.attrs, 'Source') === 'ORCID');
    differs(`author ${i} orcid`, orcid && plain(orcid.inner), got?.orcid);
    const wanted = texts(xml, 'Affiliation');
    const returned = (got?.affiliationIndices ?? []).map((k) =>
      plain(article.affiliations?.[k] ?? ''),
    );
    if (JSON.stringify(wanted) !== JSON.stringify(returned)) {
      const name = collective ?? textOf(xml, 'LastName');
      const differing = wanted.filter((a, k) => a !== returned[k]).length;
      problems.push(
        `author ${i} (${name}) has ${wanted.length} affiliation(s) in the source, ${returned.length} returned, ${differing} differing`,
      );
    }
  }

  const journal = inner(parts.article, 'Journal');
  const issue = inner(journal, 'JournalIssue');
  const pubDate = inner(issue, 'PubDate');
  const ji = article.journalInfo;
  const issn = elements(journal, 'ISSN')[0];
  const electronic = issn !== undefined && attr(issn.attrs, 'IssnType') === 'Electronic';
  const locators = elements(parts.article, 'ELocationID').filter(
    (e) => attr(e.attrs, 'EIdType') !== 'doi' && attr(e.attrs, 'ValidYN') !== 'N',
  );
  const locator = locators.find((e) => attr(e.attrs, 'ValidYN') === 'Y') ?? locators[0];
  differs('journal title', textOf(journal, 'Title'), ji?.title);
  differs('journal isoAbbreviation', textOf(journal, 'ISOAbbreviation'), ji?.isoAbbreviation);
  differs('journal issn', issn && !electronic ? plain(issn.inner) : undefined, ji?.issn);
  differs('journal eIssn', issn && electronic ? plain(issn.inner) : undefined, ji?.eIssn);
  differs('journal volume', textOf(issue, 'Volume'), ji?.volume);
  differs('journal issue', textOf(issue, 'Issue'), ji?.issue);
  differs('journal pages', textOf(parts.article, 'MedlinePgn'), ji?.pages);
  differs('journal elocationId', locator && plain(locator.inner), ji?.elocationId);
  differs(
    'journal elocationIdType',
    locator && attr(locator.attrs, 'EIdType'),
    ji?.elocationIdType,
  );
  differs('PubDate Year', textOf(pubDate, 'Year'), ji?.publicationDate?.year);
  sameNumber('PubDate Month', textOf(pubDate, 'Month'), ji?.publicationDate?.month);
  sameNumber('PubDate Day', textOf(pubDate, 'Day'), ji?.publicationDate?.day);
  differs('PubDate MedlineDate', textOf(pubDate, 'MedlineDate'), ji?.publicationDate?.medlineDate);

  for (const [i, date] of elements(parts.article, 'ArticleDate').entries()) {
    const got = article.articleDates?.[i];
    differs(`ArticleDate ${i} type`, attr(date.attrs, 'DateType'), got?.dateType);
    sameNumber(`ArticleDate ${i} Year`, textOf(date.inner, 'Year'), got?.year);
    sameNumber(`ArticleDate ${i} Month`, textOf(date.inner, 'Month'), got?.month);
    sameNumber(`ArticleDate ${i} Day`, textOf(date.inner, 'Day'), got?.day);
  }

  const starred = (e?: SourceElement) => e !== undefined && attr(e.attrs, 'MajorTopicYN') === 'Y';
  for (const [i, heading] of parts.headings.entries()) {
    const got = article.meshTerms?.[i];
    const descriptor = elements(heading.inner, 'DescriptorName')[0];
    const qualifiers = elements(heading.inner, 'QualifierName');
    differs(`MeSH ${i} descriptor`, descriptor && plain(descriptor.inner), got?.descriptorName);
    differs(
      `MeSH ${i} descriptorUi`,
      descriptor && attr(descriptor.attrs, 'UI'),
      got?.descriptorUi,
    );
    differs(
      `MeSH ${i} qualifiers`,
      qualifiers.map((q) => [plain(q.inner), attr(q.attrs, 'UI'), starred(q)]),
      (got?.qualifiers ?? []).map((q) => [q.qualifierName, q.qualifierUi, q.isMajorTopic]),
    );
    differs(
      `MeSH ${i} major`,
      starred(heading) || starred(descriptor) || qualifiers.some(starred),
      got?.isMajorTopic,
    );
  }

  for (const [i, grant] of parts.grants.entries()) {
    const got = article.grantList?.[i];
    differs(`grant ${i} grantId`, textOf(grant.inner, 'GrantID'), got?.grantId);
    differs(`grant ${i} acronym`, textOf(grant.inner, 'Acronym'), got?.acronym);
    differs(`grant ${i} agency`, textOf(grant.inner, 'Agency'), got?.agency);
    differs(`grant ${i} country`, textOf(grant.inner, 'Country'), got?.country);
  }

  for (const [i, notice] of parts.notices.entries()) {
    const got = article.commentsCorrections?.[i];
    differs(`notice ${i} refType`, attr(notice.attrs, 'RefType'), got?.refType);
    differs(`notice ${i} refSource`, textOf(notice.inner, 'RefSource'), got?.refSource);
    differs(`notice ${i} pmid`, textOf(notice.inner, 'PMID'), got?.pmid);
    differs(`notice ${i} note`, textOf(notice.inner, 'Note'), got?.note);
  }

  differs(
    'publication types',
    texts(parts.article, 'PublicationType'),
    article.publicationTypes ?? [],
  );
  differs('keywords', parts.keywords, article.keywords ?? []);
  return problems;
}

/**
 * What the per-field checks cannot see: entries the output holds beyond the source's,
 * affiliations lost in the deduplicated list, and `content[]` listing a different
 * number of authors, notices, MeSH terms or grants than `structuredContent` returns.
 */
function countProblems(source: string, article: PubmedCorpusArticle, text: string): string[] {
  const problems: string[] = [];
  const parts = sourceParts(source);
  const counts: [string, number, number][] = [
    ['authors', parts.authors.length, article.authors?.length ?? 0],
    [
      'distinct affiliations',
      new Set(texts(parts.authorList, 'Affiliation')).size,
      article.affiliations?.length ?? 0,
    ],
    ['MeSH headings', parts.headings.length, article.meshTerms?.length ?? 0],
    ['grants', parts.grants.length, article.grantList?.length ?? 0],
    ['linked notices', parts.notices.length, article.commentsCorrections?.length ?? 0],
    [
      'article dates',
      elements(parts.article, 'ArticleDate').length,
      article.articleDates?.length ?? 0,
    ],
  ];
  for (const [what, wanted, got] of counts) {
    if (wanted !== got) problems.push(`${wanted} ${what} in the source, ${got} returned`);
  }

  const section = (heading: string) =>
    text.split(new RegExp(`^#### ${heading}$`, 'm'))[1]?.split(/^#### /m)[0] ?? '';
  const bullets = (heading: string) => (section(heading).match(/^- /gm) ?? []).length;
  const rendered: [string, number, number][] = [
    [
      'authors',
      Number(/^\*\*Authors \((\d+)\):\*\*$/m.exec(text)?.[1] ?? 0),
      article.authors?.length ?? 0,
    ],
    [
      'notices',
      Number(/^#### Comments and Corrections \((\d+)\)$/m.exec(text)?.[1] ?? 0),
      article.commentsCorrections?.length ?? 0,
    ],
    ['MeSH terms', bullets('MeSH Terms'), article.meshTerms?.length ?? 0],
    ['grants', bullets('Grants'), article.grantList?.length ?? 0],
  ];
  for (const [what, shown, returned] of rendered) {
    if (shown !== returned) {
      problems.push(`content[] lists ${shown} ${what}, structuredContent ${returned}`);
    }
  }
  return problems;
}

/** Every style requested, each carrying the DOI, year, first author, volume and title. */
function citationProblems(source: string, citation: PubmedCorpusCitation): string[] {
  const problems: string[] = [];
  const styles = Object.keys(citation.citations);
  if (styles.join() !== CITATION_STYLES.join()) {
    problems.push(`citation styles ${styles.join(', ')}; expected ${CITATION_STYLES.join(', ')}`);
  }
  const { article, authors } = sourceParts(source);
  const pubDate = inner(article, 'PubDate');
  const year = textOf(pubDate, 'Year') ?? /\d{4}/.exec(plain(pubDate))?.[0];
  const firstAuthor = authors[0]?.inner ?? '';
  const surname = textOf(firstAuthor, 'CollectiveName') ?? textOf(firstAuthor, 'LastName');
  const volume = textOf(article, 'Volume');
  const title = textOf(article, 'ArticleTitle')?.replace(/\.$/, '');
  const { doi } = sourceIds(source);
  for (const style of CITATION_STYLES) {
    const value = citation.citations[style];
    if (!value?.trim()) {
      problems.push(`${style}: empty`);
      continue;
    }
    if (doi && !value.toLowerCase().includes(doi.toLowerCase())) problems.push(`${style}: no DOI`);
    if (year && !value.includes(year)) problems.push(`${style}: no year ${year}`);
    if (surname && !reads(value, surname)) problems.push(`${style}: no first author "${surname}"`);
    if (volume && !reads(value, volume)) problems.push(`${style}: no volume ${volume}`);
    if (title && !readsIgnoringCase(value, title)) {
      problems.push(`${style}: title not read in full`);
    }
  }
  return problems;
}

/** Leaks and stringified missing values on one tool's two surfaces. */
function surfaceProblems(tool: string, surfaces: Surfaces, source: string): string[] {
  const problems: string[] = [];
  const names = sourceElementNames(source);
  for (const { path, value } of [
    { path: 'content[]', value: surfaces.text },
    ...surfaces.strings,
  ]) {
    const tag = leakedTag(value, names, source);
    if (tag) problems.push(`${tool}: leaked XML tag at ${path}: "${tag}"`);
    const entity = undecodedEntity(value, source);
    if (entity) problems.push(`${tool}: undecoded entity at ${path}: "${entity}"`);
  }
  const allowed = sourceTokens(source);
  const leakedValue = surfaces.strings.find(
    ({ value }) =>
      MISSING_TOKENS.some((token) => !allowed.has(token) && value.trim() === token) ||
      (!allowed.has('[object Object]') && value.includes('[object Object]')),
  );
  if (leakedValue) problems.push(`${tool}: a stringified missing value at ${leakedValue.path}`);
  const rendered = renderedMissing(surfaces.text, allowed);
  if (rendered) problems.push(`${tool}: "${rendered}" rendered as a value in content[]`);
  if (/^#{1,6}[ \t]*$/m.test(surfaces.text)) {
    problems.push(`${tool}: an empty heading in content[]`);
  }
  return problems;
}

/** Problems with one fixture's two results; empty when every invariant holds. */
export function checkPubmedInvariants({
  article,
  articleSurfaces,
  citation,
  citationSurfaces,
  source,
}: PubmedInvariantInput): string[] {
  const problems = [
    ...surfaceProblems('pubmed_fetch_articles', articleSurfaces, source),
    ...surfaceProblems('pubmed_format_citations', citationSurfaces, source),
  ];

  const structured = articleSurfaces.strings.map((s) => s.value);
  for (const { field, value } of conservedTexts(source)) {
    if (!structured.some((s) => reads(s, value))) {
      problems.push(`${field} not read in structuredContent: "${divergence(structured, value)}"`);
    }
    if (!reads(articleSurfaces.text, value)) {
      const at = divergence([articleSurfaces.text], value);
      problems.push(`${field} not read in content[]: "${at}"`);
    }
  }
  problems.push(...fieldProblems(source, article));

  const ids = sourceIds(source);
  if (article.pmid !== ids.pmid) problems.push(`pmid ${article.pmid}, source ${ids.pmid}`);
  if (citation.pmid !== ids.pmid) {
    problems.push(`citation pmid ${citation.pmid}, source ${ids.pmid}`);
  }
  if (article.doi !== ids.doi) problems.push(`doi ${article.doi}, source ${ids.doi}`);
  if (article.pmcId !== ids.pmc) problems.push(`pmcId ${article.pmcId}, source ${ids.pmc}`);
  if (citation.title !== article.title) problems.push('the two tools return different titles');

  problems.push(...countProblems(source, article, articleSurfaces.text));
  problems.push(...citationProblems(source, citation));
  return problems;
}
