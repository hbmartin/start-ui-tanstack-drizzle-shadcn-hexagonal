import type {
  UserUpdateInput,
  UserUpdatePersistenceInput,
  UserUpdateSnapshot,
} from '../../domain/user';
import { emptyUserDisplayName, shouldUnverifyEmail } from '../../domain/user';

export const buildUserUpdatePersistenceInput = (
  current: UserUpdateSnapshot,
  input: UserUpdateInput,
  role: UserUpdatePersistenceInput['role']
): UserUpdatePersistenceInput => ({
  email: input.email,
  role,
  emailVerified: shouldUnverifyEmail(current.email, input.email)
    ? false
    : undefined,
  ...(input.name === undefined
    ? {}
    : { name: input.name ?? emptyUserDisplayName }),
});
