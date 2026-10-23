/**
 * @fileoverview Shared test helpers for narrowing MCP payload unions.
 * `format()` and prompt handlers return `ContentBlock` / `PromptMessage`
 * unions; assertions in these suites read `.text`, so narrow once at the call
 * site instead of guarding at every assertion. Also the rendered view of a
 * `content[]` text, for the Bun lane's render checks.
 * @module tests/_helpers
 */

import type { ContentBlock, PromptMessage } from '@cyanheads/mcp-ts-core';

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
