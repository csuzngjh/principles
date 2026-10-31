# Console Owner Workbench 004 — 实施与验收记录

2026-10-31 类型识别反馈修正：以既有 channel/decision kind 派生本地展示类型，增加 Lucide 图标、主题标签与阅读区同类标识；规则上线、方案修订、行为验证不再统称本轮方案决定。未知类型保留“待核对”，不从标题或模型文字猜测类型。只改变展示，不重排事项、不生成紧急级别，不改变任何写入目标/资格。安全/阻塞提醒仍用原事实来源。类型/主题工作台浏览器 7 项、Focus 单测 105 项、既有 i18n 单测 20 项通过；UI 构建与 Console 类型检查通过。该追加没有新的持久事实、状态、服务、公共后端契约、开关、跨包依赖、宿主行为或外部调用。

2026-10-31 试用反馈修正：待办列表使用局部 6px、透明轨道、主题色滑块，移除 WebKit 两端箭头，保留原生拖动/键盘滚动与强制颜色支持。今日思考此前在运行历史折叠区内，现移至该折叠区外独立显示，仍位于任务阅读流之后，原内容与换一句保留。浏览器工作台 6 项通过（含明暗主题、滚动与警句可见/切换），Focus 既有单测 105 项通过；UI 构建及 Console 类型检查通过。类型检查首次缺少前次 bundle 阶段后的插件声明产物，重建工作区插件声明后通过，未改相关服务源码。明暗截图已重新目验。该追加不改变审批契约或既有验收缺口。

实施开始：2026-10-30；收尾核查：2026-10-31。状态：代码及本地定向回归完成，完整验收尚未闭合；未发布、未替换已安装控制台。

## Owner Review Card

1. 问题：旧页面把分组审批、决策、运行摘要与历史同时展开，阅读与提交对象不够明确。
2. Before：分组卡可能逐条循环提交；普通审批没有绑定 Owner 实际阅读时的工件指纹。
3. After：事项列表与单件阅读、逐对象提交、结果重新读取；原则列表缩短标题、折叠概况/形成信息，详情优先呈现规则与决定；查询条件保留在地址中。
4. 复用：现有 React 外壳、主题、路由、审批队列、Owner 决策投影、绑定队列与激活服务；不新增治理权威。
5. Complexity Delta：见下表。新增只读材料与可选版本条件契约，其余架构项无新增。
6. 理由：连接已有生产能力；正文与版本条件由同次读取返回，决定在既有事务中比对，不建立另一套审批系统。
7. 验证：仅合成工作区与临时 SQLite，见验证记录。真实 Owner 理解与满意度不能由工程测试代替。
8. 风险：历史客户端不传可选版本条件时仍使用旧语义；新增保证限于更新后传条件的 Console 路径。缺失来源必须明确显示，不能补造原话或改善结果。
9. 恢复：回退源码与正式构建；无需治理数据迁移。通过正式安装/发布流程交付，禁止手工覆盖已安装运行时。
10. 后续：实际 Owner 体验验收、正式发布与安装验证分别进行；不增加 005 自动关联能力。

## 范围与基线保护

- Owner 已批准 004 v0.2 及阅读版本保护补充方案；原规范与批准记录位于独立私有文档库，不复制进公开仓库。
- 基线包含 PR #2227 合并提交 `bee7c45c1c9caa076a70e552ef6fac452f93fe3d`；没有合并整个旧 005 开发分支。
- 本轮集成固定主线 `288ed6eff`，包含后续已合并产品版本、运行时 pin 和官网文档变化；该提交与 #2227 均经 ancestor 检查确认保留。
- #2227 的实际合并差异没有 Console 文件；本轮保留其 V2 shadow/source receipt 实现及测试，不把它误记为界面变更。
- 明确批准的交互变化：移除隐式多对象循环按钮。逐对象批准、拒绝、替换保留；不在折叠历史区保留绕过入口。

## 实际复杂度

