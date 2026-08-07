<!-- Appendix D of the template improvement audit. See ./REPORT.md for the synthesis. -->

# Track: Quality-Gate and Testing Redesign

**Scope:** `start-ui-tanstack-drizzle-shadcn-hexagonal` (TEMPLATE), informed by deltas in `hume-demo` (APP1) and `iris-insights-crm` (APP2).

**Measurement caveat stated up front:** none of the three repos has `node_modules` installed (`ls .../node_modules` → 0 entries in all three), and neither `semgrep` nor `detect-secrets` is on PATH. **I could not time any gate.** Every wall-clock number below is labelled as an estimate. Everything that is a *count*, a *file*, or an *exit code* was measured or reproduced directly, and is labelled as such. The one gate I could execute end-to-end is `scripts/check-risk-register.mjs` (pure Node, no deps) — reproduced below.

---

## 1. Measured baseline

### 1.1 The gate inventory

`package.json` has **120 scripts** (parsed in Node, not grepped). The two aggregates:

```
package.json:132  "check":    run-p -n format:check lint lint:eslint typecheck depcruise
                              architecture:graph:check check:test-layering check:migrations
                              semgrep security:audit knip:deps
package.json:133  "check:ci": run-p -n format:check lint lint:eslint typecheck depcruise
                              check:test-layering check:migrations security:audit knip:deps
package.json:134  "verify":   pnpm check && pnpm test && pnpm build
```

| Gate | Script | In `check` | In `check:ci` | In any workflow | Deterministic? | Offline? | Node-only? |
|---|---|:-:|:-:|:-:|:-:|:-:|:-:|
| `format:check` | `oxfmt --check .` | ✅ | ✅ | ✅ code-quality:33 | ✅ | ✅ | ✅ |
| `lint` | `oxlint .` | ✅ | ✅ | ✅ code-quality:56 | ✅ | ✅ | ✅ |
| `lint:eslint` | `eslint .` | ✅ | ✅ | ✅ code-quality:56 | ✅ | ✅ | ✅ |
| `typecheck` | `tsc --noEmit` | ✅ | ✅ | ✅ code-quality:56 | ✅ | ✅ | ✅ |
| `depcruise` | `depcruise --config … src` | ✅ | ✅ | ✅ code-quality:132 | ✅ | ✅ | ✅ |
| `architecture:graph:check` | `tsx scripts/generate-module-dependency-graph.ts --check` | ✅ | ❌ | ✅ code-quality:135 | ✅ | ✅ | ✅ |
| `check:test-layering` | `node scripts/check-test-layering.mjs` | ✅ | ✅ | ✅ code-quality:219 | ✅ | ✅ | ✅ |
| `check:migrations` | `node scripts/check-migration-edits.mjs` | ✅ | ✅ | ✅ code-quality:196 | ✅ | ✅ | ✅ |
| `semgrep` | `semgrep scan --config .semgrep.yml` | ✅ | ❌ | ✅ semgrep.yml:36 | ✅ | ✅ | ❌ **python** |
| `security:audit` | `pnpm audit … && tanstack && licenses && risk-register` | ✅ | ✅ | ✅ code-quality:174 | ❌ **date+registry** | ❌ **network** | ✅ |
| `knip:deps` | `dotenv … knip --include dependencies,unlisted` | ✅ | ✅ | ❌ **nowhere** | ✅ | ✅ | ✅ |
| `lint:sheriff` | `sheriff verify` | ❌ | ❌ | ❌ **nowhere** | ✅ | ✅ | ✅ |
| `test:coverage` | `vitest run --coverage` | ❌ | ❌ | ✅ code-quality:263 | ✅ | ✅ | ✅ |
| `check:node-version` | *does not exist* | — | — | — | — | — | — |

Two gates (`lint:sheriff`, `knip:deps`) are in **zero** workflows. Sheriff is in zero aggregates *and* zero workflows — it never runs at all. `check` and `check:ci` are two hand-maintained lists that already differ in two entries (`architecture:graph:check`, `semgrep`) with no comment explaining why.

### 1.2 The test topology

`vitest.config.ts` declares **three projects** (`browser` :52, `unit` :74, `integration` :92) plus two standalone configs (`vitest.visual.config.ts`, `vitest.postgres.config.ts`) plus Playwright plus Stryker. Measured file counts:

```
tests/unit         135    (incl. 72 modules, 29 platform, 20 composition, 4 scripts, 2 app, 1 routes)
tests/browser       18
tests/integration    9
tests/architecture   6     ← included in the `unit` project (vitest.config.ts:78)
tests/security       6     ← included in the `unit` project (vitest.config.ts:79)
tests/browser-visual 1
tests/e2e           10
                   ---
runnable via vitest 172    (excluding *.postgres.integration.test.ts)
tests LOC        26,631    against src LOC 40,972 across 582 src files
```

TESTING.md:7–17 documents **eight** layers. The repo actually exposes **thirteen addressable surfaces** across **five runner configurations**:

| # | Surface | Command | Config | Notes |
|---|---|---|---|---|
| 1 | property | `test:property` | — | Not a layer. `scripts/run-property-tests.mjs:22-28` greps every test file for the string `@tests/support/property-testing` and re-runs the matches in `--project=unit`. |
| 2 | unit | `test:unit` | vitest `unit` | |
| 3 | architecture | *none* | vitest `unit` | CI runs it as `vitest run --project=unit tests/architecture` (code-quality.yml:224). No package script. |
| 4 | security | **none at all** | vitest `unit` | 6 files, no command, **absent from TESTING.md's layer map entirely**. |
| 5 | browser | `test:browser` | vitest `browser` | Chromium via Playwright provider. |
| 6 | browser-visual | `test:browser:visual` | `vitest.visual.config.ts` | **1 spec file**, 6 committed PNGs. |
| 7 | integration/workflow | `test:integration:workflow` | vitest `integration` | Name-filter over the same project. |
| 8 | integration/adapters | `test:integration:adapters` | vitest `integration` | Path-filter over the same project. |
| 9 | integration/postgres | `test:integration:postgres` | `vitest.postgres.config.ts` | Needs Docker. |
| 10 | e2e | `test:e2e` | playwright | 3 browser projects. |
| 11 | e2e-visual | `test:e2e:visual` (+3 per-file aliases) | playwright | 4 specs, 7 committed PNGs. |
| 12 | mutation | 40 scripts | 17 root files | See §7. |
| 13 | jittest | `test:jittest` | — | **Phantom — see §1.3.** |

### 1.3 Four gate defects I reproduced or verified directly

**(a) `pnpm check` fails on a fresh clone, today.** Executed:

```
$ node scripts/check-risk-register.mjs
Risk register policy failed: accepted advisories are past their review date:
- `esbuild >= 0.27.3 < 0.28.1` (review was due 2026-07-23)
- `protobufjs <= 7.6.2` (review was due 2026-07-23)
- `launch-editor <= 2.14.0` (review was due 2026-07-23)
- `js-yaml <= 4.1.1` (review was due 2026-07-23)
- `@skidding/launch-editor 2.13.2` (review was due 2026-07-23)
- `nitro` (`npm:nitro-nightly@…`) (review was due 2026-07-23)
EXIT=1
```

Chain: `check` (:132) → `security:audit` (:62) → `security:risk-register` (:65). Also inside `verify` (:134) and `check:ci` (:133), which means the `Visual` job in `e2e-tests.yml:303` (`pnpm verify:task -- --visual` → `task-verify.mjs:11` → `check:ci`) is red for this reason too.

**(b) `semgrep` in local `check` is a first-run blocker.** `semgrep` is **not** in `dependencies` or `devDependencies` (verified by parsing package.json). A fresh forker on a machine without the Python CLI gets `pnpm check` failing with `semgrep: command not found`. The maintainer already half-knew: `check:ci` (:133) omits `semgrep` precisely because the dedicated `semgrep.yml` job runs it inside `semgrep/semgrep@sha256:…` (semgrep.yml:29).

**(c) `test:jittest` references a package that does not exist.** `package.json:81 "test:jittest": "jittest catch"`. Parsing deps+devDeps for `/jittest/` → nothing. `ls jittest.config.json` → No such file. Yet `.github/workflows/jittest.yml` is 140 lines and requires `secrets.AI_GATEWAY_API_KEY`. `knip --include dependencies,unlisted` (part of `check`) should flag `jittest` as an unlisted binary — **medium confidence, I could not run knip.**

**(d) The PGlite teardown exit-code bug is still present.** `tests/server/pglite-global-setup.ts:55-58`:

```ts
  return async () => {
    await server.stop();
    await pglite.close();
  };
```

APP2 fixed it at the same lines (`iris-insights-crm/tests/server/pglite-global-setup.ts:55-66`) with a 5-line comment stating that `pnpm test` and therefore `pnpm verify` "exited 0 with failing tests, so the merge gate never failed on a broken suite." **Any redesign that does not port this first is redesigning a gate that does not fail.** This is P0.

