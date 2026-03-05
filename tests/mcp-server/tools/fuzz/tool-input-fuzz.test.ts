/**
 * @fileoverview Property-based fuzz tests for all registered MCP tool definitions.
 *
 * Automatically derives fast-check arbitraries from each tool's Zod inputSchema
 * and outputSchema, then asserts universal invariants:
 *
 * - **Layer 1 (Schema Parsing):** Generated inputs always pass `inputSchema.safeParse`.
 * - **Layer 2 (Logic Invariants):** Tool logic only throws `McpError` (never raw errors),
 *   and successful outputs validate against `outputSchema`.
 * - **Layer 3 (Formatter Safety):** `responseFormatter` never crashes on valid output shapes.
 *
 * Run via: `bun run test:fuzz`
 *
 * @module tests/mcp-server/tools/fuzz/tool-input-fuzz
 */

import { zxTest } from '@traversable/zod-test';
import fc from 'fast-check';
import { describe, expect, it, vi } from 'vitest';
import type { ZodObject, ZodRawShape } from 'zod';
import { isTaskToolDefinition } from '@/mcp-server/tasks/utils/taskToolDefinition.js';
import { allToolDefinitions } from '@/mcp-server/tools/definitions/index.js';
import type { ToolDefinition } from '@/mcp-server/tools/utils/toolDefinition.js';
import { McpError } from '@/types-global/errors.js';
import { requestContextService } from '@/utils/internal/requestContext.js';

/** Widened type alias for uniform property access across tool definitions. */
type AnyToolDef = ToolDefinition<ZodObject<ZodRawShape>, ZodObject<ZodRawShape>>;

// ─── Configuration ───────────────────────────────────────────────────────────

/** Number of random inputs per property assertion. */
const NUM_RUNS = 200;

/**
 * Tools excluded from logic execution during fuzz testing.
 * These require external APIs, real SDK capabilities, or special execution models
 * that can't be stubbed with a minimal mock context.
 */
const LOGIC_SKIP = new Set([
  'pubmed_search', // requires NcbiService (external NCBI API)
  'pubmed_fetch', // requires NcbiService (external NCBI API)
  'pubmed_spell', // requires NcbiService (external NCBI API)
  'pubmed_cite', // requires NcbiService (external NCBI API)
  'pubmed_related', // requires NcbiService (external NCBI API)
  'pubmed_trending', // requires NcbiService (external NCBI API)
  'pubmed_mesh_lookup', // requires NcbiService (external NCBI API)
  'pubmed_pmc_fetch', // requires NcbiService (external NCBI API)
]);

/**
 * Tools excluded from schema-level fuzz testing.
 * The fuzz arbitrary generator (zod-test) doesn't fully respect
 * all Zod constraints (e.g. array .min(1), string .regex).
 */
const SCHEMA_SKIP = new Set([
  'pubmed_fetch', // .min(1) on pmids array not respected by arbitrary
  'pubmed_cite', // .min(1) on pmids array not respected by arbitrary
  'pubmed_pmc_fetch', // .refine() cross-field constraints + z.lazy() recursive schema unsupported by fuzzer
]);

// ─── Test Fixtures ───────────────────────────────────────────────────────────

/** Minimal SDK context stub — tools under fuzz should not call into these. */
const mockSdkContext = {
  signal: new AbortController().signal,
  requestId: 'fuzz-test',
  sendNotification: vi.fn(),
  sendRequest: vi.fn(),
} as any;

/**
 * Wraps zxTest.fuzz with a cast to bridge exactOptionalPropertyTypes
 * incompatibilities across Zod's internal generic type boundaries.
 */
const fuzz = (schema: ZodObject<ZodRawShape>): fc.Arbitrary<Record<string, unknown>> =>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  zxTest.fuzz(schema as any);

/** Separate regular tools from task tools for different test strategies. */
const regularTools = allToolDefinitions.filter((t) => !isTaskToolDefinition(t)) as AnyToolDef[];

