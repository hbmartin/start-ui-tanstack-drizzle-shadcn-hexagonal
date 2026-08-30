# Stryker TypeScript 7 compatibility

Last reviewed: 2026-08-29

The application compiler is TypeScript 7.0.2. Mutation testing uses Stryker
10.0.0, whose native checker contains the experimental TypeScript 7 support
merged in [PR #6099](https://github.com/stryker-mutator/stryker-js/pull/6099).
The upstream [TypeScript 7 migration tracker](https://github.com/stryker-mutator/stryker-js/issues/6110)
remains open, so this repository keeps the compatibility layer isolated under
`tools/mutation` and runs it only in manual, scheduled, and release-tag jobs.

## Version resolution

`@typescript/typescript6@6.0.3` is not a published package version. As of the
review date, the published `npm:@typescript/typescript6@6.0.2` wrapper resolves
its internal compiler to TypeScript 6.0.3. The manifest therefore pins the
available wrapper rather than inventing a version, while `pnpm mutation:compat`
checks the effective runtime resolution:

- root `typescript` resolves to 7.0.2;
- mutation `typescript` resolves through
  `npm:@typescript/typescript6@6.0.2` to TypeScript 6.0.3;
- mutation `@typescript/native` resolves to TypeScript 7.0.2; and
- Stryker's native checker classifies a compiler diagnostic as `compileError`.

The mutation tsconfigs deliberately contain no project references. Native
mutant grouping is not emulated locally; the runner retains upstream's current
ungrouped behavior. `typescriptChecker.experimentalNativePreview` stays enabled
because upstream still labels the native checker experimental.

## Upstream exit criteria

An issue being closed or a pull request being merged is not sufficient. Each
change below requires a published Stryker version containing the fix, updated
local compatibility evidence, and a successful scheduled mutation ratchet.

| Upstream item | Current constraint | Removal criterion |
| --- | --- | --- |
| [#6111](https://github.com/stryker-mutator/stryker-js/issues/6111) | TypeScript 6 remains installed under the normal `typescript` name for tsconfig preprocessing. | Remove the isolated wrapper and package extension only after a released Stryker version preprocesses tsconfigs without the normal TypeScript 6 package and `pnpm mutation:compat` proves that absence. |
| [#6112](https://github.com/stryker-mutator/stryker-js/issues/6112) | TypeScript 7 checker runs use upstream's ungrouped behavior. | Adopt mutant grouping only after a released Stryker version supports TypeScript 7 grouping and a multi-mutant compatibility fixture plus the mutation ratchet pass. |
| [#6113](https://github.com/stryker-mutator/stryker-js/issues/6113) | `experimentalNativePreview` is required. | Remove the experimental flag only after a released Stryker version marks TypeScript 7 support final and the compatibility test rejects the obsolete flag. |

This file is release evidence, not an update automation. Re-check the linked
primary sources during dependency refreshes; do not relax a constraint from an
issue title or unreleased branch alone.
