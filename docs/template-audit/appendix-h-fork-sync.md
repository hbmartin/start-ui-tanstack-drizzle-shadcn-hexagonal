<!-- Appendix H of the template improvement audit. See ./REPORT.md for the synthesis. -->

# Track: Template → Fork Update Propagation

## 0. The fact that determines everything else: **there is no fork**

Every proposal in the brief (`upstream` remote + periodic merge, `template-sync` Action, versioned package, codemods) presumes some relationship between the template and the apps. Measured, there is none.

```
$ git -C <each repo> log --format=%H | sort > repo.sha
shared SHAs template ^ hume-demo:        0
shared SHAs template ^ iris-insights-crm: 0
shared SHAs hume-demo ^ iris-insights-crm: 0
  (113 / 123 / 47 commits respectively)
```

Both apps begin with a squashed tree copy:

| Repo | Root commit | Date | First-commit contents |
|---|---|---|---|
| template | `9819ad3` (+ a second root `4459a84`) | 2026‑05‑29 | — |
| hume-demo | `845552c` "first commit" | 2026‑07‑16 | `.claude/rules/*`, `.dependency-cruiser.cjs` (534 lines), `.github/**`, … — the whole template tree |
| iris-insights-crm | `af6ae45` "first commit" | 2026‑07‑31 | `AGENTS.md`, `README.md`, `__visual_snapshots__/*-chromium-darwin.png`, … — the whole template tree, **plus `_tmp_15180_c07afed440b3242d9e7e1720a174b382`** (a zero-byte scratch file, still at HEAD) |

Consequences that are not negotiable:

- **`git merge upstream/main` cannot be run today.** It requires `--allow-unrelated-histories`, and with unrelated histories git has no merge base, so *every* file that both sides touched becomes a full-content conflict. hume-demo has 179 modified + 471 deleted template files; iris has 173 modified + 189 deleted. That is a 650-file and a 362-file conflict resolution, once, before the first useful sync.
- **The apps also cannot help each other.** hume-demo and iris share zero commits, so a fix in one is invisible to the other except by a human noticing. The evidence corpus shows exactly this cost: both apps independently wrote a canonical-app-URL resolver (`hume-demo/src/platform/env/app-url.ts`, 2026‑07‑16 vs `iris/src/modules/kernel/infrastructure/config/app-url.ts`, 2026‑08‑01), both independently added a console telemetry fallback, both independently deleted `'/api/upload'` from `src/platform/http/browser-mutation-protection.ts:17`.
- **iris did not even inherit the template's agent rules.** `find /home/user/iris-insights-crm/.claude -type f` returns nothing, and `.gitignore` does not mention `claude` — iris deleted `.claude/rules/{architecture,modules,testing}.md` outright and re-derived the content into its own `CLAUDE.md`. hume-demo kept all four `.claude/` files. So the template's agent-facing rules are already at 50% survival across two forks.

Any propagation design must therefore start by **manufacturing** a shared ancestor, or by choosing a mechanism that does not need one.

---

## 1. Measured divergence: how much is actually shared

Blob-hash comparison of every git-tracked file (`git ls-files -s`), template HEAD vs each app HEAD. iris forked 11 days *after* the template's last commit (2026‑07‑20), so for iris "modified" is purely app-side change; for hume-demo two template commits (`0109c33`, `199954f`) post-date its fork and inflate its "modified" count slightly.

### 1.1 By tree

```
=== hume-demo vs template ===          === iris vs template ===
bucket             ident  mod  del add   bucket             ident  mod  del add
src/platform/        192   49    3   4   src/platform/        157   12   75   2
tests/                53   31  138  80   tests/               135   66   21  14
src/modules/           0    0  199 127   src/modules/         131   15   53  23
<root>                29   28   17  30   <root>                40   22   12   8
src/app/              20   15   35   1   src/app/              40   22    8   0
src/modules/kernel/   24   10   23   1   src/modules/kernel/   38   14    5   3
.github/              30   13    2   1   .github/              38    6    1   0
src/routes/            4    3   28  11   src/routes/           26    2    7  12
src/composition/       7   11    9   8   src/composition/      19    5    3   0
drizzle/               0    0   16   0   drizzle/              12    2    2   3
scripts/              11    3    1  10   scripts/              12    3    0   1
TOTAL                374  179  471 296   TOTAL                662  173  189  71
                     37% identical                            65% identical
```

The two forks are at opposite ends of a spectrum, and that spectrum is the design constraint:

| | hume-demo | iris |
|---|---|---|
| Kept the platform module stack (`auth`/`user`/`account`/`email`) | **No — deleted all 146 files** | **Yes — 131 of 146 byte-identical** |
| Kept Drizzle/Postgres | No (0/16 of `drizzle/` survives) | Yes (12/16 identical) |
| Kept the shadcn UI kit | Yes (mostly) | Yes, minus 42 `*.fixture.tsx` |
| Kept react-cosmos | Yes (`cosmos.config.json`, `vite.cosmos.ts` identical) | Deleted both |
| Kept `.claude/rules/` | Yes | Deleted |

Per module:

```
module        files | hume same/mod/del | iris same/mod/del
account          24 |      0/  0/ 24    |     21/  3/  0
auth             68 |      0/  0/ 68    |     59/  9/  0
email            23 |      0/  0/ 23    |     21/  2/  0
user             31 |      0/  0/ 31    |     30/  1/  0
book             35 |      0/  0/ 35    |      0/  0/ 35
genre            18 |      0/  0/ 18    |      0/  0/ 18
kernel           57 |     24/ 10/ 23    |     38/ 14/  5
```

This bimodality is the single strongest argument against a monolithic `@startui/*` package: `auth` is 87% reusable to one fork and 0% reusable to the other. Only `kernel` is kept by both — and both modified it.

### 1.2 The guardrail configs are ~96% identical across all three repos

This is the most surprising and most actionable measurement:

| file | template lines | hume diff lines | iris diff lines |
|---|---:|---:|---:|
| `.semgrep.yml` | 1455 | 40 | 41 |
| `.dependency-cruiser.cjs` | 534 | 52 | 51 |
| `sheriff.config.ts` | — | **0 (byte-identical)** | modified |
| `knip.jsonc` | 13 | 2 | 9 |
| `lefthook.yml` | 9 | 4 | 3 |

And the content of those small diffs is almost entirely *not* app policy. iris's entire `.dependency-cruiser.cjs` diff decomposes as:

