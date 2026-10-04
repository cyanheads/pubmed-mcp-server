/**
 * @fileoverview The PMC ID Converter's HTTP 400, from the wire to the service
 * error: the real `NcbiApiClient` classifies the response and
 * `NcbiService.idConvert` rewrites it with idType guidance, keeping the
 * `InvalidParams` code every other NCBI 400 carries. No tool input reaches this
 * path today — every caller's ids pass a schema that excludes the converter's
 * 400 triggers — so `fetch` fakes the status.
 * @module tests/services/ncbi/idconvert-http-400.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createPacer } from '@cyanheads/mcp-ts-core/utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NcbiApiClient } from '@/services/ncbi/api-client.js';
import { NcbiService } from '@/services/ncbi/ncbi-service.js';
import type { NcbiResponseHandler } from '@/services/ncbi/response-handler.js';

vi.mock('@cyanheads/mcp-ts-core/utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@cyanheads/mcp-ts-core/utils')>();
  return {
    ...actual,
    logger: { debug: vi.fn(), info: vi.fn(), notice: vi.fn(), warning: vi.fn(), error: vi.fn() },
    requestContextService: { createRequestContext: vi.fn(() => ({ requestId: 'test' })) },
  };
});

describe('NcbiService.idConvert on an HTTP 400 from the PMC ID Converter', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('unmocked fetch'));
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  const service = () =>
    new NcbiService(
      new NcbiApiClient({ toolIdentifier: 'test-tool', timeoutMs: 5_000 }),
      createPacer({ name: 'ncbi-test' }),
      {} as NcbiResponseHandler,
      3,
      60_000,
    );

  it('reports InvalidParams with the idType hint, once, without the upstream body', async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response('<html><body>Bad Request: invalid id</body></html>', { status: 400 }),
    );

    const error = await service()
      .idConvert(['not-a-real-id'], 'pmid')
      .catch((e: unknown) => e);

    expect(error).toMatchObject({
      code: JsonRpcErrorCode.InvalidParams,
      message:
        'PMC ID Converter rejected one or more inputs as malformed (idType="pmid"). Expected: numeric digits, e.g. "23193287".',
      data: { idType: 'pmid', idCount: 1 },
    });
    expect((error as { data: Record<string, unknown> }).data).not.toHaveProperty('body');
    // A caller error is not retried, though the service allows three retries.
    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(String(fetchSpy.mock.calls[0]?.[0])).toContain('/tools/idconv/');
  });

  it('keeps the generic message when no idType was given', async () => {
    fetchSpy.mockResolvedValueOnce(new Response('Bad Request', { status: 400 }));

    await expect(service().idConvert(['x'])).rejects.toMatchObject({
      code: JsonRpcErrorCode.InvalidParams,
      message: 'PMC ID Converter rejected the input as malformed (idType="unspecified").',
      data: { idCount: 1 },
    });
  });
});
