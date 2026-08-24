import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const scopeName = process.env.STRYKER_SCOPE ?? 'kernel';
const isFastMode = process.env.STRYKER_FAST === '1';

const commonModuleScope = (moduleName) => ({
  mutationTestFiles: [
    `tests/unit/modules/${moduleName}/domain/**/*.unit.spec.ts`,
    `tests/unit/modules/${moduleName}/application/**/*.unit.spec.ts`,
  ],
  mutationSourceFiles: [
    `src/modules/${moduleName}/domain/**/*.ts`,
    `src/modules/${moduleName}/application/**/*.ts`,
    '!**/*.spec.ts',
    '!**/*.test.ts',
    '!**/index.ts',
    `!src/modules/${moduleName}/application/ports/**/*.ts`,
    '!**/types.ts',
  ],
  tsconfigFile: `tsconfig.stryker.${moduleName}.json`,
});

const scopes = {
  profile: commonModuleScope('profile'),
  auth: commonModuleScope('auth'),
  book: commonModuleScope('book'),
  genre: commonModuleScope('genre'),
  user: commonModuleScope('user'),
  kernel: {
    ...commonModuleScope('kernel'),
    mutationTestFiles: [
      'tests/unit/modules/kernel/__tests__/**/*.unit.spec.ts',
      'tests/unit/modules/kernel/application/**/*.unit.spec.ts',
      'tests/unit/modules/kernel/domain/**/*.unit.spec.ts',
    ],
  },
  'runtime-config': {
    mutationTestFiles: [
      'tests/unit/platform/runtime-config/application/**/*.unit.spec.ts',
    ],
    mutationSourceFiles: [
      'src/platform/runtime-config/application/**/*.ts',
      '!**/*.spec.ts',
      '!**/*.test.ts',
      '!**/index.ts',
      '!src/platform/runtime-config/application/ports/**/*.ts',
      '!**/types.ts',
    ],
    tsconfigFile: 'tsconfig.stryker.runtime-config.json',
  },
  shared: {
    mutationTestFiles: ['tests/unit/platform/**/*.unit.spec.ts'],
    mutationSourceFiles: [
      'src/platform/http/**/*.ts',
      'src/platform/lib/dayjs/**/*.ts',
      'src/platform/lib/get-page-title.ts',
      'src/platform/lib/redaction/**/*.ts',
      'src/platform/lib/tailwind/**/*.ts',
      'src/platform/lib/tanstack-query/scoped-query-options.ts',
      'src/platform/lib/tanstack-start/**/*.ts',
      'src/platform/lib/zod/**/*.ts',
      '!**/*.spec.ts',
      '!**/*.test.ts',
      '!**/index.ts',
      '!**/types.ts',
    ],
    tsconfigFile: 'tsconfig.stryker.shared-only.json',
  },
};

const scope = scopes[scopeName];
if (!scope) {
  throw new Error(`Unknown Stryker scope: ${scopeName}`);
}

export default {
  plugins: [
    require.resolve('@stryker-mutator/vitest-runner'),
    require.resolve('@stryker-mutator/typescript-checker'),
  ],
  testRunner: 'vitest',
  coverageAnalysis: 'perTest',
  vitest: { configFile: 'vitest.config.ts' },
  mutate: scope.mutationSourceFiles,
  testFiles: scope.mutationTestFiles,
  ignorePatterns: [
    '/coverage',
    '/playwright-report',
    '/test-results',
    '/.output',
    '/dist',
    '/build',
  ],
  thresholds: { high: 80, low: 70, break: 70 },
  tsconfigFile: scope.tsconfigFile,
  checkers: isFastMode ? [] : ['typescript'],
  typescriptChecker: { experimentalNativePreview: true },
  incremental: isFastMode,
  incrementalFile: `reports/stryker-incremental/${scopeName}.json`,
  ignoreStatic: isFastMode,
  reporters: isFastMode
    ? ['progress-append-only', 'clear-text']
    : ['progress', 'clear-text', 'html'],
  htmlReporter: {
    fileName: `reports/mutation/${scopeName}/mutation.html`,
  },
};