```diff
@@ -57,8 +57,8 @@   name: 'domain-no-presentation'
-      from: { path: '^src/modules/(book|user|genre|account)/domain' }
+      from: { path: '^src/modules/(user|account)/domain' }
@@ -75,8 +75,8 @@   name: 'application-no-presentation'      (same substitution)
@@ -159,8 +159,8 @@  name: 'infrastructure-no-presentation'    (same substitution)
@@ -206,7 +206,6 @@
-        pathNot: '^src/modules/book/server\\.ts$',           # the vestigial waiver
@@ -240,14 +239,6 @@ - name: 'composition-uses-kernel-storage-public-gate'   # feature removed
@@ -369,26 +370,6 @@ - name: 'better-upload-server-confined'  / 'better-upload-client-confined'
+      name: 'auth-better-auth-uses-kernel-public-gates',     # ← the ONE genuine app rule
```

So of ~26 changed lines: **3 rules are pure module-allowlist substitution** (which would be zero if the template used the `$1` backreference style it already uses in `no-cross-feature-deep-import`), **1 is deleting the vestigial `book/server.ts` waiver**, **3 are deleting rules for deleted features**, and **1 is a new app rule**.

Same story in semgrep. iris's diff is almost pure deletion — narrowing the 27-name branded-type alternation at `.semgrep.yml:1426` and `:1446` down to 17, dropping `better-upload-*-confined`, dropping `src/modules/book/application/use-cases/update-book.ts` from a path exclude. hume's diff is almost pure *addition* — four new rules (`no-process-exit-in-telemetry-shutdown`, `no-literal-test-credential-properties`, `devcontainer-json-must-use-jsonc-parser`, `no-shared-unknown-evaluation-rate-limit-bucket`) with zero deletions, which is why hume still ships `BookTitle|GenreColor|PublisherName` in a repo that has no book module.

hume's `.dependency-cruiser.cjs` additions are five rules that are *strictly better than the template's* and written in the generic backreference style:

```js
{
  name: 'presentation-does-not-compose-other-feature-presentation',
  from: { path: '^src/modules/([^/]+)/presentation(?:/|\\.tsx?$)' },
  to:   { path: '^src/modules/[^/]+/presentation\\.tsx?$', pathNot: '^src/modules/$1/' },
},
{
  name: 'client-infrastructure-no-server-or-kernel-adapters',
  from: { path: '^src/modules/(?!kernel/)[^/]+/infrastructure/client(?:/|$)' },
  to:   { path: '…\\.server\\.(?:ts|tsx)$|^src/platform/env/server\\.ts$', reachable: true },
}
```

**Conclusion:** guardrail configs are the *most* shareable artifact in the repo, and the divergence that exists is overwhelmingly template defect (hardcoded enumerations) plus feature-removal fallout. This is a generation problem, not an ownership problem.

### 1.3 `src/platform` — where the seams actually are

244 tracked files, 16,546 LOC (12,948 of it `components/`). Three-way status:

```
group                              n  bothSame  bothMod  oneMod  anyDel
src/platform/flags/                3         3        0       0       0
src/platform/runtime-config/      15        13        0       2       0
src/platform/lib/                 16        12        1       3       0
src/platform/router/               6         5        0       1       0
src/platform/hooks/                6         5        0       1       0
src/platform/http/                 8         4        2       0       2
src/platform/telemetry/            7         4        1       2       0
src/platform/env/                  4         2        1       1       0
src/platform/styles/               2         0        1       0       1
src/platform/components/ui/       90        37        0      11      42
src/platform/components/form/     42        21        1       2      18
src/platform/components/ (other)  45        27        0       3      15
```

Non-component substrate: **48 of 67 files (72%) byte-identical in both apps.** UI components: 85 of 177 identical, but **78 deleted by at least one app** — almost all `*.fixture.tsx` (iris deleted the entire react-cosmos fixture set along with `cosmos.config.json` and `vite.cosmos.ts`).

The seven files **both apps modified** are the definitive list of what cannot be shipped as immutable shared code:

| file | hume's change | iris's change | true nature |
|---|---|---|---|
| `components/form/use-app-form.ts` | removed `SubmitButton: FormSubmitButton` | removed `FieldUploadInput` | **hardcoded registry** — both trimmed it, differently |
| `http/browser-mutation-protection.ts` | deleted `'/api/upload',` (line 17) | deleted `'/api/upload',` (line 17) | **template defect** — a demo route baked into a platform allowlist. *Identical edit in both apps.* |
| `lib/get-page-title.ts` | `\| SparkEd` | `\| Iris Insights` | **branding** |
| `styles/app.css` | +113 lines of `--color-sparked-*` tokens | 155-line oklch theme rewrite | **theme** |
| `telemetry/index.ts` | `+export { TELEMETRY_CONSOLE_HANDLED_ATTRIBUTE } from './console'` | `+export { createConsoleTelemetry } from './console'` + `./report-failure` | **additive barrel** — both added a `console.ts` the template lacks |
| `http/security-headers.ts` | −119 lines (CSP deleted wholesale) | option shape changed: `baseUrl?` → `isHttps?`, `s3BucketPublicUrl?` dropped | **app config leaked into a shared signature** |
| `env/config.ts` | — | the `isProd()` / `runtimeEnv()` fixes | **template bug**, fixed once |

And `src/platform` violates its own extractability in exactly three places:

```
src/platform/components/ui/calendar.tsx:25:import { REACT_DAY_PICKER_LOCALE_MAP } from '@/app/i18n/react-day-picker';
src/platform/lib/i18n/config.ts:9:import locales from '@/app/i18n';
src/platform/lib/i18n/constants.ts:1:import locales from '@/app/i18n';
```

Three upward imports into app-owned i18n. Small, but they are hard blockers for any package boundary.

### 1.4 The case that breaks naive overwrite-sync

`src/modules/kernel/infrastructure/config/url-security.ts` — iris **deliberately weakened** a security guard, with a rationale comment, in commit `b781192` "Drop the authenticated-sslmode requirement for demo deployments":

```diff
-const SECURE_SSL_MODES = new Set(['verify-ca', 'verify-full']);
-  if (sslmodes.length !== 1 || !sslmode || !SECURE_SSL_MODES.has(sslmode)) {
-    throw new ConfigurationError(`${name} must enable authenticated TLS in production…`);
+ * This deliberately does *not* require an authenticated sslmode
+ * (`verify-ca` / `verify-full`): this is a demo deployment… reinstate the
+ * authenticated-sslmode requirement before this handles real credentials.
```

A file-overwriting sync silently re-tightens this and iris's next production deploy fails at boot. A three-way merge conflicts on it every single sync forever. Any mechanism must have a **first-class "we diverged here on purpose, and here's why"** record — not a `.gitattributes` hack, not a merge-driver.

---

## 2. Evaluating the five candidate mechanisms against this evidence

