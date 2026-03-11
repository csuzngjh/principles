# PR #13 Test Impact Analysis

**PR**: refactor: WorkspaceContext architecture & Unified Trust Engine (v1.5.0)
**Branch**: feat/workspace-context-v1.5.0
**Analysis Date**: 2026-03-11
**Status**: ⚠️ **CRITICAL BREAKING CHANGES** - Test updates required before merge

---

## Executive Summary

PR #13 introduces **breaking changes** that will cause **100% of existing test scenarios to fail**. The test framework requires comprehensive updates across multiple dimensions:

1. **Trust Score Changes**: Initial trust increased from 59 → 85 (26.5% increase)
2. **Path Migration**: Files moved from `docs/` to `.state/` (AGENT_SCORECARD, etc.)
3. **Configuration Structure**: New `pain_settings.json` with different structure
4. **Test Expectations**: All hardcoded trust values need updating
5. **Migration Logic**: Tests must account for automatic path migration

**Impact Level**: 🔴 **CRITICAL** - Cannot merge without test updates

---

## 1. Trust Score Changes (HIGHEST PRIORITY)

### Breaking Change: Initial Trust Score

| Aspect | Old (v1.4.x) | New (v1.5.0) | Impact |
|--------|--------------|--------------|--------|
| **Initial Trust** | 59 | 85 | Test failures |
| **Stage** | Stage 2: Editor (59/60 threshold) | Stage 3: Developer (85/80 threshold) | Stage mismatch |
| **Grace Failures** | 3 | 5 | Test count mismatch |
| **Cold Start Period** | 24h | 24h | ✅ No change |

### Test Files Requiring Updates

#### **CRITICAL - Must Update Before Merge**

1. **`tests/quick-trust-test.sh`**
   - **Lines 34, 65, 74**: Hardcoded check `SCORE == "59"`
   - **Lines 98, 100**: Expects score to drop from 59 → 51
   - **Line 132**: Expects score to increase from 51 → 52

   **Required Changes**:
   ```bash
   # Line 34: Change cold start validation
   - if [ "$SCORE" == "59" ] && [ "$GRACE" == "3" ]; then
   + if [ "$SCORE" == "85" ] && [ "$GRACE" == "5" ]; then

   # Line 65: Update score reference
   - echo "    Score: $NEW_SCORE (应为59)"
   + echo "    Score: $NEW_SCORE (应为85)"

   # Lines 98-100: Update penalty calculation
   - NEW_SCORE=$(cat "$SCORECARD" | jq -r '.trust_score')
   - DELTA=$((59 - NEW_SCORE))
   - echo "  新Score: $NEW_SCORE (预期: 51)"
   + NEW_SCORE=$(cat "$SCORECARD" | jq -r '.trust_score')
   + DELTA=$((85 - NEW_SCORE))
   + echo "  新Score: $NEW_SCORE (预期: 83)"  # -2 penalty with new settings
   ```

2. **`tests/feature-testing/framework/test-scenarios/trust-system.json`**
   - **Line 16**: `"trust_score": 59`
   - **Line 17**: `"stage": "Stage 2: Developer"`
   - **Lines 27-30**: Validator expects min_score: 55, max_score: 65

   **Required Changes**:
   ```json
   {
     "initial_state": {
   -   "trust_score": 59,
   -   "stage": "Stage 2: Developer"
   +   "trust_score": 85,
   +   "stage": "Stage 3: Developer"
     },
     "params": {
   -   "min_score": 55,
   -   "max_score": 65,
   +   "min_score": 80,
   +   "max_score": 90,
         "expected_stage": "Stage 3"
     }
   }
   ```

