/**
 * @fileoverview Parser for PMC full-text articles in JATS XML format.
 * Consumes the ordered tree shape from fast-xml-parser's `preserveOrder: true`
 * mode (see `pmc-xml-helpers.ts`) so that mixed-content elements — `<p>`,
 * `<abstract>`, `<title>` with inline `<italic>`, `<xref>`, `<sup>`, etc. —
 * read back in document order. Parsing in the default object shape scrambles
 * inline children and drops body sections for markup-heavy articles.
 * @module src/services/ncbi/parsing/pmc-article-parser
 */

import type {
  ParsedPmcArticle,
  ParsedPmcAuthor,
  ParsedPmcJournal,
  ParsedPmcReference,
  ParsedPmcSection,
} from '../types.js';
import {
  attrOf,
  childrenOf,
  findAll,
  findOne,
  type JatsNode,
  tagNameOf,
  textContent,
} from './pmc-xml-helpers.js';

// ─── Article IDs ────────────────────────────────────────────────────────────

function extractArticleId(
  articleMeta: JatsNode | undefined,
  pubIdType: string,
): string | undefined {
  if (!articleMeta) return;
  for (const idNode of findAll(articleMeta, 'article-id')) {
    if (attrOf(idNode, 'pub-id-type') === pubIdType) {
      return textContent(idNode) || undefined;
    }
  }
  return;
}

// ─── Authors & Affiliations ─────────────────────────────────────────────────

/** Extract authors from a single `<contrib-group>` node. Non-author contributors are skipped. */
export function extractJatsAuthors(contribGroup: JatsNode | undefined): ParsedPmcAuthor[] {
  if (!contribGroup) return [];

  const authors: ParsedPmcAuthor[] = [];
  for (const contrib of findAll(contribGroup, 'contrib')) {
    const contribType = attrOf(contrib, 'contrib-type');
    if (contribType && contribType !== 'author') continue;

    const collab = findOne(contrib, 'collab');
    if (collab) {
      const collectiveName = textContent(collab);
      if (collectiveName) authors.push({ collectiveName });
      continue;
    }

    const nameNode = findOne(contrib, 'name');
    if (nameNode) {
      const lastName = textContent(findOne(nameNode, 'surname')) || undefined;
      const givenNames = textContent(findOne(nameNode, 'given-names')) || undefined;
      authors.push({
        ...(lastName && { lastName }),
        ...(givenNames && { givenNames }),
      });
    }
  }

  return authors;
}

function extractAffiliations(articleMeta: JatsNode | undefined): string[] {
  if (!articleMeta) return [];
  const result: string[] = [];
  for (const aff of findAll(articleMeta, 'aff')) {
    const text = textContent(aff);
    if (text) result.push(text);
  }
  return result;
}

// ─── Journal & Publication Date ─────────────────────────────────────────────

function extractJournal(
  journalMeta: JatsNode | undefined,
  articleMeta: JatsNode | undefined,
): ParsedPmcJournal | undefined {
  if (!journalMeta) return;

  const titleGroup = findOne(journalMeta, 'journal-title-group');
  const title =
    textContent(findOne(titleGroup, 'journal-title')) ||
    textContent(findOne(journalMeta, 'journal-title')) ||
    undefined;

  const firstIssn = findAll(journalMeta, 'issn')[0];
  const issn = firstIssn ? textContent(firstIssn) || undefined : undefined;

  const volume = articleMeta ? textContent(findOne(articleMeta, 'volume')) || undefined : undefined;
  const issue = articleMeta ? textContent(findOne(articleMeta, 'issue')) || undefined : undefined;
  const fpage = articleMeta ? textContent(findOne(articleMeta, 'fpage')) : '';
  const lpage = articleMeta ? textContent(findOne(articleMeta, 'lpage')) : '';
  const pages = fpage && lpage ? `${fpage}-${lpage}` : fpage || undefined;

  if (!title && !issn && !volume && !issue && !pages) return;

  return {
    ...(title && { title }),
    ...(issn && { issn }),
    ...(volume && { volume }),
    ...(issue && { issue }),
    ...(pages && { pages }),
  };
}

