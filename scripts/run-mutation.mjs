import { spawnSync } from 'node:child_process';
import path from 'node:path';

const args = new Set(process.argv.slice(2));
const scopeArgument = [...args].find((argument) =>
  argument.startsWith('--scope=')
);
const requestedScope = scopeArgument?.slice('--scope='.length) ?? 'critical';
const fast = args.has('--fast');
const dryRun = args.has('--dry-run');

const allScopes = [
  'account',
  'auth',
  'book',
  'genre',
  'runtime-config',
  'user',
  'kernel',
  'shared',
];
const criticalScopes = ['auth', 'kernel', 'user', 'book', 'shared'];
const scopes =
  requestedScope === 'all'
    ? allScopes
    : requestedScope === 'critical'
      ? criticalScopes
      : [requestedScope];

for (const scope of scopes) {
  if (!allScopes.includes(scope)) {
    console.error(`Unknown mutation scope: ${scope}`);
    process.exit(2);
  }

  const strykerBin = path.resolve(
    'tools/mutation/node_modules/.bin',
    process.platform === 'win32' ? 'stryker.cmd' : 'stryker'
  );
  const commandArgs = [
    'run',
    'tools/mutation/stryker.config.mjs',
    ...(dryRun ? ['--dryRunOnly'] : []),
  ];
  const result = spawnSync(strykerBin, commandArgs, {
    stdio: 'inherit',
    env: {
      ...process.env,
      STRYKER_SCOPE: scope,
      STRYKER_FAST: fast ? '1' : '0',
    },
  });

  if (result.status !== 0) process.exit(result.status ?? 1);
}
