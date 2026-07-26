# Changelog

All notable changes to this project. Each entry links to its full per-version file in [changelog/](changelog/).

## [2.10.1](changelog/2.10.x/2.10.1.md) — 2026-07-26

eSearch upstream failures now throw instead of masking as zero-hit searches; pubmed_search_articles surfaces ignored field tags, unmatched phrases, and dropped partial dateRange filters via notice; the summaryCount cap message points at pubmed_fetch_articles when maxed; research_plan's includeAgentPrompts is now correctly advertised as optional.

## [2.10.0](changelog/2.10.x/2.10.0.md) — 2026-07-26

New pubmed_europepmc_fetch tool (11th tool) resolves full Europe PMC records by source + epmcId; pubmed_fetch_fulltext gains maxCharacters/maxCharactersPerSection/overflowMode budget controls; a shared surrogate-pair-safe slice helper backs both.

## [2.9.10](changelog/2.9.x/2.9.10.md) — 2026-07-26

pubmed_fetch_fulltext: EPMC/PMCID query builders fixed, front-matter-only records fall through the retrieval chain instead of being dropped, pmcids input reaches Unpaywall via a resolved DOI, and Unpaywall articles carry a pmcId backlink. Dead 404-handling branches removed from the Europe PMC and OpenAlex clients.

## [2.9.9](changelog/2.9.x/2.9.9.md) — 2026-07-26

pubmed_lookup_mesh gets true upstream totalCount plus offset/nextOffset pagination; pubmed_lookup_citation stops false-flagging authors ranked 4th or later; pubmed_spell_check threads ctx.signal into ESpell. Adopts mcp-ts-core 0.11.0.

## [2.9.8](changelog/2.9.x/2.9.8.md) — 2026-06-30

pubmed_fetch_fulltext surfaces a recovery notice when a sections filter removes every body section from an article that had one — naming the requested terms and affected article ids, still returning the article; detected on both the PMC and Europe PMC paths. Adopts mcp-ts-core 0.10.10.

## [2.9.7](changelog/2.9.x/2.9.7.md) — 2026-06-20

