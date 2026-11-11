---
'@principles/host-runtime': patch
'principles-disciple': patch
'@principles/codex-adapter': patch
'@principles/workbuddy-adapter': patch
'create-principles-disciple': patch
---

B3：hook 与 replay 共用同一个工具语义解析入口。`resolveHostToolSemanticsForHook()` 以“workspace 持久化声明 → 宿主静态声明 → baseline”为优先级解析 `canonicalKind`：声明中出现的原始工具名以声明为准（与 replay/证据/Console 读取的是同一份 `.pd/host-tool-semantics/*.json`），声明未覆盖的静态名继续补齐，避免陈旧声明截断宿主当前工具面。声明损坏或跨宿主冲突时返回带 reason/nextAction 的类型化失败，绝不静默回退成空 registry；消费方（OpenClaw gate、Codex/WorkBuddy pd-hook）保留可用性——退回宿主静态声明并在 stderr / logger 留下可观察诊断（rc-9）。

修复前：同一 workspace 中若持久化声明把 `exec` 记为 `write`（或声明了静态表没有的工具名），OpenClaw gate 仍按静态表判为 `execute`，生产侧提取出 `out.txt`，而 replay 得到 `<tool:exec>`，同一条路径规则在回放命中、在生产不命中。现在两端一致。

OpenClaw 的接入模块刻意放在 `hooks/hook-tool-semantics.ts` 而非 `constants/tool-semantics.ts`：后者位于 `rulehost-evidence` 卫星包路径上，引入 host-runtime barrel 会把整条 LLM 依赖图拉进卫星包（satellite-purity / OPT-002）。
