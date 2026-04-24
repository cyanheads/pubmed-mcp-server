# Changelog

All notable changes to this project will be documented in this file.

---

## [2.5.5] - 2026-04-24

Framework minor bump (`@cyanheads/mcp-ts-core` 0.6.17 → 0.7.0). Issue-cleanup release from upstream with no runtime breaking changes. Picks up the devcheck changelog-sync crash fix for single-file `CHANGELOG.md` consumers (this server), the flattened ZodError message shape with structured `data.issues`, locale-aware digit-group separators in the `format-parity` linter rule, and new GitHub issue-management scaffolding. Adopts the framework template updates into `CLAUDE.md` / `AGENTS.md`, syncs five skill version bumps, and scaffolds `.github/ISSUE_TEMPLATE/` for bug reports and feature requests.

### Added

- **`.github/ISSUE_TEMPLATE/`** (`bug_report.yml`, `feature_request.yml`, `config.yml`): Copied from `node_modules/@cyanheads/mcp-ts-core/templates/.github/ISSUE_TEMPLATE/` (0.7.0 scaffolding). Structured bug report with runtime / transport / framework-version fields, a feature request form, and disabled blank-issue creation. Both forms reference secondary labels (`regression`, `performance`, `security`, `breaking-change`) documented inline; assignees line left commented. Create missing labels on the repo once with `gh label create <name>` if you want the sidebar hint to resolve.
- **`security-pass` skill reference in agent protocol** (`CLAUDE.md`, `AGENTS.md`): Added as item #8 in the "What's Next?" list and to the Skills table. The skill file itself was already adopted in 2.5.4; this wires it into the template's orientation surface per 0.7.0.

### Changed

