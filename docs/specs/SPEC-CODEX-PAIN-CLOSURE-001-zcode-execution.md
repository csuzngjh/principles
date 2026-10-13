# zcode 后端执行指令：一次性完成 Codex 痛苦信号闭环修复

## 任务与授权

你是本地 zcode 后端运行的工程代理。工程根目录为 `D:\Code\principles`。

Owner 本次任务已批准 `SPEC-CODEX-PAIN-CLOSURE-001-v0.2` 的工程实施，包括 CR-02 的明确 Owner 陈述、CR-07 的当前消息明确前缀入口，以及其他修复、兼容迁移、验证和有界恢复。SPEC 内 Draft/等待审阅是创建时状态，由本执行任务覆盖；不能以此再次向 Owner 请求批准。

执行到代码、测试、独立复核、可安装候选交付、真实 Codex/Companion 验收和最终报告，不停在分析、计划、单元测试或创建 PR。Owner 已授权必要的常规修复和重试。全程非交互：不要询问问题、请求设计审批、逐步确认或要求 Owner 选方案；遇到常规技术选择按 SPEC 和当前源码作最小决定并记录。

工程授权不等于批准 PD 产生的原则，不允许自动批准/激活、写 Owner Outcome、修改工程宪法或扩大整段对话采集。保留产品中的人工审阅门，其存在不构成工程任务的阻塞。

允许创建隔离 worktree/分支，提交和推送本任务代码，创建/更新 PR；不自动合并 PR、不直推 main、不发布公共包。候选安装与真实宿主验证应尽量独立于 PR 合并/公共发版，不要因尚未合并而跳过所有安装验收。正常 installer 支持时，允许构建本提交的候选安装包并安装到隔离验收环境；正常 installer 支持对当前 Codex 运行环境交付该候选时，允许备份后采用该正规路径更新。不得手改安装文件或绕过签名/信任机制。明确区分候选运行验证、公共发行和用户当前工作区已升级。

允许通过已验证的 PD 命令有界恢复唯一指定信号 `manual_1791868470372_8c47edyh`，先 dry-run/备份，再以本任务授权执行既有确认语义；不再征求第二次授权。不批量恢复其他信号，不把原信号的 AI 摘要冒充 Owner 原话。需要 Owner 陈述时只能使用已有明确提交记录且原文/授权/血缘可核实的材料；不足则保留补证处置，继续其他工程验收。

## 必读与文件定位

先读取：

1. `D:\Code\principles\AGENTS.md`。
2. `D:\Code\principles\docs\specs\SPEC-CODEX-PAIN-CLOSURE-001-v0.2.md`。
3. `D:\Code\principles\docs\specs\SPEC-CODEX-PAIN-CLOSURE-001-v0.2-review.md`。
4. 产品身份、适用 ADR/入口契约和 ERROR_PATTERN_INDEX；只读与任务相关的 ERR，不整库加载。

以上 SPEC 和复核文件可能尚未被 Git 跟踪。创建 worktree 后核对它们确已存在；必要时只复制这两份明确文件到任务 worktree，核对内容摘要。不得假设 checkout 会自动带上它们，不能改读 v0.1。

工作区已有无关修改：保留原状，不 reset/clean/stash 他人的工作。使用 `codex/codex-pain-closure` 或不冲突的同前缀任务分支，记录固定起点；当前源码变更需与 SPEC 的旧基线作差异核对，不能回退现有修复。

## 执行顺序与每步完成条件

### 1. 建立基线及可执行验证计划

执行 `git status --short`、`git log -n 5 --oneline`；创建/复用安全隔离工作区。按仓库 bootstrap 流程准备依赖；需要时执行 `node scripts/setup-worktree.mjs`、`npm ci` 和必要的 Git LFS 获取，避免用未安装依赖或 LFS 指针解释失败。参数先查当前脚本帮助，不照抄不存在的选项。

