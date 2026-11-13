/**
 * @fileoverview Stand-in worker body for the HTML extraction tests, loaded in place of
 * the real worker. The request URL's path picks the behavior, and the request HTML is
 * the id the fixture reports under. `/busy` and `/noisy` keep running until the
 * worker is terminated. The runtime loads this file directly, outside vitest's
 * transform, so it uses erasable syntax only and imports nothing local.
 * @module tests/services/unpaywall/fixtures/extraction-fixture.worker
 */

import { workerData } from 'node:worker_threads';

const { html, url } = workerData as { html: string; url: string };

switch (new URL(url).pathname) {
  case '/busy': {
    // Announces itself, then holds its thread the way a slow synchronous
    // extraction does. The test file listens on the same channel name.
    const channel = new BroadcastChannel('html-extraction-fixture');
    channel.postMessage({ started: html });
    channel.close();
    for (;;);
  }
  case '/noisy':
    console.log(html);
    setInterval(() => {}, 60_000);
    break;
  case '/throw':
    throw new Error('fixture worker body failed');
  case '/silent':
    break;
  default:
    throw new Error(`no fixture behavior for ${url}`);
}
