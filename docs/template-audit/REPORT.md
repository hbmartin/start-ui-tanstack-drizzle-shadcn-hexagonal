# start-ui template: improvement report

**Date:** 2026-08-07 · **Template HEAD:** `199954f` (2026-07-20) · **Compared against:** `hume-demo` @ `b4b02a3` (123 commits), `iris-insights-crm` @ `7e1ebdb` (47 commits)

---

## 1. Executive summary

This template is unusually rigorous. 57 dependency-cruiser rules, 101 Semgrep rules, a Sheriff config, 9 test layers, per-module mutation testing, CodeQL packs with custom queries, a security risk register with a policy check. Very few starters have this much machine-checkable architecture.

The problem is not rigour. It is that **the rigour is not wired up, the defaults are not satisfiable, and nothing in the repo tells the truth about itself.** Three measurements make the case:

- **`pnpm check` — the template's headline quality gate — exits 1 on a clean clone, today, offline.** Every row in `docs/security-risk-register.md` has a `Next review` date of `2026-07-23`; `scripts/check-risk-register.mjs` hard-fails on any past date, and it is chained into `check` via `security:audit`. Reproduced directly:
  ```console
  $ node scripts/check-risk-register.mjs ; echo $?
  Risk register policy failed: accepted advisories are past their review date: … 1
  ```
- **`hume-demo` did not fork this template. It transcribed it.** `845552c` "first commit" contains no `src/modules` at all; `2978d6c` is a **pure-addition** commit — 360 files, 23,553 insertions, **0 deletions**. Given the choice between forking-and-stripping and hand-copying what it wanted into an empty repo, one of the two real consumers chose transcription. And it still inherited three book icons, the `book|genre` branded IDs in `kernel/domain/ids.ts`, and three dependency-cruiser rules that match zero files in that repo 123 commits later.
- **`iris-insights-crm`'s first pull request is literally named `relax-db-tls-check-for-demo`.** Four of its first ten substantive commits remove template constraints: the sslmode requirement, mandatory OTEL, the client env schema, the risk register. A template whose first PR in every fork is "turn off the security check" has mis-set its defaults.

### The six things that block a fork tomorrow

