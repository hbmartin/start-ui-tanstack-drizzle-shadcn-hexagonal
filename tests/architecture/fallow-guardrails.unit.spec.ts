import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

type BoundaryZone = {
  file_count: number;
  name: string;
};

type BoundaryReport = {
  boundaries: {
    configured: boolean;
    logical_groups: Array<{
      children: string[];
      name: string;
      status: string;
    }>;
    zones: BoundaryZone[];
  };
  kind: 'list-boundaries';
};

const projectRoot = process.cwd();
const fallowBin = path.join(projectRoot, 'node_modules', '.bin', 'fallow');
const tempDirectories: string[] = [];

const runFallow = (args: string[], cwd = projectRoot) =>
  spawnSync(fallowBin, args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

const writeFixture = (root: string, relativePath: string, contents: string) => {
  const target = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, contents, 'utf8');
};

const makeNegativeFixture = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fallow-guardrail-'));
  tempDirectories.push(root);

  writeFixture(
    root,
    '.fallowrc.json',
    JSON.stringify({
      boundaries: {
        coverage: { requireAllFiles: true },
        rules: [
          { allow: ['platform'], from: 'platform' },
          { allow: ['modules'], from: 'modules' },
        ],
        zones: [
          { name: 'platform', patterns: ['src/platform/**'] },
          { name: 'modules', patterns: ['src/modules/**'] },
        ],
      },
      duplicates: {
        enabled: true,
        minLines: 3,
        minOccurrences: 2,
        minTokens: 10,
        mode: 'mild',
        threshold: 0,
      },
      entry: ['src/**/*.ts'],
      health: {
        maxCognitive: 1,
        maxCyclomatic: 1,
        maxCrap: 1,
        maxUnitSize: 5,
      },
      rulePacks: ['rules.json'],
      rules: {
        'boundary-violation': 'error',
        'policy-violation': 'error',
        'type-only-dependencies': 'error',
      },
    })
  );
  writeFixture(
    root,
    'rules.json',
    JSON.stringify({
      description: 'Negative-fixture rules.',
      name: 'negative-fixture',
      rules: [
        {
          files: ['src/platform/**'],
          id: 'platform-no-node-fs',
          kind: 'banned-import',
          message: 'fixture violation',
          severity: 'error',
          specifiers: ['node:fs'],
        },
      ],
      version: 1,
    })
  );
  writeFixture(
    root,
    'src/platform/main.ts',
    `import { readFileSync } from 'node:fs';
import { DomainShape, repeatedTransform } from '../modules/domain';

export const run = (value: DomainShape) => {
  if (value.enabled) {
    if (value.name.length > 2) {
      return repeatedTransform(readFileSync(value.name, 'utf8'));
    }
  }
  return value.name;
};
`
  );
  writeFixture(
    root,
    'src/modules/domain.ts',
    `export type DomainShape = { enabled: boolean; name: string };
export const repeatedTransform = (value: string) => {
  const trimmed = value.trim();
  const lowered = trimmed.toLowerCase();
  return lowered.replaceAll(' ', '-');
};
`
  );
  writeFixture(
    root,
    'src/modules/duplicate.ts',
    `export const duplicateTransform = (value: string) => {
  const trimmed = value.trim();
  const lowered = trimmed.toLowerCase();
  return lowered.replaceAll(' ', '-');
};
`
  );

  return root;
};