| 项目 | 新增 | 说明 |
|---|---|---|
| 持久事实权威 | NO | 仍由审批/激活/绑定既有 owner 管理 |
| 持久 schema/state | NO | 无表、字段或治理迁移 |
| 子系统/后台进程 | NO | 无新增服务 |
| 公共契约 | YES | 可选 ApprovalReviewGuard 与只读 material DTO；旧调用兼容，事务内负例验证，回退源码可移除 |
| 运行开关 | NO | 不新增开关 |
| 跨包依赖 | NO | 使用既有 core/Console 依赖 |
| 宿主专有行为 | NO | 复用既有 targetHost 资格与容量规则 |
| 外部网络能力 | NO | 无新增模型、遥测或外部请求 |

页面新增的临时交互状态包括选中事项、URL/浏览器往返、请求 epoch、来源读取状态、焦点与结果宣告。它们都是派生状态，不是治理记录。

## 写入边界

- 更新后的 Console GET 同次读取审批记录及准确工件，返回材料与 `approval-review-v1` 条件；当前页面以该条件提交。
- approve 在原 `BEGIN IMMEDIATE` 内核对身份、通道与指纹；reject/edit 使用同一事务保护。缺失工件仅允许仍为缺失的 reject 分支。
- edit 的替代稿验证、lineage 与内部计算的替代稿指纹在最终事务中复核；不信任客户端提供替代稿资格。
- 服务预检使用同一次受保护读取的记录，避免拿 A 做检查、拿 B 写入。
- 原意对照带 artifact ID/指纹，不能把旧对照勾选用于新正文。
- 旧 HTTP/CLI 未传条件仍兼容；条件一旦提供且无效，不降级成旧写入。
- 审批与激活分开；失败后读取权威状态，不自动重复提交审批。
- 准确材料只取同一工件的正文、理由、适用范围、风险及拟议行为。缺失/畸形风险与拟议行为保留未知；原则层信息另行命名，不借作本版本事实。
- 明确的 4xx 拒绝保留本次失败原因；重新读到他人完成的终态不会冒称本次决定成功。网络结果未知只确认当前记录。已恢复的 active 事实优先于先前激活失败响应。

## 验证记录

已执行，退出码均为 0：

- PR #2227 三组保护测试：`diagnostician-association-validation`、`diag-router-runner`、`diagnostician-committer`，38 tests PASS（后端隔离工作区）。
- 后端阅读保护与修订替换：25 tests PASS；预检快照竞争回归在修复前失败、修复后通过。
- core build 及 core/Console/CLI 类型检查通过（后端隔离工作区）；集成工作区 Console 类型检查通过。
- P-ERR-004 记录同次读取身份不一致根因；官方记录验证及 `check:error-handbook` 通过。
- 扩展 core 回归：activation/writers/Owner Decision 32 文件，627 tests PASS（后端隔离工作区，同次 guard 源码）。
- 集成工作区全 Console：160 文件，3009 PASS + 1 expected fail，exit 0；初次为 23 failed / 2984 passed / 1 expected fail，修复实际备注/容量说明/来源缺口并迁移旧结构断言后重跑。6 个迁移文件原有 278 场景全部保留。
- 首轮 Owner 浏览器回归 15 PASS：准确审批与备注/持久状态、详情拒绝/替换/迟到读取、独立降级/挂起来源/窄屏往返/对照指纹不符、原绑定与规则控制；后续扩展结果如下。
- 最终构建后全 Console：`npm test --workspace=@principles/pd-console`，160 文件，**3011 PASS + 1 expected fail**，exit 0，日志 `.tmp/console-004-unit-final.log`。没有把 expected fail 称为通过断言。
- CLI 兼容：activation、approve flag wiring/capacity、nextAction 四文件，**106 PASS**，exit 0；原 CLI 不强制新增 guard。
- Owner 浏览器整套 **22 PASS**；最后源改动相关局部 **12 PASS**，均无跳过。覆盖同原则两个对象先成功/后失败、已落库后响应丢失、他人先批准导致本次拒绝 409、真实键盘批准、长标题尾句查询、迟到筛选结果、320px 卡片首屏与返回定位。局部结果不重复加总为独立场景数。
- 既有六个浏览器文件与两个 BDD 文件：**37 PASS**，exit 0，无跳过，日志 `.tmp/console-004-existing-browser-final.log`。覆盖 no-auth 三动作锁、精确激活深链、规则紧急停用/持久状态、逐字全文/换行/15px、只读展开/关闭、skip-to-main、移动抽屉、语言切换和来源降级。初次 35 PASS / 2 FAIL：修复首次自动抢焦点；将旧装饰前缀断言迁为同次 GET 拟议行为与页面逐字断言，未删除业务内容要求。
- 补足规范精确尺寸：1280×800、1440×1024 无横向溢出、决定按钮滚动后可完整触及；工作台文件 **5 PASS**，exit 0，日志 `.tmp/console-004-viewport-final.log`。原生缩放仍未验证，不用 viewport 模拟替代。

