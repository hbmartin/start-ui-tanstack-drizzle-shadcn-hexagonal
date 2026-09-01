import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import {
  evaluateReport,
  fingerprintFinding,
  JITTEST_MODEL,
  MAX_COST_USD,
  MAX_TOKENS,
  runCli,
  validateConfig,
} from '../../../scripts/check-jittest-report.mjs';

const roots = [];
afterEach(() => {
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
});

const rootFixture = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jittest-gate-'));
  roots.push(root);
  fs.mkdirSync(path.join(root, 'docs'));
  fs.writeFileSync(path.join(root, 'CONTEXT.md'), 'context');
  fs.writeFileSync(
    path.join(root, 'docs/audit-remediation-ledger.md'),
    'ledger'
  );
  return root;
};

const configFixture = () =>
  JSON.parse(fs.readFileSync('jittest.config.json', 'utf8'));
const findingFixture = (verdict = 'likely-strong') => ({
  headline: 'Changed access behavior',
  senseCheck: 'Parent and child differ',
  details: {
    behaviorChange: {
      summary: 'Access changed',
      parentBehavior: 'allowed',
      childBehavior: 'denied',
      changeType: 'return-value-changed',
    },
    verdict,
    assessorRationales: ['A meaningful regression'],
    testCode: "it('keeps access', () => expect(access()).toBe('allowed'));",
    dismissalEstimate: 'moderate',
  },
});
const usageFixture = () => ({
  callCount: 1,
  cacheHits: 0,
  totalInputTokens: 100,
  totalOutputTokens: 50,
  totalTokens: 150,
  totalCostUsd: 0.01,
  costKnown: true,
  byModel: [
    {
      model: JITTEST_MODEL,
      callCount: 1,
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
      costUsd: 0.01,
      costKnown: true,
    },
  ],
  budget: {
    maxCostUsd: MAX_COST_USD,
    maxTokens: MAX_TOKENS,
    status: 'within-budget',
    skippedCalls: 0,
    overshootAllowed: true,
    dollarBudgetEnforced: true,
  },
  events: [
    {
      type: 'call',
      callNumber: 1,
      model: JITTEST_MODEL,
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
      costUsd: 0.01,
      costKnown: true,
    },
  ],
});
const reportFixture = (reports = [findingFixture()]) => ({
  version: '0.4.0',
  stats: {
    duration: '1s',
    diffExtractionMs: 10,
    testGenerationMs: 20,
    executionMs: 30,
    assessmentMs: 40,
    filesAnalyzed: 1,
    functionsAnalyzed: 1,
    totalTestsGenerated: 1,
    testsPassedOnParent: 1,
    testsFailedOnChild: reports.length,
    weakCatchCount: reports.length,
    hardeningCandidateCount: 0,
    assessedAsTP: reports.length,
    assessedAsFP: 0,
    assessedAsUncertain: 0,
    reportsGenerated: reports.length,
    byWorkflow: {
      dodgyDiff: {
        generated: 1,
        weakCatches: reports.length,
        hardeningCandidates: 0,
      },
      intentAware: { generated: 0, weakCatches: 0, hardeningCandidates: 0 },
    },
    llmCallCount: 1,
    estimatedTokens: 150,
    estimatedCost: 0.01,
    llmUsage: usageFixture(),
    diffRiskScore: 1,
  },
  reports,
  hardeningCandidates: [],
});
const triageFixture = (finding) => ({
  version: 1,
  entries: [
    {
      fingerprint: fingerprintFinding(finding),
      disposition: 'accepted-intended-change',
      reviewer: '@reviewer',
      reviewedAt: '2026-08-01T12:00:00Z',
      expiresOn: '2026-09-01',
      rationale:
        'This reviewed behavior is intentionally changed by the linked release work.',
      evidence: ['CONTEXT.md'],
    },
  ],
});
const evaluate = (overrides = {}) => {
  const root = overrides.root ?? rootFixture();
  return evaluateReport({
    config: configFixture(),
    report: reportFixture(),
    triage: { version: 1, entries: [] },
    cliExit: 2,
    baseSha: '1'.repeat(40),
    headSha: '2'.repeat(40),
    root,
    today: '2026-08-29',
    ...overrides,
  });
};

