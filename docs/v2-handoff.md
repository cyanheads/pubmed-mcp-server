# PubMed MCP Server — v2.0.0 Handoff

Built on `mcp-ts-template` 3.0. PubMed/NCBI E-utilities integration for AI agents and research tools.

---

## NCBI E-utilities Primer

Base URL: `https://eutils.ncbi.nlm.nih.gov/entrez/eutils`

| Endpoint | Purpose | Key Params |
|:---|:---|:---|
| ESearch | Search any Entrez database, returns ID list | `db`, `term`, `retmax`, `sort`, `datetype`, `mindate`, `maxdate`, `usehistory` |
| EFetch | Retrieve full records by IDs | `db`, `id`, `rettype`, `retmode` |
| ESummary | Retrieve document summaries (lighter than EFetch) | `db`, `id`, `retmode` |
| ELink | Find related/linked records across databases | `dbfrom`, `db`, `id`, `linkname`, `cmd` |
| ESpell | Spell-check and suggest query corrections | `db`, `term` |
| EInfo | Database metadata (field list, last update) | `db` |

**Rate limits:** 3 req/s without API key, 10 req/s with `NCBI_API_KEY`. All requests must flow through a sequential queue that enforces this delay. NCBI requires `tool` and `email` params on every request.

**XML handling:** NCBI returns XML by default. PubMed XML is notoriously inconsistent — elements that should be arrays sometimes come back as single objects, ESummary has two completely different XML formats (old Item-based vs new DocumentSummarySet), date formats vary wildly. The parser layer must use `ensureArray()` everywhere and handle multiple fallback formats.

---

## Configuration

Env vars (in addition to template defaults):

| Variable | Description | Default |
|:---|:---|:---|
| `NCBI_API_KEY` | NCBI API key for higher rate limits | none |
| `NCBI_TOOL_IDENTIFIER` | Tool name sent to NCBI | `{serverName}/{version}` |
| `NCBI_ADMIN_EMAIL` | Contact email sent to NCBI | none |
| `NCBI_REQUEST_DELAY_MS` | Delay between requests (ms) | 100 (w/ key), 334 (w/o) |
| `NCBI_MAX_RETRIES` | Retry attempts on failure | 3 |

---

## Service Layer

### `src/services/ncbi/`

Layered architecture — each component has a single responsibility:

| Component | Responsibility |
|:---|:---|
| **Constants** | Base URL, shared types (`NcbiRequestParams`, `NcbiRequestOptions`) |
| **Core API Client** | HTTP transport. Injects `tool`/`email`/`api_key` params. Exponential backoff retry. Switches to POST for large ID lists (200+). |
| **Request Queue** | Sequential FIFO queue. Enforces `ncbiRequestDelayMs` between requests. All API calls flow through here. |
| **Response Handler** | `fast-xml-parser` configuration. XML validation. Error extraction from multiple NCBI response paths (`eSearchResult.ErrorList`, `eLinkResult.ERROR`, `eSummaryResult.ERROR`, etc.). |
| **NcbiService (facade)** | Typed wrappers: `eSearch()`, `eSummary()`, `eFetch()`, `eLink()`, `eSpell()`, `eInfo()`. Singleton. |

### XML Parsing (`src/services/ncbi/parsing/`)

| Module | Purpose |
|:---|:---|
| **xmlGenericHelpers** | `ensureArray(item)`, `getText(element)`, `getAttribute(element, name)` — foundational for NCBI XML quirks |
| **pubmedArticleStructureParser** | Extraction functions for EFetch XML: authors, journal info, MeSH terms, grants, DOI, abstract (handles structured abstracts with labeled sections), publication types, keywords, dates |
| **eSummaryResultParser** | Handles old and new ESummary formats. Author parsing with 4 fallback formats (array, nested object, JSON string, comma-delimited). Date normalization. |

### PubMed Types (`src/types-global/`)

Three tiers of types:

| Tier | Purpose |
|:---|:---|
| **Raw XML** | Mirror `fast-xml-parser` output: `XmlPubmedArticle`, `XmlMedlineCitation`, `XmlAuthor`, etc. |
| **Parsed domain** | Clean application objects: `ParsedArticle`, `ParsedBriefSummary`, `ParsedArticleAuthor`, `ParsedJournalInfo`, `ParsedMeshTerm` |
| **E-utility responses** | Typed API containers: `ESearchResult`, `ESummaryResult`, `EFetchArticleSet` |

NCBI-specific error codes: `NCBI_API_ERROR`, `NCBI_PARSING_ERROR`, `NCBI_RATE_LIMIT_WARNING`, `NCBI_QUERY_ERROR`, `NCBI_SERVICE_UNAVAILABLE`.

---

## Tools

### `pubmed_search`

Search PubMed with full query syntax, filters, and date ranges. Returns PMIDs and optional brief summaries.

| Parameter | Type | Required | Default | Description |
|:---|:---|:---|:---|:---|
| `query` | string | yes | — | PubMed search query (supports full NCBI syntax) |
| `maxResults` | integer | no | 20 | Max results to return (1–1000) |
| `sort` | enum | no | `relevance` | `relevance`, `pub_date`, `author`, `journal` |
| `dateRange` | object | no | — | `{ minDate, maxDate, dateType }` — dates as YYYY/MM/DD, dateType: pdat/mdat/edat |
| `publicationTypes` | string[] | no | — | Filter by type: "Review", "Clinical Trial", etc. |
| `includeSummaries` | integer | no | 0 | Fetch ESummary for top N results (0–50) |

