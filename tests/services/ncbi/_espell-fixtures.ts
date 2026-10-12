/**
 * @fileoverview ESpell responses captured from NCBI (`espell.fcgi?db=pubmed`,
 * 2026-10-12), keyed by the `term` sent. Each body is byte-for-byte what NCBI
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
