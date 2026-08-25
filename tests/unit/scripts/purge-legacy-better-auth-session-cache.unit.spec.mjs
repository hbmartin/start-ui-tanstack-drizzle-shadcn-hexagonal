import { describe, expect, it, vi } from 'vitest';

import {
  createUpstashCommand,
  purgeLegacyBetterAuthSessionCache,
} from '../../../scripts/purge-legacy-better-auth-session-cache.mjs';

const token1 = 'A'.repeat(32);
const token2 = 'B'.repeat(32);
const token3 = 'C'.repeat(32);

const sessionSnapshot = (token, userId = 'user-1') =>
  JSON.stringify({
    session: { token, userId },
    user: { id: userId },
  });

const sessionIndex = (...tokens) =>
  JSON.stringify(
    tokens.map((token, index) => ({ expiresAt: index + 1, token }))
  );

const deleteEntries = (entries, keys) => {
  let deleted = 0;
  for (const key of keys) {
    if (entries.delete(key)) deleted += 1;
  }
  return deleted;
};

const executeCommand = (entries, args) => {
  const handlers = {
    DEL: () => deleteEntries(entries, args.slice(1)),
    GET: () => entries.get(args[1]) ?? null,
    SCAN: () => ['0', [...entries.keys()]],
  };
  const handler = handlers[args[0]];
  if (!handler) throw new Error(`Unexpected command ${String(args[0])}`);
  return handler();
};

const createCommand = (entries) =>
  vi.fn(async (args) => executeCommand(entries, args));

const executePagedCommand = (entries, scanPages, args) => {
  const handlers = {
    GET: () => entries.get(args[1]) ?? null,
    SCAN: () => scanPages.get(args[1]),
  };
  const handler = handlers[args[0]];
  if (!handler) throw new Error('Unexpected command');
  const value = handler();
  if (value === undefined) throw new Error('Unexpected command');
  return value;
};

const createPagedCommand = (entries, scanPages) =>
  vi.fn(async (args) => executePagedCommand(entries, scanPages, args));

describe('legacy Better Auth session cache purge', () => {
  it('plans validated session snapshots and indexes without deleting in dry-run mode', async () => {
    const entries = new Map([
      ['active-sessions-user-1', sessionIndex(token1)],
      ['active-sessions-user-2', sessionIndex(token2, token3)],
      [token1, sessionSnapshot(token1)],
      [token2, sessionSnapshot(token2, 'user-2')],
      [token3, sessionSnapshot(token3, 'user-2')],
    ]);
    const command = createCommand(entries);

    await expect(
      purgeLegacyBetterAuthSessionCache({ command, dryRun: true })
    ).resolves.toEqual({
      deletedKeys: 0,
      indexKeys: 2,
      plannedKeys: 5,
      sessionSnapshotKeys: 3,
      verificationKeys: 0,
    });
    expect(command).not.toHaveBeenCalledWith(expect.arrayContaining(['DEL']));
  });

  it('deletes validated snapshots together with their legacy user index', async () => {
    const entries = new Map([
      ['active-sessions-user-1', sessionIndex(token1, token2)],
      [token1, sessionSnapshot(token1)],
      [token2, sessionSnapshot(token2)],
    ]);
    const command = createCommand(entries);

    await expect(
      purgeLegacyBetterAuthSessionCache({
        command,
        dedicatedDatabaseConfirmed: true,
        dryRun: false,
      })
    ).resolves.toEqual({
      deletedKeys: 3,
      indexKeys: 1,
      plannedKeys: 3,
      sessionSnapshotKeys: 2,
      verificationKeys: 0,
    });
    expect(command).toHaveBeenCalledWith([
      'DEL',
      token1,
      token2,
      'active-sessions-user-1',
    ]);
  });

  it('detects orphaned session snapshots without a surviving user index', async () => {
    const unrelatedToken = 'D'.repeat(32);
    const entries = new Map([
      [token1, sessionSnapshot(token1)],
      [unrelatedToken, JSON.stringify({ purpose: 'unrelated' })],
    ]);
    const command = createCommand(entries);

    await expect(
      purgeLegacyBetterAuthSessionCache({ command, dryRun: true })
    ).resolves.toEqual({
      deletedKeys: 0,
      indexKeys: 0,
      plannedKeys: 1,
      sessionSnapshotKeys: 1,
      verificationKeys: 0,
    });
  });

  it('deletes legacy plaintext verification records in the same drained cutover', async () => {
    const entries = new Map([
      ['verification:user@example.com', 'record-1'],
      ['verification:another@example.com', 'record-2'],
    ]);
    const command = createCommand(entries);

    await expect(
      purgeLegacyBetterAuthSessionCache({
        command,
        dedicatedDatabaseConfirmed: true,
        dryRun: false,
      })
    ).resolves.toEqual({
      deletedKeys: 2,
      indexKeys: 0,
      plannedKeys: 2,
      sessionSnapshotKeys: 0,
      verificationKeys: 2,
    });
  });

  it('fails closed instead of discarding a malformed token inventory', async () => {
    const command = createCommand(
      new Map([['active-sessions-user-1', '{bad-json']])
    );

    await expect(
      purgeLegacyBetterAuthSessionCache({
        command,
        dedicatedDatabaseConfirmed: true,
        dryRun: false,
      })
    ).rejects.toThrow('not valid JSON');
    expect(command).not.toHaveBeenCalledWith(expect.arrayContaining(['DEL']));
  });

  it('never trusts an index token that points at an unrelated Redis key', async () => {
    const entries = new Map([
      ['active-sessions-user-1', sessionIndex(token1)],
      [token1, JSON.stringify({ purpose: 'unrelated' })],
    ]);
    const command = createCommand(entries);

    await expect(
      purgeLegacyBetterAuthSessionCache({
        command,
        dedicatedDatabaseConfirmed: true,
        dryRun: false,
      })
    ).rejects.toThrow('references a non-session key');
    expect(command).not.toHaveBeenCalledWith(expect.arrayContaining(['DEL']));
    expect(entries.has(token1)).toBe(true);
  });

  it('allows indexed snapshots to expire between SCAN and GET', async () => {
    const entries = new Map([['active-sessions-user-1', sessionIndex(token1)]]);
    const command = createCommand(entries);

    await expect(
      purgeLegacyBetterAuthSessionCache({ command, dryRun: true })
    ).resolves.toMatchObject({
      indexKeys: 1,
      plannedKeys: 1,
      sessionSnapshotKeys: 0,
    });
  });

  it('deduplicates multipage SCAN results', async () => {
    const entries = new Map([
      ['active-sessions-user-1', sessionIndex(token1)],
      [token1, sessionSnapshot(token1)],
    ]);
    const scanPages = new Map([
      ['0', ['7', [token1]]],
      ['7', ['0', [token1, 'active-sessions-user-1']]],
    ]);
    const command = createPagedCommand(entries, scanPages);

    await expect(
      purgeLegacyBetterAuthSessionCache({ command, dryRun: true })
    ).resolves.toMatchObject({ plannedKeys: 2, sessionSnapshotKeys: 1 });
  });

  it('fails boundedly on a repeated nonzero SCAN cursor', async () => {
    const command = vi.fn(async () => ['7', []]);

    await expect(
      purgeLegacyBetterAuthSessionCache({ command, dryRun: true })
    ).rejects.toThrow('repeated SCAN cursor');
  });

  it('reports actual DEL counts when a planned key expires first', async () => {
    const entries = new Map([
      ['active-sessions-user-1', sessionIndex(token1)],
      [token1, sessionSnapshot(token1)],
    ]);
    const command = createCommand(entries);
    command.mockImplementationOnce(async () => ['0', [...entries.keys()]]);
    command.mockImplementationOnce(async () => sessionSnapshot(token1));
    command.mockImplementationOnce(async () => sessionIndex(token1));
    command.mockImplementationOnce(async () => sessionSnapshot(token1));
    command.mockImplementationOnce(async () => 1);

    await expect(
      purgeLegacyBetterAuthSessionCache({
        command,
        dedicatedDatabaseConfirmed: true,
        dryRun: false,
      })
    ).resolves.toMatchObject({ deletedKeys: 1, plannedKeys: 2 });
  });

  it('requires explicit dedicated-database confirmation before deletion', async () => {
    const command = createCommand(new Map());

    await expect(
      purgeLegacyBetterAuthSessionCache({ command, dryRun: false })
    ).rejects.toThrow('dedicated-database confirmation');
    expect(command).not.toHaveBeenCalled();
  });
});

