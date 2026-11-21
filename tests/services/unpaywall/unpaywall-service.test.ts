/**
 * @fileoverview Tests for the Unpaywall service.
 * @module tests/services/unpaywall/unpaywall-service.test
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import type { RequestContext } from '@cyanheads/mcp-ts-core/utils';
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest';
import type { UnpaywallContent } from '@/services/unpaywall/types.js';

const mockFetchWithTimeout = vi.fn();

vi.mock('@cyanheads/mcp-ts-core/utils', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@cyanheads/mcp-ts-core/utils');
  return {
    ...actual,
    fetchWithTimeout: mockFetchWithTimeout,
  };
});

const { UnpaywallService, initUnpaywallService, getUnpaywallService } = await import(
  '@/services/unpaywall/unpaywall-service.js'
);
const { logger } = await import('@cyanheads/mcp-ts-core/utils');
/** The framework helper the module mock replaces, for cases that run its deadline wrapper. */
const { fetchWithTimeout: realFetchWithTimeout } = await vi.importActual<
  typeof import('@cyanheads/mcp-ts-core/utils')
>('@cyanheads/mcp-ts-core/utils');

function jsonResponse(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

describe('UnpaywallService.resolve', () => {
  beforeEach(() => {
    mockFetchWithTimeout.mockReset();
  });

  it('returns `found` when Unpaywall reports an OA copy', async () => {
    mockFetchWithTimeout.mockResolvedValue(
      jsonResponse({
        doi: '10.1000/example',
        is_oa: true,
        best_oa_location: {
          url: 'https://repo.example.org/paper',
          host_type: 'repository',
          license: 'cc-by',
          version: 'acceptedVersion',
        },
      }),
    );

    const service = new UnpaywallService('oa@example.com', 20000);
    const result = await service.resolve('10.1000/example');

    expect(result).toEqual({
      kind: 'found',
      location: {
        url: 'https://repo.example.org/paper',
        host_type: 'repository',
        license: 'cc-by',
        version: 'acceptedVersion',
      },
    });
    expect(mockFetchWithTimeout).toHaveBeenCalledWith(
      expect.stringContaining('10.1000%2Fexample'),
      20000,
      expect.any(Object),
      expect.objectContaining({ headers: expect.objectContaining({ Accept: 'application/json' }) }),
    );
  });

  it('carries the DOI object’s title, journal name, and year beside the location (#144)', async () => {
    const location = { url: 'https://www.medrxiv.org/content/10.64898/x', host_type: 'repository' };
    mockFetchWithTimeout.mockResolvedValue(
      jsonResponse({
        doi: '10.64898/x',
        is_oa: true,
        title: 'Global genomics in over 4 million individuals',
        journal_name: 'medRxiv',
        year: 2026,
        best_oa_location: location,
      }),
    );

    const result = await new UnpaywallService('oa@example.com', 20000).resolve('10.64898/x');

    expect(result).toEqual({
      kind: 'found',
      location,
      title: 'Global genomics in over 4 million individuals',
      journalName: 'medRxiv',
      year: 2026,
    });
  });

  it('omits bibliographic fields Unpaywall reports as null, blank, or mistyped (#144)', async () => {
    const location = { url: 'https://repo.example.org/paper' };
    mockFetchWithTimeout.mockResolvedValue(
      jsonResponse({
        is_oa: true,
        title: '  ',
        journal_name: null,
        year: '2026',
        best_oa_location: location,
      }),
    );

    const result = await new UnpaywallService('oa@example.com', 20000).resolve('10.1000/x');

    expect(result).toEqual({ kind: 'found', location });
  });

  it('accepts DOI inputs with scheme or doi.org prefix', async () => {
    mockFetchWithTimeout.mockImplementation(() => Promise.resolve(jsonResponse({ is_oa: false })));
    const service = new UnpaywallService('oa@example.com', 20000);

    const inputs = [
      'doi:10.1000/example',
      'DOI:10.1000/example',
      'DOI: 10.1000/example',
      'https://doi.org/10.1000/example',
      'http://dx.doi.org/10.1000/example',
      // The shared normalizer decodes a link's path and drops its query. (#299)
      'https://doi.org/10.1000%2Fexample?utm_source=x',
      // A DOI read from an upstream record keeps the whitespace around it.
      ' 10.1000/example\n',
      '\tdoi:10.1000/example ',
    ];
    for (const input of inputs) await service.resolve(input);

    expect(mockFetchWithTimeout.mock.calls.map((call) => call[0])).toEqual(
      inputs.map(() => 'https://api.unpaywall.org/v2/10.1000%2Fexample?email=oa%40example.com'),
    );
  });

  it('returns `no-oa` when Unpaywall returns 404 for an unknown DOI', async () => {
    // fetchWithTimeout throws on any non-2xx response — a 404 surfaces as a
    // thrown McpError(NotFound), never as a returned Response.
    mockFetchWithTimeout.mockRejectedValue(
      new McpError(JsonRpcErrorCode.NotFound, 'Fetch failed for ...; Status: 404'),
    );
    const service = new UnpaywallService('oa@example.com', 20000);

    const result = await service.resolve('10.0000/unknown');
    expect(result).toEqual({ kind: 'no-oa', reason: 'DOI unknown to Unpaywall' });
  });

  it('returns `no-oa` when Unpaywall returns 422 for an invalid DOI format', async () => {
    mockFetchWithTimeout.mockRejectedValue(
      new McpError(JsonRpcErrorCode.ValidationError, 'Fetch failed for ...; Status: 422'),
    );
    const service = new UnpaywallService('oa@example.com', 20000);

    const result = await service.resolve('10.0000/malformed');
    expect(result).toEqual({ kind: 'no-oa', reason: 'Invalid DOI format' });
  });

  it('returns `no-oa` when the DOI is invalid shape', async () => {
    const service = new UnpaywallService('oa@example.com', 20000);

    const result = await service.resolve('not-a-doi');
    expect(result).toEqual({ kind: 'no-oa', reason: 'Invalid DOI' });
    expect(mockFetchWithTimeout).not.toHaveBeenCalled();
  });

  it('returns `no-oa` when Unpaywall says is_oa=false', async () => {
    mockFetchWithTimeout.mockResolvedValue(jsonResponse({ is_oa: false }));
    const service = new UnpaywallService('oa@example.com', 20000);

    const result = await service.resolve('10.1000/closed');
    expect(result).toEqual({ kind: 'no-oa', reason: 'No open-access copy indexed' });
  });

  it('throws ServiceUnavailable on 5xx', async () => {
    mockFetchWithTimeout.mockRejectedValue(
      new McpError(JsonRpcErrorCode.ServiceUnavailable, 'Fetch failed for ...; Status: 503'),
    );
    const service = new UnpaywallService('oa@example.com', 20000);

    await expect(service.resolve('10.1000/example')).rejects.toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      message: expect.stringContaining('Status: 503'),
      data: { reason: 'unpaywall_unreachable' },
    });
  });

  it('throws ServiceUnavailable on network errors', async () => {
    mockFetchWithTimeout.mockRejectedValue(new Error('connect ETIMEDOUT'));
    const service = new UnpaywallService('oa@example.com', 20000);

    await expect(service.resolve('10.1000/example')).rejects.toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      message: expect.stringContaining('connect ETIMEDOUT'),
    });
  });

  it('network error on resolve stamps reason unpaywall_unreachable', async () => {
    mockFetchWithTimeout.mockRejectedValue(new Error('connect ETIMEDOUT'));
    const service = new UnpaywallService('oa@example.com', 20000);

    await expect(service.resolve('10.1000/example')).rejects.toMatchObject({
      data: {
        reason: 'unpaywall_unreachable',
        doi: '10.1000/example',
      },
    });
  });
});

