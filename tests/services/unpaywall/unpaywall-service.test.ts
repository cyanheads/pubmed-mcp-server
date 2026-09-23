/**
 * @fileoverview Tests for the Unpaywall service.
 * @module tests/services/unpaywall/unpaywall-service.test
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
    mockFetchWithTimeout.mockResolvedValue(jsonResponse({ is_oa: false }));
    const service = new UnpaywallService('oa@example.com', 20000);

    await service.resolve('https://doi.org/10.1000/example');
    expect(mockFetchWithTimeout).toHaveBeenCalledWith(
      expect.stringContaining('10.1000%2Fexample'),
      expect.any(Number),
      expect.any(Object),
      expect.any(Object),
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

    await expect(service.resolve('10.1000/example')).rejects.toThrow(/Status: 503/);
  });

  it('throws ServiceUnavailable on network errors', async () => {
    mockFetchWithTimeout.mockRejectedValue(new Error('connect ETIMEDOUT'));
    const service = new UnpaywallService('oa@example.com', 20000);

    await expect(service.resolve('10.1000/example')).rejects.toThrow(/connect ETIMEDOUT/);
  });

  it('network error on resolve stamps reason unpaywall_unreachable + recovery on the wire', async () => {
    mockFetchWithTimeout.mockRejectedValue(new Error('connect ETIMEDOUT'));
    const service = new UnpaywallService('oa@example.com', 20000);

    await expect(service.resolve('10.1000/example')).rejects.toMatchObject({
      data: {
        reason: 'unpaywall_unreachable',
        doi: '10.1000/example',
        recovery: { hint: expect.stringContaining('Unpaywall was unreachable') },
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

  it('network error on fetchContent stamps reason unpaywall_unreachable + recovery on the wire', async () => {
    mockFetchWithTimeout.mockRejectedValue(new Error('connect ECONNRESET'));
    const service = new UnpaywallService('oa@example.com', 20000);

    await expect(service.fetchContent({ url: 'https://example.org/paper' })).rejects.toMatchObject({
      data: {
        reason: 'unpaywall_unreachable',
        url: 'https://example.org/paper',
        recovery: { hint: expect.stringContaining('Unpaywall was unreachable') },
      },
    });
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
        bytesResponse(pdfBytes('  truncated'), 'application/pdf'),
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
