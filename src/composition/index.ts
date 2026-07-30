export {
  __resetAccountComposition,
  type AccountOverrides,
  getAccountUseCases,
} from './account';
export {
  __resetAuthComposition,
  type AuthOverrides,
  getAuthUseCases,
} from './auth';
export {
  __resetBookComposition,
  type BookOverrides,
  getBookUseCases,
} from './book';
export {
  __resetEmailComposition,
  type EmailOverrides,
  getEmailGateway,
  getEmailServices,
  getEmailUseCases,
} from './email';
export {
  __resetGenreComposition,
  type GenreOverrides,
  getGenreUseCases,
} from './genre';
export {
  __resetKernelComposition,
  getKernel,
  type KernelOverrides,
} from './kernel';
export {
  __resetLifecycleEventsComposition,
  getLifecycleEventsUseCases,
  type LifecycleEventsOverrides,
} from './lifecycle-events';
export {
  __resetUserComposition,
  getUserUseCases,
  type UserOverrides,
} from './user';

import { type AccountOverrides, getAccountUseCases } from './account';
import { type BookOverrides, getBookUseCases } from './book';
import { type EmailOverrides, getEmailServices } from './email';
import { type GenreOverrides, getGenreUseCases } from './genre';
import { getKernel, type KernelOverrides } from './kernel';
import {
  getLifecycleEventsUseCases,
  type LifecycleEventsOverrides,
} from './lifecycle-events';
import { getUserUseCases, type UserOverrides } from './user';

export type ServicesOverrides = {
  kernel?: KernelOverrides;
  book?: Omit<BookOverrides, 'kernel'>;
  user?: Omit<UserOverrides, 'kernel'>;
  genre?: Omit<GenreOverrides, 'kernel'>;
  account?: Omit<AccountOverrides, 'kernel'>;
  email?: Omit<EmailOverrides, 'kernel' | 'db'>;
  lifecycleEvents?: Omit<LifecycleEventsOverrides, 'kernel'>;
};

export function getServices(overrides?: ServicesOverrides) {
  if (overrides === undefined) {
    return {
      kernel: getKernel(),
      book: getBookUseCases(),
      user: getUserUseCases(),
      genre: getGenreUseCases(),
      account: getAccountUseCases(),
      email: getEmailServices(),
      lifecycleEvents: getLifecycleEventsUseCases(),
    } as const;
  }

  const kernel = getKernel(overrides.kernel ?? {});
  return {
    kernel,
    book: getBookUseCases({ ...overrides.book, kernel }),
    user: getUserUseCases({ ...overrides.user, kernel }),
    genre: getGenreUseCases({ ...overrides.genre, kernel }),
    account: getAccountUseCases({ ...overrides.account, kernel }),
    email: getEmailServices({ ...overrides.email, kernel }),
    lifecycleEvents: getLifecycleEventsUseCases({
      ...overrides.lifecycleEvents,
      kernel,
    }),
  } as const;
}
