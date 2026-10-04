/**
 * @fileoverview Properties every fixture's `pubmed_fetch_fulltext` result must have,
 * checked on both surfaces: every `structuredContent` string and the `content[]`
 * text. Each check returns the problems it found, so one run reports every broken
 * invariant. Counts compare against the fixture's own `source.xml`.
 * @module tests/corpus/invariants
 */
import type { CorpusArticle } from './expect.js';

export interface InvariantInput {
  article: CorpusArticle;
  /** The fixture's `source.xml`, decoded. */
  source: string;
  /** Every string leaf of `structuredContent`, with its path. */
  strings: { path: string; value: string }[];
  /** `expect.json`'s table count, when the fixture states why it differs from the source. */
  tablesOverride?: number | undefined;
  /** The `content[]` text. */
  text: string;
}

function count(text: string, pattern: RegExp): number {
  return [...text.matchAll(pattern)].length;
}

/** Element names the source uses, so a `<` in prose is judged against real JATS tags. */
export function sourceElementNames(source: string): Set<string> {
  return new Set(
    [...source.matchAll(/<([A-Za-z][\w.-]*(?::[\w.-]+)?)[\s/>]/g)].map((m) => m[1] ?? ''),
  );
}

const TAG_LIKE = /(?<!\\)<\/?([A-Za-z][\w.-]*(?::[\w.-]+)?)(?=[\s>/])/g;
const ENTITY = /(?<!\\)&(?:#\d+|#x[\da-f]+|[a-z][a-z\d]*);/gi;
export const MISSING_TOKENS = ['undefined', 'null', 'NaN', '[object Object]'] as const;

/** A source JATS element name that reached the output as a tag; `\<` is an escape, not a leak. */
export function leakedTag(value: string, names: Set<string>, source: string): string | undefined {
  for (const match of value.matchAll(TAG_LIKE)) {
    const name = match[1] ?? '';
    if (names.has(name) && !source.includes(`&lt;${name}`)) {
      return value.slice(match.index, match.index + 40);
    }
  }
  return;
}

/** An entity reference left undecoded, unless the source itself escapes one as text. */
export function undecodedEntity(value: string, source: string): string | undefined {
  for (const match of value.matchAll(ENTITY)) {
    if (!source.includes(`&amp;${match[0].slice(1)}`)) return match[0];
  }
  return;
}

/** Tokens the source holds as a whole text node — a `<td>NaN</td>` is content, not a leak. */
export function sourceTokens(source: string): Set<string> {
  return new Set(
    MISSING_TOKENS.filter((token) =>
      new RegExp(`>\\s*${token.replace(/[[\]]/g, '\\$&')}\\s*<`).test(source),
    ),
  );
}

/** A missing value or object stringified into a rendered line: a whole cell, field, or line. */
export function renderedMissing(text: string, allowed: Set<string>): string | undefined {
  for (const token of MISSING_TOKENS) {
    if (allowed.has(token)) continue;
    if (token === '[object Object]') {
      if (text.includes(token)) return token;
      continue;
    }
    const field = new RegExp(`(?:^|\\| |:\\*\\* |: )${token}(?= \\||$)`, 'm');
    if (field.test(text)) return token;
  }
  return;
}

// ── Text fused across a JATS boundary ───────────────────────────────────────

/**
 * Elements whose start or end separates the text on either side of it. Inline
 * markup (`<italic>`, `<sup>`, `<xref>`, MathML) is absent: it never separates.
 */
const SEPARATING = new Set([
  'abstract',
  'aff',
  'app',
  'attrib',
  'boxed-text',
  'break',
  'caption',
  'contrib',
  'def',
  'def-item',
  'def-list',
  'disp-formula',
  'disp-quote',
  'element-citation',
  'fig',
  'fn',
  'given-names',
  'hr',
  'institution',
  'institution-id',
  'kwd',
  'label',
  'list',
  'list-item',
  'mixed-citation',
  'p',
  'ref',
  'sec',
  'surname',
  'table-wrap',
  'td',
  'term',
  'th',
  'title',
  'tr',
]);

type Token =
  | { kind: 'tag'; name: string; closing: boolean; empty: boolean }
  | { kind: 'text'; value: string };

const XML_ENTITIES: Record<string, string> = { amp: '&', apos: "'", gt: '>', lt: '<', quot: '"' };

export function decodeText(value: string): string {
  return value.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (whole, body: string) => {
    if (body.startsWith('#x') || body.startsWith('#X'))
      return String.fromCodePoint(Number.parseInt(body.slice(2), 16));
    if (body.startsWith('#')) return String.fromCodePoint(Number.parseInt(body.slice(1), 10));
    return XML_ENTITIES[body] ?? whole;
  });
}

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  for (const match of source.matchAll(/<([^>]*)>|[^<]+/g)) {
    const inner = match[1];
    if (inner === undefined) {
      tokens.push({ kind: 'text', value: decodeText(match[0]) });
      continue;
    }
    const name = /^\/?([\w:.-]+)/.exec(inner)?.[1] ?? '';
    tokens.push({ kind: 'tag', name, closing: inner.startsWith('/'), empty: inner.endsWith('/') });
  }
  return tokens;
}

