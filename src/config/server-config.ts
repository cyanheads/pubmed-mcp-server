/**
 * @fileoverview Server-specific configuration for NCBI E-utilities.
 * Lazy-parsed from environment variables. Framework config (transport, logging, etc.)
 * is handled by @cyanheads/mcp-ts-core.
 * @module src/config/server-config
 */

import { z } from '@cyanheads/mcp-ts-core';

const ServerConfigSchema = z.object({
  /** NCBI API key for higher rate limits. Optional but recommended. */
  apiKey: z.string().optional().describe('NCBI API key'),
  /** Tool identifier sent with every NCBI request (required by NCBI). */
  toolIdentifier: z.string().describe('NCBI tool identifier'),
  /** Admin email sent with every NCBI request (required by NCBI). */
  adminEmail: z.email().optional().describe('Admin contact email'),
  /** Minimum delay between NCBI requests in ms. NCBI requires ~334ms without API key. */
  requestDelayMs: z.coerce.number().min(50).max(5000).default(334).describe('Request delay in ms'),
  /** Maximum retry attempts for failed NCBI requests. */
  maxRetries: z.coerce.number().min(0).max(10).default(6).describe('Max retry attempts'),
  /** Request timeout in ms. */
  timeoutMs: z.coerce
    .number()
    .min(1000)
    .max(120000)
    .default(30000)
    .describe('Request timeout in ms'),
});

export type ServerConfig = z.infer<typeof ServerConfigSchema>;

let _config: ServerConfig | undefined;

export function getServerConfig(): ServerConfig {
  if (!_config) {
    const env = process.env;
    const hasApiKey = !!env.NCBI_API_KEY;
    _config = ServerConfigSchema.parse({
      apiKey: env.NCBI_API_KEY || undefined,
      toolIdentifier: env.NCBI_TOOL_IDENTIFIER ?? 'pubmed-mcp-server',
      adminEmail: env.NCBI_ADMIN_EMAIL || undefined,
      requestDelayMs: env.NCBI_REQUEST_DELAY_MS ?? (hasApiKey ? 100 : 334),
      maxRetries: env.NCBI_MAX_RETRIES,
      timeoutMs: env.NCBI_TIMEOUT_MS,
    });
  }
  return _config;
}
