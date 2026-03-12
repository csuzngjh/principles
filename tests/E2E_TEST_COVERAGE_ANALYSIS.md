# E2E Test Coverage Analysis

> **Analysis Date**: 2026-03-12
> **Scope**: End-to-end feature chain testing through agent conversations
> **Excludes**: Single-point unit tests

---

## Summary

**Current State**: 6 E2E test scenarios covering core infrastructure
**Test Coverage**: ~40% of feature chains have E2E tests
**Critical Gaps**: OKR Management, Sub-Agent Collaboration, User Onboarding

---

## Existing E2E Tests (6)

### 1. trust-system-deep.json
**Feature Chain**: Trust Engine V2 Complete Lifecycle
- Cold start (initial score 85, 5 grace failures)
- Grace failures consumption
- Penalty calculations with adaptive scaling
- Reward calculations with consistency tracking
- Stage transitions (Stage 0→1→2→3→4)
- Stage boundary enforcement

**Coverage**: ✅ Complete trust system lifecycle tested

### 2. pain-evolution-chain.json
**Feature Chain**: Pain Detection → Trust Update → Evolution Queue → Diagnostic
- Pain signal detection (tool failures, risky operations)
- Pain signal scoring (0-100 scale)
- Trust score updates (penalties/rewards)
- Evolution queue management
- Semantic similarity matching
- Diagnostic command triggering

**Coverage**: ✅ Complete pain-evolution chain tested

### 3. evolution-worker.json
**Feature Chain**: Background Worker Service
- EvolutionWorkerService initialization
- Periodic pain flag scanning (90s intervals)
- Queue management (add/remove/clear)
- Semantic search for similar pain signals
- High-score signal prioritization

**Coverage**: ✅ Background worker lifecycle tested

### 4. gatekeeper-boundaries.json
**Feature Chain**: Progressive Gatekeeper Enforcement
- Stage 0 (Cold Start): Read-only enforcement
- Stage 1 (Restricted): PLAN whitelist only
- Stage 2 (Conditional): Audit verification
- Stage 3 (Trusted): Full access
- Risk path validation across stages
- Manual override via `/trust` command

**Coverage**: ✅ All 4 stages + boundaries tested

### 5. gatekeeper.json
**Feature Chain**: Basic Gate Enforcement
- PLAN.md readiness checks
- Risk path validation
- Allow/deny decisions
- Block event logging

**Coverage**: ✅ Basic gatekeeping logic tested

### 6. thinking-os.json
**Feature Chain**: Thinking OS Injection & Usage Tracking
- Mental model injection (T-01 through T-09)
- Usage tracking per model
- Cognitive compliance detection
- `/thinking-os` command operations

**Coverage**: ✅ Thinking OS lifecycle tested

---

## Missing E2E Tests (10+)

### P0 - Critical (Must Have)

#### 1. OKR Management Complete Flow
**Feature Chain**: Strategy Definition → OKR Decomposition → Progress Tracking → Completion
- `/init-strategy` command (vision, objectives)
- `/manage-okr` command (Key Results, agents, timeline)
- Weekly governance lifecycle (proposal/challenge/owner-approval/execution)
- CURRENT_FOCUS.md alignment checks
- WEEK_STATE.json transitions
- AGENT_SCORECARD updates from OKR completion

**Why Critical**: OKR is the strategic compass - all agent work should align to it

**Estimated Complexity**: High (requires 4-5 phase conversation)

#### 2. Sub-Agent Collaboration Flow
**Feature Chain**: Main Agent Spawns → Task Execution → Result Return → Context Restoration
- `TaskCreate` tool usage
- Thinking OS propagation to sub-agent
- Sub-agent task execution
- Task result return
- Context restoration after sub-agent ends
- Failure tracking if sub-agent fails

**Why Critical**: Core collaboration mechanism - entire system depends on this

**Estimated Complexity**: High (requires multi-agent simulation)

#### 3. Cognitive Hygiene Flow
**Feature Chain**: Task Execution → Persistence Detection → Hygiene Score → Reminder Trigger
- Detect non-persistent work (edit without save)
- Hygiene score calculation (0-100)
- Reminder trigger when score < 30
- `/hygiene` command operations
- Score recovery after persistent work

**Why Critical**: Prevents context loss - major source of agent failures

**Estimated Complexity**: Medium (requires simulation of edit/save patterns)

---

### P1 - Important (Should Have)

#### 4. User Onboarding Flow
**Feature Chain**: New Workspace → BOOTSTRAP.md Execution → Environment Setup → First Task
- Environment awareness (OS detection, directory exploration)
- PROFILE.json creation
- Initial trust score calculation
- First task execution
- State persistence verification

**Why Important**: First impression - determines if users stick with the system

**Estimated Complexity**: Medium

