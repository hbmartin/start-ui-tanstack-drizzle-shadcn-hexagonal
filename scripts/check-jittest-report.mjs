import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { jsonReportSchema } from 'catching-jit-tests-vitest';
import { parseSync } from 'oxc-parser';

export const JITTEST_VERSION = '0.4.0';
export const JITTEST_MODEL = 'anthropic/claude-sonnet-4';
export const MAX_COST_USD = 5;
export const MAX_TOKENS = 200_000;

const blockingVerdicts = new Set(['likely-strong', 'strong-catch']);
const reportVerdicts = new Set([
  'false-positive',
  'likely-false-positive',
  'uncertain',
  'likely-strong',
  'strong-catch',
]);
const behaviorChangeTypes = new Set([
  'return-value-changed',
  'exception-introduced',
  'exception-removed',
  'null-introduced',
  'boolean-flipped',
  'output-shape-changed',
  'ordering-changed',
  'missing-key',
  'type-changed',
  'other',
]);
const allowedDispositions = new Set([
  'accepted-false-positive',
  'accepted-intended-change',
]);
const badBudgetEvents = new Set([
  'missing-cost',
  'budget-exhausted',
  'llm-skipped',
  'cache-hit',
]);
const shaPattern = /^[a-f0-9]{40}$/u;
const fingerprintPattern = /^jittest:v1:[a-f0-9]{64}$/u;
const reviewerPattern = /^@[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/iu;
const githubEvidencePattern =
  /^https:\/\/github\.com\/[^/]+\/[^/]+\/(?:issues|pull|commit)\/[A-Za-z0-9._/-]+$/u;
const expectedSensitivityGlobs = [
  ['authentication', 'src/modules/auth/**'],
  ['authorization-and-audit', 'src/modules/{auth,audit,user}/**'],
  ['http-security', 'src/platform/http/**'],
  ['runtime-and-composition', 'src/{runtime,composition}/**'],
  ['database-migrations', 'src/modules/kernel/infrastructure/db/**'],
];
const expectedInclude = ['src/**/*.ts', 'src/**/*.tsx'];
const expectedExclude = [
  '**/*.test.ts',
  '**/*.test.tsx',
  '**/*.spec.ts',
  '**/*.spec.tsx',
  '**/node_modules/**',
  'tests/**',
];

const isRecord = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const exactKeys = (value, allowed, label, violations) => {
  if (!isRecord(value)) {
    violations.push(`${label} must be an object`);
    return false;
  }
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) violations.push(`${label}.${key} is not supported`);
  }
  return true;
};

const exactArray = (actual, expected, label, violations) => {
  if (
    !Array.isArray(actual) ||
    actual.length !== expected.length ||
    actual.some((value, index) => value !== expected[index])
  ) {
    violations.push(`${label} does not match the committed policy`);
  }
};

const normalizedLineEndings = (value) => value.replace(/\r\n?|\n/gu, '\n');

const canonicalFinding = (report) => ({
  schema: 1,
  changeType: report.details.behaviorChange.changeType,
  parentBehavior: normalizedLineEndings(
    report.details.behaviorChange.parentBehavior
  ),
  childBehavior: normalizedLineEndings(
    report.details.behaviorChange.childBehavior
  ),
  testCode: normalizedLineEndings(report.details.testCode),
});

export const fingerprintFinding = (report, createHash = crypto.createHash) =>
  `jittest:v1:${createHash('sha256')
    .update(JSON.stringify(canonicalFinding(report)))
    .digest('hex')}`;

const parseDate = (value, label, violations) => {
  const match =
    typeof value === 'string'
      ? /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{3}))?(Z|[+-]\d{2}:\d{2})$/u.exec(
          value
        )
      : null;
  if (!match) {
    violations.push(`${label} must be an RFC 3339 timestamp with an offset`);
    return undefined;
  }
  const [, year, month, day, hour, minute, second, , offset] = match;
  const calendar = new Date(`${year}-${month}-${day}T00:00:00.000Z`);
  const offsetMatch = /^([+-])(\d{2}):(\d{2})$/u.exec(offset ?? '');
  if (
    Number.isNaN(calendar.valueOf()) ||
    calendar.toISOString().slice(0, 10) !== `${year}-${month}-${day}` ||
    Number(hour) > 23 ||
    Number(minute) > 59 ||
    Number(second) > 59 ||
    (offset !== 'Z' &&
      (!offsetMatch ||
        Number(offsetMatch[2]) > 23 ||
        Number(offsetMatch[3]) > 59))
  ) {
    violations.push(`${label} is not a valid timestamp`);
    return undefined;
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf())) {
    violations.push(`${label} is not a valid timestamp`);
    return undefined;
  }
  return parsed;
};

