import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  createBuildInfo,
  isBuildInfoEntryPoint,
  readGitMetadata,
  sourceDateFromEpoch,
} from '@/app/build-info/infrastructure/generate-build-info';

const gitMetadata = {
  commit: '0123456789abcdef0123456789abcdef01234567',
  date: '2026-08-27T07:18:45-07:00',
  display: '01234567',
};

describe('build info generation', () => {
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
      execFileSync('git', ['init', '--quiet'], { cwd: root });
      execFileSync('git', ['config', 'user.email', 'test@example.invalid'], {
        cwd: root,
      });
      execFileSync('git', ['config', 'user.name', 'Build Info Test'], {
        cwd: root,
      });
      fs.writeFileSync(path.join(root, 'fixture.txt'), 'fixture');
      execFileSync('git', ['add', 'fixture.txt'], { cwd: root });
      execFileSync('git', ['commit', '--quiet', '-m', 'fixture'], {
        cwd: root,
        env: {
          ...process.env,
          GIT_AUTHOR_DATE: '2024-01-02T03:04:05Z',
          GIT_COMMITTER_DATE: '2024-01-02T03:04:05Z',
        },
      });
      const commit = execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: root,
        encoding: 'utf8',
      }).trim();

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
        { cwd: root, stdio: 'pipe' }
      );

      expect(fs.readFileSync(output, 'utf8')).toBe('sentinel');
    } finally {
      fs.rmSync(root, { force: true, recursive: true });
    }
  });
});
