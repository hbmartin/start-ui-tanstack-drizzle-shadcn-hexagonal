import { spawn } from 'node:child_process';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parse, printParseErrorCode } from 'jsonc-parser';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceConfigPath = path.join(root, '.fallowrc.jsonc');
const coveragePath = path.join(
  root,
  'test-results',
  'fallow-verifier-coverage',
  'coverage-final.json'
);

const parseFallowConfig = (source) => {
  const parseErrors = [];
  const config = parse(source, parseErrors, {
    allowTrailingComma: true,
    disallowComments: false,
  });
  if (parseErrors.length > 0) {
    const details = parseErrors
      .map(({ error, offset }) => `${printParseErrorCode(error)} at ${offset}`)
      .join(', ');
    throw new Error(`Invalid Fallow config: ${details}`);
  }
  if (!config || typeof config !== 'object') {
    throw new Error('Invalid Fallow config');
  }
  return config;
};

const validateRulePacks = (rulePacks) => {
  if (!Array.isArray(rulePacks)) return;
  if (rulePacks.some((rulePack) => typeof rulePack !== 'string')) {
    throw new TypeError('Fallow rule-pack paths must be strings');
  }
};

export const createPortableFallowAuditConfig = (source) => {
  const config = parseFallowConfig(source);
  validateRulePacks(config.rulePacks);

  return JSON.stringify({
    ...config,
    // Audit evaluates both the current tree and a historical checkout. A pack
    // introduced by the change does not exist inside that historical root, and
    // Fallow intentionally rejects packs outside it. The preceding project-wide
    // dead-code gate owns policy-pack enforcement; audit owns changed-code
    // complexity, styling, and dead-code attribution.
    rulePacks: [],
    // The project-wide duplication gate already compares the complete tree to
    // the reviewed baseline. Re-running duplication against a pre-Fallow base
    // misclassifies those reviewed groups as newly introduced.
    duplicates: { ...config.duplicates, enabled: false },
  });
};

const hasArgument = (args, name) =>
  args.some((argument) => argument === name || argument.startsWith(`${name}=`));

export const resolveFallowAuditArgs = async (args) => {
  if (hasArgument(args, '--coverage') || process.env.FALLOW_COVERAGE) {
    return args;
  }
  try {
    await access(coveragePath);
  } catch {
    throw new Error(
      'Fallow audit coverage is unavailable; run `pnpm quality:health` first.'
    );
  }
  return ['--coverage', coveragePath, ...args];
};

const waitForChild = (child) =>
  new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (signal) {
        reject(new Error(`Fallow audit terminated by ${signal}`));
        return;
      }
      resolve(code ?? 1);
    });
  });

export const runFallowAudit = async (args = process.argv.slice(2)) => {
  const resolvedArgs = await resolveFallowAuditArgs(args);
  const temporaryDirectory = await mkdtemp(
    path.join(os.tmpdir(), 'start-ui-fallow-audit-')
  );
  try {
    const temporaryConfigPath = path.join(temporaryDirectory, '.fallowrc.json');
    const source = await readFile(sourceConfigPath, 'utf8');
    await writeFile(
      temporaryConfigPath,
      createPortableFallowAuditConfig(source),
      'utf8'
    );
    const executable = path.join(
      root,
      'node_modules',
      '.bin',
      process.platform === 'win32' ? 'fallow.cmd' : 'fallow'
    );
    return await waitForChild(
      spawn(
        executable,
        [
          'audit',
          '--root',
          root,
          '--config',
          temporaryConfigPath,
          ...resolvedArgs,
        ],
        { cwd: root, stdio: 'inherit' }
      )
    );
  } finally {
    await rm(temporaryDirectory, { force: true, recursive: true });
  }
};

const directInvocation = process.argv[1]
  ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false;

if (directInvocation) {
  try {
    process.exitCode = await runFallowAudit();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  }
}