describe('UnpaywallService.fetchContent', () => {
  beforeEach(() => {
    mockFetchWithTimeout.mockReset();
  });

  it('fetches PDF bytes when url_for_pdf is present and returns them as a Uint8Array', async () => {
    const pdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]);
    mockFetchWithTimeout.mockResolvedValueOnce(
      new Response(pdfBytes, {
        status: 200,
        headers: { 'content-type': 'application/pdf' },
      }),
    );

    const service = new UnpaywallService('oa@example.com', 20000);
    const content = await service.fetchContent({
      url: 'https://arxiv.org/abs/2401.0001',
      url_for_pdf: 'https://arxiv.org/pdf/2401.0001.pdf',
    });

    expect(content.kind).toBe('pdf');
    expect(content.body).toBeInstanceOf(Uint8Array);
    expect((content.body as Uint8Array).byteLength).toBe(5);
  });

  it('falls back to the HTML landing page when the PDF fetch fails', async () => {
    mockFetchWithTimeout
      .mockResolvedValueOnce(new Response('gone', { status: 410 }))
      .mockResolvedValueOnce(
        new Response('<html><body>landing</body></html>', {
          status: 200,
          headers: { 'content-type': 'text/html' },
        }),
      );

    const service = new UnpaywallService('oa@example.com', 20000);
    const content = await service.fetchContent({
      url: 'https://example.org/paper',
      url_for_pdf: 'https://example.org/paper.pdf',
    });

    expect(content.kind).toBe('html');
    expect(content.body).toContain('landing');
  });

  it('returns html content when content-type is text/html', async () => {
    mockFetchWithTimeout.mockResolvedValueOnce(
      new Response('<html><body>hi</body></html>', {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      }),
    );

    const service = new UnpaywallService('oa@example.com', 20000);
    const content = await service.fetchContent({ url: 'https://example.org/paper' });

    expect(content.kind).toBe('html');
    expect(content.body).toContain('hi');
  });

  it('network error on fetchContent stamps reason unpaywall_unreachable', async () => {
    mockFetchWithTimeout.mockRejectedValue(new Error('connect ECONNRESET'));
    const service = new UnpaywallService('oa@example.com', 20000);

    const error = await service.fetchContent({ url: 'https://example.org/paper' }).catch((e) => e);
    expect(error).toMatchObject({
      data: { reason: 'unpaywall_unreachable', host: 'example.org' },
    });
    expect(error.data).not.toHaveProperty('url');
  });

  describe('classification by received bytes (issue #104)', () => {
    /** `%PDF-` — the five magic bytes every PDF starts with. */
    const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d];
    const pdfBytes = (trailer = 'X') =>
      new Uint8Array([...PDF_MAGIC, ...new TextEncoder().encode(trailer)]);
    const LANDING_HTML = '<html><body>landing</body></html>';
    const PAYWALL_HTML = '<html><body>Subscribe to read this article</body></html>';

    const bytesResponse = (body: string | Uint8Array, contentType: string, url?: string) => {
      const response = new Response(body, {
        status: 200,
        headers: { 'content-type': contentType },
      });
      if (url) Object.defineProperty(response, 'url', { value: url });
      return response;
    };

    const requestedUrls = () => mockFetchWithTimeout.mock.calls.map((call) => call[0] as string);

    it('does not label an HTML paywall served at url_for_pdf a PDF, and falls through to location.url', async () => {
      mockFetchWithTimeout
        .mockResolvedValueOnce(bytesResponse(PAYWALL_HTML, 'text/html; charset=utf-8'))
        .mockResolvedValueOnce(bytesResponse(LANDING_HTML, 'text/html'));

      const service = new UnpaywallService('oa@example.com', 20000);
      const content = await service.fetchContent({
        url: 'https://example.org/paper',
        url_for_pdf: 'https://example.org/paper.pdf',
      });

      expect(content.kind).toBe('html');
      expect(content.body).toContain('landing');
      expect(requestedUrls()).toEqual([
        'https://example.org/paper.pdf',
        'https://example.org/paper',
      ]);
    });

    it('classifies HTML sent with a content-type of application/pdf as HTML', async () => {
      // The reverse header lie: an interstitial mislabeled as a PDF used to
      // reach the PDF parser and fail as "Invalid PDF structure".
      mockFetchWithTimeout
        .mockResolvedValueOnce(bytesResponse(PAYWALL_HTML, 'application/pdf'))
        .mockResolvedValueOnce(bytesResponse(LANDING_HTML, 'text/html'));

      const service = new UnpaywallService('oa@example.com', 20000);
      const content = await service.fetchContent({
        url: 'https://example.org/paper',
        url_for_pdf: 'https://example.org/paper.pdf',
      });

      expect(content.kind).toBe('html');
      expect(content.body).toContain('landing');
    });

    it('keeps a genuine PDF served as application/octet-stream classified as a PDF', async () => {
      mockFetchWithTimeout.mockResolvedValueOnce(
        bytesResponse(pdfBytes('1.7 body'), 'application/octet-stream'),
      );

      const service = new UnpaywallService('oa@example.com', 20000);
      const content = await service.fetchContent({
        url: 'https://example.org/paper',
        url_for_pdf: 'https://example.org/paper.pdf',
      });

      expect(content.kind).toBe('pdf');
      expect(content.body).toBeInstanceOf(Uint8Array);
      expect(Array.from(content.body as Uint8Array).slice(0, 5)).toEqual(PDF_MAGIC);
      expect(requestedUrls()).toEqual(['https://example.org/paper.pdf']);
    });

    it('keeps a corrupt-but-PDF-headed body classified as a PDF rather than reclassifying it as HTML', async () => {
      // A genuinely corrupt PDF must still reach the PDF parser so the
      // downstream failure reads as a PDF parse failure, not an HTML miss.
      mockFetchWithTimeout.mockResolvedValueOnce(
        bytesResponse(pdfBytes('\x00\x01 truncated'), 'application/pdf'),
      );

      const service = new UnpaywallService('oa@example.com', 20000);
      const content = await service.fetchContent({
        url: 'https://example.org/paper',
        url_for_pdf: 'https://example.org/paper.pdf',
      });

      expect(content.kind).toBe('pdf');
      expect(Array.from(content.body as Uint8Array).slice(0, 5)).toEqual(PDF_MAGIC);
      expect(requestedUrls()).toHaveLength(1);
    });

    it('extracts the received HTML directly when url_for_pdf and url are the same address', async () => {
      mockFetchWithTimeout.mockResolvedValueOnce(bytesResponse(PAYWALL_HTML, 'application/pdf'));

      const service = new UnpaywallService('oa@example.com', 20000);
      const content = await service.fetchContent({
        url: 'https://example.org/paper',
        url_for_pdf: 'https://example.org/paper',
      });

      expect(content.kind).toBe('html');
      expect(content.body).toContain('Subscribe');
      // Refetching the same address would only repeat the same response.
      expect(requestedUrls()).toEqual(['https://example.org/paper']);
    });

    it('extracts the received HTML directly when url_for_pdf redirected to location.url', async () => {
      mockFetchWithTimeout.mockResolvedValueOnce(
        bytesResponse(PAYWALL_HTML, 'text/html', 'https://example.org/paper'),
      );

      const service = new UnpaywallService('oa@example.com', 20000);
      const content = await service.fetchContent({
        url: 'https://example.org/paper',
        url_for_pdf: 'https://example.org/redirect-to-landing',
      });

      expect(content).toMatchObject({ kind: 'html', fetchedUrl: 'https://example.org/paper' });
      expect(requestedUrls()).toEqual(['https://example.org/redirect-to-landing']);
    });

    it('falls back to the HTML received at url_for_pdf when the landing-page fetch also fails', async () => {
      mockFetchWithTimeout
        .mockResolvedValueOnce(bytesResponse(PAYWALL_HTML, 'text/html'))
        .mockRejectedValueOnce(new Error('connect ECONNRESET'));

      const service = new UnpaywallService('oa@example.com', 20000);
      const content = await service.fetchContent({
        url: 'https://example.org/paper',
        url_for_pdf: 'https://example.org/paper.pdf',
      });

      expect(content).toMatchObject({
        kind: 'html',
        fetchedUrl: 'https://example.org/paper.pdf',
      });
      expect(content.body).toContain('Subscribe');
    });

    it('still throws when the PDF slot fetch fails and the landing-page fetch fails too', async () => {
      // Nothing was received at either address, so there is no body to salvage.
      mockFetchWithTimeout
        .mockResolvedValueOnce(new Response('gone', { status: 410 }))
        .mockRejectedValueOnce(new Error('connect ECONNRESET'));

      const service = new UnpaywallService('oa@example.com', 20000);
      await expect(
        service.fetchContent({
          url: 'https://example.org/paper',
          url_for_pdf: 'https://example.org/paper.pdf',
        }),
      ).rejects.toMatchObject({ data: { reason: 'unpaywall_unreachable' } });
    });

    it('classifies a PDF served under text/html on the auto branch by its bytes', async () => {
      // The `auto` branch carried the same latent gap in the other direction.
      mockFetchWithTimeout.mockResolvedValueOnce(bytesResponse(pdfBytes('1.4'), 'text/html'));

      const service = new UnpaywallService('oa@example.com', 20000);
      const content = await service.fetchContent({ url: 'https://example.org/paper' });

      expect(content.kind).toBe('pdf');
      expect(Array.from(content.body as Uint8Array).slice(0, 5)).toEqual(PDF_MAGIC);
    });

    it('returns an empty body as HTML rather than an empty PDF', async () => {
      mockFetchWithTimeout
        .mockResolvedValueOnce(bytesResponse('', 'application/pdf'))
        .mockResolvedValueOnce(bytesResponse(LANDING_HTML, 'text/html'));

      const service = new UnpaywallService('oa@example.com', 20000);
      const content = await service.fetchContent({
        url: 'https://example.org/paper',
        url_for_pdf: 'https://example.org/paper.pdf',
      });

      expect(content.kind).toBe('html');
      expect(content.body).toContain('landing');
    });
  });
});

