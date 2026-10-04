/**
 * @fileoverview End-to-end coverage of how JATS text structure reaches both
 * surfaces of `pubmed_fetch_fulltext`: the real JATS parser and the real tool,
 * with only the NCBI service stubbed to return the ordered parse of an EFetch
 * body. Covers line boundaries in table cells and footnotes (#185), affiliations
 * at every front-matter level and of authors only (#196), adjacent citation
 * markers (#197), the line layout of lists in list items (#200, #203) and in
 * abstracts (#202), institution ids in funding prose (#208), reference fields
 * (#209), and boxed text set apart from the body (#210).
 * @module tests/mcp-server/tools/definitions/fetch-fulltext-jats-text.test
 */

import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { XMLParser } from 'fast-xml-parser';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ORDERED_XML_PARSER_OPTIONS } from '@/services/ncbi/parsing/ordered-xml-parser-options.js';

const mockEFetch = vi.fn();
const mockIdConvert = vi.fn();

vi.mock('@/services/ncbi/ncbi-service.js', () => ({
  getNcbiService: () => ({ eFetch: mockEFetch, idConvert: mockIdConvert }),
}));
vi.mock('@/services/europe-pmc/europe-pmc-service.js', () => ({
  getEuropePmcService: () => undefined,
}));
vi.mock('@/services/unpaywall/unpaywall-service.js', () => ({
  getUnpaywallService: () => undefined,
}));

const { fetchFulltextTool } = await import('@/mcp-server/tools/definitions/fetch-fulltext.tool.js');

/**
 * PMC10164684, PMC11176230 and PMC13581315 reduced to one EFetch body: the
 * Table 1 footer with four `<fn>`s, the Table 2 header cell split by `<break/>`,
 * a four-line `<break/>` cell, affiliations inside `<contrib-group>` with a ROR
 * id, a bracketed run of four citation markers with nothing between them,
 * PMC12892673's sub-list nested inside its parent item's `<p>`, PMC10869376's
 * "Key points" abstract section that is a list, an item with prose after a
 * sub-list that is a direct child of the item, PMC10666927's editor
 * `<contrib-group>` and Box 1, PMC11609225's funding statement, and
 * PMC10754557/PMC11292240 references.
 */
