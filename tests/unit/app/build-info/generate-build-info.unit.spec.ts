import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  createBuildInfo,
  isBuildInfoEntryPoint,
  readBuildCommit,
  readGitMetadata,
  resolveGitExecutable,
  sourceDateFromEpoch,
} from '@/app/build-info/infrastructure/generate-build-info';

const gitMetadata = {
  commit: '0123456789abcdef0123456789abcdef01234567',
  date: '2026-08-27T07:18:45-07:00',
  display: '01234567',
};

const isolatedChildEnvironment = (
  overrides: Readonly<Record<string, string>> = {}
) => {
  const environment: Record<string, string | undefined> = {
    ...process.env,
    GIT_CONFIG_GLOBAL: os.devNull,
    GIT_CONFIG_SYSTEM: os.devNull,
  };
  for (const key of [
    'CF_PAGES_COMMIT_SHA',
    'GITHUB_SHA',
    'GIT_DIR',
    'GIT_INDEX_FILE',
    'GIT_WORK_TREE',
    'VERCEL_GIT_COMMIT_SHA',
  ]) {
    delete environment[key];
  }
  return { ...environment, ...overrides };
};

describe('build info generation', () => {
  it('resolves Git only from explicit platform locations', () => {
    expect(
      resolveGitExecutable('linux', (candidate) =>
        candidate.endsWith('/usr/local/bin/git')
      )
    ).toBe('/usr/local/bin/git');
    expect(
      resolveGitExecutable('win32', (candidate) =>
        candidate.startsWith('C:\\Program Files (x86)')
      )
    ).toBe('C:\\Program Files (x86)\\Git\\cmd\\git.exe');
    expect(resolveGitExecutable('darwin', () => false)).toBeUndefined();
  });

  it('uses SOURCE_DATE_EPOCH as the reproducible date when supplied', () => {
    expect(
      createBuildInfo({ gitMetadata, sourceDateEpoch: '1700000000' })
    ).toEqual({
      commit: gitMetadata.commit,
      date: '2023-11-14T22:13:20.000Z',
      display: gitMetadata.display,
      version: `${gitMetadata.display} - 2023-11-14T22:13:20.000Z`,
    });
  });

  it('uses metadata pinned to the resolved Git commit', () => {
    expect(createBuildInfo({ gitMetadata })).toEqual({
      commit: gitMetadata.commit,
      date: gitMetadata.date,
      display: gitMetadata.display,
      version: `${gitMetadata.display} - ${gitMetadata.date}`,
    });
  });

  it('reads the date and display hash from one resolved Git commit', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'start-ui-build-info-'));
    try {
      const runGit = (arguments_: string[], overrides = {}) =>
        execFileSync('git', arguments_, {
          cwd: root,
          env: isolatedChildEnvironment(overrides),
        });
      runGit(['init', '--quiet']);
      runGit(['config', 'user.email', 'test@example.invalid']);
      runGit(['config', 'user.name', 'Build Info Test']);
      fs.writeFileSync(path.join(root, 'fixture.txt'), 'fixture');
      runGit(['add', 'fixture.txt']);
      runGit(['commit', '--quiet', '-m', 'fixture'], {
        GIT_AUTHOR_DATE: '2024-01-02T03:04:05Z',
        GIT_COMMITTER_DATE: '2024-01-02T03:04:05Z',
      });
      const commit = runGit(['rev-parse', 'HEAD']).toString().trim();

      expect(readGitMetadata(root)).toEqual({
        commit,
        date: '2024-01-02T03:04:05Z',
        display: commit.slice(0, 8),
      });
    } finally {
      fs.rmSync(root, { force: true, recursive: true });
    }
  });

  it('uses deterministic sentinels without Git or SOURCE_DATE_EPOCH', () => {
    expect(createBuildInfo({ gitMetadata: null })).toEqual({
      commit: 'unavailable',
      date: 'unavailable',
      display: 'unavailable',
      version: 'unavailable - unavailable',
    });
  });

  it('uses a validated provider commit when Git metadata is unavailable', () => {
    expect(
      createBuildInfo({
        fallbackCommit: 'abcdef0123456789',
        gitMetadata: null,
        sourceDateEpoch: '1700000000',
      })
    ).toEqual({
      commit: 'abcdef0123456789',
      date: '2023-11-14T22:13:20.000Z',
      display: 'abcdef01',
      version: 'abcdef01 - 2023-11-14T22:13:20.000Z',
    });
    expect(
      readBuildCommit({
        CF_PAGES_COMMIT_SHA: 'not-a-commit',
        GITHUB_SHA: 'abcdef0123456789',
      })
    ).toBe('abcdef0123456789');
  });

  it('reports missing Git metadata without using the wall clock', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'start-ui-no-git-'));
    try {
      expect(readGitMetadata(root)).toBeNull();
    } finally {
      fs.rmSync(root, { force: true, recursive: true });
    }
  });

  it.each(['-1', '1.5', 'nope', '1_700_000_000'])(
    'rejects invalid SOURCE_DATE_EPOCH %s',
    (sourceDateEpoch) => {
      expect(() => sourceDateFromEpoch(sourceDateEpoch)).toThrow(
        'SOURCE_DATE_EPOCH must be whole Unix seconds'
      );
    }
  );

  it('rejects safe-integer seconds outside the JavaScript Date range', () => {
    expect(() => sourceDateFromEpoch(String(Number.MAX_SAFE_INTEGER))).toThrow(
      'SOURCE_DATE_EPOCH must be within the JavaScript Date range'
    );
  });

  it('recognizes only the requested run-jiti module as its entry point', () => {
    const moduleUrl = 'file:///repo/src/generate-build-info.ts';

    expect(
      isBuildInfoEntryPoint(
        ['node', '/repo/run-jiti', './src/generate-build-info.ts'],
        '/repo',
        moduleUrl
      )
    ).toBe(true);
    expect(
      isBuildInfoEntryPoint(
        ['node', '/repo/run-jiti', './scripts/consumer.ts'],
        '/repo',
        moduleUrl
      )
    ).toBe(false);
  });

  it('does not generate build info when another run-jiti script imports it', () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), 'start-ui-jiti-import-')
    );
    const repositoryRoot = process.cwd();
    const output = path.join(
      root,
      'src/app/build-info/presentation/build-info.gen.json'
    );
    const consumer = path.join(root, 'consumer.ts');
    try {
      fs.mkdirSync(path.dirname(output), { recursive: true });
      fs.writeFileSync(output, 'sentinel');
      fs.writeFileSync(
        consumer,
        `import ${JSON.stringify(
          pathToFileURL(
            path.join(
              repositoryRoot,
              'src/app/build-info/infrastructure/generate-build-info.ts'
            )
          ).href
        )};\n`
      );

      execFileSync(
        process.execPath,
        [path.join(repositoryRoot, 'run-jiti'), consumer],
        { cwd: root, env: isolatedChildEnvironment(), stdio: 'pipe' }
      );

      expect(fs.readFileSync(output, 'utf8')).toBe('sentinel');
    } finally {
      fs.rmSync(root, { force: true, recursive: true });
    }
  });

  it('generates through run-jiti from another working directory', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'start-ui-jiti-entry-'));
    const repositoryRoot = process.cwd();
    const output = path.join(
      root,
      'src/app/build-info/presentation/build-info.gen.json'
    );
    try {
      fs.mkdirSync(path.dirname(output), { recursive: true });
      fs.writeFileSync(output, 'sentinel');

      execFileSync(
        process.execPath,
        [
          path.join(repositoryRoot, 'run-jiti'),
          './src/app/build-info/infrastructure/generate-build-info.ts',
        ],
        {
          cwd: root,
          env: isolatedChildEnvironment({ SOURCE_DATE_EPOCH: '' }),
          stdio: 'pipe',
        }
      );

      expect(JSON.parse(fs.readFileSync(output, 'utf8'))).toEqual({
        commit: 'unavailable',
        date: 'unavailable',
        display: 'unavailable',
        version: 'unavailable - unavailable',
      });
    } finally {
      fs.rmSync(root, { force: true, recursive: true });
    }
  });
});
