# @principles/codex-adapter

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
