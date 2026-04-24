/**
 * @fileoverview Unpaywall service. Resolves a DOI to an open-access location
 * and fetches the raw content (HTML or PDF) for downstream extraction. Enabled
 * only when `UNPAYWALL_EMAIL` is set — absence leaves the fallback disabled.
 *
 * Philosophy: best-effort. Upstream 404s and non-OA DOIs return a `no-oa`
 * resolution; only genuine service failures (5xx, network, timeout) throw.
 * @module src/services/unpaywall/unpaywall-service
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { fetchWithTimeout, logger, requestContextService } from '@cyanheads/mcp-ts-core/utils';

import { getServerConfig } from '@/config/server-config.js';
import {
  UNPAYWALL_API_BASE,
  type UnpaywallContent,
  type UnpaywallLocation,
  type UnpaywallResolution,
  type UnpaywallResponse,
} from './types.js';

const USER_AGENT = 'pubmed-mcp-server (+https://github.com/cyanheads/pubmed-mcp-server)';

/**
 * Resolves a DOI to an open-access copy via Unpaywall and fetches its bytes.
 * Constructed only when `UNPAYWALL_EMAIL` is present; absent config → no service.
 */
export class UnpaywallService {
  constructor(
    private readonly email: string,
    private readonly timeoutMs: number,
  ) {}

  /**
   * Look up a DOI in Unpaywall. Returns a structured outcome — never throws
   * for a DOI that simply has no OA copy or that Unpaywall doesn't know.
   * Throws `McpError(ServiceUnavailable)` only for network/server failures.
   */
  async resolve(doi: string, signal?: AbortSignal): Promise<UnpaywallResolution> {
    const normalized = normalizeDoi(doi);
    if (!normalized) return { kind: 'no-oa', reason: 'Invalid DOI' };

    const url = `${UNPAYWALL_API_BASE}/${encodeURIComponent(normalized)}?email=${encodeURIComponent(this.email)}`;
    const ctx = requestContextService.createRequestContext({ operation: 'UnpaywallResolve', doi });

    let response: Response;
    try {
      response = await fetchWithTimeout(url, this.timeoutMs, ctx, {
        headers: { Accept: 'application/json', 'User-Agent': USER_AGENT },
        ...(signal && { signal }),
      });
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      throw new McpError(JsonRpcErrorCode.ServiceUnavailable, `Unpaywall request failed: ${msg}`, {
        doi: normalized,
      });
    }

    if (response.status === 404) return { kind: 'no-oa', reason: 'DOI unknown to Unpaywall' };
    if (response.status === 422) return { kind: 'no-oa', reason: 'Invalid DOI format' };

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new McpError(
        response.status >= 500
          ? JsonRpcErrorCode.ServiceUnavailable
          : JsonRpcErrorCode.InvalidRequest,
        `Unpaywall returned HTTP ${response.status}.`,
        { doi: normalized, status: response.status, body: body.substring(0, 300) },
      );
    }

    const data = (await response.json()) as UnpaywallResponse;
    if (!data.is_oa) return { kind: 'no-oa', reason: 'No open-access copy indexed' };

    const location = data.best_oa_location ?? data.oa_locations?.[0];
    if (!location?.url) return { kind: 'no-oa', reason: 'OA flagged but no usable location URL' };

    logger.debug('Unpaywall resolved DOI', {
      doi: normalized,
      hostType: location.host_type ?? null,
      license: location.license ?? null,
      version: location.version ?? null,
    } as never);

    return { kind: 'found', location };
  }

  /**
   * Fetch the content at an Unpaywall location. Prefers `url_for_pdf` when
   * present (direct PDF bytes) and falls back to `url` (HTML landing page).
   * Throws `McpError(ServiceUnavailable)` on network/server failures or
   * unreadable responses — caller handles partial failures.
   */
  async fetchContent(location: UnpaywallLocation, signal?: AbortSignal): Promise<UnpaywallContent> {
    const pdfUrl = location.url_for_pdf ?? undefined;
    const htmlUrl = location.url;

    if (pdfUrl) {
      try {
        return await this.fetchAs(pdfUrl, 'pdf', signal);
      } catch (pdfErr: unknown) {
        logger.debug('Unpaywall PDF fetch failed; falling back to HTML URL', {
          url: pdfUrl,
          error: pdfErr instanceof Error ? pdfErr.message : String(pdfErr),
        } as never);
      }
    }

    return this.fetchAs(htmlUrl, 'auto', signal);
  }

  private async fetchAs(
    url: string,
    expected: 'pdf' | 'auto',
    signal?: AbortSignal,
  ): Promise<UnpaywallContent> {
    const ctx = requestContextService.createRequestContext({
      operation: 'UnpaywallFetch',
      url,
      expected,
    });

    const accept =
      expected === 'pdf'
        ? 'application/pdf,*/*;q=0.5'
        : 'text/html,application/pdf;q=0.9,*/*;q=0.5';

    let response: Response;
    try {
      response = await fetchWithTimeout(url, this.timeoutMs, ctx, {
        headers: { Accept: accept, 'User-Agent': USER_AGENT },
        redirect: 'follow',
        ...(signal && { signal }),
      });
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      throw new McpError(
        JsonRpcErrorCode.ServiceUnavailable,
        `Unpaywall content fetch failed: ${msg}`,
        { url },
      );
    }

    if (!response.ok) {
      throw new McpError(
        response.status >= 500
          ? JsonRpcErrorCode.ServiceUnavailable
          : JsonRpcErrorCode.InvalidRequest,
        `Unpaywall content fetch returned HTTP ${response.status}.`,
        { url, status: response.status },
      );
    }

    const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
    const fetchedUrl = response.url || url;

    if (contentType.includes('pdf') || expected === 'pdf') {
      const bytes = new Uint8Array(await response.arrayBuffer());
      return { kind: 'pdf', fetchedUrl, body: bytes };
    }

    const text = await response.text();
    return { kind: 'html', fetchedUrl, body: text };
  }
}

/**
 * Strip a leading `doi:` prefix or URL wrapping and return a clean DOI, or
 * undefined when the input can't be coerced into one.
 */
function normalizeDoi(input: string): string | undefined {
  const trimmed = input.trim();
  if (!trimmed) return;
  const withoutScheme = trimmed.replace(/^doi:/i, '').replace(/^https?:\/\/(dx\.)?doi\.org\//i, '');
  return withoutScheme.startsWith('10.') ? withoutScheme : undefined;
}

// ─── Init / Accessor ────────────────────────────────────────────────────────

let _service: UnpaywallService | undefined;

/**
 * Initialize the Unpaywall service if `UNPAYWALL_EMAIL` is configured.
 * Safe to call regardless — absence of the env var leaves the service unset,
 * and `getUnpaywallService()` returns `undefined`.
 */
export function initUnpaywallService(): void {
  const config = getServerConfig();
  if (!config.unpaywallEmail) {
    logger.info('Unpaywall fallback disabled (UNPAYWALL_EMAIL not set).');
    return;
  }
  _service = new UnpaywallService(config.unpaywallEmail, config.unpaywallTimeoutMs);
  logger.info('Unpaywall service initialized.', {
    timeoutMs: config.unpaywallTimeoutMs,
  } as never);
}

/** Returns the initialized service, or `undefined` when the fallback is disabled. */
export function getUnpaywallService(): UnpaywallService | undefined {
  return _service;
}
