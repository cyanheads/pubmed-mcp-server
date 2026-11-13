/**
 * @fileoverview Tests for the identifier schemas and normalizers shared by the
 * tool definitions: the PMID normalizer (#161), the DOI schema the DOI-taking
 * tools validate with, and the DOI link and `doi:` reading (`normalizeDoi`, from
 * `src/services/doi.ts`) that `doiInputSchema` applies before it (#299).
 * @module tests/mcp-server/tools/definitions/_schemas.test
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { cpuMsPerCall } from '../../../_helpers.js';

const schemas = await import('@/mcp-server/tools/definitions/_schemas.js');
const { normalizeDoi } = await import('@/services/doi.js');

/** The pattern `doiStringSchema` advertises, held here as an independent fact. */
const DOI_PATTERN = /^10\.[^\s,]+\/[^\s,]+$/;

const DOI_MESSAGE =
  'DOI must start with "10." and contain a "/" (e.g. "10.1093/nar/gks1195"). Remove any whitespace or commas — provide each DOI separately.';

/**
 * Doubling from 5k to 320k characters, each size checked against `expected` and
 * an absolute bound before the next one runs, with the 5k baseline timed again
 * beside it so a core switch between readings cannot skew the ratio. Linear work
 * grows 64× across the span; the least growth over the baselines read beside
 * each size must stay under 256.
 */
function expectLinear(
  build: (n: number) => string,
  run: (value: string) => unknown,
  expected: unknown,
) {
  const base = build(5_000);
  const baselines: number[] = [];
  let largest = 0;
  for (let n = 5_000; n <= 320_000; n *= 2) {
    const value = build(n);
    expect(run(value)).toEqual(expected);
    baselines.push(cpuMsPerCall(5_000, () => run(base)));
    largest = cpuMsPerCall(n, () => run(value));
    expect(largest).toBeLessThan(10);
  }
  expect(largest / Math.max(...baselines, 0.0005)).toBeLessThan(256);
}

describe('doiStringSchema', () => {
  it.each([
    '10.1093/nar/gks1195',
    '10.1002/(SICI)1097-4636(199706)35:4<449::AID-JBM5>3.0.CO;2-H',
    '10.5555/doi:inside',
    '10.1093/nar/gks1195.',
    '10.1//',
    '10.a/b',
  ])('accepts %s', (value) => {
    expect(schemas.doiStringSchema.safeParse(value)).toEqual({ success: true, data: value });
  });

  it.each([
    'doi:10.1093/nar/gks1195',
    '11.1093/nar/gks1195',
    '10.1093',
    '10./x',
    '10.1/',
    '10.1093/nar,gks1195',
    '10.1093/nar gks1195',
    ' 10.1093/nar/gks1195',
    '10.1093/nar/gks1195 ',
    '10.1093%2Fnar%2Fgks1195',
    '',
  ])('rejects %j with the regex issue it has always raised', (value) => {
    const result = schemas.doiStringSchema.safeParse(value);
    expect(result.success).toBe(false);
    expect(result.error?.issues).toStrictEqual([
      {
        origin: 'string',
        code: 'invalid_format',
        format: 'regex',
        pattern: String(DOI_PATTERN),
        path: [],
        message: DOI_MESSAGE,
      },
    ]);
  });

  it('accepts exactly the strings its advertised pattern matches', () => {
    // Seeded differential over short strings built from the characters the
    // pattern branches on, after each prefix that reaches a different branch.
    const unit = fc.constantFrom('1', '0', '.', '/', ',', ' ', '\t', '\n', ' ', ' ', 'a', ':', '%');
    const prefix = fc.constantFrom('', '1', '10', '10.', '10./', '10.1', '10.1/', 'doi:10.');
    fc.assert(
      fc.property(prefix, fc.string({ unit, maxLength: 10 }), (head, tail) => {
        const value = head + tail;
        expect(schemas.doiStringSchema.safeParse(value).success).toBe(DOI_PATTERN.test(value));
      }),
      { seed: 299, numRuns: 20_000 },
    );
  });

  it('advertises the pattern as its JSON Schema', () => {
    expect(
      schemas.doiStringSchema['~standard'].jsonSchema.input({ target: 'draft-2020-12' }),
    ).toStrictEqual({
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'string',
      pattern: DOI_PATTERN.source,
    });
  });

  describe('linear time on caller-sized input', () => {
    it.each<[string, (n: number) => string, boolean]>([
      ['case 1', (n) => `10.${'/'.repeat(n)} `, false],
      ['case 2', (n) => `10.${'/'.repeat(n)},`, false],
      ['case 3', (n) => `10.${'a/'.repeat(n / 2)} `, false],
      ['case 4', (n) => `10.${'/'.repeat(n)}`, true],
      ['case 5', (n) => `10.${'1'.repeat(n)}/1`, true],
      ['case 6', (n) => `10.${'/x'.repeat(n / 2)}\ny`, false],
      ['case 7', (n) => `10./${'  \r\n'.repeat(n / 4)}`, false],
    ])(
      'stays linear (%s)',
      (_label, build, valid) => {
        expectLinear(build, (value) => schemas.doiStringSchema.safeParse(value).success, valid);
      },
      0,
    );
  });
});

