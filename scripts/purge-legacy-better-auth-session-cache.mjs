import { pathToFileURL } from 'node:url';
import { z } from 'zod';

const ACTIVE_SESSION_PREFIX = 'active-sessions-';
const VERIFICATION_PREFIX = 'verification:';
const DELETE_BATCH_SIZE = 100;
const MAX_SCAN_PAGES = 10_000;
const MAX_SCANNED_KEYS = 100_000;
const REQUEST_TIMEOUT_MS = 5_000;

const scanResultSchema = z.tuple([z.string(), z.array(z.string())]);
const errorEnvelopeSchema = z.object({ error: z.string() }).passthrough();
const resultEnvelopeSchema = z
  .object({ result: z.unknown() })
  .passthrough()
  .refine((value) => Object.hasOwn(value, 'result'));
const destructiveCliSchema = z
  .object({
    dedicatedDatabaseConfirmed: z.boolean(),
    drainedConfirmed: z.boolean(),
    dryRun: z.boolean(),
    yes: z.boolean(),
  })
  .refine(
    (value) =>
      value.dryRun ||
      (value.yes && value.drainedConfirmed && value.dedicatedDatabaseConfirmed)
  );
const sessionTokenSchema = z
  .string()
  .length(32)
  .regex(/^[A-Za-z0-9]+$/u);
const activeSessionIndexSchema = z.array(
  z
    .object({
      expiresAt: z.number().finite(),
      token: sessionTokenSchema,
    })
    .passthrough()
);
const sessionSnapshotSchema = z
  .object({
    session: z
      .object({
        token: sessionTokenSchema,
        userId: z.string().min(1),
      })
      .passthrough(),
    user: z.object({ id: z.string().min(1) }).passthrough(),
  })
  .passthrough();

const parseJson = (value, message) => {
  try {
    return JSON.parse(value);
  } catch (cause) {
    throw new Error(message, { cause });
  }
};

const parseActiveSessionTokens = (value) => {
  const result = activeSessionIndexSchema.safeParse(
    parseJson(value, 'A legacy active-session index is not valid JSON.')
  );
  if (result.success) return result.data.map((entry) => entry.token);
  throw new Error('A legacy active-session index has an invalid shape.', {
    cause: result.error,
  });
};

const isSessionSnapshotForToken = (value, token) => {
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    return false;
  }
  const result = sessionSnapshotSchema.safeParse(parsed);
  return (
    result.success &&
    result.data.session.token === token &&
    result.data.session.userId === result.data.user.id
  );
};

const readScanPage = async (command, cursor) => {
  const result = scanResultSchema.safeParse(
    await command(['SCAN', cursor, 'MATCH', '*', 'COUNT', 100])
  );
  if (!result.success) {
    throw new Error('Upstash returned an invalid SCAN response.');
  }
  return result.data;
};

const addScannedKeys = (keys, pageKeys) => {
  for (const key of pageKeys) {
    keys.add(key);
    if (keys.size > MAX_SCANNED_KEYS) {
      throw new Error('Redis key scan exceeded the safe key limit.');
    }
  }
};

const assertFreshCursor = (seenCursors, cursor) => {
  if (cursor === '0') return;
  if (seenCursors.has(cursor)) {
    throw new Error('Upstash returned a repeated SCAN cursor.');
  }
  seenCursors.add(cursor);
};

const scanAllKeys = async (command) => {
  const keys = new Set();
  const seenCursors = new Set();
  let cursor = '0';
  let pages = 0;

  do {
    pages += 1;
    if (pages > MAX_SCAN_PAGES) {
      throw new Error('Redis key scan exceeded the safe page limit.');
    }
    const [nextCursor, pageKeys] = await readScanPage(command, cursor);
    assertFreshCursor(seenCursors, nextCursor);
    cursor = nextCursor;
    addScannedKeys(keys, pageKeys);
  } while (cursor !== '0');

  return keys;
};

const readStringOrExpiry = async (command, key) => {
  const value = await command(['GET', key]);
  if (value === null) return null;
  if (typeof value !== 'string') {
    throw new Error('Upstash returned a non-string cache value.');
  }
  return value;
};