const parseDay = (value, label, violations) => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) {
    violations.push(`${label} must use YYYY-MM-DD`);
    return undefined;
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (
    Number.isNaN(parsed.valueOf()) ||
    parsed.toISOString().slice(0, 10) !== value
  ) {
    violations.push(`${label} is not a valid calendar date`);
    return undefined;
  }
  return parsed;
};

export const validateConfig = (config, root = process.cwd()) => {
  const violations = [];
  if (
    !exactKeys(
      config,
      new Set([
        'llm',
        'riskThreshold',
        'testsPerFunction',
        'maxTotalTests',
        'workflow',
        'testTimeout',
        'batchSize',
        'parallelWorktrees',
        'assessConcurrency',
        'flakeGuardRuns',
        'reportThreshold',
        'rubfakeEnabled',
        'llmJudgeEnabled',
        'cache',
        'outputFormat',
        'feedbackPath',
        'contextFiles',
        'autoContext',
        'autoContextFiles',
        'sensitivityGlobs',
        'include',
        'exclude',
      ]),
      'config',
      violations
    )
  )
    return violations;

  exactKeys(
    config.llm,
    new Set(['provider', 'model', 'maxTokens', 'budget']),
    'config.llm',
    violations
  );
  exactKeys(
    config.llm?.budget,
    new Set(['maxCostUsd', 'maxTokens']),
    'config.llm.budget',
    violations
  );
  if (config.llm?.provider !== 'openrouter')
    violations.push('config.llm.provider must be openrouter');
  if (config.llm?.model !== JITTEST_MODEL)
    violations.push(`config.llm.model must be ${JITTEST_MODEL}`);
  if (config.llm?.maxTokens !== 4096)
    violations.push('config.llm.maxTokens must be 4096');
  if (config.llm?.budget?.maxCostUsd !== MAX_COST_USD)
    violations.push(`config dollar budget must be ${MAX_COST_USD}`);
  if (config.llm?.budget?.maxTokens !== MAX_TOKENS)
    violations.push(`config token budget must be ${MAX_TOKENS}`);
  if (config.testsPerFunction !== 3)
    violations.push('config.testsPerFunction must be 3');
  if (config.maxTotalTests !== 50)
    violations.push('config.maxTotalTests must be 50');
  if (config.workflow !== 'both')
    violations.push('config.workflow must be both');
  if (config.testTimeout !== 30_000)
    violations.push('config.testTimeout must be 30000');
  if (config.batchSize !== 10) violations.push('config.batchSize must be 10');
  if (config.parallelWorktrees !== true)
    violations.push('config.parallelWorktrees must be enabled');
  if (config.assessConcurrency !== 4)
    violations.push('config.assessConcurrency must be 4');
  if (config.flakeGuardRuns !== 3)
    violations.push('config.flakeGuardRuns must be 3');
  if (config.reportThreshold !== -1)
    violations.push('config.reportThreshold must be -1');
  if (config.riskThreshold !== 0)
    violations.push('config.riskThreshold must be 0');
  if (config.rubfakeEnabled !== true)
    violations.push('config.rubfakeEnabled must be enabled');
  if (config.llmJudgeEnabled !== true)
    violations.push('config.llmJudgeEnabled must be enabled');
  exactKeys(
    config.cache,
    new Set(['enabled', 'dir']),
    'config.cache',
    violations
  );
  if (config.cache?.enabled !== false || config.cache?.dir !== '.jittest/cache')
    violations.push('config.cache must be disabled for release evidence');
  if (config.outputFormat !== 'console')
    violations.push('config.outputFormat must be console');
  if (config.feedbackPath !== '.jittest/assessment-records.jsonl')
    violations.push('config.feedbackPath must use the reviewed artifact path');
  if (config.autoContext !== true)
    violations.push('config.autoContext must be enabled');
  exactArray(
    config.autoContextFiles,
    ['AGENTS.md', 'README.md'],
    'config.autoContextFiles',
    violations
  );
  exactArray(config.include, expectedInclude, 'config.include', violations);
  exactArray(config.exclude, expectedExclude, 'config.exclude', violations);
  exactArray(
    config.contextFiles,
    ['CONTEXT.md', 'docs/audit-remediation-ledger.md'],
    'config.contextFiles',
    violations
  );
  if (!Array.isArray(config.contextFiles) || config.contextFiles.length === 0) {
    violations.push('config.contextFiles must not be empty');
  } else {
    for (const contextFile of config.contextFiles) {
      const components =
        typeof contextFile === 'string' ? contextFile.split(/[\\/]/u) : [];
      const realRoot = fs.realpathSync(root);
      const candidate =
        typeof contextFile === 'string'
          ? path.resolve(realRoot, contextFile)
          : path.resolve(realRoot, '__invalid__');
      const isInsideRoot = candidate.startsWith(`${realRoot}${path.sep}`);
      const isRegularFile =
        isInsideRoot &&
        fs.existsSync(candidate) &&
        fs.statSync(candidate).isFile() &&
        fs.realpathSync(candidate).startsWith(`${realRoot}${path.sep}`);
      if (
        typeof contextFile !== 'string' ||
        path.isAbsolute(contextFile) ||
        components.includes('..') ||
        !isRegularFile
      ) {
        violations.push(
          `config context file is missing or unsafe: ${String(contextFile)}`
        );
      }
    }
  }
  if (!Array.isArray(config.sensitivityGlobs)) {
    violations.push(
      'config.sensitivityGlobs must cover the five reviewed risk groups'
    );
  } else {
    for (const [index, glob] of config.sensitivityGlobs.entries()) {
      exactKeys(
        glob,
        new Set(['label', 'pattern', 'weight']),
        `config.sensitivityGlobs[${index}]`,
        violations
      );
      if (typeof glob?.label !== 'string' || glob.label.trim() === '')
        violations.push(`config.sensitivityGlobs[${index}].label is required`);
      if (typeof glob?.pattern !== 'string' || glob.pattern.trim() === '')
        violations.push(
          `config.sensitivityGlobs[${index}].pattern is required`
        );
      if (glob?.weight !== 1)
        violations.push(`config.sensitivityGlobs[${index}].weight must be 1`);
      const expected = expectedSensitivityGlobs[index];
      if (
        expected === undefined ||
        glob?.label !== expected[0] ||
        glob?.pattern !== expected[1]
      )
        violations.push(
          `config.sensitivityGlobs[${index}] does not match the committed risk group`
        );
    }
    if (config.sensitivityGlobs.length !== expectedSensitivityGlobs.length)
      violations.push(
        'config.sensitivityGlobs must cover the five reviewed risk groups'
      );
  }
  return violations;
};

