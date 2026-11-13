/**
 * @fileoverview Shared test helpers for narrowing MCP payload unions.
 * `format()` and prompt handlers return `ContentBlock` / `PromptMessage`
 * unions; assertions in these suites read `.text`, so narrow once at the call
 * site instead of guarding at every assertion. Also the rendered view of a
 * `content[]` text, for the Bun lane's render checks, and its CommonMark
 * reading, for checks that run on every lane. And the per-call CPU time the
 * linear-time tables measure.
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

/** ` title=TITLE` for a link or image that has a title; nothing otherwise. */
const titleOf = (token: Token) => {
  const title = token.attrGet('title');
  return title ? ` title=${title}` : '';
};

function readInline(children: Token[]): string {
  let out = '';
  for (const token of children) {
    if (token.type === 'text' || token.type === 'text_special') out += token.content;
    else if (token.type === 'softbreak') out += '\n';
    else if (token.type === 'hardbreak') out += '⟨br⟩\n';
    else if (token.type === 'link_open') {
      out += `⟨a href=${token.attrGet('href')}${titleOf(token)}⟩`;
    } else if (token.type === 'image') {
      const alt = readInline(token.children ?? []);
      out += `⟨img src=${token.attrGet('src')}${titleOf(token)}⟩${alt}⟨/img⟩`;
    } else if (token.nesting === 1) out += `⟨${token.tag}⟩`;
    else if (token.nesting === -1) out += `⟨/${token.tag}⟩`;
    else out += `⟨${token.type}:${token.content}⟩`;
  }
  return out;
}

/** The marker a block token reads as, or `undefined` for a paragraph's open and close. */
function readBlock(token: Token): string | undefined {
  switch (token.type) {
    case 'paragraph_open':
    case 'paragraph_close':
      return undefined;
    case 'fence': {
      const info = token.info.trim();
      return `⟨fence${info ? ` ${info}` : ''}:${token.content}⟩`;
    }
    case 'code_block':
    case 'html_block':
      return `⟨${token.type}:${token.content}⟩`;
    case 'heading_open':
    case 'heading_close':
      return `⟨${token.type} ${token.tag}⟩`;
    case 'ordered_list_open': {
      const start = token.attrGet('start');
      return start === null ? '⟨ordered_list_open⟩' : `⟨ordered_list_open start=${start}⟩`;
    }
    default:
      return `⟨${token.type}⟩`;
  }
}

/**
 * The text a CommonMark parse of `markdown` reads back: each paragraph's text,
 * joined by a blank line, with every node that is not plain text named in place
 * so an expectation written as plain text fails on any live syntax, and a wrong
 * link target, heading level or fenced line fails too. Unlike
 * {@link renderedText}, it needs no Bun global.
 *
 * - Inline: `⟨strong⟩…⟨/strong⟩`, `⟨code_inline:x⟩`, `⟨a href=HREF⟩text⟨/a⟩`
 *   and `⟨img src=SRC⟩alt⟨/img⟩` (HREF and SRC as markdown-it normalizes them,
 *   ` title=TITLE` only when there is one). A soft break reads `\n`, a hard
 *   break `⟨br⟩\n`.
 * - Block: `⟨bullet_list_open⟩`, `⟨heading_open h2⟩`, `⟨ordered_list_open start=3⟩`
 *   (no `start` when the list starts at 1), and the content of a fence, code
 *   block or HTML block verbatim, final newline included — `⟨fence js:CONTENT⟩`
 *   (`⟨fence:CONTENT⟩` with no info string), `⟨code_block:CONTENT⟩`,
 *   `⟨html_block:CONTENT⟩`.
 */
export function readCommonMark(markdown: string): string {
  const parts: string[] = [];
  for (const token of commonMarkParser.parse(markdown, {})) {
    const part = token.type === 'inline' ? readInline(token.children ?? []) : readBlock(token);
    if (part !== undefined) parts.push(part);
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

/** Calls per reading of a `size`-character input: below 40k, a batch of 40k characters of work. */
const callsPerReading = (size: number) => Math.max(1, Math.ceil(40_000 / size));

/** This thread's user + system CPU time since `start`, in ms — never wall clock. */
function cpuMsSince(start: NodeJS.CpuUsage): number {
  const { user, system } = process.threadCpuUsage(start);
  return (user + system) / 1000;
}

/**
 * CPU time of one call of `run` on a `size`-character input, in ms: the least of
 * three readings, the first doubling as warm-up. Below 40k characters a reading
 * times a batch of 40k/`size` calls and divides by the count, so a small input
 * still reads well above the clock's resolution. A linear-time table calls it once
 * per size and checks the result against its bound before timing the next size.
 *
 * `until`, when given, ends the readings at the first least it accepts. It must
 * accept every value below one it accepts — an upper bound — so the verdict
 * matches the least of all three while a passing size costs one reading.
 */
export function cpuMsPerCall(
  size: number,
  run: () => void,
  until?: (leastMs: number) => boolean,
): number {
  const calls = callsPerReading(size);
  let least = Number.POSITIVE_INFINITY;
  for (let reading = 0; reading < 3; reading++) {
    const start = process.threadCpuUsage();
    for (let call = 0; call < calls; call++) run();
    least = Math.min(least, cpuMsSince(start) / calls);
    if (until?.(least)) break;
  }
  return least;
}

/** {@link cpuMsPerCall} for an async `run`, each call awaited until it settles. */
export async function cpuMsPerCallAsync(
  size: number,
  run: () => Promise<unknown>,
): Promise<number> {
  const calls = callsPerReading(size);
  let least = Number.POSITIVE_INFINITY;
  for (let reading = 0; reading < 3; reading++) {
    const start = process.threadCpuUsage();
    for (let call = 0; call < calls; call++) await run();
    least = Math.min(least, cpuMsSince(start) / calls);
  }
  return least;
}
