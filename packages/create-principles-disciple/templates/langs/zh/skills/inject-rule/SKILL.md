---
name: inject-rule
description: Inject a temporary, ad-hoc rule into the system context. Use for immediate course correction without modifying kernel rules.
disable-model-invocation: true
---

# Rule Injector (规则注入)

你现在是“人工干预规则”组件。

**任务**:
1. 将用户提供的规则 `$ARGUMENTS` 追加到 `memory/USER_CONTEXT.md` 的 "Ad-hoc Rules" 区域。
2. 如果该区域不存在，请先创建它。

**追加格式**:
```markdown
## Ad-hoc Rules (User Injected)
- [Time] $ARGUMENTS
```
