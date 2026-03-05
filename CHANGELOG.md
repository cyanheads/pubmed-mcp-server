# Changelog

All notable changes to this project will be documented in this file.

---

## [2.0.1] - 2026-03-04

### Added

- **Search filters**: `pubmed_search` gained field-specific filters (`author`, `journal`, `meshTerms`, `language`, `hasAbstract`, `freeFullText`, `species`) and pagination via `offset`
- **PMC links**: `pubmed_fetch` and `pubmed_search` summaries now include `pmcId`, `pubmedUrl`, and `pmcUrl` for direct article access
- **Affiliation deduplication**: article parser collects affiliations into a single array with per-author index references, reducing payload size for multi-center papers
- **Exact MeSH heading search**: `pubmed_mesh_lookup` runs a parallel `[MH]` exact-heading search and stable-sorts exact matches to the top

### Changed

- **`pubmed_search`**: renamed `includeSummaries` to `summaryCount`; date range format changed from `YYYY/MM/DD` to `YYYY-MM-DD` (auto-converted internally)
- **`pubmed_cite`**: max PMIDs raised from 20 to 50
- **`pubmed_related`**: simplified to use `cmd=neighbor` for all relationship types instead of `neighbor_history` + WebEnv for cited_by/references
- **`pubmed_mesh_lookup`**: `includeDetails` now defaults to `true`; switched from eFetch to eSummary for detail retrieval (MeSH eFetch returns plain text, not XML)
- **NCBI response handler**: demoted `eSearchResult.ErrorList` (PhraseNotFound, FieldNotFound) from errors to warnings — NCBI populates these on valid zero-result queries; enabled `processEntities` and `htmlEntities` in XML parser
- **Config defaults**: HTTP port 3010 → 3017, transport default `http` → `stdio`, storage default `filesystem` → `in-memory`

### Fixed

- **Auth factory tests**: JWT strategy tests now provide `mcpAuthSecretKey` and restore it on teardown
- **Response handler tests**: updated assertions to match ErrorList demotion (PhraseNotFound is a warning, not a thrown error)
- **Conformance tests**: removed `pubmed_trending` from expected tools list

### Removed

- **`pubmed_trending` tool**: removed — its functionality is fully covered by `pubmed_search` with date range and `pub_date` sort

---

## [2.0.0] - 2026-03-04

### Added

- **NCBI Service Layer**: Complete E-utilities integration (`eSearch`, `eSummary`, `eFetch`, `eLink`, `eSpell`, `eInfo`) with request queuing, rate limiting, retry with exponential backoff, and XML parsing.
- **7 PubMed Tools**:
  - `pubmed_search` — Search PubMed with filters, date ranges, and optional summaries
  - `pubmed_fetch` — Fetch full article metadata by PMIDs (abstract, authors, journal, MeSH)
  - `pubmed_cite` — Generate formatted citations (APA 7th, MLA 9th, BibTeX, RIS)
  - `pubmed_related` — Find related/cited-by/references via ELink
  - `pubmed_spell` — Spell-check biomedical queries via ESpell
  - `pubmed_trending` — Date-filtered search for recent publications
  - `pubmed_mesh_lookup` — MeSH vocabulary search and exploration
- **Research Plan Prompt**: `research_plan` — structured 4-phase biomedical research plan generation
- **Database Info Resource**: `pubmed://database/info` — PubMed database metadata via EInfo
- **Citation Formatters**: Hand-rolled, zero-dependency, Workers-compatible formatters for APA, MLA, BibTeX, and RIS
- **NCBI Configuration**: `NCBI_API_KEY`, `NCBI_ADMIN_EMAIL`, `NCBI_REQUEST_DELAY_MS`, `NCBI_MAX_RETRIES`, `NCBI_TIMEOUT_MS`

### Changed

- **Rebranded** from `mcp-ts-template` to `@cyanheads/pubmed-mcp-server` (package.json, server.json, smithery.yaml, wrangler.toml)
- **Architecture**: Built on mcp-ts-template 3.0 with DI container, typed tokens, Zod-validated config, OpenTelemetry, and multi-transport support (stdio, HTTP, Cloudflare Workers)

### Removed

- All template example tools, resources, prompts, and services (graph, LLM, speech)
- `openai`, `@modelcontextprotocol/ext-apps` dependencies

---

For changelog details for v1.x, please refer to the [changelog/archive.md](changelog/archive.md) file.
