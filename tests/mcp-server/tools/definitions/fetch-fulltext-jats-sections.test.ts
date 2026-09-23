/**
 * @fileoverview End-to-end coverage for how `pubmed_fetch_fulltext` titles,
 * budgets, and points body content, run through the real JATS parser, the real
 * NcbiService, and the real handler behind a stubbed global fetch serving a
 * fixture shaped like PMC13546078: a `<body>` that opens with a titled
 * `<def-list>` outside any `<sec>`, a Methods section carried by five labelled
 * subsections, and a figure whose `<graphic>`s sit under `<alternatives>`.
 *
 * Nothing here mocks the parser or the budget pass, so each assertion runs the
 * code it describes: a body-level block's own `<title>` becoming its section's
 * title (#148), word-boundary cuts and dropped subsections under
 * `maxCharacters` (#143), and a figure pointer resolved under `<alternatives>`
 * (#142). The `<alternatives>` figure shape did not occur in a ~2,000-figure
 * live sample, so its markup is built from the JATS content model rather than
 * copied from a record.
 * @module tests/mcp-server/tools/definitions/fetch-fulltext-jats-sections.test
 */

import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { textBlocks } from '../../../_helpers.js';

vi.mock('@cyanheads/mcp-ts-core/utils', async () => {
  const actual = await vi.importActual<typeof import('@cyanheads/mcp-ts-core/utils')>(
    '@cyanheads/mcp-ts-core/utils',
  );
  return {
    ...actual,
    logger: { debug: vi.fn(), info: vi.fn(), notice: vi.fn(), warning: vi.fn(), error: vi.fn() },
    requestContextService: { createRequestContext: vi.fn(() => ({ requestId: 'test' })) },
  };
});

// Before the tool modules load: the fulltext tool reads the server config at import time.
vi.stubEnv('NCBI_API_KEY', '');
vi.stubEnv('NCBI_REQUEST_DELAY_MS', '50');
vi.stubEnv('EUROPEPMC_ENABLED', 'false');
vi.stubEnv('UNPAYWALL_EMAIL', '');

const { initNcbiService } = await import('@/services/ncbi/ncbi-service.js');
const { fetchFulltextTool } = await import('@/mcp-server/tools/definitions/fetch-fulltext.tool.js');

const STUDY_DESIGN =
  'The transitivity assumption (a prerequisite for valid indirect comparisons) was assessed by comparing effect modifiers across comparisons.';
const SEARCH = 'We searched PubMed, Embase, and the Cochrane Library from inception to June 2025.';
const ELIGIBILITY =
  'Randomized trials comparing bariatric surgery with GLP-1 receptor agonists were eligible.';
const SELECTION =
  'Two reviewers screened records independently and extracted outcome data in duplicate.';
const STATISTICS =
  'A frequentist network meta-analysis estimated hazard ratios with random effects.';
const INTRO = 'Obesity is a major global health issue and a driver of cardiovascular risk.';

const subsection = (label: string, title: string, text: string) =>
  `<sec><label>${label}</label><title>${title}</title><p>${text}</p></sec>`;

