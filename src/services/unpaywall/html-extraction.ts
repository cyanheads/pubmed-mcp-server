/**
 * @fileoverview Extracts an Unpaywall landing page's article text off the serving
 * thread. The framework's `htmlExtractor` runs synchronously and cannot be
 * interrupted, so each extraction gets its own worker thread, which the caller's
 * signal or a fixed 10 s bound stops; at most two run per process at a time. Under
 * a tool call's deadline, the wait for a worker and the worker itself also end
 * when that deadline does, so a page that arrives late cannot hold the call open
 * past it. (#310)
 * @module src/services/unpaywall/html-extraction
 */

import { Worker } from 'node:worker_threads';
import { McpError, timeout } from '@cyanheads/mcp-ts-core/errors';
import { createPacer } from '@cyanheads/mcp-ts-core/utils';
import { type CallDeadline, isSpent, remainingMs } from '@/services/call-deadline.js';

import type { ExtractionReply, ExtractionRequest } from './html-extraction.worker.js';

/**
 * How long one extraction may run, counted from when its worker starts; less when
 * the tool call's deadline has less time left than this.
 */
export const HTML_EXTRACTION_DEADLINE_MS = 10_000;

/**
 * The worker module beside this one: `.ts` while this file runs from source (Bun,
 * or vitest on either runtime), `.js` once built into `dist/`.
 */
const WORKER_URL = new URL(
  `./html-extraction.worker.${import.meta.url.endsWith('.ts') ? 'ts' : 'js'}`,
  import.meta.url,
);

/** Two extraction workers per process; further extractions wait their turn in order. */
const workerSlots = createPacer({ name: 'unpaywall-html-extraction', maxConcurrent: 2 });

/** A page's extracted Markdown, with the title and word count when the page provides them. */
export interface ExtractedHtml {
  content: string;
  title?: string;
  wordCount?: number;
}

/**
 * Extract `html` (fetched from `url`) to Markdown in a worker thread.
 *
 * Rejects with `signal.reason` when `signal` aborts — before the call (even with a
 * spent deadline), while waiting for a worker slot (no worker is started), or
 * mid-extraction (the worker is terminated). An extraction still running after
 * {@link HTML_EXTRACTION_DEADLINE_MS} is terminated and rejects with a `Timeout`
 * McpError naming the deadline. An extractor failure rejects with the extractor's
 * message.
 *
 * Under a tool call's `deadline`, the extraction never outlasts it. A deadline that
 * is spent before a worker starts — as the call is made, or while it waits for a
 * slot — starts none, and rejects with a `Timeout` saying the extraction was not
 * started. A worker started with less than {@link HTML_EXTRACTION_DEADLINE_MS} left
 * is terminated when the deadline runs out, and rejects with a `Timeout` saying the
 * deadline stopped it. Every one of these `Timeout`s carries `data.reason:
 * 'html_extraction_deadline'`. Without `deadline`, only the 10 s bound applies.
 */
export async function extractHtml(
  html: string,
  url: string,
  signal: AbortSignal,
  deadline?: CallDeadline,
): Promise<ExtractedHtml> {
  // The caller's own abort comes first, so a spent deadline never masks it.
  if (signal.aborted) throw signal.reason;
  if (deadline && isSpent(deadline)) throw notStarted();
  try {
    return await workerSlots.run((runSignal) => runWorker({ html, url }, runSignal, deadline), {
      signal,
      ...(deadline && { maxWaitMs: remainingMs(deadline) }),
    });
  } catch (error: unknown) {
    // The pacer sheds a wait that outlasts `maxWaitMs` as a rate limit; here it
    // means the deadline ran out before a slot opened.
    if (error instanceof McpError && error.data?.reason === 'pacer_shed') throw notStarted();
    throw error;
  }
}

/** The rejection of an extraction the tool call's deadline left no time to start. */
function notStarted(): McpError {
  return timeout("HTML extraction was not started: the tool call's deadline left it no time", {
    reason: 'html_extraction_deadline',
  });
}

/** One extraction in its own worker, which has exited by the time this settles. */
async function runWorker(
  request: ExtractionRequest,
  signal: AbortSignal,
  deadline: CallDeadline | undefined,
): Promise<ExtractedHtml> {
  // A slot that frees as the wait for it runs out is still granted, so the deadline
  // can be spent by the time the worker would start.
  if (deadline && isSpent(deadline)) throw notStarted();

  // Defuddle writes some diagnostics to stdout, which on the stdio transport carries
  // only protocol messages; the worker's stdout is sent to stderr instead.
  const worker = new Worker(WORKER_URL, { workerData: request, stdout: true });
  worker.stdout.on('data', (chunk: Buffer) => process.stderr.write(chunk));

  const { promise, resolve, reject } = Promise.withResolvers<ExtractionReply>();
  // The worker stops at its own bound, or at the tool call's deadline when that
  // has less time left.
  const callLeftMs = deadline ? remainingMs(deadline) : Number.POSITIVE_INFINITY;
  const callDeadlineBinds = callLeftMs < HTML_EXTRACTION_DEADLINE_MS;
  const stopTimer = setTimeout(
    () =>
      reject(
        timeout(
          callDeadlineBinds
            ? "HTML extraction was stopped: the tool call's deadline ran out"
            : `HTML extraction did not finish within its ${HTML_EXTRACTION_DEADLINE_MS / 1_000} s deadline and was stopped`,
          { reason: 'html_extraction_deadline' },
        ),
      ),
    callDeadlineBinds ? callLeftMs : HTML_EXTRACTION_DEADLINE_MS,
  );
  const onAbort = () => reject(signal.reason);
  signal.addEventListener('abort', onAbort, { once: true });
  worker.once('message', resolve);
  worker.once('error', reject);
  worker.once('exit', (code) =>
    reject(new Error(`HTML extraction worker exited with code ${code} before replying`)),
  );

  try {
    const reply = await promise;
    if (!reply.ok) throw new Error(reply.message);
    return {
      content: reply.content,
      ...(reply.title !== undefined && { title: reply.title }),
      ...(reply.wordCount !== undefined && { wordCount: reply.wordCount }),
    };
  } finally {
    clearTimeout(stopTimer);
    signal.removeEventListener('abort', onAbort);
    await worker.terminate();
  }
}
