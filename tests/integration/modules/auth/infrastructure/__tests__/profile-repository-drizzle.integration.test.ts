import { makeUserRow } from '@tests/server/db-fixtures';
import { createPgliteTestDatabase } from '@tests/server/pglite';
import { testProfileName } from '@tests/support/branded-values';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createProfileRepository } from '@/modules/auth/infrastructure/drizzle/profile-repository-drizzle';
import { toUserId } from '@/modules/kernel/domain/ids';
import { user as userTable } from '@/modules/kernel/infrastructure/db/schema';
import type { ApplicationResult } from '@/modules/kernel/testing';
import { unwrapParseResult } from '@/modules/kernel/testing';

function getOk<TOutcome extends { type: string }>(
  result: ApplicationResult<TOutcome>
) {
  if (result.isError()) throw result.getError();
  return result.get();
}

describe('ProfileRepositoryDrizzle integration', () => {
  let database: Awaited<ReturnType<typeof createPgliteTestDatabase>>;

  beforeAll(async () => {
    database = await createPgliteTestDatabase();
  });

  beforeEach(async () => {
    await database.truncate();
  });

  afterAll(async () => {
    await database?.close();
  });

  it('covers profile update behavior with PGlite', async () => {
    const repository = createProfileRepository({ db: database.db });
    const now = new Date('2026-01-01T00:00:00.000Z');
    await database.db.insert(userTable).values(
      makeUserRow({
        id: 'user-1',
        name: testProfileName('Old Name'),
        email: 'user@example.com',
      })
    );

    expect(
      getOk(
        await repository.submitOnboarding(
          unwrapParseResult(toUserId('user-1')),
          {
            name: testProfileName('New Name'),
            onboardedAt: now,
          }
        )
      )
    ).toEqual({ type: 'profile_updated', profile: { id: 'user-1' } });

    const onboarded = await database.db.query.user.findFirst({
      where: eq(userTable.id, 'user-1'),
    });
    expect(onboarded).toMatchObject({
      name: testProfileName('New Name'),
      onboardedAt: now,
    });

    expect(
      getOk(
        await repository.updateInfo(unwrapParseResult(toUserId('user-1')), {
          name: testProfileName('Final Name'),
        })
      )
    ).toEqual({ type: 'profile_updated', profile: { id: 'user-1' } });
    const updatedUser = await database.db.query.user.findFirst({
      where: eq(userTable.id, 'user-1'),
    });
    expect(updatedUser).toMatchObject({ name: testProfileName('Final Name') });

    expect(
      getOk(
        await repository.updateInfo(unwrapParseResult(toUserId('missing')), {
          name: testProfileName('Missing'),
        })
      )
    ).toEqual({ type: 'profile_not_found' });
    const finalUser = await database.db.query.user.findFirst({
      where: eq(userTable.id, 'user-1'),
    });
    expect(finalUser).toMatchObject({ name: testProfileName('Final Name') });
  });
});
