/**
 * @fileoverview Resource protocol conformance tests.
 * Validates resource listing and template listing through the full protocol stack.
 *
 * The database-info resource hits external NCBI APIs, so readResource tests
 * are limited to protocol-level error handling (invalid URI rejection).
 * @module tests/conformance/resources
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { type ConformanceHarness, createConformanceHarness } from './helpers/server-harness.js';

describe('Resource protocol conformance', () => {
  let harness: ConformanceHarness;

  beforeAll(async () => {
    harness = await createConformanceHarness();
  });

  afterAll(async () => {
    await harness?.cleanup();
  });

  // ── Listing ──────────────────────────────────────────────────────────────

  describe('listResources', () => {
    it('returns a resources array', async () => {
      const result = await harness.client.listResources();
      expect(result.resources).toBeDefined();
      expect(Array.isArray(result.resources)).toBe(true);
    });

    it('each resource has uri and name', async () => {
      const { resources } = await harness.client.listResources();
      for (const resource of resources) {
        expect(resource.uri).toBeTruthy();
        expect(typeof resource.uri).toBe('string');
        expect(resource.name).toBeTruthy();
        expect(typeof resource.name).toBe('string');
      }
    });

    it('includes the database-info resource', async () => {
      const { resources } = await harness.client.listResources();
      const dbInfo = resources.find((r) => r.uri === 'pubmed://database/info');
      expect(dbInfo).toBeDefined();
      expect(dbInfo?.name).toBe('PubMed Database Info');
    });
  });

  // ── Resource templates ──────────────────────────────────────────────────

  describe('listResourceTemplates', () => {
    it('returns resource templates array', async () => {
      const result = await harness.client.listResourceTemplates();
      expect(result.resourceTemplates).toBeDefined();
      expect(Array.isArray(result.resourceTemplates)).toBe(true);
    });
  });

  // ── Error handling ──────────────────────────────────────────────────────

  describe('readResource', () => {
    it('rejects invalid resource URI', async () => {
      await expect(
        harness.client.readResource({
          uri: 'nonexistent://resource/that/does/not/exist',
        }),
      ).rejects.toThrow();
    });
  });
});
