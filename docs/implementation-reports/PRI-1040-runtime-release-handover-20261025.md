# PRI-1040 更新交付修复回执

日期：2026-10-25。源码候选，未合并、未发布、未升级生产安装。

## 问题与行为

原安装更新只切换磁盘组件与托管Console；常驻worker继续使用旧模块。Codex私有插件另有固定版本与缓存身份，canonical安装更新不等于插件已加载新能力。

修复复用active.json、Companion registry、现有manifest轮询和CLI循环。私有IPC请求只让当前周期结束后自然退出，旧child退出后再spawn；忙时不强杀。未知发布、无基线、旧worker无协议、IPC失败或超时均保留进程并显示交接未完成。计划排空不重置crash预算；真正非零退出仍计入原预算。Codex/WorkBuddy两consumer都接线，Console不运行不影响worker对账。

身份日志明确只是parent_authority_at_spawn，不冒称每个模块的字节证明；ready时再次核对发布身份。manifest保持既有60秒观察语义，未宣称退出时fresh读磁盘。移除事件在删除registry entry后发送，避免同步托盘刷新读到旧告警。

Codex插件pins更新到已发布0.5.13/0.13.0/1.296.0，metadata0.2.1使payload更新能被发现。status增加core核对。CI增加真实npm能力probe及payload变化必须递增插件版本检查。npm发布后复用既有cohort权威与token，校验完整最新cohort及三个精确包后维护固定普通PR；不自动合并，不改Version PR禁止plugins的allowlist，不以floating latest为权威。相同payload幂等；旧cohort、降级、缺包与probe失败显式失败，后续既有发布reconcile可重试。

## 已执行验证

- Companion全包：26文件255测试通过（含BDD、Windows真实IPC child、重叠/忙时/回滚/失败矩阵）。
- CLI定向parser/daemon/loop：20项通过；两个真实CLI child：2项通过。
- 最新真实IPC fixture已独立复验：从生产worker-drain.ts编译临时模块，不依赖CI未构建的sibling pd-cli/dist。
- scripts/workflow契约：36项通过；metadata实际CLI检查通过。
- 真实npm新cohort能力probe：8/8；旧cohort在新DesignGate校验/执行两项失败，具区分力。
- pin/status定向测试通过；相关build/typecheck通过。收尾修正 worker-drain 回调声明顺序后，定向 ESLint、pd-cli typecheck、两组 CLI 回归 6/6 通过；完整 `verify:merge` 本地运行 exit 0（日志 `.tmp/pri1040/verify-merge-final.log`），包含全包 lint、构建、契约、产物检查与类型检查。该次运行时源码尚未提交，release-intent 检查的实际提交差异证据另在提交后补跑，不把 no-diff 当成发布声明证明。GitHub CI 状态独立报告。
- 独立规格/质量审查未发现确定P0/P1；发现的干净CI测试依赖P2已修。未实际执行GitHub自动维护PR或Electron视觉验收。

## 交付与限制

Companion是独立binary渠道：npm更新不会替换运行中的Electron程序。其版本需沿现有release-prep/tag流程发布，普通源码PR不擅改packages/*版本。首次装入该修复的旧Companion/旧worker仍需一次安全重启，之后才具备新合作式交接协议。不能用这份源码报告声称当前用户已经加载。

未删除旧plugin data目录；locator歧义与实际Hook选中目录分开，官方setup按明确身份安装。没有新生产审批、激活或任务数据清理。

## Complexity Delta / 回滚

新durable truth、schema、服务、runtime flag、跨包依赖、外部能力均NO。私有IPC及Windows发布生命周期行为YES，隐藏于原进程管理边界并由真实child测试验证；无新公共平台/注册表。既有CI外部写入能力复用于普通维护PR，不新增自治合并权限。

回滚源代码及官方安装版本，不删除任务/声明/审批历史。P-ERR-083已通过官方记录器登记runtime-upgrade-all-consumers recurrence。Changeset覆盖pd-cli及installer；生产安装与Companion独立发布继续分开核实。
