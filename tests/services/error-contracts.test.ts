/**
 * @fileoverview Tests for the canonical service-layer error contracts.
 * @module tests/services/error-contracts.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { describe, expect, it } from 'vitest';

import {
  EUROPEPMC_SERVICE_ERRORS,
  NCBI_ID_INPUT_ERRORS,
  NCBI_SERVICE_ERRORS,
  OPENALEX_SERVICE_ERRORS,
  QUERY_INPUT_ERRORS,
} from '@/services/error-contracts.js';

describe('contract provenance', () => {
  it("marks every service-layer entry thrownBy: 'service'", () => {
    for (const entry of [
      ...NCBI_SERVICE_ERRORS,
      ...EUROPEPMC_SERVICE_ERRORS,
      ...OPENALEX_SERVICE_ERRORS,
    ]) {
      expect((entry as { thrownBy?: string }).thrownBy, entry.reason).toBe('service');
    }
  });

  it('leaves the handler-thrown input rejections unmarked', () => {
    for (const entry of [...QUERY_INPUT_ERRORS, ...NCBI_ID_INPUT_ERRORS]) {
      expect((entry as { thrownBy?: string }).thrownBy, entry.reason).toBeUndefined();
    }
  });
});

describe('blank_query', () => {
  // Declared by pubmed_search_articles, pubmed_spell_check, pubmed_lookup_mesh,
  // and pubmed_europepmc_search, so its text has to hold for an upstream other
  // than NCBI. (#176)
  const entry = QUERY_INPUT_ERRORS.find((e) => e.reason === 'blank_query');

  it('names no single upstream in its when or recovery text', () => {
    expect(entry?.when).not.toMatch(/NCBI/);
    expect(entry?.recovery).not.toMatch(/NCBI/);
  });

  it('keeps the recovery hint the declaring tools already show', () => {
    expect(entry?.recovery).toMatch(/nonblank/i);
    expect(entry?.retryable).toBe(false);
    expect(entry?.code).toBe(JsonRpcErrorCode.ValidationError);
  });

  /**
   * Field tags and parentheses are sent as written; only the blank check
   * disregards them. And Europe PMC searches `<b></b>` as the word `b`, so the
   * text cannot say an upstream would receive a blank term.
   */
  it('describes what the check disregards without claiming what is sent upstream', () => {
    expect(entry?.when).not.toMatch(/before sending/i);
    expect(entry?.when).not.toMatch(/receive a blank term/i);
    expect(entry?.when).toMatch(/no search term/i);
    expect(entry?.when).toMatch(/invisible/i);
    expect(entry?.when).toMatch(/pubmed_europepmc_search/);
    expect(entry?.when).toContain('`<b></b>`');
  });
});

describe('NCBI_SERVICE_ERRORS', () => {
  it('declares the expected reasons', () => {
    const reasons = NCBI_SERVICE_ERRORS.map((e) => e.reason).sort();
    expect(reasons).toEqual(
      [
        'ncbi_deadline_exceeded',
        'ncbi_invalid_response',
        'ncbi_rate_limited',
        'ncbi_resource_not_found',
        'ncbi_unreachable',
        'queue_full',
      ].sort(),
    );
  });

  it('declares ncbi_rate_limited as a retryable RateLimited whose hint names the operator key', () => {
    const entry = NCBI_SERVICE_ERRORS.find((e) => e.reason === 'ncbi_rate_limited');
    expect(entry?.code).toBe(JsonRpcErrorCode.RateLimited);
    expect(entry?.retryable).toBe(true);
    expect(entry?.recovery).toContain('`retryAfter`');
    expect(entry?.recovery).toContain('NCBI_API_KEY');
    expect(entry?.recovery).toMatch(/operator setting/);
  });

  /**
   * A PMC ID Converter 429 reaches this reason too, and that request never
   * carries `api_key`, so the key's ceiling is scoped to E-utilities. And
   * `retryAfter` is the raw `Retry-After` header, which can be an HTTP date.
   */
  it('scopes the ncbi_rate_limited hint so it holds for the ID Converter too', () => {
    const entry = NCBI_SERVICE_ERRORS.find((e) => e.reason === 'ncbi_rate_limited');
    expect(entry?.recovery).toMatch(
      /E-utilities ceiling from about 3 to about 10 requests per second/,
    );
    expect(entry?.recovery).not.toMatch(/NCBI's ceiling/);
    expect(entry?.recovery).not.toMatch(/number of seconds in `retryAfter`/);
    expect(entry?.recovery).toMatch(/HTTP date/);
  });

  it('describes ncbi_unreachable as every attempt failing, whichever way the loop stopped', () => {
    const entry = NCBI_SERVICE_ERRORS.find((e) => e.reason === 'ncbi_unreachable');
    expect(entry?.when).toMatch(/failed on every attempt the retry budget allowed/);
    expect(entry?.when).toMatch(/next backoff would overrun the total deadline/);
    expect(entry?.recovery).toMatch(/^Retry after a brief delay/);
    expect(entry?.recovery).toMatch(/every attempt this call made/);
    expect(entry?.recovery).not.toMatch(/across all retry attempts/);
  });

  it('describes ncbi_deadline_exceeded as an expiry wherever the timer lands', () => {
    const entry = NCBI_SERVICE_ERRORS.find((e) => e.reason === 'ncbi_deadline_exceeded');
    expect(entry?.when).toMatch(/mid-request, while queued, or during a retry backoff/);
  });

  it('classifies ncbi_resource_not_found as non-retryable NotFound', () => {
    const entry = NCBI_SERVICE_ERRORS.find((e) => e.reason === 'ncbi_resource_not_found');
    expect(entry).toBeDefined();
    expect(entry?.code).toBe(JsonRpcErrorCode.NotFound);
    expect(entry?.retryable).toBe(false);
  });

  it('every entry has a recovery hint of at least 5 words (lint-enforced)', () => {
    for (const entry of NCBI_SERVICE_ERRORS) {
      const wordCount = entry.recovery.trim().split(/\s+/).length;
      expect(wordCount, `recovery for ${entry.reason}`).toBeGreaterThanOrEqual(5);
    }
  });

  it('every entry uses a real JsonRpcErrorCode', () => {
    const validCodes = new Set(Object.values(JsonRpcErrorCode));
    for (const entry of NCBI_SERVICE_ERRORS) {
      expect(validCodes, `code for ${entry.reason}`).toContain(entry.code);
    }
  });
});

describe('EUROPEPMC_SERVICE_ERRORS', () => {
  /**
   * The service blames the cursor when the last attempt draws the empty
   * envelope, whatever the earlier attempts drew — a 503 among them.
   */
  it('describes the empty-envelope cursor case as the last attempt, not every attempt', () => {
    const entry = EUROPEPMC_SERVICE_ERRORS.find((e) => e.reason === 'europepmc_invalid_input');
    expect(entry?.when).toMatch(/an empty response on the last attempt/);
    expect(entry?.when).not.toMatch(/on every attempt/);
  });
});
