/**
 * @fileoverview Resource exposing PubMed database metadata via NCBI eInfo.
 * Returns field list, record count, last update date, and description.
 * @module src/mcp-server/resources/definitions/database-info.resource
 */

import { z } from 'zod';

import { container } from '@/container/core/container.js';
import { NcbiServiceToken } from '@/container/core/tokens.js';
import type { ResourceDefinition } from '@/mcp-server/resources/utils/resourceDefinition.js';
import { withResourceAuth } from '@/mcp-server/transports/auth/lib/withAuth.js';
import { ensureArray, getText } from '@/services/ncbi/parsing/xml-helpers.js';
import { logger } from '@/utils/internal/logger.js';
import type { RequestContext } from '@/utils/internal/requestContext.js';

const ncbi = () => container.resolve(NcbiServiceToken);

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const ParamsSchema = z.object({}).describe('No parameters required');

const FieldSchema = z.object({
  name: z.string().describe('Short field name used in queries'),
  fullName: z.string().optional().describe('Full display name'),
  description: z.string().optional().describe('Field description'),
});

const OutputSchema = z.object({
  dbName: z.string().describe('Database name'),
  description: z.string().optional().describe('Database description'),
  count: z.string().optional().describe('Total record count'),
  lastUpdate: z.string().optional().describe('Last update timestamp'),
  fields: z.array(FieldSchema).optional().describe('Searchable fields available in this database'),
});

type Output = z.infer<typeof OutputSchema>;

// ---------------------------------------------------------------------------
// Logic
// ---------------------------------------------------------------------------

async function databaseInfoLogic(
  _uri: URL,
  _params: z.infer<typeof ParamsSchema>,
  context: RequestContext,
): Promise<Output> {
  logger.debug('Fetching PubMed database info.', { ...context });

  const raw = (await ncbi().eInfo({ db: 'pubmed' }, context)) as Record<string, unknown>;

  // eInfo XML parses to { eInfoResult: { DbInfo: { ... } } }
  const eInfoResult = (raw.eInfoResult ?? raw) as Record<string, unknown>;
  const dbInfo = (eInfoResult.DbInfo ?? eInfoResult) as Record<string, unknown>;

  const dbName = getText(dbInfo.DbName, 'pubmed');
  const description = getText(dbInfo.Description) || undefined;
  const count = getText(dbInfo.Count) || undefined;
  const lastUpdate = getText(dbInfo.LastUpdate) || undefined;

  // Parse fields
  const fieldListContainer = dbInfo.FieldList as Record<string, unknown> | undefined;
  let fields: Output['fields'];

  if (fieldListContainer) {
    const rawFields = ensureArray(fieldListContainer.Field) as Record<string, unknown>[];
    fields = rawFields.map((f) => {
      const name = getText(f.Name);
      const fullName = getText(f.FullName) || undefined;
      const desc = getText(f.Description) || undefined;
      return { name, fullName, description: desc };
    });
  }

  logger.debug('PubMed database info retrieved.', {
    ...context,
    dbName,
    fieldCount: fields?.length ?? 0,
  });

  return { dbName, description, count, lastUpdate, fields };
}

// ---------------------------------------------------------------------------
// Definition
// ---------------------------------------------------------------------------

export const databaseInfoResource: ResourceDefinition<typeof ParamsSchema, typeof OutputSchema> = {
  name: 'database-info',
  title: 'PubMed Database Info',
  description: 'PubMed database metadata including field list, last update date, and record count.',
  uriTemplate: 'pubmed://database/info',
  mimeType: 'application/json',
  paramsSchema: ParamsSchema,
  outputSchema: OutputSchema,
  logic: withResourceAuth(['resource:database_info:read'], databaseInfoLogic),
  list: () => ({
    resources: [{ uri: 'pubmed://database/info', name: 'PubMed Database Info' }],
  }),
  examples: [{ name: 'PubMed Database Info', uri: 'pubmed://database/info' }],
};
