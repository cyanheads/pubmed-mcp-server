# PubMed MCP Server

[![TypeScript](https://img.shields.io/badge/TypeScript-^5.8.3-blue.svg)](https://www.typescriptlang.org/)
[![Model Context Protocol](https://img.shields.io/badge/MCP%20SDK-^1.13.0-green.svg)](https://modelcontextprotocol.io/)
[![Version](https://img.shields.io/badge/Version-1.2.3-blue.svg)](./CHANGELOG.md)
[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)
[![Status](https://img.shields.io/badge/Status-Stable-green.svg)](https://github.com/cyanheads/pubmed-mcp-server/issues)
[![GitHub](https://img.shields.io/github/stars/cyanheads/pubmed-mcp-server?style=social)](https://github.com/cyanheads/pubmed-mcp-server)

**Empower your AI agents and research tools with seamless PubMed integration!**

<a href="https://glama.ai/mcp/servers/@cyanheads/pubmed-mcp-server">
  <img width="380" height="200" src="https://glama.ai/mcp/servers/@cyanheads/pubmed-mcp-server/badge" alt="PubMed Server MCP server" />
</a>

An MCP (Model Context Protocol) server providing comprehensive access to PubMed's biomedical literature database. Enables LLMs and AI agents to search, retrieve, analyze, and visualize scientific publications through NCBI's E-utilities API with advanced research workflow capabilities.

Built on the [`cyanheads/mcp-ts-template`](https://github.com/cyanheads/mcp-ts-template), this server follows a modular architecture with robust error handling, logging, and security features.

## 🚀 Core Capabilities: PubMed Tools 🛠️

This server equips your AI with specialized tools to interact with PubMed:

| Tool Name                                                                               | Description                                                                                                                                                                                                  | Key Features                                                                                                                                                                                                                                                                                                                                                                                         |
| :-------------------------------------------------------------------------------------- | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`search_pubmed_articles`](./src/mcp-server/tools/searchPubMedArticles/)                | Searches PubMed for articles based on your query. (See [Example](./examples/search_pubmed_articles_example.md))                                                                                              | - Filter by max results, sort order, date range, publication types.<br/>- Uses NCBI ESearch for PMIDs.<br/>- Optionally fetches brief summaries (title, authors, source, dates) via ESummary.                                                                                                                                                                                                        |
| [`fetch_pubmed_content`](./src/mcp-server/tools/fetchPubMedContent/)                    | Retrieves detailed information for PubMed articles. Can use a list of PMIDs or ESearch history (queryKey/webEnv) with pagination. (See [Example](./examples/fetch_pubmed_content_example.md))                | - Flexible `detailLevel`: `abstract_plus` (parsed details, optional MeSH/grant), `full_xml` (JSON representation of the PubMedArticle XML structure), `medline_text` (MEDLINE format), `citation_data` (minimal for citations).<br/>- Supports direct PMID list or `queryKey`/`webEnv` from ESearch history.<br/>- Supports `retstart`/`retmax` for pagination with history.<br/>- Uses NCBI EFetch. |
| [`get_pubmed_article_connections`](./src/mcp-server/tools/getPubMedArticleConnections/) | Finds related articles (cited by, similar, references) or formats citations for a PMID. (See [Ex.1](./examples/get_pubmed_article_connections_1.md), [Ex.2](./examples/get_pubmed_article_connections_2.md)) | - Uses NCBI ELink for relationships.<br/>- Uses NCBI EFetch for citation data (RIS, BibTeX, APA, MLA).<br/>- Filter by max related results.                                                                                                                                                                                                                                                          |
| [`pubmed_research_agent`](./src/mcp-server/tools/pubmedResearchAgent/)                  | Generates a standardized JSON research plan outline from component details. (See [Example](./examples/pubmed_research_agent_example.md))                                                                     | - Accepts granular inputs for all research phases.<br/>- Optionally embeds instructive prompts for agent execution.<br/>- Structures rough ideas into a formal, machine-readable plan for further processing.                                                                                                                                                                                        |
| [`generate_pubmed_chart`](./src/mcp-server/tools/generatePubMedChart/)                  | Generates a chart image (PNG) from given input data. (See [Examples](./examples/generate_pubmed_chart))                                                                                                      | - Supports a wide range of chart types: `bar`, `line`, `scatter`, `pie`, `doughnut`, `bubble`, `radar`, and `polarArea`.<br/>- Takes data values and field specifications for axes and series.<br/>- Uses `Chart.js` and `chartjs-node-canvas` for direct server-side rendering.                                                                                                                     |

---

## Table of Contents

| [Overview](#overview) | [Features](#features) | [Installation](#installation) |

| [Configuration](#configuration) | [Project Structure](#project-structure) |

| [Tools](#tools) | [Resources](#resources) | [Development](#development) | [License](#license) |

## Overview

The PubMed MCP Server acts as a bridge, allowing applications (MCP Clients) that understand the Model Context Protocol (MCP) – like advanced AI assistants (LLMs), IDE extensions, or custom research tools – to interact directly and efficiently with PubMed's vast biomedical literature database.

Instead of complex API integration or manual searches, your tools can leverage this server to:

- **Automate research workflows**: Search literature, fetch full article metadata, track citations, and generate research plans programmatically.
- **Gain research insights**: Access detailed publication data, author information, journal details, MeSH terms, and citation networks without leaving the host application.
- **Integrate PubMed into AI-driven research**: Enable LLMs to conduct literature reviews, analyze research trends, and support evidence-based decision making.
- **Visualize research data**: Generate charts and visualizations from publication metadata and search results.

Built on the robust `mcp-ts-template`, this server provides a standardized, secure, and efficient way to expose PubMed functionality via the MCP standard. It achieves this by integrating with NCBI's E-utilities API, ensuring compliance with rate limits and providing comprehensive error handling.

> **Developer Note**: This repository includes a [.clinerules](.clinerules) file that serves as a developer cheat sheet for your LLM coding agent with quick reference for the codebase patterns, file locations, and code snippets.

## Features

### Core Utilities

Leverages the robust utilities provided by the `mcp-ts-template`:

- **Logging**: Structured, configurable logging (file rotation, stdout JSON, MCP notifications) with sensitive data redaction.
- **Error Handling**: Centralized error processing, standardized error types (`McpError`), and automatic logging.
- **Configuration**: Environment variable loading (`dotenv`) with comprehensive validation.
- **Input Validation/Sanitization**: Uses `zod` for schema validation and custom sanitization logic.
- **Request Context**: Tracking and correlation of operations via unique request IDs using `AsyncLocalStorage`.
- **Type Safety**: Strong typing enforced by TypeScript and Zod schemas.
- **HTTP Transport**: High-performance HTTP server using **Hono**, featuring session management with garbage collection and CORS support.
- **Authentication**: Robust authentication layer supporting JWT and OAuth 2.1, with fine-grained scope enforcement.
- **Deployment**: Multi-stage `Dockerfile` for creating small, secure production images with native dependency support.

### PubMed Integration

- **NCBI E-utilities Integration**: Comprehensive access to ESearch, EFetch, ELink, and ESummary APIs with automatic XML parsing.
- **Advanced Search Capabilities**: Complex query construction with date ranges, publication types, author filters, and MeSH term support.
- **Full Article Metadata**: Retrieve complete publication data including abstracts, authors, affiliations, journal information, DOIs, and citation data.
- **Citation Network Analysis**: Find related articles, citing articles, and reference lists through ELink integration.
- **Research Planning**: Generate structured research plans with automated literature search strategies.
- **Data Visualization**: Create PNG charts from publication metadata (bar, line, scatter, pie, bubble, radar, polarArea).
- **Multiple Output Formats**: Support for JSON, MEDLINE text, full XML, and formatted citations (RIS, BibTeX, APA, MLA).
- **Batch Processing**: Efficient handling of multiple PMIDs with pagination support.

## Installation

### Prerequisites

- [Node.js (>=18.0.0)](https://nodejs.org/)
- [npm](https://www.npmjs.com/) (comes with Node.js)
- [Docker](https://www.docker.com/) (optional, for containerized deployment)
- **NCBI API Key** (recommended for higher rate limits) - [Get one here](https://ncbiinsights.ncbi.nlm.nih.gov/2017/11/02/new-api-keys-for-the-e-utilities/)

### Install via npm (recommended)

```bash
npm install @cyanheads/pubmed-mcp-server
```

### Alternatively Install from Source

1. Clone the repository:

   ```bash
   git clone https://github.com/cyanheads/pubmed-mcp-server.git
   cd pubmed-mcp-server
   ```

2. Install dependencies:

   ```bash
   npm install
   ```

3. Build the project:
   ```bash
   npm run build
   *or npm run rebuild*
   ```

## Configuration

### Environment Variables

Configure the server using environment variables. These environmental variables are set within your MCP client config/settings (e.g. `claude_desktop_config.json` for Claude Desktop)

| Variable               | Description                                                                              | Default                        |
| ---------------------- | ---------------------------------------------------------------------------------------- | ------------------------------ |
| `MCP_TRANSPORT_TYPE`   | Transport mechanism: `stdio` or `http`.                                                  | `stdio`                        |
| `MCP_HTTP_PORT`        | Port for the HTTP server (if `MCP_TRANSPORT_TYPE=http`).                                 | `3010`                         |
| `MCP_HTTP_HOST`        | Host address for the HTTP server (if `MCP_TRANSPORT_TYPE=http`).                         | `127.0.0.1`                    |
| `MCP_ALLOWED_ORIGINS`  | Comma-separated list of allowed origins for CORS (if `MCP_TRANSPORT_TYPE=http`).         | (none)                         |
| `MCP_LOG_LEVEL`        | Logging level (`debug`, `info`, `notice`, `warning`, `error`, `crit`, `alert`, `emerg`). | `debug`                        |
| `LOG_OUTPUT_MODE`      | Logging output mode: `file` or `stdout`.                                                 | `file`                         |
| `MCP_AUTH_MODE`        | Authentication mode for HTTP: `jwt` or `oauth`.                                          | `jwt`                          |
| `MCP_AUTH_SECRET_KEY`  | **Required for `jwt` auth.** Minimum 32-character secret key for JWT authentication.     | (none)                         |
| `NCBI_API_KEY`         | **Recommended.** Your NCBI API Key for higher rate limits and reliable access.           | (none)                         |
| `NCBI_TOOL_IDENTIFIER` | Tool identifier for NCBI E-utility requests.                                             | `@cyanheads/pubmed-mcp-server` |
| `LOGS_DIR`             | Directory for log file storage (if `LOG_OUTPUT_MODE=file`).                              | `logs/`                        |

### MCP Client Settings

Add the following to your MCP client's configuration file (e.g., `cline_mcp_settings.json`). This configuration uses `npx` to run the server, which will automatically install the package if not already present:

```json
{
  "mcpServers": {
    "pubmed-mcp-server": {
      "command": "npx",
      "args": ["@cyanheads/pubmed-mcp-server"],
      "env": {
        "NCBI_API_KEY": "your_ncbi_api_key_here"
      },
      "disabled": false,
      "autoApprove": []
    }
  }
}
```

## Project Structure

The codebase follows a modular structure within the `src/` directory:

```
src/
├── index.ts              # Entry point: Initializes and starts the server
├── config/               # Configuration loading (env vars, package info)
│   └── index.ts
├── mcp-server/           # Core MCP server logic and capability registration
│   ├── server.ts         # Server setup, capability registration
│   ├── transports/       # Transport handling (stdio, http)
│   ├── resources/        # MCP Resource implementations
│   └── tools/            # MCP Tool implementations (subdirs per tool)
├── services/             # External service integrations
│   └── NCBI/             # NCBI E-utilities API client and parsing
├── types-global/         # Shared TypeScript type definitions
└── utils/                # Common utility functions (logger, error handler, etc.)
```

For a detailed file tree, run `npm run tree` or see [docs/tree.md](docs/tree.md).

## Tools

The PubMed MCP Server provides a comprehensive suite of tools for biomedical literature research, callable via the Model Context Protocol.

| Tool Name                        | Description                                                            | Key Arguments                                                                                             |
| :------------------------------- | :--------------------------------------------------------------------- | :-------------------------------------------------------------------------------------------------------- |
| `search_pubmed_articles`         | Searches PubMed for articles using queries, filters, and date ranges.  | `queryTerm`, `maxResults?`, `sortBy?`, `dateRange?`, `filterByPublicationTypes?`, `fetchBriefSummaries?`  |
| `fetch_pubmed_content`           | Fetches detailed article information using PMIDs or search history.    | `pmids?`, `queryKey?`, `webEnv?`, `detailLevel?`, `includeMeshTerms?`, `includeGrantInfo?`                |
| `get_pubmed_article_connections` | Finds related articles, citations, and references for a given PMID.    | `sourcePmid`, `relationshipType?`, `maxRelatedResults?`, `citationStyles?`                                |
| `pubmed_research_agent`          | Generates structured research plans with literature search strategies. | `project_title_suggestion`, `primary_research_goal`, `research_keywords`, `organism_focus?`, `p1_*`, etc. |
| `generate_pubmed_chart`          | Creates customizable PNG charts from structured publication data.      | `chartType`, `dataValues`, `xField`, `yField`, `title?`, `seriesField?`, `sizeField?`                     |

_Note: All tools support comprehensive error handling and return structured JSON responses._

## Examples

Comprehensive usage examples are available in the [`examples/`](examples/) directory:

- [Search PubMed Articles](examples/search_pubmed_articles_example.md)
- [Fetch Article Content](examples/fetch_pubmed_content_example.md)
- [Article Connections](examples/get_pubmed_article_connections_1.md)
- [Research Planning](examples/pubmed_research_agent_example.md)
- [Chart Generation](./examples/generate_pubmed_chart/) - Generated chart examples (bar, line, scatter, pie, bubble, radar, polarArea) are available in the `examples/generate_pubmed_chart/` directory.

## Development

### Build and Test

```bash
# Build the project (compile TS to JS in dist/ and make executable)
npm run build

# Test the server locally using the MCP inspector tool (stdio transport)
npm run inspector

# Test the server locally using the MCP inspector tool (http transport)
npm run inspector:http

# Clean build artifacts
npm run clean

# Generate a file tree representation for documentation
npm run tree

# Clean build artifacts and then rebuild the project
npm run rebuild

# Format code with Prettier
npm run format

# Start the server using stdio (default)
npm start
# Or explicitly:
npm run start:stdio

# Start the server using HTTP transport
npm run start:http
```

## License

This project is licensed under the Apache License 2.0 - see the [LICENSE](LICENSE) file for details.

---

<div align="center">
Built with the <a href="https://modelcontextprotocol.io/">Model Context Protocol</a>
</div>