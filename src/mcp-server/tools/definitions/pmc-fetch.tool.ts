/**
 * @fileoverview PMC full-text fetch tool definition. Retrieves full-text articles
 * from PubMed Central via NCBI EFetch with db=pmc. Supports direct PMCID input
 * or automatic PMID-to-PMCID resolution via ELink.
 * @module src/mcp-server/tools/definitions/pmc-fetch.tool
 */

import type { ContentBlock } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

import { container } from '@/container/core/container.js';
import { NcbiServiceToken } from '@/container/core/tokens.js';
import type { SdkContext, ToolDefinition } from '@/mcp-server/tools/utils/toolDefinition.js';
import { withToolAuth } from '@/mcp-server/transports/auth/lib/withAuth.js';
import { parsePmcArticle } from '@/services/ncbi/parsing/pmc-article-parser.js';
import { ensureArray } from '@/services/ncbi/parsing/xml-helpers.js';
import type { ParsedPmcArticle, XmlJatsArticle, XmlPmcArticleSet } from '@/services/ncbi/types.js';
import { JsonRpcErrorCode, McpError } from '@/types-global/errors.js';
import { markdown } from '@/utils/formatting/markdownBuilder.js';
import { logger } from '@/utils/internal/logger.js';
import type { RequestContext } from '@/utils/internal/requestContext.js';

const ncbi = () => container.resolve(NcbiServiceToken);

// ─── Metadata ────────────────────────────────────────────────────────────────

const TOOL_NAME = 'pmc_fetch';
const TOOL_TITLE = 'PMC Full-Text Fetch';
const TOOL_DESCRIPTION =
  'Fetch full-text articles from PubMed Central (PMC). Returns complete article body text, sections, and references for open-access articles. Accepts PMC IDs directly or PubMed IDs (auto-resolved via ELink). Only articles available in PMC will return full text.';
const TOOL_ANNOTATIONS = {
  idempotentHint: true,
  openWorldHint: true,
  readOnlyHint: true,
} as const;

// ─── Schemas ─────────────────────────────────────────────────────────────────

const InputSchema = z
  .object({
    includeReferences: z
      .boolean()
      .default(false)
      .describe('Include reference list from back matter'),
    maxSections: z
      .number()
      .int()
      .min(1)
      .max(50)
      .optional()
      .describe('Maximum number of top-level body sections to return'),
    pmcids: z
      .array(z.string())
      .min(1)
      .max(10)
      .optional()
      .describe(
        'PMC IDs to fetch (e.g., ["PMC9575052"] or ["9575052"]). Provide pmcids or pmids, not both.',
      ),
    pmids: z
      .array(z.string().regex(/^\d+$/))
      .min(1)
      .max(10)
      .optional()
      .describe(
        'PubMed IDs to resolve to PMC articles via ELink. Only articles available in PMC will be returned.',
      ),
    sections: z
      .array(z.string())
      .optional()
      .describe(
        'Filter to specific sections by title (case-insensitive match, e.g., ["methods", "results"])',
      ),
  })
  .refine((data) => data.pmcids ?? data.pmids, {
    message: 'Either pmcids or pmids must be provided',
  })
  .refine((data) => !(data.pmcids && data.pmids), {
    message: 'Provide pmcids or pmids, not both',
  });

const SectionSchema: z.ZodType<{
  label?: string | undefined;
  subsections?:
    | { label?: string | undefined; text: string; title?: string | undefined }[]
    | undefined;
  text: string;
  title?: string | undefined;
}> = z.object({
  label: z.string().optional().describe('Section label (e.g., "1", "2.1")'),
  subsections: z
    .lazy(() => z.array(SectionSchema))
    .optional()
    .describe('Nested subsections'),
  text: z.string().describe('Section body text'),
  title: z.string().optional().describe('Section heading'),
});

const ArticleSchema = z.object({
  abstract: z.string().optional().describe('Article abstract'),
  affiliations: z.array(z.string()).optional().describe('Author affiliations'),
  articleType: z.string().optional().describe('Article type (e.g., "research-article")'),
  authors: z
    .array(
      z.object({
        collectiveName: z.string().optional(),
        givenNames: z.string().optional(),
        lastName: z.string().optional(),
      }),
    )
    .optional()
    .describe('Author list'),
  doi: z.string().optional().describe('Digital Object Identifier'),
  journal: z.any().optional().describe('Journal information'),
  keywords: z.array(z.string()).optional().describe('Article keywords'),
  pmcId: z.string().describe('PubMed Central ID'),
  pmcUrl: z.string().describe('PMC article URL'),
  pmid: z.string().optional().describe('PubMed ID'),
  pubmedUrl: z.string().optional().describe('PubMed article URL'),
  publicationDate: z.any().optional().describe('Publication date'),
  references: z
    .array(
      z.object({ citation: z.string(), id: z.string().optional(), label: z.string().optional() }),
    )
    .optional()
    .describe('Reference list'),
  sections: z.array(SectionSchema).describe('Article body sections with full text'),
  title: z.string().optional().describe('Article title'),
});

