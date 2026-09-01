import { Result } from '@bloodyowl/boxed';
import { eq } from 'drizzle-orm';

import type {
  ProfileOnboardingUpdate,
  ProfileInfoUpdate,
  ProfileRepository,
  ProfileUpdateRepositoryOutcome,
} from '@/modules/profile';
import { toProfileId } from '@/modules/profile';
import {
  AppError,
  type ApplicationResult,
  type ParseResult,
  type UserId,
} from '@/modules/kernel';
import { extractDatabaseErrorDetails } from '@/modules/kernel/infrastructure/db/errors';
import { observeRepository } from '@/modules/kernel/infrastructure/db/observability';
import type { DbLike } from '@/modules/kernel/infrastructure/db/types';

import { user as userTable } from './schema';

const isSqlStateCode = (code: unknown): code is string =>
  typeof code === 'string' && /^[A-Z0-9]{5}$/.test(code);

function invalidProfileRowError(cause: unknown): AppError {
  return new AppError({
    code: 'PROFILE_ROW_INVALID',
    category: 'system',
    status: 500,
    message: 'Profile row contains invalid data',
    cause,
  });
}

function parseProfileRowValue<TValue>(
  result: ParseResult<TValue>
): ApplicationResult<TValue> {
  return result.isError()
    ? Result.Error(invalidProfileRowError(result.getError()))
    : Result.Ok(result.get());
}

function mapDbError(error: unknown): AppError {
  if (error instanceof AppError) return error;

  const details = extractDatabaseErrorDetails(error);

  if (isSqlStateCode(details?.code)) {
    return new AppError({
      code: 'PROFILE_REPOSITORY_DB_ERROR',
      category: 'system',
      status: 500,
      message: 'Profile repository database error',
      cause: error,
    });
  }

  return new AppError({
    code: 'PROFILE_REPOSITORY_ERROR',
    category: 'system',
    status: 500,
    message: 'Profile repository error',
    cause: error,
  });
}

export class ProfileRepositoryDrizzle implements ProfileRepository {
  constructor(private readonly db: DbLike) {}

  private toProfileUpdatedResult(
    updatedUser: { id: string } | undefined
  ): ApplicationResult<ProfileUpdateRepositoryOutcome> {
    if (!updatedUser) return Result.Ok({ type: 'profile_not_found' });

    const id = parseProfileRowValue(toProfileId(updatedUser.id));
    if (id.isError()) return Result.Error(id.getError());

    return Result.Ok({
      type: 'profile_updated',
      profile: { id: id.get() },
    });
  }

  async submitOnboarding(
    userId: UserId,
    input: ProfileOnboardingUpdate
  ): ReturnType<ProfileRepository['submitOnboarding']> {
    try {
      const [updatedUser] = await this.db
        .update(userTable)
        .set({
          name: input.name,
          onboardedAt: input.onboardedAt,
        })
        .where(eq(userTable.id, userId))
        .returning({ id: userTable.id });

      return this.toProfileUpdatedResult(updatedUser);
    } catch (error) {
      return Result.Error(mapDbError(error));
    }
  }

  async updateInfo(
    userId: UserId,
    input: ProfileInfoUpdate
  ): ReturnType<ProfileRepository['updateInfo']> {
    try {
      const [updatedUser] = await this.db
        .update(userTable)
        .set({ name: input.name })
        .where(eq(userTable.id, userId))
        .returning({ id: userTable.id });

      return this.toProfileUpdatedResult(updatedUser);
    } catch (error) {
      return Result.Error(mapDbError(error));
    }
  }
}

export interface ProfileRepositoryDrizzleDependencies {
  db: DbLike;
}

export function createProfileRepository(
  dependencies: ProfileRepositoryDrizzleDependencies
): ProfileRepository {
  return observeRepository(
    new ProfileRepositoryDrizzle(dependencies.db),
    'profile'
  );
}
