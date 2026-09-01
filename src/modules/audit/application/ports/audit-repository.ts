import type { ApplicationResult } from '@/modules/kernel/application/result';

import type { AuditEventId, AuditEventRecord } from '../../domain/audit-event';

export type AuditEventPersisted = Readonly<{
  type: 'audit_event_persisted';
}>;

export type AuditEventsPurged = Readonly<{
  count: number;
  hasMore: boolean;
  type: 'audit_events_purged';
}>;

export type AuditLegalHoldUpdated = Readonly<{
  eventId: AuditEventId;
  legalHold: boolean;
  type: 'audit_legal_hold_updated';
}>;

export type AuditEventNotFound = Readonly<{
  eventId: AuditEventId;
  type: 'audit_event_not_found';
}>;

export interface AuditRepository {
  append(
    record: AuditEventRecord
  ): Promise<ApplicationResult<AuditEventPersisted>>;
  purgeExpiredBatch(input: {
    before: Date;
    limit: number;
  }): Promise<ApplicationResult<AuditEventsPurged>>;
  setLegalHold(input: {
    eventId: AuditEventId;
    legalHold: boolean;
  }): Promise<ApplicationResult<AuditEventNotFound | AuditLegalHoldUpdated>>;
}
