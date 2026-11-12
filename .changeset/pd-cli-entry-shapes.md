---
'@principles/pd-cli': patch
---

修复 `pd` CLI 在"进程入口是包装器"形态下静默空转的问题（回归来自 #2555）：`argv[1] === import.meta.url` 的门闩对 loader shim（`import 'file://…/dist/index.js'`）不成立，子进程 exit 0 却什么都没执行，安装器的 WorkBuddy governance init 因此被误判为 `workbuddy_governance_init_incomplete`。命令树移到 `src/program.ts`（库，无副作用），`src/index.ts` 退回纯进程入口并无条件 `program.parse()`；"被当模块 import 不执行 CLI" 改由模块边界保证，不再依赖 argv[1] 路径比较。
