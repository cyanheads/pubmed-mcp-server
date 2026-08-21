/**
 * @fileoverview Shared test helpers for narrowing MCP payload unions.
 * `format()` and prompt handlers return `ContentBlock` / `PromptMessage`
 * unions; assertions in these suites read `.text`, so narrow once at the call
 * site instead of guarding at every assertion.
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
