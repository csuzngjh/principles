---
'create-principles-disciple': patch
---

PRI-1022：让新用户知道「PD 的内置智能体需要自己配 LLM」。安装指引（README 双语、USER_GUIDE 双语、官网 getting-started 双语、安装器 README）新增前置条件与「开始之前：先给 PD 一个 LLM」一节，讲清 provider / model / apiKeyEnv 三个字段和跳过后的真实后果（证据照收，但不诊断、不提原则）。`--yes` 安装摘要不再只说「配置了 runtime profile」，未配置时点名三个字段并给出两条补齐路径。Console 控制中心把原本写好却从未渲染的五句 readiness 文案接到实际状态上，并删掉「runtime profile 是 OpenClaw profile」这句与当前默认架构相反的描述。
