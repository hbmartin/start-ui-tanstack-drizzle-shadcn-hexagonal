import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();

describe('client environment boundaries', () => {
  it('does not read client environment proxies at auth module scope', () => {
    const source = fs.readFileSync(
      path.join(root, 'src/modules/auth/presentation/better-auth-client.ts'),
      'utf8'
    );

    expect(source).not.toMatch(/\benvClient\s*\./u);
    expect(source).toContain('getBetterAuthBrowserClient');
  });

  it('executes client validation from the package script', () => {
    const packageJson = JSON.parse(
      fs.readFileSync(path.join(root, 'package.json'), 'utf8')
    ) as { scripts?: Record<string, string> };

    expect(packageJson.scripts?.['env:client']).toContain(
      'scripts/validate-client-config.ts'
    );
  });

  it('exposes only the shared telemetry mode policy to browser builds', () => {
    const viteConfig = fs.readFileSync(
      path.join(root, 'vite.config.ts'),
      'utf8'
    );

    expect(viteConfig).toContain(
      "envPrefix: ['VITE_', 'APP_NAME', 'APP_SLUG']"
    );
    expect(viteConfig).toContain(
      'createTelemetryModeVitePlugin(telemetryMode)'
    );
    expect(viteConfig).not.toMatch(
      /envPrefix: \[[^\n]*['"]TELEMETRY_MODE['"]/u
    );
    expect(viteConfig).not.toContain('TELEMETRY_REQUIRED_SIGNALS');
  });
});
