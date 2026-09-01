import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  type AffectedTestsResult,
  type VitestCommandRunner,
  buildVitestCommand,
  classifyChangedFiles,
  collectChangedFilesFromGit,
  computeMirrorTestPaths,
  deduplicateAndSort,
  findAffectedTests,
  formatOutput,
  groupVitestTestFiles,
  isCliEntrypoint,
  main,
  normalizePath,
  parseCliArguments,
  parseImpactClosureReport,
  parseNullDelimitedPaths,
  runVitest,
  runStrategyB,
} from '../../../scripts/affected-tests';

const tempDirectories: string[] = [];

const makeTempCwd = (files: string[]) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'affected-tests-'));
  tempDirectories.push(cwd);

  for (const file of files) {
    const absolutePath = path.join(cwd, file);
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    fs.writeFileSync(absolutePath, '', 'utf8');
  }

  return cwd;
};

const makeResult = (
  overrides: Partial<AffectedTestsResult> = {}
): AffectedTestsResult => ({
  changedFiles: [],
  consideredSourceFiles: [],
  impactAnalysisFailed: false,
  directTestFiles: [],
  excludedChangedFiles: [],
  runAll: false,
  strategyAFiles: [],
  strategyBFiles: [],
  testFiles: [],
  warnings: [],
  ...overrides,
});

const runGitForLocalChangeFixture = (args: string[]) => {
  const command = args.join(' ');
  switch (command) {
    case 'diff --name-only --diff-filter=ACMRTD -z':
      return 'src/a.ts\0';
    case 'diff --cached --name-only --diff-filter=ACMRTD -z':
      return 'src/b.ts\0src/a.ts\0';
    case 'ls-files --others --exclude-standard -z':
      return 'tests/unit/a.unit.spec.ts\0';
    default:
      throw new Error(command);
  }
};

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    fs.rmSync(directory, { force: true, recursive: true });
  }
  vi.restoreAllMocks();
});

describe('affected test CLI argument parsing', () => {
  it('parses supported flags and tolerates a standalone separator', () => {
    expect(
      parseCliArguments(['--', '--base', 'origin/main', '--run', '--verbose'])
    ).toEqual({
      ok: true,
      options: {
        base: 'origin/main',
        help: false,
        json: false,
        run: true,
        summary: false,
        verbose: true,
      },
    });
  });

  it('rejects invalid flag combinations and missing values', () => {
    expect(parseCliArguments(['--wat'])).toEqual({
      error: 'Unknown option: --wat',
      ok: false,
    });
    expect(parseCliArguments(['--base'])).toEqual({
      error: 'Missing value for --base.',
      ok: false,
    });
    expect(parseCliArguments(['--json', '--summary'])).toEqual({
      error: 'Use either --json or --summary, not both.',
      ok: false,
    });
  });
});

describe('changed file discovery helpers', () => {
  it('normalizes null-delimited git output', () => {
    expect(
      parseNullDelimitedPaths(
        './src\\modules\\book\\domain\\book.ts\0src/modules/book/domain/book.ts\0\0README.md\0'
      )
    ).toEqual(['README.md', 'src/modules/book/domain/book.ts']);
  });

  it('uses the triple-dot base diff when a base is provided', () => {
    const calls: Array<{ args: string[]; description: string }> = [];
    const files = collectChangedFilesFromGit({
      base: 'origin/main',
      runGit: (args, description) => {
        calls.push({ args, description });
        return 'src/router.tsx\0';
      },
    });

    expect(files).toEqual(['src/router.tsx']);
    expect(calls).toEqual([
      {
        args: [
          'diff',
          'origin/main...HEAD',
          '--name-only',
          '--diff-filter=ACMRTD',
          '-z',
        ],
        description: 'git diff origin/main...HEAD',
      },
    ]);
  });

  it('combines unstaged, staged, and untracked local changes', () => {
    const files = collectChangedFilesFromGit({
      runGit: runGitForLocalChangeFixture,
    });

    expect(files).toEqual([
      'src/a.ts',
      'src/b.ts',
      'tests/unit/a.unit.spec.ts',
    ]);
  });
});

