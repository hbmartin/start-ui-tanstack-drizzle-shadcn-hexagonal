<!-- Appendix B of the template improvement audit. See ./REPORT.md for the synthesis. -->

# Track: Making the Template Forkable
## Demo-domain removal, renaming, and module scaffolding

---

## 0. What I verified on disk (and where I correct the corpus)

Everything below was re-read in the three checkouts today. Five things I found that are not in the evidence corpus, and three corrections to the brief's premises:

**New evidence — 1: hume-demo never forked-and-deleted. It re-implemented from scratch.**

```
$ cd /home/user/hume-demo && git log --oneline --reverse | head -3
845552c first commit          # 213 files, no src/modules at all
2978d6c initial implementation # 360 files, 23,553 insertions(+), 0 deletions
$ git ls-tree --name-only 2978d6c src/modules/
src/modules/conversation-practice
src/modules/kernel
```

`2978d6c` is a pure-addition commit. There is no commit in hume-demo's history that deletes `src/modules/book`, because book was never there. The author hand-copied the platform/kernel/infrastructure out of the template into an empty repo rather than forking it and removing the demo. **That is the single strongest forkability datum available**: given a fork-and-strip versus copy-what-I-want choice, one of the two real consumers chose transcription over deletion.

And it still failed. The 6 files that came along as collateral:

```
$ git show --stat 2978d6c | grep -iE 'book|genre'
 .../icons/generated/icon-book-open-duotone.tsx     |  22 +
 .../icons/generated/icon-book-open-fill.tsx        |  18 +
 .../components/icons/generated/icon-book-open.tsx  |  18 +
 .../icons/svg-sources/icon-book-open-duotone.svg   |   1 +
 .../icons/svg-sources/icon-book-open-fill.svg      |   1 +
 .../icons/svg-sources/icon-book-open.svg           |   1 +
```

plus the book/genre branded IDs in `src/modules/kernel/domain/ids.ts`, `parseRouteBookId` in `src/routes/-route-params.ts`, and the book/genre allowlists in `.dependency-cruiser.cjs`, `sheriff.config.ts`, and `.semgrep.yml`, all still present at HEAD 123 commits later.

**New evidence — 2: BOTH apps independently converged on the same minimal module shape.** The corpus cites only iris's `launch-workspace`. hume's `learning-portal` is byte-identical in shape:

| repo | module | gates | layers |
|---|---|---|---|
| iris | `launch-workspace` | `index.ts presentation.ts testing.ts` | `domain presentation` |
| hume | `learning-portal` | `index.ts presentation.ts testing.ts` | `domain presentation` |

Two teams, two weeks apart, produced the identical 3-gate/2-layer module. Neither has `factory.ts`, `client.ts`, `server.ts`, `application/`, `infrastructure/`, `transport/`, a `src/composition/<name>.ts`, or an i18n namespace. This is a both-apps signal and it settles the tiering question in §7.

hume additionally produced a *third* shape — `site-access`: `backend.ts index.ts presentation.ts server.ts testing.ts` over all five layers, with **no** `client.ts` and **no** `factory.ts`.

**New evidence — 3: the demo leaks into `src/platform` design tokens and the generated icon set**, which no corpus item mentions:

```
$ grep -n -i 'book' src/platform/styles/app.css
118:  --book-cover: var(--color-neutral-800);
…                                    # 9 tokens in :root, 9 again in the dark block
281:  --color-book-cover: var(--book-cover);
…
343:  html:active-view-transition-type(book-cover)::view-transition-old(root),
$ cat src/platform/components/icons/generated/index.ts | head -3
export { default as IconBookOpen } from './icon-book-open';
export { default as IconBookOpenDuotone } from './icon-book-open-duotone';
export { default as IconBookOpenFill } from './icon-book-open-fill';
```

iris's removal commit deleted 32 lines from `src/platform/styles/app.css` and 3 lines from the icon barrel. The demo domain has design tokens in the *technical substrate root that is not allowed to import modules*.

**New evidence — 4: the import graph is nearly clean; the registration graph is not.** Only 8 files outside `src/modules/{book,genre}` actually `import` from them:

```
$ grep -rn --include='*.ts' --include='*.tsx' "modules/book\|modules/genre\|@/composition/book\|@/composition/genre" src/ \
  | grep -v '^src/modules/book\|^src/modules/genre' | cut -d: -f1 | sort -u
src/composition/book-upload.ts
src/composition/book.ts
src/composition/genre.ts
src/modules/kernel/infrastructure/db/schema/index.ts
src/modules/kernel/infrastructure/db/schema/relations.ts
src/routes/api/upload.ts
src/routes/app/books/$id.index.tsx        (+ 5 more route files)
```

iris's `8d2b7b4` touched **190 files / 9,695 deletions**. The gap between 8 and 190 is entirely *non-import* coupling: string literals in i18n, the permission matrix, nav config, CSS tokens, icons, seeds, migrations, guardrail regexes, Stryker configs, package.json scripts, and tests that used `book` as the generic fixture. **This is the design thesis for the whole track: the mechanism you need is not an import-graph tool, it is a registration-graph tool.**

**Correction to the brief — docker needs no renaming.** `docker-compose.yml` contains no brand string; it reads `$DOCKER_DATABASE_NAME` / `$DOCKER_DATABASE_USERNAME` / `$DOCKER_DATABASE_PASSWORD`. The `startui` literals live only in `.env.example:7-9` and `.env.example:32-33`. One file.

**Correction to the brief — sonar props need no renaming.** `.sonarcloud.properties` is 4 lines and contains only `sonar.exclusions=`. There is no `sonar.projectKey` or `sonar.organization` to rename.

**Correction to the brief — the CodeQL qlpack rename is bigger than "a name field".** Full surface enumerated in §6.

---

## 1. The startup tax, quantified

Two costs a forker pays before writing a line of their own product:

### 1a. Removing the demo

