/**
 * @fileoverview Plain-text normalization for upstream biomedical strings.
 * Europe PMC search snippets and NCBI grant identifiers arrive carrying
 * structural JATS/HTML markup, un-decoded HTML character references, and soft
 * hyphens. These helpers turn such strings into clean, display-ready plain text
 * so callers — often a smaller model pre-screening hits — don't have to
 * re-sanitize upstream markup.
 * @module src/services/ncbi/parsing/text-helpers
 */

/** Named HTML/XML character references that appear in PubMed / Europe PMC text. */
const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  shy: '­',
};

/** A well-formed numeric (`&#173;`, `&#xAD;`) or named (`&amp;`) character reference. */
const ENTITY_RE = /&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi;
/**
 * A structural tag: `<` immediately followed by an optional `/` and a tag-name
 * letter, then a tag body carrying no further angle bracket.
 *
 * Both restrictions exist to keep statistical notation intact. Requiring a
 * leading letter leaves `P<0.001` alone; forbidding `<` inside the body stops a
 * match that opened on a stray `<` from spanning across the next real tag and
 * swallowing the prose between them (`n<N ... <bold>` keeps its text). The
 * remaining gap is a stray `<` and `>` pair with a letter after the `<` and no
 * tag between them — `a<b and c>d` still strips to `a d`. Closing it would take
 * a tag-name allowlist, which would silently drop unknown JATS elements, so the
 * looser pattern is deliberate: it errs toward leaving markup visible rather
 * than deleting text. (#94)
 */
const MARKUP_TAG_RE = /<\/?[A-Za-z][^<>]*>/g;
const SOFT_HYPHEN_RE = /­/g;
const WHITESPACE_RE = /\s+/g;

/**
 * Decode well-formed named and numeric HTML/XML character references in a plain
 * string. A bare `&` (e.g. `AT&T`) is left untouched — only `&name;` / `&#NN;` /
 * `&#xHH;` forms are decoded — so this is safe to run on text an XML parser
 * already decoded once: a surviving double-encoding (`&amp;amp;`) collapses to
 * `&amp;`, while a genuine ampersand stays put. Unknown named entities and
 * out-of-range code points are left verbatim rather than dropped.
 */
export function decodeHtmlEntities(text: string): string {
  return text.replace(ENTITY_RE, (match, body: string) => {
    if (body.charCodeAt(0) === 35 /* '#' */) {
      const isHex = body.charCodeAt(1) === 120 || body.charCodeAt(1) === 88; /* 'x' | 'X' */
      const codePoint = isHex ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (!Number.isFinite(codePoint) || codePoint < 0 || codePoint > 0x10ffff) return match;
      try {
        return String.fromCodePoint(codePoint);
      } catch {
        return match;
      }
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? match;
  });
}

/**
 * Turn an upstream string that may carry JATS/HTML markup into display-ready
 * plain text: strip structural tags, decode character references, drop soft
 * hyphens (U+00AD — invisible, and it corrupts token matching mid-word), and
 * collapse the resulting whitespace. Tags are stripped before decoding so a
 * structural `<bold>` is removed while an entity-escaped `&lt;gene&gt;` survives
 * as literal text. Used for Europe PMC abstract snippets before truncation, so
 * the character budget is spent on text rather than markup.
 */
export function toDisplayText(text: string): string {
  return decodeHtmlEntities(text.replace(MARKUP_TAG_RE, ' '))
    .replace(SOFT_HYPHEN_RE, '')
    .replace(WHITESPACE_RE, ' ')
    .trim();
}
