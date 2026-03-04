/**
 * @fileoverview Generic helper functions for parsing XML data, particularly
 * structures from fast-xml-parser.
 * @module src/services/ncbi/parsing/xml-helpers
 */

/**
 * Ensures that the input is an array. If it's not an array, it wraps it in one.
 * Handles undefined or null by returning an empty array.
 * @param item - The item to ensure is an array.
 * @returns An array containing the item, or an empty array if item is null/undefined.
 * @template T - The type of the items in the array.
 */
export function ensureArray<T>(item: T | T[] | undefined | null): T[] {
  if (item === undefined || item === null) {
    return [];
  }
  return Array.isArray(item) ? item : [item];
}

/**
 * Safely extracts text content from an XML element, which might be a string or an object with a '#text' property.
 * Handles cases where #text might be a number or boolean by converting to string.
 * @param element - The XML element (string, object with #text, or undefined).
 * @param defaultValue - The value to return if text cannot be extracted. Defaults to an empty string.
 * @returns The text content or the default value.
 */
export function getText(element: unknown, defaultValue: undefined): string | undefined;
export function getText(element: unknown, defaultValue?: string): string;
export function getText(
  element: unknown,
  defaultValue: string | undefined = '',
): string | undefined {
  if (element === undefined || element === null) {
    return defaultValue;
  }
  if (typeof element === 'string') {
    return element;
  }
  if (typeof element === 'number' || typeof element === 'boolean') {
    return String(element); // Handle direct number/boolean elements
  }
  if (typeof element === 'object') {
    const obj = element as Record<string, unknown>;
    if (obj['#text'] !== undefined) {
      const val = obj['#text'];
      if (typeof val === 'string') return val;
      if (typeof val === 'number' || typeof val === 'boolean') return String(val);
    }
  }
  return defaultValue;
}

/**
 * Safely extracts an attribute value from an XML element.
 * Assumes attributes are prefixed with '@_' by fast-xml-parser.
 * @param element - The XML element object.
 * @param attributeName - The name of the attribute (e.g., 'UI', 'MajorTopicYN', without the '@_' prefix).
 * @param defaultValue - The value to return if the attribute is not found. Defaults to an empty string.
 * @returns The attribute value or the default value.
 */
export function getAttribute(
  element: unknown,
  attributeName: string,
  defaultValue: undefined,
): string | undefined;
export function getAttribute(
  element: unknown,
  attributeName: string,
  defaultValue?: string,
): string;
export function getAttribute(
  element: unknown,
  attributeName: string, // e.g., 'UI', 'MajorTopicYN'
  defaultValue: string | undefined = '',
): string | undefined {
  const fullAttributeName = `@_${attributeName}`; // As per fast-xml-parser config
  if (element && typeof element === 'object') {
    const obj = element as Record<string, unknown>;
    const val = obj[fullAttributeName];
    if (typeof val === 'string') return val;
    if (typeof val === 'boolean') return String(val); // Convert boolean attributes to string
    if (typeof val === 'number') return String(val); // Convert number attributes to string
  }
  return defaultValue;
}
