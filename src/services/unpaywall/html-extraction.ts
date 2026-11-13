/**
 * @fileoverview Extracts an Unpaywall landing page's article text off the serving
 * thread. The framework's `htmlExtractor` runs synchronously and cannot be
 * interrupted, so each extraction gets its own worker thread, which the caller's
 * signal or a fixed deadline stops; at most two run per process at a time.
 * @module src/services/unpaywall/html-extraction
 */

import { Worker } from 'node:worker_threads';
import { timeout } from '@cyanheads/mcp-ts-core/errors';
import { createPacer } from '@cyanheads/mcp-ts-core/utils';

import type { ExtractionReply, ExtractionRequest } from './html-extraction.worker.js';

/** How long one extraction may run, counted from when its worker starts. */
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
 * Rejects with `signal.reason` when `signal` aborts — while waiting for a worker
 * slot (no worker is started) or mid-extraction (the worker is terminated). An
 * extraction still running after {@link HTML_EXTRACTION_DEADLINE_MS} is terminated
 * and rejects with a `Timeout` McpError naming the deadline. An extractor failure
 * rejects with the extractor's message.
 */
export function extractHtml(
  html: string,
  url: string,
  signal: AbortSignal,
): Promise<ExtractedHtml> {
  return workerSlots.run((runSignal) => runWorker({ html, url }, runSignal), { signal });
}

/** One extraction in its own worker, which has exited by the time this settles. */
async function runWorker(request: ExtractionRequest, signal: AbortSignal): Promise<ExtractedHtml> {
  // Defuddle writes some diagnostics to stdout, which on the stdio transport carries
  // only protocol messages; the worker's stdout is sent to stderr instead.
  const worker = new Worker(WORKER_URL, { workerData: request, stdout: true });
  worker.stdout.on('data', (chunk: Buffer) => process.stderr.write(chunk));

  const { promise, resolve, reject } = Promise.withResolvers<ExtractionReply>();
  const deadline = setTimeout(
    () =>
      reject(
        timeout(
          `HTML extraction did not finish within its ${HTML_EXTRACTION_DEADLINE_MS / 1_000} s deadline and was stopped`,
          { reason: 'html_extraction_deadline' },
        ),
      ),
    HTML_EXTRACTION_DEADLINE_MS,
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
    clearTimeout(deadline);
    signal.removeEventListener('abort', onAbort);
    await worker.terminate();
  }
}
