import childProcess from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { AppError } from '@/modules/kernel';
import { readRuntimeEnv } from '@/platform/env/runtime';

type GitMetadata = Readonly<{
  commit: string;
  date: string;
  display: string;
}>;

const generatedPath = './src/app/build-info/presentation/build-info.gen.json';
const unavailableBuildValue = 'unavailable';
const buildCommitEnvironmentKeys = [
  'GITHUB_SHA',
  'VERCEL_GIT_COMMIT_SHA',
  'CF_PAGES_COMMIT_SHA',
] as const;

const canonicalPath = (candidate: string) => {
  const resolved = path.resolve(candidate);
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    return resolved;
  }
};

export const sourceDateFromEpoch = (sourceDateEpoch: string) => {
  if (!/^\d+$/.test(sourceDateEpoch)) {
    throw new Error('SOURCE_DATE_EPOCH must be whole Unix seconds');
  }
  const seconds = Number(sourceDateEpoch);
  if (!Number.isSafeInteger(seconds)) {
    throw new Error('SOURCE_DATE_EPOCH must be a safe integer');
  }
  const date = new Date(seconds * 1_000);
  if (Number.isNaN(date.getTime())) {
    throw new Error(
      'SOURCE_DATE_EPOCH must be within the JavaScript Date range'
    );
  }
  return date.toISOString();
};

export const readGitMetadata = (cwd = process.cwd()): GitMetadata | null => {
  const runGit = (arguments_: string[]) =>
    childProcess
      .execFileSync('git', arguments_, {
        cwd,
        encoding: 'utf8',
        maxBuffer: 64 * 1024,
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 5_000,
      })
      .trim();
  try {
    const commit = runGit(['rev-parse', 'HEAD']);
    return {
      commit,
      date: runGit(['show', '-s', '--format=%cI', commit]),
      display: commit.slice(0, 8),
    };
  } catch {
    return null;
  }
};

export const createBuildInfo = ({
  fallbackCommit,
  gitMetadata,
  sourceDateEpoch,
}: Readonly<{
  fallbackCommit?: string;
  gitMetadata: GitMetadata | null;
  sourceDateEpoch?: string;
}>) => {
  const date =
    sourceDateEpoch === undefined
      ? (gitMetadata?.date ?? unavailableBuildValue)
      : sourceDateFromEpoch(sourceDateEpoch);
  const commit = gitMetadata?.commit ?? fallbackCommit ?? unavailableBuildValue;
  const display =
    gitMetadata?.display ??
    fallbackCommit?.slice(0, 8) ??
    unavailableBuildValue;
  return {
    display,
    version: `${display} - ${date}`,
    commit,
    date,
  };
};

export const readBuildCommit = (environment: Record<string, unknown>) =>
  buildCommitEnvironmentKeys
    .map((key) => environment[key])
    .find(
      (value): value is string =>
        typeof value === 'string' && /^[0-9a-f]{7,64}$/iu.test(value)
    );

const generateAppBuild = () => {
  try {
    const environment = readRuntimeEnv();
    const rawSourceDateEpoch = environment.SOURCE_DATE_EPOCH;
    if (
      rawSourceDateEpoch !== undefined &&
      typeof rawSourceDateEpoch !== 'string'
    ) {
      throw new TypeError('SOURCE_DATE_EPOCH must be a string when supplied');
    }
    const gitMetadata = readGitMetadata();
    const fallbackCommit = readBuildCommit(environment);
    if (!gitMetadata && !fallbackCommit) {
      console.warn(
        '⚠️ Git metadata unavailable; generated build provenance uses deterministic unavailable sentinels'
      );
    }
    const content = createBuildInfo({
      fallbackCommit,
      gitMetadata,
      sourceDateEpoch: rawSourceDateEpoch?.trim() || undefined,
    });
    fs.writeFileSync(generatedPath, JSON.stringify(content, null, 2));
    console.log(`✅ Build info file generated (${generatedPath})`);
  } catch (error) {
    console.error(error);
    throw new AppError({
      code: 'BUILD_INFO_GENERATE_FAILED',
      category: 'system',
      status: 500,
      message: `Failed to generate build info file (${generatedPath})`,
      cause: error,
    });
  }
};

export const isBuildInfoEntryPoint = (
  argv: ReadonlyArray<string> = process.argv,
  cwd = process.cwd(),
  moduleUrl = import.meta.url
) => {
  const launcher = argv[1];
  if (!launcher) return false;

  const modulePath = canonicalPath(fileURLToPath(moduleUrl));
  const launcherPath = canonicalPath(path.resolve(cwd, launcher));
  if (launcherPath === modulePath) return true;

  const launcherName = path.basename(launcher);
  if (launcherName !== 'run-jiti' && launcherName !== 'run-jiti.js') {
    return false;
  }

  const requestedModule = argv[2];
  if (requestedModule === undefined) return false;
  return [
    path.resolve(cwd, requestedModule),
    path.resolve(path.dirname(launcherPath), requestedModule),
  ].some((candidate) => canonicalPath(candidate) === modulePath);
};

if (isBuildInfoEntryPoint()) generateAppBuild();