### (a) `upstream` git remote + periodic merge

**Verdict: viable only as a *fallback*, and only after paying a one-time reconstruction cost. Not the primary.**

Blockers, in order of severity:

1. No common ancestor (§0). You must synthesize one. The only honest way: create an orphan branch in each app whose tree is the exact template state the app was copied from, then graft. For iris that state is knowable — it forked 2026‑07‑31 from a template whose HEAD (`199954f`) is 2026‑07‑20, so `template@199954f` *is* the base. For hume-demo, forked 2026‑07‑16, the base is somewhere before `0109c33` (2026‑07‑18); `git log --since=2026-07-15` shows only two template commits in the window, so `199954f~2` is a defensible approximation.
2. Even with a correct base, the first merge is enormous: hume deleted 471 template files and 199 module files; git will present those as delete/modify conflicts for every template commit that touched them.
3. It propagates *everything* — including the book/genre demo, which iris spent a 190-file / 9,695-deletion commit (`8d2b7b4`) removing. Every future template commit touching `src/modules/book` becomes noise in both forks.
4. It has no answer for `url-security.ts` (§1.4) except a permanent conflict.

The one thing it does well and nothing else does: **it makes the fix flow bidirectional**. hume's five better depcruise rules and iris's `isProd()` fix could be `git cherry-pick`ed upstream. That is worth preserving in some form.

### (b) A `template-sync` GitHub Action

**Verdict: yes — but as the *delivery* of a mechanism, not the mechanism itself.** An Action that runs `git merge upstream` inherits every problem in (a). An Action that runs a *manifest-driven sync script* (§3) is exactly right: it opens a PR per template release, the fork's own `pnpm check`/`pnpm test:affected` run on it, and a human resolves. The template already has 12 workflows and a `.github/actions/setup-pnpm/action.yml` to build on.

### (c) Extract the substrate into a versioned npm package / pnpm workspace package

**Verdict: reject as the primary mechanism. Adopt for a narrow, specific subset only.**

Grounded reasons:

- **The bimodality kills the module tier.** `auth` (68 files) is 87% reusable to iris and 100% deleted by hume. A package that both must depend on is wrong for one of them; an optional package is a preset, which is a scaffolding concern, not a dependency concern.
- **The files a package would most need to own are the files both apps edited.** `src/platform/http/security-headers.ts` is shared logic whose *signature* had to change per app (iris: `baseUrl?: string` → `isHttps?: boolean`, dropped `s3BucketPublicUrl?`). `use-app-form.ts` is a registry both apps trimmed. Turning these into package APIs is not a repackaging job — it's a redesign (invert the registry, take the CSP source lists as parameters), and that redesign is worth doing *regardless of packaging*.
- **The three `@/app/i18n` imports** (§1.3) mean `src/platform` is not even acyclic against the app today.
- **The repo is `"private": true`** (`package.json:5`) with `"author": {"name": "Ivan Dalmet"}` and `bugs` pointing at `hbmartin/start-ui-web`. Publishing requires resolving fork identity first.
- **It breaks the agent property** — see §5. This is not a soft concern for this repo; `.claude/rules/architecture.md` and `AGENTS.md` are written as "open the file and read the rule," and `depcruise`/Sheriff/Semgrep operate on **paths under `src/`**. Move `src/platform` into `node_modules/@startui/platform` and `.dependency-cruiser.cjs:100`-style rules like `from: { path: '^src/platform' }` stop matching anything.

**Where a package *is* right — three narrow, honest candidates:**

| candidate | evidence | shape |
|---|---|---|
| `scripts/lib/` + the check scripts | 10 of 15 `scripts/` files byte-identical in both apps; `check-test-layering.mjs` is fully generic; `git-utils.mjs` exports `runGit`/`resolveBase`/`listChangedFiles` already reused by `format-changed.mjs` | `@startui/repo-tools` — a devDependency with a bin. Zero agent cost: nobody reads `check-migration-edits.mjs` to understand the architecture. |
| Guardrail **config factories** | `.semgrep.yml` 97% identical, `.dependency-cruiser.cjs` 90% identical, `sheriff.config.ts` byte-identical in hume | `@startui/guardrails` exporting `createDependencyCruiserConfig({ modules, extraRules })`. The repo-root file becomes 15 lines that an agent can still read, and the 500 lines of policy become versioned. |
| Stryker config factory | `stryker.shared.config.mjs:6-11` already exports `createScopedStrykerConfig({ moduleName, … })`; 9 wrapper files + 8 tsconfigs are 100% derivable | Fold into `@startui/repo-tools`; delete 17 root files and the `knip.jsonc:5-8` workaround. |

Everything else — `src/platform/**`, `src/modules/kernel/**`, `src/app/**` — stays **source in the repo**.

### (d) Copier-style templating

**Verdict: reject for updates; adopt one narrow idea from it.**

Copier's update model is `diff(old_template_render, new_template_render)` applied to the fork — it needs the fork to have been *created* by copier and to retain `.copier-answers.yml`. Neither app was. Retrofitting means re-rendering the 2026‑07‑16 and 2026‑07‑31 template states through a copier template that does not exist, which is strictly more work than the graft in (a) and buys the same three-way merge.

The idea worth stealing: **an answers file**. The evidence corpus's branding finding (45 files carrying `start-ui`/`startui`/`bearstudio`) plus the load-bearing literals — `MIGRATION_LOCK_NAMESPACE = 'start-ui-web'` (`src/modules/kernel/infrastructure/db/migrate.ts:24`), `trace.getTracer('start-ui-web')`, `CSP_NONCE_PLACEHOLDER = '__START_UI_CSP_NONCE__'` — are exactly copier variables. One `template.answers.json` at the fork root (`{ "appSlug": "iris", "appName": "Iris Insights", "presets": ["auth","user","account","email"] }`) makes those derivable and makes the sync script able to skip presets the fork dropped.

### (e) Codemod releases

**Verdict: adopt as the *escape hatch* for breaking changes, not as the transport.**

There is exactly one confirmed breaking-signature change in the corpus: iris changed `unwrapApplicationResult(result, handlers)` → `unwrapApplicationResult(result, handlers, logger: ResultMapperLogger)` in `src/modules/kernel/transport/tanstack/result-mapper.ts`. That is a real codemod (add an argument at every call site) and it is the only one. Building a codemod *pipeline* for a template that produces one breaking API change per quarter is over-engineering. Building a `codemods/` directory where a release can drop a `jscodeshift` file, referenced from `UPGRADING.md`, costs nothing.

---

## 3. Recommendation

