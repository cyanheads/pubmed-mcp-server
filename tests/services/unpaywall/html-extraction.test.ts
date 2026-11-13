/**
 * @fileoverview Tests for off-thread HTML extraction: the worker it runs, the
 * deadline and the caller's signal that stop it, and the per-process worker cap.
 * Workers are real threads throughout. Cases that need a slow, failing, or noisy
 * extraction load a stand-in worker body in place of the real one, through a
 * pass-through wrap of the `Worker` constructor.
 * @module tests/services/unpaywall/html-extraction.test
 */

import type * as WorkerThreads from 'node:worker_threads';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** Whether the next worker loads the stand-in body instead of the real one. */
const fixture = vi.hoisted(() => ({ active: false }));

vi.mock('node:worker_threads', async (importOriginal) => {
  const actual = await importOriginal<typeof WorkerThreads>();
  const fixtureScript = new URL('./fixtures/extraction-fixture.worker.ts', import.meta.url);
  return {
    ...actual,
    Worker: vi.fn(
      class extends actual.Worker {
        constructor(script: URL, options?: WorkerThreads.WorkerOptions) {
          super(fixture.active ? fixtureScript : script, options);
        }
      },
    ),
  };
});

const { Worker } = await import('node:worker_threads');
const { htmlExtractor } = await import('@cyanheads/mcp-ts-core/utils');
const { extractHtml, HTML_EXTRACTION_DEADLINE_MS } = await import(
  '@/services/unpaywall/html-extraction.js'
);

/** Constructor arguments of every worker started in this test. */
const spawnCalls = () => vi.mocked(Worker).mock.calls;
/** Every worker started in this test. */
const spawned = () => vi.mocked(Worker).mock.results.map((r) => r.value as WorkerThreads.Worker);
/** The page id of every worker started in this test, in start order. */
const startedIds = () =>
  spawnCalls().map(([, options]) => (options!.workerData as { html: string }).html);

/**
 * The stand-in's `/busy` body announces itself here once it is running. Its
 * worker is then mid-extraction: holding its thread until terminated.
 */
const channel = new BroadcastChannel('html-extraction-fixture');
const starts = new Map<string, PromiseWithResolvers<void>>();
const startOf = (id: string) => {
  let start = starts.get(id);
  if (!start) {
    start = Promise.withResolvers<void>();
    starts.set(id, start);
  }
  return start;
};
channel.onmessage = (event) => {
  startOf(((event as MessageEvent).data as { started: string }).started).resolve();
};
/** Resolves once the `/busy` stand-in started for page `id` is running. */
const running = (id: string) => startOf(id).promise;
afterAll(() => channel.close());

/** One turn of the calling thread's event loop. */
const turn = () => new Promise<void>((resolve) => setImmediate(resolve));

/** Tracks whether `promise` has settled yet. */
const tracked = (promise: Promise<unknown>) => {
  const state = { settled: false };
  promise.then(
    () => (state.settled = true),
    () => (state.settled = true),
  );
  return state;
};

