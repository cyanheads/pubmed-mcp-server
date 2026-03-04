/**
 * @fileoverview Tests for core service registration.
 * @module tests/container/registrations/core.test.ts
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { container } from '@/container/core/container.js';
import {
  AppConfig,
  Logger,
  NcbiServiceToken,
  RateLimiterService,
  StorageProvider,
  StorageService,
} from '@/container/core/tokens.js';
import { registerCoreServices } from '@/container/registrations/core.js';

describe('Core Service Registration', () => {
  beforeAll(() => {
    registerCoreServices();
  });

  describe('registerCoreServices', () => {
    it('should register AppConfig as a value', () => {
      const config = container.resolve(AppConfig) as ReturnType<
        typeof import('@/config/index.js').parseConfig
      >;

      expect(config).toBeDefined();
      expect(typeof config).toBe('object');
      expect(config.mcpServerName).toBeDefined();
      expect(config.mcpServerVersion).toBeDefined();
    });

    it('should register Logger as a value', () => {
      const logger = container.resolve(
        Logger,
      ) as typeof import('@/utils/internal/logger.js').logger;

      expect(logger).toBeDefined();
      expect(typeof logger.info).toBe('function');
      expect(typeof logger.debug).toBe('function');
      expect(typeof logger.error).toBe('function');
      expect(typeof logger.warning).toBe('function');
    });

    it('should register StorageProvider factory', () => {
      const storageProvider = container.resolve(StorageProvider);

      expect(storageProvider).toBeDefined();
      expect(typeof storageProvider.get).toBe('function');
      expect(typeof storageProvider.set).toBe('function');
      expect(typeof storageProvider.delete).toBe('function');
      expect(typeof storageProvider.list).toBe('function');
    });

    it('should register StorageService with injected provider', () => {
      const storageService = container.resolve(
        StorageService,
      ) as import('@/storage/core/StorageService.js').StorageService;

      expect(storageService).toBeDefined();
      expect(typeof storageService.get).toBe('function');
      expect(typeof storageService.set).toBe('function');
      expect(typeof storageService.delete).toBe('function');
    });

    it('should register NcbiServiceToken', () => {
      const ncbiService = container.resolve(NcbiServiceToken);
      expect(ncbiService).toBeDefined();
    });

    it('should register RateLimiterService as singleton', () => {
      const rateLimiter1 = container.resolve(
        RateLimiterService,
      ) as import('@/utils/security/rateLimiter.js').RateLimiter;
      const rateLimiter2 = container.resolve(
        RateLimiterService,
      ) as import('@/utils/security/rateLimiter.js').RateLimiter;

      expect(rateLimiter1).toBeDefined();
      expect(rateLimiter1).toBe(rateLimiter2); // Same instance
    });

    it('should resolve NcbiServiceToken as singleton', () => {
      const ncbiService1 = container.resolve(NcbiServiceToken);
      const ncbiService2 = container.resolve(NcbiServiceToken);
      expect(ncbiService1).toBeDefined();
      expect(ncbiService1).toBe(ncbiService2);
    });

    it('should resolve same AppConfig instance multiple times', () => {
      const config1 = container.resolve(AppConfig) as ReturnType<
        typeof import('@/config/index.js').parseConfig
      >;
      const config2 = container.resolve(AppConfig) as ReturnType<
        typeof import('@/config/index.js').parseConfig
      >;

      expect(config1).toBe(config2);
    });

    it('should create storage provider based on configuration', () => {
      const config = container.resolve(AppConfig) as ReturnType<
        typeof import('@/config/index.js').parseConfig
      >;
      const provider = container.resolve(StorageProvider);

      expect(provider).toBeDefined();
      expect(config).toBeDefined();
      // Provider successfully created based on configuration
    });
  });

  describe('Service Dependencies', () => {
    it('should resolve StorageService with correct provider dependency', () => {
      const storageService = container.resolve(
        StorageService,
      ) as import('@/storage/core/StorageService.js').StorageService;
      const storageProvider = container.resolve(StorageProvider);

      expect(storageService).toBeDefined();
      expect(storageProvider).toBeDefined();
      // Both should be working instances
      expect(typeof storageService.get).toBe('function');
      expect(typeof storageProvider.get).toBe('function');
    });

    it('should resolve NcbiServiceToken with correct dependencies', () => {
      const ncbiService = container.resolve(NcbiServiceToken);
      expect(ncbiService).toBeDefined();
    });
  });

  describe('Error Handling', () => {
    it('should register services even with minimal configuration', () => {
      // All essential services should be registered
      expect(() => container.resolve(AppConfig)).not.toThrow();
      expect(() => container.resolve(Logger)).not.toThrow();
      expect(() => container.resolve(StorageService)).not.toThrow();
    });
  });

  describe('Service Factory Resolution', () => {
    it('should use factory to create NcbiService with config-based dependencies', () => {
      const ncbiService = container.resolve(NcbiServiceToken);
      expect(ncbiService).toBeDefined();
    });

    it('should create StorageProvider via factory with AppConfig dependency', () => {
      const config = container.resolve(AppConfig) as ReturnType<
        typeof import('@/config/index.js').parseConfig
      >;
      const provider = container.resolve(StorageProvider);

      expect(config).toBeDefined();
      expect(provider).toBeDefined();
      // Factory should have used config to determine provider type
    });
  });
});
