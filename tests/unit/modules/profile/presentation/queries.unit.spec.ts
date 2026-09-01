import { describe, expect, it, vi } from 'vitest';

import { profileQueries } from '@/modules/profile/client';
import {
  type ProfileQueryFacade,
  createProfileQueries,
} from '@/modules/profile/presentation/queries';

describe('profile mutation keys', () => {
  it('uses versioned mutation keys', () => {
    expect(profileQueries.submitOnboarding().mutationKey).toEqual([
      'profile',
      'v1',
      'submitOnboarding',
    ]);
    expect(profileQueries.updateInfo().mutationKey).toEqual([
      'profile',
      'v1',
      'updateInfo',
    ]);
  });

  it('calls injected facade functions with server function data payloads', async () => {
    const facade = {
      profileSubmitOnboarding: vi.fn(async () => ({ type: 'submitted' })),
      profileUpdateInfo: vi.fn(async () => ({ type: 'updated' })),
    } as unknown as ProfileQueryFacade;
    const queries = createProfileQueries(facade);

    await (
      queries.submitOnboarding().mutationFn as (data: {
        name: string;
      }) => Promise<unknown>
    )({ name: 'Ada' });
    await (
      queries.updateInfo().mutationFn as (data: {
        name: string;
      }) => Promise<unknown>
    )({ name: 'Grace' });

    expect(facade.profileSubmitOnboarding).toHaveBeenCalledWith({
      data: { name: 'Ada' },
    });
    expect(facade.profileUpdateInfo).toHaveBeenCalledWith({
      data: { name: 'Grace' },
    });
  });
});
