/**
 * @fileoverview Tests for the database-info resource.
 * @module tests/mcp-server/resources/definitions/database-info.resource.test
 */

import { describe, expect, it, vi } from 'vitest';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';

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

    const ctx = createMockContext();
    const params = databaseInfoResource.params.parse({});
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

    const ctx = createMockContext();
    const params = databaseInfoResource.params.parse({});
    const result = await databaseInfoResource.handler(params, ctx);

    expect(result.dbName).toBe('pubmed');
    expect(result.fields).toBeUndefined();
  });

  it('lists available resources', () => {
    const listing = databaseInfoResource.list!();
    expect(listing.resources).toHaveLength(1);
    expect(listing.resources[0]).toMatchObject({
      uri: 'pubmed://database/info',
      name: 'PubMed Database Info',
    });
  });
});