3. **`tests/feature-testing/framework/test-scenarios/trust-system-deep.json`**
   - **Line 18**: `"trust_score": "will be reset to 59 (cold start)"`
   - **Line 58**: `"expected_score": 59`
   - **Line 59**: `"expected_grace": 3`
   - **Lines 74, 89, 105, 112**: Multiple references to score = 59
   - **Lines 142, 143**: Penalty expectations (old: -8, new: -2)

   **Required Changes**:
   ```json
   {
     "initial_state": {
   -   "trust_score": "will be reset to 59 (cold start)",
   +   "trust_score": "will be reset to 85 (cold start)",
        "grace_failures": 5,  // Changed from 3
        "cold_start_active": true
     },
     "params": {
   -   "expected_score": 59,
   -   "expected_grace": 3
   +   "expected_score": 85,
   +   "expected_grace": 5
     }
   }
   ```

   **Penalty Logic Updates**:
   ```json
   {
     "params": {
   -   "expected_score": 51,   // 59 - 8
   -   "expected_delta": -8
   +   "expected_score": 83,   // 85 - 2
   +   "expected_delta": -2
     }
   }
   ```

4. **`tests/feature-testing/framework/feature-test-runner.sh`**
   - **Lines 876, 878**: Reset trust defaults to 59
   - **Lines 589, 627, 650, 676**: Hardcoded 59 in validators

   **Required Changes**:
   ```bash
   # Line 876: Update reset default
   - local score=$(echo "$action_decoded" | jq -r '.score // 59')
   + local score=$(echo "$action_decoded" | jq -r '.score // 85')

   # Lines 589, 627, 650, 676: Update validator expectations
   - local expected_score=$(echo "$params" | jq -r '.expected_score')  # Defaults to 59
   + local expected_score=$(echo "$params" | jq -r '.expected_score // 85')
   ```

---

## 2. Path Migration Changes

### Breaking Change: AGENT_SCORECARD Location

| File | Old Path | New Path | Impact |
|------|----------|----------|--------|
| **AGENT_SCORECARD.json** | `docs/AGENT_SCORECARD.json` | `.state/AGENT_SCORECARD.json` | 🔴 Critical |
| **pain_settings.json** | `memory/.state/pain_settings.json` | `.state/pain_settings.json` | 🔴 Critical |
| **thinking_os_usage.json** | `memory/.state/thinking_os_usage.json` | `.state/thinking_os_usage.json` | 🔴 Critical |
| **pain_dictionary.json** | `memory/.state/pain_dictionary.json` | `.state/pain_dictionary.json` | 🔴 Critical |
| **evolution_queue.json** | `docs/evolution_queue.json` | `.state/evolution_queue.json` | 🔴 Critical |

### Migration Logic

The PR includes **automatic migration** in `src/core/migration.ts`:

```typescript
// Legacy → New mappings
{ legacy: 'docs/AGENT_SCORECARD.json', newKey: 'AGENT_SCORECARD' }
{ legacy: 'memory/.state/pain_settings.json', newKey: 'PAIN_SETTINGS' }
{ legacy: 'memory/.state/thinking_os_usage.json', newKey: 'THINKING_OS_USAGE' }
// ... etc
```

**Migration Behavior**:
- ✅ Files are **automatically moved** on first run
- ✅ Migration is **idempotent** (safe to run multiple times)
- ⚠️ **Test must use new paths** after migration runs

### Test Files Requiring Path Updates

#### **HIGH PRIORITY - Path References**

1. **`tests/config/test-env.sh`**
   - **Line 21**: `SCORECARD_PATH="${SCORECARD_PATH:-$WORKSPACE_DIR/docs/AGENT_SCORECARD.json}"`

   **Required Change**:
   ```bash
   - export SCORECARD_PATH="${SCORECARD_PATH:-$WORKSPACE_DIR/docs/AGENT_SCORECARD.json}"
   + export SCORECARD_PATH="${SCORECARD_PATH:-$WORKSPACE_DIR/.state/AGENT_SCORECARD.json}"
   ```

2. **`tests/quick-trust-test.sh`**
   - **Line 9**: `SCORECARD="$WORKSPACE/docs/AGENT_SCORECARD.json"`

   **Required Change**:
   ```bash
   - SCORECARD="$WORKSPACE/docs/AGENT_SCORECARD.json"
   + SCORECARD="$WORKSPACE/.state/AGENT_SCORECARD.json"
   ```

3. **`tests/feature-testing/framework/test-scenarios/trust-system-deep.json`**
   - **Lines 23-26**: Data file paths

   **Required Changes**:
   ```json
   {
     "data_files": {
   -   "scorecard": "docs/AGENT_SCORECARD.json",
   -   "events": "memory/.state/logs/events.jsonl",
   -   "config": "memory/.state/config.json"
   +   "scorecard": ".state/AGENT_SCORECARD.json",
   +   "events": "memory/logs/events.jsonl",
   +   "config": ".state/pain_settings.json"
     }
   }
   ```

