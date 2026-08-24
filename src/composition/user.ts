import { Result } from '@bloodyowl/boxed';

import {
  createUserRepository,
  createUserSecurityRepository,
} from '@/modules/auth/backend';
import {
  ConfigurationError,
  type ResultTransactionRunner,
} from '@/modules/kernel';
import { createResultTransactionRunner } from '@/modules/kernel/backend';
import {
  createUserUseCases,
  type UserAuthGateway,
  type UserRepository,
  type UserTransactionContext,
} from '@/modules/user';

import { createTransactionAuditRecorder } from './audit';
import { getKernel, type Kernel } from './kernel';
import { createCachedFactory } from './shared/singleton';

const createProductionUserAuthGateway = (): UserAuthGateway => ({
  async removeUser(userId) {
    const [{ getRequestHeaders }, { getAuthUseCases }] = await Promise.all([
      import('@tanstack/react-start/server'),
      import('./auth'),
    ]);
    const result = await getAuthUseCases().removeUser({
      userId,
      headers: getRequestHeaders(),
    });
    if (result.isError()) return Result.Error(result.getError());
    return Result.Ok({ type: 'user_auth_removed' });
  },
});

export type UserOverrides = {
  kernel?: Kernel;
  userRepository?: UserRepository;
  transactionRunner?: ResultTransactionRunner<UserTransactionContext>;
  userAuthGateway?: UserAuthGateway;
};

const createUserTransactionRunner = (
  kernel: Kernel
): ResultTransactionRunner<UserTransactionContext> =>
  createResultTransactionRunner({
    transactionRunner: kernel.transactionRunner,
    bindContext: (transaction) => ({
      audit: createTransactionAuditRecorder({ kernel, transaction }),
      securityRepository: createUserSecurityRepository({ db: transaction }),
      userRepository: createUserRepository({ db: transaction }),
    }),
  });

const unavailableUserTransactionRunner =
  (): ResultTransactionRunner<UserTransactionContext> => ({
    async run() {
      return Result.Error(
        new ConfigurationError(
          'A transaction runner is required with a user repository override.'
        )
      );
    },
  });

const resolveUserTransactionRunner = (
  kernel: Kernel,
  overrides?: UserOverrides
) => {
  if (overrides?.transactionRunner) return overrides.transactionRunner;
  if (overrides?.userRepository) {
    return unavailableUserTransactionRunner();
  }
  return createUserTransactionRunner(kernel);
};

const buildUserUseCases = (overrides?: UserOverrides) => {
  const kernel = overrides?.kernel ?? getKernel();
  return createUserUseCases({
    userRepository:
      // User-admin persistence intentionally reads the auth-owned identity store.
      // Keep the Drizzle adapter with auth until the identity store ownership changes.
      overrides?.userRepository ?? createUserRepository({ db: kernel.db }),
    userAuthGateway:
      overrides?.userAuthGateway ?? createProductionUserAuthGateway(),
    transactionRunner: resolveUserTransactionRunner(kernel, overrides),
    permissionChecker: kernel.permissionChecker,
    logger: kernel.logger,
  });
};

const factory = createCachedFactory(buildUserUseCases);

export const getUserUseCases = (overrides?: UserOverrides) =>
  factory.get(overrides);

/** Test-only. */
export const __resetUserComposition = () => factory.reset();
