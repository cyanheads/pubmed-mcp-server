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
 * Because rejected arbitraries are skipped, a phase can run without ever
 * reaching the handler. The report counts what each phase actually drove
 * through the handler, so a caller can assert the run was not vacuous.
 *
 * @module tests/mcp-server/tools/definitions/_fuzz-helpers
 */

import { McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import {
  ADVERSARIAL_STRINGS,
  adversarialArbitrary,
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
import { PUBLISHED_ERRATUM_XML } from '../../../services/ncbi/parsing/_comments-corrections-fixtures.js';

/**
 * Two journal articles and one NCBI Bookshelf chapter, parsed through the
 * production response handler. An EFetch batch can return both kinds side by
 * side, and a mock carrying only `PubmedArticle` leaves the whole book branch —
 * parse, output schema, `format()` — invisible to the fuzz runner. (#114) The
 * second article carries a `CommentsCorrectionsList`, one entry with a PMID and
 * one without, so the linked-notice branch is fuzzed too. (#178)
 */
const MIXED_ARTICLE_SET = parseArticleSetXml(
  articleSetXml(JOURNAL_ARTICLE_XML, PUBLISHED_ERRATUM_XML, GENEREVIEWS_CHAPTER_XML),
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
 * articles), everything else returns a `PubmedArticleSet` holding two
 * `PubmedArticle`s and one `PubmedBookArticle`, the mixed shape a real EFetch
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

/**
 * Default fuzz options — pinned seed, modest run counts, fits within a 30s suite
 * budget. Most adversarial draws are rejected by the schema, so the adversarial
 * phase runs more of them than the valid phase to reach every handler.
 */
export const FUZZ_OPTIONS = {
  numRuns: 50,
  numAdversarial: 100,
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

/** What one phase drove through the handler. */
export interface PhaseCounts {
  /** Handler calls that returned output the tool's output schema accepts. */
  completed: number;
  /** Inputs that cleared the input schema and reached the handler. */
  handled: number;
}

/** The framework's report plus what each phase actually exercised. */
export interface StrictFuzzReport extends FuzzReport {
  /** Whether the aborted-signal probe reached the handler. */
  abortedHandled: boolean;
  /** Phase 2 — adversarial-shape inputs. */
  adversarial: PhaseCounts;
  /** Phase 1 — schema-generated inputs. */
  valid: PhaseCounts;
}

/** A handler call that outlived the per-run budget — a hang, never a declared failure. */
class FuzzTimeout extends Error {}

function withTimeout<T>(promise: Promise<T> | T, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new FuzzTimeout(`Timeout after ${ms}ms`)), ms);
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

/**
 * What a client sees of a thrown value: an `McpError`'s code, message and data
 * (the framework serializes all three onto the wire), or a plain error's message.
 */
function publicErrorText(err: unknown): string {
  if (err instanceof McpError) {
    try {
      return JSON.stringify({ code: err.code, message: err.message, data: err.data });
    } catch {
      return err.message;
    }
  }
  return err instanceof Error ? err.message : String(err);
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

/** Paths to every field, array element and nested field of `value`, outermost first. */
function valuePaths(value: unknown, prefix: (string | number)[] = []): (string | number)[][] {
  if (value === null || typeof value !== 'object') return [];
  const entries: [string | number, unknown][] = Array.isArray(value)
    ? value.map((item, i) => [i, item])
    : Object.entries(value);
  return entries.flatMap(([key, item]) => [
    [...prefix, key],
    ...valuePaths(item, [...prefix, key]),
  ]);
}

/** A deep copy of `value` with the value at `path` replaced. */
function withValueAt(value: unknown, path: (string | number)[], replacement: unknown): unknown {
  const copy = structuredClone(value);
  let node = copy as Record<string | number, unknown>;
  for (const key of path.slice(0, -1)) node = node[key] as Record<string | number, unknown>;
  node[path[path.length - 1] as string | number] = replacement;
  return copy;
}

/**
 * Run fuzz coverage against a tool definition. Like the framework's `fuzzTool`
 * but Phase 1 pre-parses generated inputs through `def.input.safeParse()` —
 * rejected arbitraries are skipped (Zod did its job), and successful parses
 * carry resolved defaults into the handler. This matches what production
 * sees at the call boundary.
 *
 * Every input that clears the schema, in every phase, is held to the same
 * contract: the handler returns output its schema accepts, or throws a failure
 * the tool declares — never a crash, a hang, or an error message leaking a
 * stack frame or a filesystem path.
 */
export async function fuzzToolStrict(
  def: AnyToolDefinition,
  options: FuzzOptions = {},
): Promise<StrictFuzzReport> {
  const numRuns = options.numRuns ?? 50;
  const numAdversarial = options.numAdversarial ?? 30;
  const timeoutMs = options.timeout ?? 5000;
  const seed = options.seed;
  const mapInput = options.mapInput ?? ((raw: unknown) => raw);

  const report: StrictFuzzReport = {
    totalRuns: 0,
    crashes: [],
    leaks: [],
    prototypePollution: false,
    valid: { handled: 0, completed: 0 },
    adversarial: { handled: 0, completed: 0 },
    abortedHandled: false,
  };

  /** One handler call against the contract above, tallied into `counts`. */
  const probe = async (
    input: Parameters<AnyToolDefinition['handler']>[0],
    ctx: ReturnType<typeof createMockContext>,
    counts?: PhaseCounts,
  ) => {
    if (counts) counts.handled++;
    try {
      const result = await withTimeout(def.handler(input, ctx), timeoutMs);
      def.output.parse(result);
      if (counts) counts.completed++;
    } catch (err) {
      if (!isDeclaredFailure(def, err)) report.crashes.push({ input, error: err });
      const text = publicErrorText(err);
      if (checkErrorLeaks(text)) report.leaks.push({ input, errorText: text });
    }
  };

  await loadFc();
  const validArb = zodToArbitrary(def.input);
  const fcParams: { numRuns: number; seed?: number } = { numRuns };
  if (seed !== undefined) fcParams.seed = seed;

  /** The first generated input the schema accepts: the base the single-field probes vary. */
  const accepted = fc
    .sample(validArb, { numRuns: 20, ...(seed !== undefined && { seed }) })
    .map((raw) => mapInput(raw))
    .find((input) => def.input.safeParse(input).success);

  // Phase 1 — valid inputs (pre-parsed through schema)
  await fc.assert(
    fc.asyncProperty(validArb, async (raw) => {
      report.totalRuns++;
      const parsed = def.input.safeParse(mapInput(raw));
      if (!parsed.success) return; // Arbitrary missed a constraint; Zod rejected. Skip.
      await probe(parsed.data, createMockContext({ errors: def.errors }), report.valid);
    }),
    fcParams,
  );

  /**
   * Phase 2 — adversarial-shape inputs, must reject via schema or handle
   * gracefully. The framework's arbitrary makes every field adversarial at once,
   * which a schema with any constrained field always rejects, so the handler
   * never sees one. Most draws instead swap one value of an accepted input — a
   * top-level field, an array element, a nested field — for an adversarial one,
   * which is what reaches a handler in practice: an injection string in a
   * free-text query, a traversal path in one ID of a batch.
   */
  const base = def.input.safeParse(accepted);
  const paths = base.success ? valuePaths(base.data) : [];
  const wholeObject = adversarialObjectArbitrary(def.input);
  const advArb =
    paths.length > 0
      ? fc.oneof(
          { arbitrary: wholeObject, weight: 1 },
          {
            arbitrary: fc
              .tuple(
                fc.constantFrom(...paths),
                fc.oneof(adversarialArbitrary(), fc.constantFrom(...ADVERSARIAL_STRINGS)),
              )
              .map(([path, value]) => withValueAt(base.data, path, value)),
            weight: 3,
          },
        )
      : wholeObject;
  await fc.assert(
    fc.asyncProperty(advArb, async (raw) => {
      report.totalRuns++;
      const parsed = def.input.safeParse(raw);
      if (!parsed.success) return;
      await probe(parsed.data, createMockContext({ errors: def.errors }), report.adversarial);
    }),
    { ...fcParams, numRuns: numAdversarial },
  );

  /**
   * Phase 3 — raw adversarial top-level shapes. The prototype-pollution probes
   * come from `JSON.parse`, which makes `__proto__` an own key the way a decoded
   * request body does; an object literal would set the prototype instead and
   * carry no such key for a merge to copy.
   */
  const rawAdversarial: unknown[] = [
    null,
    undefined,
    42,
    'string',
    true,
    [],
    JSON.parse('{"__proto__":{"polluted":true}}'),
    JSON.parse('{"constructor":{"prototype":{"polluted":true}}}'),
  ];
  for (const raw of rawAdversarial) {
    report.totalRuns++;
    const parsed = def.input.safeParse(raw);
    if (!parsed.success) continue;
    await probe(parsed.data, createMockContext({ errors: def.errors }));
  }

  /**
   * Phase 4 — an already-aborted signal. The handler may finish or throw, but
   * it must not hang: a timeout here is a crash.
   */
  report.totalRuns++;
  const controller = new AbortController();
  controller.abort();
  const sample = def.input.safeParse(accepted);
  if (sample.success) {
    report.abortedHandled = true;
    try {
      const ctx = createMockContext({ signal: controller.signal, errors: def.errors });
      await withTimeout(def.handler(sample.data, ctx), timeoutMs);
    } catch (err) {
      if (err instanceof FuzzTimeout) report.crashes.push({ input: sample.data, error: err });
    }
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
