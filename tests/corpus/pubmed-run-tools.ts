/**
 * @fileoverview The PubMed-record corpus seam. A fixture runs through the real
 * `pubmed_fetch_articles` and `pubmed_format_citations` tools, the real NCBI service
 * (API client, request queue, response handler with its flat XML parse and inline-markup
 * flattening) and the real `parseArticleSet` and `formatCitations`; only global `fetch`
 * is stubbed, answering the one PubMed EFetch URL with the fixture's `source.xml` bytes
 * (see `stubEfetch` in `run-tool.ts`).
 * @module tests/corpus/pubmed-run-tools
 */
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { loadFulltextTool, renderedText, type ToolResult } from './run-tool.js';

type FetchArticlesTool =
  typeof import('@/mcp-server/tools/definitions/fetch-articles.tool.js').fetchArticlesTool;
type FormatCitationsTool =
  typeof import('@/mcp-server/tools/definitions/format-citations.tool.js').formatCitationsTool;

export interface PubmedTools {
  fetchArticles: FetchArticlesTool;
  formatCitations: FormatCitationsTool;
}

/** Every style `pubmed_format_citations` offers, in the order the corpus requests them. */
export const CITATION_STYLES = ['apa', 'mla', 'bibtex', 'ris', 'vancouver'] as const;

export type CitationStyle = (typeof CITATION_STYLES)[number];

/**
 * Pin the server config and initialise the NCBI service exactly as the PMC runner
 * does, then import both tools.
 */
export async function loadPubmedTools(): Promise<PubmedTools> {
  await loadFulltextTool();
  const { fetchArticlesTool } = await import(
    '@/mcp-server/tools/definitions/fetch-articles.tool.js'
  );
  const { formatCitationsTool } = await import(
    '@/mcp-server/tools/definitions/format-citations.tool.js'
  );
  return { fetchArticles: fetchArticlesTool, formatCitations: formatCitationsTool };
}

/** The `pubmed_fetch_articles` input the corpus uses: MeSH and grants included. */
export function fetchArticlesInput(pmid: string) {
  return { pmids: [pmid], includeMesh: true, includeGrants: true };
}

/** The `pubmed_format_citations` input the corpus uses: every style. */
export function formatCitationsInput(pmid: string) {
  return { pmids: [pmid], format: [...CITATION_STYLES] };
}

export function callFetchArticles(tools: PubmedTools, pmid: string): Promise<ToolResult> {
  return runToolContract(tools.fetchArticles, fetchArticlesInput(pmid));
}

export function callFormatCitations(tools: PubmedTools, pmid: string): Promise<ToolResult> {
  return runToolContract(tools.formatCitations, formatCitationsInput(pmid));
}

/**
 * The snapshot `expected.md` stores: each tool's `content[]` under a comment line
 * naming the tool and the input it was called with.
 */
export function renderPubmedSnapshot(
  pmid: string,
  articles: ToolResult,
  citations: ToolResult,
): string {
  return [
    `<!-- pubmed_fetch_articles ${JSON.stringify(fetchArticlesInput(pmid))} -->`,
    renderedText(articles),
    '',
    `<!-- pubmed_format_citations ${JSON.stringify(formatCitationsInput(pmid))} -->`,
    renderedText(citations),
    '',
  ].join('\n');
}