4. **`tests/feature-testing/framework/feature-test-runner.sh`**
   - **Lines 351, 353, 387, 413, 439, 478, 508, 509**: Multiple hardcoded `docs/AGENT_SCORECARD.json` references

   **Required Changes**:
   ```bash
   # Update all scorecard path references
   - local scorecard_path="$WORKSPACE_DIR/docs/AGENT_SCORECARD.json"
   + local scorecard_path="$WORKSPACE_DIR/.state/AGENT_SCORECARD.json"
   ```

---

## 3. Configuration Structure Changes

### Breaking Change: pain_settings.json Structure

**Old Structure** (hardcoded in `src/core/pain.ts`):
```typescript
// Config embedded in code, no separate file
```

**New Structure** (`.state/pain_settings.json`):
```json
{
  "language": "zh",
  "thresholds": { "pain_trigger": 40, ... },
  "scores": { "paralysis": 30, ... },
  "severity_thresholds": { "high": 70, ... },
  "intervals": { "worker_poll_ms": 900000, ... },
  "trust": {
    "stages": { "stage_1_observer": 30, ... },
    "cold_start": { "initial_trust": 85, ... },
    "penalties": { "tool_failure_base": -2, ... },
    "rewards": { "success_base": 2, ... },
    "limits": { "stage_2_max_lines": 50, ... }
  },
  "deep_reflection": { "enabled": true, ... }
}
```

### Impact on Tests

**New `trust` section** overrides old hardcoded `TRUST_CONFIG`:
- Initial trust: **85** (not 59)
- Grace failures: **5** (not 3)
- Tool failure penalty: **-2** (not -8)
- Success reward: **+2** (not +1)

**Tests must reference the new configuration file structure**:
- ConfigService reads from `.state/pain_settings.json`
- No longer has hardcoded defaults in `trust-engine.ts`

---

## 4. Breaking Changes Summary

### Critical Changes (Must Fix)

| # | Change | Old Value | New Value | Test Impact |
|---|--------|-----------|-----------|-------------|
| 1 | Initial Trust | 59 | 85 | 🔴 All trust validations fail |
| 2 | Grace Failures | 3 | 5 | 🔴 Grace consumption tests fail |
| 3 | Tool Penalty | -8 | -2 | 🔴 Penalty calculations wrong |
| 4 | AGENT_SCORECARD Path | `docs/` | `.state/` | 🔴 File not found errors |
| 5 | Config Structure | Hardcoded | `.state/pain_settings.json` | 🔴 Config tests fail |
| 6 | Stage Threshold | Stage 2 (59) | Stage 3 (85) | 🔴 Stage validation fails |

### Non-Breaking Changes (Good to Know)

| # | Change | Impact |
|---|--------|--------|
| 1 | WorkspaceContext class | No test impact (internal refactor) |
| 2 | Lazy-loaded services | No test impact (performance optimization) |
| 3 | Unicode progress bars | Visual only, no functional impact |
| 4 | SDK alignment (V1.0) | Type safety only, no runtime impact |

---

## 5. Test Update Strategy

### Phase 1: Critical Path Updates (Do First)

```bash
# 1. Update test-env.sh with new SCORECARD_PATH
cd /home/csuzngjh/code/principles
sed -i 's|docs/AGENT_SCORECARD.json|.state/AGENT_SCORECARD.json|g' \
  tests/config/test-env.sh

# 2. Update quick-trust-test.sh with new score expectations
sed -i 's|"59"|"85"|g' tests/quick-trust-test.sh
sed -i 's|"3"|"5"|g' tests/quick-trust-test.sh
sed -i 's|SCORE == "59"|SCORE == "85"|g' tests/quick-trust-test.sh

# 3. Update feature-test-runner.sh scorecard paths
sed -i 's|docs/AGENT_SCORECARD.json|.state/AGENT_SCORECARD.json|g' \
  tests/feature-testing/framework/feature-test-runner.sh
```

