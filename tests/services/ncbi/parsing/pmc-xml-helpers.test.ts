/**
 * @fileoverview Tests for PMC JATS XML helper primitives (pmc-xml-helpers).
 * @module tests/services/ncbi/parsing/pmc-xml-helpers.test
 */

import { describe, expect, it } from 'vitest';
import type { JatsNode } from '@/services/ncbi/parsing/pmc-xml-helpers.js';
import {
  attrOf,
  childrenOf,
  findAll,
  findAllDescendants,
  findOne,
  isTextNode,
  rawTextContent,
  selectAlternative,
  tagNameOf,
  textContent,
  textContentExcluding,
  textOf,
} from '@/services/ncbi/parsing/pmc-xml-helpers.js';

// ─── Test helpers ─────────────────────────────────────────────────────────────

/** Build a text node. */
const t = (text: string): JatsNode => ({ '#text': text });
/** Build an element node, optionally with attributes. */
const el = (tag: string, children: JatsNode[], attrs?: Record<string, string>): JatsNode =>
  attrs ? { [tag]: children, ':@': attrs } : { [tag]: children };

/**
 * The LaTeX document publishers deposit as a `<tex-math>` body, reproducing the
 * preamble, the tab indentation and the `\begin{document}` wrapper of a real
 * Springer/Nature deposit.
 */
const texDocument = (expression: string): string =>
  '\\documentclass[12pt]{minimal}\n\t\t\t\t\\usepackage{amsmath}\n\t\t\t\t' +
  '\\usepackage{upgreek}\n\t\t\t\t\\setlength{\\oddsidemargin}{-69pt}\n\t\t\t\t' +
  `\\begin{document}${expression}\\end{document}`;

// ─── tagNameOf ────────────────────────────────────────────────────────────────

describe('tagNameOf', () => {
  it('returns the tag name for an element node', () => {
    const node = el('title', []);
    expect(tagNameOf(node)).toBe('title');
  });

  it('returns undefined for a text node', () => {
    expect(tagNameOf(t('some text'))).toBeUndefined();
  });

  it('returns the element key even when :@ attributes are present', () => {
    const node = el('article', [], { '@_article-type': 'research-article' });
    expect(tagNameOf(node)).toBe('article');
  });

  it('returns undefined for an empty object', () => {
    expect(tagNameOf({})).toBeUndefined();
  });

  it('returns undefined for an object with only :@ and #text keys', () => {
    const node: JatsNode = { ':@': { '@_id': 'x' }, '#text': 'val' };
    expect(tagNameOf(node)).toBeUndefined();
  });
});

// ─── childrenOf ───────────────────────────────────────────────────────────────

describe('childrenOf', () => {
  it('returns the children array of an element node', () => {
    const child = t('child text');
    const node = el('p', [child]);
    expect(childrenOf(node)).toEqual([child]);
  });

  it('returns empty array for a text node', () => {
    expect(childrenOf(t('text'))).toEqual([]);
  });

  it('returns empty array for a childless element', () => {
    expect(childrenOf(el('br', []))).toEqual([]);
  });

  it('returns empty array when the tag value is not an array (scalar content)', () => {
    const node: JatsNode = { p: 'scalar content' };
    expect(childrenOf(node)).toEqual([]);
  });
});

// ─── attrOf ───────────────────────────────────────────────────────────────────

describe('attrOf', () => {
  it('returns the attribute value for a known attribute', () => {
    const node = el('pub-date', [], { '@_pub-type': 'epub' });
    expect(attrOf(node, 'pub-type')).toBe('epub');
  });

  it('returns undefined for a missing attribute', () => {
    const node = el('pub-date', [], { '@_pub-type': 'epub' });
    expect(attrOf(node, 'date-type')).toBeUndefined();
  });

  it('returns undefined for a text node (no :@ key)', () => {
    expect(attrOf(t('text'), 'anything')).toBeUndefined();
  });

  it('returns undefined for a node with no :@ block at all', () => {
    expect(attrOf(el('p', []), 'id')).toBeUndefined();
  });

  it('converts numeric attribute values to string', () => {
    const node: JatsNode = { article: [], ':@': { '@_n': 42 } };
    expect(attrOf(node, 'n')).toBe('42');
  });

  it('converts boolean attribute values to string', () => {
    const node: JatsNode = { article: [], ':@': { '@_active': true } };
    expect(attrOf(node, 'active')).toBe('true');
  });
});

