/**
 * @fileoverview Parser for PMC full-text articles in JATS XML format.
 * Extracts metadata, body sections, and references from PMC EFetch responses.
 * @module src/services/ncbi/parsing/pmc-article-parser
 */

import type {
  ParsedPmcArticle,
  ParsedPmcAuthor,
  ParsedPmcJournal,
  ParsedPmcReference,
  ParsedPmcSection,
  XmlJatsArticle,
  XmlJatsArticleId,
  XmlJatsArticleMeta,
  XmlJatsBack,
  XmlJatsBody,
  XmlJatsContrib,
  XmlJatsContribGroup,
  XmlJatsJournalMeta,
  XmlJatsPubDate,
  XmlJatsRef,
  XmlJatsSection,
} from '../types.js';
import { ensureArray, getAttribute, getText } from './xml-helpers.js';

// ─── Text Extraction ────────────────────────────────────────────────────────

/**
 * Recursively extracts plain text content from a JATS XML node.
 * Handles mixed content where text and child elements are interleaved.
 * fast-xml-parser with `preserveOrder: false` stores text in `#text` and
 * child elements as named properties — document order is lost, but all
 * text content is preserved.
 */
export function extractTextContent(node: unknown): string {
  if (node === undefined || node === null) return '';
  if (typeof node === 'string') return node;
  if (typeof node === 'number' || typeof node === 'boolean') return String(node);

  if (Array.isArray(node)) {
    return node.map(extractTextContent).filter(Boolean).join(' ');
  }

  if (typeof node === 'object') {
    const obj = node as Record<string, unknown>;
    const parts: string[] = [];

    // Collect #text from this node
    if (obj['#text'] !== undefined) {
      const text = typeof obj['#text'] === 'string' ? obj['#text'] : String(obj['#text']);
      if (text) parts.push(text);
    }

    // Recurse into child elements (skip attributes prefixed with @_)
    for (const key of Object.keys(obj)) {
      if (key === '#text' || key.startsWith('@_')) continue;
      const childText = extractTextContent(obj[key]);
      if (childText) parts.push(childText);
    }

    return parts.join(' ').replace(/\s+/g, ' ').trim();
  }

  return '';
}

// ─── Article ID Extraction ──────────────────────────────────────────────────

/**
 * Extracts a specific article ID by pub-id-type from article-meta.
 */
function extractArticleId(
  articleIds: XmlJatsArticleId | XmlJatsArticleId[] | undefined,
  pubIdType: string,
): string | undefined {
  for (const id of ensureArray(articleIds)) {
    if (getAttribute(id, 'pub-id-type') === pubIdType) {
      const val = id['#text'];
      if (val !== undefined) return String(val);
    }
  }
  return;
}

// ─── Author Extraction ──────────────────────────────────────────────────────

/**
 * Extracts authors from JATS contrib-group elements.
 * Only includes contributors with contrib-type="author".
 */
export function extractJatsAuthors(
  contribGroups: XmlJatsContribGroup | XmlJatsContribGroup[] | undefined,
): ParsedPmcAuthor[] {
  if (!contribGroups) return [];

  const authors: ParsedPmcAuthor[] = [];
  for (const group of ensureArray(contribGroups)) {
    for (const contrib of ensureArray(group.contrib) as XmlJatsContrib[]) {
      // Only include authors (skip editors, etc.)
      if (contrib['@_contrib-type'] && contrib['@_contrib-type'] !== 'author') continue;

      const collectiveName = extractTextContent(contrib.collab);
      if (collectiveName) {
        authors.push({ collectiveName });
        continue;
      }

      if (contrib.name) {
        const lastName = extractTextContent(contrib.name.surname) || undefined;
        const givenNames = extractTextContent(contrib.name['given-names']) || undefined;
        authors.push({
          ...(lastName && { lastName }),
          ...(givenNames && { givenNames }),
        });
      }
    }
  }

  return authors;
}

// ─── Affiliation Extraction ─────────────────────────────────────────────────

/**
 * Extracts affiliation strings from JATS aff elements.
 */
function extractAffiliations(
  affs:
    | { '#text'?: string; [key: string]: unknown }
    | { '#text'?: string; [key: string]: unknown }[]
    | undefined,
): string[] {
  if (!affs) return [];
  const result: string[] = [];
  for (const aff of ensureArray(affs)) {
    const text = extractTextContent(aff);
    if (text) result.push(text);
  }
  return result;
}

