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

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import http from "http";
import { config, environment } from "../config/index.js";
import { ErrorHandler, logger, requestContextService } from "../utils/index.js";
import { registerPubMedArticleConnectionsTool } from "./tools/pubmedArticleConnections/index.js";
import { registerPubMedFetchContentsTool } from "./tools/pubmedFetchContents/index.js";
import { registerPubMedGenerateChartTool } from "./tools/pubmedGenerateChart/index.js";
import { registerPubMedResearchAgentTool } from "./tools/pubmedResearchAgent/index.js";
import { registerPubMedSearchArticlesTool } from "./tools/pubmedSearchArticles/index.js";
import { startHttpTransport } from "./transports/http/index.js";
import { startStdioTransport } from "./transports/stdio/index.js";

type SdkToolSpec = Parameters<McpServer["registerTool"]>[1];
type ServerIdentity = ConstructorParameters<typeof McpServer>[0];
type McpServerOptions = NonNullable<ConstructorParameters<typeof McpServer>[1]>;

export interface DescribedTool extends SdkToolSpec {
  title: string;
}

export interface ServerInstanceInfo {
  server: McpServer;
  tools: DescribedTool[];
  identity: ServerIdentity;
  options: McpServerOptions;
}

/**
 * Creates and configures a new instance of the `McpServer`.
 *
 * @returns A promise resolving with the configured `McpServer` instance and its tool metadata.
 * @throws {McpError} If any resource or tool registration fails.
 * @private
 */
async function createMcpServerInstance(): Promise<ServerInstanceInfo> {
  const context = requestContextService.createRequestContext({
    operation: "createMcpServerInstance",
  });
  logger.info("Initializing MCP server instance", context);

  requestContextService.configure({
    appName: config.mcpServerName,
    appVersion: config.mcpServerVersion,
    environment,
  });

  const identity: ServerIdentity = {
    name: config.mcpServerName,
    version: config.mcpServerVersion,
    description: config.mcpServerDescription,
  };

  const options: McpServerOptions = {
    capabilities: {
      logging: {},
      resources: { listChanged: true },
      tools: { listChanged: true },
    },
  };

  const server = new McpServer(identity, options);

  const registeredTools: DescribedTool[] = [];
  const originalRegisterTool = server.registerTool.bind(server);
  server.registerTool = (name, spec, implementation) => {
    registeredTools.push({
      title: name,
      description: spec.description,
      inputSchema: spec.inputSchema,
      outputSchema: spec.outputSchema,
      annotations: spec.annotations,
    });
    return originalRegisterTool(name, spec, implementation);
  };

  try {
    logger.debug("Registering resources and tools...", context);
    // IMPORTANT: Keep tool registrations in alphabetical order.
    await registerPubMedArticleConnectionsTool(server);
    await registerPubMedFetchContentsTool(server);
    await registerPubMedGenerateChartTool(server);
    await registerPubMedResearchAgentTool(server);
    await registerPubMedSearchArticlesTool(server);
    logger.info("Resources and tools registered successfully", context);
  } catch (err) {
    logger.error("Failed to register resources/tools", {
      ...context,
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
    throw err;
  }

  return { server, tools: registeredTools, identity, options };
}

/**
 * Selects, sets up, and starts the appropriate MCP transport layer based on configuration.
 *
 * @returns Resolves with `McpServer` for 'stdio' or `http.Server` for 'http'.
 * @throws {Error} If transport type is unsupported or setup fails.
 * @private
 */
async function startTransport(): Promise<McpServer | http.Server> {
  const transportType = config.mcpTransportType;
  const context = requestContextService.createRequestContext({
    operation: "startTransport",
    transport: transportType,
  });
  logger.info(`Starting transport: ${transportType}`, context);

  if (transportType === "http") {
    const { server } = await startHttpTransport(
      createMcpServerInstance,
      context,
    );
    return server as http.Server;
  }

  if (transportType === "stdio") {
    const { server } = await createMcpServerInstance();
    await startStdioTransport(server, context);
    return server;
  }

  logger.fatal(
    `Unsupported transport type configured: ${transportType}`,
    context,
  );
  throw new Error(
    `Unsupported transport type: ${transportType}. Must be 'stdio' or 'http'.`,
  );
}

/**
 * Main application entry point. Initializes and starts the MCP server.
 */
export async function initializeAndStartServer(): Promise<
  McpServer | http.Server
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
    logger.fatal("Critical error during MCP server initialization.", {
      ...context,
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
    ErrorHandler.handleError(err, {
      ...context,
      operation: "initializeAndStartServer_Catch",
      critical: true,
    });
    logger.info(
      "Exiting process due to critical initialization error.",
      context,
    );
    process.exit(1);
  }
}
