# Principle Lifecycle Review Workflow

> Status: Active
> Date: 2026-05-03
> Related: PRI-23, PRI-24, PRI-25, PRI-26

## Overview

The principle lifecycle review workflow is a **non-destructive, human-in-the-loop audit system** for principle health signals. It transforms `PruningReadModel` watch/review signals into operator-driven review decisions without modifying the principle ledger or `state.db`.

**Goals:**
- Provide visibility into stale, orphan, or at-risk principles
- Record operator decisions as append-only audit logs
- Serve as the foundation for future lifecycle mutation (archive, demote, delete)

**Non-goals:**
- No automatic pruning, deletion, or demotion
- No ledger or `state.db` mutation
- No background workers
- Destructive lifecycle changes require a separate future issue with human confirmation and rollback plan

---

## Architecture

```
Operator
   │
   ▼
PruningReadModel (read-only signal source)
   │
   ├── getPrincipleSignals() ──► signal list with riskLevel + reasons
   └── getHealthSummary()   ──► aggregate health metrics

┌─────────────────────────────────────────────────────┐
│  pd runtime pruning report                         │
│  → Shows all watch/review signals (human review)   │
└─────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────┐
│  pd runtime pruning explain --principle-id <id>    │
│  → Shows full evidence for a single principle      │
└─────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────┐
│  pd runtime pruning review --principle-id <id>     │
│         --decision keep|defer|archive-candidate    │
│         --note "..."                               │
│  → appends record to .state/pruning_reviews.jsonl │
└─────────────────────────────────────────────────────┘

PruningReviewLog (append-only JSONL audit log)
   │
   └── appendPruningReview() ──► .state/pruning_reviews.jsonl
```

### Components

| Component | Role |
|-----------|------|
| `PruningReadModel` | Reads ledger + candidates DB, computes risk signals |
| `pd runtime pruning report` | Lists all watch/review principles |
| `pd runtime pruning explain` | Shows full evidence for one principle |
| `pd runtime pruning review` | Records operator decision to audit log |
| `pruning-review-log.ts` | Append-only JSONL storage |

---

## Storage

**Location:** `<workspace>/.state/pruning_reviews.jsonl`

**Format:** One JSON record per line (JSONL)

```json
{
  "reviewId": "uuid-v4",
  "principleId": "p-xxxxx",
  "decision": "keep|defer|archive-candidate",
  "note": "operator note",
  "reviewer": "operator",
  "reviewedAt": "2026-05-03T12:00:00.000Z",
  "signalSnapshot": {
    "principleId": "p-xxxxx",
    "status": "active",
    "createdAt": "...",
    "updatedAt": "...",
    "derivedCandidateIds": ["c-001"],
    "derivedPainCount": 0,
    "matchedCandidateCount": 1,
    "recentCandidateCount": 0,
    "orphanCandidateCount": 0,
    "ageDays": 120,
    "riskLevel": "review",
    "reasons": ["review: principle older than 90 days with no derived pain signals"]
  }
}
```

---

## Command Examples

### 1. View pruning health report

```bash
# Text output (default)
pd runtime pruning report --workspace /path/to/workspace

# JSON output
pd runtime pruning report --workspace /path/to/workspace --json
```

**Output includes:**
- `watchCount` / `reviewCount` per risk level
- Per-principle signals with reasons
- Read-only notice: "No principles are modified or deleted."

---

### 2. Explain a specific principle

```bash
# Text output
pd runtime pruning explain --principle-id p-xxxxx --workspace /path/to/workspace

# JSON output (includes full signal snapshot)
pd runtime pruning explain --principle-id p-xxxxx --workspace /path/to/workspace --json
```

**Output includes:**
- `principleId`, `status`, `riskLevel`, `ageDays`
- `derivedPainCount`, `matchedCandidateCount`, `orphanCandidateCount`
- `reasons[]` — enumerated evidence for the signal

---

### 3. Record a keep decision

