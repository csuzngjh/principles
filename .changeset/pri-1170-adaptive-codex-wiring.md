---
"@principles/host-runtime": minor
"@principles/codex-adapter": patch
"@principles/core": patch
---

PRI-1170: 修复 Adaptive Activation 的选择协议并接入真实 Codex `exec` hook（默认关闭）。

- 候选负载改为 `{ref, text, digest}`，`digest = sha256(实际下发正文)`，模型只原样复制引用与摘要；PD 用本轮冻结候选表核对，并独立重验正文、修订与授权。
- 截止拆成「首字节 10 秒 + 生成阶段独立 10 秒」；保持每轮最多一次实际发送、零重试、零 repair、零 provider fallback，迟到结果不应用。
- 新增 `@principles/host-runtime` 的选择协议与 priority provider 模块；`codex-adapter` 在 `before_prompt_build` 分支按 `host.codex.adaptive_activation`（quiet，默认 `false`）装配，关闭时 Native 输出逐字节一致且零模型请求。
- 每次请求输出一行有界结构化诊断（阶段、首字节/生成结束/取消时点、引用与摘要校验结果、`finish_reason`），不保存原始会话、完整响应或凭据。
