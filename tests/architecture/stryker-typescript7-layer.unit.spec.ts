import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();

describe('Stryker TypeScript 7 compatibility layer', () => {
  it('keeps the application compiler on TS7 and TS6 isolated to mutation tooling', () => {
    const appPackage = JSON.parse(
      fs.readFileSync(path.join(root, 'package.json'), 'utf8')
    ) as { devDependencies: Record<string, string> };
    const mutationPackage = JSON.parse(
      fs.readFileSync(path.join(root, 'tools/mutation/package.json'), 'utf8')
    ) as { devDependencies: Record<string, string> };

    expect(appPackage.devDependencies.typescript).toBe('7.0.2');
    expect(mutationPackage.devDependencies['@typescript/native']).toBe(
      'npm:typescript@7.0.2'
    );
    expect(mutationPackage.devDependencies.typescript).toBe(
      'npm:@typescript/typescript6@6.0.2'
    );
  });

  it('enables Stryker native preview without project references', () => {
    const config = fs.readFileSync(
      path.join(root, 'tools/mutation/stryker.config.mjs'),
      'utf8'
    );
    const tsconfigs = fs
      .readdirSync(root)
      .filter((file) => file.startsWith('tsconfig.stryker.'));

    expect(config).toContain('experimentalNativePreview: true');
    for (const tsconfig of tsconfigs) {
      expect(fs.readFileSync(path.join(root, tsconfig), 'utf8')).not.toContain(
        '"references"'
      );
    }
  });

  it('executes the compiler resolution and classification compatibility check', () => {
    const result = spawnSync(
      process.execPath,
      ['scripts/check-stryker-typescript-compatibility.mjs'],
      { cwd: root, encoding: 'utf8' }
    );

    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('compile-error classification');
  });
});