Adopt mcp-ts-core 0.10.9: devcheck gains a Dependency Specifiers guard (floating latest/*/dist-tags) and plugin-manifest checks in lint:packaging; fresh-scaffold git guards; 14 skills re-synced; dependency refresh

## [2.9.6](changelog/2.9.x/2.9.6.md) — 2026-06-18

Output cleanups: convert_ids accepts mixed PMC/bare-digit batches; europepmc_search and fetch_articles strip leaked markup and decode entities; europepmc_search splits its silent-rejection diagnosis from its recovery hint; lookup_mesh drops non-navigable SCR tree pointers

## [2.9.5](changelog/2.9.x/2.9.5.md) — 2026-06-13

Fixes: transient NCBI eutils 500s now reclassify to ServiceUnavailable and retry; pubmed_lookup_mesh returns the canonical MeSH DescriptorUI with a new entrezUid field

## [2.9.4](changelog/2.9.x/2.9.4.md) — 2026-06-11

mcp-ts-core ^0.10.6: post-pack bundle cleaner, packaging identity checks; lint-packaging checks 8–9 synced; orchestrations skill v1.3

## [2.9.3](changelog/2.9.x/2.9.3.md) — 2026-06-11

serverInfo title corrected to machine name pubmed-mcp-server

## [2.9.2](changelog/2.9.x/2.9.2.md) — 2026-06-11

mcp-ts-core ^0.10.5: ctx.enrich.total(), z.stringbool(), server identity fields; totalCount enrichment rename; .mcpbignore anchored

## [2.9.1](changelog/2.9.x/2.9.1.md) — 2026-06-09

fix(fetch_fulltext): element-citation references now delimited; PMC page/bibliographic tokens preserved verbatim

## [2.9.0](changelog/2.9.x/2.9.0.md) — 2026-06-09

find_related: offset pagination, multi-source provider fallback (NCBI → EuropePMC → OpenAlex); europepmc_search: date-sort advisory for PPR-only results

## [2.8.0](changelog/2.8.x/2.8.0.md) — 2026-06-08

Vancouver citation style, full-text reference extraction fix, BibTeX MeSH keyword fix, empty-result notices

## [2.7.11](changelog/2.7.x/2.7.11.md) — 2026-06-04

fetch_fulltext: DOI→PMCID resolution via PMC ID Converter (#64), config-aware tool description (#65)

## [2.7.10](changelog/2.7.x/2.7.10.md) — 2026-06-04

Three ECitMatch fixes: HTTP 500 reclassified as retryable, dropped citations synthesized as not_found, citation validation requires journal or year

## [2.7.9](changelog/2.7.x/2.7.9.md) — 2026-06-02

mcp-ts-core ^0.9.16 → ^0.9.21: per-request log context fix, fetchWithTimeout secret-scrubbing, withRetry fail-fast on non-retryable errors; new scripts/release-github.ts, skill sync

## [2.7.8](changelog/2.7.x/2.7.8.md) — 2026-05-29

mcp-ts-core ^0.9.13 → ^0.9.16: result-set context (effective query, totals, applied filters, empty-result notices) moved to ctx.enrich and mirrored to structuredContent and content[] via enrichmentTrailer render/label

## [2.7.7](changelog/2.7.x/2.7.7.md) — 2026-05-28

mcp-ts-core ^0.9.10 → ^0.9.13: 413 request-body cap, auth-gated landing page default, GET /mcp keywords; landing.requireAuth: false explicit opt-out for hosted instance

## [2.7.6](changelog/2.7.x/2.7.6.md) — 2026-05-27

MCPB install fix — handle unsubstituted `${user_config.X}` env values when optional fields are left blank.

## [2.7.5](changelog/2.7.x/2.7.5.md) — 2026-05-27

Framework `^0.9.6 → ^0.9.10`. Plugin metadata scaffolds. Field-test fixes: tool description ↔ enum alignment, PMC ID schema validation, EuropePMC cursor round-trip.

## [2.7.4](changelog/2.7.x/2.7.4.md) — 2026-05-23

Framework `^0.9.4 → ^0.9.6`. `.mcpbignore` recursive-match fix. Skills synced.

## [2.7.3](changelog/2.7.x/2.7.3.md) — 2026-05-22

Framework `^0.9.3 → ^0.9.4`. Documents opt-in `MCP_GC_PRESSURE_INTERVAL_MS` for HTTP heap-growth mitigation.

## [2.7.2](changelog/2.7.x/2.7.2.md) — 2026-05-22

Framework `^0.9.1 → ^0.9.3` (zod peer-dep migration). MCPB bundle scaffolding (`manifest.json` + install badges). `fast-xml-parser` unpinned to `^5.8.0` (closes #55).

## [2.7.1](changelog/2.7.x/2.7.1.md) — 2026-05-19

`pubmed_europepmc_search` now surfaces silent EPMC rejections (invalid `sort` field, empty query) as `ValidationError` instead of falling through to a fake 0-hit response.

## [2.7.0](changelog/2.7.x/2.7.0.md) — 2026-05-18 · ⚠️ Breaking

New `pubmed_europepmc_search` tool surfaces preprints, patents, Agricola, and EPMC-only OA records. `pubmed_fetch_fulltext` chain expands to NCBI PMC → Europe PMC `fullTextXML` → Unpaywall with a `dois` input branch ([#52](https://github.com/cyanheads/pubmed-mcp-server/issues/52)).

## [2.6.12](changelog/2.6.x/2.6.12.md) — 2026-05-16

NCBI queue wait now counts toward `totalDeadlineMs`, so a slow upstream can't backlog tools into 10+ min latencies ([#50](https://github.com/cyanheads/pubmed-mcp-server/issues/50)). `pubmed_find_related` similar switches to `cmd=neighbor` to dodge NCBI's unstable scoring backend ([#53](https://github.com/cyanheads/pubmed-mcp-server/issues/53)).

## [2.6.11](changelog/2.6.x/2.6.11.md) — 2026-05-13

Adopts `@cyanheads/mcp-ts-core` 0.9.0 (Workers under `nodejs_compat`, `instructions` field, portability lint family). Pins `fast-xml-parser` to `~5.7.3` to avoid the 5.8.0 `XMLValidator` deprecation in favor of an unproven sibling package. Server now ships an `instructions` string.

## [2.6.10](changelog/2.6.x/2.6.10.md) — 2026-05-10

Reclassify NCBI prolog-only XML responses as transient `ServiceUnavailable` so the retry chain recovers, fixing intermittent `pubmed_find_related` (and any eLink) failures caused by upstream TXCLIENT EOFs.

## [2.6.9](changelog/2.6.x/2.6.9.md) — 2026-05-10

Service-layer error-contracts module with `recoveryFor()` helper; `pubmed_convert_ids` 400-leak rewrite; `pubmed_find_related` ELink `<ERROR>` folded into ESummary disambiguation. Adopts `@cyanheads/mcp-ts-core` 0.8.20.

## [2.6.8](changelog/2.6.x/2.6.8.md) — 2026-05-09

Fix `server.json` top-level `version` field missed in v2.6.7 — kept the registry stuck at 2.6.6 even though the two `packages[*].version` entries advanced. No code changes.

## [2.6.7](changelog/2.6.x/2.6.7.md) — 2026-05-09

Adopts `@cyanheads/mcp-ts-core` 0.8.6 → 0.8.19 — HTTP SSE per-request leak fix, OTel double-write fix, `ctx.sessionId` / `ctx.auth.token`. Node engine ≥24.0.0; Dockerfile pinned to `oven/bun:1.3`.

## [2.6.6](changelog/2.6.x/2.6.6.md) — 2026-04-29 · ⚠️ Breaking

Recovery hints on every error contract; `pubmed_convert_ids` input renamed `idtype` → `idType` for camelCase parity; adopts `@cyanheads/mcp-ts-core` v0.8.6.

## [2.6.5](changelog/2.6.x/2.6.5.md) — 2026-04-28 · ⚠️ Breaking

Typed error contracts on NCBI tools, service-layer logger metadata typed end-to-end, fuzz coverage for all 9 tools, plus DX renames on `pubmed_format_citations` (`styles` → `format`) and `pubmed_lookup_mesh` (`term` → `query`).

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
