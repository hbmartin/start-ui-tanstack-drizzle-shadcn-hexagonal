<!-- Appendix C of the template improvement audit. See ./REPORT.md for the synthesis. -->

# Track: Runtime, Security, and Configuration Hardening

**Scope.** Defects and over-strict policies in `src/platform`, `src/composition`, `src/modules/kernel/infrastructure/config`, `src/start.ts`, `src/server.ts`, and the tooling that gates them. Every item below was re-read on disk in `/home/user/start-ui-tanstack-drizzle-shadcn-hexagonal` at HEAD; app-side fixes were re-derived from `git show` in the two forks rather than taken from the corpus.

**Headline.** The template's runtime layer has three distinct failure classes, and they need different remedies:

| Class | Count | Remedy shape |
|---|---|---|
| **Real defects** — code that is wrong on its own terms (SSR stream substitution, unguarded telemetry, unbounded fetch, raw rethrow, exit-code loss) | 13 | Port the app fix + regression test + guardrail |
| **Over-strict defaults** — correct security policy, wrong for a starter's first hour (sslmode `verify-*`, mandatory OTEL, expiring risk register, `AUTH_SECRET` placeholder) | 4 | Make the *policy* configurable with an explicit knob, keep the *strict mode* documented and one env var away |
| **Split-brain duplication** — the same concept implemented twice and already diverged (`isProd`, `runtimeEnv`, request-host diagnostics) | 3 | Single definition or a test that pins the two to one truth table |

The over-strict class is what iris hit on day one: its very first non-merge branch is literally named `relax-db-tls-check-for-demo` (`git log` → `8d73dfe Merge pull request #1 from hbmartin/relax-db-tls-check-for-demo`). A template whose first PR in every fork is "turn off the security check" has mis-set its defaults — but the answer is *not* to delete the check, which is what iris did.

---

## 1. Severity-ordered fix list

| # | Severity | Item | File | Effort |
|---|---|---|---|---|
| R1 | **critical** | CSP nonce rewrite replaces the SSR `Response` inside request middleware | `src/start.ts:152-167`, `src/server.ts:24` | M |
| R2 | **critical** | Better Auth client reads `envClient.VITE_BASE_URL` at module scope in the SSR bundle | `src/modules/auth/presentation/better-auth-client.ts:25-29` | S |
| R3 | **critical** | `runtimeEnv()` spreads frozen build-time `import.meta.env` *after* `process.env` (two copies) | `src/platform/env/config.ts:11-14`, `src/modules/kernel/infrastructure/config/env-schema.ts:9-12` | S |
| R4 | **critical** | No server-side canonical origin; `getBaseUrl` keys on `VITE_VERCEL_*` that nothing sets; `VITE_BASE_URL` required | `src/platform/env/config.ts:30-47` | L |
| R5 | **critical** | `pnpm check` fails on a fresh clone — every risk-register advisory expired 2026-07-23 | `docs/security-risk-register.md`, `scripts/check-risk-register.mjs:61-75` | S |
| R6 | **high** | `pnpm env:client` validates nothing (runs a file that re-exports a lazy Proxy) | `package.json:41`, `src/platform/env/client.ts` | XS |
| R7 | **high** | `isProd()` in platform disagrees with `isProdRuntimeEnvironment` on `NODE_ENV=staging` | `src/platform/env/config.ts:18-21` | XS |
| R8 | **high** | `OTEL_COLLECTOR_URL` mandatory in prod; the graceful path is a silent no-op | `src/modules/kernel/infrastructure/config/telemetry.ts:84-87`; `.github/workflows/code-quality.yml:362` | M |
| R9 | **high** | `telemetryProxy` is bare delegation — an exporter throw reaches the security middleware that emitted the metric | `src/platform/telemetry/runtime.ts:12-21` | S |
| R10 | **high** | Telemetry proxy forwards to collector and Sentry with no timeout, no abort signal, no try/catch | `src/composition/telemetry/transport.ts:246-253, 290-294` | S |
| R11 | **high** | Rate limiting has no policy for "no trustworthy client IP": one call site fails shared, one fails fully open, and the doc they cite doesn't exist | `src/composition/telemetry/transport.ts:143-156`, `src/modules/email/transport/http/resend-webhook-handlers.ts:267-269` | M |
| R12 | **high** | No `TOO_MANY_REQUESTS` in the server-fn transport; `rate_limit` → HTTP 400 | `src/modules/kernel/transport/tanstack/result-mapper.ts:25`, `server-fn-error.ts:5-13` | XS |
| R13 | **high** | `mapAppErrorToServerFnError` rethrows non-`AppError` raw, and logs nothing on either path | `src/modules/kernel/transport/tanstack/result-mapper.ts:66`, `:88-115` | S |
| R14 | **high** | PGlite teardown discards the suite's exit code — `pnpm test`/`pnpm verify` exit 0 with failing tests | `tests/server/pglite-global-setup.ts:55-58` | XS |
| R15 | **high** (over-strict) | `assertDatabaseUrlTls` requires `sslmode=verify-ca\|verify-full`, rejecting essentially every hosted Postgres URL — and `.env.example:52` contradicts it | `src/modules/kernel/infrastructure/config/url-security.ts:125-132` | S |
| R16 | **medium** | First run fails: `.env.example:61` ships an `AUTH_SECRET` the validator rejects twice | `.env.example:61` | XS |
| R17 | **medium** | Module dependency graph omits every `import type` (21 missing edges; legend describes an unreachable branch) | `scripts/generate-module-dependency-graph.ts:476-479` | XS |
| R18 | **medium** | Pre-commit hook fails on any docs-only commit | `scripts/format-changed.mjs:7-17`, `lefthook.yml:6` | XS |
| R19 | **medium** | `sanitize-log-fields` redacts scoped-package stack frames and `sdk.name`; no recursion depth bound | `src/platform/lib/redaction/sanitize-log-fields.ts:15, 20-33, 96-98` | S |
| R20 | **medium** | CI writes generated credentials to `$GITHUB_ENV` with no `::add-mask::`, then uploads the build log as an artifact | `.github/workflows/code-quality.yml:355-368` | XS |
| R21 | **medium** | Better Auth adapter deep-imports kernel internals; three symbols are exported from no gate at all | `src/modules/auth/infrastructure/better-auth/auth.tsx` | S |
| R22 | **medium** | `scopedListQueryOptions` and `scopedEntityQueryOptions` build identical query keys | `src/platform/lib/tanstack-query/scoped-query-options.ts:36, 86` | XS |
| R23 | **low** | Brand-coupled constants + a CSP test whose slice offsets only work for a 22-char placeholder | `src/platform/http/csp-nonce.ts:1`, `tests/unit/platform/http/security-headers.unit.spec.ts:271-273` | S |
| R24 | **low** | Suppression / `as unknown as` hotspots, several with no justification comment | 34 sites; see §R24 | S |

---

## 2. Detailed fixes

### R1 — CSP nonce rewrite breaks TanStack Start's SSR stream contract

**Current** (`src/start.ts:152-167`, verified verbatim today):

```ts
export const securityHeadersMiddleware = createMiddleware({ type: 'request' })
  .server(async ({ context, next }) => {
    const cspNonce = createCspNonce();
    const nextContext = mergeRequestContext(context, { cspNonce });
    const result = await next({ context: nextContext });
    const response = applyAppSecurityHeaders(
      await replaceCspNoncePlaceholderInHtmlResponse(result.response, cspNonce),
      nextContext
    );
    return { ...result, response };   // ← new Response, original lifecycle handles
  });
```

`replaceCspNoncePlaceholderInHtmlResponse` (`src/platform/http/csp-nonce.ts:105-109`) returns `new Response(body.pipeThrough(transformStream), {...})`. The middleware then spreads `{...result}` — which still carries the router's SSR cleanup handles pointing at the *original* response whose body is now locked by the transform. `src/server.ts` uses the stock `handler.fetch(request, { context })` (line 24), so there is no stream handler where the contract could be honoured.

**Failure mode.** APP1 hit this as an SSR serialization hang — the PR branch is named for it (`git log --oneline --all --grep='ssr-serialization'` → `921ec0e Merge pull request #23 from hbmartin/codex/fix-ssr-serialization-timeout`). APP1 fixed it properly in `907a42f`, then **deleted the entire CSP subsystem 40 minutes later** in `479cb2e` and has shipped with `response.headers.delete('Content-Security-Policy')` for three weeks. APP2 still carries the template's version unmodified — a latent landmine. A template that makes one fork abandon CSP entirely has a defect, not a preference.

