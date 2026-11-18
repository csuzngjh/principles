---
'@principles/core': major
---

Merge-window export-surface removals announcement (PRI-1269 → PRI-1270): the
Principle Context Batch 1+2 retirement (#2698, PRI-1269) removed the focus
compression / working-memory / prompt-builder helper exports from
@principles/core. This PR's export-surface gate coverage records now point at
this changeset (the gate requires removal coverage by a changeset the PR
itself adds; the original announcement changeset predates this PR's base).

Removed exports (entries `.` and `./prompt-builder`):
DEFAULT_FOCUS_COMPRESSION_OPTIONS, FileArtifact, FocusCompressionOptions,
FocusCompressionResult, WorkingMemorySnapshot, compressFocusContent,
extractMilestones, extractSummary, mergeWorkingMemory,
parseWorkingMemorySection, validateCurrentFocus, workingMemoryToInjection,
cleanupStaleInfoPure, deduplicateArtifacts, extractDescription,
extractNextActions, extractProblems.
