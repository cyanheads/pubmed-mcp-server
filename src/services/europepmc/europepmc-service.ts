/**
 * @fileoverview Europe PMC API service. Calls the Europe PMC REST API for
 * article search and retrieval. No API key required (free public access).
 * @module src/services/europepmc/europepmc-service
 */

const EUROPE_PMC_BASE = 'https://www.ebi.ac.uk/europepmc/webservices/rest';

export interface EuropePmcPaper {
  authorString: string;
  citedByCount: number;
  doi: string;
  hasFullText: string;
  journalTitle: string;
  pmid: string;
  pubYear: string;
  source: string;
  title: string;
}

export interface EuropePmcSearchResult {
  nextCursorMark: string;
  pageSize: number;
  results: EuropePmcPaper[];
  totalHits: number;
}

let _config: EuropePmcConfig | null = null;

export interface EuropePmcConfig {
  timeoutMs: number;
}

interface EuropePmcApiResponse {
  nextCursorMark?: string;
  resultList?: {
    result?: Array<Record<string, unknown>>;
    hitCount?: number | string;
  };
}

const DefaultConfig: EuropePmcConfig = {
  timeoutMs: 20000,
};

export function getEuropePmcConfig(): EuropePmcConfig {
  if (!_config) {
    _config = { ...DefaultConfig };
  }
  return _config;
}

/**
 * Search Europe PMC with cursor-based pagination.
 * @param query - Europe PMC query syntax
 * @param pageSize - Results per page (1-1000)
 * @param cursorMark - Cursor for pagination ("*" for first page)
 * @param sort - Sort order: RELEVANCE, DATE, or CITED
 * @param signal - Optional AbortSignal
 */
export async function search({
  query,
  pageSize = 25,
  cursorMark = '*',
  sort = 'RELEVANCE',
  signal,
}: {
  query: string;
  pageSize?: number;
  cursorMark?: string;
  sort?: string;
  signal?: AbortSignal;
}): Promise<EuropePmcSearchResult> {
  const config = getEuropePmcConfig();
  const params = new URLSearchParams({
    query,
    resultType: 'core',
    pageSize: String(Math.min(Math.max(pageSize, 1), 1000)),
    cursorMark,
    sort,
    format: 'json',
  });

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), config.timeoutMs);
  if (signal) {
    signal.addEventListener('abort', () => controller.abort());
  }

  try {
    const resp = await fetch(`${EUROPE_PMC_BASE}/search?${params}`, {
      signal: controller.signal,
      headers: { 'User-Agent': 'pubmed-mcp-server/2.6' },
    });

    if (!resp.ok) {
      throw new Error(`Europe PMC API error: HTTP ${resp.status}`);
    }

    const data = (await resp.json()) as EuropePmcApiResponse;
    const resultList = data?.resultList ?? {};

    const rawResults: Array<Record<string, unknown>> = Array.isArray(resultList.result) ? resultList.result : [];
    const results: EuropePmcPaper[] = rawResults.map((r) => ({
      pmid: String(r.pmid ?? ''),
      title: String(r.title ?? 'N/A'),
      authorString: String(r.authorString ?? ''),
      journalTitle: String(r.journalTitle ?? ''),
      pubYear: String(r.pubYear ?? ''),
      doi: String(r.doi ?? ''),
      source: String(r.source ?? ''),
      hasFullText: String(r.hasFullText ?? 'N'),
      citedByCount: Number(r.citedByCount ?? 0),
    }));

    return {
      totalHits: Number(resultList.hitCount ?? 0),
      nextCursorMark: data.nextCursorMark ?? '',
      pageSize,
      results,
    };
  } finally {
    clearTimeout(timeoutId);
  }
}
