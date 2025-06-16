/**
 * @fileoverview Main entry point for the MCP (Model Context Protocol) server.
 * This file orchestrates the server's lifecycle:
 * 1. Initializes the core `McpServer` instance (from `@modelcontextprotocol/sdk`) with its identity and capabilities.
 * 2. Registers available resources and tools, making them discoverable and usable by clients.
 * 3. Selects and starts the appropriate communication transport (stdio or Streamable HTTP)
 *    based on configuration.
 * 4. Handles top-level error management during startup.
 *
 * MCP Specification References:
 * - Lifecycle: https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/docs/specification/2025-03-26/basic/lifecycle.mdx
 * - Overview (Capabilities): https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/docs/specification/2025-03-26/basic/index.mdx
 * - Transports: https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/docs/specification/2025-03-26/basic/transports.mdx
 * @module src/mcp-server/server
 */

import { ServerType } from "@hono/node-server";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { config, environment } from "../config/index.js";
import { ErrorHandler, logger, requestContextService } from "../utils/index.js";
import { BaseErrorCode } from "../types-global/errors.js";
import { registerFetchPubMedContentTool } from "./tools/fetchPubMedContent/index.js";
import { registerGeneratePubMedChartTool } from "./tools/generatePubMedChart/index.js";
import { registerGetPubMedArticleConnectionsTool } from "./tools/getPubMedArticleConnections/index.js";
import { registerPubMedResearchAgentTool } from "./tools/pubmedResearchAgent/index.js";
import { registerSearchPubMedArticlesTool } from "./tools/searchPubMedArticles/index.js";
import { startHttpTransport } from "./transports/httpTransport.js";
import { connectStdioTransport } from "./transports/stdioTransport.js";

/**
 * Creates and configures a new instance of the `McpServer`.
 *
 * This function defines the server's identity and capabilities as presented
 * to clients during MCP initialization.
 *
 * MCP Spec Relevance:
 * - Server Identity (`serverInfo`): `name` and `version` are part of `ServerInformation`.
 * - Capabilities Declaration: Declares supported features (logging, dynamic resources/tools).
 * - Resource/Tool Registration: Makes capabilities discoverable and invocable.
 *
 * @returns A promise resolving with the configured `McpServer` instance.
 * @throws {McpError} If any resource or tool registration fails.
 * @private
 */
async function createMcpServerInstance(): Promise<McpServer> {
  const context = requestContextService.createRequestContext({
    operation: "createMcpServerInstance",
  });
  logger.info("Initializing MCP server instance", context);

  requestContextService.configure({
    appName: config.mcpServerName,
    appVersion: config.mcpServerVersion,
    environment,
  });

  const server = new McpServer(
    { name: config.mcpServerName, version: config.mcpServerVersion },
    {
      capabilities: {
        logging: {}, // Server can receive logging/setLevel and send notifications/message
        resources: { listChanged: true }, // Server supports dynamic resource lists
        tools: { listChanged: true }, // Server supports dynamic tool lists
      },
    },
  );

  await ErrorHandler.tryCatch(
    async () => {
      logger.debug("Registering resources and tools...", context);
      // IMPORTANT: Keep tool registrations in alphabetical order. Do not remove this comment.
      await registerFetchPubMedContentTool(server);
      await registerGeneratePubMedChartTool(server);
      await registerGetPubMedArticleConnectionsTool(server);
      await registerPubMedResearchAgentTool(server);
      await registerSearchPubMedArticlesTool(server);
      logger.info("Resources and tools registered successfully", context);
    },
    {
      operation: "registerAllTools",
      context,
      errorCode: BaseErrorCode.INITIALIZATION_FAILED,
      critical: true,
    },
  );

  return server;
}

/**
 * Selects, sets up, and starts the appropriate MCP transport layer based on configuration.
 *
 * MCP Spec Relevance:
 * - Transport Selection: Uses `config.mcpTransportType` ('stdio' or 'http').
 * - Transport Connection: Calls dedicated functions for chosen transport.
 * - Server Instance Lifecycle: Single instance for 'stdio', per-session for 'http'.
 *
 * @returns Resolves with `McpServer` for 'stdio', `http.Server` for 'http', or `void`.
 * @throws {Error} If transport type is unsupported or setup fails.
 * @private
 */
async function startTransport(): Promise<McpServer | ServerType | void> {
  const transportType = config.mcpTransportType;
  const context = requestContextService.createRequestContext({
    operation: "startTransport",
    transport: transportType,
  });
  logger.info(`Starting transport: ${transportType}`, context);

  if (transportType === "http") {
    return startHttpTransport(createMcpServerInstance, context);
  }

  if (transportType === "stdio") {
    const server = await createMcpServerInstance();
    await connectStdioTransport(server, context);
    return server;
  }

  throw new Error(
    `Unsupported transport type: ${transportType}. Must be 'stdio' or 'http'.`,
  );
}

/**
 * Main application entry point. Initializes and starts the MCP server.
 * Orchestrates server startup, transport selection, and top-level error handling.
 */
export async function initializeAndStartServer(): Promise<
  void | McpServer | ServerType
> {
  const context = requestContextService.createRequestContext({
    operation: "initializeAndStartServer",
  });
  logger.info("MCP Server initialization sequence started.", context);
  try {
    const result = await startTransport();
    logger.info(
      "MCP Server initialization sequence completed successfully.",
      context,
    );
    return result;
  } catch (err) {
    ErrorHandler.handleError(err, {
      operation: "initializeAndStartServer",
      context: context,
      critical: true,
      rethrow: false, // Ensure we don't rethrow, so we can exit gracefully.
    });
    logger.info(
      "Exiting process due to critical initialization error.",
      context,
    );
    process.exit(1);
  }
}
