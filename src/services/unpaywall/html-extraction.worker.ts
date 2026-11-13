/**
 * @fileoverview Worker thread body for `html-extraction.ts`: extracts the one page it
 * is given with the framework's `htmlExtractor` and posts the result back.
 * The runtime loads this file directly — as `.ts` from source, `.js` from `dist/` —
 * outside the server's module graph, so it imports only the framework package and
 * declares its own types: no `@/` alias, no local value import, erasable syntax only.
 * @module src/services/unpaywall/html-extraction.worker
 */

import { parentPort, workerData } from 'node:worker_threads';
import { htmlExtractor } from '@cyanheads/mcp-ts-core/utils';

/** The page to extract, passed as `workerData`. */
export interface ExtractionRequest {
  html: string;
  url: string;
}

/** The worker's one message back: the extracted fields, or the extractor's error message. */
export type ExtractionReply =
  | { ok: true; content: string; title: string | undefined; wordCount: number | undefined }
  | { ok: false; message: string };

const { html, url } = workerData as ExtractionRequest;

let reply: ExtractionReply;
try {
  const { content, title, wordCount } = await htmlExtractor.extract(html, {
    url,
    format: 'markdown',
  });
  reply = { ok: true, content, title, wordCount };
} catch (error: unknown) {
  reply = { ok: false, message: error instanceof Error ? error.message : String(error) };
}
parentPort?.postMessage(reply);
