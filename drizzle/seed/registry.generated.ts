import { createBooks } from './book';
import { createGenres } from './genre';
import { createDemoUsers, createLocalUsers } from './user';

export const allSeedContributions = [
  {
    capabilityId: 'user',
    id: 'user.local-accounts',
    purpose: 'core',
    run: createLocalUsers,
  },
  {
    capabilityId: 'user',
    id: 'user.demo-directory',
    purpose: 'demo',
    run: createDemoUsers,
  },
  {
    capabilityId: 'genre',
    id: 'genre.demo-catalog',
    purpose: 'demo',
    run: createGenres,
  },
  {
    capabilityId: 'book',
    id: 'book.demo-catalog',
    purpose: 'demo',
    run: createBooks,
  },
] as const;

export const getSeedContributions = (preset: 'core' | 'demo') =>
  allSeedContributions.filter(
    ({ purpose }) => preset === 'demo' || purpose === 'core'
  );

export const getSeedContributionIds = (preset: 'core' | 'demo') =>
  getSeedContributions(preset).map(({ capabilityId, id }) => ({
    capabilityId,
    id,
  }));
