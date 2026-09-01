import { type ProfileQueryFacade, createProfileQueries } from './queries';
import { profileSubmitOnboarding, profileUpdateInfo } from '../server';

export const profileQueries = createProfileQueries({
  profileSubmitOnboarding,
  profileUpdateInfo,
} satisfies ProfileQueryFacade);
