<div align="center">
  <h1>@cyanheads/pubmed-mcp-server</h1>
  <p><b>Search PubMed/Europe PMC, fetch articles and full text (PMC/EPMC/Unpaywall), citations, MeSH terms via MCP. STDIO or Streamable HTTP.</b>
  <div>11 Tools • 1 Resource • 1 Prompt</div>
  </p>
</div>

<div align="center">



[![Version](https://img.shields.io/badge/Version-2.10.17-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/pubmed-mcp-server) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^2.0.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/@cyanheads/pubmed-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/pubmed-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^7.0.2-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.4.0-blueviolet.svg?style=flat-square)](https://bun.sh/)

</div>

<div align="center">

[![Install in Claude Desktop](https://img.shields.io/badge/Install_in-Claude_Desktop-D97757?style=for-the-badge&logo=anthropic&logoColor=white)](https://github.com/cyanheads/pubmed-mcp-server/releases/latest/download/pubmed-mcp-server.mcpb) [![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=pubmed-mcp-server&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBjeWFuaGVhZHMvcHVibWVkLW1jcC1zZXJ2ZXIiXX0=) [![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=for-the-badge&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect?url=vscode:mcp/install?%7B%22name%22%3A%22pubmed-mcp-server%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40cyanheads%2Fpubmed-mcp-server%22%5D%7D)

[![Framework](https://img.shields.io/badge/Built%20on-@cyanheads/mcp--ts--core-67E8F9?style=flat-square)](https://www.npmjs.com/package/@cyanheads/mcp-ts-core)

</div>

<div align="center">

**Public Hosted Server:** [https://pubmed.caseyjhand.com/mcp](https://pubmed.caseyjhand.com/mcp)

</div>

---

## Overview

The biomedical literature via NCBI's E-utilities, PubMed Central, and Europe PMC. Search it, fetch metadata and full text, resolve identifiers and partial citations, format references, and ground queries in MeSH vocabulary. Runs as a stdio process, a local Streamable HTTP server, or the public hosted endpoint above.

### Tools

| Tool | Description |
|:---|:---|
| `pubmed_search_articles` | Search PubMed with full query syntax, field-specific filters, date ranges, pagination, and optional brief summaries |
| `pubmed_europepmc_search` | Search Europe PMC for preprints, patents, Agricola, and EPMC-only OA records that don't surface in PubMed. Cursor-based pagination. |
| `pubmed_europepmc_fetch` | Fetch complete Europe PMC records — including the untruncated abstract — by `source` + `epmcId`, the only identifier many preprint, patent, and Agricola records carry |
| `pubmed_fetch_articles` | Fetch full article metadata by PMIDs — abstract, authors, journal, MeSH terms, grants |
| `pubmed_fetch_fulltext` | Fetch full-text articles via a chain: NCBI PMC EFetch → Europe PMC `fullTextXML` → Unpaywall. Accepts PMIDs, PMCIDs, or DOIs. |
| `pubmed_format_citations` | Generate formatted citations in APA 7th, MLA 9th, BibTeX, RIS, or Vancouver (ICMJE/NLM) |
| `pubmed_find_related` | Find similar articles, citing articles, or references for a given PMID |
| `pubmed_spell_check` | Spell-check a PubMed query via NCBI ESpell — every misspelled token corrected in one call; the recovery step after a zero-hit or thin search |
| `pubmed_lookup_mesh` | Search MeSH by heading — tree numbers, scope notes, entry terms — for building controlled-vocabulary queries |
| `pubmed_lookup_citation` | Resolve partial bibliographic references — one citation or a batch of up to 25 — to PubMed IDs via ECitMatch |
| `pubmed_convert_ids` | Convert between DOI, PMID, and PMCID using the PMC ID Converter API |

### Resources

| Resource | Description |
|:---|:---|
| `pubmed://database/info` | PubMed database metadata via EInfo (field list, record count, last update) |

### Prompts

| Prompt | Description |
|:---|:---|
| `research_plan` | Generate a structured 4-phase biomedical research plan outline |

## Capability reference

### `pubmed_search_articles` <sub>tool</sub>

- Full PubMed boolean and field-tag syntax, plus structured filters: author, journal, MeSH terms, language, species, publication type, has-abstract, free-full-text
- Date ranges by publication, modification, or Entrez date; sort by relevance, date, author, or journal; offset pagination
- Optional brief summaries for the top N results via ESummary
- NCBI Bookshelf hits carry `bookTitle`, `publisherName`, `docType`, and `editors` in place of the empty `source`; the rendered summary shows the doc type only for these, not for ordinary journal articles (`citation`)
- Reports `totalCount`, stated in the header beside the page (`Returned: 3 of 2924`); echoes the original query, the fully applied PubMed query, and normalized filter metadata
- A query with no search term — blank, markup only, a bare field tag like `[pdat]`, or empty `()` — is rejected as `blank_query` rather than sent upstream
- `limit` is accepted for `maxResults`

---

### `pubmed_fetch_articles` <sub>tool</sub>

- Up to 200 PMIDs per call (POST for batches of 100 or more); `ids` is accepted for `pmids`
- A zero-padded PMID (`00000001`) resolves as the PMID it spells; `unavailablePmids` lists misses as you sent them
- Title, abstract, authors with deduplicated affiliations, journal info, DOI, PubMed/PMC links; optional MeSH terms, grants, and publication types
- Tolerant of PubMed's inconsistent XML — structured abstracts, missing fields, varying date formats
- Bookshelf chapters and books are first-class: `recordType` (`journal-article` / `book-chapter` / `book`) plus a `book` object (title, publisher, editors, ISBNs, Bookshelf accession); `journalInfo` is absent on them
- Article-number journals report `journalInfo.elocationId` + `elocationIdType` rather than a page range
- Opt-in `maxResponseCharacters` keeps whole records in order until the ceiling, then defers the rest to `deferred.ids` for a follow-up call

---

### `pubmed_fetch_fulltext` <sub>tool</sub>

- Exactly one of `pmcids`, `pmids`, or `dois` (one id per element), up to 10 per request; a zero-padded PMID or PMC ID resolves as the ID it spells, DOIs match case-insensitively, and PMC IDs match with or without the `PMC` prefix in any case. Each record is fetched once however many spellings name it; `unavailable[].id` keeps your PMID or DOI spelling, and reports a PMC ID as `PMC<digits>`
- Three-tier chain: NCBI PMC EFetch → Europe PMC `fullTextXML` (`EUROPEPMC_ENABLED`, default on) → Unpaywall (needs `UNPAYWALL_EMAIL`); `viaSource` names which tier served each article
- Preprints, patents, and Agricola records have metadata via `pubmed_europepmc_search` but no full text through this chain — Europe PMC's `fullTextXML` is PMC-keyed
- `source: "pmc"` returns structured sections plus `tables[]` (cells, caption, label, footnotes) and `assets[]` (figures and supplementary material, with `[Figure: <label>]` markers left in the body, and the file pointer read through `<alternatives>` when a figure offers several formats); `source: "unpaywall"` returns a best-effort body with `contentFormat` (`html-markdown` / `pdf-text`), a `title` from Unpaywall's record (else the Europe PMC record, else the HTML page), and `journalName` / `year` when Unpaywall has them
- A titled list, definition list, or boxed text that sits in the body outside any section, or is the only content of an untitled section, such as an abbreviations list, becomes a section under its own title, and a figure or table inside it names that section; a section with no title is headed `untitled section`, the same name the `truncation` ledger gives it, and section titles in headings and ledger lines are Markdown-escaped
- Unavailable entries carry a typed `reason` (`not-found`, `no-doi`, `doi-lookup-failed`, `no-oa`, `service-error`, …), `idType`, `triedTiers` (per-tier outcome in execution order), and `unqueriedTiers` when an unconfigured tier could have served the id
- Filters and budgets: `sections` (case-insensitive title match), `maxSections`, `includeTables`, `includeAssets`, `maxCharacters`, `maxCharactersPerSection`, `overflowMode` (`truncate` / `outline`), and `maxResponseCharacters`, which defers whole articles past the ceiling to `deferred.ids`; a `truncation` object reports what was shortened or omitted, per section and subsection
- A budget cut ends at a word boundary; `truncate` drops every section and subsection past the cut, while `outline` keeps each heading and marks one the budget left empty

---

### `pubmed_europepmc_search` <sub>tool</sub>

- Reaches records PubMed can't: preprints (`PPR`), patents (`PAT`), Agricola (`AGR`), alongside `MED` and `PMC`; default `sources` is `["MED", "PMC", "PPR"]`
- Cursor pagination via `cursorMark` — `*` for the first page, then `nextCursorMark`; `pageSize` up to 100, with `max_results` and `limit` accepted for it
- Hits carry `source` plus `pmid` / `pmcId` / `doi` when known; `abstractSnippet` is capped at 400 characters, with `abstractTruncated` flagging the cut
- `totalCount` reports the full hit count, stated in the header beside the page; `searchUrl` opens the same source-filtered query on europepmc.org
- Not registered when `EUROPEPMC_ENABLED=false`

---

### `pubmed_europepmc_fetch` <sub>tool</sub>

- Full records with the untruncated plain-text abstract, addressed by `source` + `epmcId` — the only identifier preprint, patent, and Agricola records reliably carry
- Up to 25 per call in one Europe PMC request; unresolved ids come back in `notFound` rather than failing the batch
- Not registered when `EUROPEPMC_ENABLED=false`

---

### `pubmed_format_citations` <sub>tool</sub>

- APA 7th, MLA 9th, BibTeX, RIS, Vancouver (ICMJE/NLM); several styles per article in one call, up to 50 articles
- Bookshelf chapters and books cite in each style's edited-book form; articles without a page range cite by electronic locator in each style's convention
- Hand-rolled formatters — zero dependencies, Workers-compatible
- Reports formatted counts and unavailable PMIDs; `ids` is accepted for `pmids`, and a zero-padded PMID resolves as the PMID it spells

---

### `pubmed_find_related` <sub>tool</sub>

- `similar`, `cited_by`, or `references` for a PMID, in NCBI relevance order, enriched with title, authors, date, and source (or Bookshelf book title and publisher)
- Falls back to Europe PMC, then OpenAlex, when NCBI can't answer; the response names the provider. Fails with a typed `all_providers_failed` error rather than an empty result
- `maxResults` up to 50 (`limit` also accepted) with offset pagination; `totalCount` reports the full match count, stated in the header beside the page
- A zero-padded source PMID resolves as the PMID it spells and is never listed among its own related articles

---

### `pubmed_spell_check` <sub>tool</sub>

- Runs a PubMed query through NCBI ESpell and returns `original`, `corrected`, and `hasSuggestion`; every misspelled token is corrected in one call (`alzhiemer diseese treatmnt outcomse` → `alzheimer disease treatment outcomes`)
- Reach for it after a zero-hit or thin `pubmed_search_articles` result, or when a drug, gene, disease, or author name may be misspelled, then re-run the search with `corrected`
- A blank or whitespace-only query is rejected rather than sent upstream

---

### `pubmed_lookup_mesh` <sub>tool</sub>

- Looks up MeSH descriptors by name or free-text term, pinning the exact-heading match to the top of the first page
- Records carry `meshId` (DescriptorUI), `entrezUid`, and, with `includeDetails` (default on), tree numbers, scope notes, and entry terms
- `maxResults` up to 50 (`limit` also accepted) with offset pagination via `nextOffset`; `totalCount` reports the upstream match count

---

### `pubmed_lookup_citation` <sub>tool</sub>

- Match on journal, year, volume, first page, and/or author — journal or year required, more fields for better precision
- `citations` takes an array of up to 25 or a single citation object; `citation` is accepted for it
- Pipes and line breaks are rejected at the schema (ECitMatch's wire format is pipe-delimited); the free-form `key` label is exempt
- Explicit `matched`, `not_found`, and `ambiguous` statuses with recovery detail

---

### `pubmed_convert_ids` <sub>tool</sub>

- Up to 50 DOIs, PMIDs, or PMCIDs per call, all one type; only PMC-indexed articles resolve
- One id per element — a packed `"23193287,37952131"` is rejected rather than expanded
- One success/error row per submitted element, in order, with `requestedId` exactly as sent — repeats, a bare-digit PMCID, and a DOI's casing included; a partial batch never fails as a whole
- A zero-padded PMID resolves as the PMID it spells

---

### `pubmed://database/info` <sub>resource</sub>

- Live EInfo call for the `pubmed` database, returned as `application/json`
- `dbName`, `description`, `count`, `lastUpdate`, and `fields[]` — each field's short `name` (the tag usable in `pubmed_search_articles` queries), `fullName`, and `description`
- No parameters

---

### `research_plan` <sub>prompt</sub>

- Arguments: `title`, `goal`, `keywords` (comma-separated) required; `organism` and `includeAgentPrompts` (`"true"` / `"false"`) optional
- Returns two messages: an assistant framing message (biomedical research planning assistant, grounds recommendations in the PubMed tools when available) and a user message carrying the plan
- The plan walks four phases — Conception & Planning, Data Collection & Processing, Analysis & Interpretation, Dissemination — with sub-steps under each
- `includeAgentPrompts: "true"` adds an agent-guidance block under each sub-step, several of which point at `pubmed_search_articles` and `pubmed_lookup_mesh`

## Features

Built on [`@cyanheads/mcp-ts-core`](https://github.com/cyanheads/mcp-ts-core): stdio and Streamable HTTP transports, pluggable auth (`none` / `jwt` / `oauth`), swappable storage (`in-memory`, `filesystem`, `Supabase`, `Cloudflare KV/R2/D1`), structured logging with optional OpenTelemetry tracing.

PubMed-specific:

- Complete NCBI E-utilities integration (ESearch, EFetch, ESummary, ELink, ESpell, EInfo, ECitMatch) plus PMC ID Converter
- Shared NCBI request queue — paced request starts, capped concurrency, a cooldown that holds every caller after an NCBI 429, and one deadline covering queue wait and retries
- NCBI-specific XML parser with `isArray` hints for PubMed's inconsistent XML structure
- Hand-rolled citation formatters (APA, MLA, BibTeX, RIS, Vancouver) — zero deps, Workers-compatible

Agent-friendly output:

- Provenance on every response — source labels, license fields, best-effort warnings on Unpaywall results, and effective-query echo on searches so agents can reason about trust
- Graceful partial failure — batch tools return per-item success/error rows instead of failing the request, with structured status codes and actionable next-step text
- Discriminated output contracts — `source: "pmc" | "unpaywall"`, typed `unavailable` reasons, `viaSource` and `triedTiers` fields — callers branch on data, not string parsing

## Getting started

### Public Hosted Instance

A public instance is available at `https://pubmed.caseyjhand.com/mcp` — no installation required. Point any MCP client at it via Streamable HTTP:

```json
{
  "mcpServers": {
    "pubmed-mcp-server": {
      "type": "streamable-http",
      "url": "https://pubmed.caseyjhand.com/mcp"
    }
  }
}
```

### Self-Hosted / Local

Add the following to your MCP client configuration file.

```json
{
  "mcpServers": {
    "pubmed-mcp-server": {
      "type": "stdio",
      "command": "bunx",
      "args": ["@cyanheads/pubmed-mcp-server@latest"],
      "env": {
        "MCP_TRANSPORT_TYPE": "stdio",
        "MCP_LOG_LEVEL": "info",
        "NCBI_API_KEY": "your-key-here"
      }
    }
  }
}
```

Or with npx (no Bun required):

```json
{
  "mcpServers": {
    "pubmed-mcp-server": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@cyanheads/pubmed-mcp-server@latest"],
      "env": {
        "MCP_TRANSPORT_TYPE": "stdio",
        "MCP_LOG_LEVEL": "info",
        "NCBI_API_KEY": "your-key-here"
      }
    }
  }
}
```

Or with Docker:

```json
{
  "mcpServers": {
    "pubmed-mcp-server": {
      "type": "stdio",
      "command": "docker",
      "args": ["run", "-i", "--rm", "-e", "MCP_TRANSPORT_TYPE=stdio", "ghcr.io/cyanheads/pubmed-mcp-server:latest"]
    }
  }
}
```

For Streamable HTTP, set the transport and start the server:

```sh
MCP_TRANSPORT_TYPE=http MCP_HTTP_PORT=3010 bun run start:http
# Server listens at http://localhost:3010/mcp
```

### Prerequisites

- [Bun v1.4.0](https://bun.sh/) or higher.
- Optional: [NCBI API key](https://www.ncbi.nlm.nih.gov/account/settings/) for higher rate limits (10 req/s vs 3 req/s).

### Installation

1. **Clone the repository:**

```sh
git clone https://github.com/cyanheads/pubmed-mcp-server.git
```

2. **Navigate into the directory:**

```sh
cd pubmed-mcp-server
```

3. **Install dependencies:**

```sh
bun install
```

## Configuration

Key environment variables:

| Variable | Description | Default |
|:---|:---|:---|
| `MCP_TRANSPORT_TYPE` | Transport: `stdio` or `http` | `stdio` |
| `MCP_HTTP_PORT` | HTTP server port | `3010` |
| `MCP_HTTP_ENDPOINT_PATH` | HTTP endpoint path where the MCP server is mounted | `/mcp` |
| `MCP_SESSION_MODE` | HTTP session mode: `stateless`, `stateful`, or `auto` (resolves to `stateful`). This server ships `stateless` — it has no `ctx.requestInput` call sites. | `stateless` |
| `MCP_PUBLIC_URL` | Public origin override for TLS-terminating reverse-proxy deployments (landing page, Server Card, RFC 9728 metadata). | none |
| `MCP_AUTH_MODE` | Authentication: `none`, `jwt`, or `oauth` | `none` |
| `MCP_LOG_LEVEL` | Log level (`debug`, `info`, `warning`, `error`, etc.) | `info` |
| `MCP_GC_PRESSURE_INTERVAL_MS` | Opt-in Bun-only forced-GC pressure loop (ms). Drains the per-request `McpServer`/`McpSessionTransport` cycle under sustained low-traffic HTTP. Recommended starting point if heap growth is observed: `60000`. | `0` (disabled) |
| `LOGS_DIR` | Directory for log files (Node.js only). Relative paths resolve against the application root. | `<app-root>/logs` |
| `STORAGE_PROVIDER_TYPE` | Storage backend: `in-memory`, `filesystem`, `supabase`, `cloudflare-kv/r2/d1` | `in-memory` |
| `NCBI_API_KEY` | NCBI API key for higher rate limits (10 req/s vs 3 req/s) | none |
| `NCBI_ADMIN_EMAIL` | Contact email sent with NCBI requests (recommended by NCBI) | none |
| `NCBI_REQUEST_DELAY_MS` | Minimum gap between NCBI request starts in ms | 334 (100 with key) |
| `NCBI_MAX_CONCURRENT` | Max concurrent in-flight NCBI requests | `8` |
| `NCBI_MAX_RETRIES` | Retry attempts for failed NCBI requests | 6 |
| `NCBI_TIMEOUT_MS` | Per-request HTTP timeout in ms | `30000` |
| `NCBI_TOTAL_DEADLINE_MS` | Total deadline for one NCBI call — queue wait, retry attempts, and backoff — in ms. A call the queue cannot start before it is rejected at once | `60000` |
| `UNPAYWALL_EMAIL` | Contact email for Unpaywall. When set, `pubmed_fetch_fulltext` falls back to Unpaywall open-access copies for non-PMC DOIs | none |
| `UNPAYWALL_TIMEOUT_MS` | Per-request HTTP timeout for Unpaywall lookups and content fetches, in ms | `20000` |
| `EUROPEPMC_ENABLED` | Enable Europe PMC search tool and the `pubmed_fetch_fulltext` JATS fallback chain. Set `false` to disable all EPMC calls and skip tool registration. | `true` |
| `EUROPEPMC_EMAIL` | Optional contact email sent with Europe PMC requests (EBI courtesy). | none |
| `EUROPEPMC_REQUEST_DELAY_MS` | Minimum gap between Europe PMC request starts in ms | `200` |
| `EUROPEPMC_MAX_RETRIES` | Retry attempts for failed Europe PMC requests | `3` |
| `EUROPEPMC_TIMEOUT_MS` | Per-request HTTP timeout for Europe PMC calls, in ms | `20000` |
| `OTEL_ENABLED` | Enable OpenTelemetry | `false` |

## Running the server

### Local development

- **Build and run the production version**:

  ```sh
  # One-time build
  bun run rebuild

  # Run the built server
  bun run start:http
  # or
  bun run start:stdio
  ```

- **Run checks and tests**:
  ```sh
  bun run devcheck  # Lints, formats, type-checks, and more
  bun run test      # Runs the test suite
  ```

## Project structure

| Directory | Purpose |
|:---|:---|
| `src/mcp-server/tools` | Tool definitions (`*.tool.ts`). Eleven tools across PubMed, PMC, and Europe PMC. |
| `src/mcp-server/resources` | Resource definitions. Database info resource. |
| `src/mcp-server/prompts` | Prompt definitions. Research plan prompt. |
| `src/services/ncbi` | NCBI E-utilities service layer — API client, queue, parser, formatter. |
| `src/services/europe-pmc` | Europe PMC service — search + `fullTextXML` JATS retrieval. Reuses the NCBI JATS parser. |
| `src/services/unpaywall` | Unpaywall service — DOI → OA location resolution and content fetch (HTML/PDF). |
| `src/config` | Server-specific environment variable parsing and validation with Zod. |
| `tests/` | Unit and integration tests, mirroring the `src/` structure. |

## Development guide

See [`CLAUDE.md`](./CLAUDE.md) for development guidelines and architectural rules. The short version:

- Handlers throw, framework catches — no `try/catch` in tool logic
- Use `ctx.log` for logging, `ctx.state` for storage
- Register new tools and resources in the `createApp()` arrays

## Contributing

Issues are welcome. Run checks and tests before submitting:

```sh
bun run devcheck
bun run test
```

## License

This project is licensed under the Apache 2.0 License. See the [LICENSE](./LICENSE) file for details.
