---
"principles-disciple": patch
"create-principles-disciple": patch
---

fix(openclaw-plugin): RuleCode evaluation child now hands its vm context only a JSON string and builds the call input and helpers inside the context, so rule code can no longer reach the child's `process` through `helpers.constructor.constructor`.
