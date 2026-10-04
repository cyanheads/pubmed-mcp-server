/**
 * @fileoverview `flattenInlineMarkup` on nested inline markup and MathML (#211): PubMed's
 * `%text;` content model (`b | i | sup | sub | u`) nests without limit, and titles,
 * abstracts and keywords also take `mml:math`. Each case runs at the function itself and
 * through the response handler and article parser — the path every flat-parsed PubMed
 * field takes — and the scan is timed against nested and unclosed openers.
 * @module tests/services/ncbi/response-handler.inline-markup.test
 */

import { describe, expect, it } from 'vitest';
import { parseArticleSet } from '@/services/ncbi/parsing/article-parser.js';
import { flattenInlineMarkup, NcbiResponseHandler } from '@/services/ncbi/response-handler.js';
import type { XmlPubmedArticleSet } from '@/services/ncbi/types.js';

const MML = 'xmlns:mml="http://www.w3.org/1998/Math/MathML"';

/** One journal record through the real response handler and article parser. */
function parseRecord(articleXml: string) {
  const xml = `<?xml version="1.0"?><PubmedArticleSet><PubmedArticle><MedlineCitation><PMID>1</PMID>${articleXml}</MedlineCitation></PubmedArticle></PubmedArticleSet>`;
  const parsed = new NcbiResponseHandler().parseAndHandleResponse<{
    PubmedArticleSet: XmlPubmedArticleSet;
  }>(xml, 'efetch');
  const [record] = parseArticleSet(parsed.PubmedArticleSet);
  if (!record) throw new Error('no record parsed');
  return record;
}

describe('flattenInlineMarkup — single-level markup is unchanged', () => {
  it('renders a mixed run of single-level tags exactly as before', () => {
    expect(
      flattenInlineMarkup(
        'Na<sup>+</sup>/K<sup>+</sup>-ATPase, CO<sub>2</sub>, CO<inf>2</inf>, <i>in vivo</i>, <b>P</b> &lt; 0.05, <u>u</u><sc>sc</sc>, V<sub>max</sub>, <sup>13</sup>C, x<sup>foo</sup>, GeneReviews<sup>&#xae;</sup>, AT<sup>&amp;T</sup>, <sup></sup>end',
      ),
    ).toBe(
      'Na⁺/K⁺-ATPase, CO₂, CO₂, in vivo, P &lt; 0.05, usc, V_max, ¹³C, x^foo, GeneReviews®, AT^&amp;T, end',
    );
  });

  it('maps a script inside emphasis, as before', () => {
    expect(flattenInlineMarkup('<i>x<sup>2</sup></i> and <b>H<sub>2</sub>O</b>')).toBe(
      'x² and H₂O',
    );
  });

  it('leaves text with no inline markup byte-identical', () => {
    const xml = '<Root><AbstractText Label="A">P &lt; 0.05 &amp; n=3</AbstractText></Root>';
    expect(flattenInlineMarkup(xml)).toBe(xml);
  });
});

describe('flattenInlineMarkup — nested inline markup (#211)', () => {
  it('keeps a superscript that holds an italic, through the fallback prefix', () => {
    expect(flattenInlineMarkup('<i>miR223</i> <sup>-/<i>y</i></sup> mice')).toBe(
      'miR223 ^-/y mice',
    );
  });

  it('keeps a subscript that holds an italic', () => {
    expect(flattenInlineMarkup('the V<sub><i>max</i></sub> was')).toBe('the V_max was');
  });

  it('maps a script whose emphasized content is mappable', () => {
    expect(flattenInlineMarkup('m<sup><b>2</b></sup> and CO<sub><i>2</i></sub>')).toBe(
      'm² and CO₂',
    );
  });

  it('renders a script inside a script, inner mapped and outer prefixed', () => {
    expect(flattenInlineMarkup('x<sup>a<sub>1</sub>b</sup> y')).toBe('x^a₁b y');
  });

  it('renders three levels of nested scripts', () => {
    expect(flattenInlineMarkup('e<sup>a<sup>b<sup>2</sup>c</sup>d</sup>!')).toBe('e^a^b²cd!');
  });

  it('keeps the words around a nested script apart', () => {
    expect(flattenInlineMarkup('(<i>A</i><sup><i>+/-</i></sup>) mice and <i>B</i>')).toBe(
      '(A^+/-) mice and B',
    );
  });
});

