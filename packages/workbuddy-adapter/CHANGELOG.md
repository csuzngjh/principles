# @principles/workbuddy-adapter

## 0.2.4

### Patch Changes

- bf5aed3: Introduce an opt-in WorkBuddy native current-user keyword Pain path using the shared high-precision detector, canonical Pain admission and Diagnostician task continuation. Expose effective keyword detection status; leave the feature off by default and preserve Codex ingestion consent boundaries.
- Updated dependencies [bf5aed3]
  - @principles/core@1.294.1
  - @principles/host-runtime@0.10.4

## 0.2.3

### Patch Changes

- b02ebb5: Deliver WorkBuddy pain recording, status, Owner review and disable skills through the plugin package, marketplace and versioned cache. Reject incomplete payloads and unsafe manifest versions before registration, refresh old hook-only caches even at the same manifest version while preserving native registry scopes and older cache versions, confine cache replacement to the PD plugin version directory, and delegate disable to the existing official installer API.
- b02ebb5: Connect WorkBuddy current-user explicit Owner pain submissions to existing governance admission and diagnostic task creation. Preserve native session/turn identity, unverified Owner evidence, bounded input rejection and model-visible receipts; retain Codex prefix behavior through the shared parser.
- Updated dependencies [b02ebb5]
  - @principles/core@1.293.4
  - @principles/host-runtime@0.10.2

## 0.2.2

### Patch Changes

- Updated dependencies [fec1306]
- Updated dependencies [574954a]
- Updated dependencies [06152af]
  - @principles/install-layout@0.4.0
  - @principles/core@1.293.0
  - @principles/host-runtime@0.10.0

## 0.2.1

### Patch Changes

- ccc04eb: Switch distributed PD packages to Apache License 2.0, ship matching LICENSE/NOTICE files, and preserve the historical MIT notice. This is a licensing and packaging release without runtime feature changes.
- Updated dependencies [ccc04eb]
  - @principles/core@1.292.1
  - @principles/host-runtime@0.9.1
  - @principles/install-layout@0.3.1

## 0.2.0

### Minor Changes

- 5e794be: New package: the WorkBuddy host adapter (third ADR-0020 host) — decoder/encoder, hook entry with the probed fail-closed contract, tool semantics, evidence recorder, plugin skeleton, governance worker cycle.

### Patch Changes

- Updated dependencies [6e60d84]
- Updated dependencies [0f94f8c]
- Updated dependencies [4ba83b7]
- Updated dependencies [5e794be]
- Updated dependencies [5e794be]
- Updated dependencies [5e794be]
  - @principles/core@1.292.0
  - @principles/host-runtime@0.9.0
  - @principles/install-layout@0.3.0
