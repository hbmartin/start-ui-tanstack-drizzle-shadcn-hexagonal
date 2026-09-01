# Security and Quality Practices

## Current status

This document describes controls that are implemented in the repository. It is
not a compliance certification or a production-readiness attestation. Accepted
dependency risks live in `docs/security-risk-register.md`; incomplete audit
items and release blockers live in `docs/audit-remediation-ledger.md`.

## Deterministic local gates

`pnpm check` is the required static gate. It runs repository-pinned Node tools,
the locally installed Semgrep CLI, and reviewed local security evidence. Install
Semgrep before running the gate; `.github/workflows/semgrep.yml` separately pins
its CI container by digest.

| Control | Implemented contract |
| --- | --- |
| Oxfmt and Oxlint | Repository formatting plus type-aware linting with a zero-warning ceiling. |
| Fallow | Project-wide dead code/dependencies, duplication, and health checks. CI separately runs `quality:audit` for changed-code regressions. |
| Semgrep | Repository-local security and architecture rules executed by the available local CLI. |
| Architecture tests | Semantic module, public-gate, runtime, parser, and security invariants that source-graph rules cannot express. |
| Migration integrity | Existing SQL migration history is immutable; schema changes produce forward migrations. |
| Security audit | Locked TanStack incident, license, advisory, and time-bounded risk-register evidence. |

Network refreshes are deliberately separate. `pnpm security:refresh` fetches
new advisory evidence for review; `pnpm security:licenses` recomputes license
evidence from the locked installed graph. Ordinary `pnpm check` consumes the
reviewed results and does not mutate them.

Use `pnpm test:affected` after a change and `pnpm verify` for the complete local
pre-merge contract. Fallow computes affected-test impact closure; a discovery
failure falls back to the full test suite. See `TESTING.md` for the test layers
and escalation rules.

## Continuous integration

Pull-request workflows provide these independently visible controls:

- `.github/workflows/code-quality.yml` runs format, zero-warning lint and
  typecheck, affected tests, Fallow, deterministic audit, migration integrity,
  architecture tests, and coverage.
- `.github/workflows/semgrep.yml` runs the repository-local Semgrep policy.
- `.github/workflows/codeql.yml` runs CodeQL where GitHub Advanced Security is
  available; ordinary forks do not depend on it to run the local required
  gates.
- `.github/workflows/dependency-review.yml` and
  `.github/workflows/osv-scanner.yml` always report their required status. They
  skip expensive scanning for unrelated diffs and fail closed if change
  detection or a required scan fails.
- `.github/workflows/detect-secrets.yml` and the action-supply-chain tests cover
  secret leakage and workflow hardening.
- `.github/workflows/supply-chain.yml` refreshes dependency evidence, emits SPDX
  and CycloneDX SBOMs, and attests those artifacts on `main`.

GitHub-hosted features such as CodeQL, Dependency Review, SARIF upload, and
attestations depend on repository permissions. Local Fallow, Semgrep, migration,
test, and deterministic audit gates remain runnable without those features.

## Application security boundaries

- External input is parsed once at HTTP, server-function, form, upload, or
  webhook boundaries and passed inward as normalized types.
- Drizzle parameterization is the normal persistence path. Architecture and
  Semgrep rules constrain raw SQL and provider SDK usage.
- `src/start.ts` explicitly installs TanStack's server-function CSRF middleware
  and an app-owned same-origin browser-mutation guard. The controls validate
  Origin/Referer and Fetch Metadata signals; documentation does not claim an
  app-issued CSRF-token protocol.
- Preview and production responses enforce CSP and request nonces before the
  response stream begins. Local/test profiles may use documented relaxations.
- Public server errors use the closed versioned DTO
  `{ version, target, reason, correlationId }`; internal causes are logged before
  flattening and are not serialized to clients.
- Auth, destructive administration, session revocation, and other classified
  critical operations use durable audit policies. Low-risk best-effort audit
  failures emit an operational signal.
- Public signup is disabled by default. The complete persisted invite-only flow
  remains a release blocker in the remediation ledger.
- The shared in-memory limiter is process-local defense in depth. It is not a
  distributed correctness boundary; production distributed and edge rate-limit
  completion remains an explicit release blocker.

## Runtime and deployment claims

Build selection is explicit: `pnpm build` targets Node,
`pnpm build:vercel` targets the Nitro Vercel preset, and
`pnpm build:cloudflare` targets the Cloudflare Vite plugin. Artifact inspection
exists for all three. `pnpm verify:node` additionally boots and exercises the
Node artifact.

Vercel and Cloudflare remain artifact-only in the current v5 alpha. Their build
outputs are not runtime verification or deployment approval. The exact open
adapter, lifecycle, browser, mutation, and release gates are recorded in
`docs/audit-remediation-ledger.md`.

## Reporting and risk ownership

Report vulnerabilities through `.github/SECURITY.md`. Do not add cloud
credentials to ordinary pull-request workflows. When a risk must be accepted or
temporarily mitigated, record its owner, evidence, review date, and removal
condition in `docs/security-risk-register.md`.