合并检查 `npm run verify:merge` 首次退出 1，停止于 website 的既有视频字幕契约：`homepage-contract.test.mjs:175`，字幕「只让它修按钮，却又改了整页。」不在 narration manifest 中。已在主分支 `75a5d25a5` 只读复跑同一具体测试，得到相同失败：

`node --test --test-name-pattern='published videos contain synchronized narration' packages/website/tests/homepage-contract.test.mjs`

本轮相对固定主线无 website 差异，不修复/放宽相邻网站测试；完整合并门禁仍为 FAIL，不宣称通过。网站之前的 release intent、工件、错误手册、遥测、仓库卫生、运行时、文档、安全、工具和 guard 检查已执行。

网站之后的 13 阶段已按原顺序单独执行，全部 exit 0：lint、全仓 build、pipeline contract、workspace artifacts、release artifact hygiene、core/CLI/install-layout/plugin/Console/Companion 类型检查、satellite bundle、runtime writers。日志 `.tmp/console-004-remaining-gates.log`。lint 含既有 `in`/导入方向等警告；被 ESLint 忽略的测试文件不计为已 lint，另以类型检查与真实测试验证。没有跳过某一步后称整体门禁通过。

原生浏览器 200%/400% 缩放：NOT VERIFIED。Windows 工具恢复最小化 Chrome 后仍不能可靠确认浏览器 URL，自动停止控制；未绕过。窄屏/主题截图与 viewport 变化不代替原生缩放。

## 验收覆盖与剩余缺口

以下是证据范围，不把“代码保留”写成“已在真实宿主体验验收”。

| AC | 当前证据 | 状态/缺口 |
|---|---|---|
| 01 | 路由扫描、登录/无认证、导航/语言/主题与深链回归；App 外壳未重做 | PARTIAL：真实 Companion 工作区切换/安装态未运行 |
| 02 | 选择、返回、刷新、浏览器往返、窄屏末项返回 | PASS |
| 03 | 逐对象 exact GET/guard、同组独立记录与版本错配负例 | PASS（HTTP/核心及浏览器分层证据） |
| 04 | 同原则 A 成功、B 请求失败，A 不重发，持久结果分别核对 | PASS |
| 05 | approve/reject/edit、备注、revision intent/digest；原 native 决策组件保留 | PASS（定向回归） |
| 06 | RuleCode 提升/拒绝、精确深链、紧急 containment 与持久状态 | PASS（定向回归；不声称真实宿主生效） |
| 07 | 绑定/stale/受阻资格浏览器及全 Console 接口/组件回归；原撤销、修订、来源纠正实现未删除 | PARTIAL：撤销/来源纠正的完整浏览器正例未单独执行 |
| 08 | 容量/预算接口、CLI、双语展示契约与 warning 消费保留 | PARTIAL：多宿主选择及所有 warning 的浏览器矩阵未全部运行 |
| 09 | 摘要 503、挂起运行来源、degraded inbox、projection off/no-auth 场景 | PASS（已列组合；不声称所有开关笛卡尔积） |
| 10 | 短标题/尾句检索、筛选与排序 URL、展开不导航、详情返回、准确全文 | PASS |
| 11 | 已落库后响应丢失、并发 409 不冒领、审批/激活后果分层；失败激活服务回归 | PASS（浏览器与服务分层；不是所有故障的单一端到端试验） |
| 12 | 1280×720/800、1440×900/1024、390/320、明暗、双语、skip/nav/真实键盘批准、正文 15px | PARTIAL：原生 200%/400% 缩放未验证；不声称完整可访问性认证 |
| 13 | 真实 SQLite/HTTP 的旧读新写、同 ID 改文、预检/写入之间变化、替代稿内容/lineage 竞争 | PASS |
| 14 | 成功来源独立呈现、挂起/失败不清零、详情/列表迟到响应；宿主变更重挂阅读确认 | PARTIAL：真实工作区切换与所有来源/宿主延迟矩阵未全部运行 |
| 15 | 同版本风险/拟议行为/缺口常驻；历史折叠、来源覆盖说明与 cancelled 过滤保留 | PASS（代码、契约与定向 UI 证据） |

