---
"@principles/pd-cli": patch
---

fix(PRI-957): `pd` 不带 `-w`/`PD_WORKSPACE_DIR` 时先在当前目录向上发现工作区（补 §11.2 承诺的解析步），空候选结果回显被查询的工作区绝对路径；读写共用同一条解析权威，因此「没人声明过的 cwd 推断目标」会在 stderr 说出被使用的工作区，「所在目录 ≠ 声明的 workspace.default」也显式告警；config **解析失败**不再被当作「未声明」——声明值未知时若无 `-w`/`PD_WORKSPACE_DIR` 覆盖则 fail-closed 报错，不再把脚下目录交给写命令（`pd pain record`），有显式覆盖时保留覆盖并说出采用的目标；`-w .` 这类等价相对路径不再误报分歧。杜绝多宿主下「查错库 = 查无候选」的假阴性与静默改目标。