**Proposed change.** Port `907a42f` verbatim. Three parts:

1. `src/platform/http/csp-nonce-server.ts` — add the SSR-aware wrapper (this is APP1's actual code, read from the diff):

```ts
import {
  type HandlerCallbackResult,
  normalizeSsrResponse,
  type SsrResponse,
} from '@tanstack/react-router/ssr/server';
import { randomBytes } from 'node:crypto';

import { replaceCspNoncePlaceholderInHtmlResponse } from './csp-nonce';

export const createCspNonce = () => randomBytes(18).toString('base64');

export async function replaceCspNoncePlaceholderInSsrResponse(
  result: HandlerCallbackResult,
  nonce: string
): Promise<SsrResponse> {
  const ssrResponse = normalizeSsrResponse(result);
  const response = await replaceCspNoncePlaceholderInHtmlResponse(
    ssrResponse.response,
    nonce
  );

  if (response === ssrResponse.response) return ssrResponse;
  if (ssrResponse.serverSsrCleanup === 'none') {
    return { response, serverSsrCleanup: 'none' };
  }

  let disposed = false;
  return {
    response,
    serverSsrCleanup: 'stream',
    async dispose(reason?: unknown) {
      if (disposed) return;
      disposed = true;
      try {
        await response.body?.cancel(reason);
      } catch {
        // The original disposer still releases the router's SSR state.
      }
      await ssrResponse.dispose(reason);
    },
  };
}
```

2. `src/server.ts` — replace `handler.fetch` with a `createStartHandler(defineHandlerCallback(...))` wrapping `defaultStreamHandler`, reading the nonce from `context.router.options.ssr?.nonce` (which `src/router.tsx:118` already sets).

3. `src/start.ts:158-160` — strip `replaceCspNoncePlaceholderInHtmlResponse` out of `securityHeadersMiddleware` so it only mutates headers.

**Test to add.** APP1's assertion, which is the exact regression guard: `expect(result.response).toBe(originalResponse)` in `tests/unit/start.unit.spec.ts`. **Plus** an integration/e2e test that streams a real SSR page with a nonce and asserts (a) no placeholder survives in the body, (b) the response completes. The unit mocks in the template did not catch this and will not catch a recurrence.

**Guardrail.** A semgrep rule scoped to `src/start.ts` banning `new Response(` and any call whose name matches `/InHtmlResponse$/` inside a `createMiddleware({ type: 'request' })` body. Request middleware may set headers; it may not construct a response body.

**Effort:** M (0.5–1d, most of it the streaming e2e test).

---

### R2 — Better Auth client parses client env at module scope during SSR

**Current** (`src/modules/auth/presentation/better-auth-client.ts:25-29`):

```ts
const betterAuthClient = createAuthClient({
  baseURL: typeof globalThis.window === 'undefined'
    ? envClient.VITE_BASE_URL
    : globalThis.window.location.origin,
  plugins: [...],
});
```

`envClient` is the lazy Zod Proxy (`src/platform/env/config.ts:126-128`), so this top-level property access *is* where the parse happens — on the server, during module evaluation, inside Nitro's `loadEntries`.

**Failure mode.** iris commit `9fcb5c1`: *"A production deploy crashed on every request with a ZodError for an unset VITE_BASE_URL, thrown from the envClient proxy at module scope during Nitro's loadEntries. … one missing field took down every route before request handling began."* Blast radius is the whole app, not the auth feature.

**Proposed change.** iris's memoized factory, plus dropping `envClient` from the file entirely:

```ts
/**
 * Built on first use rather than at module scope. This module is imported into
 * the SSR bundle, so eager construction ran during Nitro's loadEntries — a
 * failure there took down every route before request handling began instead of
 * degrading only the auth feature.
 */
let client: ReturnType<typeof createAuthClient> | undefined;
const getBetterAuthClient = () => (client ??= createAuthClient({
  baseURL: typeof globalThis.window === 'undefined'
    ? undefined
    : globalThis.window.location.origin,
  plugins: [...],
}));
```

`baseURL: undefined` on the server is correct: nothing in the browser-triggered auth surface issues a server-side request from this client.

**Test.** Architecture test: no file under `src/modules/*/presentation/**` may reference `envClient.` outside a function body. Implement with the Oxc AST helper (see R21 note) or a targeted regex over the module-scope statement list.

**Guardrail.** Semgrep rule `no-module-scope-env-client`: `pattern: envClient.$X` with `paths.include: src/modules/*/presentation/**` and a `pattern-not-inside` for arrow/function bodies. Same rule catches `src/start.ts:78-89` — see the owner decision in §4.

**Effort:** S.

---

### R3 — `runtimeEnv()` lets the build artifact override the platform's runtime env

**Current**, two independent copies (kept separate by the platform-must-not-import-modules rule):

```ts
// src/platform/env/config.ts:11-14
const runtimeEnv = (): RuntimeEnv => ({
  ...(typeof process === 'undefined' ? {} : process.env),
  ...import.meta.env,          // ← frozen at build; wins
});
// src/modules/kernel/infrastructure/config/env-schema.ts:9-12 — identical
```

Vite compiles `import.meta.env` into a frozen object literal, so on a build-once/deploy-many pipeline every baked value overrides what the platform injected. This inverts the module's own stated contract.

**Proposed change.** Swap the order in both copies and split the sources so the reason survives:

```ts
/**
 * Vite compiles `import.meta.env` into a frozen object literal at build time.
 * It must therefore be the LOWER-precedence source: a build-once/deploy-many
 * pipeline needs the platform's runtime `process.env` to win, otherwise a value
 * baked at build overrides what the operator set on the deployment.
 */
const buildTimeEnv = (): RuntimeEnv =>
  (import.meta as ImportMeta & { env?: RuntimeEnv }).env ?? {};
const processEnv = (): RuntimeEnv =>
  typeof process === 'undefined' ? {} : process.env;
const runtimeEnv = (): RuntimeEnv => ({ ...buildTimeEnv(), ...processEnv() });
```

Also port iris's `getEnvSourceDrift()` (~8 lines, reports keys whose build-time value disagrees with the runtime value) — it is wired into iris's real `app-url.ts` diagnostics, not dead code, and it converts "I changed it in the dashboard and nothing happened" into one log line.

**Test.** Unit test asserting `process.env` wins for a key present in both, in *both* files.

**Guardrail.** Architecture test asserting the two `runtimeEnv` implementations are token-identical (they must stay duplicated; only a test can keep them in sync).

**Effort:** S. **Note:** two defects the wrong order was masking (iris `6a943d9`): `isTruthy` rejected `'1'`-style values (`VERCEL=1`, `CI=1`), and the localhost fallback keyed off `!isProdRuntimeEnvironment(env)` — true precisely when no platform signals arrive. Fix both in the same change.

---

### R4 — No canonical-origin resolution; the Vercel integration reads variables nothing sets

**Current** (`src/platform/env/config.ts:30-38`):

```ts
const getBaseUrl = (env: RuntimeEnv) => {
  const vercelUrlPreviewUrl =
    env.VITE_VERCEL_ENV === 'preview' ? env.VITE_VERCEL_BRANCH_URL : null;
  if (typeof vercelUrlPreviewUrl === 'string' && vercelUrlPreviewUrl) {
    return `https://${vercelUrlPreviewUrl}`;
  }
  return env.VITE_BASE_URL;
};
```

A repo-wide grep for `VITE_VERCEL_ENV|VITE_VERCEL_BRANCH_URL|VERCEL_URL|VERCEL_PROJECT_PRODUCTION_URL` returns exactly one hit — line 32 itself. Vercel's system variables are unprefixed; nothing in the template mirrors them, and no doc tells an operator to.

Meanwhile `VITE_BASE_URL` is **required** (`:43-47`, no `.optional()`, no default) and is consumed by three server-only concerns: `src/start.ts:84` (security headers), `src/modules/auth/infrastructure/better-auth/auth.tsx:68` (`allowedHosts`) and `:84` (cookie scoping).

**This is the strongest cross-app signal in the corpus.** Both forks independently replaced it, two weeks apart, with no shared branch: APP1's `src/platform/env/app-url.ts` (26 lines, commit `a1d9dee`) and APP2's `src/modules/kernel/infrastructure/config/app-url.ts` (193 lines, commit `9fcb5c1`).

**Proposed change.** Take APP2's shape — it is the more correct of the two and its docblock states why:

- `APP_URL`, **unprefixed and server-only**. Delete `VITE_BASE_URL` from the client schema; the browser uses `window.location.origin`.
- Precedence, each signal normalized *before* `??` is applied (iris `0adcf25` fixed a follow-up bug where `VERCEL_TARGET_ENV=' '` discarded `VERCEL_ENV='preview'`):
  1. `preview` deployment + `VERCEL_BRANCH_URL` → branch URL (previews must authenticate against the host the browser is actually on)
  2. explicit `APP_URL`
  3. `production` + `VERCEL_PROJECT_PRODUCTION_URL`
  4. custom environment + `VERCEL_BRANCH_URL`
  5. localhost fallback — **requires a positive local signal**, never merely the absence of a production one
- `VERCEL_URL` stays out of the schema deliberately: it changes on every push (silently re-scoping auth cookies) and Vercel documents it as incompatible with Standard Deployment Protection.
- Log the resolved `AppUrlSource` at boot with a non-secret signal snapshot (`APP_URL` reported as presence only).

**Test.** Table-driven unit test over the five sources × `{production, preview, staging, development, unset}`, including the "no platform signals arrived" case asserting a `ConfigurationError` rather than a localhost fallback.

**Guardrail.** Semgrep: ban `VITE_VERCEL_` anywhere. Architecture test: the client env schema contains no key whose value is consumed by `src/start.ts`, `src/modules/auth/infrastructure/**`, or `src/platform/http/security-headers.ts`.

**Effort:** L (3–4d — it touches auth cookie scoping, `allowedHosts`, security headers, `.env.example`, README, and every test that stubs `VITE_BASE_URL`). This is the largest single item in the track and the one with the clearest payback.

---

### R5 — `pnpm check` fails on a fresh clone today

Reproduced first-hand:

```
$ node scripts/check-risk-register.mjs
Risk register policy failed: accepted advisories are past their review date:
  esbuild >= 0.27.3 < 0.28.1   (review was due 2026-07-23)
  protobufjs <= 7.6.2          (review was due 2026-07-23)
  ... 4 more
$ echo $?
1
```

`package.json:132 check` → `:62 security:audit` → `:65 security:risk-register` → `scripts/check-risk-register.mjs:61-75` compares each `Next review` cell against `new Date().toISOString().slice(0,10)` and exits 1 on any past date. Every row in `docs/security-risk-register.md` is dated `2026-07-23`. The template's advertised merge gate has been failing since that date and will fail for every future fork, forever.

**Proposed change — two parts.**

1. Clear the advisories: port iris's caret-range override block into `pnpm-workspace.yaml` and bump `vitest`/`@vitest/browser`/`@vitest/browser-playwright` from 4.1.9 → ≥4.1.10.
2. Make the gate non-fatal-by-default for forks. Change `check-risk-register.mjs` to hard-fail only when an entry is **both** expired **and** still reported by `pnpm audit`; an expired entry for an advisory that no longer resolves is a warning. Ship the register with zero accepted entries so the template's baseline is clean.

Additionally: **remove `security:audit` from `check` and `check:ci`.** `.github/workflows/code-quality.yml:159-176` already runs it as a dedicated job. `pnpm check` should be deterministic and offline; a new upstream advisory should not block every local edit.

**Guardrail.** A unit test on `check-risk-register.mjs` asserting that an expired entry whose advisory is absent from the audit output exits 0, and one present exits 1.

**Effort:** S. **Sequence first** — nothing else in this track can be verified locally until `pnpm check` is green.

---

### R6 — `pnpm env:client` is a no-op

`package.json:41` runs `src/platform/env/client.ts`, whose entire body is `export { envClient } from './config';`. `envClient` is a Proxy whose `get` trap does the parse. Importing it validates nothing. Both `dev` (`:36`) and `build` (`:38`) depend on this gate.

**Fix** (iris's, plus the one-word change iris's five lines do *not* drop in without):

```ts
// scripts/validate-client-config.ts
import { getEnvClient } from '@/platform/env/client';

// `envClient` is a lazy Proxy that only parses on first property access, so
// merely importing it validates nothing. This call is the validation.
getEnvClient();
```

The template's `src/platform/env/client.ts` re-exports only `envClient`; add `getEnvClient` to it. Repoint `package.json:41`.

**Test.** Spawn the script with a deliberately invalid `VITE_*` value; assert non-zero exit. Without this the gate can silently regress to a no-op again — which is exactly how the R2/R4 outage passed `pnpm build` clean.

**Effort:** XS.

---

### R7 — `isProd()` split-brain on `NODE_ENV=staging`

`src/platform/env/config.ts:18-21` returns **false** for `NODE_ENV=staging` even with `PROD=true`. `src/modules/kernel/infrastructure/config/env-schema.ts:49-58` returns **true** for the same input — and carries a doc comment at `:45-48` describing precisely this bug class ("*This prevents the split-brain where a prod build run with `NODE_ENV=staging` kept HSTS on but dropped DB-TLS verification*"). The platform copy is the unfixed instance of the bug the kernel comment warns about.

Blast radius is four call sites, not two: `:45` (`VITE_BASE_URL` HTTPS refine), `:76` (`VITE_S3_BUCKET_PUBLIC_URL`), `:82` (`VITE_SENTRY_DSN` HTTPS), `:91` (`.prefault(isProd() ? 0.1 : 1)` — a staging build also ships a **100% Sentry sample rate**).

The failure shape is the worst possible: every server-side guard stays on, only the client-side URL checks silently stop. The deployment looks hardened.

**Fix.** Replace with the kernel's normalize-then-allowlist semantics (dev/test → false; production → true; otherwise `isTruthy(PROD)`), plus iris's `VERCEL_TARGET_ENV ?? VERCEL_ENV` normalization and the `'1'`-accepting `isTruthy`. Keep iris's comment explaining why the definition is duplicated rather than imported.

**Test.** One truth table pinning **both** predicates across `{production, development, test, staging, preview, unset} × {PROD true, false}`. Fold into the same architecture test as R3.

**Effort:** XS.

---

### R8 — OTEL is mandatory in production, and the graceful path is silent

`src/modules/kernel/infrastructure/config/telemetry.ts:84-87`:

```ts
if (isProduction && !env.OTEL_COLLECTOR_URL) {
  throw new ConfigurationError(
    'OTEL_COLLECTOR_URL is required in production telemetry configuration.'
  );
}
```

…while the schema at `:34-44` marks every `OTEL_*` var `.optional()`. And the template's own CI works around it — `.github/workflows/code-quality.yml:362`:

```bash
printf '%s=%s\n' 'OTEL_COLLECTOR_URL' 'http://localhost:4318'
```

That line is first-party proof the constraint is wrong rather than merely inconvenient: the template injects a fake collector to get its own `pnpm build` past its own check.

**Both apps deleted the same five lines and the same CI line, three weeks apart**, and both concluded that deleting the throw alone is insufficient — the fallthrough in `src/composition/telemetry/otel.server.ts` (`if (!config.collectorUrl) return undefined;`) lands on `createNoOpTelemetry()`, which silently drops every signal.

**Fix.**
1. Delete `:84-87`. Keep the HTTPS-when-set guard immediately below it (`:89-98`).
2. Port APP2's `src/platform/telemetry/console.ts` (`createConsoleTelemetry`, 3904 bytes) — it needs no OTel SDK, which makes it the right template shape. The template's `src/platform/telemetry/` has `frontend-logger.ts, index.ts, metadata.ts, no-op.ts, runtime.ts, tags.ts, types.ts` — no `console.ts`.
3. Select it in composition when **no OpenTelemetry adapter is present**, not merely when no adapters at all are. APP2's rationale: *"the Sentry adapter implements only captureException/setUser, so a DSN-only deploy would otherwise still lose logs and metrics."*
4. Delete `.github/workflows/code-quality.yml:362`.
5. Also port APP1's `installTelemetryShutdownFlush` — `grep -rn 'SIGTERM|beforeExit|forceFlush|shutdown()' --include=*.ts src/` returns **zero hits** in the template, while `otel.server.ts` configures `BatchSpanProcessor`, `BatchLogRecordProcessor` and a `PeriodicExportingMetricReader({ exportIntervalMillis: 30_000 })`. On the serverless target the template ships for, the 30-second window containing the crash is exactly the window that gets dropped. Add `forceFlush?(): Promise<void>` to `TelemetryAdapter`, fan out in `adapter-chain.ts`, and install a `beforeExit`/`SIGTERM`/`SIGINT` handler that is idempotent, `Promise.race`s against a bounded timeout with an `.unref()`ed timer, and falls back to `console.error` (*"a failed flush during shutdown must not mask the original exit reason"*).

**Test.** Boot with no `OTEL_COLLECTOR_URL` and assert (a) no throw, (b) `getTelemetry()` is the console adapter not the no-op, (c) an `emitLog` reaches the console sink. Separately: assert `forceFlush` is called once on `SIGTERM` and that a rejecting flush does not change the exit code.

**Guardrail.** CI job that runs `pnpm build` with *no* `OTEL_*` variables set at all — the config that the current CI line exists to avoid.

**Effort:** M.

---

### R9 — `telemetryProxy` is unguarded delegation

`src/platform/telemetry/runtime.ts:12-21`, read in full — the file is 21 lines and there is no `try` anywhere in it. The proxy is installed into the security spine: `src/start.ts:244-254` registers `telemetryRequestMiddleware`, `securityHeadersMiddleware`, `browserMutationGuardMiddleware`, `csrfMiddleware`.

APP2's commit `994cfb9` enumerates the concrete consequences: *"a `recordMetric` throw in the browser-mutation guard meant the 403 was never built and a rejected cross-origin mutation became a propagating exception; a throwing sink on the auth error path replaced the provider's error with the telemetry one."*

The template already encodes the intent one layer down — `src/composition/telemetry/request-observability.ts:98-104` wraps a single call in `try { … } catch { /* Request telemetry must never change request handling behavior. */ }` — it just never applied it at the choke point that covers all callers. APP1's copy of `runtime.ts` is byte-identical to the template's; this is APP2-only.

**Fix.** Port APP2's `runtime.ts` and `report-failure.ts` verbatim, including both rationale comments. The critical design decision, which is easy to get wrong:

```ts
/**
 * `startSpan`, `startManualSpan` and `currentCorrelation` are deliberately NOT
 * guarded. `startSpan` wraps application code and returns its value, so
 * swallowing there would discard real application errors; the other two return
 * values their callers depend on. Only the void, report-only methods can be
 * safely ignored.
 */
