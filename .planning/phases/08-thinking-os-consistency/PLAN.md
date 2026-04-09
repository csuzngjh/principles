# PLAN: Phase 8 — THINKING_OS.md 一致性

**Milestone:** v1.10
**Phase:** 8
**Goal:** 确保 THINKING_OS.md 模板包含全部 10 个 directive
**Requirements:** SYNC-01

## Context

**Issue:** `THINKING_OS.md` in templates has 8 directives (T-01~T-08), but `thinking-models.ts` has 10 builtin patterns (T-01~T-10).

**Impact:** If workspace THINKING_OS.md parses successfully, only 8 models are returned. T-09 and T-10 only appear as fallback when parsing fails.

## Approach

### 1. Add T-09 and T-10 to all THINKING_OS.md templates

Files to update:
- `templates/langs/en/principles/THINKING_OS.md`
- `templates/langs/zh/principles/THINKING_OS.md`
- `templates/workspace/.principles/THINKING_OS.md`

Add XML directives matching the builtin patterns:

```xml
<directive id="T-09" name="DIVIDE_AND_CONQUER">
  <trigger>When facing a complex task with multiple interdependent steps</trigger>
  <must>Break the work into smallest meaningful units. Execute in dependency order. Validate each unit before proceeding.</must>
  <forbidden>Tackle complex tasks as a single monolithic operation. Mix unrelated changes in one edit.</forbidden>
</directive>

<directive id="T-10" name="MEMORY_EXTERNALIZATION">
  <trigger>When drawing conclusions, completing analysis, or about to switch context</trigger>
  <must>Write conclusions to a file (plan.md, scratchpad, memory) before proceeding. Preserve reasoning for future reference.</must>
  <forbidden>Keep important conclusions only in conversation context. Lose state between turns.</forbidden>
</directive>
```

### 2. Verify consistency

Ensure builtin patterns match the THINKING_OS.md trigger/must/forbidden content.

## Files to Modify

| File | Changes |
|------|---------|
| `templates/langs/en/principles/THINKING_OS.md` | Add T-09, T-10 directives |
| `templates/langs/zh/principles/THINKING_OS.md` | Add T-09, T-10 directives |
| `templates/workspace/.principles/THINKING_OS.md` | Add T-09, T-10 directives |

## UAT Criteria

- [ ] All 3 template files contain T-01 through T-10
- [ ] Builtin patterns match THINKING_OS.md content