**NCBI APIs:** ESearch (with `usehistory` when summaries requested), ESummary.

**Returns:** `{ query, totalFound, pmids, summaries?, searchUrl }`

---

### `pubmed_fetch`

Fetch full article metadata by PMIDs. The primary way to get detailed article content.

| Parameter | Type | Required | Default | Description |
|:---|:---|:---|:---|:---|
| `pmids` | string[] | yes | — | PubMed IDs to fetch (max 200) |
| `includeMesh` | boolean | no | true | Include MeSH terms |
| `includeGrants` | boolean | no | false | Include grant information |
| `includeReferences` | boolean | no | false | Include reference list |

**NCBI APIs:** EFetch (auto-POST for large ID lists).

**Returns:** Array of parsed articles: `{ pmid, title, abstract, authors, journal, doi, publicationDate, meshTerms?, grants?, references?, publicationTypes, keywords }`

---

### `pubmed_cite`

Get formatted citations for one or more articles.

| Parameter | Type | Required | Default | Description |
|:---|:---|:---|:---|:---|
| `pmids` | string[] | yes | — | PubMed IDs to cite |
| `styles` | enum[] | no | `["apa"]` | Citation styles: `ris`, `bibtex`, `apa`, `mla` |

**NCBI APIs:** EFetch. Converts PubMed XML → CSL-JSON → formatted citations via `citation-js`.

**Returns:** Array of `{ pmid, title, citations: { apa?, bibtex?, ris?, mla? } }`

---

### `pubmed_related`

Find articles related to a source article — similar content, citing articles, or references.

| Parameter | Type | Required | Default | Description |
|:---|:---|:---|:---|:---|
| `pmid` | string | yes | — | Source PubMed ID |
| `relationship` | enum | no | `similar` | `similar`, `cited_by`, `references` |
| `maxResults` | integer | no | 10 | Max related articles (1–50) |

**NCBI APIs:** ELink (`neighbor_score` for similar, `neighbor_history` for cited_by/references), ESummary for enrichment.

**Returns:** `{ sourcePmid, relationship, articles: [{ pmid, title, authors, score? }], totalFound }`

---

### `pubmed_mesh_lookup`

Search and explore MeSH (Medical Subject Headings) vocabulary. Essential for building precise PubMed queries.

| Parameter | Type | Required | Default | Description |
|:---|:---|:---|:---|:---|
| `term` | string | yes | — | MeSH term to look up |
| `maxResults` | integer | no | 10 | Max results (1–50) |
| `includeDetails` | boolean | no | false | Fetch full MeSH records (scope notes, tree numbers, entry terms) |

**NCBI APIs:** ESearch (db=mesh), EFetch/ESummary (db=mesh) when `includeDetails` is true.

**Returns:** `{ term, results: [{ meshId, name, treeNumbers?, scopeNote?, entryTerms? }] }`

---

### `pubmed_spell`

Spell-check a query and get NCBI's suggested correction. Lightweight utility for query refinement.

| Parameter | Type | Required | Default | Description |
|:---|:---|:---|:---|:---|
| `query` | string | yes | — | Query to spell-check |

**NCBI APIs:** ESpell.

**Returns:** `{ original, corrected, hasSuggestion }`

---

### `pubmed_trending`

Find recent articles in a field, sorted by date. Opinionated convenience wrapper over search.

| Parameter | Type | Required | Default | Description |
|:---|:---|:---|:---|:---|
| `query` | string | yes | — | Topic to find trending articles for |
| `days` | integer | no | 30 | Look back period (1–365) |
| `maxResults` | integer | no | 10 | Max results (1–50) |

**NCBI APIs:** ESearch (date-filtered, sorted by pub_date), ESummary.

**Returns:** `{ query, period, articles: [{ pmid, title, authors, publicationDate, source }] }`

---

## Prompts

### `research_plan`

Structured research plan generation. Migrated from the v1 `pubmed_research_agent` tool — this is prompt templating, not an API integration, so it belongs as a prompt definition.

| Argument | Type | Required | Description |
|:---|:---|:---|:---|
| `title` | string | yes | Project title |
| `goal` | string | yes | Primary research goal |
| `keywords` | string[] | yes | Research keywords |
| `organism` | string | no | Organism focus |
| `includeAgentPrompts` | boolean | no | Include detailed prompts for consuming LLM |

**Returns:** Multi-message prompt with structured research plan outline covering: conception (hypothesis, lit review, experimental design), data collection (methods, QC), analysis (statistics, bioinformatics), dissemination (manuscript, data deposition).

---

## Resources

### `pubmed://database/info`

Database metadata from EInfo — field list, last update date, record count. Static reference data that fits the resource model.

---

## Dependencies (PubMed-specific)

| Package | Purpose |
|:---|:---|
| `fast-xml-parser` | NCBI XML parsing |
| `citation-js` | Citation formatting (RIS, BibTeX, APA, MLA) |
| `chrono-node` | Date normalization for inconsistent NCBI date formats |

### Removed from v1

| Package | Reason |
|:---|:---|
| `axios` | Replace with `fetchWithTimeout` from template utils (native fetch) |
| `chart.js` / `chartjs-node-canvas` | Chart generation tool removed (out of scope) |
| `tiktoken` / `openai` | Token counting removed (no longer needed without research agent tool) |
