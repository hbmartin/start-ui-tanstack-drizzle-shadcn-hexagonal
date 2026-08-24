import type { AuditPort } from '@/modules/audit';
import {
  createAuditPort,
  createLoggerAuditFailureSignal,
  type AuditRepository,
  type AuditRetentionPolicy,
} from '@/modules/audit/backend';

import { getKernel, type Kernel } from './kernel';

export type AuditRecorderDependencies = Readonly<{
  kernel?: Kernel;
  repository: Pick<AuditRepository, 'append'>;
  retentionPolicy?: AuditRetentionPolicy;
}>;

/**
 * Creates a recorder bound to the caller's repository context. Critical
 * mutations must supply a repository backed by their active transaction.
 */
export const createAuditRecorder = (
  dependencies: AuditRecorderDependencies
): AuditPort => {
  const kernel = dependencies.kernel ?? getKernel();
  return createAuditPort({
    clock: kernel.clock,
    failureSignal: createLoggerAuditFailureSignal(kernel.logger),
    idGenerator: kernel.idGenerator,
    repository: dependencies.repository,
    retentionPolicy: dependencies.retentionPolicy,
  });
};
