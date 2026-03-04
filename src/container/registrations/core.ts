/**
 * @fileoverview Registers core application services with the DI container.
 * This module encapsulates the registration of fundamental services such as
 * configuration, logging, storage, and the NCBI service.
 * @module src/container/registrations/core
 */
import { createClient } from '@supabase/supabase-js';

import { config as parsedConfig } from '@/config/index.js';
import { container } from '@/container/core/container.js';
import {
  AppConfig,
  Logger,
  NcbiServiceToken,
  RateLimiterService,
  StorageProvider,
  StorageService,
  SupabaseAdminClient,
} from '@/container/core/tokens.js';
import { NcbiApiClient } from '@/services/ncbi/core/api-client.js';
import { NcbiService } from '@/services/ncbi/core/ncbi-service.js';
import { NcbiRequestQueue } from '@/services/ncbi/core/request-queue.js';
import { NcbiResponseHandler } from '@/services/ncbi/core/response-handler.js';
import { StorageService as StorageServiceClass } from '@/storage/core/StorageService.js';
import { createStorageProvider, type StorageFactoryDeps } from '@/storage/core/storageFactory.js';
import type { Database } from '@/storage/providers/supabase/supabase.types.js';
import { JsonRpcErrorCode, McpError } from '@/types-global/errors.js';
import { logger } from '@/utils/internal/logger.js';
import { RateLimiter } from '@/utils/security/rateLimiter.js';

/**
 * Registers core application services and values with the container.
 */
export const registerCoreServices = () => {
  container.registerValue(AppConfig, parsedConfig);
  container.registerValue(Logger, logger);

  // Supabase client — lazy singleton, resolved on first use
  container.registerSingleton(SupabaseAdminClient, (c) => {
    const cfg = c.resolve(AppConfig);
    if (!cfg.supabase?.url || !cfg.supabase?.serviceRoleKey) {
      throw new McpError(
        JsonRpcErrorCode.ConfigurationError,
        'Supabase URL or service role key is missing for admin client.',
      );
    }
    return createClient<Database>(cfg.supabase.url, cfg.supabase.serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  });

  // Storage provider — resolve DB clients here so storageFactory stays DI-agnostic
  container.registerSingleton(StorageProvider, (c) => {
    const cfg = c.resolve(AppConfig);
    const pt = cfg.storage.providerType;
    const deps: StorageFactoryDeps = {
      ...(pt === 'supabase' && {
        supabaseClient: c.resolve(SupabaseAdminClient),
      }),
    };
    return createStorageProvider(cfg, deps);
  });

  // StorageService — singleton, receives provider via container
  container.registerSingleton(
    StorageService,
    (c) => new StorageServiceClass(c.resolve(StorageProvider)),
  );

  // RateLimiter — registered before services that depend on it
  container.registerSingleton(
    RateLimiterService,
    (c) => new RateLimiter(c.resolve(AppConfig), c.resolve(Logger)),
  );

  // NcbiService — composes API client, request queue, and response handler
  container.registerSingleton(NcbiServiceToken, (c) => {
    const cfg = c.resolve(AppConfig);
    const responseHandler = new NcbiResponseHandler();
    const apiClient = new NcbiApiClient({
      ...(cfg.ncbiApiKey !== undefined && { apiKey: cfg.ncbiApiKey }),
      toolIdentifier: cfg.ncbiToolIdentifier,
      ...(cfg.ncbiAdminEmail !== undefined && { adminEmail: cfg.ncbiAdminEmail }),
      maxRetries: cfg.ncbiMaxRetries,
      timeoutMs: cfg.ncbiTimeoutMs,
    });
    const queue = new NcbiRequestQueue(cfg.ncbiRequestDelayMs);
    return new NcbiService(apiClient, queue, responseHandler);
  });

  logger.info('Core services registered with the DI container.');
};
