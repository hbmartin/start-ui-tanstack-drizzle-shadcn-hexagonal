import { describe, expect, it } from 'vitest';

import { isInviteUsable, toAuthIdentityId, toInviteId } from '@/modules/auth';
import { toEmailAddress, toUserId } from '@/modules/kernel';
import { unwrapParseResult } from '@/modules/kernel/testing';

describe('authentication identity vocabulary', () => {
  it('keeps provider identities and signup invites as distinct branded IDs', () => {
    expect(unwrapParseResult(toAuthIdentityId(' better-auth:user-1 '))).toBe(
      'better-auth:user-1'
    );
    expect(unwrapParseResult(toInviteId(' invite-1 '))).toBe('invite-1');
    expect(toAuthIdentityId(' ').isError()).toBe(true);
    expect(toInviteId(' ').isError()).toBe(true);
  });

  it('evaluates invite usability from injected time', () => {
    const now = new Date('2026-08-24T12:00:00.000Z');
    const invite = {
      id: unwrapParseResult(toInviteId('invite-1')),
      email: unwrapParseResult(toEmailAddress('invited@example.com')),
      invitedBy: unwrapParseResult(toUserId('user-1')),
      expiresAt: new Date('2026-08-25T12:00:00.000Z'),
      acceptedAt: null,
    } as const;

    expect(isInviteUsable(invite, now)).toBe(true);
    expect(isInviteUsable({ ...invite, acceptedAt: now }, now)).toBe(false);
    expect(
      isInviteUsable(
        { ...invite, expiresAt: new Date('2026-08-24T12:00:00.000Z') },
        now
      )
    ).toBe(false);
  });
});