describe('JiTTest release evidence gate', () => {
  it('validates the committed model, context, sensitivity, flake, and budget policy', () => {
    expect(validateConfig(configFixture(), process.cwd())).toEqual([]);
    const weakened = configFixture();
    weakened.llm.budget.maxCostUsd = 10;
    weakened.flakeGuardRuns = 1;
    weakened.sensitivityGlobs = [];
    expect(validateConfig(weakened, process.cwd())).toEqual(
      expect.arrayContaining([
        'config dollar budget must be 5',
        'config.flakeGuardRuns must be 3',
        'config.sensitivityGlobs must cover the five reviewed risk groups',
      ])
    );
  });

  it('keeps the workflow release evidence contract nonweakenable', () => {
    const workflowSource = fs.readFileSync(
      '.github/workflows/jittest.yml',
      'utf8'
    );
    const workflow = parseYaml(workflowSource);
    expect(Object.keys(workflow.on)).toEqual(['workflow_dispatch']);
    expect(Object.keys(workflow.on.workflow_dispatch.inputs)).toEqual([
      'base-sha',
      'head-sha',
      'secret-name',
    ]);
    expect(workflow.jobs.jittest.environment).toBe('release-jittest');
    expect(workflow.jobs.jittest.permissions).toBeUndefined();
    expect(workflow.permissions).toEqual({ contents: 'read' });
    expect(workflowSource).toContain(
      'if [ "${GITHUB_REF}" != "refs/heads/main" ]'
    );
    expect(workflowSource).toContain(
      'JITTEST_SANDBOX_READY: ${{ vars.JITTEST_SANDBOX_READY }}'
    );
    expect(workflowSource).not.toContain('actions/cache@');
    expect(workflowSource).toContain(
      '--import=./scripts/jittest-child-env-preload.mjs'
    );
    expect(workflowSource).toContain('--llm-provider openrouter');
    expect(workflowSource).toContain('--llm-model anthropic/claude-sonnet-4');
    expect(workflowSource).toContain('--flake-guard-runs 3');
    expect(workflowSource).toContain('--max-cost-usd 5');
    expect(workflowSource).toContain('--max-tokens 200000');
    expect(workflowSource).toContain('--fail-on likely-strong');
    expect(workflowSource).toContain('--release');
    expect(workflowSource).toContain('.jittest/run-metadata.json');
    expect(workflowSource).toContain('if-no-files-found: error');
    for (const ambientOverride of [
      'LLM_API_KEY',
      'LLM_PROVIDER',
      'LLM_BASE_URL',
      'LLM_MODEL',
      'OPENROUTER_MODEL',
    ]) {
      expect(workflowSource).toContain(`-u ${ambientOverride}`);
    }
  });

  it('rejects defaulted, assessor-disabled, excluded, duplicated, or escaping config', () => {
    const root = rootFixture();
    const weakened = configFixture();
    delete weakened.flakeGuardRuns;
    weakened.rubfakeEnabled = false;
    weakened.llmJudgeEnabled = false;
    weakened.include = [];
    weakened.exclude = ['src/**'];
    weakened.sensitivityGlobs = Array.from({ length: 5 }, () => ({
      label: 'duplicate',
      pattern: 'README.md',
      weight: 1,
    }));
    weakened.contextFiles = ['../start-ui-web/CONTEXT.md'];
    expect(validateConfig(weakened, root)).toEqual(
      expect.arrayContaining([
        'config.flakeGuardRuns must be 3',
        'config.rubfakeEnabled must be enabled',
        'config.llmJudgeEnabled must be enabled',
        'config.include does not match the committed policy',
        'config.exclude does not match the committed policy',
        'config.contextFiles does not match the committed policy',
      ])
    );
  });

  it.each(['likely-strong', 'strong-catch'])(
    'blocks an untriaged %s report',
    (verdict) => {
      const finding = findingFixture(verdict);
      const result = evaluate({ report: reportFixture([finding]) });
      expect(result.violations).toEqual([]);
      expect(result.blockers).toEqual([expect.objectContaining({ verdict })]);
    }
  );

  it('accepts an exact, current, reviewed false-positive or intended-change triage', () => {
    const finding = findingFixture('strong-catch');
    const result = evaluate({
      report: reportFixture([finding]),
      triage: triageFixture(finding),
    });
    expect(result).toMatchObject({ blockers: [], violations: [] });
  });

  it('keeps fingerprints stable across verdict and explanatory prose changes', () => {
    const first = findingFixture('likely-strong');
    const second = findingFixture('strong-catch');
    second.headline = 'Different prose';
    second.details.assessorRationales = ['Different rationale'];
    expect(fingerprintFinding(first)).toBe(fingerprintFinding(second));
    second.details.behaviorChange.childBehavior = 'allowed';
    expect(fingerprintFinding(first)).not.toBe(fingerprintFinding(second));
  });

  it('rejects malformed or unknown report data through the installed 0.4.0 schema', () => {
    const report = reportFixture([]);
    report.reports = [findingFixture('strongest-catch')];
    report.reports[0].headline = 42;
    report.reports[0].details.behaviorChange.changeType = 'invented';
    report.stats.reportsGenerated = 1;
    expect(evaluate({ cliExit: 0, report }).violations).toEqual(
      expect.arrayContaining([
        expect.stringContaining('report does not match JiTTest 0.4.0'),
        'report.reports[0].headline must be a string',
        'report.reports[0].details.verdict is invalid',
        'report.reports[0].details.behaviorChange.changeType is invalid',
      ])
    );
  });

  it('requires upstream fail-on status to agree with blocking findings', () => {
    expect(
      evaluate({ cliExit: 0, report: reportFixture([findingFixture()]) })
        .violations
    ).toContain('blocking reports require JiTTest exit 2');
  });

  it('rejects duplicate blocking fingerprints instead of sharing one waiver', () => {
    const finding = findingFixture();
    const result = evaluate({
      report: reportFixture([finding, structuredClone(finding)]),
      triage: triageFixture(finding),
    });
    expect(result.violations).toContain(
      'duplicate blocking fingerprints are ambiguous and cannot be triaged'
    );
  });

  it.each([
    [
      'unknown cost',
      (report) => {
        report.stats.llmUsage.costKnown = false;
      },
    ],
    [
      'missing ceiling',
      (report) => {
        delete report.stats.llmUsage.budget.maxTokens;
      },
    ],
    [
      'budget exhaustion',
      (report) => {
        report.stats.llmUsage.budget.status = 'exhausted';
      },
    ],
    [
      'skipped calls',
      (report) => {
        report.stats.llmUsage.budget.skippedCalls = 1;
      },
    ],
    [
      'unenforced dollars',
      (report) => {
        report.stats.llmUsage.budget.dollarBudgetEnforced = false;
      },
    ],
    [
      'cost overshoot',
      (report) => {
        report.stats.llmUsage.totalCostUsd = 6;
      },
    ],
    [
      'token overshoot',
      (report) => {
        report.stats.llmUsage.totalTokens = 200001;
      },
    ],
    [
      'usage failure event',
      (report) => {
        report.stats.llmUsage.events.push({ type: 'missing-cost' });
      },
    ],
  ])('fails closed on %s', (_label, mutate) => {
    const report = reportFixture([]);
    mutate(report);
    expect(evaluate({ cliExit: 0, report }).violations).not.toEqual([]);
  });

  it('reconciles call-event and per-model usage with aggregate totals', () => {
    const wrongEvent = reportFixture([]);
    wrongEvent.stats.llmUsage.events[0].model = 'unexpected/model';
    expect(evaluate({ cliExit: 0, report: wrongEvent }).violations).toContain(
      'LLM call audit events are inconsistent'
    );

    const wrongModelTotals = reportFixture([]);
    wrongModelTotals.stats.llmUsage.byModel[0].inputTokens = 99;
    expect(
      evaluate({ cliExit: 0, report: wrongModelTotals }).violations
    ).toContain('per-model LLM accounting is inconsistent');
  });

  it('rejects malformed reports, stale triage, tool failure, and release exit 3', () => {
    const finding = findingFixture();
    const expired = triageFixture(finding);
    expired.entries[0].expiresOn = '2026-08-28';
    expect(
      evaluate({ report: reportFixture([finding]), triage: expired }).violations
    ).toContain('triage.entries[0] is expired');
    expect(evaluate({ cliExit: 1 }).violations).toContain(
      'JiTTest exited with tool failure status 1'
    );
    expect(
      evaluate({
        cliExit: 3,
        baseSha: '1'.repeat(40),
        headSha: '1'.repeat(40),
        release: true,
      }).violations
    ).toContain(
      'JiTTest exit 3 is not valid release or differing-SHA evidence'
    );
    const malformed = reportFixture([]);
    malformed.extra = true;
    expect(evaluate({ cliExit: 0, report: malformed }).violations).toContain(
      'report.extra is not supported'
    );
  });

  it('permits same-SHA exit 3 only for non-release diagnostic runs', () => {
    const result = evaluate({
      cliExit: 3,
      baseSha: '1'.repeat(40),
      headSha: '1'.repeat(40),
      release: false,
    });
    expect(result).toEqual({ blockers: [], fingerprints: [], violations: [] });
  });

  it('rejects impossible dates, bot reviewers, placeholder rationale, and directory evidence', () => {
    const finding = findingFixture();
    const triage = triageFixture(finding);
    Object.assign(triage.entries[0], {
      reviewer: '@ci-bot',
      reviewedAt: '2026-02-30T00:00:00Z',
      expiresOn: '2026-03-01',
      rationale:
        'TODO placeholder rationale that is deliberately at least forty characters.',
      evidence: ['.'],
    });
    const violations = evaluate({
      report: reportFixture([finding]),
      triage,
      today: 'not-a-day',
    }).violations;
    expect(violations).toEqual(
      expect.arrayContaining([
        'triage evaluation date must use YYYY-MM-DD',
        'triage.entries[0].reviewer must identify a human GitHub reviewer',
        'triage.entries[0].reviewedAt is not a valid timestamp',
        'triage.entries[0].rationale contains placeholder text',
        'triage.entries[0].evidence is missing or unsupported: .',
      ])
    );
  });

  it('removes LLM credentials from every JiTTest child process', () => {
    const preload = path.resolve('scripts/jittest-child-env-preload.mjs');
    const output = execFileSync(
      process.execPath,
      [
        '--import',
        preload,
        '--input-type=module',
        '--eval',
        `const { runCommand } = await import('./node_modules/catching-jit-tests-vitest/dist/utils/process.js');
         const result = await runCommand(process.execPath, ['--input-type=module', '--eval',
           'process.stdout.write(JSON.stringify({ openrouter: process.env.OPENROUTER_API_KEY, llm: process.env.LLM_API_KEY }))'
         ], { env: process.env });
         process.stdout.write(JSON.stringify({ child: JSON.parse(result.stdout), stderr: result.stderr }));`,
      ],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          OPENROUTER_API_KEY: 'must-not-reach-child',
          LLM_API_KEY: 'must-not-reach-child',
        },
      }
    );
    expect(JSON.parse(output)).toEqual({ child: {}, stderr: '' });
  });

  it('rejects unknown CLI options and missing option values', () => {
    expect(() => runCli(['--unknown'])).toThrow('Unknown option --unknown');
    expect(() => runCli(['--config'])).toThrow('--config requires a value');
  });
});