describe('flattenInlineMarkup — MathML and DispFormula (#211)', () => {
  it('flattens an inline mml:math to its text, scripts mapped', () => {
    expect(
      flattenInlineMarkup(
        `in the <mml:math ${MML} overflow="scroll"><mml:mrow><mml:mrow><mml:msubsup><mml:mi mathvariant="sans-serif">&#x3a6;</mml:mi><mml:mn>4</mml:mn><mml:mn>4</mml:mn></mml:msubsup></mml:mrow></mml:mrow></mml:math> model`,
      ),
    ).toBe('in the &#x3a6;₄⁴ model');
  });

  it('prefixes a script MathML cannot map, and writes a fraction with a slash', () => {
    expect(
      flattenInlineMarkup(
        `<mml:math ${MML}><mml:msub><mml:mi>K</mml:mi><mml:mi>m</mml:mi></mml:msub><mml:mo>=</mml:mo><mml:mfrac><mml:mn>1</mml:mn><mml:mn>2</mml:mn></mml:mfrac></mml:math>`,
      ),
    ).toBe('K_m=1/2');
  });

  it('drops whitespace between MathML elements and self-closing elements', () => {
    expect(
      flattenInlineMarkup(
        `a <mml:math ${MML}>\n  <mml:msup>\n    <mml:mi>x</mml:mi>\n    <mml:mn>2</mml:mn>\n  </mml:msup>\n  <mml:mspace width="1em"/>\n  <mml:mtext>for all</mml:mtext>\n</mml:math> b`,
      ),
    ).toBe('a x²for all b');
  });

  it('maps msubsup with an empty subscript slot', () => {
    expect(
      flattenInlineMarkup(
        `<mml:math ${MML}><mml:msubsup><mml:mi>y</mml:mi><mml:none/><mml:mn>3</mml:mn></mml:msubsup></mml:math>`,
      ),
    ).toBe('y³');
  });

  it('nests a MathML script inside a script', () => {
    expect(
      flattenInlineMarkup(
        `<mml:math ${MML}><mml:msup><mml:mi>e</mml:mi><mml:msub><mml:mi>x</mml:mi><mml:mn>1</mml:mn></mml:msub></mml:msup></mml:math>`,
      ),
    ).toBe('e^x₁');
  });

  it('removes the DispFormula wrapper and keeps its formula', () => {
    expect(
      flattenInlineMarkup(
        `then <DispFormula><mml:math ${MML}><mml:mi>n</mml:mi></mml:math></DispFormula> rows`,
      ),
    ).toBe('then n rows');
  });
});

describe('every flat-parsed PubMed field keeps nested markup (#211)', () => {
  const record = parseRecord(
    `<Article><Journal><Title>J</Title></Journal><ArticleTitle>Role of <i>miR223</i> <sup>-/<i>y</i></sup> in the <mml:math ${MML}><mml:msup><mml:mi>x</mml:mi><mml:mn>2</mml:mn></mml:msup></mml:math> model</ArticleTitle><Abstract><AbstractText Label="RESULTS" NlmCategory="RESULTS">LCWE-injected <i>miR223</i> <sup>-/<i>y</i></sup> mice and the V<sub><i>max</i></sub> was <DispFormula><mml:math ${MML}><mml:mfrac><mml:mi>a</mml:mi><mml:mi>b</mml:mi></mml:mfrac></mml:math></DispFormula> high.</AbstractText></Abstract><AuthorList><Author><CollectiveName>The <i>Tbx5</i><sup><i>del</i>/+</sup> Group</CollectiveName></Author><Author><LastName>Lee</LastName><ForeName>Ann</ForeName><Initials>A</Initials><AffiliationInfo><Affiliation>Dept of <b>Ca<sup>2<i>+</i></sup></b> Signalling</Affiliation></AffiliationInfo></Author></AuthorList></Article><KeywordList Owner="NOTNLM"><Keyword MajorTopicYN="N">CO<sub><b>2</b></sub> uptake</Keyword><Keyword MajorTopicYN="N"><mml:math ${MML}><mml:msub><mml:mi>T</mml:mi><mml:mn>1</mml:mn></mml:msub></mml:math> mapping</Keyword></KeywordList>`,
  );

  it('title', () => {
    expect(record.title).toBe('Role of miR223 ^-/y in the x² model');
  });

  it('abstract', () => {
    expect(record.abstractText).toBe(
      'RESULTS: LCWE-injected miR223 ^-/y mice and the V_max was a/b high.',
    );
  });

  it('collective name and author affiliation', () => {
    expect(record.authors?.[0]?.collectiveName).toBe('The Tbx5^del/+ Group');
    expect(record.affiliations).toEqual(['Dept of Ca²⁺ Signalling']);
  });

  it('keywords', () => {
    expect(record.keywords).toEqual(['CO₂ uptake', 'T₁ mapping']);
  });
});

