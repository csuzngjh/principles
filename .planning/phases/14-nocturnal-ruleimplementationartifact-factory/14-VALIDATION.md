# Phase 14: Nocturnal RuleImplementationArtifact Factory - Validation

## Validation Architecture

Phase 14 introduces a second nocturnal output class while preserving the existing behavioral artifact path. Validation therefore has to prove both:

1. behavioral nocturnal output still works exactly as before
2. code-candidate output is only created when route, validation, and persistence contracts all pass

## Validation Layers

### Layer 1: Contract validation

Proves:

- deterministic `principle -> rule` resolution
- Artificer output parses into a stable code-candidate contract
- candidate source validation rejects forbidden or incompatible code

Primary tests:

- `tests/core/nocturnal-artificer.test.ts`
- `tests/core/nocturnal-rule-implementation-validator.test.ts`

### Layer 2: Persistence and lineage validation

Proves:

- successful code candidates become `Implementation(type=code, lifecycleState='candidate')`
- implementation storage writes candidate assets correctly
- artifact lineage preserves source principle/rule/snapshot plus both pain refs and gate-block refs where present
- replay `SampleClassification` remains unchanged

Primary tests:

- `tests/core/nocturnal-artifact-lineage.test.ts`
- service-level tests that inspect ledger + storage together

### Layer 3: Orchestration safety validation

Proves:

- behavioral nocturnal artifacts still persist when Artificer is skipped
- behavioral nocturnal artifacts still persist when Artificer fails validation or persistence
- Artificer never blocks the existing nocturnal success path

Primary tests:

- `tests/service/nocturnal-service-code-candidate.test.ts`

## Phase Pass Conditions

Phase 14 is considered complete only when all of the following are true:

1. a nocturnal run can emit a behavioral artifact without any code candidate
2. a nocturnal run can emit both a behavioral artifact and a candidate implementation
3. ambiguous `principle -> rule` resolution causes Artificer skip, not arbitrary candidate generation
4. invalid candidate code never persists to ledger/storage as a live candidate
5. replay dataset classification semantics remain unchanged

## Out-of-Scope Validation

Phase 14 does not validate:

- replay promotion quality thresholds beyond “candidate exists for replay”
- coverage/adherence/deprecation accounting
- automatic promotion or routing across skill/code/LoRA paths
