/**
 * @fileoverview Tests for the canonical service-layer error contracts and the
 * `recoveryFor` helper that bridges service-layer throws to the wire payload.
 * @module tests/services/error-contracts.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { describe, expect, it } from 'vitest';

import {
  EUROPEPMC_SERVICE_ERRORS,
  NCBI_ID_INPUT_ERRORS,
  NCBI_QUERY_INPUT_ERRORS,
  NCBI_SERVICE_ERRORS,
  OPENALEX_SERVICE_ERRORS,
  recoveryFor,
  UNPAYWALL_SERVICE_ERRORS,
} from '@/services/error-contracts.js';

describe('contract provenance', () => {
  it("marks every service-layer entry thrownBy: 'service'", () => {
    for (const entry of [
      ...NCBI_SERVICE_ERRORS,
      ...UNPAYWALL_SERVICE_ERRORS,
      ...EUROPEPMC_SERVICE_ERRORS,
      ...OPENALEX_SERVICE_ERRORS,
    ]) {
      expect((entry as { thrownBy?: string }).thrownBy, entry.reason).toBe('service');
    }
  });

  it('leaves the handler-thrown input rejections unmarked', () => {
    for (const entry of [...NCBI_QUERY_INPUT_ERRORS, ...NCBI_ID_INPUT_ERRORS]) {
      expect((entry as { thrownBy?: string }).thrownBy, entry.reason).toBeUndefined();
    }
  });
});

describe('NCBI_SERVICE_ERRORS', () => {
  it('declares the expected reasons', () => {
    const reasons = NCBI_SERVICE_ERRORS.map((e) => e.reason).sort();
    expect(reasons).toEqual(
      [
        'ncbi_deadline_exceeded',
        'ncbi_invalid_response',
        'ncbi_resource_not_found',
        'ncbi_unreachable',
        'queue_full',
      ].sort(),
    );
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

describe('UNPAYWALL_SERVICE_ERRORS', () => {
  it('declares the expected reasons', () => {
    const reasons = UNPAYWALL_SERVICE_ERRORS.map((e) => e.reason);
    expect(reasons).toEqual(['unpaywall_unreachable']);
  });

  it('every entry has a recovery hint of at least 5 words', () => {
    for (const entry of UNPAYWALL_SERVICE_ERRORS) {
      const wordCount = entry.recovery.trim().split(/\s+/).length;
      expect(wordCount, `recovery for ${entry.reason}`).toBeGreaterThanOrEqual(5);
    }
  });
});

describe('recoveryFor', () => {
  it('returns the contract recovery hint for every NCBI reason', () => {
    for (const entry of NCBI_SERVICE_ERRORS) {
      expect(recoveryFor(entry.reason)).toEqual({ recovery: { hint: entry.recovery } });
    }
  });

  it('returns the contract recovery hint for every Unpaywall reason', () => {
    for (const entry of UNPAYWALL_SERVICE_ERRORS) {
      expect(recoveryFor(entry.reason)).toEqual({ recovery: { hint: entry.recovery } });
    }
  });

  it('throws when the reason union and the recovery map drift apart', () => {
    expect(() => recoveryFor('not_a_real_reason' as never)).toThrow(/no recovery hint registered/);
  });

  it('result is spread-safe — adds recovery.hint when reason is known', () => {
    const data = { endpoint: 'esearch', ...recoveryFor('queue_full') };
    expect(data).toMatchObject({
      endpoint: 'esearch',
      recovery: { hint: expect.stringContaining('retryAfter') },
    });
  });
});
