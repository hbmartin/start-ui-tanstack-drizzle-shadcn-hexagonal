import { cloudflareTest } from '@cloudflare/vitest-plugin';
import path from 'node:path';
import { defineConfig } from 'vitest/config';

const resolve = (filePath: string) =>
  path.resolve(import.meta.dirname, filePath);
const pgliteTestDatabaseUrlContextKey = 'pgliteTestDatabaseUrl';

export default defineConfig({
  root: import.meta.dirname,
  plugins: [
    cloudflareTest(({ inject }) => ({
      miniflare: {
        hyperdrives: {
          START_UI_DATABASE: inject(pgliteTestDatabaseUrlContextKey),
        },
        serviceBindings: {
          TELEMETRY_TAIL_COLLECTOR: 'telemetry-tail-collector',
        },
        streamingTails: ['telemetry-tail-collector'],
        workers: [
          {
            name: 'telemetry-tail-collector',
            modules: true,
            scriptPath: resolve(
              './tests/cloudflare/support/telemetry-tail-collector.mjs'
            ),
          },
        ],
      },
      wrangler: { configPath: resolve('./wrangler.json') },
    })),
  ],
  resolve: {
    alias: [{ find: '@', replacement: resolve('./src') }],
  },
  test: {
    deps: {
      optimizer: {
        ssr: {
          enabled: true,
          include: ['pg'],
          rolldownOptions: {
            external: [
              /^(?:crypto|dns|fs|net|path|stream|tls|util)(?:\/.*)?$/u,
              /^node:/u,
            ],
          },
        },
      },
    },
    globalSetup: ['./tests/server/pglite-global-setup.ts'],
    include: ['tests/cloudflare/**/*.cloudflare.{test,spec}.ts'],
  },
});
