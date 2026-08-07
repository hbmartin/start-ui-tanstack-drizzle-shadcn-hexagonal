<!-- Appendix E of the template improvement audit. See ./REPORT.md for the synthesis. -->

# Track: Agentification Plan for `start-ui-tanstack-drizzle-shadcn-hexagonal`

## 0. Position of this track

The template already has more machine-checkable architecture than almost any starter — 57 dependency-cruiser rules, 101 Semgrep rules, a Sheriff config, six architecture tests, six security tests, a module-dependency-graph `--check`. What it does not have is any way for an *agent* to find, trust, or cheaply exercise that machinery. Its entire agent-facing surface is:

```
.claude/settings.json        7 lines, attribution only — no permissions, no hooks
.claude/rules/architecture.md
.claude/rules/modules.md
.claude/rules/testing.md     ← 6 lines, about Prisma. This repo has no Prisma.
AGENTS.md                    147 lines
TESTING.md                   87 lines
```

Verified absent from the template: `CLAUDE.md`, `CONTEXT.md`, `docs/adr/`, `.claude/commands/`, `.claude/agents/`, `.claude/skills/`, `.agents/`, `skills-lock.json`, `.mcp.json`, `.github/copilot-instructions.md`, `.cursor/`, any per-directory `AGENTS.md`, and any Claude Code hook of any kind (`grep -rn "PostToolUse\|SessionStart\|hooks" --include=*.json` across all three repos returns only `components.json:18 "hooks": "@/platform/hooks"` and unrelated matches).

Both apps built the missing pieces, independently, in different shapes. That divergence is the argument for putting a canonical version in the template.

---

## 1. What the two apps actually built (evidence)

| Artifact | Template | hume-demo (APP1) | iris (APP2) |
|---|---|---|---|
| `CLAUDE.md` | absent | 30 lines, authoritative-refs table first | 120 lines, authoritative-refs sentence first |
| `CONTEXT.md` | absent | 67-line bullet glossary, 1 `_Avoid_` | 67 lines, skill format, 14 `_Avoid_` |
| `docs/adr/` | absent | 7 ADRs, `0001`–`0007`, Status/Date/Context/Decision/Consequences | absent |
| `.claude/rules/` | 3 files | **byte-identical copy** (`diff -r` → IDENTICAL) incl. the Prisma rule | **deleted the whole `.claude/` dir** (`ls -d .*/` → `.git .github .vscode .zed`) |
| `.agents/skills/` | absent | 3 vendored skills + `agents/openai.yaml` sidecars | absent |
| `skills-lock.json` | absent | 3 entries, all files present | **14 entries, zero files** (`git ls-files \| grep -i skill` → `skills-lock.json` only) |
| Node/toolchain guard | absent | `mise.toml`, `bin/run`, `.devcontainer/`, `scripts/check-node-version.mjs` wired into `check` + `check:ci` | absent |
| Doc-drift response | — | prose warning in `CLAUDE.md:15` | working rule in `CLAUDE.md:71` + commit `21db066` |

Two observations worth acting on:

1. **`.claude/rules/testing.md` is inherited garbage that survived a fork.** Its full content is a rule about `toHaveBeenCalledWith` on *Prisma* mocks, scoped to `paths: ["src/**/{spec,test}.{ts,tsx}"]`. There is no Prisma in the template (`grep -ril prisma` → only `.vscode/extensions.json:6 "Prisma.prisma"`, itself upstream residue), and no test file matches that glob — tests live in `tests/**` named `*.unit.spec.ts`. hume-demo carried it verbatim for 123 commits; iris deleted the directory rather than fix it. Neither outcome is what you want.

2. **iris's `skills-lock.json` is orphaned.** 14 locked skills (`domain-modeling`, `grilling`, plus 12 `hyperframes*` video skills from `heygen-com/hyperframes`), and not one `SKILL.md` in the repo. An agent in iris reads a lockfile promising `domain-modeling` and gets nothing — which is exactly why iris's `CONTEXT.md` follows the skill's format perfectly (it was written in a session where the skill *was* loaded) while nothing enforces that the next session can load it.

---

## 2. The doc-drift defense — design this first, it is the highest-value item

### 2.1 The template's docs are provably wrong today

I did not have to hunt. `docs/security practices.md` (93 lines, referenced from README and from `docs/security-risk-register.md`) is a verbatim import from **a different application**:

| Line | Claim | Reality (verified) |
|---|---|---|
| `:90` | "51 dependency-cruiser rules … 123 Semgrep rules" | `grep -c "name: '" .dependency-cruiser.cjs` → **57**; `grep -c "^  - id:" .semgrep.yml` → **101** |
| `:23` | Sheriff enforces "12 layer tags (barrel, domain, ports, use-cases, cache, application, infrastructure, transport, config, observability, utils, validation)" | 8 of those 12 names (`barrel`, `ports`, `use-cases`, `cache`, `config`, `observability`, `utils`, `validation`) appear **nowhere** in `sheriff.config.ts`. Actual tags: 11 × `layer:*` (`app, application, composition, domain, infrastructure, platform, platform-support, presentation, public, routes, transport`) + 6 × `area:*` |
| `:23`, `:48` | "`pnpm lint:sheriff` in CI" / step 6 of the verification sequence | `grep -rn 'sheriff' .github/` → **zero hits**; `lint:sheriff` is in neither `check` (package.json:132) nor `check:ci` (:133) |
| `:27`, `:61`, `:65`, `:81` | SDK confinement for **Stripe / Twilio / Attio / MongoDB**, Mongo integration tests in `introductions`/`onboarding-simulation`, mutation testing on `intros-consent`, `whatsapp-webhook-delivery`, webhook idempotency for Stripe/Twilio | `grep -ril "stripe\|twilio\|attio\|mongodb\|whatsapp"` across the whole repo, excluding that file → **zero hits** |
| `:68` | "Biome: ~400 individual rule configurations" | zero hits for `biome`; the repo uses oxfmt + oxlint + eslint |
| `:88`, `:93` | "Octoscan", "Pushover on-call alert", "`db-migrate.yml` workflow" | zero hits each; workflows are the 12 listed in `.github/workflows/` |

And in the doc AGENTS.md points at for boundary contracts:

```
docs/strict-modular-monolith.md:113
  functions out of the box. This app does not define `src/start.ts`, so the
```
`src/start.ts` exists — 7,455 bytes, and it is the security spine (Sentry, telemetry, security headers, auth context, browser-mutation guard, body limit, CSRF).

### 2.2 Prose warnings do not work — proof from APP1

hume-demo's response was to warn the agent in `CLAUDE.md:15`:

> Two known staleness traps: `AGENTS.md` describes the repo as a "minimal boilerplate fork" with only the `kernel` module, and both it and `docs/strict-modular-monolith.md` document Better Auth, Drizzle/Postgres, and Resend guardrails. **None of those exist here** …

That warning is **itself stale**. hume-demo's `AGENTS.md:18` now reads:

> There is **no database, no user authentication, and no transactional email**. There is no Drizzle, no Better Auth, and no Resend adapter…

`git log --oneline -- AGENTS.md CLAUDE.md` shows both files were last touched in the **same commit** (`b235e2d`). The author fixed the doc and left the warning about the doc. A meta-doc describing the wrongness of another doc is a second thing to drift, and it drifted within one commit.

iris took the other route — `CLAUDE.md:71`: *"When a doc does not match the code, fix the doc in the same change."* — and did it once (`21db066 Correct the CSRF policy doc to match src/start.ts`, producing `docs/strict-modular-monolith.md:112 "src/start.ts defines the Start instance…"`). A working rule with no enforcement is one conscientious contributor away from failing.

**Both apps independently hit template doc drift and both invented a manual mitigation. That is the signal: the template needs a mechanical one.**

### 2.3 Proposed mechanism: `scripts/check-doc-drift.mjs`, three tiers

There is already precedent for both halves of this in the repo, so this is not a new genre of tooling:
- `scripts/generate-module-dependency-graph.ts` `--check` (`CHECKED_ARTIFACT_FILENAMES = [ARTIFACT_FILENAMES.dot]`, line 39) — "generated artifact must match code".
- `scripts/check-risk-register.mjs` — parses a markdown table in `docs/` and exits 1 on a policy violation.
- `tests/architecture/dependency-cruiser.unit.spec.ts:24-32` — reads a config **as text** and asserts on its content.

**Tier 1 — zero-annotation reference resolution.** No doc changes required; catches the majority of real drift.

