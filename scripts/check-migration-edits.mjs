import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { resolveBase, runGitStrict } from './lib/git-utils.mjs';

const MIGRATIONS_DIR = 'drizzle/migrations';
const SCHEMA_PATHS = [
  'src/modules/kernel/infrastructure/db/schema.ts',
  'src/modules/kernel/infrastructure/db/schema',
  'src/modules/*/infrastructure/drizzle/schema.ts',
];
const SQL_MIGRATION_PATTERN = /^drizzle\/migrations\/.*\.sql$/;
const SNAPSHOT_PATTERN = /^drizzle\/migrations\/meta\/(\d{4})_snapshot\.json$/;
const JOURNAL_PATH = 'drizzle/migrations/meta/_journal.json';
const IMMUTABLE_MIGRATION_PATTERN = (filePath) =>
  SQL_MIGRATION_PATTERN.test(filePath) || SNAPSHOT_PATTERN.test(filePath);

const splitNul = (output) => output.split('\0').filter(Boolean);

const parseNameStatus = (output, source) => {
  const fields = splitNul(output);
  const changes = [];

  for (let index = 0; index < fields.length; index += 1) {
    const rawStatus = fields[index];
    const status = rawStatus?.[0];

    if (!rawStatus || !status) continue;

    if (status === 'R' || status === 'C') {
      const oldPath = fields[index + 1];
      const filePath = fields[index + 2];
      index += 2;
      if (oldPath && filePath) {
        changes.push({ source, status, rawStatus, oldPath, filePath });
      }
      continue;
    }

    const filePath = fields[index + 1];
    index += 1;
    if (filePath) {
      changes.push({ source, status, rawStatus, filePath });
    }
  }

  return changes;
};

const listBaseMigrationArtifacts = (base) =>
  new Set(
    splitNul(
      runGitStrict([
        'ls-tree',
        '-r',
        '-z',
        '--name-only',
        base,
        '--',
        MIGRATIONS_DIR,
      ])
    ).filter(IMMUTABLE_MIGRATION_PATTERN)
  );

const collectMigrationChanges = (base) => [
  ...parseNameStatus(
    runGitStrict([
      'diff',
      '--name-status',
      '-z',
      '--find-renames',
      `${base}...HEAD`,
      '--',
      MIGRATIONS_DIR,
    ]),
    'committed'
  ),
  ...parseNameStatus(
    runGitStrict([
      'diff',
      '--name-status',
      '-z',
      '--find-renames',
      '--cached',
      '--',
      MIGRATIONS_DIR,
    ]),
    'staged'
  ),
  ...parseNameStatus(
    runGitStrict([
      'diff',
      '--name-status',
      '-z',
      '--find-renames',
      '--',
      MIGRATIONS_DIR,
    ]),
    'unstaged'
  ),
];

const collectUntrackedMigrationArtifacts = () =>
  splitNul(
    runGitStrict([
      'ls-files',
      '--others',
      '--exclude-standard',
      '-z',
      '--',
      MIGRATIONS_DIR,
    ])
  ).filter(IMMUTABLE_MIGRATION_PATTERN);

const collectCurrentMigrationArtifacts = () =>
  new Set(
    splitNul(
      runGitStrict([
        'ls-files',
        '--cached',
        '--others',
        '--exclude-standard',
        '-z',
        '--',
        MIGRATIONS_DIR,
      ])
    ).filter(IMMUTABLE_MIGRATION_PATTERN)
  );

const hasSchemaChanges = (base) => {
  const committed = splitNul(
    runGitStrict([
      'diff',
      '--name-only',
      '-z',
      `${base}...HEAD`,
      '--',
      ...SCHEMA_PATHS,
    ])
  ).length;
  const staged = splitNul(
    runGitStrict([
      'diff',
      '--name-only',
      '-z',
      '--cached',
      '--',
      ...SCHEMA_PATHS,
    ])
  ).length;
  const unstaged = splitNul(
    runGitStrict(['diff', '--name-only', '-z', '--', ...SCHEMA_PATHS])
  ).length;
  const untracked = splitNul(
    runGitStrict([
      'ls-files',
      '--others',
      '--exclude-standard',
      '-z',
      '--',
      ...SCHEMA_PATHS,
    ])
  ).length;

  return committed > 0 || staged > 0 || unstaged > 0 || untracked > 0;
};

const formatChange = (change) => {
  if (change.oldPath) {
    return `[${change.source}] ${change.rawStatus} ${change.oldPath} -> ${change.filePath}`;
  }

  return `[${change.source}] ${change.rawStatus} ${change.filePath}`;
};

const addUnique = (map, key, value) => {
  if (!map.has(key)) {
    map.set(key, value);
  }
};

const readJournal = (source, contents) => {
  try {
    const parsed = JSON.parse(contents);
    if (!Array.isArray(parsed.entries)) {
      throw new TypeError('entries must be an array');
    }
    return parsed;
  } catch (error) {
    throw new Error(`Cannot parse ${source}: ${error.message}`, {
      cause: error,
    });
  }
};

