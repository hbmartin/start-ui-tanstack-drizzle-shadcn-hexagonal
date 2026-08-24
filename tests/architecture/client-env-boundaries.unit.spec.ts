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
});
