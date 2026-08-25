# v5 Better Auth cache cutover

v5 stores sessions and verification records only in PostgreSQL. Redis is used
through a separate HMAC-keyed, atomic rate-limit adapter and never receives a
Better Auth `{ session, user }` snapshot.

Upstash is required at production startup for the app-owned global, trusted
network, and normalized identity limits. The in-memory adapter is restricted to
local development and tests. Better Auth's built-in IP limiter is disabled so
requests without trusted client-IP provenance never collapse into a shared
provider bucket; the app gateway remains the single fail-closed distributed
limit owner. `TRUSTED_PROXY_DEPTH=0` disables network bucketing for a directly
exposed origin while retaining global and identity limits.

Applications upgrading from a pre-v5 revision that configured Upstash must
remove the old session snapshots and verification records during a drained
deployment:

1. Confirm this application has a dedicated Redis database. The legacy keys
   were not application-namespaced, so this command must never run against a
   database shared with another application.
2. Stop or drain every pre-v5 application instance. Do not run old and v5 auth
   writers concurrently during this cutover.
3. Preview the validated keys with
   `pnpm auth:purge-legacy-session-cache -- --dry-run`.
4. Delete every validated session snapshot, its `active-sessions-*` inventory,
   and every legacy `verification:*` record with
   `pnpm auth:purge-legacy-session-cache -- --yes --confirm-older-instances-drained --confirm-dedicated-database`.
5. Run the dry-run again and require a zero-key result before starting v5.

The purge scans the dedicated database with bounded pages and key counts. It
validates Better Auth's exact 32-character token format and the `{session,user}`
linkage before deleting an indexed key, and it value-classifies orphaned
snapshots even when their per-user index is gone. It also removes legacy
verification records whose keys may contain plaintext identifiers. Every index
is validated before the first deletion; malformed state, repeated cursors,
invalid response envelopes, and implausible deletion counts fail closed.
Expiry races are reported as “deleted X of Y planned.” Requests have a bounded
timeout, and credentials and discovered keys are never printed.
