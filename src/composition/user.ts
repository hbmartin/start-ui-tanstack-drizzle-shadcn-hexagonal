import { Result } from '@bloodyowl/boxed';

import {
  createUserRepository,
  createUserSecurityRepository,
} from '@/modules/auth/administration';
import {
  ConfigurationError,
  type ResultTransactionRunner,
} from '@/modules/kernel';
import { createResultTransactionRunner } from '@/modules/kernel/backend';
import {
  createUserUseCases,
  type UserRepository,
  type UserTransactionContext,
} from '@/modules/user';

import { createTransactionAuditRecorder } from './audit';
import { getKernel, type Kernel } from './kernel';
import { createCachedFactory } from './shared/singleton';

export type UserOverrides = {
  kernel?: Kernel;
  userRepository?: UserRepository;
  transactionRunner?: ResultTransactionRunner<UserTransactionContext>;
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
