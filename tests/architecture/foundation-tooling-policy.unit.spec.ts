import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { resolveTrustedProjectBin } from '../../scripts/trusted-tool';

const root = process.cwd();
const read = (file: string) => fs.readFileSync(path.join(root, file), 'utf8');
type PackageManifest = Readonly<{
  dependencies?: Readonly<Record<string, string>>;
  devDependencies?: Readonly<Record<string, string>>;
  scripts?: Readonly<Record<string, string>>;
}>;
const packageManifest = JSON.parse(read('package.json')) as PackageManifest;
const lefthookSource = read('lefthook.yml');
const lefthook = parseYaml(lefthookSource) as {
  'pre-commit': {
    commands: Readonly<
      Record<
        string,
        Readonly<{
          exclude?: ReadonlyArray<string>;
          glob?: string;
          run?: string;
        }>
      >
    >;
  };
};
const formatter = JSON.parse(read('.oxfmtrc.json')) as {
  ignorePatterns?: ReadonlyArray<string>;
};
const linter = JSON.parse(read('.oxlintrc.json')) as {
  ignorePatterns?: ReadonlyArray<string>;
};
const lockfile = parseYaml(read('pnpm-lock.yaml')) as {
  packages?: Readonly<Record<string, unknown>>;
  snapshots?: Readonly<Record<string, unknown>>;
};
const dependencyInputPaths = [
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'tools/*/package.json',
];
const graphvizExecutionPatterns = [
  /['"`](?:dot(?:\.exe)?|graphviz|@viz-js\/[^'"`]+|viz\.js(?:\/[^'"`]*)?)['"`]/iu,
  /\b(?:exec|execFile|execFileSync|execSync|execa|spawn|spawnSync)\s*\(\s*['"`](?:dot(?:\.exe)?|graphviz)['"`]/iu,
  /\b(?:resolveTrustedProjectBin|resolveTrustedTool)\s*\(\s*['"`](?:dot(?:\.exe)?|graphviz)['"`]/iu,
  /\b(?:from\s+|import\s*\(|require\s*\()\s*['"`](?:@viz-js\/[^'"`]+|graphviz|viz\.js)(?:\/[^'"`]*)?['"`]/iu,
  /(?:^|[\n;&|])\s*(?:run:\s*)?(?:(?:npx|npm\s+exec|pnpm(?:\s+exec)?)\s+)?(?:dot(?:\.exe)?|graphviz)(?:\s|$)/imu,
];
const graphvizPackageNamePattern = /^(?:@viz-js\/[^@/]+|graphviz|viz\.js)$/iu;
const graphvizLockKeyPattern = /^\/?(?:@viz-js\/[^@/]+|graphviz|viz\.js)@/iu;

type WorkflowStep = Readonly<{
  'continue-on-error'?: boolean;
  env?: Readonly<Record<string, string>>;
  if?: string;
  id?: string;
  name?: string;
  run?: string;
  uses?: string;
}>;

type Workflow = Readonly<{
  jobs: Readonly<
    Record<
      string,
      Readonly<{
        if?: string;
        name?: string;
        needs?: string | ReadonlyArray<string>;
        outputs?: Readonly<Record<string, string>>;
        steps?: ReadonlyArray<WorkflowStep>;
      }>
    >
  >;
  on: { pull_request: { paths?: ReadonlyArray<string> } };
}>;

const hasGraphvizExecutionDependency = (source: string) =>
  graphvizExecutionPatterns.some((pattern) => pattern.test(source));

const listFiles = (directory: string): ReadonlyArray<string> =>
  fs
    .readdirSync(path.join(root, directory), { withFileTypes: true })
    .flatMap((entry) => {
      const relativePath = path.join(directory, entry.name);
      return entry.isDirectory() ? listFiles(relativePath) : [relativePath];
    });

const workspacePackageManifests = [
  'package.json',
  ...fs
    .readdirSync(path.join(root, 'tools'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join('tools', entry.name, 'package.json'))
    .filter((file) => fs.existsSync(path.join(root, file))),
].map((file) => JSON.parse(read(file)) as PackageManifest);
const workspaceDependencyNames = workspacePackageManifests.flatMap(
  (manifest) => [
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.devDependencies ?? {}),
  ]
);
const workspacePackageScripts = workspacePackageManifests.flatMap((manifest) =>
  Object.values(manifest.scripts ?? {})
);
const lockfilePackageKeys = [
  ...Object.keys(lockfile.packages ?? {}),
  ...Object.keys(lockfile.snapshots ?? {}),
];

const hasStrictCiLintStep = (workflow: Workflow) => {
  const step = workflow.jobs['lint-typecheck']?.steps?.find(
    (candidate) => candidate.name === 'Run lint and typecheck'
  );
  return (
    step?.run === 'pnpm exec run-p -n lint typecheck' &&
    step['continue-on-error'] !== true
  );
};

const runHook = (...files: ReadonlyArray<string>) =>
  execFileSync(
    resolveTrustedProjectBin('lefthook'),
    [
      'run',
      'pre-commit',
      ...files.flatMap((file) => ['--file', file]),
      '--no-tty',
      '--colors=off',
    ],
    { cwd: root, encoding: 'utf8' }
  );

describe('foundation tooling policy', () => {
  it('selects no formatter or linter for docs-only and agent-only commits', () => {
    for (const output of [
      runHook('docs/example.md'),
      runHook('.agents/example.ts', '.claude/example.ts', '.codex/example.ts'),
    ]) {
      expect(output).toContain('format (skip) no files for inspection');
      expect(output).toContain('lint (skip) no files for inspection');
    }
  });

  it('makes the direct changed-file formatter ignore agent directories', () => {
    const output = execFileSync(
      process.execPath,
      [
        'scripts/format-changed.mjs',
        '.agents/example.ts',
        'nested/.claude/example.json',
        'nested\\.codex\\example.ts',
      ],
      { cwd: root, encoding: 'utf8' }
    );
    expect(output.trim()).toBe('No changed files to format.');
  });

  it('keeps agent directories outside hooks, formatting, and linting', () => {
    const agentIgnores = ['.agents/**', '.claude/**', '.codex/**'];
    expect(formatter.ignorePatterns).toEqual(
      expect.arrayContaining(agentIgnores)
    );
    expect(linter.ignorePatterns).toEqual(expect.arrayContaining(agentIgnores));
    for (const command of Object.values(lefthook['pre-commit'].commands)) {
      expect(command.exclude).toEqual(agentIgnores);
    }
  });

  it('internally filters dependency lanes without suppressing required workflows', () => {
    for (const policy of [
      {
        requiredJobName: 'dependency-review',
        requiredJobNeeds: 'dependency-paths',
        requiredResultToken: 'DETECTION_RESULT',
        requiredStepName: 'Require successful dependency detection',
        scanJobIf: 'always()',
        scanJobName: 'dependency-review',
        workflowFile: '.github/workflows/dependency-review.yml',
      },
      {
        requiredJobName: 'scan-pr',
        requiredJobNeeds: ['dependency-paths', 'scan-pr-run'],
        requiredResultToken: 'SCAN_RESULT',
        requiredStepName: 'Require successful OSV result',
        scanJobIf:
          "github.event.pull_request.draft == false && needs.dependency-paths.outputs.relevant == 'true'",
        scanJobName: 'scan-pr-run',
        workflowFile: '.github/workflows/osv-scanner.yml',
      },
    ] as const) {
      const workflow = parseYaml(read(policy.workflowFile)) as Workflow;
      expect(workflow.on.pull_request.paths).toBeUndefined();

      const detector = workflow.jobs['dependency-paths'];
      expect(detector?.outputs?.relevant).toBe(
        '${{ steps.filter.outputs.relevant }}'
      );
      const filter = detector?.steps?.find((step) => step.id === 'filter');
      expect(filter?.run).toContain(
        'git diff --name-only -z "${BASE_SHA}...${HEAD_SHA}" > "${changed_files}"'
      );
      expect(filter?.run).toContain('done < "${changed_files}"');
      expect(filter?.run).not.toContain('< <(');
      for (const dependencyPath of [
        policy.workflowFile,
        ...dependencyInputPaths,
      ]) {
        expect(filter?.run).toContain(dependencyPath);
      }

      const scanJob = workflow.jobs[policy.scanJobName];
      expect(scanJob?.needs).toBe('dependency-paths');
      expect(scanJob?.if).toBe(policy.scanJobIf);

      const requiredJob = workflow.jobs[policy.requiredJobName];
      expect(requiredJob?.needs).toEqual(policy.requiredJobNeeds);
      expect(requiredJob?.if).toBe('always()');
      const requiredStep = requiredJob?.steps?.find(
        (step) => step.name === policy.requiredStepName
      );
      expect(requiredStep?.run).toContain('DETECTION_RESULT');
      expect(requiredStep?.run).toContain(policy.requiredResultToken);
    }
  });

  it('does not require Graphviz directly or through executable tooling', () => {
    for (const dependencyName of workspaceDependencyNames) {
      expect(dependencyName).not.toMatch(graphvizPackageNamePattern);
    }
    for (const packageKey of lockfilePackageKeys) {
      expect(packageKey).not.toMatch(graphvizLockKeyPattern);
    }
    for (const script of workspacePackageScripts) {
      expect(hasGraphvizExecutionDependency(script)).toBe(false);
    }

    const executableFiles = [
      ...listFiles('scripts').filter((file) =>
        /\.(?:[cm]?[jt]s|[cm]ts)$/u.test(file)
      ),
      ...listFiles('.github/workflows').filter((file) =>
        /\.ya?ml$/u.test(file)
      ),
      ...listFiles('.github/actions').filter((file) =>
        /action\.ya?ml$/u.test(file)
      ),
    ];
    expect(
      executableFiles.filter((file) =>
        hasGraphvizExecutionDependency(read(file))
      )
    ).toEqual([]);

    for (const hostileSource of [
      "spawnSync('dot', ['-Tsvg'])",
      'resolveTrustedTool("graphviz")',
      "const renderer = 'dot'; spawnSync(renderer)",
      "import { render } from '@viz-js/viz'",
      'run: dot -Tsvg architecture.dot',
      'pnpm dot -Tsvg architecture.dot',
      'pnpm exec graphviz --version',
    ]) {
      expect(hasGraphvizExecutionDependency(hostileSource)).toBe(true);
    }
    for (const hostilePackageKey of [
      '@viz-js/viz@3.18.0',
      'graphviz@1.0.0',
      '/viz.js@2.1.2',
    ]) {
      expect(hostilePackageKey).toMatch(graphvizLockKeyPattern);
    }
  });

  it('enforces a zero-warning lint ceiling in hooks and required CI', () => {
    expect(packageManifest.scripts?.lint).toBe(
      'oxlint --type-aware --deny-warnings .'
    );
    expect(lefthook['pre-commit'].commands.lint?.run).toBe(
      'pnpm oxlint --deny-warnings {staged_files}'
    );
    const codeQuality = parseYaml(
      read('.github/workflows/code-quality.yml')
    ) as Workflow;
    expect(hasStrictCiLintStep(codeQuality)).toBe(true);

    const lintStep = codeQuality.jobs['lint-typecheck']?.steps?.find(
      (step) => step.name === 'Run lint and typecheck'
    );
    expect(
      hasStrictCiLintStep({
        ...codeQuality,
        jobs: {
          ...codeQuality.jobs,
          'lint-typecheck': {
            ...codeQuality.jobs['lint-typecheck'],
            steps: [{ ...lintStep, run: `${lintStep?.run} || true` }],
          },
        },
      })
    ).toBe(false);
    expect(
      hasStrictCiLintStep({
        ...codeQuality,
        jobs: {
          ...codeQuality.jobs,
          'lint-typecheck': {
            ...codeQuality.jobs['lint-typecheck'],
            steps: [{ ...lintStep, 'continue-on-error': true }],
          },
        },
      })
    ).toBe(false);
  });
});
