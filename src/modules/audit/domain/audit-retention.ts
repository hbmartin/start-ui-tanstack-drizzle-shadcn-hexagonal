import { auditRetentionClasses, type AuditRetentionClass } from './audit-event';

export const DEFAULT_AUDIT_RETENTION_DAYS = 365;
export const DEFAULT_AUDIT_PURGE_BATCH_SIZE = 500;
export const MAX_AUDIT_PURGE_BATCH_SIZE = 1_000;
const MAX_AUDIT_RETENTION_DAYS = 36_500;
const MILLISECONDS_PER_DAY = 86_400_000;

export const isValidAuditPurgeBatchSize = (limit: number) =>
  Number.isSafeInteger(limit) &&
  limit >= 1 &&
  limit <= MAX_AUDIT_PURGE_BATCH_SIZE;

export type AuditRetentionPolicy = Readonly<{
  classes?: Readonly<Partial<Record<AuditRetentionClass, number>>>;
  defaultDays: number;
}>;

export const defaultAuditRetentionPolicy: AuditRetentionPolicy = {
  defaultDays: DEFAULT_AUDIT_RETENTION_DAYS,
};

const assertRetentionDays = (days: number, label: string) => {
  if (
    !Number.isSafeInteger(days) ||
    days < 1 ||
    days > MAX_AUDIT_RETENTION_DAYS
  ) {
    throw new RangeError(
      `${label} must be an integer between 1 and 36500 days`
    );
  }
};

export const validateAuditRetentionPolicy = (
  policy: AuditRetentionPolicy
): AuditRetentionPolicy => {
  assertRetentionDays(policy.defaultDays, 'Default audit retention');
  const knownClasses = new Set<string>(auditRetentionClasses);
  for (const [retentionClass, days] of Object.entries(policy.classes ?? {})) {
    if (!knownClasses.has(retentionClass)) {
      throw new RangeError(`Unknown audit retention class: ${retentionClass}`);
    }
    if (days !== undefined) {
      assertRetentionDays(days, `${retentionClass} audit retention`);
    }
  }
  return policy;
};

export const resolveAuditRetention = (input: {
  occurredAt: Date;
  policy: AuditRetentionPolicy;
  retentionClass: AuditRetentionClass;
}) => {
  validateAuditRetentionPolicy(input.policy);
  const days =
    input.policy.classes?.[input.retentionClass] ?? input.policy.defaultDays;
  return {
    legalHold: false,
    retainUntil: new Date(
      input.occurredAt.getTime() + days * MILLISECONDS_PER_DAY
    ),
  } as const;
};
