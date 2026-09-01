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
runtime. Those commands are therefore named `verify:artifact:*` and
`verify:artifacts`. The Node target additionally has an executable
`verify:node` HTTP/stream gate. The names `verify:vercel`,
`verify:cloudflare`, and `verify:profiles` remain reserved until their
executable adapter contracts exist.

The initial Cloudflare artifact still contains Node-oriented composition and
does not start successfully in workerd. No preview or deployment command is
public until profile-specific composition removes that graph and an executable
gate proves the result.

The first Node artifact smoke exposed a stream-ownership defect: post-render
CSP placeholder replacement created a derived `Response` body after TanStack
Start had registered serialization listeners on the original stream. Start
disposed the original response while the derived pipe was still active. The
security middleware now mutates only the original response headers; the router
and platform UI providers receive the request nonce before rendering. This also
avoids depending on the related upstream router cleanup work in
[TanStack Router #7529](https://github.com/TanStack/router/issues/7529).

`pnpm verify:node` builds the Node artifact, migrates an isolated PGlite
database, boots the emitted server, requests `/login` twice, and asserts HTTP 200,
bounded clean stream completion, TanStack's serialization end marker,
CSP/HTML nonce agreement, per-response nonce freshness, and absence of the
former placeholder. The gate ignores repository `.env*` files, verifies that
the reserved database listener is PGlite, checks child liveness, and hydrates
the production response in Chromium before opening a Base UI Select under the
enforced CSP and verifying its generated scrollbar style carries the request
nonce.

Before a target is production-ready, its runtime gate must exercise the built
application with that profile's database, storage when enabled, trusted client
IP, lifecycle, rate limiting, and telemetry adapters. Cloudflare additionally
requires workerd tests with Hyperdrive and conditional R2 bindings. Vercel must
prove serverless lifecycle ownership. Node has proven the emitted entry and
clean response stream; lifecycle-owned telemetry shutdown remains a release
blocker.
