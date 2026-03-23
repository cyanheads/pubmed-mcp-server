/**
 * @fileoverview Tests for XML parsing helper functions.
 * @module tests/services/ncbi/parsing/xml-helpers.test
 */

import { describe, expect, it } from 'vitest';
import { ensureArray, getAttribute, getText } from '@/services/ncbi/parsing/xml-helpers.js';

describe('ensureArray', () => {
  it('wraps a single item in an array', () => {
    expect(ensureArray('hello')).toEqual(['hello']);
  });

  it('returns an array as-is', () => {
    expect(ensureArray([1, 2, 3])).toEqual([1, 2, 3]);
  });

  it('returns empty array for undefined', () => {
    expect(ensureArray(undefined)).toEqual([]);
  });

  it('returns empty array for null', () => {
    expect(ensureArray(null)).toEqual([]);
  });

  it('wraps objects', () => {
    const obj = { a: 1 };
    expect(ensureArray(obj)).toEqual([obj]);
  });
});

describe('getText', () => {
  it('returns a string element directly', () => {
    expect(getText('hello')).toBe('hello');
  });

  it('extracts #text from an object', () => {
    expect(getText({ '#text': 'value' })).toBe('value');
  });

  it('converts numeric #text to string', () => {
    expect(getText({ '#text': 42 })).toBe('42');
  });

  it('converts boolean #text to string', () => {
    expect(getText({ '#text': true })).toBe('true');
  });

  it('converts a direct number to string', () => {
    expect(getText(123)).toBe('123');
  });

  it('converts a direct boolean to string', () => {
    expect(getText(false)).toBe('false');
  });

  it('returns default empty string for null', () => {
    expect(getText(null)).toBe('');
  });

  it('returns default empty string for undefined', () => {
    expect(getText(undefined)).toBe('');
  });

  it('returns custom default for null', () => {
    expect(getText(null, 'fallback')).toBe('fallback');
  });

  it('returns empty string even when undefined is passed (JS default param)', () => {
    // The implementation's default param `= ''` triggers for explicit undefined
    expect(getText(null, undefined)).toBe('');
  });

  it('returns default for an object without #text', () => {
    expect(getText({ '@_attr': 'val' })).toBe('');
  });
});

describe('getAttribute', () => {
  it('extracts an attribute prefixed with @_', () => {
    expect(getAttribute({ '@_UI': 'D012345' }, 'UI')).toBe('D012345');
  });

  it('returns default empty string for missing attribute', () => {
    expect(getAttribute({ '@_UI': 'D012345' }, 'Name')).toBe('');
  });

  it('returns custom default for missing attribute', () => {
    expect(getAttribute({ '@_UI': 'D012345' }, 'Name', 'N/A')).toBe('N/A');
  });

  it('returns empty string even when undefined is passed (JS default param)', () => {
    expect(getAttribute({}, 'Missing', undefined)).toBe('');
  });

  it('converts boolean attribute to string', () => {
    expect(getAttribute({ '@_MajorTopicYN': true }, 'MajorTopicYN')).toBe('true');
  });

  it('converts number attribute to string', () => {
    expect(getAttribute({ '@_Version': 1 }, 'Version')).toBe('1');
  });

  it('returns default for non-object', () => {
    expect(getAttribute(null, 'X')).toBe('');
  });
});
