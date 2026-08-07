<!-- Appendix G of the template improvement audit. See ./REPORT.md for the synthesis. -->

# Track: Dependency & Toolchain Modernization

## 0. Method and headline

Everything below was re-derived from the repos on disk plus live npm registry queries run today (2026-08-07). Where the evidence corpus and the repo disagreed, the repo won; two corpus claims are corrected in §7.

**Headline: the template's dependency posture is not "slightly stale" — it is currently red.** Two of the gates `pnpm check` runs fail on a clean checkout right now:

```console
$ node scripts/check-risk-register.mjs ; echo $?
Risk register policy failed: accepted advisories are past their review date:
- `esbuild >= 0.27.3 < 0.28.1` (review was due 2026-07-23)
- `protobufjs <= 7.6.2` (review was due 2026-07-23)
- `launch-editor <= 2.14.0` (review was due 2026-07-23)
- `js-yaml <= 4.1.1` (review was due 2026-07-23)
- `@skidding/launch-editor 2.13.2` (review was due 2026-07-23)
- `nitro` (`npm:nitro-nightly@3.0.1-20260501-164602-aee73f19`) (review was due 2026-07-23)
1

$ pnpm audit --audit-level=high >/dev/null; echo $?
1
```

Live audit totals, all three repos, same day, same registry:

| Repo | critical | high | moderate | low | **total** |
|---|---|---|---|---|---|
| **TEMPLATE** | 1 | 21 | 8 | 2 | **32** |
| APP1 hume-demo | 0 | 2 | 0 | 0 | **2** |
| APP2 iris-insights-crm | 0 | 1 | 0 | 0 | **1** |

Both forks independently drove their advisory count to ~0 and the template stayed at 32. The residual 1–2 in the apps are advisories published *after* their last sweep (`js-yaml` GHSA-5p4m-2wfm-xmqj, `nanoid` GHSA-2v37-7h3g-55p8), i.e. natural decay of days, not months.

Drift statistics, computed by parsing all three `package.json` files:

| Measure | Count |
|---|---|
| Template direct deps (prod + dev) | 126 |
| Behind npm `latest` | **69** |
| Behind APP1 (hume) | **53** |
| Behind APP2 (iris) | 4 |
| Behind **both** apps | **4** — `vitest`, `@vitest/browser`, `@vitest/browser-playwright`, `@vitest/coverage-v8` |
| Template deps dropped by APP1 | 22 |
| Template deps dropped by APP2 | 4 |
| Deps APP1 added that are toolchain (not domain) | `npm-run-all2`, `oxc-parser`, `oxlint-tsgolint`, `@typescript/native`, `strip-json-comments` |
| Deps APP2 added | **0** |

The four-package overlap is the strongest cross-app signal in this track and it is also the one **critical** advisory: `@vitest/browser >=4.0.0 <4.1.10` (GHSA-p63j-vcc4-9vmv). Both apps bumped to `4.1.10` independently. The template is still on `4.1.9` at `package.json:251`.

---

## 1. Master upgrade table

Grouped by decision, not alphabetically. "Behind" = template version is lower.

### 1a. Security-forced — do these first

| Package | Template | APP1 | APP2 | Target | Why | Risk | Effort |
|---|---|---|---|---|---|---|---|
| `vitest` | `4.1.9` | `4.1.10` | `4.1.10` | `4.1.10` | GHSA-p63j-vcc4-9vmv **critical**, direct devDep | none — patch, both apps shipped it | 5 min |
| `@vitest/browser` | `4.1.9` | `4.1.10` | `4.1.10` | `4.1.10` | same advisory, this *is* the vulnerable package | none | — |
| `@vitest/browser-playwright` | `4.1.9` | `4.1.10` | `4.1.10` | `4.1.10` | peer-locked to vitest exact version | none | — |
| `@vitest/coverage-v8` | `^4.1.9` | `4.1.10` | `4.1.10` | `4.1.10` (exact) | peer-locked; both apps pinned it exact | none | — |
| `vite` | `8.1.0` | `8.1.5` | `8.1.0` | **`8.2.1`** | `vite@8.1.0 → postcss ^8.5.15`; `vite@8.2.1 → postcss ^8.5.25`. Clears **both** postcss advisories (GHSA-r28c needs ≥8.5.18, GHSA-fxqj needs ≥8.5.23) at the root, no override needed. Also `rolldown ~1.1.2 → ~1.2.1`. | low-medium — minor Vite bump under Rolldown; run `pnpm verify` | 1–2 h incl. verify |
| `npm-run-all` → `npm-run-all2` | `4.1.5` | `npm-run-all2@9.0.2` | `4.1.5` | **`npm-run-all2@9.0.3`** | `npm-run-all@4.1.5` was **published 2018-11-24** and depends on `minimatch@^3.0.4`. Three of the template's 21 high advisories resolve through `.>npm-run-all>minimatch>brace-expansion` (GHSA-3jxr, GHSA-mh99, GHSA-rgw5). Swapping removes the path instead of patching it. `npm-run-all2` provides the same `run-p`/`run-s` bins. | low — engines require node `^24.15.0`; template pins `24.x`, so bump `.nvmrc`/`.node-version` to `24.15` or leave (24.x satisfies at install time only if the installed 24 is ≥24.15) | 30 min; 41 script lines reference `run-p`/`run-s`, no edits needed |
| `@svgr/cli` | `8.1.0` | `8.1.0` | `8.1.0` | keep `8.1.0`, **floor its transitives** | `8.1.0` last published **2023-08-15**. Sole source of `svgo` GHSA-2p49 (high) and `js-yaml` GHSA-h67p (moderate, via `cosmiconfig`). No newer release exists. | none if floored | included in §5 |

### 1b. Behind APP1 only — safe patch/minor sweep

These are pure version drift where hume already ran the upgrade and shipped it. Take them as one batch.

| Group | Template | APP1 | npm latest | Notes |
|---|---|---|---|---|
| `@opentelemetry/*` (14 packages) | `^0.219.0` / `^2.8.0` / `^1.41.1` | `^0.221.0` / `^2.10.0` / `^1.43.0` | same as APP1 | APP1 also added `@opentelemetry/exporter-{trace,metrics}-otlp-http` alongside the `-proto` exporters. Template ships proto only. |
| `@tanstack/*` (9 packages) | `1.170.16` / `1.168.26` / `5.101.1` / `0.7.0` / `0.10.5` | `1.170.18` / `1.168.32` / `5.101.4` / `0.8.3` / `0.10.9` | `1.170.23` / `1.168.40` / `5.101.4` / `0.8.3` / `0.10.9` | Template is 24 patch releases behind on `@tanstack/react-start` alone. `@tanstack/devtools-vite 0.7.0 → 0.8.3` matters: it is the path to the `launch-editor` GHSA-v6wh advisory. |
| `react`, `react-dom` | `19.2.7` | `19.2.8` | `19.2.8` | trivial |
| `tailwindcss`, `@tailwindcss/postcss` | `4.3.1` | `4.3.3` | `4.3.3` | trivial |
| `@sentry/tanstackstart-react` | `^10.62.0` | `^10.68.0` | `10.69.0` | also a `brace-expansion` path via `@sentry/vite-plugin` |
| `i18next` / `react-i18next` | `26.3.3` / `17.0.8` | `26.3.6` / `17.0.11` | same | trivial |
| `lucide-react` | `1.21.0` | `1.27.0` | `1.30.0` | 9 minors behind |
| `playwright` / `@playwright/test` | `1.61.1` | `1.62.0` | `1.62.1` | note: browser binaries must be re-installed in CI; `e2e-tests.yml` handles this |
| `oxlint` / `oxfmt` | `1.71.0` / `0.56.0` | `1.76.0` / `0.61.0` | `1.77.0` / `0.62.0` | see §4 — the oxfmt bump is a prerequisite for `sortImports` |
| `knip` | `^6.21.0` | `^6.29.0` | `6.32.0` | |
| `lefthook`, `tsx`, `temporal-polyfill`, `@fontsource-variable/inter` | — | ahead | ahead | trivial |
| `dependency-cruiser` | `^17.4.3` | `^18.1.0` | `18.1.1` | **major**. APP1 took it; the template's `.dependency-cruiser.cjs` still works there, so the migration is proven on this exact config shape. |
| `eslint-plugin-sonarjs` | `4.1.0` | `4.2.0` | `4.2.0` | |
| `jscpd` | `^4.2.4` | `^5.0.14` | `5.0.14` | **major** — but see §6, jscpd is invoked by nothing |
| `better-auth` | `1.6.22` | (dropped) | `1.6.22` | `1.6.26` latest; check the `kysely: 0.28.17` override comment in `pnpm-workspace.yaml:33-35` still applies |
| `@base-ui/react` | `1.6.0` | `1.6.0` | **`1.7.0`** | neither app took it; see §5 registry discussion |
| `@foresightjs/react` | `^0.3.2` | `^1.0.0` | `1.0.0` | **major**, single consumer: `src/platform/router/bridge-link.tsx:1` (`useForesight`). APP1 took the major with no other code change visible in that file. Low risk, one file to check. |
| `@eslint-react/eslint-plugin` | `^5.9.4` | (dropped) | `^5.9.4` | `5.18.3` latest — **9 minors behind**. If §4 is adopted this package disappears; do not spend effort upgrading it first. |
| `@testcontainers/postgresql` | `^12.0.3` | (dropped) | `^12.0.3` | `12.1.0`. Source of 4 `undici` + 1 `protobufjs` advisories. Upgrading does not clear them (testcontainers still pins old undici); the override in §5 does. |