const WORD_END = /[\p{L}\p{N}]$/u;
const WORD_START = /^[\p{L}\p{N}]/u;

/**
 * The non-whitespace run ending one text node joined to the run starting the next,
 * wherever only tags lie between the two, at least one of them separates text, and a
 * letter or digit meets a letter or digit at the join (`RATIOSIRR`, `2095`,
 * `1Division`). A join at punctuation (`University` + `.`) reads naturally and is not
 * a fusion.
 */
function boundaryFusions(tokens: Token[]): string[] {
  const found: string[] = [];
  let previous: string | undefined;
  let separated = false;
  for (const token of tokens) {
    if (token.kind === 'tag') {
      if (SEPARATING.has(token.name)) separated = true;
      continue;
    }
    if (
      separated &&
      previous !== undefined &&
      WORD_END.test(previous) &&
      WORD_START.test(token.value)
    ) {
      const fused = `${/\S+$/.exec(previous)?.[0] ?? ''}${/^\S+/.exec(token.value)?.[0] ?? ''}`;
      if (fused.length >= 4) found.push(fused);
    }
    previous = token.value;
    separated = false;
  }
  return found;
}

/**
 * Every run of two or more `<xref>`s with no text between them, their texts joined
 * and read with the non-space character just outside each end: `[1234]` for four
 * adjacent citation markers inside brackets.
 */
function xrefRunFusions(tokens: Token[]): string[] {
  const found: string[] = [];
  let run: string[] = [];
  let inside = false;
  let before = '';
  let previous = '';
  const finish = (after: string) => {
    if (run.filter(Boolean).length >= 2) found.push(`${before}${run.join('')}${after}`);
    run = [];
  };
  for (const token of tokens) {
    if (token.kind === 'text') {
      if (inside) {
        run[run.length - 1] += token.value;
        continue;
      }
      if (run.length > 0) finish(token.value.slice(0, 1).trim());
      previous = token.value;
      continue;
    }
    if (token.name !== 'xref' || token.empty) continue;
    if (token.closing) {
      inside = false;
      continue;
    }
    if (run.length === 0) before = previous.slice(-1).trim();
    run.push('');
    inside = true;
  }
  finish('');
  return found;
}

/**
 * Words the output would hold if a separating boundary were dropped (see
 * {@link boundaryFusions} and {@link xrefRunFusions}). Each is reported only when the
 * output holds it and no single source text node does.
 */
function fusionCandidates(source: string): string[] {
  const tokens = tokenize(source);
  return [...new Set([...boundaryFusions(tokens), ...xrefRunFusions(tokens)])];
}