> **Primary: manifest-driven vendored sync — `pnpm template:sync`, delivered by a scheduled GitHub Action that opens a PR.**
> **Fallback: a synthesized `upstream` remote used only for cherry-picking individual commits in both directions.**

The mechanism is: the template remains the single source of truth as **files**; each fork records, per path, whether it *tracks* the template, *owns* the file outright, or has a *recorded deliberate divergence*; the sync tool applies template changes for tracked paths using the fork's recorded base revision as the merge base, and refuses to touch the rest.

Why this and not the alternatives, in one line each:
- It works today, with no history reconstruction (unlike (a)).
- It survives hume having deleted 471 template files and iris having deleted 189 (a package/merge cannot).
- It keeps everything readable in the repo (unlike (c)).
- It handles `url-security.ts` explicitly instead of conflicting on it forever.
- It is ~400 lines of Node in a repo that already has `scripts/lib/git-utils.mjs`.

### 3.1 `.template-sync.json` — the manifest (lives in each fork)

```jsonc
{
  "$schema": "https://raw.githubusercontent.com/hbmartin/start-ui-tanstack-drizzle-shadcn-hexagonal/main/schema/template-sync.schema.json",
  "template": {
    "repo": "https://github.com/hbmartin/start-ui-tanstack-drizzle-shadcn-hexagonal",
    // The template ref this fork was last reconciled against. Written by
    // `pnpm template:sync --accept`. On first adoption, set to the commit
    // whose tree the fork was copied from.
    "baseRef": "199954ffb2fe771e0895d6d17b8159316b7caa85",
    "baseVersion": "4.0.0"
  },
  "identity": {
    "appSlug": "iris",
    "appName": "Iris Insights",
    "renamedLiterals": [
      "src/modules/kernel/infrastructure/db/migrate.ts#MIGRATION_LOCK_NAMESPACE",
      "src/platform/http/csp-nonce.ts#CSP_NONCE_PLACEHOLDER",
      "src/composition/telemetry/otel-adapter.ts#tracer|meter|logger"
    ]
  },
  // Presets this fork dropped. The sync tool never proposes files under these.
  "droppedPresets": ["book", "genre", "cosmos", "upload"],

  "tracked": [
    "src/platform/**",
    "src/modules/kernel/**",
    "scripts/**",
    ".github/**",
    "tests/support/**",
    "AGENTS.md", "TESTING.md", ".claude/**",
    ".dependency-cruiser.cjs", ".semgrep.yml", "sheriff.config.ts", "knip.jsonc"
  ],

  // Paths the fork owns outright. Template changes are reported in the PR body
  // as FYI and never applied.
  "owned": [
    "src/app/**",
    "src/routes/**",
    "src/composition/**",
    "src/modules/launch-workspace/**",
    "src/platform/styles/app.css",          // 155-line oklch theme rewrite
    "src/platform/lib/get-page-title.ts",   // branding
    "README.md", "CLAUDE.md", "CONTEXT.md", ".env.example",
    "drizzle/migrations/**"                 // immutable by policy
  ],

  // Deliberate divergences. Required fields: reason + the fork commit that made
  // the decision. `pnpm template:sync` prints these and skips the path;
  // `--audit` fails if the template's version changed since `sinceTemplateRef`,
  // so a security fix upstream cannot be silently ignored forever.
  "divergences": [
    {
      "path": "src/modules/kernel/infrastructure/config/url-security.ts",
      "reason": "Demo deployment: managed providers negotiate TLS from a plain postgres:// string. Reinstate the authenticated-sslmode requirement before this handles real credentials.",
      "decidedIn": "b781192",
      "sinceTemplateRef": "199954f",
      "review": "2026-11-01"
    },
    {
      "path": "src/platform/http/security-headers.ts",
      "reason": "Signature changed: baseUrl?:string -> isHttps?:boolean; s3BucketPublicUrl removed with the upload preset.",
      "decidedIn": "2589bb1",
      "sinceTemplateRef": "199954f"
    }
  ]
}
```

Note the `divergences[].review` date deliberately mirrors `docs/security-risk-register.md`'s existing "Next review" column — and must **not** repeat its mistake: the corpus confirms `node scripts/check-risk-register.mjs` exits 1 today because every row expired 2026‑07‑23. So `--audit` should warn on an expired review, and only *fail* when the template has actually changed the file (`sinceTemplateRef` behind).

### 3.2 `pnpm template:sync` — actual CLI

Lives at `scripts/template-sync.mjs` in the **template**, and is copied into forks as a tracked file (it is itself under `scripts/**`, so it self-updates). Reuses `scripts/lib/git-utils.mjs`.

```
pnpm template:sync [--to <ref>] [--dry-run] [--audit] [--accept] [--only <glob>]

  (default)    Fetch the template into a bare cache at .git/template-cache,
               compute the diff  baseRef..to  restricted to `tracked` minus
               `owned` minus `divergences[].path` minus droppedPresets, and
               apply it with `git apply --3way`. Leaves conflicts in the tree
               as normal conflict markers for a human/agent to resolve.
               Prints a summary table and writes .template-sync-report.md.

  --dry-run    Print the table only. Touches nothing. Safe offline once the
               cache exists. This is what the Action runs first.

  --audit      Exit 1 if any `divergences[]` entry has a template-side change
               between its `sinceTemplateRef` and template HEAD, or if
               `identity.renamedLiterals` no longer resolve. Wire into
               `pnpm check` so drift is a hard signal, not a quarterly chore.

  --accept     After a successful sync + `pnpm verify`, rewrite
               .template-sync.json{template.baseRef, template.baseVersion}
               and append a row to the fork's UPGRADING log.

  --only       Restrict to a subtree, e.g. --only 'src/platform/telemetry/**'.
               Use this to take one fix without taking a release.
```

What it edits, precisely: files under `tracked`, and exactly two lines of `.template-sync.json` on `--accept`. Nothing else. It never runs `git commit`.

Report it emits (this is what the PR body becomes):

```
Template sync  v4.0.0 (199954f) → v4.3.0 (a1b2c3d)

APPLIED CLEAN (14)
  src/platform/telemetry/runtime.ts            guarded proxy + report-failure
  src/platform/lib/redaction/sanitize-log-fields.ts
  src/modules/kernel/transport/tanstack/result-mapper.ts   BREAKING → codemods/0002
  .dependency-cruiser.cjs                      generic $1 backrefs
  ...

CONFLICTED (2) — resolve in working tree
  src/platform/env/config.ts
  src/platform/components/form/use-app-form.ts

SKIPPED — owned by this fork (3)
  src/platform/styles/app.css
  src/platform/lib/get-page-title.ts
  README.md

SKIPPED — recorded divergence (1)
  src/modules/kernel/infrastructure/config/url-security.ts
    ↳ b781192 "Demo deployment: managed providers negotiate TLS…"
    ⚠ template changed this file in a1b2c3d — review required

SKIPPED — dropped preset (37)
  src/modules/book/**, src/modules/genre/**, src/platform/components/upload/**

BREAKING CHANGES (1)
  unwrapApplicationResult() gained a required `logger` argument.
  Run: pnpm dlx jscodeshift -t codemods/0002-result-mapper-logger.cjs src/
```

