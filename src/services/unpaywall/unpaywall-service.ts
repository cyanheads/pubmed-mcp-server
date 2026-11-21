/**
 * @fileoverview Unpaywall service. Resolves a DOI to an open-access location —
 * together with the title, journal name, and year the DOI object carries — and
 * fetches the raw content (HTML or PDF, each read held to a 50 MiB limit) for
 * downstream extraction. Enabled only when `UNPAYWALL_EMAIL` is set — absence
 * leaves the fallback disabled.
 *
 * Philosophy: best-effort. Upstream 404s and non-OA DOIs return a `no-oa`
 * resolution; only genuine service failures (5xx, network, timeout) throw.
 *
 * Each request runs under `UNPAYWALL_TIMEOUT_MS`, or under the time the tool
 * call's deadline has left when that is shorter; a request the deadline cuts, or
 * one it leaves no time to start, ends as `unpaywall_deadline_exceeded`.
 * @module src/services/unpaywall/unpaywall-service
 */

import {
  JsonRpcErrorCode,
  McpError,
  serviceUnavailable,
  timeout,
} from '@cyanheads/mcp-ts-core/errors';
import {
  fetchWithTimeout,
  httpErrorFromResponse,
  logger,
  requestContextService,
} from '@cyanheads/mcp-ts-core/utils';