// ─── isTextNode / textOf ──────────────────────────────────────────────────────

describe('isTextNode', () => {
  it('returns true for a text node', () => {
    expect(isTextNode(t('hello'))).toBe(true);
  });

  it('returns false for an element node', () => {
    expect(isTextNode(el('p', []))).toBe(false);
  });

  it('returns false for an empty object', () => {
    expect(isTextNode({})).toBe(false);
  });
});

describe('textOf', () => {
  it('returns the text content of a text node', () => {
    expect(textOf(t('hello world'))).toBe('hello world');
  });

  it('converts numeric text values to string', () => {
    expect(textOf({ '#text': 42 })).toBe('42');
  });

  it('converts boolean text values to string', () => {
    expect(textOf({ '#text': false })).toBe('false');
  });

  it('returns empty string when #text is null', () => {
    expect(textOf({ '#text': null })).toBe('');
  });

  it('returns empty string for an element node (no #text key)', () => {
    expect(textOf(el('p', []))).toBe('');
  });
});

// ─── textContent ──────────────────────────────────────────────────────────────

describe('textContent', () => {
  it('returns empty string for undefined input', () => {
    expect(textContent(undefined)).toBe('');
  });

  it('returns text from a bare text node', () => {
    expect(textContent(t('hello'))).toBe('hello');
  });

  it('concatenates text across direct child text nodes', () => {
    const node = el('p', [t('first '), t('second')]);
    expect(textContent(node)).toBe('first second');
  });

  it('recursively collects text from nested elements', () => {
    const node = el('p', [t('Before '), el('italic', [t('italic text')]), t(' after')]);
    expect(textContent(node)).toBe('Before italic text after');
  });

  it('collapses multiple whitespace runs to a single space', () => {
    const node = el('p', [t('  lots   of   whitespace  ')]);
    expect(textContent(node)).toBe('lots of whitespace');
  });

  it('trims leading and trailing whitespace', () => {
    const node = el('p', [t('  trimmed  ')]);
    expect(textContent(node)).toBe('trimmed');
  });

  it('preserves document order across mixed inline content', () => {
    const node = el('p', [
      t('Our genes: '),
      el('italic', [t('NF1')]),
      t(' and '),
      el('italic', [t('MED12')]),
      t('.'),
    ]);
    expect(textContent(node)).toBe('Our genes: NF1 and MED12.');
  });

  it('handles a node list (array) input', () => {
    const nodes: JatsNode[] = [t('one'), t(' '), t('two')];
    expect(textContent(nodes)).toBe('one two');
  });

  it('returns empty string for an element with no children', () => {
    expect(textContent(el('br', []))).toBe('');
  });

  it('handles deeply nested text', () => {
    const deep = el('outer', [el('middle', [el('inner', [t('deep text')])])]);
    expect(textContent(deep)).toBe('deep text');
  });
});

// ─── findOne ─────────────────────────────────────────────────────────────────

describe('findOne', () => {
  it('returns undefined for undefined input', () => {
    expect(findOne(undefined, 'title')).toBeUndefined();
  });

  it('finds the first matching direct child', () => {
    const title = el('title', [t('My Title')]);
    const parent = el('front', [el('journal-meta', []), title]);
    expect(findOne(parent, 'title')).toBe(title);
  });

  it('returns undefined when no matching child exists', () => {
    const parent = el('front', [el('journal-meta', [])]);
    expect(findOne(parent, 'title')).toBeUndefined();
  });

  it('returns the first match when multiple matching children exist', () => {
    const first = el('p', [t('first')]);
    const second = el('p', [t('second')]);
    const parent = el('body', [first, second]);
    expect(findOne(parent, 'p')).toBe(first);
  });

  it('accepts a node list (array) as input', () => {
    const found = el('sec', []);
    const list: JatsNode[] = [el('p', []), found, el('p', [])];
    expect(findOne(list, 'sec')).toBe(found);
  });

  it('does not recurse into grandchildren — only checks direct children', () => {
    const nested = el('title', [t('Deep Title')]);
    const parent = el('body', [el('sec', [nested])]);
    expect(findOne(parent, 'title')).toBeUndefined();
  });

  it('skips text nodes when searching by tag', () => {
    const parent = el('p', [t('text'), el('title', [t('heading')])]);
    expect(findOne(parent, 'title')).toBeDefined();
  });
});

