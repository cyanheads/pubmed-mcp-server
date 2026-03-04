/**
 * @fileoverview Tests for the XML helper utilities used in NCBI parsing.
 * @module tests/services/ncbi/parsing/xml-helpers.test
 */
import { describe, expect, it } from 'vitest';

import { ensureArray, getAttribute, getText } from '@/services/ncbi/parsing/xml-helpers.js';

describe('ensureArray', () => {
  it('returns empty array for undefined', () => {
    expect(ensureArray(undefined)).toEqual([]);
  });

  it('returns empty array for null', () => {
    expect(ensureArray(null)).toEqual([]);
  });

  it('wraps a single non-array value in an array', () => {
    expect(ensureArray('hello')).toEqual(['hello']);
  });

  it('returns the same array when given an array', () => {
    const arr = [1, 2, 3];
    expect(ensureArray(arr)).toBe(arr);
  });

  it('returns empty array when given an empty array', () => {
    expect(ensureArray([])).toEqual([]);
  });

  it('wraps a single object value in an array', () => {
    const obj = { key: 'val' };
    expect(ensureArray(obj)).toEqual([obj]);
  });

  it('wraps a single number value in an array', () => {
    expect(ensureArray(42)).toEqual([42]);
  });
});

describe('getText', () => {
  it('returns default value for undefined', () => {
    expect(getText(undefined)).toBe('');
  });

  it('returns default value for null', () => {
    expect(getText(null)).toBe('');
  });

  it('returns the string as-is', () => {
    expect(getText('hello')).toBe('hello');
  });

  it('converts a number to string', () => {
    expect(getText(42)).toBe('42');
  });

  it('converts a boolean true to string', () => {
    expect(getText(true)).toBe('true');
  });

  it('converts a boolean false to string', () => {
    expect(getText(false)).toBe('false');
  });

  it('extracts string from object with #text property', () => {
    expect(getText({ '#text': 'extracted' })).toBe('extracted');
  });

  it('converts number #text to string', () => {
    expect(getText({ '#text': 99 })).toBe('99');
  });

  it('converts boolean #text to string', () => {
    expect(getText({ '#text': true })).toBe('true');
  });

  it('returns default value for object without #text', () => {
    expect(getText({ other: 'field' })).toBe('');
  });

  it('returns custom default value for undefined', () => {
    expect(getText(undefined, 'N/A')).toBe('N/A');
  });

  it('returns custom default value for object without #text', () => {
    expect(getText({ other: 'field' }, 'fallback')).toBe('fallback');
  });

  it('returns custom default value for null', () => {
    expect(getText(null, 'missing')).toBe('missing');
  });
});

describe('getAttribute', () => {
  it('extracts a string attribute value', () => {
    expect(getAttribute({ '@_UI': 'D001249' }, 'UI')).toBe('D001249');
  });

  it('converts a number attribute to string', () => {
    expect(getAttribute({ '@_Count': 5 }, 'Count')).toBe('5');
  });

  it('converts a boolean attribute to string', () => {
    expect(getAttribute({ '@_MajorTopicYN': true }, 'MajorTopicYN')).toBe('true');
  });

  it('returns default value when attribute is missing', () => {
    expect(getAttribute({ '@_Other': 'val' }, 'UI')).toBe('');
  });

  it('returns default value for null element', () => {
    expect(getAttribute(null, 'UI')).toBe('');
  });

  it('returns default value for a non-object element', () => {
    expect(getAttribute('string-element', 'UI')).toBe('');
  });

  it('returns custom default value when attribute is missing', () => {
    expect(getAttribute({}, 'UI', 'N/A')).toBe('N/A');
  });

  it('returns custom default value for null element', () => {
    expect(getAttribute(null, 'UI', 'none')).toBe('none');
  });

  it('returns default value for undefined element', () => {
    expect(getAttribute(undefined, 'UI')).toBe('');
  });

  it('returns default value when attribute value is undefined', () => {
    expect(getAttribute({ '@_UI': undefined }, 'UI')).toBe('');
  });
});
