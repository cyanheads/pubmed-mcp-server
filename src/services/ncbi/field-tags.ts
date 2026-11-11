/**
 * @fileoverview PubMed search field tags — the one set `pubmed_search_articles`
 * reads for its blank-query check and its advice on a clause PubMed matched
 * nothing for, and `pubmed_spell_check` reads to keep the value of an indexed
 * field as written.
 * @module src/services/ncbi/field-tags
 */

/**
 * PubMed search field tags, lowercased: the tags in PubMed's search-field help,
 * their full names, and ESearch's own field names, each confirmed live to be
 * read as a field tag — a bare `[pdat]` returns "No items found." PubMed searches
 * the content of any other bracket as text (`[18F]`, `[cancer]`, `[smith j]`, and
 * `[ab]` all return matches). A tag missing here fails safe: its bare form is
 * sent and answered as an ordinary zero-hit search, and spell-check treats its
 * bracket like any other.
 */
const PUBMED_FIELD_TAGS: ReadonlySet<string> = new Set(
  [
    '1au|ad|aid|all|au|auid|book|cn|cois|crdt|dcom|doi|dp|ed|edat|fau|filter|fir|gr|ip|ir',
    'isbn|jid|la|lastau|lid|lr|majr|mh|mhda|nm|ot|pa|pg|pl|pmid|ps|pt|pubn|rn|sb|sh|si|so',
    'ta|ti|tiab|tt|tw|vi|affl|aucl|auth|cdat|cnty|coln|ecno|eid|epdat|epdt|faut|filt|finv',
    'full|grnt|iss|jour|lang|laut|mdat|mesh|otrm|page|papx|pdat|pid|ppdat|ppdt|ptyp|subh',
    'subs|titl|vol|word|author|editor|issue|subset|title|volume',
    'keyword|affiliation|all fields|author - corporate|author - first|author - identifier',
    'author - last|author cluster id|completion date|conflict of interest statements',
    'corporate author|create date|date - completion|date - create|date - entry|date - mesh',
    'date - modification|date - publication|ec/rn number|electronic publication date',
    'entry date|extended pmid|first author name|full author name|full investigator name',
    'grants and funding|investigator|journal|language|last author name|location id',
    'mesh date|mesh major topic|mesh subheading|mesh terms|modification date|other term',
    'pagination|personal name as subject|pharmacological action|place of publication',
    'print publication date|publication date|publication type|publisher|publisher id',
    'secondary source id|subheading|subject - personal name|supplementary concept|text word',
    'title/abstract|transliterated title',
  ]
    .join('|')
    .split('|'),
);

/**
 * The field tags whose value is words of the record's own text — Title/Abstract,
 * Title, Text Word, Other Term, Transliterated Title, All Fields, and Conflict
 * of Interest Statements, by tag, full name, or ESearch field name. Every other
 * field matches against an index (MeSH headings, publication types, journal
 * abbreviations, author names, subsets, language codes) that ESpell's dictionary
 * does not hold. (#259)
 */
const FREE_TEXT_FIELD_TAGS: ReadonlySet<string> = new Set([
  'tiab',
  'title/abstract',
  'ti',
  'title',
  'titl',
  'tw',
  'text word',
  'word',
  'ot',
  'other term',
  'otrm',
  'keyword',
  'tt',
  'transliterated title',
  'all',
  'all fields',
  'cois',
  'conflict of interest statements',
]);

/** Which index a PubMed field tag searches, as advice on a clause matching nothing tells them apart. */
export type FieldTagGroup = 'mesh' | 'journal' | 'language' | 'other';

/**
 * The field tags of the indexes a clause matching nothing is advised by, by
 * tag, full name, or ESearch field name: MeSH vocabulary — headings, major
 * topics, supplementary concepts, pharmacological actions, subheadings, and
 * publication types, every record type `pubmed_lookup_mesh` resolves — then
 * journals and languages. Every other field tag is `other`. (#294)
 */
const FIELD_TAG_GROUPS: ReadonlyMap<string, Exclude<FieldTagGroup, 'other'>> = new Map([
  ...[
    'mh',
    'mesh',
    'mesh terms',
    'majr',
    'mesh major topic',
    'nm',
    'subs',
    'supplementary concept',
    'pa',
    'papx',
    'pharmacological action',
    'sh',
    'subh',
    'subheading',
    'mesh subheading',
    'pt',
    'ptyp',
    'publication type',
  ].map((tag) => [tag, 'mesh'] as const),
  ...['ta', 'jour', 'journal'].map((tag) => [tag, 'journal'] as const),
  ...['la', 'lang', 'language'].map((tag) => [tag, 'language'] as const),
]);

/**
 * A bracket's content as a tag name: trimmed, lowercased, and cut at a search
 * modifier (`mh:noexp`, `tiab:~3`). Linear in `content`.
 */
function tagName(content: string): string {
  const name = content.trim().toLowerCase();
  const colon = name.indexOf(':');
  return colon < 0 ? name : name.slice(0, colon).trimEnd();
}

/**
 * What a bracket's content names: a PubMed field tag whose value is free text,
 * one whose value matches an index, or — `undefined` — no field tag at all
 * (`18F`, `cancer`, `ab`). Case, surrounding whitespace, and a search modifier
 * (`mh:noexp`, `tiab:~3`) do not change what a tag is. Linear in `content`.
 */
export function fieldTagKind(content: string): 'free-text' | 'indexed' | undefined {
  const tag = tagName(content);
  if (!PUBMED_FIELD_TAGS.has(tag)) return;
  return FREE_TEXT_FIELD_TAGS.has(tag) ? 'free-text' : 'indexed';
}

/**
 * The {@link FieldTagGroup} of the field a bracket's content names, read as
 * {@link fieldTagKind} reads it, or `undefined` when it names no PubMed field
 * tag. Linear in `content`.
 */
export function fieldTagGroup(content: string): FieldTagGroup | undefined {
  const tag = tagName(content);
  if (!PUBMED_FIELD_TAGS.has(tag)) return;
  return FIELD_TAG_GROUPS.get(tag) ?? 'other';
}

/**
 * The {@link FieldTagGroup} of a clause as ESearch reports it matching nothing,
 * read from the bracket that closes it: `"dapagliflozin"[MeSH Terms]` is
 * `mesh`. ESearch keeps the tag only on a quoted clause
 * (`QuotedPhraseNotFound`); an unquoted one comes back bare
 * (`dapagliflozin[mh]` as `dapagliflozin`, in `PhraseNotFound`), so its field
 * is unknown and this returns `undefined`, as it does for a clause whose
 * bracket names no field tag. Linear in `clause`: one scan back from its end.
 */
export function clauseFieldGroup(clause: string): FieldTagGroup | undefined {
  const text = clause.trimEnd();
  if (!text.endsWith(']')) return;
  const open = text.lastIndexOf('[');
  if (open < 0) return;
  return fieldTagGroup(text.slice(open + 1, -1));
}