/**
 * One content read holds at most 50 MiB of decoded body. Each stub body streams
 * lazily from one reused chunk and counts what was pulled from it, so no case
 * holds more than one body of the limit's size. (#311)
 */
describe('UnpaywallService.fetchContent read limit (issue #311)', () => {
  const LIMIT_BYTES = 50 * 1024 * 1024;
  const CHUNK_BYTES = 256 * 1024;
  /** A body four chunks past the limit, so a reader that stops at the limit leaves some unread. */
  const PAST_LIMIT_BYTES = LIMIT_BYTES + 4 * CHUNK_BYTES;
  const TOO_LARGE = { reason: 'unpaywall_content_too_large' };
  /** `%PDF-` — the five magic bytes every PDF starts with. */
  const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d];
  const LANDING_HTML = '<html><body>landing</body></html>';
  const PAPER_URL = 'https://example.org/paper';
  const PDF_URL = 'https://example.org/paper.pdf';

  /**
   * `totalBytes` of body, one reused chunk opening with `%PDF-` per pull and
   * nothing pulled ahead of the reader. `pulledBytes` counts what the reader took;
   * `cancelled` records a reader that let the rest go.
   */
  function countedBody(totalBytes: number) {
    const chunk = new Uint8Array(CHUNK_BYTES);
    chunk.set(PDF_MAGIC);
    const stats = { pulledBytes: 0, cancelled: false };
    const stream = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          const size = Math.min(CHUNK_BYTES, totalBytes - stats.pulledBytes);
          if (size === 0) {
            controller.close();
            return;
          }
          stats.pulledBytes += size;
          controller.enqueue(size === CHUNK_BYTES ? chunk : chunk.subarray(0, size));
        },
        cancel() {
          stats.cancelled = true;
        },
      },
      { highWaterMark: 0 },
    );
    return { stream, stats };
  }

  const streamed = (stream: ReadableStream<Uint8Array>, headers: Record<string, string> = {}) =>
    new Response(stream, {
      status: 200,
      headers: { 'content-type': 'application/pdf', ...headers },
    });

  const landingPage = () =>
    new Response(LANDING_HTML, { status: 200, headers: { 'content-type': 'text/html' } });

  const requestedUrls = () => mockFetchWithTimeout.mock.calls.map((call) => call[0] as string);

  const service = () => new UnpaywallService('oa@example.com', 20000);

  /**
   * The error `pending` rejects with. A resolution fails the case naming only the
   * content's kind and size, so a body read whole never reaches an assertion diff.
   */
  const refusalOf = (pending: Promise<UnpaywallContent>): Promise<unknown> =>
    pending.then(
      (content) => {
        throw new Error(
          `expected a rejection, got ${content.kind} content of ${content.body.length} bytes`,
        );
      },
      (error: unknown) => error,
    );

  beforeEach(() => {
    mockFetchWithTimeout.mockReset();
  });

  it.each([
    ['one byte past the limit', LIMIT_BYTES + 1],
    ['several chunks past the limit', PAST_LIMIT_BYTES],
  ])(
    'stops reading a body %s that has no Content-Length at the limit',
    async (_label, totalBytes) => {
      const { stream, stats } = countedBody(totalBytes);
      mockFetchWithTimeout.mockResolvedValueOnce(streamed(stream));

      const error = await refusalOf(service().fetchContent({ url: PAPER_URL }));

      expect(error).toBeInstanceOf(McpError);
      expect(error).toMatchObject({
        code: JsonRpcErrorCode.ServiceUnavailable,
        data: { ...TOO_LARGE, host: 'example.org' },
      });
      expect((error as Error).message).toContain('50 MiB read limit');
      expect(stats.pulledBytes).toBeLessThanOrEqual(LIMIT_BYTES + CHUNK_BYTES);
      expect(stats.cancelled).toBe(true);
    },
  );

  it('refuses an uncompressed body whose Content-Length is past the limit before reading any of it', async () => {
    const { stream, stats } = countedBody(LIMIT_BYTES + 1);
    mockFetchWithTimeout.mockResolvedValueOnce(
      streamed(stream, { 'content-length': String(LIMIT_BYTES + 1) }),
    );

    const error = await refusalOf(service().fetchContent({ url: PAPER_URL }));

    expect(error).toMatchObject({ data: TOO_LARGE });
    expect((error as Error).message).toContain('50 MiB read limit');
    expect(stats.pulledBytes).toBe(0);
    expect(stats.cancelled).toBe(true);
  });

  it.each(['gzip', 'br'])(
    'counts the decoded bytes of a %s body whose Content-Length is its encoded size',
    async (encoding) => {
      // What fetch hands back for a compressed body on both runtimes: the decoded
      // bytes, with Content-Encoding and the encoded Content-Length left in place.
      const { stream, stats } = countedBody(PAST_LIMIT_BYTES);
      mockFetchWithTimeout.mockResolvedValueOnce(
        streamed(stream, { 'content-encoding': encoding, 'content-length': String(64 * 1024) }),
      );

      const error = await refusalOf(service().fetchContent({ url: PAPER_URL }));

      expect(error).toMatchObject({ data: TOO_LARGE });
      expect(stats.pulledBytes).toBeLessThanOrEqual(LIMIT_BYTES + CHUNK_BYTES);
      expect(stats.cancelled).toBe(true);
    },
  );

  it.each(['gzip', 'br'])(
    'reads a %s body whole when its encoded Content-Length is past the limit and its decoded bytes are not',
    async (encoding) => {
      const { stream, stats } = countedBody(CHUNK_BYTES);
      mockFetchWithTimeout.mockResolvedValueOnce(
        streamed(stream, {
          'content-encoding': encoding,
          'content-length': String(LIMIT_BYTES + 1),
        }),
      );

      const content = await service().fetchContent({ url: PAPER_URL });

      expect(content.kind).toBe('pdf');
      expect((content.body as Uint8Array).byteLength).toBe(CHUNK_BYTES);
      expect(stats.pulledBytes).toBe(CHUNK_BYTES);
    },
  );

  it('reads a response that carries no body as an empty page', async () => {
    mockFetchWithTimeout.mockResolvedValueOnce(
      new Response(null, { status: 200, headers: { 'content-type': 'text/html' } }),
    );

    expect(await service().fetchContent({ url: PAPER_URL })).toEqual({
      kind: 'html',
      fetchedUrl: PAPER_URL,
      body: '',
    });
  });

  it('resolves a body of exactly the limit, Content-Length included, as a PDF', async () => {
    const { stream, stats } = countedBody(LIMIT_BYTES);
    mockFetchWithTimeout.mockResolvedValueOnce(
      streamed(stream, { 'content-length': String(LIMIT_BYTES) }),
    );

    const content = await service().fetchContent({ url: PAPER_URL });

    expect(content.kind).toBe('pdf');
    const body = content.body as Uint8Array;
    expect(body).toBeInstanceOf(Uint8Array);
    expect(body.byteLength).toBe(LIMIT_BYTES);
    expect(Array.from(body.subarray(0, 5))).toEqual(PDF_MAGIC);
    expect(Array.from(body.subarray(CHUNK_BYTES, CHUNK_BYTES + 5))).toEqual(PDF_MAGIC);
    expect(stats.pulledBytes).toBe(LIMIT_BYTES);
  });

  it('falls through to the landing page when the url_for_pdf body is past the limit', async () => {
    const { stream } = countedBody(PAST_LIMIT_BYTES);
    mockFetchWithTimeout
      .mockResolvedValueOnce(streamed(stream))
      .mockResolvedValueOnce(landingPage());

    const content = await service().fetchContent({ url: PAPER_URL, url_for_pdf: PDF_URL });

    // Kind first: a PDF read whole would otherwise land in the toEqual diff.
    expect(content.kind).toBe('html');
    expect(content).toEqual({ kind: 'html', fetchedUrl: PAPER_URL, body: LANDING_HTML });
    expect(requestedUrls()).toEqual([PDF_URL, PAPER_URL]);
  });

  it('does not read the same address again when url_for_pdf equals url and its body is past the limit', async () => {
    const { stream } = countedBody(PAST_LIMIT_BYTES);
    mockFetchWithTimeout
      .mockResolvedValueOnce(streamed(stream))
      .mockResolvedValueOnce(landingPage());

    const error = await refusalOf(
      service().fetchContent({ url: PAPER_URL, url_for_pdf: PAPER_URL }),
    );

    expect(error).toMatchObject({ data: TOO_LARGE });
    expect(requestedUrls()).toEqual([PAPER_URL]);
  });

  it('still reads the same address again when url_for_pdf equals url and the first read failed on the network', async () => {
    mockFetchWithTimeout
      .mockRejectedValueOnce(new Error('connect ECONNRESET'))
      .mockResolvedValueOnce(landingPage());

    const content = await service().fetchContent({ url: PAPER_URL, url_for_pdf: PAPER_URL });

    expect(content).toMatchObject({ kind: 'html', body: LANDING_HTML });
    expect(requestedUrls()).toEqual([PAPER_URL, PAPER_URL]);
  });

  /**
   * The real `fetchWithTimeout` over a stubbed global `fetch`: the deadline it
   * hands to the body, and the caller's signal, reach the read.
   */
  describe('through the fetchWithTimeout body wrapper', () => {
    const fetchStub = vi.fn<typeof fetch>();

    /**
     * Answers the next fetch with a body that sends one chunk, then stays open
     * until that request's signal aborts, which errors it the way a real fetch
     * body errors. Resolves once the first chunk is sent.
     */
    function answerWithStalledBody(): Promise<void> {
      const firstChunkSent = Promise.withResolvers<void>();
      fetchStub.mockImplementationOnce(async (_input, init) => {
        const signal = init?.signal as AbortSignal;
        let sent = false;
        const stream = new ReadableStream<Uint8Array>(
          {
            start(controller) {
              signal.addEventListener('abort', () => controller.error(signal.reason), {
                once: true,
              });
            },
            pull(controller) {
              if (sent) return;
              sent = true;
              controller.enqueue(Uint8Array.of(...PDF_MAGIC));
              firstChunkSent.resolve();
            },
          },
          { highWaterMark: 0 },
        );
        return streamed(stream);
      });
      return firstChunkSent.promise;
    }

    beforeEach(() => {
      fetchStub.mockReset();
      mockFetchWithTimeout.mockImplementation(realFetchWithTimeout);
      vi.stubGlobal('fetch', fetchStub);
    });

    afterEach(() => {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    });

    it('cancels the upstream body and disarms the request deadline when it refuses a body', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const { stream, stats } = countedBody(PAST_LIMIT_BYTES);
      fetchStub.mockResolvedValueOnce(streamed(stream));

      const error = await refusalOf(service().fetchContent({ url: PAPER_URL }));

      expect(error).toMatchObject({ data: TOO_LARGE });
      expect(stats.cancelled).toBe(true);
      // The wrapper's own queue holds one chunk ahead of the reader.
      expect(stats.pulledBytes).toBeLessThanOrEqual(LIMIT_BYTES + 2 * CHUNK_BYTES);
      expect(vi.getTimerCount()).toBe(0);
    });

    it('rejects with RequestCancelled when the caller aborts mid-body', async () => {
      const bodyStarted = answerWithStalledBody();
      const controller = new AbortController();

      const call = service().fetchContent({ url: PAPER_URL }, controller.signal);
      await bodyStarted;
      controller.abort(new DOMException('The client went away', 'AbortError'));

      await expect(call).rejects.toMatchObject({ code: JsonRpcErrorCode.RequestCancelled });
    });

    it('rejects with Timeout when UNPAYWALL_TIMEOUT_MS runs out mid-body, and not before', async () => {
      vi.useFakeTimers();
      const bodyStarted = answerWithStalledBody();
      let settled = false;

      const call = service().fetchContent({ url: PAPER_URL });
      call.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      await bodyStarted;
      await vi.advanceTimersByTimeAsync(19_999);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);

      await expect(call).rejects.toMatchObject({ code: JsonRpcErrorCode.Timeout });
    });
  });
});

