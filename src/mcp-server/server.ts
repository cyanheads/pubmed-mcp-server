/**
 * @fileoverview Main entry point for the MCP (Model Context Protocol) server.
 * This file orchestrates the server's lifecycle:
 * 1. Initializes the core `McpServer` instance (from `@modelcontextprotocol/sdk`) with its identity and capabilities.
 * 2. Registers available resources and tools, making them discoverable and usable by clients.
 * 3. Selects and starts the appropriate communication transport (stdio or Streamable HTTP)
 *    based on configuration.
 * 4. Handles top-level error management during startup.
 *
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
import { startHttpTransport } from "./transports/http/index.js";
import { startStdioTransport } from "./transports/stdio/index.js";

/**
 * Creates and configures a new instance of the `McpServer`.
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

  const server = new McpServer(
    { name: config.mcpServerName, version: config.mcpServerVersion },
    {
      capabilities: {
        logging: {},
        resources: { listChanged: true },
        tools: { listChanged: true },
      },
    },
  );

  await ErrorHandler.tryCatch(
    async () => {
      logger.debug("Registering resources and tools...", context);
      // IMPORTANT: Keep tool registrations in alphabetical order.
      await registerFetchPubMedContentTool(server);
      await registerGeneratePubMedChartTool(server);
      await registerGetPubMedArticleConnectionsTool(server);
      await registerPubMedResearchAgentTool(server);
      await registerSearchPubMedArticlesTool(server);
      logger.info("Resources and tools registered successfully", context);
    },
    {
      operation: "registerAllCapabilities",
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

  const serverFactory = createMcpServerInstance;

  if (transportType === "http") {
    const { server } = await startHttpTransport(serverFactory, context);
    return server;
  }

  if (transportType === "stdio") {
    const server = await serverFactory();
    await startStdioTransport(server, context);
    return server;
  }

  throw new Error(
    `Unsupported transport type: ${transportType}. Must be 'stdio' or 'http'.`,
  );
}

/**
 * Main application entry point. Initializes and starts the MCP server.
 */
export async function initializeAndStartServer(): Promise<
  void | McpServer | ServerType
> {
  const context = requestContextService.createRequestContext({
    operation: "initializeAndStartServer",
  });
  logger.info("MCP Server initialization sequence started.", context);

  requestContextService.configure({
    appName: config.mcpServerName,
    appVersion: config.mcpServerVersion,
    environment,
  });

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
      rethrow: false,
    });
    logger.info(
      "Exiting process due to critical initialization error.",
      context,
    );
    process.exit(1);
  }
}
