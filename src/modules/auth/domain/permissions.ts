import { z } from 'zod';

import { isCapabilityEnabled } from '@/modules/kernel';

export const rolesNames = ['admin', 'user'] as const;
type UserRole = (typeof rolesNames)[number];

const corePermissionStatements = {
  user: ['create', 'list', 'update', 'set-role', 'delete'],
  session: ['list', 'revoke'],
  profile: ['update'],
  apps: ['app', 'manager'],
} as const;

const demoPermissionStatements = {
  ...corePermissionStatements,
  book: ['read', 'create', 'update', 'delete'],
  genre: ['read'],
} as const;

const allPermissionStatements = demoPermissionStatements;

export const permissionStatements = isCapabilityEnabled('book')
  ? demoPermissionStatements
  : corePermissionStatements;

export type Permission = {
  [Resource in keyof typeof allPermissionStatements]?: Array<
    (typeof allPermissionStatements)[Resource][number]
  >;
};

const coreRolePermissions = {
  user: {
    user: [],
    session: [],
    profile: ['update'],
    apps: ['app'],
  },
  admin: {
    user: ['create', 'list', 'update', 'set-role', 'delete'],
    session: ['list', 'revoke'],
    profile: ['update'],
    apps: ['app', 'manager'],
  },
} as const satisfies Record<UserRole, Permission>;

const demoRolePermissions = {
  user: {
    user: [],
    session: [],
    profile: ['update'],
    apps: ['app'],
    book: ['read'],
    genre: ['read'],
  },
  admin: {
    user: ['create', 'list', 'update', 'set-role', 'delete'],
    session: ['list', 'revoke'],
    profile: ['update'],
    apps: ['app', 'manager'],
    book: ['read', 'create', 'update', 'delete'],
    genre: ['read'],
  },
} as const satisfies Record<UserRole, Permission>;

export const rolePermissions = isCapabilityEnabled('book')
  ? demoRolePermissions
  : coreRolePermissions;

export const zRole: () => z.ZodType<Role> = () => z.enum(rolesNames);
export type Role = keyof typeof rolePermissions;

export const isRole = (value: unknown): value is Role =>
  typeof value === 'string' && Object.hasOwn(rolePermissions, value);

export const parseRole = (value: unknown): Role | undefined =>
  isRole(value) ? value : undefined;

export const hasRolePermission = (role: Role, permissions: Permission) => {
  const grants: Permission = rolePermissions[role];
  if (!grants || !permissions || typeof permissions !== 'object') {
    return false;
  }

  return Object.entries(permissions).every(([resource, actions]) => {
    if (!Array.isArray(actions)) return false;
    const allowed = grants[resource as keyof typeof allPermissionStatements] as
      | readonly string[]
      | undefined;
    if (!Array.isArray(allowed)) return false;
    return actions.every(
      (action) =>
        typeof action === 'string' &&
        (allowed as readonly string[]).includes(action)
    );
  });
};

const coreDefaultUserPermissions = {
  profile: ['update'],
  apps: ['app'],
} as const satisfies Permission;

const demoDefaultUserPermissions = {
  ...coreDefaultUserPermissions,
  book: ['read'],
  genre: ['read'],
} as const satisfies Permission;

export const defaultUserPermissions = isCapabilityEnabled('book')
  ? demoDefaultUserPermissions
  : coreDefaultUserPermissions;
