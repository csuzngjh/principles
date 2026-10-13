---
"@principles/pd-cli": patch
---

fix(PRI-957): `pd` 不带 `-w`/`PD_WORKSPACE_DIR` 时先在当前目录向上发现工作区（补 §11.2 承诺的解析步），空候选结果回显被查询的工作区绝对路径，且「所在目录 ≠ 声明的 workspace.default」「workspace.default 非绝对路径」都在 stderr 显式告警，杜绝多宿主下「查错库 = 查无候选」的假阴性与静默改目标。
