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

## [2.3.10](changelog/2.3.x/2.3.10.md) — 2026-04-20

## [2.3.9](changelog/2.3.x/2.3.9.md) — 2026-04-20

## [2.3.8](changelog/2.3.x/2.3.8.md) — 2026-04-20

## [2.3.7](changelog/2.3.x/2.3.7.md) — 2026-04-20

## [2.3.6](changelog/2.3.x/2.3.6.md) — 2026-04-19

## [2.3.5](changelog/2.3.x/2.3.5.md) — 2026-04-13

## [2.3.4](changelog/2.3.x/2.3.4.md) — 2026-04-12

## [2.3.3](changelog/2.3.x/2.3.3.md) — 2026-04-09

## [2.3.2](changelog/2.3.x/2.3.2.md) — 2026-04-04

## [2.3.1](changelog/2.3.x/2.3.1.md) — 2026-04-01

## [2.3.0](changelog/2.3.x/2.3.0.md) — 2026-03-31

## [2.2.6](changelog/2.2.x/2.2.6.md) — 2026-03-30

## [2.2.5](changelog/2.2.x/2.2.5.md) — 2026-03-28

## [2.2.4](changelog/2.2.x/2.2.4.md) — 2026-03-28

## [2.2.3](changelog/2.2.x/2.2.3.md) — 2026-03-24

## [2.2.2](changelog/2.2.x/2.2.2.md) — 2026-03-24

## [2.2.1](changelog/2.2.x/2.2.1.md) — 2026-03-23

## [2.2.0](changelog/2.2.x/2.2.0.md) — 2026-03-23

The server was migrated to use the `@cyanheads/mcp-ts-core` framework for MCP plumbing.

## [2.1.6](changelog/2.1.x/2.1.6.md) — 2026-03-09

## [2.1.5](changelog/2.1.x/2.1.5.md) — 2026-03-06

## [2.1.4](changelog/2.1.x/2.1.4.md) — 2026-03-04

## [2.1.3](changelog/2.1.x/2.1.3.md) — 2026-03-04

## [2.1.2](changelog/2.1.x/2.1.2.md) — 2026-03-04

## [2.1.1](changelog/2.1.x/2.1.1.md) — 2026-03-04

## [2.1.0](changelog/2.1.x/2.1.0.md) — 2026-03-04

## [2.0.1](changelog/2.0.x/2.0.1.md) — 2026-03-04

## [2.0.0](changelog/2.0.x/2.0.0.md) — 2026-03-04