const EFETCH_BODY = `<?xml version="1.0"?>
<pmc-articleset><article article-type="research-article"><front><article-meta>
<article-id pub-id-type="pmcid">PMC10164684</article-id>
<title-group><article-title>Boundary Article</article-title></title-group>
<contrib-group><contrib contrib-type="author"><name><surname>Post</surname><given-names>Adrian</given-names></name><xref ref-type="aff" rid="aff1">1</xref></contrib>
<aff id="aff1"><label>1</label><institution-wrap><institution-id institution-id-type="ROR">https://ror.org/03cv38k47</institution-id><institution>University Medical Center Groningen</institution></institution-wrap>, Groningen, The Netherlands</aff>
<aff id="aff2"><label>2</label>Division of Gastroenterology, University of Washington, Seattle, Washington, USA</aff></contrib-group>
<contrib-group><contrib contrib-type="editor"><name><surname>Zaidi</surname><given-names>Mone</given-names></name><role>Reviewing Editor</role><aff><institution-wrap><institution-id institution-id-type="ror">https://ror.org/04a9tmd77</institution-id><institution>Icahn School of Medicine at Mount Sinai</institution></institution-wrap><country>United States</country></aff></contrib></contrib-group>
<abstract><sec><title>Abstract</title><p>Type 2 diabetes mellitus was reported to be associated with impaired immune response.</p></sec><sec><title>Key points</title><p id="Par2">
<list list-type="bullet"><list-item><p id="Par3">
<italic toggle="yes">Hyperglycemia may suppress tryptophanase activity.</italic>
</p></list-item><list-item><p id="Par4">
<italic toggle="yes">A low abundance of</italic> anti-inflammatory bacteria <italic toggle="yes">may induce an inflammatory response.</italic></p></list-item></list>
</p></sec></abstract>
</article-meta></front><body>
<sec><title>Introduction</title><p>Cystic fibrosis is increasingly recognised among Asians.[<xref rid="R1" ref-type="bibr">1</xref><xref rid="R2" ref-type="bibr">2</xref><xref rid="R3" ref-type="bibr">3</xref><xref rid="R4" ref-type="bibr">4</xref>]</p></sec>
<sec><title>Results</title>
<table-wrap id="T1"><label>Table 1</label><table><thead><tr><th>Characteristic</th></tr></thead><tbody><tr><td>Age</td></tr></tbody></table>
<table-wrap-foot><fn id="TFN1"><p id="P50">Abbreviations: OCS, oral corticosteroids.</p></fn><fn id="TFN2"><label>+</label><p id="P51">66 (97%) of the 68% patients on dupilumab were using the 300 mg every 2-week dose.</p></fn><fn id="TFN3"><label>*</label><p id="P52">No patient within this cohort was uninsured</p></fn><fn id="TFN4"><label>#</label><p id="P53">The five patients on omalizumab all had IgE within the accepted level.</p></fn></table-wrap-foot></table-wrap>
<table-wrap id="T2"><label>Table 2</label><table><thead><tr><th align="left" valign="bottom" rowspan="1" colspan="1">EXACERBATION RATE RATIOS<break/>IRR (95% CI)</th><th>MEPOLIZUMAB</th></tr></thead>
<tbody><tr><td>KTR<break/><italic toggle="yes">n</italic>\u2009=\u2009157<break/>mean measured GFR: 57\u2009±\u200920<break/>95 percentile range: 25–87</td><td>1.08<break/>2.44</td></tr></tbody></table></table-wrap>
</sec>
<sec><title>Recommendations</title><p id="para40">We agreed on the following priorities:<list list-type="simple" id="celist10"><list-item id="celistitem10"><label>-</label><p id="para50">PREVENTION:<list list-type="simple" id="celist20"><list-item id="celistitem20"><label>•</label><p id="para60">Implementation and education of known risk factors;</p></list-item><list-item id="celistitem30"><label>•</label><p id="para70">Large interventional studies.</p></list-item></list></p></list-item></list></p></sec>
<sec><title>Procedure</title><list list-type="bullet"><list-item><p>Prepare the sample.</p><list list-type="bullet"><list-item><p>Centrifuge it.</p></list-item></list><p>Then record the yield.</p></list-item></list></sec>
<sec><title>Funding</title><p>This research was sponsored by the <funding-source id="gsp0010"><institution-wrap><institution-id institution-id-type="doi">10.13039/501100001809</institution-id><institution>National Natural Science Foundation of China</institution></institution-wrap></funding-source> grant No. <award-id award-type="grant" rid="gsp0010">12250410247</award-id>.</p></sec>
<sec><title>Discussion</title><p>Members met virtually (see <xref rid="box1" ref-type="boxed-text">Box 1</xref>).</p><boxed-text id="box1" position="float"><label>Box 1.</label><caption><title>Virtual unconference format</title></caption><p>In March 2022, 96 participants took part.</p></boxed-text><p>The first section of this paper gives an overview.</p></sec>
</body><back><ref-list>
<ref id="R19"><label>[19]</label><mixed-citation publication-type="journal"><person-group person-group-type="author"><name name-style="western"><surname>Zwierenga</surname><given-names>F</given-names></name><name name-style="western"><surname>van Veggel</surname><given-names>B</given-names></name><name name-style="western"><surname>Hendriks</surname><given-names>LEL</given-names></name><etal/></person-group>. <article-title>High dose osimertinib in EGFR exon 20 NSCLC.</article-title>
<source>Lung Cancer</source>. <year>2022</year>;<volume>170</volume>:<fpage>133</fpage>–<lpage>40</lpage>.</mixed-citation></ref>
<ref id="bib21"><label>21</label><element-citation publication-type="journal"><person-group person-group-type="author"><name name-style="western"><surname>Halcomb</surname><given-names>E.</given-names></name></person-group><article-title>Using the consensus development conference method</article-title><source>Nurse Res.</source><volume>16</volume><issue>1</issue><year>2008</year><fpage>56</fpage><lpage>71</lpage></element-citation></ref>
</ref-list></back></article></pmc-articleset>`;

interface ReadArticle {
  abstract?: string;
  affiliations?: string[];
  references?: { citation: string; id?: string; label?: string }[];
  sections: { text: string; title?: string }[];
  tables?: { footnotes?: string; rows: string[][] }[];
}

function rendered(call: { content?: unknown }): string {
  return (call.content as { text?: string }[]).map((block) => block.text ?? '').join('\n');
}

