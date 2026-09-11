/**
 * @fileoverview Shared mock factory and fuzz runner for tool fuzz tests.
 *
 * `createMockNcbiService()` builds a permissive `NcbiService` stub whose
 * every method returns the minimal valid shape its consumer expects so
 * Phase 1 (valid inputs → handler runs to completion) doesn't crash on
 * shape errors.
 *
 * `fuzzToolStrict()` wraps the framework's primitives but pre-parses Phase 1
 * inputs through the tool's own input schema. The framework's `fuzzTool`
 * walks `zodToArbitrary` output directly — fields with `.default()` arrive
 * `undefined`, propagate to output, and fail the output schema's `.parse()`.
 * `min(1)` array constraints are also not honored by the arbitrary, which
 * leaks invalid inputs into Phase 1. Pre-parsing with `safeParse` mirrors
 * the runtime's call boundary (where defaults apply and rejected inputs
 * never reach the handler) and skips over arbitrary outputs the schema
 * itself rejects.
 *
 * @module tests/mcp-server/tools/definitions/_fuzz-helpers
 */

import { McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import {
  adversarialObjectArbitrary,
  type FuzzReport,
  loadFc,
  zodToArbitrary,
} from '@cyanheads/mcp-ts-core/testing/fuzz';
import type { AnyToolDefinition } from '@cyanheads/mcp-ts-core/tools';
import fc from 'fast-check';
import type { Mock } from 'vitest';
import { vi } from 'vitest';

import {
  articleSetXml,
  GENEREVIEWS_CHAPTER_XML,
  JOURNAL_ARTICLE_XML,
  parseArticleSetXml,
} from '../../../services/ncbi/parsing/_book-fixtures.js';

/**
 * One journal article and one NCBI Bookshelf chapter, parsed through the
 * production response handler. An EFetch batch can return both kinds side by
 * side, and a mock carrying only `PubmedArticle` leaves the whole book branch —
 * parse, output schema, `format()` — invisible to the fuzz runner. (#114)
 */
const MIXED_ARTICLE_SET = parseArticleSetXml(
  articleSetXml(JOURNAL_ARTICLE_XML, GENEREVIEWS_CHAPTER_XML),
);

/** Mock NCBI service exposing every method the 9 tools call. */
export interface MockNcbiService {
  eCitMatch: Mock;
  eFetch: Mock;
  eInfo: Mock;
  eLink: Mock;
  eSearch: Mock;
  eSpell: Mock;
  eSummary: Mock;
  idConvert: Mock;
}

/**
 * Build a fresh mock NCBI service with permissive default returns. Each method
 * returns the minimal valid shape its consumer expects — no crashes from the
 * handler walking missing fields.
 *
 * `eFetch` dispatches by `params.db`: `pmc` returns the JATS ordered-parser
 * shape (an array containing a single `pmc-articleset` element with no child
 * articles), everything else returns a `PubmedArticleSet` holding one
 * `PubmedArticle` and one `PubmedBookArticle`, the mixed shape a real EFetch
 * batch can return.
 */
export function createMockNcbiService(): MockNcbiService {
  return {
    eSearch: vi.fn().mockResolvedValue({
      count: 0,
      retmax: 0,
      retstart: 0,
      idList: [],
      queryTranslation: '',
    }),
    eSummary: vi.fn().mockResolvedValue({}),
    eFetch: vi.fn().mockImplementation(async (params: { db?: string } = {}) => {
      if (params.db === 'pmc') return [{ 'pmc-articleset': [] }];
      return { PubmedArticleSet: MIXED_ARTICLE_SET };
    }),
    eLink: vi.fn().mockResolvedValue({ eLinkResult: [{}] }),
    eSpell: vi.fn().mockResolvedValue({
      original: '',
      corrected: '',
      hasSuggestion: false,
    }),
    eInfo: vi.fn().mockResolvedValue({}),
    eCitMatch: vi.fn().mockResolvedValue([]),
    idConvert: vi.fn().mockResolvedValue([]),
  };
}

/** Default fuzz options — pinned seed, modest run counts, fits within a 30s suite budget. */
export const FUZZ_OPTIONS = {
  numRuns: 50,
  numAdversarial: 30,
  seed: 42,
  timeout: 5000,
} as const;

interface FuzzOptions {
  /**
   * Coerce a Phase 1 arbitrary into an input the tool accepts, for a tool whose
   * accepted shape is narrower than its Zod schema can express — a per-element
   * format that depends on a sibling field, say. Without it the valid-input
   * phase degenerates: every generated input is rejected before the handler
   * runs, and the phase asserts nothing about the handler at all.
   *
   * Phase 1 and the aborted-signal phase only. The adversarial phases keep
   * their raw arbitraries — coercing those is the opposite of their purpose.
   */
  mapInput?: (raw: unknown) => unknown;
  numAdversarial?: number;
  numRuns?: number;
  seed?: number;
  timeout?: number;
}

function withTimeout<T>(promise: Promise<T> | T, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout after ${ms}ms`)), ms);
    Promise.resolve(promise).then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

/**
 * True when the thrown value is a failure the tool declares in its own error
 * contract — an input the tool rejects on purpose, not one it crashed on. The
 * arbitraries generate blank and degenerate strings freely, so a tool that
 * validates its input beyond what Zod expresses would otherwise have its
 * correct rejection reported as a crash.
 */
function isDeclaredFailure(def: AnyToolDefinition, err: unknown): boolean {
  if (!(err instanceof McpError)) return false;
  const { reason } = (err.data ?? {}) as { reason?: unknown };
  return def.errors?.some((entry) => entry.reason === reason) ?? false;
}

function checkErrorLeaks(text: string): boolean {
  return (
    /\bat\s+\S+\s+\(/.test(text) ||
    /node_modules/.test(text) ||
    /process\.env/.test(text) ||
    /\/Users\//.test(text) ||
    /\/home\//.test(text) ||
    /[A-Za-z]:\\/.test(text)
  );
}

/**
 * Run fuzz coverage against a tool definition. Like the framework's `fuzzTool`
 * but Phase 1 pre-parses generated inputs through `def.input.safeParse()` —
 * rejected arbitraries are skipped (Zod did its job), and successful parses
 * carry resolved defaults into the handler. This matches what production
 * sees at the call boundary.
 *
 * Phases 2 and 3 already pre-parse via the framework's adversarial path; we
 * inline the same logic here so we own the full report.
 */
export async function fuzzToolStrict(
  def: AnyToolDefinition,
  options: FuzzOptions = {},
): Promise<FuzzReport> {
  const numRuns = options.numRuns ?? 50;
  const numAdversarial = options.numAdversarial ?? 30;
  const timeoutMs = options.timeout ?? 5000;
  const seed = options.seed;
  const mapInput = options.mapInput ?? ((raw: unknown) => raw);

  const report: FuzzReport = {
    totalRuns: 0,
    crashes: [],
    leaks: [],
    prototypePollution: false,
  };

  await loadFc();
  const validArb = zodToArbitrary(def.input);
  const fcParams: { numRuns: number; seed?: number } = { numRuns };
  if (seed !== undefined) fcParams.seed = seed;

  // Phase 1 — valid inputs (pre-parsed through schema)
  await fc.assert(
    fc.asyncProperty(validArb, async (raw) => {
      report.totalRuns++;
      const parsed = def.input.safeParse(mapInput(raw));
      if (!parsed.success) return; // Arbitrary missed a constraint; Zod rejected. Skip.
      const ctx = createMockContext({ errors: def.errors });
      try {
        const result = await withTimeout(def.handler(parsed.data, ctx), timeoutMs);
        def.output.parse(result);
      } catch (err) {
        if (!isDeclaredFailure(def, err)) report.crashes.push({ input: parsed.data, error: err });
      }
    }),
    fcParams,
  );

  // Phase 2 — adversarial-shape inputs, must reject via schema or handle gracefully
  const advArb = adversarialObjectArbitrary(def.input);
  await fc.assert(
    fc.asyncProperty(advArb, async (raw) => {
      report.totalRuns++;
      const parsed = def.input.safeParse(raw);
      if (!parsed.success) return;
      const ctx = createMockContext({ errors: def.errors });
      try {
        const result = await withTimeout(def.handler(parsed.data, ctx), timeoutMs);
        def.output.parse(result);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (checkErrorLeaks(msg)) {
          report.leaks.push({ input: parsed.data, errorText: msg });
        }
      }
    }),
    { ...fcParams, numRuns: numAdversarial },
  );

  // Phase 3 — raw adversarial top-level shapes
  const rawAdversarial: unknown[] = [
    null,
    undefined,
    42,
    'string',
    true,
    [],
    { __proto__: { polluted: true } },
    { constructor: { prototype: { polluted: true } } },
  ];
  for (const raw of rawAdversarial) {
    report.totalRuns++;
    const parsed = def.input.safeParse(raw);
    if (!parsed.success) continue;
    const ctx = createMockContext();
    try {
      await withTimeout(def.handler(parsed.data, ctx), timeoutMs);
    } catch {
      // Expected
    }
  }

  // Phase 4 — aborted signal must not hang
  report.totalRuns++;
  try {
    const controller = new AbortController();
    controller.abort();
    const ctx = createMockContext({ signal: controller.signal, errors: def.errors });
    const sample = def.input.safeParse(mapInput(fc.sample(validArb, 1)[0]));
    if (sample.success) await withTimeout(def.handler(sample.data, ctx), timeoutMs);
  } catch {
    // Expected
  }

  // Prototype pollution check
  if (
    'polluted' in (Object.prototype as Record<string, unknown>) ||
    Object.keys(Object.prototype).some((k) => !['constructor', '__proto__'].includes(k))
  ) {
    report.prototypePollution = true;
    delete (Object.prototype as Record<string, unknown>).polluted;
  }

  return report;
}
