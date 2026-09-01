import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const compatibilityDecision = 'docs/stryker-typescript7-compatibility.md';

describe('Stryker TypeScript 7 compatibility layer', () => {
  it('keeps the TS6 wrapper isolated while its runtime resolution is checked separately', () => {
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
    expect(mutationPackage.devDependencies['@stryker-mutator/core']).toBe(
      '10.0.0'
    );
    expect(
      mutationPackage.devDependencies['@stryker-mutator/typescript-checker']
    ).toBe('10.0.0');
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
    expect(result.stdout).toContain('root TS7.0.2');
    expect(result.stdout).toContain('isolated preprocessing TS6.0.3');
    expect(result.stdout).toContain('native TS7.0.2');
    expect(result.stdout).toContain('compile-error classification');
  });

  it('keeps the experimental limitations and release-based exit criteria explicit', () => {
    const decision = fs.readFileSync(
      path.join(root, compatibilityDecision),
      'utf8'
    );

    for (const issue of ['6110', '6111', '6112', '6113']) {
      expect(decision).toContain(
        `https://github.com/stryker-mutator/stryker-js/issues/${issue}`
      );
    }
    expect(decision).toContain(
      'https://github.com/stryker-mutator/stryker-js/pull/6099'
    );
    expect(decision).toContain('npm:@typescript/typescript6@6.0.2');
    expect(decision).toContain('TypeScript 6.0.3');
    expect(decision).toContain('experimentalNativePreview');
    expect(decision).toContain('project references');
    expect(decision).toContain('mutant grouping');
    expect(decision.match(/released Stryker version/gu)).toHaveLength(3);
  });

  it('runs compatibility before scheduled, manual, and tag mutation ratchets', () => {
    const workflow = fs.readFileSync(
      path.join(root, '.github/workflows/mutation-testing.yml'),
      'utf8'
    );

    expect(workflow).toContain("tags:\n      - 'v*'");
    expect(workflow).toContain('schedule:');
    expect(workflow).toContain('workflow_dispatch:');
    expect(workflow).not.toContain('pull_request:');
    expect(workflow.indexOf('run: pnpm mutation:compat')).toBeGreaterThan(-1);
    expect(workflow.indexOf('run: pnpm mutation:compat')).toBeLessThan(
      workflow.indexOf('run: node scripts/run-mutation.mjs')
    );
  });
});