export const validateTriage = (triage, fingerprints, options = {}) => {
  const root = options.root ?? process.cwd();
  const violations = [];
  const today = parseDay(
    options.today ?? new Date().toISOString().slice(0, 10),
    'triage evaluation date',
    violations
  );
  if (!exactKeys(triage, new Set(['version', 'entries']), 'triage', violations))
    return { entries: new Map(), violations };
  if (triage.version !== 1) violations.push('triage.version must be 1');
  if (!Array.isArray(triage.entries)) {
    violations.push('triage.entries must be an array');
    return { entries: new Map(), violations };
  }

  const entries = new Map();
  let priorFingerprint = '';
  for (const [index, entry] of triage.entries.entries()) {
    const label = `triage.entries[${index}]`;
    if (
      !exactKeys(
        entry,
        new Set([
          'fingerprint',
          'disposition',
          'reviewer',
          'reviewedAt',
          'expiresOn',
          'rationale',
          'evidence',
        ]),
        label,
        violations
      )
    )
      continue;
    if (!fingerprintPattern.test(entry.fingerprint ?? ''))
      violations.push(`${label}.fingerprint is invalid`);
    if (entry.fingerprint <= priorFingerprint)
      violations.push(
        'triage entries must be unique and sorted by fingerprint'
      );
    priorFingerprint = entry.fingerprint;
    if (!allowedDispositions.has(entry.disposition))
      violations.push(`${label}.disposition is not waivable`);
    if (
      !reviewerPattern.test(entry.reviewer ?? '') ||
      /(?:^@(?:bot|todo|unknown)$|-?bot$)/iu.test(entry.reviewer ?? '')
    )
      violations.push(
        `${label}.reviewer must identify a human GitHub reviewer`
      );
    const rationale =
      typeof entry.rationale === 'string' ? entry.rationale.trim() : '';
    if (rationale.length < 40 || rationale.length > 2000)
      violations.push(`${label}.rationale must contain 40 to 2000 characters`);
    if (/\b(?:todo|tbd|placeholder|n\/a)\b/iu.test(rationale))
      violations.push(`${label}.rationale contains placeholder text`);
    const reviewedAt = parseDate(
      entry.reviewedAt,
      `${label}.reviewedAt`,
      violations
    );
    const expiresOn = parseDay(
      entry.expiresOn,
      `${label}.expiresOn`,
      violations
    );
    if (
      reviewedAt &&
      today &&
      reviewedAt.valueOf() >= today.valueOf() + 86_400_000
    )
      violations.push(`${label}.reviewedAt is in the future`);
    if (reviewedAt && expiresOn && today) {
      const reviewedDay = new Date(
        `${reviewedAt.toISOString().slice(0, 10)}T00:00:00.000Z`
      );
      const lifetimeDays = (expiresOn - reviewedDay) / 86_400_000;
      if (lifetimeDays <= 0 || lifetimeDays > 90)
        violations.push(`${label}.expiresOn must be 1 to 90 days after review`);
      if (expiresOn < today) violations.push(`${label} is expired`);
    }
    if (!Array.isArray(entry.evidence) || entry.evidence.length === 0) {
      violations.push(`${label}.evidence must not be empty`);
    } else {
      for (const evidence of entry.evidence) {
        const safeLocal =
          typeof evidence === 'string' &&
          evidence.length > 0 &&
          !path.isAbsolute(evidence) &&
          !evidence.split(/[\\/]/u).includes('..') &&
          fs.existsSync(path.resolve(root, evidence)) &&
          fs.statSync(path.resolve(root, evidence)).isFile() &&
          fs
            .realpathSync(path.resolve(root, evidence))
            .startsWith(`${fs.realpathSync(root)}${path.sep}`);
        if (!safeLocal && !githubEvidencePattern.test(evidence ?? ''))
          violations.push(
            `${label}.evidence is missing or unsupported: ${String(evidence)}`
          );
      }
    }
    if (!fingerprints.has(entry.fingerprint))
      violations.push(`${label} does not match a current blocking finding`);
    if (
      fingerprintPattern.test(entry.fingerprint ?? '') &&
      !entries.has(entry.fingerprint)
    )
      entries.set(entry.fingerprint, entry);
  }
  return { entries, violations };
};

