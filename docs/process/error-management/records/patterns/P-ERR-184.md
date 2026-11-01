<!-- pd-error-record
{
  "schemaVersion": 1,
  "recordType": "pattern",
  "recordId": "P-ERR-184",
  "displayId": "ERR-184",
  "title": "Paste-ready snippet duplicated an existing parent key: following the copy would make .pd/config.yaml unparseable and drop the whole config to defaults",
  "status": "active",
  "category": "Documentation & Spec Drift",
  "ep": "EP-04",
  "createdAt": "2026-10-31",
  "source": "PR 2253 code review (agent), reproduced with js-yaml 5.4.3 against a real workspace config"
}
-->

Copy was rewritten to be "paste-ready" by printing a complete top-level YAML block:

    features:
      host.workbuddy:
        enabled: true

Two independent problems with that shape. (1) Every real `.pd/config.yaml` already has a top-level `features:` key, so a user appending the advertised block produces a DUPLICATE mapping key; js-yaml 5.4.3 throws `duplicated mapping key`, and `loadPdConfigForPlugin` converts that into `source: 'malformed'` with `computeEffectivePdConfig(null)` — PD drops to defaults, so the flag the user just "enabled" is off AND their runtimeProfiles/internalAgents are silently discarded. (2) The claim "the dotted id is one flat key" was correct but unverifiable from the copy: nothing showed what the user was expected to type into the file they already have.

Net effect: the guidance intended to fix "config silently ineffective" could turn a working config into an unparseable one.

Must check: before calling any snippet paste-ready, run it against a REAL file of that kind (existing keys, existing blocks) and parse the result with the project's loader. If the target file already contains the parent key, the instruction must be "inside the existing <parent>: block set X: {enabled: true}" — a single-line flow mapping that is added, not appended as a new root block. Pin both halves: the snippet parses, and it yields exactly one key at the expected level.
