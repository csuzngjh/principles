# WorkBuddy 配套技能与显式痛苦登记修复

## 结论与交付边界

本轮修复插件缺技能和缺少 WorkBuddy 显式 Owner 登记入口，并补齐旧缓存升级。
源代码交付不等于已发布，也不等于真实用户的安装已升级。未 push、建 PR、合并或发布。

设计：`docs/specs/SPEC-WORKBUDDY-PAIN-CLOSURE-001-v0.1.md`。
基线：`d91b9e07e97a262298f3e41124a27e8087eeb7c7`。

## 实现

- 四项技能随 adapter、installer payload、marketplace 和版本缓存交付：
  `pd-record-pain`、`pd-status`、`pd-review`、`pd-disable`。
- 当前 Owner 原生消息使用精确前缀 `PD记录痛苦：`；正文 1–500 字符，超长拒绝。
  原生会话和轮次标识不可缺失，内部续写不可获得 Owner 权限。
- 复用共享 admission、幂等身份、痛苦库和诊断任务 ensure；原文保持
  `owner_statement` 的未经独立验证分类，不制造技术证据。
- 回执明确给出 painId、taskId、WorkBuddy 归因；登记不意味着诊断、候选准入、审批或激活。
- 默认关闭，固定使用宿主治理目录。状态、审阅和关闭技能使用既有 CLI/安装器权威。
- 重装比较真实 payload/cache 字节，补齐同版本旧 hook-only 缓存；兼容真实引擎
  registry 数组，保留其他 scope、元数据、安装时间和旧版本缓存。
- 畸形原生输入通过有界上下文明确拒绝，不清除 Owner 消息、不绕过 decoder。
- 版本必须为安全单段 semver；写入及删除前复核缓存目标严格位于固定插件缓存根内。
- CLI `pd pain record --host workbuddy` 仍不受支持，技能明确禁止借其他宿主参数绕过。

没有新增账本、数据库结构、治理策略、评分、开关、跨包依赖或网络能力。
新增 WorkBuddy 显式输入路径、共享解析导出和委托正式安装器的插件控制脚本。

## 验证与证据分层

证据位于本工作树 `.tmp/workbuddy-pain-skills/`，不进入版本库。

| 层级 | 已验证事项 | 限制 |
| --- | --- | --- |
| 生产入口与真实 SQLite | 显式入口 23/23；离线 adapter 全套 141/141 | Hook payload 使用冻结 fixture，不能冒充桌面提交 |
| 共享兼容 | admission 50、Codex 显式入口 9、core schema 34 通过 | 子代理在各自工作树实跑 |
| 安装交付 | 实际 adapter npm pack → installer → marketplace → cache；同版升级、失败、关闭命令 | 这些用例使用隔离合成安装环境 |
| 升级与目录安全 | 子代理最终目标套件 72/72、零跳过，含恶意版本零变更快照 | 父集成复跑另留最终日志 |
| 完整 npm 安装器包 | 实际 prepack/bundle 的 tar 内容及编译安装器检查通过，7 PASS / 3 SKIP | 3 项为条件互斥的 pre-integration 分支；不宣称零跳过 |
| 真实引擎注册 | 实际 engine 注册/卸载及配置根隔离 1/1 PASS | 不证明模型推理或治理学习 |
| 真实引擎技能发现 | 原始 engine 日志明确加载四项技能、五项 Hook | 该运行发生下述隔离失误，不算隔离治理 E2E 通过 |
| 实际模型请求 | 记录到登记 ID 回执进入请求体 | 本地脚本模型，且写入隔离失败；不能作为合格产品闭环验收 |
| 后续有硬保护的原生开发验收 | `native-1792226108867/result.json`：实验库恰有 1 条 WorkBuddy 痛苦和 1 个任务，回执 ID 与模型请求对账，四技能可见，真实引擎 exit 0 | 有 lab-only wrapper HOME 拒绝保护、开发 adapter override、本地脚本模型；不算正式已安装运行时 E2E |
| 真实 LLM 全学习 BDD | NOT COMPLETED | 首次无筛选运行未完成，后续明确排除此长链；不计入 141 个离线通过项 |
| 独立审查 | SPEC 与质量两名只读审查者；发现后修复再审 | 审查者未声称自己执行父代理测试 |

