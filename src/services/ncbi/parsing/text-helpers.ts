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
 * Names a bare raw tag is stripped under with no closing partner: the formatting
 * names, plus HTML void and optional-close elements, which are never closed
 * (`<br>`, `<p>` with no `</p>`). The same names are the only ones recognized in
 * entity-encoded form. (#256, #262)
 */
const UNPAIRED_TAG_NAMES = [...FORMATTING_TAG_NAMES, 'br', 'hr', 'img', 'li', 'p', 'wbr'] as const;
const UNPAIRED_TAG_NAME_SET: ReadonlySet<string> = new Set(UNPAIRED_TAG_NAMES);
/**
 * An entity-encoded tag with an {@link UNPAIRED_TAG_NAMES} name and nothing else
 * inside the brackets but a closing `/` before the name or a self-closing `/`
 * after it: `&lt;i&gt;`, `&lt;/sup&gt;`, `&lt;br /&gt;`, `&lt;p&gt;`. Captures
 * the leading `/`, the name and the trailing `/`. Every other escaped
 * `&lt;…&gt;` — another name, attributes — is literal text. A failed match costs
 * at most the whitespace run after the name, so the scan stays linear.
 */
const ENCODED_TAG_SOURCE = `&lt;(\\/?)(${UNPAIRED_TAG_NAMES.join('|')})(\\s*\\/)?&gt;`;
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
 * #94). A match is not always markup: {@link toDisplayText} keeps a bare
 * `<NAME>` that nothing marks as a tag (`HuMab<CD20>`, #256). The remaining gap
 * is a stray `<letter …>` pair with a body — `a<b and c>d` still strips to
 * `a d`, as a tag with attributes would. The name class excludes the delimiter
 * the body must start with, so a failed match costs only the characters up to
 * the next angle bracket and the scan stays linear.
 *
 * Entity-encoded: {@link ENCODED_TAG_SOURCE} — a tag as Europe PMC escapes it
 * in PubMed titles (`&lt;i&gt;`, `&lt;/sup&gt;`, #181), and as NCBI
 * double-encodes it in abstracts (`&lt;br /&gt;`, `&lt;p&gt;`, #262).
 */
const MARKUP_TAG_RE = new RegExp(
  `<\\/?([A-Za-z][^\\s/<>=]*)([\\s/][^<>]*)?>|${ENCODED_TAG_SOURCE}`,
  'gi',
);
/** {@link ENCODED_TAG_SOURCE} alone, for the strip that leaves raw tags as text. */
const ENCODED_TAG_RE = new RegExp(ENCODED_TAG_SOURCE, 'gi');
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
 * Lowercased names of every closing tag in `text`: the `</name…>` matches of
 * {@link MARKUP_TAG_RE}, so exactly the closing tags the strip removes. One
 * linear scan.
 */
function closingTagNames(text: string): ReadonlySet<string> {
  const names = new Set<string>();
  for (const [tag, rawName] of text.matchAll(MARKUP_TAG_RE)) {
    if (rawName !== undefined && tag[1] === '/') names.add(rawName.toLowerCase());
  }
  return names;
}

/**
 * Replacement for one {@link MARKUP_TAG_RE} match. A raw tag is markup when it
 * is a closing tag, has a body (attributes, a `/`), carries an
 * {@link UNPAIRED_TAG_NAME_SET} name, or has a `</name>` partner somewhere in
 * the string; any other bare `<NAME>` is literal notation and stays as written
 * (`HuMab<CD20>`, #256). An encoded match is always markup. `closingNames` is
 * computed on first use, so a string with no bare unknown tag never pays for it.
 * The markup itself is replaced as {@link tagReplacement} says.
 */
function replaceMarkupTag(
  tag: string,
  rawName: string | undefined,
  rawBody: string | undefined,
  encodedName: string | undefined,
  encodedSelfClose: string | undefined,
  offset: number,
  text: string,
  closingNames: () => ReadonlySet<string>,
): string {
  if (rawName === undefined) {
    return tagReplacement(encodedSelfClose === undefined, encodedName ?? '', tag, offset, text);
  }
  if (rawBody === undefined && tag[1] !== '/') {
    const name = rawName.toLowerCase();
    if (!UNPAIRED_TAG_NAME_SET.has(name) && !closingNames().has(name)) return tag;
  }
  return tagReplacement(rawBody === undefined, rawName, tag, offset, text);
}

/**
 * What a markup tag spanning `offset`–`offset + tag.length` of `text` becomes.
 * A bare formatting tag (`bare`: no attributes, no self-closing `/`), raw or
 * encoded, is removed outright; any other tag becomes a space so the words on
 * either side of a structural boundary stay apart. A formatting tag that sits
 * between a sentence's closing punctuation and the next word also becomes a
 * space: abstracts set headings in bold or italic with no whitespace around them
 * (`children.<b>Aim.</b> The`, `<i>Objective.</i>Quantitative`), and joining
 * there fuses the sentences.
 */
function tagReplacement(
  bare: boolean,
  name: string,
  tag: string,
  offset: number,
  text: string,
): '' | ' ' {
  const formatting = bare && FORMATTING_TAG_NAME_SET.has(name.toLowerCase());
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
 * decode produces is scanned again (`&lt;&lt;i&gt;i&gt;` reads `<i>`). A raw
 * bare `<NAME>` that nothing marks as markup survives too (`HuMab<CD20>`; see
 * {@link replaceMarkupTag}). Used for Europe PMC titles, authors, journals, and
 * abstracts before truncation, so the character budget is spent on text rather
 * than markup.
 */
export function toDisplayText(text: string): string {
  let closing: ReadonlySet<string> | undefined;
  const closingNames = () => (closing ??= closingTagNames(text));
  const stripped = text.replace(
    MARKUP_TAG_RE,
    (
      tag: string,
      rawName: string | undefined,
      rawBody: string | undefined,
      _encodedClose: string | undefined,
      encodedName: string | undefined,
      encodedSelfClose: string | undefined,
      offset: number,
    ) =>
      replaceMarkupTag(
        tag,
        rawName,
        rawBody,
        encodedName,
        encodedSelfClose,
        offset,
        text,
        closingNames,
      ),
  );
  return decodeHtmlEntities(stripped)
    .replace(SOFT_HYPHEN_RE, '')
    .replace(WHITESPACE_RE, ' ')
    .trim();
}

/**
 * {@link toDisplayText} for a Europe PMC title, then one more single
 * {@link decodeHtmlEntities} pass. Europe PMC serves a PubMed title escaped
 * over the text NCBI's XML parser yields, so the layer NCBI double-encodes
 * (`Parkinson&amp;apos;s` in the XML) survives the strip's decode, and this
 * pass removes it as `esummary-parser.ts` and `article-parser.ts` do for the
 * same title — never to a fixed point: `&amp;amp;lt;` reads `&lt;`. A title
 * with no residual layer reads as {@link toDisplayText} returns it. Abstracts,
 * authors and journal titles arrive one layer lower (`patient&apos;s`,
 * `&lt;b&gt;`), so they take {@link toDisplayText} alone. Linear in the
 * length of the text. (#272)
 */
export function europePmcTitleText(text: string): string {
  return decodeHtmlEntities(toDisplayText(text));
}

const WHITESPACE_CHAR_RE = /\s/;
const isWhitespaceChar = (character: string | undefined): boolean =>
  character !== undefined && WHITESPACE_CHAR_RE.test(character);

/**
 * Strip the entity-encoded tags {@link toDisplayText} strips —
 * {@link ENCODED_TAG_SOURCE}, with the same replacements — and nothing else:
 * no raw tag, no decode, no whitespace collapse. For NCBI text a parser has
 * decoded once, where a surviving `&lt;b&gt;` is markup NCBI double-encoded
 * (`&amp;lt;b&amp;gt;` in the XML) while a raw `<b>` was single-encoded in the
 * XML, so it is the deposit's text. Run it before the residual
 * {@link decodeHtmlEntities} pass, so the decode is still the only one and
 * reveals no tag (#262).
 *
 * A tag that becomes a space adds one only between two non-whitespace
 * characters, so the text's own spacing and line breaks — the blank line
 * between abstract sections — stay byte for byte, and a tag at either end
 * leaves no space behind. Linear in the length of the text.
 */
export function stripEncodedMarkupTags(text: string): string {
  let out = '';
  let last = 0;
  let pendingSpace = false;
  const emit = (chunk: string) => {
    if (chunk === '') return;
    if (pendingSpace && out !== '' && !isWhitespaceChar(out.at(-1)) && !isWhitespaceChar(chunk[0]))
      out += ' ';
    pendingSpace = false;
    out += chunk;
  };
  for (const match of text.matchAll(ENCODED_TAG_RE)) {
    const [tag, , name = '', selfClose] = match;
    emit(text.slice(last, match.index));
    if (tagReplacement(selfClose === undefined, name, tag, match.index, text) === ' ') {
      pendingSpace = true;
    }
    last = match.index + tag.length;
  }
  if (last === 0) return text;
  emit(text.slice(last));
  return out;
}

/**
 * U+FEFF (zero width no-break space), U+00AD (soft hyphen) and U+200B (zero
 * width space): invisible characters PMC deposits carry inside words. U+200C
 * and U+200D, joiners that carry meaning in some scripts, are left alone, and so
 * is U+2060, which no deposit sampled carries.
 */
const INVISIBLE_FORMAT_CHARS_RE = /[\uFEFF\u00AD\u200B]/g;

/**
 * Drop {@link INVISIBLE_FORMAT_CHARS_RE} from a raw XML body before it is
 * parsed, once for every reader of the tree. JavaScript's `\s` matches U+FEFF,
 * so each whitespace collapse downstream turned one inside a word into a space
 * that split it (`hepatopulmonary s yndrome`); U+00AD and U+200B survive every
 * collapse and break a search for the word (`employ` + U+00AD + `ment`). The
 * characters never stand for spacing, so a real space beside one stays one
 * space. (#224)
 */
export function stripInvisibleFormatChars(xml: string): string {
  return xml.replace(INVISIBLE_FORMAT_CHARS_RE, '');
}
