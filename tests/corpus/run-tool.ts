/**
 * @fileoverview The corpus seam. A fixture runs through the real
 * `pubmed_fetch_fulltext` tool, the real NCBI service (API client, request queue,
 * response handler and its ordered XML parse) and the real `parsePmcArticle`; only
 * global `fetch` is stubbed, answering the one PMC EFetch URL the tool should request
 * with the fixture's `source.xml` bytes and rejecting every other request. Europe PMC
 * and Unpaywall are never initialised, so their accessors return `undefined` and the
 * chain stops at PMC.
 * @module tests/corpus/run-tool
 */
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { vi } from 'vitest';

/** What a tool call returns: `content[]`, `structuredContent`, and `isError`. */
export type ToolResult = Awaited<ReturnType<typeof runToolContract>>;

type FulltextTool =
  typeof import('@/mcp-server/tools/definitions/fetch-fulltext.tool.js').fetchFulltextTool;

/**
 * Pin the server config the suite runs under, initialise the NCBI service, and
 * import the tool. Must run before anything reads `getServerConfig()`, which parses
 * the environment once per module graph. No retries, so a stub that answers wrong
 * fails at once instead of backing off; the shortest request gap the config allows.
 */
export async function loadFulltextTool(): Promise<FulltextTool> {
  vi.stubEnv('NCBI_API_KEY', '');
  vi.stubEnv('NCBI_ADMIN_EMAIL', '');
  vi.stubEnv('NCBI_MAX_RETRIES', '0');
  vi.stubEnv('NCBI_REQUEST_DELAY_MS', '50');
  vi.stubEnv('EUROPEPMC_ENABLED', 'false');
  vi.stubEnv('UNPAYWALL_EMAIL', '');
  const { initNcbiService } = await import('@/services/ncbi/ncbi-service.js');
  initNcbiService();
  const { fetchFulltextTool } = await import(
    '@/mcp-server/tools/definitions/fetch-fulltext.tool.js'
  );
  return fetchFulltextTool;
}

/** Every request the stubbed `fetch` saw during one tool call. */
export interface FetchLog {
  refused: string[];
  served: string[];
}

function requestUrl(input: string | URL | Request): URL {
  if (typeof input === 'string') return new URL(input);
  return new URL(input instanceof URL ? input.href : input.url);
}

/**
 * Stub global `fetch` to serve `bytes` for a GET of the EFetch endpoint with
 * `db=<db>` (PMC unless stated) and `id=<numericId>`, and to reject anything else. A
 * fresh `Response` per call, since a body can be read once.
 */
export function stubEfetch(
  numericId: string,
  bytes: Uint8Array<ArrayBuffer>,
  db: 'pmc' | 'pubmed' = 'pmc',
): FetchLog {
  const log: FetchLog = { refused: [], served: [] };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = requestUrl(input);
      const isFixture =
        url.origin === 'https://eutils.ncbi.nlm.nih.gov' &&
        url.pathname === '/entrez/eutils/efetch.fcgi' &&
        url.searchParams.get('db') === db &&
        url.searchParams.get('id') === numericId &&
        (init?.method ?? 'GET') === 'GET';
      if (!isFixture) {
        log.refused.push(url.href);
        throw new Error(`unmocked fetch: ${url.href}`);
      }
      log.served.push(url.href);
      return new Response(bytes, {
        status: 200,
        headers: { 'content-type': 'text/xml; charset=UTF-8' },
      });
    }),
  );
  return log;
}

/** One tool call for the fixture's PMC ID, references included. */
export function callFulltext(tool: FulltextTool, numericId: string): Promise<ToolResult> {
  return runToolContract(tool, { pmcids: [`PMC${numericId}`], includeReferences: true });
}

/** `content[]` as the snapshot stores it: every text block, in order. */
export function renderedText(result: ToolResult): string {
  return result.content
    .map((block) => (block.type === 'text' ? block.text : `[${block.type} block]`))
    .join('\n\n');
}

/** Every string leaf of `structuredContent`, with its JSON path. */
export function structuredStrings(value: unknown, path = ''): { path: string; value: string }[] {
  if (typeof value === 'string') return [{ path, value }];
  if (Array.isArray(value))
    return value.flatMap((item, i) => structuredStrings(item, `${path}[${i}]`));
  if (value !== null && typeof value === 'object') {
    return Object.entries(value).flatMap(([key, item]) =>
      structuredStrings(item, path ? `${path}.${key}` : key),
    );
  }
  return [];
}
