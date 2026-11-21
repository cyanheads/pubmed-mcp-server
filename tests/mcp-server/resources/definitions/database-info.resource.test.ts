/**
 * @fileoverview Tests for the database-info resource.
 * @module tests/mcp-server/resources/definitions/database-info.resource.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { NCBI_SERVICE_ERRORS } from '@/services/error-contracts.js';

const mockEInfo = vi.fn();
vi.mock('@/services/ncbi/ncbi-service.js', () => ({
  getNcbiService: () => ({ eInfo: mockEInfo }),
}));

const { databaseInfoResource } = await import(
  '@/mcp-server/resources/definitions/database-info.resource.js'
);

describe('databaseInfoResource', () => {
  it('returns database metadata', async () => {
    mockEInfo.mockResolvedValue({
      eInfoResult: {
        DbInfo: {
          DbName: 'pubmed',
          Description: 'PubMed bibliographic database',
          Count: '36000000',
          LastUpdate: '2024/03/15 12:00',
          FieldList: {
            Field: [
              { Name: 'ALL', FullName: 'All Fields', Description: 'All terms' },
              { Name: 'AU', FullName: 'Author', Description: 'Author name' },
            ],
          },
        },
      },
    });

    const ctx = createMockContext({ errors: databaseInfoResource.errors });
    const params = databaseInfoResource.params!.parse({});
    const result = await databaseInfoResource.handler(params, ctx);

    expect(result.dbName).toBe('pubmed');
    expect(result.description).toBe('PubMed bibliographic database');
    expect(result.count).toBe('36000000');
    expect(result.fields).toHaveLength(2);
    expect(result.fields?.[0]?.name).toBe('ALL');
  });

  it('handles missing fields gracefully', async () => {
    mockEInfo.mockResolvedValue({
      eInfoResult: { DbInfo: { DbName: 'pubmed' } },
    });

    const ctx = createMockContext({ errors: databaseInfoResource.errors });
    const params = databaseInfoResource.params!.parse({});
    const result = await databaseInfoResource.handler(params, ctx);

    expect(result.dbName).toBe('pubmed');
    expect(result.fields).toBeUndefined();
  });

  it('lists available resources', async () => {
    /**
     * `list` receives the SDK's `ServerContext`, not a handler `Context`, and
     * may be async — a minimal literal is enough for a listing that ignores it.
     */
    const serverContext = {
      mcpReq: {
        id: 'test',
        method: 'resources/list',
        signal: new AbortController().signal,
      },
    } as unknown as Parameters<NonNullable<typeof databaseInfoResource.list>>[0];
    const listing = await databaseInfoResource.list!(serverContext);
    expect(listing.resources).toHaveLength(1);
    expect(listing.resources[0]).toMatchObject({
      uri: 'pubmed://database/info',
      name: 'PubMed Database Info',
    });
  });

  it('declares every NCBI service reason, so a service throw reaches the wire with its hint', () => {
    expect(databaseInfoResource.errors?.map((e) => e.reason)).toEqual(
      NCBI_SERVICE_ERRORS.map((e) => e.reason),
    );
  });
});

describe('databaseInfoResource call deadline (issue #310)', () => {
  const STARTED_AT = Date.UTC(2026, 0, 1);

  beforeEach(() => {
    mockEInfo.mockReset();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(STARTED_AT);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('passes EInfo the deadline the read starts, beside ctx.signal', async () => {
    mockEInfo.mockResolvedValue({ eInfoResult: { DbInfo: { DbName: 'pubmed' } } });
    const ctx = createMockContext({ errors: databaseInfoResource.errors });
    await databaseInfoResource.handler(databaseInfoResource.params!.parse({}), ctx);

    expect(mockEInfo).toHaveBeenCalledTimes(1);
    const options = mockEInfo.mock.lastCall?.[1];
    expect(options).toEqual({
      signal: ctx.signal,
      deadline: { expiresAt: STARTED_AT + 50_000, totalMs: 50_000 },
    });
    expect(options.signal).toBe(ctx.signal);
  });
});