| Category | Files | Fails how if you miss it |
|---|---|---|
| `src/modules/{book,genre}/**` | 34 | Loudly (typecheck) |
| `src/composition/{book,book-upload,genre}.ts` + 5 edit sites in `index.ts` | 4 | Loudly |
| `src/routes/{app,manager}/books/**` + `api/upload.ts` + `-route-params.ts` | 8 | Loudly |
| `src/modules/kernel/domain/ids.ts` (9 declarations), `kernel/backend.ts:18`, `db/schema/{index,relations}.ts` | 4 | Loudly |
| `src/modules/auth/domain/permissions.ts` (4 sites) | 1 | Loudly (`satisfies Record<UserRole, Permission>`) |
| `src/app/i18n/{ar,en,fr,sw}/{book,genre}.json` + 4 barrels + 4 `layout.json` | 16 | Loudly |
| `src/app/shell/presentation/{app/main-nav-config.ts,manager/nav-sidebar.tsx}` | 2 | Loudly |
| `drizzle/seed/{book.ts,book-data.json,index.ts}` | 3 | **Silently** — `pnpm db:init` just breaks at runtime |
| `drizzle/migrations/` — baseline `0000` creates author/book/publisher/genre; policy says immutable | — | **Requires a new DROP migration** (iris wrote `0005_drop_book_and_genre.sql`) |
| `src/platform/styles/app.css` (32 lines), `icons/generated/` (3 exports + 6 files) | 8 | **Silently** — dead CSS and dead icons forever |
| `.dependency-cruiser.cjs:60,61,78,79,162,163`; `sheriff.config.ts:44,47`; `.semgrep.yml:498,1426,1435,1446`; `scripts/check-migration-edits.mjs:7,10`; `.github/workflows/mutation-testing.yml:21` | 5 | **Silently** — rules match zero files, guardrails evaporate |
| `stryker.{book,genre}.config.mjs`, `tsconfig.stryker.{book,genre}.json`, 8 package.json scripts + 8 aggregate edits | 5 | **Silently** |
| `tests/**` — book was the generic fixture across platform, kernel, auth, e2e | ~90 | Loudly, but requires **repointing, not deleting** |

### 1b. Adding one new module

For a hypothetical full-stack module `widget`, the registrations required:

| # | Location | Edit sites | Failure mode if skipped |
|---|---|---|---|
| 1 | `src/modules/widget/**` | 18 files (matching `genre`) | — |
| 2 | `src/composition/widget.ts` | new file | — |
| 3 | `src/composition/index.ts` | **5** (export block, import line, `ServicesOverrides`, both `getServices` branches) | Loud |
| 4 | `src/modules/kernel/infrastructure/db/schema/index.ts` | 3 (`export *`, `import {}`, `$inferSelect/$inferInsert`) | Loud |
| 5 | `src/modules/kernel/infrastructure/db/schema/relations.ts` | 1–2 | Loud |
| 6 | `src/modules/kernel/domain/ids.ts` | 3 (schema, type, parser) | Loud |
| 7 | `src/modules/auth/domain/permissions.ts` | 3 (`permissionStatements` + both role rows) | Loud |
| 8 | `src/app/i18n/{ar,en,fr,sw}/widget.json` + 4 barrels × 2 | **4 new + 8 edits** | Loud |
| 9 | `.dependency-cruiser.cjs:60,61,78,79,162,163` | 6 | **SILENT** |
| 10 | `sheriff.config.ts:44,47` | 2 | **SILENT** (and Sheriff never runs anyway) |
| 11 | `.semgrep.yml:1426`, `:1446`, `:1433-1437`, `:498` | 3–4 | **SILENT** |
| 12 | `scripts/check-migration-edits.mjs:4-11` | 1 | **SILENT** |
| 13 | `stryker.widget.config.mjs` + `tsconfig.stryker.widget.json` | 2 new | **SILENT** |
| 14 | `package.json:83-90` aggregates + `:99-106`-style entries | **4 new + 4 edits** | **SILENT** |
| 15 | `.github/workflows/mutation-testing.yml:21` | 1 | **SILENT** |
| 16 | `tests/architecture/modular-monolith.unit.spec.ts:426,439,454` | 3 | **SILENT** |

**≈14 config files, ≈45 edit sites, and 9 of the 16 categories fail silently.** That asymmetry drives the whole design: the loud half is self-correcting (typecheck), the silent half is where guardrails quietly stop applying — exactly what happened to hume, whose `.dependency-cruiser.cjs` today contains three rules matching zero files.

---

## 2. Tooling decision: custom `tsx` scripts. Not hygen, plop, or turbo-gen.

**Recommendation: custom TypeScript scripts under `scripts/`, executed with `tsx`, zero new dependencies.**

The justification is not taste, it is that the template already does exactly this and the generic generators cannot do the job:

1. **The precedent is already in the repo.** `package.json:53-54`:
   ```json
   "architecture:graph": "tsx scripts/generate-module-dependency-graph.ts",
   "architecture:graph:check": "tsx scripts/generate-module-dependency-graph.ts --check",
   ```
   `tsx@^4.22.4` (`package.json:277`) and `jiti@2.7.0` (`:266`) with the `run-jiti.js` alias shim are already devDependencies. `scripts/` already holds 13 scripts, 3 of them TS, with a shared `scripts/lib/git-utils.mjs`. A new script costs zero install surface.

2. **≈70% of this work is not file emission, it is *surgical edits to existing files*.** Hygen and plop are template-file renderers; their edit story is `inject: before/after: <regex>` against a text file. The edits needed here are:
   - insert an alphabetically-sorted `export {…} from './widget';` block into `src/composition/index.ts`, plus a key in a TS type literal, plus two object literals inside `getServices`;
   - insert an `import x from './widget.json' with { type: 'json' }` line and an object key into four `src/app/i18n/*/index.ts` barrels;
   - add a name to a 27-alternative regex inside a YAML scalar in `.semgrep.yml:1426`.

   Regex injection into TypeScript is how you get a generator that silently produces unsorted imports that `oxfmt` then reformats and `lint` then flags. A TS script can parse with the Oxc parser (hume already added `scripts/lib/repository-ast.ts` for exactly this class of job) or, more cheaply and adequately, do sorted-insert with a tiny structural helper and then run `pnpm format:changed` on the touched set.

3. **turbo-gen requires Turborepo.** This is not a monorepo; `pnpm-workspace.yaml` exists only to carry security `overrides`. Adopting Turborepo to get a generator is absurd.

4. **The remove-module direction has no generator analogue at all.** No scaffolding tool removes a module. `scaffold:remove-module` must be custom regardless, and having generate/remove share one `scripts/lib/module-registry.ts` is what makes them stay inverse of each other.

5. **Dogfooding.** A `.ts` generator is typechecked by `pnpm typecheck` and unit-testable by the repo's own Vitest `unit` project. `.hbs`/`.ejs` templates are not. The template can and should ship `tests/unit/scripts/scaffold-module.unit.spec.ts` asserting that generate-then-remove is a git no-op — the strongest possible regression test for this feature. hume has a precedent for testing tooling: `tests/unit/scripts/node-tooling.unit.spec.ts`.

**Template file format:** plain `.ts.tmpl` files under `scripts/templates/module/` with `__MODULE__` / `__Module__` / `__MODULES__` token substitution. Not Handlebars — three casings and no conditionals is not worth a template engine, and `.ts.tmpl` files stay greppable.