```

`report-failure.ts` reaches the console through `globalThis` with a bracket-accessed method — deliberately, so the module stays outside the `no-console-in-production-source` semgrep rule without an exclusion, and so tests can inject a sink. Otherwise *the one sink that could report the failure is the sink that is failing.*

Also apply APP2's two companion fixes in the same change: wrap `createTelemetryLogger.write()`'s whole body (covers the redactor, console mirror and capture-context building, not just adapter calls), and isolate adapters per-iteration in the chain (a throw from `adapters[0]` currently means `adapters[1]` never receives the event).

Once guarded, the ad-hoc `try/catch` at `request-observability.ts:98-104` can be deleted.

**Test.** A throwing adapter must not propagate out of `emitLog`/`recordMetric`/`captureException`/`setUser`, **and must** propagate out of `startSpan`. Plus APP2's composed-path test: a throwing metrics backend cannot turn an anonymous-session result into a gateway error, exercising the real `telemetryProxy` rather than a mock adapter (which would prove nothing).

**Guardrail.** Semgrep rule requiring every `TelemetryAdapter` void method implementation in `src/platform/telemetry/runtime.ts` to be wrapped in `ignoreFailure`.

**Effort:** S.

---

### R10 — Telemetry forwarding fetches have no timeout and no try/catch

`src/composition/telemetry/transport.ts:246-253`:

```ts
const collectorResponse = await fetch(
  telemetrySignalUrl(config.collectorUrl, signal),
  { body, headers, method: 'POST' }
);
const status = collectorResponse.ok ? 202 : 502;
```

and `:290-294` for the Sentry envelope. `grep -n 'forwardTimeout|AbortSignal' src/composition/telemetry/transport.ts src/modules/kernel/infrastructure/config/telemetry.ts` → no matches. There is no timeout knob in the telemetry config schema at all.

These are public proxy endpoints — `TELEMETRY_REQUIRE_AUTH: z.stringbool().default(false)` (telemetry.ts:52). A slow or blackholed collector holds a server worker for as long as the platform allows; a DNS or connection error throws out of the HTTP handler instead of producing a 502.

**Fix.** APP1's `a711431`:

```ts
// telemetry.ts schema
TELEMETRY_FORWARD_TIMEOUT_MS: z.coerce.number().int().positive().optional(),
// config: forwardTimeoutMs: env.TELEMETRY_FORWARD_TIMEOUT_MS ?? 10_000