describe('fetchFulltextTool JATS text structure (#185, #196, #197, #200, #202, #203, #208, #209, #210)', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('unmocked fetch')));
    mockIdConvert.mockReset().mockRejectedValue(new Error('unmocked idConvert'));
    mockEFetch.mockReset().mockImplementation(async (params: { db: string }) => {
      if (params.db !== 'pmc') throw new Error(`unmocked eFetch db=${params.db}`);
      return new XMLParser(ORDERED_XML_PARSER_OPTIONS).parse(EFETCH_BODY);
    });
  });

  async function call() {
    const result = await runToolContract(fetchFulltextTool, { pmcids: ['PMC10164684'] });
    const article = (result.structuredContent as { articles: ReadArticle[] }).articles[0];
    if (!article) throw new Error('expected one article');
    return { article, text: rendered(result) };
  }

  it('keeps cell line boundaries as \\n in structuredContent and renders them " · " in content[]', async () => {
    const { article, text } = await call();
    const table2 = article.tables?.[1];

    expect(table2?.rows[0]?.[0]).toBe('EXACERBATION RATE RATIOS\nIRR (95% CI)');
    expect(table2?.rows[1]).toEqual([
      'KTR\nn = 157\nmean measured GFR: 57 ± 20\n95 percentile range: 25–87',
      '1.08\n2.44',
    ]);
    expect(text).toContain('| EXACERBATION RATE RATIOS · IRR (95% CI) | MEPOLIZUMAB |');
    expect(text).toContain(
      '| KTR · n = 157 · mean measured GFR: 57 ± 20 · 95 percentile range: 25–87 | 1.08 · 2.44 |',
    );
    for (const fused of ['RATIOSIRR', '2095', '1.082.44']) {
      expect(JSON.stringify(article)).not.toContain(fused);
      expect(text).not.toContain(fused);
    }
  });

  it('returns one footnote per line in structuredContent and joins them with " · " on the Footnotes line', async () => {
    const { article, text } = await call();
    const lines = [
      'Abbreviations: OCS, oral corticosteroids.',
      '+ 66 (97%) of the 68% patients on dupilumab were using the 300 mg every 2-week dose.',
      '* No patient within this cohort was uninsured',
      '# The five patients on omalizumab all had IgE within the accepted level.',
    ];

    expect(article.tables?.[0]?.footnotes).toBe(lines.join('\n'));
    expect(text).toContain(`Footnotes: ${lines.join(' · ')}`);
  });

  it('returns affiliations from <contrib-group> on both surfaces, without the ROR id', async () => {
    const { article, text } = await call();
    const affiliations = [
      '1 University Medical Center Groningen, Groningen, The Netherlands',
      '2 Division of Gastroenterology, University of Washington, Seattle, Washington, USA',
    ];

    expect(article.affiliations).toEqual(affiliations);
    expect(text).toContain(`- ${affiliations[0]}`);
    expect(text).toContain(`- ${affiliations[1]}`);
    expect(text).not.toContain('ror.org');
  });

  it("leaves an editor's affiliation out of affiliations on both surfaces (#196)", async () => {
    const { article, text } = await call();

    expect(article.affiliations).toHaveLength(2);
    expect(JSON.stringify(article.affiliations)).not.toContain('Icahn');
    expect(text).not.toContain('Icahn School of Medicine');
  });

  it('names a funder without its <institution-id> on both surfaces (#208)', async () => {
    const { article, text } = await call();
    const funding =
      'This research was sponsored by the National Natural Science Foundation of China grant No. 12250410247.';

    expect(article.sections[4]?.title).toBe('Funding');
    expect(article.sections[4]?.text).toBe(funding);
    expect(text).toContain(`#### Funding\n${funding}`);
    expect(text).not.toContain('501100001809');
  });

  it('sets a floating box apart from the body on both surfaces (#210)', async () => {
    const { article, text } = await call();
    const discussion =
      'Members met virtually (see Box 1).\n\n[Box: Box 1. Virtual unconference format]\n\n' +
      'In March 2022, 96 participants took part.\n\n[End of box]\n\nThe first section of this paper gives an overview.';

    expect(article.sections[5]?.text).toBe(discussion);
    expect(text).toContain(`#### Discussion\n${discussion}`);
  });

  it('separates reference names, page ranges and labels on both surfaces (#209)', async () => {
    const result = await runToolContract(fetchFulltextTool, {
      pmcids: ['PMC10164684'],
      includeReferences: true,
    });
    const article = (result.structuredContent as { articles: ReadArticle[] }).articles[0];
    const mixed =
      'Zwierenga F, van Veggel B, Hendriks LEL, et al. High dose osimertinib in EGFR exon 20 NSCLC. Lung Cancer. 2022;170:133–40.';
    const element =
      'Halcomb E. Using the consensus development conference method Nurse Res. 16(1) 2008 56–71';

    expect(article?.references).toEqual([
      { id: 'R19', label: '19', citation: mixed },
      { id: 'bib21', label: '21', citation: element },
    ]);
    const text = rendered(result);
    expect(text).toContain(`- [19 R19] ${mixed}`);
    expect(text).toContain(`- [21 bib21] ${element}`);
    expect(text).not.toContain('[[19]');
  });

  it('renders a run of citation markers as distinct numbers on both surfaces', async () => {
    const { article, text } = await call();

    expect(article.sections[0]?.text).toBe(
      'Cystic fibrosis is increasingly recognised among Asians.[1,2,3,4]',
    );
    expect(text).toContain('recognised among Asians.[1,2,3,4]');
    expect(text).not.toContain('1234');
  });

  it('puts each item of a list nested in its parent item paragraph on a line of its own (#200)', async () => {
    const { article, text } = await call();
    const lines = [
      '- PREVENTION:',
      '  • Implementation and education of known risk factors;',
      '  • Large interventional studies.',
    ].join('\n');

    expect(article.sections[2]?.text).toBe(`We agreed on the following priorities:\n\n${lines}`);
    expect(text).toContain(lines);
    expect(text).not.toContain('PREVENTION: •');
  });

  it('keeps prose after a sub-list that is a direct child of its item below the sub-list (#203)', async () => {
    const { article, text } = await call();
    const lines = '- Prepare the sample.\n  - Centrifuge it.\n  Then record the yield.';

    expect(article.sections[3]?.text).toBe(lines);
    expect(text).toContain(lines);
    expect(text).not.toContain('Prepare the sample. Then record the yield.');
  });

  it('puts an abstract list on lines of its own below its heading (#202)', async () => {
    const { article, text } = await call();
    const abstract = [
      'Abstract: Type 2 diabetes mellitus was reported to be associated with impaired immune response.',
      '',
      'Key points:',
      '- Hyperglycemia may suppress tryptophanase activity.',
      '- A low abundance of anti-inflammatory bacteria may induce an inflammatory response.',
    ].join('\n');

    expect(article.abstract).toBe(abstract);
    expect(text).toContain(`#### Abstract\n${abstract}`);
    expect(text).not.toContain('Key points: -');
  });

  it('keeps an abstract paragraph that sits beside a section (#204)', async () => {
    mockEFetch.mockReset().mockImplementation(async (params: { db: string }) => {
      if (params.db !== 'pmc') throw new Error(`unmocked eFetch db=${params.db}`);
      return new XMLParser(ORDERED_XML_PARSER_OPTIONS).parse(
        '<pmc-articleset><article><front><article-meta><article-id pub-id-type="pmcid">PMC11281965</article-id>' +
          '<title-group><article-title>Serum amino acids in pediatric sepsis</article-title></title-group>' +
          '<abstract id="Abs1"><p id="Par1">Sepsis is characterized by a metabolic disorder of amino acid occurs in the early stage.</p>' +
          '<sec><title>Supplementary Information</title><p>The online version contains supplementary material available at 10.1007/s00726-024-03408-3.</p></sec></abstract>' +
          '</article-meta></front><body><sec><title>Introduction</title><p>Sepsis is commonly encountered.</p></sec></body></article></pmc-articleset>',
      );
    });
    const result = await runToolContract(fetchFulltextTool, { pmcids: ['PMC11281965'] });
    const article = (result.structuredContent as { articles: ReadArticle[] }).articles[0];
    const abstract =
      'Sepsis is characterized by a metabolic disorder of amino acid occurs in the early stage.\n\n' +
      'Supplementary Information: The online version contains supplementary material available at 10.1007/s00726-024-03408-3.';

    expect(article?.abstract).toBe(abstract);
    expect(rendered(result)).toContain(`#### Abstract\n${abstract}`);
  });
});
