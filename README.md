<div align="center">
  <h1>pubmed-mcp-server</h1>
  <p><b>MCP server for the NCBI E-utilities API. Search PubMed, fetch article metadata and full text, generate citations, explore MeSH terms, and discover related research. Runs over stdio or HTTP. Deployable to Cloudflare Workers.</b>
  <div>7 Tools • 1 Resource • 1 Prompt</div>
  </p>
</div>

<div align="center">

[![npm](https://img.shields.io/npm/v/@cyanheads/pubmed-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/pubmed-mcp-server) [![Version](https://img.shields.io/badge/Version-2.1.1-blue.svg?style=flat-square)](./CHANGELOG.md) [![MCP Spec](https://img.shields.io/badge/MCP%20Spec-2025--11--25-8A2BE2.svg?style=flat-square)](https://modelcontextprotocol.io/specification/2025-11-25) 

[![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^1.27.1-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Status](https://img.shields.io/badge/Status-Stable-brightgreen.svg?style=flat-square)](https://github.com/cyanheads/pubmed-mcp-server/issues) [![TypeScript](https://img.shields.io/badge/TypeScript-^5.9.3-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.3.2-blueviolet.svg?style=flat-square)](https://bun.sh/)

</div>

---

## Tools

Seven tools for working with PubMed and NCBI data:

| Tool | Description |
|:---|:---|
| `pubmed_search` | Search PubMed with full query syntax, field-specific filters, date ranges, pagination, and optional brief summaries |
| `pubmed_fetch` | Fetch full article metadata by PMIDs — abstract, authors, journal, MeSH terms, grants |
| `pmc_fetch` | Fetch full-text articles from PubMed Central — body sections, references, and metadata for open-access articles |
| `pubmed_cite` | Generate formatted citations in APA 7th, MLA 9th, BibTeX, or RIS |
| `pubmed_related` | Find similar articles, citing articles, or references for a given PMID |
| `pubmed_spell` | Spell-check biomedical queries using NCBI's ESpell service |
| `pubmed_mesh_lookup` | Search and explore MeSH vocabulary — tree numbers, scope notes, entry terms |

### `pubmed_search`

Search PubMed with full NCBI query syntax and filters.

- Free-text queries with PubMed's full boolean and field-tag syntax
- Field-specific filters: author, journal, MeSH terms, language, species
- Common filters: has abstract, free full text
- Date range filtering by publication, modification, or Entrez date
- Publication type filtering (Review, Clinical Trial, Meta-Analysis, etc.)
- Sort by relevance, publication date, author, or journal
- Pagination via offset for paging through large result sets
- Optional brief summaries for top N results via ESummary

---

### `pubmed_fetch`

Fetch full article metadata by PubMed IDs.

- Batch fetch up to 200 articles at once (auto-switches to POST for large batches)
- Returns structured data: title, abstract, authors with deduplicated affiliations, journal info, DOI
- Direct links to PubMed and PubMed Central (when available)
- Optional MeSH terms, grant information, and publication types
- Handles PubMed's inconsistent XML (structured abstracts, missing fields, varying date formats)

---

### `pmc_fetch`

Fetch full-text articles from PubMed Central (PMC).

- Accepts PMC IDs directly or PubMed IDs (auto-resolved to PMCIDs via ELink)
- Returns complete article body text organized by sections and subsections
- Optional reference list from back matter
- Section filtering by title (case-insensitive match, e.g. `["methods", "results"]`)
- Configurable max sections to limit response size
- Up to 10 articles per request
- Only open-access articles available in PMC will return full text

---

### `pubmed_cite`

Generate formatted citations for articles.

- Four citation styles: APA 7th, MLA 9th, BibTeX, RIS
- Request multiple styles per article in a single call
- Hand-rolled formatters — zero external dependencies, fully Workers-compatible
- Up to 50 articles per request

---

### `pubmed_related`

Find articles related to a source article via ELink.

- Three relationship types: `similar` (content similarity), `cited_by`, `references`
- Results enriched with title, authors, publication date, and source via ESummary
- Similarity scores included for `similar` relationship type

---

### `pubmed_spell`

Spell-check a biomedical query using NCBI's ESpell.

- Returns the original query, corrected query, and whether a suggestion was found
- Useful for query refinement before searching

---

### `pubmed_mesh_lookup`

Search and explore the MeSH (Medical Subject Headings) vocabulary.

- Search MeSH terms by name with exact-heading matching
- Detailed records with tree numbers, scope notes, and entry terms by default
- Useful for building precise PubMed queries with controlled vocabulary

## Resource and prompt

| Type | Name | Description |
|:---|:---|:---|
| Resource | `pubmed://database/info` | PubMed database metadata via EInfo (field list, record count, last update) |
| Prompt | `research_plan` | Generate a structured 4-phase biomedical research plan outline |

## Features

Built on [`mcp-ts-template`](https://github.com/cyanheads/mcp-ts-template) 3.0:

- Declarative tool definitions — single file per tool, framework handles registration and validation
- Unified `McpError` error handling across all tools
- Pluggable auth (`none`, `jwt`, `oauth`)
- Swappable storage backends: `in-memory`, `filesystem`, `Supabase`, `Cloudflare KV/R2/D1`
- Structured logging (Pino) with optional OpenTelemetry tracing
- Typed DI container with `Token<T>` phantom branding
- Runs locally (stdio/HTTP) or on Cloudflare Workers from the same codebase

PubMed-specific:

- Complete NCBI E-utilities integration (ESearch, EFetch, ESummary, ELink, ESpell, EInfo)
- Sequential request queue with configurable delay for NCBI rate limit compliance
- NCBI-specific XML parser with `isArray` hints for PubMed's inconsistent XML structure
- Hand-rolled citation formatters (APA, MLA, BibTeX, RIS) — zero deps, Workers-compatible

## Getting started

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
MCP_TRANSPORT_TYPE=http MCP_HTTP_PORT=3017 bun run start:http
# Server listens at http://localhost:3017/mcp
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

All configuration is centralized and validated at startup in `src/config/index.ts`. Key environment variables:

| Variable | Description | Default |
|:---|:---|:---|
| `MCP_TRANSPORT_TYPE` | Transport: `stdio` or `http` | `stdio` |
| `MCP_HTTP_PORT` | HTTP server port | `3017` |
| `MCP_AUTH_MODE` | Authentication: `none`, `jwt`, or `oauth` | `none` |
| `MCP_LOG_LEVEL` | Log level (`debug`, `info`, `warning`, `error`, etc.) | `info` |
| `STORAGE_PROVIDER_TYPE` | Storage backend: `in-memory`, `filesystem`, `supabase`, `cloudflare-kv/r2/d1` | `in-memory` |
| `NCBI_API_KEY` | NCBI API key for higher rate limits (10 req/s vs 3 req/s) | none |
| `NCBI_ADMIN_EMAIL` | Contact email sent with NCBI requests (recommended by NCBI) | none |
| `NCBI_REQUEST_DELAY_MS` | Delay between NCBI requests in ms | 334 (100 with key) |
| `NCBI_MAX_RETRIES` | Retry attempts for failed NCBI requests | 3 |
| `NCBI_TIMEOUT_MS` | NCBI request timeout in ms | 30000 |
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

### Cloudflare Workers

1. **Build the Worker bundle**:

```sh
bun run build:worker
```

2. **Run locally with Wrangler**:

```sh
bun run deploy:dev
```

3. **Deploy to Cloudflare**:
    ```sh
    bun run deploy:prod
    ```

## Project structure

| Directory | Purpose |
|:---|:---|
| `src/mcp-server/tools` | Tool definitions (`*.tool.ts`). Seven PubMed tools. |
| `src/mcp-server/resources` | Resource definitions. Database info resource. |
| `src/mcp-server/prompts` | Prompt definitions. Research plan prompt. |
| `src/mcp-server/transports` | HTTP and stdio transports, including auth middleware. |
| `src/services/ncbi` | NCBI E-utilities service layer — API client, queue, parser, formatter. |
| `src/storage` | `StorageService` abstraction and provider implementations. |
| `src/container` | DI container registrations and tokens. |
| `src/utils` | Logging, error handling, security, parsing, formatting, telemetry. |
| `src/config` | Environment variable parsing and validation with Zod. |
| `schemas/ncbi-dtd` | NCBI E-utilities DTD files — XML schema definitions for ESearch, EFetch, ESummary, ELink, ESpell, EInfo, and PubMed article XML. |
| `docs/ncbi` | NCBI reference material ([E-utilities help manual](docs/ncbi/eutilities-help.pdf)). |
| `tests/` | Unit and integration tests, mirroring the `src/` structure. |

## Development guide

See [`CLAUDE.md`](./CLAUDE.md) for development guidelines and architectural rules. The short version:

- Logic throws `McpError`, handlers catch — no `try/catch` in tool logic
- Pass `RequestContext` through the call stack for logging and tracing
- Register new tools and resources in the `index.ts` barrel files

## Contributing

Issues and pull requests are welcome. Run checks and tests before submitting:

```sh
bun run devcheck
bun run test
```

## License

This project is licensed under the Apache 2.0 License. See the [LICENSE](./LICENSE) file for details.
