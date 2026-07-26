/**
 * @fileoverview Unpaywall service. Resolves a DOI to an open-access location
 * and fetches the raw content (HTML or PDF) for downstream extraction. Enabled
 * only when `UNPAYWALL_EMAIL` is set — absence leaves the fallback disabled.
 *
 * Philosophy: best-effort. Upstream 404s and non-OA DOIs return a `no-oa`
 * resolution; only genuine service failures (5xx, network, timeout) throw.
 * @module src/services/unpaywall/unpaywall-service
 */

import { JsonRpcErrorCode, McpError, serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
import {
  fetchWithTimeout,
  httpErrorFromResponse,
  logger,
  requestContextService,
} from '@cyanheads/mcp-ts-core/utils';

import { getServerConfig } from '@/config/server-config.js';
import { recoveryFor } from '@/services/error-contracts.js';
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

    // `fetchWithTimeout` throws on any non-2xx response, so the explicit
    // `response.status === 404` / `=== 422` checks the API actually returns
    // arrive as `McpError(NotFound)` / `McpError(ValidationError)` here, not as
    // a response object. Translate those into the documented `no-oa` outcomes
    // before falling back to the service-unavailable wrap.
    let response: Response;
    try {
      response = await fetchWithTimeout(url, this.timeoutMs, ctx, {
        headers: { Accept: 'application/json', 'User-Agent': USER_AGENT },
        expectedStatuses: [404, 422],
        ...(signal && { signal }),
      });
    } catch (error: unknown) {
      if (error instanceof McpError) {
        if (error.code === JsonRpcErrorCode.NotFound) {
          return { kind: 'no-oa', reason: 'DOI unknown to Unpaywall' };
        }
        if (error.code === JsonRpcErrorCode.ValidationError) {
          return { kind: 'no-oa', reason: 'Invalid DOI format' };
        }
      }
      const msg = error instanceof Error ? error.message : String(error);
      throw serviceUnavailable(
        `Unpaywall request failed: ${msg}`,
        {
          reason: 'unpaywall_unreachable',
          doi: normalized,
          ...recoveryFor('unpaywall_unreachable'),
        },
        { cause: error },
      );
    }

    const data = (await response.json()) as UnpaywallResponse;
    if (!data.is_oa) return { kind: 'no-oa', reason: 'No open-access copy indexed' };

    const location = data.best_oa_location ?? data.oa_locations?.[0];
    if (!location?.url) return { kind: 'no-oa', reason: 'OA flagged but no usable location URL' };

    logger.debug(
      'Unpaywall resolved DOI',
      requestContextService.createRequestContext({
        operation: 'UnpaywallResolved',
        doi: normalized,
        hostType: location.host_type ?? null,
        license: location.license ?? null,
        version: location.version ?? null,
      }),
    );

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
        logger.debug(
          'Unpaywall PDF fetch failed; falling back to HTML URL',
          requestContextService.createRequestContext({
            operation: 'UnpaywallPdfFallback',
            url: pdfUrl,
            error: pdfErr instanceof Error ? pdfErr.message : String(pdfErr),
          }),
        );
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
      throw serviceUnavailable(
        `Unpaywall content fetch failed: ${msg}`,
        { reason: 'unpaywall_unreachable', url, ...recoveryFor('unpaywall_unreachable') },
        { cause: error },
      );
    }

    if (!response.ok) {
      throw await httpErrorFromResponse(response, {
        service: 'Unpaywall content fetch',
        data: { url },
      });
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
  logger.info(
    'Unpaywall service initialized.',
    requestContextService.createRequestContext({
      operation: 'UnpaywallInit',
      timeoutMs: config.unpaywallTimeoutMs,
    }),
  );
}

/** Returns the initialized service, or `undefined` when the fallback is disabled. */
export function getUnpaywallService(): UnpaywallService | undefined {
  return _service;
}
