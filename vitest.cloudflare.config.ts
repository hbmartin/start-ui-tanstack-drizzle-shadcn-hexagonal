import { cloudflareTest } from '@cloudflare/vitest-plugin';
import path from 'node:path';
import { defineConfig } from 'vitest/config';

const resolve = (filePath: string) =>
  path.resolve(import.meta.dirname, filePath);
const pgliteTestDatabaseUrlContextKey = 'pgliteTestDatabaseUrl';
const hyperdriveLocalConnectionEnvironmentKey =
  'CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_START_UI_DATABASE';

export default defineConfig({
  root: import.meta.dirname,
  plugins: [
    cloudflareTest(({ inject }) => {
      const databaseUrl = inject(pgliteTestDatabaseUrlContextKey);
      // Wrangler resolves source-declared Hyperdrive bindings before applying
      // Miniflare overrides. Feed the isolated PGlite URL through Wrangler's
      // documented local-development variable as well as the explicit test
      // binding so no developer or repository environment can leak in.
      process.env[hyperdriveLocalConnectionEnvironmentKey] = databaseUrl;
      return {
        miniflare: {
          hyperdrives: {
            START_UI_DATABASE: databaseUrl,
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
      };
    }),
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
