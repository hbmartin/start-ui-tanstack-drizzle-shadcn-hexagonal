import { describe, expect, it } from 'vitest';

import {
  auditEventDefinitions,
  toAuditSubjectId,
  validateAuditEventInput,
} from '@/modules/audit';
import {
  DEFAULT_AUDIT_RETENTION_DAYS,
  resolveAuditRetention,
  validateAuditRetentionPolicy,
} from '@/modules/audit/backend';
import { toCorrelationId, toUserId } from '@/modules/kernel';
import { unwrapParseResult } from '@/modules/kernel/testing';

const correlationId = unwrapParseResult(toCorrelationId('correlation-1'));
const userId = unwrapParseResult(toUserId('user-1'));
const occurredAt = new Date('2026-01-01T00:00:00.000Z');
const subjectId = <TKind extends Parameters<typeof toAuditSubjectId>[0]>(
  kind: TKind,
  value: string
) => unwrapParseResult(toAuditSubjectId(kind, value));

describe('audit event domain', () => {
  it('accepts a typed event with only allowlisted metadata', () => {
    expect(
      validateAuditEventInput({
        type: 'authorization.role-changed',
        actor: { kind: 'user', userId },
        subject: { kind: 'user', id: subjectId('user', 'user-2') },
        correlationId,
        metadata: { from: 'user', to: 'admin' },
      })
    ).toMatchObject({ type: 'audit_event_valid' });
  });

  it.each([
    {
      type: 'administration.user-deleted',
      actor: { kind: 'anonymous' },
      subject: { kind: 'user', id: 'user-2' },
      metadata: { reason: 'administrator' },
    },
    {
      type: 'authorization.role-changed',
      actor: { kind: 'user', userId },
      subject: { kind: 'book', id: 'book-1' },
      metadata: { from: 'user', to: 'admin' },
    },
    {
      type: 'data.book-deleted',
      actor: { kind: 'user', userId },
      metadata: {},
    },
    {
      type: 'session.revoked',
      actor: { kind: 'system', name: 'application' },
      subject: { kind: 'user', id: 'user-2' },
      metadata: { reason: 'administrator', scope: 'single' },
    },
    {
      type: 'administration.user-deleted',
      actor: { kind: 'user', userId },
      subject: { kind: 'user', id: 'user-2' },
      metadata: { reason: 'self-service' },
    },
    {
      type: 'authentication.signed-in',
      actor: { kind: 'user', userId },
      subject: { kind: 'user', id: 'user-2' },
      metadata: { method: 'password' },
    },
    {
      type: 'authentication.signed-out',
      actor: { kind: 'user', userId },
      subject: { kind: 'user', id: 'user-2' },
      metadata: { scope: 'all' },
    },
    {
      type: 'authentication.failed',
      actor: { kind: 'user', userId },
      subject: { kind: 'user', id: 'user-1' },
      metadata: { method: 'password', reason: 'unknown-user' },
    },
    {
      type: 'authorization.role-changed',
      actor: { kind: 'user', userId },
      subject: { kind: 'user', id: 'user-2' },
      metadata: { from: 'admin', to: 'admin' },
    },
  ])('rejects invalid actor/subject semantics for $type', (event) => {
    expect(validateAuditEventInput({ ...event, correlationId })).toMatchObject({
      type: 'audit_event_invalid',
    });
  });

  it('rejects unsafe identifiers and open-ended system actor names', () => {
    expect(
      validateAuditEventInput({
        type: 'profile.updated',
        actor: { kind: 'user', userId },
        subject: { kind: 'profile', id: 'person@example.com' },
        correlationId,
        metadata: { fields: ['name'] },
      })
    ).toMatchObject({ type: 'audit_event_invalid' });
    expect(
      validateAuditEventInput({
        type: 'session.revoked',
        actor: { kind: 'system', name: 'untrusted-provider' },
        subject: { kind: 'session', id: 'session-1' },
        correlationId,
        metadata: { reason: 'administrator', scope: 'single' },
      })
    ).toMatchObject({ type: 'audit_event_invalid' });
  });

  it('rejects arbitrary metadata and envelope fields', () => {
    expect(
      validateAuditEventInput({
        type: 'authorization.role-changed',
        actor: { kind: 'user', userId },
        correlationId,
        metadata: { from: 'user', to: 'admin', email: 'secret@example.com' },
      })
    ).toMatchObject({ type: 'audit_event_invalid' });
    expect(
      validateAuditEventInput({
        type: 'data.book-deleted',
        actor: { kind: 'user', userId },
        correlationId,
        metadata: {},
        href: 'https://example.com/private?token=secret',
      })
    ).toMatchObject({ type: 'audit_event_invalid' });
  });

  it('classifies security/destructive events as required and low-risk profile updates as best-effort', () => {
    expect(
      Object.entries(auditEventDefinitions)
        .filter(([, definition]) => definition.persistence === 'required')
        .map(([type]) => type)
        .toSorted()
    ).toEqual(
      [
        'administration.user-deleted',
        'authentication.failed',
        'authentication.signed-in',
        'authentication.signed-out',
        'authorization.role-changed',
        'data.book-deleted',
        'session.revoked',
      ].toSorted()
    );
    expect(auditEventDefinitions['profile.updated'].persistence).toBe(
      'best-effort'
    );
  });

  it('defaults retention to 365 days and supports longer classes', () => {
    const standard = resolveAuditRetention({
      occurredAt,
      policy: { defaultDays: DEFAULT_AUDIT_RETENTION_DAYS },
      retentionClass: 'standard',
    });
    const longSecurity = resolveAuditRetention({
      occurredAt,
      policy: { defaultDays: 365, classes: { security: 2_555 } },
      retentionClass: 'security',
    });
    expect(standard.retainUntil?.toISOString()).toBe(
      '2027-01-01T00:00:00.000Z'
    );
    expect(longSecurity.retainUntil?.getTime()).toBeGreaterThan(
      standard.retainUntil!.getTime()
    );
    expect(standard.legalHold).toBe(false);
  });

  it('rejects unsafe retention durations', () => {
    expect(() => validateAuditRetentionPolicy({ defaultDays: 0 })).toThrow(
      RangeError
    );
    expect(() =>
      validateAuditRetentionPolicy({
        defaultDays: 365,
        classes: { security: 36_501 },
      })
    ).toThrow(RangeError);
    expect(() =>
      validateAuditRetentionPolicy({
        defaultDays: 365,
        classes: { typo: 730 } as never,
      })
    ).toThrow('Unknown audit retention class: typo');
  });
});