### 3.3 The GitHub Action

`.github/workflows/template-sync.yml`, shipped **in the template** so every fork gets it:

```yaml
name: Template sync
on:
  schedule: [{ cron: '0 6 * * 1' }]   # Monday 06:00 UTC
  workflow_dispatch:
    inputs:
      to: { description: 'Template ref (default: latest tag)', required: false }

permissions: { contents: write, pull-requests: write }

jobs:
  sync:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
        with: { fetch-depth: 0 }
      - uses: ./.github/actions/setup-pnpm      # already exists in the template
      - run: pnpm install --frozen-lockfile
      - id: sync
        run: pnpm template:sync ${{ inputs.to && format('--to {0}', inputs.to) || '' }}
        continue-on-error: true                 # conflicts are expected output
      - run: pnpm format:changed && pnpm check && pnpm test:affected
        continue-on-error: true
      - uses: peter-evans/create-pull-request@v7
        with:
          branch: template-sync/${{ steps.sync.outputs.to-version }}
          title: 'Template sync → v${{ steps.sync.outputs.to-version }}'
          body-path: .template-sync-report.md
          labels: template-sync
```

Two properties that matter: the PR **carries conflict markers** rather than failing (a resolvable PR is more useful than a red X), and `pnpm check` / `pnpm test:affected` run on the result so the reviewer sees the blast radius immediately. `continue-on-error` on both is deliberate — the report is the deliverable.

### 3.4 The fallback: a synthesized `upstream` remote for cherry-picks only

Do this **in addition**, because it is cheap and it is the only thing that makes fixes flow *back*:

```bash
git remote add template https://github.com/hbmartin/start-ui-tanstack-drizzle-shadcn-hexagonal
git fetch template
```

No merge, ever. Its jobs are:
1. `git cherry-pick -x` a single template commit into a fork when `template:sync` is too coarse.
2. **Upstreaming.** hume's five depcruise rules and iris's `env/config.ts` fix are single, clean commits. With the remote configured, `git format-patch` → template PR is a two-command operation instead of a manual retype. Given the corpus's finding that both apps independently rebuilt app-URL resolution, console telemetry, and pnpm security floors, the return path is worth as much as the forward path.

Document in `CONTRIBUTING.md` that merging `template/main` is **forbidden** (unrelated histories) and that `template:sync` is the only forward path.

---

## 4. Shareable-as-a-package vs must-stay-copied — the honest split

| Tier | Contents | Evidence | Mechanism |
|---|---|---|---|
| **A. Package (npm devDep)** | `scripts/check-*.mjs`, `scripts/lib/*`, `scripts/affected-tests.ts`, `scripts/task-verify.mjs`, `scripts/generate-module-dependency-graph.ts`, the Stryker factory | 10/15 `scripts/` byte-identical in both apps; `check-test-layering.mjs` fully generic; `stryker.shared.config.mjs:6-11` already a factory | `@startui/repo-tools` with bins. Deletes 17 root Stryker files + the `knip.jsonc:5-8` workaround. |
| **B. Package (config factory), thin file in repo** | dependency-cruiser rules, semgrep rules, sheriff layers, knip | `.semgrep.yml` 97% identical across all three; `sheriff.config.ts` byte-identical in hume; iris's whole depcruise diff = 3 allowlist substitutions + 4 deletions + 1 new rule | `@startui/guardrails`. Root file becomes `module.exports = createDependencyCruiserConfig({ modules: readdirSync('src/modules'), extraRules: [ /* the 1 app rule */ ] })`. |
| **C. Vendored, tracked by sync** | `src/platform/{env,flags,hooks,http,lib,router,runtime-config,telemetry}`, `src/modules/kernel/**`, `.github/**`, `AGENTS.md`, `TESTING.md`, `.claude/**`, `tests/support/**` | 72% of non-component platform files byte-identical in both apps; kernel kept by both | `template:sync` tracked paths. Stays as readable source. |
| **D. Vendored, tracked, but *optional presets*** | `src/modules/{auth,user,account,email}`, `drizzle/**`, `src/platform/components/upload/**`, cosmos | 87%/100%/91%/97% identical for iris, **100% deleted by hume** | `droppedPresets` in the manifest. Sync silently skips them for forks that dropped them; a `pnpm template:remove-preset <name>` does the deletion mechanically. |
| **E. Copied once, never synced** | `src/app/**`, `src/routes/**`, `src/composition/**`, `src/platform/styles/app.css`, `get-page-title.ts`, `README.md`, `.env.example`, `CLAUDE.md`, `CONTEXT.md`, `drizzle/migrations/**` | app.css diffs of 380 and 155 lines; page-title is literally the product name; migrations immutable by `scripts/check-migration-edits.mjs` | `owned` in the manifest. |
| **F. Cannot be shared until redesigned** | `src/platform/components/form/use-app-form.ts`, `src/platform/http/security-headers.ts`, `src/platform/http/browser-mutation-protection.ts` | all three modified by **both** apps, for structural reasons: a hardcoded component registry, an app-config-carrying signature, and a demo route (`'/api/upload'`) in a platform allowlist that both apps deleted identically | Fix these **before** the first sync. See §6 step 1. |

The tier-F items deserve emphasis: `browser-mutation-protection.ts:17` is a one-line template defect that produced a **byte-identical edit in two independent forks**. That is the cleanest possible demonstration that the propagation problem and the template-quality problem are the same problem — a well-factored template is one where forks don't have to touch the shared files at all.

---

## 5. The "everything is in the repo so agents can read it" trade-off

This property is real and this repo depends on it more than most:

- `AGENTS.md` (147 lines) and `.claude/rules/{architecture,modules}.md` are written as prose about **paths**: "`src/platform` must not import `modules`", "Cross-module imports go through public gates only". An agent verifies these by reading `src/platform/**`. Under a package, `grep -rn "from '@/modules" src/platform/` returns nothing because there is no `src/platform/`.
- The guardrails are literally path regexes. `.dependency-cruiser.cjs` has `from: { path: '^src/platform' }`; `sheriff.config.ts` has `src/modules/<module>` placeholders; `.semgrep.yml` has `paths.include: [src/**]`. Moving code to `node_modules/` disables all of them for that code.
- The repo's own working rules (iris `CLAUDE.md`) say *"Research means web search plus executable experimentation — not reading types or docs alone… Published `.d.ts` files, READMEs, and changelogs lag the shipped binary."* A package turns the substrate into exactly the `.d.ts`-and-changelog surface that rule distrusts.