const BUSY = 'https://fixture.test/busy';
const LANDING_URL = 'https://journal.example.org/articles/10.1000/example';
const LANDING_PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Gut microbiota and sleep quality in older adults | Journal of Examples</title>
<meta name="citation_title" content="Gut microbiota and sleep quality in older adults">
<meta name="description" content="A cohort study of gut microbiota and sleep.">
</head>
<body>
<header><nav><a href="/">Home</a> <a href="/journals">Journals</a> <a href="/about">About</a></nav></header>
<main>
<article>
<h1>Gut microbiota and sleep quality in older adults</h1>
<p>A. Author, B. Author, C. Author</p>
<section>
<h2>Abstract</h2>
<p>Sleep quality declines with age, and the gut microbiota has been linked to sleep regulation in several cohorts. We followed adults over sixty for two years and related stool microbiota composition to actigraphy-measured sleep efficiency.</p>
</section>
<section>
<h2>Methods</h2>
<p>Participants provided stool samples at baseline and at twelve months. Sleep was recorded with wrist actigraphy for seven nights at each visit, and composition was profiled by 16S rRNA sequencing.</p>
<p>Associations were estimated with mixed models adjusted for age, sex, body mass index, and medication use.</p>
</section>
<section>
<h2>Results</h2>
<p>Higher microbial diversity was associated with greater sleep efficiency, and the association held after adjustment.</p>
<table><tr><th>Group</th><th>Participants</th></tr><tr><td>Low diversity</td><td>48</td></tr><tr><td>High diversity</td><td>52</td></tr></table>
</section>
</article>
</main>
<footer><p>Journal of Examples. All rights reserved.</p></footer>
</body>
</html>`;

describe('extractHtml', () => {
  beforeEach(() => {
    fixture.active = false;
    vi.mocked(Worker).mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
    // No worker outlives the test that started it.
    for (const worker of spawned()) expect(worker.threadId).toBe(-1);
  });

  describe('the real worker', () => {
    it('extracts a landing page from the source worker module, matching the in-thread extractor’s content, title, and word count', async () => {
      const offThread = await extractHtml(LANDING_PAGE, LANDING_URL, new AbortController().signal);
      const inThread = await htmlExtractor.extract(LANDING_PAGE, {
        url: LANDING_URL,
        format: 'markdown',
      });

      // The page's own title and a real body, so the comparison below is not vacuous.
      expect(inThread.title).toBe('Gut microbiota and sleep quality in older adults');
      expect(inThread.content).toContain('Higher microbial diversity was associated');
      expect(inThread.wordCount).toBeGreaterThan(50);
      expect(offThread).toEqual({
        content: inThread.content,
        title: inThread.title,
        wordCount: inThread.wordCount,
      });
      expect(spawnCalls()).toHaveLength(1);
      expect(String(spawnCalls()[0]?.[0])).toMatch(
        /\/src\/services\/unpaywall\/html-extraction\.worker\.ts$/,
      );
    });

    it('lets work scheduled on the calling thread run before the extraction settles', async () => {
      // Load the in-thread extractor's dependencies first, so an in-thread run would
      // hold the thread for the extraction itself.
      await htmlExtractor.extract(LANDING_PAGE, { url: LANDING_URL, format: 'markdown' });
      const order: string[] = [];

      const run = extractHtml(LANDING_PAGE, LANDING_URL, new AbortController().signal).then(() =>
        order.push('extraction'),
      );
      setImmediate(() => order.push('setImmediate'));
      await run;

      expect(order).toEqual(['setImmediate', 'extraction']);
    });

    it('rejects with the extractor’s own message when the extractor fails', async () => {
      const inThread = await htmlExtractor
        .extract('   ', { url: LANDING_URL, format: 'markdown' })
        .catch((error: unknown) => error);
      expect(inThread).toBeInstanceOf(Error);

      await expect(
        extractHtml('   ', LANDING_URL, new AbortController().signal),
      ).rejects.toMatchObject({ message: (inThread as Error).message });
    });
  });

  describe('a stand-in worker body', () => {
    beforeEach(() => {
      fixture.active = true;
    });

    it('leaves the calling thread free while the worker extracts', async () => {
      const controller = new AbortController();
      const run = extractHtml('free', BUSY, controller.signal);
      const state = tracked(run);
      await running('free');

      await turn();

      expect(state.settled).toBe(false);
      const reason = new Error('test finished');
      controller.abort(reason);
      await expect(run).rejects.toBe(reason);
    });

    it('stops a worker still running at the deadline and rejects naming the deadline', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const run = extractHtml('deadline', BUSY, new AbortController().signal);
      const state = tracked(run);
      await running('deadline');

      vi.advanceTimersByTime(HTML_EXTRACTION_DEADLINE_MS - 1);
      await turn();
      expect(state.settled).toBe(false);

      vi.advanceTimersByTime(1);
      await expect(run).rejects.toMatchObject({
        code: JsonRpcErrorCode.Timeout,
        message: 'HTML extraction did not finish within its 10 s deadline and was stopped',
        data: { reason: 'html_extraction_deadline' },
      });
      expect(spawned()[0]?.threadId).toBe(-1);
    });

    it('stops the worker when the signal aborts mid-extraction and rejects with the signal’s reason', async () => {
      const controller = new AbortController();
      const reason = new DOMException('The client went away', 'AbortError');
      const run = extractHtml('abort', BUSY, controller.signal);
      await running('abort');

      controller.abort(reason);

      await expect(run).rejects.toBe(reason);
      expect(spawned()[0]?.threadId).toBe(-1);
    });

    it('rejects with the reason at once, starting no worker, when the signal has already aborted', async () => {
      const reason = new Error('already cancelled');

      await expect(extractHtml('pre-aborted', BUSY, AbortSignal.abort(reason))).rejects.toBe(
        reason,
      );
      expect(spawnCalls()).toHaveLength(0);
    });

    it('runs at most two workers at once, in order, and never starts one for a queued extraction whose signal aborts', async () => {
      const ids = ['cap-0', 'cap-1', 'cap-2', 'cap-3'];
      const controllers = ids.map(() => new AbortController());
      const runs = ids.map((id, i) =>
        extractHtml(id, BUSY, controllers[i]!.signal).catch((error: unknown) => error),
      );

      expect(startedIds()).toEqual(['cap-0', 'cap-1']);

      const queuedReason = new Error('cancelled while queued');
      controllers[3]!.abort(queuedReason);
      expect(await runs[3]).toBe(queuedReason);
      expect(startedIds()).toEqual(['cap-0', 'cap-1']);

      await Promise.all([running('cap-0'), running('cap-1')]);
      controllers[0]!.abort(new Error('test finished'));
      await runs[0];
      // The freed slot's worker has exited by the time the next one takes it.
      expect(spawned()[0]?.threadId).toBe(-1);
      expect(startedIds()).toEqual(['cap-0', 'cap-1', 'cap-2']);

      await running('cap-2');
      controllers[1]!.abort(new Error('test finished'));
      controllers[2]!.abort(new Error('test finished'));
      await Promise.all(runs);
      expect(startedIds()).toEqual(['cap-0', 'cap-1', 'cap-2']);
    });

    it('starts a queued extraction’s deadline when its worker starts, not when it was queued', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const deadlineError = { code: JsonRpcErrorCode.Timeout };
      const firstController = new AbortController();
      const first = extractHtml('first', BUSY, firstController.signal).catch(
        (error: unknown) => error,
      );
      const second = extractHtml('second', BUSY, new AbortController().signal);
      const queued = extractHtml('queued', BUSY, new AbortController().signal);
      const queuedState = tracked(queued);
      await Promise.all([running('first'), running('second')]);

      // The queued extraction takes the first slot one millisecond before the
      // second extraction's deadline.
      vi.advanceTimersByTime(HTML_EXTRACTION_DEADLINE_MS - 1);
      firstController.abort(new Error('test finished'));
      await first;
      await running('queued');

      vi.advanceTimersByTime(1);
      await expect(second).rejects.toMatchObject(deadlineError);
      await turn();
      expect(queuedState.settled).toBe(false);

      vi.advanceTimersByTime(HTML_EXTRACTION_DEADLINE_MS - 2);
      await turn();
      expect(queuedState.settled).toBe(false);

      vi.advanceTimersByTime(1);
      await expect(queued).rejects.toMatchObject(deadlineError);
    });

    it('sends what the worker writes to stdout to stderr, leaving stdout to the protocol', async () => {
      const line = 'stand-in worker stdout line';
      const landed = Promise.withResolvers<'stdout' | 'stderr'>();
      const watch = (stream: 'stdout' | 'stderr') =>
        vi.spyOn(process[stream], 'write').mockImplementation(((chunk: unknown) => {
          if (String(chunk).includes(line)) landed.resolve(stream);
          return true;
        }) as typeof process.stdout.write);
      const stdout = watch('stdout');
      const stderr = watch('stderr');
      const controller = new AbortController();
      const run = extractHtml(line, 'https://fixture.test/noisy', controller.signal).catch(
        (error: unknown) => error,
      );

      try {
        expect(await landed.promise).toBe('stderr');
      } finally {
        controller.abort(new Error('test finished'));
        await run;
        stdout.mockRestore();
        stderr.mockRestore();
      }
    });

    it.each([
      ['throws before replying', '/throw', 'fixture worker body failed'],
      [
        'exits without replying',
        '/silent',
        'HTML extraction worker exited with code 0 before replying',
      ],
    ])('rejects when the worker %s', async (_case, path, message) => {
      await expect(
        extractHtml('failure', `https://fixture.test${path}`, new AbortController().signal),
      ).rejects.toThrow(message);
    });
  });
});