**Recommendation:** run 1b as a single "toolchain sweep" PR reproducing APP1's `99e92ad` version set, then a second PR for the remainder up to today's `latest`. Do not mix with 1a.

---

## 2. Decision: the `nitro-nightly` pin — **replace it with the `nitro` beta channel**

### Current state

`package.json:200`
```json
"nitro": "npm:nitro-nightly@3.0.1-20260501-164602-aee73f19",
```

`docs/security-risk-register.md:29` accepts it with this justification:

> Pre-release dependency (no CVE). Nitro 3 server bundling for TanStack Start; **no Nitro 3 GA stable is published upstream yet**. … Upgrade to a Nitro 3 GA release as soon as one is published.

Consumed at `vite.config.ts:6` (`import { nitro } from 'nitro/vite'`) and `vite.config.ts:107`. I confirmed the register's claim that TanStack Start does not declare nitro: `npm view @tanstack/react-start@1.168.26 dependencies peerDependencies` lists neither `nitro` nor `nitro-nightly`. So this is a first-party choice, not a forced one.

### What the registry actually says today

```console
$ npm view nitro dist-tags --json
{ "latest": "3.0.260610-beta" }

$ npm view nitro time --json
3.0.0            2025-10-10   (deprecated: "IMPORTANT: please use nitro@3.0.1")
3.0.1-alpha.2    2026-01-21
3.0.260311-beta  2026-03-11
3.0.260415-beta  2026-04-15
3.0.260429-beta  2026-04-29
3.0.260522-beta  2026-05-22
3.0.260603-beta  2026-06-03
3.0.260610-beta  2026-06-10   <- latest

$ npm view nitro-nightly dist-tags --json
{ "latest": "3.0.1-20260731-205209-52abde8a" }
```

Three facts the risk register does not reflect:

1. **A curated pre-release channel exists on the `nitro` package name itself.** `3.0.260610-beta` is a human-cut beta, not an automated per-commit nightly. The register's premise ("no GA yet") is still true — but "no GA" was silently being treated as "therefore nightly," which does not follow.
2. **The pinned nightly is stale by ~3.2 months.** `20260501` predates `3.0.260522-beta`, `3.0.260603-beta`, and `3.0.260610-beta`. So the template is simultaneously on the riskiest channel *and* not getting the benefit of being on it.
3. `nitro@3.0.0` is **deprecated** upstream — do not "upgrade to GA," there isn't one to go to.

### Decision

**Change `package.json:200` to a pinned beta on the real package name:**

```diff
-    "nitro": "npm:nitro-nightly@3.0.1-20260501-164602-aee73f19",
+    "nitro": "3.0.260610-beta",
```

Why this and not the alternatives:

- vs. **keep the nightly**: a nightly is an unreviewed per-commit artifact. In a *starter*, it is inherited by every fork that never thinks about it — both APP1 and APP2 carry the identical pin verbatim, unchanged, months later. Neither team touched it. That is the failure mode: the template's riskiest supply-chain decision is the one forks are least likely to revisit.
- vs. **bump the nightly to `3.0.1-20260731-...`**: same category of risk, plus you must re-pick a SHA every time.
- vs. **drop nitro entirely**: not viable — `vite.config.ts:107` calls `nitro()` and it is how the app gets a deployable server bundle. Removing it changes the deployment story, not just a dependency.

Then rewrite the register entry so the expiry gate stops being a landmine (see §8):

```diff
-| `nitro` (`npm:nitro-nightly@3.0.1-20260501-164602-aee73f19`) | Pre-release dependency (no CVE). … no Nitro 3 GA stable is published upstream yet. | … | 2026-07-23 |
+| `nitro@3.0.260610-beta` | Pre-release (no CVE). Nitro 3 has **no GA**: `nitro@3.0.0` is deprecated upstream ("please use nitro@3.0.1") and the maintained line is the dated `3.0.<YYMMDD>-beta` channel. We deliberately track that channel, **not** `nitro-nightly`, which is an unreviewed per-commit build. | Build-time only — `nitro/vite` in `vite.config.ts:6,107`; no runtime import in `src/`. | Accepted: exact pin, npm-sourced, build-time only, and TanStack Start does not declare nitro as a dep or peer (verified 2026-08-07). Re-pin to the newest `-beta` at each review; adopt GA when one ships. | <review + 90d> |
```

**Risk:** medium. Beta-to-beta across 40 days of Nitro 3 development can move the server bundle output. Mitigation is the existing gate: `pnpm verify` (`package.json:134`) runs `check && test && build`, and `.github/workflows/e2e-tests.yml` exercises a real server. Do this bump *alone*, not inside the §1b sweep.

**Effort:** 15 min to change; 1–2 h to verify (build + e2e).

**Owner decision needed:** none. This is strictly less risky than the status quo on every axis.

---

## 3. Decision: `rolldown-vite` — **already done; explicitly do nothing, and document that**

The brief lists rolldown-vite as an open question. It is not one, and the reason is worth writing down so nobody re-opens it.

```console
$ npm view vite@8.1.0 dependencies --json
{ "postcss": "^8.5.15", "rolldown": "~1.1.2", "picomatch": "^4.0.4",
  "tinyglobby": "^0.2.17", "lightningcss": "^1.32.0" }

$ npm view rolldown-vite dist-tags --json
{ "latest": "7.3.1", "beta": "7.2.0-beta.3", "alpha": "7.0.0-alpha.0" }
```

**Vite 8 *is* Rolldown.** `rolldown-vite` is the Vite **7** compatibility bridge; its latest is `7.3.1`. Adding `"vite": "npm:rolldown-vite@7.3.1"` to this repo would be a **major downgrade** from Vite 8 to Vite 7, and would break `@vitejs/plugin-react@6`, whose peer is `"vite": "^8.0.0"`.

Corroborating evidence inside the repo that the Rolldown path is already live:
- `vite.config.ts:1` imports `@rolldown/plugin-babel` (the Rolldown-native Babel bridge).
- `vite.config.ts:100-102` uses `resolve: { tsconfigPaths: true }` — the built-in tsconfig-paths resolution that replaced `vite-tsconfig-paths` under Rolldown.
- `vite.config.ts:90-92` uses `build.target: 'baseline-widely-available'`.
- `iris-insights-crm/docs/react-compiler-toolchain-evaluation.md:299` quotes `@vitejs/plugin-react-swc`'s own runtime warning: *"Under Rolldown (i.e. Vite 8, our situation)…"*.

