<div align="center">

# pubmed-mcp-server

**Empower your AI agents and research tools with seamless PubMed integration!**

[![TypeScript](https://img.shields.io/badge/TypeScript-^5.8.3-blue.svg?style=flat-square)](https://www.typescriptlang.org/)
[![Model Context Protocol](https://img.shields.io/badge/MCP%20SDK-^1.18.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/)
[![Version](https://img.shields.io/badge/Version-1.4.4-blue.svg?style=flat-square)](./CHANGELOG.md)
[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg?style=flat-square)](https://opensource.org/licenses/Apache-2.0)
[![Status](https://img.shields.io/badge/Status-Stable-green.svg?style=flat-square)](https://github.com/cyanheads/pubmed-mcp-server/issues)
[![GitHub](https://img.shields.io/github/stars/cyanheads/pubmed-mcp-server?style=social)](https://github.com/cyanheads/pubmed-mcp-server)

</div>

A production-grade Model Context Protocol (MCP) server that empowers AI agents and research tools with comprehensive access to PubMed. Enables advanced, automated workflows for searching, retrieving, analyzing, and visualizing biomedical and scientific literature via NCBI E-utilities.

Built on the [`cyanheads/mcp-ts-template`](https://github.com/cyanheads/mcp-ts-template), this server follows a modular architecture with robust error handling, logging, and security features.

## 🚀 Core Capabilities: PubMed Tools 🛠️

This server equips your AI with specialized tools to interact with PubMed:

| Tool Name                                                                        | Description                                                                             | Example                                                                                                  |
| :------------------------------------------------------------------------------- | :-------------------------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------------- |
| [`pubmed_search_articles`](./src/mcp-server/tools/pubmedSearchArticles/)         | Searches PubMed for articles based on your query.                                       | [View Example](./examples/pubmed_search_articles_example.md)                                             |
| [`pubmed_fetch_contents`](./src/mcp-server/tools/pubmedFetchContents/)           | Retrieves detailed information for PubMed articles.                                     | [View Example](./examples/pubmed_fetch_contents_example.md)                                              |
| [`pubmed_article_connections`](./src/mcp-server/tools/pubmedArticleConnections/) | Finds related articles (cited by, similar, references) or formats citations for a PMID. | [Ex. 1](./examples/pubmed_article_connections_1.md), [Ex. 2](./examples/pubmed_article_connections_2.md) |
| [`pubmed_research_agent`](./src/mcp-server/tools/pubmedResearchAgent/)           | Generates a standardized JSON research plan outline from component details.             | [View Example](./examples/pubmed_research_agent_example.md)                                              |
| [`pubmed_generate_chart`](./src/mcp-server/tools/pubmedGenerateChart/)           | Generates a chart image (PNG) from given input data.                                    | [View Examples](./examples/generate_pubmed_chart/)                                                       |

---

## Table of Contents

| [Overview](#overview)           | [Features](#features)                          | [Installation](#installation) |
| :------------------------------ | :--------------------------------------------- | :---------------------------- |
| [Configuration](#configuration) | [Project Structure](#project-structure)        |
| [Tools](#tools)                 | [Development & Testing](#development--testing) | [License](#license)           |

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
- **Configuration**: Environment variable loading (`dotenv`) with comprehensive validation using Zod.
- **Input Validation/Sanitization**: Uses `zod` for schema validation and custom sanitization logic.
- **Request Context**: Tracking and correlation of operations via unique request IDs using `AsyncLocalStorage`.
- **Type Safety**: Strong typing enforced by TypeScript and Zod schemas.
- **HTTP Transport**: High-performance HTTP server using **Hono**, featuring session management and authentication support.
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

- [Node.js (>=20.0.0)](https://nodejs.org/)
- [npm](https://www.npmjs.com/) (comes with Node.js)
- **NCBI API Key** (recommended for higher rate limits) - [Get one here](https://ncbiinsights.ncbi.nlm.nih.gov/2017/11/02/new-api-keys-for-the-e-utilities/)

### MCP Client Settings

Add the following to your MCP client's configuration file (e.g., `cline_mcp_settings.json`).
This configuration uses `npx` to run the server, which will automatically install the package if not already present.
All environment variables are optional, but recommended for production use. NCBI API key is recommended to avoid rate limiting issues.

```json
{
  "mcpServers": {
    "pubmed-mcp-server": {
      "command": "npx",
      "args": ["@cyanheads/pubmed-mcp-server"],
      "env": {
        "MCP_LOG_LEVEL": "debug",
        "MCP_TRANSPORT_TYPE": "http",
        "MCP_HTTP_PORT": "3017",
        "NCBI_API_KEY": "YOUR_NCBI_API_KEY_HERE"
      }
    }
  }
}
```

### If running manually (not via MCP client for development or testing)

#### Install via npm

```bash
npm install @cyanheads/pubmed-mcp-server
```

#### Alternatively Install from Source

1.  Clone the repository:
    ```bash
    git clone https://github.com/cyanheads/pubmed-mcp-server.git
    cd pubmed-mcp-server
    ```
2.  Install dependencies:
    ```bash
    npm install
    ```
3.  Build the project:
    ```bash
    npm run build
    ```

## Configuration

### Environment Variables

Configure the server using environment variables. For local development, these can be set in a `.env` file at the project root or directly in your environment. Otherwise, you can set them in your MCP client configuration as shown above.

| Variable              | Description                                                                              | Default       |
| :-------------------- | :--------------------------------------------------------------------------------------- | :------------ |
| `MCP_TRANSPORT_TYPE`  | Transport mechanism: `stdio` or `http`.                                                  | `stdio`       |
| `MCP_HTTP_PORT`       | Port for the HTTP server (if `MCP_TRANSPORT_TYPE=http`).                                 | `3017`        |
| `MCP_HTTP_HOST`       | Host address for the HTTP server (if `MCP_TRANSPORT_TYPE=http`).                         | `127.0.0.1`   |
| `MCP_ALLOWED_ORIGINS` | Comma-separated list of allowed origins for CORS (if `MCP_TRANSPORT_TYPE=http`).         | (none)        |
| `MCP_LOG_LEVEL`       | Logging level (`debug`, `info`, `notice`, `warning`, `error`, `crit`, `alert`, `emerg`). | `debug`       |
| `MCP_AUTH_MODE`       | Authentication mode for HTTP: `jwt` or `oauth`.                                          | `jwt`         |
| `MCP_AUTH_SECRET_KEY` | **Required for `jwt` auth.** Minimum 32-character secret key for JWT authentication.     | (none)        |
| `NCBI_API_KEY`        | **Recommended.** Your NCBI API Key for higher rate limits and reliable access.           | (none)        |
| `LOGS_DIR`            | Directory for log file storage.                                                          | `logs/`       |
| `NODE_ENV`            | Runtime environment (`development`, `production`).                                       | `development` |

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
│   └── tools/            # MCP Tool implementations (subdirs per tool)
├── services/             # External service integrations
│   └── NCBI/             # NCBI E-utilities API client and parsing
├── types-global/         # Shared TypeScript type definitions
└── utils/                # Common utility functions (logger, error handler, etc.)
```

For a detailed file tree, run `npm run tree` or see [docs/tree.md](docs/tree.md).

## Tools

The PubMed MCP Server provides a comprehensive suite of tools for biomedical literature research, callable via the Model Context Protocol.

| Tool Name                    | Description                                                            | Key Arguments                                                                                             |
| :--------------------------- | :--------------------------------------------------------------------- | :-------------------------------------------------------------------------------------------------------- |
| `pubmed_search_articles`     | Searches PubMed for articles using queries, filters, and date ranges.  | `queryTerm`, `maxResults?`, `sortBy?`, `dateRange?`, `filterByPublicationTypes?`, `fetchBriefSummaries?`  |
| `pubmed_fetch_contents`      | Fetches detailed article information using PMIDs or search history.    | `pmids?`, `queryKey?`, `webEnv?`, `detailLevel?`, `includeMeshTerms?`, `includeGrantInfo?`                |
| `pubmed_article_connections` | Finds related articles, citations, and references for a given PMID.    | `sourcePmid`, `relationshipType?`, `maxRelatedResults?`, `citationStyles?`                                |
| `pubmed_research_agent`      | Generates structured research plans with literature search strategies. | `project_title_suggestion`, `primary_research_goal`, `research_keywords`, `organism_focus?`, `p1_*`, etc. |
| `pubmed_generate_chart`      | Creates customizable PNG charts from structured publication data.      | `chartType`, `dataValues`, `xField`, `yField`, `title?`, `seriesField?`, `sizeField?`                     |

_Note: All tools support comprehensive error handling and return structured JSON responses._

## Examples

Comprehensive usage examples for each tool are available in the [`examples/`](examples/) directory.

- **`pubmed_search_articles`**: [View Example](./examples/pubmed_search_articles_example.md)
- **`pubmed_fetch_contents`**: [View Example](./examples/pubmed_fetch_contents_example.md)
- **`pubmed_article_connections`**: [Ex. 1](./examples/pubmed_article_connections_1.md), [Ex. 2](./examples/pubmed_article_connections_2.md)
- **`pubmed_research_agent`**: [View Example](./examples/pubmed_research_agent_example.md)
- **`pubmed_generate_chart`**: [View Examples](./examples/generate_pubmed_chart/)

## Development & Testing

### Development Scripts

```bash
# Build the project (compile TS to JS in dist/ and make executable)
npm run build

# Clean build artifacts
npm run clean

# Clean build artifacts and then rebuild the project
npm run rebuild

# Lint the codebase
npm run lint

# Format code with Prettier
npm run format

# Generate a file tree representation for documentation
npm run tree
```

### Running the Server

```bash
# Start the server using stdio (default)
npm start
# Or explicitly:
npm run start:stdio

# Start the server using HTTP transport
npm run start:http

# Test the server locally using the MCP inspector tool (stdio transport)
npm run inspector

# Test the server locally using the MCP inspector tool (http transport)
npm run inspector:http
```

## License

This project is licensed under the Apache License 2.0 - see the [LICENSE](LICENSE) file for details.

---

<div align="center">
Built with the <a href="https://modelcontextprotocol.io/">Model Context Protocol</a>
</div>