#### 5. Tools Upgrade Flow
**Feature Chain**: `/bootstrap-tools` → Tool Detection → Version Check → Upgrade Recommendations
- Scan available tools (rg, node, python, git)
- Version comparison against requirements
- Upgrade command generation
- SYSTEM_CAPABILITIES.json update

**Why Important**: Ensures agents have required tooling

**Estimated Complexity**: Low-Medium

#### 6. Pain Learning Flow
**Feature Chain**: Pain Signal → Dictionary Update → Rule Refinement → Future Prevention
- Pain signal classification
- Dictionary rule matching
- Rule score adjustments
- New rule creation via `/pain` command
- Future prevention verification

**Why Important**: Adaptive learning - prevents recurring errors

**Estimated Complexity**: Medium

---

### P2 - Nice to Have

#### 7. Reflection Log Flow
**Feature Chain**: `/reflection` → Reflection Generation → Memory Update → Insights Extraction
- Reflection generation
- MEMORY.md updates
- Insights extraction
- Pattern recognition

#### 8. Deep Reflect Tool Flow
**Feature Chain**: Cognitive Analysis → Model Compliance → Improvement Suggestions
- Deep cognitive analysis
- Thinking OS model compliance checking
- Improvement recommendations

#### 9. Environment Cleanup Flow
**Feature Chain**: Grooming Trigger → Two-Phase Deletion → Trash Management → Recovery
- Grooming detection
- Phase 1: Move to .trash/
- Phase 2: Delete after 7 days
- Recovery procedures

#### 10. Plugin Lifecycle Flow
**Feature Chain**: Installation → First Start → Configuration → Upgrade
- install-openclaw.sh execution
- Plugin registration
- First agent conversation
- Configuration validation
- Upgrade path

---

## Test Coverage Matrix

| Feature Chain | Unit Tests | E2E Tests | Coverage |
|--------------|------------|-----------|----------|
| Trust System | ✅ | ✅ | 100% |
| Pain Detection | ✅ | ✅ | 100% |
| Evolution Queue | ✅ | ✅ | 100% |
| Gatekeeper | ✅ | ✅ | 100% |
| Evolution Worker | ✅ | ✅ | 100% |
| Thinking OS | ✅ | ✅ | 100% |
| **OKR Management** | ✅ | ❌ | **50%** |
| **Sub-Agent Collaboration** | ✅ | ❌ | **50%** |
| **Cognitive Hygiene** | ✅ | ❌ | **50%** |
| User Onboarding | Partial | ❌ | 25% |
| Tools Upgrade | ✅ | ❌ | 50% |
| Pain Learning | ✅ | ❌ | 50% |
| Reflection Log | ✅ | ❌ | 50% |
| Deep Reflect | ✅ | ❌ | 50% |
| Environment Cleanup | ❌ | ❌ | 0% |
| Plugin Lifecycle | ❌ | ❌ | 0% |

**Overall E2E Coverage**: 6/16 feature chains = **37.5%**

---

## Recommendations

### Immediate Actions (This Sprint)

1. **Create OKR Management E2E Test** (P0)
   - File: `tests/feature-testing/framework/test-scenarios/okr-management-flow.json`
   - Estimated Time: 3-4 hours
   - Impact: Validates strategic alignment system

2. **Create Sub-Agent Collaboration E2E Test** (P0)
   - File: `tests/feature-testing/framework/test-scenarios/subagent-collaboration-flow.json`
   - Estimated Time: 4-5 hours
   - Impact: Validates core collaboration mechanism

3. **Create Cognitive Hygiene E2E Test** (P0)
   - File: `tests/feature-testing/framework/test-scenarios/cognitive-hygiene-flow.json`
   - Estimated Time: 2-3 hours
   - Impact: Prevents context loss failures

### Next Sprint (P1)

4. User Onboarding Flow
5. Tools Upgrade Flow
6. Pain Learning Flow

### Future Work (P2)

7. Reflection Log Flow
8. Environment Cleanup Flow
9. Plugin Lifecycle Flow

---

## Test Creation Guidelines

When creating new E2E test scenarios:

1. **Use JSON format** (follow existing pattern)
2. **Include conversation flow** with user/agent turns
3. **Define assertions** for each step
4. **Test complete chain** (not just one component)
5. **Include edge cases** (failures, boundary conditions)
6. **Document expected outcomes**

Example structure:
```json
{
  "name": "OKR Management Flow",
  "description": "Test complete OKR lifecycle from strategy to completion",
  "phases": [
    {
      "name": "Initialize Strategy",
      "conversation": [...],
      "assertions": [...]
    }
  ]
}
```

---

## Conclusion

The test suite has strong coverage of core infrastructure (trust, pain, evolution, gatekeeper, thinking-os) but lacks E2E tests for critical user-facing workflows like OKR management and sub-agent collaboration.

**Priority**: Create 3 P0 E2E tests this sprint to validate the most critical feature chains.