---

## 2. The tiered model

Five tiers. The organising principle: **a tier may only contain gates that are deterministic, offline, and Node-only up to and including pre-push.** Everything with a network dependency, a Python dependency, a Docker dependency, or a wall-clock cost above the tier budget moves right.

| Tier | Trigger | Budget (target) | Failure meaning | Who runs it |
|---|---|---|---|---|
| **T0 — edit-time** | file save / agent tool-call | < 2 s per file | "this file is malformed" | editor, agent |
| **T1 — pre-commit** | `git commit` (lefthook) | < 10 s | "this commit is malformed" | lefthook |
| **T2 — pre-push / agent loop** | `pnpm check && pnpm test:affected` | **< 90 s total, of which affected < 30 s** | "this change is wrong" | human + agent |
| **T3 — PR CI** | pull_request | < 12 min wall (parallel jobs) | "this branch cannot merge" | GitHub Actions |
| **T4 — nightly / dispatch** | cron + workflow_dispatch | unbounded | "the codebase is drifting" | GitHub Actions |

### 2.1 Assignment table

| Gate | Today | **Proposed tier** | Justification |
|---|---|---|---|
| `oxfmt` on staged files | T1 (lefthook:3-6) | **T1** | Already right. |
| `oxlint` on staged files | T1 (lefthook:7-9) | **T0 + T1** | Sub-second per file; also expose to editors. |
| `check:node-version` | absent | **T1** | Instant. APP1 wired it into both aggregates (`hume-demo/package.json` `check`, `check:ci`). The ambient shell in this very environment is Node **v22.22.2** against a repo pinning 24 (`.nvmrc`, `.node-version`, `engines.node: "24.x"`) — the failure mode is live right now. |
| `format:check` (whole tree) | T2 | **T3 only** | Redundant with T1 for anyone using hooks; keep in CI to catch hook-skippers. |
| `lint` (whole tree) | T2 | **T2 + T3** | Oxlint over 582 src files is fast. Keep. |
| `lint:eslint` (whole tree) | T2 | **deleted → `lint:typed`, T2 + T3** | See §5. |
| `typecheck` | T2 | **T2 + T3** | Non-negotiable; `tsc -p tsconfig.json --noEmit` is the single highest-value gate. |
| `depcruise` | T2 | **T2 + T3** | Keep, but see §9 — it must stop being computed three times per loop. |
| `lint:sheriff` | **nowhere** | **T2 + T3** | Sheriff's `layer:domain`/`layer:application` permitted-target lists (`sheriff.config.ts:113-119`) are the *only* generic backstop for the two depcruise rules that fail open on new modules. Free to run; currently never runs. |
| `architecture:graph:check` | T2 (not `check:ci`) | **T3 only** | It regenerates and diffs a generated artifact — a T3 concern, and it is the source of one of the two `check`/`check:ci` divergences. |
| `check:test-layering` | T2 | **T2 + T3** | Pure filesystem + `ts.preProcessFile` over `src` + `tests`. Cheap. |
| `check:migrations` | T2 | **T2 + T3** | Verified locally: `Migration edit guard passed.` exit 0. Offline, deterministic, instant. |
| `knip:deps` | T2, **no CI** | **T3 only** | Whole-graph analysis; too slow for the inner loop, and today it is the second-most-likely source of a red `check` on a fresh clone (§1.3c). |
| `semgrep` | **T2** | **T3 only** | 101 rules / 1455 lines, Python binary not in `package.json`. Already covered by `semgrep.yml` running in the vendor container. **Remove from local `check`.** |
| `security:audit` | **T2** | **T3 job + T4 cron** | Network-dependent, registry-nondeterministic, and today deterministically red (§1.3a). Already has a dedicated `Audit` job (code-quality.yml:158-177) *and* `supply-chain.yml:34-37`. APP1 already removed it from both aggregates. |
| `detect-secrets` | T3 only | **T3 (unchanged) + optional T1** | Correct today. Python + `--require-hashes` venv (detect-secrets.yml:34-37) does not belong in `check`. Offer an *optional* lefthook command that self-skips when the binary is absent. |
| `test:affected` | T2 | **T2 (redesigned)** | See §9. |
| `test` (full vitest) | T2 via `verify` | **T3** | 172 files across 3 projects incl. a Chromium boot. |
| `test:coverage` + thresholds | T3, **no thresholds** | **T3** | See §8. |
| `test:integration:postgres` | T3 (code-quality:289) | **T3** | Docker `postgres:16-alpine`; keep as its own job. |
| `test:e2e` chromium | T3 (e2e-tests matrix) | **T3** | Chromium only on PR. |
| `test:e2e` firefox/webkit | T3 (e2e-tests.yml:36) | **T4** | Three-browser matrix on every PR is the largest CI cost with the lowest per-PR yield. |
| `test:e2e:visual` / `test:browser:visual` | T3 (e2e-tests.yml:288-307) | **T4 + dispatch** | See §6. |
| `test:mutation:*` | T4 (`workflow_dispatch` only) | **T4 + weekly cron** | Correct tier, wrong shape. See §7. |
| CodeQL | opt-in local, `codeql.yml` | **T4** | Correct today (TESTING.md:63 already says so). |
| OSV / dependency-review / supply-chain | T3/T4 | **T4** | Adopt APP1's permission-trimmed shape (out of this track's scope; see the security track). |
| `test:jittest` | T3-ish workflow | **delete or install** | §12 owner decision. |

---

## 3. The two aggregates become one

**Delete `check:ci` (package.json:133).** It exists only because `check` contains two gates unfit for CI's job decomposition (`semgrep`, `architecture:graph:check`) plus one unfit for anything (`security:audit`). Once those move out per §2.1, the two lists are identical and the divergence bug disappears structurally rather than by discipline.

Consequences:
- `scripts/task-verify.mjs:10-12` collapses:
  ```js
  // before
  const checkStep = process.env.CI
    ? { id: 'check-ci', command: 'pnpm', args: ['check:ci'] }
    : { id: 'check',    command: 'pnpm', args: ['check'] };
  // after
  const checkStep = { id: 'check', command: 'pnpm', args: ['check'] };
  ```
- `.github/workflows/code-quality.yml` replaces its four hand-listed static jobs (`format`, `lint-typecheck`, `dependency-cruiser`, `architecture`) with **one** job that runs `pnpm check`. Adding a gate to `check` then automatically runs in CI — which is exactly the drift that let Sheriff and knip fall out of CI entirely.

---

## 4. `.github/workflows/code-quality.yml` — proposed job shape

```yaml
jobs:
  check:                    # runs `pnpm check` — one list, no drift
    steps: [checkout, setup-pnpm, "pnpm check", "git diff --exit-code -- ."]
  slow-static:              # T3-only static gates, parallel with `check`
    steps: [..., "pnpm knip:deps", "pnpm architecture:graph:check", graphviz + graph artifacts]
  tests:                    # full vitest, all 3 projects, with coverage thresholds
    steps: [..., setup-playwright, "pnpm test:coverage", codecov]
  postgres-integration:     # unchanged
  e2e-chromium:             # matrix reduced from [chromium, firefox, webkit] → [chromium]
  build:                    # unchanged except §11 masking + drop OTEL_COLLECTOR_URL line 362
  audit:                    # unchanged (this is where `security:audit` lives now)
```

`semgrep.yml`, `detect-secrets.yml`, `codeql.yml`, `osv-scanner.yml` stay as separate workflows — they each have a distinct runtime (container / Python venv / CLI) and correctly do not belong in the Node job.

---

## 5. Decision: oxlint vs ESLint

### 5.1 What the overlap actually is

The template runs **two full linters over the same tree** (`check` :132 and code-quality.yml:56 both list `lint lint:eslint`). Measured overlap:

- **SonarJS runs twice.** `.oxlintrc.json:8` lists `eslint-plugin-sonarjs` under `jsPlugins`; `eslint.config.mjs:117` also applies `warnRules(sonarjs.configs.recommended.rules)`.
- **Ten ESLint packages** are installed: `@eslint-react/eslint-plugin ^5.9.4`, `@tanstack/eslint-plugin-query 5.101.1`, `@tanstack/eslint-plugin-router 1.162.0`, `eslint-plugin-playwright ^2.10.4`, `eslint-plugin-react-hooks ^7.1.1`, `eslint-plugin-security ^4.0.1`, `eslint-plugin-simple-import-sort 13.0.0`, `eslint-plugin-sonarjs 4.1.0`, `typescript-eslint ^8.62.0`, `eslint ^10.5.0`. Of these, `@tanstack/*` and `simple-import-sort` are *already* driven by oxlint (`.oxlintrc.json:5-8`) — ESLint carries them only as transitive noise.
- The genuinely ESLint-only surface is exactly two things: `eslint.config.mjs:85-100` (six `@typescript-eslint` **type-aware** rules — `await-thenable`, `no-floating-promises`, `no-for-in-array`, `no-misused-promises`, `no-unnecessary-type-assertion`, `return-await`) and the `requiresTypeChecking` subset of SonarJS.