describe('changed file classification', () => {
  it('separates source, direct tests, test support, global config, and exclusions', () => {
    expect(
      classifyChangedFiles([
        'vitest.config.ts',
        'src/modules/book/domain/book.ts',
        'scripts/affected-tests.ts',
        'tests/unit/modules/book/domain/book.unit.spec.ts',
        'tests/browser/platform/components/form/form.browser.spec.tsx',
        'tests/integration/modules/book/infrastructure/__tests__/book-repository-drizzle.postgres.integration.test.ts',
        'tests/e2e/login.spec.ts',
        'tests/server/test-utils.ts',
        'README.md',
      ])
    ).toEqual({
      directTestFiles: [
        'tests/browser/platform/components/form/form.browser.spec.tsx',
        'tests/unit/modules/book/domain/book.unit.spec.ts',
      ],
      excludedFiles: [
        'README.md',
        'tests/e2e/login.spec.ts',
        'tests/integration/modules/book/infrastructure/__tests__/book-repository-drizzle.postgres.integration.test.ts',
      ],
      globalConfigChanged: true,
      globalConfigFiles: ['vitest.config.ts'],
      sourceFiles: [
        'scripts/affected-tests.ts',
        'src/modules/book/domain/book.ts',
      ],
      testSupportFiles: ['tests/server/test-utils.ts'],
    });
  });
});

describe('global config fallback', () => {
  it('runs all runnable Vitest tests without impact discovery', async () => {
    const impactClosure = vi.fn(async () => {
      throw new Error('should not run');
    });

    const result = await findAffectedTests({
      allTestFiles: [
        'tests/unit/a.unit.spec.ts',
        'tests/browser/a.browser.spec.tsx',
      ],
      changedFiles: ['vitest.config.ts'],
      impactClosure,
    });

    expect(result.runAll).toBe(true);
    expect(result.runAllReason).toBe('global config file changed');
    expect(result.testFiles).toEqual([
      'tests/unit/a.unit.spec.ts',
      'tests/browser/a.browser.spec.tsx',
    ]);
    expect(impactClosure).not.toHaveBeenCalled();
  });
});

describe('mirror path strategy', () => {
  it('computes repo-specific unit, browser, and integration candidates', () => {
    const paths = computeMirrorTestPaths([
      'scripts/affected-tests.ts',
      'src/modules/book/domain/book.ts',
      'src/router.tsx',
      'src/routes/(auth)/actions.ts',
    ]);

    expect(paths).toContain('tests/unit/scripts/affected-tests.unit.spec.ts');
    expect(paths).toContain('tests/unit/__tests__/router.unit.spec.ts');
    expect(paths).toContain(
      'tests/unit/modules/book/domain/__tests__/book.unit.spec.ts'
    );
    expect(paths).toContain(
      'tests/browser/modules/book/domain/book.browser.spec.tsx'
    );
    expect(paths).toContain(
      'tests/integration/modules/book/domain/book.integration.test.ts'
    );
    expect(paths).toContain(
      'tests/integration/modules/book/domain/book.integration.spec.ts'
    );
    expect(paths).toContain('tests/unit/routes/(auth)/actions.unit.spec.ts');
    expect(paths).toContain('tests/unit/routes/auth/actions.unit.spec.ts');
    expect(paths.some((candidate) => candidate.includes('/./'))).toBe(false);
  });

  it('keeps only mirror candidates that exist', () => {
    const cwd = makeTempCwd(['tests/unit/scripts/affected-tests.unit.spec.ts']);

    expect(runStrategyB(['scripts/affected-tests.ts'], cwd)).toEqual([
      'tests/unit/scripts/affected-tests.unit.spec.ts',
    ]);
  });
});

