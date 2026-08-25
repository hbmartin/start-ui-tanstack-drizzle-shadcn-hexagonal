# ADR 0003: Explicit runtime artifact builds

- Status: Accepted for v5
- Date: 2026-08-24

## Context

The template previously used one unconfigured Nitro plugin and described the
result as portable across Node, Vercel, and Cloudflare. That allowed ambient
provider detection to select a preset and did not verify the output contract
for any deployment target. Cloudflare's supported TanStack Start path now uses
the Cloudflare Vite plugin and workerd rather than treating a Node Nitro bundle
as a Worker.

## Decision

Version 5 has three explicit build inputs and isolated outputs:

- `build:node` uses Nitro's `node-server` preset and writes `.output/node`;
- `build:vercel` uses Nitro's `vercel` preset and writes `.vercel/output`; and
- `build:cloudflare` uses `@cloudflare/vite-plugin` and writes `dist`.

`pnpm build` is only an alias for `build:node`. A production Vite build without
`START_UI_RUNTIME_PROFILE` fails closed. The selected entrypoint injects a
closed `RuntimeProfile`; request hosts, forwarding headers, and ambient
provider variables never choose application adapters.

Artifact verification checks the target preset, entry, public/static output,
platform metadata, generated Wrangler snapshot, and the compiled trusted
profile marker. CI builds both `core` and `demo` presets for all three targets.
The source `wrangler.json` uses `APP_SLUG` as its Worker name, and setup updates
that field atomically with environment and capability selection files.

## Consequences

Artifact verification proves build isolation and deployment shape, not a live
runtime. The current commands are therefore named `verify:artifact:*` and
`verify:artifacts`. The names `verify:node`, `verify:vercel`,
`verify:cloudflare`, and `verify:profiles` remain reserved for executable HTTP
and adapter contract tests.

The initial Cloudflare artifact still contains Node-oriented composition and
does not start successfully in workerd. No preview or deployment command is
public until profile-specific composition removes that graph and an executable
gate proves the result.

A manual Node artifact smoke rendered `/login` with HTTP 200, but the response
stream did not terminate before the existing serialization timeout. This is a
runtime-verification blocker, not evidence against the build output contract.
The future `verify:node` gate must assert bounded, clean stream completion.

Before a target is production-ready, its runtime gate must exercise the built
application with that profile's database, storage when enabled, trusted client
IP, lifecycle, rate limiting, and telemetry adapters. Cloudflare additionally
requires workerd tests with Hyperdrive and conditional R2 bindings. Vercel must
prove serverless lifecycle ownership; Node must prove the persistent process
entry, clean response-stream completion, and shutdown contract.
