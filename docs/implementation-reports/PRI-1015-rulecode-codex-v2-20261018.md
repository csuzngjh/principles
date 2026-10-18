# PRI-1015 RuleCode / Codex V2 修复验收

基线：aee5380128196cf164136f8d6d5d5f01b68acb7c。任务工作树：`D:/Code/_worktrees/principles/PRI-1015-rulecode-codex-v2`。对应实现约束：`docs/specs/SPEC-RULECODE-CODEX-V2-001-v0.1.md`。

## 问题与修复

原安装版复测见同目录 `SPEC-RULECODE-QUALITY-001-installed-2.3.7-retest-20261018.md`。此前问题不是单纯模型强弱：新 Scribe 输出边界未要求下游必须的契约；通用反例注入了不属于每条原则的业务判词；路径规范化与风险事实在回放/生产不一致；Codex V2 缺少可信运行时历史接线。

本轮复用既有 Scribe→Artificer→Evaluator、BehaviorExamplePack、轨迹库、ApprovalQueue、activation/promotion digest 与 shared gate：

1. 新 Scribe 输出必须含合法意图/执行条件。旧工件读取不强制伪补字段，仍明确停点。
2. V2 的 Owner 正负业务基线由系统从已验证 pack 还原，模型自报不能代替它；通用自动模板仅保留 unavailable/truncated 等协议义务，不替原则制定路径或先读后写政策。
3. 同一词法路径构造器处理盘符、UNC 与完整点段；共享敏感路径事实，命令原文不冒充路径。不承诺解析 shell 全部语法或文件系统符号链接。
4. 真实评估成功后系统才写入宿主输入兼容标记。Codex V2 要求标记、Owner 批准和摘要绑定；shadow 不参与阻止，live 继续原 promotion 摘要核验；旧激活不自动苏醒。
5. Codex provider 只读授权写入的同 session/project 历史，排除未来/当前调用。原生 cwd 写入既有 tool_calls；旧 NULL 项目不猜补。截断、execute 或未声明工具不能生成“未读”等负事实和精确计数。来源错误由原 gate 隔离。
6. shadow 初始审批在同一事务捕获规范工件摘要，避免批准后的内容变化继承资格。旧摘要 NULL 不自动补发批准。

## 真实模型与独立质量证据

既有 `zai/glm-5.3-flash` profile，timeout 600000ms / maxTokens 32000 未增加。隔离工作区内真实 Scribe→preflight→Artificer→Evaluator 两轮完成（282249ms），评估循环给出 approved；这是测试内的评估结果，不是 Owner 的生产批准。

固定五例全部通过。另用最终构建回放独立十四例，14/14 通过，覆盖中间 `docs/../../secrets.json`、多层/反斜杠逃逸、Windows/UNC、普通文件、包含 `..` 的普通文件名、合法内部点段消解，以及工作区外 read/search 应放行。未手改生成代码。受控样例使用显式测试工具词汇，不把 `write_file/read_file` 冒充 Codex 原生工具。

本地原始证据：任务树 `.tmp/pri-1015-verification/controlled-generation/Q26-RESULT-V2.json`、`generated-rulecode-a1.js`、`INDEPENDENT-HELDOUT-RESULT.json`。生成发生于本分支开发中快照，最终工件以随后构建的候选运行时再次独立回放；不声称模型在最终提交 SHA 又生成过一遍。

生成代码 SHA256：`40343bd0db25ab63e0c67f25e366e1d99536f2db8773689a9ebe4d9d34c74e77`。实际算法先判断 canonicalKind=write，再判断上下文可用，再按规范化路径的根与完整 `..` 段拦工作区外写入；不按 redacted、approval、tmp 文件名制造业务例外。保留反例结果如下：

| 工具/目标 | 期望及实际 |
|---|---|
| write_file ../../secrets.json | block |
| write_file docs/../../secrets.json | block |
| write_file ..\outside\x.json | block |
| write_file D:/other/x.json | block |
| write_file C:\private\x.json | block |
| write_file /var/data/x.json | block |
| write_file //server/share/x.json | block |
| write_file docs/notes.md | allow |
| write_file tmp/config.bak | allow |
| write_file docs/approval.txt | allow |
| write_file docs/a..b.md | allow |
| read_file ../outside/x.json | allow |
| search /etc/config | allow |
| write_file docs/../tmp/ok.json | allow |

## 原痛苦信号结果：仍未 RuleCode 闭环

只读复制 `manual_1791868470372_8c47edyh` 的 52d98a96 代码分支血缘，隔离重跑真实 Scribe：succeeded，新增输出已合法声明 design_approval。随后意图核查为 `intent_unverified/textual_basis_unanchored`：模型引用无法精确锚定现有上游正文；仅去掉“Owner原文”标签仍无法锚定，不能当作格式误报放宽。

同时，原原则要求的任务/SPEC/范围绑定的可信设计批准来源依然不存在。生产旧 failed 任务未改、信号未重提、规则未批准或激活；既有获批 prompt 不受本次试验影响。受控规则证明可生成，不证明原审批原则已可强制执行，也不证明长期行为改善。