/**
 * The tool call's deadline, passed beside the signal: each request's timeout is
 * `UNPAYWALL_TIMEOUT_MS` or the time the deadline has left, whichever is shorter, and
 * a request the shortened timeout cuts ends as `unpaywall_deadline_exceeded`, never as
 * an ordinary timeout. The real `fetchWithTimeout` runs over a stubbed `fetch` under
 * the fake clock. (#310)
 */
describe('UnpaywallService under a tool call deadline (#310)', () => {
  const TIMEOUT_MS = 20_000;
  const DOI = '10.1000/x';
  const PAPER_URL = 'https://example.org/paper';
  const PDF_URL = 'https://example.org/paper.pdf';
  const LANDING_HTML = '<html><body>landing</body></html>';
  const fetchStub = vi.fn<typeof fetch>();

  const service = () => new UnpaywallService('oa@example.com', TIMEOUT_MS);
  const deadlineWith = (leftMs: number, totalMs: number) => ({
    expiresAt: Date.now() + leftMs,
    totalMs,
  });

  /** A response whose headers arrive at once and whose body never ends until its signal aborts. */
  function stalledBody(init: RequestInit | undefined, contentType: string): Response {
    const signal = init?.signal as AbortSignal;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        signal.addEventListener('abort', () => controller.error(signal.reason), { once: true });
      },
    });
    return new Response(stream, { status: 200, headers: { 'content-type': contentType } });
  }

  /** A request that never answers until its signal aborts; one already aborted rejects at once. */
  const hang = (_input: unknown, init: RequestInit | undefined) =>
    new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal as AbortSignal;
      if (signal.aborted) reject(signal.reason);
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });

  /** Run a call under the fake clock; return what it threw and the instant it settled. */
  async function settleTimed(call: Promise<unknown>) {
    const start = Date.now();
    let settledAfterMs: number | undefined;
    const outcome = call.then(
      () => {
        throw new Error('expected the call to fail');
      },
      (error: unknown) => {
        settledAfterMs = Date.now() - start;
        return error;
      },
    );
    await vi.runAllTimersAsync();
    return { error: await outcome, settledAfterMs };
  }

  const requestedUrls = () =>
    fetchStub.mock.calls.map(([input]) => (input instanceof Request ? input.url : String(input)));

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    fetchStub.mockReset();
    mockFetchWithTimeout.mockReset();
    mockFetchWithTimeout.mockImplementation(realFetchWithTimeout);
    vi.stubGlobal('fetch', fetchStub);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  describe('resolve', () => {
    it('settles at the deadline’s instant as unpaywall_deadline_exceeded when it leaves less than UNPAYWALL_TIMEOUT_MS', async () => {
      fetchStub.mockImplementation(hang);
      const { error, settledAfterMs } = await settleTimed(
        service().resolve(DOI, undefined, deadlineWith(5_000, 50_000)),
      );

      expect(error).toBeInstanceOf(McpError);
      expect(error).toMatchObject({
        code: JsonRpcErrorCode.Timeout,
        message: 'Unpaywall request deadline (50000ms) exceeded',
        data: { reason: 'unpaywall_deadline_exceeded', deadlineMs: 50_000, doi: DOI },
      });
      expect(settledAfterMs).toBe(5_000);
    });

    it('ends a lookup body the deadline cuts mid-read as unpaywall_deadline_exceeded', async () => {
      fetchStub.mockImplementation(async (_input, init) => stalledBody(init, 'application/json'));
      const { error, settledAfterMs } = await settleTimed(
        service().resolve(DOI, undefined, deadlineWith(5_000, 50_000)),
      );

      expect(error).toMatchObject({
        code: JsonRpcErrorCode.Timeout,
        data: { reason: 'unpaywall_deadline_exceeded', deadlineMs: 50_000 },
      });
      expect(settledAfterMs).toBe(5_000);
    });

    it('keeps an ordinary UNPAYWALL_TIMEOUT_MS timeout as unpaywall_unreachable when the deadline leaves more time', async () => {
      fetchStub.mockImplementation(hang);
      const { error, settledAfterMs } = await settleTimed(
        service().resolve(DOI, undefined, deadlineWith(30_000, 50_000)),
      );

      expect(error).toMatchObject({
        code: JsonRpcErrorCode.ServiceUnavailable,
        data: { reason: 'unpaywall_unreachable', doi: DOI },
      });
      expect((error as McpError).cause).toMatchObject({ code: JsonRpcErrorCode.Timeout });
      expect(settledAfterMs).toBe(TIMEOUT_MS);
    });

    it.each([0, 1])(
      'sends nothing and arms no timer on a deadline with %i ms left',
      async (leftMs) => {
        fetchStub.mockImplementation(async () => jsonResponse({ is_oa: false }));
        const error = await service()
          .resolve(DOI, undefined, deadlineWith(leftMs, 50_000))
          .catch((e: unknown) => e);

        expect(error).toMatchObject({
          code: JsonRpcErrorCode.Timeout,
          data: { reason: 'unpaywall_deadline_exceeded', deadlineMs: 50_000, doi: DOI },
        });
        expect(fetchStub).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
      },
    );

    it('never reports a caller’s cancellation on a spent deadline as the deadline', async () => {
      fetchStub.mockImplementation(hang);
      const controller = new AbortController();
      controller.abort(new DOMException('The client went away', 'AbortError'));
      const { error } = await settleTimed(
        service().resolve(DOI, controller.signal, deadlineWith(0, 50_000)),
      );

      expect((error as McpError).data?.reason).not.toBe('unpaywall_deadline_exceeded');
      expect((error as McpError).cause).toMatchObject({ code: JsonRpcErrorCode.RequestCancelled });
    });
  });

  describe('fetchContent', () => {
    it('settles at the deadline’s instant as unpaywall_deadline_exceeded when it leaves less than UNPAYWALL_TIMEOUT_MS', async () => {
      fetchStub.mockImplementation(hang);
      const { error, settledAfterMs } = await settleTimed(
        service().fetchContent({ url: PAPER_URL }, undefined, deadlineWith(5_000, 50_000)),
      );

      expect(error).toMatchObject({
        code: JsonRpcErrorCode.Timeout,
        message: 'Unpaywall request deadline (50000ms) exceeded',
        data: { reason: 'unpaywall_deadline_exceeded', deadlineMs: 50_000, host: 'example.org' },
      });
      expect(settledAfterMs).toBe(5_000);
    });

    it('ends a content body the deadline cuts mid-read as unpaywall_deadline_exceeded', async () => {
      fetchStub.mockImplementation(async (_input, init) => stalledBody(init, 'application/pdf'));
      const { error, settledAfterMs } = await settleTimed(
        service().fetchContent({ url: PAPER_URL }, undefined, deadlineWith(5_000, 50_000)),
      );

      expect(error).toMatchObject({
        code: JsonRpcErrorCode.Timeout,
        data: { reason: 'unpaywall_deadline_exceeded', deadlineMs: 50_000 },
      });
      expect(settledAfterMs).toBe(5_000);
    });

    it.each([0, 1])(
      'sends nothing and arms no timer on a deadline with %i ms left',
      async (leftMs) => {
        fetchStub.mockImplementation(
          async () =>
            new Response(LANDING_HTML, { status: 200, headers: { 'content-type': 'text/html' } }),
        );
        const error = await service()
          .fetchContent(
            { url: PAPER_URL, url_for_pdf: PDF_URL },
            undefined,
            deadlineWith(leftMs, 50_000),
          )
          .catch((e: unknown) => e);

        expect(error).toMatchObject({
          code: JsonRpcErrorCode.Timeout,
          data: { reason: 'unpaywall_deadline_exceeded', deadlineMs: 50_000 },
        });
        expect(fetchStub).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
      },
    );

    it('skips the landing-page read once the deadline that cut the PDF read is spent', async () => {
      fetchStub.mockImplementation(hang);
      const { error, settledAfterMs } = await settleTimed(
        service().fetchContent(
          { url: PAPER_URL, url_for_pdf: PDF_URL },
          undefined,
          deadlineWith(5_000, 50_000),
        ),
      );

      expect(error).toMatchObject({
        code: JsonRpcErrorCode.Timeout,
        data: { reason: 'unpaywall_deadline_exceeded', deadlineMs: 50_000 },
      });
      expect(settledAfterMs).toBe(5_000);
      expect(requestedUrls()).toEqual([PDF_URL]);
    });

    it('still reads the landing page after a failed PDF read while the deadline has time left', async () => {
      fetchStub
        .mockRejectedValueOnce(new TypeError('fetch failed'))
        .mockResolvedValueOnce(
          new Response(LANDING_HTML, { status: 200, headers: { 'content-type': 'text/html' } }),
        );

      const content = await service().fetchContent(
        { url: PAPER_URL, url_for_pdf: PDF_URL },
        undefined,
        deadlineWith(5_000, 50_000),
      );

      expect(content).toEqual({ kind: 'html', fetchedUrl: PAPER_URL, body: LANDING_HTML });
      expect(requestedUrls()).toEqual([PDF_URL, PAPER_URL]);
    });
  });
});

