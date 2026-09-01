/**
 * Server-only persistence adapters used to compose app-owned user
 * administration. Kept separate from `backend.ts` so logout orchestration can
 * depend on the user capability without creating a public-gate cycle.
 */
export { createUserRepository } from './infrastructure/drizzle/user-repository-drizzle';
export { createUserSecurityRepository } from './infrastructure/drizzle/user-security-repository-drizzle';