### Phase 2: Scenario JSON Updates

```bash
# Update trust-system.json
cd tests/feature-testing/framework/test-scenarios
jq '
  .setup.initial_state.trust_score = 85 |
  .setup.initial_state.stage = "Stage 3: Developer" |
  .steps[0].params.min_score = 80 |
  .steps[0].params.max_score = 90 |
  .steps[0].params.expected_stage = "Stage 3"
' trust-system.json > trust-system.json.tmp && mv trust-system.json.tmp trust-system.json

# Update trust-system-deep.json (more complex)
jq '
  .setup.initial_state.trust_score = "will be reset to 85 (cold start)" |
  .setup.initial_state.grace_failures = 5 |
  .steps[2].params.expected_score = 85 |
  .steps[2].params.expected_grace = 5
' trust-system-deep.json > trust-system-deep.json.tmp && \
  mv trust-system-deep.json.tmp trust-system-deep.json
```

### Phase 3: Penalty/Reward Recalculation

**Old Logic** (v1.4.x):
- Initial: 59
- After 1st failure: 59 - 8 = 51
- After 2nd failure: 51 - 11 = 40 (streak penalty)
- After 1st success: 40 + 1 = 41
- After 5 streak: 41 + 5 = 46

**New Logic** (v1.5.0):
- Initial: 85
- After 1st failure: 85 - 2 = 83
- After 2nd failure: 83 - 4 = 79 (streak penalty)
- After 1st success: 79 + 2 = 81
- After 5 streak: 81 + 5 = 86

**Test scenarios must update all expected score values**:

```json
// trust-system-deep.json penalty test
{
  "params": {
    "expected_score": 83,      // Was 51
    "expected_delta": -2       // Was -8
  }
}

// Streak bonus test
{
  "params": {
    "expected_streak": 5,
    "expected_stage": 3,       // Was 2 (now in Stage 3)
    "min_expected_score": 86   // Was 46
  }
}
```

### Phase 4: Verification Tests

```bash
# After applying all updates, run quick smoke test
cd /home/csuzngjh/code/principles
bash tests/quick-trust-test.sh

# Run full trust system test
bash tests/feature-testing/framework/feature-test-runner.sh trust-system

# Run deep trust test
bash tests/feature-testing/framework/feature-test-runner.sh trust-system-deep
```

---

## 6. Migration Checklist

### Pre-Merge Requirements

- [ ] **Step 1**: Update all hardcoded "59" → "85" in test files
- [ ] **Step 2**: Update all hardcoded "3" (grace) → "5" in test files
- [ ] **Step 3**: Update all `docs/AGENT_SCORECARD.json` → `.state/AGENT_SCORECARD.json` paths
- [ ] **Step 4**: Update penalty expectations (-8) → (-2)
- [ ] **Step 5**: Update stage expectations (Stage 2) → (Stage 3)
- [ ] **Step 6**: Recalculate all expected score values in test scenarios
- [ ] **Step 7**: Update test-env.sh SCORECARD_PATH
- [ ] **Step 8**: Run smoke tests to verify basic functionality
- [ ] **Step 9**: Run full trust system test suite
- [ ] **Step 10**: Verify migration logic moves files correctly

### Post-Merge Verification

- [ ] Verify automatic migration runs on plugin load
- [ ] Check that legacy `docs/AGENT_SCORECARD.json` is moved to `.state/`
- [ ] Confirm new `.state/pain_settings.json` is loaded correctly
- [ ] Validate trust score starts at 85 for new installations
- [ ] Test that existing workspaces maintain their scores after migration

---

## 7. Recommended Test Updates

### File-by-File Update Guide

#### **tests/config/test-env.sh**

```bash
# Line 21: Update SCORECARD_PATH
- export SCORECARD_PATH="${SCORECARD_PATH:-$WORKSPACE_DIR/docs/AGENT_SCORECARD.json}"
+ export SCORECARD_PATH="${SCORECARD_PATH:-$WORKSPACE_DIR/.state/AGENT_SCORECARD.json}"
```

#### **tests/quick-trust-test.sh**

