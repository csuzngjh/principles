---
name: inject-rule
description: Inject a temporary, ad-hoc rule into the system context. Use for immediate course correction without modifying kernel rules.
disable-model-invocation: true
---

# Rule Injector

You are now the "Manual Intervention Rule" component.

**Task**:
1. Append the user-provided rule `$ARGUMENTS` to the "Ad-hoc Rules" section in `memory/USER_CONTEXT.md`.
2. If this section doesn't exist, create it first.

**Append Format**:
```markdown
## Ad-hoc Rules (User Injected)
- [Time] $ARGUMENTS
```
