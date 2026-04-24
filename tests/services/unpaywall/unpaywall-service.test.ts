/**
 * @fileoverview Tests for the Unpaywall service.
 * @module tests/services/unpaywall/unpaywall-service.test
 */

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
    mockFetchWithTimeout.mockResolvedValue(new Response('not found', { status: 404 }));
    const service = new UnpaywallService('oa@example.com', 20000);

    const result = await service.resolve('10.0000/unknown');
    expect(result).toEqual({ kind: 'no-oa', reason: 'DOI unknown to Unpaywall' });
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
    mockFetchWithTimeout.mockResolvedValue(new Response('down', { status: 503 }));
    const service = new UnpaywallService('oa@example.com', 20000);

    await expect(service.resolve('10.1000/example')).rejects.toThrow(/HTTP 503/);
  });

  it('throws ServiceUnavailable on network errors', async () => {
    mockFetchWithTimeout.mockRejectedValue(new Error('connect ETIMEDOUT'));
    const service = new UnpaywallService('oa@example.com', 20000);

    await expect(service.resolve('10.1000/example')).rejects.toThrow(/connect ETIMEDOUT/);
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
