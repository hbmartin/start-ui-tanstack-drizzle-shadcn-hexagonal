export {
  __resetProfileComposition,
  type ProfileOverrides,
  getProfileUseCases,
} from './profile';
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
  __resetUserComposition,
  getUserUseCases,
  type UserOverrides,
} from './user';

import { type ProfileOverrides, getProfileUseCases } from './profile';
import { type BookOverrides, getBookUseCases } from './book';
import { type EmailOverrides, getEmailServices } from './email';
import { type GenreOverrides, getGenreUseCases } from './genre';
import { getKernel, type KernelOverrides } from './kernel';
import { getUserUseCases, type UserOverrides } from './user';

export type ServicesOverrides = {
  kernel?: KernelOverrides;
  book?: Omit<BookOverrides, 'kernel'>;
  user?: Omit<UserOverrides, 'kernel'>;
  genre?: Omit<GenreOverrides, 'kernel'>;
  profile?: Omit<ProfileOverrides, 'kernel'>;
  email?: Omit<EmailOverrides, 'kernel' | 'db'>;
};

export function getServices(overrides?: ServicesOverrides) {
  if (overrides === undefined) {
    return {
      kernel: getKernel(),
      book: getBookUseCases(),
      user: getUserUseCases(),
      genre: getGenreUseCases(),
      profile: getProfileUseCases(),
      email: getEmailServices(),
    } as const;
  }

  const kernel = getKernel(overrides.kernel ?? {});
  return {
    kernel,
    book: getBookUseCases({ ...overrides.book, kernel }),
    user: getUserUseCases({ ...overrides.user, kernel }),
    genre: getGenreUseCases({ ...overrides.genre, kernel }),
    profile: getProfileUseCases({ ...overrides.profile, kernel }),
    email: getEmailServices({ ...overrides.email, kernel }),
  } as const;
}
