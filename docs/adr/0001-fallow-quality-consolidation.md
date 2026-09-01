# ADR 0001: Consolidate static architecture and quality analysis in Fallow

- Status: Accepted for v5
- Date: 2026-08-24

## Context

The template previously combined dependency-cruiser, Knip, Sheriff, and jscpd.
Those tools disagreed about entry points and TypeScript support, duplicated work,
and allowed dependency-cruiser to report success after discovering only two
modules and no dependency edges. Sheriff was not part of the required check and
did not support the authoritative TypeScript 7 compiler.

## Decision

Pin Fallow 3.17.0 and make it the required source-graph, dependency, boundary,
type-only-edge, policy, duplication, and health analyzer. Keep focused
architecture tests and Semgrep for semantic or security invariants that Fallow
does not express.

The repository configuration must:

- enumerate TanStack Start entry points and every public module gate;
- require boundary coverage for production source files;
- enforce provider ownership with a repository rule pack;
- use complete TypeScript 7 type-aware analysis;
- reject stale or unexplained suppressions; and
- gate dead code, duplication, and function health against separately reviewed
  baselines while `fallow audit` rejects changed-code regressions.

The dead-code baseline contains no findings. The duplication and health
baselines record inherited findings so the consolidation itself does not mix
large behavioral refactors into the tool migration. Each baseline is an
explicit debt inventory: entries may be removed after refactoring, but new
entries require review and must not be added merely to make CI pass.

Affected-test discovery uses Fallow impact closure. It fails closed to the full
Vitest suite when analysis fails, a changed source file no longer exists, or no
relevant tests can be proven.

## Consequences

Normal checks no longer depend on Graphviz or four overlapping JavaScript
analysis stacks. Forks can run the same deterministic local gate as the primary
repository. The checked-in baselines and executable negative fixtures make
changes to the guardrail reviewable and prevent a silently empty source graph.
