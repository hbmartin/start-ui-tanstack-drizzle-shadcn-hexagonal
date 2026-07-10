# start-ui-web — minimal boilerplate

A bare-bones [TanStack Start](https://tanstack.com/start) starter, organized as
a strict modular monolith with hexagonal boundaries. This is a trimmed-down
fork: the sample business features (book, genre), authentication (Better Auth),
persistence (Drizzle ORM / Postgres), and transactional email (Resend) have been
removed so you can start from a clean, well-structured skeleton and wire in only
what you need.

## Technologies

[⚙️ Node.js](https://nodejs.org), [🟦 TypeScript](https://www.typescriptlang.org/), [⚛️ React](https://react.dev/), [📦 TanStack Start](https://tanstack.com/start), [💨 Tailwind CSS](https://tailwindcss.com/), [🧩 shadcn/ui-style primitives](https://ui.shadcn.com/), [🔎 TanStack Query](https://tanstack.com/query), [🌐 i18next](https://www.i18next.com/), [🪐 React Cosmos](https://reactcosmos.org/), [🧪 Vitest](https://vitest.dev/), [🎭 Playwright](https://playwright.dev/), [📈 OpenTelemetry + Sentry](https://opentelemetry.io/)

## What's included

- TanStack Start SSR app with a file-based router and a single public home page.
- A modular-monolith layout (`src/modules`, `src/platform`, `src/app`,
  `src/composition`) enforced by dependency-cruiser, Sheriff, Semgrep, and
  architecture tests.
- A `kernel` module providing cross-cutting primitives (clock, id generator,
  logger, cache, result/error types).
- A platform UI kit (shadcn/ui-style components), theming, i18n (en/fr/ar/sw),
  and form primitives.
- First-class observability: OpenTelemetry, a Sentry adapter, and same-origin
  telemetry proxy routes under `/api/telemetry/*`.
- Security middleware: CSP nonces, same-origin browser-mutation protection,
  CSRF, and security headers.

## What's been removed vs. the full starter

- Business sample features: **book**, **genre**.
- Authentication: **Better Auth** and the `auth` / `user` / `account` modules.
- Persistence: **Drizzle ORM**, Postgres, and all database migrations/seeds.
- Transactional email: **Resend** and the `email` module.

## Requirements

- [Node.js](https://nodejs.org) 24.x
- [pnpm](https://pnpm.io/)
- [Docker](https://www.docker.com/) (optional — only for local MinIO / the OTel collector)

## Installation

```bash
cp .env.example .env
pnpm install
```

## Run

```bash
pnpm dev
```

The app is served on the port defined by `VITE_PORT` (default `3000`).

## Verification

```bash
pnpm check   # format, lint, typecheck, depcruise, architecture, semgrep, audit, knip
pnpm test    # Vitest unit + browser projects
pnpm build   # production build
pnpm verify  # check + test + build
```

## TypeScript Path Aliases

Imports are aliased to `@/` for `src` and `@tests/` for `tests`.

## Observability

Server telemetry exports to an OpenTelemetry Collector when `OTEL_COLLECTOR_URL`
is set; browser telemetry always posts to the same-origin `/api/telemetry/*`
routes. Sentry is enabled by setting `SENTRY_DSN` / `VITE_SENTRY_DSN`. See
`.env.example` for the full list of telemetry options.

## Architecture

See [`AGENTS.md`](./AGENTS.md) and the rules under `.claude/rules/` for the
module shape, public gates, and layering constraints. New capabilities live
under `src/modules/<capability>` as vertical hexagonal slices and are wired in
`src/composition`.

## License

[MIT](./LICENSE)