const sameJson = (left, right) =>
  JSON.stringify(left) === JSON.stringify(right);

const base = resolveBase();
const baseMigrationArtifacts = listBaseMigrationArtifacts(base);
const migrationChanges = collectMigrationChanges(base);
const untrackedMigrationArtifacts = collectUntrackedMigrationArtifacts();
const currentMigrationArtifacts = collectCurrentMigrationArtifacts();
const immutableMigrationViolations = new Map();
const newMigrationPaths = new Map();

for (const change of migrationChanges) {
  const filePathIsArtifact = IMMUTABLE_MIGRATION_PATTERN(change.filePath);
  const oldPathIsArtifact =
    change.oldPath !== undefined && IMMUTABLE_MIGRATION_PATTERN(change.oldPath);

  if (!filePathIsArtifact && !oldPathIsArtifact) continue;

  if (
    oldPathIsArtifact &&
    change.oldPath !== undefined &&
    baseMigrationArtifacts.has(change.oldPath)
  ) {
    addUnique(
      immutableMigrationViolations,
      `${change.source}:${change.rawStatus}:${change.oldPath}:${change.filePath}`,
      formatChange(change)
    );
    continue;
  }

  if (filePathIsArtifact && baseMigrationArtifacts.has(change.filePath)) {
    addUnique(
      immutableMigrationViolations,
      `${change.source}:${change.rawStatus}:${change.filePath}`,
      formatChange(change)
    );
    continue;
  }

  if (filePathIsArtifact && ['A', 'C', 'M'].includes(change.status)) {
    addUnique(newMigrationPaths, change.filePath, formatChange(change));
  }
}

for (const filePath of untrackedMigrationArtifacts) {
  addUnique(newMigrationPaths, filePath, `[untracked] A ${filePath}`);
}

const schemaChanged = hasSchemaChanges(base);
const newMigrationViolations = schemaChanged
  ? []
  : [...newMigrationPaths.values()];

const integrityViolations = [];
const baseJournalDocument = readJournal(
  `${base}:${JOURNAL_PATH}`,
  runGitStrict(['show', `${base}:${JOURNAL_PATH}`])
);
const currentJournalDocument = readJournal(
  JOURNAL_PATH,
  fs.readFileSync(JOURNAL_PATH, 'utf8')
);
const baseJournal = baseJournalDocument.entries;
const currentJournal = currentJournalDocument.entries;
const { entries: _baseEntries, ...baseJournalMetadata } = baseJournalDocument;
const { entries: _currentEntries, ...currentJournalMetadata } =
  currentJournalDocument;

if (!sameJson(baseJournalMetadata, currentJournalMetadata)) {
  integrityViolations.push(
    'Migration journal version, dialect, and other top-level metadata are immutable.'
  );
}

if (currentJournal.length < baseJournal.length) {
  integrityViolations.push('Migration journal entries may not be removed.');
} else {
  for (const [index, entry] of baseJournal.entries()) {
    if (!sameJson(entry, currentJournal[index])) {
      integrityViolations.push(
        `Migration journal entry ${index} is immutable and was changed.`
      );
    }
  }
}

const appendedJournal = currentJournal.slice(baseJournal.length);
for (const [offset, entry] of appendedJournal.entries()) {
  const expectedIndex = baseJournal.length + offset;
  if (entry.idx !== expectedIndex) {
    integrityViolations.push(
      `Migration journal entry ${expectedIndex} must use idx ${expectedIndex}.`
    );
    continue;
  }
  const expectedPrefix = String(expectedIndex).padStart(4, '0');
  if (
    typeof entry.tag !== 'string' ||
    !/^\d{4}_[A-Za-z0-9_]+$/u.test(entry.tag) ||
    !entry.tag.startsWith(`${expectedPrefix}_`)
  ) {
    integrityViolations.push(
      `Migration journal entry ${expectedIndex} has an invalid tag.`
    );
    continue;
  }
  const sqlPath = `${MIGRATIONS_DIR}/${entry.tag}.sql`;
  const snapshotPath = `${MIGRATIONS_DIR}/meta/${String(entry.idx).padStart(4, '0')}_snapshot.json`;
  if (!currentMigrationArtifacts.has(sqlPath)) {
    integrityViolations.push(`${entry.tag} is missing ${sqlPath}.`);
  } else if (!newMigrationPaths.has(sqlPath)) {
    integrityViolations.push(`${entry.tag} does not reference a new SQL file.`);
  }
  if (!currentMigrationArtifacts.has(snapshotPath)) {
    integrityViolations.push(`${entry.tag} is missing ${snapshotPath}.`);
  } else if (!newMigrationPaths.has(snapshotPath)) {
    integrityViolations.push(`${entry.tag} does not reference a new snapshot.`);
  }
}