---

## 3. Prerequisite: de-hardcode before you generate

**This is the most important recommendation in the track.** A generator that writes `widget` into six allowlists in `.dependency-cruiser.cjs` is a bug factory: it makes the config *look* maintained while the failure mode (a forker who hand-adds a module, or who renames one) is unchanged, and it doubles the work of `scaffold:remove-module`.

Every registration in §1b rows 9–16 should be **deleted, not generated**. Concretely:

```js
// .dependency-cruiser.cjs — BEFORE (lines 57-62, 75-79, 159-164)
{ name: 'domain-no-presentation', severity: 'error',
  from: { path: '^src/modules/(book|user|genre|account)/domain' },
  to:   { path: '^src/modules/(book|user|genre|account)/presentation' } },

// AFTER — the backreference style the file already uses at 'no-cross-feature-deep-import'
{ name: 'domain-no-presentation', severity: 'error',
  from: { path: '^src/modules/([^/]+)/domain' },
  to:   { path: '^src/modules/$1/presentation' } },
```

`infrastructure-no-presentation` (`.dependency-cruiser.cjs:159-164`) should be **deleted outright** — I confirmed `infrastructure-no-feature-presentation-or-transport` at `:165-173` is generic (`^src/modules/(?!kernel/)[^/]+/infrastructure` → `.../(presentation|transport)`) and strictly subsumes it. Also delete the `pathNot: '^src/modules/book/server\\.ts$'` waiver at `:210` — `src/modules/book/server.ts` is one line (`export * from './transport/server-functions/server-functions';`), identical to `src/modules/account/server.ts`, which carries no waiver.

```ts
// sheriff.config.ts:41-50 — BEFORE
const infrastructureTarget: RuleMatcher = ({ fromModulePath, toModulePath }) =>
  isModuleInternalTargetPath(toModulePath) &&
  !( /\/src\/modules\/(?:account|book|genre|user)\/infrastructure(?:\/|$)/.test(fromModulePath) &&
     /\/src\/modules\/(?:account|book|genre|user)\/presentation(?:\/|$)/.test(toModulePath) );
// AFTER — matches the generic style of its own siblings at :29-39
     !( /\/src\/modules\/[^/]+\/infrastructure(?:\/|$)/.test(fromModulePath) && …
```

```js
// scripts/check-migration-edits.mjs:3-11 — BEFORE: 6 literal paths
// AFTER:
import { globSync } from 'node:fs';
const SCHEMA_PATHS = [
  'src/modules/kernel/infrastructure/db/schema.ts',
  'src/modules/kernel/infrastructure/db/schema',
  ...globSync('src/modules/*/infrastructure/drizzle/schema.ts'),
];
```

```yaml
# .github/workflows/mutation-testing.yml:21 — BEFORE
        scope: [auth, kernel, user, book, shared]
# AFTER: a `discover` job emitting fromJSON(needs.discover.outputs.scopes),
#        computed as fs.readdirSync('src/modules') plus 'shared'
```

**Stryker: collapse 17 root files and 40 scripts into 1 + 3.** `stryker.shared.config.mjs:6-11` already exports `createScopedStrykerConfig({ moduleName, mutationSourceFiles, mutationTestFiles, tsconfigFile })` and the nine wrappers re-supply three arguments derivable from the first. Replace with:

```js
// stryker.module.config.mjs  (replaces stryker.{account,auth,book,genre,kernel,
//   runtime-config,shared-only,user}.config.mjs and 8 tsconfig.stryker.*.json)
import { createScopedStrykerConfig } from './stryker.shared.config.mjs';
const moduleName = process.env.STRYKER_MODULE;
if (!moduleName) throw new Error('STRYKER_MODULE is required.');
export default createScopedStrykerConfig({
  moduleName,
  mutationTestFiles: [
    `tests/unit/modules/${moduleName}/domain/**/*.unit.spec.ts`,
    `tests/unit/modules/${moduleName}/application/**/*.unit.spec.ts`,
  ],
  mutationSourceFiles: [
    `src/modules/${moduleName}/domain/**/*.ts`,
    `src/modules/${moduleName}/application/**/*.ts`,
    '!**/*.spec.ts', '!**/*.test.ts', '!**/index.ts',
    `!src/modules/${moduleName}/application/ports/**/*.ts`, '!**/types.ts',
  ],
  tsconfigFile: 'tsconfig.stryker.module.json',   // include: src/modules/**/{domain,application}/**/*.ts
});
```
```json
"test:mutation:module": "stryker run stryker.module.config.mjs",
"test:mutation:module:fast": "cross-env STRYKER_FAST=1 stryker run stryker.module.config.mjs",
"test:mutation:module:dry": "stryker run stryker.module.config.mjs --dryRunOnly"
```
Called as `STRYKER_MODULE=widget pnpm test:mutation:module`. This deletes 16 root files, 36 package.json scripts, and the `knip.jsonc:5-8` workaround comment (`"Per-module Stryker configs do not match knip's default stryker.config.* pattern."`).

**Architecture tests:** replace the three literal arrays at `tests/architecture/modular-monolith.unit.spec.ts:426,439,454` with `fs.readdirSync('src/modules')` filtered by shape (a module has `application/ports/` ⇒ assert the full contract; a module has only `domain/` + `presentation/` ⇒ assert the minimal contract). Then add the one test that makes all of this self-policing:

```ts
// tests/architecture/guardrail-config-freshness.unit.spec.ts  (NEW)
const modules = new Set(fs.readdirSync(path.join(root, 'src/modules')));
const configs = [
  '.dependency-cruiser.cjs', 'sheriff.config.ts', '.semgrep.yml',
  '.github/workflows/mutation-testing.yml', 'scripts/check-migration-edits.mjs',
];
it('names no module that does not exist', () => {
  for (const file of configs) {
    const text = fs.readFileSync(path.join(root, file), 'utf8');
    for (const [, name] of text.matchAll(/src\/modules\/([a-z][a-z0-9-]*)\//g)) {
      if (name === 'kernel') continue;
      expect({ file, name, exists: modules.has(name) }).toMatchObject({ exists: true });
    }
  }
});
```

This single test would have failed in hume-demo on day one, and it is the mechanism that keeps every fork honest without any generator running. **If only one item from this whole track ships, ship this test plus the wildcard rewrites.**

After de-hardcoding, the generator's job shrinks from 14 config files to **4**: `src/composition/index.ts`, the four i18n barrels, `package.json` (only if the module is added to a mutation matrix), and the module's own files. That is a generator worth writing.

