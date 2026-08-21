import coreConfig from '@cyanheads/mcp-ts-core/vitest.config';
import { defineConfig, mergeConfig } from 'vitest/config';

export default mergeConfig(
  coreConfig,
  defineConfig({
    resolve: {
      alias: { '@/': new URL('./src/', import.meta.url).pathname },
    },
    test: {
      include: ['tests/**/*.test.ts'],
    },
  }),
);
