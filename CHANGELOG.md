# Changelog

All notable changes to this project will be documented in this file.

---

## [2.2.0] - 2026-03-23

### Changed

- **Framework migration**: Replaced inline framework code (~58k lines) with `@cyanheads/mcp-ts-core` package dependency. All tools, resources, and prompts now use the framework's declarative builders (`tool()`, `resource()`, `prompt()`)
- **Tool definitions**: Rewritten from handler-factory pattern to single-file `tool()` builder definitions with Zod input/output schemas, `format` functions, and `annotations`
- **Resource definition**: `database-info.resource.ts` migrated from custom `ResourceDefinition` type to framework's `resource()` builder with `handler(params, ctx)` pattern
- **Prompt definition**: `research-plan.prompt.ts` migrated from custom `PromptDefinition` type to framework's `prompt()` builder
- **Entry point**: `src/index.ts` simplified from DI container + server bootstrap to single `createApp()` call with tool/resource/prompt arrays
- **NCBI service**: Flattened from `services/ncbi/core/` subdirectory to `services/ncbi/` top-level; uses framework's `logger` instead of custom logger
- **Config**: Replaced monolithic `src/config/index.ts` with focused `src/config/server-config.ts` (NCBI-specific env vars only; framework handles transport, auth, storage)
- **Build**: Switched from custom build scripts to framework-provided `tsconfig.base.json`, `biome.json`, and `vitest.config.ts` extensions
- **Tool renames**: File names changed to match tool names (e.g., `pubmed-search.tool.ts` → `search-articles.tool.ts`, `pubmed-spell.tool.ts` → `spell-check.tool.ts`)
- **CLAUDE.md**: Replaced generic placeholder patterns with actual server examples (spell-check tool, database-info resource, NCBI config), updated structure tree, removed unused context properties
- **README.md**: Updated all tool names to match renames (e.g., `pubmed_search` → `pubmed_search_articles`), updated config section description
- **Dockerfile**: Fixed image title/description labels, added `source` label, corrected log directory name and default port
- **.env.example**: Added `NCBI_TIMEOUT_MS` entry

### Added

- **Skills directory**: Framework skill files for development workflows (add-tool, add-resource, devcheck, field-test, etc.)
- **MCP definition linter**: `bun run lint:mcp` validates tool/resource/prompt definitions against the MCP spec at build time
- **devcheck.config.json**: Centralized devcheck configuration

### Fixed

- **fetch-articles**: Added `unavailablePmids` to output — surfaces which requested PMIDs returned no article data
- **fetch-fulltext**: Added `unavailablePmcIds` to output — tracks which PMC IDs returned no data; fetch failures now return a graceful empty result instead of throwing
- **research-plan prompt**: Corrected tool reference from `pubmed_mesh_lookup` to `pubmed_lookup_mesh`; clarified `includeAgentPrompts` description

### Security

- **package.json**: Added `overrides` to pin transitive dependencies `express-rate-limit` (>=8.2.2) and `hono` (>=4.12.7) to patched versions

### Removed

- **Inline framework code**: DI container, transport layer (stdio/HTTP/Workers), storage providers, auth strategies, error handler, logger, telemetry, utilities — all now provided by `@cyanheads/mcp-ts-core`
- **All tests**: Legacy test suite removed (covered framework internals, not server logic); to be rebuilt with `createMockContext()` pattern
- **Worker entry point**: `src/worker.ts` removed (framework handles Workers deployment via `createWorkerHandler()`)
- **Cloudflare config**: `wrangler.toml`, `schemas/cloudflare-d1-schema.sql` removed
- **Misc**: `.husky/pre-commit`, `smithery.yaml`, `repomix.config.json`, `typedoc.json`, `tsdoc.json`, various README docs in `src/`

---

## [2.1.6] - 2026-03-09

### Fixed

- **Error responses**: Removed `structuredContent` from error responses in tool handler factory — `structuredContent` is only valid for successful results, not error payloads

### Updated

- `fast-check` to 4.6.0
- `jose` to 6.2.1

---

## [2.1.5] - 2026-03-06

### Added

- **Startup logging**: NCBI configuration (API key status, email, request delay, max retries, timeout) now logged at initialization for easier debugging

### Updated

- `@biomejs/biome` to 2.4.6
- `@cloudflare/workers-types` to 4.20260307.1
- `@types/node` to 25.3.5
- `@types/sanitize-html` to 2.16.1
- `jose` to 6.2.0

