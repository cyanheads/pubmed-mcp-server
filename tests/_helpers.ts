/**
 * @fileoverview Shared test helpers for narrowing MCP payload unions.
 * `format()` and prompt handlers return `ContentBlock` / `PromptMessage`
 * unions; assertions in these suites read `.text`, so narrow once at the call
 * site instead of guarding at every assertion. Also the rendered view of a
 * `content[]` text, for the Bun lane's render checks, and its CommonMark
 * reading, for checks that run on every lane.
 * @module tests/_helpers
 */

import type { ContentBlock, PromptMessage } from '@cyanheads/mcp-ts-core';
import MarkdownIt, { type Token } from 'markdown-it';

/** A `ContentBlock` narrowed to the text variant. */
export type TextBlock = Extract<ContentBlock, { type: 'text' }>;

/** A `PromptMessage` whose content is narrowed to the text variant. */
export type TextPromptMessage = Omit<PromptMessage, 'content'> & { content: TextBlock };

/** Narrows `format()` output to text blocks, throwing on any other block kind. */
export function textBlocks(blocks: ContentBlock[]): TextBlock[] {
  return blocks.map((block, index) => {
    if (block.type !== 'text') {
      throw new Error(`Expected a text content block at index ${index}, got "${block.type}".`);
    }
    return block;
  });
}

/**
 * Bun's CommonMark + GFM renderer. The Node lane has no `Bun` global, so a
 * suite gates its render checks with `describe.runIf(bunMarkdown !== undefined)`.
 */
export const bunMarkdown = (globalThis as { Bun?: { markdown?: { html(text: string): string } } })
  .Bun?.markdown;

/**
 * `markdown` rendered to HTML by {@link bunMarkdown}. Throws without it, so a
 * render check left ungated fails on the Node lane instead of passing on `''`.
 */
export function renderedHtml(markdown: string): string {
  if (!bunMarkdown) {
    throw new Error(
      'Bun.markdown is unavailable: gate this check with runIf(bunMarkdown !== undefined).',
    );
  }
  return bunMarkdown.html(markdown);
}

/** The text a reader sees once `markdown` renders: tags dropped, entities decoded, whitespace collapsed. */
export function renderedText(markdown: string): string {
  return renderedHtml(markdown)
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

/** GFM-flavored CommonMark with raw HTML on, the shape `content[]` clients render. */
const commonMarkParser = new MarkdownIt('default', { html: true });

function readInline(children: Token[]): string {
  let out = '';
  for (const token of children) {
    if (token.type === 'text' || token.type === 'text_special') out += token.content;
    else if (token.type === 'softbreak' || token.type === 'hardbreak') out += '\n';
    else if (token.nesting === 1) out += `⟨${token.tag}⟩`;
    else if (token.nesting === -1) out += `⟨/${token.tag}⟩`;
    else out += `⟨${token.type}:${token.content}⟩`;
  }
  return out;
}

/**
 * The text a CommonMark parse of `markdown` reads back: each paragraph's text
 * (line breaks as `\n`), joined by a blank line, with every node that is not
 * plain text named in place — `⟨strong⟩…⟨/strong⟩`, `⟨code_inline:x⟩`,
 * `⟨bullet_list_open⟩` — so an expectation written as plain text fails on any
 * live syntax. Unlike {@link renderedText}, it needs no Bun global.
 */
export function readCommonMark(markdown: string): string {
  const parts: string[] = [];
  for (const token of commonMarkParser.parse(markdown, {})) {
    if (token.type === 'inline') parts.push(readInline(token.children ?? []));
    else if (token.type !== 'paragraph_open' && token.type !== 'paragraph_close') {
      parts.push(`⟨${token.type}⟩`);
    }
  }
  return parts.join('\n\n');
}

/** Narrows prompt messages to text content, throwing on any other block kind. */
export function textMessages(messages: PromptMessage[]): TextPromptMessage[] {
  return messages.map((message, index) => {
    if (message.content.type !== 'text') {
      throw new Error(
        `Expected a text prompt message at index ${index}, got "${message.content.type}".`,
      );
    }
    return { ...message, content: message.content };
  });
}
