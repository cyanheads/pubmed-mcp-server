/**
 * @fileoverview Resource exposing PubMed database metadata via NCBI EInfo.
 * Returns field list, record count, last update date, and description.
 * @module src/mcp-server/resources/definitions/database-info.resource
 */

import { resource, z } from '@cyanheads/mcp-ts-core';
import { getNcbiService } from '@/services/ncbi/ncbi-service.js';
import { ensureArray, getText } from '@/services/ncbi/parsing/xml-helpers.js';

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

export const databaseInfoResource = resource('pubmed://database/info', {
  name: 'database-info',
  title: 'PubMed Database Info',
  description: 'PubMed database metadata including field list, last update date, and record count.',
  mimeType: 'application/json',
  params: z.object({}),
  output: OutputSchema,

  async handler(_params, ctx) {
    ctx.log.info('Fetching PubMed database info');

    const raw = (await getNcbiService().eInfo({ db: 'pubmed' })) as Record<string, unknown>;

    const eInfoResult = (raw.eInfoResult ?? raw) as Record<string, unknown>;
    const dbInfo = (eInfoResult.DbInfo ?? eInfoResult) as Record<string, unknown>;

    const dbName = getText(dbInfo.DbName, 'pubmed');
    const description = getText(dbInfo.Description) || undefined;
    const count = getText(dbInfo.Count) || undefined;
    const lastUpdate = getText(dbInfo.LastUpdate) || undefined;

    const fieldListContainer = dbInfo.FieldList as Record<string, unknown> | undefined;
    let fields: z.infer<typeof FieldSchema>[] | undefined;

    if (fieldListContainer) {
      const rawFields = ensureArray(fieldListContainer.Field) as Record<string, unknown>[];
      fields = rawFields.map((f) => ({
        name: getText(f.Name),
        fullName: getText(f.FullName) || undefined,
        description: getText(f.Description) || undefined,
      }));
    }

    ctx.log.info('PubMed database info retrieved', {
      dbName,
      fieldCount: fields?.length ?? 0,
    });

    return { dbName, description, count, lastUpdate, fields };
  },

  list: () => ({
    resources: [{ uri: 'pubmed://database/info', name: 'PubMed Database Info' }],
  }),
});