---

## 4. Track A — the demo domain

### Options considered

| Option | Verdict |
|---|---|
| **A1. `pnpm scaffold:eject-demo`** — keep the demo in `main`, remove it mechanically | **Recommended primary.** Preserves the demo's teaching value; the script *is* the executable spec of the coupling. |
| **A2. Move the demo to an `examples/` branch or dir** | Rejected as primary. An `examples/book/` directory cannot hold the coupling that matters — the kernel branded IDs, the permission rows, the `--book-cover-*` CSS tokens, the i18n barrel entries, the `0000` migration. Moving the files without moving the wiring produces a demo that does not run, which is worse than no demo. |
| **A3. `create-*` CLI (`pnpm create hbmartin-start-ui`)** | Rejected for now, revisit later. Requires a published npm package and a release pipeline the fork does not have; and the fork's first command today (`README.md:26`) already wrongly points at upstream BearStudio's `pnpm create start-ui`. Fixing the README to say `degit hbmartin/start-ui-web` is the honest 5-minute version. |
| **A4. Document a manual checklist** | Rejected. This is what exists now (nothing), and iris's 190-file commit plus hume's decision to re-transcribe the repo is the measured outcome. |

### Recommendation: A1 with a hard prerequisite — decouple first, then script

Six decouplings turn a 190-file surgery into a mechanical deletion. Each is independently valuable even for a forker who keeps the demo:

**A1.1 — Move branded IDs out of the shared kernel.**
`src/modules/kernel/domain/ids.ts` currently declares `zBookIdSchema`, `zGenreIdSchema`, `zBookCoverObjectKeySchema`, `BookId`, `GenreId`, `BookCoverObjectKey`, `toBookId`, `toGenreId`, `toBookCoverObjectKey`. The kernel is the module every fork keeps; the demo's IDs should live in `src/modules/book/domain/ids.ts` and `src/modules/genre/domain/ids.ts`, built from a kernel-exported `zBrandedId<'BookId'>()` helper. This is the single change that most reduces demo entanglement, and it is why hume still carries dead `parseRouteBookId` at `src/routes/-route-params.ts:15-19`.

**A1.2 — Make the Drizzle schema barrel discover modules.**
`src/modules/kernel/infrastructure/db/schema/index.ts:1-42` hand-lists four modules' schemas plus 20 `$inferSelect`/`$inferInsert` type aliases. Replace with per-module re-export and let each module own its row types (`export type Genre = typeof genre.$inferSelect` in `src/modules/genre/infrastructure/drizzle/schema.ts`). `relations.ts` genuinely needs cross-module knowledge (`bookRelations` joins `book` to `genre`) — the honest fix is that relations spanning modules belong to whichever module owns the FK, exported through a `drizzleRelations` name the kernel barrel re-exports.

**A1.3 — Make the permission matrix composable.**
`src/modules/auth/domain/permissions.ts:19-20,35-36,51-52` bake `book: ['read','create','update','delete']` and `genre: ['read']` into `permissionStatements` and both role rows. Split into `permissions-core.ts` (user, session, account, apps) and a `permissions-demo.ts` merged in `permissions.ts` — one import line to delete instead of six edits inside three object literals.

**A1.4 — `/api/upload` dispatches through a registry.**
`src/routes/api/upload.ts:3-6,16` imports `handleBookUploadRequest` from `@/composition/book-upload` as its only handler. Replace with an `UploadRoutes` registry assembled in composition, so the generic route survives demo removal.

**A1.5 — `drizzle/seed/index.ts` discovers seeders.**
Today `:9` `import { createBooks } from './book';` and `:31` `await createBooks();`. `pnpm db:init` (`package.json:148`) is a documented first-run command and it breaks the moment the book module is deleted. Replace with a glob over `drizzle/seed/*.seeder.ts` exporting a `seed()` function.

**A1.6 — Migrations: squash the baseline.**
`0000_marvelous_zzzax.sql` creates `author`, `book`, `publisher`, `genre`. Because `drizzle/migrations/**` is immutable by policy (`scripts/check-migration-edits.mjs` + `pnpm check:migrations` in `check` and `check:ci`), every fork must ship a `DROP TABLE` migration for tables it never wanted — which is precisely `/home/user/iris-insights-crm/drizzle/migrations/0005_drop_book_and_genre.sql`. Squash the five shipped migrations into one platform-only baseline (`auth`, `account`, `session`, `verification`, `email_status`, `user`), and give the demo its own **last** migration so `eject-demo` can delete the file rather than write an inverse of it. This is safe because the template is a starter: nobody has a deployed database at `0004`. **Owner decision — see §10.**

### The script

```
pnpm scaffold:eject-demo [--dry-run] [--keep-tests] [--yes]
```

`scripts/scaffold-eject-demo.ts`, run via `tsx`. Non-interactive with `--yes`; otherwise prints the plan and prompts once via `node:readline`.

What it does, in order (after A1.1–A1.6 land):

| Step | Action |
|---|---|
| 1 | Refuse to run if `git status --porcelain` is non-empty (reuses `scripts/lib/git-utils.mjs`) |
| 2 | `rm -rf src/modules/{book,genre} src/composition/{book,book-upload,genre}.ts src/routes/{app,manager}/books drizzle/seed/book*.ts drizzle/seed/book-data.json` |
| 3 | `rm -rf tests/**/{book,genre}` (unless `--keep-tests`), and **repoint** the ~30 platform/kernel/auth tests that use `book` as generic fixture onto `user` via an explicit rename map in `scripts/lib/demo-manifest.ts` — this is the only step that is not pure deletion, and it is why the map must be committed rather than inferred |
| 4 | Delete `src/app/i18n/*/book.json`, `*/genre.json`; call `removeI18nNamespace('book'\|'genre')` on the four barrels; strip `nav.books` from the four `layout.json` |
| 5 | Delete the demo migration file + its `meta/*_snapshot.json` + its `_journal.json` entry (post-A1.6) |
| 6 | Delete `stryker.{book,genre}.config.mjs` + tsconfigs (moot post-§3 collapse) |
| 7 | Delete `--book-cover-*` blocks from `src/platform/styles/app.css` and the three `IconBookOpen*` exports + 6 files; regenerate via `pnpm gen:icons` |
| 8 | Delete `src/routes/app/books`-derived entries by running `pnpm dev` once, or simply `rm src/routeTree.gen.ts` and let TanStack regenerate |
| 9 | Rewrite `README.md` "Demo domain" section to a "your first module" pointer |
| 10 | Run `pnpm format:changed`, then print the exact verification command: `pnpm check && pnpm test` |

