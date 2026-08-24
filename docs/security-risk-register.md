# Security Risk Register

Last reviewed: 2026-08-24

## Temporary Accepted Dependency Advisories

The locked snapshot currently contains no dependency advisories. Any future
low or moderate advisory must be listed here with the affected package and a
review date before `pnpm check` will accept it. High and critical advisories
cannot be accepted by this register.

| Package | Advisory | Current path | Decision | Next review |
| --- | --- | --- | --- | --- |

The committed snapshot is bound to `package.json`, `pnpm-lock.yaml`, and
`pnpm-workspace.yaml`. Dependency changes require `pnpm security:refresh` and
review of the resulting snapshot. `pnpm security:audit` is deterministic and
does not access the network.

## Accepted Pre-release Dependencies

Tracked here so the `scripts/check-risk-register.mjs` expiry gate forces a
periodic re-review even though `pnpm audit` reports no advisory for these.

| Package | Note | Current path | Decision | Next review |
| --- | --- | --- | --- | --- |
| `nitro` (`3.0.260610-beta`) | Pre-release dependency (no CVE). Nitro 3 server bundling for TanStack Start; no compatible Nitro 3 GA release is available. | Build-time and generated server runtime through `nitro/vite`. | Accepted as an exact curated beta while the explicit runtime-profile builds are implemented. Re-evaluate against the latest compatible stable release. | 2026-09-24 |

## Resolved Previous Accepted Advisories

- The 2026 esbuild, protobufjs, launch-editor, js-yaml, scoped launch-editor,
  ws, and qs findings were removed by compatible lockfile overrides or by
  removing React Cosmos. The 2026-08-24 low-level audit reports zero findings.

## Implemented Controls

- Global TanStack Start middleware now sets report-only CSP, clickjacking, referrer, content-type, permissions-policy, and production HSTS headers.
- `/api/upload` now requires same-origin `Origin` on non-GET requests; Better Auth routes and the Resend webhook keep their provider-specific protection.
- TanStack Router/Start incident package versions and vulnerable TanStack floors are blocked by `scripts/check-tanstack-security.mjs`.
- CI installs dependencies with lifecycle scripts disabled, then explicitly runs trusted local build metadata generation.