/** PMC13546078's body shape, trimmed. */
const ARTICLE = `<article article-type="research-article"><front><article-meta>
<article-id pub-id-type="pmcid">PMC13546078</article-id>
<title-group><article-title>Bariatric surgery versus GLP-1 receptor agonists</article-title></title-group>
<abstract><p>Background: Obesity, a major global health issue, is linked to cardiovascular events.</p></abstract>
</article-meta></front><body>
<def-list list-content="abbreviations"><title>Abbreviations</title>
<def-item><term>BS</term><def><p>bariatric surgery</p></def></def-item>
<def-item><term>CV</term><def><p>cardiovascular</p></def></def-item>
<def-item><term>NMA</term><def><p>network meta-analysis</p></def></def-item>
</def-list>
<sec><label>1</label><title>Introduction</title><p>${INTRO}</p></sec>
<sec><label>2</label><title>Methods</title>
${subsection('2.1', 'Study Design', STUDY_DESIGN)}
${subsection('2.2', 'Search Strategy', SEARCH)}
${subsection('2.3', 'Eligibility Criteria', ELIGIBILITY)}
${subsection('2.4', 'Study Selection and Data Collection and Extraction', SELECTION)}
${subsection('2.5', 'Statistical Analysis', STATISTICS)}
</sec>
<sec><label>3</label><title>Results</title><p>Twelve trials met the inclusion criteria.</p>
<fig id="Fig1"><label>Figure 1</label><caption><p>Network of treatment comparisons.</p></caption>
<alternatives>
<graphic xlink:href="edm2-70311-g001.tif" specific-use="print" mimetype="image" mime-subtype="tiff"/>
<graphic xlink:href="edm2-70311-g001.jpg" specific-use="web" mimetype="image" mime-subtype="jpeg"/>
</alternatives></fig>
</sec>
</body></article>`;

/** Characters the abbreviations list contributes once its title is lifted out. */
const ABBREVIATIONS_TEXT =
  '- BS — bariatric surgery\n- CV — cardiovascular\n- NMA — network meta-analysis';

/** A section title carrying every Markdown delimiter the inline escape handles. */
const MARKUP_TITLE = 'Assessment of *risk*, `dose` and _exposure_ [draft]';

/**
 * The four title shapes #169 names, in one body: a titled body-level box
 * holding figures — one directly, one in a `<sec>` the box flattens into its
 * text — a titled section holding a box whose caption has a title and a
 * paragraph, and an untitled `<sec>` wrapping a titled `<def-list>`
 * (PMC12696417's shape) — plus a titled `<sec>` around a titled `<def-list>`,
 * which keeps its own title.
 */
const TITLES_ARTICLE = `<article article-type="research-article"><front><article-meta>
<article-id pub-id-type="pmcid">PMC12696417</article-id>
<title-group><article-title>Safety of a feed additive</article-title></title-group>
</article-meta></front><body>
<boxed-text id="box0"><caption><title>Key points</title><p>What the panel concluded.</p></caption>
<p>The additive is safe for the target species.</p>
<fig id="BoxFig1"><label>Figure B1</label><caption><p>Exposure pathways.</p></caption><graphic xlink:href="box-fig1.jpg"/></fig>
<sec><title>Uncertainties</title><p>Data gaps remain.</p><fig id="BoxFig2"><label>Figure B2</label><graphic xlink:href="box-fig2.jpg"/></fig></sec>
</boxed-text>
<sec><label>1</label><title>${MARKUP_TITLE}</title><p>Assessment text.</p>
<boxed-text id="box1"><caption><title>Box 1</title><p>Summary.</p></caption><p>Box body.</p></boxed-text>
</sec>
<sec><def-list list-content="abbreviations"><title>ABBREVIATIONS</title>
<def-item><term>ANOVA</term><def><p>analysis of variance</p></def></def-item>
<def-item><term>BW</term><def><p>body weight</p></def></def-item>
</def-list></sec>
<sec><title>Glossary</title><def-list><title>Terms</title>
<def-item><term>CAS</term><def><p>Chemical Abstracts Service</p></def></def-item>
</def-list></sec>
</body></article>`;

/** Saved PMC EFetch payloads by the id requested. */
const ARTICLES: Record<string, string> = { '13546078': ARTICLE, '12696417': TITLES_ARTICLE };

let fetchSpy: ReturnType<typeof vi.spyOn>;

beforeAll(() => {
  fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = new URL(String(input));
    const article = ARTICLES[url.searchParams.get('id') ?? ''];
    if (url.pathname.endsWith('/efetch.fcgi') && url.searchParams.get('db') === 'pmc' && article) {
      return new Response(`<?xml version="1.0"?><pmc-articleset>${article}</pmc-articleset>`, {
        status: 200,
      });
    }
    throw new Error(`unexpected request ${url.href}`);
  });
  initNcbiService();
});