- Every backticked token in tracked `*.md` (plus `//` and `/* */` comments under `src/` and `scripts/`) matching `^(src|tests|scripts|drizzle|docs|hume|\.github|\.claude)/\S+` must resolve on disk (allowing a trailing `/**`, `/*` glob).
- Every backticked `pnpm <script>` must name a real key in `package.json` `scripts` (or a real pnpm builtin: `install`, `audit`, `exec`, `dlx`, `add`).

What this would have caught, today, with no annotations:
- `src/composition/telemetry/transport.ts:139` — *"see `docs/security-rate-limiting.md`"*. That file does not exist in the template (`ls docs/` → `architecture/`, `security practices.md`, `security-risk-register.md`, `security-upload.md`, `strict-modular-monolith.md`). hume-demo's first template-touching commit `a711431` *deleted the sentence* rather than write the doc.
- In a fork: hume-demo's `.semgrep.yml:529,1465,1466` pointing at `src/modules/book/application/use-cases/update-book.ts` and `src/modules/genre/domain/genre.ts`, neither of which exists there.
- In a fork: `pnpm db:generate` in hume-demo's docs after Drizzle was removed.

**Tier 2 — an annotation vocabulary for semantic claims.** Fixed verbs, implemented in the script, **no shell execution** (a doc that can run shell would be flagged by the repo's own Semgrep/CodeQL posture).

```md
<!-- assert: file-exists src/start.ts -->
`src/start.ts` defines the Start instance and replaces TanStack Start's default
middleware chain, so CSRF must stay registered there explicitly.

<!-- assert: script-in-aggregate lint:sheriff check -->
<!-- assert: script-in-aggregate lint:sheriff check:ci -->
<!-- assert: workflow-runs lint:sheriff -->
| Sheriff | Module-barrel + layer-tag checks | `pnpm lint:sheriff` in CI |

<!-- assert: count depcruise-rules 57 -->
<!-- assert: count semgrep-rules 101 -->
- Architectural guardrails: 57 dependency-cruiser rules + 101 Semgrep rules

<!-- assert: dep-absent @prisma/client -->
<!-- assert: glob-nonempty tests/**/*.unit.spec.ts -->
```

Verb set (complete; ~200 lines of implementation, no new dependency):

| Verb | Checks | Would have caught |
|---|---|---|
| `file-exists` / `file-absent` | `fs.existsSync` | `docs/strict-modular-monolith.md:113` |
| `script-exists <name>` | key in `package.json.scripts` | `pnpm db:generate` after Drizzle removal |
| `script-in-aggregate <name> <aggregate>` | substring of the aggregate's command | `lint:sheriff` claim at `security practices.md:48` |
| `workflow-runs <script>` | `pnpm <script>` present in `.github/workflows/**` | `security practices.md:23` "in CI" |
| `dep-exists` / `dep-absent <pkg>` | `package.json` deps + devDeps | README:11's oRPC / React Hook Form claims |
| `count <matcher> <n>` | named matchers registered in the script: `depcruise-rules`, `semgrep-rules`, `modules`, `sheriff-layer-tags`, `workflows` | `security practices.md:90` (51/123 vs 57/101) |
| `symbol-exists <path> <ident>` | regex for `export …<ident>` | AGENTS.md's port names (`SessionGateway` etc.) |
| `glob-nonempty <glob>` | at least one match | `.claude/rules/testing.md`'s dead `paths:` glob |

`--fix` semantics (state this precisely, it is the part people get wrong): **`--fix` only rewrites the integer in a `count` assertion's annotation and the nearest matching integer on the following non-blank line.** It never edits prose. Everything else fails and demands a human edit.

**Tier 3 — generated regions**, for the highest-churn drift: the command tables.

```md
<!-- generated:commands start -->
| Command | Purpose |
|---|---|
| `pnpm dev` | … |
<!-- generated:commands end -->
```

Regenerated from `package.json` `scripts` plus a `scripts/doc-command-descriptions.json` map; `--check` fails when stale, exactly like `architecture:graph:check`. This kills the class where `AGENTS.md`'s table and `CLAUDE.md`'s table and `README.md`'s table diverge from `package.json` and from each other — which is already happening: the template's AGENTS.md command table lists `pnpm test:e2e:visual:manager-users` but never mentions `pnpm lint:sheriff`, `pnpm check:test-layering`, `pnpm knip:deps`, or `pnpm architecture:graph:check`, all of which are in `check`.

### 2.4 Wiring

```jsonc
// package.json
"check:docs":     "node scripts/check-doc-drift.mjs",
"check:docs:fix": "node scripts/check-doc-drift.mjs --fix",
"gen:doc-commands": "node scripts/check-doc-drift.mjs --write-generated",
```
Add `check:docs` to **both** `check` and `check:ci` (they have already diverged three ways — `check:ci` silently omits `architecture:graph:check` and `semgrep`; fix that in the same change, see §8).

Add `tests/architecture/doc-drift.unit.spec.ts` — same shape as `dependency-cruiser.unit.spec.ts` — asserting (a) the drift check reports zero violations, and (b) a coverage floor: `AGENTS.md`, `TESTING.md`, `CLAUDE.md`, `README.md`, and every file in `docs/` carries at least one Tier-2 assertion or an explicit `<!-- assert: none-required <reason> -->` opt-out. The opt-out is deliberate: it makes "this doc makes no checkable claims" an affirmative statement rather than an omission.

**Effort:** 1.5–2 days for the script + verbs + tests. **Then a separate 0.5 day** to repair `docs/security practices.md` — which, given §2.1, is closer to "delete and rewrite" than "fix". See §9 for the decision.

---

## 3. Document hierarchy: the CLAUDE.md / AGENTS.md / `.claude/rules` ownership rule

Today there is no rule, and it shows: `.claude/rules/architecture.md` and `.claude/rules/modules.md` restate AGENTS.md content in condensed form with **no cross-reference in either direction** (`grep -rn "claude/rules"` across the template → zero hits; only hume-demo's `CLAUDE.md:12` mentions the directory). Three sources of the same truth, two of which nothing points to.

**Proposed rule, to be stated verbatim in `CLAUDE.md` itself:**

| File | Owns | Never contains | Read by |
|---|---|---|---|
| `AGENTS.md` | The **contract**: canonical commands, public gates, layer rules, Result/`AppError` policy, guardrails, auth ports. Normative, tool-neutral, stable. | Repo-specific "how I like to work" preferences; anything that changes per fork | every agent; humans |
| `CLAUDE.md` | The **index + working rules**: pointers into AGENTS.md / TESTING.md / CONTEXT.md / `.claude/rules`, the tiered gate ladder, single-test invocations, and behavioural rules that are Claude-Code-specific (branch policy, when to escalate, research standards) | Any normative architecture rule — those live in AGENTS.md and are *linked* | Claude Code (auto-loaded) |
| `.claude/rules/*.md` | **Path-scoped** rules with `paths:` front-matter, condensed to the point of being a checklist. One file per boundary. | Prose, rationale, anything not actionable when you have that file open | Claude Code, scoped |
| `CONTEXT.md` | Ubiquitous language only | Architecture, commands, how-to | all agents; humans writing UI copy |
| `docs/adr/NNNN-*.md` | Why a hard-to-reverse decision was made | Current-state description (that drifts) | agents on demand |

The load-bearing part of the rule: **AGENTS.md is normative and CLAUDE.md is navigational.** Both apps got this right by accident — iris's `CLAUDE.md:7` says *"When they disagree with this file, they win"* — and the template should state it so forks inherit it.

### 3.1 `CLAUDE.md` skeleton (new file, ~85 lines)

```md
# CLAUDE.md

Guidance for Claude Code in this repository.

## Authoritative references

| File | Covers |
|---|---|
| `AGENTS.md` | **Normative.** Canonical commands, public gates, module/layer rules, Result/`AppError` policy, guardrails. |
| `TESTING.md` | Test layer map, escalation rules, quality gates. |
| `CONTEXT.md` | Domain glossary. Use these terms in UI copy, domain types, and commit messages. |
| `.claude/rules/*.md` | Path-scoped checklists, loaded automatically when you open a matching file. |
| `docs/adr/*.md` | Decisions and their rationale. Read before reversing one. |
| `docs/adding-a-module.md` | The residue `pnpm gen:module` cannot automate. |

This file is an index and a set of working rules. It states no architecture rule
of its own — when this file and `AGENTS.md` disagree, `AGENTS.md` wins.
If you find any of these documents contradicting the code, fix the document in
the same change and add a `<!-- assert: … -->` line so it cannot drift again
(`pnpm check:docs`).

## The gate ladder — climb only as far as the change requires

<!-- generated:commands start -->
| Tier | Command | Typical wall clock | When |
| 0 | (automatic PostToolUse hook) | <1s | every Edit/Write — formats the file you touched |
| 1 | `pnpm typecheck` | seconds | after any edit, before believing anything |
| 2 | `pnpm check:fast` | ~10-20s | the loop. format:check + lint + typecheck + depcruise + check:docs |
| 3 | `pnpm test:affected` | seconds-minutes | before saying a change works |
| 4 | `pnpm check` | ~1-2 min | when the change is believed complete |
| 5 | `pnpm verify` | several min | pre-merge only |
<!-- generated:commands end -->

Do not run tier 4 or 5 in a loop. Running `pnpm test` after every edit is the
single largest avoidable time sink in this repo (see `iris CLAUDE.md`, which
learned this the hard way).

## Running one test

    pnpm vitest run --project=unit tests/unit/path/to/file.unit.spec.ts
    pnpm vitest run --project=unit -t "rejects expired sessions"
    pnpm vitest run --project=browser tests/browser/.../x.browser.spec.tsx
    pnpm test:e2e --project=chromium tests/e2e/login.spec.ts

## Working rules

**Never create a branch unless asked.** Commit to the checked-out branch;
`git fetch` before concluding anything about what a branch contains.

**Guardrails over one-off fixes.** When a regression class can repeat, add the
rule to `.dependency-cruiser.cjs`, `.semgrep.yml`, `sheriff.config.ts`, or
`tests/architecture/**` — not only a test. Never add a *named* waiver for a
single file; `.dependency-cruiser.cjs` already carries one vestigial example
(`pathNot: '^src/modules/book/server\.ts$'`) that outlived its cause.

**Never widen a guardrail to make your change pass.** If depcruise, Sheriff, or
Semgrep blocks you, that is the answer. Escalate to the user instead.

**Visual baselines under `__visual_snapshots__/` are reviewed artifacts.**
Never run `pnpm test:visual:update` without saying why. (These are currently
`-chromium-darwin` only; see `TESTING.md`.)

**Secrets never enter the repo.** `detect-secrets` runs in CI against
`.secrets.baseline`; intentional fixtures carry `# pragma: allowlist secret`.
```

### 3.2 Rewrite `.claude/rules/testing.md`

Delete the Prisma rule. Replace with the actual rules that exist in this repo, scoped correctly:

```md
---
paths:
  - "tests/**/*.{test,spec}.{ts,tsx}"
---

- Pick the cheapest layer that proves the behaviour (`TESTING.md` has the map).
  `scripts/check-test-layering.mjs` enforces the placement rules; it runs in
  `pnpm check`.
- Integration tests import modules through **public gates only** — never
  `domain/`, `application/`, `infrastructure/`, `transport/`, `presentation/`.
- Adapter behaviour over SQL, `db.execute`, schema serialization, or migrations
  needs a real driver (`tests/integration/modules/*/infrastructure/__tests__/`),
  not a mocked `db`. Mocked-DB unit tests do not prove serialization.
- Use `tests/**/testing.ts` gates for owner internals; production source must
  never import them (enforced by depcruise).
- Never assert on mock call arguments where the return value is observable.
  Assert the value the unit under test produced.
```

Add a fourth rule file, `.claude/rules/guardrails.md`, scoped to `paths: [".dependency-cruiser.cjs", "sheriff.config.ts", ".semgrep.yml", ".github/workflows/*.yml"]`, encoding the lesson from the critical corpus finding:

```md
Guardrail configs must never name a module literally. Use a backreference —
`from: '^src/modules/([^/]+)/domain'` → `to: '^src/modules/$1/presentation'` —
the style `no-cross-feature-deep-import` already uses. Hardcoded allowlists
(`(book|user|genre|account)`) fail OPEN for every module a fork adds, and are
asserted against by `tests/architecture/modular-monolith.unit.spec.ts`.
```

**Effort:** CLAUDE.md 3h; rules rewrite 1h.

---

## 4. `CONTEXT.md` and its format

The template should ship a **stub plus the format**, not a book-store glossary (which would be deleted alongside `book`/`genre` anyway — 178 files, 3,749 occurrences).

`CONTEXT.md` (new, ~25 lines):

```md
# {Your Product} Domain

<!-- assert: none-required stub replaced per fork -->

One or two sentences: what this product is and who it is for.

## Language

**{Term}**:
What it IS, in one or two sentences. Not what it does.
_Avoid_: {the synonyms you are deliberately rejecting}

---

### Rules for this file (delete once populated)

- **Be opinionated.** Pick one word per concept; list the losers under `_Avoid_`.
- **Project-specific terms only.** `Clock`, `Result`, `AppError`, and rate limiting
  are general engineering concepts documented in `AGENTS.md`, not domain terms.
- **Group under `##` subheadings** when clusters emerge; a flat list is fine otherwise.
- **Rename in lockstep.** Changing a domain term means changing this file, the
  Drizzle schema, the module name, the i18n keys, and the UI copy in one change.
- Multiple bounded contexts → add `CONTEXT-MAP.md` at the root and per-context
  `CONTEXT.md` files; see `.agents/skills/domain-modeling/CONTEXT-FORMAT.md`.
```

This is iris's format (14 `_Avoid_` entries, `## Workspace` / `## Relationships` grouping), which is the better of the two — hume-demo's is a flat bullet list with one `_Avoid_`. Both derive from the same vendored skill; iris followed it because the skill was loaded, hume-demo did not.

Add `CONTEXT.md` to the list in `docs/adding-a-module.md`: a new capability must contribute its terms.

**Effort:** 1h.

---

## 5. ADR practice

hume-demo produced seven ADRs; iris produced none. hume-demo's are genuinely good — `docs/adr/0003-gate-scoring-on-terminal-hume-history.md` records exactly the kind of constraint that a future agent would otherwise "optimize away" (a bounded poll before a paid model call). The template ships neither the directory nor the convention, so a fork gets ADRs only if someone happens to load the `domain-modeling` skill.

**Ship:**

```
docs/adr/README.md              ← index + numbering rule
docs/adr/ADR-FORMAT.md          ← the format (adapted from the vendored skill)
docs/adr/0001-strict-modular-monolith.md
docs/adr/0002-result-and-apperror-policy.md
docs/adr/0003-public-gate-files.md
docs/adr/0004-immutable-migrations.md
```

Seeding four ADRs is not busywork — it does three things: it establishes the numbering so `/adr` has a floor to increment from, it demonstrates the format, and it records four decisions that agents currently violate or "fix" because nothing explains them. Each is ~15 lines.

`docs/adr/ADR-FORMAT.md` (adapted from `.agents/skills/domain-modeling/ADR-FORMAT.md`, with this repo's heavier house style — hume-demo's real ADRs use Status/Date/Context/Decision/Consequences, not the skill's one-paragraph minimum, so the template should codify what its forks actually write):

```md
# ADR Format

ADRs live in `docs/adr/` with sequential four-digit numbering: `0001-slug.md`.
Numbering: scan `docs/adr/`, take the highest, increment. Never reuse or renumber.

    # ADR NNNN: {Decision, in the imperative}

    - Status: Proposed | Accepted | Deprecated | Superseded by ADR-NNNN
    - Date: YYYY-MM-DD

    ## Context
    What forced the decision. Include the measurement or incident if there was one.

    ## Decision
    What we do now. Present tense, specific enough to check against the code.

    ## Consequences
    What this costs, and what it makes hard. Name the thing a future reader
    will be tempted to "fix".

## When an ADR is warranted

All three must hold:
1. Hard to reverse.
2. Surprising without context — a reader will ask "why on earth".
3. The result of a real trade-off with a live alternative.

Deliberate *non*-decisions count: "we do not use X because Y" stops the next
agent from adding X.

## What does NOT go in an ADR
Current-state description. That drifts. Put it in `AGENTS.md` (with a
`<!-- assert: … -->`) and let the ADR say only why.
```

**Decision for the owner:** whether `ADR-FORMAT.md` lives in `docs/adr/` (template-owned, editable) or stays inside the vendored skill (upstream-owned, overwritten on skill update). **Recommendation: `docs/adr/`**, because the template's house style already diverges from the skill's, and a vendored file that gets locally edited breaks `skills-lock.json`.

**Effort:** 4h (format + README + four seed ADRs).

---

## 6. `.claude/settings.json` — permissions

Current file is 7 lines and grants nothing, so every `pnpm`, `git`, and `node` invocation prompts. The allowlist below is derived from the actual 120 scripts in `package.json` and the actual services in `docker-compose.yml` (postgres, minio, maildev, createbucket, otel-collector).

```jsonc
{
  "$schema": "https://json.schemastore.org/claude-code-settings.json",
  "attribution": {
    "commit": "Co-authored-by: Claude <noreply@anthropic.com>",
    "pr": "Generated with [Claude](https://claude.ai)"
  },
  "permissions": {
    "allow": [
      // --- read-only inspection ---
      "Bash(git status:*)", "Bash(git diff:*)", "Bash(git log:*)",
      "Bash(git show:*)", "Bash(git branch:*)", "Bash(git fetch:*)",
      "Bash(git ls-files:*)", "Bash(git blame:*)", "Bash(git stash list:*)",
      "Bash(gh pr view:*)", "Bash(gh pr diff:*)", "Bash(gh run list:*)",
      "Bash(gh run view:*)", "Bash(gh api:*)",

      // --- the gate ladder (see CLAUDE.md) ---
      "Bash(pnpm typecheck)", "Bash(pnpm lint)", "Bash(pnpm lint:eslint)",
      "Bash(pnpm lint:fix)", "Bash(pnpm lint:sheriff)",
      "Bash(pnpm format)", "Bash(pnpm format:check)", "Bash(pnpm format:changed:*)",
      "Bash(pnpm depcruise:*)", "Bash(pnpm semgrep)", "Bash(pnpm knip:deps)",
      "Bash(pnpm architecture:graph:*)",
      "Bash(pnpm check:*)", "Bash(pnpm check)", "Bash(pnpm check:fast)",
      "Bash(pnpm security:tanstack)", "Bash(pnpm security:licenses)",
      "Bash(pnpm security:risk-register)",

      // --- tests ---
      "Bash(pnpm test:*)", "Bash(pnpm vitest run:*)", "Bash(pnpm exec vitest run:*)",
      "Bash(pnpm exec playwright test:*)", "Bash(pnpm exec tsx scripts/:*)",

      // --- env / build / db (local only) ---
      "Bash(pnpm run env)", "Bash(pnpm env:*)", "Bash(pnpm build)",
      "Bash(pnpm db:generate)", "Bash(pnpm db:push)", "Bash(pnpm db:seed)",
      "Bash(pnpm db:init)", "Bash(pnpm db:migrate)",
      "Bash(pnpm dk:init)", "Bash(pnpm dk:start)", "Bash(pnpm dk:stop)",
      "Bash(docker compose ps:*)", "Bash(docker compose logs:*)",

      // --- ambient ---
      "Bash(node -e:*)", "Bash(node scripts/:*)", "Bash(pnpm install)",
      "Bash(pnpm exec depcruise:*)", "Bash(ls:*)", "Bash(rg:*)", "Bash(wc:*)",
      "Read(//home/**)", "WebFetch(domain:tanstack.com)",
      "WebFetch(domain:orm.drizzle.team)", "WebFetch(domain:better-auth.com)",
      "WebFetch(domain:zod.dev)", "WebFetch(domain:base-ui.com)"
    ],
    "deny": [
      "Read(./.env)", "Read(./.env.*)", "Read(./**/*.pem)", "Read(./**/*.key)",
      "Bash(git push --force:*)", "Bash(git push -f:*)", "Bash(git reset --hard:*)",
      "Bash(git checkout -b:*)", "Bash(git switch -c:*)",
      "Bash(gh pr merge:*)", "Bash(gh release:*)", "Bash(pnpm publish:*)",
      "Bash(pnpm dk:clear)",
      "Bash(pnpm test:visual:update)", "Bash(pnpm test:e2e:visual:update)",
      "Bash(pnpm test:browser:visual:update)",
      "Bash(rm -rf:*)", "Bash(curl:*)", "Bash(sudo:*)"
    ],
    "ask": [
      "Bash(git commit:*)", "Bash(git push:*)", "Bash(gh pr create:*)",
      "Bash(pnpm add:*)", "Bash(pnpm remove:*)", "Bash(pnpm update:*)",
      "Bash(pnpm verify)"
    ]
  }
}
```

Rationale for the non-obvious entries, each grounded:

- **`git checkout -b` / `switch -c` denied.** Both apps' CLAUDE.md carry a branch rule; iris's is emphatic (*"Never create a branch unless explicitly asked… do not silently branch, switch, or move commits"*). Denying the syntax is stronger than a prose rule.
- **Visual-update scripts denied**, not asked. AGENTS.md: *"Visual test baselines are reviewed repo artifacts; do not silently update them."* Six committed PNGs, all `-chromium-darwin`.
- **`pnpm dk:clear` denied** — it is `docker compose down --volumes`, i.e. it destroys the local database.
- **`pnpm add` in `ask`, not `allow`** — `knip:deps` and `security:licenses` and `docs/security-risk-register.md` all gate dependencies; a silent add defeats three checks.
- **`pnpm verify` in `ask`** — it is `check && test && build`. Making the agent ask is a deliberate speed brake, reinforcing the ladder.
- **`Read(./.env)` denied** while `env:*` scripts are allowed — the agent can *validate* config without *reading* secrets.

Also ship `.claude/settings.local.json.example` (gitignore `settings.local.json`) showing how an individual adds `Bash(mise:*)` or a personal MCP.

**Effort:** 2h including a pass verifying each pattern against the real script names.

---

## 7. Hooks

None exist today. Three, all as committed shell scripts under `.claude/hooks/` so they are reviewable and testable, invoked from `.claude/settings.json`.

```jsonc
"hooks": {
  "PostToolUse": [{
    "matcher": "Edit|Write|MultiEdit",
    "hooks": [{ "type": "command", "command": ".claude/hooks/format-file.sh", "timeout": 20 }]
  }],
  "Stop": [{
    "hooks": [{ "type": "command", "command": ".claude/hooks/stop-gate.sh", "timeout": 300 }]
  }],
  "SessionStart": [{
    "hooks": [{ "type": "command", "command": ".claude/hooks/session-start.sh", "timeout": 900 }]
  }]
}
```

### 7.1 `.claude/hooks/format-file.sh` — PostToolUse auto-format

`lefthook.yml` already formats on `pre-commit` (`pnpm format:changed -- {staged_files}` + `pnpm oxlint {staged_files}`), but that fires only at commit, which means every intermediate `pnpm check` in an agent loop can fail on `format:check` alone. Formatting at write time removes an entire class of false failure.

```sh
#!/bin/sh
set -eu
# stdin is the hook JSON; node is guaranteed (engines: node 24.x). No jq dependency.
file=$(node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
  try{const j=JSON.parse(s);process.stdout.write(j.tool_input?.file_path??"")}catch{}})')
[ -n "$file" ] || exit 0
[ -f "$file" ] || exit 0
case "$file" in
  *.ts|*.tsx|*.js|*.jsx|*.mjs|*.cjs|*.json|*.jsonc|*.md|*.css) ;;
  *) exit 0 ;;
esac
[ -x node_modules/.bin/oxfmt ] || exit 0          # pre-install: silently no-op
node_modules/.bin/oxfmt "$file" >/dev/null 2>&1 || true
# Lint only; never auto-fix — oxlint --fix can change semantics the agent
# did not intend, and the agent must see its own lint errors.
node_modules/.bin/oxlint "$file" 2>&1 | head -40 >&2 || true
exit 0
```

Deliberate choices: exit 0 always (a formatter must never block a write); `oxfmt` direct rather than `pnpm format:changed` (which shells out to git and formats the whole changed set — ~10× slower per keystroke); lint output to stderr so the agent *sees* it without it being a hard failure.

### 7.2 `.claude/hooks/stop-gate.sh` — affected tests before the agent stops

The template already has `scripts/affected-tests.ts` with `--run --json --summary --base <rev>`. The hook wraps it with the guards that make a Stop hook safe.

```sh
#!/bin/sh
set -eu
payload=$(cat)
# 1. Never recurse: if this hook already blocked once this turn, let it stop.
active=$(printf '%s' "$payload" | node -e '…j.stop_hook_active…')
[ "$active" = "true" ] && exit 0
# 2. Opt-out for long refactors / doc-only sessions.
[ "${CLAUDE_SKIP_STOP_GATE:-0}" = "1" ] && exit 0
# 3. No source changes → nothing to prove.
git diff --quiet --exit-code -- src tests scripts && exit 0
[ -x node_modules/.bin/tsx ] || exit 0

# 4. Size the blast radius first; a 400-file refactor must not run the world.
count=$(node_modules/.bin/tsx scripts/affected-tests.ts --json \
        | node -e '…JSON.parse(s).testFiles.length…')
if [ "$count" -gt "${CLAUDE_STOP_GATE_MAX:-40}" ]; then
  printf 'Stop gate skipped: %s affected test files (> %s). Run `pnpm verify` before handoff.\n' \
    "$count" "${CLAUDE_STOP_GATE_MAX:-40}" >&2
  exit 0
fi
if ! node_modules/.bin/tsx scripts/affected-tests.ts --run >/tmp/stop-gate.log 2>&1; then
  echo "Affected tests are failing. Fix them before finishing:" >&2
  tail -60 /tmp/stop-gate.log >&2
  exit 2   # exit 2 blocks the stop and feeds stderr back to the model
fi
exit 0
```

The `stop_hook_active` guard and the `--json` pre-count are the two things that separate a useful Stop hook from an infinite loop and a five-minute stall. Both are needed here specifically: `scripts/affected-tests.ts` treats `vitest.config.ts`, `package.json`, `pnpm-lock.yaml`, `tsconfig.json`, and `tests/setup.*.ts` as `GLOBAL_CONFIG_FILES` (lines 13–24), so touching any of them makes *every* test affected.

**Decision for the owner:** blocking Stop hook vs. advisory. **Recommendation: blocking, with the `> 40` escape hatch above**, because the corpus shows this repo's failure mode is silently-shipped regressions (the PGlite teardown swallowing exit codes; the `env:client` no-op) rather than agents being over-cautious.

### 7.3 `.claude/hooks/session-start.sh` — cloud/web bootstrap

This is the hook with the largest payoff, because the template **does not currently start**: `.env.example:61` ships `AUTH_SECRET="REPLACE ME"`, which `src/modules/kernel/infrastructure/config/auth.ts` rejects twice (10 chars < `AUTH_SECRET_MIN_LENGTH = 32`, and `'replace me'` ∈ `AUTH_SECRET_PLACEHOLDERS`), and `SKIP_ENV_VALIDATION` is commented out at `.env.example:47-48`, so `pnpm dev` → `run-p env dev:*` → `env:server` → `validateServerConfig()` → `getAuthConfig()` fails on a fresh clone.

Make the hook a thin wrapper over a **real script**, so the same logic serves three consumers:

```
scripts/bootstrap.mjs   ← new; the single implementation
  ├─ pnpm setup                                     (humans, README step 2)
  ├─ .claude/hooks/session-start.sh                 (agents, cloud/web)
  └─ .devcontainer/devcontainer.json postCreateCommand
```

`node scripts/bootstrap.mjs [--no-docker] [--no-browsers] [--quiet]`, all steps idempotent:

| Step | Action | Skipped when |
|---|---|---|
| 1 | Verify Node major against `.node-version` (port hume-demo's `scripts/check-node-version.mjs`) | never — fail fast |
| 2 | `cp .env.example .env` if absent | `.env` exists |
| 3 | Rewrite `AUTH_SECRET=` in `.env` with `crypto.randomBytes(32).toString('hex')` **iff** the current value is a known placeholder (reuse the same `AUTH_SECRET_PLACEHOLDERS` set) | value already valid |
| 4 | `pnpm install --frozen-lockfile` | `node_modules/.bin/vitest` exists and lockfile mtime older |
| 5 | `docker compose --profile init up -d --wait` (postgres, minio, maildev, createbucket, otel-collector) then `pnpm db:init` | `--no-docker`, or no docker socket |
| 6 | `pnpm exec playwright install chromium --with-deps` | `--no-browsers`, or browsers cached |
| 7 | Warm: `pnpm typecheck` (populates tsbuildinfo) and `pnpm exec vitest --version` | `--quiet` |
| 8 | Print a status table: which steps ran, which were skipped, and the exact next command | never |

```sh
#!/bin/sh
set -eu
# Cloud/web sessions have no docker socket and no interactive shell.
if [ -S /var/run/docker.sock ]; then extra=""; else extra="--no-docker"; fi
node scripts/bootstrap.mjs $extra 2>&1 | tail -30
exit 0   # never block a session on bootstrap
```

Step 3 alone removes the template's documented first-run failure for humans and agents simultaneously. Steps 5–6 are what make a cloud session able to run `pnpm test:integration` and `pnpm test:browser` at all.

**Effort:** hooks 1 day; `scripts/bootstrap.mjs` 1 day (it is the biggest new script).

---

## 8. The fast feedback loop — tiered gates

The template today offers exactly two speeds: `pnpm check` (11 parallel tools, including `semgrep`, `knip:deps`, and `security:audit` which shells out to the network) and `pnpm verify` (`check && test && build`). There is no fast tier, so agents either run the expensive one repeatedly or run nothing.

Worse, `security:audit` is **inside `check`** (package.json:62 → :132), and `security:audit` chains `security:risk-register`, which **fails on a fresh clone today** — every row in `docs/security-risk-register.md` carries `2026-07-23` and `scripts/check-risk-register.mjs:61-75` exits 1 on any past date. So the template's advertised gate is currently red for every fork, which trains agents to ignore it.

**Proposed script set:**

```jsonc
// fast — pure, offline, deterministic, no network, no docker. Target < 20s.
"check:fast": "run-p -n format:check lint typecheck depcruise check:docs",

// full local — everything deterministic and offline
"check": "run-p -n format:check lint lint:eslint typecheck depcruise lint:sheriff architecture:graph:check check:test-layering check:migrations check:docs check:node-version semgrep knip:deps",

// CI — identical to check; the ONLY difference is reporter flags
"check:ci": "pnpm check",

// networked / slow, deliberately outside the loop
"security:audit": "pnpm audit --audit-level=high && pnpm security:tanstack && pnpm security:licenses && pnpm security:risk-register",
```

Four changes embedded there, each grounded:

1. **`lint:sheriff` enters `check`.** Today it is in no aggregate and no workflow (`grep -rn 'sheriff' .github/` → nothing), while `docs/security practices.md:23,48` claims it runs in CI. It is also the *only* backstop for the two dependency-cruiser rules that fail open for new modules. hume-demo added it to both aggregates; iris did not.
2. **`security:audit` leaves `check`.** `.github/workflows/code-quality.yml` already runs it as its own job. Keeping a network-dependent, date-sensitive check in the agent's inner loop means the loop is nondeterministic and currently always-failing.
3. **`check:ci` becomes an alias of `check`.** They have already diverged three ways (`check:ci` silently omits `architecture:graph:check` and `semgrep`; `check` omits nothing). Two hand-maintained lists of the same thing is the drift generator; `scripts/task-verify.mjs:10-12` already branches on `process.env.CI` to pick between them, so the branch can stay while the target collapses.
4. **CI invokes the aggregate.** `.github/workflows/code-quality.yml:56` currently runs `pnpm exec run-p -n lint lint:eslint typecheck` and re-lists the remaining checks as separate steps — a third copy of the list. One step calling `pnpm check:ci` means adding a check to `package.json` automatically runs in CI.

Add `tests/security/check-parity.unit.spec.ts` (there is precedent — `tests/security/github-actions-supply-chain.unit.spec.ts` and `tests/security/affected-test-workflow.unit.spec.ts` already assert on workflow content) asserting: every script named in `check` either appears in a workflow or is covered by `pnpm check:ci` being invoked; and `check:fast` ⊆ `check`.

**Effort:** 0.5 day for the script surgery + parity test; the risk-register expiry fix belongs to the friction track.

---

## 9. Slash commands (`.claude/commands/`)

Five files, each ~20–40 lines. These are prompts, not scripts — their value is encoding the *sequence and the escalation rule*, which is what agents get wrong.

### `/check-fast`
```md
---
description: Fast deterministic gate (format, lint, typecheck, depcruise, docs)
allowed-tools: Bash(pnpm check:fast), Bash(pnpm typecheck), Bash(pnpm lint:fix)
---
Run `pnpm check:fast`.

If it fails:
- **format:check** → run `pnpm format:changed`, do not hand-edit whitespace.
- **depcruise** → read the rule name in the output and find it in
  `.dependency-cruiser.cjs`. Fix the import, never the rule. If the rule
  looks wrong, stop and say so — do not widen it.
- **check:docs** → a doc asserts something the code contradicts. Fix the
  doc, or fix the code if the doc was right. `--fix` only updates counts.
- **typecheck** → fix types; never `as any`, never `@ts-expect-error`
  (`.semgrep.yml` bans `as` casts outside tests).

Do not escalate to `pnpm check` or `pnpm test` from this command.
```

### `/new-module <name>`
Runs `pnpm gen:module <name>` (proposed in the friction track) and then walks the residue the generator cannot do, with the *specific* file list measured from the repo:

```md
After `pnpm gen:module $ARGUMENTS`, verify and complete by hand:
1. `src/composition/$ARGUMENTS.ts` uses `createCachedFactory`; overrides merged with `??`.
2. `src/composition/index.ts` — 5 edit sites (re-export block, import block,
   `ServicesOverrides`, both branches of `getServices`).
3. i18n: 4 new `src/app/i18n/{ar,en,fr,sw}/$ARGUMENTS.json` + 2 edits per locale barrel.
   Skip entirely if the module has no user-facing copy — say so explicitly.
4. Drizzle schema + `pnpm db:generate`. Never edit `drizzle/migrations/*.sql`.
5. `CONTEXT.md` — add this capability's domain terms.
6. Do NOT add the module name to `.dependency-cruiser.cjs`, `sheriff.config.ts`,
   `.semgrep.yml`, or `.github/workflows/mutation-testing.yml`. Those must be
   wildcards. If a rule requires a literal name, that rule is a bug — report it.
7. Run `/check-fast`, then `pnpm test:affected`.
```

### `/port-from-app <path-or-topic>`
This is the command that directly serves the user's premise (b) — the template falling behind its forks. It is genuinely useful because both apps are on disk in every session:

```md
Port a practice from a downstream app into this template.

1. Locate the app-side implementation. Sibling checkouts:
   `/home/user/hume-demo`, `/home/user/iris-insights-crm`.
2. `git log -S<symbol> --oneline -- <path>` in the app. **Read the commit body** —
   these repos put the measurement and the failure mode in the message
   (e.g. iris `9fcb5c1` documents the module-scope ZodError outage;
   hume `7522ddc` documents the 399px/414px scrollbar flake).
3. `diff` the app file against the template's copy. State what changed and why.
4. Port the *rationale comment* with the code. In both apps, the comment is
   the durable artifact — see `src/platform/telemetry/runtime.ts` in iris.
5. Add the regression test the app added, or write one if it did not.
6. If the practice appears in BOTH apps independently, say so — that is the
   strongest adoption signal.
7. If it changes a public signature (e.g. `unwrapApplicationResult` gaining a
   logger param), note the fork-breaking impact before writing code.
```

### `/adr [topic]`
```md
Read `docs/adr/ADR-FORMAT.md`. Confirm all three tests hold (hard to reverse /
surprising / real trade-off) before writing anything — if one fails, say which
and stop. Scan `docs/adr/` for the highest number, increment. Write
`docs/adr/NNNN-<kebab-slug>.md`. Then check whether the decision changes a term
in `CONTEXT.md` or a claim in `AGENTS.md`; update those in the same change.
```

### `/verify-task [--visual|--e2e-chromium|--build]`
Thin wrapper over the existing `scripts/task-verify.mjs`, adding the escalation rule from AGENTS.md that agents skip: `--e2e-chromium` when auth/routing/session/persistence/upload is touched, `--visual` for UI, `--build` for production-runtime risk. Reports live under `test-results/task-verification/<timestamp>/` (gitignored at `.gitignore:55`).

**Effort:** 1 day for all five.

---

## 10. Subagents (`.claude/agents/`)

Three, each bound to machinery that already exists so their findings are checkable rather than vibes.

### `architecture-guardrail.md`
```md
---
name: architecture-guardrail
description: Review a diff against the modular-monolith boundaries. Use after
  any change touching src/modules, src/platform, src/composition, or src/routes.
tools: Read, Grep, Glob, Bash(pnpm depcruise:*), Bash(pnpm lint:sheriff),
  Bash(pnpm architecture:graph:check), Bash(pnpm vitest run --project=unit tests/architecture:*)
model: sonnet
---
Authoritative: `AGENTS.md` (Public Gates, Module Rules, Common Guardrails),
`.claude/rules/architecture.md`, `.claude/rules/modules.md`.

Run, in order: `pnpm depcruise`, `pnpm lint:sheriff`,
`pnpm vitest run --project=unit tests/architecture`.

Then check by reading, because tooling does not cover these:

1. **Cross-module imports** go through `index.ts` / `server.ts` / `backend.ts` /
   `client.ts` / `presentation.ts` / `testing.ts` only. `kernel` internals are
   the exception.
2. **Hardcoded module names in guardrail configs.** Grep
   `.dependency-cruiser.cjs`, `sheriff.config.ts`, `.semgrep.yml`,
   `.github/workflows/mutation-testing.yml`, and
   `tests/architecture/modular-monolith.unit.spec.ts` for literal module names.
   Every one that is not a directory under `src/modules/` is a finding, and every
   allowlist that should be a `([^/]+)` backreference is a finding.
3. **Named waivers.** Any `pathNot:` naming a single file is a finding.
4. **`src/platform` importing `modules`/`routes`/`composition`** — and the
   inverse smell: a definition *duplicated* into platform to dodge the rule
   (`isProd` in `src/platform/env/config.ts:18-21` vs `isProdRuntimeEnvironment`
   in `src/modules/kernel/infrastructure/config/env-schema.ts:48-57`). If a
   duplicate is unavoidable, demand a test pinning both to the same truth table.
5. **Module-scope side effects in files reachable from the SSR bundle** — top-level
   `envClient.X` reads, eagerly constructed clients. This took down every route
   in iris (`9fcb5c1`).

Report file:line and the rule name. Never propose relaxing a guardrail.
```

### `security-reviewer.md`
```md
---
name: security-reviewer
description: Security review bound to this repo's risk register and rule set.
tools: Read, Grep, Glob, Bash(pnpm semgrep), Bash(pnpm security:tanstack),
  Bash(pnpm security:licenses), Bash(pnpm vitest run --project=unit tests/security:*)
model: sonnet
---
Authoritative: `docs/security-risk-register.md`, `.semgrep.yml`,
`tests/security/**`, `docs/security-upload.md`, `.github/codeql/`.

Run `pnpm semgrep`, `pnpm security:tanstack`, and `pnpm vitest run --project=unit tests/security`.

Checklist beyond the scanners:
- **Middleware chain** (`src/start.ts`). It REPLACES framework defaults. CSRF,
  security headers, browser-mutation guard, and the body-limit must all stay
  registered. A middleware must never replace `result.response` with a new
  `Response` object — that breaks the SSR stream/dispose contract.
- **Error redaction.** `src/modules/kernel/transport/tanstack/result-mapper.ts`
  is the sanitization boundary. Any path that rethrows a non-`AppError` raw is a
  finding.
- **Rate limiting.** `getClientIp(...) ?? 'unknown'` is banned — unattributed
  traffic gets its own coarse bucket, never the strict per-IP one.
- **Config.** Server-only vars must never be `VITE_`-prefixed. Production
  predicates must treat `NODE_ENV=staging` as production.
- **Accepting a risk** means a row in `docs/security-risk-register.md` with a
  future review date AND a matching `osv-scanner.toml` / CodeQL baseline entry —
  never a suppression comment alone.
- **Never widen `.semgrep.yml` paths to silence a finding.**
```

### `test-layering.md`
```md
---
name: test-layering
description: Check that new/changed tests are at the right layer and would fail
  for the right reason. Use when a change adds or moves tests.
tools: Read, Grep, Glob, Bash(pnpm check:test-layering), Bash(pnpm test:affected:list),
  Bash(pnpm vitest run:*)
model: sonnet
---
Authoritative: `TESTING.md`, `scripts/check-test-layering.mjs`,
`.claude/rules/testing.md`.

Run `pnpm check:test-layering` and `pnpm test:affected:list`.

Then judge:
- Cheapest layer that proves the behaviour. A unit test with a mocked `db` does
  not prove SQL serialization — that needs `tests/integration/**` against PGlite.
- Public gates only in `tests/integration/**/*.workflow.integration.test.ts`.
- **Does the test fail without the fix?** State how you know. Assertions on mock
  call arguments where a return value is observable are a finding.
- Missing regression test for a fixed defect is a finding — name the file it
  should live in.
- Flake risk: layout-dependent browser assertions, real timers, ordering
  assumptions across parallel projects.
```

**Effort:** 1 day.

---

## 11. Skills

hume-demo vendored three skills into `.agents/skills/` with `skills-lock.json`; iris shipped the lockfile without the files. The template should settle both the location and the integrity question.

**Recommended split:**

| Location | Contents | Why |
|---|---|---|
| `.agents/skills/` + `skills-lock.json` | **Vendored third-party** skills. Port hume-demo's three verbatim: `domain-modeling` (with `ADR-FORMAT.md`, `CONTEXT-FORMAT.md`, `agents/openai.yaml`), `grilling`, `grill-with-docs`. | Tool-neutral directory; the `agents/openai.yaml` sidecars show these are intended to be read by more than Claude Code. This is what one fork actually did. |
| `.claude/skills/` | **Repo-authored** skills that are too long for a slash command: `guardrail-triage` (map a depcruise/Sheriff/Semgrep rule name → what it means → the legal fixes), `module-anatomy` (walk of a full module with gate contents), `telemetry-and-config` (the env/isProd/OTel invariants). | These are Claude-Code-specific, template-owned, and change with the repo. Keeping them out of `.agents/` keeps `skills-lock.json` purely third-party. |

Why `domain-modeling` in particular earns its place: **iris's `CONTEXT.md` follows `CONTEXT-FORMAT.md` exactly** — 14 `_Avoid_` entries, grouped under `## Workspace` / `## Relationships` — while hume-demo's is a flat bullet list with one `_Avoid_`. The skill demonstrably produced the better artifact, and it is the only thing in either repo that explains ADR numbering. `grilling` earns it for a different reason: it forces decisions to the human one at a time, which is exactly the discipline this repo's architecture requires (a mis-chosen module boundary costs a dozen files).

**`scripts/check-skills-lock.mjs`** (new, wired into `check`) — the integrity check iris needed:

```
For each entry in skills-lock.json:
  1. `.agents/skills/<name>/SKILL.md` must exist.       ← iris fails 14/14 today
  2. Its front-matter `name:` must equal the key.
  3. Its sha256 must equal the entry's `vendoredSha256`.
Every directory under .agents/skills/ must have a lock entry.
```

**Important caveat, verified:** do *not* try to reproduce the upstream `computedHash`. hume-demo's locked `domain-modeling` hash is `363cb0f5…` while `sha256sum .agents/skills/domain-modeling/SKILL.md` is `e760d29f…` — the upstream tool hashes something else (bundle or upstream path). So the template adds its own `vendoredSha256` field, written by `pnpm skills:lock`, and leaves `computedHash` alone as upstream-owned.

**Decision for the owner:** whether to vendor the video/`hyperframes` family iris locked. **Recommendation: no** — 12 of iris's 14 entries are `heygen-com/hyperframes` skills for video generation, entirely unrelated to this stack. They are evidence that `skills-lock.json` accumulated globally-installed skills rather than being curated. The template should ship three, and `check-skills-lock.mjs` should make orphans loud.

**Effort:** 0.5 day vendoring + 0.5 day for the check; 1.5 days if the three repo-authored skills are written now (they can wait).

---

## 12. `.mcp.json`

None of the three repos has one. Keep it minimal and honest — an MCP server that needs credentials the fork does not have is worse than none.

```jsonc
{
  "mcpServers": {
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": { "GITHUB_PERSONAL_ACCESS_TOKEN": "${GITHUB_TOKEN}" }
    },
    "postgres-local": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-postgres",
               "postgresql://startui:startui@localhost:5432/startui"],
      "//": "Local docker-compose database only. Read-only introspection for schema questions. Never point this at a deployed database."
    }
  }
}
```

Two servers, both grounded: `docker-compose.yml` really does run postgres locally, and `gh` is already used by the workflows. **Deliberately excluded:** anything touching Sentry, Vercel, or the OTel collector — those carry production credentials, and the template's own posture (`scripts/validate-server-config.ts` at build time, `detect-secrets` in CI) is that production secrets do not live in the repo.

Document in README that `.mcp.json` is opt-in per developer and `${GITHUB_TOKEN}` must come from the environment, not `.env`.

**Decision for the owner:** ship `.mcp.json` at all, or ship `.mcp.json.example`? **Recommendation: ship the real file** with only these two servers — both degrade gracefully (github fails auth, postgres fails to connect) and neither can leak anything.

**Effort:** 2h.

---

## 13. Cross-agent files and `AGENTS.md` nesting

### 13.1 Generated pointer files

Do **not** hand-maintain parallel instruction files — that is the drift generator this whole track exists to kill. Generate thin pointers from `AGENTS.md` + `CLAUDE.md`:

`.github/copilot-instructions.md`:
```md
<!-- GENERATED by `pnpm gen:agent-docs` — do not edit. Source: AGENTS.md -->
This repository is a strict modular monolith with hexagonal boundaries.
Read `AGENTS.md` before proposing code; it is normative.
Hard rules Copilot must not violate:
- Cross-module imports go only through index.ts / server.ts / backend.ts /
  client.ts / presentation.ts / testing.ts.
- `src/platform` must not import `modules`, `routes`, or `composition`.
- Expected business outcomes are tagged `Result.Ok`; failures are `Result.Error(AppError)`.
- Never `new Date()` outside clock adapters, tests, scripts, and boundary mapping.
- Files under `drizzle/migrations/` are immutable.
```

`.cursor/rules/00-architecture.mdc` — same body with Cursor front-matter (`alwaysApply: true`, `globs: ["src/**"]`).

`.zed/settings.example.json` already exists (Tailwind LSP config only); leave it — Zed reads `AGENTS.md` natively, so no extra file is warranted.

`pnpm gen:agent-docs` extracts the "Common Guardrails" and "Public Gates" sections from `AGENTS.md` between markers and rewrites both files; `--check` fails when stale, wired into `check:docs`. This is Tier 3 of the drift mechanism applied to a second target.

### 13.2 Nested `AGENTS.md`

Neither app nested. This is where the template can genuinely lead, because its top-level `AGENTS.md` is 147 lines covering five roots, and an agent editing `src/composition/auth.ts` needs ~12 of them.

Ship five nested files, ~15–25 lines each, each opening with `Parent: ../AGENTS.md` and containing **only what is not derivable from the parent**:

| File | Content that is not in the root AGENTS.md |
|---|---|
| `src/modules/AGENTS.md` | The gate-file table with *what belongs in each*; the layer table; the "add gates only when needed" rule; the `factory.ts` convention |
| `src/composition/AGENTS.md` | `createCachedFactory` contract: no overrides → cached singleton, any override → fresh instance, each dep merged with `??`; the `__reset*Composition()` test hook; the "module internals must never import `@/composition`" inverse |
| `src/platform/AGENTS.md` | No business imports, ever. Where a duplicate-by-necessity is allowed and the test that must accompany it. Telemetry must never change request behaviour |
| `src/routes/AGENTS.md` | Thin routes; `validateSearch` + `loaderDeps` when reading search params; query keys carry the same normalized values; server fns re-check auth independently of `beforeLoad` |
| `tests/AGENTS.md` | The layer map + the file-naming patterns `scripts/affected-tests.ts` matches (`RUNNABLE_TEST_FILE_PATTERN` at line 26); why `tests/setup.*.ts` and `vitest.config.ts` are `GLOBAL_CONFIG_FILES` |
| `drizzle/AGENTS.md` | Migrations immutable; `pnpm db:generate` only; `pnpm check:migrations` |

Add a Tier-2 assertion to each (`<!-- assert: file-exists ../AGENTS.md -->`) and a coverage test asserting every directory in that list has one.

**Effort:** 1 day for the six nested files + the generator.

---

## 14. Complete proposed tree

```
CLAUDE.md                                   NEW   ~85 lines
CONTEXT.md                                  NEW   ~25 lines (stub + format rules)
AGENTS.md                                   EDIT  add doc-drift assertions, generated command block
README.md                                   EDIT  (friction track) + link CLAUDE.md/CONTEXT.md/docs/adr

.claude/settings.json                       EDIT  +permissions, +hooks
.claude/settings.local.json.example          NEW
.claude/rules/architecture.md                EDIT  add "no literal module names in guardrails"
.claude/rules/modules.md                     KEEP
.claude/rules/testing.md                     REWRITE — currently about Prisma
.claude/rules/guardrails.md                  NEW
.claude/hooks/format-file.sh                 NEW   PostToolUse
.claude/hooks/stop-gate.sh                   NEW   Stop
.claude/hooks/session-start.sh               NEW   SessionStart
.claude/commands/{check-fast,new-module,port-from-app,adr,verify-task}.md   NEW
.claude/agents/{architecture-guardrail,security-reviewer,test-layering}.md  NEW
.claude/skills/{guardrail-triage,module-anatomy,telemetry-and-config}/SKILL.md  NEW (phase 4)

.agents/skills/domain-modeling/{SKILL.md,ADR-FORMAT.md,CONTEXT-FORMAT.md,agents/openai.yaml}  VENDOR
.agents/skills/grilling/…                    VENDOR
.agents/skills/grill-with-docs/…             VENDOR
skills-lock.json                             NEW   3 entries + vendoredSha256

.mcp.json                                    NEW   github + local postgres

docs/adr/README.md                           NEW
docs/adr/ADR-FORMAT.md                       NEW
docs/adr/000{1..4}-*.md                      NEW   seed decisions
docs/adding-a-module.md                      NEW   (shared with friction track)
docs/security practices.md                   REWRITE or DELETE — see §9 decision

src/{modules,composition,platform,routes}/AGENTS.md   NEW
tests/AGENTS.md, drizzle/AGENTS.md                    NEW

scripts/check-doc-drift.mjs                  NEW   ~250 lines, no new deps
scripts/check-skills-lock.mjs                NEW   ~60 lines
scripts/bootstrap.mjs                        NEW   ~180 lines
scripts/gen-agent-docs.mjs                   NEW   ~80 lines
scripts/doc-command-descriptions.json        NEW
tests/architecture/doc-drift.unit.spec.ts    NEW
tests/security/check-parity.unit.spec.ts     NEW

.github/copilot-instructions.md              GENERATED
.cursor/rules/00-architecture.mdc            GENERATED
```

---

## 15. Effort and sequencing

| # | Item | Effort | Depends on | Kind |
|---|---|---|---|---|
| **Wave 1 — stop the bleeding (≈3 days)** | | | | |
| 1.1 | Rewrite `.claude/rules/testing.md`; add `guardrails.md` | 1h | — | defect |
| 1.2 | `scripts/bootstrap.mjs` + `pnpm setup` (fixes the AUTH_SECRET first-run block) | 1d | — | defect |
| 1.3 | `.claude/settings.json` permissions | 2h | — | missing |
| 1.4 | Tiered gates: `check:fast`, `lint:sheriff` into `check`, `security:audit` out, `check:ci` → alias | 0.5d | — | defect |
| 1.5 | `CLAUDE.md` | 3h | 1.4 (gate table) | missing (both apps) |
| **Wave 2 — the drift defense (≈3 days)** | | | | |
| 2.1 | `scripts/check-doc-drift.mjs` Tiers 1+2 | 1.5d | — | missing (both apps' workaround) |
| 2.2 | Tier 3 generated command blocks + `scripts/gen-agent-docs.mjs` | 0.5d | 2.1 | missing |
| 2.3 | Annotate AGENTS.md / TESTING.md / README / docs; **triage `docs/security practices.md`** | 0.5d | 2.1 | defect |
| 2.4 | `tests/architecture/doc-drift.unit.spec.ts` + `tests/security/check-parity.unit.spec.ts` | 0.5d | 2.1, 1.4 | missing |
| **Wave 3 — the loop (≈3 days)** | | | | |
| 3.1 | Three hooks | 1d | 1.2 | missing |
| 3.2 | Five slash commands | 1d | 1.4, §16 gen:module | missing |
| 3.3 | Three subagents | 1d | 1.4 | missing |
| **Wave 4 — knowledge (≈3 days)** | | | | |
| 4.1 | `CONTEXT.md` stub + format | 1h | — | missing (both apps) |
| 4.2 | `docs/adr/` + `ADR-FORMAT.md` + 4 seed ADRs | 0.5d | — | missing (APP1) |
| 4.3 | Vendor 3 skills + `skills-lock.json` + `check-skills-lock.mjs` | 1d | — | missing (APP1, half-APP2) |
| 4.4 | Six nested `AGENTS.md` | 1d | 2.2 | modernization |
| 4.5 | `.mcp.json` + generated cross-agent files | 0.5d | 2.2 | modernization |
| 4.6 | Three repo-authored `.claude/skills/` | 1.5d | 3.3 | modernization |

**Total ≈ 12 working days**, of which Waves 1–2 (6 days) carry most of the value. Wave 1 is independently shippable and unblocks the friction track's own work (a template that does not start is a bad place to test fixes).

---

## 16. Coupling to the other tracks

Three items here are load-bearing for the friction track and should be sequenced jointly rather than duplicated:

- **`pnpm gen:module`** — `/new-module` degrades to a pure checklist without it. Friction track owns the generator; this track owns the prompt.
- **The wildcard rewrite of `.dependency-cruiser.cjs` / `sheriff.config.ts` / `.semgrep.yml` / `mutation-testing.yml`** — the `architecture-guardrail` subagent's check #2 and `.claude/rules/guardrails.md` both assume this landed. If it has not, the subagent will report the template's own configs as findings on day one (arguably correct, but noisy).
- **`docs/security-risk-register.md` expiry** — until the dates move, `pnpm check` is red on a fresh clone, and no gate ladder is credible. Moving `security:audit` out of `check` (item 1.4) is a mitigation, not the fix.

---

## 17. Decisions I want the repo owner to make

| # | Decision | My recommendation | Confidence |
|---|---|---|---|
| 1 | **`docs/security practices.md`: repair or delete?** It is 93 lines describing a different application — Stripe/Twilio/Attio/MongoDB confinement, Biome, Pushover, Octoscan, `db-migrate.yml`, "51 rules / 123 rules" (actual 57/101), and a claim that Sheriff runs in CI when it runs nowhere. Perhaps 20 lines are salvageable. | **Delete it.** Fold the accurate parts into `AGENTS.md` (guardrail stack) and `docs/security-risk-register.md` (which is already the file it defers to at its own line 3). It is currently the single largest source of false agent context in the repo. | high |
| 2 | **Blocking Stop hook or advisory?** | **Blocking**, with `stop_hook_active` + the `>40 affected files` bail-out + `CLAUDE_SKIP_STOP_GATE=1`. The repo's failure mode is silent regressions, not over-caution. | medium |
| 3 | **`security:audit` out of `pnpm check`?** It is the only network-dependent, date-sensitive member, and CI already runs it as a dedicated job. Removing it makes the local gate deterministic and offline — but a fork that never opens CI loses the advisory signal locally. | **Remove it from `check`; add it to `verify`.** Deterministic inner loop, still gated pre-merge. | high |
| 4 | **`.claude/skills/` vs `.agents/skills/`** | **Both, with a rule**: `.agents/` for vendored third-party + lockfile, `.claude/` for repo-authored. Enforced by `check-skills-lock.mjs`. | medium |
| 5 | **Vendor all 14 skills iris locked?** | **No** — three. Twelve are `heygen-com/hyperframes` video skills with no relation to this stack; their presence in iris's lockfile looks like accidental capture of a global install. | high |
| 6 | **Ship `.mcp.json` or `.mcp.json.example`?** | **Real file**, two servers only (github via `${GITHUB_TOKEN}`, local docker postgres). Both fail closed and neither can leak. | medium |
| 7 | **Nested `AGENTS.md` (6 files) — worth the surface?** Neither app did it, so there is no downstream evidence it is needed. | **Yes, but Wave 4.** It is the one proposal here with no fork corroboration; if effort is tight, cut this before anything else. | low |
| 8 | **`ADR-FORMAT.md` in `docs/adr/` or inside the vendored skill?** | **`docs/adr/`.** The template's house format (Status/Date/Context/Decision/Consequences, as hume-demo actually writes them) diverges from the skill's one-paragraph minimum, and editing a vendored file breaks the lock. | high |
| 9 | **Does `check:docs` block CI on day one?** It will find dozens of violations across README, AGENTS.md, and docs/. | **Ship the script and the annotations in the same PR** so `check` is green at merge. Do not ship a warn-only mode — a non-blocking drift check is exactly the class of guardrail that rots (see `lint:sheriff`). | high |

---

## 18. What breaks

- **Deleting `docs/security practices.md`** breaks a reference in `docs/security-risk-register.md` and the `.secrets.baseline` entry keyed on its path. Both are one-line updates; `check:docs` Tier 1 will catch the dangling reference automatically once the file is gone.
- **`check:ci` becoming an alias of `check`** adds `architecture:graph:check` and `semgrep` to CI. `architecture:graph:check` needs graphviz (`resolveTrustedTool('dot')`) — verify the CI image has it, or the job fails on a non-code change. `semgrep` already has its own workflow, so it will run twice until that workflow is removed.
- **Adding `lint:sheriff` to `check`** will likely surface an existing violation backlog — Sheriff has never run. Budget half a day for triage; the corpus notes `sheriff.config.ts:113-119` layer targets are already generic, so the backlog should be the two hardcoded matchers at `:44,47` rather than real boundary breaks. **Low confidence** on the backlog size — I could not execute Sheriff (no `node_modules` in any checkout).
- **`.claude/settings.json` deny-list on `git checkout -b`** will surprise anyone whose workflow depends on branching. Documented in `CLAUDE.md`; overridable in `settings.local.json`.
- **Stop hook** adds latency to every turn that touched `src/`. The `--json` pre-count keeps it bounded, but on a cold cache the first `tsx scripts/affected-tests.ts` run costs a few seconds regardless.