// ─── Journal Extraction ─────────────────────────────────────────────────────

/**
 * Extracts journal metadata from JATS journal-meta.
 */
function extractJournal(
  journalMeta: XmlJatsJournalMeta | undefined,
  articleMeta: XmlJatsArticleMeta | undefined,
): ParsedPmcJournal | undefined {
  if (!journalMeta) return;

  const title =
    extractTextContent(journalMeta['journal-title-group']?.['journal-title']) ||
    extractTextContent(journalMeta['journal-title']) ||
    undefined;

  const issns = ensureArray(journalMeta.issn);
  const issn = issns.length > 0 ? getText(issns[0]) || undefined : undefined;

  const volume = articleMeta?.volume
    ? extractTextContent(articleMeta.volume) || undefined
    : undefined;
  const issue = articleMeta?.issue ? extractTextContent(articleMeta.issue) || undefined : undefined;

  const fpage = articleMeta?.fpage ? extractTextContent(articleMeta.fpage) : undefined;
  const lpage = articleMeta?.lpage ? extractTextContent(articleMeta.lpage) : undefined;
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

// ─── Publication Date Extraction ────────────────────────────────────────────

/**
 * Extracts publication date from JATS pub-date elements.
 * Prefers epub date, falls back to ppub, then any available.
 */
function extractPubDate(
  pubDates: XmlJatsPubDate | XmlJatsPubDate[] | undefined,
): { day?: string; month?: string; year?: string } | undefined {
  if (!pubDates) return;

  const dates = ensureArray(pubDates);
  // Prefer epub, then ppub, then first available
  const preferred =
    dates.find((d) => getAttribute(d, 'pub-type') === 'epub') ??
    dates.find((d) => getAttribute(d, 'pub-type') === 'ppub') ??
    dates.find((d) => getAttribute(d, 'date-type') === 'pub') ??
    dates[0];

  if (!preferred) return;

  const year = extractTextContent(preferred.year) || undefined;
  const month = extractTextContent(preferred.month) || undefined;
  const day = extractTextContent(preferred.day) || undefined;

  if (!year) return;
  return {
    year,
    ...(month && { month }),
    ...(day && { day }),
  };
}

// ─── Abstract Extraction ────────────────────────────────────────────────────

/**
 * Extracts abstract text from JATS abstract element.
 * Handles both simple and structured abstracts (with titled sections).
 */
function extractAbstract(abstractNode: unknown): string | undefined {
  if (!abstractNode) return;

  // Structured abstract with sections
  if (typeof abstractNode === 'object' && !Array.isArray(abstractNode)) {
    const obj = abstractNode as Record<string, unknown>;

    // Check for sectioned abstract (<abstract><sec><title>...<p>...</sec></abstract>)
    if (obj.sec) {
      const sections = ensureArray(obj.sec);
      const parts: string[] = [];
      for (const sec of sections) {
        const secObj = sec as Record<string, unknown>;
        const title = extractTextContent(secObj.title);
        const text = extractTextContent(secObj.p);
        if (title && text) {
          parts.push(`${title}: ${text}`);
        } else if (text) {
          parts.push(text);
        }
      }
      const result = parts.join('\n\n').trim();
      return result || undefined;
    }

    // Simple abstract with just <p> elements
    if (obj.p) {
      const text = extractTextContent(obj.p);
      return text || undefined;
    }
  }

  // Fallback: extract all text
  const text = extractTextContent(abstractNode);
  return text || undefined;
}

// ─── Keywords Extraction ────────────────────────────────────────────────────

/**
 * Extracts keywords from JATS kwd-group elements.
 */
function extractKeywords(
  kwdGroups:
    | { kwd?: unknown; '@_kwd-group-type'?: string }
    | { kwd?: unknown; '@_kwd-group-type'?: string }[]
    | undefined,
): string[] {
  if (!kwdGroups) return [];

  const keywords: string[] = [];
  for (const group of ensureArray(kwdGroups)) {
    for (const kwd of ensureArray(group.kwd)) {
      const text = extractTextContent(kwd);
      if (text) keywords.push(text);
    }
  }
  return keywords;
}

// ─── Body Section Extraction ────────────────────────────────────────────────

/**
 * Recursively extracts body sections from JATS sec elements.
 */
export function extractBodySections(body: XmlJatsBody | undefined): ParsedPmcSection[] {
  if (!body) return [];

  // Some articles have paragraphs directly in body without section wrappers
  if (!body.sec) {
    if (body.p) {
      const text = extractTextContent(body.p);
      return text ? [{ text }] : [];
    }
    return [];
  }

  return ensureArray(body.sec)
    .map(extractSection)
    .filter((s): s is ParsedPmcSection => s !== null);
}

/**
 * Extracts a single JATS section, recursing into subsections.
 */
function extractSection(sec: XmlJatsSection): ParsedPmcSection | null {
  const title = extractTextContent(sec.title) || undefined;
  const label = extractTextContent(sec.label) || undefined;

  // Collect text from paragraphs
  const paragraphs = ensureArray(sec.p);
  const textParts: string[] = [];
  for (const p of paragraphs) {
    const text = extractTextContent(p);
    if (text) textParts.push(text);
  }

  // Recurse into subsections
  const subsections = sec.sec
    ? ensureArray(sec.sec)
        .map(extractSection)
        .filter((s): s is ParsedPmcSection => s !== null)
    : undefined;

  const text = textParts.join('\n\n');

  // Skip empty sections with no subsections
  if (!text && (!subsections || subsections.length === 0)) return null;

  return {
    ...(title && { title }),
    ...(label && { label }),
    text,
    ...(subsections && subsections.length > 0 && { subsections }),
  };
}

// ─── Reference Extraction ───────────────────────────────────────────────────

/**
 * Extracts references from JATS back matter ref-list.
 */
export function extractReferences(back: XmlJatsBack | undefined): ParsedPmcReference[] {
  if (!back?.['ref-list']?.ref) return [];

  const refs = ensureArray(back['ref-list'].ref) as XmlJatsRef[];
  const results: ParsedPmcReference[] = [];

  for (const ref of refs) {
    // Try mixed-citation first, then element-citation
    const citationNode = ref['mixed-citation'] ?? ref['element-citation'];
    const citation = extractTextContent(citationNode);
    if (!citation) continue;

    const label = ref.label ? extractTextContent(ref.label) || undefined : undefined;
    results.push({
      ...(ref['@_id'] && { id: ref['@_id'] }),
      ...(label && { label }),
      citation,
    });
  }

  return results;
}

// ─── Main Parser ────────────────────────────────────────────────────────────

/**
 * Parses a JATS XML article (from PMC EFetch) into a structured ParsedPmcArticle.
 * @param xmlArticle - The parsed JATS article object from fast-xml-parser.
 * @returns A fully parsed PMC article with metadata, body sections, and optional references.
 */
export function parsePmcArticle(xmlArticle: XmlJatsArticle): ParsedPmcArticle {
  const front = xmlArticle.front;
  const articleMeta = front?.['article-meta'];
  const journalMeta = front?.['journal-meta'];

  const articleIds = articleMeta?.['article-id'];
  const pmcId =
    extractArticleId(articleIds, 'pmcid') ?? extractArticleId(articleIds, 'pmc-uid') ?? '';
  const pmid = extractArticleId(articleIds, 'pmid');
  const doi = extractArticleId(articleIds, 'doi');

  const title = articleMeta?.['title-group']
    ? extractTextContent(articleMeta['title-group']['article-title']) || undefined
    : undefined;

  const authors = extractJatsAuthors(articleMeta?.['contrib-group']);
  const affiliations = extractAffiliations(articleMeta?.aff);
  const journal = extractJournal(journalMeta, articleMeta);
  const publicationDate = extractPubDate(articleMeta?.['pub-date']);
  const abstract = extractAbstract(articleMeta?.abstract);
  const keywords = extractKeywords(articleMeta?.['kwd-group']);
  const sections = extractBodySections(xmlArticle.body);
  const references = extractReferences(xmlArticle.back);

  // Normalize PMCID — ensure it has the PMC prefix
  const normalizedPmcId = pmcId.startsWith('PMC') ? pmcId : `PMC${pmcId}`;

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
    ...(xmlArticle['@_article-type'] && { articleType: xmlArticle['@_article-type'] }),
    pmcUrl: `https://www.ncbi.nlm.nih.gov/pmc/articles/${normalizedPmcId}/`,
    ...(pmid && { pubmedUrl: `https://pubmed.ncbi.nlm.nih.gov/${pmid}/` }),
  };
}