// ─── findAll ─────────────────────────────────────────────────────────────────

describe('findAll', () => {
  it('returns empty array for undefined input', () => {
    expect(findAll(undefined, 'p')).toEqual([]);
  });

  it('returns all matching direct children', () => {
    const p1 = el('p', [t('first')]);
    const p2 = el('p', [t('second')]);
    const parent = el('body', [p1, el('sec', []), p2]);
    const result = findAll(parent, 'p');
    expect(result).toHaveLength(2);
    expect(result[0]).toBe(p1);
    expect(result[1]).toBe(p2);
  });

  it('returns empty array when no children match', () => {
    const parent = el('body', [el('sec', [])]);
    expect(findAll(parent, 'p')).toEqual([]);
  });

  it('accepts a node list (array) as input', () => {
    const p1 = el('p', [t('a')]);
    const p2 = el('p', [t('b')]);
    const list: JatsNode[] = [p1, el('sec', []), p2];
    expect(findAll(list, 'p')).toHaveLength(2);
  });

  it('does not recurse — only checks direct children', () => {
    const nested = el('p', [t('nested p')]);
    const parent = el('body', [el('sec', [nested])]);
    expect(findAll(parent, 'p')).toHaveLength(0);
  });

  it('returns matches in document order', () => {
    const nodes = [el('kwd', [t('beta')]), el('kwd', [t('alpha')]), el('kwd', [t('gamma')])];
    const parent = el('kwd-group', nodes);
    const result = findAll(parent, 'kwd');
    expect(result.map((n) => textContent(n))).toEqual(['beta', 'alpha', 'gamma']);
  });

  it('skips text nodes when collecting by tag', () => {
    const parent = el('sec', [t('raw text'), el('p', [t('para')]), t('more text')]);
    expect(findAll(parent, 'p')).toHaveLength(1);
  });
});

// ─── Integration: nested JATS fragment ───────────────────────────────────────

describe('JATS tree navigation (integration)', () => {
  it('navigates a realistic article-meta fragment', () => {
    const articleMeta = el('article-meta', [
      el('article-id', [t('PMC7654321')], { '@_pub-id-type': 'pmcid' }),
      el('article-id', [t('10.1000/test')], { '@_pub-id-type': 'doi' }),
      el('title-group', [
        el('article-title', [t('Test '), el('italic', [t('Article')]), t(' Title')]),
      ]),
      el('contrib-group', [
        el('contrib', [el('name', [el('surname', [t('Smith')])])], { '@_contrib-type': 'author' }),
        el('contrib', [el('name', [el('surname', [t('Jones')])])], { '@_contrib-type': 'author' }),
      ]),
      el('pub-date', [el('year', [t('2024')]), el('month', [t('03')])], { '@_pub-type': 'epub' }),
      el('volume', [t('12')]),
      el('issue', [t('4')]),
    ]);

    // findOne drills into direct children
    const titleGroup = findOne(articleMeta, 'title-group');
    expect(titleGroup).toBeDefined();

    const articleTitle = findOne(titleGroup, 'article-title');
    expect(textContent(articleTitle)).toBe('Test Article Title');

    // findAll for contrib-group members
    const contribGroup = findOne(articleMeta, 'contrib-group');
    const contribs = findAll(contribGroup, 'contrib');
    expect(contribs).toHaveLength(2);

    // attrOf reads pub-id-type
    const ids = findAll(articleMeta, 'article-id');
    expect(ids).toHaveLength(2);
    expect(attrOf(ids[0]!, 'pub-id-type')).toBe('pmcid');
    expect(attrOf(ids[1]!, 'pub-id-type')).toBe('doi');

    // pub-date pub-type attribute
    const pubDate = findOne(articleMeta, 'pub-date');
    expect(attrOf(pubDate!, 'pub-type')).toBe('epub');
    expect(textContent(findOne(pubDate!, 'year'))).toBe('2024');
  });

  it('handles unicode in text nodes', () => {
    const node = el('article-title', [t('β-catenin in García-López cohorts')]);
    expect(textContent(node)).toBe('β-catenin in García-López cohorts');
  });

  it('collapses whitespace-only siblings to empty string', () => {
    const node = el('p', [t('   '), t('   ')]);
    expect(textContent(node)).toBe('');
  });
});