`--dry-run` prints the same plan and touches nothing; this matches the existing `pnpm hume:sync --dry-run` idiom the apps already use.

**What breaks and what replaces it, explicitly:**

| Deleted | Breaks | Replacement |
|---|---|---|
| `handleBookUploadRequest` | `/api/upload` has no handler | The A1.4 registry; route survives with zero registered uploaders and returns 404 |
| `createBooks()` seeder | `pnpm db:init` | A1.5 discovery; seeds only users |
| `book`/`genre` permission rows | `rolePermissions satisfies Record<UserRole, Permission>` | A1.3 split; `permissions-demo.ts` deleted with the module |
| `tests/e2e/upload.spec.ts` (iris deleted it, 104 lines) | Upload has no E2E coverage | **Nothing.** This is a real loss and the honest answer is that the template needs a non-demo upload example — e.g. user avatar — or it should accept the loss and say so in `TESTING.md`. Flagged in §10. |
| `__visual_snapshots__/…/combobox-*` etc. | Nothing — these are platform components | Unaffected |

**Effort:** A1.1–A1.6 decoupling **≈3–4 days**. The script itself **≈1 day** once the decoupling is done. Attempting the script without the decoupling is a 190-line rename map that rots on the first refactor — do not do it.

---

## 5. Track B — renaming and branding

### Two mechanisms, not one

Half the branding is *data* that should never have been a literal, and half is *text* that legitimately needs rewriting. Ship both.

**B1 — One `APP_SLUG`, derived everywhere.** These five are load-bearing runtime identity, not cosmetics:

| File:line | Literal | Consequence of a naive sed |
|---|---|---|
| `src/modules/kernel/infrastructure/db/migrate.ts:24` | `const MIGRATION_LOCK_NAMESPACE = 'start-ui-web';` | Consumed at `:112-113` and `:128` in `pg_try_advisory_lock(hashtext($1), hashtext($2))`. Changing it while old and new code run concurrently **defeats the migration lock**. |
| `src/composition/telemetry/otel-adapter.ts:22-24` | `getTracer/getMeter/getLogger('start-ui-web')` | Silently starts a new metric series; existing dashboards go flat |
| `src/modules/kernel/infrastructure/config/telemetry.ts:120` | `OTEL_SERVICE_NAME ?? 'start-ui-web'` | Same |
| `src/platform/env/config.ts:97` | `VITE_OTEL_SERVICE_NAME … .prefault('start-ui-web')` | Same |
| `src/platform/http/csp-nonce.ts:1,5,13` | `'__START_UI_CSP_NONCE__'` (22 chars), `'__startUiCspNonceBridgeInstalled'` | **`tests/unit/platform/http/security-headers.unit.spec.ts:271-273` hardcodes `.slice(0,8)`, `.slice(8,19)`, `.slice(19)` against that exact length.** iris's rename produced an 18-char placeholder, making `.slice(19)` empty and silently reducing a three-chunk split to two — while the test still passed. |

Fix: a single `src/platform/app-identity.ts` exporting `APP_SLUG` (read from `package.json` `name` at build time via the existing `gen:build-info` path, or a plain constant), and derive all five from it. **Independently of any rename**, fix the test to compute its offsets from `CSP_NONCE_PLACEHOLDER.length` — that assertion is correct today only by coincidence.

**B2 — `pnpm scaffold:rename` for the text.**

```
pnpm scaffold:rename --slug my-app --name "My App" \
                     [--repo owner/repo] [--author "Name <email>"] \
                     [--skip-codeql] [--dry-run]
```

`scripts/scaffold-rename.ts`. Exact edit surface, enumerated from `grep -rilI 'start-ui\|startui\|START_UI\|bearstudio\|ivan-dalmet\|hbmartin' .` → **45 files**:

| Group | Files | Action |
|---|---|---|
| Package identity | `package.json:2,5,6,8,11-14` (`name`, `description`, `homepage`, `bugs.url`, `author`) | Replace; set `author` from `--author` or clear it. Currently `"name": "Ivan Dalmet"` against a `bugs.url` of `hbmartin/start-ui-web` — already inconsistent. |
| Docs | `README.md`, `AGENTS.md:1`, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `.github/SECURITY.md`, `LICENSE` | Slug/name replace. **Do not touch the MIT copyright line** without `--author`; flag it. |
| Env / docker | `.env.example:7-9` (`DOCKER_DATABASE_{NAME,USERNAME,PASSWORD}="startui"`), `:32-33` (`S3_ACCESS_KEY_ID="startui-access-key"`) | Replace. Note `src/modules/kernel/infrastructure/config/storage.ts:18-20` rejects those exact strings as placeholders in prod — the rejection set must be updated **or** (better) generalized to "any value matching the shipped `.env.example`". |
| Runtime identity | the 5 files in B1 | Handled by `APP_SLUG`; script only rewrites the one constant |
| Outbound links | `src/platform/components/ui/button.fixture.tsx:37` `href="https://start-ui.com/"`, `src/modules/email/presentation/components/email-footer.tsx:8` same | Replace with `--repo` URL or a placeholder; **the email footer ships in real transactional email**, so leaving it is a live branding leak |
| CI | `.github/workflows/{code-quality,e2e-tests}.yml` | Docker credentials / artifact names |
| **CodeQL** | see below | Behind `--skip-codeql`, default **on** |

**The CodeQL rename surface, concretely** (this is the part the brief flagged and it is bigger than a name field):

```
.github/codeql/start-ui-web-queries/                      # directory rename
.github/codeql/start-ui-web-queries/start-ui-web-codeql.qls  # file rename
  → content: "- description: start-ui-web custom JavaScript and TypeScript security queries"
.github/codeql/start-ui-web-queries/qlpack.yml
  → "name: start-ui-web/codeql-queries"                   # must stay <scope>/<name>
4 × queries/**/*.ql  →  "@id start-ui-web/react-dangerous-html-api"  etc.
3 × .github/codeql/codeql-{config,actions-config,local-extraction}.yml
  → "name:" field + 4 path references to the queries dir
package.json:58,59,60 → 3 scripts referencing the dir, the .qls, `start-ui-web-db`, `start-ui-web.sarif`
README.md:118-123
```

**The `@id` prefix is the decision point.** Renaming `@id start-ui-web/...` → `@id my-app/...` changes the rule IDs surfaced in GitHub's Security tab and invalidates any SARIF baseline (hume added `.github/codeql/codeql-baseline.json` + `scripts/check-codeql-sarif-baseline.mjs` in `e181825`/`698adc0`). **My recommendation: rename it.** A fork that keeps `start-ui-web/` rule IDs is confusing forever, and a fresh fork has no baseline to invalidate. But the script must print a loud warning if `.github/codeql/codeql-baseline.json` exists.