afterAll(() => {
  fetchSpy.mockRestore();
  vi.unstubAllEnvs();
});

async function fetchFulltext(extra: Record<string, unknown> = {}) {
  const ctx = createMockContext({ errors: fetchFulltextTool.errors });
  const result = await fetchFulltextTool.handler(
    fetchFulltextTool.input.parse({
      pmcids: ['PMC13546078'],
      includeTables: false,
      ...extra,
    }),
    ctx,
  );
  const text = textBlocks(fetchFulltextTool.format!(result))
    .map((b) => b.text)
    .join('\n');
  const article = result.articles[0];
  if (article?.source !== 'pmc') throw new Error('expected a pmc article');
  return { result, article, ctx, text };
}

describe('pubmed_fetch_fulltext over parsed JATS', () => {
  it('titles the body-level abbreviations list and heads it in content[] (#148)', async () => {
    const { article, result, text } = await fetchFulltext();

    expect(article.sections[0]).toEqual({ title: 'Abbreviations', text: ABBREVIATIONS_TEXT });
    expect(text).toContain(
      `#### Abstract\nBackground: Obesity, a major global health issue, is linked to cardiovascular events.\n\n#### Abbreviations\n${ABBREVIATIONS_TEXT}\n\n#### 1 Introduction`,
    );
    expect(result.truncation).toBeUndefined();
  });

  it('labels the same entry Abbreviations in the ledger under an outline budget (#148)', async () => {
    const { result, text } = await fetchFulltext({ maxCharacters: 200, overflowMode: 'outline' });

    const ledger = result.truncation?.articles[0]?.sections ?? [];
    expect(ledger[0]).toMatchObject({ title: 'Abbreviations' });
    expect(ledger[0]?.originalCharacters).toBe(ABBREVIATIONS_TEXT.length);
    expect(text).toMatch(/^ {2}- Abbreviations — \d+ of 76 characters/m);
    expect(text).not.toContain('untitled section');
    expect(text).toContain('\n#### Abbreviations\n');
  });

  it('cuts at a word boundary and drops the subsections past the cut (#143)', async () => {
    // Abbreviations (76) and Introduction (75) fit whole; 70 characters remain
    // for Methods, which a character cut would end inside "comparisons".
    const budget = ABBREVIATIONS_TEXT.length + INTRO.length + 70;
    const { article, result, ctx, text } = await fetchFulltext({ maxCharacters: budget });

    const methods = article.sections[2];
    expect(methods?.title).toBe('Methods');
    expect(methods?.subsections).toEqual([
      {
        label: '2.1',
        title: 'Study Design',
        text: 'The transitivity assumption (a prerequisite for valid indirect',
      },
    ]);
    expect(article.sections.map((s) => s.title)).toEqual([
      'Abbreviations',
      'Introduction',
      'Methods',
    ]);
    // Four Methods subsections and Results are dropped.
    expect(result.truncation?.omittedSections).toBe(5);
    expect(result.truncation?.returnedCharacters).toBe(
      ABBREVIATIONS_TEXT.length + INTRO.length + 62,
    );
    expect(result.truncation?.articles[0]?.sections?.[2]?.subsections?.map((s) => s.title)).toEqual(
      [
        'Study Design',
        'Search Strategy',
        'Eligibility Criteria',
        'Study Selection and Data Collection and Extraction',
        'Statistical Analysis',
      ],
    );
    expect(getEnrichment(ctx).notice).toContain('5 section(s) were dropped');
    expect(text).not.toContain('##### 2.2 Search Strategy');
    expect(text).toContain(`    - 2.2 Search Strategy — 0 of ${SEARCH.length} characters`);
  });

  it('resolves the figure pointer under <alternatives>, preferring the web rendering (#142)', async () => {
    const { article, text } = await fetchFulltext();

    expect(article.assets).toEqual([
      {
        assetType: 'figure',
        id: 'Fig1',
        label: 'Figure 1',
        caption: 'Network of treatment comparisons.',
        sectionTitle: 'Results',
        href: 'edm2-70311-g001.jpg',
      },
    ]);
    expect(text).toContain('file: edm2-70311-g001.jpg');
    expect(text).toContain('[Figure: Figure 1]');
  });
});