export const evaluateReport = ({
  config,
  report,
  triage,
  cliExit,
  baseSha,
  headSha,
  release = false,
  root = process.cwd(),
  today,
}) => {
  const violations = validateConfig(config, root);
  if (![0, 2, 3].includes(cliExit))
    violations.push(`JiTTest exited with tool failure status ${cliExit}`);
  if (!shaPattern.test(baseSha) || !shaPattern.test(headSha))
    violations.push('base and head must be full lowercase commit SHAs');
  if (cliExit === 3 && (release || baseSha !== headSha))
    violations.push(
      'JiTTest exit 3 is not valid release or differing-SHA evidence'
    );
  if (cliExit === 3 && baseSha === headSha && !release)
    return { blockers: [], fingerprints: [], violations };

  const parsedReport = jsonReportSchema.safeParse(report);
  if (!parsedReport.success)
    violations.push(
      `report does not match JiTTest ${JITTEST_VERSION}: ${parsedReport.error.issues[0]?.message ?? 'invalid report'}`
    );
  if (
    !exactKeys(
      report,
      new Set([
        'version',
        'stats',
        'reports',
        'hardeningCandidates',
        'statusMessage',
      ]),
      'report',
      violations
    )
  )
    return { blockers: [], fingerprints: [], violations };
  if (report.version !== JITTEST_VERSION)
    violations.push(`report.version must be ${JITTEST_VERSION}`);
  if (report.stats === null || !isRecord(report.stats))
    violations.push('report.stats must contain completed run statistics');
  if (!Array.isArray(report.reports))
    violations.push('report.reports must be an array');
  if (!Array.isArray(report.hardeningCandidates))
    violations.push('report.hardeningCandidates must be an array');
  if (
    typeof report.statusMessage === 'string' &&
    report.statusMessage.trim() !== ''
  )
    violations.push('report.statusMessage indicates an incomplete run');

  const reports = Array.isArray(report.reports) ? report.reports : [];
  const fingerprints = new Set();
  const blockers = [];
  for (const [index, finding] of reports.entries()) {
    const label = `report.reports[${index}]`;
    exactKeys(
      finding,
      new Set(['headline', 'senseCheck', 'details']),
      label,
      violations
    );
    exactKeys(
      finding?.details,
      new Set([
        'behaviorChange',
        'verdict',
        'assessorRationales',
        'testCode',
        'dismissalEstimate',
      ]),
      `${label}.details`,
      violations
    );
    exactKeys(
      finding?.details?.behaviorChange,
      new Set(['summary', 'parentBehavior', 'childBehavior', 'changeType']),
      `${label}.details.behaviorChange`,
      violations
    );
    if (typeof finding?.headline !== 'string')
      violations.push(`${label}.headline must be a string`);
    if (typeof finding?.senseCheck !== 'string')
      violations.push(`${label}.senseCheck must be a string`);
    const details = finding?.details;
    const behavior = details?.behaviorChange;
    if (!reportVerdicts.has(details?.verdict))
      violations.push(`${label}.details.verdict is invalid`);
    if (
      !Array.isArray(details?.assessorRationales) ||
      details.assessorRationales.some(
        (rationale) => typeof rationale !== 'string'
      )
    )
      violations.push(`${label}.details.assessorRationales must be strings`);
    if (typeof details?.testCode !== 'string')
      violations.push(`${label}.details.testCode must be a string`);
    else {
      const parsedTest = parseSync(
        'jittest.generated.test.ts',
        details.testCode,
        {
          sourceType: 'module',
        }
      );
      if (parsedTest.errors.length > 0)
        violations.push(`${label}.details.testCode must parse as TypeScript`);
    }
    if (typeof details?.dismissalEstimate !== 'string')
      violations.push(`${label}.details.dismissalEstimate must be a string`);
    for (const field of ['summary', 'parentBehavior', 'childBehavior'])
      if (typeof behavior?.[field] !== 'string')
        violations.push(
          `${label}.details.behaviorChange.${field} must be a string`
        );
    if (!behaviorChangeTypes.has(behavior?.changeType))
      violations.push(`${label}.details.behaviorChange.changeType is invalid`);
    if (!blockingVerdicts.has(finding?.details?.verdict)) continue;
    if (
      typeof finding?.details?.testCode !== 'string' ||
      !isRecord(finding?.details?.behaviorChange)
    ) {
      violations.push(`${label} cannot be fingerprinted`);
      continue;
    }
    const fingerprint = fingerprintFinding(finding);
    fingerprints.add(fingerprint);
    blockers.push({
      fingerprint,
      headline: finding.headline,
      verdict: finding.details.verdict,
    });
  }
  if (blockers.length !== fingerprints.size)
    violations.push(
      'duplicate blocking fingerprints are ambiguous and cannot be triaged'
    );

  const stats = report.stats;
  const usage = stats?.llmUsage;
  const budget = usage?.budget;
  if (stats?.reportsGenerated !== reports.length)
    violations.push('report count does not match stats.reportsGenerated');
  if (!isRecord(usage) || !isRecord(budget)) {
    violations.push('report stats are missing LLM budget evidence');
  } else {
    if (usage.costKnown !== true)
      violations.push('LLM cost accounting is unknown');
    if (usage.cacheHits !== 0)
      violations.push('release evidence must not contain cache hits');
    if (budget.maxCostUsd !== MAX_COST_USD || budget.maxTokens !== MAX_TOKENS)
      violations.push('report budget does not match the committed ceilings');
    if (budget.status !== 'within-budget')
      violations.push('JiTTest exhausted its run budget');
    if (budget.skippedCalls !== 0) violations.push('JiTTest skipped LLM calls');
    if (budget.dollarBudgetEnforced !== true)
      violations.push('OpenRouter dollar budget was not enforced');
    if (usage.totalCostUsd > MAX_COST_USD)
      violations.push('JiTTest exceeded the dollar ceiling');
    if (usage.totalTokens > MAX_TOKENS)
      violations.push('JiTTest exceeded the token ceiling');
    if (usage.totalInputTokens + usage.totalOutputTokens !== usage.totalTokens)
      violations.push('LLM token totals are inconsistent');
    if (!Array.isArray(usage.events))
      violations.push('LLM usage audit events are missing');
    else
      for (const event of usage.events)
        if (badBudgetEvents.has(event?.type))
          violations.push(`LLM usage contains ${event.type}`);
    const callEvents = Array.isArray(usage.events)
      ? usage.events.filter((event) => event?.type === 'call')
      : [];
    if (
      callEvents.length !== usage.callCount ||
      callEvents.some(
        (event) =>
          event.model !== JITTEST_MODEL ||
          event.costKnown !== true ||
          typeof event.costUsd !== 'number'
      )
    )
      violations.push('LLM call audit events are inconsistent');
    else {
      const eventInputTokens = callEvents.reduce(
        (sum, event) => sum + event.inputTokens,
        0
      );
      const eventOutputTokens = callEvents.reduce(
        (sum, event) => sum + event.outputTokens,
        0
      );
      const eventCost = callEvents.reduce(
        (sum, event) => sum + event.costUsd,
        0
      );
      if (
        eventInputTokens !== usage.totalInputTokens ||
        eventOutputTokens !== usage.totalOutputTokens ||
        Math.abs(eventCost - usage.totalCostUsd) > 1e-9
      )
        violations.push('LLM call audit totals are inconsistent');
    }
    if (
      !Array.isArray(usage.byModel) ||
      usage.byModel.length === 0 ||
      usage.byModel.some((item) => item?.model !== JITTEST_MODEL)
    )
      violations.push('LLM usage contains an unexpected model');
    else {
      const modelInputTokens = usage.byModel.reduce(
        (sum, item) => sum + item.inputTokens,
        0
      );
      const modelOutputTokens = usage.byModel.reduce(
        (sum, item) => sum + item.outputTokens,
        0
      );
      const modelCost = usage.byModel.reduce(
        (sum, item) => sum + item.costUsd,
        0
      );
      if (
        usage.byModel.some((item) => item.costKnown !== true) ||
        usage.byModel.reduce((sum, item) => sum + item.callCount, 0) !==
          usage.callCount ||
        modelInputTokens !== usage.totalInputTokens ||
        modelOutputTokens !== usage.totalOutputTokens ||
        Math.abs(modelCost - usage.totalCostUsd) > 1e-9
      )
        violations.push('per-model LLM accounting is inconsistent');
    }
    if (usage.callCount !== stats.llmCallCount)
      violations.push('LLM call counts are inconsistent');
  }

  if (stats?.hardeningCandidateCount !== report.hardeningCandidates?.length)
    violations.push(
      'hardening candidate count does not match report statistics'
    );

  const validatedTriage = validateTriage(triage, fingerprints, { root, today });
  violations.push(...validatedTriage.violations);
  const untriaged = blockers.filter(
    ({ fingerprint }) => !validatedTriage.entries.has(fingerprint)
  );
  if (blockers.length > 0 && cliExit !== 2)
    violations.push('blocking reports require JiTTest exit 2');
  if (cliExit === 2 && blockers.length === 0)
    violations.push('JiTTest exit 2 has no blocking report');
  return {
    blockers: untriaged,
    fingerprints: [...fingerprints].sort((left, right) =>
      left.localeCompare(right)
    ),
    violations,
  };
};

