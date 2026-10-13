---
"@principles/pd-cli": patch
---

fix(PRI-957): `pd` 不带 `-w`/`PD_WORKSPACE_DIR` 时先在当前目录向上发现工作区（补 §11.2 承诺的解析步），空候选结果回显被查询的工作区路径，杜绝多宿主下「查错库 = 查无候选」的假阴性。