/** Regular tools with schema-compatible fuzz arbitraries. */
const fuzzableTools = regularTools.filter((t) => !SCHEMA_SKIP.has(t.name));

const taskTools = allToolDefinitions.filter(isTaskToolDefinition);

// ─── Layer 1: Schema Parsing ─────────────────────────────────────────────────

describe('Tool Input Fuzz Tests', () => {
  describe('Layer 1: Schema Parsing', () => {
    describe.each(fuzzableTools.map((t) => [t.name, t] as const))('%s', (_name, tool) => {
      it('inputSchema.safeParse succeeds for all generated inputs', () => {
        const arb = fuzz(tool.inputSchema);

        fc.assert(
          fc.property(arb, (input) => {
            const parsed = tool.inputSchema.safeParse(input);
            expect(parsed.success).toBe(true);
          }),
          { numRuns: NUM_RUNS },
        );
      });
    });

    describe.each(taskTools.map((t) => [t.name, t] as const))('%s (task tool)', (_name, tool) => {
      it('inputSchema.safeParse succeeds for all generated inputs', () => {
        const arb = fuzz(tool.inputSchema);

        fc.assert(
          fc.property(arb, (input) => {
            const parsed = tool.inputSchema.safeParse(input);
            expect(parsed.success).toBe(true);
          }),
          { numRuns: NUM_RUNS },
        );
      });
    });
  });

  // ─── Layer 2: Logic Invariants ───────────────────────────────────────────────

  describe('Layer 2: Logic Invariants', () => {
    const logicTestableTools = regularTools.filter((t) => !LOGIC_SKIP.has(t.name));

    if (logicTestableTools.length === 0) {
      it.skip('no tools available for logic fuzz testing', () => {});
    } else {
      describe.each(logicTestableTools.map((t) => [t.name, t] as const))('%s', (_name, tool) => {
        it('logic never throws non-McpError exceptions', async () => {
          const arb = fuzz(tool.inputSchema);

          await fc.assert(
            fc.asyncProperty(arb, async (input) => {
              const ctx = requestContextService.createRequestContext({
                operation: `fuzz:${tool.name}`,
              });

              try {
                await tool.logic(input, ctx, mockSdkContext);
              } catch (err) {
                expect(err).toBeInstanceOf(McpError);
              }
            }),
            { numRuns: NUM_RUNS },
          );
        });

        it('successful logic output validates against outputSchema', async () => {
          const arb = fuzz(tool.inputSchema);

          await fc.assert(
            fc.asyncProperty(arb, async (input) => {
              const ctx = requestContextService.createRequestContext({
                operation: `fuzz:${tool.name}`,
              });

              try {
                const result = await tool.logic(input, ctx, mockSdkContext);
                const parsed = tool.outputSchema.safeParse(result);
                if (!parsed.success) {
                  // Surface the validation error for debugging
                  expect.fail(
                    `outputSchema validation failed: ${JSON.stringify(parsed.error.issues, null, 2)}`,
                  );
                }
              } catch (err) {
                // McpError is acceptable — tested in the invariant above
                if (!(err instanceof McpError)) {
                  throw err;
                }
              }
            }),
            { numRuns: NUM_RUNS },
          );
        });
      });
    }
  });

  // ─── Layer 3: Response Formatter Safety ────────────────────────────────────

  describe('Layer 3: Response Formatter Safety', () => {
    const toolsWithFormatters = fuzzableTools.filter((t) => t.responseFormatter != null);

    describe.each(toolsWithFormatters.map((t) => [t.name, t] as const))('%s', (_name, tool) => {
      it('responseFormatter never crashes on valid output shapes', () => {
        const arb = fuzz(tool.outputSchema);

        fc.assert(
          fc.property(arb, (output) => {
            const blocks = tool.responseFormatter?.(output);
            expect(Array.isArray(blocks)).toBe(true);
            for (const block of blocks!) {
              expect(block).toHaveProperty('type');
            }
          }),
          { numRuns: NUM_RUNS },
        );
      });
    });
  });
});
