import { createBooks } from './book';
import { createGenres } from './genre';
import { createDemoUsers, createLocalUsers } from './user';

export const activeSeedPreset = 'demo' as const;

export const seedContributions = [
  {
    capabilityId: 'user',
    id: 'user.local-accounts',
    run: createLocalUsers,
  },
  {
    capabilityId: 'user',
    id: 'user.demo-directory',
    run: createDemoUsers,
  },
  {
    capabilityId: 'genre',
    id: 'genre.demo-catalog',
    run: createGenres,
  },
  {
    capabilityId: 'book',
    id: 'book.demo-catalog',
    run: createBooks,
  },
] as const;

export const seedContributionIds = seedContributions.map(
  ({ capabilityId, id }) => ({ capabilityId, id })
);