describe('Fallow impact-closure strategy', () => {
  it('rejects malformed and partial impact reports', () => {
    expect(() => parseImpactClosureReport('not-json')).toThrow('invalid JSON');
    expect(() =>
      parseImpactClosureReport(JSON.stringify({ kind: 'trace', seed: 'x' }))
    ).toThrow('unexpected report shape');
  });

  it('combines direct, impact, and mirror tests with excluded change details', async () => {
    const cwd = makeTempCwd([
      'src/modules/foo/foo.ts',
      'tests/unit/modules/foo/foo.unit.spec.ts',
      'tests/unit/modules/foo/foo-graph.unit.spec.ts',
      'tests/security/server-functions.unit.spec.ts',
    ]);
    const result = await findAffectedTests({
      changedFiles: [
        'src/modules/foo/foo.ts',
        'tests/security/server-functions.unit.spec.ts',
        'README.md',
      ],
      cwd,
      impactClosure: async () => [
        'src/modules/foo/index.ts',
        'tests/unit/modules/foo/foo-graph.unit.spec.ts',
      ],
    });

    expect(result.directTestFiles).toEqual([
      'tests/security/server-functions.unit.spec.ts',
    ]);
    expect(result.strategyAFiles).toEqual([
      'tests/unit/modules/foo/foo-graph.unit.spec.ts',
    ]);
    expect(result.strategyBFiles).toEqual([
      'tests/unit/modules/foo/foo.unit.spec.ts',
    ]);
    expect(result.excludedChangedFiles).toEqual(['README.md']);
    expect(result.testFiles).toEqual([
      'tests/security/server-functions.unit.spec.ts',
      'tests/unit/modules/foo/foo-graph.unit.spec.ts',
      'tests/unit/modules/foo/foo.unit.spec.ts',
    ]);
  });

  it('runs all tests when Fallow impact analysis fails', async () => {
    const cwd = makeTempCwd([
      'tests/browser/components/form.browser.spec.tsx',
      'tests/server/test-utils.ts',
      'tests/unit/a.unit.spec.ts',
    ]);

    const result = await findAffectedTests({
      changedFiles: ['tests/server/test-utils.ts'],
      cwd,
      impactClosure: async () => {
        throw new Error('Fallow failed');
      },
    });

    expect(result.impactAnalysisFailed).toBe(true);
    expect(result.runAll).toBe(true);
    expect(result.runAllReason).toBe('Fallow impact analysis failed');
    expect(result.testFiles).toEqual([
      'tests/browser/components/form.browser.spec.tsx',
      'tests/unit/a.unit.spec.ts',
    ]);
    expect(result.warnings).toEqual([
      'Warning: Fallow impact analysis failed; running the complete Vitest suite',
    ]);
  });

  it('fails closed when a changed source was deleted', async () => {
    const cwd = makeTempCwd(['tests/unit/a.unit.spec.ts']);

    const result = await findAffectedTests({
      changedFiles: ['src/deleted.ts'],
      cwd,
      impactClosure: vi.fn(async () => []),
    });

    expect(result.runAll).toBe(true);
    expect(result.impactAnalysisFailed).toBe(true);
    expect(result.testFiles).toEqual(['tests/unit/a.unit.spec.ts']);
  });

  it('fails closed when analysis finds no tests for changed source', async () => {
    const cwd = makeTempCwd([
      'src/a.ts',
      'tests/browser/other.browser.spec.tsx',
    ]);

    const result = await findAffectedTests({
      changedFiles: ['src/a.ts'],
      cwd,
      impactClosure: async () => ['src/b.ts'],
    });

    expect(result.runAll).toBe(true);
    expect(result.runAllReason).toBe(
      'no tests were discovered for changed source files'
    );
    expect(result.testFiles).toEqual(['tests/browser/other.browser.spec.tsx']);
  });
});

describe('output formatting', () => {
  const result = makeResult({
    changedFiles: ['src/a.ts'],
    directTestFiles: ['tests/unit/a.unit.spec.ts'],
    excludedChangedFiles: ['README.md'],
    strategyAFiles: ['tests/unit/a-graph.unit.spec.ts'],
    strategyBFiles: ['tests/unit/a.unit.spec.ts'],
    testFiles: ['tests/unit/a-graph.unit.spec.ts', 'tests/unit/a.unit.spec.ts'],
  });

  it('prints plain path output by default', () => {
    expect(
      formatOutput(result, { json: false, summary: false, verbose: false })
    ).toBe('tests/unit/a-graph.unit.spec.ts\ntests/unit/a.unit.spec.ts');
  });

  it('prints verbose discovery sections', () => {
    expect(
      formatOutput(result, { json: false, summary: false, verbose: true })
    ).toContain('# Strategy A - Fallow impact closure (1):');
  });

  it('prints summary output', () => {
    expect(
      formatOutput(result, { json: false, summary: true, verbose: false })
    ).toContain('Total affected tests: 2');
  });

  it('prints JSON output', () => {
    expect(
      JSON.parse(
        formatOutput(result, { json: true, summary: false, verbose: false })
      )
    ).toMatchObject({
      testFiles: [
        'tests/unit/a-graph.unit.spec.ts',
        'tests/unit/a.unit.spec.ts',
      ],
    });
  });
});

