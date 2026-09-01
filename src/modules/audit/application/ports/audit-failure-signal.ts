import type { AppError } from '@/modules/kernel/domain/errors/app-error';

import type { AuditEventInput } from '../../domain/audit-event';

export type AuditFailureSignalOutcome =
  | Readonly<{ type: 'audit_failure_signal_accepted' }>
  | Readonly<{ type: 'audit_failure_signal_unavailable' }>;

export interface AuditFailureSignal {
  /** Implementations should absorb sink failures; callers also defend this boundary. */
  emit(input: {
    error: AppError;
    event: AuditEventInput;
  }): AuditFailureSignalOutcome;
}
