/**
 * @fileoverview NIH iCite test fixtures and a `fetch` fake for the iCite host.
 * `fixtures/pubs-sample.json` holds ten `/pubs` records captured verbatim from
 * the live API with the service's `fl` list (October 2026): scored, unscored,
 * provisional, null-RCR, pre-1980, and HTML-titled rows.
 * @module tests/services/icite/_icite-fixtures
 */

import { readFileSync } from 'node:fs';
import { vi } from 'vitest';

export const ICITE_HOST = 'icite.od.nih.gov';

/** The captured rows, keyed by PMID string. */
export const SAMPLE_ROWS: ReadonlyMap<string, Record<string, unknown>> = new Map(
  (
    JSON.parse(readFileSync(new URL('./fixtures/pubs-sample.json', import.meta.url), 'utf8')) as {
      data: Record<string, unknown>[];
    }
  ).data.map((row) => [String(row.pmid), row]),
);

/** A captured row by PMID; throws on a PMID the fixture lacks. */
export function sampleRow(pmid: string): Record<string, unknown> {
  const row = SAMPLE_ROWS.get(pmid);
  if (!row) throw new Error(`No iCite fixture row for PMID ${pmid}`);
  return row;
}

export function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

/**
 * Answers a `/pubs` URL the way iCite does: the rows it holds for the requested
 * PMIDs, sorted by PMID as a string, unknown PMIDs omitted.
 */
export function pubsFrom(rows: ReadonlyMap<string, Record<string, unknown>> = SAMPLE_ROWS) {
  return (url: URL): Response => {
    const wanted = (url.searchParams.get('pmids') ?? '').split(',');
    const data = wanted
      .filter((pmid) => rows.has(pmid))
      .sort()
      .map((pmid) => rows.get(pmid));
    return jsonResponse({ data });
  };
}

type Responder = (url: URL, init: RequestInit | undefined) => Response | Promise<Response>;

/**
 * Stub the global `fetch`: a request to {@link ICITE_HOST} goes to `respond`,
 * anything else rejects. The returned mock records every call.
 */
export function stubIciteFetch(respond: Responder = pubsFrom()) {
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.hostname !== ICITE_HOST) throw new Error(`unmocked fetch: ${url.hostname}`);
    return respond(url, init);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

/** The URL of the `index`th fetch the mock received. */
export function fetchedUrl(fetchMock: ReturnType<typeof stubIciteFetch>, index = 0): URL {
  const call = fetchMock.mock.calls[index];
  if (!call) throw new Error(`No fetch call at index ${index}`);
  const [input] = call;
  return new URL(input instanceof Request ? input.url : String(input));
}

/** A fetch that never answers until its signal aborts, then rejects with the abort reason. */
export function hangingUntilAborted(_url: URL, init: RequestInit | undefined): Promise<Response> {
  return new Promise((_resolve, reject) => {
    const signal = init?.signal;
    if (!signal) return;
    if (signal.aborted) reject(signal.reason);
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
}