describe('pubmed_fetch_fulltext section and box titles (#169)', () => {
  const titled = (extra: Record<string, unknown> = {}) =>
    fetchFulltext({ pmcids: ['PMC12696417'], ...extra });

  it('titles an untitled <sec> with its lone titled <def-list>', async () => {
    const { article, text } = await titled();

    expect(article.sections[2]).toEqual({
      title: 'ABBREVIATIONS',
      text: '- ANOVA — analysis of variance\n- BW — body weight',
    });
    expect(text).toContain('\n#### ABBREVIATIONS\n- ANOVA — analysis of variance\n');
    expect(text).not.toContain('untitled section');
    // A titled <sec> keeps its own title, and the list's stays in its text.
    expect(article.sections[3]).toEqual({
      title: 'Glossary',
      text: 'Terms\n- CAS — Chemical Abstracts Service',
    });
    expect(text).toContain('\n#### Glossary\nTerms\n- CAS — Chemical Abstracts Service');
  });

  it('renders a box caption title and paragraph as separate lines', async () => {
    const { article, text } = await titled();

    expect(article.sections[1]?.text).toBe('Assessment text.\n\nBox 1\n\nSummary.\n\nBox body.');
    expect(text).toContain('Assessment text.\n\nBox 1\n\nSummary.\n\nBox body.');
    // A lifted box loses only its title, never its caption paragraph.
    expect(article.sections[0]).toEqual({
      title: 'Key points',
      text: 'What the panel concluded.\n\nThe additive is safe for the target species.\n\n[Figure: Figure B1]\n\nUncertainties\nData gaps remain.\n\n[Figure: Figure B2]',
    });
  });

  it('names a lifted box as the section of every figure inside it', async () => {
    const { article, text } = await titled();

    // The box's own <sec> is flattened into its text, so it is not a section a
    // figure can name — the box is, however deep inside it the figure sits.
    expect(article.assets).toEqual([
      {
        assetType: 'figure',
        id: 'BoxFig1',
        label: 'Figure B1',
        caption: 'Exposure pathways.',
        sectionTitle: 'Key points',
        href: 'box-fig1.jpg',
      },
      {
        assetType: 'figure',
        id: 'BoxFig2',
        label: 'Figure B2',
        sectionTitle: 'Key points',
        href: 'box-fig2.jpg',
      },
    ]);
    expect(text).toContain('*figure · Section: Key points · id: BoxFig1 · file: box-fig1.jpg*');
    expect(text).toContain('*figure · Section: Key points · id: BoxFig2 · file: box-fig2.jpg*');

    const filtered = await titled({ sections: ['Key points'] });
    expect(filtered.article.sections.map((s) => s.title)).toEqual(['Key points']);
    expect(filtered.article.assets?.map((a) => a.id)).toEqual(['BoxFig1', 'BoxFig2']);
    expect(filtered.text).toContain('#### Assets (2)');
  });

  it('escapes Markdown in section titles in body headings and ledger lines', async () => {
    const escaped = '1 Assessment of \\*risk\\*, \\`dose\\` and \\_exposure\\_ \\[draft\\]';
    const { article, result, text } = await titled({ maxCharacters: 40, overflowMode: 'outline' });

    // structuredContent keeps the plain title; only the render is escaped.
    expect(article.sections[1]?.title).toBe(MARKUP_TITLE);
    expect(result.truncation?.articles[0]?.sections?.[1]?.title).toBe(MARKUP_TITLE);
    expect(text).toContain(`\n#### ${escaped}\n`);
    expect(text.split('\n').some((line) => line.startsWith(`  - ${escaped} — `))).toBe(true);
    expect(text).not.toContain(`#### 1 ${MARKUP_TITLE}`);
  });
});