/**
 * A request URL can carry a token in its path or query (signed PDF links, the
 * operator's `email` on the lookup), so records and error data name the host,
 * the DOI, or the location slot instead. The request itself still goes to the
 * full URL. (mcp-ts-core 0.13.12, 0.13.13)
 */
describe('URLs stay out of log records and error data', () => {
  const PDF_URL = 'https://cdn.publisher.example/sk-token/paper.pdf?sig=secret';
  const LANDING_URL = 'https://www.publisher.example/article/x?access=secret';
  const HTML = '<html><body>Subscribe to read this article</body></html>';

  let debugSpy: MockInstance<typeof logger.debug>;

  beforeEach(() => {
    mockFetchWithTimeout.mockReset();
    debugSpy = vi.spyOn(logger, 'debug');
  });

  afterEach(() => {
    debugSpy.mockRestore();
  });

  /** The line each `logger.debug` call writes: message, operation, and the context's `extra` fields flattened. */
  const recordsOf = (operation: string) =>
    debugSpy.mock.calls
      .map(([msg, context]) => {
        const ctx = context as RequestContext | undefined;
        return { msg, operation: ctx?.operation, ...ctx?.extra };
      })
      .filter((record) => record.operation === operation);

  /** The context each fetch ran under — the framework writes its fields on every record for that call. */
  const fetchContexts = () =>
    mockFetchWithTimeout.mock.calls.map((call) => {
      const ctx = call[2] as RequestContext;
      return { operation: ctx.operation, ...ctx.extra };
    });

  const expectNoUrl = (value: unknown) => {
    const text = JSON.stringify(value);
    for (const fragment of ['://', 'sk-token', 'secret', 'oa@example.com', 'oa%40example.com']) {
      expect(text).not.toContain(fragment);
    }
  };

  const htmlAt = (url?: string) => {
    const response = new Response(HTML, { status: 200, headers: { 'content-type': 'text/html' } });
    if (url) Object.defineProperty(response, 'url', { value: url });
    return response;
  };

  it('names the hosts when the PDF slot redirects to HTML, while requesting the full URLs', async () => {
    mockFetchWithTimeout
      .mockResolvedValueOnce(htmlAt('https://login.publisher.example/sso?next=secret'))
      .mockResolvedValueOnce(htmlAt(LANDING_URL));

    const service = new UnpaywallService('oa@example.com', 20000);
    const content = await service.fetchContent({ url: LANDING_URL, url_for_pdf: PDF_URL });

    expect(content).toMatchObject({ kind: 'html', fetchedUrl: LANDING_URL });
    expect(mockFetchWithTimeout.mock.calls.map((call) => call[0])).toEqual([PDF_URL, LANDING_URL]);

    const [notPdf, ...rest] = recordsOf('UnpaywallPdfNotPdf');
    expect(rest).toEqual([]);
    expectNoUrl(notPdf);
    expectNoUrl(fetchContexts());
    expect(notPdf).toMatchObject({
      host: 'cdn.publisher.example',
      fetchedHost: 'login.publisher.example',
    });
    expect(fetchContexts()).toEqual([
      { operation: 'UnpaywallFetch', expected: 'pdf', host: 'cdn.publisher.example' },
      { operation: 'UnpaywallFetch', expected: 'auto', host: 'www.publisher.example' },
    ]);
  });

  it('names the host and the error when the PDF fetch fails before the landing-page fetch', async () => {
    const forbidden = new Response('denied', { status: 403 });
    Object.defineProperty(forbidden, 'url', { value: PDF_URL });
    mockFetchWithTimeout
      .mockResolvedValueOnce(forbidden)
      .mockResolvedValueOnce(htmlAt(LANDING_URL));

    const service = new UnpaywallService('oa@example.com', 20000);
    await service.fetchContent({ url: LANDING_URL, url_for_pdf: PDF_URL });

    const [fallback, ...rest] = recordsOf('UnpaywallPdfFallback');
    expect(rest).toEqual([]);
    expectNoUrl(fallback);
    expect(fallback).toMatchObject({
      host: 'cdn.publisher.example',
      error: expect.stringContaining('HTTP 403'),
    });
  });

  it('keeps the URL out of a network failure’s error data', async () => {
    mockFetchWithTimeout.mockRejectedValueOnce(new Error('connect ECONNRESET'));

    const error = await new UnpaywallService('oa@example.com', 20000)
      .fetchContent({ url: LANDING_URL })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(McpError);
    expectNoUrl((error as McpError).data);
    expect((error as McpError).data).toMatchObject({
      reason: 'unpaywall_unreachable',
      host: 'www.publisher.example',
    });
  });

  it('keeps the URL out of a non-2xx error’s data, even when the response carries it', async () => {
    // `httpErrorFromResponse` adds `data.url` only under `includeUrl: true`.
    const forbidden = new Response('denied', { status: 403 });
    Object.defineProperty(forbidden, 'url', { value: LANDING_URL });
    mockFetchWithTimeout.mockResolvedValueOnce(forbidden);

    const error = await new UnpaywallService('oa@example.com', 20000)
      .fetchContent({ url: LANDING_URL })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(McpError);
    expect((error as McpError).data).not.toHaveProperty('url');
    expectNoUrl((error as McpError).data);
    expect(error).toMatchObject({
      code: JsonRpcErrorCode.Forbidden,
      data: { status: 403, body: 'denied', host: 'www.publisher.example' },
    });
  });

  it('names the DOI, never the lookup URL or the operator email, on the resolve call', async () => {
    mockFetchWithTimeout.mockResolvedValueOnce(
      jsonResponse({
        is_oa: true,
        best_oa_location: { url: LANDING_URL, host_type: 'publisher', version: 'publishedVersion' },
      }),
    );

    await new UnpaywallService('oa@example.com', 20000).resolve('10.1000/x');

    expect(mockFetchWithTimeout.mock.calls[0]?.[0]).toContain('email=oa%40example.com');
    expect(fetchContexts()).toEqual([{ operation: 'UnpaywallResolve', doi: '10.1000/x' }]);
    expectNoUrl(fetchContexts());
    const resolved = recordsOf('UnpaywallResolved');
    expect(resolved).toEqual([expect.objectContaining({ doi: '10.1000/x' })]);
    expectNoUrl(resolved);
  });

  /** The logger writes a caller's `version` key as `data_version`. (mcp-ts-core 0.13.13) */
  it('logs the OA location version under oaVersion, a key the logger keeps as written', async () => {
    mockFetchWithTimeout.mockResolvedValueOnce(
      jsonResponse({
        is_oa: true,
        best_oa_location: {
          url: LANDING_URL,
          host_type: 'repository',
          license: 'cc-by',
          version: 'acceptedVersion',
        },
      }),
    );

    await new UnpaywallService('oa@example.com', 20000).resolve('10.1000/x');

    const [resolved, ...rest] = recordsOf('UnpaywallResolved');
    expect(rest).toEqual([]);
    expect(resolved).toEqual({
      msg: 'Unpaywall resolved DOI',
      operation: 'UnpaywallResolved',
      doi: '10.1000/x',
      hostType: 'repository',
      license: 'cc-by',
      oaVersion: 'acceptedVersion',
    });
  });

  it('logs a missing OA version as null under oaVersion', async () => {
    mockFetchWithTimeout.mockResolvedValueOnce(
      jsonResponse({ is_oa: true, oa_locations: [{ url: LANDING_URL }] }),
    );

    await new UnpaywallService('oa@example.com', 20000).resolve('10.1000/x');

    expect(recordsOf('UnpaywallResolved')).toEqual([
      expect.objectContaining({ hostType: null, license: null, oaVersion: null }),
    ]);
    expect(recordsOf('UnpaywallResolved')[0]).not.toHaveProperty('version');
  });

  /** No path token, query, or operator email from the request URLs above. */
  const expectNoUrlQuery = (value: unknown) => {
    const text = JSON.stringify(value);
    for (const fragment of ['sk-token', 'secret', 'oa@example.com', 'oa%40example.com']) {
      expect(text).not.toContain(fragment);
    }
  };

  /**
   * A 200 whose body fails mid-stream with a rejection quoting the request URL whole,
   * as Bun 1.4 writes some of them.
   */
  const bodyFailingWith = (url: string) => {
    const rejection = Object.assign(
      new TypeError(
        `InvalidHTTPResponse fetching "${url}". For more information, pass \`verbose: true\` in the second argument to fetch()`,
      ),
      { code: 'InvalidHTTPResponse', path: url },
    );
    const body = new ReadableStream({ start: (controller) => controller.error(rejection) });
    return { rejection, response: new Response(body, { status: 200 }) };
  };

  it('a lookup whose body fails names only the host in the rejection', async () => {
    const { rejection, response } = bodyFailingWith(
      'https://api.unpaywall.org/v2/10.1000%2Fx?email=oa%40example.com',
    );
    mockFetchWithTimeout.mockResolvedValueOnce(response);

    const error = await new UnpaywallService('oa@example.com', 20000)
      .resolve('10.1000/x')
      .catch((e: unknown) => e);

    // The same rejection, its classification unchanged; only its text is redacted.
    expect(error).toBe(rejection);
    expect(error).toMatchObject({ code: 'InvalidHTTPResponse' });
    expect((error as Error).message).toContain('"https://api.unpaywall.org/…?…"');
    expectNoUrlQuery((error as Error).message);
  });

  it('a content fetch whose body fails names only the host, in the fallback record and the error', async () => {
    mockFetchWithTimeout
      .mockResolvedValueOnce(bodyFailingWith(PDF_URL).response)
      .mockResolvedValueOnce(bodyFailingWith(LANDING_URL).response);

    const error = await new UnpaywallService('oa@example.com', 20000)
      .fetchContent({ url: LANDING_URL, url_for_pdf: PDF_URL })
      .catch((e: unknown) => e);

    expect(recordsOf('UnpaywallPdfFallback')).toEqual([
      expect.objectContaining({
        host: 'cdn.publisher.example',
        error: expect.stringContaining('"https://cdn.publisher.example/…?…"'),
      }),
    ]);
    expectNoUrlQuery(recordsOf('UnpaywallPdfFallback'));
    expect((error as Error).message).toContain('"https://www.publisher.example/…?…"');
    expectNoUrlQuery((error as Error).message);
  });
});

describe('initUnpaywallService / getUnpaywallService', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('leaves the service unset when UNPAYWALL_EMAIL is missing', async () => {
    delete process.env.UNPAYWALL_EMAIL;
    delete process.env.UNPAYWALL_TIMEOUT_MS;

    const mod = await import('@/services/unpaywall/unpaywall-service.js');
    mod.initUnpaywallService();
    expect(mod.getUnpaywallService()).toBeUndefined();
  });

  it('constructs the service when UNPAYWALL_EMAIL is configured', async () => {
    vi.stubEnv('UNPAYWALL_EMAIL', 'oa@example.com');
    delete process.env.UNPAYWALL_TIMEOUT_MS;

    const mod = await import('@/services/unpaywall/unpaywall-service.js');
    mod.initUnpaywallService();
    expect(mod.getUnpaywallService()).toBeInstanceOf(mod.UnpaywallService);
  });
});

// Silence unused-import warning — imports exercised via dynamic import above.
void initUnpaywallService;
void getUnpaywallService;
