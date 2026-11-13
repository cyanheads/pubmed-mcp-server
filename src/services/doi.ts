/**
 * @fileoverview The DOI rules shared by the tool layer's DOI schemas
 * (`src/mcp-server/tools/definitions/_schemas.ts`) and the Unpaywall service:
 * the single-pass DOI check, and the reading of a DOI resolver link or `doi:`
 * form as the bare DOI it names.
 * @module src/services/doi
 */

/** A character no DOI element may carry: whitespace, or the PMC ID Converter's list delimiter. */
const DOI_SEPARATOR = /[\s,]/;

/**
 * Whether `value` is a DOI as the tool schemas define one, in a single pass:
 * `10.`, then a character before a `/` and a character after it, with no
 * whitespace or comma anywhere. The first `/` past the character after `10.`
 * decides it, since a later one leaves no less room after it.
 */
export function isDoi(value: string): boolean {
  if (!value.startsWith('10.') || DOI_SEPARATOR.test(value)) return false;
  const slash = value.indexOf('/', 4);
  return slash !== -1 && slash < value.length - 1;
}

/** A DOI resolver link's scheme and host: `http` or `https`, `doi.org` or `dx.doi.org`. */
const DOI_LINK = /^https?:\/\/(?:dx\.)?doi\.org\//i;

/** The `doi:` scheme and any whitespace after it. */
const DOI_SCHEME = /^doi:\s*/i;

/**
 * The bare DOI a DOI link or `doi:`-prefixed value names, or `value` as sent.
 * One leading form is read, case-insensitively: a resolver link — `http` or
 * `https`, `doi.org` or `dx.doi.org` — whose path is percent-decoded and whose
 * query and fragment are dropped, or the `doi:` scheme with the whitespace after
 * it. The reading is kept only when it passes {@link isDoi}, so anything else
 * reaches validation, and its rejection, as sent. A value starting `10.` is never
 * rewritten, and no surrounding whitespace is trimmed. (#299)
 */
export function normalizeDoi(value: string): string {
  let read: string | undefined;
  const link = DOI_LINK.exec(value);
  if (link) {
    const rest = value.slice(link[0].length);
    const end = rest.search(/[?#]/);
    try {
      read = decodeURIComponent(end === -1 ? rest : rest.slice(0, end));
    } catch {
      // A malformed percent escape names no DOI; the value is rejected as sent.
      return value;
    }
  } else {
    const scheme = DOI_SCHEME.exec(value);
    if (scheme) read = value.slice(scheme[0].length);
  }
  return read !== undefined && isDoi(read) ? read : value;
}
