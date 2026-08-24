import { Result } from '@bloodyowl/boxed';
import { makeTestKernel } from '@tests/unit/composition/helpers';
import { describe, expect, it, vi } from 'vitest';

import { createAuditRecorder } from '@/composition/audit';
import { toAuditSubjectId, type AuditEventInput } from '@/modules/audit';
import type { AuditRepository } from '@/modules/audit/backend';
import { toCorrelationId, toUserId } from '@/modules/kernel';
import { unwrapParseResult } from '@/modules/kernel/testing';

describe('audit composition', () => {
  it('requires an explicit repository context and records through it', async () => {
    const append = vi.fn<AuditRepository['append']>(async () =>
      Result.Ok({ type: 'audit_event_persisted' })
    );
    const recorder = createAuditRecorder({
      kernel: makeTestKernel(),
      repository: { append },
    });
    const event = {
      type: 'profile.updated',
      actor: {
        kind: 'user',
        userId: unwrapParseResult(toUserId('user-1')),
      },
      subject: {
        kind: 'profile',
        id: unwrapParseResult(toAuditSubjectId('profile', 'profile-1')),
      },
      correlationId: unwrapParseResult(toCorrelationId('correlation-1')),
      metadata: { fields: ['name'] },
    } as const satisfies AuditEventInput;

    const result = await recorder.record(event);

    expect(result.isOk()).toBe(true);
    expect(append).toHaveBeenCalledOnce();
  });
});