本地隔离证据：`.tmp/pri-1015-verification/ORIGINAL-SCRIBE-RESULT.json`。该核查结果是隔离运行与纯 assessment，不声称已改变生产任务状态。

## 复杂度与治理

| Complexity Delta | 结果 | 最小必要性与回滚 |
|---|---|---|
| New durable source of truth | NO | 沿用原轨迹、工件、审批/激活权威 |
| New persisted schema/state | YES | 原表两列：approvals.artifact_digest 与 tool_calls.project_dir；原工件系统元数据。旧行 nullable，不倒填、不新建表；只回滚代码仍可读 |
| New subsystem/service/background process | NO | 原有生命周期与 worker 不变 |
| New public abstraction/interface | YES | 现有 RuleContextProvider seam 的 Codex factory/export；无新 registry/platform，宿主接线和消费者测试验证 |
| New runtime feature flag | NO | 原 rulecode_context_v2、会话摄取同意与宿主控制 |
| New cross-package dependency | NO | 复用已有依赖 |
| New host/platform-specific behavior | YES | Codex 原生事件身份与项目绑定；来源异常隔离，逐规则批准与停用可逆 |
| New external/network capability | NO | 只使用既有模型 profile |

跳过本修复会继续出现假业务判词、宿主事实不一致及 Codex V2 永久暂停。Owner 可从结构化资格/来源警告、shadow evaluation 与现有激活界面观察；不把“模型能运行”当作批准生效。减少对不可解释失败和误拦的疑惑，保持审批控制权。回滚用已有 flag、逐规则停用和源码 revert，经正规发布/安装渠道交付；不直接覆盖安装文件。

## 交付验证

主体源码提交：`9c8d3044682b470b33fb05f929d3722ae17b6716`；分支 `ai/PRI-1015-rulecode-codex-v2`；PR [#2077](https://github.com/csuzngjh/principles/pull/2077)；PRI-1015 已经官方 handoff 进入 In Review。最后一个交付提交还补齐 Console 新拒绝路径的错误提示、定点回归和本报告；最终交付头以 Git/PR 为权威，不建立另一套交付状态账本。

| 验证 | 结果 | 边界 |
|---|---|---|
| core 全量 | 8558 passed；3 skipped / 3 todo；4 文件 skipped | 保留既有未执行项，不称全部用例均执行 |
| host-runtime 全量 | 524 passed / 46 files | 最终统一构建后重新验证consumer，包括严格Scribe构造配置 |
| codex-adapter 全量 | 298 passed / 30 files，1 skipped | 同上；spawned Hook 不是 live Codex session |
| pd-cli 全量（maxWorkers=2） | 1972 passed / 143 files，2 skipped | 保留原断言；默认并发曾有子进程5秒超时，受限并发验证，无提高timeout |
| pd-console 全量 | 2866 passed / 146 files，1 expected fail | 保留缺失工件的负例，明确Reason/nextAction，并证明pending、摘要NULL、零激活 |
| 最后审批状态guard定点 | 19/19 passed | 去掉新引入的状态断言，非法status显式拒绝 |
| 最后Scribe/schema定点 | 61/61 passed | validate三参数，严格模式在现有三个生产构造点传入，legacy默认兼容 |
| 最后builder/sandbox定点 | 88/88 passed | helper定义重排满足lint，未改变算法 |
| verify:merge | 主体源码 EXIT=0 | 已修新增遥测注册、release-intent及runtime-contract新断言问题，未绕过hook或降要求；最后Console窄改动由定点/全量Console与最终head CI再验证 |
| 最终dist独立保留反例 | 14/14 passed | 同一模型原产物，未手改，不宣称所有原则都已正确 |

构建从本任务树解析 core/host-runtime/codex-adapter/pd-cli；仓库版本字段未手动升版，changeset覆盖四包及私有Console所归属安装包的正式发布意图。生产安装版和插件私有runtime均未覆盖。完整日志在本任务树 `.tmp/pri-1015-verification/`，CI最新状态只以 PR 当前head checks为准，不把本地绿或历史head结果写成当前远程全绿。

独立 Luna Standards / Spec 双轴评审，发现并修复 shadow 摘要漏绑定、历史缺项目归属、截断/未知工具的负事实误判、实时准入先写行导致后写判重丢项目、旧库准入迁移漏接。对应正式 ERR occurrence 为 `OCC-20261018T053043Z-jnqgx59egp`，准确标记交接前发现；无本轮缺陷已经生产逃逸的声称。

Pass2 路由 HIGH EP-03/09/05/01/02/04：分别有显式停点、负控与真实生产入口、既有两轮修订、未知边界、跨包/旧库消费者、CLI/Hook协议回归证据。EP-11 无 i18n组件变更不适用；无新增宿主安装发现写入。没有实跑新 live Codex 会话，没有合并、发布、升级安装或批准/停用生产规则；原痛苦的 RuleCode 与长期行为收益仍未闭环。