function extractPubDate(
  articleMeta: JatsNode | undefined,
): { day?: string; month?: string; year?: string } | undefined {
  if (!articleMeta) return;

  const dates = findAll(articleMeta, 'pub-date');
  if (dates.length === 0) return;

  const preferred =
    dates.find((d) => attrOf(d, 'pub-type') === 'epub') ??
    dates.find((d) => attrOf(d, 'pub-type') === 'ppub') ??
    dates.find((d) => attrOf(d, 'date-type') === 'pub') ??
    dates[0];

  if (!preferred) return;

  const year = textContent(findOne(preferred, 'year')) || undefined;
  if (!year) return;

  const month = textContent(findOne(preferred, 'month')) || undefined;
  const day = textContent(findOne(preferred, 'day')) || undefined;
  return {
    year,
    ...(month && { month }),
    ...(day && { day }),
  };
}

// ─── Abstract & Keywords ────────────────────────────────────────────────────

function extractAbstract(articleMeta: JatsNode | undefined): string | undefined {
  if (!articleMeta) return;
  const abstractNode = findOne(articleMeta, 'abstract');
  if (!abstractNode) return;

  const sections = findAll(abstractNode, 'sec');
  if (sections.length > 0) {
    const parts: string[] = [];
    for (const sec of sections) {
      const title = textContent(findOne(sec, 'title'));
      const text = findAll(sec, 'p')
        .map((p) => textContent(p))
        .filter(Boolean)
        .join(' ');
      if (title && text) parts.push(`${title}: ${text}`);
      else if (text) parts.push(text);
    }
    return parts.join('\n\n').trim() || undefined;
  }

  const paragraphs = findAll(abstractNode, 'p');
  if (paragraphs.length > 0) {
    return (
      paragraphs
        .map((p) => textContent(p))
        .filter(Boolean)
        .join(' ') || undefined
    );
  }

  return textContent(abstractNode) || undefined;
}

function extractKeywords(articleMeta: JatsNode | undefined): string[] {
  if (!articleMeta) return [];
  const keywords: string[] = [];
  for (const group of findAll(articleMeta, 'kwd-group')) {
    for (const kwd of findAll(group, 'kwd')) {
      const text = textContent(kwd);
      if (text) keywords.push(text);
    }
  }
  return keywords;
}

// ─── Body Sections ──────────────────────────────────────────────────────────

/**
 * Extract body sections from a `<body>` node, walking children in document order.
 * Consecutive bare `<p>` siblings are collected into an untitled section so
 * articles with mixed structure (direct paragraphs + trailing `<sec>`, common
 * in manuscript-submitted PMC deposits) preserve their main text.
 */
export function extractBodySections(body: JatsNode | undefined): ParsedPmcSection[] {
  if (!body) return [];

  const sections: ParsedPmcSection[] = [];
  let pendingParagraphs: string[] = [];

  const flushPending = () => {
    if (pendingParagraphs.length > 0) {
      sections.push({ text: pendingParagraphs.join('\n\n') });
      pendingParagraphs = [];
    }
  };

  for (const child of childrenOf(body)) {
    const tag = tagNameOf(child);
    if (tag === 'p') {
      const text = textContent(child);
      if (text) pendingParagraphs.push(text);
    } else if (tag === 'sec') {
      flushPending();
      const section = extractSection(child);
      if (section) sections.push(section);
    }
  }
  flushPending();

  return sections;
}

function extractSection(sec: JatsNode): ParsedPmcSection | null {
  const title = textContent(findOne(sec, 'title')) || undefined;
  const label = textContent(findOne(sec, 'label')) || undefined;

  const paragraphs = findAll(sec, 'p');
  const textParts = paragraphs.map((p) => textContent(p)).filter(Boolean);

  const subsections = findAll(sec, 'sec')
    .map(extractSection)
    .filter((s): s is ParsedPmcSection => s !== null);

  const text = textParts.join('\n\n');
  if (!text && subsections.length === 0) return null;

  return {
    ...(title && { title }),
    ...(label && { label }),
    text,
    ...(subsections.length > 0 && { subsections }),
  };
}