// ─── textContentExcluding ─────────────────────────────────────────────────────

describe('textContentExcluding', () => {
  const SKIP_TABLES: ReadonlySet<string> = new Set(['table-wrap']);

  it('returns empty for undefined', () => {
    expect(textContentExcluding(undefined, SKIP_TABLES)).toBe('');
  });

  it('reads a node with no excluded descendant exactly as textContent does', () => {
    const node = el('p', [t('Candidates include '), el('italic', [t('NF1')]), t('.')]);
    expect(textContentExcluding(node, SKIP_TABLES)).toBe(textContent(node));
  });

  it('drops an excluded subtree wherever it is nested', () => {
    const node = el('p', [
      t('Prose before. '),
      el('list', [
        el('list-item', [el('table-wrap', [el('label', [t('Table 1')]), el('td', [t('14.44')])])]),
      ]),
      t(' Prose after.'),
    ]);

    expect(textContentExcluding(node, SKIP_TABLES)).toBe('Prose before. Prose after.');
  });

  it('excludes nothing when the set is empty', () => {
    const node = el('p', [t('a'), el('table-wrap', [t('b')])]);
    expect(textContentExcluding(node, new Set())).toBe('ab');
  });
});

// ─── findAllDescendants ───────────────────────────────────────────────────────

describe('findAllDescendants', () => {
  it('returns empty for undefined', () => {
    expect(findAllDescendants(undefined, 'ref-list')).toEqual([]);
  });

  it('returns empty when nothing matches', () => {
    expect(findAllDescendants(el('body', [el('sec', [el('p', [t('x')])])]), 'ref-list')).toEqual(
      [],
    );
  });

  it('finds matches at mixed depths in document order', () => {
    const article = el('article', [
      el('body', [
        el('sec', [el('sec', [el('ref-list', [el('ref', [t('deep')])])])]),
        el('ref-list', [el('ref', [t('shallow')])]),
      ]),
      el('back', [el('ref-list', [el('ref', [t('back')])])]),
    ]);

    const found = findAllDescendants(article, 'ref-list');
    expect(found.map((n) => textContent(n))).toEqual(['deep', 'shallow', 'back']);
  });

  it('keeps descending through a match into a nested one', () => {
    const back = el('back', [
      el('ref-list', [el('ref', [t('outer')]), el('ref-list', [el('ref', [t('inner')])])]),
    ]);

    expect(findAllDescendants(back, 'ref-list')).toHaveLength(2);
  });

  it('accepts a sibling list as well as a single node', () => {
    const nodes = [el('back', [el('ref-list', [])]), el('body', [el('ref-list', [])])];
    expect(findAllDescendants(nodes, 'ref-list')).toHaveLength(2);
  });
});

// ─── <tex-math> and <alternatives> (#135) ─────────────────────────────────────