describe('Vitest runner command', () => {
  it('builds a project-scoped pnpm Vitest command', () => {
    expect(buildVitestCommand(['tests/unit/a.unit.spec.ts'])).toEqual({
      args: [
        'exec',
        'vitest',
        'run',
        '--project=unit',
        '--passWithNoTests',
        'tests/unit/a.unit.spec.ts',
      ],
      command: 'pnpm',
      project: 'unit',
    });
  });

  it('groups affected tests into deterministic sequential projects', () => {
    expect(
      groupVitestTestFiles([
        'tests/integration/z.integration.test.ts',
        'tests/unit/b.unit.spec.ts',
        'tests/browser/a.browser.spec.tsx',
        'tests/security/a.unit.spec.ts',
      ])
    ).toEqual([
      {
        files: ['tests/security/a.unit.spec.ts', 'tests/unit/b.unit.spec.ts'],
        project: 'unit',
      },
      {
        files: ['tests/browser/a.browser.spec.tsx'],
        project: 'browser',
      },
      {
        files: ['tests/integration/z.integration.test.ts'],
        project: 'integration',
      },
    ]);
  });

  it('stops sequential project execution on the first child failure', async () => {
    const runCommand = vi
      .fn()
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(7)
      .mockResolvedValueOnce(0);

    const code = await runVitest(
      [
        'tests/unit/a.unit.spec.ts',
        'tests/browser/a.browser.spec.tsx',
        'tests/integration/a.integration.test.ts',
      ],
      false,
      runCommand
    );

    expect(code).toBe(7);
    expect(runCommand).toHaveBeenCalledTimes(2);
    expect(runCommand.mock.calls[1]?.[0]).toMatchObject({ project: 'browser' });
  });

  it('uses project discovery instead of a huge explicit path list for run-all fallbacks', async () => {
    const runCommand = vi.fn<VitestCommandRunner>(async () => 0);

    const code = await runVitest(
      [
        'tests/unit/a.unit.spec.ts',
        'tests/browser/a.browser.spec.tsx',
        'tests/integration/a.integration.test.ts',
      ],
      true,
      runCommand
    );

    expect(code).toBe(0);
    expect(runCommand).toHaveBeenCalledTimes(3);
    for (const [command] of runCommand.mock.calls) {
      expect(command.args).not.toContain('tests/unit/a.unit.spec.ts');
      expect(command.args).not.toContain('tests/browser/a.browser.spec.tsx');
      expect(command.args).not.toContain(
        'tests/integration/a.integration.test.ts'
      );
    }
  });

  it('does not spawn Vitest when the CLI run finds no affected tests', async () => {
    const stderr: string[] = [];
    const runVitest = vi.fn(async () => 1);
    const code = await main(['--run'], {
      findAffectedTests: async () => makeResult(),
      runVitest,
      stderr: (message) => stderr.push(message),
      stdout: vi.fn(),
    });

    expect(code).toBe(0);
    expect(stderr.join('')).toContain('No affected test files found.');
    expect(runVitest).not.toHaveBeenCalled();
  });

  it('returns Vitest exit codes from the CLI run path', async () => {
    const runVitest = vi.fn(async () => 7);
    const findAffectedTests = vi.fn(async () =>
      makeResult({ testFiles: ['tests/unit/a.unit.spec.ts'] })
    );
    const stdout: string[] = [];

    const code = await main(['--run', '--base', 'origin/main'], {
      findAffectedTests,
      runVitest,
      stderr: vi.fn(),
      stdout: (message) => stdout.push(message),
    });

    expect(code).toBe(7);
    expect(findAffectedTests).toHaveBeenCalledWith({ base: 'origin/main' });
    expect(runVitest).toHaveBeenCalledWith(
      ['tests/unit/a.unit.spec.ts'],
      false
    );
    expect(stdout.join('')).toContain('tests/unit/a.unit.spec.ts');
  });
});

describe('sorting helpers', () => {
  it('normalizes, deduplicates, and sorts paths', () => {
    expect(deduplicateAndSort(['./b.ts', 'a.ts', 'b.ts', ''])).toEqual([
      'a.ts',
      'b.ts',
    ]);
    expect(normalizePath('./tests/unit/./__tests__/router.unit.spec.ts')).toBe(
      'tests/unit/__tests__/router.unit.spec.ts'
    );
  });
});

describe('CLI entrypoint detection', () => {
  it('compares Windows entrypoint paths case-insensitively', () => {
    expect(
      isCliEntrypoint(
        String.raw`c:\repo\scripts\affected-tests.ts`,
        String.raw`C:\repo\scripts\affected-tests.ts`,
        'win32'
      )
    ).toBe(true);
  });

  it('keeps non-Windows entrypoint checks case-sensitive', () => {
    expect(isCliEntrypoint('/repo/script.ts', '/repo/script.ts', 'linux')).toBe(
      true
    );
    expect(isCliEntrypoint('/repo/script.ts', '/Repo/script.ts', 'linux')).toBe(
      false
    );
  });
});