**Action:** add one line to `AGENTS.md` (or the README's stack section) stating: *"Vite 8 is Rolldown-based (`vite@8 → rolldown@~1.x`). Do not add `rolldown-vite`; it is the Vite 7 bridge and would be a downgrade."* This is a 5-minute doc change that prevents a recurring wrong-turn. Effort: trivial. Risk: none.

---

## 4. Decision: React Compiler — **keep the current wiring, and port iris's evaluation doc into the template**

### Current wiring (verified)

`vite.config.ts:103-112`:
```ts
plugins: [
  ...(isTestRuntime ? [] : devtools()),
  srcJsonImportPlugin(),
  tanstackStart(),
  nitro(),
  // react's vite plugin must come after start's vite plugin
  viteReact(),
  babel({ presets: [reactCompilerPreset()] }),
  ...sentryPlugins,
],
```
Deps: `@vitejs/plugin-react 6.0.3`, `@rolldown/plugin-babel ^0.2.3`, `babel-plugin-react-compiler 1.0.0` — **identical in all three repos**. Neither app changed the wiring.

### What iris established

APP2 wrote a 420-line evaluation at `/home/user/iris-insights-crm/docs/react-compiler-toolchain-evaluation.md` (dated 2026-08-04, verdict at :6). The load-bearing findings:

- **§2.1** — `@vitejs/plugin-react@6` on Vite 8 does the base JSX transform and Fast Refresh through **oxc (Rust)**, not Babel. The "plugin-react = slow Babel" framing is obsolete. Only the *compiler pass* is Babel.
- **§2.2, measured by instrumenting the real build** — files reaching the Babel transform: **294**, all in the `client` environment, **0** in `ssr`, **0** outside `src/`. Therefore *"adding an `include: [/src\//]` scope to the Babel plugin would exclude exactly zero files"* — and would introduce a silent-failure mode. **§6.5: "Path scoping is not a lever. Do not do this."**
- **§2.3 — the dev/build-server cost the brief asks about could not be measured.** This is the most valuable and most under-appreciated part of the doc. The doc *retracts* its own earlier numbers:

  > ⚠️ The build-time figures previously recorded here (7.0s / 3.6s, a 3.4s delta) **could not be reproduced, and no build-time claim in this document should be relied on.**

  Re-measured medians: **5.57 s with** the pass vs **5.98 s without** — i.e. *negative*. Eight consecutive builds of one identical configuration ranged 2.19 s → 12.18 s, a 5.5× spread, on a host at load average ~9/14 cores.
- **The number that *is* deterministic**: client JS bytes, identical across all 16 builds in both orderings — **2,276,491 B with the pass vs 2,149,356 B without = +127,135 B (+5.9 %)**. That is emitted memoization code across 294 files, not waste.
- **§3.3** — `swc#11982`: the SWC-native React Compiler silently miscompiled a `catch` binding, producing a runtime `ReferenceError` only on the error path. Fixed 2026-07-05, but the doc keeps it as a **maturity signal** for the failure class that unit tests and typechecking cannot catch.
- **§3.1** — the `oxc: { transform: { reactCompiler: true } }` advice circulating in `vitejs/vite#22949` is **fabricated**; verified `oxc-transform@0.143.0` contains zero occurrences of `reactCompiler`.
- **§4.1** — `@swc/core@1.15.47` *does* expose `jsc.transform.reactCompiler` even though its `.d.ts` omits it; proven by executing a transform, not by grepping types.

### Decision

**Do not change the plugin stack.** Three concrete actions instead:

1. **Copy `docs/react-compiler-toolchain-evaluation.md` into the template**, retitled and with §2.3's honest "not measurable" section intact. Reason: the template will be forked repeatedly, and every fork will eventually ask "can we drop the Babel pass?" The doc's value is that it answers with *executed evidence* — a package-tarball grep protocol (§ Appendix), a benchmark method with two hard-won pitfalls (run configurations in consecutive blocks, not interleaved; check host idleness first), and named revisit triggers.
2. **Add the revisit triggers as a tracked item**, verbatim from §6:
   - `@vitejs/plugin-react` ships a native React Compiler option → adopt promptly (watch `vitejs/vite-plugin-react#428`).
   - `oxc-transform` gains a `reactCompiler` option → `npm view oxc-transform version`, then grep the tarball.
   - Build time becomes a genuine constraint → run the §7 spike, do not switch on principle.
3. **Add a `// do not scope this` comment at `vite.config.ts:110`**, because "just add an `include`" is the obvious-looking micro-optimization that §2.2 proves is worthless and actively harmful:
   ```ts
   // React Compiler runs via Babel because that is the reference implementation
   // and the only officially supported path on Vite 8 / Rolldown. Do NOT add
   // include/exclude scoping here: measured, 294/294 transformed files are
   // already under src/ and in the client environment only, so scoping excludes
   // zero files and adds a silent-failure mode.
   // See docs/react-compiler-toolchain-evaluation.md
   babel({ presets: [reactCompilerPreset()] }),
   ```

**Version bump:** `@vitejs/plugin-react 6.0.3 → 6.0.5` (peer `vite ^8.0.0`, `@rolldown/plugin-babel ^0.1.7 || ^0.2.0`, `babel-plugin-react-compiler ^1.0.0` — all satisfied). Trivial, low risk.

**Risk of the whole item:** none (doc + comment + patch bump). **Effort:** 1 h.

**Owner decision needed:** none. But note the doc's own caveat — its build-time numbers are unusable, so if the repo owner *believes* the compiler pass is slowing dev, that belief is currently unmeasured in either direction.

---

## 5. Decision: TypeScript native compiler (tsgo) — **adopt APP1's aliasing scheme, staged**

This is the single highest-leverage modernization in this track and the corpus does not mention it at all.

### What APP1 actually did

`hume-demo/package.json`:
```json
"@typescript/native": "npm:typescript@7.0.2",      // :203
"typescript": "npm:@typescript/typescript6@6.0.2", // :232
"oxlint-tsgolint": "7.0.2001",                     // :226
```

Introduced in a single commit, `99e92ad` ("refactor: split presentation concerns and add evaluation metrics", 2026-07-29), which in the *same diff* changed `tsconfig.json`:

```diff
     "noImplicitAny": true,
-    "ignoreDeprecations": "6.0",
-    "baseUrl": ".",
+    "types": ["node"],
     "paths": {
```

### Why this works — verified against the registry, not inferred

```console
$ npm view typescript@7.0.2 bin --json
{ "tsc": "./bin/tsc" }
$ npm view typescript@7.0.2 optionalDependencies --json
{ "@typescript/typescript-linux-x64": "7.0.2", "@typescript/typescript-darwin-arm64": "7.0.2", ... }  # 20 native Go binaries

$ npm view @typescript/typescript6@6.0.2 bin --json
{ "tsc6": "./bin/tsc6" }
```

Tarball contents (`npm pack`, then `tar tzf`):

| | `typescript@7.0.2` | `@typescript/typescript6@6.0.2` |
|---|---|---|
| `bin/` | `bin/tsc` | `bin/tsc6` |
| `lib/typescript.js` (compiler API) | **absent** | present |
| `lib/tsserverlibrary.js` | absent | present |
| `lib/lib.*.d.ts` | absent (embedded in Go binary) | **0 files** |
| implementation | native Go + vendored `vscode-jsonrpc` LSP | JS |

So the aliasing does exactly two things:

1. **`tsc` in `node_modules/.bin` resolves to TypeScript 7's native Go binary** — because `@typescript/typescript6` deliberately names its binary `tsc6` and therefore does not collide. hume's `typecheck` script is unchanged (`tsc -p tsconfig.json --noEmit`, `package.json:51` equivalent) but is now running the native compiler. Its CI step is unchanged too (`hume-demo/.github/workflows/code-quality.yml:52`: `pnpm exec run-p -n lint typecheck`).
2. **Every tool that peer-depends on `typescript` and uses the compiler API still resolves.** Confirmed in `hume-demo/pnpm-lock.yaml`:
   ```
   @softarc/sheriff-core   0.19.6(@typescript/typescript6@6.0.2)
   @stryker-mutator/typescript-checker 9.6.1(...)(@typescript/typescript6@6.0.2)
   typescript-eslint       8.65.0(@typescript/typescript6@6.0.2)(eslint@10.8.0...)
   vite                    8.1.0(@typescript/typescript6@6.0.2)
   @tanstack/eslint-plugin-{query,router}, i18next, react-i18next  -> same
   ```

The `tsconfig.json` edits are not incidental: `baseUrl` is removed in TS 7, and `ignoreDeprecations: "6.0"` exists in the template (`tsconfig.json:11`) precisely to silence the TS 6 deprecation warning for `baseUrl` at `tsconfig.json:12`. Dropping `baseUrl` makes `paths` resolve relative to the tsconfig (supported since TS 4.4) and makes `ignoreDeprecations` unnecessary. **The migration is: delete two lines.**

### What breaks

| Consumer | Under the alias | Fix |
|---|---|---|
| `scripts/check-test-layering.mjs:3` — `import ts from 'typescript'` | works (compiler API is in `@typescript/typescript6`) | none required |
| `tests/architecture/modular-monolith.unit.spec.ts:5` — `import * as ts from 'typescript'`, uses `ts.createSourceFile` at :154 and :205 | works (parse-only, needs no `lib.*.d.ts`) | none required |
| `ts-plugin-sort-import-suggestions@1.0.4` (`tsconfig.json:18-24`) | **breaks** — it is a `tsserver` plugin; TS 7 ships no `tsserver`, and `@typescript/typescript6` ships no `bin/tsserver`. Also last published **2024-02-23**. | APP1 **dropped it** and moved import ordering into `oxfmt`'s `sortImports` (`hume-demo/.oxfmtrc.json:9-64`). See §6. |
| Editor language service | `node_modules/typescript` now has no `lib.*.d.ts` and no `tsserver` | editors fall back to their bundled TS, or use the TS 7 native LSP extension. **Must be documented.** |

### Recommendation — staged

**Stage 1 (safe, no aliasing):** add the `sortImports` block to `.oxfmtrc.json` (copy `hume-demo/.oxfmtrc.json:9-64`), bump `oxfmt 0.56.0 → 0.62.0`, remove `ts-plugin-sort-import-suggestions` from `package.json:276` and the `plugins` block at `tsconfig.json:18-24`, and remove `eslint-plugin-simple-import-sort` from `.oxlintrc.json:8`. Verify with `pnpm format:check`. *Effort: 2–3 h (one repo-wide reformat commit). Risk: low — output is diffable.*

**Stage 2 (the alias):**
```diff
   "devDependencies": {
+    "@typescript/native": "npm:typescript@7.0.2",
-    "typescript": "6.0.3",
+    "typescript": "npm:@typescript/typescript6@6.0.2",
```
```diff
 // tsconfig.json
     "noImplicitAny": true,
-    "ignoreDeprecations": "6.0",
-    "baseUrl": ".",
+    // Ambient-type allowlist. Add required @types packages here; do not remove
+    // the allowlist to fix a distant "cannot find name" error.
+    "types": ["node"],
```
Then run `pnpm typecheck` and expect a *shorter* list of diagnostics than before only if nothing regressed — TS 7 is stricter in places. Also delete the eight `tsconfig.stryker.*.json` files' `baseUrl` if present.

Add to the README / `AGENTS.md`:
> `pnpm typecheck` runs **TypeScript 7 native** (`typescript@7.0.2`, Go). The `typescript` package name is aliased to `@typescript/typescript6` so that `typescript-eslint`, Sheriff, Stryker's TS checker and Vite still get a JS compiler API. Consequence: `node_modules/typescript` has no `tsserver` and no `lib.*.d.ts` — configure your editor to use its bundled TypeScript or the TypeScript native language server.

**Stage 3 (optional, APP1-only, larger):** `oxlint-tsgolint@7.0.2001` to run type-aware oxlint rules. `hume-demo/oxlint.config.ts:110` documents the scoping decision:
> `correctness` also registers type-aware rules when tsgolint is present. Keep this migration scoped to the six production rules that were already enforced by typescript-eslint.

and then explicitly `'off'`s twelve additional type-aware rules that would otherwise light up (`oxlint.config.ts:112-127`). That discipline is what makes the adoption survivable; copy it if you take Stage 3.

**Risk:** Stage 1 low; Stage 2 **medium** (new compiler, editor story changes); Stage 3 medium-large. **Effort:** Stage 1 ≈ 3 h, Stage 2 ≈ 4–8 h, Stage 3 ≈ 1–2 days.

**Owner decision needed — yes.** Stage 2 changes what `typescript` means in this repo, which every fork inherits. My recommendation: **take Stages 1 and 2.** The evidence that it works is a 123-commit application running it in CI today, and the migration cost is two deleted `tsconfig.json` lines. Hold Stage 3 until §8 (oxlint consolidation) is decided, since they share the same config surface.

**One honest uncertainty:** no script in `hume-demo` references `@typescript/native` by name (`grep -rn "typescript/native\|tsgo" hume-demo` returns only `package.json:203` and `oxlint.config.ts:110`'s comment). It works purely because installing it puts `tsc` on the path. That is load-bearing-by-side-effect and deserves an explicit comment in `package.json` or a `check:toolchain` assertion (`node -e "require('child_process').execSync('tsc --version')"` should print 7.x) so a future `pnpm remove` does not silently revert typechecking to TS 6.

---

## 6. Decision: drop `react-cosmos` — **yes, but not for iris's stated reason**

APP2 removed it in `5082abf` ("Remove React Cosmos"). Its commit body claims:

> The Cosmos component-catalog setup was already non-functional: its renderer HTML loaded `/src/main.tsx` and `vite.cosmos.ts` resolved a root `index.html`, neither of which exists in this repo.

**That reasoning is wrong, and I checked it rather than repeating it.** `npm pack react-cosmos-plugin-vite@7.3.0` and reading `dist/reactCosmosViteRollupPlugin.js`:

```js
async buildStart() {
  const htmlPath = path.resolve(config.rootDir, 'index.html');
  // Other plugins might intercept <root>/index.html and resolve it to
  // a different path. We need to respect that and avoid generating a new
  // index.html in the root if it already exists.
  const resolved = await this.resolve(htmlPath);
  const html = resolved ? fs.readFileSync(resolved.id, 'utf-8') : createIndexHtml(htmlPath);
  mainScriptUrl = findMainScriptUrl(html, cosmosViteConfig.mainScriptUrl);
},
resolveId(id) {
  switch (id) {
    case mainScriptUrl: return rendererResolvedModuleId;   // '\0virtual:cosmos-renderer'
```

`/src/main.tsx` is **supposed** not to exist — the plugin intercepts it and substitutes a virtual renderer module. And the template's `cosmosIndexHtmlPlugin` at `vite.cosmos.ts:20-30` (`enforce: 'pre'`, resolving root `index.html` → `tools/cosmos/index.html`) is exactly the interception the cosmos plugin's own comment says it supports. The template's cosmos setup is a *correct, deliberate* configuration.

### The real case for dropping it

| Cost | Evidence |
|---|---|
| 63 `*.fixture.tsx` files, 42 of them in `src/platform/components/ui/` alone | `find . -name "*.fixture.tsx" \| wc -l` → 63 |
| Config surface in 8 tools | `cosmos.config.json`, `vite.cosmos.ts` (112 lines), `src/cosmos.decorator.tsx`, `src/platform/styles/cosmos.css`, `tools/cosmos/index.html`, plus `*.fixture.*` globs in `.gitignore`, `.oxlintrc.json`, `eslint.config.mjs`, `.semgrep.yml`, the `jscpd.ignore` array (`package.json:292+`), the Stryker configs, and three CodeQL configs |
| A CI workflow nobody asked for | `.github/workflows/cosmos-pages.yml` runs `pnpm run cosmos-export` on **every push to main** and publishes to GitHub Pages (`:30-40`) |
| An accepted security advisory that exists only because of it | `docs/security-risk-register.md:18` — `@skidding/launch-editor 2.13.2` via `react-cosmos`. This is one of the six entries currently failing `check:risk-register`. |
| Two `pnpm-workspace.yaml` overrides that exist only for it | `pnpm-workspace.yaml:16` `'react-cosmos>ws': 8.21.0`, and `docs/security-risk-register.md:36-39` records `qs` and `ws` as resolved-via-override *because of* react-cosmos |
| A live low advisory | audit path `.>react-cosmos>express>body-parser` (GHSA-v422-hmwv-36x6) |
| 78 packages | iris `5082abf`: *"pnpm install drops 78 packages."* |
| Overlap with what the repo already has | `tests/browser/**` (Vitest Browser + Chromium), `vitest.visual.config.ts` + `pnpm test:browser:visual`, and Playwright visual specs already render these components |
| Upstream velocity | `react-cosmos@7.3.0`, last modified 2026-05-20 |

### Recommendation

**Drop it**, following iris's mechanical shape but with a corrected rationale in the commit message. Exactly what breaks and what replaces it:

| Deleted | Breaks | Replacement |
|---|---|---|
| `package.json:274-275` (`react-cosmos`, `react-cosmos-plugin-vite`), `:43-44` (`cosmos`, `cosmos-export` scripts) | nothing — no `check`/`verify`/CI script invokes them except cosmos-pages.yml | — |
| `cosmos.config.json`, `vite.cosmos.ts`, `src/cosmos.decorator.tsx`, `src/platform/styles/cosmos.css`, `tools/cosmos/` | nothing else imports them (`src/cosmos.decorator.tsx` is referenced only from `cosmos.config.json`'s discovery) | — |
| `.github/workflows/cosmos-pages.yml` | the Pages site | if a component catalog is wanted, keep it as a **separate opt-in repo/branch**, not a default workflow |
| 63 `*.fixture.tsx` | **the only per-component visual reference in the repo** | this is the real loss. Mitigate by keeping the 6 `__visual_snapshots__` specs and, if desired, converting a handful of the richest fixtures into `tests/browser/**.browser.spec.tsx` cases. |
| `pnpm-workspace.yaml:16` `'react-cosmos>ws'` | nothing | delete |
| `docs/security-risk-register.md:18` `@skidding/launch-editor` row | nothing | delete — the advisory becomes unreachable |
| `*.fixture.*` globs in `.gitignore`, `.oxlintrc.json`, `eslint.config.mjs`, `.semgrep.yml`, `package.json` jscpd ignore, Stryker configs, 3 CodeQL configs | nothing | delete each |

**Risk:** low-medium — the loss is a working component catalog, which is a real feature. **Effort:** 3–5 h (iris's diff touched ~70 files).

**Owner decision needed — yes, this is the one genuine judgement call in this track.** My recommendation is **drop**, because a starter's component catalog is the fork's problem, not the template's: neither fork used it (APP1 kept the deps but its 47 module `.tsx` files contain zero fixtures; APP2 deleted the lot), and it costs a Pages workflow, an accepted CVE, two overrides, 78 packages and 63 files that every fork must curate or delete. If the owner values the catalog, the alternative is to keep it but move `cosmos-pages.yml` behind `workflow_dispatch` only and pin the `@skidding/launch-editor` risk-register row to a real review cadence.

---

## 7. Other DROP / ADD candidates

### Drop

| Package | Where | Verdict | Evidence |
|---|---|---|---|
| `npm-run-all@4.1.5` | `package.json:270` | **drop → `npm-run-all2@9.0.3`** | published 2018-11-24; `minimatch@^3.0.4` is one of three live high-advisory paths; APP1 migrated |
| `ts-plugin-sort-import-suggestions@1.0.4` | `package.json:276`, `tsconfig.json:18-24` | **drop** | published 2024-02-23; a `tsserver` plugin, incompatible with the TS 7 path in §5; APP1 dropped it and replaced with `oxfmt` `sortImports` |
| `react-cosmos`, `react-cosmos-plugin-vite` | `package.json:274-275` | **drop** — see §6 | |
| `jscpd@^4.2.4` | `package.json:267`, config at `package.json:292-306` | **drop or wire up — currently it is neither** | `node -e "…scripts filter /jscpd/"` → `[]`. `grep -rn jscpd .github/ lefthook.yml` → nothing. `knip.jsonc:10-11` carries an `ignoreDependencies` entry *specifically to stop knip flagging it*: `// Manual copy-paste detection; configured via the "jscpd" key in package.json.` So the template ships a tool, a config block, and a linter suppression for a tool that runs nowhere. Either add `"dupes": "jscpd src"` to `check`, or delete all three. APP1 bumped it to `^5.0.14` without wiring it either. |
| `@eslint-react/eslint-plugin` | `package.json:227` | **drop if §8 adopted** | 9 minors behind (`^5.9.4` vs `5.18.3`); APP1 dropped it when consolidating on oxlint |
| `"resolutions": { "@types/node": "^24" }` | `package.json:285-287` | **drop** (low confidence, low stakes) | duplicates `pnpm-workspace.yaml:9` `'@types/node': ^24`, which is the pnpm-native mechanism. Harmless either way; one fewer thing forks copy without understanding. |

### Add

| Package | Why | Effort |
|---|---|---|
| `npm-run-all2@9.0.3` | replaces `npm-run-all` (above) | — |
| `@typescript/native` (`npm:typescript@7.0.2`) | §5 Stage 2 | — |
| `oxlint-tsgolint@7.0.2001` | §5 Stage 3 / §8 | — |
| `oxc-parser@0.142.0` | only if you port `hume-demo/scripts/lib/repository-ast.ts` (333 lines) to replace `import ts from 'typescript'` in `scripts/check-test-layering.mjs:3` and `tests/architecture/modular-monolith.unit.spec.ts:5`. **Not required** — both usages are `ts.createSourceFile`, which survives the TS 6/7 alias. Treat as optional and independent. | 1 day |
| `@opentelemetry/exporter-{trace,metrics}-otlp-http` | APP1 added both alongside the existing `-proto` exporters. Only worth it if the template also adopts APP1's console-fallback telemetry work (a different track). | — |

### Explicitly **keep** (checked, all still used)

`@better-upload/server` (`src/modules/kernel/infrastructure/storage/better-upload.ts`), `@better-upload/client` (`src/platform/components/upload/{upload-button,upload-input}.tsx`), `@neondatabase/serverless` + `ws` (`src/modules/kernel/infrastructure/db/{client.ts:43,migrate.ts:72}` — `require('ws')` for the Neon WebSocket driver), `@foresightjs/react` (`src/platform/router/bridge-link.tsx:1`), `@bearstudio/ui-state`, `@uidotdev/usehooks` (`src/platform/hooks/use-clipboard.ts`), `zustand`, `boring-avatars`, `temporal-utils`. None are droppable.

---

## 8. Decision: the shadcn / Base UI component registry

### Findings

`components.json` is **byte-identical in all three repos** (`diff` returns empty):

```json
{
  "$schema": "https://ui.shadcn.com/schema.json",
  "style": "base-vega",
  "aliases": { "ui": "@/platform/components/ui", "utils": "@/platform/lib/tailwind/utils", ... },
  "iconLibrary": "lucide"
}
```

But the components are **not registry-clean**:

- **15 of 43** UI components import `react-i18next`. `src/platform/components/ui/dialog.tsx:4` is `import { useTranslation } from 'react-i18next';`. Full list: `calendar, combobox, confirm-responsive-drawer, datalist, date-picker-button, dialog, local-switcher, number-input, scroll-area, search-button, search-input, select, sheet, sidebar, theme-switcher`.
- Several are inventions with no registry counterpart: `button-link.tsx`, `responsive-drawer.tsx`, `responsive-icon-button.tsx`, `responsive-icon-button-link.tsx`, `confirm-responsive-drawer.tsx`, `local-switcher.tsx`, `search-button.tsx`, `datalist.tsx`, `date-input.tsx`.
- Cross-component coupling: 28 files import `@/platform/components/ui/button`, 9 import `input-group`, 4 import `@/platform/hooks/use-mobile`.

So `pnpm dlx shadcn@latest add dialog` would **overwrite** the i18n-aware dialog with a plain one, silently. The `components.json` in this repo is a *provenance record*, not a working update channel — and nothing in the repo says so. Both forks inherited that ambiguity unchanged.

Also: `@base-ui/react` is at `1.6.0` in all three; `latest` is **`1.7.0`**. Neither app took the bump, so there is no fork evidence either way.

### Recommendation

1. **Bump `@base-ui/react 1.6.0 → 1.7.0`** and run `pnpm test:browser` + `pnpm test:e2e:visual`. Risk: medium (a headless-UI minor can move DOM structure, and the 6 committed visual baselines are the tripwire). Effort: 2–4 h. Do this as its own PR.
2. **Write down the registry contract.** Add to `AGENTS.md`:
   > `components.json` records how `src/platform/components/ui/*` were originally generated (shadcn `base-vega` style over `@base-ui/react`). It is **not** a live update channel: 15 of these components have been modified locally — chiefly to consume `react-i18next` — and several (`button-link`, `responsive-drawer`, `local-switcher`, …) have no registry counterpart. Never run `shadcn add` over an existing file. To pull a *new* component, run `shadcn add <name>` and diff before committing; to update an existing one, diff manually against the registry.
3. **Consider deleting `components.json` entirely** if the owner does not intend forks to use `shadcn add` at all. It is 20 lines of config that currently implies a capability the repo does not have.

**Owner decision needed — yes:** keep `components.json` as documentation-with-a-warning (my recommendation, cheaper) or delete it as a false affordance.

---

## 9. Decision: i18n locale defaults — **cut to `en` + `ar`, keep the plumbing**

### Measurements

```
src/app/i18n/{ar,en,fr,sw}/  — 40 JSON files, 2,155 lines, 84,503 bytes total
  en 19,030 B   fr 21,616 B   ar 24,102 B   sw 19,755 B
by namespace (all 4 locales):
  auth 46,558 B   book 10,186 B   user 9,676 B   components 9,165 B
  common 2,427 B  account 2,253 B  emails 1,767 B  layout 1,199 B
  build-info 665 B  genre 607 B
```

Everything is loaded eagerly. `src/platform/lib/i18n/config.ts:14` — `resources: locales`, where `src/app/i18n/index.ts` is:

```ts
import ar from '@/app/i18n/ar';
import en from '@/app/i18n/en';
import fr from '@/app/i18n/fr';
import sw from '@/app/i18n/sw';
export default { en, fr, ar, sw } as const;
```

So all 84.5 KB of JSON is in the client bundle for every fork, on every route.

`src/platform/lib/i18n/constants.ts:14-29` is the locale list. Only `ar` carries structural configuration:
```ts
{ key: 'ar', dir: 'rtl', fontScale: 1.2 } as const,
```
`fr` and `sw` are both plain LTR — structurally identical to `en`, therefore demonstrating nothing `en` does not.

### What the forks did

Both kept all four locales. Neither added a namespace for its own features:

- APP1: `hume-demo/src/app/i18n/en/` → `build-info.json, common.json, components.json, layout.json` (16 files total). Its three business modules added **zero** namespaces, and `grep -rl useTranslation src/modules/{conversation-practice,learning-portal,site-access}` → **0 files** across 47 `.tsx`.
- APP2: 32 files (8 namespaces). `grep -rl useTranslation src/modules/launch-workspace` → **0 files** across 12 `.tsx`.

Both apps *reduced* the namespace count and neither *removed* a locale — consistent with "deleting a locale means editing four barrels and a constants array; deleting a namespace file is easy." That is a friction signal, though I mark the causal claim medium-confidence: both apps may simply be single-market.

### Recommendation

1. **Ship `en` + `ar` only.** Delete `src/app/i18n/{fr,sw}/` (20 files, ~41 KB) and the corresponding entries in `src/app/i18n/index.ts` and `src/platform/lib/i18n/constants.ts:18-20,26-28`. `ar` is the one that earns its keep: it is the only locale exercising `dir: 'rtl'` and `fontScale`, which is what proves the layout, the `local-switcher`, and `src/modules/email/presentation/components/email-layout.tsx:21`'s direction handling actually work. A second LTR locale proves nothing a template maintainer can keep accurate.
2. **Replace the four hand-written barrels with a glob loader**, so adding a namespace is 1 file instead of 4 files + 8 edits. Sketch:
   ```ts
   // src/app/i18n/index.ts
   const modules = import.meta.glob('./*/*.json', { eager: true, import: 'default' });
   const locales: Record<string, Record<string, unknown>> = {};
   for (const [path, resource] of Object.entries(modules)) {
     const [, locale, file] = /^\.\/([^/]+)\/([^/]+)\.json$/.exec(path)!;
     (locales[locale] ??= {})[file.replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = resource;
   }
   export default locales;
   ```
   Caveat: `src/platform/lib/i18n/constants.ts:4` derives `Language['key']` from `keyof typeof locales`, so the glob version loses the literal key union. Preserve type-safety by keeping `AVAILABLE_LANGUAGES` as the source of truth and typing `locales` as `Record<LanguageKey, …>`. **Verify this against the `srcJsonImportPlugin` at `vite.config.ts:13-69`**, which already special-cases `/src/**/*.json?import` in dev — a glob import may interact with it.
3. **State in `AGENTS.md` that i18n is optional per module**, since 0 of 5 app-authored modules across both forks used it, while `.claude/rules/architecture.md` still mandates translation-key-only schemas.

**Risk:** low (locale deletion), medium (barrel rewrite — the `srcJsonImportPlugin` interaction is the unknown). **Effort:** 2 h + 4 h.

**Owner decision needed — yes:** `en` only, `en + ar` (my recommendation), or status quo.

---

## 10. Decision: the dual lint stack (dependency consequences)

`package.json:132-133` — both `check` and `check:ci` run `lint lint:eslint`. `.github/workflows/code-quality.yml:56` runs `pnpm exec run-p -n lint lint:eslint typecheck`. That is oxlint **plus** a full ESLint pass over the same tree, and `.oxlintrc.json:4-9` additionally runs `eslint-plugin-simple-import-sort` and `eslint-plugin-sonarjs` through oxlint's JS-plugin bridge — so SonarJS runs **twice**, untyped inside oxlint and typed inside ESLint.

Ten packages exist solely for the ESLint half: `eslint@^10.5.0`, `@eslint-react/eslint-plugin`, `@tanstack/eslint-plugin-query`, `@tanstack/eslint-plugin-router`, `eslint-plugin-playwright`, `eslint-plugin-react-hooks`, `eslint-plugin-security`, `eslint-plugin-simple-import-sort`, `eslint-plugin-sonarjs`, `typescript-eslint`.

APP1 consolidated in `d0c1c8a` ("Consolidate linting on Oxlint" — *"Move type-aware and plugin lint rules into Oxlint, move import ordering into Oxfmt, and replace repository TypeScript compiler API usage with focused Oxc parser helpers"*), producing:

| | Template | APP1 |
|---|---|---|
| oxlint config | `.oxlintrc.json`, 164 lines | `oxlint.config.ts`, 335 lines |
| eslint config | `eslint.config.mjs`, 124 lines | `eslint.typed.config.mjs`, 60 lines |
| `lint` script | `oxlint .` | `run-p -n lint:oxlint lint:typed-sonar` |
| residual ESLint scope | whole repo | `eslint --no-inline-config --config eslint.typed.config.mjs src` — SonarJS `requiresTypeChecking` rules only, at `warn`, `src/**/*.{ts,tsx}` minus specs/fixtures |

`hume-demo/eslint.typed.config.mjs:5-28` is worth copying wholesale: it *derives* the typed rule set from `sonarjs.configs.recommended` by filtering `rule.meta.docs.requiresTypeChecking`, then **asserts** four representative rules survived and throws if not — so a SonarJS upgrade that reclassifies rules fails loudly instead of silently shrinking coverage.

The removal criterion is documented in `hume-demo/docs/oxc-tooling-decisions.md`:
> Oxlint remains the primary linter. Its JavaScript-plugin bridge cannot provide SonarJS with TypeScript program information, so recommended rules marked `requiresTypeChecking` do not run there. `pnpm lint:typed-sonar` retains a narrow ESLint pass for those rules over production `src` TypeScript. … Remove this compatibility pass only after Oxlint can demonstrate equivalent typed SonarJS coverage. Compare diagnostics from both paths before removal.

**Recommendation:** adopt, but as the **last** item in the sequence. Port `oxlint.config.ts`, `.oxfmtrc.json`'s `sortImports`, `eslint.typed.config.mjs`, and `docs/oxc-tooling-decisions.md`; drop `eslint.config.mjs`, `@eslint-react/eslint-plugin`, `eslint-plugin-security`, `eslint-plugin-simple-import-sort`, `eslint-plugin-react-hooks`, and both `@tanstack/eslint-plugin-*`. Keep `eslint`, `typescript-eslint`, `eslint-plugin-sonarjs`, `eslint-plugin-playwright`. **Before deleting anything, run both paths over the template's own `src` and diff the diagnostics**, exactly as that doc instructs.

**Risk:** medium (48 files in APP1's commit; rule-coverage regressions are silent). **Effort:** 2–3 days. **Owner decision needed — yes.** Recommendation: do it, but only after §5 Stage 1–2 and §11 have landed, since it shares `.oxfmtrc.json` and `tsconfig.json` with them.

---

## 11. The `pnpm-workspace.yaml` overrides — concrete replacement

The template's current block pins **exact minimums**, which is the specific mistake both apps had to unlearn. APP2's comment at `iris-insights-crm/pnpm-workspace.yaml:11-18` states the rule:

> These are security **FLOORS**, not compatibility pins — each is a caret range so future patch and minor releases are picked up without another audit round. **(Pinning exact minimums is what left postcss one advisory behind.)** … `minimumReleaseAge` above keeps a freshly-published compromised version out of the range.

And APP1's at `hume-demo/pnpm-workspace.yaml:15-18` records the subtler trap:

> `'fast-uri@3.1.2'` selector stopped matching once the override itself moved the resolved version to 3.1.4, silently reopening the advisory.

**A version-scoped override selector invalidates itself the moment it takes effect.** Never use one for an advisory floor.

Proposed replacement for `pnpm-workspace.yaml:7-20`, derived from the 32 live advisories and cross-checked against `npm view <pkg> versions`:

```yaml
overrides:
  # ---- Compatibility pins (exact on purpose; NOT security floors) ----
  '@esbuild-kit/core-utils>esbuild': 0.25.0
  '@types/node': ^24
  effect: 3.21.2
  # PR #40, 2026-05-27: keep toolchain consumers on a known-good current glob 13.
  glob: 13.0.6
  http-proxy-middleware: 3.0.7
  # better-auth 1.6.13 advertises kysely 0.29 support, but its kysely adapter
  # still imports root migration constants removed at runtime in kysely 0.29.
  kysely: 0.28.17

  # ---- Security FLOORS (caret ranges, never exact, never version-scoped) ----
  # Rationale: an exact pin goes stale silently; a version-scoped selector
  # (e.g. 'fast-uri@3.1.2': 3.1.4) stops matching once it takes effect and
  # reopens the advisory. minimumReleaseAge: 1440 above bounds the risk of
  # floating within the caret.
  body-parser: ^1.20.6                # GHSA-v422-hmwv-36x6  (was 1.20.4)
  'brace-expansion@1': ^1.1.18        # GHSA-3jxr / GHSA-mh99 / GHSA-rgw5
  'brace-expansion@2': ^2.1.4         # same family, 2.x line
  'brace-expansion@5': ^5.0.9         # same family, 5.x line
  'esbuild@0.28': ^0.28.1             # GHSA-g7r4-m6w7-qqqr (0.25.x line above is below the range)
  fast-uri: ^3.1.5                    # GHSA-7p8r / GHSA-v2hh / GHSA-4c8g
  'js-yaml@4': ^4.3.1                 # GHSA-52cp, GHSA-5p4m, GHSA-h67p (3.x unaffected)
  'nanoid@3': ^3.3.17                 # GHSA-28wg, GHSA-2v37
  postcss: ^8.5.23                    # GHSA-r28c (>=8.5.18) + GHSA-fxqj (>=8.5.23)
  'protobufjs@7': ^7.6.5              # GHSA-j3f2 (8.x is a major for dockerode's path)
  qs: ^6.15.3
  # shell-quote has no 1.8.5 despite GHSA-395f naming it; 1.9.0 is the first
  # published release carrying the fix. Verified against `npm view shell-quote versions`.
  shell-quote: ^1.9.0                 # was 1.8.4 — i.e. the vulnerable version, pinned
  socket.io-parser: ^4.2.7            # via react-email > socket.io
  svgo: ^4.0.2                        # GHSA-2p49, via the unmaintained @svgr/cli 8.1.0
  'testcontainers>undici': ^7.29.0    # GHSA-4cwx + 4 moderates
```

Two entries become unnecessary and should be **deleted**:
- `'react-cosmos>ws': 8.21.0` — dead once §6 lands.
- `postcss` floor — *may* be removable if `vite` goes to `8.2.1` (which requires `^8.5.25`), but keep it: `@tailwindcss/postcss` also pulls postcss and the floor is free insurance.

**Validation of this exact set:** APP2 runs a near-identical caret-floor list and its live audit today is **1 advisory** (a new one published after their sweep). APP1 runs the exact-pin variant and sits at **2**. The template runs the stale-exact variant and sits at **32**.

**Risk:** low. **Effort:** 1 h + one `pnpm install` + `pnpm verify`.

---

## 12. Why this recurred, and the two automation changes that stop it

The template *has* a well-configured `.github/dependabot.yml` (80 lines, six groups: `tanstack`, `sentry`, `react`, `drizzle`, `dev-tooling`, `production-minor-patch`, plus github-actions and docker ecosystems). It is not a missing-automation problem. Two structural gaps explain the 3-month drift:

**(a) Dependabot cannot see `pnpm-workspace.yaml` overrides.** Every one of the 21 high advisories is transitive and is fixed by an override floor, which lives in a file Dependabot does not parse. So the *only* mechanism that can clear the template's actual advisory load is a human running `pnpm audit`. Nothing schedules that.

> **Add** a scheduled workflow — `.github/workflows/dependency-floors.yml`, weekly — that runs `pnpm audit --audit-level=low --json`, diffs the reported `patched_versions` against `pnpm-workspace.yaml` `overrides`, and opens an issue listing the floors to add. ~60 lines of Node in `scripts/check-override-floors.mjs`. This is the single highest-value automation in this track; without it the same drift recurs.

**(b) `scripts/check-risk-register.mjs` is a guaranteed future failure.** `docs/security-risk-register.md` ships six entries all dated `2026-07-23`; the script compares against `new Date().toISOString().slice(0,10)` and `process.exit(1)` on any past date. So `pnpm check` — the documented merge gate at `package.json:132`, reached through `security:audit` at `:62` → `security:risk-register` at `:65` — is *guaranteed* to fail for every fork created after the review date. It has been failing since 2026-07-23, and both forks inherited it.

> **Change the gate's semantics**: hard-fail only when an entry is **both** expired **and** still reported by `pnpm audit`. An expired entry whose advisory no longer resolves should print a "stale entry, delete me" warning, not block work. Concretely, in `scripts/check-risk-register.mjs`, join the parsed rows against `pnpm audit --json`'s `advisories[].module_name` before deciding the exit code.
>
> **And ship the register empty.** With §11's floors applied the only remaining rows are `@svgr/cli`'s transitives (already floored) and `nitro`. A starter should not ship five inherited accepted-advisory rows with a fixed expiry date.

**(c) A smaller interaction worth checking:** `pnpm-workspace.yaml:5` sets `minimumReleaseAge: 1440`, which refuses versions published in the last 24 h. Dependabot routinely opens PRs within hours of a release. Those PRs' `pnpm install --frozen-lockfile` in CI may fail resolution until the version ages out. I did **not** reproduce this (no Node 24 on this host) — mark it low-confidence — but it is worth a one-line check, and pnpm supports excluding specific packages from the age rule if it bites.

---

## 13. Sequencing and effort

Ordered so that nothing later has to redo earlier work. Each row is a separate PR.

| # | Change | Blocks | Effort | Risk |
|---|---|---|---|---|
| 1 | **Advisory clearance**: §11 override block; `vitest`/`@vitest/*` → 4.1.10; `vite` 8.1.0 → 8.2.1; `npm-run-all` → `npm-run-all2` | everything (green `check` first) | **1 day** | low |
| 2 | **Risk register**: rewrite `check-risk-register.mjs` semantics (§12b); empty the register except `nitro` | 1 | **0.5 day** | low |
| 3 | **Nitro**: `npm:nitro-nightly@…` → `nitro@3.0.260610-beta`; rewrite its register row (§2) | 2 | **0.5 day** (mostly verify + e2e) | medium |
| 4 | **Toolchain sweep**: §1b batch — OTel ×14, TanStack ×9, react 19.2.8, tailwind 4.3.3, sentry, playwright, oxlint/oxfmt, knip, dependency-cruiser 17→18, `@foresightjs/react` 0.3→1.0 | 1 | **1 day** | low-medium |
| 5 | **Drop react-cosmos** (§6): deps, 63 fixtures, 5 config files, `cosmos-pages.yml`, 8 tool globs, `react-cosmos>ws` override, register row | 2 | **0.5 day** | low-medium |
| 6 | **Import ordering** (§5 Stage 1): `.oxfmtrc.json` `sortImports`; drop `ts-plugin-sort-import-suggestions` + `eslint-plugin-simple-import-sort`; one repo-wide reformat | 4 | **0.5 day** | low |
| 7 | **tsgo** (§5 Stage 2): the `typescript`/`@typescript/native` alias + two `tsconfig.json` deletions + README note | 6 | **1 day** | **medium** |
| 8 | **`@base-ui/react` 1.6.0 → 1.7.0** + registry-contract note in `AGENTS.md` (§8) | 4 | **0.5 day** | medium (visual baselines) |
| 9 | **i18n**: drop `fr`/`sw`; glob barrel; optional-i18n note (§9) | 4 | **1 day** | low-medium |
| 10 | **React Compiler doc** (§4): port `react-compiler-toolchain-evaluation.md`, add the do-not-scope comment at `vite.config.ts:110`, `@vitejs/plugin-react` → 6.0.5 | — | **0.5 day** | none |
| 11 | **Override-floor automation** (§12a): `scripts/check-override-floors.mjs` + weekly workflow | 1 | **1 day** | low |
| 12 | **Lint consolidation** (§10): `oxlint.config.ts`, `eslint.typed.config.mjs`, drop 6 ESLint packages, port `docs/oxc-tooling-decisions.md` | 6, 7 | **2–3 days** | medium |
| 13 | *(optional)* **tsgolint** (§5 Stage 3): `oxlint-tsgolint`, scoped to the six already-enforced typed rules | 12 | **1–2 days** | medium |

**Total: ~11–14 engineer-days**, of which items 1–5 (**2.5 days**) restore a green `pnpm check` and eliminate the nightly-pin supply-chain exposure. Items 1–5 are the ones I would insist on.

---

## 14. Explicit owner decisions, with recommendations

| # | Decision | My recommendation | Confidence |
|---|---|---|---|
| A | Nitro channel: nightly / beta / GA | **`nitro@3.0.260610-beta`.** There is no GA (`3.0.0` is deprecated upstream); the beta channel is curated, is on the real package name, and the current nightly is 3.2 months stale. | high |
| B | `rolldown-vite` | **Do nothing** and document why. Vite 8 already depends on `rolldown@~1.1.2`; `rolldown-vite@7.3.1` would be a Vite 7 downgrade breaking `@vitejs/plugin-react@6`'s `vite ^8` peer. | high |
| C | React Compiler / SWC swap | **Keep `plugin-react` + `@rolldown/plugin-babel`.** Correctness (swc#11982-class silent miscompiles), `useAtYourOwnRisk_` API, and no measurable build-time win. Port iris's doc. | high |
| D | TS 7 native (`tsgo`) | **Adopt Stages 1–2.** Proven in a 123-commit app; migration is two `tsconfig.json` deletions. Document the editor consequence. | high on mechanism, medium on org appetite |
| E | `oxlint-tsgolint` (Stage 3) | **Defer** until (D) and the lint consolidation land. | medium |
| F | react-cosmos | **Drop.** iris's stated reason is wrong (the `/src/main.tsx` interception is by design — I verified against the plugin source), but the real costs — a Pages workflow, an accepted advisory, two overrides, 78 packages, 63 fixtures, 8 tool configs — stand, and neither fork used it for its own components. | high on cost, **medium** on the judgement call |
| G | shadcn `components.json` | **Keep + warn.** 15/43 components are locally modified for i18n; `shadcn add` over them is destructive. Delete it only if forks should never use the registry. | high |
| H | i18n locales | **`en` + `ar`.** `ar` is the only locale exercising `dir: rtl` / `fontScale`; `fr` and `sw` are structurally redundant with `en` and cost 41 KB of always-bundled JSON a template maintainer cannot keep accurate. | medium (the causal read of fork behaviour is inference) |
| I | Lint consolidation | **Do it, last.** APP1 proved the shape and wrote the removal criterion; the ~10 duplicated ESLint packages and the double SonarJS pass are pure tax. | medium |
| J | `jscpd` | **Wire it into `check` or delete it.** Shipping a tool + config + a knip suppression for something that runs nowhere is worse than either. | high |

---

## 15. Corrections to the evidence corpus

Two corpus items in this track are wrong or incomplete, and acting on them as written would produce bad changes:

1. **"`@vitest/browser < 4.1.10` was CRITICAL — sourced only to iris commit `efac8c6`, treat as second-hand."** It is **first-hand confirmed**: `pnpm audit --json` on the template today reports `GHSA-p63j-vcc4-9vmv`, severity `critical`, `@vitest/browser >=4.0.0 <4.1.10`, patched `>=4.1.10`. It is the only critical in the repo.

2. **iris's react-cosmos removal rationale** (quoted approvingly in the corpus) claims the setup was "already non-functional" because `/src/main.tsx` and a root `index.html` do not exist. Reading `react-cosmos-plugin-vite@7.3.0/dist/reactCosmosViteRollupPlugin.js` shows both are *expected* absences: `resolveId` swaps `mainScriptUrl` for `'\0virtual:cosmos-renderer'`, and `buildStart` explicitly supports another plugin intercepting root `index.html` — which is what `vite.cosmos.ts:20-30` does. The template's cosmos setup is a correct configuration. **The drop is still right; the justification must be rewritten**, or a future maintainer will "fix" a non-bug.

Additionally, the corpus's framing of `pnpm-workspace.yaml` as needing "the floors both apps needed" understates it: the template needs **eight** floors neither fork's list fully covers today (`nanoid@3`, `js-yaml@4` at `^4.3.1` not `^4.3.0`, `postcss` at `^8.5.23` not `^8.5.18`, `brace-expansion@1/@2/@5` at the GHSA-rgw5 levels, `socket.io-parser`, `protobufjs@7`), because three new advisories landed after both forks' last sweeps.