```bash
# Line 9: Update scorecard path
- SCORECARD="$WORKSPACE/docs/AGENT_SCORECARD.json"
+ SCORECARD="$WORKSPACE/.state/AGENT_SCORECARD.json"

# Lines 34, 65, 74: Update score expectations
- if [ "$SCORE" == "59" ] && [ "$GRACE" == "3" ]; then
+ if [ "$SCORE" == "85" ] && [ "$GRACE" == "5" ]; then

# Lines 98-100: Update penalty calculation
- DELTA=$((59 - NEW_SCORE))
- echo "  新Score: $NEW_SCORE (预期: 51)"
+ DELTA=$((85 - NEW_SCORE))
+ echo "  新Score: $NEW_SCORE (预期: 83)"
```

#### **tests/feature-testing/framework/test-scenarios/trust-system.json**

```json
{
  "setup": {
    "initial_state": {
-     "trust_score": 59,
-     "stage": "Stage 2: Developer"
+     "trust_score": 85,
+     "stage": "Stage 3: Developer"
    }
  },
  "steps": [
    {
      "params": {
-       "min_score": 55,
-       "max_score": 65,
+       "min_score": 80,
+       "max_score": 90,
        "expected_stage": "Stage 3"
      }
    }
  ]
}
```

#### **tests/feature-testing/framework/test-scenarios/trust-system-deep.json**

```json
{
  "setup": {
    "initial_state": {
-     "trust_score": "will be reset to 59 (cold start)",
+     "trust_score": "will be reset to 85 (cold start)",
-     "grace_failures": 3,
+     "grace_failures": 5,
      "cold_start_active": true
    },
    "data_files": {
-     "scorecard": "docs/AGENT_SCORECARD.json",
+     "scorecard": ".state/AGENT_SCORECARD.json",
-     "events": "memory/.state/logs/events.jsonl",
+     "events": "memory/logs/events.jsonl",
-     "config": "memory/.state/config.json"
+     "config": ".state/pain_settings.json"
    }
  },
  "steps": [
    {
      "params": {
-       "expected_score": 59,
-       "expected_grace": 3
+       "expected_score": 85,
+       "expected_grace": 5
      }
    },
    {
      "params": {
-       "expected_score": 51,
-       "expected_delta": -8
+       "expected_score": 83,
+       "expected_delta": -2
      }
    },
    {
      "params": {
-       "expected_stage": 2,
-       "min_expected_score": 60
+       "expected_stage": 3,
+       "min_expected_score": 86
      }
    }
  ]
}
```

#### **tests/feature-testing/framework/feature-test-runner.sh**

```bash
# Update all scorecard path references (lines 351, 353, 387, 413, 439, 478, 508, 509)
- local scorecard_path="$WORKSPACE_DIR/docs/AGENT_SCORECARD.json"
+ local scorecard_path="$WORKSPACE_DIR/.state/AGENT_SCORECARD.json"

# Update reset trust default (line 876)
- local score=$(echo "$action_decoded" | jq -r '.score // 59')
+ local score=$(echo "$action_decoded" | jq -r '.score // 85')

# Update validator default expectations (lines 589, 627, 650, 676)
- local expected_score=$(echo "$params" | jq -r '.expected_score')
+ local expected_score=$(echo "$params" | jq -r '.expected_score // 85')
```

---

## 8. Automated Migration Script

To speed up test updates, use this script:

```bash
#!/bin/bash
# migrate-tests-for-v1.5.0.sh

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
TESTS_DIR="$PROJECT_ROOT/tests"

echo "╔════════════════════════════════════════════════════════════╗"
echo "║     Migrating Tests for v1.5.0 Breaking Changes             ║"
echo "╚════════════════════════════════════════════════════════════╝"
echo ""

# Phase 1: Trust score updates
echo "━━━ Phase 1: Updating trust scores (59 → 85) ━━━"
find "$TESTS_DIR" -name "*.json" -o -name "*.sh" | while read file; do
  sed -i 's/"59"/"85"/g' "$file"
  sed -i 's/SOURCE == 59/SOURCE == 85/g' "$file"
  sed -i 's/SOURCE == "59"/SOURCE == "85"/g' "$file"
  sed -i 's/SCORE == 59/SCORE == 85/g' "$file"
  sed -i 's/SCORE == "59"/SCORE == "85"/g' "$file"
done
echo "✅ Trust scores updated"

# Phase 2: Grace failures updates
echo "━━━ Phase 2: Updating grace failures (3 → 5) ━━━"
find "$TESTS_DIR" -name "*.json" -o -name "*.sh" | while read file; do
  sed -i 's/"grace_failures": 3/"grace_failures": 5/g' "$file"
  sed -i 's/"expected_grace": 3/"expected_grace": 5/g' "$file"
  sed -i 's/GRACE == "3"/GRACE == "5"/g' "$file"
done
echo "✅ Grace failures updated"

# Phase 3: Path updates
echo "━━━ Phase 3: Updating file paths ━━━"
find "$TESTS_DIR" -name "*.json" -o -name "*.sh" | while read file; do
  sed -i 's|docs/AGENT_SCORECARD.json|.state/AGENT_SCORECARD.json|g' "$file"
  sed -i 's|docs/evolution_queue.json|.state/evolution_queue.json|g' "$file"
  sed -i 's|memory/\.state/|\.state/|g' "$file"
done
echo "✅ File paths updated"

# Phase 4: Stage updates
echo "━━━ Phase 4: Updating stage expectations ━━━"
find "$TESTS_DIR" -name "*.json" | while read file; do
  sed -i 's/"Stage 2: Developer"/"Stage 3: Developer"/g' "$file"
  sed -i 's/"expected_stage": 2/"expected_stage": 3/g' "$file"
  sed -i 's/"stage": "Stage 2"/"stage": "Stage 3"/g' "$file"
done
echo "✅ Stage expectations updated"

# Phase 5: Penalty updates
echo "━━━ Phase 5: Updating penalty expectations ━━━"
find "$TESTS_DIR" -name "*.json" | while read file; do
  sed -i 's/"expected_delta": -8/"expected_delta": -2/g' "$file"
  sed -i 's/"expected_score": 51/"expected_score": 83/g' "$file"
  sed -i 's/"expected_score": 40/"expected_score": 79/g' "$file"
done
echo "✅ Penalty expectations updated"

echo ""
echo "━━━ Migration Complete ━━━"
echo ""
echo "📋 Next Steps:"
echo "  1. Review changes with: git diff tests/"
echo "  2. Run smoke test: bash tests/quick-trust-test.sh"
echo "  3. Run full test suite"
echo "  4. Commit updates"
echo ""
```

---

## 9. Conclusion

### Summary

PR #13 introduces **breaking changes** that require **comprehensive test updates**:

1. ✅ **Trust score changes** (59 → 85) affect **ALL** test validations
2. ✅ **Path migration** (`docs/` → `.state/`) breaks **ALL** file references
3. ✅ **Configuration restructure** requires test config updates
4. ✅ **Penalty/reward logic** changes require score recalculation

### Risk Assessment

| Risk | Severity | Mitigation |
|------|----------|------------|
| Tests fail after merge | 🔴 Critical | Update tests BEFORE merge |
| Path migration fails | 🟡 Medium | Auto-migration is idempotent |
| Score miscalculation | 🟡 Medium | Update all test expectations |
| Stage validation fails | 🟢 Low | Update stage references |

### Recommendation

**DO NOT MERGE** until test updates are complete:

1. Apply automated migration script (Section 8)
2. Manually review complex test scenarios (trust-system-deep.json)
3. Run smoke tests to verify basic functionality
4. Run full test suite to ensure no regressions
5. Update this analysis document with actual test results

### Estimated Effort

- **Automated updates**: 30 minutes (script)
- **Manual review**: 2-3 hours (complex scenarios)
- **Testing & validation**: 1-2 hours (run suite, fix edge cases)
- **Total**: 4-6 hours

---

## 10. Contact & Support

For questions or issues with test migration:

- **Review PR #13 description** for architectural context
- **Check migration.ts** for automatic migration logic
- **Compare pain_settings.json** (new template) with old hardcoded values
- **Run WorkspaceContext tests** in `packages/openclaw-plugin/tests/core/`

**Last Updated**: 2026-03-11
**Analysis By**: Claude Code (Senior Code Reviewer)
