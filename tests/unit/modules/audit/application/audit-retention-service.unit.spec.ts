import { Result } from '@bloodyowl/boxed';
import { describe, expect, it, vi } from 'vitest';

import { toAuditEventId } from '@/modules/audit';
import {
  createAuditRetentionService,
  DEFAULT_AUDIT_PURGE_BATCH_SIZE,
  MAX_AUDIT_PURGE_BATCH_SIZE,
  type AuditRepository,
} from '@/modules/audit/backend';
import { toGeneratedId } from '@/modules/kernel';
import { unwrapParseResult } from '@/modules/kernel/testing';
import type { ApplicationResult } from '@/modules/kernel/testing';

const now = new Date('2026-01-01T00:00:00.000Z');
const eventId = unwrapParseResult(
  toAuditEventId(unwrapParseResult(toGeneratedId('audit-event-1')))
);

const makeRepository = (): AuditRepository => ({
  append: vi.fn<AuditRepository['append']>(async () =>
    Result.Ok({ type: 'audit_event_persisted' })
  ),
  purgeExpiredBatch: vi.fn<AuditRepository['purgeExpiredBatch']>(async () =>
    Result.Ok({ type: 'audit_events_purged', count: 0, hasMore: false })
  ),
  setLegalHold: vi.fn<AuditRepository['setLegalHold']>(
    async ({ eventId: id, legalHold }) =>
      Result.Ok({ type: 'audit_legal_hold_updated', eventId: id, legalHold })
  ),
});

const getError = <TOutcome extends { type: string }>(
  result: ApplicationResult<TOutcome>
) => {
  if (result.isOk())
    throw new Error(`Expected error, got ${result.get().type}`);
  return result.getError();
};

describe('audit retention service', () => {
  it('uses injected time and a bounded default purge size', async () => {
    const repository = makeRepository();
    const service = createAuditRetentionService({
      clock: { now: () => now },
      repository,
    });

    await service.purgeExpiredBatch();

    expect(repository.purgeExpiredBatch).toHaveBeenCalledWith({
      before: now,
      limit: DEFAULT_AUDIT_PURGE_BATCH_SIZE,
    });
  });

  it('rejects purge sizes outside the bounded contract', async () => {
    const service = createAuditRetentionService({
      clock: { now: () => now },
      repository: makeRepository(),
    });

    const zero = await service.purgeExpiredBatch({ limit: 0 });
    const tooLarge = await service.purgeExpiredBatch({
      limit: MAX_AUDIT_PURGE_BATCH_SIZE + 1,
    });

    expect(getError(zero).code).toBe('AUDIT_PURGE_BATCH_SIZE_INVALID');
    expect(getError(tooLarge).code).toBe('AUDIT_PURGE_BATCH_SIZE_INVALID');
  });

  it('applies and releases legal holds through the maintenance repository', async () => {
    const repository = makeRepository();
    const service = createAuditRetentionService({
      clock: { now: () => now },
      repository,
    });

    await service.applyLegalHold(eventId);
    await service.releaseLegalHold(eventId);

    expect(repository.setLegalHold).toHaveBeenNthCalledWith(1, {
      eventId,
      legalHold: true,
    });
    expect(repository.setLegalHold).toHaveBeenNthCalledWith(2, {
      eventId,
      legalHold: false,
    });
  });
});
