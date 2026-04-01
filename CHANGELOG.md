# Changelog

All notable changes to this project will be documented in this file.

---

## [2.3.1] - 2026-04-01

### Fixed

- **`pubmed_search_articles`**: Empty `dateRange` strings (e.g., `{ minDate: "", maxDate: "" }`) no longer produce a malformed NCBI query returning 0 results — the handler now skips the date clause when either date is empty ([#14](https://github.com/cyanheads/pubmed-mcp-server/issues/14))
- **`pubmed_search_articles`**: Date field descriptions updated to reflect accepted NCBI formats (`YYYY/MM/DD`, `YYYY/MM`, or `YYYY`)

### Added

- **Test coverage**: 7 new tests for `dateRange` handling — empty strings, omitted dateRange, partial dates, valid dates, and dash-to-slash conversion

---

## [2.3.0] - 2026-03-31

### Added

- **`pubmed_lookup_citation` tool**: Resolve partial bibliographic references (journal, year, volume, page, author) to PubMed IDs via NCBI ECitMatch. Batch up to 25 citations per request with deterministic matching.
- **`pubmed_convert_ids` tool**: Convert between DOI, PMID, and PMCID using the PMC ID Converter API. Batch up to 50 IDs per request; returns all available identifier mappings.
- **`NcbiService.eCitMatch()`**: ECitMatch service method — formats bdata pipe-delimited strings, parses multi-line responses, handles NOT_FOUND/AMBIGUOUS results.
- **`NcbiService.idConvert()`**: PMC ID Converter service method — JSON-based external API call with error classification.
- **`NcbiApiClient.makeExternalRequest()`**: HTTP client method for non-eutils NCBI endpoints (e.g., PMC ID Converter). Uses plain fetch with `AbortSignal.timeout` for response body access on error status codes.
- **Test coverage**: Full test suites for both new tools and service methods (eCitMatch parsing, idConvert JSON handling, input validation, format output)

### Changed

- **Retry logic**: Extracted inline retry loop from `performRequest` into reusable `withRetry()` method, shared by both eutils and external API calls
- **HTTP error classification**: `NcbiApiClient` now distinguishes 4xx (InvalidRequest) from 5xx (ServiceUnavailable) errors instead of treating all non-OK responses as ServiceUnavailable
- **Endpoint suffix handling**: `api-client.ts` skips `.fcgi` suffix for endpoints that already contain a dot (e.g., `ecitmatch.cgi`)

### Docs

- Updated README tool count (7 → 9), added tool descriptions and detail sections for both new tools
- Updated CLAUDE.md tool count (7 → 9)
- Regenerated `docs/tree.md` with new files

---

## [2.2.6] - 2026-03-30

### Changed

- **add-tool skill** (v1.1): Content-complete `format()` template; new Tool Response Design section covering batch input, partial success, empty results, error classification, operational metadata, and context budget
- **add-resource skill** (v1.1): Added tool coverage guidance — verify data is reachable via the tool surface for tool-only clients
- **design-mcp-server skill** (v2.1): Tools-first design philosophy, live API probing step, batch input design patterns, convenience shortcuts, error design table with classification, resilience and API efficiency planning, naming convention refinement

### Updated

- `@cyanheads/mcp-ts-core` to ^0.2.10
- `@biomejs/biome` to ^2.4.10

---

## [2.2.5] - 2026-03-28

### Updated

- `@cyanheads/mcp-ts-core` to ^0.2.8

---

## [2.2.4] - 2026-03-28

### Added

- **fetch-articles format**: Affiliations, keywords, MeSH terms (with major topic markers and qualifiers), and grant information now rendered in format output
- **fetch-fulltext format**: Authors, affiliations, journal info, article type, publication date, PubMed URL, keywords, and reference list now rendered in format output; unavailable PMC IDs surfaced
- **Skills**: `report-issue-framework` and `report-issue-local` for filing bugs/feature requests against the framework or this server

### Changed

- **polish-docs-meta skill**: Updated to v1.2 — added GitHub repo metadata sync step, description propagation rule (`package.json` → README header, `server.json`, Dockerfile), renumbered checklist steps

### Refactored

- Optional chaining cleanup in `article-parser.ts` and `fetch-articles.tool.ts` (replaced `x && x.y` with `x?.y`)

### Updated

- `@cyanheads/mcp-ts-core` to ^0.2.3
- `@biomejs/biome` to ^2.4.9
- `vitest` to ^4.1.2

### Security

- Added overrides for `brace-expansion` (>=2.0.3), `path-to-regexp` (>=8.4.0), `picomatch` (>=4.0.4), `yaml` (>=2.8.3)

### Docs

- Added `LOGS_DIR` env var to README and reference docs

---

## [2.2.3] - 2026-03-24

### Changed

- **Retry logic**: Moved retry with exponential backoff from `NcbiApiClient` (HTTP-only) to `NcbiService.performRequest`, so retries now cover both HTTP-level failures and XML-level NCBI errors (e.g., 200 OK with C++ exception traces in the response body)
- **Backoff timing**: Retry delays changed from 200ms base (200, 400, 800ms) to 1s base (1s, 2s, 4s) for more conservative backoff
- **`api-client`**: Simplified to single-attempt; now checks `response.ok` and throws `ServiceUnavailable` for non-OK HTTP status codes

### Added

- **HTML response detection**: `NcbiResponseHandler` now detects HTML responses from NCBI (typically rate-limiting pages) and throws `ServiceUnavailable` instead of an opaque XML parse error
- **Retry integration tests**: New colocated test file `src/services/ncbi/ncbi-service.test.ts` — 8 tests covering HTTP retry, XML-level retry, timeout retry, non-retryable error passthrough, exhaustion messaging, and backoff timing

---

## [2.2.2] - 2026-03-24

### Changed

- **fetch-articles format**: Now displays authors (first 3 + "et al."), journal info (abbreviation, year, volume, issue, pages), publication types, and unavailable PMIDs
- **fetch-fulltext format**: Renders subsections within body sections
- **find-related**: Added `source` and `pubDate` fields to output schema and format display

### Fixed

- **NCBI error messages**: Raw C++ exception traces from NCBI are now replaced with concise, user-friendly messages

### Updated

- `@cyanheads/mcp-ts-core` to 0.1.29

---

## [2.2.1] - 2026-03-23

### Fixed

- **package.json**: Added `mcpName` field required by the MCP registry for publishing

---

## [2.2.0] - 2026-03-23

### Framework Migration

The server was migrated to use the `@cyanheads/mcp-ts-core` framework for MCP plumbing. This will simplify and streamline future development.

### Tool Renames

All tools were renamed for clarity. Schemas and capabilities are unchanged.

| Previous (v2.1.x) | New (v2.2.0) |
|:-------------------|:-------------|
| `pubmed_search` | `pubmed_search_articles` |
| `pubmed_fetch` | `pubmed_fetch_articles` |
| `pubmed_pmc_fetch` | `pubmed_fetch_fulltext` |
| `pubmed_related` | `pubmed_find_related` |
| `pubmed_cite` | `pubmed_format_citations` |
| `pubmed_mesh_lookup` | `pubmed_lookup_mesh` |
| `pubmed_spell` | `pubmed_spell_check` |

### Changed

- **Framework migration**: Replaced inline framework code (~58k lines) with `@cyanheads/mcp-ts-core` package dependency. All tools, resources, and prompts now use the framework's declarative builders (`tool()`, `resource()`, `prompt()`)
- **Tool definitions**: Rewritten from handler-factory pattern to single-file `tool()` builder definitions with Zod input/output schemas, `format` functions, and `annotations`
- **Resource definition**: `database-info.resource.ts` migrated from custom `ResourceDefinition` type to framework's `resource()` builder with `handler(params, ctx)` pattern
- **Prompt definition**: `research-plan.prompt.ts` migrated from custom `PromptDefinition` type to framework's `prompt()` builder
- **Entry point**: `src/index.ts` simplified from DI container + server bootstrap to single `createApp()` call with tool/resource/prompt arrays
- **NCBI service**: Flattened from `services/ncbi/core/` subdirectory to `services/ncbi/` top-level; uses framework's `logger` instead of custom logger
- **Config**: Replaced monolithic `src/config/index.ts` with focused `src/config/server-config.ts` (NCBI-specific env vars only; framework handles transport, auth, storage)
- **Build**: Switched from custom build scripts to framework-provided `tsconfig.base.json`, `biome.json`, and `vitest.config.ts` extensions
- **Tool file renames**: Files renamed to match tool names (e.g., `pubmed-search.tool.ts` → `search-articles.tool.ts`, `pubmed-spell.tool.ts` → `spell-check.tool.ts`)
- **CLAUDE.md**: Replaced generic placeholder patterns with actual server examples (spell-check tool, database-info resource, NCBI config), updated structure tree, removed unused context properties
- **README.md**: Updated all tool names and descriptions to match renames, updated config section
- **Dockerfile**: Fixed image title/description labels, added `source` label, corrected log directory name and default port
- **Default HTTP port**: Reverted to `3010` across `.env.example`, `Dockerfile`, `README.md`, and `server.json` (was changed to `3017` in 2.0.1)
- **server-config.ts**: Replaced `z.string().email()` with `z.email()` shorthand
- **.env.example**: Added `NCBI_TIMEOUT_MS` entry

### Added

- **Test suite**: 178 tests across 17 files in `tests/` mirroring `src/` structure — covers config, NCBI service layer, XML/JSON parsers, citation formatters, all 7 tools, 1 resource, and 1 prompt using `createMockContext()` from `@cyanheads/mcp-ts-core/testing`
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
- **Legacy tests**: Old test suite removed (covered framework internals, not server logic); replaced by new `tests/` suite
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
