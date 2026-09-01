import { describe, expect, it } from 'vitest';

import { createUserSecurityRepository } from '@/modules/auth/infrastructure/drizzle/user-security-repository-drizzle';
import { toUserId } from '@/modules/kernel/domain/ids';
import type { DbLike } from '@/modules/kernel/infrastructure/db/types';
import { unwrapParseResult } from '@/modules/kernel/testing';

describe('UserSecurityRepositoryDrizzle', () => {
  it('orders both principals in one query before taking update locks', async () => {
    const calls: string[] = [];
    const actorId = unwrapParseResult(toUserId('actor-z'));
    const targetId = unwrapParseResult(toUserId('target-a'));
    const database = {
      select: () => ({
        from: () => ({
          where: () => ({
            orderBy: () => {
              calls.push('orderBy');
              return {
                for: async (mode: string) => {
                  calls.push(`for:${mode}`);
                  return [
                    { id: targetId, role: 'user' as const },
                    { id: actorId, role: 'admin' as const },
                  ];
                },
              };
            },
          }),
        }),
      }),
    } as unknown as DbLike;

    const result = await createUserSecurityRepository({
      db: database,
    }).lockMutationPrincipals({ actorId, targetId });

    expect(calls).toEqual(['orderBy', 'for:update']);
    expect(result).toMatchObject({
      tag: 'Ok',
      value: {
        type: 'user_security_mutation_principals_locked',
        actor: { type: 'user_security_principal_found', role: 'admin' },
        target: { type: 'user_security_principal_found', role: 'user' },
      },
    });
  });
});
