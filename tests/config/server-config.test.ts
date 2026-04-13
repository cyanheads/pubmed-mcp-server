/**
 * @fileoverview Tests for server configuration parsing.
 * @module tests/config/server-config.test
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

// Reset module cache between tests so _config gets cleared
async function loadModule() {
  const mod = await import('@/config/server-config.js');
  return mod.getServerConfig;
}

describe('getServerConfig', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('returns defaults when no env vars are set', async () => {
    // Delete env vars so ?? fallback applies (empty string would bypass ??)
    delete process.env.NCBI_API_KEY;
    delete process.env.NCBI_TOOL_IDENTIFIER;
    delete process.env.NCBI_ADMIN_EMAIL;
    delete process.env.NCBI_REQUEST_DELAY_MS;
    delete process.env.NCBI_MAX_RETRIES;
    delete process.env.NCBI_TIMEOUT_MS;

    const getServerConfig = await loadModule();
    const config = getServerConfig();

    expect(config.toolIdentifier).toBe('pubmed-mcp-server');
    expect(config.requestDelayMs).toBe(334);
    expect(config.maxRetries).toBe(6);
    expect(config.timeoutMs).toBe(30000);
    expect(config.apiKey).toBeUndefined();
    expect(config.adminEmail).toBeUndefined();
  });

  it('picks up env vars when set', async () => {
    vi.stubEnv('NCBI_API_KEY', 'test-key-123');
    vi.stubEnv('NCBI_TOOL_IDENTIFIER', 'my-tool');
    vi.stubEnv('NCBI_ADMIN_EMAIL', 'test@example.com');
    vi.stubEnv('NCBI_REQUEST_DELAY_MS', '200');
    vi.stubEnv('NCBI_MAX_RETRIES', '5');
    vi.stubEnv('NCBI_TIMEOUT_MS', '60000');

    const getServerConfig = await loadModule();
    const config = getServerConfig();

    expect(config.apiKey).toBe('test-key-123');
    expect(config.toolIdentifier).toBe('my-tool');
    expect(config.adminEmail).toBe('test@example.com');
    expect(config.requestDelayMs).toBe(200);
    expect(config.maxRetries).toBe(5);
    expect(config.timeoutMs).toBe(60000);
  });

  it('uses lower delay when API key is present', async () => {
    vi.stubEnv('NCBI_API_KEY', 'test-key');
    delete process.env.NCBI_TOOL_IDENTIFIER;
    delete process.env.NCBI_ADMIN_EMAIL;
    delete process.env.NCBI_REQUEST_DELAY_MS;
    delete process.env.NCBI_MAX_RETRIES;
    delete process.env.NCBI_TIMEOUT_MS;

    const getServerConfig = await loadModule();
    const config = getServerConfig();

    expect(config.requestDelayMs).toBe(100);
  });

  it('caches the config on repeated calls', async () => {
    delete process.env.NCBI_API_KEY;
    delete process.env.NCBI_TOOL_IDENTIFIER;
    delete process.env.NCBI_ADMIN_EMAIL;
    delete process.env.NCBI_REQUEST_DELAY_MS;
    delete process.env.NCBI_MAX_RETRIES;
    delete process.env.NCBI_TIMEOUT_MS;

    const getServerConfig = await loadModule();
    const first = getServerConfig();
    const second = getServerConfig();
    expect(first).toBe(second);
  });
});
