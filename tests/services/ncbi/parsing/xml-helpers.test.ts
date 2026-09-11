/**
 * @fileoverview Tests for XML parsing helper functions.
 * @module tests/services/ncbi/parsing/xml-helpers.test
 */

import { describe, expect, it } from 'vitest';
import {
  ensureArray,
  getAttribute,
  getOptionalAttribute,
  getOptionalText,
  getText,
} from '@/services/ncbi/parsing/xml-helpers.js';

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

  it('returns default for an object without #text', () => {
    expect(getText({ '@_attr': 'val' })).toBe('');
  });
});

describe('getOptionalText', () => {
  it('returns undefined for a missing element', () => {
    expect(getOptionalText(undefined)).toBeUndefined();
    expect(getOptionalText(null)).toBeUndefined();
  });

  it('returns undefined for a present but empty element', () => {
    // `<ClusterID/>` and `<AuthType></AuthType>` are the shape NCBI ships for a
    // field it carries with no value; an absent field and an empty one are the
    // same absence to every caller.
    expect(getOptionalText('')).toBeUndefined();
    expect(getOptionalText({ '#text': '' })).toBeUndefined();
    expect(getOptionalText({ '@_attr': 'val' })).toBeUndefined();
  });

  it('returns the text of a populated element', () => {
    expect(getOptionalText('Editor')).toBe('Editor');
    expect(getOptionalText({ '#text': 'Editor' })).toBe('Editor');
    expect(getOptionalText(2024)).toBe('2024');
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

describe('getOptionalAttribute', () => {
  it('returns undefined for a missing attribute', () => {
    expect(getOptionalAttribute({ '@_UI': 'D012345' }, 'Name')).toBeUndefined();
    expect(getOptionalAttribute(null, 'X')).toBeUndefined();
  });

  it('returns undefined for a present but empty attribute', () => {
    expect(getOptionalAttribute({ '@_EIdType': '' }, 'EIdType')).toBeUndefined();
  });

  it('returns the value of a populated attribute', () => {
    expect(getOptionalAttribute({ '@_EIdType': 'pii' }, 'EIdType')).toBe('pii');
    expect(getOptionalAttribute({ '@_Version': 1 }, 'Version')).toBe('1');
  });
});