// transport.ts — thread request.signal through handleOtlpProxyRequest
try {
  const collectorResponse = await fetch(url, {
    body, headers, method: 'POST',
    signal: AbortSignal.any([
      requestSignal,
      AbortSignal.timeout(config.forwardTimeoutMs),
    ]),
  });
  …
} catch (error) {
  recordLocalTelemetrySummary({
    …,
    summary: {
      forwarded: false,
      reason: error instanceof DOMException && error.name === 'TimeoutError'
        ? 'timeout' : 'transport_error',
    },
  });
  return new Response(null, { status: 502 });
}
```

Threading `request.signal` also means a client disconnect aborts the upstream call.

**Test.** A collector that never responds produces a 502 within `forwardTimeoutMs`, not a hang. A collector that rejects at the socket level produces a 502, not a thrown exception.

**Guardrail.** Semgrep: any `fetch(` under `src/composition/**` or `src/modules/*/infrastructure/**` must carry a `signal:` property. This is the general rule; the telemetry proxy is just its first instance.

**Effort:** S.

---

### R11 — No policy for "no trustworthy client IP"; three call sites, three answers

`src/platform/http/get-client-ip.ts:41` returns `undefined` **by design** — *"If the configured hop is missing, fail closed instead of trusting the leftmost value."* That branch is reachable on a misconfigured `TRUSTED_PROXY_DEPTH` (default `1`, `http.ts:31`) or a directly-reachable origin. Two consumers disagree about what to do with it:

```ts
// src/composition/telemetry/transport.ts:143-156 — fails SHARED
const ip = getClientIp(request, {...}) ?? 'unknown';
const result = defaultRateLimiter.check(`telemetry:${scope}:${ip}`, rateLimitPerMinute, …);
```
All unattributed traffic shares one bucket at the strict per-IP limit — a self-DoS: one misbehaving client locks out every unattributed caller.

```ts
// src/modules/email/transport/http/resend-webhook-handlers.ts:267-269 — fails OPEN
const enforceRateLimit = (request: Request) => {
  const ip = getClientIp(request, { trustedProxyDepth });
  if (!ip) return undefined;   // ← public webhook endpoint, no limit at all
```

And `transport.ts:139` cites a doc that does not exist: *"Durable, cross-instance rate limiting must be enforced at the edge/WAF (see `docs/security-rate-limiting.md`)"* — `ls docs/` returns `architecture/`, `security practices.md`, `security-risk-register.md`, `security-upload.md`, `strict-modular-monolith.md`. APP1's first template-touching commit `a711431` deleted the citation rather than writing the doc.

**Fix.** One composed helper in `src/platform/http`, implementing APP1's policy:

```ts
export const enforceRateLimit = ({
  request, scope, trustedProxyDepth, limit, unattributedLimit, windowMs,
  limiter = defaultRateLimiter, logger,
}: EnforceRateLimitInput): Response | undefined => {
  const ip = getClientIp(request, { trustedProxyDepth });

  // Attributed traffic gets a strict per-IP bucket. Unattributed traffic gets
  // a SEPARATE, much coarser bucket: sharing the strict per-IP bucket lets one
  // client lock out every unattributable caller, and skipping the limit
  // entirely leaves the endpoint unprotected the moment TRUSTED_PROXY_DEPTH
  // stops matching the deployment topology.
  const key = ip ? `${scope}:${ip}` : `${scope}:unattributed`;
  const effectiveLimit = ip ? limit : unattributedLimit;

  if (!ip) {
    logger?.warn({
      event: `${scope}.rate_limit_ip_unavailable`,
      details: { trustedProxyDepth },
    });
  }

  const result = limiter.check(key, effectiveLimit, windowMs);
  return result.allowed ? undefined : tooManyRequests(result.retryAfterSeconds);
};
```

APP1's real ratio for reference (`src/modules/conversation-practice/server.ts:78-110`): `EVALUATION_RATE_LIMIT_PER_MINUTE = 6` vs `EVALUATION_UNATTRIBUTED_RATE_LIMIT_PER_MINUTE = 100`.

Migrate both template call sites onto it. Either write `docs/security-rate-limiting.md` or delete the reference at `transport.ts:139`.

**Guardrail.** Port APP1's semgrep rule, generalising its `paths.include`:

```yaml
- id: no-shared-unknown-rate-limit-bucket
  pattern-regex: '\bgetClientIp\s*\([^;]*?\)\s*\?\?\s*[''"]unknown[''"]'
  message: >
    Do not collapse an unattributable client into a shared 'unknown' bucket.
    Use enforceRateLimit() from @/platform/http, which routes unattributed
    traffic to a separate coarse bucket.
```
Plus a second rule: a `getClientIp(...)` result used in a rate-limit key must not be discarded by an early `return undefined`.

**Test.** Three cases per call site: attributed → strict bucket; unattributed → coarse bucket + warn; unattributed flood → 429 (not unbounded, not sharing the strict bucket).

**Effort:** M.

---

### R12 — The transport cannot express HTTP 429

`src/modules/kernel/transport/tanstack/result-mapper.ts:20-28` maps `rate_limit: 'BAD_REQUEST'`, and `server-fn-error.ts:5-13` has no `TOO_MANY_REQUESTS` member. Meanwhile `src/modules/kernel/domain/errors/app-error.ts:7` defines `| 'rate_limit'` as a first-class category, and the template ships `createRateLimiter` plus rate-limited HTTP handlers. A rate-limited use case surfaces to the client as a 400 — indistinguishable from a validation failure, with no `Retry-After` semantics and no basis for client backoff.

**Fix** (three entries and one line):

```ts
// server-fn-error.ts
SERVER_FN_ERROR_CODES = [..., 'TOO_MANY_REQUESTS'];
STATUS_BY_CODE = { ..., TOO_MANY_REQUESTS: 429 };
CATEGORY_BY_CODE = { ..., TOO_MANY_REQUESTS: 'rate_limit' };
// result-mapper.ts:25
rate_limit: 'TOO_MANY_REQUESTS',
```

**Guardrail.** Unit test asserting `codeForCategory` is exhaustive over `AppError['category']` *and* that every entry round-trips to a status in the same class as `AppError.status`. Ship it with R11 so the helper can set `Retry-After` and throw the right code.

**Effort:** XS.

---

### R13 — The server-function error boundary leaks raw errors and logs nothing

`src/modules/kernel/transport/tanstack/result-mapper.ts:47-66`. Lines 49-51 state the contract — *"Never forward an internal (5xx/system) error's developer-facing message to the client. The real message is still logged server-side"* — and line 66, the fallthrough for everything that is **not** an `AppError`, is:

```ts
  throw error;
```

That path is reachable from every server function: line 95 is `await Promise.resolve(result).catch(mapAppErrorToServerFnError)`, which catches *any* rejection — a raw Drizzle/pg/Better-Auth/undici error whose message can carry SQL text, connection strings, or upstream response bodies. The function sanitizes exactly one class of error: the one that was already structured.

Second half: the claim "the real message is still logged server-side" is **false**. Neither `mapAppErrorToServerFnError` nor `unwrapApplicationResult` takes or calls a logger. A repository or gateway failure reaches the client as a 500 with no server-side record — so the flagship OpenTelemetry/Sentry stack the template ships never sees the failure that produced it.

**Fix.**

```ts
  // Anything that is not an AppError is, by definition, unexpected — which is
  // exactly the class most likely to embed SQL, connection strings, or an
  // upstream response body in its message. Flatten it.
  reportApplicationError(error, logger);
  throw new ServerFnError('INTERNAL_SERVER_ERROR', {
    message: 'Internal server error',
  });
```

and port APP2's `reportApplicationError(error, logger)` at both mapping sites, with its severity split — internal errors at `error` with `exception` attached, client-error categories at `warn` without one — plus a `describeErrorChain(error)` helper for the cause chain.

**Migration note.** APP2 changed the public signature to `unwrapApplicationResult(result, handlers, logger)`. For a template that forks already depend on, ship it as an optional third parameter defaulting to the kernel logger, so existing call sites keep compiling; make it required in the next major.

**Test.** `expect(() => …).rejects` on a thrown `new Error('SELECT * FROM users WHERE token = …')` — assert the client-visible message is exactly `'Internal server error'` and that the logger received the original.

**Guardrail.** Semgrep: bare `throw error` / `throw e` is banned in `src/modules/*/transport/**`.

**Effort:** S.

---

### R14 — PGlite teardown discards the suite's exit code

`tests/server/pglite-global-setup.ts:55-58`:

```ts
  return async () => {
    await server.stop();
    await pglite.close();
  };
```

PGlite's WASM runtime resets `process.exitCode` to 0 as it tears down. iris measured it directly (`588a92b`):

```
vitest run --project=unit                        failing -> exit 1
vitest run --project=unit --project=browser      failing -> exit 1
vitest run --project=unit --project=integration  failing -> exit 0
vitest run  (all projects, what `pnpm test` runs) failing -> exit 0
```

So `pnpm test` (`package.json:69`) and therefore `pnpm verify` (`:134`) exit **0 with failing tests**. Single-project runs exit correctly, which is why nobody noticed.

**Fix** (iris's, verbatim):

```ts
  return async () => {
    await server.stop();

    // PGlite's WASM runtime resets `process.exitCode` to 0 as it tears down, so
    // closing it here silently discarded Vitest's non-zero failure code. Any run
    // that included the integration project — `pnpm test`, and therefore
    // `pnpm verify` — then exited 0 with failing tests, so the merge gate never
    // failed on a broken suite. Preserve the code across close().
    const exitCodeBeforeClose = process.exitCode;
    await pglite.close();
    process.exitCode = exitCodeBeforeClose;
  };
```

**Guardrail.** A CI job (or a `scripts/` self-test) that runs `vitest run` against a deliberately failing fixture spec and asserts exit 1. This defect class — a green merge gate that gates nothing — is worth one dedicated meta-test.

**Effort:** XS. **This is the highest-leverage XS item in the track**: every other fix's regression test is worthless while `pnpm verify` cannot fail.

---

### R15 — The database TLS policy rejects real hosted Postgres (over-strict)

`src/modules/kernel/infrastructure/config/url-security.ts:125-132`:

```ts
const [sslmode] = sslmodes;
if (sslmodes.length !== 1 || !sslmode || !SECURE_SSL_MODES.has(sslmode)) {
  throw new ConfigurationError(
    `${name} must enable authenticated TLS in production: set sslmode=verify-full ` +
      `(recommended) or sslmode=verify-ca. …`
  );
}
```

with `SECURE_SSL_MODES = new Set(['verify-ca', 'verify-full'])` (`:15`).

The security argument is correct — `require` encrypts without verifying server identity. But the template's own `.env.example` **contradicts its own validator**:

```
# .env.example:51-52
# Production (node-pg) requires TLS: append ?sslmode=verify-full (or at least
# ?sslmode=require) for any non-localhost host. Neon drivers are TLS by default.
```

`?sslmode=require` is rejected. A forker who follows the template's own documentation gets a boot failure.

This was **iris's PR #1** — branch `relax-db-tls-check-for-demo`, commit `b781192`: *"assertDatabaseUrlTls required sslmode=verify-ca or verify-full for non-Neon production database URLs, which rejects the connection strings the managed providers behind this demo hand out (a plain postgres:// URL or sslmode=require)."* iris deleted the requirement entirely and also deleted the `driver` parameter, which existed only to gate it.

**iris's fix is wrong for a template.** It silently drops MITM protection with only a comment as the record.

**Proposed change — make the policy an explicit knob, not a deletion:**

```ts
/**
 * Database TLS enforcement level in production.
 *
 * - `verify`  (strictest): requires sslmode=verify-ca or verify-full. Server
 *              certificate and hostname are checked; MITM is defeated. Requires
 *              a CA bundle the driver can reach, which most managed providers
 *              do not hand out with their default connection string.
 * - `encrypt` (DEFAULT): rejects cleartext schemes and sslmode=disable/allow/
 *              prefer, and accepts sslmode=require or a driver that negotiates
 *              TLS itself (Neon). Encrypted but NOT certificate-verified.
 * - `off`:     cleartext checks only. Never appropriate for real user data.
 *
 * The default is `encrypt` because that is what Supabase, Neon, Railway, RDS
 * and Fly hand out. Set DATABASE_TLS_POLICY=verify before this system handles
 * real credentials or user data, and see docs/database-tls.md for how to
 * supply the CA bundle each provider needs.
 */
DATABASE_TLS_POLICY: z.enum(['off', 'encrypt', 'verify']).default('encrypt'),
```

Two important sub-fixes the current code gets wrong regardless of policy level:

- `prefer` and `allow` are **not currently rejected** — only `disable` is (`:115-119`), and then the `verify-*` check catches everything else. Under the new `encrypt` level, `allow` and `prefer` must be explicitly rejected, since they silently fall back to cleartext. (`prefer` is libpq/node-pg's default when `sslmode` is absent, so a bare `postgres://host/db` must be treated as `prefer` and rejected under `encrypt` unless the driver is Neon.)
- Keep the `driver` parameter. iris removed it, but it is the only thing that distinguishes "TLS is negotiated inside the Neon driver from a plain `postgres://` string" from "node-pg will happily connect in cleartext."

Fix `.env.example:51-52` to describe whichever policy ships as default.

**Test.** A matrix over `{off, encrypt, verify} × {postgres:// bare, ?sslmode=disable, =allow, =prefer, =require, =verify-full, http://} × {node-pg, neon-http, neon-websocket}`. The template has `tests/unit/.../config-accessors.unit.spec.ts` — extend it; iris's `71b4f36 Fix the stale cleartext-database-URL test fixture` shows the fixtures rot otherwise.

**Guardrail.** A boot-time diagnostic (using the existing `emitConfigDiagnostic`) that logs the active policy at startup, so `encrypt` is a visible choice rather than an invisible default. Plus a `docs/security-risk-register.md` row that is *required* to exist while `DATABASE_TLS_POLICY !== 'verify'` in a production runtime.

**Effort:** S.

---

### R16 — First run fails on the shipped `AUTH_SECRET`

`.env.example:61` ships `AUTH_SECRET="REPLACE ME"`. `src/modules/kernel/infrastructure/config/auth.ts:13-22` rejects it twice: `AUTH_SECRET_MIN_LENGTH = 32` (it is 10 chars) and `AUTH_SECRET_PLACEHOLDERS` contains `'replace me'`, matched case-insensitively at `:34-35`. `SKIP_ENV_VALIDATION` is shipped **commented out** at `.env.example:47-48`, so `shouldSkipEnvValidation` (`env-schema.ts:65-67`) is falsy and validation runs in local dev. Chain: `package.json:36 dev` → `:40 env` → `:42 env:server` → `scripts/validate-server-config.ts` → `server.ts:14 getAuthConfig()`.

`README.md:50` Installation is `cp .env.example .env` / `pnpm install` / `pnpm dk:init` / `pnpm db:init` — no secret step. The only `AUTH_SECRET` mention in the README is at `:210`, inside a production checklist.

**Fix.** Ship `pnpm setup` — a real script, not a README line:

```
scripts/setup.mjs
  1. if .env exists and --force not passed → exit 0 with a message
  2. cp .env.example .env
  3. rewrite the AUTH_SECRET= line with randomBytes(32).toString('base64url')
  4. print the remaining REQUIRED variables that are still placeholders
```

Add it to README Installation as step 1 and to the `dk:init`/`db:init` sequence. Also add `pnpm run env` to the README's verification list so the failure is self-diagnosing.

**Effort:** XS.

---

### R17 — The module dependency graph is missing every type-only edge

`scripts/generate-module-dependency-graph.ts:476-479` passes the repo depcruise options straight to `cruise()`. `tsPreCompilationDeps` defaults to `false`, so the report describes the graph *after* TypeScript elision. In a hexagonal codebase where ports, `ApplicationResult` and branded IDs are all type-only, that erases the primary way an application-layer dependency is expressed. iris measured **78 → 99 edges** — 21 missing, whole edges, not styling. `account/application → kernel/application` was absent despite `account-repository.ts` importing `@/modules/kernel/application/result`.

It also made `classifyDependencyStyle`'s `type-only` branch unreachable, so the published legend ("dashed edges are dynamic imports or type-only dependencies") described something the graph could never contain — while its unit test asserted the mapping in isolation and passed.

**Fix.** Set `tsPreCompilationDeps: true` on the generator's own `cruise()` call, **not** in `.dependency-cruiser.cjs`. iris's reason, which I'd keep verbatim in the comment: enabling it repo-wide makes `no-circular` newly fire on a type-only cycle between `user/domain/user-policy.ts` and `user/domain/user.ts` that is harmless at runtime. No boundary rules are affected either way; widening the lint config is a separate decision.

**Test.** Assert the generated graph contains at least one edge derived solely from an `import type` (pick a fixture pair), so the flag cannot silently regress. And make the `classifyDependencyStyle` test read from a real generated report, not a synthetic input.

**Effort:** XS. **Owner decision:** whether to *also* enable it repo-wide and break the `user/domain` type-only cycle. My recommendation: no, not in this track — record it as a separate issue.

---

### R18 — Pre-commit hook fails on every docs-only commit

`scripts/format-changed.mjs:7-17` includes `'.md'` in `FORMAT_EXTENSIONS`; `.oxfmtrc.json:24-25` ignores `**/*.md` and `**/*.mdx`; `lefthook.yml:6` glob is `'*.{js,ts,cjs,mjs,jsx,tsx,json,md,css}'`. A commit staging only markdown hands oxfmt a file list it has entirely excluded → oxfmt exits 2 → the pre-commit format step fails.

**Fix.** iris's `6d1f0c5` — drop `.md` from the script's set, with the comment that explains why it must stay dropped:

```js
/**
 * Must stay a subset of what `.oxfmtrc.json` will actually format. Markdown is
 * deliberately absent: that config ignores `**​/*.md`, so handing oxfmt a
 * markdown-only file list made it exit 2 with "All matched files may have been
 * excluded by ignore rules" and failed the pre-commit hook on docs-only commits.
 */
```

**Guardrail (better than the fix).** A unit test asserting `FORMAT_EXTENSIONS` ⊆ (`.oxfmtrc.json` includes − ignores), derived by reading the config rather than hardcoded. That prevents the same drift for `.css`, `.jsonc`, and anything a fork adds. Also drop `md` from the lefthook glob so the step doesn't even run.

**Effort:** XS.

---

### R19 — Log sanitization destroys the diagnostics it is meant to protect

`src/platform/lib/redaction/sanitize-log-fields.ts`:

- `:15` `const EMAIL_PATTERN = /[^\s@]+@[^\s@]+\.[^\s@]+/g;` applied at `:96-98` to **every string in the tree**. `/node_modules/@sentry/core/index.js` matches in its entirety — so error-telemetry stack frames become `[REDACTED]`.
- `:20-33` `DEFAULT_SENSITIVE_LOG_KEYS` includes `'name'`, matched unconditionally — wiping `sdk.name`, `service.name`, and every structural `name` field.
- No recursion depth bound (`grep -n 'MAX_SANITIZED_DEPTH|depth'` → only `path: WeakSet<object>` at `:90`).

Both defects sit in the template's flagship observability path and are invisible until you open a Sentry event and find the stack gone.

APP1 removed the PII heuristics wholesale (`4c8eceb`), which is right for its prototype posture — its own comment says *"Revisit this if the system ever handles real learner data"* — but too aggressive as a template default. Fix the bugs without abandoning redaction:

1. Drop `'name'` from `DEFAULT_SENSITIVE_LOG_KEYS` at `:25`.
2. Gate `redactString` to values under known free-text keys, or at minimum adopt APP1's earlier `146e4ff` form — `value.includes('@') ? value.replace(EMAIL_PATTERN, …) : value` with bounded quantifiers `/[^\s@]{1,64}@[^\s@]{1,189}\.[^\s@]{1,63}/g`. The unbounded `+` form is also a backtracking hazard on a function that walks arbitrary SDK objects.
3. Port APP1's `a711431` depth bound: `MAX_SANITIZED_DEPTH = 32`, returning `'[MaxDepth]'`.

**Test.** Assert `/node_modules/@sentry/core/index.js` and `{ sdk: { name: 'opentelemetry' } }` survive intact, and that `{ email: 'a@b.co' }` and `{ password: 'x' }` do not. Plus a self-referential object and a 40-deep nesting.

**Effort:** S.

---

### R20 — CI writes generated credentials to `$GITHUB_ENV` unmasked

`.github/workflows/code-quality.yml:355-368` writes `AUTH_SECRET`, `DATABASE_URL`, `RESEND_API_KEY`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` with bare `printf … >> "$GITHUB_ENV"`. `grep -rn 'add-mask' .github/` → zero hits anywhere.

The values are throwaway, which caps severity — but the pattern gets copied, and the next step (`:369`) is `pnpm build 2>&1 | tee test-results/build/build.log`, uploaded as an artifact. Any config-validation error that echoes `DATABASE_URL` lands in a downloadable artifact in clear text.

**Fix.** APP1's `e181825` helper split:

```bash
write_masked_env() {
  local env_name="$1"; local env_value="$2"
  echo "::add-mask::${env_value}"
  printf '%s=%s\n' "${env_name}" "${env_value}" >> "$GITHUB_ENV"
}
write_env() { printf '%s=%s\n' "$1" "$2" >> "$GITHUB_ENV"; }
```

Also switch `AUTH_SECRET` from `openssl rand -base64 32` to `-hex 32` — base64 emits `+` and `/`, a latent shell hazard in an unquoted context, which is presumably why APP1 moved.

**Guardrail.** A `scripts/check-workflow-secrets.mjs` (added to `check:ci`) asserting that no `>> "$GITHUB_ENV"` line in `.github/workflows/**` writes a variable whose name matches `/SECRET|TOKEN|KEY|PASSWORD|_URL$/` without a preceding `::add-mask::`.

**Effort:** XS.

---

### R21 — Better Auth adapter deep-imports kernel; three symbols have no gate

iris `3f60ded`: `emitConfigDiagnostic`, the `Database` type, and `getUserLanguage` *"were exported from no kernel gate at all, so consumers had no supported import path."* `auth.tsx` carried seven kernel imports; iris collapsed them to two gate imports and added the three symbols to `kernel/backend.ts`. The regenerated graph dropped two edges: `auth/infrastructure → kernel/transport` and `auth/transport → kernel/infrastructure`.

Two nuances worth preserving verbatim in the template:

- **Kernel deep-imports are not a rule violation.** The docs call kernel "the practical exception" and the cruiser config encodes it. This is a deliberate tightening for one adapter, not a broken rule — pin it with a rule modeled on the existing `smtp-gateway-uses-kernel-public-gates`, scoped to `auth.tsx`. Five sibling files in that directory still deep-import and would need converting first; `schema.ts` needs care because kernel DB schema imports are separately permitted by the drizzle rule.
- **`server-functions.ts` must keep its direct import** of the diagnostics module. Routing it through the gate broke 17 browser test files with `ReferenceError: Buffer is not defined`: that module is reachable from the browser graph, and the gate is a barrel that re-exports the DB client, pulling `pg` in with it. Ship the comment explaining this, or the next person will "fix" it.

**Effort:** S. Depends on R17 (the graph must be correct before you use graph-edge deltas as your acceptance criterion).

---

### R22 — Query-key collision between list and entity options

`src/platform/lib/tanstack-query/scoped-query-options.ts`: `:36` (list) and `:86` (entity) are byte-identical — `[...input.baseKey(input.input.scopeKey), data] as const` — while `:59-63` (infinite) inserts `'infinite'`. The template's own modules avoid the collision only by passing distinct `baseKey`s, so this is a latent contract hazard rather than a live bug — but APP1 hit it on day one, under a commit titled "Fix telemetry and demo regressions," which suggests it presents as a confusing data-shape bug rather than an obvious error.

**Fix.** Insert `'list'` at `:36` and `'entity'` at `:86`. **Test:** list/entity/infinite built from the same `baseKey` and input produce three distinct keys. **Changelog note:** this is a cache-key shape change; persisted query caches invalidate once on deploy.

**Effort:** XS.

---

### R23 — Brand-coupled runtime constants, and a test that only passes by coincidence

`src/platform/http/csp-nonce.ts:1` `CSP_NONCE_PLACEHOLDER = '__START_UI_CSP_NONCE__'` (22 chars). `tests/unit/platform/http/security-headers.unit.spec.ts:271-273`:

```ts
`<script nonce="${CSP_NONCE_PLACEHOLDER.slice(0, 8)}`,
CSP_NONCE_PLACEHOLDER.slice(8, 19),
`${CSP_NONCE_PLACEHOLDER.slice(19)}"></script>`,
```

The offsets are tuned to that exact length. iris caught this while rebranding (`2589bb1`): *"The new placeholder is 18 chars, so `.slice(19)` would have gone empty and quietly reduced the three-chunk split to two while still passing"* — i.e. the test would keep passing while no longer testing the split-chunk case it exists for. **This is a live template defect independent of renaming.**

Other brand-coupled runtime values: `src/modules/kernel/infrastructure/db/migrate.ts:24` `MIGRATION_LOCK_NAMESPACE = 'start-ui-web'` (consumed by `pg_try_advisory_lock` at `:112-113` and `:128`); `src/composition/telemetry/otel-adapter.ts:22-24` tracer/meter/logger names; `telemetry.ts:120` and `src/platform/env/config.ts:97` `OTEL_SERVICE_NAME` defaults; `csp-nonce.ts:5` `'__startUiCspNonceBridgeInstalled'`.

**Fix.** (a) Derive the slice offsets from `CSP_NONCE_PLACEHOLDER.length` — e.g. thirds. (b) Introduce one `APP_SLUG` constant (or read `name` from package.json) and derive the OTel names, the nonce bridge key, and the placeholder from it. (c) Leave the migration advisory-lock namespace *explicitly configurable and documented*: iris's own commit warns that *"the migration lock namespace change is only safe if no old-code and new-code instance run migrations concurrently."* Auto-deriving it from a rename would be a silent hazard.

**Effort:** S.

---

### R24 — Suppression and cast hotspots

34 suppression/cast sites across `src/`. Two groups deserve action:

**Unjustified suppressions** (no `--` reason, so nothing records why they are safe): `src/platform/lib/tanstack-query/scoped-query-options.ts:1`, `src/platform/components/ui/sidebar.tsx:60`, `src/platform/components/ui/confirm-responsive-drawer.tsx:52,59`, `src/platform/hooks/use-value-has-changed.ts:5,7`, `src/types/utilities.d.ts:1-2`, `src/modules/book/presentation/app/page-books.tsx:55,93`.

**Type lies** — the ones that can produce a runtime surprise:
- `src/platform/lib/zod/zod-utils.ts:5,9` — `(null as unknown as string)` and `(undefined as unknown as string)`, with the comment *"Cast null value to string for React Hook Form inference."* React Hook Form is **not a dependency** (`grep -n 'react-hook-form' package.json` → nothing; it is only advertised in `README.md:11`). The cast's stated justification no longer exists, and it makes `z.string()` fields claim non-nullability they do not have.
- `src/modules/kernel/infrastructure/db/client.ts:39`, `migrate.ts:58,67,140` — four `as unknown as` casts bridging the node-pg/Neon driver split. Legitimate boundary casts, but they need a `--` reason each.
- `src/modules/kernel/transport/tanstack/result-mapper.ts:99` `outcome as unknown as TOutcome` — inside the exact function R13 touches; worth revisiting there.

**Guardrail.** Configure the linter to require a justification on every suppression (`eslint-comments/require-description` equivalent, or an oxlint rule), and add a semgrep rule banning `as unknown as` outside `src/modules/*/infrastructure/**` and `tests/`. Then fix the ~10 sites that violate it. **Recommend fixing `zod-utils.ts:5,9` for real** — return `z.string().nullable()` / `.optional()` and let inference do its job.

**Effort:** S.

---

## 3. Default posture: what should be ON, what should be a knob

This is the question the track brief singles out, and the evidence is unambiguous about the failure mode: **iris's PR #1 was `relax-db-tls-check-for-demo`, and its first week also had to relax OTEL (`94dd67f`), the client env schema (`9fcb5c1`), and the risk register (`efac8c6`).** Four of its first ten substantive commits were removing template constraints. A template that induces that pattern trains forkers to *delete* security checks rather than configure them — and iris's TLS deletion is exactly that outcome: the protection is gone, recorded only in a doc comment.

The governing rule I'd write into `AGENTS.md`:

> **A hardening default is acceptable only if it is satisfiable by a correctly-configured deployment on the platforms the template targets, using values those platforms actually hand out.** If satisfying it requires the operator to obtain something the platform does not provide (a CA bundle, a collector endpoint), it must be a named policy level with a documented default — never a hard throw.

Applied concretely:

| Control | Current | Recommended default | Why |
|---|---|---|---|
| **CSP with per-request nonce** | ON (broken, R1) | **ON**, once R1 lands | CSP costs the operator nothing and is the template's headline security feature. Fix it rather than weaken it — APP1 having to delete the whole subsystem is the argument for fixing, not for defaulting off. |
| **DB TLS** | `verify-ca\|verify-full` required in prod | **`DATABASE_TLS_POLICY=encrypt`**, with `verify` one env var away and `off` explicitly labelled as never-for-real-data | `verify-*` is unsatisfiable with Supabase/Railway/RDS default connection strings. `encrypt` still rejects `disable`/`allow`/`prefer`/cleartext — i.e. it keeps the property that actually protects credentials on the wire. |
| **OTEL collector** | Required in prod (throws) | **Optional**, falling back to a console adapter (never the no-op) | Both apps deleted it independently; the template's own CI injects a fake collector to get past it. Observability is not a security control and must not gate boot. |
| **HTTPS on client URLs in prod** | ON | **ON** | Free to satisfy; the R7 fix makes it correct on staging too. |
| **HSTS / security headers** | ON | **ON** | Free. |
| **CSRF + same-origin browser-mutation guard** | ON (`src/start.ts:244-254`) | **ON** | Free, and `src/start.ts` replacing framework defaults means removing it is silent. |
| **`AUTH_SECRET` length + placeholder rejection** | ON, blocks first run | **ON**, with `pnpm setup` generating a real secret (R16) | The check is right; the onboarding is wrong. Fix the onboarding. |
| **Rate limiting** | ON, inconsistent | **ON**, via one helper with a coarse unattributed bucket (R11) | Fail-open on a public webhook is worse than any default. |
| **Telemetry never affects app behaviour** | Asserted in comments, unenforced | **ON, unconditional** (R9) | This is an invariant, not a policy. There is no configuration under which an exporter throw should break a request. |
| **`security:audit` inside `pnpm check`** | ON | **OFF** — keep the dedicated CI job | Makes the local gate non-deterministic and network-dependent, and an unfixable transitive advisory blocks all local work (R5). |
| **Risk-register expiry hard-fail** | ON, guaranteed to fire | **Warn**, hard-fail only when the advisory is still live (R5) | A time bomb that detonates N days after release is the worst possible first-run experience. |
| **`lint:sheriff`, `knip:deps`** | In `check`, in no workflow | **ON in both `check` and CI** | Documented as CI gates (`docs/security practices.md:23,48`) while running nowhere. |

**The general shape:** hardening that a correct deployment satisfies for free stays ON and unconditional. Hardening that requires the operator to *obtain something* becomes a named policy level with a boot-time diagnostic announcing the active level. Nothing becomes a silent deletion.

One further structural recommendation: add **`scripts/check-hardening-posture.mjs`** to `check:ci`, printing a table of every policy knob and its resolved value for the current env. That makes "we relaxed X" a visible, reviewable line in CI output rather than a one-line diff in a config file that nobody re-reads.

---

## 4. Sequencing

**Phase 0 — unblock (0.5 day).** Nothing here can be verified until the gates work.
`R5` (risk register + advisory clear) → `R14` (PGlite exit code) → `R6` (`env:client`) → `R18` (docs-only commit) → `R16` (`pnpm setup`).
Acceptance: `pnpm check` exits 0 on a fresh clone; a deliberately failing spec makes `pnpm verify` exit 1; a docs-only commit passes pre-commit.

**Phase 1 — config correctness (2 days).** These are prerequisites for R4 and they are all small.
`R3` (spread inversion, both copies) → `R7` (`isProd` truth table) → `R15` (`DATABASE_TLS_POLICY`) → `R8` (OTEL optional + console fallback + shutdown flush).

**Phase 2 — the two structural fixes (5–6 days).** Run in parallel; they do not touch the same files.
- Track A: `R4` (canonical origin) → `R2` (lazy Better Auth client). R2 is much cheaper after R4 removes `VITE_BASE_URL` from the client schema.
- Track B: `R1` (SSR stream) → `R23a` (CSP test slice offsets).

**Phase 3 — request-path hardening (2 days).**
`R9` (telemetry proxy guard) → `R10` (fetch timeouts) → `R12` (429 code) → `R11` (rate-limit helper) → `R13` (error boundary logging + flattening). Ordered so each depends only on what precedes it: R11 needs R12's code, R13 needs the logger R9's guard establishes.

**Phase 4 — cleanup (1.5 days).**
`R17` (graph type-only) → `R21` (auth gates, uses R17's edge count as acceptance) → `R19` (sanitization) → `R20` (CI masking) → `R22` (query keys) → `R23b` (`APP_SLUG`) → `R24` (suppressions).

**Total: ~11–12 engineer-days** for the track, excluding the demo-domain removal and scaffolding work owned by other tracks.

---

## 5. Owner decisions required

| # | Decision | My recommendation |
|---|---|---|
| **D1** | **DB TLS default: `encrypt` or `verify`?** `verify` is strictly more secure and strictly less usable; iris chose to delete the check entirely rather than satisfy it. | **`encrypt`**, with `verify` documented as the target and a boot-time diagnostic naming the active level. The measured outcome of `verify`-by-default is deletion, which is worse than `encrypt`. Ship `docs/database-tls.md` with per-provider CA-bundle instructions so `verify` is achievable. |
| **D2** | **Does the template keep CSP at all?** APP1 fixed it correctly and then removed it 40 minutes later, and has shipped without it for three weeks. | **Keep it, fixed.** APP1's removal was diagnostic expedience under a hang it had already fixed, not a considered judgment. But make it one env var to disable (`SECURITY_CSP_MODE=enforce|report-only|off`) so the next fork's diagnostic session does not require deleting 400 lines. |
| **D3** | **`VITE_BASE_URL` → `APP_URL`: breaking change for existing forks.** APP2 dropped it from the client schema entirely; APP1 kept it as the primary key and still ships it client-side. | **Take APP2's shape.** The consumers are all server-side (`start.ts:84`, `auth.tsx:68,84`). Ship a one-release deprecation: accept `VITE_BASE_URL` with a loud config diagnostic, remove it next major. |
| **D4** | **`tsPreCompilationDeps` repo-wide?** Enabling it in `.dependency-cruiser.cjs` (not just the generator) makes `no-circular` fire on a type-only cycle in `user/domain`. | **Generator only, for now.** File the `user/domain` cycle separately. Type-only cycles are harmless at runtime but they *are* a design smell worth fixing on its own schedule. |
| **D5** | **`unwrapApplicationResult` signature change** (R13 adds a logger parameter). | **Optional third parameter defaulting to the kernel logger** for this release; required in the next major. A template cannot ship a breaking transport signature without a migration path. |
| **D6** | **Remove `security:audit` from `pnpm check`?** Makes the local gate faster and deterministic, but removes a local warning. | **Remove it.** `.github/workflows/code-quality.yml:159-176` already runs it as a dedicated job. Keep `security:licenses` and `security:tanstack` (both offline and deterministic) in `check`. |
| **D7** | **Migration advisory-lock namespace** (`migrate.ts:24`) — auto-derive from `APP_SLUG` or leave explicit? | **Leave explicit and documented.** Auto-deriving means a rename silently changes lock identity, which is only safe if no old-code and new-code instance run migrations concurrently. Make it an env var with the current value as default, and put the warning in the rename docs. |

---

## 6. Confidence notes

- **High confidence, verified on disk today:** R1, R2, R3, R5 (reproduced exit 1), R6, R7, R9, R10, R11, R12, R13, R14, R15, R16, R17, R18, R19, R20, R22, R23, R24.
- **Medium confidence:** R4's full precedence table is APP2's design, adopted on its reasoning rather than reproduced here — I did not deploy to Vercel to confirm each signal's behaviour. R13's *exploitability* depends on how TanStack Start serializes a raw thrown `Error` across the server-fn boundary in this version, which I did not verify; the contract violation inside the template's own file is unambiguous either way.
- **Not verified:** I could not run `pnpm depcruise`, `pnpm test`, or a build — `node_modules` is absent in all three repos. Every runtime claim above is either a code read, a git-history read, or (for R5) a direct node invocation of a dependency-free script.
