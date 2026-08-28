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
  gitMetadata,
  sourceDateEpoch,
}: Readonly<{
  gitMetadata: GitMetadata | null;
  sourceDateEpoch?: string;
}>) => {
  const date =
    sourceDateEpoch === undefined
      ? (gitMetadata?.date ?? unavailableBuildValue)
      : sourceDateFromEpoch(sourceDateEpoch);
  const display = gitMetadata?.display ?? unavailableBuildValue;
  return {
    display,
    version: `${display} - ${date}`,
    commit: gitMetadata?.commit ?? unavailableBuildValue,
    date,
  };
};

export const generateAppBuild = () => {
  try {
    const rawSourceDateEpoch = readRuntimeEnv().SOURCE_DATE_EPOCH;
    if (
      rawSourceDateEpoch !== undefined &&
      typeof rawSourceDateEpoch !== 'string'
    ) {
      throw new TypeError('SOURCE_DATE_EPOCH must be a string when supplied');
    }
    const content = createBuildInfo({
      gitMetadata: readGitMetadata(),
      ...(rawSourceDateEpoch === undefined
        ? {}
        : { sourceDateEpoch: rawSourceDateEpoch }),
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

  const modulePath = path.resolve(fileURLToPath(moduleUrl));
  if (path.resolve(cwd, launcher) === modulePath) return true;

  const launcherName = path.basename(launcher);
  if (launcherName !== 'run-jiti' && launcherName !== 'run-jiti.js') {
    return false;
  }

  const requestedModule = argv[2];
  return (
    requestedModule !== undefined &&
    path.resolve(cwd, requestedModule) === modulePath
  );
};

if (isBuildInfoEntryPoint()) generateAppBuild();