---

## [2.1.4] - 2026-03-04

### Added

- **pubmed_fetch**: `affiliations` (deduplicated author affiliations) and `articleDates` (electronic publication, received, accepted dates) now included in article output
- **Public hosted instance**: Added public Streamable HTTP endpoint (`https://pubmed.caseyjhand.com/mcp`) to README — no installation required
- **Output schema coverage tests**: New test suite validates that tool output schemas cover every field returned by parsers at runtime, preventing strict-client rejections from `additionalProperties: false`

---

## [2.1.3] - 2026-03-04

### Fixed

- **Telemetry**: Enable OpenTelemetry NodeSDK on Bun — the `isBun` guard was unnecessarily blocking initialization when manual spans, custom metrics, and OTLP export all work correctly

---

## [2.1.2] - 2026-03-04

### Changed

- **Tool rename**: `pmc_fetch` renamed to `pubmed_pmc_fetch` for consistency with the `pubmed_*` naming convention across all tools

### Fixed

- **Config**: Path resolution for logs directory now uses `node:path` utilities (`dirname`, `join`, `isAbsolute`) instead of URL-based arithmetic for cross-platform correctness ([#9](https://github.com/cyanheads/pubmed-mcp-server/pull/9))

### Updated

- `@cloudflare/workers-types` to `4.20260305.1`

---

## [2.1.1] - 2026-03-04

### Fixed

- **Response handler**: `extractTextValues` now handles numeric and boolean primitives emitted by fast-xml-parser when `parseTagValue` is enabled
- **Response handler**: Error detection uses shared `ERROR_PATHS` constant to stay in sync with error message extraction
- **PMC article parser**: Empty PMCID no longer produces a bare "PMC" prefix — returns empty string instead
- **Article parser**: Eliminated redundant `getText()` calls for month, day, and medlineDate in `extractJournalInfo`
- **Citation formatter**: `formatAuthorApa` no longer produces "undefined." when firstName contains consecutive spaces
- **Citation formatter**: Reordered `formatAuthorApa` logic so authors with only initials (no lastName) return formatted initials instead of empty string

### Changed

- **Citation formatter**: `escapeBibtex` refactored from chained `.replace()` calls to a single regex with switch — fixes ordering bug where backslash-then-brace sequences were double-escaped
- **Citation formatter**: `splitPages` simplified with destructuring

### Added

- Comprehensive test coverage for NCBI service edge cases: eSearch non-numeric fields, eSpell fallbacks, eSummary retmode logic, eFetch POST behavior
- Response handler tests: `CannotRetrievePMID` error path, numeric error values, DOCTYPE stripping, `returnRawXml` error passthrough
- Citation formatter tests: BibTeX special character escaping, APA author formatting edge cases, author-count boundaries (1/3/20/21), page splitting with en-dash/em-dash, minimal article formatting
- Article parser tests: PMC ID extraction from `ArticleIdList`, ORCID extraction, ISSN type classification, MedlineDate without year, empty AffiliationInfo handling
- ESummary parser tests: nested Author objects, string authors, PMC ID from ArticleIds, FullJournalName fallback
- PMC article parser tests: `pmc-uid` fallback, empty PMCID, affiliations, page ranges, pub-date priority (epub > ppub > pub)

---

## [2.1.0] - 2026-03-04

### Added

- **`pubmed_pmc_fetch` tool**: Fetch full-text articles from PubMed Central (PMC) via NCBI EFetch with `db=pmc`. Accepts PMC IDs directly or PubMed IDs (auto-resolved to PMCIDs via ELink). Returns structured body sections, subsections, metadata, and optional references parsed from JATS XML.
- **PMC article parser**: JATS XML parser (`pmc-article-parser.ts`) extracts metadata (authors, affiliations, journal, keywords, publication date, abstract), recursive body sections, and back-matter references from PMC EFetch responses.
- **PMC types**: JATS XML element types and parsed PMC result types (`XmlJatsArticle`, `ParsedPmcArticle`, etc.) in `src/services/ncbi/types.ts`.

### Changed

- **NCBI response handler**: Added PMC JATS-specific jpaths (`pmc-articleset.article`, `contrib-group.contrib`, `body.sec`, `ref-list.ref`, etc.) to the `isArray` set for consistent XML parsing.
- **README**: Added `pubmed_pmc_fetch` tool documentation, updated server description to mention full-text fetch.

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