- **Framework bump — `@cyanheads/mcp-ts-core` 0.6.17 → 0.7.0** (`package.json`, `bun.lock`): Issue-cleanup release, no runtime breaking changes.
  - **Flattened ZodError message shape** (upstream #55): `getErrorMessage(err)` now detects `ZodError` and returns `<first-issue.message> at <path> (+N more)` instead of the raw serialized issue array. Resource param validation, tool output validation, and user-thrown `ZodError` now populate `error.data.issues` with the full `ZodIssue[]`; for tools, issues surface via `_meta.error.data.issues` alongside explicit `McpError.data`. Verified wire-transparent — no code paths in this server's `src/` or `tests/` parse `error.message` JSON, so downstream behavior is unchanged (cleaner logs aside).
  - **Locale-aware `format-parity` linter** (upstream #54): Numeric sentinel matching now retries against text with common digit-group separators stripped (comma, period, underscore, apostrophe, right single quote, space variants including narrow no-break U+202F, Arabic thousands U+066C). Covers en-US, de-DE, fr-FR, de-CH formatting.
  - **Devcheck changelog-sync crash fix** (upstream #51): Guard now checks only for the `changelog/` directory; the monolithic `CHANGELOG.md` alone is a supported configuration. This server uses single-file `CHANGELOG.md`, so the step now skips cleanly (⚪ SKIPPED) instead of crashing on `readdirSync` `ENOENT`. We filed this upstream during the 2.5.4 cycle; it's now resolved in the framework directly.
- **Phase C script sync — `scripts/devcheck.ts`**: Resynced from `@cyanheads/mcp-ts-core/scripts/devcheck.ts` (only framework script whose content hash differed). Picks up the guard described above. Other framework scripts (`build.ts`, `build-changelog.ts`, `check-docs-sync.ts`, `check-skills-sync.ts`, `clean.ts`, `lint-mcp.ts`, `tree.ts`) were already in sync.
- **Phase A skill sync — five skill version bumps** (`skills/`, `.agents/skills/`, `.claude/skills/`): `api-linter` 1.0 → 1.1 (recursion-rules table for `describe-on-fields`, primitive array elements explicitly skipped, softened "mechanical fix" framing); `maintenance` 1.4 → 1.5 (Step 4 template review defaults to direct application of framework-authored updates; Step 6 splits into two tiers — framework changes default adopt, third-party changes default cost/benefit; Step 8 renames "Needs attention" → "Open decisions"); `release-and-publish` 2.0 → 2.1 (transient-failure retry protocol for network steps 3–6 with short backoff, idempotent-success skip signals for npm / MCP Registry, `docker builder prune -f` before retrying `buildx --push`); `report-issue-framework` 1.2 → 1.3 and `report-issue-local` 1.2 → 1.3 (primary + secondary label restructure, `--assignee "@me"` CLI examples, `gh label create` bootstrap block in the local skill).
- **Phase B agent skill refresh** (`.claude/skills/`, `.agents/skills/`): All 25 project skills copied end-to-end into both agent-discovery paths, including the five version bumps from Phase A.
- **`CLAUDE.md` / `AGENTS.md` template sync**: Skill-directory callout now references the maintenance skill's Phase B auto-resync instead of instructing a manual re-copy — matches the v1.5 maintenance flow.



Framework patch series bump (`@cyanheads/mcp-ts-core` 0.6.10 → 0.6.17) and a code-cohesion pass. Picks up the new recursive `describe-on-fields` linter (0.6.16) and an HTTP transport per-request `McpServer` race fix (0.6.17). Adds the new `security-pass` skill, syncs the Phase C build/check scripts from the package, and refactors two heavy output schemas into named sub-schemas for readability — verified wire-format-transparent. No library API changes, no tool behavior changes.

### Added

- **`security-pass` skill** (`skills/security-pass/`, `.agents/skills/security-pass/`): New v1.1 skill from framework 0.6.14 — systematic audit pass covering secrets, input validation, rate limiting, error surface, and dependency hygiene. Available as first-class skill for post-change security review.
- **Phase C build/check scripts** (`scripts/build-changelog.ts`, `scripts/check-docs-sync.ts`, `scripts/check-skills-sync.ts`): Copied from `@cyanheads/mcp-ts-core` 0.6.16 as part of the new package → project script sync path. `build-changelog.ts` is invoked by the `devcheck` Changelog Sync step with an added `existsSync(CHANGELOG_DIR)` early-exit to handle single-file `CHANGELOG.md` projects (this server does not use a directory-based changelog). Filed upstream as [cyanheads/mcp-ts-core#51](https://github.com/cyanheads/mcp-ts-core/issues/51).

### Changed

- **Framework bump — `@cyanheads/mcp-ts-core` 0.6.10 → 0.6.17** (`package.json`, `bun.lock`): seven patch releases rolled up.
  - **0.6.11–0.6.13**: Template + skill polish (internal-audience), no consumer impact.
  - **0.6.14**: Ships the `security-pass` skill (adopted above).
  - **0.6.15**: Landing-page hardening.
  - **0.6.16**: Definition-linter upgrade — `describe-on-fields` now walks nested object properties, array element schemas, and union variants recursively. Flagged 19 missing `.describe()` calls on inner schemas across this server's 9 tools + 1 resource; all added in this release.
  - **0.6.17**: HTTP transport fix — per-request `McpServer` instantiation resolves a session race where concurrent requests on the same session could see cross-wired tool registrations.
- **Schema refactor — `fetch-articles.tool.ts`, `fetch-fulltext.tool.ts`**: Extracted deeply nested inline `z.object({...})` output schemas into named module-scoped schemas (`AuthorSchema`, `JournalInfoSchema`, `MeshTermSchema`, `GrantSchema`, `ArticleDateSchema`, `FetchedArticleSchema`, `SubsectionSchema`, `SectionSchema`, `ReferenceSchema`, `PublicationDateSchema`, `FulltextArticleSchema`, etc.). Code-organization change only — verified byte-identical JSON Schema output via `toJSONSchema` from `zod/v4/core`, so MCP SDK's `tools/list` emission and the LLM's view of the tool are unchanged.
- **`describe-on-fields` compliance** (`convert-ids.tool.ts`, `find-related.tool.ts`, `search-articles.tool.ts`, `lookup-mesh.tool.ts`, `lookup-citation.tool.ts`, `format-citations.tool.ts`, `database-info.resource.ts`): Added `.describe()` on 19 previously unannotated array element schemas and nested object properties flagged by the 0.6.16 recursive linter. Tools' surface descriptions unchanged — this fills in the missing per-field hints for nested structures.
- **Project skills synced from 0.6.17** (`skills/`, `.agents/skills/`): `security-pass` v1.1 added; `field-test` 1.3 → 2.0 (HTTP + JSON-RPC helper, universal battery vs situational categories); content refreshes at same version on `add-tool`, `design-mcp-server`, `maintenance`, `polish-docs-meta`, `release-and-publish`, `report-issue-framework`, `report-issue-local`, `setup`. Both agent skill directories refreshed end-to-end.
- **Project scripts synced from 0.6.16** (`scripts/devcheck.ts`, `scripts/lint-mcp.ts`, `scripts/tree.ts`): picked up the new Docs Sync + Changelog Sync + Skills Sync steps in `devcheck.ts` and linter-rule updates in `lint-mcp.ts`.
- **`AGENTS.md` re-synced from `CLAUDE.md`**: the two were out of sync (2.5.0 vs 2.5.3); the mirror is now re-established.
- **Biome patch bump — `@biomejs/biome` 2.4.12 → 2.4.13** (`package.json`, `bun.lock`): internal fixes only.

### Tests

- Full suite: **409 passed** / 4 skipped / 0 regressions. `bun run devcheck` green across all 11 checks (Docs Sync, Changelog Sync, Skills Sync, and MCP definition lint included). Field-tested all 9 tools via real HTTP + JSON-RPC transport — happy path, `structuredContent` ↔ `content[]` parity, and input-validation error messages verified.

---

## [2.5.3] - 2026-04-23

Framework patch bump (`@cyanheads/mcp-ts-core` 0.6.8 → 0.6.10) and agent-protocol polish. 0.6.9 is an internal landing-page refactor with a new CSP header and per-request render memoization; 0.6.10 renames the `release` skill to `release-and-publish` and expands the `setup` skill to cover everything `init` scaffolds. No library API changes — no code edits required.

### Changed

- **Framework bump — `@cyanheads/mcp-ts-core` 0.6.8 → 0.6.10** (`package.json`, `bun.lock`): 0.6.9 splits the 1.7kLOC landing-page monolith into `landing-page/` sub-modules, adds a strict `Content-Security-Policy` header to `GET /`, and memoizes both full and degraded render paths when `transport.publicUrl` is set. 0.6.10 renames the shipping skill to `release-and-publish` (v2.0, now `audience: external`) as a post-wrapup publish workflow that runs the verification gate → push → npm → MCP Registry → GHCR, halting on first failure. `setup` skill bumped 1.4 → 1.5. Patch series — no breaking changes and no API surface impact on this server.
- **Project skills synced from 0.6.10** (`skills/`, `.agents/skills/`, `.claude/skills/`): new `release-and-publish` v2.0 skill added; `setup` v1.4 → v1.5. Skipped internal-audience skills (`add-export`, `add-provider`). Both agent skill directories refreshed end-to-end.
- **`CLAUDE.md` agent protocol updates**:
  - Skills table now lists `release-and-publish` so agents can discover it when a release is requested.
  - `## Publishing` section rewritten to direct agents at the `release-and-publish` skill as the primary path; the raw `bun publish` + `docker buildx` commands remain as reference and `mcp-publisher publish` added to cover the MCP Registry leg.
  - Checklist expanded with form-client safety (empty inner values on optional nested objects), `format()` completeness (Claude Code reads `structuredContent`, Claude Desktop reads `content[]` — both must carry the same data), and three NCBI-wrapping items (sparsity review on required/optional fields, uncertainty preservation in normalization/format, sparse-payload test coverage).
  - Zod non-serializable type list in the checklist now enumerates the full set (`z.bigint()`, `z.symbol()`, `z.void()`, `z.map()`, `z.set()`, `z.function()`, `z.nan()` in addition to the existing entries).

### Tests

- Full suite: **409 passed** / 4 skipped / 0 regressions. `bun run devcheck` green across all 8 checks — MCP definition lint, Biome, TypeScript, depcheck, audit, outdated all clean.

---

## [2.5.2] - 2026-04-22

Framework patch series bump (`@cyanheads/mcp-ts-core` 0.6.5 → 0.6.8) and documentation refresh. Picks up the new `MCP_PUBLIC_URL` override for TLS-terminating reverse-proxy deployments (0.6.6), template hygiene fixes (0.6.7), and landing-page visual polish plus a new CSS-injection lint rule (0.6.8). No API surface impact on this server.

### Added

- **`MCP_PUBLIC_URL` env var documentation** (`.env.example`, `README.md`, `server.json`): Surfaces the 0.6.6 override for deployments behind Cloudflare Tunnel / Caddy / nginx / ALB so the landing page, SEP-1649 Server Card, and RFC 9728 protected-resource metadata emit the public `https://` origin instead of the internal container hostname. Declared on the `streamable-http` package entry in `server.json` so MCP registry clients advertise it alongside `MCP_HTTP_HOST`/`MCP_HTTP_PORT`.
- **`MCP_HTTP_ENDPOINT_PATH` env var documentation** (`.env.example`, `README.md`): Documents the existing framework knob for the HTTP mount path (default `/mcp`).

### Changed

- **Framework bump — `@cyanheads/mcp-ts-core` 0.6.5 → 0.6.8** (`package.json`, `bun.lock`): 0.6.6 adds `MCP_PUBLIC_URL` + `design-mcp-server` skill rework (v2.7 codifies the `{server}_{verb}_{noun}` naming default, documents workflow-safety patterns, and diversifies examples beyond email/notifications); 0.6.7 is template hygiene with no consumer impact; 0.6.8 ships landing-page visual polish (auto-derived `--accent-2` secondary token via `oklch` relative color, animated conic-gradient border beam on the connect card, brighter dark-mode surfaces, accent bar prefix on `h2`s) and a new `landing-theme-accent-format` lint rule that rejects CSS-injection payloads in `landing.theme.accent`. Patch series — no breaking changes.
- **`.dockerignore` adds `.agents`** (`.dockerignore`): Mirrors the 0.6.7 template fix. Keeps agent scratch directories out of the production image, matching the existing `.claude` exclusion.
- **Project skills synced from 0.6.6** (`skills/`, `.agents/skills/`, `.claude/skills/`): `add-tool` v1.7 → v1.8, `design-mcp-server` v2.5 → v2.7, `field-test` v1.2 → v1.3, `polish-docs-meta` v1.6 → v1.7.

### Tests

- Full suite: **409 passed** / 4 skipped / 0 regressions. `bun run devcheck` green across all 8 checks — the new `landing-theme-accent-format` rule is a no-op here since `src/index.ts` doesn't set `landing.theme.accent`.

---

## [2.5.1] - 2026-04-22

End-to-end cancellation. `ctx.signal` from every tool and resource handler now threads through the NCBI service layer into both `fetch()` and the retry-loop backoff sleep, so client cancellations and the new service-level deadline interrupt the *full* retry chain instead of waiting for the next attempt to complete. Adds a `NCBI_TOTAL_DEADLINE_MS` knob (default `60000`) that bounds worst-case tool latency regardless of `NCBI_MAX_RETRIES × backoff`.

### Added

- **Service-level deadline + caller-signal abort propagation** (`src/services/ncbi/ncbi-service.ts`, `src/services/ncbi/api-client.ts`, `src/services/ncbi/types.ts`, `src/config/server-config.ts`, `.env.example`):
  - New `runWithDeadline()` wrapper composes an internal `AbortController` (fires at `totalDeadlineMs`) with the caller's `ctx.signal` via `AbortSignal.any()`. The combined signal is threaded into both `apiClient.makeRequest` (cancels the in-flight `fetch`) and the backoff sleep (cancels pending retries).
  - New `abortableSleep()` replaces the bare `setTimeout` in `withRetry()`'s backoff so retry chains short-circuit on abort instead of finishing the current sleep first.
  - New `NcbiCallOptions { signal? }` exported from `types.ts`. Every public `NcbiService` method (`eSearch`, `eSummary`, `eFetch`, `eLink`, `eSpell`, `eInfo`, `eCitMatch`, `idConvert`) now accepts it as its trailing optional arg.
  - New `NCBI_TOTAL_DEADLINE_MS` env var (range `5000`–`600000`, default `60000`). Surfaced in `.env.example`, `README.md` config table, and the Zod schema in `src/config/server-config.ts`. Deadline expiry throws `McpError(JsonRpcErrorCode.Timeout)` with `{ deadlineMs }` data.
  - `NcbiApiClient.makeExternalRequest` (PMC ID Converter — uses `globalThis.fetch` directly, not `fetchWithTimeout`) now composes the per-request `AbortSignal.timeout` with an optional caller signal via `AbortSignal.any()`. `getRequest` / `postRequest` forward an optional `signal` into `fetchWithTimeout` so service-level cancellation reaches the lower-level fetch.

### Changed

- **All 9 tools + database-info resource thread `ctx.signal`** through to the NCBI service (`convert-ids`, `fetch-articles`, `fetch-fulltext`, `find-related`, `format-citations`, `lookup-citation`, `lookup-mesh`, `search-articles`, `database-info.resource`). Single-line wiring per call site — `{ signal: ctx.signal }` is forwarded as the new options arg.
- **`NCBI_TIMEOUT_MS` description clarified** (`.env.example`, `src/config/server-config.ts`, `README.md`): `Request timeout` → `Per-request HTTP timeout` to disambiguate from the new total-deadline knob.
- **Framework bump — `@cyanheads/mcp-ts-core` 0.6.3 → 0.6.5** (`package.json`, `bun.lock`): patch bumps with no API surface impact on this server.

### Tests

- **`api-client.test.ts` (+97 lines)**: 6 new tests covering `signal` forwarding on GET / POST / no-signal paths, plus three `makeExternalRequest` cases (timeout-only signal, `AbortSignal.any()` composition, pre-aborted external signal short-circuit).
- **`ncbi-service.test.ts` (+277 lines)**: three new describe blocks:
  - **Retry behavior with signals** (4 tests): forwards `signal` to `apiClient.makeRequest`, throws `Timeout` when deadline fires before first attempt, short-circuits the retry chain when caller signal aborts before invocation or mid-flight.
  - **Real-timer signal wiring during backoff sleep** (4 tests): proves the deadline + caller-signal both cut backoff sleeps short (≤500ms vs the 750–1250ms first-attempt window) for both `eSearch` (`makeRequest` path) and `idConvert` (`makeExternalRequest` path).
  - **Deadline timer cleanup** (3 tests): pins the contract that every request — success, non-retryable error, exhausted retries — clears its deadline timer (`setTimeout` ↔ `clearTimeout` parity).
- **9 tool-test assertion updates** in `convert-ids`, `fetch-articles`, `fetch-fulltext` (3 sites), `find-related` (3 sites), `search-articles` (4 sites) test files — switch from positional args to `expect.objectContaining({ signal: expect.any(AbortSignal) })` to verify each tool wires `ctx.signal` through to the service.

---

## [2.5.0] - 2026-04-21

Three feature tracks land together: MCPmed-aligned semantic concept tags on every tool, an HTTP landing page with per-tool view-source links, and a framework bump to `@cyanheads/mcp-ts-core` 0.6.3 that exposes `sourceUrl?` on definitions so the auto-derived path convention is overridable without file renames or type casts.

### Added

- **Ontology-backed semantic concept tags on every tool** (`_concepts.ts`, all 9 `*.tool.ts` files): Each tool now emits `_meta['io.mcpmed/concepts']` with resolvable Schema.org (`SearchAction`, `ScholarlyArticle`, `CreativeWork`, `DefinedTerm`, `DefinedTermSet`) and EDAM (`operation_2421` Database search, `operation_2422` Data retrieval, `operation_3282` ID mapping, `operation_0335` Data formatting, `topic_0089` Ontology and terminology, `data_1187` PubMed ID, `data_2091` Accession) URIs — implementing the concept-mapping proposal from Flotho et al., *Briefings in Bioinformatics* 2026 (doi:10.1093/bib/bbag076) with real URIs rather than the paper's placeholder strings. Namespace key follows the MCP `_meta` spec (`<reverse-dns>/<name>`); the `conceptMeta()` helper declares the key once so a rename-on-review is a single-file change. Draft MCPmed listing PR at `docs/mcpmed-pr-draft.md`.
- **HTTP landing page + SEP-1649 Server Card** (`src/index.ts`): `createApp({ landing: { ... } })` wires a server-specific tagline, `repoRoot`, four footer links (PubMed, E-utilities docs, NCBI API key signup, MeSH Browser), and `envExample` surfacing `NCBI_API_KEY` / `NCBI_ADMIN_EMAIL` in the STDIO/Claude CLI connect snippets. The page renders at `/` and the Server Card at `/.well-known/mcp.json` — no new env vars required; Cloudflare pass-through already reaches the container for both paths.
- **Per-tool `sourceUrl` view-source overrides** (all 9 `*.tool.ts` files): Each tool definition now carries an explicit `sourceUrl` pointing at its actual file path. Without the override, the framework's default `snake_case → kebab-case` filename derivation would produce `pubmed-convert-ids.tool.ts` (prefixed) from the tool name `pubmed_convert_ids`, while our actual file is `convert-ids.tool.ts` (unprefixed, since the directory already namespaces). Landing-page per-tool view-source links now resolve.

### Changed

- **Framework bump — `@cyanheads/mcp-ts-core` 0.5.3 → 0.6.3**: 0.5.4 added the `api-linter` skill and a diagnostic breadcrumb on every `LintDiagnostic`; 0.6.0 introduced the landing page, SEP-1649 Server Card, `LandingConfig` export, and directory-based changelog system (opt-in per 0.6.2); 0.6.1 added `envExample` and the tabbed terminal-chrome connect card; 0.6.2 softened the directory-based changelog prescription so runtime-only consumer servers can stay monolithic (closes [cyanheads/mcp-ts-core#41](https://github.com/cyanheads/mcp-ts-core/issues/41)) and clarified `changelog/unreleased.md` as a pristine format reference; 0.6.3 exposed `sourceUrl?: string` on `ToolDefinition` / `ResourceDefinition` / `PromptDefinition` (closes [cyanheads/mcp-ts-core#42](https://github.com/cyanheads/mcp-ts-core/issues/42)).
- **Test runner — `vitest` 4.1.4 → 4.1.5**: patch bump (bug fixes + experimental istanbul instrumenter option). 392 tests pass on 4.1.5 with no changes required.
- **`CLAUDE.md` skill table**: added `api-linter` (new in 0.5.4) and `add-app-tool` rows; refreshed `maintenance` description.
- **Project skills synced**: `add-app-tool` 1.2→1.3, `add-prompt` 1.1→1.2, `add-resource` 1.2→1.3, `add-service` 1.2→1.3, `add-tool` 1.6→1.7, `api-context` 1.0→1.1, `api-services` 1.2→1.3, `api-utils` 2.0→2.1, `design-mcp-server` 2.4→2.5, `maintenance` 1.3→1.4, `polish-docs-meta` 1.4→1.6, `setup` 1.3→1.4. New: `api-linter` v1.0.

### Tests

- **Live end-to-end verification** against pubmed-mcp-server running in HTTP mode:
  - Landing page (`GET /`) renders identity, tagline, 4 NCBI links, `envExample` keys in all 3 connect-tab panels (STDIO JSON / Claude CLI `--env` / curl), and per-tool view-source URLs resolving to real repo files.
  - Server Card (`GET /.well-known/mcp.json`) returns correct `server_name`, `server_version`, and all three capability flags `true`.
  - `pubmed_spell_check("alzhimer disese")` → both `content[].text` and `structuredContent` carry the corrected query, `hasSuggestion: true`, and original input.
  - `pubmed_search_articles({query: "CRISPR Cas9", maxResults: 3, summaryCount: 2})` → both surfaces populated with 38,563 hits, PMIDs, per-summary fields (authors/doi/pmid/pubDate/pubmedUrl/source/title), and applied filters.
- Full suite: **392 passed** / 4 skipped / 0 regressions. `bun run devcheck` green across all 8 checks.

### References

- Framework issues closed by upstream: [cyanheads/mcp-ts-core#41](https://github.com/cyanheads/mcp-ts-core/issues/41) (soften directory-based changelog prescription — filed to preserve monolithic `CHANGELOG.md` as a valid choice for runtime-only consumer servers), [cyanheads/mcp-ts-core#42](https://github.com/cyanheads/mcp-ts-core/issues/42) (expose `sourceUrl?` on definitions — unblocks per-tool view-source overrides without file renames or type casts).
- Upstream: `@cyanheads/mcp-ts-core` 0.6.3 `sourceUrl` export.

---

## [2.4.1] - 2026-04-20

Adopts `@cyanheads/mcp-ts-core` 0.5.3, whose new `format-parity` lint rule flagged 20 tool fields that were declared in `output` but never rendered by `format()`. Every flagged field now appears in both surfaces, so `content[]`-reading clients (e.g., Claude Desktop) see the same data as `structuredContent`-reading clients (e.g., Claude Code).

### Fixed

- **`pubmed_spell_check` — `hasSuggestion` invisible in `content[]`** (`spell-check.tool.ts`): Neither branch of `format()` included the word "suggestion" as a whole word or the boolean value, so a `content[]`-only client had no way to tell whether a correction was offered. Renamed the label to `**Suggestion:**` and reworded the no-suggestion branch to read `No suggestion — query "<q>" appears correct as written.`, so the key name now matches in either case.
- **`pubmed_convert_ids` — error rows hid pmid/pmcid/doi** (`convert-ids.tool.ts`): The prior split-table layout (introduced by #32) was invisible to the parity rule because synthetic lint input sets `errmsg` on every record, routing all rows through the errors-only branch that never rendered pmid/pmcid/doi. Collapsed back to a single table with an added `Error` column — keeps columns semantically correct (the root concern of #32) while rendering every declared field on every row.
- **`pubmed_lookup_citation` — `detail` not rendered for `matched` status** (`lookup-citation.tool.ts`): `detail` was emitted only inside the `ambiguous` and `not_found` branches. Moved the render above the branch so it prints whenever present, regardless of status.
- **`pubmed_fetch_articles` — author/journal/MeSH fields silently dropped** (`fetch-articles.tool.ts`): `formatAuthor` short-circuited on `collectiveName`, hiding `lastName`, `firstName`, `initials`, `affiliationIndices`, and `orcid` for any collective author. `ji.isoAbbreviation ?? ji.title` showed only one. `ji.eIssn ? … : ji.issn ? …` showed only one. `formatPublicationDate` returned `medlineDate` alone and skipped year/month/day. MeSH `isMajorTopic` rendered as a bare `*` that the permissive matcher couldn't tie back to the `isMajorTopic` key. All six paths now render every present field: author lines show `<name> (<initials>) [aff 0,1] · ORCID <id>`, journals show full title `(<iso>), <date>, <vol>(<iss>), <pages>, ISSN <issn>, eISSN <eissn>`, MeSH major topics render as `(major)`, and affiliations switched to `- [0] <text>` so the 0-indexed `affiliationIndices` values line up with the list they reference.
- **`pubmed_fetch_fulltext` — author names and reference ids silently dropped** (`fetch-fulltext.tool.ts`): Same `collectiveName` short-circuit problem as `fetch-articles`. Reference lines rendered `label ?? id`, so a reference with both only showed one. Authors now render collective name then individual `givenNames lastName`; reference tags now render both `label` and `id` when present (`[1 gks1195-B1] <citation>`).

### Changed

- **Framework bump — `@cyanheads/mcp-ts-core` 0.5.0 → 0.5.3** (patch) (`package.json`, `bun.lock`): 0.5.1 is doc polish and retroactive skill version bumps; 0.5.2 adds the `format-parity` lint rule enforced at startup and via `bun run devcheck`; 0.5.3 rewrites the diagnostic wording around dual-surface parity (some clients forward `structuredContent`, others `content[]`, both must carry the full picture) and ships a new `check-docs-sync.ts` script for newly-scaffolded projects — not auto-adopted here since our `scripts/devcheck.ts` is a standalone copy.
- **Project skills synced from 0.5.3** (`skills/`, `.agents/skills/`, `.claude/skills/`): `add-tool` v1.4 → v1.6, `api-config` v1.1 → v1.2, `design-mcp-server` v2.3 → v2.4, `field-test` v1.1 → v1.2, `polish-docs-meta` v1.3 → v1.4, `setup` v1.2 → v1.3. Deleted `skills/devcheck/` (removed upstream in 0.5.2 — the skill was a thin restatement of the `devcheck` command already documented in the agent protocol).

### Tests

- **Updated eight assertions** in `convert-ids.tool.test.ts`, `spell-check.tool.test.ts`, and `fetch-articles.tool.test.ts` to match the new rendering — author-line format, affiliation list ordering, MeSH `(major)` label, unified convert-ids table, suggestion-branch wording.
- Full suite: **392 passed** / 4 skipped / 0 regressions. `bun run devcheck` green across all 8 checks including the new `format-parity` rule (0 errors, was 20).
- **Verified end-to-end against live HTTP server** for all five touched tools (`spell_check`, `convert_ids`, `lookup_citation`, `fetch_articles`, `fetch_fulltext`): both `content[]` and `structuredContent` surfaces carry the same fields for real PubMed data.

### References

- Issue [#32](https://github.com/cyanheads/pubmed-mcp-server/issues/32): convert_ids error-column semantics — my fix preserves the column-integrity concern from the original issue but switches from the 2.4.0 split-section layout to a unified table with an explicit `Error` column (the issue's Option B).
- Upstream: `@cyanheads/mcp-ts-core` 0.5.2 format-parity rule.

---

## [2.4.0] - 2026-04-20

Extends the `content[]`-completeness work from #26 across the rest of the tool surface. Every tool that previously dropped schema fields from rendered markdown now renders what the LLM sees, and the shared PMID validation logic is deduplicated into a single schema. Also bumps `@cyanheads/mcp-ts-core` 0.4.1 → 0.5.0 and migrates the server config to the new `parseEnvConfig` helper for actionable startup errors.

### Added

- **Shared `pmidStringSchema` export** (`src/mcp-server/tools/definitions/_schemas.ts`): Consolidates the `z.string().regex(/^\d+$/, <message>)` guard that four tool files (`fetch-articles`, `fetch-fulltext`, `find-related`, `format-citations`) each duplicated inline. The message is unified so it reads naturally in both array and scalar contexts; a future refinement now updates one file instead of four.
- **`pubmed_fetch_articles` — MeSH UIs in `content[]`** (`fetch-articles.tool.ts`): Rendered `descriptorUi` and `qualifierUi` inline with their names (`Breast Neoplasms [D001943] * (pathology [Q000473])`). The UI codes are canonical keys the LLM can hand directly to `pubmed_lookup_mesh` or use in `{ui}[MeSH Terms]` search filters without name-matching fuzziness. (#30)
- **`pubmed_search_articles` — raw PMCID in summaries** (`search-articles.tool.ts`): Summary entries now include `**PMCID:** PMC12345` alongside the existing `**PMC:** {url}` line, so the LLM can copy-paste the canonical ID into downstream `pubmed_fetch_fulltext` or `pubmed_convert_ids` calls without string-parsing the URL. Parallel to the raw-PMCID fix #26 applied to `pubmed_fetch_articles`. (#31)

### Fixed

- **`pubmed_fetch_fulltext` — `format()` silently dropped schema fields from `content[]`** (`fetch-fulltext.tool.ts`): Parallel to #26 for `fetch_articles`. Authors now render as a bulleted list with full `givenNames lastName` — no more `first3 + "et al."` truncation that silently hid authors 4+ from the LLM. Collective authors render as `{name} (collective)`. The journal line now includes `ISSN {issn}` when present. Section and subsection headings are prefixed with their JATS `label` when present (`#### 1 Introduction`, `##### 1.1 Background`), aiding cross-reference navigation. Field-tested against `PMC9575052` — confirmed ISSN, section labels "1"/"2", and all four authors now appear in `content[]`. (#29)
- **`pubmed_convert_ids` — error rows overwrote the DOI column** (`convert-ids.tool.ts`): The prior format stuffed `errmsg` into the DOI cell of the markdown table (`| id | - | - | Error: msg |`), so an LLM parsing by column index would read the error as a DOI, and any partial pmid/pmcid data accompanying an error was silently discarded. Split into two distinct sections: a success table and a separate `### Errors` bulleted list (`- **{id}:** {errmsg}`). The structuredContent shape is unchanged. (#32)
- **`pubmed_fetch_articles` — grant with only `acronym` rendered `"NIH (NIH)"`** (`fetch-articles.tool.ts`): When a grant carried `acronym` without `grantId`, `format()` produced the acronym duplicated in both slots of the `"{grantId} ({acronym})"` template. Now renders `"NIH"` alone in that case; the happy-path `"R01 EY05922 (EY)"` rendering is unchanged. Not covered by any existing test — discovered during an audit of the surrounding code.

### Changed

- **Framework bump — `@cyanheads/mcp-ts-core` 0.4.1 → 0.5.0** (minor) (`package.json`, `bun.lock`): Brings `parseEnvConfig` (opt-in env-var-aware config errors), framework-level ZodError conversion at startup (printed as a banner rather than a JSON dump), and a rewritten `maintenance` skill (v1.2 → v1.3).
- **`getServerConfig()` migrated to `parseEnvConfig`** (`src/config/server-config.ts`): Validation errors now name the actual environment variable at fault rather than the internal Zod path — `NCBI_REQUEST_DELAY_MS (requestDelayMs): expected number` instead of `requestDelayMs: expected number, received NaN`. Moved the dynamic "API-key-present → 100ms delay" logic out of inline env plumbing into a post-parse override so the Zod schema stays declarative. Added an `emptyAsUndefined` preprocessor on `apiKey` and `adminEmail` to preserve the empty-string-as-unset semantics the previous implementation provided via `env.VAR || undefined` — without it, `NCBI_ADMIN_EMAIL=` would fail `z.email()` validation instead of being treated as "no admin email configured". No runtime behavior change for existing consumers: same field names, same types, same defaults.
- **`maintenance` skill synced to v1.3** (`skills/maintenance/SKILL.md`, plus agent-directory copies in `.claude/skills/` and `.agents/skills/`): Rewritten around a two-mode flow (Mode A — full update-investigate-adopt flow, Mode B — post-update review), delegates per-package release-note investigation to the `changelog` skill, and documents the two-phase skill sync (package → project → agent dirs).
- **In-file consistency in `fetch-articles.tool.ts`**: Replaced a lone `a.affiliations.forEach((aff, i) => ...)` with `for (const [i, aff] of a.affiliations.entries())` to match the `for...of` convention used everywhere else in the same file.

### References

- Closes [#29](https://github.com/cyanheads/pubmed-mcp-server/issues/29) — `fetch_fulltext` format() dropped fields from `content[]` that were present in `structuredContent`.
- Closes [#30](https://github.com/cyanheads/pubmed-mcp-server/issues/30) — `fetch_articles` MeSH `descriptorUi` / `qualifierUi` missing from `content[]`.
- Closes [#31](https://github.com/cyanheads/pubmed-mcp-server/issues/31) — `search_articles` summaries rendered `pmcUrl` but not the raw `pmcId`.
- Closes [#32](https://github.com/cyanheads/pubmed-mcp-server/issues/32) — `convert_ids` error rows reused the DOI column for `errmsg`, hiding any other fields.

---

## [2.3.11] - 2026-04-20

### Fixed

- **`pubmed_fetch_articles` — `format()` silently dropped schema fields from `content[]`** (`fetch-articles.tool.ts`): The rendered markdown that most LLM clients forward to the model omitted `articleDates`, per-author `firstName` / `orcid` / `affiliationIndices`, journal `issn` / `eIssn` / full publication date (month, day, medlineDate), the raw `pmcId`, grant `acronym`, and collapsed authors beyond the third to `et al.` — even though every value was present in `structuredContent`. Rewrote the formatter: authors render as a bulleted list with `firstName lastName`, 1-based affiliation markers that point into a new numbered `Affiliations` section, and an inline ORCID suffix when present; the journal line now renders year/month/day (or `medlineDate`) and the preferred ISSN; a new `Article Dates` line surfaces electronic/received/revised dates; grants show the acronym alongside the ID; and empty-result responses include a one-line hint that points the caller at `pubmed_search_articles`. Field-tested end-to-end over HTTP with PMIDs 13054692, 17960126, 36813558 to confirm every field in the output schema now appears in `content[]`.

### Changed

- **PMID schema validation error message — actionable across all tools accepting PMIDs** (`fetch-articles.tool.ts`, `fetch-fulltext.tool.ts`, `find-related.tool.ts`, `format-citations.tool.ts`): The shared `z.string().regex(/^\d+$/)` guard previously produced the raw `Invalid string: must match pattern /^\d+$/` message for every failure mode — trailing whitespace, comma-joined IDs, and non-digit input all looked identical. Supplied an explicit regex message that names the domain concept, shows an example (`"13054692"`), and lists the common pitfalls (whitespace, commas, non-digit characters) so the caller can self-correct without inspecting the regex.
- **Article parser omits empty arrays for absent optional fields** (`article-parser.ts`): `parseFullArticle` no longer returns `publicationTypes: []`, `keywords: []`, `articleDates: []`, `meshTerms: []` (when `includeMesh: true` but none present), or `grantList: []` (when `includeGrants: true` but none present). The schema already marked these `.optional()`; now the runtime matches the types. Reduces payload size on older papers (Watson & Crick 1953 no longer carries three empty arrays) and tightens the contract between parser output and the output schema.

### References

- Closes [#26](https://github.com/cyanheads/pubmed-mcp-server/issues/26) — `fetch_articles` format() dropped fields from `content[]` that were present in `structuredContent`.
- Closes [#27](https://github.com/cyanheads/pubmed-mcp-server/issues/27) — PMID validation error was opaque; now surfaces actionable guidance.
- Closes [#28](https://github.com/cyanheads/pubmed-mcp-server/issues/28) — Parser returned empty arrays for absent fields instead of omitting them.

---

## [2.3.10] - 2026-04-20

### Fixed

- **`pubmed_fetch_fulltext` — PMC parser lost document order on mixed-content markup** (`pmc-article-parser.ts`, `response-handler.ts`, `pmc-xml-helpers.ts`): `extractTextContent` consumed `fast-xml-parser` output in `preserveOrder: false` mode, which collapses `#text` fragments and reorders inline children by property-key order. Older Science/Nature PMC deposits (e.g. `PMC4089965`) came back with garbled abstracts — sentences interleaved, gene lists detached — and `sections: []` because the body's direct `<p>` children were skipped whenever a trailing supplementary `<sec>` was present. Added a second `FastXmlParser` instance with `preserveOrder: true, trimValues: false` dedicated to PMC, routed via a new `useOrderedParser` flag on `NcbiRequestOptions`. New `pmc-xml-helpers.ts` module provides typed helpers (`tagNameOf`, `childrenOf`, `attrOf`, `textContent`, `findOne`, `findAll`) over the ordered shape. Rewrote `pmc-article-parser.ts` around them; `extractBodySections` now walks body children in document order so mixed `<p>` + `<sec>` bodies preserve their main text. PubMed E-utilities parsing is unchanged — the ordered parser is opt-in.
- **`pubmed_fetch_articles` / `pubmed_fetch_fulltext` — silent empty payload when all requested IDs are invalid** (`fetch-articles.tool.ts`, `fetch-fulltext.tool.ts`): Both tools short-circuited before computing `unavailablePmids` / `unavailablePmcIds`, so a caller passing a single bad ID received `{ articles: [], totalReturned: 0 }` with no signal about what failed. The mixed-input path (some valid, some invalid) worked correctly; only the all-invalid path regressed. Dropped the early returns; the existing post-parse set-difference logic now covers every case uniformly. Also narrowed the ordered-mode error tag regex in `response-handler.ts` to case-sensitive `<ERROR>` so PMC's lowercase per-ID `<error id="…">` element (returned for missing PMCIDs) falls through as data rather than triggering a retry-throw cascade.

### Changed

- **Removed obsolete `XmlJats*` types** (`types.ts`): The unordered JATS element types no longer describe the parser output for PMC responses. Replaced with a short note pointing readers at `pmc-xml-helpers.ts` for the `JatsNode` / `JatsNodeList` interface.

### References

- Closes [#19](https://github.com/cyanheads/pubmed-mcp-server/issues/19) — PMC full-text parser lost document order on complex inline markup.
- Closes [#20](https://github.com/cyanheads/pubmed-mcp-server/issues/20) — `fetch_articles` / `fetch_fulltext` silently returned empty when all IDs were invalid.

---

## [2.3.9] - 2026-04-20

### Fixed

- **`pubmed_search_articles` — DOI and PMC IDs missing from every brief summary** (`esummary-parser.ts`): `parseSingleDocumentSummary` matched lowercase keys (`idtype`/`value`) from the JSON ESummary shape, but the call site requests `retmode=xml` and fast-xml-parser preserves element casing. Real NCBI XML returns `{ IdType, IdTypeN, Value }`, so every search summary silently dropped its DOI and PMC ID. Normalized via small accessor helpers that accept both shapes; widened `ESummaryArticleId` to reflect the dual casing. Test fixture updated to use the real XML shape (the prior lowercase fixture passed because it tested the implementation, not the behavior).

### Changed

- **`pubmed_search_articles` — input validation and empty-result guidance** (`search-articles.tool.ts`):
  - `dateRange.minDate`/`maxDate` now validated by regex (`YYYY`, `YYYY/MM`, or `YYYY/MM/DD` with `/`, `-`, or `.` separators). Empty strings still accepted for the MCP Inspector payload shape; obvious typos like `not-a-date` now fail at the schema boundary with an actionable message instead of degrading silently to 0 results.
  - `publicationTypes` and `meshTerms` descriptions now state their join semantics (OR'd vs AND'd) — the asymmetry wasn't discoverable from the schema alone.
  - New optional `notice` field surfaces guidance when the response would otherwise be a bare empty array: suggests `pubmed_spell_check` on no-filter misses, filter relaxation on filtered misses, and flags pagination overshoot (`offset >= totalFound`). Absent on successful pages. Rendered as a blockquote in `format()` so both human and LLM consumers see it.

### References

- Closes [#17](https://github.com/cyanheads/pubmed-mcp-server/issues/17) — DOI/PMC extraction bug surfaced by field-testing `pubmed_search_articles`.
- Closes [#18](https://github.com/cyanheads/pubmed-mcp-server/issues/18) — UX polish for empty results, input validation, and filter-semantics docs from the same field-test.

---

## [2.3.8] - 2026-04-20

### Fixed

- **`pubmed_fetch_fulltext` — PMID→PMCID resolution via PMC ID Converter instead of eLink** (`fetch-fulltext.tool.ts`): `resolvePmidsToPmcIds` now calls `NcbiService.idConvert()` — the purpose-built DOI/PMID/PMCID mapping endpoint — rather than `eLink(cmd=neighbor, linkname=pubmed_pmc)`. Triggered by a sustained NCBI outage on 2026-04-20 where eLink's `exLinkSrv2` backend returned `Couldn't resolve #exLinkSrv2, the address table is empty.` for every request, breaking all fulltext calls; the ID Converter runs on a different backend and stayed up throughout. Equivalent coverage (both require the article be in PMC), batch-friendly (up to 200 IDs/request vs. the tool's 10 cap), and drops ~30 lines of ELink XML type shims.

### Changed

- **Dependency updates**: `@cyanheads/mcp-ts-core` 0.3.7 → 0.4.1, picking up OTel prompt telemetry (0.4.1), Vitest 4 `projects` testing helpers (0.4.0), and the duplicate `"Error:"` prefix fix (0.3.8). No handler-facing API changes.
- **Skill sync**: `skills/api-utils` refreshed from the package — adds `withRetry` options reference and partial-success batch metric documentation.

### References

- Closes [#16](https://github.com/cyanheads/pubmed-mcp-server/issues/16) — feature request to swap the fulltext resolution path off eLink, filed after the 2026-04-20 outage.

---

## [2.3.7] - 2026-04-20

### Fixed

- **APA — missing period before year with collective authors** (`citation-formatter.ts`): `formatApa` now coerces a trailing period on the author block. Individual author initials already end with `.`, but collective names (e.g., `ATLAS Collaboration`, `KEYNOTE-024 Investigators`, `ACTT-1 Study Group Members`) did not, producing `Name (Year).` instead of the APA 7 §9.8-compliant `Name. (Year).`. Fix mirrors the `endsWith('.')` idiom already used in `formatMla`.
- **RIS — truncated-end page ranges emitted as absolute pages** (`splitPages`): `737-8` now expands to `SP 737 / EP 738`, `1639-41` to `SP 1639 / EP 1641`, etc. PubMed uses a truncated-end convention for page ranges; downstream RIS importers (Zotero, EndNote, Mendeley) treat `EP` as an absolute page number, so the unexpanded form rendered wrong page ranges in compiled bibliographies.
- **BibTeX — trailing period retained inside `title = {...}`** (`formatBibtex`): titles ending with `.` are now stripped before emission. biblatex styles append their own terminal period, so the prior behavior produced `...Final Report..` (double period) in compiled bibliographies. Mirrors the existing APA/MLA title handling.

### Changed

- **MLA `p.` vs `pp.`** (`formatMla`): single-page citations now use `p.`, page ranges continue to use `pp.`, per MLA 9 §6.56.
- **RIS abstract whitespace** (`formatRis`): structured-abstract newlines (`BACKGROUND:\n\nMETHODS:\n\n...`) are collapsed to single spaces before emission. Strict RIS parsers treat blank lines as record terminators, so the prior output could truncate records at the first `\n\n` boundary.
- **`getYear` fallback** (`citation-formatter.ts`): falls back to `articleDates` (typically the electronic pub date) when `journalInfo.publicationDate.year` is absent, instead of emitting `n.d.` prematurely.

### Added

- **Publication type → entry/reference type mapping**: `publicationTypes` now drives BibTeX entry types (`@book`, `@inbook`, `@misc`) and RIS `TY` codes (`BOOK`, `CHAP`, `GEN`) for `Book`, `Book Chapter`, and `Preprint`. Unmapped types fall back to `@article` / `TY - JOUR`.
- **RIS `SN` (ISSN) tag**: `journalInfo.issn` (with `eIssn` fallback) now emitted in RIS records.
- **BibTeX `issn`, `pmcid` fields**: surfaced from parsed metadata when present.
- **PMC URL in RIS**: second `UR` tag emitted when `pmcId` is present (`https://pmc.ncbi.nlm.nih.gov/articles/PMC.../`).
- **Merged keywords + MeSH**: RIS `KW` tags and BibTeX `keywords` now include MeSH descriptor names alongside article keywords, deduplicated.
- **Test coverage**: 11 new test cases covering the three bug fixes, MLA `p.`/`pp.` branching, abstract whitespace normalization, pub-type mapping, ISSN, PMC URL, MeSH merging, and `articleDates` year fallback.

### References

- Closes [#15](https://github.com/cyanheads/pubmed-mcp-server/issues/15) — field-testing report identifying the three APA/RIS/BibTeX correctness issues.

---

## [2.3.6] - 2026-04-19

### Updated

- `@cyanheads/mcp-ts-core` to ^0.3.7
- `fast-xml-parser` to ^5.7.1
- `sanitize-html` to ^2.17.3
- `@biomejs/biome` to ^2.4.12
- `typescript` to ^6.0.3

### Removed

- **Dependency overrides**: Removed the `overrides` block from `package.json`. All nine pinned transitive deps (`hono`, `@hono/node-server`, `brace-expansion`, `express-rate-limit`, `path-to-regexp`, `picomatch`, `vite`, `yaml`, `lodash`) have since shipped patched versions upstream, making the overrides dead weight. `bun audit` remains clean.

### Changed

- **Tool descriptions**: Collapsed multi-line `+` string concatenation in `pubmed_search_articles`, `pubmed_fetch_fulltext`, and `pubmed_convert_ids` to single strings, aligning with the project's description convention and the updated `add-tool` / `design-mcp-server` skill guidance (single cohesive paragraph, no structural noise).

### Docs

- Synced `add-tool` (v1.4) and `design-mcp-server` (v2.3) skills from the framework — both now emphasize single-paragraph tool descriptions over bullet lists or blank-line-separated sections.

---

## [2.3.5] - 2026-04-13

### Fixed

- **XML response handling**: Raised the numeric entity expansion ceiling for trusted NCBI XML, preserved decoded punctuation/diacritics in parsed metadata, and wrapped parser failures as `SerializationError`.
- **Retry behavior**: Stopped retrying unexpected plain errors in `NcbiService`; only transient `McpError` responses are retried now.

### Added

- **Regression coverage**: Added end-to-end and unit tests for Unicode metadata, en-dash page ranges, parser failure wrapping, and entity-heavy XML payloads.

### Updated

- `@cyanheads/mcp-ts-core` to ^0.3.5
- `fast-xml-parser` to ^5.5.12

### Docs

- Updated the `design-mcp-server` and `add-test` skills for MCP Apps planning guidance and default test layout guidance.

---

## [2.3.4] - 2026-04-12

### Fixed

- **HTTP 429 classification**: NCBI rate-limit responses (HTTP 429) were misclassified as `InvalidRequest` and failed immediately without retrying. Now correctly classified as `RateLimited`.
- **Retry resilience**: `RateLimited` errors are now included in the retryable error set alongside `ServiceUnavailable` and `Timeout`.

### Changed

- **Retry defaults**: Increased default `maxRetries` from 3 to 6, extending the retry window from ~7s to ~45-75s before giving up.
- **Backoff strategy**: Added 30s cap on exponential backoff (prevents explosion at high retry counts) and ±25% jitter (prevents thundering herd on concurrent retries).

### Updated

- `@biomejs/biome` to ^2.4.11
- `@types/node` to ^25.6.0

---

## [2.3.3] - 2026-04-09

### Added

- **`pubmed_search_articles`**: Returned `effectiveQuery` and normalized `appliedFilters` metadata so clients can inspect the exact filters sent to PubMed
- **`pubmed_lookup_citation`**: Returned per-citation `status` (`matched`, `not_found`, `ambiguous`) and ECitMatch detail for non-exact outcomes
- **`pubmed_format_citations`**: Returned `totalSubmitted`, `totalFormatted`, and `unavailablePmids` for partial-result handling
- **Skill**: Added the `code-simplifier` agent skill for cleanup/refinement passes after edits
- **Test coverage**: Added `tests/index.test.ts` for `createApp()` registration/setup and expanded tool/service tests for search, citation lookup, citation formatting, related articles, and fulltext flows, including regression coverage for normalized `appliedFilters` output and summary clamping in `pubmed_search_articles`

### Fixed

- **`pubmed_search_articles`**: History-backed summary fetches now clamp to the returned PMID page, and `appliedFilters` now reports the normalized/sanitized values actually sent to PubMed

### Changed

- **`pubmed_search_articles`**: Format output now shows the effective query and a normalized Applied Filters section
- **`pubmed_lookup_citation`**: Format output now gives next-step guidance for ambiguous and unmatched citations instead of a flat status table

### Updated

- `@cyanheads/mcp-ts-core` to ^0.3.4
- `fast-xml-parser` to ^5.5.11
- `vitest` to ^4.1.4
- Added `@vitest/coverage-istanbul` for coverage support

### Security

- Added/raised overrides for `@hono/node-server` (>=1.19.13), `hono` (>=4.12.12), and `vite` (>=8.0.8)

### Docs

- Marked `docs/design.md` as historical and regenerated `docs/tree.md` for the current project layout

---

## [2.3.2] - 2026-04-04

### Fixed

- **ESummary date parsing**: Added dedicated `parseNcbiDate()` for NCBI's non-standard date formats (`YYYY Mon`, `YYYY Mon DD`, `YYYY Mon-Mon`, `YYYY`). chrono-node's `forwardDate` option was misinterpreting past months as future dates (e.g., "2018 Jun" resolved to a future June). The new parser handles all known NCBI formats as a fast path, falling back to chrono-node only for unrecognized strings.
- **`pubmed_search_articles`**: Search URL now uses `effectiveQuery` (post-filter) instead of raw `input.query`, so the PubMed link matches the actual search executed
- **`pubmed_fetch_fulltext`**: Removed try/catch that silently swallowed eFetch errors and returned empty results — errors now propagate per the "handlers throw" convention
- **`pubmed_format_citations`**: Added explicit `retmode: 'xml'` and POST mode for batches >= 25 PMIDs

### Changed

- **`pubmed_fetch_articles`**: Lowered POST threshold from > 200 to >= 100 PMIDs for more reliable large batch requests

### Added

- **Test coverage**: Comprehensive `parseNcbiDate` unit tests covering all 12 months, year-only, month ranges (dash/slash separators), whitespace handling, and rejection of invalid formats. Integration tests through `standardizeESummaryDate` and `extractBriefSummaries`. Optional live NCBI API integration tests (`NCBI_INTEGRATION=1`).

### Updated

- `@cyanheads/mcp-ts-core` to ^0.2.12
- `fast-xml-parser` to ^5.5.10
- `@types/node` to ^25.5.2

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
