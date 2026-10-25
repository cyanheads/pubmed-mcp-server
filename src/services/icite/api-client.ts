/**
 * @fileoverview Low-level HTTP client for NIH iCite: builds the `/pubs` URL and
 * makes one attempt — fetch, read, parse the JSON envelope. Retry, the total
 * deadline, and the record guard live in `IciteService`.
 * @module src/services/icite/api-client
 */

import { type Context, z } from '@cyanheads/mcp-ts-core';
import { serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
import { fetchWithTimeout } from '@cyanheads/mcp-ts-core/utils';

import { readBody } from '@/services/fetch-redaction.js';

import { ICITE_API_BASE, ICITE_FIELDS, type IciteRawRecord } from './types.js';

const USER_AGENT = 'pubmed-mcp-server (+https://github.com/cyanheads/pubmed-mcp-server)';

/** The `/pubs` envelope: a `data` list of records, each naming its PMID. */
const PubsEnvelopeSchema = z.object({
  data: z.array(z.looseObject({ pmid: z.union([z.number(), z.string()]) })),
});

/** Single-attempt client for the iCite `/pubs` endpoint. */
export class IciteApiClient {
  /**
   * The request URL for `pmids`, which must be canonical PMIDs (digits only).
   * Commas are written literally: every character in the query is URL-safe, and
   * iCite reads the list as sent.
   */
  pubsUrl(pmids: readonly string[]): string {
    return `${ICITE_API_BASE}/pubs?pmids=${pmids.join(',')}&fl=${ICITE_FIELDS.join(',')}`;
  }

  /**
   * One `/pubs` request. A non-2xx throws the status-mapped `McpError`
   * `fetchWithTimeout` raises (429 keeps its `Retry-After` as `retryAfter`); a
   * body that is not the JSON envelope throws `ServiceUnavailable` with
   * `reason: 'icite_invalid_response'`, which the service retries like a 5xx.
   */
  async fetchPubs(
    pmids: readonly string[],
    timeoutMs: number,
    ctx: Context,
    signal: AbortSignal,
  ): Promise<IciteRawRecord[]> {
    const response = await fetchWithTimeout(this.pubsUrl(pmids), timeoutMs, ctx, {
      headers: { Accept: 'application/json', 'User-Agent': USER_AGENT },
      signal,
    });
    const text = await readBody(response.text());

    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch (error: unknown) {
      throw serviceUnavailable(
        'NIH iCite returned a body that is not JSON.',
        { reason: 'icite_invalid_response' },
        { cause: error },
      );
    }
    const parsed = PubsEnvelopeSchema.safeParse(body);
    if (!parsed.success) {
      throw serviceUnavailable(
        'NIH iCite returned JSON without the expected `data` list of records.',
        { reason: 'icite_invalid_response' },
        { cause: parsed.error },
      );
    }
    return parsed.data.data;
  }
}
