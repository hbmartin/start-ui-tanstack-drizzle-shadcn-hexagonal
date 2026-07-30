# Upgrading your fork from the template

This starter is designed to stay a **living template**: after you fork it (or
scaffold with `pnpm create start-ui -t web`) you can keep pulling upstream
releases — security patches, dependency bumps, architecture improvements —
without them clobbering your product identity.

## The model

Two ownership zones:

- **Adopter-owned** — everything that makes the product *yours*. It is
  consolidated behind a small, explicit surface:
  - `src/app/adopter/**` — the adopter zone: `adopter.config.ts` holds the
    app name, brand mark, theme-token overrides, and default feature flags.
  - Brand assets in `public/` — favicons, touch icons, and the web manifest.

  These paths are listed in `.gitattributes` with `merge=ours`, so a template
  merge always keeps **your** side of them.

- **Upstream-owned** — everything else: `src/platform`, `src/modules`,
  `src/composition`, tooling, CI, security guards. Don't fork-edit these
  casually; the less you diverge, the cleaner every future upgrade merge.

Environment-driven identity stays env-owned rather than code-owned:
`VITE_ENV_NAME` / `VITE_ENV_COLOR` / `VITE_ENV_EMOJI` (environment hint),
`VITE_AUTH_SIGNUP_ENABLED` (public signup), and `DEPLOY_TARGET`
(cross-environment webhook isolation).

## How identity is injected

`src/platform` never imports the adopter zone (enforced by Sheriff and
dependency-cruiser). Instead:

- `src/router.tsx` calls `configureAdopter()` at boot, which applies the app
  name to page titles, and sources the router `flags` context from
  `adopterConfig.featureFlags`.
- `src/routes/__root.tsx` injects the brand mark through `BrandProvider`
  (rendered by the platform `Logo`) and layers `adopterConfig.themeTokens`
  as CSS custom properties over `src/platform/styles/app.css`.

To rebrand: edit `src/app/adopter/adopter.config.ts`, swap the `public/`
icons, done. No platform file needs to change.

## Pulling an upstream release

```bash
# See what's available
pnpm upgrade:template -- --list

# Preview the changelog and diff without merging
pnpm upgrade:template -- --tag v4.1.0 --dry-run

# Merge it
pnpm upgrade:template -- --tag v4.1.0
```

The script:

1. Ensures an `upstream` remote (defaults to the template repository — pass
   `--remote-url` to point elsewhere) and fetches tags.
2. Enables the `ours` merge driver (`git config merge.ours.driver true`),
   which is what makes the `.gitattributes` protection effective.
3. Shows the upstream commits and diff summary between your base (your last
   merged template tag, or `--base <ref>`) and the target tag.
4. Runs `git merge --no-ff <tag>`. The adopter zone and brand assets keep
   your side automatically; conflicts can only appear in files you diverged
   on — resolve them, `git add`, `git merge --continue`.

After the merge:

```bash
pnpm install
pnpm verify
```

If upstream added database schema, migrations arrive as new immutable files
under `drizzle/migrations` — deploy them as usual (`pnpm db:migrate`).

## Keeping upgrades cheap

- Put new product code in `src/modules/<your-capability>` and new app-shell
  code in `src/app` — upstream rarely touches your capabilities, so merges
  stay conflict-free.
- Resist editing upstream-owned files; when you must, keep the change small
  and consider proposing it upstream.
- Upgrade often. Many small merges beat one giant one.

## Out of scope (for now)

A route/feature extension registry (adding nav items and routes from the
adopter zone without touching upstream shell files) is a planned second phase
of this seam.
