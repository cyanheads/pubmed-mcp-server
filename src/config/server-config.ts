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
  requestDelayMs: z.coerce
    .number()
    .min(50)
    .max(5000)
    .optional()
    .describe(
      'Minimum gap between NCBI request starts in ms; unset takes the keyed or keyless default',
    ),
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

/** The parsed config, with an unset `requestDelayMs` resolved to its keyed or keyless default. */
export type ServerConfig = Omit<z.infer<typeof ServerConfigSchema>, 'requestDelayMs'> & {
  requestDelayMs: number;
};

let _config: ServerConfig | undefined;

export function getServerConfig(): ServerConfig {
  if (!_config) {
    const { requestDelayMs, ...parsed } = parseEnvConfig(ServerConfigSchema, {
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
     * An API key raises NCBI's rate ceiling from ~3 req/s to ~10 req/s, so an
     * unset delay takes 120ms with a key and 400ms without one. Unset is what
     * `parseEnvConfig` reads as unset: absent, blank, or an unsubstituted
     * `${…}` placeholder. An explicit delay always wins.
     *
     * Neither default sits at its ceiling. Without a key, gaps of 334–367ms drew a
     * 429 in every burst of concurrent calls and 400ms drew none, so NCBI counts
     * over a window somewhat wider than one second. The keyed 120ms is inferred
     * from that, not measured with a key: ten gaps span the 1,200ms that three
     * keyless 400ms gaps do, where the 100ms that 10 req/s works out to spans
     * only 1,000ms.
     */
    _config = { ...parsed, requestDelayMs: requestDelayMs ?? (parsed.apiKey ? 120 : 400) };
  }
  return _config;
}