| # | Blocker | Bites at | Evidence |
|---|---|---|---|
| 1 | **It does not start.** `.env.example:61` ships `AUTH_SECRET="REPLACE ME"`, which fails validation twice — the 32-char floor *and* the placeholder set at `kernel/infrastructure/config/auth.ts:13-22`, where `'replace me'` is a literal member. `pnpm dev` → `env:server` → dies. | hour 1 | README:50-54's four-step install breaks on step 4 |
| 2 | **Its own quality gate is red.** See above. A forker who sees the advertised gate fail on day one learns to bypass it. | hour 1 | reproduced by execution |
| 3 | **The demo will not come out.** iris's removal commit `8d2b7b4` touched **190 files / 9,695 deletions**. Only 8 files outside `src/modules/{book,genre}` actually *import* from them — the other 180 are string literals, i18n, permission matrices, nav config, CSS design tokens in `src/platform`, generated icons, seeds, migrations, guardrail regexes, Stryker configs and package.json scripts. | day 1–3 | §5 has the full checklist |
| 4 | **Guardrails silently stop applying to your modules.** Two dependency-cruiser layering rules hardcode `(book\|user\|genre\|account)` and fail open for any module you add. Sheriff — the only backstop — appears in **zero** aggregates and **zero** workflows: `grep -rn sheriff .github/` returns nothing. You believe you have hexagonal enforcement; you do not. | week 1, discovered never | `.dependency-cruiser.cjs:57-61, 75-79`; `sheriff.config.ts:44,47` |
| 5 | **You inherit four production defects wholesale.** Module-scope `envClient` read in the SSR bundle (took every route in iris down with a ZodError during Nitro's `loadEntries`); OTEL mandatory in production (both apps deleted it independently); `isProd()` split-brain on `NODE_ENV=staging`; CSP nonce rewrite that breaks TanStack Start's SSR stream contract (hume fixed it correctly, then deleted the entire CSP subsystem 40 minutes later and has shipped without it since). | week 2–4, in prod | §4, items P0.4–P0.7 |
| 6 | **The visual suite cannot pass in CI.** All 13 committed baselines are `*-chromium-darwin.png`; the only runner is `ubuntu-latest`, which produces `-chromium-linux`. `AGENTS.md` documents `verify:task -- --visual` as the escalation path for UI changes. | first UI PR | `find . -name '*-darwin*.png'` → 13; `-linux` → 0 |

### The headline judgement

**The whole P0 set is about three days of work.** Ten items, nine of them under half a day. Nothing in this report is more valuable than those three days, and shipping anything else first is a mistake — a template that does not start is a bad place to test improvements.

Beyond P0, the ordering principle that falls out of the evidence is: **a well-factored template is one where forks don't have to touch the shared files at all.** The single cleanest demonstration is `src/platform/http/browser-mutation-protection.ts:17` — a demo route (`'/api/upload'`) baked into a platform-level allowlist, which produced a *byte-identical* deletion in two independent forks that share zero commits. The propagation problem and the template-quality problem are the same problem.

---

## 2. How this was produced, and what "verified" means here

Thirteen parallel investigations, each followed by an adversarial verifier instructed to open every cited file and refute anything that did not hold. Then seven design tracks and a completeness critic that independently spot-checked the twenty highest-stakes claims.

- **315 findings survived** verification. **85 were refuted** and are listed in Appendix A2 so nobody re-derives them.
- **277 of 315 are high-confidence**, meaning the verifier opened the cited file or ran the cited git command.
- Two corrections went the other way: one claim filed as "refuted/unverifiable" (`pnpm check` fails on a clean clone) was proven **true by execution**, and the `@vitest/browser` critical advisory, filed as second-hand, was confirmed first-hand against the live registry.

**What could not be checked:** `node_modules` is absent in all three repos, so no gate was timed and no build, test run, `depcruise`, `knip`, or Sheriff invocation was executed. Every wall-clock estimate is labelled as an estimate. Everything that is a *count*, a *file*, an *exit code*, or a *git fact* was measured. The one gate executable without dependencies — `scripts/check-risk-register.mjs`, pure Node — was run, and it fails.

**Not examined, and flagged rather than implied:** accessibility, bundle-size budgets, drift of `src/platform/components/ui` against upstream shadcn/`@base-ui`, and RTL correctness for the shipped `ar` locale.

### Reading order

| Appendix | Covers |
|---|---|
| [A — All findings](./appendix-a-findings.md) | 315 verified findings indexed by severity, plus the 85 refuted claims |
| [B — Forkability](./appendix-b-forkability.md) | Demo removal, renaming, module generator, module tiers |
| [C — Runtime & security](./appendix-c-runtime.md) | R1–R24, the concrete defect fix list with code |
| [D — Gates & testing](./appendix-d-gates.md) | Tiered gate model, oxlint-vs-eslint, Stryker collapse, the new scripts block |
| [E — Agentification](./appendix-e-agentification.md) | CLAUDE.md, hooks, commands, subagents, skills, the doc-drift defence |
| [F — Documentation](./appendix-f-docs.md) | The complete drift ledger with line numbers, port-back register |
| [G — Stack modernization](./appendix-g-stack.md) | Upgrade tables, the nitro-nightly decision, tsgo, React Compiler |
| [H — Fork propagation](./appendix-h-fork-sync.md) | Measured divergence, sync mechanism design |

---

## 3. What the two apps prove

The apps are the most valuable evidence in this audit because they are two independent trials of the same template, by the same author, five months into the template's life. Where they converged *independently* — zero shared commits, two weeks apart — the template is unambiguously wrong.

### Independently rediscovered by both apps

| What both apps did | What it says about the template |
|---|---|
| Wrote a root **`CLAUDE.md`** (hume 30 lines, iris 120) | `AGENTS.md` + `.claude/rules/` did not serve agents. Strongest missing-artifact signal in the audit. |
| Wrote a **`CONTEXT.md`** domain glossary | The template has no ubiquitous-language artifact and no convention for one. |
| Built a **canonical-app-URL resolver** (`hume/src/platform/env/app-url.ts` 2026-07-16; `iris/src/modules/kernel/…/app-url.ts` 2026-08-01) | `getBaseUrl` keys on `VITE_VERCEL_ENV`/`VITE_VERCEL_BRANCH_URL` — names that appear exactly once in the entire repo, on the line that reads them. Vercel sets `VERCEL_ENV`/`VERCEL_URL`, unprefixed. The template's only deployment-shaped code is dead. |
| Made **OTEL optional with a console fallback** (hume `14943d6`+`5850d3f`, iris `94dd67f`) | `telemetry.ts:84-87` throws in production when `OTEL_COLLECTOR_URL` is unset. Observability is not a security control and must not gate boot. |
| **Deleted `'/api/upload'`** from `browser-mutation-protection.ts:17` — the *identical* one-line edit | A demo route in a platform allowlist. |
| Bumped **`vitest`/`@vitest/browser` to 4.1.10** | GHSA-p63j-vcc4-9vmv, **critical**, and the template is still on 4.1.9. |
| Converged on the same **minimal module shape** — `index/presentation/testing` gates over `domain/presentation` only (iris `launch-workspace`, hume `learning-portal`) | The modal new module is 3 gates and 2 layers. The template ships no example of it, and `tests/architecture/modular-monolith.unit.spec.ts:425-437` asserts five gates. |
| Drove their advisory count to ~0 | Live `pnpm audit` today: template **32** advisories (1 critical, 21 high); hume 2; iris 1. |

### Where they diverged, and why that matters

They are at opposite ends of a spectrum, and that constrains any propagation design:

| | hume-demo | iris |
|---|---|---|
| Byte-identical to template | 37% | 65% |
| Kept `auth`/`user`/`account`/`email` | **No — deleted all 146 files** | **Yes — 131 of 146 identical** |
| Kept Drizzle/Postgres | No | Yes |
| Kept `.claude/rules/` | Yes, **byte-identical, including the Prisma rule** | **Deleted the whole `.claude/` directory** |
| Kept react-cosmos | Yes | Deleted |

`auth` is 87% reusable to one fork and 0% reusable to the other. Only `kernel` is kept by both — and both modified it. That bimodality is the argument against extracting shared packages, and it matches the decision already made for this report (moderate appetite: in-repo improvements plus sync tooling, no extraction).

One measurement cuts the other way and is the most actionable in the audit: **the guardrail configs are ~96% identical across all three repos.** `.semgrep.yml` is 1,455 lines with 40/41-line diffs; `sheriff.config.ts` is byte-identical in hume. And iris's entire `.dependency-cruiser.cjs` diff decomposes as *3 module-allowlist substitutions* (which would be **zero** if the template used the `$1` backreference style it already uses elsewhere in the same file), 1 deletion of the vestigial `book/server.ts` waiver, 3 deletions of rules for removed features, and **1 genuine new app rule**. The guardrail divergence is almost entirely template defect, not app policy.

Meanwhile hume wrote five *better* dependency-cruiser rules in the generic backreference style (`presentation-does-not-compose-other-feature-presentation`, `client-infrastructure-no-server-or-kernel-adapters`, …). Those should come back upstream.

---

## 4. The backlog

One consolidated list. The seven design tracks each proposed their own and triple-counted several items (`lint:sheriff` into `check`, `APP_SLUG`, the guardrail-freshness test); those are merged here.

### P0 — Fix before anyone forks again · ≈3 days

Every item is a live defect. Nine of ten are under half a day.

| # | Item | Effort | Signal |
|---|---|---|---|
| **P0.1** | **Un-red the gate.** Extend the six expired rows in `docs/security-risk-register.md`; change `check-risk-register.mjs:61-75` to hard-fail only when an advisory is *both* expired **and** still reported by `pnpm audit`; remove `security:audit` from `check`/`check:ci` (the dedicated job at `code-quality.yml:159-176` already covers it). | 2h | reproduced by execution |
| **P0.2** | **`pnpm setup`** — generate a real `AUTH_SECRET` into `.env`, so README's install actually completes. | 2h | first-run blocker |
| **P0.3** | **Make `pnpm env:client` validate something.** It currently runs `src/platform/env/client.ts`, whose entire body is `export { envClient } from './config';` — and `envClient` is a lazy `Proxy` that only parses on first property access. Port iris's 3-line `scripts/validate-client-config.ts`, re-export `getEnvClient`, add a regression test. | 1h | iris |
| **P0.4** | **Lazy Better Auth client.** `better-auth-client.ts:25-29` reads `envClient.VITE_BASE_URL` at module scope in the SSR bundle. Memoized factory + an architecture test banning module-scope `envClient.*` in presentation. | 3h | iris — total outage (`9fcb5c1`) |
| **P0.5** | **`isProd()` split-brain.** `src/platform/env/config.ts:18-21` is `NODE_ENV === 'production'`; the kernel's `isProdRuntimeEnvironment` is not. They disagree on `NODE_ENV=staging`. Unify + truth-table test. Fix the `runtimeEnv()` spread order in both copies while you are there — `import.meta.env` is frozen at build time and currently *wins* over `process.env`, inverting build-once/deploy-many. | 3h | iris |
| **P0.6** | **OTEL optional.** Delete the `telemetry.ts:84-87` production throw; port a console telemetry adapter (never a silent no-op); delete the fake-collector placeholder at `code-quality.yml:362`. | 1d | **both apps** |
| **P0.7** | **De-hardcode the guardrails.** Backreference rewrite of `domain-no-presentation` and `application-no-presentation`; delete `infrastructure-no-presentation` (redundant — the generic `infrastructure-no-feature-presentation-or-transport` at `:165-172` already covers it); delete the `pathNot: '^src/modules/book/server\.ts$'` waiver at `:209`; `[^/]+` in `sheriff.config.ts:44,47`; **add `lint:sheriff` to `check`, `check:ci`, and a workflow.** | 2h | neither |
| **P0.8** | **`tests/architecture/guardrail-config-freshness.unit.spec.ts`** — assert every module name appearing in `.dependency-cruiser.cjs`, `sheriff.config.ts`, `.semgrep.yml`, `mutation-testing.yml` and `modular-monolith.unit.spec.ts` is a real directory under `src/modules/`. | 2h | would have failed hume on day 1 |
| **P0.9** | **README first-contact fixes.** `README:26` currently tells forkers to run `pnpm create start-ui -t web myApp`, which scaffolds *upstream BearStudio*, not this fork. Also: `README:11` advertises React Hook Form and oRPC (neither is in `package.json`); `README:154-166` documents `/api/openapi/app`, a route that does not exist; `README:266` claims Vercel preview-URL derivation that does not work; `package.json:11-14` still lists Ivan Dalmet as author while `:8` points bugs at hbmartin. | 2h | both |
| **P0.10** | **Close the `platform` import rule hole.** `.claude/rules/architecture.md` forbids `src/platform` importing `modules`, `routes`, `composition` — **`app` is omitted**, so `platform/components/ui/calendar.tsx:25`, `platform/lib/i18n/config.ts:9` and `constants.ts:1` legally import `@/app/i18n`. Add `app` to the list; invert the i18n dependency or record a documented exception. | 1h | new |

### P1 — Makes forking tractable · ≈13 days

| # | Item | Effort | Signal |
|---|---|---|---|
| **P1.1** | **Visual baselines.** Commit Linux baselines generated in a container pinned to `@playwright/test@1.61.1`, or make CI the baseline source of truth. State the policy in `TESTING.md` — the current silence is the actual defect. | 4h | neither |
| **P1.2** | **Transport can't express 429.** `result-mapper.ts:25` maps `rate_limit` → `BAD_REQUEST`. Add `TOO_MANY_REQUESTS`. Kill the raw `throw error;` at `:66` for non-`AppError`, and add structured logging on both paths. Breaking signature change on `unwrapApplicationResult` — ship it as an optional third parameter this release, required next major. | 1d | hume |
| **P1.3** | **Telemetry must never affect app behaviour.** `platform/telemetry/runtime.ts:12-21` is 21 lines of bare delegation across seven methods with zero try/catch — an exporter throw reaches the security middleware that emitted the metric. Guard the proxy, add `report-failure`, add `forceFlush` + shutdown flush, add `AbortSignal` timeouts to the collector and Sentry forwarding fetches at `composition/telemetry/transport.ts:246-253,290-294`. | 1.5d | iris + hume, different halves |
| **P1.4** | **One rate-limit policy.** Today three call sites have three answers for "no trustworthy client IP": one buckets under `'unknown'`, one skips limiting entirely (a public webhook, fail-open), and the doc they cite does not exist. Port hume's coarse unattributed-bucket helper + the Semgrep rule; port iris's `docs/security-rate-limiting.md` verbatim (it is written entirely against template code paths and resolves both dead citations). | 1d | hume + iris |
| **P1.5** | **CSP/SSR stream fix.** Port hume `907a42f`: an SSR-aware `replaceCspNoncePlaceholderInSsrResponse` that preserves `serverSsrCleanup`, `createStartHandler` in `src/server.ts`, and `securityHeadersMiddleware` stops constructing a `Response`. Regression assertion: `expect(result.response).toBe(originalResponse)`. Plus a streaming e2e test — the existing unit mocks did not catch this and will not catch a recurrence. | 1d | hume (then deleted CSP) |
| **P1.6** | **Database TLS policy.** `url-security.ts:125-132` requires `sslmode=verify-ca\|verify-full` in production, which essentially no hosted Postgres connection string satisfies — and `.env.example:52` contradicts it. Replace with `DATABASE_TLS_POLICY=encrypt` (still rejects `disable`/`allow`/`prefer`/cleartext), `verify` one env var away, and ship `docs/database-tls.md` with per-provider CA instructions. **The measured outcome of `verify`-by-default is deletion** — iris removed the check entirely. | 0.5d | iris |
| **P1.7** | **`APP_SLUG` + `pnpm rename`.** 46 files carry `start-ui`/`bearstudio` literals. One script that renames everywhere including `.env.example:7-9,32-33`, the CodeQL qlpack (`start-ui-web-queries` and the `@id` prefixes on 4 queries), `AGENTS.md:1`, `CODE_OF_CONDUCT.md:63` (`tech@bearstudio.fr` — both forks silently inherited it as their security contact), `.github/SECURITY.md`, `package.json` author. Fix `security-headers.unit.spec.ts:271-273`, whose slice offsets only pass by coincidence for a 22-char placeholder. | 2d | iris `2589bb1` |
| **P1.8** | **`CLAUDE.md` + `CONTEXT.md` stub + rewrite `.claude/rules/testing.md`.** That file's entire content is a rule about `toHaveBeenCalledWith` on **Prisma** mocks, scoped to a glob (`src/**/{spec,test}.{ts,tsx}`) that matches nothing — this repo uses Drizzle and keeps tests in `tests/`. hume carried it byte-identically for 123 commits; iris deleted the whole directory. Add `.claude/rules/guardrails.md`. | 0.5d | **both apps invented CLAUDE.md + CONTEXT.md** |
| **P1.9** | **Security-forced dependency sweep.** `vitest`/`@vitest/browser`/`@vitest/browser-playwright`/`@vitest/coverage-v8` → `4.1.10` (critical, GHSA-p63j-vcc4-9vmv). `vite 8.1.0 → 8.2.1` (clears both postcss advisories at the root, no override needed). `npm-run-all@4.1.5` (published 2018) → `npm-run-all2@9.0.3` (removes three high advisories by removing the path). Eight `pnpm-workspace.yaml` floors neither fork's list fully covers. | 0.5d | both |
| **P1.10** | **Replace the `nitro-nightly` pin.** `package.json:200` pins `npm:nitro-nightly@3.0.1-20260501-…` — an unreviewed per-commit build, now **3.2 months stale**, and both forks carry it verbatim without ever revisiting it. A curated beta channel exists on the real package name: `nitro@3.0.260610-beta`. There is no GA to wait for (`nitro@3.0.0` is deprecated upstream). Strictly less risky than the status quo on every axis. | 15min + 2h verify | neither |
| **P1.11** | **Node-version guard.** Port hume's `scripts/check-node-version.mjs` (asserts `.nvmrc` ≡ `.node-version` ≡ `engines.node` ≡ running major) into `check`; add `node-version-file: '.node-version'` to the `setup-pnpm` composite action. | 0.5d | hume |
| **P1.12** | **Fork-sync foundations** — see §6. Git tags (`v4.0.0` on `199954f`), `CHANGELOG.md` with a `Fork impact` section, `UPGRADING.md`, and a documented `template` remote for cherry-picking. | 1d | — |
| **P1.13** | **Collapse Stryker.** 17 root config files → 2, 40 package scripts → 4, matrix derived from `readdirSync('src/modules')`, delete the `knip.jsonc:5-8` workaround. Largest single block of per-module boilerplate in the repo. | 0.5d | apps deleted most of them |
| **P1.14** | **CI/gate hygiene.** CI invokes `pnpm check:ci` as one step; close the `architecture:graph:check` gap between `check` and `check:ci`; keep semgrep single-sourced to its own workflow. Add `::add-mask::` to the generated credentials written to `$GITHUB_ENV` at `code-quality.yml:355-368` before the build log is uploaded as an artifact. | 0.5d | — |
| **P1.15** | **Delete and rewrite `docs/security practices.md`.** It is 93 lines written for a **different application**: Biome, MongoDB, Stripe, Twilio, Attio, WhatsApp, Prisma, jscpd, Pushover, Octoscan, `ci.yml`, `db-migrate.yml`, "five high-risk modules" none of which exist, "51 dependency-cruiser rules / 123 Semgrep rules" (actual: 57 and 101), and a claim that Sheriff runs in CI when it runs nowhere. iris's copy is byte-identical to the template's. Rename it while you're there — the filename contains a space. | 0.5d | hume rewrote it |
| **P1.16** | **PGlite teardown exit code.** `tests/server/pglite-global-setup.ts:55-58` discards the suite's exit code, so `pnpm test` and therefore `pnpm verify` **exit 0 with failing tests**. Port iris `588a92b`. *(Arguably P0; it is here only because it does not block the first hour.)* | 1h | iris |
| **P1.17** | **Lefthook docs-only commits.** `scripts/format-changed.mjs:7-17` + `lefthook.yml:6` fail on any commit with no formattable files. Port iris `6d1f0c5`. Make the `detect-secrets` hook self-skip when the binary is absent. | 2h | iris |
| **P1.18** | **Module dependency graph misses type-only edges.** `scripts/generate-module-dependency-graph.ts:476-479` — 21 missing edges, and the legend describes an unreachable branch. Port iris `b60c9a5`. | 1h | iris |

### P2 — Worth doing, not urgent · ≈14 days

| # | Item | Effort |
|---|---|---|
| **P2.1** | **Module generator** — `scripts/lib/module-registry.ts` + `pnpm scaffold:module` / `scaffold:remove-module` + a round-trip test. Custom `tsx` scripts, not hygen/plop/turbo-gen (see Appendix B §2). Must be preceded by P0.7 — a generator that maintains hardcoded allowlists is worse than no generator. | 5.5d |
| **P2.2** | **Three module tiers** (`minimal` / `standard` / `full`), documented in `.claude/rules/modules.md` and `AGENTS.md`, with shape-aware architecture tests replacing the name-listed arrays at `modular-monolith.unit.spec.ts:426,439,454`. Default tier: **`minimal`** — it is the measured modal shape in both apps. | 1d |
| **P2.3** | **Deployment story.** There is currently no `Dockerfile`, no deploy workflow, no platform env-var table, and no deployment doc — while every production defect found in this audit is a *deployment* defect. Add a deploy guide, an env-var-per-platform table, and delete the dead `getBaseUrl` Vercel branch once P1's origin resolver lands. | 1.5d |
| **P2.4** | **Doc-drift check, Tier 1 only** (`pnpm check:docs`): every backticked repo path in `*.md` and in `//` comments must resolve on disk; every backticked `pnpm <script>` must exist in `package.json`. Would have caught the two dead `docs/security-rate-limiting.md` citations in `src/`, the `pnpm db:generate` drift, and (in hume) `.semgrep.yml` pointing at book/genre files that no longer exist. Tiers 2–3 (an annotation vocabulary) are deferred. | 1d |
| **P2.5** | **i18n locale trim** — `en` + one demonstration locale, glob barrels instead of four hand-maintained `index.ts` files. Reduces a new module's i18n registration from 12 touches to 1. Measured `useTranslation` adoption in the apps' own modules: 0/47 in hume, 0/12 in iris. | 1d |
| **P2.6** | **Agent loop.** `.claude/settings.json` permissions for this repo's real commands; a PostToolUse hook that formats edited files; a SessionStart hook for cloud/web sessions. | 2d |
| **P2.7** | **Slash commands** — `/check-fast`, `/new-module`, `/port-from-app`, `/adr`, `/verify-task`. | 1d |
| **P2.8** | **ADR practice** — `docs/adr/README.md` + `ADR-FORMAT.md` + 3-4 seed ADRs. Port hume's convention (Status/Date/Context/Decision/Consequences) wholesale; its `0005` and `0007` are good worked examples. | 0.5d |
| **P2.9** | **Oxlint consolidation.** Port hume's `oxlint.config.ts` (typed TS config) and keep a narrow type-aware pass in `eslint.typed.config.mjs`; port `docs/oxc-tooling-decisions.md`, whose removal criterion is exactly what an ADR's Consequences section is for. Drops ~10 duplicated ESLint packages and a double SonarJS pass. | 3.5d |
| **P2.10** | **Coverage and mutation thresholds.** `vitest.config.ts` currently enforces nothing. Measure once, set each floor to the measured value rounded down to 5, document that floors only ratchet up. | 0.5d |
| **P2.11** | **Docker-free e2e path.** Today `pnpm test:e2e` needs Maildev + Docker + a PGlite server + a real `AUTH_SECRET`. Split into a `chromium-core` tier that needs none of it and a `chromium-full` tier that does. Reduce the PR matrix to chromium; firefox/webkit nightly. | 1.5d |
| **P2.12** | **`jscpd` and `jittest`.** `test:jittest` runs `jittest catch`; `jittest` is in no dependency list and `jittest.config.json` does not exist — yet `.github/workflows/jittest.yml` is 140 lines requiring `secrets.AI_GATEWAY_API_KEY`. `jscpd` is a devDependency with a config block and no runner. **Wire each in or delete it**; shipping a broken reference is worse than shipping nothing. | 0.5d |

### Deferred / do-not-build — with the reason

| Item | Why not |
|---|---|
| **`@startui/repo-tools` / `@startui/guardrails` npm packages** | The bimodal divergence (§3) kills it: `auth` is 87% reusable to iris and 0% to hume. Also explicitly out of scope per the stated appetite — everything stays copied so agents can read it. |
| **A manifest-driven `template:sync` engine + scheduled Action** (≈20 days) | The value is real but the cost is not proportional to two forks that share zero commits and have already finished diverging in opposite directions. §6 captures the useful 90% at 1/20 the cost. Revisit when a third fork appears. |
| **Doc-drift Tiers 2 and 3** (an eight-verb assertion vocabulary, `--fix` semantics, a coverage-floor test) | Speculative machinery. The worst-offending document should be *deleted and rewritten* (P1.15), not annotated. |
| **`.claude/agents/` subagents, `.mcp.json`, skills vendoring + `check-skills-lock.mjs`, six nested `AGENTS.md`, generated Copilot/Cursor pointer files** | Zero downstream corroboration — neither app built any of them. Ship `CLAUDE.md`, `CONTEXT.md`, settings permissions and the format hook first; that is the 80/20. |
| **A `create-*` npm CLI** | Requires publishing infrastructure this fork does not have. Fix `README:26` to a `degit` line and see whether demand materialises. |
| **Moving the demo to an `examples/` branch** | Ruled out by the stated preference (keep the demo, document removal). It also cannot carry the coupling that matters — see §5. |
| **Squashing `drizzle/migrations`** | Attractive for the template, but the justification offered for it ("nobody has a deployed database") is **false** — iris has one, at `0005`, including its own `0005_drop_book_and_genre.sql`. If you do squash, the rule must be: safe for new forks only, and existing forks must never sync migrations. |

---

## 5. Demo-domain removal checklist

Per the decision to keep `book`/`genre` in `main` and document removal rather than build an eject script, this is that document. It should ship as `docs/removing-the-demo.md`.

**Scale:** 178 files mention `book` or `genre`. Only **8** files outside `src/modules/{book,genre}` actually *import* from them. iris's real removal commit (`8d2b7b4`) touched **190 files / 9,695 deletions**. The gap between 8 and 190 is entirely non-import coupling — which is why an import-graph tool would not have helped and a checklist is the right instrument.

**The critical property: 4 of the 13 categories fail *silently*.** The loud half is self-correcting via `tsc`. The silent half is where guardrails quietly stop applying — exactly what happened to hume, whose `.dependency-cruiser.cjs` today contains three rules matching zero files, 123 commits in.

| # | What to delete or edit | Files | Fails |
|---|---|---|---|
| 1 | `src/modules/{book,genre}/**` | 34 | loud |
| 2 | `src/composition/{book,book-upload,genre}.ts` + 5 edit sites in `src/composition/index.ts` (export block, import line, `ServicesOverrides`, both `getServices` branches) | 4 | loud |
| 3 | `src/routes/{app,manager}/books/**`, `src/routes/api/upload.ts`, `parseRouteBookId` in `src/routes/-route-params.ts` | 8 | loud |
| 4 | `src/modules/kernel/domain/ids.ts` (9 branded-ID declarations), `kernel/backend.ts:18`, `kernel/infrastructure/db/schema/{index,relations}.ts` | 4 | loud |
| 5 | `src/modules/auth/domain/permissions.ts` — 4 sites (`satisfies Record<UserRole, Permission>` catches misses) | 1 | loud |
| 6 | `src/app/i18n/{ar,en,fr,sw}/{book,genre}.json` + the 4 barrels + 4 `layout.json` files | 16 | loud |
| 7 | `src/app/shell/presentation/app/main-nav-config.ts`, `…/manager/nav-sidebar.tsx` | 2 | loud |
| 8 | `tests/**` — `book` is the *generic fixture* across platform, kernel, auth and e2e. Requires **repointing, not deleting** | ~90 | loud |
| 9 | `drizzle/seed/{book.ts,book-data.json,index.ts}` | 3 | **SILENT** — `pnpm db:init` just breaks at runtime |
| 10 | `drizzle/migrations/` — the `0000` baseline creates `author`/`book`/`publisher`/`genre`, and the directory is enforced-immutable by `pnpm check:migrations`. You must **write a new DROP migration** (iris wrote `0005_drop_book_and_genre.sql`) | +1 new | **SILENT** |
| 11 | `src/platform/styles/app.css` — 32 lines: 9 `--book-cover`-family tokens in `:root`, 9 again in the dark block, `--color-book-cover` at `:281`, and a `view-transition-type(book-cover)` rule at `:343`. Plus `src/platform/components/icons/generated/` — 3 exports and 6 files (`icon-book-open{,-duotone,-fill}`). **The demo has design tokens inside the technical substrate that is not allowed to import modules.** | 8 | **SILENT** — dead CSS and dead icons forever |
| 12 | Guardrail regexes: `.dependency-cruiser.cjs:60,61,78,79,162,163`; `sheriff.config.ts:44,47`; `.semgrep.yml:498,1426,1435,1446` (a 27-name branded-type alternation); `scripts/check-migration-edits.mjs:7,10`; `.github/workflows/mutation-testing.yml:21` | 5 | **SILENT** — rules match zero files, enforcement evaporates |
| 13 | `stryker.{book,genre}.config.mjs`, `tsconfig.stryker.{book,genre}.json`, 8 `package.json` scripts + 8 aggregate-script edits | 5 | **SILENT** |

Two collateral items to decide at the same time:

- **`docs/security-upload.md` loses its audience.** It is cited from four places, three of which are inside the demo `book` module. The template ships `src/platform/components/upload/**`, `src/routes/api/upload.ts` and S3 config — a real subsystem whose only end-to-end test (`tests/e2e/upload.spec.ts`, 104 lines) exists because of book covers. Either add a user-avatar upload to the `user` module (the one module every fork keeps, ≈1 day) or accept the loss and say so in `TESTING.md`.
- **P0.7 makes step 12 mostly unnecessary going forward.** Once the guardrails use `[^/]+` and `$1` backreferences instead of module-name allowlists, deleting a module stops silently disabling rules. Doing P0.7 *before* documenting removal shrinks this checklist permanently.

---

## 6. Propagating template fixes to forks

The stated appetite is in-repo improvements plus sync tooling — no package extraction. The measurement that shapes the design:

```
shared commits, template ^ hume-demo:         0
shared commits, template ^ iris:              0
shared commits, hume-demo ^ iris:             0
```

Both apps begin with a squashed tree copy. `git merge upstream/main` is therefore not runnable today — it needs `--allow-unrelated-histories`, and with no merge base *every* file both sides touched becomes a full-content conflict: 650 files for hume, 362 for iris, once, before the first useful sync.

**Recommended: build the cheap 90% now (P1.12, ≈1 day), and hold the engine until a third fork appears.**

1. **Tag the template.** `v4.0.0` on `199954f`, and tag every release from here. There are currently zero tags, so no fork can even name what it forked from.
2. **`CHANGELOG.md` with a `Fork impact` section per entry** — one line per change saying whether a fork needs to act, and how. This is the artifact that actually moves fixes downstream, because it is what a human reads.
3. **`UPGRADING.md`** listing the fixes worth pulling regardless of how far a fork has diverged. Seed it with exactly the P0/P1 items above; both existing forks want P1.2 (429), P1.3 (telemetry guards), P1.5 (CSP/SSR), and P0.7 (guardrail de-hardcoding).
4. **A documented `template` remote for cherry-picking, both directions.** `git remote add template …; git fetch template; git cherry-pick -x <sha>` works fine across unrelated histories for individual commits. Document it in `UPGRADING.md`. This is also the return channel — hume's five better dependency-cruiser rules and iris's `isProd()`/`runtimeEnv()` fixes should come back this way.

**The deferred engine**, for when it is justified: a `.template-sync.json` manifest in each fork classifying every path as `tracked` / `owned` / `divergence`, plus `pnpm template:sync` applying template changes only to tracked paths using a recorded base revision. The full design is in [Appendix H](./appendix-h-fork-sync.md) §3. The reason it needs a first-class "we diverged here on purpose" record rather than a merge driver is `url-security.ts`: iris *deliberately weakened* that guard with a rationale comment (`b781192`). A file-overwriting sync silently re-tightens it and iris's next deploy fails at boot; a three-way merge conflicts on it forever.

**The structural point worth more than any sync tooling:** three files were modified by *both* apps for structural reasons — `platform/components/form/use-app-form.ts` (a hardcoded component registry both had to trim), `platform/http/security-headers.ts` (app config leaked into a shared signature), and `platform/http/browser-mutation-protection.ts` (a demo route in a platform allowlist). Fix those three and the shared surface stops needing to be synced at all.

---

## 7. Open decisions

Each with a recommendation. These are the ones where the evidence does not settle it.

| # | Decision | Recommendation |
|---|---|---|
| **1** | **Database TLS default: `encrypt` or `verify`?** `verify` is strictly more secure and strictly less usable. | **`encrypt`**, with `verify` one env var away, a boot-time diagnostic naming the active level, and a per-provider CA doc. The measured outcome of `verify`-by-default is *deletion* (iris), which is worse than `encrypt`. |
| **2** | **Does the template keep CSP at all?** hume fixed it correctly, then removed the whole subsystem 40 minutes later and has shipped without it for three weeks. | **Keep it, fixed** (P1.5). hume's removal was diagnostic expedience under a hang it had already fixed, not a considered judgement. But add `SECURITY_CSP_MODE=enforce|report-only|off` so the next fork's debugging session doesn't require deleting 400 lines. |
| **3** | **`VITE_BASE_URL` → server-side `APP_URL`.** Breaking for existing forks; iris dropped it from the client schema entirely, hume kept it. | **Take iris's shape** — all three consumers are server-side. One-release deprecation: accept `VITE_BASE_URL` with a loud config diagnostic, remove next major. |
| **4** | **Default module tier for the generator.** | **`minimal`.** Both apps' first module was 3-gate/2-layer, independently. Ship the measured modal shape and let authors grow into `standard`. |
| **5** | **Four locales or two?** | **Two** (`en` + one). Adoption measured at 0/47 and 0/12 `useTranslation` across the apps' own modules — high confidence in the measurement, low in the causation. |
| **6** | **`security:audit` out of `pnpm check`?** | **Yes.** It is the only network-dependent, date-sensitive member; the dedicated CI job already covers it; and it is red today. Keep `security:tanstack` (offline, deterministic) in `check`. |
| **7** | **`CODE_OF_CONDUCT.md` and `.github/SECURITY.md`** — given internal-first, public-capable. | **Ship as clearly-marked templates** with a `<!-- REPLACE BEFORE PUBLISHING -->` header, and put them in `pnpm rename`'s output checklist. Both forks silently inherited `tech@bearstudio.fr` as their security contact and a supported-versions table for `4.x`. |
| **8** | **Visual-baseline platform policy.** | Either containerized Linux baselines committed, or gitignored with CI informational. **Whichever you pick, state it in `TESTING.md`** — the current silence is the actual defect. |
| **9** | **`jittest` and `jscpd`.** | **Delete both** unless you intend to wire them in. An LLM-based test generator is a per-fork policy choice, not template furniture. |
| **10** | **Migration advisory-lock namespace** (`migrate.ts:24`) — auto-derive from `APP_SLUG` or leave explicit? | **Leave explicit**, make it an env var with the current value as default, and warn about it in the rename docs. Auto-deriving means a rename silently changes lock identity. |

---

## 8. If you only do one thing

Do P0. Three days, ten items, and it converts the template from "fails on contact" to "starts, and its gates mean what they say." Everything else in this report is optional by comparison.

If you have a second week, do P0.7 + P0.8 (guardrail de-hardcoding and the freshness test) and P1.8 (`CLAUDE.md`) before anything else in P1 — the first makes the architecture enforcement actually apply to code you write, and the second is the artifact both apps independently decided they could not work without.
