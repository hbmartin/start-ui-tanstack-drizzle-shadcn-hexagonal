import { cloudflareTest } from '@cloudflare/vitest-plugin';
import path from 'node:path';
import { defineConfig } from 'vitest/config';

const resolve = (filePath: string) =>
  path.resolve(import.meta.dirname, filePath);

export default defineConfig({
  plugins: [
    cloudflareTest({
      miniflare: {
        serviceBindings: {
          TELEMETRY_TAIL_COLLECTOR: 'telemetry-tail-collector',
        },
        streamingTails: ['telemetry-tail-collector'],
        workers: [
          {
            name: 'telemetry-tail-collector',
            modules: true,
            scriptPath:
              './tests/cloudflare/support/telemetry-tail-collector.mjs',
          },
        ],
      },
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
