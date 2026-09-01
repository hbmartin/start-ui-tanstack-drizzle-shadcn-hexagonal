# Domain Context

This repository is a production application template for an authenticated,
single-application modular monolith. The language below is authoritative for
code, schemas, permissions, routes, documentation, and generated modules.

## Application identity

- `APP_NAME` is the human-facing presentation name. It may change as the
  product is renamed.
- `APP_SLUG` is the stable machine identifier used by infrastructure,
  telemetry, storage prefixes, and other durable integration keys. It may be
  changed before the first deployment. After that point, changing it requires
  an explicit migration for every durable consumer.

## Identity and access

- **User**: the application principal. A User is the stable subject used for
  authorization and ownership. It is not a provider credential.
- **Profile**: user-facing account information and preferences associated with
  one User. A Profile may currently share persistence with the authentication
  provider's user record, but the domain boundary and identifier remain
  distinct.
- **AuthIdentity**: a provider credential or provider-account link associated
  with a User. Password credentials and social-provider links are
  AuthIdentities; they are not Profiles.
- **Invite**: authorization to begin an account-creation flow. An Invite does
  not become a User until signup succeeds and must not be treated as a session
  or role grant.
- **Session**: a time-bounded authenticated interaction associated with a User
  and, where available, the AuthIdentity used to create it.
- **Role**: a named preset of permission grants. Authorization decisions are
  made from typed resource/action permissions rather than role-name checks.

The unqualified term `account` is intentionally avoided in domain and
application code because it ambiguously refers to a Profile, an AuthIdentity,
or the act of signing up. Provider APIs may retain `account` when that is their
external contract; adapters translate that language at the boundary.

## Capabilities

The core preset contains authentication, permissions, Profile, and durable
audit capabilities. These capabilities define the production security and
accountability boundary and remain enabled in every supported preset.

The demo preset adds books and uploads. Demo capabilities are examples rather
than framework dependencies and must be removable without leaving registered
routes, permissions, translations, seeds, storage requirements, jobs, or
schema ownership behind.

Each capability declares validated public metadata through a
`CapabilityManifest`: public routes, schema ownership, permission resources and
actions, preset role grants, seeds, forms, background jobs, and runtime adapter
requirements. Production permissions, navigation, locales, seeds, routes, and
composition are not yet wholly manifest-derived; that derivation remains a v5
release blocker. Cross-capability behavior uses focused public gates and
injected ports; deep imports do not form a composition mechanism.

## Deployment and tenancy

The declared build profiles are Node, Vercel, and Cloudflare Workers. A trusted
entrypoint selects the profile and injects its adapters. Request hosts,
forwarding headers, and ambient provider variables do not select application
behavior. Node has an executable artifact gate; Vercel and Cloudflare remain
artifact-only until the runtime gates in the remediation ledger close.

Version 5 is single-application and does not implement multi-tenancy. Generic
identifiers, injected ports, and capability manifests are composition seams;
they must not be described as tenant isolation, tenant routing, tenant-scoped
authorization, or tenant-aware persistence.

## Audit language

An **audit event** is a durable, typed record of a security- or
business-relevant action. It includes an actor when known, a subject when
applicable, correlation data, an allowlisted metadata shape, and a retention
class. Audit events are distinct from operational logs and telemetry. Critical
actions fail closed when their audit event cannot be persisted; explicitly
classified low-risk events may be best-effort and must emit an operational
failure signal.