// ─── References ─────────────────────────────────────────────────────────────

/** Extract references from a `<back>` node. Prefers mixed-citation over element-citation. */
export function extractReferences(back: JatsNode | undefined): ParsedPmcReference[] {
  if (!back) return [];
  const refList = findOne(back, 'ref-list');
  if (!refList) return [];

  const results: ParsedPmcReference[] = [];
  for (const ref of findAll(refList, 'ref')) {
    const citationNode = findOne(ref, 'mixed-citation') ?? findOne(ref, 'element-citation');
    if (!citationNode) continue;
    const citation = textContent(citationNode);
    if (!citation) continue;

    const id = attrOf(ref, 'id');
    const label = textContent(findOne(ref, 'label')) || undefined;
    results.push({
      ...(id && { id }),
      ...(label && { label }),
      citation,
    });
  }

  return results;
}

// ─── Main Parser ────────────────────────────────────────────────────────────

/**
 * Parse a single JATS `<article>` node (from PMC EFetch via the ordered parser)
 * into a structured `ParsedPmcArticle`. The input node is the element wrapper
 * itself — `{ article: [...], ':@': { '@_article-type': ... } }` — not the
 * outer `<pmc-articleset>`.
 */
export function parsePmcArticle(articleNode: JatsNode): ParsedPmcArticle {
  const front = findOne(articleNode, 'front');
  const articleMeta = findOne(front, 'article-meta');
  const journalMeta = findOne(front, 'journal-meta');
  const body = findOne(articleNode, 'body');
  const back = findOne(articleNode, 'back');

  const pmcId =
    extractArticleId(articleMeta, 'pmcid') ?? extractArticleId(articleMeta, 'pmc-uid') ?? '';
  const pmid = extractArticleId(articleMeta, 'pmid');
  const doi = extractArticleId(articleMeta, 'doi');

  const titleGroup = findOne(articleMeta, 'title-group');
  const title = textContent(findOne(titleGroup, 'article-title')) || undefined;

  const authors = collectAuthors(articleMeta);
  const affiliations = extractAffiliations(articleMeta);
  const journal = extractJournal(journalMeta, articleMeta);
  const publicationDate = extractPubDate(articleMeta);
  const abstract = extractAbstract(articleMeta);
  const keywords = extractKeywords(articleMeta);
  const sections = extractBodySections(body);
  const references = extractReferences(back);

  const normalizedPmcId = !pmcId ? '' : pmcId.startsWith('PMC') ? pmcId : `PMC${pmcId}`;
  const articleType = attrOf(articleNode, 'article-type');

  return {
    pmcId: normalizedPmcId,
    ...(pmid && { pmid }),
    ...(doi && { doi }),
    ...(title && { title }),
    ...(authors.length > 0 && { authors }),
    ...(affiliations.length > 0 && { affiliations }),
    ...(journal && { journal }),
    ...(publicationDate && { publicationDate }),
    ...(abstract && { abstract }),
    ...(keywords.length > 0 && { keywords }),
    sections,
    ...(references.length > 0 && { references }),
    ...(articleType && { articleType }),
    pmcUrl: `https://www.ncbi.nlm.nih.gov/pmc/articles/${normalizedPmcId}/`,
    ...(pmid && { pubmedUrl: `https://pubmed.ncbi.nlm.nih.gov/${pmid}/` }),
  };
}

/** Collect authors across every `<contrib-group>` under `<article-meta>`. */
function collectAuthors(articleMeta: JatsNode | undefined): ParsedPmcAuthor[] {
  if (!articleMeta) return [];
  const result: ParsedPmcAuthor[] = [];
  for (const group of findAll(articleMeta, 'contrib-group')) {
    result.push(...extractJatsAuthors(group));
  }
  return result;
}