describe('flattenInlineMarkup — linear time on adversarial input (#211)', () => {
  /** CPU time of `run`, in ms — this thread's user + system time, not wall clock. */
  const cpuMs = (run: () => void): number => {
    const start = process.threadCpuUsage();
    run();
    const { user, system } = process.threadCpuUsage(start);
    return (user + system) / 1000;
  };

  /** Fastest of five measurements of ten calls each — the least noisy reading of the work. */
  const fastestMs = (input: string): number => {
    flattenInlineMarkup(input);
    return Math.min(
      ...Array.from({ length: 5 }, () =>
        cpuMs(() => {
          for (let i = 0; i < 10; i++) flattenInlineMarkup(input);
        }),
      ),
    );
  };

  /** Repeat `unit` to exactly `length` characters. */
  const fill = (unit: string, length: number) =>
    unit.repeat(Math.ceil(length / unit.length)).slice(0, length);

  /** `depth` nested openers, one character, and their closers — about `length` characters. */
  const nested = (open: string, close: string, length: number) => {
    const depth = Math.floor(length / (open.length + close.length));
    return `${open.repeat(depth)}x${close.repeat(depth)}`;
  };

  it.each([
    ['nested `<sup>`', (n: number) => nested('<sup>', '</sup>', n)],
    ['nested `<sup>a`', (n: number) => nested('<sup>a', '</sup>', n)],
    ['nested `<sup><i>`', (n: number) => nested('<sup><i>', '</i></sup>', n)],
    [
      'nested MathML `msup`',
      (n: number) => nested('<mml:msup><mml:mi>e</mml:mi>', '</mml:msup>', n),
    ],
    ['`<sup>` with no closer', (n: number) => fill('<sup>', n)],
    ['`<sup>a<i>` with no closer', (n: number) => fill('<sup>a<i>', n)],
    ['`<mml:mi "` with no closing quote', (n: number) => fill('<mml:mi "', n)],
    ['`<mml:mi a="` with no closing quote', (n: number) => fill('<mml:mi a="', n)],
    ['`<mml:math><mml:msup>` with no closer', (n: number) => fill('<mml:math><mml:msup>', n)],
    ['`<DispFormula ` with no `>`', (n: number) => fill('<DispFormula ', n)],
  ])('scales linearly from 5k to 80k characters of %s', (_label, build) => {
    const [t5k, t20k, t80k] = [5_000, 20_000, 80_000].map((n) => fastestMs(build(n)));
    // Linear work grows 16× across the span; quadratic grows 256×.
    expect((t80k ?? 0) / Math.max(t5k ?? 0, 0.001)).toBeLessThan(64);
    expect(t20k).toBeLessThan(400);
    expect(t80k).toBeLessThan(400);
  });

  it('flattens 80k characters of nested scripts to the expected text', () => {
    const depth = 8_000;
    expect(flattenInlineMarkup(`${'<sup>'.repeat(depth)}2${'</sup>'.repeat(depth)}`)).toBe(
      `${'^'.repeat(depth - 1)}²`,
    );
  });
});