首次打包缺构建前置产物，补齐后复跑；一次离线测试遇到同时清理构建产物的干扰，
随后在产物稳定时复跑 141/141。失败日志保留，不用最终成功抹去历史失败。

## 原生验收隔离失误

主代理使用 Hook 子进程的 home shim，未在发送变更型提示前验证实际子进程工作区。
引擎对 NODE_OPTIONS 有自己的子进程环境策略；直接探针能工作的 preload 不能证明
原生 Hook 也使用它。两条原文明确标注“隔离验收信号”的记录进入真实 WorkBuddy 治理库。
发现后停止原生提交并向 Owner 披露，没有直接修改数据库删除记录，也没有批准或激活。

只读复核：两条诊断任务均 succeeded；按各自 task_id 查询 principle_candidates 均为空。
具体 ID、原始模型请求、数据库读回及时间保存在 `.tmp/workbuddy-pain-skills/isolation-incident.log`
和 `native-*` 实验目录中。真实 settings 文件前后字节检查相同，不能据此声称治理数据零触碰。
这些记录保持可审计；未找到可安全采用的正式痛苦删除入口，未擅自增造清理接口。

已通过正式 error writer 记录 ERR-083 复发：
`OCC-20261017T083101Z-9h4zp8yz95`。本任务无关联 issue，不发送外部消息。
后续原生变更验收必须先证明子进程实际 workspace 位于 lab，并设置真实 HOME 拒绝条件；
仅父进程环境、插件注册或 mock 模型请求不足以证明隔离。
随后复验已采用上述硬保护，并在第一轮 Hook 观察到实验 HOME 后才提交显式登记。
实验库读回成功，真实库的实验记录仍为原来的两条；这个后续成功不撤销先前失误。

## 后续与恢复

合入并走正式发布/安装更新后，重新打开 WorkBuddy 会话核对技能发现，再执行有硬隔离保护的
已安装产物登记验收；当前不宣称真实用户安装已获得本次修复。
完整真实 provider 学习、Owner 审批及行为改善不属于本次登记成功结论。
现有宿主开关用于停用，源代码提交可回退；既有 Owner 数据不自动删除。

## 外审修复（2026-10-17，HEAD 9c588492a 之后）

外部评审给出 P1/P1/P2 三条阻塞项，本轮按最小面修复，并补了变异验证。

| 问题 | 修复 | 变异证据（回退实现后实测） |
| --- | --- | --- |
| `Test principles-core` 红：新增 barrel 导出未同步 PRI-775 冻结快照 | `runtime-v2-barrel-surface.json` 加入 `boundCorrectionEvidenceText`，`count` 1928→1929。该导出有生产消费方（`host-runtime/src/governance-signal-admission.ts` 从 barrel 导入），不是 ghost export | 修复前 CI 日志实测 `+ added (1): boundCorrectionEvidenceText`；改前本地复现同一断言 |
| 同版本刷新先删缓存再复制：复制失败会把可用插件换成半成品 | 先复制到 `.pd-staging-*`，按 `WORKBUDDY_PAYLOAD_FILES` 证明完整，再以 `.pd-backup-*` 做可回滚目录替换；**注册表写入推迟到缓存落地之后**，避免把宿主指向从未真正落地的版本 | 回退实现 + 把注入失败指向活缓存：新用例报 `the previous cache must survive a failed refresh: expected false to be true` |
| 卸载删整键与版本缓存根，误伤 project/local scope | 卸载只移除 user scope 记录；`enabledPlugins` 仅在没有其他 scope 时清除；缓存按「仍被任何 scope 引用的 installPath」逐个版本清扫，根目录空了才删 | 回退实现：新用例在 `after.plugins[key].map` 处 `undefined`（整键被删） |

补充说明：
- 缓存校验同时把 `installPath` 比较改成 `path.resolve()` 归一，避免引擎写入路径形态差异导致每轮重装。
- `pluginCacheMatchesPayload` 与暂存校验共用同一份 `WORKBUDDY_PAYLOAD_FILES`，不再是两份会漂移的清单。
- 引擎自身的 `plugin uninstall` 仍按宿主冻结事实删除整键；本轮只约束 PD 自己写的那条路径。

