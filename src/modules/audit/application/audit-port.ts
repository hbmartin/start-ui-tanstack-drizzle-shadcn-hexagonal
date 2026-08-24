import { Result } from '@bloodyowl/boxed';

import type { Clock } from '@/modules/kernel/application/ports/clock';
import type { IdGenerator } from '@/modules/kernel/application/ports/id-generator';
import type { ApplicationResult } from '@/modules/kernel/application/result';
import { AppError } from '@/modules/kernel/domain/errors/app-error';

import type { AuditRepository } from './ports/audit-repository';
import type { AuditFailureSignal } from './ports/audit-failure-signal';
import {
  auditEventDefinitions,
  toAuditEventId,
  validateAuditEventInput,
  type AuditEventId,
  type AuditEventInput,
  type AuditPersistencePolicy,
} from '../domain/audit-event';
import {
  defaultAuditRetentionPolicy,
  resolveAuditRetention,
  validateAuditRetentionPolicy,
  type AuditRetentionPolicy,
} from '../domain/audit-retention';

export type AuditRecorded = Readonly<{
  eventId: AuditEventId;
  occurredAt: Date;
  type: 'audit_recorded';
}>;

export type AuditBestEffortFailure = Readonly<{
  eventType: AuditEventInput['type'];
  operationalSignalAttempted: true;
  type: 'audit_best_effort_failed';
}>;

export type AuditRecordOutcome = AuditBestEffortFailure | AuditRecorded;

/** Business capabilities receive recording only; retention is an admin concern. */
export interface AuditPort {
  record(
    event: AuditEventInput
  ): Promise<ApplicationResult<AuditRecordOutcome>>;
}

export type AuditPortDependencies = Readonly<{
  clock: Clock;
  idGenerator: IdGenerator;
  failureSignal: AuditFailureSignal;
  repository: Pick<AuditRepository, 'append'>;
  retentionPolicy?: AuditRetentionPolicy;
}>;

const invalidAuditEventError = (issues: readonly unknown[]) =>
  new AppError({
    code: 'AUDIT_EVENT_INVALID',
    category: 'system',
    status: 500,
    message: 'Audit event failed validation',
    details: { issues },
  });

const auditRecordingError = (stage: string, cause: unknown) =>
  new AppError({
    code: 'AUDIT_RECORDING_FAILED',
    category: 'system',
    status: 500,
    message: `Audit event recording failed during ${stage}`,
    cause,
  });

const signalBestEffortFailure = (input: {
  error: AppError;
  event: AuditEventInput;
  failureSignal: AuditFailureSignal;
}): AuditBestEffortFailure => {
  input.failureSignal.emit({ error: input.error, event: input.event });

  return {
    type: 'audit_best_effort_failed',
    eventType: input.event.type,
    operationalSignalAttempted: true,
  };
};

const classifyInfrastructureFailure = (input: {
  error: AppError;
  event: AuditEventInput;
  failureSignal: AuditFailureSignal;
  persistence: AuditPersistencePolicy;
}): ApplicationResult<AuditRecordOutcome> =>
  input.persistence === 'required'
    ? Result.Error(input.error)
    : Result.Ok(signalBestEffortFailure(input));

export function createAuditPort(
  dependencies: AuditPortDependencies
): AuditPort {
  const retentionPolicy = validateAuditRetentionPolicy(
    dependencies.retentionPolicy ?? defaultAuditRetentionPolicy
  );

  return {
    async record(input) {
      const validation = validateAuditEventInput(input);
      if (validation.type === 'audit_event_invalid') {
        return Result.Error(invalidAuditEventError(validation.issues));
      }
      const event = validation.event;
      const definition = auditEventDefinitions[event.type];

      const generatedId = dependencies.idGenerator.createId();
      if (generatedId.isError()) {
        return classifyInfrastructureFailure({
          error: auditRecordingError('ID generation', generatedId.getError()),
          event,
          failureSignal: dependencies.failureSignal,
          persistence: definition.persistence,
        });
      }
      const eventId = toAuditEventId(generatedId.get());
      if (eventId.isError()) {
        return classifyInfrastructureFailure({
          error: auditRecordingError('ID validation', eventId.getError()),
          event,
          failureSignal: dependencies.failureSignal,
          persistence: definition.persistence,
        });
      }

      const occurredAt = dependencies.clock.now();
      const retention = resolveAuditRetention({
        occurredAt,
        policy: retentionPolicy,
        retentionClass: definition.retentionClass,
      });
      const persisted = await dependencies.repository.append({
        ...event,
        ...definition,
        ...retention,
        id: eventId.get(),
        occurredAt,
      });
      if (persisted.isError()) {
        return classifyInfrastructureFailure({
          error: persisted.getError(),
          event,
          failureSignal: dependencies.failureSignal,
          persistence: definition.persistence,
        });
      }

      return Result.Ok({
        type: 'audit_recorded',
        eventId: eventId.get(),
        occurredAt,
      });
    },
  };
}