const isOrphanedSessionSnapshot = async (command, key) => {
  if (!sessionTokenSchema.safeParse(key).success) return false;
  const value = await readStringOrExpiry(command, key);
  return value !== null && isSessionSnapshotForToken(value, key);
};

const collectOrphanSnapshotKeys = async (command, scannedKeys) => {
  const snapshotKeys = new Set();
  for (const key of scannedKeys) {
    if (await isOrphanedSessionSnapshot(command, key)) snapshotKeys.add(key);
  }
  return snapshotKeys;
};

const validateIndexedSnapshot = async (command, token) => {
  const snapshot = await readStringOrExpiry(command, token);
  if (snapshot === null) return false;
  if (!isSessionSnapshotForToken(snapshot, token)) {
    throw new Error(
      'A legacy active-session index references a non-session key.'
    );
  }
  return true;
};

const validateSessionIndex = async (command, indexKey, snapshotKeys) => {
  const value = await readStringOrExpiry(command, indexKey);
  if (value === null) return false;
  for (const token of parseActiveSessionTokens(value)) {
    if (await validateIndexedSnapshot(command, token)) snapshotKeys.add(token);
  }
  return true;
};

const collectLiveIndexKeys = async (command, indexKeys, snapshotKeys) => {
  const liveIndexKeys = new Set();
  for (const indexKey of indexKeys) {
    if (await validateSessionIndex(command, indexKey, snapshotKeys)) {
      liveIndexKeys.add(indexKey);
    }
  }
  return liveIndexKeys;
};

const collectLegacyKeys = async (command, scannedKeys) => {
  const indexKeys = [...scannedKeys].filter((key) =>
    key.startsWith(ACTIVE_SESSION_PREFIX)
  );
  const verificationKeys = [...scannedKeys].filter((key) =>
    key.startsWith(VERIFICATION_PREFIX)
  );
  const snapshotKeys = await collectOrphanSnapshotKeys(command, scannedKeys);
  const liveIndexKeys = await collectLiveIndexKeys(
    command,
    indexKeys,
    snapshotKeys
  );
  const keysToDelete = new Set([
    ...snapshotKeys,
    ...liveIndexKeys,
    ...verificationKeys,
  ]);
  return { indexKeys, keysToDelete, snapshotKeys, verificationKeys };
};

const parseDeletedCount = (value, batchSize) => {
  const parsed = z.number().int().nonnegative().safeParse(value);
  if (!parsed.success || parsed.data > batchSize) {
    throw new Error('Upstash returned an invalid DEL response.');
  }
  return parsed.data;
};

const deleteLegacyKeys = async (command, keysToDelete) => {
  const keys = [...keysToDelete];
  let deletedKeys = 0;
  for (let offset = 0; offset < keys.length; offset += DELETE_BATCH_SIZE) {
    const batch = keys.slice(offset, offset + DELETE_BATCH_SIZE);
    const deleted = await command(['DEL', ...batch]);
    deletedKeys += parseDeletedCount(deleted, batch.length);
  }
  return deletedKeys;
};

export async function purgeLegacyBetterAuthSessionCache({
  command,
  dedicatedDatabaseConfirmed = false,
  dryRun,
}) {
  if (!dryRun && !dedicatedDatabaseConfirmed) {
    throw new Error(
      'Refusing to delete from Redis without dedicated-database confirmation.'
    );
  }
  const scannedKeys = await scanAllKeys(command);
  const inventory = await collectLegacyKeys(command, scannedKeys);
  const deletedKeys = dryRun
    ? 0
    : await deleteLegacyKeys(command, inventory.keysToDelete);

  return {
    deletedKeys,
    indexKeys: inventory.indexKeys.length,
    plannedKeys: inventory.keysToDelete.size,
    sessionSnapshotKeys: inventory.snapshotKeys.size,
    verificationKeys: inventory.verificationKeys.length,
  };
}

const parseUpstashEnvelope = (body) => {
  const error = errorEnvelopeSchema.safeParse(body);
  if (error.success) throw new Error(error.data.error);
  const result = resultEnvelopeSchema.safeParse(body);
  if (!result.success) {
    throw new Error('Upstash returned an invalid response envelope.');
  }
  return result.data.result;
};

