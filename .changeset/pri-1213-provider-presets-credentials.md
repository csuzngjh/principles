---
"create-principles-disciple": patch
---

控制台 LLM 配置改为「选供应商 → 选模型 → 贴密钥」：供应商地址与模型列表来自内置 pi-ai 目录（只读投影），自建端点收进高级设置；密钥写入 `~/.pd/credentials.yaml`（0600 / Windows icacls 尽力而为），环境变量优先，密钥不回显、不进日志与 URL；新增可选的连接测试（先试模型列表，再试极小 chat）并区分网络不可达、认证失败与上游错误。ADR-0016 §2.2/§5 与 ADR-0022 相应适用范围经 Owner 2026-11-14 授权修订（PRI-1213）。
