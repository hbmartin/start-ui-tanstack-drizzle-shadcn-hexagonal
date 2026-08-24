import { Result } from '@bloodyowl/boxed';
import { createAuthenticatedContext } from '@tests/server/test-utils';
import { testProfileId } from '@tests/support/branded-values';
import { describe, expect, it, vi } from 'vitest';

import {
  createProfileHandlers,
  zUpdateInfoInput,
} from '@/modules/profile/transport/http/profile-handlers';

describe('profile HTTP transport handlers', () => {
  it('maps profile update input and protected scope to the use case', async () => {
    const ctx = createAuthenticatedContext();
    const updateInfo = vi.fn(async () =>
      Result.Ok({
        type: 'profile_updated' as const,
        profile: { id: testProfileId(ctx.scope.userId) },
      })
    );
    const handlers = createProfileHandlers({
      getUseCases: () => ({ updateInfo }) as ExplicitAny,
    });

    await handlers.updateInfo(
      ctx,
      zUpdateInfoInput().parse({ name: ' Acme ' })
    );

    expect(updateInfo).toHaveBeenCalledWith({
      currentUserId: ctx.scope.userId,
      name: 'Acme',
    });
  });
});
