import type { Logger } from '@/modules/kernel/application/ports/logger';

import type { AuditFailureSignal } from '../application/ports/audit-failure-signal';

export const createLoggerAuditFailureSignal = (
  logger: Logger
): AuditFailureSignal => ({
  emit(input) {
    try {
      logger.error({
        event: 'audit.best_effort_recording_failed',
        correlationId: input.event.correlationId,
        error: input.error.code,
        exception: input.error,
        details: { auditEventType: input.event.type },
      });
      return { type: 'audit_failure_signal_accepted' };
    } catch {
      return { type: 'audit_failure_signal_unavailable' };
    }
  },
});
