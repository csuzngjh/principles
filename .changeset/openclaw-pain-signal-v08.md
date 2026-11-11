---
"principles-disciple": patch
---

OpenClaw 的 `pd-pain-signal` Skill 与另两个宿主对齐到 Pain Ingress v0.8：

- 新增锚点式入口 `pd_submit_pain`（`reason` / `anchorType` / `anchorRef` / 可选 `painType`），与 `/pd-pain` 原生入口并列；工具不可用时明确要求停下并如实告知 Owner，不得伪造或绕门禁。
- 补齐锚点三源与格式要求（`<principleId>@<version>`、`<path>#<section>`）、`painType` 默认值只在原则锚点下成立的限制、严重度不可自提（默认中等）、仅本次授权、后台/定时/无人值守禁止提交。
- 补齐四状态回执（`submitted` / `refused` / `failed` / `submit_unconfirmed`）的阅读方式，并保留既有的会话绑定与准入核验约束（`pd pain record` 必须带 `--session`，下游看 `admissionResults` / `ledgerEntryIds`）。
- 契约测试在原断言之上新增 v0.8 断言，未放宽或删除任何既有断言。