function fusedAcrossBoundary(source: string, haystack: string): string[] {
  const native = source
    .split(/<[^>]*>/)
    .map(decodeText)
    .join('\u0000');
  return fusionCandidates(source).filter(
    (fused) => haystack.includes(fused) && !native.includes(fused),
  );
}

// ── Checks ──────────────────────────────────────────────────────────────────

/** Problems with one fixture's result; empty when every invariant holds. */
export function checkInvariants({
  article,
  source,
  strings,
  tablesOverride,
  text,
}: InvariantInput): string[] {
  const problems: string[] = [];
  const names = sourceElementNames(source);
  const surfaces = [{ path: 'content[]', value: text }, ...strings];

  for (const { path, value } of surfaces) {
    const tag = leakedTag(value, names, source);
    if (tag) problems.push(`leaked JATS tag at ${path}: "${tag}"`);
    const entity = undecodedEntity(value, source);
    if (entity) problems.push(`undecoded entity at ${path}: "${entity}"`);
  }

  const allowed = sourceTokens(source);
  const leakedValue = strings.find(
    ({ value }) =>
      MISSING_TOKENS.some((token) => !allowed.has(token) && value.trim() === token) ||
      (!allowed.has('[object Object]') && value.includes('[object Object]')),
  );
  if (leakedValue) problems.push(`a stringified missing value at ${leakedValue.path}`);
  const rendered = renderedMissing(text, allowed);
  if (rendered) problems.push(`"${rendered}" rendered as a value in content[]`);

  const emptyHeading = /^#{1,6}[ \t]*$/m.exec(text);
  if (emptyHeading) problems.push(`an empty heading in content[] at offset ${emptyHeading.index}`);
  const blankTitle = strings.find(
    ({ path, value }) => /\.title$/.test(path) && value.trim() === '',
  );
  if (blankTitle) problems.push(`a blank title at ${blankTitle.path}`);

  const sourceTables = count(source, /<table-wrap[\s>]/g);
  const wantedTables = tablesOverride ?? sourceTables;
  const tables = article.tables?.length ?? 0;
  if (tables !== wantedTables) {
    problems.push(
      `${wantedTables} tables expected (${sourceTables} <table-wrap> in the source), ${tables} returned`,
    );
  }
  const renderedTables = Number(/^#### Tables \((\d+)\)$/m.exec(text)?.[1] ?? 0);
  if (renderedTables !== tables)
    problems.push(`content[] lists ${renderedTables} tables, structuredContent ${tables}`);

  const assets = article.assets ?? [];
  const figures = assets.filter((a) => a.assetType === 'figure').length;
  const sourceFigures = count(source, /<fig[\s>]/g);
  if (figures < sourceFigures)
    problems.push(`${sourceFigures} <fig> in the source, ${figures} figures returned`);
  const supplements = assets.length - figures;
  const sourceSupplements = count(source, /<supplementary-material[\s>]/g);
  if (supplements < sourceSupplements) {
    problems.push(
      `${sourceSupplements} <supplementary-material> in the source, ${supplements} returned`,
    );
  }
  const renderedFigures = count(text, /^\*figure(?: · .*)?\*$/gm);
  if (renderedFigures !== figures)
    problems.push(`content[] renders ${renderedFigures} figures, structuredContent ${figures}`);

  const sourceRefs = count(source, /<ref[\s>]/g);
  const references = article.references?.length ?? 0;
  if (references < Math.floor(sourceRefs * 0.95)) {
    problems.push(`${sourceRefs} <ref> in the source, ${references} references returned`);
  }
  const renderedRefs = Number(/^#### References \((\d+)\)$/m.exec(text)?.[1] ?? 0);
  if (renderedRefs !== references)
    problems.push(`content[] lists ${renderedRefs} references, structuredContent ${references}`);

  const haystack = [text, ...strings.map((s) => s.value)].join('\u0000');
  for (const fused of fusedAcrossBoundary(source, haystack)) {
    problems.push(`text fused across a JATS boundary: "${fused}"`);
  }
  return problems;
}
