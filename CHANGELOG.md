# Changelog

All notable changes to this project will be documented in this file.

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