import { getServerConfig } from '@/config/server-config.js';
import { type CallDeadline, upstreamBound } from '@/services/call-deadline.js';
import { normalizeDoi } from '@/services/doi.js';
import { readBody } from '@/services/fetch-redaction.js';
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
   * Throws `McpError(ServiceUnavailable)` only for network/server failures, and
   * a Timeout with reason `unpaywall_deadline_exceeded` when `deadline` cuts the
   * lookup or leaves no time to send it.
   */
  async resolve(
    doi: string,
    signal?: AbortSignal,
    deadline?: CallDeadline,
  ): Promise<UnpaywallResolution> {
    const normalized = normalizeDoi(doi.trim());
    if (!normalized.startsWith('10.')) return { kind: 'no-oa', reason: 'Invalid DOI' };

    const request = this.requestTimeout(deadline, signal, { doi: normalized });
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
      response = await fetchWithTimeout(url, request.timeoutMs, ctx, {
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
      throw (
        request.cut(error) ??
        serviceUnavailable(
          `Unpaywall request failed: ${msg}`,
          {
            reason: 'unpaywall_unreachable',
            doi: normalized,
          },
          { cause: error },
        )
      );
    }

    const data = (await readBody(response.json()).catch((error: unknown) => {
      throw request.cut(error) ?? error;
    })) as UnpaywallResponse;
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
          // The logger writes a caller's `version` key as `data_version`.
          oaVersion: location.version ?? null,
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
   *
   * A body past the {@link MAX_CONTENT_BYTES} read limit at `url_for_pdf` falls
   * through the same way, unless `url` is the same address: that refusal is
   * thrown, since a second read would only repeat it. (#311)
   *
   * Each read runs under `deadline` as {@link resolve} does. The landing-page read
   * starts only while `deadline` has time left; once spent, the HTML already
   * received is returned, or the call fails as `unpaywall_deadline_exceeded`.
   */
  async fetchContent(
    location: UnpaywallLocation,
    signal?: AbortSignal,
    deadline?: CallDeadline,
  ): Promise<UnpaywallContent> {
    const pdfUrl = location.url_for_pdf ?? undefined;
    const htmlUrl = location.url;

    if (pdfUrl) {
      /** HTML served where a PDF was advertised — a fallback candidate, not a result. */
      let servedHtml: UnpaywallContent | undefined;
      try {
        const content = await this.fetchAs(pdfUrl, 'pdf', signal, deadline);
        if (content.kind === 'pdf') return content;
        servedHtml = content;
        logger.debug(
          'Unpaywall PDF URL served non-PDF bytes; falling back to HTML URL',
          requestContextService.createRequestContext({
            operation: 'UnpaywallPdfNotPdf',
            additionalContext: { host: hostOf(pdfUrl), fetchedHost: hostOf(content.fetchedUrl) },
          }),
        );
      } catch (pdfErr: unknown) {
        if (pdfUrl === htmlUrl && isOverReadLimit(pdfErr)) throw pdfErr;
        logger.debug(
          'Unpaywall PDF fetch failed; falling back to HTML URL',
          requestContextService.createRequestContext({
            operation: 'UnpaywallPdfFallback',
            additionalContext: {
              host: hostOf(pdfUrl),
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
        return await this.fetchAs(htmlUrl, 'auto', signal, deadline);
      } catch (htmlErr: unknown) {
        if (servedHtml) return servedHtml;
        throw htmlErr;
      }
    }

    return this.fetchAs(htmlUrl, 'auto', signal, deadline);
  }

  /**
   * The timeout one request runs under: `UNPAYWALL_TIMEOUT_MS`, or the time
   * `deadline` has left when that is shorter. A `deadline` already spent sends
   * nothing and throws `unpaywall_deadline_exceeded` with `where` in its data,
   * unless the caller has aborted, whose cancellation then takes its own course.
   */
  private requestTimeout(
    deadline: CallDeadline | undefined,
    signal: AbortSignal | undefined,
    where: Record<string, unknown>,
  ): RequestTimeout {
    const bound = upstreamBound(this.timeoutMs, deadline);
    if (bound.spent && !signal?.aborted) throw deadlineExceeded(bound.deadlineMs, where);
    /**
     * One timer bounds the request, and which one is fixed here, as it is armed: a
     * timeout the deadline shortened is the deadline's own, so the request's timeout
     * firing on it is the deadline expiring. No elapsed time is compared afterwards.
     */
    const shortened = bound.remainingMs < this.timeoutMs;
    return {
      timeoutMs: bound.remainingMs,
      cut: (error) =>
        shortened && isRequestTimeout(error)
          ? deadlineExceeded(bound.deadlineMs, where, error)
          : undefined,
    };
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
   *
   * Records and error data name the URL's host, never the URL: a publisher's
   * PDF link can carry an access token in its path or query.
   *
   * The body is read under {@link MAX_CONTENT_BYTES}; see {@link readWithinLimit}.
   */
  private async fetchAs(
    url: string,
    expected: 'pdf' | 'auto',
    signal?: AbortSignal,
    deadline?: CallDeadline,
  ): Promise<UnpaywallContent> {
    const host = hostOf(url);
    const request = this.requestTimeout(deadline, signal, { host });
    const ctx = requestContextService.createRequestContext({
      operation: 'UnpaywallFetch',
      additionalContext: { expected, host },
    });

    const accept =
      expected === 'pdf'
        ? 'application/pdf,*/*;q=0.5'
        : 'text/html,application/pdf;q=0.9,*/*;q=0.5';

    let response: Response;
    try {
      response = await fetchWithTimeout(url, request.timeoutMs, ctx, {
        headers: { Accept: accept, 'User-Agent': USER_AGENT },
        redirect: 'follow',
        ...(signal && { signal }),
      });
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      throw (
        request.cut(error) ??
        serviceUnavailable(
          `Unpaywall content fetch failed: ${msg}`,
          { reason: 'unpaywall_unreachable', host },
          { cause: error },
        )
      );
    }

    if (!response.ok) {
      throw await httpErrorFromResponse(response, {
        service: 'Unpaywall content fetch',
        data: { host },
      });
    }

    const fetchedUrl = response.url || url;
    // Read the body once — a Response body can only be consumed once, and the
    // bytes are what the classification reads.
    const bytes = await readBody(readWithinLimit(response, host)).catch((error: unknown) => {
      throw request.cut(error) ?? error;
    });

    if (hasPdfMagic(bytes)) return { kind: 'pdf', fetchedUrl, body: bytes };

    return { kind: 'html', fetchedUrl, body: new TextDecoder().decode(bytes) };
  }
}

/** The timeout one Unpaywall request runs under, from `UnpaywallService.requestTimeout`. */
interface RequestTimeout {
  /**
   * The deadline's expiry when `error` is the request's own timeout firing on a
   * timeout the deadline shortened; `undefined` for every other failure.
   */
  readonly cut: (error: unknown) => McpError | undefined;
  /** The request's timeout, in ms. */
  readonly timeoutMs: number;
}

/**
 * `data.reason` of the Timeout a request ends on when the tool call's deadline cuts
 * it or leaves no time to send it. No contract declares it, like
 * {@link OVER_READ_LIMIT}: `pubmed_fetch_fulltext` catches every Unpaywall failure
 * per article and reports it as a tier outcome.
 */
const DEADLINE_EXCEEDED = 'unpaywall_deadline_exceeded';

/** The expiry of a deadline `deadlineMs` long, naming the lookup or host in `where`. */
function deadlineExceeded(
  deadlineMs: number,
  where: Record<string, unknown>,
  cause?: unknown,
): McpError {
  return timeout(
    `Unpaywall request deadline (${deadlineMs}ms) exceeded`,
    { reason: DEADLINE_EXCEEDED, deadlineMs, ...where },
    cause === undefined ? undefined : { cause },
  );
}

/** Whether `error` is `fetchWithTimeout`'s own timeout firing, before the headers or mid-body. */
function isRequestTimeout(error: unknown): boolean {
  return error instanceof McpError && error.data?.errorSource === 'FetchTimeout';
}

/** Decoded bytes one content read may hold: 50 MiB, for a PDF and a landing page alike. */
const MAX_CONTENT_BYTES = 50 * 1024 * 1024;

/** `data.reason` of the refusal {@link readWithinLimit} throws. */
const OVER_READ_LIMIT = 'unpaywall_content_too_large';

/**
 * Read a response body whole, refusing one past {@link MAX_CONTENT_BYTES}.
 *
 * An uncompressed body whose `Content-Length` is already past the limit is
 * refused unread. Every other body is counted as it streams: a compressed body's
 * `Content-Length` is its encoded size while the runtime yields decoded bytes,
 * and a chunked body has none. A refusal cancels the body, which releases the
 * connection and the request deadline that `fetchWithTimeout` hands it.
 *
 * @throws {McpError} `ServiceUnavailable` with `data.reason` {@link OVER_READ_LIMIT}
 *   on a refusal. A failure while the body streams rejects with the stream's own
 *   error, as classified by `fetchWithTimeout`.
 */
async function readWithinLimit(response: Response, host: string | undefined): Promise<Uint8Array> {
  const { body } = response;
  if (!body) return new Uint8Array(0);

  const refusal = () =>
    serviceUnavailable(
      `Unpaywall content is larger than the ${MAX_CONTENT_BYTES / (1024 * 1024)} MiB read limit`,
      { reason: OVER_READ_LIMIT, host },
    );

  if (declaresOverLimit(response.headers)) {
    await body.cancel();
    throw refusal();
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_CONTENT_BYTES) {
      await reader.cancel();
      throw refusal();
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/** Whether an uncompressed response's `Content-Length` names a body past {@link MAX_CONTENT_BYTES}. */
function declaresOverLimit(headers: Headers): boolean {
  const encoding = headers.get('content-encoding')?.trim().toLowerCase();
  if (encoding && encoding !== 'identity') return false;
  return Number(headers.get('content-length')) > MAX_CONTENT_BYTES;
}

/** Whether `error` is {@link readWithinLimit}'s refusal of a body past the limit. */
function isOverReadLimit(error: unknown): boolean {
  return error instanceof McpError && error.data?.reason === OVER_READ_LIMIT;
}

/** The host a URL names, for log and error labels — `undefined` when it does not parse. */
function hostOf(url: string): string | undefined {
  return URL.parse(url)?.host;
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
