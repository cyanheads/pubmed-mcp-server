/**
 * @fileoverview Tests for the canonical service-layer error contracts.
 * @module tests/services/error-contracts.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { describe, expect, it } from 'vitest';

import {
  EUROPEPMC_SERVICE_ERRORS,
  ICITE_SERVICE_ERRORS,
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
      ...ICITE_SERVICE_ERRORS,
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
        'ncbi_timed_out',
        'ncbi_unreachable',
        'queue_full',
      ].sort(),
    );
  });

  /**
   * A loop that stops on a Timeout without its deadline firing is told apart from an
   * expiry, which keeps `ncbi_deadline_exceeded`. NCBI's client reports a request its
   * per-request timeout ended as `ncbi_unreachable`, so this reason never claims it.
   */
  it('declares ncbi_timed_out as a retryable Timeout the last attempt ended on, whichever way the loop stopped', () => {
    const entry = NCBI_SERVICE_ERRORS.find((e) => e.reason === 'ncbi_timed_out');
    expect(entry).toMatchObject({
      code: JsonRpcErrorCode.Timeout,
      retryable: true,
      thrownBy: 'service',
    });
    expect(entry?.when).toMatch(/HTTP 504/);
    expect(entry?.when).toMatch(/retries ran out/);
    expect(entry?.when).toMatch(/next backoff would overrun the total deadline/);
    expect(entry?.when).toMatch(/Retry-After NCBI named outlasts the time left/);
    expect(entry?.when).not.toMatch(/per-request timeout/);
    expect(entry?.recovery).toMatch(/^Retry after a brief delay/);
  });

  it('names the Retry-After exit and the per-request timeout under ncbi_unreachable', () => {
    const entry = NCBI_SERVICE_ERRORS.find((e) => e.reason === 'ncbi_unreachable');
    expect(entry?.when).toMatch(/Retry-After NCBI named outlasts the time left/);
    expect(entry?.when).toMatch(/per-request timeout/);
    expect(entry?.when).toMatch(/other than 501 and 504/);
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

  it('describes ncbi_deadline_exceeded as an expiry wherever the timer lands, under either deadline', () => {
    const entry = NCBI_SERVICE_ERRORS.find((e) => e.reason === 'ncbi_deadline_exceeded');
    expect(entry?.when).toMatch(
      /mid-request, while queued, during a retry backoff, or before the next request could be sent/,
    );
    expect(entry?.when).toMatch(
      /the total NCBI request deadline, or the time the tool call had left/,
    );
    expect(entry?.when).toMatch(/`deadlineMs` names its length/);
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

describe('ICITE_SERVICE_ERRORS', () => {
  const entryFor = (reason: string) => ICITE_SERVICE_ERRORS.find((e) => e.reason === reason);

  it('declares the reasons the iCite service stamps, the unrequested record alone not retryable', () => {
    expect(
      ICITE_SERVICE_ERRORS.map(({ reason, code, retryable }) => ({ reason, code, retryable })),
    ).toEqual([
      {
        reason: 'icite_unreachable',
        code: JsonRpcErrorCode.ServiceUnavailable,
        retryable: true,
      },
      { reason: 'icite_deadline_exceeded', code: JsonRpcErrorCode.Timeout, retryable: true },
      { reason: 'icite_timed_out', code: JsonRpcErrorCode.Timeout, retryable: true },
      {
        reason: 'icite_invalid_response',
        code: JsonRpcErrorCode.ServiceUnavailable,
        retryable: true,
      },
      {
        reason: 'icite_unrequested_record',
        code: JsonRpcErrorCode.ServiceUnavailable,
        retryable: false,
      },
    ]);
  });

  it('keeps icite_invalid_response to the unparseable body and its retry hint', () => {
    const entry = entryFor('icite_invalid_response');
    expect(entry?.when).toMatch(/not its JSON record list on the last attempt/);
    expect(entry?.when).not.toMatch(/did not request/);
    expect(entry?.recovery).toMatch(/^Retry the request after a brief delay/);
    expect(entry?.recovery).not.toMatch(/mismatch/);
  });

  /**
   * iCite gives the same answer to the same PMID list every time, so resending it
   * cannot succeed; smaller batches isolate the PMID it misreads. (#278)
   */
  it('declares icite_unrequested_record with a recovery that does not say to retry', () => {
    const entry = entryFor('icite_unrequested_record');
    expect(entry?.when).toMatch(/a record for a PMID the call did not request/);
    expect(entry?.when).toMatch(/not a PMID/);
    expect(entry?.recovery).not.toMatch(/retry/i);
    expect(entry?.recovery).toMatch(/same PMIDs/);
    expect(entry?.recovery).toMatch(/smaller batches/);
  });

  /**
   * A deadline that fired is told apart from attempts that ended on a timeout, and
   * `deadlineMs` names the deadline that fired. (#310)
   */
  it('declares icite_deadline_exceeded as the expiry wherever it lands, naming whose deadline deadlineMs is', () => {
    const entry = entryFor('icite_deadline_exceeded');
    expect(entry?.when).toMatch(
      /mid-request, during a retry backoff, or before the request was sent/,
    );
    expect(entry?.when).toMatch(/`deadlineMs`/);
    expect(entry?.when).toMatch(/the tool call's own, or iCite's total deadline/);
    expect(entry?.recovery).toMatch(/^Retry after a brief delay/);
  });

  it('declares icite_timed_out as the last attempt timing out, whichever way the loop stopped', () => {
    const entry = entryFor('icite_timed_out');
    expect(entry?.when).toMatch(/per-request timeout/);
    expect(entry?.when).toMatch(/HTTP 504/);
    expect(entry?.when).toMatch(/retries ran out, or the next backoff would overrun the deadline/);
    expect(entry?.recovery).toMatch(/^Retry after a brief delay/);
  });

  it('describes icite_unreachable as every attempt failing, whichever way the loop stopped', () => {
    const entry = entryFor('icite_unreachable');
    expect(entry?.when).toMatch(/failed on every attempt the retry budget allowed/);
    expect(entry?.when).toMatch(/retries ran out, or the next backoff would overrun the deadline/);
  });

  it('every entry has a recovery hint of at least 5 words (lint-enforced)', () => {
    for (const entry of ICITE_SERVICE_ERRORS) {
      const wordCount = entry.recovery.trim().split(/\s+/).length;
      expect(wordCount, `recovery for ${entry.reason}`).toBeGreaterThanOrEqual(5);
    }
  });
});

describe('OPENALEX_SERVICE_ERRORS', () => {
  const entryFor = (reason: string) => OPENALEX_SERVICE_ERRORS.find((e) => e.reason === reason);

  it('keeps every reason with its code and retryability', () => {
    expect(
      OPENALEX_SERVICE_ERRORS.map(({ reason, code, retryable }) => ({ reason, code, retryable })),
    ).toEqual([
      {
        reason: 'openalex_unreachable',
        code: JsonRpcErrorCode.ServiceUnavailable,
        retryable: true,
      },
      { reason: 'openalex_deadline_exceeded', code: JsonRpcErrorCode.Timeout, retryable: true },
      {
        reason: 'openalex_invalid_response',
        code: JsonRpcErrorCode.ServiceUnavailable,
        retryable: true,
      },
    ]);
  });

  /** One deadline bounds every request an OpenAlex call makes; `deadlineMs` names it. (#310) */
  it('declares openalex_deadline_exceeded as the expiry wherever it lands, naming whose deadline deadlineMs is', () => {
    const entry = entryFor('openalex_deadline_exceeded');
    expect(entry?.when).toMatch(
      /mid-request, during a retry backoff, or before a request was sent/,
    );
    expect(entry?.when).toMatch(/every request the call makes/);
    expect(entry?.when).toMatch(/the tool call's own, or OpenAlex's total deadline/);
    expect(entry?.recovery).toMatch(/^Retry after a brief delay/);
  });

  it('describes openalex_unreachable by every way the attempts can stop', () => {
    const entry = entryFor('openalex_unreachable');
    expect(entry?.when).toMatch(/on every attempt the retry budget allowed/);
    expect(entry?.when).toMatch(/next backoff would overrun the deadline/);
    expect(entry?.when).toMatch(/30-second backoff cap/);
  });

  it('every entry has a recovery hint of at least 5 words (lint-enforced)', () => {
    for (const entry of OPENALEX_SERVICE_ERRORS) {
      const wordCount = entry.recovery.trim().split(/\s+/).length;
      expect(wordCount, `recovery for ${entry.reason}`).toBeGreaterThanOrEqual(5);
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

  /** One deadline bounds each call; its expiry is worth retrying, unlike bad input. (#305) */
  it('declares europepmc_deadline_exceeded as a retryable Timeout wherever the timer lands', () => {
    const entry = EUROPEPMC_SERVICE_ERRORS.find((e) => e.reason === 'europepmc_deadline_exceeded');
    expect(entry).toMatchObject({
      code: JsonRpcErrorCode.Timeout,
      retryable: true,
      thrownBy: 'service',
    });
    expect(entry?.when).toMatch(/mid-request, while queued, or during a retry backoff/);
    expect(entry?.recovery).toMatch(/^Retry after a brief delay/);
  });

  /**
   * A call runs under Europe PMC's own deadline or the tool call's, whichever ends
   * first, and one started with none of the tool call's left sends nothing; the
   * text holds for every way it ends. (#310)
   */
  it('describes europepmc_deadline_exceeded for both deadlines a call can run under', () => {
    const entry = EUROPEPMC_SERVICE_ERRORS.find((e) => e.reason === 'europepmc_deadline_exceeded');
    expect(entry?.when).toMatch(/Europe PMC's own total request deadline/);
    expect(entry?.when).toMatch(/the tool call's deadline/);
    expect(entry?.when).toMatch(/no request was sent/);
    expect(entry?.when).toContain('`deadlineMs`');
    expect(entry?.when).not.toMatch(/^The total Europe PMC request deadline/);
  });

  /**
   * A 5xx whose Retry-After the loop will not wait out ends the call unretried,
   * under the reason declared for its code. (#310)
   */
  it.each([
    ['europepmc_unreachable', /HTTP 5xx other than a 504 whose Retry-After/],
    ['europepmc_timed_out', /HTTP 504 whose Retry-After/],
  ])(
    'describes %s as also ending on a Retry-After the call will not wait out',
    (reason, retryAfter) => {
      const entry = EUROPEPMC_SERVICE_ERRORS.find((e) => e.reason === reason);
      expect(entry?.when).toMatch(retryAfter);
      expect(entry?.when).toMatch(/outlasts the time left or the 30-second backoff cap/);
      expect(entry?.when).toMatch(/without retrying/);
    },
  );

  it('keeps every reason with its code and retryability', () => {
    expect(
      EUROPEPMC_SERVICE_ERRORS.map(({ reason, code, retryable }) => ({ reason, code, retryable })),
    ).toEqual([
      {
        reason: 'europepmc_unreachable',
        code: JsonRpcErrorCode.ServiceUnavailable,
        retryable: true,
      },
      { reason: 'europepmc_deadline_exceeded', code: JsonRpcErrorCode.Timeout, retryable: true },
      { reason: 'europepmc_timed_out', code: JsonRpcErrorCode.Timeout, retryable: true },
      { reason: 'europepmc_rate_limited', code: JsonRpcErrorCode.RateLimited, retryable: true },
      {
        reason: 'europepmc_invalid_response',
        code: JsonRpcErrorCode.SerializationError,
        retryable: true,
      },
      {
        reason: 'europepmc_invalid_input',
        code: JsonRpcErrorCode.ValidationError,
        retryable: false,
      },
    ]);
  });

  /**
   * A Timeout that ends the loop — retries spent, or the next backoff would not
   * fit — is told apart from a deadline that fired, which keeps its own reason.
   * Both timeout sources are named. (#315)
   */
  it('describes europepmc_timed_out as the last attempt timing out, whichever way the loop stopped', () => {
    const entry = EUROPEPMC_SERVICE_ERRORS.find((e) => e.reason === 'europepmc_timed_out');
    expect(entry?.thrownBy).toBe('service');
    expect(entry?.when).toMatch(/per-request timeout/);
    expect(entry?.when).toMatch(/HTTP 504/);
    expect(entry?.when).toMatch(/retries ran out/);
    expect(entry?.when).toMatch(/next backoff would overrun the total deadline/);
    expect(entry?.recovery).toMatch(/^Retry after a brief delay/);
  });

  /** A 429 names how long to wait; the hint says to honor it. (#315) */
  it('declares europepmc_rate_limited with a recovery that honors retryAfter', () => {
    const entry = EUROPEPMC_SERVICE_ERRORS.find((e) => e.reason === 'europepmc_rate_limited');
    expect(entry?.thrownBy).toBe('service');
    expect(entry?.when).toMatch(/HTTP 429/);
    expect(entry?.when).toMatch(/30-second backoff cap/);
    expect(entry?.when).toMatch(/outlasts the time left/);
    expect(entry?.recovery).toContain('`retryAfter`');
    expect(entry?.recovery).toMatch(/HTTP date/);
    expect(entry?.recovery).not.toMatch(/brief delay/);
  });

  it('every entry has a recovery hint of at least 5 words (lint-enforced)', () => {
    for (const entry of EUROPEPMC_SERVICE_ERRORS) {
      const wordCount = entry.recovery.trim().split(/\s+/).length;
      expect(wordCount, `recovery for ${entry.reason}`).toBeGreaterThanOrEqual(5);
    }
  });
});
