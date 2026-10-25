# SPEC-PD-RUNTIME-HANDOVER-001 v0.1

日期：2026-10-24。PRI-1040。Owner 已在本会话要求使用子代理实施两项已调查修复；本文件细化更新交付部分，不授权发布、合并或生产治理。

## 目标与现状

安装更新后，Companion管理的worker最终切换到安装权威指向的发布，且不终止正在执行的模型调用、不并行补起第二个进程。Codex插件通过官方渠道安装具备预期能力的已发布包。

现状：release watch只交接Console；worker registry只按workspace对账；CLI已有stopped循环，但Windows kill不是合作式排空；插件pins仍0.5.9/0.11.0/1.295.0。npm已确认0.5.13/0.13.0/1.296.0存在。

## 设计与数据流

1. 复用active.json的releaseId/generation及既有readActiveRecord，不新增持久状态或发布权威。worker启动记录内存release identity，worker发布对账独立于Console是否running。
2. Companion只为自己spawn的Codex/WorkBuddy child增加私有IPC通道。子进程发送固定、校验过的支持声明；固定drain消息复用现有stopped循环，当前cycle完成才自然退出。idle等待可唤醒；不再开始下一个cycle。未知消息不能停止服务。
3. registry在发布不同且基线、权威有效时请求排空；重复tick不重复发送、不spawn。旧child自然exit确认后才按最新有效authority与最近一次有效manifest中仍授权的workspace启动替代进程。manifest沿既有60秒对账，不声称退出回调重读磁盘；观察到移除后取消重启。A→B→C直接进入最新C；rollback同样按identity变化处理。
4. drain不消耗原crash restart预算。等待超时、IPC失败、缺启动基线、authority无效、旧worker无支持声明时，保留旧child并发结构化degraded/nextAction；不强杀、不谎称交接完成。后续恢复沿现有supervisor路径。
5. manifest removal/quit原语义不暗中改变；发布排空不复用会立即kill/delete entry的stopEntry。替代进程严格在旧child退出后启动。
6. 普通修复PR更新已发布插件pins。Version PR禁止改plugins的现有allowlist不放宽。能力探针覆盖实际DesignGate/V2能力与真实包身份；check不能只匹配旧pins/安全最低版本。插件发布检查对明确目标cohort/能力要求验证，不以floating latest或尚未发布源码版本作为权威。状态同时核实core。

### 插件交付防复发接线

现有 `publish-npm.yml` 的明确 cohort 解析及每日 reconciliation 是唯一发布权威。所有 npm legs 成功后，独立 `codex-plugin-maintenance` job 在当前 main 上调用 `sync-codex-runtime-pins.mjs --cohort <sha>`：先复用 Version PR 确定性复现证明 SHA，再通过同一 resolver 验证它仍是当前且完整发布的 cohort，读取该提交的三包 manifest 精确版本，并逐包核对 npm 精确包身份。任何未发布、身份不符、过期 cohort、registry 错误都阻断；禁止拿源码当前版本或 floating latest 代替。禁止改 Version PR allowlist。

验证齐备后只更新插件 `runtime-version.json` 与 `.codex-plugin/plugin.json` patch 版本，并运行现有 `check:runtime-pin` 对真实安装包进行 S1–S8 能力探针。成功后用已有 `PD_VERSION_PR_TOKEN` 机制维护固定 `codex/runtime-pins-maintenance` 分支及同一个普通 PR；相同 payload 不重复 push，分支存在但 PR 创建失败时仍重试创建。无自动合并。缺 token、probe、push、PR 创建或编辑失败均为明确失败；npm 发布不因此改称插件已送达。既有每日发布对账会再次执行，无新服务、账本或发布权威。

普通 CI 的 `Codex plugin delivery contract` 无路径跳过：运行真实 npm 精确 pins 能力 probe；PR 下比较 base 与实际 `plugins/principles-disciple/` payload，任何变动必须严格递增插件 metadata 版本，确保 Codex 能发现不同缓存版本。仓库外侧 docs 不触发该版本 guard。首次修复版本为 `0.2.1`；后续维护不冻结本次版本 tuple。此接线证明发布后可产生可审查更新，不能证明 PR 已合并、用户缓存已刷新或运行进程已切换。

成本沿既有 release registry 查询与 npm 安装探针：CI 每次一次隔离三包安装和八场景本地验证；发布对账增加 cohort/精确身份查询与一次相同探针，无模型调用。探针失败不修改生产安装；维护 PR 可关闭/回滚。显式旧版本安装/回滚仍由官方用户流程执行，维护自动化拒绝过期 cohort 覆盖较新 pins。

## 输入、输出、成本、失败

输入：现有安装权威、manifest workspace、owned child、私有IPC消息。输出：有界交接事件、启动发布身份、明确degraded原因和实际安装能力结果。无LLM调用，无新增网络能力（沿现有npm打包探针），无新服务/DB/flag。日志不得含凭据。

首次旧Companion/旧worker不支持新协议不能被新文件追溯修复：必须诚实要求一次安全重启，后续才有自动交接保证。

Companion 为独立 Electron binary：当前仓库 `@principles/pd-companion` 为 `0.1.5`，通过既有 `companion-release.yml` 的 `companion-v*` tag 和安装包发布，tag/repo/app.asar 版本一致性由既有检查约束。npm runtime 更新、Codex 插件 metadata 更新均不会替换已运行的 Electron 程序。本次源码修复未经该独立发布和用户安装/安全重启，不能声称现有 Companion 已加载新交接逻辑；本任务不执行生产发布。

## 验收

- 生产registry测试：busy时不kill、不在exit前spawn；idle可排空；重复tick/快速发布/rollback/authority失效/manifest移除/旧worker/IPC失败/超时/原crash预算。
- 两CLI真实parser及循环测试：当前cycle未结束不退出，不开始第二轮；idle及时响应；陌生消息无效。
- Windows真实child-process IPC实验，不仅mock信号：busy→drain→自然exit→替换，退出前无新child。
- Console非running时仍对账worker；Codex/WorkBuddy两consumer都有测试。
- 官方隔离setup与真实npm探针验证目标包，故意旧包负控必须红；无生产安装文件手改。
- 合并/发布/磁盘安装/运行身份分别报告，不以任一替代其他。

## 回滚与复杂度

回滚代码及官方安装版本；不清理workspace、任务或旧插件data目录。不支持协议的旧进程显示人工恢复，不升级为强杀。

Complexity Delta：新durable truth NO；schema NO；服务/后台 NO；runtime flag NO；跨包依赖 NO；新公共抽象 NO（仅现有管理边界私有IPC）；新host行为 YES（Windows安全进程交接，真实child测试）；新外部能力 NO。