const runSchemaDriftGeneration = (drizzleKit, temporaryMigrations) =>
  spawnSync(
    drizzleKit,
    [
      'generate',
      '--dialect',
      'postgresql',
      '--schema',
      'src/modules/kernel/infrastructure/db/schema/index.ts',
      '--out',
      temporaryMigrations,
      '--name',
      'schema_drift_check',
    ],
    {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: { ...process.env, CI: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
    }
  );

const formatSchemaDriftFailure = (detail) =>
  detail.length > 0
    ? `drizzle-kit schema drift check failed: ${detail}`
    : 'drizzle-kit schema drift check failed.';

const getSchemaDriftExecutionFailure = (result) => {
  if (result.error) {
    return `Unable to compare schema with the latest snapshot: ${result.error.message}`;
  }
  if (result.status === 0) return null;
  const detail = (result.stderr || result.stdout).trim();
  return formatSchemaDriftFailure(detail);
};

const compareTemporaryJournal = (temporaryMigrations) => {
  const copiedJournal = readJournal(
    'temporary migration journal',
    fs.readFileSync(
      path.join(temporaryMigrations, 'meta/_journal.json'),
      'utf8'
    )
  );
  return copiedJournal.entries.length === currentJournal.length
    ? null
    : 'Current Drizzle schema differs from the latest generated snapshot; run pnpm db:generate.';
};

const checkCurrentSchemaMatchesLatestSnapshot = () => {
  const drizzleKit = path.resolve('node_modules/.bin/drizzle-kit');
  if (!fs.existsSync(drizzleKit)) {
    return 'Pinned drizzle-kit is unavailable; run pnpm install --frozen-lockfile.';
  }
  fs.mkdirSync('test-results', { recursive: true });
  const temporaryRoot = fs.mkdtempSync(
    path.join('test-results', '.migration-drift-')
  );
  const temporaryMigrations = path.join(temporaryRoot, 'migrations');
  try {
    fs.cpSync(MIGRATIONS_DIR, temporaryMigrations, { recursive: true });
    const result = runSchemaDriftGeneration(drizzleKit, temporaryMigrations);
    const executionFailure = getSchemaDriftExecutionFailure(result);
    return executionFailure ?? compareTemporaryJournal(temporaryMigrations);
  } finally {
    fs.rmSync(temporaryRoot, { force: true, recursive: true });
  }
};

const schemaDriftViolation = checkCurrentSchemaMatchesLatestSnapshot();
if (schemaDriftViolation) integrityViolations.push(schemaDriftViolation);

for (const filePath of newMigrationPaths.keys()) {
  if (SQL_MIGRATION_PATTERN.test(filePath)) {
    const tag = filePath.slice(`${MIGRATIONS_DIR}/`.length, -'.sql'.length);
    if (!appendedJournal.some((entry) => entry.tag === tag)) {
      integrityViolations.push(`${filePath} has no appended journal entry.`);
    }
  }
  const snapshot = SNAPSHOT_PATTERN.exec(filePath);
  if (snapshot) {
    const index = Number(snapshot[1]);
    if (!appendedJournal.some((entry) => entry.idx === index)) {
      integrityViolations.push(`${filePath} has no appended journal entry.`);
    }
  }
}

if (schemaChanged && appendedJournal.length === 0) {
  integrityViolations.push(
    'Schema changes require a generated SQL migration, snapshot, and appended journal entry.'
  );
}

const snapshotPaths = [...currentMigrationArtifacts]
  .filter((filePath) => SNAPSHOT_PATTERN.test(filePath))
  .toSorted((left, right) => left.localeCompare(right));
let previousSnapshotId = '00000000-0000-0000-0000-000000000000';
for (const snapshotPath of snapshotPaths) {
  try {
    const snapshot = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
    if (snapshot.prevId !== previousSnapshotId) {
      integrityViolations.push(
        `${snapshotPath} prevId does not match the preceding snapshot id.`
      );
    }
    if (typeof snapshot.id !== 'string' || snapshot.id.length === 0) {
      integrityViolations.push(`${snapshotPath} has no valid snapshot id.`);
      continue;
    }
    previousSnapshotId = snapshot.id;
  } catch (error) {
    integrityViolations.push(
      `${snapshotPath} is not valid JSON: ${error.message}`
    );
  }
}

if (
  immutableMigrationViolations.size === 0 &&
  newMigrationViolations.length === 0 &&
  integrityViolations.length === 0
) {
  console.log('Migration edit guard passed.');
  process.exit(0);
}

console.error('Migration edit guard failed.');

if (immutableMigrationViolations.size > 0) {
  console.error(
    '\nExisting migration SQL and snapshot files may not be modified, deleted, or renamed:'
  );
  for (const violation of immutableMigrationViolations.values()) {
    console.error(`- ${violation}`);
  }
}

if (integrityViolations.length > 0) {
  console.error('\nMigration artifact integrity violations:');
  for (const violation of integrityViolations) {
    console.error(`- ${violation}`);
  }
}

if (newMigrationViolations.length > 0) {
  console.error(
    `\nNew migration SQL files require schema changes in ${SCHEMA_PATHS.join(
      ' or '
    )}:`
  );
  for (const violation of newMigrationViolations) {
    console.error(`- ${violation}`);
  }
}

process.exit(1);
