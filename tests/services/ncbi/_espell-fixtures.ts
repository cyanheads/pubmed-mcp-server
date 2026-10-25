/**
 * @fileoverview ESpell responses captured from NCBI (`espell.fcgi?db=pubmed`,
 * 2026-10-12; field-tag and single-letter terms 2026-10-22; indexed field-tag
 * values 2026-10-25), keyed by the
 * `term` sent. Each body is byte-for-byte what NCBI
 * returned; only the shared prolog and DOCTYPE are factored into
 * {@link espellBody}. `<CorrectedQuery>` is ESpell's lowercased, punctuation-
 * and digit-stripped rewrite; `<SpelledQuery>` interleaves the caller's text
 * (`<Original>`) with each replacement (`<Replaced>`) in document order.
 * @module tests/services/ncbi/_espell-fixtures
 */

/** The `<eSpellResult>` element NCBI returned for each term. */
const ESPELL_RESULTS: Readonly<Record<string, string>> = {
  'BRCA1 tamoxifen resistence':
    '<eSpellResult>\n\t<Database>pubmed</Database>\n\t<Query>BRCA1 tamoxifen resistence</Query>\n\t<CorrectedQuery>brca tamoxifen resistance</CorrectedQuery>\n\t<SpelledQuery><Original></Original><Replaced>brca</Replaced><Original> tamoxifen </Original><Replaced>resistance</Replaced></SpelledQuery>\n\t<ERROR/>\n</eSpellResult>\n',
  'breast cancer[MeSH] AND tamoxifen resistence':
    '<eSpellResult>\n\t<Database>pubmed</Database>\n\t<Query>breast cancer[MeSH] AND tamoxifen resistence</Query>\n\t<CorrectedQuery>breast cancer mesh and tamoxifen resistance</CorrectedQuery>\n\t<SpelledQuery><Original>breast cancer[MeSH] AND tamoxifen </Original><Replaced>resistance</Replaced></SpelledQuery>\n\t<ERROR/>\n</eSpellResult>\n',
  '(lung OR brest) cancr':
    '<eSpellResult>\n\t<Database>pubmed</Database>\n\t<Query>(lung OR brest) cancr</Query>\n\t<CorrectedQuery>lung or breast cancer</CorrectedQuery>\n\t<SpelledQuery><Original>(lung OR </Original><Replaced>breast</Replaced><Original>) </Original><Replaced>cancer</Replaced></SpelledQuery>\n\t<ERROR/>\n</eSpellResult>\n',
  'heart  attack   treatmnt':
    '<eSpellResult>\n\t<Database>pubmed</Database>\n\t<Query>heart  attack   treatmnt</Query>\n\t<CorrectedQuery>heart attack treatment</CorrectedQuery>\n\t<SpelledQuery><Original>heart  attack   </Original><Replaced>treatment</Replaced></SpelledQuery>\n\t<ERROR/>\n</eSpellResult>\n',
  'diabetis mellitus type 2':
    '<eSpellResult>\n\t<Database>pubmed</Database>\n\t<Query>diabetis mellitus type 2</Query>\n\t<CorrectedQuery>diabetes mellitus type</CorrectedQuery>\n\t<SpelledQuery><Original></Original><Replaced>diabetes</Replaced><Original> mellitus type 2</Original></SpelledQuery>\n\t<ERROR/>\n</eSpellResult>\n',
  'myocardial infarcton NOT stemi':
    '<eSpellResult>\n\t<Database>pubmed</Database>\n\t<Query>myocardial infarcton NOT stemi</Query>\n\t<CorrectedQuery>myocardial infarction non stemi</CorrectedQuery>\n\t<SpelledQuery><Original>myocardial </Original><Replaced>infarction</Replaced><Original> </Original><Replaced>non</Replaced><Original> stemi</Original></SpelledQuery>\n\t<ERROR/>\n</eSpellResult>\n',
  'H1N1 vacine 2009 pandemc':
    '<eSpellResult>\n\t<Database>pubmed</Database>\n\t<Query>H1N1 vacine 2009 pandemc</Query>\n\t<CorrectedQuery>h1n1 vaccine pandemic</CorrectedQuery>\n\t<SpelledQuery><Original>H1N1 </Original><Replaced>vaccine</Replaced><Original> </Original><Replaced>pandemic</Replaced><Original> pandemc</Original></SpelledQuery>\n\t<ERROR/>\n</eSpellResult>\n',
  'alzhiemer diseese treatmnt outcomse':
    '<eSpellResult>\n\t<Database>pubmed</Database>\n\t<Query>alzhiemer diseese treatmnt outcomse</Query>\n\t<CorrectedQuery>alzheimer disease treatment outcomes</CorrectedQuery>\n\t<SpelledQuery><Original></Original><Replaced>alzheimer</Replaced><Original> </Original><Replaced>disease</Replaced><Original> </Original><Replaced>treatment</Replaced><Original> </Original><Replaced>outcomes</Replaced></SpelledQuery>\n\t<ERROR/>\n</eSpellResult>\n',
  HbA1c:
    '<eSpellResult>\n\t<Database>pubmed</Database>\n\t<Query>HbA1c</Query>\n\t<CorrectedQuery>hbalc</CorrectedQuery>\n\t<SpelledQuery><Original></Original><Replaced>hbalc</Replaced></SpelledQuery>\n\t<ERROR/>\n</eSpellResult>\n',
  IL6: '<eSpellResult>\n\t<Database>pubmed</Database>\n\t<Query>IL6</Query>\n\t<CorrectedQuery>il6</CorrectedQuery>\n\t<SpelledQuery/>\n\t<ERROR/>\n</eSpellResult>\n',
  Tamoxifen:
    '<eSpellResult>\n\t<Database>pubmed</Database>\n\t<Query>Tamoxifen</Query>\n\t<CorrectedQuery>tamoxifen</CorrectedQuery>\n\t<SpelledQuery/>\n\t<ERROR/>\n</eSpellResult>\n',
  'breast cancer[mesh]':
    '<eSpellResult>\n\t<Database>pubmed</Database>\n\t<Query>breast cancer[mesh]</Query>\n\t<CorrectedQuery>breast cancer mesh</CorrectedQuery>\n\t<SpelledQuery/>\n\t<ERROR/>\n</eSpellResult>\n',
  '1918 influenza pandemc':
    '<eSpellResult>\n\t<Database>pubmed</Database>\n\t<Query>1918 influenza pandemc</Query>\n\t<CorrectedQuery>influenza pandemic</CorrectedQuery>\n\t<SpelledQuery><Original></Original><Replaced>influenza</Replaced><Original> </Original><Replaced>pandemic</Replaced><Original> pandemc</Original></SpelledQuery>\n\t<ERROR/>\n</eSpellResult>\n',
  'COVID-19 vaccin efficacy':
    '<eSpellResult>\n\t<Database>pubmed</Database>\n\t<Query>COVID-19 vaccin efficacy</Query>\n\t<CorrectedQuery>covid vaccine efficacy</CorrectedQuery>\n\t<SpelledQuery><Original>COVID-</Original><Replaced>vaccine</Replaced><Original> </Original><Replaced>efficacy</Replaced><Original> efficacy</Original></SpelledQuery>\n\t<ERROR/>\n</eSpellResult>\n',
  'PCR assay sensitivty':
    '<eSpellResult>\n\t<Database>pubmed</Database>\n\t<Query>PCR assay sensitivty</Query>\n\t<CorrectedQuery>pc r assay sensitivity</CorrectedQuery>\n\t<SpelledQuery><Original></Original><Replaced>pc</Replaced><Original> </Original><Replaced>r</Replaced><Original> </Original><Replaced>assay</Replaced></SpelledQuery>\n\t<ERROR/>\n</eSpellResult>\n',
  'Sjögren syndrom':
    '<eSpellResult>\n\t<Database>pubmed</Database>\n\t<Query>Sjögren syndrom</Query>\n\t<CorrectedQuery>jogren syndrom</CorrectedQuery>\n\t<SpelledQuery><Original></Original><Replaced>jogren</Replaced><Original> syndrom</Original></SpelledQuery>\n\t<ERROR/>\n</eSpellResult>\n',
  '007':
    '<eSpellResult>\n\t<Database>pubmed</Database>\n\t<Query>007</Query>\n\t<CorrectedQuery/>\n\t<SpelledQuery/>\n\t<ERROR/>\n</eSpellResult>\n',
  '1e5':
    '<eSpellResult>\n\t<Database>pubmed</Database>\n\t<Query>1e5</Query>\n\t<CorrectedQuery/>\n\t<SpelledQuery/>\n\t<ERROR/>\n</eSpellResult>\n',
  '33306283':
    '<eSpellResult>\n\t<Database>pubmed</Database>\n\t<Query>33306283</Query>\n\t<CorrectedQuery/>\n\t<SpelledQuery/>\n\t<ERROR/>\n</eSpellResult>\n',
  'ALZHIEMER DISEESE':
    '<eSpellResult>\n\t<Database>pubmed</Database>\n\t<Query>ALZHIEMER DISEESE</Query>\n\t<CorrectedQuery>alzheimer disease</CorrectedQuery>\n\t<SpelledQuery><Original></Original><Replaced>alzheimer</Replaced><Original> </Original><Replaced>disease</Replaced></SpelledQuery>\n\t<ERROR/>\n</eSpellResult>\n',
  'raloxifen breast cancr':
    '<eSpellResult>\n\t<Database>pubmed</Database>\n\t<Query>raloxifen breast cancr</Query>\n\t<CorrectedQuery>tamoxifen breast cancer</CorrectedQuery>\n\t<SpelledQuery><Original></Original><Replaced>tamoxifen</Replaced><Original> breast </Original><Replaced>cancer</Replaced></SpelledQuery>\n\t<ERROR/>\n</eSpellResult>\n',
  'risk[tiab] AND alzhiemer':
    '<eSpellResult>\n\t<Database>pubmed</Database>\n\t<Query>risk[tiab] AND alzhiemer</Query>\n\t<CorrectedQuery>risk tia and alzheimer</CorrectedQuery>\n\t<SpelledQuery><Original>risk[</Original><Replaced>tia</Replaced><Original>] AND </Original><Replaced>alzheimer</Replaced></SpelledQuery>\n\t<ERROR/>\n</eSpellResult>\n',
  'smith j[au] AND diabetis':
    '<eSpellResult>\n\t<Database>pubmed</Database>\n\t<Query>smith j[au] AND diabetis</Query>\n\t<CorrectedQuery>smith j ar and diabetes</CorrectedQuery>\n\t<SpelledQuery><Original>smith j[</Original><Replaced>ar</Replaced><Original>] AND </Original><Replaced>diabetes</Replaced></SpelledQuery>\n\t<ERROR/>\n</eSpellResult>\n',
  'dementia[mh] AND alzhiemer':
    '<eSpellResult>\n\t<Database>pubmed</Database>\n\t<Query>dementia[mh] AND alzhiemer</Query>\n\t<CorrectedQuery>dementia m and alzheimer</CorrectedQuery>\n\t<SpelledQuery><Original>dementia[</Original><Replaced>m</Replaced><Original>] AND </Original><Replaced>alzheimer</Replaced></SpelledQuery>\n\t<ERROR/>\n</eSpellResult>\n',
  'alzheimer disease[MeSH Terms] AND treatmnt':
    '<eSpellResult>\n\t<Database>pubmed</Database>\n\t<Query>alzheimer disease[MeSH Terms] AND treatmnt</Query>\n\t<CorrectedQuery>alzheimer disease mesh tems and treatment</CorrectedQuery>\n\t<SpelledQuery><Original>alzheimer disease[MeSH </Original><Replaced>tems</Replaced><Original>] AND </Original><Replaced>treatment</Replaced></SpelledQuery>\n\t<ERROR/>\n</eSpellResult>\n',
  '"heart attack"[tiab] AND treatmnt':
    '<eSpellResult>\n\t<Database>pubmed</Database>\n\t<Query>&quot;heart attack&quot;[tiab] AND treatmnt</Query>\n\t<CorrectedQuery>heart attack tia and treatment</CorrectedQuery>\n\t<SpelledQuery><Original>&quot;heart attack&quot;[</Original><Replaced>tia</Replaced><Original>] AND </Original><Replaced>treatment</Replaced></SpelledQuery>\n\t<ERROR/>\n</eSpellResult>\n',
  'risk[tiab] AND smith j[au] AND alzhiemer':
    '<eSpellResult>\n\t<Database>pubmed</Database>\n\t<Query>risk[tiab] AND smith j[au] AND alzhiemer</Query>\n\t<CorrectedQuery>risk tia and smith j au and alzheimer</CorrectedQuery>\n\t<SpelledQuery><Original>risk[</Original><Replaced>tia</Replaced><Original>] AND smith j[au] AND </Original><Replaced>alzheimer</Replaced></SpelledQuery>\n\t<ERROR/>\n</eSpellResult>\n',
  'q fever outbreak':
    '<eSpellResult>\n\t<Database>pubmed</Database>\n\t<Query>q fever outbreak</Query>\n\t<CorrectedQuery>c fever outbreaks</CorrectedQuery>\n\t<SpelledQuery><Original></Original><Replaced>c</Replaced><Original> fever </Original><Replaced>outbreaks</Replaced></SpelledQuery>\n\t<ERROR/>\n</eSpellResult>\n',
  'smith q AND diabetis':
    '<eSpellResult>\n\t<Database>pubmed</Database>\n\t<Query>smith q AND diabetis</Query>\n\t<CorrectedQuery>smith t and diabetes</CorrectedQuery>\n\t<SpelledQuery><Original>smith </Original><Replaced>t</Replaced><Original> AND </Original><Replaced>diabetes</Replaced></SpelledQuery>\n\t<ERROR/>\n</eSpellResult>\n',
  'breast cancer n women':
    '<eSpellResult>\n\t<Database>pubmed</Database>\n\t<Query>breast cancer n women</Query>\n\t<CorrectedQuery>breast cancer in women</CorrectedQuery>\n\t<SpelledQuery><Original>breast cancer </Original><Replaced>in</Replaced><Original> women</Original></SpelledQuery>\n\t<ERROR/>\n</eSpellResult>\n',
  'cancr AND 2020:2024[dp]':
    '<eSpellResult>\n\t<Database>pubmed</Database>\n\t<Query>cancr AND 2020:2024[dp]</Query>\n\t<CorrectedQuery>cancer and dp</CorrectedQuery>\n\t<SpelledQuery><Original></Original><Replaced>cancer</Replaced><Original> AND </Original><Replaced>dp</Replaced><Original>:2024[dp]</Original></SpelledQuery>\n\t<ERROR/>\n</eSpellResult>\n',
  '2020/01/01[dp] AND cancr':
    '<eSpellResult>\n\t<Database>pubmed</Database>\n\t<Query>2020/01/01[dp] AND cancr</Query>\n\t<CorrectedQuery>d and cancer</CorrectedQuery>\n\t<SpelledQuery><Original></Original><Replaced>d</Replaced><Original>/</Original><Replaced>and</Replaced><Original>/</Original><Replaced>cancer</Replaced><Original>[dp] AND cancr</Original></SpelledQuery>\n\t<ERROR/>\n</eSpellResult>\n',
  'diabetis[tiab]':
    '<eSpellResult>\n\t<Database>pubmed</Database>\n\t<Query>diabetis[tiab]</Query>\n\t<CorrectedQuery>diabetes diab</CorrectedQuery>\n\t<SpelledQuery><Original></Original><Replaced>diabetes</Replaced><Original>[</Original><Replaced>diab</Replaced><Original>]</Original></SpelledQuery>\n\t<ERROR/>\n</eSpellResult>\n',
  'neoplasm[mh] AND humen[mh]':
    '<eSpellResult>\n\t<Database>pubmed</Database>\n\t<Query>neoplasm[mh] AND humen[mh]</Query>\n\t<CorrectedQuery>neoplasms mh and human mh</CorrectedQuery>\n\t<SpelledQuery><Original></Original><Replaced>neoplasms</Replaced><Original>[mh] AND </Original><Replaced>human</Replaced><Original>[mh]</Original></SpelledQuery>\n\t<ERROR/>\n</eSpellResult>\n',
  'cancr AND free full text[sb]':
    '<eSpellResult>\n\t<Database>pubmed</Database>\n\t<Query>cancr AND free full text[sb]</Query>\n\t<CorrectedQuery>cancer and fred full text srs</CorrectedQuery>\n\t<SpelledQuery><Original></Original><Replaced>cancer</Replaced><Original> AND </Original><Replaced>fred</Replaced><Original> full text[</Original><Replaced>srs</Replaced><Original>]</Original></SpelledQuery>\n\t<ERROR/>\n</eSpellResult>\n',
  'cancr AND "free full text"[sb]':
    '<eSpellResult>\n\t<Database>pubmed</Database>\n\t<Query>cancr AND &quot;free full text&quot;[sb]</Query>\n\t<CorrectedQuery>cancer and fred full text srs</CorrectedQuery>\n\t<SpelledQuery><Original></Original><Replaced>cancer</Replaced><Original> AND &quot;</Original><Replaced>fred</Replaced><Original> full text&quot;[</Original><Replaced>srs</Replaced><Original>]</Original></SpelledQuery>\n\t<ERROR/>\n</eSpellResult>\n',
  'cancr AND "pubmed books"[sb]':
    '<eSpellResult>\n\t<Database>pubmed</Database>\n\t<Query>cancr AND &quot;pubmed books&quot;[sb]</Query>\n\t<CorrectedQuery>cancer and pubmed hooks sb</CorrectedQuery>\n\t<SpelledQuery><Original></Original><Replaced>cancer</Replaced><Original> AND &quot;pubmed </Original><Replaced>hooks</Replaced><Original>&quot;[sb]</Original></SpelledQuery>\n\t<ERROR/>\n</eSpellResult>\n',
  'cancr AND randomized controlled trial[pt]':
    '<eSpellResult>\n\t<Database>pubmed</Database>\n\t<Query>cancr AND randomized controlled trial[pt]</Query>\n\t<CorrectedQuery>cancer and randomized controlled terial pt</CorrectedQuery>\n\t<SpelledQuery><Original></Original><Replaced>cancer</Replaced><Original> AND randomized controlled </Original><Replaced>terial</Replaced><Original>[pt]</Original></SpelledQuery>\n\t<ERROR/>\n</eSpellResult>\n',
  'cancr AND lancet[ta]':
    '<eSpellResult>\n\t<Database>pubmed</Database>\n\t<Query>cancr AND lancet[ta]</Query>\n\t<CorrectedQuery>cancer and lane ta</CorrectedQuery>\n\t<SpelledQuery><Original></Original><Replaced>cancer</Replaced><Original> AND </Original><Replaced>lane</Replaced><Original>[ta]</Original></SpelledQuery>\n\t<ERROR/>\n</eSpellResult>\n',
  'cancr AND aged[mh]':
    '<eSpellResult>\n\t<Database>pubmed</Database>\n\t<Query>cancr AND aged[mh]</Query>\n\t<CorrectedQuery>cancer and age mh</CorrectedQuery>\n\t<SpelledQuery><Original></Original><Replaced>cancer</Replaced><Original> AND </Original><Replaced>age</Replaced><Original>[mh]</Original></SpelledQuery>\n\t<ERROR/>\n</eSpellResult>\n',
  'cancr AND aged[MeSH Terms]':
    '<eSpellResult>\n\t<Database>pubmed</Database>\n\t<Query>cancr AND aged[MeSH Terms]</Query>\n\t<CorrectedQuery>cancer and age mesh terms</CorrectedQuery>\n\t<SpelledQuery><Original></Original><Replaced>cancer</Replaced><Original> AND </Original><Replaced>age</Replaced><Original>[MeSH Terms]</Original></SpelledQuery>\n\t<ERROR/>\n</eSpellResult>\n',
  'cancr AND eng[la]':
    '<eSpellResult>\n\t<Database>pubmed</Database>\n\t<Query>cancr AND eng[la]</Query>\n\t<CorrectedQuery>cancer and end la</CorrectedQuery>\n\t<SpelledQuery><Original></Original><Replaced>cancer</Replaced><Original> AND </Original><Replaced>end</Replaced><Original>[la]</Original></SpelledQuery>\n\t<ERROR/>\n</eSpellResult>\n',
  'cancr AND zhang y[au]':
    '<eSpellResult>\n\t<Database>pubmed</Database>\n\t<Query>cancr AND zhang y[au]</Query>\n\t<CorrectedQuery>cancer and jhang y au</CorrectedQuery>\n\t<SpelledQuery><Original></Original><Replaced>cancer</Replaced><Original> AND </Original><Replaced>jhang</Replaced><Original> y[au]</Original></SpelledQuery>\n\t<ERROR/>\n</eSpellResult>\n',
  'cancr AND [sb]':
    '<eSpellResult>\n\t<Database>pubmed</Database>\n\t<Query>cancr AND [sb]</Query>\n\t<CorrectedQuery>cancer and st</CorrectedQuery>\n\t<SpelledQuery><Original></Original><Replaced>cancer</Replaced><Original> AND [</Original><Replaced>st</Replaced><Original>]</Original></SpelledQuery>\n\t<ERROR/>\n</eSpellResult>\n',
  'cancr AND diabetis[tiab]':
    '<eSpellResult>\n\t<Database>pubmed</Database>\n\t<Query>cancr AND diabetis[tiab]</Query>\n\t<CorrectedQuery>cancer and diabetes tiab</CorrectedQuery>\n\t<SpelledQuery><Original></Original><Replaced>cancer</Replaced><Original> AND </Original><Replaced>diabetes</Replaced><Original>[tiab]</Original></SpelledQuery>\n\t<ERROR/>\n</eSpellResult>\n',
  'asthma AND smith j[Author] AND englsh[Language]':
    '<eSpellResult>\n\t<Database>pubmed</Database>\n\t<Query>asthma AND smith j[Author] AND englsh[Language]</Query>\n\t<CorrectedQuery>asthma and smith j author and english language</CorrectedQuery>\n\t<SpelledQuery><Original>asthma AND smith j[Author] AND </Original><Replaced>english</Replaced><Original>[Language]</Original></SpelledQuery>\n\t<ERROR/>\n</eSpellResult>\n',
};

/** Wrap an `<eSpellResult>` element in the prolog and DOCTYPE NCBI sends with it. */
export function espellBody(result: string): string {
  return `<?xml version="1.0"?>\n<!DOCTYPE eSpellResult PUBLIC "-//NLM//DTD eSpellResult, 23 November 2004//EN" "https://www.ncbi.nlm.nih.gov/entrez/query/DTD/eSpell.dtd">\n${result}`;
}

/** Every term captured, in capture order. */
export const ESPELL_TERMS: readonly string[] = Object.keys(ESPELL_RESULTS);

/** The full response body NCBI returned for `term`. Throws for a term never captured. */
export function capturedEspell(term: string): string {
  const result = ESPELL_RESULTS[term];
  if (result === undefined) throw new Error(`no captured ESpell response for "${term}"`);
  return espellBody(result);
}