**What the script must NOT do:** rename `pnpm-lock.yaml` entries, edit `drizzle/migrations/**` (immutable), or touch `.secrets.baseline` (regenerate with `detect-secrets scan --baseline .secrets.baseline` instead — the script should print that command, not run it).

**Post-run verification, printed by the script:**
```
git diff --stat
pnpm format:changed && pnpm check
grep -rilI 'start-ui\|startui\|bearstudio\|ivan-dalmet' . --exclude-dir=node_modules --exclude=pnpm-lock.yaml
```
The last line should return only `drizzle/migrations/` (if pre-squash) and `LICENSE` (if `--author` was omitted). Ship an architecture test `tests/architecture/branding.unit.spec.ts` that asserts exactly that residue set, so a half-finished rename fails CI.

**Effort:** `APP_SLUG` extraction ≈ **half a day**. `scaffold-rename.ts` ≈ **1.5 days** (the CodeQL directory/file renames and the `.ql` `@id` rewrites are most of it). Branding test ≈ 1 hour.

---

## 6. Track C — the module generator and its inverse

### API

```
pnpm scaffold:module <name> [--tier minimal|standard|full] [--with-db] \
                            [--with-i18n] [--with-permissions] [--dry-run]
pnpm scaffold:remove-module <name> [--dry-run] [--force]
```

Both are `scripts/scaffold-module.ts` / `scripts/scaffold-remove-module.ts`, sharing `scripts/lib/module-registry.ts`.

### `scripts/lib/module-registry.ts` — the shared edit engine

This is the interesting file. It exposes one function per registration point, each with an `add` and a `remove` direction, so generate and remove cannot drift:

```ts
// scripts/lib/module-registry.ts
export type Registration = {
  id: string;                       // 'composition-index'
  file: string;                     // 'src/composition/index.ts'
  add: (source: string, m: ModuleNames) => string;
  remove: (source: string, m: ModuleNames) => string;
  appliesTo: (spec: ModuleSpec) => boolean;
};

export type ModuleNames = {
  kebab: string;      // 'launch-workspace'
  camel: string;      // 'launchWorkspace'
  pascal: string;     // 'LaunchWorkspace'
  constant: string;   // 'LAUNCH_WORKSPACE'
};

export const registrations: Registration[] = [
  compositionIndex,      // 5 sites in src/composition/index.ts
  i18nBarrels,           // 4 files × 2 sites in src/app/i18n/*/index.ts
  kernelSchemaBarrel,    // 3 sites, only when --with-db
  kernelRelations,       // 1 site, only when --with-db
  authPermissions,       // 3 sites, only when --with-permissions
  mutationScripts,       // package.json, only for tier=full
];
```

After §3's de-hardcoding, that is the **entire** list — six registrations, down from sixteen. `.dependency-cruiser.cjs`, `sheriff.config.ts`, `.semgrep.yml`, `check-migration-edits.mjs`, `mutation-testing.yml`, and the architecture tests no longer appear, because they no longer name modules.

The `compositionIndex` registration is the fiddliest; here is its real shape:

```ts
const compositionIndex: Registration = {
  id: 'composition-index',
  file: 'src/composition/index.ts',
  appliesTo: (spec) => spec.tier !== 'minimal',
  add: (src, m) => pipe(src,
    insertSortedExportBlock(
      `export {\n  __reset${m.pascal}Composition,\n  type ${m.pascal}Overrides,\n  get${m.pascal}UseCases,\n} from './${m.kebab}';`),
    insertSortedImportLine(
      `import { type ${m.pascal}Overrides, get${m.pascal}UseCases } from './${m.kebab}';`),
    insertTypeMember('ServicesOverrides',
      `  ${m.camel}?: Omit<${m.pascal}Overrides, 'kernel'>;`),
    insertObjectMember('getServices.singleton',
      `    ${m.camel}: get${m.pascal}UseCases(),`),
    insertObjectMember('getServices.overridden',
      `    ${m.camel}: get${m.pascal}UseCases({ ...overrides.${m.camel}, kernel }),`)),
  remove: /* exact inverse, each helper has a matching dropX */,
};
```

