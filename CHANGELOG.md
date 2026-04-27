# Changelog

All notable changes to this project. Each entry links to its full per-version file in [changelog/](changelog/).

## [2.6.4](changelog/2.6.x/2.6.4.md) — 2026-04-26

Description audit follow-up to v2.6.3 — cross-field constraints surface in tool descriptions, and `pubmed_format_citations` no longer throws on zero matches.

## [2.6.3](changelog/2.6.x/2.6.3.md) — 2026-04-26

Cross-field input violations on `pubmed_fetch_fulltext` and `pubmed_lookup_citation` now classify as `-32602` instead of `-32603` (closes [#46](https://github.com/cyanheads/pubmed-mcp-server/issues/46)).

## [2.6.2](changelog/2.6.x/2.6.2.md) — 2026-04-26

Maintenance — `@cyanheads/mcp-ts-core` 0.7.0 → 0.7.5, `fast-xml-parser` 5.7.1 → 5.7.2. No runtime API changes for this server.

## [2.6.1](changelog/2.6.x/2.6.1.md) — 2026-04-24

Field-test correctness + DX pass.

## [2.6.0](changelog/2.6.x/2.6.0.md) — 2026-04-24

Closes [#34](https://github.com/cyanheads/pubmed-mcp-server/issues/34) — non-PMC full-text fallback via Unpaywall.

## [2.5.6](changelog/2.5.x/2.5.6.md) — 2026-04-24

Correctness + ergonomics pass on `pubmed_lookup_citation`.

## [2.5.5](changelog/2.5.x/2.5.5.md) — 2026-04-24

Framework minor bump (`@cyanheads/mcp-ts-core` 0.6.17 → 0.7.0).

## [2.5.3](changelog/2.5.x/2.5.3.md) — 2026-04-23

Framework patch bump (`@cyanheads/mcp-ts-core` 0.6.8 → 0.6.10) and agent-protocol polish.

## [2.5.2](changelog/2.5.x/2.5.2.md) — 2026-04-22

Framework patch series bump (`@cyanheads/mcp-ts-core` 0.6.5 → 0.6.8) and documentation refresh.

## [2.5.1](changelog/2.5.x/2.5.1.md) — 2026-04-22

End-to-end cancellation.

## [2.5.0](changelog/2.5.x/2.5.0.md) — 2026-04-21

Three feature tracks land together: MCPmed-aligned semantic concept tags on every tool, an HTTP landing page with per-tool view-source links, and a framework bump to `@cyanheads/mcp-ts-core` 0.6.3 that exposes `sourceUrl?` on definitions so the…

## [2.4.1](changelog/2.4.x/2.4.1.md) — 2026-04-20

Adopts `@cyanheads/mcp-ts-core` 0.5.3, whose new `format-parity` lint rule flagged 20 tool fields that were declared in `output` but never rendered by `format()`.

## [2.4.0](changelog/2.4.x/2.4.0.md) — 2026-04-20

Extends the `content[]`-completeness work from #26 across the rest of the tool surface.

## [2.3.11](changelog/2.3.x/2.3.11.md) — 2026-04-20

`pubmed_fetch_articles` format() renders all schema fields in `content[]` (closes [#26](https://github.com/cyanheads/pubmed-mcp-server/issues/26)); actionable PMID validation errors (#27); parser omits empty arrays for absent fields (#28).

## [2.3.10](changelog/2.3.x/2.3.10.md) — 2026-04-20

PMC full-text parser preserves document order via `preserveOrder: true` (closes [#19](https://github.com/cyanheads/pubmed-mcp-server/issues/19)); all-invalid-ID fetches now surface failures (closes #20).

## [2.3.9](changelog/2.3.x/2.3.9.md) — 2026-04-20

`pubmed_search_articles` — restores DOI/PMC IDs in brief summaries (closes [#17](https://github.com/cyanheads/pubmed-mcp-server/issues/17)); adds date validation, filter docs, empty-result guidance (closes #18).

## [2.3.8](changelog/2.3.x/2.3.8.md) — 2026-04-20

`pubmed_fetch_fulltext` PMID→PMCID resolution switched from eLink to PMC ID Converter (closes [#16](https://github.com/cyanheads/pubmed-mcp-server/issues/16)); `@cyanheads/mcp-ts-core` 0.3.7 → 0.4.1.

## [2.3.7](changelog/2.3.x/2.3.7.md) — 2026-04-20

Citation formatter fixes — APA collective-author period, RIS page expansion, BibTeX double-period; adds pub-type mapping, ISSN, PMC URL, MeSH keywords (closes [#15](https://github.com/cyanheads/pubmed-mcp-server/issues/15)).

## [2.3.6](changelog/2.3.x/2.3.6.md) — 2026-04-19

Maintenance — five deps updated, `overrides` block removed (all nine pinned transitives patched upstream), tool description strings collapsed to single-paragraph convention.

## [2.3.5](changelog/2.3.x/2.3.5.md) — 2026-04-13

XML handling — raised entity expansion ceiling, preserved diacritics, wrapped parser failures as `SerializationError`. Retry tightened: only transient `McpError` retries. `fast-xml-parser` ^5.5.12.

## [2.3.4](changelog/2.3.x/2.3.4.md) — 2026-04-12

HTTP 429 now classified as `RateLimited` and retried; default `maxRetries` raised 3 → 6 with 30s backoff cap and ±25% jitter.

## [2.3.3](changelog/2.3.x/2.3.3.md) — 2026-04-09

Output enrichments — `pubmed_search_articles` adds `effectiveQuery` and `appliedFilters`, `pubmed_lookup_citation` adds per-citation `status`, `pubmed_format_citations` adds partial-result counters.

## [2.3.2](changelog/2.3.x/2.3.2.md) — 2026-04-04

ESummary date parsing fix (`parseNcbiDate`), `pubmed_fetch_fulltext` now propagates eFetch errors, `pubmed_search_articles` uses `effectiveQuery` for PubMed link, `pubmed_format_citations` adds POST mode for large batches.

## [2.3.1](changelog/2.3.x/2.3.1.md) — 2026-04-01

Fix `pubmed_search_articles` ignoring empty `dateRange` strings — skips date clause instead of producing a malformed NCBI query (closes [#14](https://github.com/cyanheads/pubmed-mcp-server/issues/14)).

## [2.3.0](changelog/2.3.x/2.3.0.md) — 2026-03-31

Adds `pubmed_lookup_citation` (ECitMatch, batch 25) and `pubmed_convert_ids` (DOI/PMID/PMCID via PMC ID Converter, batch 50). Refactored retry logic and HTTP error classification in `NcbiApiClient`.

## [2.2.6](changelog/2.2.x/2.2.6.md) — 2026-03-30

Skill updates — `add-tool` v1.1 expands `format()` template and adds Tool Response Design section; `add-resource` and `design-mcp-server` gain coverage guidance and tools-first patterns. Bumps `mcp-ts-core` ^0.2.10, `biome` ^2.4.10.

## [2.2.5](changelog/2.2.x/2.2.5.md) — 2026-03-28

Maintenance — `@cyanheads/mcp-ts-core` bumped to ^0.2.8. No runtime API changes.

## [2.2.4](changelog/2.2.x/2.2.4.md) — 2026-03-28

Format output enriched — `pubmed_fetch_articles` gains affiliations, MeSH/grants; `pubmed_fetch_fulltext` gains authors, journal, references. Deps: `mcp-ts-core` →0.2.3, `biome` →2.4.9.

## [2.2.3](changelog/2.2.x/2.2.3.md) — 2026-03-24

Retry logic moved to `NcbiService.performRequest` to cover XML-level NCBI errors; backoff changed to 1s base; HTML rate-limit responses now throw `ServiceUnavailable`. 8 new retry integration tests.

## [2.2.2](changelog/2.2.x/2.2.2.md) — 2026-03-24

Format improvements for `fetch-articles`, `fetch-fulltext`, and `find-related`; NCBI raw exception traces replaced with user-friendly messages; `@cyanheads/mcp-ts-core` 0.1.29.

## [2.2.1](changelog/2.2.x/2.2.1.md) — 2026-03-23

Fix: adds missing `mcpName` field to `package.json` required by the MCP registry for publishing.

## [2.2.0](changelog/2.2.x/2.2.0.md) — 2026-03-23

The server was migrated to use the `@cyanheads/mcp-ts-core` framework for MCP plumbing.

## [2.1.6](changelog/2.1.x/2.1.6.md) — 2026-03-09

Fix: `structuredContent` removed from error responses (valid for success only); `fast-check` → 4.6.0, `jose` → 6.2.1.

## [2.1.5](changelog/2.1.x/2.1.5.md) — 2026-03-06

NCBI config now logged at startup (API key status, delay, retries, timeout). Dep bumps: `@biomejs/biome` 2.4.6, `jose` 6.2.0, `@types/node` 25.3.5.

## [2.1.4](changelog/2.1.x/2.1.4.md) — 2026-03-04

`pubmed_fetch` gains `affiliations` and `articleDates` fields; public hosted endpoint added to README; new output-schema coverage tests prevent strict-client rejections.

## [2.1.3](changelog/2.1.x/2.1.3.md) — 2026-03-04

Fix: OpenTelemetry NodeSDK now initializes on Bun — `isBun` guard removed, manual spans, custom metrics, and OTLP export all work correctly.

## [2.1.2](changelog/2.1.x/2.1.2.md) — 2026-03-04

`pmc_fetch` renamed to `pubmed_pmc_fetch`; log directory path resolution switched to `node:path` for cross-platform correctness ([#9](https://github.com/cyanheads/pubmed-mcp-server/pull/9)).

## [2.1.1](changelog/2.1.x/2.1.1.md) — 2026-03-04

Bug fixes across response handler, PMC/article parsers, and citation formatter — plus comprehensive test coverage for NCBI service and parser edge cases.

## [2.1.0](changelog/2.1.x/2.1.0.md) — 2026-03-04

Adds `pubmed_pmc_fetch` tool — fetch full-text articles from PubMed Central via NCBI EFetch, with a JATS XML parser returning structured body sections, metadata, and references.

## [2.0.1](changelog/2.0.x/2.0.1.md) — 2026-03-04

`pubmed_search` gains field filters, offset pagination, and PMC URLs; `pubmed_mesh_lookup` exact-heading sort; `pubmed_trending` removed; six tool and config defaults revised.

## [2.0.0](changelog/2.0.x/2.0.0.md) — 2026-03-04

Initial release — 7 PubMed tools, NCBI E-utilities service layer (eSearch/eSummary/eFetch/eLink/eSpell/eInfo with rate-limit + retry), `research_plan` prompt, and `pubmed://database/info` resource.