describe('normalizePmid', () => {
  it.each([
    ['00000001', '1'],
    ['0023193287', '23193287'],
    ['00000000', '0'],
    ['0', '0'],
    ['1', '1'],
    ['10', '10'],
    ['100', '100'],
    ['23193287', '23193287'],
  ])('normalizes %s to %s', (input, expected) => {
    expect(schemas.normalizePmid(input)).toBe(expected);
  });

  it('returns the canonical decimal form of the number any accepted PMID spells', () => {
    fc.assert(
      fc.property(fc.stringMatching(/^\d{1,30}$/), (pmid) => {
        expect(schemas.pmidStringSchema.safeParse(pmid).success).toBe(true);
        const normalized = schemas.normalizePmid(pmid);
        expect(normalized).toMatch(/^(0|[1-9]\d*)$/);
        expect(normalized).toBe(BigInt(pmid).toString());
        expect(schemas.normalizePmid(normalized)).toBe(normalized);
      }),
      { seed: 161 },
    );
  });
});

describe('normalizeDoi (#299)', () => {
  const BARE = '10.1093/nar/gks1195';

  it.each([
    ['https://doi.org/10.1093/nar/gks1195', BARE],
    ['http://doi.org/10.1093/nar/gks1195', BARE],
    ['https://dx.doi.org/10.1093/nar/gks1195', BARE],
    ['http://dx.doi.org/10.1093/nar/gks1195', BARE],
    ['HTTPS://DOI.ORG/10.1093/nar/gks1195', BARE],
    ['https://DX.Doi.org/10.1093/NAR/gks1195', '10.1093/NAR/gks1195'],
    ['https://doi.org/10.1093%2Fnar%2Fgks1195', BARE],
    ['https://doi.org/10.1093/nar/gks1195?utm_source=x', BARE],
    ['https://doi.org/10.1093/nar/gks1195#sec1', BARE],
    ['https://doi.org/10.1093/nar/gks1195?a=1#b?c', BARE],
    [
      'https://doi.org/10.1002/(SICI)1097-4636(199706)35:4%3C449::AID-JBM5%3E3.0.CO;2-H',
      '10.1002/(SICI)1097-4636(199706)35:4<449::AID-JBM5>3.0.CO;2-H',
    ],
    ['https://doi.org/10.1000/a/../b', '10.1000/a/../b'],
    ['doi:10.1093/nar/gks1195', BARE],
    ['DOI: 10.1093/nar/gks1195', BARE],
    ['Doi:  10.1093/nar/gks1195', BARE],
    ['doi:\t10.1093/nar/gks1195', BARE],
  ])('reads %s as %s', (value, bare) => {
    expect(normalizeDoi(value)).toBe(bare);
    expect(schemas.doiInputSchema.safeParse(value)).toEqual({ success: true, data: bare });
  });

  it.each([
    // A value starting `10.` is never rewritten, valid or not.
    BARE,
    '10.1093/NAR/GKS1195',
    '10.5555/doi:inside',
    '10.5555/http://inside',
    '10.1093/nar/gks1195.',
    '10.1093%2Fnar%2Fgks1195',
    // Nothing else reduces to a DOI.
    'https://example.org/10.1093/nar/gks1195',
    'https://www.doi.org/10.1093/nar/gks1195',
    'https://doi.org.example.com/10.1093/nar/gks1195',
    'ftp://doi.org/10.1093/nar/gks1195',
    'https:/doi.org/10.1093/nar/gks1195',
    'urn:doi:10.1093/nar/gks1195',
    'https://doi.org/doi:10.1093/nar/gks1195',
    'doi:https://doi.org/10.1093/nar/gks1195',
    'doi:doi:10.1093/nar/gks1195',
    'doi:11.1/x',
    'doi:',
    'doi:10.1093',
    'https://doi.org/',
    'https://doi.org/?x=10.1/y',
    'https://doi.org/%E0%A4%A',
    'https://doi.org/10.1093/nar%2Cgks1195',
    'https://doi.org/10.1093/nar%20gks1195',
    'https://doi.org/10.1093/nar gks1195',
    // No surrounding whitespace is trimmed.
    ' doi:10.1093/nar/gks1195',
    'doi:10.1093/nar/gks1195 ',
    ' https://doi.org/10.1093/nar/gks1195',
    'https://doi.org/10.1093/nar/gks1195\n',
  ])('leaves %j as sent', (value) => {
    expect(normalizeDoi(value)).toBe(value);
  });

  it('rejects what it leaves as sent with the plain DOI rejection, under the value sent', () => {
    const result = schemas.doiInputSchema.safeParse('https://doi.org/10.1093/nar%2Cgks1195');
    expect(result.success).toBe(false);
    expect(result.error?.issues).toStrictEqual([
      {
        origin: 'string',
        code: 'invalid_format',
        format: 'regex',
        pattern: String(DOI_PATTERN),
        path: [],
        message: DOI_MESSAGE,
      },
    ]);
  });

  it('returns either the value as sent or a DOI the schema accepts, and is idempotent', () => {
    const unit = fc.constantFrom(
      'https://',
      'http://',
      'dx.',
      'doi.org/',
      'doi:',
      'DOI: ',
      '10.',
      '1',
      '/',
      '%2F',
      '%2C',
      '%',
      '?',
      '#',
      ' ',
      ',',
      'a',
    );
    fc.assert(
      fc.property(fc.string({ unit, maxLength: 8 }), (value) => {
        const read = normalizeDoi(value);
        if (read !== value) expect(schemas.doiStringSchema.safeParse(read).success).toBe(true);
        expect(normalizeDoi(read)).toBe(read);
      }),
      { seed: 299, numRuns: 20_000 },
    );
  });

  it('leaves the advertised JSON Schema the plain DOI pattern', () => {
    const target = { target: 'draft-2020-12' } as const;
    expect(schemas.doiInputSchema['~standard'].jsonSchema.input(target)).toStrictEqual(
      schemas.doiStringSchema['~standard'].jsonSchema.input(target),
    );
  });

  describe('linear time on caller-sized input', () => {
    it.each<[string, (n: number) => string, boolean]>([
      ['case 1', (n) => `https://doi.org/10.1/${'%2F'.repeat(n / 3)}`, true],
      ['case 2', (n) => `https://doi.org/${'/'.repeat(n)} `, false],
      ['case 3', (n) => `https://doi.org/10.1/${'%'.repeat(n)}`, false],
      ['case 4', (n) => `https://doi.org/10.1/x${'?'.repeat(n)}`, true],
      ['case 5', (n) => `doi:${' '.repeat(n)}10.1/x`, true],
      ['case 6', (n) => `doi:10.${'/'.repeat(n)} `, false],
      ['case 7', (n) => `doi:10.${'1'.repeat(n)}/1`, true],
      ['case 8', (n) => `doi:10.${'/x'.repeat(n / 2)}\ny`, false],
      ['case 9', (n) => `doi:${'  \r\n'.repeat(n / 4)}`, false],
    ])(
      'stays linear (%s)',
      (_label, build, valid) => {
        expectLinear(build, (value) => schemas.doiInputSchema.safeParse(value).success, valid);
      },
      0,
    );
  });
});
