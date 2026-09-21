# @principles/pd-cli

## 1.152.11

### Patch Changes

- 8424d60: Baseline-cutover dependency-contract fix: the internal dependency ranges now match the aligned component versions (principles-disciple ^2.0.1, @principles/host-runtime ^0.7.7, @principles/codex-adapter ^0.4.4). Without this, npm would nest stale registry copies inside the workspace after version alignment (ERR-131 single-copy violation; the 2026-09-19 release-train failure mode).
- Updated dependencies [8424d60]
- Updated dependencies [8424d60]
- Updated dependencies [8424d60]
  - @principles/codex-adapter@0.4.5
  - @principles/core@1.287.0
  - principles-disciple@2.0.2
