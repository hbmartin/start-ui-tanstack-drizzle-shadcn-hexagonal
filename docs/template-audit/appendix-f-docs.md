<!-- Appendix F of the template improvement audit. See ./REPORT.md for the synthesis. -->

# Track: Documentation Architecture

## 0. Diagnosis

The template ships **five root markdown files, four `docs/` files, three `.claude/rules/` files, and one generated artifact** — and no mechanism of any kind that ties any of them to the code. There is no doc linting, no link checking, no "does this symbol exist" check, and `pnpm check` (`package.json:132`) contains eleven commands, none of which reads a `.md` file except `security:risk-register`, which reads only dates.

The result is measurable rather than rhetorical. Verified in this session:

- **Two documents in the template were written for an entirely different codebase** and describe Biome, MongoDB, Stripe, Twilio, WhatsApp, Prisma, and jscpd — none of which exist here.
- **Two source-comment citations point at a file that does not exist** (`docs/security-rate-limiting.md`). The template's own markdown links all resolve; the dead references are inside TS comments, which is precisely why nothing catches them.
- **The template documents a function name that does not exist in `src/`** (`beforeLoadAuthenticated()`), and **that error propagated verbatim into APP2's `CLAUDE.md:101`** — a fork inherited a factual error from the template's docs and re-stated it as authoritative.
- **APP1's `CLAUDE.md:15` contains a paragraph whose entire job is to warn the agent that the repo's own `AGENTS.md` and `docs/strict-modular-monolith.md` are lying.** That is the fork-level workaround for a template-level defect, and it is the single clearest statement of the problem in either repo.

Both apps independently created a root `CLAUDE.md` and a `CONTEXT.md` (corpus-confirmed, re-verified: `/home/user/hume-demo/CLAUDE.md`, `CONTEXT.md`, `/home/user/iris-insights-crm/CLAUDE.md`, `CONTEXT.md`). Both independently rewrote the README from scratch into different shapes. Neither could use the template's docs as-is.

---

## 1. The drift ledger

Every stale claim I verified, with the correction. All line numbers re-read today.

### 1.1 `README.md`

| Line | Claim | Reality | Correction |
|---|---|---|---|
| 3 | "created & maintained by the [BearStudio Team]" | This is hbmartin's fork; `package.json:8` points bugs at `hbmartin/start-ui-web` while `package.json:11-14` still lists `Ivan Dalmet` as author | Rewrite attribution; fix `package.json.author` in the same change |
| 11 | Advertises `[📋 React Hook Form]` and `[🔌 oRPC]` | Neither is in `package.json` (verified: `grep 'orpc\|react-hook-form' package.json` → nothing). Forms are TanStack Form; there is no RPC layer | Delete both. Replace `[🧩 shadcn/ui]` with "shadcn-style components on `@base-ui/react`" (`package.json:156`) |
| 15 | "refer to the [documentation](https://docs.web.start-ui.com)" | Upstream BearStudio's docs site; documents a stack this fork has diverged from (oRPC, Chakra-era conventions) | Delete, or repoint at `AGENTS.md` + `docs/` |
| 26 | `pnpm create start-ui -t web myApp` | Scaffolds **upstream** start-ui-web, not this fork. This is the literal first command a forker runs and it produces the wrong repo | Replace with `git clone`/degit of `hbmartin/start-ui-web` + `pnpm rename` |
| 50-54 | Installation: `cp .env.example` → `pnpm install` → `dk:init` → `db:init` | **Breaks on step 4.** `.env.example:61` ships `AUTH_SECRET="REPLACE ME"`, which fails both the 32-char floor and the placeholder set at `src/modules/kernel/infrastructure/config/auth.ts:13-22` (`'replace me'` is a literal member). `SKIP_ENV_VALIDATION` is commented out at `.env.example:47-48` so validation runs | Insert a secret-generation step, or ship `pnpm setup` |
| 154-166 | "OpenAPI Documentation for the API … `http://localhost:3000/api/openapi/app`" — "complete documentation of all backend endpoints exposed by the API" | **No such route.** `find src/routes/api -type f` returns eight files, none named `openapi`. The only OpenAPI surface is Better Auth's plugin (`src/modules/auth/infrastructure/better-auth/auth.tsx:120`), mounted at `/api/auth/open-api/generate-schema` and `/api/auth/reference`, **disabled by default** (`AUTH_OPENAPI_ENABLED` defaults to `false`, `src/modules/kernel/infrastructure/config/auth.ts:71`), and covering **auth endpoints only**. This whole section is oRPC-era residue | Rewrite as "Better Auth OpenAPI reference (opt-in)" with the real path and the env flag, or delete |
| 210-211 | "Set production values for … `VITE_BASE_URL`" / "Point `VITE_BASE_URL` at the deployed HTTPS URL" | Corpus-confirmed: this is the field whose absence took down every route in Iris (`9fcb5c1`). The correct posture is a server-side canonical origin resolver | Rewrite once the app-url work lands; until then, add an explicit warning that it is required and validated lazily |
| 266 | "this app can derive `VITE_BASE_URL` from Vercel's preview environment variables" | **False.** `src/platform/env/config.ts:32` keys on `VITE_VERCEL_ENV`/`VITE_VERCEL_BRANCH_URL`. I re-ran the grep: those two names appear in exactly one place in the entire repo — that line. Vercel sets `VERCEL_ENV`/`VERCEL_URL`, unprefixed. Nothing in `.env.example` or any workflow mirrors them | Delete the sentence; replace when the resolver lands |
| — | No mention of `src/modules`, hexagonal, modular monolith, composition, public gates, dependency-cruiser, Sheriff, Semgrep, or Stryker | Verified: `grep -iE 'src/modules\|hexagon\|composition\|depcruise\|sheriff\|semgrep\|stryker\|modular monolith\|public gate' README.md` → the only `src/modules` hits are 139/141, about email templates | Add an Architecture section (see §3.1) |

Not stale, contrary to what a skim suggests: `pnpm e2e`, `e2e:setup`, `e2e:ui` (README:187-189) **do** exist; `cosmos-export` and `gen:icons` exist; README:79 **does** link `AGENTS.md` and `TESTING.md`; the Observability (94-114) and CodeQL (118-123) sections are accurate.

### 1.2 `docs/strict-modular-monolith.md`

| Line | Claim | Reality | Correction |
|---|---|---|---|
| **112-114** | "This app does not define `src/start.ts`, so the default chain is in effect." | `src/start.ts` **exists** (7455 bytes) and registers `csrfMiddleware` at `:238` and `:252`. This is the highest-severity doc defect in the repo: the security-critical middleware chain is documented as absent | **Port APP2's replacement verbatim** — see §4.1 |
| 20-28 | Module shape lists `index/presentation/client/server/factory` + four layers | Omits `backend.ts` and `testing.ts`, which `AGENTS.md:58,61` and `.claude/rules/modules.md` both list as public gates. The two documents contradict each other | Add both gates |
| 30-31 | "Cross-module imports must use `index.ts`, `presentation.ts`, `client.ts`, or `server.ts`" | Same omission | Same |
| 66-67 | "enforce auth in `beforeLoad` via **`beforeLoadAuthenticated()`** from `@/modules/auth/presentation`" | **The function does not exist.** `grep -rn "beforeLoadAuthenticated" src/` → zero hits in the template *and* zero in APP2. The real export is `requireAuthenticatedRouteOrForbidden` (`src/modules/auth/presentation/route-guards.ts:131`, re-exported `src/modules/auth/presentation.ts:21`, used `src/routes/manager/route.tsx:10`) | Rename. **This error is already replicated in `/home/user/iris-insights-crm/CLAUDE.md:101`** |
| 83-85 | "`telemetry` — Sentry adapter exposing `captureException`, `setUser`, and a `startSpan` helper" | The slot is typed `TelemetryAdapter` from `@/platform/telemetry` (`src/platform/router/context.ts:4,31`); the proxy at `src/platform/telemetry/runtime.ts:12-21` fronts seven methods and OTel is the primary backend | Rewrite as OTel-first with Sentry as one adapter in the chain |
| 88-89 | "`tenant` — reserved slot for active-tenant context" | **No `tenant` key exists** in `RouterContext` (`src/platform/router/context.ts:16-34` has exactly `queryClient`, `auth`, `telemetry`, `flags`). Confirmed absent in APP2's copy too | Delete. **Also already replicated in `/home/user/iris-insights-crm/CLAUDE.md:101`**, which tells routes to read `tenant` off context |