因此 **不声明 AC-01～AC-15 全部 PASS**。剩余项主要是正式宿主/环境和完整矩阵验收，不能通过改断言或隐藏能力消除。

## 视觉与隔离预览

11 张实际浏览器截图位于 `packages/pd-console/.tmp/owner-workbench/`（忽略目录，不提交用户资料）。已目验明暗工作台、原则列表与 320px 列表；320px 首屏能看到第一张原则卡标题。截图是合成数据的实际渲染，不是生成效果图，不证明 Owner 已理解或满意。

隔离服务：`http://127.0.0.1:7790/#/focus`，测试令牌 `owner-e2e-token`。它创建独立临时合成工作区，使用真实源码服务与写入路径；点击决定只改变测试资料，刷新不会撤销已经记录的测试决定。重建测试服务才会重新 seed。API 已验证返回准确材料及 `approval-review-v1`；health 中旧时间/未运行流水线告警来自刻意构造的 fixture，不代表真实工作区健康。

重启（在 `packages/pd-console` 下，先完成仓库构建）：

```powershell
$env:PD_CONSOLE_E2E_PORT='7790'
$env:PD_CONSOLE_E2E_OWNER_AUTH='1'
$env:PD_CONSOLE_TOKEN='owner-e2e-token'
$env:PD_OWNER_ID='owner-e2e'
$env:PD_OWNER_CREDENTIAL_ID='credential-e2e'
node scripts/e2e-start.mjs
```

在启动终端 Ctrl+C 停止。测试材料与演练过程不是 Owner 的正式治理决定；真实工作区和安装目录未被修改。

## 评审与错误模式

- Standards 与 Spec 两轴独立评审发现并修复：详情入口临时锁、版本对照错配、服务预检快照错配、决定必需限制缺失、归档后果文案、来源独立加载及宿主确认清理。最终再次关闭长标题、列表迟到覆盖与终态冒领三项 P2；首次抢焦点由既有浏览器回归发现并修复，不放宽 skip 导航要求。
- error-context 规划命中 EP-03（失败不冒充成功）、EP-02（生产入口）、EP-06（源码/构建）、EP-11（双语）、EP-13（主题）。语义另选 EP-01/07/09，分别验证输入负例、同次身份与真实浏览器状态。
- diff 模式命中 HIGH：EP-09/11/03/13/06/02/08/01/14；MEDIUM：EP-05/07；LOW：EP-12。分别以真实浏览器/事务负例、双语/主题、结果与当前事实分离、生产构建、写入前条件、严格 DTO、产物卫生、请求 epoch 和隔离 workspace 响应；没有未解释的新 HIGH 排除项。
- P-ERR-004 与 P-ERR-002 均通过官方 occurrence writer 写入；手册校验通过。既有 EP-02 inventory/count-guard 热点未扩入本任务。
- `pr-risk-gate`：HIGH，confidence 0.95，建议合并前独立外部复查（core 事务、跨包契约与 Owner 决策路径）。未自动发送外部审查请求；Owner 品味审计未代填。
- 本轮没有安装、发布、真实批准、真实激活或行为改善证据。