describe('legacy purge Upstash transport', () => {
  it('rejects malformed and insecure remote URLs before sending a token', () => {
    const fetchFn = vi.fn();

    expect(() =>
      createUpstashCommand({
        fetchFn,
        restToken: 'token',
        restUrl: 'not-a-url',
      })
    ).toThrow('must be a valid URL');
    expect(() =>
      createUpstashCommand({
        fetchFn,
        restToken: 'token',
        restUrl: 'http://redis.example',
      })
    ).toThrow('must use HTTPS');
    expect(() =>
      createUpstashCommand({
        fetchFn,
        restToken: 'token',
        restUrl: 'http://127.attacker.example',
      })
    ).toThrow('must use HTTPS');
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('allows plain HTTP only for a local cutover target', async () => {
    const fetchFn = vi.fn(async () => Response.json({ result: 'ok' }));
    const command = createUpstashCommand({
      fetchFn,
      restToken: 'token',
      restUrl: 'http://127.0.0.1:8079',
    });

    await expect(command(['PING'])).resolves.toBe('ok');
    expect(fetchFn).toHaveBeenCalledWith(
      'http://127.0.0.1:8079',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer token' }),
      })
    );
  });

  it('rejects a successful response without a result envelope', async () => {
    const command = createUpstashCommand({
      fetchFn: vi.fn(async () => Response.json({})),
      restToken: 'token',
      restUrl: 'https://redis.example',
    });

    await expect(command(['SCAN', '0'])).rejects.toThrow('invalid response');
  });

  it('aborts a stalled request after the configured timeout', async () => {
    const command = createUpstashCommand({
      fetchFn: vi.fn(
        (_url, init) =>
          new Promise((_resolve, reject) => {
            init.signal.addEventListener('abort', () => {
              reject(new DOMException('Aborted', 'AbortError'));
            });
          })
      ),
      restToken: 'token',
      restUrl: 'https://redis.example',
      timeoutMs: 1,
    });

    await expect(command(['SCAN', '0'])).rejects.toMatchObject({
      name: 'AbortError',
    });
  });
});
