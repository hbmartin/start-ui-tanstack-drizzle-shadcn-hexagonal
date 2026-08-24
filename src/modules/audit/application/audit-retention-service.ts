import { Result } from '@bloodyowl/boxed';

import type { Clock } from '@/modules/kernel/application/ports/clock';
import type { ApplicationResult } from '@/modules/kernel/application/result';
import { AppError } from '@/modules/kernel/domain/errors/app-error';

import type {
  AuditEventNotFound,
  AuditEventsPurged,
  AuditLegalHoldUpdated,
  AuditRepository,
} from './ports/audit-repository';
import type { AuditEventId } from '../domain/audit-event';
import {
  DEFAULT_AUDIT_PURGE_BATCH_SIZE,
  isValidAuditPurgeBatchSize,
  MAX_AUDIT_PURGE_BATCH_SIZE,
} from '../domain/audit-retention';

export interface AuditRetentionService {
  applyLegalHold(
    eventId: AuditEventId
  ): Promise<ApplicationResult<AuditEventNotFound | AuditLegalHoldUpdated>>;
  purgeExpiredBatch(input?: {
    limit?: number;
  }): Promise<ApplicationResult<AuditEventsPurged>>;
  releaseLegalHold(
    eventId: AuditEventId
  ): Promise<ApplicationResult<AuditEventNotFound | AuditLegalHoldUpdated>>;
}

const validateBatchSize = (limit: number) => {
  if (!isValidAuditPurgeBatchSize(limit)) {
    return {
      type: 'audit_purge_batch_size_invalid',
      error: new AppError({
        code: 'AUDIT_PURGE_BATCH_SIZE_INVALID',
        category: 'system',
        status: 500,
        message: `Audit purge batch size must be between 1 and ${MAX_AUDIT_PURGE_BATCH_SIZE}`,
      }),
    } as const;
  }
  return { type: 'audit_purge_batch_size_valid', limit } as const;
};

export const createAuditRetentionService = (dependencies: {
  clock: Clock;
  repository: Pick<AuditRepository, 'purgeExpiredBatch' | 'setLegalHold'>;
}): AuditRetentionService => ({
  applyLegalHold: (eventId) =>
    dependencies.repository.setLegalHold({ eventId, legalHold: true }),
  async purgeExpiredBatch(input) {
    const limit = validateBatchSize(
      input?.limit ?? DEFAULT_AUDIT_PURGE_BATCH_SIZE
    );
    if (limit.type === 'audit_purge_batch_size_invalid') {
      return Result.Error(limit.error);
    }
    return dependencies.repository.purgeExpiredBatch({
      before: dependencies.clock.now(),
      limit: limit.limit,
    });
  },
  releaseLegalHold: (eventId) =>
    dependencies.repository.setLegalHold({ eventId, legalHold: false }),
});