const requestUpstash = async ({
  args,
  fetchFn,
  restToken,
  restUrl,
  timeoutMs,
}) => {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchFn(restUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${restToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(args),
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`Upstash request failed with status ${response.status}.`);
    }
    return parseUpstashEnvelope(await response.json());
  } finally {
    clearTimeout(timeoutId);
  }
};

const isLoopbackHost = (hostname) =>
  hostname === 'localhost' ||
  hostname === '::1' ||
  hostname === '[::1]' ||
  /^127(?:\.\d{1,3}){3}$/u.test(hostname);

const requireRestToken = (restToken) => {
  if (typeof restToken !== 'string' || restToken.trim().length === 0) {
    throw new Error('UPSTASH_REDIS_REST_TOKEN must be a non-empty string.');
  }
  return restToken;
};

const parseRestUrl = (restUrl) => {
  let parsed;
  try {
    parsed = new URL(restUrl);
  } catch (cause) {
    throw new Error('UPSTASH_REDIS_REST_URL must be a valid URL.', { cause });
  }
  if (parsed.username || parsed.password) {
    throw new Error('UPSTASH_REDIS_REST_URL must not contain credentials.');
  }
  return parsed;
};

const isSecureUpstashTarget = (url) =>
  url.protocol === 'https:' ||
  (url.protocol === 'http:' && isLoopbackHost(url.hostname));

const validateUpstashTransport = ({ restToken, restUrl }) => {
  const token = requireRestToken(restToken);
  const parsed = parseRestUrl(restUrl);
  if (!isSecureUpstashTarget(parsed)) {
    throw new Error(
      'UPSTASH_REDIS_REST_URL must use HTTPS unless it targets localhost.'
    );
  }
  return { restToken: token, restUrl: parsed.href.replace(/\/$/u, '') };
};

export const createUpstashCommand = (options) => {
  const transport = validateUpstashTransport(options);
  const resolved = {
    fetchFn: fetch,
    timeoutMs: REQUEST_TIMEOUT_MS,
    ...options,
    ...transport,
  };
  return (args) => requestUpstash({ ...resolved, args });
};

const readCliOptions = (argv) => {
  const args = new Set(argv);
  const parsed = destructiveCliSchema.safeParse({
    dedicatedDatabaseConfirmed: args.has('--confirm-dedicated-database'),
    drainedConfirmed: args.has('--confirm-older-instances-drained'),
    dryRun: args.has('--dry-run'),
    yes: args.has('--yes'),
  });
  if (!parsed.success) {
    throw new Error(
      'Refusing to delete Redis keys. Use a dedicated Redis database, drain every pre-v5 instance, then pass --yes --confirm-older-instances-drained --confirm-dedicated-database; use --dry-run to inspect counts.'
    );
  }
  return parsed.data;
};

const readUpstashConfig = (environment) => {
  const restUrl = environment.UPSTASH_REDIS_REST_URL;
  const restToken = environment.UPSTASH_REDIS_REST_TOKEN;
  if (!restUrl || !restToken) {
    throw new Error(
      'UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN are required.'
    );
  }
  return validateUpstashTransport({ restToken, restUrl });
};

const writeResult = (result, dryRun) => {
  const action = dryRun
    ? `Planned ${result.plannedKeys}`
    : `Deleted ${result.deletedKeys} of ${result.plannedKeys} planned`;
  process.stdout.write(
    `${action} legacy Better Auth cache keys: ${result.sessionSnapshotKeys} session snapshots, ${result.indexKeys} user session indexes, and ${result.verificationKeys} verification records.\n`
  );
};

const run = async () => {
  const { dedicatedDatabaseConfirmed, dryRun } = readCliOptions(
    process.argv.slice(2)
  );
  const config = readUpstashConfig(process.env);
  const result = await purgeLegacyBetterAuthSessionCache({
    command: createUpstashCommand(config),
    dedicatedDatabaseConfirmed,
    dryRun,
  });
  writeResult(result, dryRun);
};

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  run().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : 'Legacy cache purge failed.'}\n`
    );
    process.exitCode = 1;
  });
}
