/**
 * @fileoverview Tool protocol conformance tests.
 * Validates tool listing, field validation, and error handling
 * through the full protocol stack (Client → InMemoryTransport → McpServer).
 *
 * All tools in this server hit external NCBI APIs, so invocation tests are
 * limited to protocol-level behavior (unknown tool errors, listing structure).
 * @module tests/conformance/tools
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assertValidToolEntry } from './helpers/assertions.js';
import { type ConformanceHarness, createConformanceHarness } from './helpers/server-harness.js';

describe('Tool protocol conformance', () => {
  let harness: ConformanceHarness;

  beforeAll(async () => {
    harness = await createConformanceHarness();
  });

  afterAll(async () => {
    await harness?.cleanup();
  });

  // ── Listing ──────────────────────────────────────────────────────────────

  describe('listTools', () => {
    it('returns a non-empty tool list', async () => {
      const result = await harness.client.listTools();
      expect(result.tools.length).toBeGreaterThanOrEqual(1);
    });

    it('every tool has valid protocol fields', async () => {
      const { tools } = await harness.client.listTools();
      for (const tool of tools) {
        assertValidToolEntry(tool);
      }
    });

    it('includes the expected pubmed tools', async () => {
      const { tools } = await harness.client.listTools();
      const names = new Set(tools.map((t) => t.name));

      const expected = [
        'pubmed_search',
        'pubmed_fetch',
        'pubmed_spell',
        'pubmed_cite',
        'pubmed_related',
        'pubmed_trending',
        'pubmed_mesh_lookup',
      ];
      for (const name of expected) {
        expect(names.has(name), `missing tool: ${name}`).toBe(true);
      }
    });

    it('tools with outputSchema have valid structure', async () => {
      const { tools } = await harness.client.listTools();
      for (const tool of tools) {
        if (tool.outputSchema) {
          expect(tool.outputSchema.type).toBe('object');
        }
      }
    });

    it('tools with annotations have valid structure', async () => {
      const { tools } = await harness.client.listTools();
      const annotated = tools.filter((t) => t.annotations);
      // At least some tools should have annotations
      expect(annotated.length).toBeGreaterThan(0);
      for (const tool of annotated) {
        // annotations is an object — any hint keys are booleans
        const hints = tool.annotations as Record<string, unknown>;
        for (const [key, val] of Object.entries(hints)) {
          if (key.endsWith('Hint')) {
            expect(typeof val).toBe('boolean');
          }
        }
      }
    });
  });

  // ── Error handling ────────────────────────────────────────────────────────

  describe('error handling', () => {
    it('returns isError for unknown tool', async () => {
      const result = await harness.client.callTool({
        name: 'nonexistent_tool_abc123',
        arguments: {},
      });

      expect('isError' in result).toBe(true);
      expect(result.isError).toBe(true);
      if ('content' in result) {
        const textBlock = (result.content as { type: string; text?: string }[]).find(
          (b) => b.type === 'text',
        );
        expect(textBlock?.text).toContain('not found');
      }
    });
  });
});