**How the recommendation preserves it:**

- Tiers C/D/E stay as source in `src/`. That is ~85% of the code an agent reasons about, including 100% of `src/platform` and `src/modules/kernel`.
- Tier A is scripts nobody reads for architecture — `check-migration-edits.mjs` teaches nothing about the domain. Moving it out is a pure win.
- Tier B is the one real cost: `.dependency-cruiser.cjs` shrinks from 534 readable lines to ~15 lines calling a factory. **Mitigation:** ship `pnpm guardrails:explain`, which prints the fully-resolved rule set (name, from, to, comment) as text. An agent asking "why is this import forbidden" gets a better answer than reading 534 lines of nested objects, and `depcruise` already produces rule names in its output. If the owner judges this cost too high, keep the configs vendored in tier C — the sync mechanism handles them fine at 96% identity, it just won't auto-fix the hardcoded-allowlist class of bug.

**Recommendation on the trade-off:** take tier A (no cost), take tier B **only for semgrep and Stryker** (1455 and 17-file surfaces nobody reads end-to-end), and keep `.dependency-cruiser.cjs` and `sheriff.config.ts` vendored-and-generic in tier C, because those two are the files an agent most plausibly reads to understand the architecture, and fixing them is a regex change, not a packaging change.

---

## 6. Migration path for the two existing forks

### Step 0 — Fix the template first (prerequisite, ~1 week)

Syncing a template that ships `AUTH_SECRET="REPLACE ME"`, an expired risk register that fails `pnpm check` on a clean clone, and hardcoded `(book|user|genre|account)` allowlists just distributes those. Minimum pre-sync set, all from the corpus and all verified:

1. Generic `$1` backreferences in `.dependency-cruiser.cjs:57-61, 75-79`; delete the redundant `infrastructure-no-presentation` (159‑163) and the `pathNot: '^src/modules/book/server\.ts$'` waiver (:210); `[^/]+` in `sheriff.config.ts:44,47`. **This alone erases 3 of iris's 4 depcruise divergences.**
2. Derive the branded-type alternations at `.semgrep.yml:1426,1446` instead of enumerating 27 names. **This erases iris's semgrep divergence and hume's stale-regex problem.**
3. Delete `'/api/upload'` from `src/platform/http/browser-mutation-protection.ts:17` and make the list app-supplied. **Erases a both-apps divergence.**
4. Invert `use-app-form.ts`'s `formComponents` registry so the app supplies it. **Erases a both-apps divergence.**
5. Parameterize `security-headers.ts` — take CSP source lists as input rather than `s3BucketPublicUrl`. **Erases a both-apps divergence.**
6. Clear `docs/security-risk-register.md` expirations and make `check-risk-register.mjs` fail only on *expired ∧ still-reported* advisories.
7. `APP_SLUG` constant driving the OTel names, `CSP_NONCE_PLACEHOLDER`, and `MIGRATION_LOCK_NAMESPACE`; fix `tests/unit/platform/http/security-headers.unit.spec.ts:271-273` to derive its slice offsets from `CSP_NONCE_PLACEHOLDER.length`.

Items 1–5 remove **five of the seven** platform/config files both forks had to touch. The propagation mechanism's whole job gets easier in proportion.

### Step 1 — Adopt the mechanism in **iris** first (~2–3 days)

iris is the easier fork: 65% identical, forked *after* template HEAD, so `baseRef = 199954f` is exact.

```bash
cd /home/user/iris-insights-crm
git remote add template https://github.com/hbmartin/…   # cherry-pick channel only
# hand-write .template-sync.json from the §3.1 sketch; the `owned` and
# `divergences` lists are derivable mechanically:
pnpm dlx @startui/repo-tools template-sync init --template ../start-ui… --base 199954f
#   → proposes `owned` for every file iris modified, `divergences` for every file
#     iris modified where the template comment/behaviour disagrees, and
#     `droppedPresets: ["book","genre","cosmos","upload"]` from the 53 deleted module files
pnpm template:sync --dry-run
```

Expected first-sync surface, from the measured numbers: 173 modified + 189 deleted files, of which the deletions are all `droppedPresets` (book/genre = 53, cosmos fixtures = 42, upload = 5, plus `tests/` fallout) and the modifications resolve into `owned` (theme, branding, routes, composition) plus ~4 real divergences. Realistic reviewable diff: **10–20 files.**

Also in this step, clean iris's tree: `_tmp_15180_c07afed440b3242d9e7e1720a174b382`, `_tmp_19237_…` (both zero-byte, both tracked since `af6ae45`) and the two `compass_artifact_wf-*.md` files. Add a `check:tree-hygiene` to the template that fails on tracked `_tmp_*` and zero-byte files — this is precisely the class of thing that a "first commit" copy propagates and a sync never cleans.

### Step 2 — **hume-demo** (~1 week)

Harder: 37% identical, and it deleted the entire module stack. Its manifest is mostly `droppedPresets`:

```jsonc
"droppedPresets": ["book","genre","auth","user","account","email","drizzle","upload"],
"tracked": ["src/platform/**","src/modules/kernel/**","scripts/**",".github/**",".claude/**",
            "AGENTS.md","TESTING.md",".dependency-cruiser.cjs",".semgrep.yml","sheriff.config.ts"],
```

With `auth`+`user`+`account`+`email`+`drizzle` dropped, 199 module files and 16 drizzle files leave the sync surface entirely, and hume's tracked surface collapses to `src/platform` (192 identical / 49 modified / 3 deleted) + kernel (24/10/23) + scripts + `.github`. hume's `baseRef` is inexact (forked 2026‑07‑16, two template commits later); set it to `199954f` and accept that the first sync will show `0109c33`'s book-transition refactor as a no-op against a repo with no book module.

**hume also has the largest upstreaming backlog** — its `.dependency-cruiser.cjs` additions, `oxlint.config.ts` migration, `scripts/check-node-version.mjs`, `scripts/lib/repository-ast.ts`, `installTelemetryShutdownFlush`, the `tests/setup.browser.ts` scrollbar-gutter fix, the `field-otp` prop-ordering fix. Do the upstream cherry-picks **before** the first hume sync, so the sync doesn't propose overwriting hume's own fixes with the template's older versions.

### Step 3 — Future forks (~0)

