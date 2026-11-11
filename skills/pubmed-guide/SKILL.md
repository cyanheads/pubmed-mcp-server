---
name: pubmed-guide
description: PubMed query syntax, identifier crosswalks, and gates for the pubmed_* tools over PubMed, PubMed Central, Europe PMC, and NIH iCite. Use when building a MeSH-based or systematic search, resolving a reference list or DOIs to PMIDs, judging how cited an article is, getting full text, or finding preprints and records PubMed lacks.
license: Apache-2.0
metadata:
  author: cyanheads
  version: "1.0"
---

## Scope

Biomedical literature: PubMed records (MEDLINE, PubMed Central, NCBI Bookshelf), PMC full text, Europe PMC (adds preprints, patents, Agricola), and NIH iCite citation metrics. Keyless. `NCBI_API_KEY` raises NCBI's rate ceiling, `UNPAYWALL_EMAIL` adds an Unpaywall full-text tier, and a deployment that sets `EUROPEPMC_ENABLED=false` registers neither Europe PMC tool.

- Full text only where an open copy exists: PMC, Europe PMC's open-access subset, or, with `UNPAYWALL_EMAIL` set, a copy Unpaywall finds. A subscription article outside all three comes back in `unavailable`.
- iCite metrics are keyed by PMID, so a work PubMed doesn't index has none here.
- Trial registrations appear only as accessions in `pubmed_fetch_articles` `dataBanks`; the registry record itself is a ClinicalTrials.gov server's job. Literature outside biomedicine belongs to an OpenAlex or Crossref server.

## Identifiers

| ID | Form | Comes from |
|:--|:--|:--|
| PMID | digits | `pubmed_search_articles`, `pubmed_lookup_citation`, a `MED` hit of `pubmed_europepmc_search` (its `epmcId` is the PMID) |
| PMCID | `PMC` + digits | `pmcId` on `pubmed_fetch_articles` records, search summaries, and `pubmed_find_related` rows; `pubmed_convert_ids` |
| DOI | `10.…/…` | `doi` on `pubmed_fetch_articles` records, search summaries, `pubmed_find_related` rows, and Europe PMC hits |
| Europe PMC `source` + `epmcId` | `PPR1306463` | `pubmed_europepmc_search` hits only; preprints and patents often carry no PMID or DOI |
| MeSH record | descriptor name, or the clause in `searchTerm` | `name` and `searchTerm` on `pubmed_lookup_mesh` results |
| ORCID | `0000-0002-5446-9969` | `orcid` on `pubmed_fetch_articles` authors, when the record carries one |

Crosswalks:

- **PMID → DOI or PMCID:** `pubmed_fetch_articles`, for any PubMed record.
- **DOI → PMID:** `pubmed_convert_ids` answers only for articles in PMC; `10.1056/NEJMoa1911303` (not in PMC) fails there. Search `10.1056/NEJMoa1911303[doi]` with `pubmed_search_articles` (returns 31535829), or `DOI:"10.1056/NEJMoa1911303"` with `pubmed_europepmc_search`, whose hit carries the PMID.
- **ORCID → an author's papers:** `0000-0002-5446-9969[auid]` in `pubmed_search_articles` returned 46 records. It matches only records whose author entry carries that ORCID, however the name is spelled.

## Gates

### Building a PubMed search

| Syntax | Matches |
|:--|:--|
| `term[tiab]`, `term[ti]` | title and abstract words; title only |
| `"a b"[tiab:~3]` | both words within 3 of each other |
| `"Name"[mh]`, `[mh:noexp]`, `[majr]` | MeSH heading plus every narrower heading; the heading alone; as a major topic |
| `"Name"[pa]` | records indexed with any substance that has that pharmacological action |
| `"Name"[nm]` | records indexed with that supplementary concept (a drug or chemical with no descriptor); no `[mh]` clause matches one |
| `"Heading/qualifier"[mh]` | the heading restricted to one subheading, the qualifier taken from the exact match's `subheadings` |
| `"Randomized Controlled Trial"[pt]` | publication type |
| `McMurray JJ[au]`, `<orcid>[auid]` | author name; author ORCID |
| `"N Engl J Med"[ta]` | journal abbreviation |
| `2019[dp]`, `2026/10/20:2026/10/31[edat]` | publication date; date added to PubMed (ranges as `start:end`) |
| `<doi>[doi]` | DOI |
| `pubmed pmc[sb]` | records with a PMC copy |