const parseArguments = (argv) => {
  const values = { release: false };
  const valueOptions = new Set([
    'config',
    'report',
    'triage',
    'cli-exit',
    'base-sha',
    'head-sha',
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--release') values.release = true;
    else if (argument.startsWith('--')) {
      const option = argument.slice(2);
      if (!valueOptions.has(option))
        throw new Error(`Unknown option ${argument}`);
      const value = argv[++index];
      if (value === undefined || value.startsWith('--'))
        throw new Error(`${argument} requires a value`);
      values[option] = value;
    } else throw new Error(`Unexpected argument ${argument}`);
  }
  return values;
};

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

export const runCli = (argv = process.argv.slice(2)) => {
  const args = parseArguments(argv);
  for (const required of [
    'config',
    'triage',
    'cli-exit',
    'base-sha',
    'head-sha',
  ]) {
    if (args[required] === undefined)
      throw new Error(`--${required} is required`);
  }
  const cliExit = Number(args['cli-exit']);
  const report = cliExit === 3 ? {} : readJson(args.report);
  const result = evaluateReport({
    config: readJson(args.config),
    triage: readJson(args.triage),
    report,
    cliExit,
    baseSha: args['base-sha'],
    headSha: args['head-sha'],
    release: args.release,
  });
  for (const violation of result.violations)
    console.error(`JiTTest evidence error: ${violation}`);
  for (const blocker of result.blockers)
    console.error(
      `JiTTest ${blocker.verdict}: ${blocker.fingerprint} ${blocker.headline ?? ''}`.trim()
    );
  return result.violations.length === 0 && result.blockers.length === 0 ? 0 : 1;
};

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    process.exitCode = runCli();
  } catch (error) {
    console.error(
      `JiTTest evidence error: ${error instanceof Error ? error.message : String(error)}`
    );
    process.exitCode = 1;
  }
}
