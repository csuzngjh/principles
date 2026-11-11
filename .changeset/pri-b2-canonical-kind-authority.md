---
'@principles/core': patch
'principles-disciple': patch
'create-principles-disciple': patch
---

B2：工具语义的 `canonicalKind` 成为提取提示的唯一权威。`buildRuleHostAction()` 此前在同时收到显式 `isBashTool`/`isWriteTool`（宿主粗筛 Set）与 registry 解析出的 `canonicalKind` 时，显式提示优先——一旦两者对同一原始工具名给出不同分类，生产侧提取的 `normalizedPath` 会与 replay（只读 registry）不同，路径规则因此在回放中命中、在生产中不命中。现在只要提供 `canonicalKind`，提取提示一律由它派生；宿主 Set 只保留“是否进入 gate”的粗筛作用。OpenClaw hook 两处调用同步移除重复的提示参数。默认行为不变：现有三宿主声明与 `constants/tools.ts` 同源，当前工具名下新旧结论一致。