const makePersistenceBoundaryFixture = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fallow-persistence-'));
  tempDirectories.push(root);
  writeFixture(
    root,
    '.fallowrc.json',
    JSON.stringify({
      boundaries: {
        coverage: { requireAllFiles: true },
        rules: [
          { allow: ['module-schema'], from: 'persistence' },
          { allow: ['persistence'], from: 'module-schema' },
          { allow: ['routes'], from: 'routes' },
          { allow: ['client-gates'], from: 'client-gates' },
        ],
        zones: [
          { name: 'persistence', patterns: ['src/modules/*/persistence.ts'] },
          {
            name: 'module-schema',
            patterns: ['src/modules/*/infrastructure/drizzle/schema.ts'],
          },
          { name: 'client-gates', patterns: ['src/modules/*/client.ts'] },
          { name: 'routes', patterns: ['src/routes/**'] },
        ],
      },
      entry: ['src/**/*.ts'],
      rules: { 'boundary-violation': 'error' },
    })
  );
  writeFixture(
    root,
    'src/modules/book/persistence.ts',
    `export { table } from './infrastructure/drizzle/schema';\n`
  );
  writeFixture(
    root,
    'src/modules/book/infrastructure/drizzle/schema.ts',
    `import { clientValue } from '../../client';\nexport const table = clientValue;\n`
  );
  writeFixture(
    root,
    'src/modules/book/client.ts',
    `export const clientValue = 'client';\n`
  );
  writeFixture(
    root,
    'src/routes/books.ts',
    `import { table } from '../modules/book/persistence';\nexport const route = table;\n`
  );
  return root;
};

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    fs.rmSync(directory, { force: true, recursive: true });
  }
});

describe('Fallow guardrails', () => {
  it('keeps every configured production zone populated', () => {
    const result = runFallow([
      'list',
      '--boundaries',
      '--format',
      'json',
      '--quiet',
      '--no-cache',
      '--no-type-aware',
    ]);

    expect(result.status).toBe(0);
    const report = JSON.parse(result.stdout) as BoundaryReport;
    expect(report.kind).toBe('list-boundaries');
    expect(report.boundaries.configured).toBe(true);
    expect(report.boundaries.zones).toHaveLength(34);
    expect(
      report.boundaries.zones
        .map(({ name }) => name)
        .filter((name) => name.startsWith('audit-'))
        .toSorted()
    ).toEqual([
      'audit-backend',
      'audit-contract',
      'audit-db-schema',
      'audit-infrastructure',
    ]);
    expect(
      report.boundaries.zones
        .filter((zone) => zone.name !== 'router')
        .every((zone) => zone.file_count > 0)
    ).toBe(true);

    const modules = report.boundaries.logical_groups.find(
      (group) => group.name === 'modules'
    );
    expect(modules).toMatchObject({ status: 'ok' });
    expect(modules?.children).toHaveLength(8);
  }, 15_000);

  it('detects boundary, provider-policy, duplication, and health regressions', () => {
    const root = makeNegativeFixture();
    const deadCode = runFallow(
      ['dead-code', '--format', 'json', '--quiet', '--no-cache'],
      root
    );
    const dupes = runFallow(
      [
        'dupes',
        '--format',
        'json',
        '--quiet',
        '--no-cache',
        '--fail-on-issues',
      ],
      root
    );
    const health = runFallow(
      [
        'health',
        '--format',
        'json',
        '--quiet',
        '--no-cache',
        '--fail-on-issues',
      ],
      root
    );

    expect(deadCode.status).toBe(1);
    expect(deadCode.stdout).toContain('boundary_violations');
    expect(deadCode.stdout).toContain('policy_violations');
    expect(deadCode.stdout).toContain('type_only_dependencies');
    expect(dupes.status).toBe(0);
    expect(JSON.parse(dupes.stdout)).toMatchObject({
      clone_groups: [expect.any(Object)],
      kind: 'dupes',
    });
    expect(health.status).toBe(1);
    expect(JSON.parse(health.stdout)).toMatchObject({ kind: 'health' });
    expect(health.stdout).toContain('max_unit_size');
  });

  it('rejects persistence imports from routes and non-persistence gates from schemas', () => {
    const fixture = makePersistenceBoundaryFixture();
    const result = runFallow(
      ['dead-code', '--format', 'json', '--quiet', '--no-cache'],
      fixture
    );
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('boundary_violations');
    expect(result.stdout).toContain('src/routes/books.ts');
    expect(result.stdout).toContain(
      'src/modules/book/infrastructure/drizzle/schema.ts'
    );
  });
});