const OutputSchema = z.object({
  articles: z.array(ArticleSchema).describe('Parsed full-text articles'),
  totalReturned: z.number().describe('Number of articles returned'),
  unavailablePmids: z
    .array(z.string())
    .optional()
    .describe('PMIDs that could not be resolved to PMC articles'),
});

// ─── Types ───────────────────────────────────────────────────────────────────

type Input = z.infer<typeof InputSchema>;
type Output = z.infer<typeof OutputSchema>;

// ─── ELink Types (local — match NCBI response shape) ────────────────────────

interface ELinkLinkItem {
  Id: string | number | { '#text'?: string | number };
}

interface ELinkLinkSetDb {
  Link?: ELinkLinkItem | ELinkLinkItem[];
  LinkName?: string;
}

interface ELinkResultItem {
  ERROR?: string;
  LinkSet?: {
    IdList?: { Id?: string | number | { '#text'?: string | number } };
    LinkSetDb?: ELinkLinkSetDb | ELinkLinkSetDb[];
  };
}

interface ELinkResponse {
  eLinkResult?: ELinkResultItem | ELinkResultItem[];
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Normalizes a PMCID by stripping the "PMC" prefix for API calls.
 */
function normalizePmcId(id: string): string {
  return id.replace(/^PMC/i, '');
}

/**
 * Extracts a string value from an ELink Id field.
 */
function extractLinkId(field: string | number | { '#text'?: string | number } | undefined): string {
  if (field === undefined || field === null) return '';
  if (typeof field === 'object') {
    return field['#text'] !== undefined ? String(field['#text']) : '';
  }
  return String(field);
}

/**
 * Resolves PMIDs to PMCIDs via NCBI ELink.
 * Returns a map of PMID → PMCID for articles available in PMC.
 */
async function resolvePmidsToPmcIds(
  pmids: string[],
  appContext: RequestContext,
): Promise<{ resolved: Map<string, string>; unavailable: string[] }> {
  const eLinkResult = (await ncbi().eLink(
    {
      cmd: 'neighbor',
      db: 'pmc',
      dbfrom: 'pubmed',
      id: pmids.join(','),
      linkname: 'pubmed_pmc',
      retmode: 'xml',
    },
    appContext,
  )) as ELinkResponse;

  const resolved = new Map<string, string>();
  const eLinkResults = ensureArray(eLinkResult?.eLinkResult);

  for (const result of eLinkResults) {
    if (result?.ERROR) {
      logger.warning('ELink error during PMID resolution', {
        ...appContext,
        error: result.ERROR,
      });
      continue;
    }

    const linkSet = result?.LinkSet;
    if (!linkSet?.LinkSetDb) continue;

    const linkSetDbArray = ensureArray(linkSet.LinkSetDb);
    const pmcLinkSet =
      linkSetDbArray.find((db) => db.LinkName === 'pubmed_pmc') ?? linkSetDbArray[0];

    if (pmcLinkSet?.Link) {
      // Extract the source PMID from IdList
      const sourcePmid = extractLinkId(
        linkSet.IdList?.Id as string | number | { '#text'?: string | number } | undefined,
      );

      const links = ensureArray(pmcLinkSet.Link);
      for (const link of links) {
        const pmcId = extractLinkId(link.Id);
        if (pmcId && sourcePmid) {
          resolved.set(sourcePmid, pmcId);
        }
      }
    }
  }

  const unavailable = pmids.filter((pmid) => !resolved.has(pmid));
  return { resolved, unavailable };
}

/**
 * Filters sections by title (case-insensitive match).
 */
function filterSections(
  sections: ParsedPmcArticle['sections'],
  sectionFilter: string[],
): ParsedPmcArticle['sections'] {
  const lowerFilter = sectionFilter.map((s) => s.toLowerCase());
  return sections.filter((s) => {
    if (!s.title) return false;
    return lowerFilter.some((f) => s.title?.toLowerCase().includes(f));
  });
}

// ─── Logic ───────────────────────────────────────────────────────────────────

async function logic(
  input: Input,
  appContext: RequestContext,
  _sdkContext: SdkContext,
): Promise<Output> {
  logger.info('Executing pmc_fetch tool', {
    ...appContext,
    hasPmcids: !!input.pmcids,
    hasPmids: !!input.pmids,
    idCount: (input.pmcids ?? input.pmids)?.length,
  });

  let pmcIds: string[];
  let unavailablePmids: string[] | undefined;

  // Resolve PMIDs to PMCIDs if needed
  if (input.pmids) {
    const resolution = await resolvePmidsToPmcIds(input.pmids, appContext);

    if (resolution.resolved.size === 0) {
      logger.notice('No PMC articles found for provided PMIDs', {
        ...appContext,
        pmids: input.pmids,
      });
      return {
        articles: [],
        totalReturned: 0,
        unavailablePmids: input.pmids,
      };
    }

    pmcIds = [...resolution.resolved.values()];
    if (resolution.unavailable.length > 0) {
      unavailablePmids = resolution.unavailable;
      logger.debug('Some PMIDs not available in PMC', {
        ...appContext,
        unavailable: resolution.unavailable,
      });
    }
  } else {
    pmcIds = (input.pmcids ?? []).map(normalizePmcId);
  }

  // Fetch full-text XML from PMC
  const xmlData = await ncbi().eFetch<{ 'pmc-articleset'?: XmlPmcArticleSet }>(
    { db: 'pmc', id: pmcIds.join(','), retmode: 'xml' },
    appContext,
    { retmode: 'xml', usePost: pmcIds.length > 5 },
  );

  if (!xmlData || !('pmc-articleset' in xmlData)) {
    throw new McpError(
      JsonRpcErrorCode.InternalError,
      'Invalid PMC EFetch response: missing pmc-articleset',
      { requestId: appContext.requestId },
    );
  }

  const articleSet = xmlData['pmc-articleset'];
  if (!articleSet?.article) {
    return { articles: [], totalReturned: 0, ...(unavailablePmids && { unavailablePmids }) };
  }

  const xmlArticles = ensureArray(articleSet.article) as XmlJatsArticle[];

  // Parse each article
  let articles: ParsedPmcArticle[] = xmlArticles.map((xmlArticle) => parsePmcArticle(xmlArticle));

  // Apply section filtering
  if (input.sections && input.sections.length > 0) {
    const sectionFilter = input.sections;
    articles = articles.map((article) => ({
      ...article,
      sections: filterSections(article.sections, sectionFilter),
    }));
  }

  // Apply maxSections limit
  if (input.maxSections !== undefined) {
    articles = articles.map((article) => ({
      ...article,
      sections: article.sections.slice(0, input.maxSections),
    }));
  }

  // Strip references if not requested
  if (!input.includeReferences) {
    articles = articles.map((article) => {
      const { references: _refs, ...rest } = article;
      return rest as ParsedPmcArticle;
    });
  }

  logger.notice('pmc_fetch completed', {
    ...appContext,
    requested: pmcIds.length,
    returned: articles.length,
  });

  return {
    articles,
    totalReturned: articles.length,
    ...(unavailablePmids && { unavailablePmids }),
  };
}

// ─── Response Formatter ──────────────────────────────────────────────────────

function formatSection(
  md: ReturnType<typeof markdown>,
  section: {
    text: string;
    title?: string | undefined;
    subsections?: { text: string; title?: string | undefined }[] | undefined;
  },
  depth: number,
): void {
  const headingLevel = Math.min(depth, 6);
  const prefix = '#'.repeat(headingLevel);
  if (section.title) {
    md.text(`${prefix} ${section.title}\n\n`);
  }
  if (section.text) {
    md.paragraph(section.text);
  }
  if (section.subsections) {
    for (const sub of section.subsections) {
      formatSection(md, sub, depth + 1);
    }
  }
}

function responseFormatter(result: Output): ContentBlock[] {
  const md = markdown()
    .h2('PMC Full-Text Articles')
    .keyValue('Articles Returned', result.totalReturned);

  if (result.unavailablePmids?.length) {
    md.keyValue('Unavailable PMIDs', result.unavailablePmids.join(', '));
  }

  for (const article of result.articles) {
    md.h3(article.title ?? article.pmcId);
    md.keyValue('PMCID', article.pmcId);
    if (article.pmid) md.keyValue('PMID', article.pmid);
    if (article.doi) md.keyValue('DOI', article.doi);
    md.keyValue('PMC', article.pmcUrl);
    if (article.pubmedUrl) md.keyValue('PubMed', article.pubmedUrl);

    if (article.authors?.length) {
      const authorStr = article.authors
        .slice(0, 5)
        .map((a) => a.collectiveName ?? `${a.lastName ?? ''} ${a.givenNames ?? ''}`.trim())
        .join(', ');
      md.keyValue('Authors', article.authors.length > 5 ? `${authorStr}, et al.` : authorStr);
    }

    if (article.journal) {
      const parts = [article.journal.title, article.journal.volume, article.journal.pages].filter(
        Boolean,
      );
      if (parts.length > 0) md.keyValue('Journal', parts.join(', '));
    }

    if (article.abstract) {
      md.h4('Abstract').paragraph(article.abstract);
    }

    if (article.sections.length > 0) {
      for (const section of article.sections) {
        formatSection(md, section, 4);
      }
    }

    if (article.references?.length) {
      md.h4('References');
      const refItems = article.references.map(
        (r) => `${r.label ? `[${r.label}] ` : ''}${r.citation}`,
      );
      md.list(refItems);
    }
  }

  return [{ type: 'text', text: md.build() }];
}

// ─── Export ──────────────────────────────────────────────────────────────────

export const pmcFetchTool: ToolDefinition<typeof InputSchema, typeof OutputSchema> = {
  annotations: TOOL_ANNOTATIONS,
  description: TOOL_DESCRIPTION,
  inputSchema: InputSchema,
  logic: withToolAuth(['tool:pmc_fetch:read'], logic),
  name: TOOL_NAME,
  outputSchema: OutputSchema,
  responseFormatter,
  title: TOOL_TITLE,
};
