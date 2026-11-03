/**
 * @fileoverview Tests for `readCommonMark`, the CommonMark reading `content[]`
 * assertions compare against: every form it reads a node as, including the link
 * and image targets, fenced and HTML block contents, hard breaks, heading levels
 * and list starts a renderer shows (issue #276).
 * @module tests/_helpers.test
 */

import { describe, expect, it } from 'vitest';
import { readCommonMark } from './_helpers.js';

describe('readCommonMark (issue #276)', () => {
  describe('links and images', () => {
    it('reads a link with its href', () => {
      expect(readCommonMark('See [PMID 1](https://pubmed.ncbi.nlm.nih.gov/1/).')).toBe(
        'See ⟨a href=https://pubmed.ncbi.nlm.nih.gov/1/⟩PMID 1⟨/a⟩.',
      );
    });

    it('reads a link title inside the marker only when the link has one', () => {
      expect(readCommonMark('[home](https://a.test/p "Home page")')).toBe(
        '⟨a href=https://a.test/p title=Home page⟩home⟨/a⟩',
      );
      expect(readCommonMark('[home](https://a.test/p "")')).toBe(
        '⟨a href=https://a.test/p⟩home⟨/a⟩',
      );
    });

    it('reads an autolink href as markdown-it normalizes it, a backtick as %60', () => {
      expect(readCommonMark('<https://x.org/a`b>')).toBe(
        '⟨a href=https://x.org/a%60b⟩https://x.org/a`b⟨/a⟩',
      );
    });

    it('reads an image with its src, title, and alt read like link text', () => {
      expect(readCommonMark('![A *bar* chart](https://x.test/c.png "Figure 1")')).toBe(
        '⟨img src=https://x.test/c.png title=Figure 1⟩A ⟨em⟩bar⟨/em⟩ chart⟨/img⟩',
      );
      expect(readCommonMark('![chart](https://x.test/c.png)')).toBe(
        '⟨img src=https://x.test/c.png⟩chart⟨/img⟩',
      );
    });
  });

  describe('fenced, code and HTML blocks', () => {
    it('reads a fence with its info string and content, final newline included', () => {
      expect(readCommonMark('```js\nconst a = 1;\n```\n')).toBe('⟨fence js:const a = 1;\n⟩');
    });

    it('reads a fence with no info string as just its content', () => {
      expect(readCommonMark('```\n**Smith J**\n```\n')).toBe('⟨fence:**Smith J**\n⟩');
    });

    it('reads an indented code block and an HTML block with their content', () => {
      expect(readCommonMark('    indented *code*\n')).toBe('⟨code_block:indented *code*\n⟩');
      expect(readCommonMark('<div>\n**raw**\n</div>\n')).toBe(
        '⟨html_block:<div>\n**raw**\n</div>\n⟩',
      );
    });

    it('lets a negative check see text inside a fence', () => {
      const reading = readCommonMark('Authors:\n\n```\nSmith J\n```\n');
      expect(() => expect(reading).not.toContain('Smith J')).toThrow();
    });
  });

  describe('line breaks', () => {
    it('reads a hard break as ⟨br⟩ and a soft break as a bare newline', () => {
      expect(readCommonMark('line one  \nline two\nline three\\\nline four')).toBe(
        'line one⟨br⟩\nline two\nline three⟨br⟩\nline four',
      );
    });
  });

  describe('headings and ordered lists', () => {
    it('reads a heading with its level', () => {
      expect(readCommonMark('## Results\n\n#### Outcomes')).toBe(
        '⟨heading_open h2⟩\n\nResults\n\n⟨heading_close h2⟩\n\n⟨heading_open h4⟩\n\nOutcomes\n\n⟨heading_close h4⟩',
      );
    });

    it('reads an ordered list start past 1, and none for a list starting at 1', () => {
      expect(readCommonMark('3. third\n4. fourth')).toBe(
        '⟨ordered_list_open start=3⟩\n\n⟨list_item_open⟩\n\nthird\n\n⟨list_item_close⟩\n\n⟨list_item_open⟩\n\nfourth\n\n⟨list_item_close⟩\n\n⟨ordered_list_close⟩',
      );
      expect(readCommonMark('1. first')).toBe(
        '⟨ordered_list_open⟩\n\n⟨list_item_open⟩\n\nfirst\n\n⟨list_item_close⟩\n\n⟨ordered_list_close⟩',
      );
    });
  });

  it('keeps the forms it already read: emphasis, code spans, inline HTML, bullet lists', () => {
    expect(readCommonMark('- **a** `b` <i>c</i>')).toBe(
      '⟨bullet_list_open⟩\n\n⟨list_item_open⟩\n\n⟨strong⟩a⟨/strong⟩ ⟨code_inline:b⟩ ⟨html_inline:<i>⟩c⟨html_inline:</i>⟩\n\n⟨list_item_close⟩\n\n⟨bullet_list_close⟩',
    );
  });
});
