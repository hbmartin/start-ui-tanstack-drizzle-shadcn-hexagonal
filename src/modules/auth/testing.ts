export type {
  AuthEmailPort,
  SendSignInOtpInput,
} from './application/ports/auth-email-port';
export type {
  AuthorizationGateway,
  AuthorizationPermission,
} from './application/ports/authorization-gateway';
export type { SessionGateway } from './application/ports/session-gateway';
export {
  hasScopePermission,
  scopeUserId,
} from './application/scope-authorization';
export type { AuthSession } from './domain/session';
export { createAuthUseCases } from './factory';
export {
  isAllowedBetterAuthHttpRequest,
  isBlockedBetterAuthHttpRequest,
} from './infrastructure/better-auth/auth-http-exposure';
export type { Auth } from './infrastructure/better-auth/auth';
export { SessionGatewayBetterAuth } from './infrastructure/better-auth/session-gateway-better-auth';
export {
  ProfileRepositoryDrizzle,
  createProfileRepository,
} from './infrastructure/drizzle/profile-repository-drizzle';
export * as authDrizzleSchema from './infrastructure/drizzle/schema';
export {
  createUserRepository,
  UserRepositoryDrizzle,
} from './infrastructure/drizzle/user-repository-drizzle';
export { createUserSecurityRepository } from './infrastructure/drizzle/user-security-repository-drizzle';
