<div align="center">
  <h1>@cyanheads/pubmed-mcp-server</h1>
  <p><b>MCP server for the NCBI E-utilities API. Search PubMed, fetch article metadata and full text, generate citations, explore MeSH terms, and discover related research. STDIO or Streamable HTTP.</b>
  <div>9 Tools • 1 Resource • 1 Prompt</div>
  </p>
</div>

<div align="center">

[![npm](https://img.shields.io/npm/v/@cyanheads/pubmed-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/pubmed-mcp-server) [![Version](https://img.shields.io/badge/Version-2.6.1-blue.svg?style=flat-square)](./CHANGELOG.md) [![Framework](https://img.shields.io/badge/Built%20on-@cyanheads/mcp--ts--core-259?style=flat-square)](https://www.npmjs.com/package/@cyanheads/mcp-ts-core) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^1.27.1-green.svg?style=flat-square)](https://modelcontextprotocol.io/) 

[![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![TypeScript](https://img.shields.io/badge/TypeScript-^6.0.3-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.3.2-blueviolet.svg?style=flat-square)](https://bun.sh/)

</div>

<div align="center">

**Public Hosted Server:** [https://pubmed.caseyjhand.com/mcp](https://pubmed.caseyjhand.com/mcp)

</div>

---

## Tools

Nine tools for working with PubMed and NCBI data:

| Tool | Description |
|:---|:---|
| `pubmed_search_articles` | Search PubMed with full query syntax, field-specific filters, date ranges, pagination, and optional brief summaries |
| `pubmed_fetch_articles` | Fetch full article metadata by PMIDs — abstract, authors, journal, MeSH terms, grants |
| `pubmed_fetch_fulltext` | Fetch full-text articles from PubMed Central, with optional Unpaywall fallback for non-PMC DOIs (HTML → Markdown or PDF → text) |
| `pubmed_format_citations` | Generate formatted citations in APA 7th, MLA 9th, BibTeX, or RIS |
| `pubmed_find_related` | Find similar articles, citing articles, or references for a given PMID |
| `pubmed_spell_check` | Spell-check biomedical queries using NCBI's ESpell service |
| `pubmed_lookup_mesh` | Search and explore MeSH vocabulary — tree numbers, scope notes, entry terms |
| `pubmed_lookup_citation` | Resolve partial bibliographic references to PubMed IDs via ECitMatch |
| `pubmed_convert_ids` | Convert between DOI, PMID, and PMCID using the PMC ID Converter API |

### `pubmed_search_articles`

Search PubMed with full NCBI query syntax and filters.

- Free-text queries with PubMed's full boolean and field-tag syntax
- Field-specific filters: author, journal, MeSH terms, language, species
- Common filters: has abstract, free full text
- Date range filtering by publication, modification, or Entrez date
- Publication type filtering (Review, Clinical Trial, Meta-Analysis, etc.)
- Sort by relevance, publication date, author, or journal
- Pagination via offset for paging through large result sets
- Optional brief summaries for top N results via ESummary
- Returns the original query plus the fully applied PubMed query and normalized filter metadata

---

### `pubmed_fetch_articles`

Fetch full article metadata by PubMed IDs.

- Batch fetch up to 200 articles at once (auto-switches to POST for batches >= 100)
- Returns structured data: title, abstract, authors with deduplicated affiliations, journal info, DOI
- Direct links to PubMed and PubMed Central (when available)
- Optional MeSH terms, grant information, and publication types
- Handles PubMed's inconsistent XML (structured abstracts, missing fields, varying date formats)

---

### `pubmed_fetch_fulltext`

Fetch full-text articles from PubMed Central (PMC), with an optional Unpaywall fallback for articles not in PMC.

- Accepts PMC IDs directly or PubMed IDs (auto-resolved to PMCIDs via ELink)
- PMC path returns complete article body organized by sections and subsections, plus optional references from back matter
- Unpaywall fallback (enabled by setting `UNPAYWALL_EMAIL`) resolves DOIs to legal open-access copies hosted by publishers or institutional repositories; extracts HTML landing pages to Markdown via Defuddle or PDFs to text via unpdf
- Discriminated output contract — `source: "pmc"` (structured sections) or `source: "unpaywall"` (single body + `contentFormat` metadata: `html-markdown` or `pdf-text`)
- Structured unavailable reasons (`no-pmc-fallback-disabled`, `no-doi`, `no-oa`, `fetch-failed`, `parse-failed`, `service-error`) so callers can retry or explain to users without parsing text
- Section filtering by title (case-insensitive match, e.g. `["methods", "results"]`) and configurable max sections apply to PMC output
- Up to 10 articles per request

---

### `pubmed_format_citations`

Generate formatted citations for articles.

- Four citation styles: APA 7th, MLA 9th, BibTeX, RIS
- Request multiple styles per article in a single call
- Hand-rolled formatters — zero external dependencies, fully Workers-compatible
- Up to 50 articles per request
- Reports formatted counts and unavailable PMIDs for partial-result handling

---

### `pubmed_find_related`

Find articles related to a source article via ELink.

- Three relationship types: `similar` (content similarity), `cited_by`, `references`
- Results enriched with title, authors, publication date, and source via ESummary
- Similarity scores included for `similar` relationship type

---

### `pubmed_spell_check`

Spell-check a biomedical query using NCBI's ESpell.

- Returns the original query, corrected query, and whether a suggestion was found
- Useful for query refinement before searching

---

### `pubmed_lookup_mesh`

Search and explore the MeSH (Medical Subject Headings) vocabulary.

- Search MeSH terms by name with exact-heading matching
- Detailed records with tree numbers, scope notes, and entry terms by default
- Useful for building precise PubMed queries with controlled vocabulary

---

### `pubmed_lookup_citation`

Resolve partial bibliographic references to PubMed IDs via NCBI ECitMatch.

- Match citations by journal, year, volume, first page, and/or author name
- More fields = better match accuracy; at least one field required
- Batch up to 25 citations per request
- Deterministic matching — more reliable than free-text search for known references
- Returns explicit `matched`, `not_found`, and `ambiguous` statuses with recovery detail

---

### `pubmed_convert_ids`

Convert between article identifiers (DOI, PMID, PMCID) using the PMC ID Converter API.

- Batch up to 50 IDs per request
- Accepts DOIs, PMIDs, or PMCIDs (all IDs must be the same type)
- Only resolves articles indexed in PubMed Central
- Returns all available identifier mappings for each input ID

## Resource and prompt

| Type | Name | Description |
|:---|:---|:---|
| Resource | `pubmed://database/info` | PubMed database metadata via EInfo (field list, record count, last update) |
| Prompt | `research_plan` | Generate a structured 4-phase biomedical research plan outline |

## Features

Built on [`@cyanheads/mcp-ts-core`](https://github.com/cyanheads/mcp-ts-core):

- Declarative tool definitions — single file per tool, framework handles registration and validation
- Unified error handling across all tools
- Pluggable auth (`none`, `jwt`, `oauth`)
- Swappable storage backends: `in-memory`, `filesystem`, `Supabase`, `Cloudflare KV/R2/D1`
- Structured logging with optional OpenTelemetry tracing
- Runs locally (stdio/HTTP) or on Cloudflare Workers from the same codebase

PubMed-specific:

- Complete NCBI E-utilities integration (ESearch, EFetch, ESummary, ELink, ESpell, EInfo, ECitMatch) plus PMC ID Converter
- Sequential request queue with configurable delay for NCBI rate limit compliance
- NCBI-specific XML parser with `isArray` hints for PubMed's inconsistent XML structure
- Hand-rolled citation formatters (APA, MLA, BibTeX, RIS) — zero deps, Workers-compatible

## Getting started

### Public Hosted Instance

A public instance is available at `https://pubmed.caseyjhand.com/mcp` — no installation required. Point any MCP client at it via Streamable HTTP:

```json
{
  "mcpServers": {
    "pubmed": {
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
    "pubmed": {
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
    "pubmed": {
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
    "pubmed": {
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

- [Bun v1.3.2](https://bun.sh/) or higher.
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

All configuration is validated at startup via Zod schemas in `src/config/server-config.ts`. Key environment variables:

| Variable | Description | Default |
|:---|:---|:---|
| `MCP_TRANSPORT_TYPE` | Transport: `stdio` or `http` | `stdio` |
| `MCP_HTTP_PORT` | HTTP server port | `3010` |
| `MCP_HTTP_ENDPOINT_PATH` | HTTP endpoint path where the MCP server is mounted | `/mcp` |
| `MCP_PUBLIC_URL` | Public origin override for TLS-terminating reverse-proxy deployments (landing page, Server Card, RFC 9728 metadata). | none |
| `MCP_AUTH_MODE` | Authentication: `none`, `jwt`, or `oauth` | `none` |
| `MCP_LOG_LEVEL` | Log level (`debug`, `info`, `warning`, `error`, etc.) | `info` |
| `LOGS_DIR` | Directory for log files (Node.js only). | `<project-root>/logs` |
| `STORAGE_PROVIDER_TYPE` | Storage backend: `in-memory`, `filesystem`, `supabase`, `cloudflare-kv/r2/d1` | `in-memory` |
| `NCBI_API_KEY` | NCBI API key for higher rate limits (10 req/s vs 3 req/s) | none |
| `NCBI_ADMIN_EMAIL` | Contact email sent with NCBI requests (recommended by NCBI) | none |
| `NCBI_REQUEST_DELAY_MS` | Delay between NCBI requests in ms | 334 (100 with key) |
| `NCBI_MAX_RETRIES` | Retry attempts for failed NCBI requests | 6 |
| `NCBI_TIMEOUT_MS` | Per-request HTTP timeout in ms | `30000` |
| `NCBI_TOTAL_DEADLINE_MS` | Total deadline across all retry attempts for one NCBI call, in ms | `60000` |
| `UNPAYWALL_EMAIL` | Contact email for Unpaywall. When set, `pubmed_fetch_fulltext` falls back to Unpaywall open-access copies for non-PMC DOIs | none |
| `UNPAYWALL_TIMEOUT_MS` | Per-request HTTP timeout for Unpaywall lookups and content fetches, in ms | `20000` |
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
| `src/mcp-server/tools` | Tool definitions (`*.tool.ts`). Nine PubMed tools. |
| `src/mcp-server/resources` | Resource definitions. Database info resource. |
| `src/mcp-server/prompts` | Prompt definitions. Research plan prompt. |
| `src/services/ncbi` | NCBI E-utilities service layer — API client, queue, parser, formatter. |
| `src/services/unpaywall` | Unpaywall service — DOI → OA location resolution and content fetch (HTML/PDF). |
| `src/config` | Server-specific environment variable parsing and validation with Zod. |
| `tests/` | Unit and integration tests, mirroring the `src/` structure. |

## Development guide

See [`CLAUDE.md`](./CLAUDE.md) for development guidelines and architectural rules. The short version:

- Handlers throw, framework catches — no `try/catch` in tool logic
- Use `ctx.log` for logging, `ctx.state` for storage
- Register new tools and resources in the `createApp()` arrays

## Contributing

Issues and pull requests are welcome. Run checks and tests before submitting:

```sh
bun run devcheck
bun run test
```

## License

This project is licensed under the Apache 2.0 License. See the [LICENSE](./LICENSE) file for details.