按 linear-cli skill 读取 PRI-958/PRI-959 最新内容，并搜索与执行结果误记/后处理丢失相同的票。授权工程推进并按既有 workflow 管理状态，中文记录证据，不创建重复票，不以历史“等待Owner决定”取代本任务已有授权。遇到真实外部依赖 blocker，不自动伪造清除；继续不依赖它的工作。

输出 requirements→producer→consumer→authority→test 对应表，覆盖 CR-01～CR-08、A01～A22。运行 error:context plan mode，合并语义选择后的 Required Evidence 到验证计划。

确认真实 Codex/Companion、正常 installer、provider/profile、Hook、安装清单和隔离验收目录可用；只引用已有凭据环境，不输出密钥。真实宿主没有可用自动驱动路径时先寻找现有可用 CLI/API/测试驱动，不请求用户点界面，也不能用自造 Hook 样本冒充真实交付证据。

完成条件：每项有实际生产入口、测试方式和证据落点；任何能力缺口有具体事实，不是未经查证的假设。

### 2. 修复并逐段验证

实现完整 SPEC，重点禁止以下遗漏：

- 当前 Codex 工具结果 success/failure/unknown 如实记录；未知不默认 exit=0，也不从文本关键字猜失败。
- 明确用户前缀入口在实际 UserPromptSubmit Hook 接通；使用本事件宿主身份，不让模型猜会话/轮次，不读整段对话来补身份。
- 明确 Owner 陈述、reason、轨迹和模型输出分类清楚；同一观察键唯一 canonical pain；登记/任务跨库中断按已有续接机制恢复。
- 自动/手动写入使用同一完整准入。candidate store 保存不可变评估历史、当前指针及独立处理进度；processing 不覆盖旧decision。
- worker 实际消费诊断成功后的 orphan、intake失败、consumed但未seed、已seed但链接中断；不是调用 buildExistingResult 或只改UI状态。
- 后处理恢复不重新运行诊断LLM，Ledger/task幂等，有限重试、长期阻碍可查，各工作类别最多3个完整周期获得执行机会。
- ready不冒充后台活性；阶段deadline内的长运行不被误报停滞；产品审批/激活门保留。
- 同步CLI、async CLI、--wait、Hook快速入队分别符合实际返回和后台行为。
- Codex实际安装的插件入口/技能/说明一同交付，不只改OpenClaw模板。

读现有 exports、调用者及公共契约后修改；复用既有 owner，不引入新通用调度器、provider、registry。若源码已有能力，只补连接。Routine implementation decisions无需再次询问；如方案必须越过SPEC授权边界，保留具体阻碍，不擅自扩大。

在正确生产边界构建能击中原缺陷的回归，先确认旧状态会失败，再修复使其通过。相关BDD不能删、禁用或降级。共享类型/schema变化验证所有实际消费者及旧库迁移，不只跑core helper。

完成条件：每条必修有diff、对应验收和负向证据；没有用假材料、手工intake或改数据库使测试通过。

### 3. 闭合评审与全部检查

运行相关测试、跨包契约、SQLite round-trip/迁移、真实Commander注册、worker重启/故障注入，再运行 `npm run verify:merge`。失败先定位并修本任务回归；无关旧失败固定证据并单列，不藏skip、不降低期望、不无限重跑无变化的检查。

运行 error:context diff mode及对抗自评。若有代理能力，分别执行 Standards 与 Spec 独立评审，代码探查优先Luna；代理不可用时用独立的审阅上下文自评，不声称独立评审已经完成。有效在范围内的发现修复后重新验证直到收敛；不把相邻机会扩成当前任务。

可复用真实缺陷按AGENTS及record-error流程分类/记录，使用已有记录工具，不手写或修改冻结ERR快照，不修改用户级memory。

完成条件：评审阻碍已收敛，检查有真实执行结果，未执行/未通过项明确列出。

### 4. 候选安装和真实宿主验收

构建本提交对应的正规候选包；使用现有正常installer的非交互方式安装到隔离验收环境，不依赖公共npm先发版。先检查当前installer帮助；现有 `--host codex`、`--workspace`、`--non-interactive`/`--json` 可作为核对起点，不默认它支持任意本地包、任意profile或绕过信任验证。