`pnpm template:sync init` writes `.template-sync.json` with `baseRef` = the ref they cloned. `pnpm template:remove-preset auth user account email drizzle` does mechanically what hume did by hand — which requires first fixing the entanglement the corpus documents (`kernel/domain/ids.ts` branded IDs, `auth/domain/permissions.ts` rows, `drizzle/seed/index.ts:9,30`, `src/app/shell/presentation/app/main-nav-config.ts:21,24`).

---

## 7. Versioning and CHANGELOG policy

The template is `"version": "4.0.0"` and has **zero git tags** (`git tag` → empty). Without tags there is no `baseRef` a human can name and no `--to` a fork can request. First action: tag `199954f` as `v4.0.0`.

### Policy

**SemVer, redefined for a template** (this needs stating explicitly because "breaking" means something different when the artifact is a tree, not an API):

| bump | meaning | examples from the corpus |
|---|---|---|
| **major** | A sync will not apply cleanly to a conforming fork without human decisions, or a fork must run a codemod, or a security default becomes stricter. | `unwrapApplicationResult()` gains a required `logger`. `check-risk-register.mjs` becomes fail-on-expired. Demo domain extracted to an `examples/` branch. |
| **minor** | New capability, new preset, new guardrail rule, new script. Applies cleanly; may newly *fail* a fork's `pnpm check` because a rule now catches existing code. | Add `forceFlush?()` to `TelemetryAdapter`. Add `scripts/check-node-version.mjs`. Add `template-sync.yml`. |
| **patch** | Bug fix, dependency floor, doc correction. Applies cleanly and does not newly fail anything. | `isProd()` staging fix. `browser-mutation-protection.ts` `'/api/upload'` removal. `field-otp` prop ordering. |

Two extra rules specific to this repo:

- **A guardrail rule that newly fails existing code is minor, never patch** — the fork needs a scheduled window, not a Monday-morning PR. `.template-sync.json` should let a fork pin `maxBump: "minor"` so the Action doesn't propose majors unattended.
- **Security floors in `pnpm-workspace.yaml` ship as patch and are backported** to the previous major. Both forks independently discovered stale exact pins (`body-parser: 1.20.4` → `^1.20.6`, plus `brace-expansion`, `fast-uri`, `launch-editor`, `postcss`, `js-yaml@4`, `esbuild@0.28`, and iris additionally `protobufjs@7`, `socket.io-parser`). A fork should be able to take a security release without taking a feature release.

### `CHANGELOG.md` format

Keep-a-Changelog, with two template-specific sections that the sync tool parses:

```markdown
## [4.1.0] — 2026-08-14

### Breaking
_none_

### Added
- `src/platform/telemetry/console.ts` — `createConsoleTelemetry()` fallback for
  deploys with no OTel collector. Selected in composition when no OpenTelemetry
  adapter is present. (#118)
- `scripts/check-node-version.mjs`, wired into `check` and `check:ci`. (#121)

### Fixed
- `src/platform/env/config.ts` — `isProd()` now matches
  `isProdRuntimeEnvironment` semantics; `NODE_ENV=staging` on a production build
  no longer silently drops HTTPS enforcement on `VITE_BASE_URL`,
  `VITE_SENTRY_DSN`, and `VITE_S3_BUCKET_PUBLIC_URL`. (#119)
- `src/platform/http/browser-mutation-protection.ts` — removed the demo
  `'/api/upload'` entry; the protected-path list is now supplied by the app. (#120)
- `src/modules/kernel/infrastructure/config/telemetry.ts:84-87` — no longer
  throws when `OTEL_COLLECTOR_URL` is unset in production. Removes the
  `.github/workflows/code-quality.yml:362` placeholder that existed only to
  satisfy it. (#118)

### Fork impact                                   ← parsed by template:sync
| path | class | note |
|---|---|---|
| `src/platform/telemetry/index.ts` | additive-barrel | conflicts if your fork added exports; keep both |
| `src/platform/http/browser-mutation-protection.ts` | signature | now takes `protectedPathnames`; pass yours from `src/start.ts` |
| `src/platform/env/config.ts` | clean | |

### Upstreamed from
- hume-demo `fda0509` (shutdown flush), `7522ddc` (scrollbar gutter)
- iris `6a943d9` (runtime env precedence)
```

The **Fork impact** table is the load-bearing addition. `pnpm template:sync` reads it to classify each file in its report (§3.2) instead of guessing from the diff, and the `Upstreamed from` section is what keeps the return channel from silently dying.

### `UPGRADING.md` format

One `##` section per **major**, plus a `##` per minor that has any manual step. The format is a numbered list of *commands*, not prose — the primary reader is an agent running `pnpm template:sync` and then following instructions.

