import { cloudflareTest } from '@cloudflare/vitest-plugin';
import path from 'node:path';
import { defineConfig } from 'vitest/config';

const resolve = (filePath: string) =>
  path.resolve(import.meta.dirname, filePath);

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.json' },
    }),
  ],
  resolve: {
    alias: [{ find: '@', replacement: resolve('./src') }],
  },
  test: {
    include: ['tests/cloudflare/**/*.cloudflare.{test,spec}.ts'],
  },
});
