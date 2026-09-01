# JiTTest release evidence policy

JiTTest 0.4.0 is a release-evidence gate, not an ordinary pull-request job. It
runs only against reviewed full commit SHAs and uses the committed
`jittest.config.json`. Dispatch inputs cannot weaken its model, analysis mode,
sensitivity weights, flake guard, verdict floor, or token and dollar limits.

The OpenRouter credential is stored as the environment-scoped GitHub secret
`OPENROUTER_API_KEY`. The `release-jittest` environment must require human
approval, and the provider key must have a provider-side spending limit. The
CLI's five-dollar and 200,000-token run limits are defense in depth: in-flight
requests may overshoot the CLI budget, so the repository post-gate rejects an
overshoot, unknown cost, skipped call, exhausted budget, or unenforced dollar
budget.

The CLI process receives the OpenRouter secret, and a Node preload removes it
from every spawned Git, package-manager, and Vitest process. That scrub is only
defense in depth: same-UID generated code is not isolated from the trusted
checkout or GitHub command files. The workflow therefore fails before the
credentialed step unless the protected environment supplies
`JITTEST_SANDBOX_READY=true` after an isolated runner or equivalent upstream
execution boundary has been reviewed. Release evidence also disables the model
response cache and records the analyzed base, head, policy commit, config
digest, model, and budgets in the uploaded metadata.

Every `likely-strong` or `strong-catch` report blocks. Fixing the code is the
normal resolution. A human may instead add a short-lived entry to
`docs/jittest-triage.json` when the behavior is an intended change or a
confirmed false positive. The post-gate prints the required fingerprint. An
entry must have an accountable reviewer, rationale, review timestamp, expiry
no more than 90 days later, and evidence. Expired, stale, duplicate, or
unmatched entries fail closed. A confirmed true positive cannot be waived.

The fingerprint covers the reported parent behavior, child behavior, change
type, and generated test. It deliberately excludes the verdict and explanatory
LLM prose so a finding remains identified if its severity changes. The gate
normalizes only line endings; observable whitespace and Unicode values remain
part of the identity.

Exit 1 is always a tool failure. Exit 2 is evaluated by the post-gate so an
exact reviewed triage entry can clear it. Exit 3 is accepted only for a
non-release diagnostic run whose independently resolved base and head SHAs are
identical; it is never release evidence. The workflow is intentionally manual
until a promotion owner can supply the complete reviewed base-to-head range. A
tag-triggered job would run after its tag already existed and could not by
itself be called a promotion gate. Final release wiring must invoke this
evidence contract before publishing or deploying a version. The sandbox
attestation and promotion wiring are both release blockers in the audit ledger.
