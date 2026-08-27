<h1 align="center"><img src=".github/assets/thumbnail.png" alt="Start UI Web" /></h1>

🚀 Start UI <small>[web]</small> is an opinionated frontend starter repository created & maintained by the [BearStudio Team](https://www.bearstudio.fr/team) and other contributors.
It represents our team's up-to-date stack that we use when creating web apps for our clients.


## Technologies

<div align="center" style="margin: 0 0 16px 0"><img src=".github/assets/tech-logos.png" alt="Technologies logos of the starter" /></div>

[⚙️ Node.js](https://nodejs.org), [🟦 TypeScript](https://www.typescriptlang.org/), [⚛️ React](https://react.dev/), [📦 TanStack Start](https://tanstack.com/start), [💨 Tailwind CSS](https://tailwindcss.com/), [🧩 shadcn/ui](https://ui.shadcn.com/), [📋 React Hook Form](https://react-hook-form.com/), [🔌 oRPC](https://orpc.unnoq.com/), [🛠 Drizzle ORM](https://orm.drizzle.team/), [🔐 Better Auth](https://www.better-auth.com/), [🧪 Vitest](https://vitest.dev/), [🎭 Playwright](https://playwright.dev/)

## Documentation

For detailed information on how to use this project, please refer to the [documentation](https://docs.web.start-ui.com). The documentation contains all the necessary information on installation, usage, and some guides.

## Requirements

* [Node.js](https://nodejs.org) 24.x
* [pnpm](https://pnpm.io/)
* [Docker](https://www.docker.com/) (or a [PostgreSQL](https://www.postgresql.org/) database)

## Getting Started

```bash
pnpm create start-ui -t web myApp
```

That will scaffold a new folder with the latest version of 🚀 Start UI <small>[web]</small> 🎉

## Setup your IDE

- VS Code
```bash
cp .vscode/settings.example.json .vscode/settings.json
```

- Zed
```bash
cp .zed/settings.example.json .zed/settings.json
```

## TypeScript Path Aliases

This project uses Vite's native `resolve.tsconfigPaths: true` option to resolve aliases from `tsconfig.json`. If you need TypeScript path aliases in a Vite 8 project, check the [Vite paths documentation](https://vite.dev/guide/features#paths) before installing an extra plugin.

## Installation

```bash
pnpm install
pnpm setup # Interactive: choose core or demo and provide the application identity
pnpm dk:db:init # core: PostgreSQL only
# pnpm dk:init # demo: PostgreSQL plus MinIO bucket initialization
pnpm db:init
```

For a deterministic noninteractive setup:

```bash
pnpm setup -- --yes --preset=core --app-name="Acme Cloud" --app-slug=acme-cloud
```

There is no default preset. `core` enables auth, permissions, Profile, email
ports, and durable audit without requiring object storage. `demo` additionally
enables the books, genres, uploads, and demo seed data. Setup creates a private
`.env`, generates distinct authentication and rate-limit secrets, and leaves
optional email delivery and external telemetry exporters disabled until they are
configured. Browser telemetry and its local SQLite development sink remain on.
Email-dependent sign-in, invitation, verification, and reset delivery cannot
complete while email delivery is disabled.

`APP_NAME` is presentation identity and can be renamed. `APP_SLUG` is the stable
machine identifier used by durable consumers; change it only before the first
deployment unless you also supply an explicit data migration.

Inspect setup without writing files by adding `--dry-run`. Re-running the same
setup is byte-idempotent and preserves explicitly configured optional adapters.
The production build validates every supplied adapter value but does not require
deploy-time Upstash credentials. Production server startup still fails closed
until the distributed authentication limiter is configured.

> [!NOTE]
> **Don't want to use docker?**
>
> Setup a PostgreSQL database (locally or online) and replace the **DATABASE_URL** environment variable. Then you can run `pnpm db:push` to update your database schema and then run `pnpm db:seed` to seed your database.

Database transport is controlled by `DATABASE_TLS_POLICY`, not URL parameters. Loopback URLs default to `off`; every remote URL defaults to `verify`, including migration and Drizzle CLI processes. `encrypt` is an explicit opt-down that encrypts traffic without verifying the certificate or hostname. For private certificate authorities, extend the Node trust store (for example with `NODE_EXTRA_CA_CERTS`) instead of adding `sslmode` or certificate parameters to the database URL.

The trusted runtime entrypoint also fixes the request-path database adapter:
Node requires `DATABASE_DRIVER=node-pg`, while Vercel requires
`DATABASE_DRIVER=neon-http`. Maintenance migrations may independently use
`node-pg` or `neon-websocket`. The Cloudflare request path will use a separately
injected Hyperdrive binding rather than one of these process-owned drivers.
Live Worker startup fails explicitly until that binding contract is installed
and verified; artifact-only build validation remains available.

## Run

```bash
pnpm dk:start # Only if your Docker containers are not running
pnpm dev
```

## Verification

```bash
pnpm check           # Static checks: format, lint, types, architecture, test layering, security, audit
pnpm test            # Unit, browser, and integration tests
pnpm test:property   # Focused property/invariant tests
pnpm test:e2e        # Full Playwright user journeys
pnpm verify          # Full local pre-merge gate
pnpm verify:task     # Task verification logs; add --visual, --e2e-chromium, or --build as needed
```

`pnpm verify:task` writes timestamped logs under `test-results/task-verification/`. Its optional flags add visual regression tests (`--visual`), Chromium E2E (`--e2e-chromium`), and a production build (`--build`). See [AGENTS.md](AGENTS.md) and [Testing Strategy](TESTING.md) for the full verification workflow.

## Auth Route Freshness

Authenticated route guards live in TanStack Router `beforeLoad` hooks on the protected layout routes. The guards share the `auth.currentSession` query through router context so SSR requests and concurrent route checks use one sanitized session read.

Freshness differs by route:

* `/manager` passes `requireFresh: true` to `requireAuthenticatedRouteOrForbidden`. Client navigations always refetch the current session before allowing the manager shell, so revocation, sign-out, and role changes are observed before privileged manager UI renders.
* `/app`, `/login`, and `/onboarding` use the default session freshness. On SSR they fetch from the request context; on the client they may reuse the current-session query cache when it already has a value, and fetch when it does not. Auth boundary actions such as sign-in verification, onboarding completion, and sign-out clear or refresh the session cache and invalidate the router so the relevant `beforeLoad` hook reruns.

Use `requireFresh: true` for protected routes whose UI or loaders must observe authorization changes before render. The default cached session path is acceptable for lower-risk route transitions where avoiding an extra client fetch is preferred.

## Observability

The app uses OpenTelemetry for traces, metrics, and server-emitted logs, with Sentry kept for rich error tracking. Browser telemetry must stay same-origin:

* Browser OTel traces and metrics are exported with OTLP/HTTP protobuf to `/api/telemetry/otel/v1/traces` and `/api/telemetry/otel/v1/metrics`.
* Browser Sentry sends errors only, disables browser tracing, and uses the `/api/telemetry/sentry-tunnel` tunnel.
* Frontend logs are batched to `/api/telemetry/logs`; production source should use `frontendLogger` instead of `console.*`.
* Browser fetch instrumentation only propagates `traceparent` and `baggage` to same-origin requests and ignores `/api/telemetry/*`.
* Server OTel exports directly to `OTEL_COLLECTOR_URL` when configured. Without that env, server export is no-op and local/test proxy summaries can be written to `.telemetry/telemetry.sqlite`.

The telemetry layer derives Query and mutation operation names from static TanStack Query key segments, such as `book.getAll`. Dynamic key values are hashed before becoming attributes; raw dynamic values are only exposed in localhost/debug mode. Route loaders and `beforeLoad` guards are wrapped with route-level spans so navigation time, guard time, loader time, and Query time can be separated.

TanStack Query retry policy is intentionally bounded: queries retry transient/network and 5xx-style failures up to two times, do not retry numeric 4xx client errors, and mutations do not retry by default. Keep query keys aligned with `validateSearch` and `loaderDeps` for routes that read search params.

Optional local Collector:

```bash
docker compose --profile observability up otel-collector
```

The Collector receives OTLP/HTTP on port `4318` and exports to debug, Sentry OTLP, and Honeycomb OTLP exporters using the env vars in `.env.example`. Production browser CSP should not need Sentry, Honeycomb, or Collector origins in `connect-src`; browser traffic goes through the app proxy routes.

TypeScript is configured for ES2024 syntax. The Vite browser build target stays on the evergreen baseline (`baseline-widely-available`) rather than targeting IE-era browsers.

### CodeQL

CodeQL runs in GitHub Actions with the default and `security-extended` query suites plus repo-local queries under `.github/codeql/start-ui-web-queries`. Local CodeQL commands call the CodeQL CLI directly, install the local query pack dependencies first, and require the [CodeQL CLI](https://github.com/github/codeql-cli-binaries/releases) on your `PATH`.

```bash
pnpm codeql:test     # Compile and test local custom queries
pnpm codeql:db       # Create test-results/codeql/start-ui-web-db
pnpm codeql:analyze  # Analyze that DB and write test-results/codeql/start-ui-web.sarif
```

### Emails in development

#### Resend delivery

Emails are sent with [Resend](https://resend.com). Configure `RESEND_API_KEY`
with a Resend API key and set `EMAIL_FROM` to a sender from a verified domain.
Set `RESEND_WEBHOOK_SECRET` to the Resend/Svix signing secret for
`/api/webhooks/resend` delivery status callbacks.
Use `EMAIL_DELIVERY_DISABLED=true` when a workflow should skip delivery, such
as automated end-to-end test runs.

#### Preview emails

Emails templates are built with `react-email` components in the `src/modules/email/presentation` folder.

You can preview an email template at `http://localhost:3000/api/dev/email/{template}` where `{template}` is the name of the template file in the `src/modules/email/presentation/templates` folder.

Example: [Login Code](http://localhost:3000/api/dev/email/login-code)

##### Email translation preview

Add the language in the preview url like `http://localhost:3000/api/dev/email/{template}?language={language}` where `{language}` is the language key (`en`, `fr`, ...)

#### Email props preview

You can add search params to the preview url to pass as props to the template.
`http://localhost:3000/api/dev/email/{template}/?{propsName}={propsValue}`

### Generate custom icons components from svg files

Put the custom svg files into the `src/platform/components/icons/svg-sources` folder and then run the following command:

```bash
pnpm gen:icons
```

If you want to use the same set of custom duotone icons that Start UI is already using, checkout
[Phosphor](https://phosphoricons.com/)

> [!WARNING]
> All svg icons should be svg files prefixed by `icon-` (example: `icon-external-link`) with **square size** and **filled with `#000` color** (will be replaced by `currentColor`).

### E2E Tests

E2E tests are setup with Playwright.

```sh
pnpm e2e:setup  # Setup context to be used across test for more efficient execution 
pnpm e2e        # Run tests in headless mode, this is the command executed in CI
pnpm e2e:ui     # Open a UI which allows you to run specific tests and see test execution
```

> [!WARNING]
> The generated e2e context files contain authentication logic. If you make changes to your local database instance, you should re-run `pnpm e2e:setup`. It will be run automatically in a CI context.
## Production

Production targets are explicit and have isolated output contracts:

```bash
pnpm build                 # Node alias; writes .output/node
pnpm build:vercel          # Nitro Vercel preset; writes .vercel/output
pnpm build:cloudflare      # Cloudflare Vite plugin; writes dist
pnpm verify:artifacts      # Build and inspect all three artifact shapes
pnpm verify:node           # Build, boot, stream-test, and hydrate the Node artifact in Chromium
```

`pnpm preview:node` and `pnpm preview:vercel` run the corresponding
already-built output. Runtime selection is a trusted build input; the application never
infers a deployment profile from request hosts, forwarding headers, or ambient
provider variables.

The Vercel build and preview commands validate
`DATABASE_DRIVER=neon-http` and an effective `verify` TLS policy. Remote URLs
default to `verify`. For artifact-only validation with a loopback placeholder,
use `pnpm verify:artifact:vercel`; its isolated environment selects `verify`
while keeping the loopback migration policy `off`. Do not persist that verify
override in the shared local `.env`, because it would also apply to Node dev and
migration connections unless separately overridden. These checks do not
connect to the database or prove endpoint compatibility. Before exercising a
DB-backed Vercel request, supply a remote Neon-compatible `DATABASE_URL`; the
Neon HTTP driver cannot serve requests against the local Docker PostgreSQL
endpoint. Use the Node build/preview commands for that local driver.

Set `DATABASE_MIGRATION_URL` when migrations need a connection distinct from
`DATABASE_URL`; transaction-pooled migration URLs are rejected. Migrations may
use `node-pg` or `neon-websocket`; `neon-http` is rejected. The
default follows the request driver: `node-pg` for a Node request runtime and
`neon-websocket` for Vercel's `neon-http` runtime. Set
`DATABASE_MIGRATION_DRIVER=node-pg` explicitly when the maintenance URL is a
conventional direct PostgreSQL endpoint, and set
`DATABASE_MIGRATION_TLS_POLICY=off` when that endpoint is loopback and would
otherwise inherit a non-`off` request policy. When neither policy is configured,
the migration URL independently defaults to `off` for loopback and `verify` for
remote endpoints.
Conversely, a remote maintenance URL that would inherit
`DATABASE_TLS_POLICY=off` must set `DATABASE_MIGRATION_TLS_POLICY=verify`.

The v5 runtime work is intentionally incremental. The artifact commands prove
isolated output shapes and trusted profile injection. `pnpm verify:node` also
uses an isolated PGlite database and local Upstash configuration stub to boot the built
Node server and prove that `/login` returns HTTP 200, completes the TanStack
serialization stream within a bounded timeout, and applies one request nonce
consistently to the CSP header and every executable HTML tag. It then hydrates
the production response in Chromium, opens a Base UI Select under the enforced
CSP, and verifies Base UI's generated scrollbar style carries the request
nonce. Verification builds ignore repository `.env*` files and consume only
their generated, allowlisted child-process environment. Executable
adapter contract tests for Hyperdrive, R2, Worker lifecycle ownership, and the
Vercel serverless lifecycle land before Workers or Vercel are declared
production-ready.

The Node gate covers the emitted entry, streamed public-login response, and
strict-CSP browser hydration. Node
is not production-ready until its remaining adapter contracts and
lifecycle-owned telemetry shutdown are executable as well.

## Deploy

Node and Vercel use explicit Nitro presets. Cloudflare uses the official
Cloudflare Vite plugin and its generated deployment configuration. Do not set
`NITRO_PRESET`; use the target-specific command instead.

Before deploying anywhere:

* Use Node.js 24 or newer to match the current `package.json` engine.
* Set production values for the required variables in `.env.example`, especially the database, authentication secrets, canonical application URL, and public `VITE_*` values. Object storage is required only when its capability is enabled.
* Use explicit platform secrets and bindings. The Cloudflare artifact build disables implicit `.env` fallback and rejects local `.dev.vars*` files before bundling.
* Run your versioned migration command against the production database before serving production traffic. Do not use `pnpm db:push` for production deployments because it bypasses migration history.

<details>
<summary><strong>Cloudflare Workers</strong></summary>

Build and inspect the Worker artifact while the executable runtime gate is
under construction:

```bash
pnpm build:cloudflare
```

`wrangler.json` is the source configuration. The Cloudflare Vite plugin emits
the deployment snapshot at `dist/server/wrangler.json`; Wrangler automatically
uses that generated output after a build. `pnpm setup` keeps the Worker name in
sync with `APP_SLUG`. `.wrangler` and `.dev.vars*` are local-only and ignored.

The artifact build alone is not a deployment approval, so the v5 branch does
not yet expose a Cloudflare preview or deploy script. The production Worker
gate must first prove that the built graph starts in workerd and exercises
Hyperdrive, R2 when uploads are enabled, lifecycle flushing, and non-Node
adapters. Workers Builds configuration and deploy instructions return only
after that contract is executable.

Docs: [Cloudflare TanStack Start](https://developers.cloudflare.com/workers/framework-guides/web-apps/tanstack-start/), [Workers Builds image](https://developers.cloudflare.com/workers/ci-cd/builds/build-image/)

</details>

<details>
<summary><strong>Vercel</strong></summary>

Vercel uses the explicit Nitro `vercel` preset and emits Build Output API v3
under `.vercel/output`.

Deploy from Git:

1. Import the repository in Vercel.
2. Use the TanStack Start preset if it is shown, otherwise use the default project settings.
3. Set Node.js Version to `24.x`.
4. Set Build Command to `pnpm build:vercel`.
5. Leave Output Directory empty/default.
6. Add the production environment variables from `.env.example`.
   Set a remote Neon-compatible `DATABASE_URL`,
   `DATABASE_DRIVER=neon-http`, and `DATABASE_TLS_POLICY=verify` for the Vercel
   request runtime. For a conventional direct PostgreSQL maintenance endpoint,
   also set its separate URL and `DATABASE_MIGRATION_DRIVER=node-pg`; otherwise
   the Vercel request driver makes migrations default to `neon-websocket`.
7. Deploy.

Deploy from the CLI:

```bash
pnpm dlx vercel
pnpm dlx vercel --prod
```

Run `pnpm verify:artifact:vercel` locally or in CI to validate the function
entry, Node 24 runtime metadata, response-streaming flag, and static output.
Vercel selects the canonical application origin from its validated
`VERCEL_PROJECT_PRODUCTION_URL`, falling back to `VERCEL_URL`; Better Auth uses
that fixed origin rather than deriving links or callbacks from request hosts.
Because Vercel exposes the project production URL to preview deployments,
previews intentionally share the production callback origin. Use a separate
Vercel project when isolated preview authentication callbacks are required.

Docs: [TanStack Start on Vercel](https://vercel.com/docs/frameworks/full-stack/tanstack-start), [Vercel Node.js versions](https://vercel.com/docs/functions/runtimes/node-js/node-js-versions)

</details>

<details>
<summary><strong>Railway</strong></summary>

Railway deploys TanStack Start as a standard Node service. Railpack detects `package.json`, installs pnpm from `packageManager`, runs the `build` script, and uses the `start` script.

Deploy from Git:

1. Create a Railway project and deploy from the GitHub repository.
2. Add a PostgreSQL service or connect an external PostgreSQL database.
3. Add the production environment variables from `.env.example`.
4. Set `RAILPACK_NODE_VERSION=24` if Railway does not pick Node 24 from `package.json`.
5. Generate a public domain in the service Networking tab.
6. Set `APP_DOMAIN` to that exact HTTPS origin and redeploy.

Deploy from the CLI after installing and authenticating the Railway CLI:

```bash
railway init
railway up
```

If detection fails, set explicit commands in the service settings:

```text
Build Command: pnpm build
Start Command: pnpm start
```

Nitro reads Railway's `PORT` environment variable automatically.

Docs: [Railway TanStack Start](https://docs.railway.com/guides/tanstack-start), [Railway CLI deploys](https://docs.railway.com/cli/deploying), [Railpack Node.js](https://railpack.com/languages/node)

</details>

<details>
<summary><strong>Render</strong></summary>

Render should be configured as a Node Web Service that builds the Nitro output and starts the generated Node server.

Dashboard settings:

```text
Runtime: Node
Build Command: pnpm i --shamefully-hoist && pnpm build
Start Command: pnpm start
```

Environment variables:

```text
NODE_VERSION=24
HOST=0.0.0.0
```

Also add the production values from `.env.example`. Render provides `PORT`; Nitro reads `PORT` automatically.

Optional `render.yaml`:

```yaml
services:
  - type: web
    name: start-ui-web
    env: node
    buildCommand: pnpm i --shamefully-hoist && pnpm build
    startCommand: pnpm start
    envVars:
      - key: NODE_VERSION
        value: 24
      - key: HOST
        value: 0.0.0.0
```

Docs: [Nitro on Render](https://nitro-docs.pages.dev/deploy/providers/render/), [Render deploys](https://render.com/docs/deploys), [Render Node.js versions](https://render.com/docs/node-version)

</details>

## Show hint on development environments

Setup the `VITE_ENV_NAME` env variable with the name of the environment.

```
VITE_ENV_NAME="staging"
VITE_ENV_EMOJI="🔬"
VITE_ENV_COLOR="teal"
```

## FAQ

<details><summary><strong>git detect a lot of changes inside my <code>.husky</code> folder</strong></summary>
<p>
You probably have updated your branch with lefthook installed instead of husky. Follow these steps to fix
your hooks issue:
<ul>
  <li><code>git config --unset core.hooksPath</code></li>
  <li><code>rm -rf ./.husky</code></li>
  <li><code>pnpm install</code></li>
</ul>

From now husky should have been removed; and lefthook should run your hooks correctly.
</p>
</details>