- **Read `notice` before using a count.** It flags a field tag PubMed did not recognize and searched as free text (`heart failure[xyz]` returned 385,186 unrestricted records) and a clause that matched nothing, with advice by the clause's field: resolve a MeSH-vocabulary clause with `pubmed_lookup_mesh` and search its `searchTerm`, give a journal as its NLM abbreviation (`N Engl J Med`) or ISSN, and a language as its English name or three-letter code (`english`, `eng`; `en` matches nothing). Fix the query; never report that count. A page that reaches PubMed's 9,999-record window says how many matches no `offset` reaches; split the query by `dateRange`.
- **A MeSH term is the descriptor `name`, never a synonym.** `"SGLT2 inhibitors"[MeSH Terms]` matched nothing although the descriptor lists it as an entry term; `Sodium-Glucose Transporter 2 Inhibitors` is the name. Look the concept up first and search the record's `searchTerm`: a supplementary concept (a specific drug or chemical) is searched as `"Name"[nm]`, because no `[mh]` clause matches it, and `meshTerms` takes headings only, so it goes in `query`.
- **A heading introduced inside the searched dates can miss earlier literature.** A record with `yearIntroduced` inside the date range was indexed before then under the headings in its `previousIndexing`. Look each up with `pubmed_lookup_mesh` by name, without its years, and search the `searchTerm` returned. A current heading returns its own; a retired one matches nothing as `[mh]` and resolves to the heading that holds its records: `"Heart Failure, Congestive"[mh]` matched 0 with `2000:2005[dp]`, and the lookup returns `"Heart Failure"[mh]`, which matched 15,780.
- **MeSH misses the newest records.** Indexing lags, so for records added 2026-10-01 to 2026-11-02 `"Heart Failure"[mh]` matched 212 and `"heart failure"[tiab]` 1,747. OR each MeSH clause with `[tiab]` synonyms from the descriptor's entry terms whenever recent work counts.
- **A drug class needs `[pa]` beside `[mh]`.** An article about one drug is indexed under that drug's headings, not its class: 38320128, "Dapagliflozin and Anemia in Patients with Chronic Kidney Disease", carries no SGLT2-inhibitor heading. `"Sodium-Glucose Transporter 2 Inhibitors"[pa] NOT "Sodium-Glucose Transporter 2 Inhibitors"[mh]` returned 2,354 such records. `pubmed_lookup_mesh` lists such a class twice with one name and MeSH ID, the descriptor first (`recordType` `descriptor`) and then its pharmacological-action record (`pharmacological-action`); the one name serves both tags.
- **`[mh]` explodes.** `"Heart Failure, Systolic"[mh] NOT "Heart Failure"[mh]` is 0; the same against `[mh:noexp]` is 1,429. Use `[mh:noexp]` when the narrower headings don't belong.
- **A quoted phrase is exact; use proximity for words near each other.** `"dapagliflozin mortality"[tiab]` matched nothing (the notice names the clause); `"dapagliflozin mortality"[tiab:~3]` matched 47.
- **Free full text is not a PMC copy.** The free-full-text filter counts articles free anywhere (141,777 for `"heart failure"[tiab]`); `AND pubmed pmc[sb]` in its place matches the 101,121 with a PMC copy, the tier `pubmed_fetch_fulltext` reads first.
- **Batch, don't loop.** Without an API key the server spaces NCBI requests 400 ms apart across all its callers, so parallel calls only queue. Pass many IDs per call; each tool's array limit is in its schema.

### Resolving references

- **One wrong field sinks an ECitMatch lookup.** 31535829 cited with year 2020 came back `not_found`, not matched with a warning; the same citation without the year matched. `The Lancet` failed where `Lancet` and `New England Journal of Medicine` matched. Retry a `not_found` with the doubtful field dropped, or the journal as its NLM abbreviation (`Lancet`), before falling back to search.
- **A title search returns the paper's correspondence too.** `"Dapagliflozin in Patients with Heart Failure and Reduced Ejection Fraction"[ti]` returned 9 records: the trial (31535829), five more under the same title (32130820 is a NEJM letter typed Letter and Comment), and three longer titles containing it. Pick by publication type, first author, and date from `pubmed_fetch_articles`.

### Citations and full text

- **`cited_by` is not a citation count.** For 31535829, `pubmed_find_related` `cited_by` totals 3,381, iCite's `citationCount` 5,579, and Europe PMC's `citedByCount` 5,400. Report iCite's count or RCR for how cited a paper is; use `cited_by` to list citing PubMed records.
- **An `unavailable` entry is not proof that no free full text exists.** `unqueriedTiers` names a tier this deployment skipped that could have served it (Unpaywall without `UNPAYWALL_EMAIL`), and `service-error` is an upstream failure: Europe PMC answered PPR829124's full text with HTTP 500 although its search hit set `hasFullTextXml`. Say which tiers answered.

## Workflows

**Systematic search.** `pubmed_spell_check` the user's terms, then `pubmed_lookup_mesh` each concept for its `searchTerm` and entry terms. Build `("Descriptor"[mh] OR synonym[tiab] OR …) AND (…)` from the `searchTerm` clauses per the gates, adding `[pa]` for a drug class. Size it with `maxResults` 0 and read `notice`, then add publication types and dates. PubMed serves only the first 9,999 records of a set, so split a larger one by date range. Fetch metadata with `pubmed_fetch_articles` in batches, then full text for the included set. Run the same concepts as free text through `pubmed_europepmc_search` with `sources` `PPR` for preprints.

**Resolve a reference list.** Split each reference into journal, year, volume, first page, and first author, and send them to `pubmed_lookup_citation` 25 at a time. On `matched`, compare `matchedFirstAuthor` and read `warnings`; on `ambiguous`, fetch the `candidatePmids` and pick; on `not_found`, apply the ECitMatch gate, then a `[ti]` search, then `TITLE:"…"` in `pubmed_europepmc_search` for preprints. Format with `pubmed_format_citations`, whose `notices` carry retractions and errata.

**How cited is this paper.** Resolve it to a PMID, then `pubmed_fetch_citation_metrics` for RCR, NIH percentile, and citation count; a paper added this year may not be scored yet (42951449, October 2026). Check `pubmed_fetch_articles` for a retraction before relying on the numbers: 9500320 keeps RCR 41.0 and the 99.8th percentile though its publication types include Retracted Publication. `pubmed_find_related` `cited_by` then lists citing records to read.

**A preprint or a record PubMed lacks.** `pubmed_europepmc_search` with `sources` `PPR`; add `AND HAS_FT:Y` to keep records with full text (16 of 69 preprints on dapagliflozin and heart failure). `pubmed_europepmc_fetch` returns the whole abstract; `pubmed_fetch_fulltext` with the DOI returns the body when Europe PMC holds it (`10.21203/rs.3.rs-8604461/v1` did).
