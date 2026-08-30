# Security Policy

`start-ui-web` is an open-source starter that many projects build on, so we
take the integrity of this template and its supply chain seriously.

## Supported Versions

Security fixes are provided for the active v5 line on `main`, including its
pre-releases. The breaking v5 branch does not maintain a v4 compatibility or
security-fix line.

| Version | Supported          |
| ------- | ------------------ |
| 5.x     | :white_check_mark: |
| < 5.0   | :x:                |

## Reporting a Vulnerability

**Please do not open a public issue for security vulnerabilities.**

Report privately through GitHub's coordinated disclosure flow:

1. Go to the repository's **Security** tab → **Report a vulnerability**
   (GitHub Private Vulnerability Reporting), or open
   <https://github.com/hbmartin/start-ui-web/security/advisories/new>.
2. Include affected version/commit, reproduction steps, impact, and any PoC.

If you cannot use GitHub advisories, contact the repository author through the
address published in the tracked `package.json` metadata.

### What to expect

- **Acknowledgement:** within 5 business days.
- **Triage & severity assessment:** within 10 business days.
- **Fix / mitigation:** prioritized by severity; we will coordinate a
  disclosure timeline and credit reporters who wish to be named.

Please give us a reasonable window to remediate before any public disclosure.

## Scope

In scope: code in this repository and its build/release pipeline
(`.github/workflows`, dependency manifests, CI configuration).

Out of scope: vulnerabilities in third-party dependencies that are already
public — these are tracked via Dependabot, OSV Scanner, the locked security
snapshot, and [`docs/security-risk-register.md`](../docs/security-risk-register.md).
Report those upstream; if this repo needs to pin or override around one, record
the mitigation and review date in the risk register.

## Supply-chain controls

This repository enforces a layered supply-chain posture (OWASP A09:2025).
A summary lives in [`docs/security practices.md`](../docs/security%20practices.md);
accepted/temporary risks are tracked in
[`docs/security-risk-register.md`](../docs/security-risk-register.md). Key
controls:

- All GitHub Actions are pinned by commit SHA. The shared pnpm setup action uses
  the frozen lockfile with dependency lifecycle scripts disabled, then generates
  trusted local build metadata explicitly.
- `pnpm-workspace.yaml` enforces `minimumReleaseAge` and an explicit
  build-script allowlist.
- Continuous scanning: OSV Scanner, Dependency Review, CodeQL, Semgrep, and
  detect-secrets. `pnpm security:audit` deterministically checks the locked
  TanStack incident policy, license evidence, and time-bounded risk register;
  `pnpm security:refresh` is the separate network evidence refresh.
- SPDX and CycloneDX SBOMs plus the normalized
  `docs/security-audit.snapshot.json` are generated and signed with build
  provenance on every push to `main`.

## Browser request defenses

Production HTTPS auth uses a host-bound `__Host-` session cookie with Secure,
HttpOnly, `Path=/`, and `SameSite=Lax` attributes. Better Auth accepts only the
validated canonical origins configured by the selected runtime profile.

`src/start.ts` explicitly registers TanStack's server-function CSRF middleware
and the app-owned browser-mutation guard. Together they validate Origin/Referer
and Fetch Metadata signals for their declared mutation surfaces. The template
does not claim a separate synchronizer-token protocol.

### Verifying release artifacts

The SBOMs and normalized security evidence published from `main` carry signed
build provenance. Verify an artifact with the GitHub CLI:

```bash
gh attestation verify sbom.spdx.json --repo hbmartin/start-ui-web
```