使用真实Codex发出明确反馈，并由实际安装的Hook→登记→任务→真实provider→Companion worker消费，不用test-double冒充。至少验证：

- 工具真正失败时记录和CLI取证一致；工具全成功但明确Owner反馈时可正常处理。
- A03/A11正常样例无人工推进，到真实支持prompt渠道的Owner审阅入口。
- A09逐个后处理边界中断后重启恢复；A18暂时intake/seed失败最终自动续接。
- A17同观察键重复事件/CLI/通用检测不重复信号；A20验证实际活性、重启及长阶段负控。
- A21持续backlog下重试与orphan有有限服务机会；A22回执、启动、deadline和真实拓扑的时间证据。
- 负向案例稳定进入真实补证/待审/失败状态；产品中的待Owner审阅是正确结果，不需要向Owner发起本工程的批准请求。

证据读取真实数据库关联：pain、源run、candidate、admission版本、Ledger、后续task、审阅工件/入口、worker周期和安装sourceCommit。截图、进程存在、ready或任务数量单独都不证明验收成功。

安装候选已经验证不代表本机生产workspace已升级；原信号恢复只在包含本次修复的实际运行版本上执行。未进入该版本则报告恢复尚未执行，禁止去旧安装目录补丁式修复。

完成条件：SPEC要求的真实验收均有证据；正向blocked/unsupported不算通过。外部依赖确实不可用则所有可执行项仍须完成，最终据实PARTIAL。

### 5. 最终交付

提交并推送任务分支，创建/更新PR，关联已有工单；按Linear workflow交接状态。GitHub可访问时处理本PR有效反馈和CI，直到收敛；不得因自动review限额把未完成review称为通过。

交付候选安装包、准确安装/恢复命令、rollback方案，以及以下可审阅材料：

- `IMPLEMENTATION_REPORT.md`：改动、Complexity Delta、安装版本/commit、完整与部分完成项。
- `ACCEPTANCE_MATRIX.md`：CR-01～08和A01～22逐项状态、真实命令、结果、证据路径、旧状态负控。
- `HOST_VALIDATION.md`：真实Codex/Companion自动流程、时间、重启及安装证据。
- `REVIEW_FINDINGS.md`：独立评审或自评的发现及处理；明确评审方式。
- `REMAINING_GAPS.md`：只列真实未闭合事项，没有则明确None；区分工程失败、外部环境、公共发行和产品正常待审。

按AGENTS/private-doc政策选择保存位置：Owner敏感运行报告放私有文档或项目外的本地交付目录，PR只含脱敏摘要；不可将凭据、整段用户会话或私有资料复制到公开仓库。

最终直接用中文给出：完成结论→Owner影响→PR及交付链接→验收通过/失败/未运行→原信号恢复状态→后续外部依赖。不要再以“请批准下一步”“是否继续”“请提供截图”结束。

## 持续执行与真实阻碍

每个重要步骤写checkpoint，记录已验证状态、下一步和不可变关联。遵守每会话30000 token约束；支持自动续跑时用持久checkpoint继续，不把正常上下文压缩当作重新审批理由。后端未配置自动续跑能力时如实报告限制，不能创建并不存在的续跑任务或默默超预算。

对暂时网络、依赖、构建和API故障作有界重试并定位原因；不要等Owner指导。缺权限、凭据、签名、真实宿主能力或不可自行跨越的仓库限制时，不绕过、不造假、不重复发问：完成不依赖该条件的其余工作，输出准确阻碍及预备好的恢复步骤，保留可续接状态。

“非交互”取消本任务的重复设计/工程确认，不取消真实工具权限，不授权公共发行或原则审批；不能用它作为伪造授权和成功证据的理由。

**最终完成判据：实现、评审、检查、正规候选安装和真实Codex正向/恢复验收均通过，才写COMPLETE。只完成代码、PR或可见阻碍必须写PARTIAL，并明确欠缺。**