```markdown
# Upgrading

Run `pnpm template:sync --to vX.Y.Z`, then follow the section below for every
version between your `.template-sync.json` `template.baseVersion` and the target.
After each section: `pnpm format:changed && pnpm check && pnpm test:affected`.

---

## 4.0.0 → 5.0.0

### 1. `unwrapApplicationResult` requires a logger  *(breaking)*

`src/modules/kernel/transport/tanstack/result-mapper.ts` now logs before
flattening an `AppError` into a `ServerFnError` — previously a repository or
gateway failure reached the client as a 500 with no server-side record.

```bash
pnpm dlx jscodeshift -t codemods/0002-result-mapper-logger.cjs src/
```

The codemod inserts `getServices().kernel.logger` as the third argument at every
`unwrapApplicationResult(` call site. Review its output where your fork calls it
from a non-composition context; those need a logger threaded through by hand.

**Verify:** `pnpm vitest run --project=unit -t "reportApplicationError"`

### 2. `rate_limit` now maps to HTTP 429  *(breaking for clients)*

`result-mapper.ts:25` changes `rate_limit: 'BAD_REQUEST'` to
`'TOO_MANY_REQUESTS'`, and `server-fn-error.ts` gains the code with status 429.

**Action:** if any client code branches on a 400 to detect throttling, update it.
Search: `grep -rn "BAD_REQUEST" src/ | grep -i rate`

**No action** if your fork never returns a `rate_limit` AppError
(`grep -rn "category: 'rate_limit'" src/`).

### 3. Query keys for list/entity scoped queries change shape  *(breaking cache)*

`src/platform/lib/tanstack-query/scoped-query-options.ts` inserts `'list'` and
`'entity'` discriminators. Persisted query caches are invalidated once on deploy.

**No code action.** Note it in your release notes.

### 4. Demo domain moved to the `examples/` branch  *(no action if already removed)*

If `ls src/modules/book` exists in your fork, run `pnpm template:remove-preset book genre`
before syncing, or add `"droppedPresets": ["book","genre"]` to `.template-sync.json`.
```

Rules for the file: every step has a **verify** command; every step states its **no-action** condition (so a fork can skip fast); a step that a codemod can do must ship the codemod under `codemods/NNNN-*.cjs`.

---

## 8. Sequencing and effort

| # | Work | Effort | Depends on | Why here |
|---|---|---|---|---|
| 1 | Tag `199954f` as `v4.0.0`; add `CHANGELOG.md`, `UPGRADING.md`, `codemods/` | 0.5 d | — | Nothing can reference a base ref that doesn't exist |
| 2 | Template step-0 fixes (§6): generic depcruise/sheriff regexes, derived semgrep alternations, `'/api/upload'`, `use-app-form` registry, `security-headers` params, risk-register expiry, `APP_SLUG` | 5 d | — | Removes 5 of 7 both-fork divergences *before* they become permanent manifest entries |
| 3 | `scripts/template-sync.mjs` + `.template-sync.json` schema + `template-sync init` | 4 d | 1 | The mechanism. Reuses `scripts/lib/git-utils.mjs`. |
| 4 | `.github/workflows/template-sync.yml` | 0.5 d | 3 | Delivery |
| 5 | Configure `template` remote in both forks; upstream hume's depcruise rules + iris's `env/config.ts` fix as template PRs | 2 d | 1 | Do **before** first sync so sync doesn't propose regressing them |
| 6 | iris: `.template-sync.json`, first `--dry-run`, first real sync, tree hygiene (`_tmp_*`, `compass_artifact*`) | 3 d | 3, 5 | Easier fork; proves the mechanism |
| 7 | `pnpm template:remove-preset <name>` + untangling kernel IDs / auth permissions / seed / nav so presets are actually removable | 5 d | 2 | Blocked on the demo-entanglement work; makes hume's manifest honest |
| 8 | hume: `.template-sync.json`, first sync | 5 d | 3, 5, 7 | Hardest fork |
| 9 | `@startui/repo-tools` (scripts + Stryker factory); delete 17 root Stryker files + `knip.jsonc:5-8` | 4 d | 6, 8 | Only worth doing once sync exists to distribute the removal |
| 10 | `@startui/guardrails` for semgrep + Stryker only (keep depcruise/sheriff vendored) | 4 d | 9 | Optional; see §5 |
| 11 | `--audit` in `pnpm check`; `check:tree-hygiene` | 1 d | 3 | Makes divergence drift a hard signal |

**Total to a working mechanism with both forks migrated: ~20 working days.** Steps 1–6 (~13 d) deliver the whole value for iris; steps 9–10 are optimization.

---

## 9. Decisions I want the repo owner to make

1. **Publish to npm, or use a pnpm workspace / git dependency for tiers A–B?**
   The template is `"private": true` with `author` still `Ivan Dalmet` and `bugs` pointing at `hbmartin/start-ui-web`. **My recommendation: git dependency first** (`"@startui/repo-tools": "github:hbmartin/start-ui-…#v4.1.0"`), because it avoids the naming/ownership question entirely and `pnpm-workspace.yaml` already sets `minimumReleaseAge: 1440`, which npm publishing would interact with awkwardly. Move to npm only if a third fork appears.

2. **Does the demo domain stay in `main`, move to an `examples/` branch, or become a preset?**
   This changes the sync design materially. If it stays, every fork carries `droppedPresets: ["book","genre"]` forever and the 3,749 `book|genre` occurrences across 178 files keep leaking into `kernel/domain/ids.ts`, `auth/domain/permissions.ts`, `drizzle/seed/index.ts:9,30`, and `src/app/shell/…/main-nav-config.ts:21,24`. **My recommendation: `examples/start-ui-demo` branch.** Both forks deleted it (iris in a single 190-file / 9,695-deletion commit `8d2b7b4`), so keeping it in `main` is 100% dead weight for 100% of observed forks.

3. **Tier B for `.dependency-cruiser.cjs` and `sheriff.config.ts`: package or vendored?**
   This is the one place where propagation and agent-readability genuinely conflict (§5). **My recommendation: vendored.** Generic regexes get 90% of the benefit at 0% of the readability cost, and `sheriff.config.ts` was already byte-identical in hume without any packaging.

4. **`maxBump` default for the sync Action: `patch`, `minor`, or unlimited?**
   **My recommendation: `minor`.** A major should always be a human-initiated `workflow_dispatch`, because `UPGRADING.md` steps require judgement (e.g. the `unwrapApplicationResult` logger threading).

5. **Should the template *own* `.claude/rules/**` under sync, given iris deleted them?**
   iris removed all four files and folded the content into `CLAUDE.md`; hume kept them and added its own `CLAUDE.md` too. **My recommendation: ship a root `CLAUDE.md` in the template** (both forks invented one independently — the strongest both-apps signal for a missing artifact), keep `.claude/rules/**` as *tracked*, and let iris list them under `owned` if it wants to stay consolidated. Do not force the shape.

6. **Do forks get `--audit` in `pnpm check`?**
   It makes an unreviewed divergence fail the local gate. Given the risk-register precedent — `node scripts/check-risk-register.mjs` exits 1 today on a clean template clone because every row expired 2026‑07‑23 — a time-based hard failure is a demonstrated foot-gun in this repo. **My recommendation: `--audit` warns on an expired `review` date and fails only when the template has actually changed a divergent file.**

---

## 10. Confidence and gaps

**High confidence:** the zero-shared-commits finding (measured three ways), all divergence tables (blob-hash comparison of every tracked file), the guardrail-config identity percentages, the seven both-modified platform files and the seven both-modified kernel files, the three `@/app/i18n` imports in `src/platform`, the absence of tags/`CHANGELOG.md`/`UPGRADING.md`, iris's missing `.claude/` directory, the tracked `_tmp_*` files.

**Medium confidence:** hume-demo's exact fork point. Its `baseRef` is bounded to the window before `0109c33` (2026‑07‑18) but not pinned; the two template commits in that window touched book transitions, so the practical error is near zero, but a `--dry-run` will confirm before anyone commits to it.

**Low confidence / not verified:** whether `peter-evans/create-pull-request` or the reusable-workflow pattern is permitted under this org's Actions policy — the corpus documents that hume had to strip `security-events: write` from OSV/CodeQL and delete `dependency-review.yml` for private-repo/GHAS reasons (`e181825`, `e53f58d`), so the `template-sync.yml` sketch's `permissions: { contents: write, pull-requests: write }` may need the same treatment. I could not run `pnpm` anywhere (no `node_modules` in any of the three repos), so no effort estimate here is validated by executing the tooling — they are read-and-measure estimates.
