# @principles/codex-adapter

## 0.4.7

### Patch Changes

- 84c7074: PRI-892: fixed the silent no-op of `npx create-principles-disciple` on Windows. Node resolves the main module through symlinks/junctions while `process.argv[1]` keeps the unresolved link path handed over by npm/npx `.bin` shims, so the raw `pathToFileURL(argv[1]) === import.meta.url` entry guard never matched and the CLI exited 0 with zero output (install / repair-update-chain / uninstall all dead). The guard now canonicalizes argv[1] with `realpathSync` before comparing (fail-safe: an unreadable entry is simply not the main module), keeps the cli-7 import-safety semantics (importing the module still never parses argv), and adds an rc-9 observable fallback: when the entry path unambiguously names this package's `dist/index.js` but canonicalization still misses, the CLI warns on stderr instead of saying nothing. The identical guard in the Codex `pd-hook` entry is fixed the same way (linked installs previously skipped `main()` silently). Regression tests spawn the built CLI and hook through a junction path and assert real output (red before the fix: empty stdout, exit 0).
- 1ac725c: PRI-892 follow-up (last open review finding of the merged PR #1833): the Codex `pd-hook` entry guard could still reproduce the silent no-op it was introduced to remove, because it compared `argv[1]` only after `realpathSync` and answered a failed lookup with `return false`. A legitimate direct invocation whose realpath lookup threw (EPERM, an antivirus-held path, an exotic mount) therefore skipped `main()` and the hook emitted nothing. The guard now decides in three layers: the raw `pathToFileURL(argv[1]) === import.meta.url` comparison runs first, so an ordinary `node dist/pd-hook.js` never depends on a filesystem lookup succeeding; realpath canonicalization still covers the npm/npx `.bin` shim and junctioned-install case; and when realpath itself throws while `argv[1]` still names this file, the guard writes a bounded rc-9 diagnostic (`reason=entry_identity_unverified … nextAction=…`) and runs `main()`, preserving the hook contract of exactly one JSON object on stdout. cli-7 import-safety is unchanged, and the installer needed no edit because its `looksLikeOwnDistEntry()` fallback already resolves without realpath. Regression tests pin all three layers by spawning the built hook through a real path, a junction path and an unresolvable path, plus the negative control that an unresolvable entry naming a different file stays silent.
- Updated dependencies [c7453ea]
- Updated dependencies [99e6a8c]
- Updated dependencies [edbbcd9]
- Updated dependencies [8b7b775]
- Updated dependencies [9d98f89]
- Updated dependencies [92074a0]
  - @principles/host-runtime@0.7.8
  - @principles/core@1.287.2
  - @principles/install-layout@0.2.7

## 0.4.6

### Patch Changes

- 8ae91f4: Re-cut of @principles/codex-adapter. The 0.4.5 tarball on npm was published by a legacy release run carrying stale internal dependency ranges (@principles/core ^1.74.1, @principles/host-runtime ^0.1.0), so an install resolving to 0.4.5 pulls inconsistent dependency copies. npm tarballs are immutable and cannot be corrected in place, so this publishes a fresh 0.4.6 from the current aligned tree (@principles/core ^1.287.0, @principles/host-runtime ^0.7.7, @principles/install-layout ^0.2.0). Version re-cut only; no source change.
- Updated dependencies [75b4ac4]
  - @principles/core@1.287.1

## 0.4.5

### Patch Changes

- 8424d60: Baseline-cutover dependency-contract fix: the @principles/host-runtime range now matches the aligned version (^0.7.7) so workspace resolution stays single-copy after version alignment (ERR-131).
- Updated dependencies [8424d60]
  - @principles/core@1.287.0
