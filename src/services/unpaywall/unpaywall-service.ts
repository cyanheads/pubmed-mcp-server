/**
 * @fileoverview Unpaywall service. Resolves a DOI to an open-access location —
 * together with the title, journal name, and year the DOI object carries — and
 * fetches the raw content (HTML or PDF) for downstream extraction. Enabled only
 * when `UNPAYWALL_EMAIL` is set — absence leaves the fallback disabled.
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
    const ctx = requestContextService.createRequestContext({
      operation: 'UnpaywallResolve',
      additionalContext: { doi },
    });

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
        additionalContext: {
          doi: normalized,
          hostType: location.host_type ?? null,
          license: location.license ?? null,
          version: location.version ?? null,
        },
      }),
    );

    return {
      kind: 'found',
      location,
      ...(nonBlank(data.title) && { title: data.title }),
      ...(nonBlank(data.journal_name) && { journalName: data.journal_name }),
      ...(typeof data.year === 'number' && Number.isInteger(data.year) && { year: data.year }),
    };
  }

  /**
   * Fetch the content at an Unpaywall location. Prefers `url_for_pdf` when
   * present (direct PDF bytes) and falls back to `url` (HTML landing page).
   * Throws `McpError(ServiceUnavailable)` on network/server failures or
   * unreadable responses — caller handles partial failures.
   *
   * Publishers routinely answer `url_for_pdf` with an HTML paywall or
   * interstitial at `200 OK`. That is not a fetch failure, so it takes the same
   * route as one: fall through to `location.url`, Unpaywall's designated
   * landing page, which is likelier to hold real content. The HTML already
   * received is kept and returned when a second fetch cannot improve on it —
   * the two addresses are the same, or the fallback fetch itself fails. (#104)
   */
  async fetchContent(location: UnpaywallLocation, signal?: AbortSignal): Promise<UnpaywallContent> {
    const pdfUrl = location.url_for_pdf ?? undefined;
    const htmlUrl = location.url;

    if (pdfUrl) {
      /** HTML served where a PDF was advertised — a fallback candidate, not a result. */
      let servedHtml: UnpaywallContent | undefined;
      try {
        const content = await this.fetchAs(pdfUrl, 'pdf', signal);
        if (content.kind === 'pdf') return content;
        servedHtml = content;
        logger.debug(
          'Unpaywall PDF URL served non-PDF bytes; falling back to HTML URL',
          requestContextService.createRequestContext({
            operation: 'UnpaywallPdfNotPdf',
            additionalContext: { url: pdfUrl, fetchedUrl: content.fetchedUrl },
          }),
        );
      } catch (pdfErr: unknown) {
        logger.debug(
          'Unpaywall PDF fetch failed; falling back to HTML URL',
          requestContextService.createRequestContext({
            operation: 'UnpaywallPdfFallback',
            additionalContext: {
              url: pdfUrl,
              error: pdfErr instanceof Error ? pdfErr.message : String(pdfErr),
            },
          }),
        );
      }

      // Refetching an address we already read returns the same bytes.
      if (servedHtml && (pdfUrl === htmlUrl || servedHtml.fetchedUrl === htmlUrl)) {
        return servedHtml;
      }

      try {
        return await this.fetchAs(htmlUrl, 'auto', signal);
      } catch (htmlErr: unknown) {
        if (servedHtml) return servedHtml;
        throw htmlErr;
      }
    }

    return this.fetchAs(htmlUrl, 'auto', signal);
  }

  /**
   * Fetch one URL and classify what came back by its own bytes.
   *
   * `expected` steers the `Accept` header only. Classification reads the
   * response body's magic header, because neither the caller's expectation nor
   * the `content-type` describes it reliably: a genuine PDF is often served as
   * `application/octet-stream`, and an HTML interstitial is sometimes served as
   * `application/pdf`. Bytes opening with `%PDF-` are a PDF whatever the header
   * says; everything else is treated as text. (#104)
   */
  private async fetchAs(
    url: string,
    expected: 'pdf' | 'auto',
    signal?: AbortSignal,
  ): Promise<UnpaywallContent> {
    const ctx = requestContextService.createRequestContext({
      operation: 'UnpaywallFetch',
      additionalContext: { url, expected },
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

    const fetchedUrl = response.url || url;
    // Read the body once — a Response body can only be consumed once, and the
    // bytes are what the classification reads.
    const bytes = new Uint8Array(await response.arrayBuffer());

    if (hasPdfMagic(bytes)) return { kind: 'pdf', fetchedUrl, body: bytes };

    return { kind: 'html', fetchedUrl, body: new TextDecoder().decode(bytes) };
  }
}

/** True for a string carrying more than whitespace — Unpaywall sends `null` for a field it has no value for. */
function nonBlank(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/** `%PDF-`, the five bytes every PDF file opens with. */
const PDF_MAGIC = Uint8Array.of(0x25, 0x50, 0x44, 0x46, 0x2d);

/** Whether the received bytes are a PDF, independent of any declared type. */
function hasPdfMagic(bytes: Uint8Array): boolean {
  return (
    bytes.length >= PDF_MAGIC.length && PDF_MAGIC.every((byte, index) => bytes[index] === byte)
  );
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
      additionalContext: { timeoutMs: config.unpaywallTimeoutMs },
    }),
  );
}

/** Returns the initialized service, or `undefined` when the fallback is disabled. */
export function getUnpaywallService(): UnpaywallService | undefined {
  return _service;
}
