import { Result } from '@bloodyowl/boxed';

import type { AuditEventInput, AuditPort } from '@/modules/audit';
import type { ApplicationResult } from '@/modules/kernel/application/result';
import { AppError } from '@/modules/kernel/domain/errors/app-error';

type RequiredAuditRecorded = Readonly<{ type: 'required_audit_recorded' }>;

export async function recordRequiredAudit(
  audit: AuditPort,
  event: AuditEventInput
): Promise<ApplicationResult<RequiredAuditRecorded>> {
  const recorded = await audit.record(event);
  if (recorded.isError()) return Result.Error(recorded.getError());
  if (recorded.get().type !== 'audit_recorded') {
    return Result.Error(
      new AppError({
        code: 'REQUIRED_AUDIT_EVENT_NOT_RECORDED',
        category: 'system',
        status: 500,
        message: `Required ${event.type} audit event was not recorded`,
      })
    );
  }

  return Result.Ok({ type: 'required_audit_recorded' });
}
