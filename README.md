<div align="center">
  <h1>@cyanheads/pubmed-mcp-server</h1>
  <p><b>Search PubMed/Europe PMC, fetch articles and full text (PMC/EPMC/Unpaywall), citations, MeSH terms via MCP. STDIO or Streamable HTTP.</b>
  <div>11 Tools • 1 Resource • 1 Prompt</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-2.10.19-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/pubmed-mcp-server) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^2.1.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/@cyanheads/pubmed-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/pubmed-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^7.0.2-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.4.2-blueviolet.svg?style=flat-square)](https://bun.sh/)

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

Biomedical literature from PubMed, PubMed Central, and Europe PMC. Search it, fetch metadata and full text, resolve identifiers and partial citations, format references, and ground queries in MeSH vocabulary. Runs as a stdio process, a local Streamable HTTP server, or the public hosted endpoint above.

### Tools

| Tool | Description |
|:---|:---|
| `pubmed_search_articles` | Search PubMed with full query syntax, structured filters, date ranges, and optional summaries |
| `pubmed_fetch_articles` | Fetch article metadata by PMID: abstract, authors, journal, MeSH terms, grants, linked retraction and correction notices |
| `pubmed_fetch_fulltext` | Fetch full text by PMID, PMCID, or DOI, falling back from PMC to Europe PMC to Unpaywall |
| `pubmed_europepmc_search` | Search Europe PMC for preprints, patents, Agricola, and open-access records PubMed doesn't carry |
| `pubmed_europepmc_fetch` | Fetch complete Europe PMC records, including the untruncated abstract, by `source` + `epmcId` |
| `pubmed_format_citations` | Format citations in APA 7th, MLA 9th, BibTeX, RIS, or Vancouver (ICMJE/NLM) |
| `pubmed_find_related` | Find similar articles, citing articles, or references for a PMID |
| `pubmed_spell_check` | Correct a misspelled PubMed query via NCBI ESpell |
| `pubmed_lookup_mesh` | Look up MeSH headings with tree numbers, scope notes, and entry terms |
| `pubmed_lookup_citation` | Resolve partial references, up to 25 at a time, to PMIDs via ECitMatch |
| `pubmed_convert_ids` | Convert between DOI, PMID, and PMCID via the PMC ID Converter |

### Resources

| Resource | Description |
|:---|:---|
| `pubmed://database/info` | PubMed database metadata via EInfo (field list, record count, last update) |

### Prompts

| Prompt | Description |
|:---|:---|
| `research_plan` | Generate a structured four-phase biomedical research plan |

## Capability reference

### `pubmed_search_articles` <sub>tool</sub>

- Full PubMed query syntax plus filters (author, journal, MeSH, publication type, language, species, abstract, free full text) and publication/modification/Entrez date ranges
- Up to 1,000 results per page and offsets up to 9,998; `summaryCount` adds briefs for up to 50 hits
- Reports `totalCount`, the `effectiveQuery` PubMed ran, and the `appliedFilters`
- Rejects blank filter values, impossible dates, and reversed date ranges before PubMed is called

---

### `pubmed_fetch_articles` <sub>tool</sub>

- Up to 200 PMIDs per call; misses are listed in `unavailablePmids`
- Abstract, authors, journal, DOI, publication types, linked retraction/erratum/comment notices, and links; MeSH terms on by default, grants via `includeGrants`
- `recordType` separates journal articles from Bookshelf chapters and books; opt-in `maxResponseCharacters` defers overflow to `deferred.ids`

---

### `pubmed_fetch_fulltext` <sub>tool</sub>

- One of `pmcids`, `pmids`, or `dois`, up to 10 per call, tried against PMC, then Europe PMC, then Unpaywall (needs `UNPAYWALL_EMAIL`); `viaSource` names the tier that answered
- `source: "pmc"` returns sections, tables, and figures; `source: "unpaywall"` returns a best-effort HTML or PDF text body
- Misses carry a typed `reason` and `triedTiers`; `sections`, `maxCharacters`, `overflowMode`, and `maxResponseCharacters` bound the response, and `truncation` reports what was cut

---

### `pubmed_europepmc_search` <sub>tool</sub>

- Adds preprints (`PPR`), patents (`PAT`), and Agricola (`AGR`) to `MED` and `PMC`; defaults to `MED`, `PMC`, `PPR`
- Cursor pagination via `cursorMark` / `nextCursorMark`, up to 100 per page; abstracts arrive as 400-character snippets
- Not registered when `EUROPEPMC_ENABLED=false`

---

### `pubmed_europepmc_fetch` <sub>tool</sub>

- Up to 25 records per call, addressed by a search hit's `source` + `epmcId`, with the full abstract; unresolved ids land in `notFound`
- Not registered when `EUROPEPMC_ENABLED=false`

---

### `pubmed_format_citations` <sub>tool</sub>

- Up to 50 PMIDs per call, in any mix of `apa`, `mla`, `bibtex`, `ris`, and `vancouver`
- Bookshelf records cite as edited books; PMIDs that can't be fetched are reported as unavailable

---

### `pubmed_find_related` <sub>tool</sub>

- `similar`, `cited_by`, or `references`, up to 50 per page with offset pagination
- Falls back to Europe PMC, then OpenAlex, and names the provider that answered; fails as `all_providers_failed` if none can

---

### `pubmed_spell_check` <sub>tool</sub>

- Returns `original`, `corrected`, and `hasSuggestion`, fixing every misspelled token in one call
- Run it after a zero-hit or thin search, then retry `pubmed_search_articles` with `corrected`

---

### `pubmed_lookup_mesh` <sub>tool</sub>

- Descriptors by name or free-text term, with an exact heading match pinned first; up to 50 per page, continued via `nextOffset`
- Records carry `meshId`; `includeDetails` (default on) adds tree numbers, scope notes, and entry terms

---

### `pubmed_lookup_citation` <sub>tool</sub>

- Up to 25 partial citations per call; journal or year is required, and volume, first page, and author sharpen the match
- Each comes back `matched`, `not_found`, or `ambiguous`, with recovery detail

---

### `pubmed_convert_ids` <sub>tool</sub>

- Up to 50 ids per call, all of one declared `idType` (`doi`, `pmid`, `pmcid`); only PMC-indexed articles resolve
- One success or error row per id, in order, so a partial batch never fails

---

### `pubmed://database/info` <sub>resource</sub>

- Live EInfo call for the `pubmed` database, returned as `application/json`
- `count`, `lastUpdate`, and `fields[]`, whose names are the search tags `pubmed_search_articles` accepts

---

### `research_plan` <sub>prompt</sub>

- Arguments: `title`, `goal`, and `keywords` required; `organism` and `includeAgentPrompts` optional
- Returns a four-phase research plan; `includeAgentPrompts: "true"` adds an agent-guidance block under each of its nine sub-steps, two of which point at tools: the literature review names `pubmed_search_articles` and `pubmed_lookup_mesh`, and the interpretation step names `pubmed_search_articles`

## Features

Built on [`@cyanheads/mcp-ts-core`](https://github.com/cyanheads/mcp-ts-core): stdio and Streamable HTTP transports, pluggable auth (`none` / `jwt` / `oauth`), swappable storage (`in-memory`, `filesystem`, `Supabase`, `Cloudflare KV/R2/D1`), structured logging with optional OpenTelemetry tracing.

PubMed-specific:

- NCBI E-utilities (ESearch, EFetch, ESummary, ELink, ESpell, EInfo, ECitMatch) and the PMC ID Converter, with Europe PMC, OpenAlex, and Unpaywall filling the gaps
- Shared NCBI request queue: paced request starts, capped concurrency, a cooldown that holds every caller after an NCBI 429, and one deadline covering queue wait and retries
- XML parsing built for PubMed's inconsistent records: structured abstracts, missing fields, varying date formats
- Forgiving identifiers: a zero-padded PMID resolves as the PMID it spells in every tool that takes one; `pubmed_fetch_fulltext` also matches DOIs case-insensitively and PMC IDs with or without the `PMC` prefix
- Hand-rolled citation formatters (APA, MLA, BibTeX, RIS, Vancouver) with no dependencies

Agent-friendly output:

- Provenance on every response: source labels, license fields, best-effort warnings on Unpaywall results, and effective-query echo on searches, so agents can judge what to trust
- Graceful partial failure: batch tools return per-item success/error rows instead of failing the request, with structured status codes and actionable next-step text
- Discriminated output contracts: `source: "pmc" | "unpaywall"`, typed `unavailable` reasons, `viaSource` and `triedTiers` fields, so callers branch on data, not string parsing

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

- [Bun v1.4.0](https://bun.sh/) or higher (or Node.js v24+).
- Optional: an [NCBI API key](https://www.ncbi.nlm.nih.gov/account/settings/) raises the rate limit from 3 to 10 requests per second.

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

4. **Configure environment:**

```sh
cp .env.example .env
# edit .env and set NCBI_API_KEY, NCBI_ADMIN_EMAIL, and UNPAYWALL_EMAIL as needed
```

## Configuration

| Variable | Description | Default |
|:---|:---|:---|
| `NCBI_API_KEY` | NCBI API key; raises the rate limit from 3 to 10 req/s. | none |
| `NCBI_ADMIN_EMAIL` | Contact email sent with NCBI requests, as NCBI recommends. | none |
| `NCBI_REQUEST_DELAY_MS` | Minimum gap between NCBI request starts, in ms. | `400` (`100` with a key) |
| `NCBI_MAX_CONCURRENT` | Max concurrent in-flight NCBI requests. | `8` |
| `NCBI_MAX_RETRIES` | Retry attempts for failed NCBI requests. | `6` |
| `NCBI_TIMEOUT_MS` | Per-request HTTP timeout, in ms. | `30000` |
| `NCBI_TOTAL_DEADLINE_MS` | Deadline for one NCBI call across queue wait, retries, and backoff, in ms. A call that can't start in time is rejected at once. | `60000` |
| `UNPAYWALL_EMAIL` | Contact email for Unpaywall. Setting it enables the Unpaywall tier of `pubmed_fetch_fulltext` for non-PMC DOIs. | none |
| `UNPAYWALL_TIMEOUT_MS` | Per-request timeout for Unpaywall lookups and content fetches, in ms. | `20000` |
| `EUROPEPMC_ENABLED` | Set `false` to disable every Europe PMC call: both Europe PMC tools go unregistered, `pubmed_fetch_fulltext` skips that tier, and `pubmed_find_related` skips that fallback. | `true` |
| `EUROPEPMC_EMAIL` | Optional contact email sent with Europe PMC requests. | none |
| `EUROPEPMC_REQUEST_DELAY_MS` | Minimum gap between Europe PMC request starts, in ms. | `200` |
| `EUROPEPMC_MAX_RETRIES` | Retry attempts for failed Europe PMC requests. | `3` |
| `EUROPEPMC_TIMEOUT_MS` | Per-request timeout for Europe PMC calls, in ms. | `20000` |
| `MCP_TRANSPORT_TYPE` | Transport: `stdio` or `http`. | `stdio` |
| `MCP_HTTP_PORT` | HTTP server port. | `3010` |
| `MCP_SESSION_MODE` | HTTP session mode: `stateless`, `stateful`, or `auto`. | `stateless` |
| `MCP_AUTH_MODE` | Authentication: `none`, `jwt`, or `oauth`. | `none` |
| `MCP_LOG_LEVEL` | Log level (`debug`, `info`, `warning`, `error`, etc.). | `info` |
| `LOGS_DIR` | Directory for log files (Node.js only). | `<app-root>/logs` |
| `STORAGE_PROVIDER_TYPE` | Storage backend: `in-memory`, `filesystem`, `supabase`, `cloudflare-kv/r2/d1`. | `in-memory` |
| `OTEL_ENABLED` | Enable [OpenTelemetry](https://github.com/cyanheads/mcp-ts-core/tree/main/docs/telemetry). | `false` |

See [`.env.example`](./.env.example) for every server setting and the common framework overrides.

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
| `src/services/openalex` | OpenAlex service — last-resort provider for `pubmed_find_related`. |
| `src/config` | Server-specific environment variable parsing and validation with Zod. |
| `tests/` | Unit and integration tests, mirroring the `src/` structure. |

## Development guide

See [`CLAUDE.md`](./CLAUDE.md) for development guidelines and architectural rules. The short version:

- Handlers throw, framework catches — no `try/catch` in tool logic
- Use `ctx.log` for logging, `ctx.state` for storage
- Register new tools and resources in the `createApp()` arrays in `src/index.ts`
- Wrap external API calls: validate raw → normalize to domain type → return output schema; never fabricate missing fields

## Contributing

Issues are welcome. Run checks and tests before submitting:

```sh
bun run devcheck
bun run test
```

## License

This project is licensed under the Apache 2.0 License. See the [LICENSE](./LICENSE) file for details.