describe('tex-math and alternatives (#135)', () => {
  it('contributes only the document body of a preamble-wrapped <tex-math>', () => {
    const node = el('tex-math', [t(texDocument('$$\\mathbb {F}_q$$'))]);
    expect(textContent(node)).toBe('$$\\mathbb {F}_q$$');
  });

  it('leaves a <tex-math> deposited without a preamble unchanged', () => {
    expect(textContent(el('tex-math', [t('\\eta_{crit}')]))).toBe('\\eta_{crit}');
  });

  it('keeps the math delimiters so the expression still reads as math', () => {
    const node = el('tex-math', [t(texDocument('\\(x_i\\)'))]);
    expect(textContent(node)).toBe('\\(x_i\\)');
  });

  it('strips the preamble from a <tex-math> the deposit never closed', () => {
    // A truncated deposit opens \begin{document} and never closes it. Requiring
    // the closing marker returns the whole document, preamble included.
    const node = el('tex-math', [
      t('\\documentclass[12pt]{minimal}\\usepackage{amsmath}\\begin{document}$$\\gamma$$'),
    ]);
    expect(textContent(node)).toBe('$$\\gamma$$');
  });

  it('reads exactly one rendering from <alternatives>, preferring <tex-math>', () => {
    const node = el('alternatives', [
      el('tex-math', [t(texDocument('$$\\eta_{crit}$$'))]),
      el('mml:math', [t('ηcrit')]),
    ]);
    expect(textContent(node)).toBe('$$\\eta_{crit}$$');
  });

  it('falls back to the first child carrying text when <alternatives> has no <tex-math>', () => {
    const node = el('alternatives', [
      el('graphic', [], { '@_xlink:href': 'eq1.gif' }),
      el('mml:math', [t('ηcrit')]),
    ]);
    expect(textContent(node)).toBe('ηcrit');
  });

  it('applies the rule through rawTextContent', () => {
    const node = el('p', [
      t('before '),
      el('inline-formula', [el('tex-math', [t(texDocument('$$Q$$'))])]),
      t(' after'),
    ]);
    expect(rawTextContent(node)).toBe('before $$Q$$ after');
  });

  it('applies the rule through textContentExcluding', () => {
    const node = el('p', [
      el('inline-formula', [el('tex-math', [t(texDocument('$$Q$$'))])]),
      el('table-wrap', [el('label', [t('Table 1')])]),
    ]);
    expect(textContentExcluding(node, new Set(['table-wrap']))).toBe('$$Q$$');
  });

  it('skips an <alternatives> child the caller excluded and reads the next', () => {
    // The rendering a caller excluded by tag is not a rendering it can read, so
    // selecting it would contribute nothing where a sibling carries the text.
    const node = el('alternatives', [
      el('graphic', [el('alt-text', [t('eq1.gif')])], { '@_xlink:href': 'eq1.gif' }),
      el('mml:math', [t('ηcrit')]),
    ]);
    expect(textContentExcluding(node, new Set(['graphic']))).toBe('ηcrit');
  });

  it('resolves an <alternatives> nested inside inline markup', () => {
    const node = el('p', [
      t('stalls once '),
      el('italic', [
        el('inline-formula', [
          el('alternatives', [
            el('tex-math', [t(texDocument('$$\\eta$$'))]),
            el('mml:math', [t('η')]),
          ]),
        ]),
      ]),
      t(' is exceeded'),
    ]);
    expect(textContent(node)).toBe('stalls once $$\\eta$$ is exceeded');
  });
});

describe('selectAlternative', () => {
  it('returns the <tex-math> child when one is present', () => {
    const texMath = el('tex-math', [t('x')]);
    const node = el('alternatives', [el('mml:math', [t('y')]), texMath]);
    expect(selectAlternative(node)).toBe(texMath);
  });

  it('returns the first child carrying text otherwise', () => {
    const mathml = el('mml:math', [t('y')]);
    const node = el('alternatives', [el('graphic', []), mathml]);
    expect(selectAlternative(node)).toBe(mathml);
  });

  it('returns undefined when no child carries text', () => {
    expect(selectAlternative(el('alternatives', [el('graphic', [])]))).toBeUndefined();
  });

  it('passes over a <tex-math> that carries no expression', () => {
    // An empty <tex-math> stands for no rendering at all. Preferring it by tag
    // alone drops the MathML beside it and the formula disappears.
    const mathml = el('mml:math', [t('ηcrit')]);
    expect(selectAlternative(el('alternatives', [el('tex-math', []), mathml]))).toBe(mathml);
  });

  it('passes over a <tex-math> whose document body is empty', () => {
    const mathml = el('mml:math', [t('ηcrit')]);
    const preambleOnly = el('tex-math', [t(texDocument(''))]);
    expect(selectAlternative(el('alternatives', [preambleOnly, mathml]))).toBe(mathml);
  });

  it('prefers a rendering over a pointer that carries alt text', () => {
    // <graphic> and <inline-graphic> point at an external image; their
    // <alt-text> names the file rather than stating the object, so selecting
    // one positionally drops the only readable rendering the deposit carries.
    const mathml = el('mml:math', [t('ηcrit')]);
    const pointer = el('graphic', [el('alt-text', [t('eq1.gif')])], { '@_xlink:href': 'eq1.gif' });
    expect(selectAlternative(el('alternatives', [pointer, mathml]))).toBe(mathml);
  });

  it('falls back to a pointer when it is the only child carrying text', () => {
    const pointer = el('graphic', [el('alt-text', [t('Structure of benzene')])]);
    expect(selectAlternative(el('alternatives', [pointer]))).toBe(pointer);
  });
});