### 5.2 Recommendation: adopt APP1's shape

APP1 solved this in `d0c1c8a` ("Consolidate linting on Oxlint"): `eslint.config.mjs -124`, `.oxlintrc.json -164`, `+330 oxlint.config.ts`, `+56 .oxfmtrc.json`, `+333 scripts/lib/repository-ast.ts`, ~48 files. It is APP1-only (APP2's `package.json:122` still runs `lint lint:eslint`) — so this is a **modernization**, not a defect, and it should be *scheduled*, not rushed.

The type-aware story has two halves and APP1 answers both:

1. **typescript-eslint typed rules → `oxlint-tsgolint`.** APP1 pins `oxlint-tsgolint: 7.0.2001` (verified in `hume-demo/package.json:226`). This is what replaces `eslint.config.mjs:85-100`.
2. **Typed SonarJS → a deliberately retained narrow ESLint pass.** APP1's `eslint.typed.config.mjs` (60 lines, read in full) is the piece worth copying verbatim, because it is *self-maintaining*:

```js
// hume-demo/eslint.typed.config.mjs:5-28  — derives the rule list, then fails closed
const recommendedRules = sonarjs.configs.recommended.rules;
const typedRecommendedRules = Object.fromEntries(
  Object.entries(recommendedRules).flatMap(([ruleName, configuration]) => {
    if (configuration === 'off' || configuration === 0) return [];
    const rule = sonarjs.rules[ruleName.replace(/^sonarjs\//u, '')];
    if (!rule?.meta?.docs?.requiresTypeChecking) return [];
    ...
  })
);
for (const representativeRule of [
  'sonarjs/deprecation', 'sonarjs/no-ignored-return',
  'sonarjs/null-dereference', 'sonarjs/sql-queries',
]) {
  if (typedRecommendedRules[representativeRule] === undefined) {
    throw new Error(`Missing expected type-aware SonarJS rule: ${representativeRule}`);
  }
}
```

The four-rule tripwire is the good part: a SonarJS upgrade that silently drops type-awareness from a rule **crashes the lint config** instead of silently reducing coverage. And `hume-demo/docs/oxc-tooling-decisions.md:16-17` carries the removal criterion in prose:

> Remove this compatibility pass only after Oxlint can demonstrate equivalent typed SonarJS coverage. Compare diagnostics from both paths before removal.

### 5.3 Concrete delta

| Action | File |
|---|---|
| Add | `oxlint.config.ts` (port APP1's, minus its Hume-specific rules) |
| Add | `eslint.typed.config.mjs` (port APP1's verbatim, including the tripwire) |
| Add | `docs/oxc-tooling-decisions.md` §"Type-aware SonarJS diagnostics" verbatim |
| Delete | `.oxlintrc.json` (superseded by the typed config) |
| Delete | `eslint.config.mjs` |
| Remove dep | `@eslint-react/eslint-plugin` — the only package with no consumer after the move |
| Keep dep | `eslint`, `typescript-eslint`, `eslint-plugin-sonarjs` (typed pass); `eslint-plugin-security`, `eslint-plugin-react-hooks`, `eslint-plugin-playwright`, `@tanstack/eslint-plugin-*`, `eslint-plugin-simple-import-sort` (consumed by `oxlint.config.ts` as JS plugins) |
| Add dep | `oxlint-tsgolint` (pinned exactly, as APP1 does) |
| Rename | `lint` → `run-p -n lint:oxlint lint:typed`; `lint:eslint` → `lint:typed` |
| Edit | `.github/workflows/code-quality.yml:56` — folded into `pnpm check` per §3 |

**Honest note on the payoff:** the dependency win is *one package*. The real wins are (a) one lint config instead of two with an undocumented overlap, (b) one pass over 582 files instead of two, (c) `scripts/lib/repository-ast.ts` — APP1's oxc-parser helper — which lets `scripts/check-test-layering.mjs` stop importing the TypeScript compiler (`check-test-layering.mjs:3 import ts from 'typescript'`, used only for `ts.preProcessFile` at :34). Port `repository-ast.ts` as a **separate, lower-risk change**; it stands on its own.

**Effort:** ~1.5 days, of which half is diffing both paths' diagnostics over the template's own `src` before deleting anything, as APP1's own doc instructs.

---

## 6. Committed visual snapshots in a template

### 6.1 The measured state

```
__visual_snapshots__/tests/browser-visual/platform/components/visual-states.browser.visual.spec.tsx/
  combobox-open-chromium-darwin.png            date-picker-open-chromium-darwin.png
  combobox-no-results-chromium-darwin.png      dropdown-menu-expanded-chromium-darwin.png
  form-validation-error-chromium-darwin.png    dialog-open-chromium-darwin.png

tests/e2e/visual/app-shell.visual.spec.ts-snapshots/authenticated-app-shell-chromium-darwin.png
tests/e2e/visual/auth.visual.spec.ts-snapshots/login-page-chromium-darwin.png
tests/e2e/visual/auth.visual.spec.ts-snapshots/login-verify-page-chromium-darwin.png
tests/e2e/visual/manager-users.visual.spec.ts-snapshots/manager-user{s-list,-create,-edit,-delete-confirmation}-chromium-darwin.png
```

**13 PNGs, every one `-chromium-darwin`.** Both visual jobs run on `ubuntu-latest` (`e2e-tests.yml:31`, `:174`), which produces `-chromium-linux`. `vitest.visual.config.ts:51-64` builds the path from `${arg}-${browserName}-${platform}${ext}` — the platform segment is not optional.

This is a **template defect, not merely dead weight**: a forker inherits 13 files that cannot match on the CI the template ships, generated on one maintainer's Mac, for screens (`manager-users`, `authenticated-app-shell`) they are about to delete. And there are **two independent visual mechanisms** with two snapshot roots, two update commands (`test:browser:visual:update`, `test:e2e:visual:update`), and a `test:visual` (:130) that runs both.

### 6.2 Recommendation

1. **Ship zero baselines.** `git rm -r __visual_snapshots__ tests/e2e/visual/*-snapshots`, add both to `.gitignore`. What breaks: the `Visual` job's comparison step — which cannot be passing today anyway.
2. **Keep both specs and both configs**, because they demonstrate two genuinely different techniques (component-level via Vitest Browser with no server; screen-level via Playwright against the full stack). Deleting either loses a teaching artifact.
3. **Move visual to T4 + `workflow_dispatch`.** Remove the `Visual` job's `push`/`pull_request` trigger (`e2e-tests.yml:9-16` currently fires it on both).
4. **Make baseline generation platform-stable and one command.** New file:

```jsonc
// docker/visual/Dockerfile
FROM mcr.microsoft.com/playwright:v1.61.1-noble   // pin == @playwright/test 1.61.1
WORKDIR /repo
```

```json
"visual:accept": "docker run --rm -v \"$PWD\":/repo -w /repo $(docker build -q docker/visual) sh -c 'pnpm install --frozen-lockfile --ignore-scripts && pnpm test:visual:update'"
```

This writes `-chromium-linux` baselines that match CI byte-for-byte, from any host OS. Document in TESTING.md: *baselines are an opt-in artifact a fork generates once, after it has replaced the demo screens; the template ships none.*

5. **Port APP1's HMR guard.** `hume-demo/vite.config.ts:121` adds `hmr: env.VITE_VISUAL_TEST === 'true' ? { overlay: false } : undefined`. Without it a transient HMR error overlay can be baked into a baseline. The template has no such guard. One line.

6. **Port APP1's scrollbar-gutter fix regardless of the visual decision** — it is the highest value-to-effort item in the whole track. `tests/setup.browser.ts` is 18 lines and has no scrollbar handling; APP1's is 33 lines, the delta being:

```ts
// hume-demo/tests/setup.browser.ts:6-19
// Reserve the scrollbar gutter for every browser test.
// … the scrollbar appears and the available width drops by its ~15px … Playwright's
// actionability check requires an element's bounding box to be identical across two
// consecutive frames, so anything below the growth point can read as permanently
// "unstable" and a click times out after ~15s. …
const scrollbarGutter = document.createElement('style');
scrollbarGutter.textContent = ':root { scrollbar-gutter: stable; }';
document.head.append(scrollbarGutter);
```

APP1's commit `7522ddc` reports the combobox specs failing "roughly every other full-suite run" after ~15 s of retries, measured by tracking the button's box across 60 frames (two distinct boxes before, one after). **The affected specs are the template's own** — `tests/browser/platform/components/form/field-combobox/…` and `…/field-combobox-multiple/…` both exist here. A ~50 %-per-run flake in a T3 gate is a gate that teaches people to hit re-run.

---

## 7. Stryker: 17 root files → 1

### 7.1 Measured

**9 × `stryker.*.config.mjs` + 8 × `tsconfig.stryker.*.json` = 17 of 53 root entries.** 40 of 120 package scripts start with `test:mutation`.

The factory **already exists and already takes the module name**:

```js
// stryker.shared.config.mjs:6-11
export function createScopedStrykerConfig({
  moduleName, mutationSourceFiles, mutationTestFiles, tsconfigFile,
}) { … }
```

Each of the nine wrappers then re-supplies three arguments the factory could compute. `stryker.book.config.mjs` in full is 23 lines, every one derivable from the string `book`. Compare `stryker.kernel.config.mjs` — the *only* structural difference from `book` is one extra glob (`tests/unit/modules/kernel/__tests__/**`) and one different `!ports` exclusion path. `stryker.shared-only.config.mjs` is the genuine exception: it enumerates eight hand-picked `src/platform/**` globs.

Both forks *pruned* but neither *fixed*: APP1 is down to 3 module configs / 16 scripts, APP2 to 6 / 32. Neither generalized.

### 7.2 Proposal — one parameterized config + one generated tsconfig

```js
// stryker.config.mjs   (replaces all 9 stryker.*.config.mjs)
import { mkdirSync, writeFileSync } from 'node:fs';

const isFastMode = process.env.STRYKER_FAST === '1';
const scope = process.env.STRYKER_SCOPE;
if (!scope) throw new Error('STRYKER_SCOPE is required (a module name, or "platform").');

// `platform` is the one scope that is not a module directory; it stays declarative.
const PLATFORM_SOURCES = [
  'src/platform/http/**/*.ts',
  'src/platform/lib/dayjs/**/*.ts',
  'src/platform/lib/get-page-title.ts',
  'src/platform/lib/redaction/**/*.ts',
  'src/platform/lib/tailwind/**/*.ts',
  'src/platform/lib/tanstack-query/scoped-query-options.ts',
  'src/platform/lib/tanstack-start/**/*.ts',
  'src/platform/lib/zod/**/*.ts',
];

const EXCLUDES = ['!**/*.spec.ts', '!**/*.test.ts', '!**/index.ts', '!**/types.ts'];

const isPlatform = scope === 'platform';
const sources = isPlatform
  ? [...PLATFORM_SOURCES, ...EXCLUDES]
  : [
      `src/modules/${scope}/domain/**/*.ts`,
      `src/modules/${scope}/application/**/*.ts`,
      `!src/modules/${scope}/application/ports/**/*.ts`,
      ...EXCLUDES,
    ];
const testFiles = isPlatform
  ? ['tests/unit/platform/**/*.unit.spec.ts']
  : [
      `tests/unit/modules/${scope}/domain/**/*.unit.spec.ts`,
      `tests/unit/modules/${scope}/application/**/*.unit.spec.ts`,
      `tests/unit/modules/${scope}/__tests__/**/*.unit.spec.ts`,   // kernel's extra glob, harmless elsewhere
    ];

// Stryker's typescript checker needs a real tsconfig path; generate it instead of
// committing eight near-identical files.
mkdirSync('.cache/stryker', { recursive: true });
const tsconfigFile = `.cache/stryker/tsconfig.${scope}.json`;
writeFileSync(tsconfigFile, JSON.stringify({
  extends: '../../tsconfig.json',
  include: sources.filter((g) => !g.startsWith('!')),
  exclude: ['**/index.ts', '**/types.ts', '**/*.spec.ts', '**/*.test.ts',
            ...(isPlatform ? [] : [`src/modules/${scope}/application/ports/**/*.ts`])],
}, null, 2));

export default {
  $schema: './node_modules/@stryker-mutator/core/schema/stryker-schema.json',
  plugins: ['@stryker-mutator/vitest-runner', '@stryker-mutator/typescript-checker'],
  testRunner: 'vitest',
  coverageAnalysis: 'perTest',
  vitest: { configFile: 'vitest.config.ts' },
  mutate: sources,
  testFiles,
  ignorePatterns: ['/coverage', '/playwright-report', '/test-results', '/cosmos-export', '/.output', '/dist', '/build'],
  thresholds: { high: 85, low: 75, break: 75 },      // see §8.2
  tsconfigFile,
  checkers: isFastMode ? [] : ['typescript'],
  incremental: isFastMode,
  incrementalFile: `reports/stryker-incremental/${scope}.json`,
  ignoreStatic: isFastMode,
  reporters: isFastMode ? ['progress-append-only', 'clear-text'] : ['progress', 'clear-text', 'html'],
  htmlReporter: { fileName: `reports/mutation/${scope}/mutation.html` },
};
```

Scope discovery, used by both the `test:mutation` runner and the CI matrix:

```js
// scripts/mutation-scopes.mjs
// Prints the mutation scopes as JSON. Single source of truth for
// `pnpm test:mutation` and .github/workflows/mutation-testing.yml's matrix,
// replacing the hand-maintained list at mutation-testing.yml:21.
import { readdirSync, existsSync } from 'node:fs';
const modules = readdirSync('src/modules', { withFileTypes: true })
  .filter((e) => e.isDirectory() && existsSync(`src/modules/${e.name}/domain`))
  .map((e) => e.name);
process.stdout.write(JSON.stringify([...modules, 'platform']));
```

```js
// scripts/mutation.mjs  —  CLI: pnpm test:mutation [--scope <name>] [--fast] [--dry]
// With no --scope it iterates every scope from mutation-scopes.mjs.
```

**Scripts: 40 → 3.**

```json
"test:mutation":      "node scripts/mutation.mjs",
"test:mutation:fast": "node scripts/mutation.mjs --fast",
"test:mutation:dry":  "node scripts/mutation.mjs --dry"
```

`--scope`, `--fast`, `--dry` compose: `pnpm test:mutation --scope kernel --fast`.

### 7.3 What breaks

- `.github/workflows/mutation-testing.yml:21 scope: [auth, kernel, user, book, shared]` and `:37 run: pnpm test:mutation:${{ matrix.scope }}`. Replace with a `prepare` job emitting `matrix` from `scripts/mutation-scopes.mjs`, then `run: pnpm test:mutation --scope ${{ matrix.scope }}`. **This also fixes a live bug:** the matrix names `book`, which APP2 deleted and APP1 never had — the workflow would fail on both forks.
- `knip.jsonc:5-8` — the workaround exists *solely* for this layout:
  ```jsonc
  "stryker": {
    // Per-module Stryker configs do not match knip's default stryker.config.* pattern.
    "config": ["stryker.*.config.mjs"],
  },
  ```
  With a single `stryker.config.mjs` this block is deleted; knip's default pattern matches.
- `TESTING.md:17` ("Stryker scoped configs") and `:78` (`pnpm test:mutation:auth:fast`) need rewording.
- `.cache/` must be added to `.gitignore`.
- The `shared` scope is renamed to `platform` (it mutates `src/platform/**`, and `shared` is a name that no longer corresponds to anything). This is a rename in the CI matrix and in `reports/mutation/<scope>/` paths only.

**Effort:** ~4 hours. **Net: −16 root files, −37 scripts, −1 knip workaround.**

---

## 8. Coverage and mutation thresholds

### 8.1 Coverage — currently enforces nothing

```
$ grep -n "thresholds" vitest.config.ts hume-demo/vitest.config.ts iris-insights-crm/vitest.config.ts
(no output)
```

`vitest.config.ts:30-35` configures a v8 provider, an lcov reporter, and one exclusion — and **no floor**. CI (`code-quality.yml:263-287`) runs `test:coverage`, asserts `test -s coverage/lcov.info`, and uploads to Codecov with `fail_ci_if_error: true`. There is **no `codecov.yml` / `.codecov.yml`** (verified: both absent), so Codecov's defaults apply and `fail_ci_if_error` only guards *upload* failure, not coverage regression. The gate is decorative.

**Proposal — enforce in `vitest.config.ts`, bind only to the T3 coverage job:**

```ts
// vitest.config.ts:30
coverage: {
  exclude: [...coverageConfigDefaults.exclude, 'src/app/i18n/**/*.json'],
  provider: 'v8',
  reportsDirectory: './coverage',
  reporter: ['text', 'html', 'lcov'],
  // Floors, not targets. Global numbers are deliberately modest — they exist to
  // catch a whole subsystem losing its tests, not to be gamed upward. The glob
  // entries are the real gate: pure logic in domain/ and application/ is where
  // a missing test is a missing guarantee.
  thresholds: {
    lines: 60, functions: 60, branches: 65, statements: 60,
    'src/modules/*/domain/**':      { lines: 90, functions: 90, branches: 85, statements: 90 },
    'src/modules/*/application/**': { lines: 85, functions: 85, branches: 80, statements: 85 },
    'src/platform/lib/**':          { lines: 80, functions: 80, branches: 75, statements: 80 },
  },
},
```

**These numbers are a proposal, not a measurement** — I could not run the suite. The correct procedure, which should be step 1 of implementing this: run `pnpm test:coverage` once, read the per-glob numbers, and set each floor **at the measured value rounded down to the nearest 5**, so the gate starts green and ratchets. Ship a note in TESTING.md saying floors ratchet up and never down.

Where it is enforced: only the T3 `tests` job runs `test:coverage`. Local `test:affected` and `test:unit` never compute coverage, so a partial local run cannot trip a floor. That is the point.

### 8.2 Mutation

`stryker.shared.config.mjs:34-38` sets `high: 80 / low: 70 / break: 70` uniformly. Since the mutated surface is *only* `domain` + `application` — the purest code in the repo — 70 is low. Raise to `high: 85 / low: 75 / break: 75` in the single config (§7.2), and **schedule** `mutation-testing.yml` weekly (`cron: '0 4 * * 1'`) in addition to `workflow_dispatch`, non-blocking for PRs. A mutation score is a trend signal; making it a merge gate on a template guarantees forks disable it.

---

## 9. The `affected` story — designing for sub-30 s agent signal

### 9.1 Why it is not fast today

`scripts/affected-tests.ts` is a genuinely good design (817 lines, two independent strategies, graceful degradation, its own unit tests, and a CI-shape test at `tests/security/affected-test-workflow.unit.spec.ts`). Its cost problems are structural, and all of them are measurable statically:

**(a) It re-cruises the entire repository on every invocation.**
```ts
// affected-tests.ts:10
const DEPENDENCY_CRUISE_ROOT_CANDIDATES = ['src', 'tests', 'scripts'] as const;
// :457-474
export const runDependencyCruiserWithApi = async (roots, cwd) => {
  const options = await extractDepcruiseOptions(path.resolve(cwd, '.dependency-cruiser.cjs'));
  const result = await cruise(roots, options);
```
That is **582 src files + ~180 test files + 13 scripts** resolved through TypeScript path mapping, with all 57 forbidden rules evaluated — with **no caching**, on every run.

**(b) The same graph is computed three times per `pnpm check && pnpm test:affected` loop.** Once by `pnpm depcruise` (package.json:52), once by `affected-tests.ts`, and once *inside the unit test project* by `tests/architecture/dependency-cruiser.unit.spec.ts:9-21`, which calls `cruise(['src'], options)` with a `DEPCRUISE_TEST_TIMEOUT_MS = 15_000`. That 15 s timeout is the closest thing to a maintainer-supplied measurement in the repo, and it is a *lower* bound on one of the three cruises.

**(c) The blast radius makes graph selection nearly useless for the most common edits.** Measured:
```
tests importing @/modules/kernel : 81   (of 172 runnable)
tests importing @/platform       : 75
src files importing @/modules/kernel : 132
```
`findRelatedTestsInGraph` (:514-548) does a **transitive** reverse-dependency BFS. Touch one kernel domain file and it selects ≥81 test files before transitivity — i.e. roughly the whole suite, at the cost of a full cruise to discover that.

**(d) Any dependency change forces a full run.**
```ts
// affected-tests.ts:13-24
const GLOBAL_CONFIG_FILES = new Set([
  'vitest.config.ts', 'vitest.postgres.config.ts', 'tsconfig.json',
  'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', …
]);
```
Reasonable, but `package.json` also changes for every *script* edit.

**(e) It never narrows the vitest project.**
```ts
// affected-tests.ts:721-724
export const buildVitestCommand = (testFiles: string[]) => ({
  args: ['exec', 'vitest', 'run', '--passWithNoTests', ...testFiles],
  command: 'pnpm',
});
```
Vitest loads all three projects; the `browser` project's Playwright provider (`vitest.config.ts:55-60`) is initialized. CI acknowledges this by installing Playwright in the `affected-tests` job (`code-quality.yml:81-82`). *Low confidence on whether Vitest 4 skips a project with zero matching files* — but the config is loaded and the provider constructed either way.

### 9.2 Redesign

**Four changes, in value order.**

**① Add `--fast`: filesystem-only selection, no cruise.** This is the sub-30 s agent path. Drop Strategy A entirely, keep direct-test-changes + Strategy B (mirror paths, `computeMirrorTestPaths` :377-418 — pure string manipulation + `existsSync`). Selection cost goes from a full cruise to a few hundred `stat` calls: **< 200 ms, high confidence**, because the code path touches no resolver.

Tradeoff, to be stated in `--help` and TESTING.md: `--fast` misses a test that exercises a changed file without living at its mirror path. That is exactly what the pre-push tier is for. The agent loop gets a signal it can trust to be *fast and mostly right*; the push gate is *slow and exhaustive*.

**② Narrow `--project`.** Partition selected files by which vitest project's `include` they match, and emit `--project=` flags:

```ts
// affected-tests.ts — replaces buildVitestCommand at :721-724
const PROJECT_BY_PREFIX = [
  ['tests/browser/',     'browser'],
  ['tests/integration/', 'integration'],
] as const;

export const projectsForTestFiles = (testFiles: string[]) => {
  const projects = new Set<string>();
  for (const file of testFiles) {
    const hit = PROJECT_BY_PREFIX.find(([prefix]) => file.startsWith(prefix));
    projects.add(hit ? hit[1] : 'unit');   // unit/, architecture/, security/ all live in `unit`
  }
  return [...projects].sort();
};

export const buildVitestCommand = (testFiles: string[]) => ({
  command: 'pnpm',
  args: ['exec', 'vitest', 'run', '--passWithNoTests',
         ...projectsForTestFiles(testFiles).map((p) => `--project=${p}`),
         ...testFiles],
});
```

For the overwhelmingly common case — a pure-logic edit selecting only `tests/unit/**` — this removes the browser project and its Chromium boot from the command entirely.

**③ Cache the module graph.** `pnpm depcruise` already computes it in `check`. Have it persist, and have `affected-tests.ts` reuse it:

```json
"depcruise": "depcruise --config .dependency-cruiser.cjs --output-type json --output-to .cache/depcruise/graph.json src tests scripts && node scripts/depcruise-report.mjs"
```

Cache key: a hash over `(path, size, mtimeMs)` for every file under `src/`, `tests/`, `scripts/` plus the mtime of `.dependency-cruiser.cjs` and `tsconfig.json`. One `readdir` walk of ~780 entries — **< 100 ms**. Store it as `.cache/depcruise/graph.key`. On a match, `runDependencyCruiserWithApi` reads the JSON instead of cruising. This makes the *second* invocation in a `check`-then-`affected` loop free, and makes `tests/architecture/dependency-cruiser.unit.spec.ts` a cache consumer rather than a third producer.

**④ Fix the silent-degradation path and add `--why`.** Today:
```ts
// affected-tests.ts:603-608
} catch {
  dependencyCruiserFailed = true;
  warnings.push('Warning: dependency-cruiser failed, continuing with mirror-path strategy only');
}
```
A warning on stderr that a CI log swallows. Make it **fail loudly by default** with `--allow-degraded` to opt in, except when `--fast` is set (where mirror-only is the *intent*, not a fallback). And add `--why <testfile>` printing the reverse-dependency chain from a changed file to a selected test — agents currently have no way to interrogate an over-broad selection.

### 9.3 New CLI

```
pnpm test:affected                     # graph-based, all projects, --run   (T2 pre-push, T3 CI)
pnpm test:affected --fast              # mirror+direct only, project-narrowed  (T2 agent loop, target <30s)
pnpm test:affected --list              # replaces `test:affected:list`
pnpm test:affected --list --summary    # existing formatSummary output (:665-692)
pnpm test:affected --base <rev>        # unchanged
pnpm test:affected --why <path>        # new: explain why a test was selected
pnpm test:affected --allow-degraded    # new: opt into the mirror-only fallback
```

`--run` becomes the default (it is what both `test:affected` and CI already pass) and `--list` becomes the inverse. `test:affected:list` (package.json:80) is deleted; `AGENTS.md:30`/`TESTING.md:59` reference it and must be updated.

**Effort:** ~1 day for ①②④, ~0.5 day for ③. **Highest ROI in the whole track**, because it is the gate agents hit on every single iteration.

---

## 10. E2E for a forker without Docker

### 10.1 What the chain actually is

Traced through `playwright.config.ts:69-73`:

```
playwright webServer
  → pnpm e2e:webserver                      (package.json:143)
      pglite-server --db=memory:// --port=54329 --run "pnpm e2e:dev"
  → pnpm e2e:dev                            (package.json:142)
      run-s e2e:maildev e2e:db:init dev
        → e2e:maildev  (:141) docker compose up -d --wait maildev   ← DOCKER
        → e2e:db:init  (:140) run-s db:migrate db:seed
        → dev
```

So the **database is already Docker-free** — `pglite-server --db=memory://` (the bin comes from `@electric-sql/pglite-socket@0.2.6`, package.json:226). Two Docker/service dependencies remain, and they are asymmetric:

- **Maildev is started** by `e2e:maildev` — Docker required.
- **MinIO is *not* started at all** by any local e2e script. `test:e2e` sets `S3_HOST=localhost:9000` only via `.env.example`, and CI starts MinIO explicitly (`e2e-tests.yml:113-149`). But `tests/e2e/upload.spec.ts` is in the default `chromium` project. **A forker running `pnpm test:e2e` locally without having run `pnpm dk:init` gets a failing upload spec with no explanation.** This is a genuine template trap and I have not seen it documented anywhere.

APP1 "solved" this by deleting the problem: `hume-demo/package.json` `"e2e:webserver": "pnpm gen:build-info && exec vite dev"` — no PGlite, no Maildev, no seed, because that fork has no database. **Not a portable lesson.**

### 10.2 Proposal: two tiers, one tag

Tag every spec that needs an out-of-process service, and split by Playwright project:

```ts
// playwright.config.ts — add alongside the existing chromium/firefox/webkit projects
{
  name: 'chromium-core',
  use: { ...devices['Desktop Chrome'], locale: DEFAULT_LANGUAGE_KEY },
  dependencies: ['setup'],
  grepInvert: /@docker/,          // login (OTP via SMTP) and upload (S3) carry @docker
},
{
  name: 'chromium-full',
  use: { ...devices['Desktop Chrome'], locale: DEFAULT_LANGUAGE_KEY },
  dependencies: ['setup'],
},
```

and split the webserver:

```json
"e2e:dev":       "dotenv -e .env -e .env.example -- cross-env VITE_ENV_NAME=tests run-s e2e:db:init dev",
"e2e:dev:full":  "dotenv -e .env -e .env.example -- cross-env VITE_ENV_NAME=tests EMAIL_SERVER=smtp://127.0.0.1:1025 EMAIL_DELIVERY_DISABLED=false MAILDEV_URL=http://127.0.0.1:1080 run-s e2e:services e2e:db:init dev",
"e2e:services":  "docker compose --profile e2e up -d --wait maildev minio",
"test:e2e":      "dotenv -e .env -e .env.example -- cross-env playwright test --project=chromium-core",
"test:e2e:full": "dotenv -e .env -e .env.example -- cross-env E2E_FULL=1 playwright test --project=chromium-full"
```

with `e2e:webserver` selecting `e2e:dev` or `e2e:dev:full` on `process.env.E2E_FULL`.

**The default `pnpm test:e2e` then needs no Docker at all** — PGlite in memory, `EMAIL_DELIVERY_DISABLED=true`, no S3 — and covers routing, auth-session, async-react and observability (`tests/e2e/`: `async-react`, `login`, `observability`, `routing`, `upload`, `users`). Only `login.spec.ts` (Maildev OTP) and `upload.spec.ts` (MinIO) get `@docker`.

**Better still, and worth an owner decision:** replace Maildev with an in-process SMTP capture. The seam already exists — `EMAIL_SERVER=smtp://…` is read by the email gateway (commit `5b086aa`: "Added local/test SMTP delivery via `EMAIL_SERVER=smtp://127.0.0.1:1025`"). A ~60-line Node SMTP sink started by the Playwright global setup, exposing captured messages over a local HTTP endpoint with the same shape the Maildev reader already consumes, removes the last Docker dependency from `chromium-core` **and** removes a network image pull from CI. MinIO is harder to fake honestly (presigned-URL semantics), so `upload.spec.ts` stays `@docker`.

Also: **reduce the PR matrix from `[chromium, firefox, webkit]` (`e2e-tests.yml:36`) to `[chromium]`**, and move the three-browser matrix to nightly. Three full stacks (Postgres container + MinIO container + `mc` download + `db:push` + `db:seed`, per browser) is the single largest CI cost in the repo.

**Effort:** ~0.5 day for the tag split; ~1 day more for the in-process SMTP sink.

---

## 11. Verdict on semgrep / detect-secrets / `pnpm audit` in local `check`

| Tool | Runtime | Verdict | Rationale |
|---|---|---|---|
| **semgrep** | Python CLI, **not in package.json** | **Remove from `check`.** Keep `semgrep.yml` (runs in `semgrep/semgrep@sha256:…`, semgrep.yml:29). Keep the `semgrep` script as an *optional documented command.* | A gate that fails with `command not found` after `pnpm install` is a first-run blocker in the same class as the `AUTH_SECRET="REPLACE ME"` defect. 101 rules over 1455 lines is also not an inner-loop cost. `check:ci` already omits it. |
| **detect-secrets** | Python, hash-pinned venv | **Leave CI-only (correct today).** Optionally add a lefthook command that self-skips when the binary is absent. | `detect-secrets.yml:34-37` builds a `--require-hashes` venv from `.github/requirements/detect-secrets.txt`. Reproducing that locally is a real setup cost for zero inner-loop value. |
| **`pnpm audit`** (inside `security:audit`) | network + registry | **Remove `security:audit` from `check` entirely.** | Three independent reasons: (1) network dependency makes `check` fail offline; (2) registry advisories change under you, so `check` is non-reproducible across two runs of identical code; (3) **it is red today** — reproduced, §1.3a. Coverage is preserved by the existing `Audit` job (code-quality.yml:158-177) and `supply-chain.yml:34-37,77-81`. APP1 already did exactly this (`hume-demo/package.json` `check` has no `security:audit`). |
| `security:tanstack`, `security:licenses`, `security:risk-register` | Node | **Split them out.** `security:tanstack` is offline+deterministic (verified: `TanStack security policy passed.`, exit 0) → **keep in `check`**. `security:licenses` shells to `pnpm licenses list --json` → **T3 only**. `security:risk-register` is *time*-dependent → **T3/T4 only**. | Bundling four different runtime profiles behind one `security:audit` name is why the time bomb reached `check`. |

**Additionally, and independently of tiering:** make `scripts/check-risk-register.mjs` stop being a template time bomb. Today (`:61-75`) it exits 1 on any past `Next review` date, unconditionally. A starter whose merge gate is *guaranteed* to fail N days after release is the worst possible first-run experience. Change it to hard-fail only when an entry is **both expired and still reported by `pnpm audit`**, or ship the register with zero accepted entries. Recommendation: **ship with zero entries**, keep the script strict, and document the `[[IgnoredVulns]]` + register-row workflow (APP1's `osv-scanner.toml` shows the shape) as something a fork opts into.

---

## 12. The new `package.json` scripts block

From **120 → 54**. Deletions are listed with their replacement in §13.

```jsonc
{
  "scripts": {
    // ── lifecycle ──────────────────────────────────────────────────────────
    "postinstall": "pnpm gen:build-info",
    "prepare": "pnpm lefthook install",

    // ── dev / build ────────────────────────────────────────────────────────
    "dev": "run-p env dev:*",
    "dev:app": "pnpm gen:build-info && vite dev",
    "build": "cross-env NODE_ENV=production run-p env gen:build-info && vite build",
    "start": "dotenv -- node .output/server/index.mjs",
    "env": "run-p env:*",
    "env:client": "dotenv -- node ./run-jiti ./scripts/validate-client-config.ts",   // was a no-op; see the env track
    "env:server": "dotenv -- node ./run-jiti ./scripts/validate-server-config.ts",
    "gen:build-info": "dotenv -- node ./run-jiti ./src/app/build-info/infrastructure/generate-build-info.ts",
    "gen:icons": "svgr --config-file src/platform/components/icons/svgr.config.cjs src/platform/components/icons/svg-sources && oxfmt src/platform/components/icons/generated",

    // ── format / lint ──────────────────────────────────────────────────────
    "format": "oxfmt .",
    "format:check": "oxfmt --check .",
    "format:changed": "node scripts/format-changed.mjs",
    "lint": "run-p -n lint:oxlint lint:typed",
    "lint:oxlint": "oxlint .",
    "lint:typed": "eslint --no-inline-config --config eslint.typed.config.mjs src",
    "lint:fix": "oxlint --fix .",
    "lint:sheriff": "sheriff verify",
    "typecheck": "tsc -p tsconfig.json --noEmit",

    // ── architecture / structural gates ────────────────────────────────────
    "depcruise": "node scripts/depcruise.mjs",              // cruises + writes .cache/depcruise/graph.json
    "architecture:graph": "tsx scripts/generate-module-dependency-graph.ts",
    "architecture:graph:check": "tsx scripts/generate-module-dependency-graph.ts --check",
    "check:test-layering": "node scripts/check-test-layering.mjs",
    "check:migrations": "node scripts/check-migration-edits.mjs",
    "check:node-version": "node scripts/check-node-version.mjs",
    "knip:deps": "dotenv -e .env -e .env.example -- knip --include dependencies,unlisted --no-progress",

    // ── security (each with its own runtime profile; no more `security:audit` bundle) ──
    "security:tanstack": "node scripts/check-tanstack-security.mjs",     // offline, deterministic → in `check`
    "security:licenses": "node scripts/check-license-compliance.mjs",    // shells to pnpm  → CI only
    "security:risk-register": "node scripts/check-risk-register.mjs",    // date-dependent  → CI only
    "security:audit": "pnpm audit --audit-level=high",                   // network         → CI only
    "semgrep": "semgrep scan --config .semgrep.yml --error --quiet",     // python          → CI only

    // ── aggregates ─────────────────────────────────────────────────────────
    // `check` is deterministic, offline, and Node-only by construction.
    // Anything needing network, Python, or Docker lives in its own CI job.
    "check": "run-p -n check:node-version format:check lint typecheck depcruise lint:sheriff check:test-layering check:migrations security:tanstack",
    "verify": "pnpm check && pnpm test && pnpm build",
    "verify:task": "node scripts/task-verify.mjs",

    // ── tests ──────────────────────────────────────────────────────────────
    "test": "vitest run",
    "test:ui": "vitest",
    "test:unit": "vitest run --project=unit tests/unit",
    "test:architecture": "vitest run --project=unit tests/architecture",
    "test:security": "vitest run --project=unit tests/security",         // NEW: had no command at all
    "test:property": "node scripts/run-property-tests.mjs",
    "test:browser": "vitest run --project=browser",
    "test:integration": "vitest run --project=integration",
    "test:integration:postgres": "vitest run --config vitest.postgres.config.ts",
    "test:affected": "tsx scripts/affected-tests.ts",
    "test:coverage": "vitest run --coverage",

    // ── e2e ────────────────────────────────────────────────────────────────
    "test:e2e": "dotenv -e .env -e .env.example -- cross-env playwright test --project=chromium-core",
    "test:e2e:full": "dotenv -e .env -e .env.example -- cross-env E2E_FULL=1 playwright test --project=chromium-full",
    "test:e2e:ui": "pnpm test:e2e --ui",
    "e2e:services": "docker compose --profile e2e up -d --wait maildev minio",
    "e2e:db:init": "run-s db:migrate db:seed",
    "e2e:dev": "dotenv -e .env -e .env.example -- cross-env VITE_ENV_NAME=tests run-s e2e:db:init dev",
    "e2e:dev:full": "dotenv -e .env -e .env.example -- cross-env VITE_ENV_NAME=tests EMAIL_SERVER=smtp://127.0.0.1:1025 EMAIL_DELIVERY_DISABLED=false MAILDEV_URL=http://127.0.0.1:1080 run-s e2e:services e2e:db:init dev",
    "e2e:webserver": "node scripts/e2e-webserver.mjs",

    // ── visual (opt-in; the template ships no baselines) ────────────────────
    "test:visual": "run-s test:visual:component test:visual:e2e",
    "test:visual:component": "vitest run --config vitest.visual.config.ts",
    "test:visual:e2e": "cross-env VITE_VISUAL_TEST=true pnpm test:e2e:full tests/e2e/visual",
    "visual:accept": "node scripts/visual-accept.mjs",                   // regenerates baselines in a pinned container

    // ── mutation ───────────────────────────────────────────────────────────
    "test:mutation": "node scripts/mutation.mjs",
    "test:mutation:fast": "node scripts/mutation.mjs --fast",
    "test:mutation:dry": "node scripts/mutation.mjs --dry",

    // ── codeql (opt-in, CLI not a dependency) ───────────────────────────────
    "codeql:db": "…",  "codeql:analyze": "…",  "codeql:test": "…",       // unchanged

    // ── docker / db ────────────────────────────────────────────────────────
    "dk:init": "docker compose --profile init up -d",
    "dk:start": "docker compose start",
    "dk:stop": "docker compose stop",
    "dk:clear": "docker compose down --volumes",
    "db:init": "pnpm db:push && pnpm db:seed",
    "db:push": "dotenv -- drizzle-kit push",
    "db:generate": "dotenv -- drizzle-kit generate",
    "db:migrate": "dotenv -- node ./run-jiti ./src/modules/kernel/infrastructure/db/migrate-cli.ts",
    "db:ui": "dotenv -- drizzle-kit studio",
    "db:seed": "dotenv -- cross-env node ./run-jiti ./drizzle/seed/index.ts",

    // ── cosmos ─────────────────────────────────────────────────────────────
    "cosmos": "cosmos",
    "cosmos-export": "cosmos-export"
  }
}
```

Corresponding `lefthook.yml`:

```yaml
pre-commit:
  commands:
    node-version:
      run: pnpm check:node-version
    format:
      run: pnpm format:changed -- {staged_files}
      stage_fixed: true
      glob: '*.{js,ts,cjs,mjs,jsx,tsx,json,md,css}'
    lint:
      glob: '*.{js,ts,cjs,mjs,jsx,tsx}'
      run: pnpm oxlint {staged_files}
    secrets:
      glob: '*'
      # Skipped silently when detect-secrets is not installed — it is a CI gate
      # (.github/workflows/detect-secrets.yml) and must not block a fresh clone.
      run: 'command -v detect-secrets-hook >/dev/null 2>&1 && detect-secrets-hook --baseline .secrets.baseline {staged_files} || true'

pre-push:
  commands:
    check:
      run: pnpm check
    affected:
      run: pnpm test:affected
```

---

## 13. Deletions and what replaces them

| Deleted | Count | Replacement | What breaks |
|---|---:|---|---|
| `test:mutation:*` per-scope scripts | 37 | `pnpm test:mutation --scope <n> [--fast] [--dry]` | `mutation-testing.yml:21,37`; TESTING.md:17,78 |
| `stryker.{account,auth,book,genre,kernel,runtime-config,shared-only,user}.config.mjs` | 8 | `stryker.config.mjs` + `STRYKER_SCOPE` | `knip.jsonc:5-8` workaround — delete it |
| `tsconfig.stryker.*.json` | 8 | generated into `.cache/stryker/` | add `.cache/` to `.gitignore` |
| `check:ci` | 1 | `check` | `scripts/task-verify.mjs:10-12` |
| `security:audit` bundle | 1 | four separate scripts by runtime profile | code-quality.yml:174 → `pnpm security:audit && pnpm security:licenses && pnpm security:risk-register` |
| `lint:eslint` | 1 | `lint:typed` | code-quality.yml:56 (folded into `pnpm check`) |
| `test:affected:list` | 1 | `test:affected --list` | AGENTS.md:30, TESTING.md:59 |
| `test:integration:workflow` / `:adapters` | 2 | `pnpm test:integration <path-filter>` | TESTING.md:12-13 |
| `test:e2e:visual:{auth,app-shell,manager-users}` | 3 | `pnpm test:visual:e2e <spec path>` | **AGENTS.md:20-22 names all three** |
| `test:e2e:chromium` | 1 | `test:e2e` (now chromium-core by default) | AGENTS.md:41, TESTING.md:14,73 |
| `test:browser:visual{,:update}`, `test:visual:update` | 3 | `test:visual:component`, `visual:accept` | e2e-tests.yml:305 |
| `test:jittest` | 1 | **owner decision** — see §15 | `.github/workflows/jittest.yml` (delete with it) |
| `e2e`, `e2e:ui`, `e2e:setup`, `e2e:maildev` | 4 | folded into the split above | none (aliases) |
| 13 committed `*-chromium-darwin.png` | 13 | `pnpm visual:accept` generates linux baselines on demand | the `Visual` job's comparison — already broken |

---

## 14. New files, with sketched content

| File | Purpose | ~LOC |
|---|---|---:|
| `stryker.config.mjs` | Single parameterized Stryker config (full content in §7.2) | 60 |
| `scripts/mutation.mjs` | `--scope`/`--fast`/`--dry` runner; iterates all scopes when `--scope` omitted | 60 |
| `scripts/mutation-scopes.mjs` | Emits scopes as JSON from `readdirSync('src/modules')` (content in §7.2) | 10 |
| `scripts/depcruise.mjs` | Cruises once, writes `.cache/depcruise/graph.json` + `.key`, reports violations | 70 |
| `scripts/check-node-version.mjs` | Port from `hume-demo/scripts/check-node-version.mjs`; asserts `.nvmrc` ≡ `.node-version` ≡ `engines.node` ≡ running major | 80 |
| `scripts/e2e-webserver.mjs` | Selects `e2e:dev` vs `e2e:dev:full` on `E2E_FULL`, wraps `pglite-server` | 30 |
| `scripts/visual-accept.mjs` | Builds `docker/visual/Dockerfile`, runs `test:visual --update` inside `mcr.microsoft.com/playwright:v1.61.1-noble` | 40 |
| `docker/visual/Dockerfile` | Pinned to the exact `@playwright/test` version (`1.61.1`) so baselines match CI | 3 |
| `eslint.typed.config.mjs` | Port `hume-demo/eslint.typed.config.mjs` verbatim, incl. the four-rule tripwire | 60 |
| `oxlint.config.ts` | Port from `hume-demo/oxlint.config.ts`, minus Hume-specific rules | ~300 |
| `docs/oxc-tooling-decisions.md` | Port §"Type-aware SonarJS diagnostics" verbatim — it carries the removal criterion | 20 |
| `scripts/validate-client-config.ts` | Fixes the `env:client` no-op (env track owns it; listed here because it is a *gate*) | 5 |

Plus **edits**: `vitest.config.ts` (coverage thresholds), `tests/setup.browser.ts` (scrollbar gutter), `tests/server/pglite-global-setup.ts` (exit-code preservation), `playwright.config.ts` (core/full projects), `lefthook.yml`, `.github/workflows/code-quality.yml`, `.github/workflows/e2e-tests.yml`, `.github/workflows/mutation-testing.yml`, `TESTING.md`, `AGENTS.md`.

### A guardrail for the guardrails

Add one architecture test — it is the cheapest defence against the whole class of drift this track documents:

```ts
// tests/architecture/gate-integrity.unit.spec.ts
// 1. Every script named in `check` exists in package.json.
// 2. Every gate in `check` is also reachable from a .github/workflows/** step
//    (directly or via `pnpm check`) — Sheriff and knip fell out of CI silently.
// 3. Every module name appearing in .dependency-cruiser.cjs, sheriff.config.ts,
//    .semgrep.yml and mutation-testing.yml is a directory under src/modules/
//    — hume-demo still names book/genre/account 123 commits in.
// 4. Every `stryker` scope from scripts/mutation-scopes.mjs has ≥1 test file.
// 5. Every command referenced in TESTING.md and AGENTS.md code fences exists
//    in package.json.scripts — AGENTS.md:20-23 currently names three scripts
//    this redesign deletes.
```

---

## 15. Owner decisions

| # | Question | My recommendation |
|---|---|---|
| 1 | **`test:jittest` / `jittest.yml`** — `jittest` is in no dependency list, `jittest.config.json` does not exist, yet a 140-line workflow requires `secrets.AI_GATEWAY_API_KEY`. | **Delete both.** An LLM-based test generator in a starter is a per-fork policy choice, not template furniture, and shipping a broken reference to one is worse than shipping nothing. If it is genuinely wanted, add the dependency and the config file — but then `knip:deps` needs to pass too. |
| 2 | **Which visual mechanism survives** — component (Vitest Browser, no server) or screen (Playwright, full stack)? | **Keep both, ship neither's baselines.** They teach different things and cost nothing without PNGs. If forced to pick one, keep the component mechanism: it needs no database, no MinIO, no seed. |
| 3 | **Does the template ship a Docker-free e2e path at all?** | **Yes** — §10's `chromium-core`. The alternative (require Docker for any e2e) is defensible for a Postgres-backed template but makes the first `pnpm test:e2e` a 5-minute setup instead of a 30-second one. |
| 4 | **Replace Maildev with an in-process SMTP sink?** | **Yes, but as a follow-up.** It is the difference between "one Docker service" and "zero" in the default path, and it removes an image pull from CI. Ship the tag-split first. |
| 5 | **Reduce the PR e2e matrix to chromium?** | **Yes.** Three full stacks per PR (Postgres + MinIO + `mc` + push + seed, ×3) is the largest CI cost with the lowest per-PR yield. Nightly for firefox/webkit. |
| 6 | **Where do the coverage floors start?** | **Measure first.** Run `pnpm test:coverage` once, set each floor to the measured value rounded down to 5, document that floors ratchet up only. Do not guess my §8.1 numbers into `main`. |
| 7 | **Does `check` fail closed on a missing `.env`?** | Uncertain — `knip:deps` is `dotenv -e .env -e .env.example -- knip …` and `dotenv-cli` behaviour on a missing first file is version-dependent. **Low confidence.** Moving `knip:deps` to T3 (§2.1) sidesteps it; verify once before closing. |

---

## 16. Effort and sequencing

Estimates assume one engineer familiar with the repo.

### Phase 0 — Unblock (½ day). **Do this before anything else.**

| # | Change | Effort |
|---|---|---|
| 0.1 | Port APP2's exit-code preservation into `tests/server/pglite-global-setup.ts:55-58`. **Nothing else in this track means anything until `pnpm test` can fail.** | 15 min |
| 0.2 | Remove `security:audit` and `semgrep` from `check`; delete `check:ci`; simplify `task-verify.mjs:10-12`. `pnpm check` becomes green and offline. | 1 h |
| 0.3 | Clear the advisories in `docs/security-risk-register.md`, and make `check-risk-register.mjs` fail only on *expired-and-still-reported*. | 2 h |
| 0.4 | Add `lint:sheriff` to `check`. Fix whatever it reports (it has literally never run — budget for a backlog). | 1–3 h, **unbounded tail** |
| 0.5 | Port the scrollbar gutter into `tests/setup.browser.ts`. Removes a ~50 %-per-run flake from the template's own combobox specs. | 15 min |

### Phase 1 — Topology (2 days)

| # | Change | Effort |
|---|---|---|
| 1.1 | Stryker: 17 files → 1, 40 scripts → 3, matrix from `mutation-scopes.mjs`, delete the `knip.jsonc` workaround. | 4 h |
| 1.2 | `affected` redesign ①②④ (`--fast`, `--project` narrowing, loud degradation, `--why`). **Highest ROI.** | 1 day |
| 1.3 | `affected` ③ (graph cache via `scripts/depcruise.mjs`); make `tests/architecture/dependency-cruiser.unit.spec.ts` a cache consumer. | 4 h |
| 1.4 | `check:node-version` + `mise.toml`; optionally `bin/run`. | 2 h |

### Phase 2 — CI and visual (1.5 days)

| # | Change | Effort |
|---|---|---|
| 2.1 | `code-quality.yml` → one `pnpm check` job + `slow-static` + the rest (§4). | 3 h |
| 2.2 | Delete the 13 baselines; move `Visual` to `workflow_dispatch`; add `visual:accept` + `docker/visual/Dockerfile` + the HMR guard. | 4 h |
| 2.3 | E2E `core`/`full` split; PR matrix → chromium. | 4 h |
| 2.4 | Coverage thresholds — **measure, then set.** | 2 h |
| 2.5 | Rewrite TESTING.md's layer map (5 layers, not 8-documented/13-real) and the AGENTS.md command table. Add `test:security`, which has never had a command. | 3 h |

### Phase 3 — Lint consolidation (1.5 days, schedulable independently)

| # | Change | Effort |
|---|---|---|
| 3.1 | Port `oxlint.config.ts`, `eslint.typed.config.mjs`, `docs/oxc-tooling-decisions.md`; add `oxlint-tsgolint`. | 1 day |
| 3.2 | Diff diagnostics from both paths over `src` before deleting `eslint.config.mjs`, as APP1's own doc instructs. | 3 h |
| 3.3 | Port `scripts/lib/repository-ast.ts`; migrate `check-test-layering.mjs` off `import ts from 'typescript'`. | 3 h |

### Phase 4 — Hardening (½ day)

| # | Change | Effort |
|---|---|---|
| 4.1 | `tests/architecture/gate-integrity.unit.spec.ts` (§14) — the five assertions that make all of the above non-regressible. | 4 h |

**Total: ~6 days**, of which Phase 0 (½ day) delivers a template whose merge gate works at all, and Phase 1.2 (1 day) delivers the sub-30-second agent loop.

---

## 17. Cross-app signal summary

For the final report's prioritisation, the gate/test findings ranked by independence of discovery:

| Practice | APP1 | APP2 | Strength |
|---|:-:|:-:|---|
| Trim `check` of network/nondeterministic gates | ✅ removed `security:audit` from both aggregates | ❌ verbatim template | **one app** |
| Run Sheriff at all | ✅ added to `check` + `check:ci` | ❌ | **one app** |
| Node-version enforcement | ✅ `check:node-version`, `bin/run`, `mise.toml`, devcontainer | ❌ | **one app** |
| Consolidate on oxlint + narrow typed pass | ✅ `d0c1c8a` | ❌ | **one app** |
| Preserve exit code across PGlite teardown | ❌ | ✅ with a 5-line rationale comment | **one app — but it silently disables the merge gate** |
| Prune dead Stryker scopes | ✅ 9→3 | ✅ 9→6 | **both — but neither generalized** |
| Reserve scrollbar gutter in browser harness | ✅ measured, 5 clean runs | ❌ | **one app, quantified** |

No gate/test practice was invented independently by *both* apps. What both apps did do independently is **prune** the same structures (Stryker configs, module lists) without fixing the generator problem underneath — which is precisely the signal that the template should own the parameterization rather than the enumeration.
