import coreConfig from '@cyanheads/mcp-ts-core/vitest.config';
import { defineConfig, mergeConfig } from 'vitest/config';

export default mergeConfig(
  coreConfig,
  defineConfig({
    resolve: {
      alias: { '@/': new URL('./src/', import.meta.url).pathname },
    },
    test: {
      // Vitest's fork pool calls `channel.unref()` on each worker's IPC channel, which Bun lacks; Node keeps forks.
      ...(process.versions.bun && { pool: 'threads' as const }),
      include: ['tests/**/*.test.ts'],
    },
  }),
);
