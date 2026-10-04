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
 * Inline formatting elements (PubMed, JATS, HTML). Removing one reproduces what
 * a renderer shows, so `D<sub>2</sub>O` reads `D2O`, never `D 2 O` — except
 * after sentence-closing punctuation, where it keeps the break. (#181)
 */
const FORMATTING_TAG_NAMES = [
  'b',
  'bold',
  'em',
  'i',
  'inf',
  'italic',
  'sc',
  'strong',
  'sub',
  'sup',
  'u',
  'underline',
] as const;
const FORMATTING_TAG_NAME_SET: ReadonlySet<string> = new Set(FORMATTING_TAG_NAMES);
const FORMATTING_TAG_ALTERNATION = FORMATTING_TAG_NAMES.join('|');
/**
 * A markup tag, in one of two forms, recognized in a single left-to-right pass.
 *
 * Raw: `<`, an optional `/`, a tag name that starts with a letter, then either
 * `>` or a body that opens with whitespace or `/` and carries no further angle
 * bracket. Each restriction keeps notation intact. A leading letter leaves
 * `P<0.001` alone; a name ends only at whitespace, `/`, or `>`, never at `=`, so
 * PubMed's legacy `<or= 20 or > 20` (≤) is not read as a tag that deletes the
 * text up to the next `>` (#195); and a body free of `<` stops a match opened on
 * a stray `<` from spanning the next real tag (`n<N ... <bold>` keeps its text,
 * #94). The remaining gap is a stray `<letter …>` pair — `a<b and c>d` still
 * strips to `a d`, and `HuMab<CD20>` loses `<CD20>`. Closing it would take a
 * tag-name allowlist that silently drops unknown JATS elements, so the looser
 * shape is deliberate. The name class excludes the delimiter the body must
 * start with, so a failed match costs only the characters up to the next angle
 * bracket and the scan stays linear.
 *
 * Entity-encoded: a bare formatting tag as Europe PMC escapes it in PubMed
 * titles (`&lt;i&gt;`, `&lt;/sup&gt;`). Only these names, with nothing else
 * inside the brackets, are recognized — every other escaped `&lt;…&gt;` stays
 * literal text. (#181)
 */
const MARKUP_TAG_RE = new RegExp(
  `<\\/?([A-Za-z][^\\s/<>=]*)([\\s/][^<>]*)?>|&lt;\\/?(?:${FORMATTING_TAG_ALTERNATION})&gt;`,
  'gi',
);
/** Punctuation that closes a sentence or a heading label (`Results:`). */
const SENTENCE_END = new Set(['.', ':', '!', '?']);
/** Sticky: one bare formatting tag, raw or encoded, at `lastIndex`. */
const FORMATTING_TAG_AT_RE = new RegExp(
  `<\\/?(?:${FORMATTING_TAG_ALTERNATION})>|&lt;\\/?(?:${FORMATTING_TAG_ALTERNATION})&gt;`,
  'iy',
);
/** Sticky: a letter or digit at `lastIndex`. */
const WORD_CHARACTER_AT_RE = /[\p{L}\p{N}]/uy;
const ASCII_DIGIT_RE = /[0-9]/;
const SOFT_HYPHEN_RE = /­/g;
const WHITESPACE_RE = /\s+/g;

/**
 * Replacement for one {@link MARKUP_TAG_RE} match: a bare formatting tag, raw or
 * encoded, is removed outright; any other raw tag becomes a space so the words
 * on either side of a structural boundary stay apart. A formatting tag that
 * sits between a sentence's closing punctuation and the next word also becomes
 * a space: abstracts set headings in bold or italic with no whitespace around
 * them (`children.<b>Aim.</b> The`, `<i>Objective.</i>Quantitative`), and
 * joining there fuses the sentences.
 */
function replaceMarkupTag(
  tag: string,
  rawName: string | undefined,
  rawBody: string | undefined,
  offset: number,
  text: string,
): string {
  const formatting =
    rawName === undefined ||
    (rawBody === undefined && FORMATTING_TAG_NAME_SET.has(rawName.toLowerCase()));
  return formatting && !breaksSentence(text, offset, offset + tag.length) ? '' : ' ';
}

/**
 * Whether the tag spanning `start`–`end` follows sentence-closing punctuation
 * and leads, past any further formatting tags, into a letter or digit. A `::`
 * separator (`T2::<i>Nluc</i>`) closes no sentence, and neither does
 * punctuation between two digits (`0.<b>05</b>`, `10:<b>30</b>`). Only a tag
 * preceded by that punctuation reads ahead, and the run it reads ends at the
 * first character that is not a formatting tag, so the read-ahead stays linear
 * overall.
 */
function breaksSentence(text: string, start: number, end: number): boolean {
  const before = text[start - 1];
  if (before === undefined || !SENTENCE_END.has(before)) return false;
  if (before === ':' && text[start - 2] === ':') return false;
  let next = end;
  FORMATTING_TAG_AT_RE.lastIndex = next;
  while (FORMATTING_TAG_AT_RE.test(text)) next = FORMATTING_TAG_AT_RE.lastIndex;
  WORD_CHARACTER_AT_RE.lastIndex = next;
  if (!WORD_CHARACTER_AT_RE.test(text)) return false;
  return !(ASCII_DIGIT_RE.test(text[start - 2] ?? '') && ASCII_DIGIT_RE.test(text[next] ?? ''));
}

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
 * plain text: strip tags, decode character references, drop soft hyphens
 * (U+00AD — invisible, and it corrupts token matching mid-word), and collapse
 * the resulting whitespace. Tags are stripped in one pass before decoding, so a
 * raw `<bold>` and an encoded `&lt;i&gt;` are removed while an escaped
 * `&lt;gene&gt;` survives as literal text — and nothing a removal joins or a
 * decode produces is scanned again (`&lt;&lt;i&gt;i&gt;` reads `<i>`). Used for
 * Europe PMC titles, authors, journals, and abstracts before truncation, so the
 * character budget is spent on text rather than markup.
 */
export function toDisplayText(text: string): string {
  return decodeHtmlEntities(text.replace(MARKUP_TAG_RE, replaceMarkupTag))
    .replace(SOFT_HYPHEN_RE, '')
    .replace(WHITESPACE_RE, ' ')
    .trim();
}
