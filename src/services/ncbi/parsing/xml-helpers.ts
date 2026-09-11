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
  if (item == null) {
    return [];
  }
  return Array.isArray(item) ? item : [item];
}

/**
 * Safely extracts text content from an XML element, which might be a string or an object with a '#text' property.
 * Handles cases where #text might be a number or boolean by converting to string.
 *
 * Always returns a string. Use {@link getOptionalText} where an absent element
 * must stay distinguishable from an empty one — a default parameter fires on an
 * explicit `undefined`, so this function cannot report absence. (#137)
 * @param element - The XML element (string, object with #text, or undefined).
 * @param defaultValue - The value to return if text cannot be extracted. Defaults to an empty string.
 * @returns The text content or the default value.
 */
export function getText(element: unknown, defaultValue = ''): string {
  if (element == null) {
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
 * Text of an XML element, with an absent or empty element reported as absent.
 *
 * NCBI ships a field it carries with no value as an empty element — `<AuthType/>`,
 * `<ClusterID/>`, `<ELocationID></ELocationID>` — and a caller cannot act on the
 * difference between that and no element at all. Both are `undefined` here, so
 * a conditional spread (`...(v !== undefined && { v })`) omits the key instead
 * of writing an empty string into the parsed record. (#137)
 * @param element - The XML element (string, object with #text, or undefined).
 * @returns The text content, or undefined when the element is absent or empty.
 */
export function getOptionalText(element: unknown): string | undefined {
  return getText(element) || undefined;
}

/**
 * Safely extracts an attribute value from an XML element.
 * Assumes attributes are prefixed with '@_' by fast-xml-parser.
 *
 * Always returns a string; {@link getOptionalAttribute} is the form that reports
 * absence. (#137)
 * @param element - The XML element object.
 * @param attributeName - The name of the attribute (e.g., 'UI', 'MajorTopicYN', without the '@_' prefix).
 * @param defaultValue - The value to return if the attribute is not found. Defaults to an empty string.
 * @returns The attribute value or the default value.
 */
export function getAttribute(
  element: unknown,
  attributeName: string, // e.g., 'UI', 'MajorTopicYN'
  defaultValue = '',
): string {
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

/**
 * Attribute value of an XML element, with a missing or empty attribute reported
 * as absent — the {@link getOptionalText} rule applied to attributes. (#137)
 * @param element - The XML element object.
 * @param attributeName - The attribute name, without the '@_' prefix.
 * @returns The attribute value, or undefined when it is missing or empty.
 */
export function getOptionalAttribute(element: unknown, attributeName: string): string | undefined {
  return getAttribute(element, attributeName) || undefined;
}
