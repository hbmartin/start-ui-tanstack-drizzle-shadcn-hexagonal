# Strict Modular Monolith Organization

This app uses a strict modular monolith shape:

```text
src/
  routes/          TanStack file routes and URL/auth/data-loading edge
  composition/     production wiring, singletons, and test overrides
  modules/         business and shell capabilities
  platform/        shared technical substrate with no business imports
```

## Module Contract

Business and shell capabilities live under `src/modules/<capability>`.

```text
modules/<capability>/
  index.ts          domain/application public API
  server.ts         TanStack createServerFn exports; kernel also exposes focused server-function support contracts
  backend.ts        server-only protected runners and HTTP handlers
  client.ts         client-only facades and Query options
  middleware.ts     universal TanStack middleware when required
  presentation.ts   React screens, forms, schemas, and guards
  manifest.ts       static capability metadata for composition
  persistence.ts    named owner schema exports for schema wiring
  testing.ts        test-only owner gate
  administration.ts auth-owned destructive persistence gate
  domain/          business language, invariants, policies
  application/     use cases and ports
  infrastructure/  provider/database/SDK adapters
  transport/       protocol translation
```

Only add gates a capability needs. Cross-module imports must use the focused
public gates above; deep imports are allowed inside the owning module only.
Routes and ordinary module code must not import `manifest.ts` or
`persistence.ts`. Only `src/composition/user.ts` may consume auth's
`administration.ts`; callers use the resulting audited user use cases.

## Platform Contract

`src/platform` contains module-agnostic UI primitives, form primitives, hooks,
query provider utilities, i18n/dayjs/zod helpers, environment parsing, styles,
icons, and generic upload UI.

`platform` must not import from `modules`, `routes`, or `composition`.

## Composition Contract

`src/composition` is the production wiring root. It may import module factories,
module infrastructure adapters, and platform utilities. Use cases and pure HTTP
handlers receive dependencies explicitly instead of importing composition.

Auth provider details are isolated behind auth ports. Better Auth is the current
adapter; a future WorkOS/AuthKit adapter should implement the same auth gateway
and client facade before changing routes or feature modules.

The auth module exposes provider-neutral `SessionGateway`,
`AuthorizationGateway`, and `AuthEmailPort` contracts. Do not pass Better Auth
client/server objects across module boundaries. Provider-specific values,
including Better Auth session tokens, stay inside the Better Auth adapter.
Destructive user administration is app-owned and commits its required audit
event in the same transaction; Better Auth's admin plugin is not an alternative
mutation path.

## Route Contract

Routes stay thin. They validate path/search state, seed initial server-backed
data through loaders, select route error/not-found UX, and render module
presentation screens. Screens may use React Query for cache reads, continuation
pages, refresh, and mutations.

Authenticated route subtrees enforce auth in `beforeLoad` via
`requireAuthenticatedRoute()` or `requireAuthenticatedRouteOrForbidden()` from
`@/modules/auth/presentation`. Component-level session guards are not allowed —
guards belong at the route boundary so the redirect happens before any layout
shell paints. Role, permission, and onboarding policy stays in the same route
boundary so every child route inherits it.

## Router Context Contract

The router context is the single read-side contract that every route loader and
`beforeLoad` reads from. It is constructed once in `src/router.tsx` from the
composition layer and typed in `src/platform/router/context.ts`. Current shape:

- `queryClient` — shared TanStack Query client used by `ensureQueryData` /
  `prefetchQuery` in loaders.
- `auth.getSession()` — per-navigation cached session accessor. Resolves
  server-side via the Better Auth gateway during SSR and via fetch on client
  navigations. Route guards choose cached or `requireFresh` reads according to
  the authorization risk.
- `telemetry` — provider-neutral adapter for spans and exception reporting.
  Current Node/browser composition uses OpenTelemetry for implemented spans,
  metrics, and structured logs while Sentry is restricted to actionable
  exceptions; routes call the adapter rather than importing either SDK. Web
  Vitals and the final Worker trace/log ownership decision remain open under
  `OBS-001` in the remediation ledger.
- `flags` — feature-flag adapter (currently a no-op stub). Reserved for an
  OpenFeature/LaunchDarkly provider when needed.

Version 5 is a single-application modular monolith. Provider-neutral IDs and
composition seams are not tenant routing, isolation, authorization, or
tenant-scoped persistence.

Routes that need a dependency must read it off `context` rather than importing
`@/composition` directly — the composition root is the only file that wires
concretes into the context.

## Response Cache Policy

Every response that depends on the authenticated session must set a `private`
cache policy. Use the helpers in `@/platform/http/cache-control`:

- `cachePrivateNoStore()` — default for authenticated reads/mutations.
- `cachePrivateShortLived(seconds)` — short browser caching with
  `Vary: Cookie, Authorization`.
- `cachePublic({ maxAgeSeconds, reason })` — only for genuinely
  cross-user-safe responses. The `reason` parameter is mandatory so reviewers
  can audit each shared-cache decision.

Raw `Cache-Control: public` strings outside the helper are rejected by the
`raw-cache-control-public` semgrep rule.

## Browser Mutation and CSRF Policy

`src/start.ts` explicitly registers `createCsrfMiddleware` for server functions
with Referer and `Sec-Fetch-Site: same-origin` validation. App-owned browser
mutation routes also pass through `browserMutationGuardMiddleware`, which
validates Origin/Referer and Fetch Metadata signals, rejects conflicts, and
adds the corresponding `Vary` headers.

These controls work with the authentication cookie's SameSite policy. The app
does not claim a separate app-issued CSRF-token protocol. Any change to
`src/start.ts`, browser mutation routing, or cookie policy must retain the
origin and Fetch Metadata tests in `tests/unit/start.unit.spec.ts` and
`tests/unit/platform/http/browser-mutation-protection.unit.spec.ts`.
