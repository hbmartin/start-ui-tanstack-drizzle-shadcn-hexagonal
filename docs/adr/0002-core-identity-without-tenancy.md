# ADR 0002: Core identity vocabulary without multi-tenancy

- Status: Accepted for v5
- Date: 2026-08-24

## Context

Version 4 used `Account` for the user-facing name and preferences capability.
Better Auth also uses `account` for provider credentials and linked provider
records. The collision obscured which data belonged to the application
principal, its presentation profile, or an authentication provider. Template
documentation also described composition seams as though tenant isolation had
already been implemented.

## Decision

Version 5 uses four distinct domain terms:

- `User` is the application principal;
- `Profile` is user-facing information and preferences for one User;
- `AuthIdentity` is a provider credential or provider link for a User; and
- `Invite` authorizes the start of account creation.

The application capability, routes, permission resource, public functions,
queries, translations, and composition key are renamed from Account to
Profile. This is a breaking rename with no compatibility exports or route
redirects. Provider contracts may continue to use `account` inside their
adapters when the provider requires that name.

The first rename preserves the existing persistence projection: Profile fields
remain on Better Auth's user record until a separate forward-only migration can
establish Profile-owned storage and safely transition session projections. The
public Profile identifier is nevertheless distinct from `UserId` so callers do
not accidentally rely on that temporary storage identity.

Version 5 remains single-application. Provider-neutral identifiers, injected
ports, and capability manifests are extension seams, not tenant boundaries.
Documentation and code must not claim tenant routing, isolation, or
tenant-scoped authorization.

## Consequences

Existing `/app/account` and `/manager/account` links become `/app/profile` and
`/manager/profile`. Consumers must update Profile API and permission names.
Better Auth's `account` table/configuration remains unchanged. Profile-owned
persistence, the session User/Profile projection split, invite persistence,
and invite-only signup are follow-on v5 changes with their own migrations and
security tests.
