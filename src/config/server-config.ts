/**
 * @fileoverview Server-specific configuration for NCBI E-utilities.
 * Lazy-parsed from environment variables. Framework config (transport, logging, etc.)
 * is handled by @cyanheads/mcp-ts-core.
 * @module src/config/server-config
 */

import { z } from '@cyanheads/mcp-ts-core';
import { parseEnvConfig } from '@cyanheads/mcp-ts-core/config';

const ServerConfigSchema = z.object({
  apiKey: z.string().optional().describe('NCBI API key'),
  toolIdentifier: z.string().default('pubmed-mcp-server').describe('NCBI tool identifier'),
  adminEmail: z.email().optional().describe('Admin contact email'),
  requestDelayMs: z.coerce.number().min(50).max(5000).default(400).describe('Request delay in ms'),
  maxConcurrent: z.coerce
    .number()
    .min(1)
    .max(16)
    .default(8)
    .describe('Max concurrent in-flight NCBI requests'),
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
  unpaywallEmail: z
    .email()
    .optional()
    .describe('Email for Unpaywall API (enables non-PMC full-text fallback when set)'),
  unpaywallTimeoutMs: z.coerce
    .number()
    .min(1000)
    .max(120000)
    .default(20000)
    .describe('Per-request HTTP timeout for Unpaywall lookups and content fetches, in ms'),
  europepmcEnabled: z
    .stringbool()
    .default(true)
    .describe(
      'Enable Europe PMC search tool and `pubmed_fetch_fulltext` JATS fallback chain. Set false to fully disable EPMC calls.',
    ),
  europepmcEmail: z
    .email()
    .optional()
    .describe('Optional contact email sent with Europe PMC requests'),
  europepmcRequestDelayMs: z.coerce
    .number()
    .min(50)
    .max(5000)
    .default(200)
    .describe('Minimum gap between Europe PMC request starts in ms'),
  europepmcMaxRetries: z.coerce
    .number()
    .min(0)
    .max(10)
    .default(3)
    .describe('Max retry attempts for failed Europe PMC requests'),
  europepmcTimeoutMs: z.coerce
    .number()
    .min(1000)
    .max(120000)
    .default(20000)
    .describe('Per-request HTTP timeout for Europe PMC calls, in ms'),
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
      maxConcurrent: 'NCBI_MAX_CONCURRENT',
      maxRetries: 'NCBI_MAX_RETRIES',
      timeoutMs: 'NCBI_TIMEOUT_MS',
      totalDeadlineMs: 'NCBI_TOTAL_DEADLINE_MS',
      unpaywallEmail: 'UNPAYWALL_EMAIL',
      unpaywallTimeoutMs: 'UNPAYWALL_TIMEOUT_MS',
      europepmcEnabled: 'EUROPEPMC_ENABLED',
      europepmcEmail: 'EUROPEPMC_EMAIL',
      europepmcRequestDelayMs: 'EUROPEPMC_REQUEST_DELAY_MS',
      europepmcMaxRetries: 'EUROPEPMC_MAX_RETRIES',
      europepmcTimeoutMs: 'EUROPEPMC_TIMEOUT_MS',
    });
    /**
     * An API key raises NCBI's rate ceiling from ~3 req/s to ~10 req/s. If the
     * operator hasn't explicitly overridden the delay, tighten from the 400ms
     * keyless default to 100ms when a key is present. A set-but-blank delay counts
     * as not overridden, matching how `parseEnvConfig` reads it.
     *
     * The keyless default sits above the 334ms that 3 req/s works out to, leaving
     * margin for arrival jitter: spaced at exactly the ceiling, a small burst of
     * concurrent calls draws 429s.
     */
    _config =
      parsed.apiKey && !process.env.NCBI_REQUEST_DELAY_MS?.trim()
        ? { ...parsed, requestDelayMs: 100 }
        : parsed;
  }
  return _config;
}
