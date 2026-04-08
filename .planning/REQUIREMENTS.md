# Requirements: v1.9.0 Principle Internalization System

**Defined:** 2026-04-07  
**Core Value:** AI agents improve their own behavior through a structured loop: pain -> diagnosis -> principle -> gate -> active -> reflection -> training -> internalization

## v1.9.0 Requirements

### Principle Tree Ledger

- [x] **TREE-01**: system can persist `Rule` entities as first-class principle-tree records rather than document-only concepts
- [x] **TREE-02**: system can persist `Implementation` entities as first-class principle-tree leaves linked to a parent `Rule`
- [x] **TREE-03**: system can query `Principle -> Rule -> Implementation` relationships for any active principle
- [x] **TREE-04**: one Rule can reference multiple Implementations without collapsing semantic and runtime layers

### Runtime Code Host

- [x] **HOST-01**: runtime gate chain executes a `Rule Host` between `GFI Gate` and `Progressive Gate`
- [x] **HOST-02**: active code implementations execute through a fixed host contract and helper whitelist instead of arbitrary workspace access
- [x] **HOST-03**: a code implementation can return `allow`, `block`, or `requireApproval` plus structured diagnostics
- [x] **HOST-04**: host failure degrades conservatively without disabling existing hard-boundary gates

### Implementation Storage

- [x] **IMPL-01**: `Implementation(type=code)` is stored as a versioned asset with manifest, entry file, replay samples, and latest evaluation report
- [x] **IMPL-02**: code implementations support lifecycle states `candidate`, `active`, `disabled`, and `archived`
- [x] **IMPL-03**: a promoted implementation can be disabled or rolled back without corrupting the principle tree ledger

### Replay and Promotion

- [x] **EVAL-01**: system can replay `pain-negative` samples against a candidate code implementation
- [x] **EVAL-02**: system can replay `success-positive` samples and detect newly introduced false positives
- [x] **EVAL-03**: system can replay `principle-anchor` samples so principles constrain forward behavior rather than only memorizing past pain
- [x] **EVAL-04**: replay produces a structured evaluation report that determines whether a candidate can be promoted
- [x] **EVAL-05**: promotion of code implementations is manual until replay and rollback loops are stable

### Nocturnal Code Candidate Factory

- [x] **NOC-01**: nocturnal reflection can emit `RuleImplementationArtifact` candidates distinct from behavioral training artifacts
- [x] **NOC-02**: a code implementation artifact records its originating principle, rule, snapshot, and source pain / gate-block context
- [x] **NOC-03**: nocturnal code candidate generation reuses existing selection, snapshot extraction, and validation skeletons without conflating artifact types

### Coverage and Lifecycle

- [x] **COV-01**: system computes `Rule.coverageRate` from replay and live implementation behavior rather than implementation existence alone
- [x] **COV-02**: system computes `Rule.falsePositiveRate` from `success-positive` replay and live misfires
- [x] **COV-03**: system updates `Principle.adherenceRate` from rule coverage and repeated error reduction
- [x] **COV-04**: system can mark a principle as a `deprecated` candidate only when stable lower-layer implementations genuinely absorb it

### Internalization Strategy

- [ ] **ROUT-01**: system can represent “cheapest viable implementation first” as an explicit internalization strategy
- [ ] **ROUT-02**: system does not default every principle failure to code implementation when a cheaper skill or prompt route would suffice

## v2 Requirements

### Multi-Form Internalization

- **MULTI-01**: system routes principle failures between skill, code, LoRA, and heavier optimization paths using explicit policy
- **MULTI-02**: code, skill, and LoRA implementations can contribute jointly to rule coverage accounting
- **MULTI-03**: system can escalate an inadequately internalized principle from one implementation form to a heavier one using measured evidence

### Automation and Review

- **AUTO-01**: nocturnal code implementation candidates can enter a review queue with confidence scoring and operator triage
- **AUTO-02**: promotion can move from manual to supervised automation once false-positive and rollback metrics are stable

## Out of Scope

| Feature | Reason |
|---------|--------|
| removing `Progressive Gate` in v1.9.0 | existing host hard-boundary layer must remain until the new code implementation path is proven |
| auto-deploying code implementations directly from nocturnal output | replay and rollback loops must be stable before automation |
| forcing every principle into code implementation | the system must prefer the cheapest viable internalization path |
| LoRA or full fine-tune execution pipeline buildout | this milestone focuses on the code implementation branch only |
| dashboard-first work for internalization analytics | ledger, host, replay, and nocturnal candidate flow come first |
| `packages/openclaw-plugin` product-side fixes unrelated to internalization architecture | outside this milestone’s scope |
| `D:/Code/openclaw` changes | outside this repo |

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| TREE-01 | Phase 11 | Complete |
| TREE-02 | Phase 11 | Complete |
| TREE-03 | Phase 11 | Complete |
| TREE-04 | Phase 11 | Complete |
| HOST-01 | Phase 12 | Complete |
| HOST-02 | Phase 12 | Complete |
| HOST-03 | Phase 12 | Complete |
| HOST-04 | Phase 12 | Complete |
| IMPL-01 | Phase 12 | Complete |
| IMPL-02 | Phase 12 | Complete |
| IMPL-03 | Phase 13 | Complete |
| EVAL-01 | Phase 13 | Complete |
| EVAL-02 | Phase 13 | Complete |
| EVAL-03 | Phase 13 | Complete |
| EVAL-04 | Phase 13 | Complete |
| EVAL-05 | Phase 13 | Complete |
| NOC-01 | Phase 14 | Complete |
| NOC-02 | Phase 14 | Complete |
| NOC-03 | Phase 14 | Complete |
| COV-01 | Phase 15 | Complete |
| COV-02 | Phase 15 | Complete |
| COV-03 | Phase 15 | Complete |
| COV-04 | Phase 15 | Complete |
| ROUT-01 | Phase 15 | Pending |
| ROUT-02 | Phase 15 | Pending |

**Coverage:**
- v1.9.0 requirements: 25 total
- Mapped to phases: 25
- Unmapped: 0 ✅

---
*Requirements defined: 2026-04-07*
*Last updated: 2026-04-08 after completing Phase 15-01*
