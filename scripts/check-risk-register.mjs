import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
const registerPath = path.join(root, 'docs/security-risk-register.md');
const snapshotPath = path.join(root, 'docs/security-audit.snapshot.json');
const dependencyInputFiles = [
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
];
const riskSectionHeadings = [
  'Temporary Accepted Dependency Advisories',
  'Accepted Pre-release Dependencies',
];
const isoDatePattern = /^\d{4}-\d{2}-\d{2}$/;
const severityValues = new Set(['info', 'low', 'moderate', 'high', 'critical']);

export function isIsoCalendarDate(value) {
  if (typeof value !== 'string' || !isoDatePattern.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return (
    parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === month - 1 &&
    parsed.getUTCDate() === day
  );
}

function assertIsoCalendarDate(value) {
  if (!isIsoCalendarDate(value)) throw new Error(`Invalid ISO date: ${value}`);
}

function readSection(markdown, heading) {
  const marker = `## ${heading}`;
  const start = markdown.indexOf(marker);
  if (start < 0) return '';
  const content = markdown.slice(start + marker.length);
  const nextHeading = content.search(/\n##\s/u);
  return nextHeading < 0 ? content : content.slice(0, nextHeading);
}

function parseTableCells(line) {
  return line
    .split('|')
    .map((cell) => cell.trim())
    .filter((cell) => cell.length > 0);
}

function parsePackageNames(packageCell) {
  return [...packageCell.matchAll(/`([^`]+)`/gu)].map(
    (match) => match[1].trim().split(/\s+/u)[0]
  );
}

export function parseRiskEntries(markdown) {
  const entries = [];
  const policyMarkdown = riskSectionHeadings
    .map((heading) => readSection(markdown, heading))
    .join('\n');

  for (const line of policyMarkdown.split('\n')) {
    if (!line.trimStart().startsWith('|')) continue;

    const cells = parseTableCells(line);
    const reviewDate = cells.at(-1);
    if (!reviewDate || !isoDatePattern.test(reviewDate)) continue;
    assertIsoCalendarDate(reviewDate);

    entries.push({
      package: cells[0],
      packageNames: parsePackageNames(cells[0]),
      reviewDate,
      advisoryIds: [...line.matchAll(/GHSA-[\dA-Za-z-]+/gu)].map(
        (match) => match[0]
      ),
    });
  }

  return entries;
}

export function parseAcceptedAdvisories(markdown) {
  return parseRiskEntries(markdown).map((entry) => ({
    advisory: entry.package,
    reviewDate: entry.reviewDate,
  }));
}

export function findExpiredAdvisories(markdown, todayIsoDate) {
  assertIsoCalendarDate(todayIsoDate);
  return parseAcceptedAdvisories(markdown).filter(
    (entry) => entry.reviewDate < todayIsoDate
  );
}

function isRiskActive(entry, snapshot) {
  const activeAdvisories = new Set(
    snapshot.advisories.map((advisory) => advisory.id)
  );
  const trackedPackages = new Set(snapshot.trackedPackages);
  return (
    entry.advisoryIds.some((id) => activeAdvisories.has(id)) ||
    entry.packageNames.some((packageName) => trackedPackages.has(packageName))
  );
}

export function findExpiredActiveRisks(markdown, todayIsoDate, snapshot) {
  assertIsoCalendarDate(todayIsoDate);
  return parseRiskEntries(markdown).filter(
    (entry) => entry.reviewDate < todayIsoDate && isRiskActive(entry, snapshot)
  );
}

export function findExpiredInactiveRisks(markdown, todayIsoDate, snapshot) {
  assertIsoCalendarDate(todayIsoDate);
  return parseRiskEntries(markdown).filter(
    (entry) => entry.reviewDate < todayIsoDate && !isRiskActive(entry, snapshot)
  );
}

export function computeDependencyStateDigest(rootDirectory = root) {
  const digest = crypto.createHash('sha256');
  for (const inputFile of dependencyInputFiles) {
    const contents = fs.readFileSync(path.join(rootDirectory, inputFile));
    digest.update(inputFile);
    digest.update('\0');
    digest.update(contents);
    digest.update('\0');
  }
  return digest.digest('hex');
}

export function validateSecuritySnapshot(
  markdown,
  snapshot,
  expectedDependencyStateSha256
) {
  if (
    snapshot?.schemaVersion !== 1 ||
    !Array.isArray(snapshot.advisories) ||
    !Array.isArray(snapshot.trackedPackages)
  ) {
    return ['security snapshot does not match schema version 1'];
  }

  const violations = [];
  if (
    typeof snapshot.generatedAt !== 'string' ||
    !Number.isFinite(Date.parse(snapshot.generatedAt))
  ) {
    violations.push('security snapshot generatedAt is invalid');
  }
  if (!/^[\da-f]{64}$/u.test(snapshot.dependencyStateSha256 ?? '')) {
    violations.push('security snapshot dependency digest is invalid');
  } else if (
    expectedDependencyStateSha256 &&
    snapshot.dependencyStateSha256 !== expectedDependencyStateSha256
  ) {
    violations.push(
      'security snapshot is stale for package.json, pnpm-lock.yaml, or pnpm-workspace.yaml; run pnpm security:refresh and review the result'
    );
  }

  const seenAdvisories = new Set();
  for (const advisory of snapshot.advisories) {
    if (
      !advisory ||
      typeof advisory.id !== 'string' ||
      !/^GHSA-[\dA-Za-z-]+$/u.test(advisory.id) ||
      typeof advisory.module !== 'string' ||
      advisory.module.length === 0 ||
      typeof advisory.title !== 'string' ||
      !severityValues.has(advisory.severity)
    ) {
      violations.push('security snapshot contains a malformed advisory');
      continue;
    }
    const identity = `${advisory.id}:${advisory.module}`;
    if (seenAdvisories.has(identity)) {
      violations.push(`security snapshot repeats advisory ${identity}`);
    }
    seenAdvisories.add(identity);
  }

  if (
    snapshot.trackedPackages.some(
      (packageName) =>
        typeof packageName !== 'string' || packageName.length === 0
    ) ||
    new Set(snapshot.trackedPackages).size !== snapshot.trackedPackages.length
  ) {
    violations.push('security snapshot contains invalid tracked packages');
  }

  const acceptedRisks = parseRiskEntries(markdown);
  for (const advisory of snapshot.advisories) {
    if (!advisory || typeof advisory !== 'object') continue;
    if (advisory.severity === 'critical' || advisory.severity === 'high') {
      violations.push(
        `${advisory.id} (${advisory.module}) is ${advisory.severity} and must be fixed`
      );
      continue;
    }
    const isAccepted = acceptedRisks.some(
      (entry) =>
        entry.advisoryIds.includes(advisory.id) &&
        entry.packageNames.includes(advisory.module)
    );
    if (!isAccepted) {
      violations.push(
        `${advisory.id} (${advisory.module}) is active but missing from the risk register`
      );
    }
  }

  return violations;
}

function readRegister() {
  if (!fs.existsSync(registerPath)) {
    throw new Error(`Missing risk register: ${registerPath}`);
  }
  return fs.readFileSync(registerPath, 'utf8');
}

function readSnapshot() {
  if (!fs.existsSync(snapshotPath)) {
    throw new Error(
      `Missing deterministic security snapshot: ${snapshotPath}. Run pnpm security:refresh and review the result.`
    );
  }
  return JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
}

function main() {
  const markdown = readRegister();
  const snapshot = readSnapshot();
  const entries = parseRiskEntries(markdown);

  if (markdown.includes('Next review') && entries.length === 0) {
    console.error(
      'Risk register policy failed: the register declares review dates but none could be parsed; fix the table format or this check.'
    );
    process.exit(1);
  }

  const snapshotViolations = validateSecuritySnapshot(
    markdown,
    snapshot,
    computeDependencyStateDigest()
  );
  if (snapshotViolations.length > 0) {
    console.error('Security snapshot policy failed:');
    for (const violation of snapshotViolations) console.error(`- ${violation}`);
    process.exit(1);
  }

  const today = new Date().toISOString().slice(0, 10);
  const expiredActive = findExpiredActiveRisks(markdown, today, snapshot);
  if (expiredActive.length > 0) {
    console.error(
      'Risk register policy failed: active accepted risks are past their review date:'
    );
    for (const entry of expiredActive) {
      console.error(`- ${entry.package} (review was due ${entry.reviewDate})`);
    }
    console.error(
      'Re-review each risk in docs/security-risk-register.md: fix it or extend the review date with justification.'
    );
    process.exit(1);
  }

  const expiredInactive = findExpiredInactiveRisks(markdown, today, snapshot);
  if (expiredInactive.length > 0) {
    console.warn(
      'Risk register review requested for resolved or inactive rows:'
    );
    for (const entry of expiredInactive) {
      console.warn(`- ${entry.package} (review was due ${entry.reviewDate})`);
    }
  }

  console.log(
    `Risk register policy passed (${entries.length} accepted risks, no expired active entries).`
  );
}

if (
  process.argv[1] &&
  pathToFileURL(process.argv[1]).href === import.meta.url
) {
  main();
}
