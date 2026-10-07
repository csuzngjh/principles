# ADR-0028: Owner Principle Assets and Evolution

> **Status**: Proposed — Owner-authorized documentation integration; pending the existing ADR review process
> **Date**: 2026-10-07
> **Decider**: Owner
> **Decision basis**: PD v2 architecture freeze and Owner-approved integration plan; target design, not a claim of completed migration
> **Supersedes**: None as a whole. Refines Principle ownership and evolution; preserves ADR-0017's single ledger implementation contract.
> **Related**: [ADR-0014](0014-mvp-first-strategy-and-product-pivot.md), [ADR-0017](0017-principle-ledger-single-implementation.md), [ADR-0022](0022-owner-identity-registration.md), [ADR-0027](0027-principle-intervention-evidence-and-delivery-contract.md)
> **Existing contract**: [Core Value Pipeline Governance SPEC](../specs/PD_CORE_VALUE_PIPELINE_GOVERNANCE_SPEC.md)

## 1. Context

Current Principles use a workspace ledger. This is an existing implementation boundary, not a hidden sharing bug. The target product requires the Owner's experience to survive project and host changes. Ownership, use authorization and storage location must therefore be different concepts.

The existing ledger implementation remains authoritative until a separately authorized migration. This ADR does not claim that an Owner Asset Layer, immutable content revision store or cross-workspace sharing already exists.

## 2. Decision

### 2.1 Ownership and authorization

The target Principle owner is the Owner. Workspace provides authorized use scope and local evidence isolation. Machine provides storage and execution, not asset identity.

```text
Owner -> Principle -> immutable Revision
             |
           Binding -> exact Revision
             |
      Workspace / Agent / Runtime
             |
      Activation of a binding configuration
```

A Binding is explicit use authorization, not a writable Principle copy. It defines exact revision, workspace/agent/host scope, applicability/exclusions, channel and delivery commitment. Each Activation pins its Binding configuration and content reference; it does not follow a mutable latest-version pointer.

Owner asset authority owns Principle identities, accepted revisions, decisions and bindings. Local workspace evidence keeps its source authority. Runtime prompts, enforcement artifacts, indexes and caches are derived projections.

An Owner owning an asset does not grant every workspace access. Project-specific assets remain source-scoped until explicit authorization. Sharing a Principle does not share raw tasks, conversations, files or all supporting evidence. Summary and metadata sharing also requires an authorized boundary. Existing Owner identity resolution is reused; neither an OS username, a machine identifier nor a folder path substitutes for Owner identity.

### 2.2 Separate lifecycles

| Object | Target lifecycle |
| --- | --- |
| Existing Candidate/proposal | Proposed, then Owner accepted or rejected; not a formal asset |
| Principle | In service or retired; restoration requires an explicit Owner decision |
| Revision | Immutable content; authorization and replacement relationships come from decisions |
| Binding | Authorized configuration with history, or revoked |
| Activation | Enabled, paused, ended; fixed historical content/configuration reference |
| Owner Decision | Immutable decision record; later decisions can revoke its effect |

Active is not a universal Principle state: the same asset may be enabled on one host and paused on another. Revised and superseded describe version/replacement relationships, not a mandatory linear asset state machine. Restoration does not automatically reactivate historical bindings.

### 2.3 Revision and identity

Changes within the same behavioral purpose create a new immutable Revision under the same Principle identity. A genuinely different behavioral purpose creates a new Principle with lineage. A workspace/host authorization change alone versions the Binding configuration instead of changing Principle text. Classification may be recommended by an LLM; the Owner decides.

Revisions preserve predecessor and source evidence references. A digest detects content drift but cannot grant approval or serve as a replacement Principle identity. Existing repair-process identities remain distinct.

Accepting a new Revision must specify the old version's disposition: continue in identified bindings, migrate identified bindings, or revoke further use. No implicit replacement of existing Activations is allowed. New activation records implement approved cutovers; old records and their evidence retain their original references.

### 2.4 Evolution operations

| Operation | Minimal v2 boundary |
| --- | --- |
| narrow | New Revision for semantic change; Binding configuration change for use-scope restriction |
| expand | Explicit Owner approval of semantics or use scope; never automatic propagation |
| supersede | Record replacement lineage and an explicit old-binding disposition; no automatic activation transfer |
| retire | Owner decision stops further authorized use; preserve history |
| merge / split | Native operations deferred; not required for the minimal learning loop |

Reuse review precedes new asset creation. New evidence normally augments an existing asset's evidence instead of creating another Principle. Duplicate assets can be resolved by an Owner-selected replacement and retirement, without a generic merge engine. Complementary assets can coexist. Conflicting assets require explicit scope/authorization resolution.

LLMs can recommend reuse, revision, narrowing, expansion, replacement and retirement. Formal creation, modification, merge, scope expansion and retirement remain Owner decisions. Deterministic execution of already authorized expiry/revocation is not an autonomous value decision.

### 2.5 Reversibility and revocation

Revocation controls future delivery and supported execution boundaries. Previously delivered text cannot be reliably removed from an in-flight model context. Audit must state when the stop becomes enforceable and what remains in flight.

Runtime rollback must not revive revoked content from an old cache. Asset restoration requires a new Owner decision and does not restore old Activations implicitly. Historical evidence and decisions remain reviewable subject to their privacy/retention contracts.

## 3. Alternatives Considered

- Workspace ownership: preserves local execution but fragments the Owner's long-term asset across copied ledgers.
- Machine ownership: confuses the custodian with the governance subject.
- Hybrid ownership: leaves final revision and approval authority ambiguous.
- Mutable Principle text: makes past behavior impossible to interpret against its original content.
- New Principle on every edit: fragments evidence and multiplies assets unnecessarily.
- Automatic latest-version activation: changes Owner-authorized behavior without an explicit cutover.

## 4. Consequences

Stable identity and explicit scope allow cross-host reuse without universal visibility. Version and Binding management adds necessary governance work. The effective runtime set can remain bounded while historical assets are preserved; growth control does not mean model-driven deletion.

The target is local-first, single-machine and compatible with SQLite/local ledgers. No forced cloud, live multi-machine synchronization, multi-master writing, general memory or model training follows from this decision.

## 5. Migration Impact

Maintain three reading layers in existing domain and architecture documents:

1. **Current Implementation**: existing workspace ledger, schemas, identifiers and activation behavior.
2. **Phase 1 Added Concepts**: evidence references/snapshots, Episodes, Effects and Outcomes; no asset migration or new formal revisions.
3. **Future Target Model**: Owner asset authority, immutable revisions and explicit bindings, implemented only by a separately authorized migration.

Migrate incrementally by asset or workspace. Preserve original scope and identifiers through mappings; sharing requires a separate Owner decision. Do not fabricate historical approvals.

For each cutover: pause relevant writers, preserve a backup, import and verify, switch the single write authority, make the source read-only, then resume supported writers. Unknown/old writers must be accounted for before switching. There is no long-term dual-write authority.

After new decisions exist in the target ledger, restoring an old backup is not a valid governance rollback. Recovery must preserve those decisions and revocations. Until cutover, ADR-0017's current implementation and locking authority remain unchanged.

## 6. Review and verification

Accept through the existing ADR process. Updating LOCKED-ONTOLOGY documents follows their existing review requirement. A design's acceptance does not mark its target as implemented.

Later migration acceptance must prove shared identity across authorized hosts/workspaces, denied unauthorized access, pinned revision history, explicit cutover, revocation across restart, and absence of dual writers. Phase 1 does not claim these migration outcomes.
