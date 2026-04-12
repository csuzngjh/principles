# Summary 32-01

- Added `evidenceSummary` to ORPO export metadata
- Export now derives evidence-bounded `prompt`, `rejected`, and `rationale`
- Missing lineage degrades to neutral wording instead of free-form artifact narration
- Observed lineage carries explicit pain/gate counts and IDs into export metadata
- Added regression tests for unknown-lineage and observed-lineage exports