`insertSorted*` uses the Oxc parser (hume's `scripts/lib/repository-ast.ts` is the proven precedent) rather than regex; the object-member inserts are anchored on the `getServices` function's two `return {` nodes, not on a text landmark.

### Generator template tree

```
scripts/templates/module/
  _shared/
    index.ts.tmpl                     # export type * from './domain/__MODULE__';
    testing.ts.tmpl
  minimal/                            # 3 gates / 2 layers
    presentation.ts.tmpl
    domain/__MODULE__.ts.tmpl
    presentation/pages/page-__MODULE__.tsx.tmpl
    presentation/__MODULE__-store.ts.tmpl
  standard/                           # + application, transport, composition, client/server gates
    client.ts.tmpl
    server.ts.tmpl
    factory.ts.tmpl
    application/ports/__MODULE__-repository.ts.tmpl
    application/use-cases/types.ts.tmpl
    application/use-cases/list-__MODULES__.ts.tmpl
    transport/server-functions/server-functions.ts.tmpl
    presentation/queries.ts.tmpl
    presentation/wired-queries.ts.tmpl
    presentation/schema.ts.tmpl
    composition.ts.tmpl               # → src/composition/__MODULE__.ts
  full/                               # + infrastructure, backend gate, HTTP transport
    backend.ts.tmpl
    infrastructure/drizzle/schema.ts.tmpl
    infrastructure/drizzle/__MODULE__-repository-drizzle.ts.tmpl
    transport/http/__MODULE__-handlers.ts.tmpl
  tests/
    unit/domain/__MODULE__.unit.spec.ts.tmpl
    unit/application/__MODULE__-use-cases.unit.spec.ts.tmpl
```

Template content is a direct de-specialization of `src/modules/genre/**` — the smallest full module (18 files) and therefore the honest reference. Two sketches:

```ts
// scripts/templates/module/standard/application/use-cases/list-__MODULES__.ts.tmpl
// derived from src/modules/genre/application/use-cases/list-genres.ts
import { Result } from '@bloodyowl/boxed';

import type { UserId } from '@/modules/kernel/domain/ids';

import type { __Module__ListOutcome, __Module__Result, __Module__UseCaseDeps } from './types';
import { normalize__Module__SearchTerm } from '../../domain/__module__';

export type List__Modules__Input = {
  currentUserId: UserId;
  limit: number;
  searchTerm?: string;
};

export async function list__Modules__(
  deps: __Module__UseCaseDeps,
  input: List__Modules__Input
): Promise<__Module__Result<__Module__ListOutcome>> {
  const allowed = await deps.permissionChecker.hasPermission(input.currentUserId, {
    __module__: ['read'],
  });
  if (allowed.isError()) return Result.Error(allowed.getError());
  if (allowed.get().type === 'permission_denied') {
    return Result.Ok({ type: '__module___forbidden' });
  }

  deps.logger.info({ event: '__module__.list' });
  const limit = Math.min(Math.max(input.limit, 1), 100);
  const result = await deps.__module__Repository.list({
    limit,
    searchTerm: normalize__Module__SearchTerm(input.searchTerm),
  });
  if (result.isError()) return Result.Error(result.getError());
  return Result.Ok(result.get());
}
```

```ts
// scripts/templates/module/standard/composition.ts.tmpl
// derived from src/composition/genre.ts (26 lines)
import { create__Module__UseCases, type __Module__Repository } from '@/modules/__module__';
import { create__Module__Repository } from '@/modules/__module__/infrastructure/drizzle/__module__-repository-drizzle';

import { getKernel, type Kernel } from './kernel';
import { createCachedFactory } from './shared/singleton';

export type __Module__Overrides = {
  kernel?: Kernel;
  __module__Repository?: __Module__Repository;
};

const build__Module__UseCases = (overrides?: __Module__Overrides) => {
  const kernel = overrides?.kernel ?? getKernel();
  return create__Module__UseCases({
    __module__Repository:
      overrides?.__module__Repository ?? create__Module__Repository({ db: kernel.db }),
    permissionChecker: kernel.permissionChecker,
    logger: kernel.logger,
  });
};

const factory = createCachedFactory(build__Module__UseCases);

export const get__Module__UseCases = (overrides?: __Module__Overrides) => factory.get(overrides);

/** Test-only. */
export const __reset__Module__Composition = () => factory.reset();
```

Note this template reproduces the composition contract verbatim from `.claude/rules/modules.md` — `createCachedFactory`, singleton when no overrides, fresh when overrides, `??` merging — which is currently prose that a human must remember.

### `scaffold:remove-module`

```
pnpm scaffold:remove-module <name> [--dry-run] [--force]
```

1. Refuse if the working tree is dirty.
2. **Refuse if anything still imports the module.** Run the inbound-edge scan I ran in §0 — `src/**` for `@/modules/<name>` and `@/composition/<name>` — and print the offending file:line list. `--force` overrides. This is the guard that would have made iris's removal a two-command operation instead of a 190-file commit.
3. Delete `src/modules/<name>/`, `src/composition/<name>.ts`, `tests/**/modules/<name>/`, `src/app/i18n/*/<name>.json`.
4. Run every `registrations[].remove` whose `appliesTo` matched.
5. Warn (do not act) about: routes under `src/routes/**` referencing the module, Drizzle tables that need a DROP migration, and `src/app/shell/presentation/**` nav entries. These need human judgement.
6. `pnpm format:changed`; print `pnpm check && pnpm test:affected`.

### The test that makes this trustworthy

```ts
// tests/unit/scripts/scaffold-module.unit.spec.ts
it.each(['minimal', 'standard', 'full'] as const)(
  'generate then remove is a no-op for tier %s', async (tier) => {
    const before = await gitStatusPorcelain();
    await run(`scaffold:module scaffoldprobe --tier ${tier} --with-db --with-i18n`);
    await run('scaffold:remove-module scaffoldprobe');
    expect(await gitStatusPorcelain()).toEqual(before);
  });
```

Plus a slower CI-only job asserting that a freshly generated `--tier full` module passes `pnpm typecheck && pnpm depcruise && pnpm lint:sheriff` — i.e. that the template the generator emits is itself conformant. Without this, the generator's templates rot the moment the module contract changes.

**Effort:** `module-registry.ts` + 6 registrations ≈ **2 days**. Templates (3 tiers, ~28 files, de-specialized from `genre`) ≈ **2 days**. `scaffold-remove-module` ≈ **1 day**. Round-trip test ≈ **half a day**. **≈5.5 days**, and it is only that small because §3 already deleted 10 of the 16 registrations.

---

## 7. Track D — should the shape be tiered? Yes. Three tiers.

**The evidence is decisive and it is a both-apps signal.** Measured across all three repos:

| Shape | Gates | Layers | Instances |
|---|---|---|---|
| **minimal** | `index` `presentation` `testing` | `domain` `presentation` | iris `launch-workspace`, **hume `learning-portal`** |
| **standard** | + `client` `server` `factory.ts` | + `application` `transport` | template `account`, template `user` |
| **full** | + `backend` | + `infrastructure` | template `book` `genre` `auth` `email`, hume `conversation-practice` |
| *(outlier)* | `backend` `index` `presentation` `server` `testing`, no `client`/`factory` | all 5 | hume `site-access` |

Two independent teams, on unrelated products, reached for a 3-gate/2-layer module as the *first* module they wrote in their own domain. That is not a corner case; that is the modal new module. The template offers no example of it and no documentation that it is legal, and `tests/architecture/modular-monolith.unit.spec.ts:425-437` currently asserts that modules have five gates — an assertion that, if a forker naively extends the array, would forbid the very shape both apps chose.

**Recommendation:**

- **Ship all three tiers in the generator**, `--tier standard` as the default (the middle is the right default: minimal invites presentation-only modules that later need a use case and get retrofitted badly; full invites unused Drizzle scaffolding).
- **Document the tiers in `.claude/rules/modules.md` and `AGENTS.md`.** The current text — *"Only add folders and public gates when the module needs them"* — is correct but gives no examples, and the architecture tests contradict it. Replace with a named tier table plus the sentence *"A presentation-only capability (a fixture-backed surface, a demo screen, a read-only dashboard) is a legitimate module; it needs `index.ts`, `presentation.ts`, `testing.ts`, `domain/`, `presentation/` and nothing else."*
- **Fix the architecture tests to be shape-aware** rather than name-listed (see §3), so a minimal module passes and a half-built standard module fails.
- **Do not offer the `site-access` outlier as a tier.** It is `full` minus `client.ts` minus `factory.ts`; the generator should emit `standard`/`full` and let the author delete gates they don't use, since deleting a gate is a one-line operation the guardrails already tolerate.

**Effort:** ≈**1 day** (mostly the architecture-test rewrite and the docs).

---

## 8. Sequencing

Ordered by *unblocking*, not by size. Steps 1–3 are worth shipping even if the rest is never built.

| # | Work | Effort | Why here |
|---|---|---|---|
| **1** | **De-hardcode the guardrails.** Backreference rewrites in `.dependency-cruiser.cjs:57-62,75-79`; delete `:159-164` and the `:210` waiver; `[^/]+` in `sheriff.config.ts:44,47`; glob in `check-migration-edits.mjs:4-11`; matrix discovery in `mutation-testing.yml:21`; shape-aware architecture tests. **Add `tests/architecture/guardrail-config-freshness.unit.spec.ts`.** Add `lint:sheriff` to `check` and `check:ci` so any of this is actually enforced. | **1 day** | Everything downstream is cheaper. Standalone value: closes two fail-open layering rules. |
| **2** | **Collapse Stryker**: 17 root files → 2, 40 scripts → 4, delete the `knip.jsonc:5-8` workaround. | **half day** | Removes the largest single block of per-module boilerplate the generator would otherwise have to emit. |
| **3** | **Tier documentation + shape-aware tests** (§7). | **1 day** | Legitimises what both apps already built. Zero risk. |
| **4** | **`APP_SLUG` extraction + CSP-slice test fix** (§5 B1). | **half day** | Independent of everything; the CSP test fix is a live latent defect. |
| **5** | **`pnpm scaffold:rename`** (§5 B2) + branding architecture test. | **1.5 days** | First thing a forker runs. Independent of the demo work. |
| **6** | **Demo decoupling A1.1–A1.6** (kernel IDs, schema barrel, permissions split, upload registry, seed discovery, migration squash). | **3–4 days** | The expensive one. Each sub-step is independently mergeable. |
| **7** | **`pnpm scaffold:eject-demo`** (§4). | **1 day** | Only worth writing after 6. |
| **8** | **`scripts/lib/module-registry.ts` + `scaffold:module` + `scaffold:remove-module`** + round-trip test (§6). | **5.5 days** | Depends on 1, 2, 3. |
| **9** | **`docs/adding-a-module.md`** documenting the residue the generator does not automate (routes, nav, migrations). | **half day** | |

**Total ≈ 15 working days.** Steps 1–5 (**4.5 days**) deliver most of the forkability improvement; steps 6–9 deliver the rest.

---

## 9. What I would *not* build

- **A `create-*` npm CLI.** Requires publishing infrastructure the fork doesn't have. Fix `README.md:26` (which currently tells forkers to run `pnpm create start-ui -t web myApp`, scaffolding *upstream BearStudio*, not this fork) to a `degit hbmartin/start-ui-web my-app` line first, and see whether demand for a CLI materialises.
- **Moving the demo to `examples/`.** Already argued in §4. It cannot carry the coupling that matters.
- **A generator that writes into `.dependency-cruiser.cjs` / `sheriff.config.ts` / `.semgrep.yml`.** Delete those registrations instead (§3). A generator maintaining allowlists is worse than no generator, because it hides the fact that hand-added and renamed modules still fall through.
- **Automating the i18n *content*.** The generator should emit `{}` in `src/app/i18n/en/<name>.json` and stub keys for the other three locales. Which raises the next point.

---

## 10. Decisions for the repo owner

Ranked by how much they change the design. My recommendation stated for each.

**D1 — Squash the migration baseline? (blocks A1.6, §4)**
The `0000` baseline creates `author`/`book`/`publisher`/`genre`, and `drizzle/migrations/**` is enforced-immutable by `pnpm check:migrations`. Every fork must therefore ship a `DROP TABLE` migration for tables it never wanted.
→ **Recommend: yes, squash.** This is a starter template; no fork has a deployed database at `0004` (iris and hume both re-baselined or dropped). Squash to one platform-only baseline, put the demo tables in the *last* migration so `eject-demo` deletes a file instead of writing an inverse. If you say no, `eject-demo` must generate a DROP migration + snapshot + journal entry, which is another day of work and a permanent wart in every fork's history.

**D2 — Four locales, or one? (affects the generator's i18n registration cost)**
`src/app/i18n/` ships `ar`, `en`, `fr`, `sw` — 40 JSON files, 2,155 lines. Adding one namespace is 4 new files and 8 barrel edits. Measured adoption: `grep -rl 'useTranslation'` returns **0 of 47** presentation `.tsx` files across hume's three modules and **0 of 12** across iris's `launch-workspace`.
→ **Recommend: keep `en` plus one demonstration locale (`fr`), drop `ar` and `sw`, and replace the four hand-maintained `index.ts` barrels with a glob loader.** That reduces the generator's i18n registration from 12 touches to 1 file. The 0/59 adoption number is suggestive but not proof of causation (both apps are early and single-market) — low confidence on the *cause*, high confidence on the *measurement*. If you disagree and keep four locales, the generator handles it either way; it just stays a registration.

**D3 — Rename CodeQL `@id` prefixes? (§5)**
Changes the rule IDs in GitHub's Security tab and invalidates any SARIF baseline.
→ **Recommend: rename by default, warn loudly if `.github/codeql/codeql-baseline.json` exists.** A fresh fork has no baseline; a fork carrying `start-ui-web/react-dangerous-html-api` rule IDs forever is worse.

**D4 — What replaces the demo's upload E2E coverage? (§4)**
`tests/e2e/upload.spec.ts` (104 lines) and `docs/security-upload.md` (116 lines) exist only because of book covers; iris deleted both. The template ships `src/platform/components/upload/**`, `src/routes/api/upload.ts`, and S3 config — a real subsystem with no non-demo consumer.
→ **Recommend: add a user-avatar upload to the `user` module before ejecting the demo.** `user` is the module every fork keeps. Roughly 1 extra day, and it preserves the upload path's only end-to-end test. The alternative — accept the loss and say so in `TESTING.md` — is defensible but leaves a shipped subsystem entirely untested in every fork.

**D5 — Default generator tier.**
→ **Recommend `standard`.** Both apps' *first* module was minimal, which argues for `minimal`; but both also eventually built a full module, and retrofitting `application/` into a presentation-only module is the harder direction. Low confidence; happy to be overruled toward `minimal` given it is the measured modal shape.

**D6 — Should `pnpm scaffold:eject-demo` be run *by* the fork, or should `main` ship demo-free with the demo on a `demo` branch?**
→ **Recommend: `main` keeps the demo, script removes it.** The demo is the only worked example of the full 6-gate/5-layer contract, and `genre` is the reference the generator's templates are derived from. Removing it from `main` means the template documents a contract it does not demonstrate. But note the counter-evidence: hume looked at this repo and chose to *transcribe* rather than fork. If a second consumer does the same after this track ships, revisit — that would be evidence the demo is a net negative regardless of how cleanly it can be removed.
