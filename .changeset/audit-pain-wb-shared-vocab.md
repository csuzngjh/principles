---
"@principles/host-runtime": patch
"@principles/workbuddy-adapter": patch
---

Connect WorkBuddy live keyword Pain detection to the shared learned correction vocabulary (AUDIT-P3-01, 2026-10-21 remediation; SPEC-PD-CROSS-HOST-KEYWORD-PAIN-001 v0.2): assessWorkbuddyLiveKeyword accepts an optional UnifiedKeywordStore and admitTrustedWorkbuddyLiveCorrection plus the adapter pre-filter now resolve the same shared live store (seed + learned, mtime-cached, seed-only degradation) instead of the four-term P0 projection, so earned-high terms accumulated on other hosts take effect in WorkBuddy. Only high-precision correction terms can trigger automatic Pain (existing gates unchanged: startsWith prefilter, native UserPromptSubmit validation, explicit Owner-statement prefix reservation, both default-OFF flags, no LLM, no transcript reads). Adds direct host-runtime unit tests for the admission boundary (previously adapter-indirect only, AUDIT-P3-04).