### 1.3 `AGENTS.md`

| Line | Claim | Reality | Correction |
|---|---|---|---|
| 1 | `# Agent Instructions for start-ui-web` | Brand literal; APP1 changed it to "SparkEd", APP2 left it as `start-ui-web` (verified `head -1 AGENTS.md` in both) | Derive from `package.json.name` via the rename script |
| 15 | "`pnpm check`: format, lint, typecheck, depcruise, semgrep, audit" | The real script (`package.json:132`) also runs `architecture:graph:check`, `check:test-layering`, `check:migrations`, `knip:deps` — and **does not** run `lint:sheriff` or `check:node-version` | Generate this row from `package.json` (see §6) |
| 16 | "`pnpm test`: Vitest unit and browser projects" | Three projects: `browser` (vitest.config.ts:52), `unit` (:74), `integration` (:92) | Add integration |
| 80 | Result examples are `{ type: 'book_found'; book: Book }` | Demo-domain vocabulary in the canonical agent doc — survives demo deletion and confuses forks | Use `user_not_found` (APP2's `CLAUDE.md` already does) |
| 132-147 | Test table | Never mentions adding a module, and `grep -n -iE 'new module\|scaffold\|adding' AGENTS.md TESTING.md` returns one hit, about E2E scope | Add an "Adding a capability" section pointing at `docs/adding-a-module.md` |
| — | Sheriff is never mentioned in `AGENTS.md` at all | Yet `docs/security practices.md:23,48` claims it runs in CI, and `grep -rn 'sheriff' .github/` → zero | See §1.5 |

### 1.4 `TESTING.md`

| Line | Claim | Reality | Correction |
|---|---|---|---|
| 15 | "Visual regression — `tests/e2e/visual/*.visual.spec.ts` — `pnpm test:e2e:visual`" | There are **two** visual layers. `test:visual = run-s test:browser:visual test:e2e:visual`, where `test:browser:visual` runs `vitest --config vitest.visual.config.ts` over `tests/browser-visual/`. TESTING.md documents only the Playwright one | Add the Vitest-browser visual row and `pnpm test:visual` |
| 15 | "local Playwright snapshots" | `find __visual_snapshots__ -type f` → six PNGs, **all** `-chromium-darwin.png`, while `.github/workflows/e2e-tests.yml:31,174` run `ubuntu-latest`, which produces `-chromium-linux` | State the baseline platform policy explicitly (see §5, owner decision) |
| 63 | CodeQL opt-in | Accurate | — |
| — | Never states that `pnpm test` can exit 0 with failing tests | Corpus: PGlite teardown at `tests/server/pglite-global-setup.ts:55-58` discards `process.exitCode` | Once fixed, no doc change; until then, TESTING.md should say so |

### 1.5 `docs/security practices.md` — a foreign document

This file is not drifted. **It was written for a different codebase and copied in wholesale.** Verified against `package.json` and `.github/`:

| Claim | Line | Verdict |
|---|---|---|
| "Biome with `--error-on-warnings`" | 45, 69-71 | `@biomejs/biome` **absent**; `lint` is `oxlint .` |
| "`pnpm dupes` — jscpd code duplication detection" | 46 | **No `dupes` script.** `jscpd` is a devDependency with a `jscpd` key in `package.json` but no runner and no workflow |
| "`.github/workflows/ci.yml`" | 41 | **Does not exist.** Workflows are `code-quality.yml`, `codeql.yml`, `cosmos-pages.yml`, `dependency-review.yml`, `detect-secrets.yml`, `e2e-tests.yml`, `jittest.yml`, `mutation-testing.yml`, `osv-scanner{,-full}.yml`, `semgrep.yml`, `supply-chain.yml` |
| "`actions-scanning.yml`" / "Octoscan (`synacktiv/action-octoscan`)" | 21, 41, 50 | **Neither exists.** `grep -rln octoscan .github/` → nothing |
| "`db-migrate.yml` workflow … Pushover alerts" | 93 | **Does not exist.** No Pushover anywhere |
| "MongoDB to kernel/onboarding-simulation/introductions", "Stripe to memberships, Twilio to whatsapp, Attio to external-users" | 27 | **None of these packages or modules exist** |
| "mrkdwn-escaping", "prohibited PII patterns in WhatsApp logs" | 20, 27 | Slack/WhatsApp product concerns from another repo |
| "React Testing Library" | 62 | Absent; component tests are Vitest Browser |
| "`mongodb-memory-server`" | 61 | Absent |
| "`@fast-check/vitest`" | 64 | ✅ present (0.4.1) — one of the few true rows |
| "five high-risk modules: intros-consent, onboarding-checkout-payments, events-rsvps-communications, whatsapp-webhook-delivery, auth-totp-security" | 65 | **None exist.** Real Stryker scopes are `auth, kernel, user, book, shared` (`.github/workflows/mutation-testing.yml:21`) |
| "123 custom rules" (Semgrep) | 20, 49, 90 | Actual: **101** (`grep -c "^  - id:" .semgrep.yml`) |
| "51 … rules" (dependency-cruiser) | 22, 47, 90 | Actual: **57** (`require('./.dependency-cruiser.cjs').forbidden.length`) |
| "Sheriff … `pnpm lint:sheriff` in CI" | 23, 48 | **Sheriff runs nowhere.** `grep -rn sheriff .github/` → zero hits; absent from `check` (:132), `check:ci` (:133), `verify` (:134) |
| "Vercel's managed infrastructure … Edge Config failures return safe defaults" | 34, 83 | No Vercel/Edge Config coupling in this repo |

**Both apps inherited it. APP1 rewrote it** (`diff` shows a full rewrite of the scanner table and CI pipeline sections into CodeQL/detect-secrets/OSV/Socket/Dependabot reality). **APP2's copy is byte-identical to the template's** — `diff` returned nothing. So a fork carrying a security-posture document that names Stripe and MongoDB is the *default* outcome.

### 1.6 `.claude/rules/testing.md` — a second foreign document

```
---
paths:
  - "src/**/{spec,test}.{ts,tsx}"
---

In unit tests for server routers, never use `toHaveBeenCalledWith` on Prisma mock
functions (`mockDb.*`). Always assert on the output/result returned by the route
handler instead.
```

That is the file in its entirety (`.claude/rules/testing.md:1-6`). Three independent defects:

1. **Prisma.** `grep -rl prisma` across the repo returns exactly two files: this one and `.vscode/extensions.json`. The ORM is Drizzle.
2. **The path glob matches nothing.** Tests live under `tests/`, not `src/`, and `src/**/{spec,test}.ts` matches files *named* `spec.ts`. `ls src/**/spec.ts src/**/test.ts` → no such file.
3. **It is the only content in the file**, so an agent loading the "testing rules" for this repo gets one wrong sentence about an ORM the repo does not use, while `TESTING.md`'s 87 lines of real strategy are never surfaced under that name.

**APP1 copied it byte-for-byte** (`diff` → IDENTICAL for all three `.claude/rules/*.md`). APP2 never created `.claude/` at all (`git log --all -- .claude` → empty), which is arguably the more honest response.

### 1.7 Dead cross-references from source

Two source comments cite a document that does not exist:

```
src/composition/telemetry/transport.ts:139
   cross-instance rate limiting must be enforced at the edge/WAF (see
   `docs/security-rate-limiting.md`)

src/modules/email/transport/http/resend-webhook-handlers.ts:56
   limiter is in-memory/per-process; durable cross-instance limits belong at the
   edge/WAF (see `docs/security-rate-limiting.md`).
```

`ls docs/` → `architecture/`, `security practices.md`, `security-risk-register.md`, `security-upload.md`, `strict-modular-monolith.md`. The corpus found one of these; there are two.

The forks split perfectly: **APP1 deleted both citations** (`a711431`); **APP2 wrote the file** (`docs/security-rate-limiting.md`, 84 lines) and both citations now resolve. Verified by running the same resolver over all three repos.

Also worth noting for the demo-removal track: `docs/security-upload.md` is cited from four places, **three of which are inside the demo `book` module** (`src/composition/book.ts:37`, `src/modules/book/application/ports/book-cover-storage.ts:27`, `src/modules/book/domain/book-policy.ts:43`, `src/modules/book/transport/upload/book-cover.ts:106`). Deleting the demo orphans that doc's audience.

### 1.8 `docs/security-risk-register.md`

Not a wording problem — a **merge-gate time bomb**, and the only doc the template does check. Every row's `Next review` cell is `2026-07-23`. Running `node scripts/check-risk-register.mjs` today exits 1 and prints six expired advisories. Because `security:risk-register` (`package.json:65`) is chained into `security:audit` (`:62`) which is in `check` (`:132`), **`pnpm check` fails on a fresh clone**. The doc-architecture consequence: this is what happens when a doc-honesty check has a hard-coded absolute deadline rather than a condition tied to reality. §6.3 addresses it.

### 1.9 Trivia

| Item | Fix | What breaks |
|---|---|---|
| `docs/security practices.md` (space in filename) | `git mv "docs/security practices.md" docs/security-practices.md` | Exactly one inbound reference: `.github/SECURITY.md:54`, which currently reads `[\`docs/security practices.md\`](../docs/security%20practices.md)`. Update to `[\`docs/security-practices.md\`](../docs/security-practices.md)`. Nothing in `src/`, `scripts/`, or CI references it. Both forks carry the same single reference, so the rename is a one-line follow-up for each |
| `CONTRIBUTING.md:9` | "assigned that issue by a **BearStudio's team member**" | Generic wording, or delete the clause |
| `CODE_OF_CONDUCT.md:63` | Reports go to `tech@bearstudio.fr` | Replace with a placeholder the rename script fills, or the fork's own contact |
| `.github/SECURITY.md:29` | "contact the maintainer listed in [`CODEOWNERS`](./CODEOWNERS)" | **`CODEOWNERS` does not exist** (`ls .github/CODEOWNERS CODEOWNERS` → both missing). Either ship a `CODEOWNERS` stub or drop the sentence |
| `.github/SECURITY.md:3-15` | "`start-ui-web` is an open-source starter …" + a `4.x` supported-versions table | Correct for the template, **wrong for every fork** — and both forks kept it. Add it to the rename checklist as a "delete or rewrite" item |

---

## 2. What each document is for

The template currently has no stated audience model, which is why the same layer rules are written four times (`AGENTS.md:107-119`, `.claude/rules/architecture.md`, `.claude/rules/modules.md`, `docs/strict-modular-monolith.md:13-57`) and drifted independently in at least two of them.

Proposed model — **one audience per file, one fact in one place, everything else links**:

| File | Audience | Answers | Never contains |
|---|---|---|---|
| `README.md` | Human, minute 0-30, has just forked | What is this, how do I make it mine, how do I run it, how do I add a module, how do I deploy | Architecture rules, env-var reference, test strategy |
| `AGENTS.md` | Coding agent + experienced contributor | Canonical commands, public gates, layer rules, Result/`AppError` policy, guardrails, adding a capability | Product description, install steps, operator runbooks |
| `CLAUDE.md` | Claude Code specifically | A **10-line index** into the above + the toolchain quirk + the "run targeted tests" working rule | Any rule that is not also in `AGENTS.md` |
| `CONTEXT.md` | Both | Ubiquitous language: domain terms, and the `_Avoid_` list | Anything about code structure |
| `TESTING.md` | Both | Layer map, escalation table, single-test invocations, quality gates | Architecture |
| `docs/adr/NNNN-*.md` | Both, later | Why a structural choice was made and what was given up | How-to |
| `docs/operations.md` | Operator / deployer | Env reference, production checklist, runbook, troubleshooting | Dev workflow |
| `docs/adding-a-module.md` | Contributor | The residue after `pnpm gen:module` | — |
| `docs/architecture/*` | Nobody directly — generated | Machine output | Hand edits |
| `.claude/rules/*.md` | Claude Code, path-scoped | **Nothing that duplicates `AGENTS.md`** | See §3.5 |

### The AGENTS.md / CLAUDE.md / CONTEXT.md split

Both apps arrived at the same shape independently and both got it right in the same way: **`CLAUDE.md` opens with an authoritative-references table and then adds only what is not elsewhere.** APP1's is 8043 bytes, APP2's 11240; both start with a table pointing at `AGENTS.md` / `TESTING.md` / `CONTEXT.md`.

The rule that makes this work — and which neither app wrote down — is:

> `CLAUDE.md` is an **index plus deltas**. If a statement in `CLAUDE.md` could equally live in `AGENTS.md`, it belongs in `AGENTS.md` and `CLAUDE.md` should link to it. `CLAUDE.md` legitimately owns: the reference table, toolchain quirks (`./bin/run`, Node version), the working rules about *how* to work (run targeted tests, never branch, fix docs on sight), and a "known staleness" section that should always be empty.

APP1's `CLAUDE.md:15` is the counter-example that proves the need: an entire paragraph enumerating which of the repo's own authoritative docs are lying. That paragraph should never need to exist — and the CI check in §6 is designed so that it cannot.

Proposed `CLAUDE.md` for the template (complete, ~40 lines):

```markdown
# CLAUDE.md

Guidance for Claude Code (claude.ai/code) working in this repository.

## Authoritative references

| File | Covers |
|---|---|
| `AGENTS.md` | Canonical commands, public gates, module/layer rules, Result/`AppError` policy, guardrails. |
| `TESTING.md` | Test layer map, escalation table, quality gates. |
| `CONTEXT.md` | Domain glossary (ubiquitous language). Update it when a domain term changes. |
| `docs/adding-a-module.md` | Adding a capability after `pnpm gen:module`. |
| `docs/adr/*.md` | Why the structural decisions were made. |
| `.claude/rules/*.md` | Path-scoped rules the harness applies automatically. |

When this file disagrees with `AGENTS.md` or `TESTING.md`, they win.

## Toolchain

Node 24 and pnpm 11.9.0, pinned in `.nvmrc`, `.node-version`, `mise.toml`,
and `package.json`. `pnpm doctor:node` verifies alignment.

## Commands

```bash
pnpm format:changed && pnpm check && pnpm test:affected   # after any change
pnpm verify                                              # before merge
pnpm vitest run --project=unit -t "test name substring"   # one test
pnpm test:e2e --project=chromium tests/e2e/login.spec.ts  # one e2e
```

## Working rules

**Run targeted tests while working; run the full suite only at the end.**
A full `pnpm test` costs over a minute; repeating it after every edit is the
largest avoidable time sink in this repo.

**Never create a branch unless explicitly asked.** Commit to the checked-out
branch. `git fetch` before drawing conclusions about what a branch contains.

**When a doc does not match the code, fix the doc in the same change.**
`AGENTS.md`, `TESTING.md`, `CONTEXT.md`, `README.md`, and `docs/**` are read as
authoritative. Renames are the usual culprit — change `CONTEXT.md` whenever a
domain term changes. `pnpm check:docs` catches the mechanical cases; it cannot
catch prose that is merely wrong.

## Known staleness

None. If you find a stale claim, fix it — do not add it here.
```

Both apps' "working rules" wording is generalizable almost verbatim: the "run targeted tests" rule and the "fix the doc in the same change" rule are APP2's (`/home/user/iris-insights-crm/CLAUDE.md`), and are template-level advice with no Iris specifics.

`CONTEXT.md` should ship as a **stub with the format demonstrated**, not a book-store glossary. Both apps converged on the same entry shape — term, definition, `_Avoid_:` list — which is worth encoding:

```markdown
# Domain Glossary

The ubiquitous language for this codebase. Use these terms in UI copy, domain
type names, test names, and commit messages. The `_Avoid_` list names the
synonyms that have caused confusion — reviewers should reject them.

Update this file in the same change as any domain rename.

<!-- Delete the example below and replace it with your own domain. -->

**Example Term**:
One or two sentences. Say what it *is*, and where the boundary is against the
neighbouring concept.
_Avoid_: Synonym one, synonym two

<!-- Where a UI term and a code identifier deliberately differ, say so here.
     APP2's pattern, worth copying:
     "KIT/KIQ is the term used in all UI copy; the domain type is still named
      `Theme` in `src/modules/launch-workspace/domain/`." -->
```

That last note is the highest-value thing in either app's `CONTEXT.md` (`/home/user/iris-insights-crm/CONTEXT.md:48`): it records a deliberate UI/code vocabulary divergence, which is exactly the fact a future reader would otherwise "fix" wrongly.

---

## 3. Proposed file set

### 3.1 `README.md` — restructured for a starter

The template's README is 375 lines that mix product pitch, install, feature reference, deployment guides for four platforms, and an FAQ. Both forks abandoned that shape: APP1's is product + setup + architecture + verification (10 sections); **APP2 retitled its README "Iris Operator Guide"** with sections `Current operating status / Requirements / Local setup / Adding users / Test setup / Configuration reference / Production runbook / Routine operations / Backup and recovery / Troubleshooting / Maintainer references`.

That divergence tells you the template README is trying to be two documents. Split it:

**`README.md` — the starter path, ~150 lines, five sections:**

```markdown
# start-ui-web

An opinionated TanStack Start starter: strict modular monolith, hexagonal
boundaries per capability, and a guardrail stack that enforces them.

Fork of [BearStudio/start-ui-web](https://github.com/BearStudio/start-ui-web),
diverged substantially — see UPGRADING.md.

## What you get

React 19 · TanStack Start / Router / Query / Form · Drizzle + Postgres ·
Better Auth · Tailwind 4 + shadcn-style components on @base-ui/react · Zod 4 ·
@bloodyowl/boxed Result · ts-pattern · Remeda · Vitest 4 · Playwright ·
OpenTelemetry · i18next

Enforced boundaries: dependency-cruiser (57 rules), Sheriff, Semgrep (101
rules), CodeQL, Stryker, and architecture tests under `tests/architecture/`.

## 1. Fork

```bash
pnpm dlx degit hbmartin/start-ui-web my-app
cd my-app && git init && pnpm install
```

## 2. Make it yours

```bash
pnpm rename my-app "My App"
```

This rewrites the app slug and display name across `package.json`, the OTel
tracer/meter/logger names, the `OTEL_SERVICE_NAME` defaults, the CSP nonce
bridge key, the migration advisory-lock namespace, the CodeQL pack path, and
the README/AGENTS.md titles. See `docs/renaming.md` for what it deliberately
does not touch and why.

Then decide about the demo domain:

```bash
pnpm remove:demo     # deletes the book/genre example module end-to-end
```

Both forks removed it; one of them took 190 files and 9,695 deleted lines to
do by hand.

Finally: this template ships `.github/SECURITY.md` and `CODE_OF_CONDUCT.md`
written for the upstream project. Rewrite or delete them.

## 3. Run

```bash
cp .env.example .env
pnpm dlx @better-auth/cli@latest secret   # paste into AUTH_SECRET in .env
pnpm dk:init                              # Postgres + MinIO + Maildev
pnpm db:init                              # push schema and seed
pnpm run env                              # verify configuration
pnpm dev                                  # http://localhost:3000
```

Seeded logins: `admin@e2e.local`, `user@e2e.local` (codes appear in Maildev).

`.env.example` is the canonical, commented reference for every variable.
`pnpm run env` validates both server and client schemas and fails closed.

## 4. Add a capability

```bash
pnpm gen:module billing
```

Then read `docs/adding-a-module.md` for what the generator does not do.
Architecture rules live in `AGENTS.md`; the layer diagram is regenerated with
`pnpm architecture:graph`.

## 5. Verify and deploy

```bash
pnpm check          # static gates
pnpm test:affected  # tests reachable from your changes
pnpm verify         # check + test + build — the merge gate
```

Deployment targets, the production configuration checklist, and the runbook
live in `docs/operations.md`.

## Where things are

| Path | What |
|---|---|
| `src/routes/` | Thin TanStack file routes |
| `src/composition/` | The only place concretes are wired |
| `src/modules/<capability>/` | domain / application / infrastructure / transport / presentation behind public gates |
| `src/platform/` | Module-agnostic substrate; must not import modules |
| `src/app/` | Shell, i18n, build-info, devtools |

`AGENTS.md` · `TESTING.md` · `CONTEXT.md` · `docs/`
```

Everything else moves: the four platform deployment guides (README:214-349), the production checklist (README:207-212), the observability configuration (README:92-114), the email/Resend setup (README:126-152), and the FAQ go to **`docs/operations.md`**. The Auth Route Freshness section (README:81-90) is an architecture rule and belongs in `AGENTS.md` or `docs/strict-modular-monolith.md`. Icons (README:168-180) and Cosmos go to `docs/ui-toolkit.md` or stay as a short appendix.

**Generalize APP2's "Configuration reference" section (`README.md:182-~495`) into `docs/operations.md`.** Its first 20 lines are entirely template-level and true of any fork — they explain the two caveats on `pnpm run env`, why `NODE_ENV=staging` must not downgrade production guards, and the platform-signal precedence. That text is better than anything the template has and required no Iris knowledge to write.

### 3.2 `AGENTS.md` — keep the shape, fix the content

`AGENTS.md` is the strongest document in the template and both forks kept its heading structure (APP2's is structurally identical; APP1 added `## Toolchain`, renamed `## Auth Boundary` → `## Access Boundary`, and dropped `## Async UI and Route Data`). Changes:

1. Apply the §1.3 corrections.
2. Replace the Canonical Commands table body with generated content (§6.2) so it cannot drift.
3. Add `## Adding a Capability` — a short section naming `pnpm gen:module` and linking `docs/adding-a-module.md`.
4. Add `## Observability` — currently `AGENTS.md` says nothing about telemetry, yet both forks did substantial telemetry work and both hit the same fallback/flush gaps.
5. Move the ~40 lines of layer/gate rules that `docs/strict-modular-monolith.md:13-57` duplicates into `AGENTS.md` and leave `strict-modular-monolith.md` owning only the *contracts* the shorter file cannot carry: Router Context, Response Cache Policy, CSRF Policy.

### 3.3 The ADR convention — port APP1's wholesale

APP1's `docs/adr/` is the best documentation artifact in any of the three repos, and APP2 has none. Seven ADRs, `NNNN-kebab-title.md`, each with:

```markdown
# ADR NNNN: Imperative title

- Status: Accepted | Superseded by ADR NNNN | Accepted, amended by ADR NNNN
- Date: YYYY-MM-DD
- Supersedes: ADR NNNN            (when applicable)

## Context
## Decision
## Consequences
```

What makes it work, and what to encode as the convention:

- **The lifecycle is actually exercised.** `0006` is `Status: Superseded by ADR 0007 (the apply path this serialized no longer exists)` — status carries the *reason*, not just the state. `0001` is `Accepted, amended by ADR 0007 (the plan/apply CLI and append-only lock are replaced by hume:sync and hume/pins.json; git-managed state and exact runtime pinning stand)` — an amendment names precisely which clauses survived.
- **Consequences state what was given up.** ADR 0007's Consequences section lists three explicit losses ("a pre-mutation drift report… the enforced CI-only apply path… marker-perfect crash recovery"). That is the section most ADR conventions omit and the one that pays off.
- **They explain apparent duplication.** ADR 0005: "Collapsing the two back into one re-creates whichever problem the surviving placement does not solve, so the apparent duplication is deliberate." That single sentence prevents a future contributor from "simplifying" a two-gate rate limiter.

**Ship in the template:** `docs/adr/README.md` (the convention, ~30 lines), `docs/adr/0000-template.md`, and **two real seed ADRs recording decisions the template has already made but never wrote down**:

- `0001-strict-modular-monolith-with-public-gates.md` — why capability modules with six gate files rather than layered folders; consequence: cross-module refactors are more ceremonious, and adding a module touches ~12 places (which is why `pnpm gen:module` exists).
- `0002-tagged-results-instead-of-exceptions.md` — why `@bloodyowl/boxed` `Result` with domain-tagged `Ok` variants; consequence: `try/catch` is confined to SDK boundaries, and every port signature is wider than a nullable return.

Candidates for later, all of which the corpus shows are live decisions with no written rationale: the platform/kernel `isProd` duplication (structurally forced by the platform-must-not-import-modules rule, and therefore permanently confusing without an ADR), the migration-immutability policy, and the dual-linter (oxlint + ESLint) posture — for which **APP1 already wrote the rationale** in `docs/oxc-tooling-decisions.md`, including an explicit removal criterion.

### 3.4 `UPGRADING.md` — new

Neither app has one, and both are now permanently detached from the template: APP1 is 123 commits ahead with `book`/`genre` still half-present; APP2 is 47 commits ahead having deleted the demo across 190 files. Neither can cherry-pick a template fix without archaeology. That is the cost of shipping a starter with no upgrade story.

Two audiences, two halves:

```markdown
# UPGRADING

## For forks: pulling template changes back in

This is a starter, not a dependency. There is no `pnpm upgrade` path — you
merge. Keep the merge possible:

```bash
git remote add template https://github.com/hbmartin/start-ui-web.git
git fetch template
git log --oneline HEAD..template/main -- src/platform src/modules/kernel
git merge template/main   # or cherry-pick individual fixes
```

Conflicts concentrate in files every fork edits: `package.json`,
`pnpm-workspace.yaml`, `.env.example`, `src/composition/index.ts`, the i18n
barrels, and `.github/workflows/code-quality.yml`. Files that rarely conflict
and are worth pulling wholesale: `src/platform/**`, `src/modules/kernel/**`,
`scripts/**`, `tests/architecture/**`.

If you ran `pnpm rename`, expect conflicts on the renamed literals. `git merge
-X ours` on `package.json` then re-running `pnpm rename` is usually faster than
resolving by hand.

### Fixes worth pulling regardless of how far you have diverged

Maintained as a table, newest first, so a fork can scan it in one pass:

| Since | What | Files | Why it matters to you |
|---|---|---|---|
| … | … | … | … |

## For this repository: version history

### 5.0.0 — unreleased

**Breaking**
- `unwrapApplicationResult` takes a required `logger` argument.
- Query keys from `scopedListQueryOptions` / `scopedEntityQueryOptions` gain a
  `'list'` / `'entity'` discriminator. Persisted query caches invalidate once.
- `VITE_BASE_URL` is removed from the client schema; the canonical origin is
  resolved server-side.

**Fixed**
- `pnpm env:client` validated nothing.
- `pnpm check` failed on a fresh clone (expired risk-register dates).
- CSP nonce rewrite replaced the SSR Response, breaking the stream contract.
```

The "fixes worth pulling" table is the part with real value: it is the artifact that would have let APP1 pick up APP2's `env:client` fix and APP2 pick up APP1's SSR-stream fix, neither of which happened.

### 3.5 `.claude/rules/` — delete three, replace with one

Current state: `architecture.md` and `modules.md` are **condensed restatements of `AGENTS.md`** — a fourth copy of the same rules, which is the mechanism by which `AGENTS.md` and `strict-modular-monolith.md` drifted apart in the first place. `testing.md` is foreign (§1.6). All three are byte-identical in APP1; APP2 has none.

The `paths:` front-matter in `testing.md` reveals the feature that actually justifies the directory: these are **path-scoped** rules, injected only when a matching file is touched. That is a real capability `AGENTS.md` does not have, and it is wasted on restating global rules.

Proposal — delete all three, ship rules that are only path-scoped and that appear nowhere else:

```
.claude/rules/
  migrations.md     paths: ["drizzle/migrations/**", "src/modules/*/infrastructure/drizzle/schema.ts"]
                    → files under drizzle/migrations are immutable; edit the schema and
                      run `pnpm db:generate`; run `pnpm check:migrations`.
  schemas.md        paths: ["src/modules/*/presentation/schema.ts"]
                    → emit static translation keys only; never import i18next.
  visual-baselines.md  paths: ["__visual_snapshots__/**", "tests/e2e/visual/**"]
                    → baselines are reviewed artifacts; never regenerate silently.
```

**What breaks:** nothing mechanical — nothing reads these files but the Claude Code harness. What is lost is the condensed architecture summary, which is replaced by `CLAUDE.md`'s reference table pointing at `AGENTS.md`. **Owner decision** if you disagree: keep `architecture.md`/`modules.md` but generate them from `AGENTS.md` sections so they cannot drift; my recommendation is deletion, because a summary that must be kept in sync is worse than a link.

### 3.6 `docs/architecture` — generated-artifact policy

`scripts/generate-module-dependency-graph.ts` writes **three** artifacts (`:387-390`):

```ts
const ARTIFACT_FILENAMES = {
  dot: 'module-layer-dependencies.dot',
  markdown: 'module-layer-dependencies.md',
  svg: 'module-layer-dependencies.svg',
};
const CHECKED_ARTIFACT_FILENAMES = [ARTIFACT_FILENAMES.dot];   // :39
```

The template commits **only the `.dot`** (`git ls-files docs/architecture/` → one file). Consequences, all verified:

- Running `pnpm architecture:graph` leaves **two untracked files** in a clean tree. Nothing in `.gitignore` mentions them (`grep -n 'architecture\|svg\|\.dot' .gitignore` → nothing). So the documented command dirties the repo.
- The committed `.dot` is a Graphviz source file — GitHub does not render it. **The one artifact a human could actually read (`.md`, a Mermaid flowchart that GitHub renders natively) is generated and thrown away.**
- APP2 committed all three (`docs/architecture/module-layer-dependencies.{dot,md,svg}`, the SVG at 64 KB) — but **only the `.dot` is drift-checked**, so its `.md` and 64 KB `.svg` can rot silently.

**Proposed policy, stated in `docs/architecture/README.md` and enforced in code:**

```markdown
# docs/architecture — generated artifacts

Do not hand-edit anything in this directory. Regenerate:

    pnpm architecture:graph          # rewrite artifacts
    pnpm architecture:graph:check    # fail if committed artifacts are stale

`module-layer-dependencies.md` is the human-facing artifact — a Mermaid
flowchart GitHub renders inline. It is committed and drift-checked.

`module-layer-dependencies.dot` is the Graphviz source. It is committed and
drift-checked because it is the input the SVG is rendered from and it diffs
meaningfully.

`module-layer-dependencies.svg` is NOT committed. It is a render of the DOT
that adds tens of kilobytes of unreviewable diff per change. Produce it on
demand with `pnpm architecture:graph` (gitignored) or from the DOT directly.
```

Three concrete edits:

1. `scripts/generate-module-dependency-graph.ts:39` → `const CHECKED_ARTIFACT_FILENAMES = [ARTIFACT_FILENAMES.dot, ARTIFACT_FILENAMES.markdown]`.
2. Commit `docs/architecture/module-layer-dependencies.md` and link it from `AGENTS.md` and `README.md`.
3. Add `docs/architecture/module-layer-dependencies.svg` to `.gitignore`.

**What breaks:** APP2 has the SVG committed; on merge it becomes untracked-and-ignored, which is harmless. **Owner decision:** whether to commit the SVG. My recommendation is no — a 64 KB binary-ish artifact regenerated on every module change is diff noise, and the Mermaid `.md` renders in the same places the SVG would.

The general rule this instantiates, worth stating once in `AGENTS.md`: *a generated artifact is either committed **and** drift-checked, or gitignored. Never committed and unchecked.* Under that rule the template today violates it in one direction (`.md`/`.svg` generated but neither committed nor ignored) and APP2 violates it in the other.

### 3.7 `docs/` target tree

```
docs/
  adr/
    README.md                      convention
    0000-template.md
    0001-strict-modular-monolith-with-public-gates.md
    0002-tagged-results-instead-of-exceptions.md
  architecture/
    README.md                      generated-artifact policy
    module-layer-dependencies.dot  generated, committed, checked
    module-layer-dependencies.md   generated, committed, checked  [NEW]
  adding-a-module.md               [NEW]
  operations.md                    [NEW — absorbs README:92-114,126-152,203-349]
  renaming.md                      [NEW — what pnpm rename touches and what it must not]
  security-practices.md            [REWRITTEN from APP1 — was "security practices.md"]
  security-rate-limiting.md        [PORTED VERBATIM from APP2]
  security-risk-register.md        [dates fixed, checker relaxed]
  security-upload.md               unchanged
  strict-modular-monolith.md       [CSRF section ported from APP2; §1.2 fixes]
```

---

## 4. Port-back register

### 4.1 Port verbatim

| Source | Target | Why |
|---|---|---|
| `/home/user/iris-insights-crm/docs/security-rate-limiting.md` (84 lines) | `docs/security-rate-limiting.md` | **Written entirely against template code paths** — `src/composition/telemetry/transport.ts`, `src/modules/email/transport/http/resend-webhook-handlers.ts`, `src/modules/auth/infrastructure/better-auth/auth.tsx`, `src/platform/http/get-client-ip.ts`, `TRUSTED_PROXY_DEPTH`, `AUTH_OTP_SEND_MAX`. Zero Iris specifics. It resolves both dead citations, and its §"Follow-up: Better Auth client-address resolution" documents a real template defect (`getIPFromHeader` returns `null` for multi-entry XFF, collapsing per-IP auth limits into one global bucket) with the exact upstream file:line. Its item 3 — "the telemetry limiter buckets unresolved addresses under `'unknown'`, while the Resend webhook limiter skips the check entirely" — is the corpus's rate-limit-policy finding, already written up |
| `/home/user/iris-insights-crm/docs/strict-modular-monolith.md:112-123` (CSRF Policy) | `docs/strict-modular-monolith.md:110-119` | Replaces the false "This app does not define `src/start.ts`" with an accurate description naming `createCsrfMiddleware`, `handlerType === 'serverFn'`, `referer: true`, `secFetchSite: 'same-origin'`, `browserMutationGuardMiddleware`, and the two guardrails that pin it (`tests/unit/start.unit.spec.ts`, the `no-csrf-origin-weakeners` semgrep rule). All of those exist in the template |
| `/home/user/hume-demo/docs/adr/` structure + `0005`, `0007` as convention exemplars | `docs/adr/README.md`, `docs/adr/0000-template.md` | Ship the *convention* and use these two as the worked examples of "Consequences that name what was given up" and "Status that names why" |

### 4.2 Port generalized

| Source | Target | Generalization needed |
|---|---|---|
| `/home/user/hume-demo/docs/security practices.md` | `docs/security-practices.md` | APP1's rewrite is scoped to *its* CI (CodeQL baseline gating, detect-secrets, OSV without SARIF upload, Socket, Dependabot). The template's CI differs — it still uploads SARIF and still has `dependency-review.yml`. Take APP1's **structure and honesty**, restate the scanner table against the template's twelve actual workflows, and replace the invented counts ("123 rules", "51 rules") with either the real numbers or, better, no numbers at all — numbers in prose are the fastest-rotting content in any doc |
| `/home/user/iris-insights-crm/README.md:182-~495` "Configuration reference" | `docs/operations.md` | The first ~20 lines are already template-general: the two caveats on `pnpm run env`, the "production is derived from the platform signal, not `NODE_ENV`" explanation, and the `preview`-stays-production-grade rule. The per-variable body needs re-deriving from the template's `.env.example` |
| `/home/user/iris-insights-crm/README.md:495-621` (Production runbook / Routine operations / Backup and recovery / Troubleshooting) | `docs/operations.md` | Section skeleton is fully general; content needs re-authoring against Postgres/MinIO/Resend rather than Iris's stack |
| `/home/user/hume-demo/README.md:16-70` "Local setup" | `README.md` §3 + `docs/operations.md` | The mise / `.nvmrc` / `.node-version` / `bin/run` explanation is toolchain-general and pairs with the corpus's node-version-guard finding |
| Both apps' `CLAUDE.md` reference table + working rules | `CLAUDE.md` (§2) | Two independent inventions of the same artifact — the strongest signal in this track |
| Both apps' `CONTEXT.md` term/`_Avoid_` format | `CONTEXT.md` stub (§2) | Ship the format, not a domain |
| `/home/user/hume-demo/docs/oxc-tooling-decisions.md` | `docs/adr/00NN-linting-toolchain.md` | Only if the oxlint consolidation is adopted. Its removal criterion — "Remove this compatibility pass only after Oxlint can demonstrate equivalent typed SonarJS coverage. Compare diagnostics from both paths before removal." — is exactly what an ADR's Consequences section is for |

### 4.3 Do not port

| Source | Why not |
|---|---|
| `/home/user/hume-demo/CLAUDE.md:15` (the staleness-trap paragraph) | It is the symptom. Porting it institutionalizes the defect. The template's `CLAUDE.md` should have a `## Known staleness` heading whose body is the single word "None." |
| `/home/user/hume-demo/docs/production-observability.md` | Genuinely app-specific — hardcodes `SENTRY_ORG=harold-martin`, `hume-demo-web`, Honeycomb datasets, and the Voice Event Archive. Its *shape* (Ownership → Environment → Transport → What to watch → Views → Verification) is a good skeleton for a template `docs/operations.md#observability`, but nothing in the body survives |
| `/home/user/hume-demo/docs/server-persistence-and-identity-{plan,operator-checklist}.md` (27 KB + 14 KB) | Project-plan documents for a migration that had not happened. Valuable as evidence that operator checklists were needed; not template content |
| `/home/user/iris-insights-crm/MARKET-BRIEF.md`, `compass_artifact_wf-*.md` (35 KB + 30 KB at repo root) | Research dumps. Worth noting as an anti-pattern the template should discourage: `docs/` exists for a reason, and two 30 KB unlabelled files at the repo root are a fork-specific mess |
| `.claude/rules/testing.md` (all three repos) | Delete (§3.5) |

---

## 5. Drift prevention: `pnpm check:docs`

The single highest-leverage item in this track. Nothing today reads a markdown file for correctness, and every defect in §1 is mechanically detectable.

### 5.1 The script

`scripts/check-docs.mjs`, no new dependency, wired into `check`, `check:ci`, and the CI job.

```bash
pnpm check:docs              # verify; non-zero exit on any violation
pnpm check:docs --fix        # rewrite the generated blocks in place, then re-verify
pnpm check:docs --list       # print every doc→code reference it found and resolved
```

`--fix` edits exactly one thing: content between generated markers. It never touches prose.

### 5.2 What it checks

| # | Check | Catches (from §1) | How |
|---|---|---|---|
| 1 | Every `docs/…​.md` path cited in a `.md` file **or in a `//` / `/* */` comment under `src/`, `scripts/`, `tests/`** resolves | `transport.ts:139`, `resend-webhook-handlers.ts:56` | `grep -roE "docs/[A-Za-z0-9._/-]+\.md"`, `fs.existsSync` each. I ran exactly this by hand today; it found both dead refs and confirmed the other nine resolve |
| 2 | Every relative markdown link in root + `docs/` + `.github/` resolves | `.github/SECURITY.md` → `CODEOWNERS` (missing) | Parse `](path)`, allow `#anchor` |
| 3 | Every `pnpm <script>` named in `README.md`, `AGENTS.md`, `TESTING.md`, `CLAUDE.md`, `docs/**` exists in `package.json.scripts` | `pnpm dupes` (§1.5) | Set membership. This is how I found `dupes` |
| 4 | Every `` `path/like/this.ts` `` or `` `src/…` `` in root docs resolves on disk | `.github/workflows/ci.yml`, `db-migrate.yml`, `actions-scanning.yml` | Only for backticked strings containing `/` and a known extension, to avoid false positives on prose |
| 5 | Every `` `identifier()` `` in root docs + `docs/**` that looks like an exported symbol appears in `src/` | **`beforeLoadAuthenticated()`** | `grep -rF` the bare name across `src/`. Deliberately loose: existence anywhere in `src/`, not signature checking. Opt-out via an inline `<!-- check-docs: ignore-symbol -->` |
| 6 | Every `` `PACKAGE_NAME` `` or bracketed-link technology in `README.md`'s Technologies line is in `package.json` deps | oRPC, React Hook Form (README:11) | Match against the union of `dependencies` + `devDependencies` |
| 7 | No module name appearing in `.dependency-cruiser.cjs`, `sheriff.config.ts`, `.semgrep.yml`, `.github/workflows/mutation-testing.yml`, or root docs lacks a directory under `src/modules/` | The whole `book`/`genre` residue class; APP1 still carries three depcruise rules matching zero files | Shared with the guardrails track; the docs half is the same check |
| 8 | Generated blocks are current | `AGENTS.md:15` command drift | See §5.3 |

Checks 5 and 6 are the ones with false-positive risk; both get an explicit ignore comment and both should ship in warn-only mode for one release before becoming fatal. **Marked as lower confidence** — I have not implemented them, and check 5 in particular will need tuning against `AGENTS.md`'s prose.

### 5.3 Generated blocks

The canonical-commands table drifts because it is transcribed. Make it generated:

````markdown
<!-- generated:commands start — edit package.json, then run `pnpm check:docs --fix` -->
| Command | Runs |
|---|---|
| `pnpm check` | format:check, lint, lint:eslint, typecheck, depcruise, architecture:graph:check, check:test-layering, check:migrations, semgrep, security:audit, knip:deps |
| `pnpm verify` | check + test + build |
<!-- generated:commands end -->
````

`--fix` rewrites the block from `package.json.scripts`, expanding `run-p`/`run-s` one level. Same mechanism for the module list in `README.md`'s "Where things are" table (from `readdirSync('src/modules')`) and the workflow list in `docs/security-practices.md` (from `readdirSync('.github/workflows')`) — which would have made §1.5's `ci.yml`/`actions-scanning.yml`/`db-migrate.yml` fabrications impossible.

### 5.4 Wiring

```jsonc
// package.json
"check:docs": "node scripts/check-docs.mjs",
"check":     "run-p -n format:check lint lint:eslint typecheck depcruise architecture:graph:check check:test-layering check:migrations check:docs lint:sheriff semgrep security:audit knip:deps",
"check:ci":  "…same…"
```

And — per the corpus finding that CI re-lists commands inline and has already diverged three ways — `.github/workflows/code-quality.yml` should invoke **`pnpm check:ci` as one step** rather than enumerating. Otherwise `check:docs` joins `lint:sheriff` and `knip:deps` in the set of gates that exist but never run, which is the exact failure mode this whole track is about.

Add `tests/unit/scripts/check-docs.unit.spec.ts` following the existing `tests/unit/scripts/check-risk-register.unit.spec.ts` precedent: fixture markdown with a dead link, a missing script, and a nonexistent symbol; assert each is reported.

### 5.5 Relaxing the risk-register time bomb

`scripts/check-risk-register.mjs:61-75` hard-fails on any past `Next review` date. For a template shipped to forks, that guarantees `pnpm check` fails N days after release — which it does today. Two changes:

1. Fail only when an entry is **both** past review **and** still reported by `pnpm audit --json`. An accepted advisory that has since been fixed by an override should not block anyone.
2. Ship the template's register with **zero** accepted entries, the table header, and a worked example inside an HTML comment. A starter should not inherit someone else's accepted risk.

Add to `docs/adr/`: the register's contract (dates are commitments, not decoration) is a decision worth recording, since the obvious "fix" is to delete the checker.

---

## 6. Effort and sequencing

Estimates are engineer-days for someone with the repos loaded. "Trivial" = under an hour.

### Wave 1 — stop the bleeding (≈1.5 days)

| # | Item | Effort | Blocks |
|---|---|---|---|
| 1 | Delete `.claude/rules/testing.md`; replace `architecture.md`/`modules.md` per §3.5 | trivial | — |
| 2 | Fix `docs/strict-modular-monolith.md`: port APP2's CSRF section; fix `beforeLoadAuthenticated`; delete `tenant`; add `backend.ts`/`testing.ts`; fix the telemetry slot description | 0.25 | — |
| 3 | Port `docs/security-rate-limiting.md` from APP2 verbatim | trivial | resolves 2 dead refs |
| 4 | Rewrite `docs/security practices.md` from APP1's version; `git mv` to `security-practices.md`; update `.github/SECURITY.md:54` | 0.5 | — |
| 5 | `.github/SECURITY.md`: ship `CODEOWNERS` or drop the reference; flag the file for rename | trivial | — |
| 6 | `README.md` line-level corrections only: 3, 11, 15, 26, 50-54, 154-166, 266; `package.json.author` | 0.25 | — |
| 7 | `AGENTS.md` line-level corrections: 1, 15, 16, 80 | trivial | — |
| 8 | Risk-register dates + relax the checker (§5.5) | 0.25 | **unblocks `pnpm check` on a fresh clone** |

Item 8 first — until it lands, nobody can run the gate that would validate the rest.

### Wave 2 — the new documents (≈3 days)

| # | Item | Effort | Notes |
|---|---|---|---|
| 9 | `CLAUDE.md` (§2, sketched in full) | 0.25 | |
| 10 | `CONTEXT.md` stub (§2, sketched in full) | trivial | |
| 11 | `docs/adr/README.md` + `0000-template.md` + two seed ADRs | 0.75 | |
| 12 | `docs/architecture/README.md`; commit the `.md`; add `.svg` to `.gitignore`; `CHECKED_ARTIFACT_FILENAMES` → include markdown | 0.25 | one-line code change |
| 13 | `docs/operations.md` — absorb README:92-114, 126-152, 203-349 + generalize APP2's config reference and runbook | 1.5 | largest single item |
| 14 | `README.md` restructure to §3.1 | 0.5 | after 13 |
| 15 | `UPGRADING.md` §3.4 | 0.5 | table starts empty and grows |

### Wave 3 — enforcement (≈2 days)

| # | Item | Effort | Notes |
|---|---|---|---|
| 16 | `scripts/check-docs.mjs`, checks 1-4 | 0.75 | highest value, lowest risk |
| 17 | Generated blocks + `--fix` (check 8) | 0.5 | |
| 18 | Checks 5-6, warn-only for one release | 0.5 | tune false positives |
| 19 | `tests/unit/scripts/check-docs.unit.spec.ts` | 0.25 | |
| 20 | Wire into `check` / `check:ci`; make `code-quality.yml` call `check:ci` | 0.25 | shared with guardrails track |

### Wave 4 — depends on other tracks (≈1 day, do not start early)

| # | Item | Depends on |
|---|---|---|
| 21 | `docs/adding-a-module.md` | `pnpm gen:module` existing — otherwise it is a 12-step manual checklist that rots |
| 22 | `docs/renaming.md` | `pnpm rename` existing |
| 23 | README §2 "Make it yours" final wording | `pnpm rename` + `pnpm remove:demo` |
| 24 | Rewrite `README.md:210-211, 266` on `VITE_BASE_URL` | the app-url resolver landing |
| 25 | `docs/adr/` entry for the linting toolchain | the oxlint consolidation decision |

**Total: ≈7.5 engineer-days**, of which Wave 1 (1.5 days) removes the two foreign documents, the false CSRF claim, the nonexistent function name, and the broken merge gate.

---

## 7. Decisions for the repo owner

| # | Question | Options | My recommendation |
|---|---|---|---|
| 1 | Is this fork a **starter people fork** or **your own app scaffold**? | Everything in §3.1-3.4 assumes the former | Starter. Both existing forks were made by third parties, `.github/SECURITY.md` already claims "an open-source starter that many projects build on," and it drives the README, `UPGRADING.md`, and the rename tooling |
| 2 | Commit `module-layer-dependencies.svg`? | Commit + check / gitignore | **Gitignore.** 64 KB of unreviewable diff per module change; the Mermaid `.md` renders everywhere the SVG would |
| 3 | Keep `.claude/rules/{architecture,modules}.md` as summaries? | Delete / generate from `AGENTS.md` / keep hand-written | **Delete.** They are the fourth copy of the same rules and are the mechanism by which `AGENTS.md` and `strict-modular-monolith.md` diverged |
| 4 | Does `docs/security-practices.md` survive at all? | Rewrite (APP1's shape) / delete and fold into `docs/operations.md` + `AGENTS.md` | **Rewrite, but strip every count.** "101 Semgrep rules" is already wrong; a doc that asserts numbers about generated things will always be wrong |
| 5 | Visual-baseline platform policy | Containerized linux baselines, committed / developer-local, gitignored, CI informational | I lean **gitignored + CI informational** given six macOS PNGs against ubuntu runners, but this is a testing-track call. Whichever way it goes, **state it in `TESTING.md`** — the current silence is the actual defect |
| 6 | `CODE_OF_CONDUCT.md` and `.github/SECURITY.md` in the template | Keep as upstream / rewrite as fork's / ship as clearly-marked templates a fork must edit | **Ship as marked templates** with a `<!-- REPLACE BEFORE PUBLISHING -->` header and add them to `pnpm rename`'s output checklist. Both forks silently inherited `tech@bearstudio.fr` as their security contact |
| 7 | Warn-only period for `check-docs` checks 5-6 | One release / immediately fatal | **One release, warn-only.** Symbol- and dependency-name matching over prose is the part most likely to be annoying, and a noisy new gate gets disabled rather than fixed |

---

## 8. Confidence

**High** — everything in §1 (every file:line opened and verified today, including the two foreign documents, both dead source citations, the `beforeLoadAuthenticated`/`tenant` errors and their propagation into APP2's `CLAUDE.md:101`, the nonexistent `/api/openapi/app` route, the missing `CODEOWNERS`, the `ci.yml`/`db-migrate.yml`/`actions-scanning.yml` fabrications, the 101-vs-123 and 57-vs-51 counts, the generated-artifact asymmetry, and the single `%20` inbound reference to the space-named file). Also high on the port-back register — I read APP2's `security-rate-limiting.md` and CSRF section in full and confirmed they reference only template-resident code.

**Medium** — `check-docs` checks 5 and 6 (symbol and dependency-name matching over prose): the *targets* are real and verified, but the false-positive rate is unmeasured because I did not implement them. Effort estimates for `docs/operations.md` (1.5 days) assume the deployment guides are moved largely as-is rather than re-verified against each platform's current behaviour; re-verification would roughly double it.

**Low / explicitly uncertain** — the visual-baseline recommendation (decision 5), which is a testing-track call I have only doc-level evidence for. And the claim that documentation friction *caused* either fork's divergence: I can show both forks independently created `CLAUDE.md` and `CONTEXT.md`, that APP1 wrote a paragraph warning about its own stale docs, and that APP2 inherited two factual errors verbatim — but the counterfactual (would better docs have kept them closer to the template?) is not something the repos can prove.
