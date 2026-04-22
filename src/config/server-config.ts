/**
 * @fileoverview Server-specific configuration for NCBI E-utilities.
 * Lazy-parsed from environment variables. Framework config (transport, logging, etc.)
 * is handled by @cyanheads/mcp-ts-core.
 * @module src/config/server-config
 */

import { z } from '@cyanheads/mcp-ts-core';
import { parseEnvConfig } from '@cyanheads/mcp-ts-core/config';

/**
 * Treats an unset env var (`undefined`) and a set-but-empty env var (`""`)
 * identically. Without this, `NCBI_ADMIN_EMAIL=` would fail `z.email()`
 * validation instead of being interpreted as "no admin email configured".
 */
const emptyAsUndefined = (v: unknown) => (v === '' ? undefined : v);

const ServerConfigSchema = z.object({
  apiKey: z.preprocess(emptyAsUndefined, z.string().optional()).describe('NCBI API key'),
  toolIdentifier: z.string().default('pubmed-mcp-server').describe('NCBI tool identifier'),
  adminEmail: z.preprocess(emptyAsUndefined, z.email().optional()).describe('Admin contact email'),
  requestDelayMs: z.coerce.number().min(50).max(5000).default(334).describe('Request delay in ms'),
  maxRetries: z.coerce.number().min(0).max(10).default(6).describe('Max retry attempts'),
  timeoutMs: z.coerce
    .number()
    .min(1000)
    .max(120000)
    .default(30000)
    .describe('Per-request HTTP timeout in ms'),
  totalDeadlineMs: z.coerce
    .number()
    .min(5000)
    .max(600000)
    .default(60000)
    .describe('Total deadline across all retry attempts for one NCBI call, in ms'),
});

export type ServerConfig = z.infer<typeof ServerConfigSchema>;

let _config: ServerConfig | undefined;

export function getServerConfig(): ServerConfig {
  if (!_config) {
    const parsed = parseEnvConfig(ServerConfigSchema, {
      apiKey: 'NCBI_API_KEY',
      toolIdentifier: 'NCBI_TOOL_IDENTIFIER',
      adminEmail: 'NCBI_ADMIN_EMAIL',
      requestDelayMs: 'NCBI_REQUEST_DELAY_MS',
      maxRetries: 'NCBI_MAX_RETRIES',
      timeoutMs: 'NCBI_TIMEOUT_MS',
      totalDeadlineMs: 'NCBI_TOTAL_DEADLINE_MS',
    });
    /**
     * An API key raises NCBI's rate ceiling from ~3 req/s to ~10 req/s. If the
     * operator hasn't explicitly overridden the delay, tighten from the 334ms
     * safe default to 100ms when a key is present.
     */
    _config =
      parsed.apiKey && process.env.NCBI_REQUEST_DELAY_MS === undefined
        ? { ...parsed, requestDelayMs: 100 }
        : parsed;
  }
  return _config;
}