```bash
pd runtime pruning review \
  --principle-id p-xxxxx \
  --decision keep \
  --note "Principle is actively used in M7 pipeline; no action needed" \
  --workspace /path/to/workspace \
  --json
```

---

### 4. Record a defer decision

```bash
pd runtime pruning review \
  --principle-id p-xxxxx \
  --decision defer \
  --note "Need more data before deciding; revisit after next cycle" \
  --workspace /path/to/workspace
```

---

### 5. Record an archive-candidate decision

```bash
pd runtime pruning review \
  --principle-id p-xxxxx \
  --decision archive-candidate \
  --note "Principle was only used in P2 prototype; no longer referenced" \
  --workspace /path/to/workspace
```

> **Note:** `--note` is required for `archive-candidate` decisions.

---

## Decision Semantics

| Decision | Meaning |
|----------|---------|
| `keep` | Operator reviewed and wants to keep observing/using this principle |
| `defer` | Not enough evidence or review postponed; revisit later |
| `archive-candidate` | Flagged for future archival consideration — does **NOT** currently archive or change status |

**Important:** All review decisions are **audit records only**. A review decision does not modify the principle in the ledger, does not change `status` in `state.db`, and does not trigger any background process. The audit log captures the operator's intent for future reference.

---

## Guardrails

1. **No ledger mutation** — `appendPruningReview` only writes to `pruning_reviews.jsonl`
2. **No `state.db` mutation** — no `UPDATE` or `DELETE` on any table
3. **No automatic pruning** — human must trigger every review decision
4. **No background workers** — no scheduled jobs or event-driven side effects
5. **Audit-only default** — report and explain commands are always read-only

**Destructive lifecycle mutation** (archive, demote, delete) requires:
- A separate future issue
- Human confirmation step
- Rollback plan before execution
- No automatic execution

---

## Operator Workflow

**Step 1: Run the pruning health report**

```bash
pd runtime pruning report --workspace /path/to/workspace --json
```

Review watch/review flagged principles.

---

**Step 2: Inspect a flagged principle**

```bash
pd runtime pruning explain --principle-id p-xxxxx --workspace /path/to/workspace --json
```

Review the evidence: age, orphan candidates, derived pain count, status, reasons.

---

**Step 3: Record a review decision**

```bash
pd runtime pruning review \
  --principle-id p-xxxxx \
  --decision keep|defer|archive-candidate \
  --note "..." \
  --workspace /path/to/workspace
```

The review is appended to the audit log with a full signal snapshot.

---

**Step 4: Follow-up lifecycle mutation (future)**

If a review decision identifies a principle that should be archived, demoted, or deleted, create a separate issue with:
- Reference to the review audit record
- Human confirmation step
- Rollback plan
- No automatic execution

---

## Troubleshooting

### Principle not found

```
Error: Principle not found: 'p-xxxxx'
```

The `principleId` does not exist in the ledger. Verify the ID with:

```bash
pd runtime pruning report --workspace /path/to/workspace --json | grep principleId
```

---

### Invalid decision

```
Error: Invalid decision: 'xxx'. Must be one of: keep, defer, archive-candidate
```

Valid decisions are: `keep`, `defer`, `archive-candidate`.

---

### archive-candidate requires --note

```
Error: archive-candidate decision requires --note
```

When using `--decision archive-candidate`, you must provide `--note "..."`.

---

### Workspace path not found

Ensure the `--workspace` path is the workspace root (contains `.state/` directory).

```bash
ls /path/to/workspace/.state  # should list principle_training_state.json
```

---

### Corrupt JSONL lines

`listPruningReviews()` silently skips corrupt lines. If a line fails to parse, it is skipped and processing continues.

To inspect the raw log:

```bash
cat /path/to/workspace/.state/pruning_reviews.jsonl
```

Each line should be valid JSON.

---

## Related Documents

- [ADR-0001: Runtime v2 Service Boundaries](../adr/0001-runtime-v2-service-boundaries.md)
- [PD Runtime v2 Milestone Roadmap](./pd-runtime-v2/runtime-v2-milestone-roadmap.md)