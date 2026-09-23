# PRI-768 — Golden User Journey Reality Validation v4 报告

- 日期：2026-09-19（实验窗口 09-18 22:00 → 09-19 06:35 UTC+8）
- 类型：产品现实验证（只读实验，未改 PD 代码、未建 PR、未手工插入任何 Pain/候选数据）
- 场景：Scenario A「先看清，再动手」（设计文档：`D:\pd-labs\pri768-golden-journey-v4\scenario-design.md`）
- 执行模型：Orchestrator + 三个子代理（Scenario Designer / User Simulator / Reality Observer），Owner 治理动作由编排者以 Owner Simulator 身份经认证 Console 执行

---

# Executive Summary

**Golden Journey: PARTIAL**

一条真实链路走通了大半程：真实任务 → Agent 真实犯错（只改眼前文件、漏改配对值）→ Owner 自然纠正 → **Pain 最终被自动捕获** → 诊断 → 候选原则自动生成并入账。但在决定性的后半程断掉：

1. **Pain 捕获对用户不可见且极慢**：纠正后 10 分钟观察窗内零反馈；最终捕获发生在约 38 分钟后，且依赖两次编排者介入（修复死掉的分类器通道 + 用户多发一条自然收尾消息）。真实用户在纠正发生的当下，什么都没有发生。
2. **形成的候选抓错了教训**：Owner 教的是「改配置前先搜引用、一起改」，管线蒸馏出的两条候选却是「建议重启前先验证服务状态」和「诊断前先确认实际状态」——来自纠正之后一句收尾闲聊，而非纠正本体。语义保真度失败。
3. **内化管道停摆，Owner 无法决策**：两个候选卡在 dreamer 阶段（队列积压最老 18 天，consumerStatus=manual_action_required），候选详情页明示「当前不需要拥有者决策」——激活从未发生，也无法发生。
4. **第二任务行为确实变了（L2 级），但不可归因于 PD**：新会话中 Agent 表现出教科书级的「先搜引用再动手」。然而充分解释是宿主 OpenClaw 自己的记忆机制——Agent 在被纠正时把规则逐字写进了 `USER.md`（含来源标注），PD 没有激活任何新原则。

一句话结论：**管线机械可通，但「吃一堑长一智」没有以用户可感知、语义正确、可归因的方式闭合。** 更重要的是本次实验揭示了一个定位级事实：宿主的 USER.md 已经以「即时 + 逐字保真」解决了"让 Agent 记住教训"，PD 若把价值押在"记住"上，就是在重复一个更慢、更失真的轮子；PD 的差异化价值只能在 Owner 治理面（可视、可审、可撤销、可审计、跨宿主）。

---

# Environment（Phase 0 现实核查）

| 项 | 值 |
|---|---|
| 仓库基线 | origin/main `6c2fa480`（实验前 ff 同步，含 #1756/#1757） |
| Live PD runtime | 由本次从 main `6c2fa480` 构建的 self-contained release 经官方安装器部署（active.json generation 15→16，releaseId `bundled-1.74.1-66ae5f1e60c3`；storyA/features 验证通过） |
| OpenClaw | 2026.9.4 (3a9d69d)；PD 插件全核心面注册（prompt / code_tool_hook / defer_archive 三通道启用） |
| 模型 | 主对话 agent 与 7 个内部代理走 zai/glm-5.3（coding 端点）；Owner 本任务提供的 ZAI 密钥实测 glm-5.3 与 glm-5.3-flash 均 200 有效 |
| Console | 安装器自启实例（3101，no_auth，决策锁定）；另起认证实例（3110，token）执行 Owner 治理动作 |
| 网关 | schtasks 任务 `OpenClaw Gateway`，重启后 ~180-210s 就绪（已知慢启动） |

**环境修复披露（全程留痕，均非 PD 代码改动、无数据伪造）**：

1. **内部代理通道修复（01:08，有备份 `evidence/config.yaml.before-20260919-0108`）**：实况核查发现 correctionObserver / empathyObserver / signalCollector 三个内部代理的 `pi-ai.ninfer` profile 指向本地 ninfer 代理（`D:\ninfer\proxy.js`，其上游 127.0.0.1:8081 已死），纠正观察器**每个 15 分钟周期都在失败**（网关日志：`LLM execution failed: 502 proxy error: connect ECONNREFUSED 127.0.0.1:8081`）。依据 Owner 本任务明确指示「PD 内置代理使用 ZAI glm 模型（密钥已提供）」，将这三个 profile 切至已验证的 `pi-ai.glm`。**此修复发生在 H1 的 10 分钟窗口判定之后**——失败事实先于修复成立，修复没有制造结果。
2. Live runtime 升级至最新 main（Owner 指示「确保当前环境的PD是最新的版本」）。
3. 认证 Console 实例（3110）用于 Owner 审批动作——no_auth 实例下决策按钮被产品有意锁定。

**实验前已存在的存量噪声（未清理、如实声明）**：队列 19+ 条陈旧任务（最老 09-01）、41 个失败任务、pain_13 血缘断裂告警、50 条历史原则/账本、1 条既有激活原则「Model-Evidence-Reversibility-Verification Loop」（14 天内 presence=490/effect=61，每轮注入——构成 Agent 基线行为的既有 PD 影响面）。

---

# Hypothesis Result

| Hypothesis | Result | 一句话依据 |
|---|---|---|
| H1 Pain Capture | **PARTIAL** | 纠正最终被自动捕获（score=70 severe user_correction），但晚 38 分钟、需要通道修复 + 用户多一发自然消息才触发；用户在纠正当下零反馈、零感知 |
| H2 Principle Formation | **FAIL** | 候选生成了，但语义抓错教训（收尾闲聊蒸馏出「重启验证」规则）；管道卡死在 dreamer；候选详情页「当前不需要拥有者决策」+「治理证据不完整/规范血缘尚不可用」；Owner 想拒都拒不了 |
| H3 Behavior Change | **NOT ESTABLISHED** | 第二任务 L2 级行为变化真实发生，但无任何新 PD 原则被激活——行为变化有充分非 PD 解释（宿主 USER.md），不能声称内化验证完成 |

---

# Evidence Chain

```
Task 1（改 request_timeout 30→120）
  └ Session S1 (pri768-s1)，00:31:50 发送，agent 直接改 config.json，
    注意到 deploy.sh 的 30 但判断"与请求超时无关"（预案二：有检索、无配对推断）
    → 文件终态：config=120 / deploy.sh=30（不一致成立，Result A）→ commit ab4a8fa
Owner 纠正（00:37:54，同会话自然话术）
  └ agent 修复 deploy.sh（commit 9a0fbbe）
  └ ⚠ 同时把规则写入宿主 USER.md（commit d6a5a9b，"chore(memory): directive"）
    ——竞争性记忆机制入场（Observed Fact）
Pain（H1 关键证据）
  ├ 00:39–01:04：三个观察器周期全部失败（死通道 ECONNREFUSED 8081）→ 10 分钟窗 MISSING
  ├ 01:08 通道修复；01:14 周期首次成功（"One real correction… accountability phrasing
  │  added. Trajectory empty"——识别了纠正、学了线索词，但仍未生成 Pain）
  ├ 01:16:37 用户自然收尾消息（"不用重启，服务我没在跑"）
  └ 01:17:38 ✅ Pain 捕获：pain_host_a30c660f90e6a06a…  score=70 severe user_correction
Diagnosis（自动，55 秒完成）
  └ task diagnosis_pain_host_a30c660f…  succeeded（ZAI glm 通道健康后）
Candidates（01:17:38，双候选，自动入账 candidate→ledger 6ms）
  ├ 3bf1ebf9：「任何诊断或干预建议前，必须先以可观察证据确认系统实际状态…」(conf 0.6)
  └ 676b7b55：「当 AI 输出重启服务类建议…时，要求先验证服务运行状态」(conf 0.6)
  └ ⚠ 两条均非 Owner 所教内容（语义偏移，Observed Fact）
Activation
  └ ✗ MISSING —— 候选卡死 dreamer 阶段：
    队列 pending=21（我们 2 条 dreamer 任务排在 12+ 条陈旧任务后，最老 09-01），
    consumerStatus=manual_action_required（控制台自己给出的恢复指令是
    `pd runtime internalization run-once`）；候选详情「当前不需要拥有者决策」。
    编排者（Owner Simulator）判定：排空陈旧积压超出本实验授权，未执行。
Second Task（新会话 S2，06:20:02，端口 8085→9110）
  ├ 行为：先全项目 rg 检索 → 改 config.json + README 镜像 → 复核零残留 → 验证
  │  9110 空闲 → 正确判断 deploy.sh 动态读端口无需改 → 回复含影响范围表述
  ├ 文件终态：config=9110 / README=9110 / 8085 零残留（L2 全判据达成）
  ├ commit 3c72fcd
  └ ⚠ 归因：PD 未激活任何新原则；USER.md 存在逐字对应指令（"来源：2026-09-19
     photo-service 超时 30→120 时漏改 deploy.sh 配对探活窗口"）→ 行为变化的充分
     解释是宿主记忆，PD 内化贡献不可分离、不可主张（预案四降级）
```

Pain ID：`pain_host_a30c660f90e6a06a117075f34bb950969ad08f0a487a56cac3f0df40274acd7b`
候选 ID：`3bf1ebf9-bcb6-4020-9a8a-576985d0fea8`、`676b7b55-4686-44b5-b992-1b6d49f9ec26`
账本条目：`18ba6e6d-61aa-4adc-ab2e-efd95c384fc1`、`7e1c2798-1d10-4957-94f1-3a651864aee0`
激活 ID：**不存在**（MISSING，不补造）

---

# Journey Map

| 阶段 | 状态 | 证据 |
|---|---|---|
| 首次使用 | ⚠ 可导航、定位清晰，但信息过载 | 首屏同时呈现 2 待审批+3 停滞+数据质量降级+按钮锁定（no_auth 下"接受/拒绝"禁用），新用户第一眼可能以为系统坏了 → shot1 |
| 任务执行 | ✅ 真实偏差如期诱发 | config=120/deploy.sh=30；agent 有检索但未建立配对推断（预案二路径） |
| Pain | ⚠ 最终捕获，但对用户不可见、迟到 38 分钟 | `pd pain list` 01:17:38 新条目；10 分钟窗 MISSING（截图对比 shot2）；需通道修复+补一发自然消息 |
| Principle | ✗ 语义偏移 + 管道停摆 | 候选文本与纠正语义不符；「治理证据不完整」「规范血缘尚不可用」「当前不需要拥有者决策」→ shot3 |
| Activation | ✗ 未发生 | 生效情况页仍只有既有原则（Model-Evidence-RV Loop）→ shot4；新候选无激活路径 |
| 第二次任务 | ✅ L2 行为（不可归因 PD） | 文件终态 + agent 回复 + USER.md 指令；新会话、无新激活 |

---

# Reality Gaps

## UX Gap（有能力，用户无法理解/感知）
- 纠正发生时**零即时反馈**：用户不知道 PD 是否"听到了"。捕获成功 1 小时后用户仍无从得知。
- 候选详情把生触发正则直接给用户看（适用场景：`(重启|restart).*(服务|service)|建议重启`）；Console 自己都提示"标题似乎是技术模式"。
- 「形成依据：该原则由历史行为校准沉淀而来，**详细来源尚未关联**」——Owner 看不到"这条原则来自我哪次纠正"，治理信任链断裂（与 pain_13 血缘断裂告警同族）。
- no_auth 首屏锁定决策按钮的提示文案偏工程向，第一眼观感像故障。

## Connection Gap（能力存在，链路断开）
- **分类器死通道**：三个内部代理 profile 指向已死本地代理，纠正观察器每周期静默失败（只有日志 WARN，无用户可见告警、无 signal-health 升级）。
- **内化消费器停摆**：`consumerStatus=manual_action_required`，积压 18 天，产品恢复方式=Owner 手工 run-once 且无法定向（只能 FIFO 排空陈旧任务）。
- **候选→dreamer 阶段无推进**：diagnosis 55 秒跑完（说明通道健康时管线很快），但后续阶段依赖一个已停摆的消费器。
- 每周期 "Dispatching with **0 trajectory events**"（重启后轨迹事件恒为 0，观察器退化为只读 recent messages）——PRI-824 家族症状再现，如实记录。

## Capability Gap（真正缺能力）
- **形成语义保真度**：蒸馏器从整个会话窗口抓取"最近/最像教训的片段"，没有机制保证"Owner 纠正句"是第一输入。这不是连接问题，是形成质量能力缺口。

## Wrong Assumption（产品假设错误）
- **假设"H1：用户知道发生了什么"** ——实测不成立。捕获是后台批处理（15 分钟周期 + 需要后续回合触发），用户视角等同于"没有发生"。
- **假设"PD 的价值=让 Agent 记住教训"** ——宿主 OpenClaw 的 USER.md 机制在本次实验中**即时、逐字、带来源**地完成了同样的事，并且直接驱动了第二任务的 L2 行为。PD 在"记住"这个赛道上是更慢、更失真的实现。PD 的不可替代性只能在治理面（Owner 可见/可审/可撤销/跨宿主/质量门）。

---

# 归因边界（必须与结论同读）

1. **基线混杂**：工作区存在既有激活原则（每轮注入，14 天 490 次在场），任务 1 中 agent 已表现出"先验证再改"的部分行为（读了 server.py）。基线不是白纸。
2. **竞争机制**：USER.md 指令（agent 自己在纠正回合写入）是第二任务行为的最强解释。PD 管线即便激活成功，也需与它竞争归因。
3. **Agent 自述不可靠**：agent 两次自称"应用了你的原则「Model-Evidence-Reversibility-Verification Loop」"，但该原则内容（证据-修改-可逆-验证环）并不直接包含"搜引用"行为；Console 自己也声明"智能体自述为概率性自报"。自述≠因果。
4. **环境修复在案**：通道修复发生在 H1 窗口判定之后（修复前三个周期失败为独立事实）；runtime 升级与 profile 切换均为 Owner 指示/授权的最小配置动作，留有前后快照。
5. n=1 单次观察，全部结论是观察性的，无统计归因。

---

# Recommended Next Action（仅修复 / 验证 / 暂停）

**修复（P1）**
1. 内化消费器：`manual_action_required` 常态化 = 管线事实死亡。需要可定向的恢复路径（按 pain-id/task-id 驱动），而不是 FIFO 排空 18 天积压。
2. 内部代理通道健康：死端点应升级为用户可见告警（Console 控制中心红条 / signal-health 面板），不能只是每 15 分钟一条日志 WARN。

**修复（P2）**
3. 形成语义保真度：蒸馏输入必须以"Owner 纠正句"为锚（纠正证据在 pain event 里已存在），候选强制回链 Pain（消除"详细来源尚未关联"）。
4. 捕获时效与可见性：捕获成功的用户可见反馈（哪怕一行"已记录本次纠正"），以及"需要下一回合才触发"这一机制的显式化。

**验证**
5. 上述修复落地后，原样复跑本场景（`scenario-design.md` 可直接复用，含判定表与预案）。H2/H3 的验收即复跑通过。

**暂停**
6. 在 H2 语义保真度修复前，不建议扩大任何 MVP 范围或接入更多宿主——当前管线会把错误教训制度化为行为约束（本次的"重启验证"规则若被批准即是实例）。

---

# What NOT to Build

发现问题后，以下系统**不应该**被创建：

1. **新 onboarding 系统**——首屏问题是文案与信息密度，不是缺系统。
2. **新记忆/学习引擎**——宿主 USER.md 已覆盖"跨会话记住"；PD 再建一个就是第二轮重复造轮子。
3. **新 Dashboard / 评分系统**——现有生效情况页的 Effect/Presence 两级语义已经够用且诚实。
4. **新捕获通道**——现有通道能工作（修复后即捕获成功），问题在通道健康与时序，不在缺通道。
5. **为语义漂移新建 LLM 评审系统**——先修血缘关联与蒸馏输入锚定；在那之前任何评审层都在给错误输入加_quality gate_。
6. **把"重启验证"这类低质候选自动升级为规则的任何机制**——本次它们未被激活是 Owner 门守住了，不是管线筛选住了。

---

# 完成标准问答（spec Completion Criteria）

1. **新用户是否能自然产生 Pain？** 机制上最终能；体验上否——38 分钟延迟 + 需要修复死通道 + 需要多一发消息，且全程零用户可见反馈。
2. **Pain 是否能形成 Principle？** 形成了候选，但不是用户教的那条；且卡死在 Owner 不可决策的状态。实质为否。
3. **Activation 是否被用户理解？** 新原则未到达激活。激活页面本身（基线原则）的呈现质量好：Effect/Presence 两级语义、"参与决策 ≠ 已改变行为"的诚实声明。
4. **用户是否能感知 Agent 改变？** 能——但归因是宿主 USER.md，不是 PD。用户感知到的"学会了"与 PD 无关。
5. **最大阻塞是什么？** 内化管道消费器停摆（manual_action_required + 18 天积压）叠加形成语义保真度缺失；as-found 环境里还叠加分类器死通道（已修复留痕）。

---

# Owner Review Card

```text
1. Environment
   main 6c2fa480 → 官方安装器部署 live（generation 16）；OpenClaw 2026.9.4；
   ZAI glm-5.3 双密钥均验证有效；三处环境修复全程留痕（runtime 升级、
   3 个内部代理 profile ninfer→glm【有备份】、认证 console 实例）。

2. Scenario
   Scenario A「先看清，再动手」：photo-service 沙盒，配对值隐藏约束
   （config.json ↔ deploy.sh / README.md），真实 OpenClaw 对话 4 轮 + 新会话对照。

3. H1 Result
   PARTIAL——最终捕获（pain_host_a30c660f…，score=70），但迟 38 分钟、
   修复前 3 个周期全部死于死通道、需用户补一发自然消息才触发；当下零反馈。

4. H2 Result
   FAIL——双候选语义均非所教教训（来自收尾闲聊）；dreamer 停摆；
   「当前不需要拥有者决策」；血缘断裂（"详细来源尚未关联"）。

5. H3 Result
   NOT ESTABLISHED——L2 行为变化真实发生（新会话、零残留、边界判断正确），
   但充分解释是宿主 USER.md；PD 无激活，不可归因。

6. Evidence Chain
   Task→S1→纠正→(38min)→Pain(pain_host_a30c660f…)→Diagnosis(55s)→
   Candidates(3bf1ebf9/676b7b55，语义偏移)→Activation(MISSING)→
   Second Task(L2，归因 USER.md)。逐段见正文证据链。

7. Biggest Reality Gap
   定位级：宿主记忆机制已即时+保真地"让 agent 记住"，PD 在该赛道无优势；
   工程级：内化消费器停摆使治理闭环的后半程（候选→决策→激活）事实不可达。

8. Recommended Action
   修复：消费器可定向恢复 + 通道健康用户可见告警（P1）；
   蒸馏以纠正句为锚 + 候选强制回链 Pain（P2）。
   验证：复跑本场景（设计文档可复用）。暂停：语义保真修复前不扩 MVP。

9. What NOT to Build
   onboarding 系统 / 记忆引擎 / 新 Dashboard / 新捕获通道 /
   语义评审层 / 候选自动升级机制——全部不该建，理由见正文。
```

---

---

# 附：H2/H3 失败的表层与根本原因深挖（2026-09-19 Owner 追加调查）

> 全部结论基于：仓库源码（main 6c2fa480）+ live state.db 只读查询（artifacts/candidates/配置备份序列）+ 网关日志时间线。每个断点给出三层：表层现象 → 机制根因 → 设计层根因。

## H2 形成失败 = 四条独立断裂的叠加

### 断裂① 证据锚定（语义漂移的真正根源）

**表层**：候选提炼出"重启验证"而非"搜引用"。

**机制根因（逐环实证）**：
1. 纠正句（第 2 回合"漏改了/别只改眼前"）与 16 个种子纠正词（`correction-types.ts` CORRECTION_SEED_KEYWORDS：不是这个/不对/错了/搞错了/理解错了/你理解错了/重新来/再试一次 + 8 英文）**零匹配**——"漏改了"不含"错了"二字序列 → L1 词典层沉默，第 2 回合无 Pain。
2. L3 语义层本可兜底（detection-funnel-policy：L1 词典→L2 缓存→L3 异步 LLM），但当时分类器通道已死（ninfer→8081 ECONNREFUSED）→ L3 也不可用。
3. 第 3 回合（"不用重启，服务我没在跑"）L3 首次存活，Pain 触发——但证据载荷=**触发回合前 400 字符**：`signal-collector-host.ts:370 excerpt: pending.text.slice(0, 400)`；分类器也只看这 400 字符（`:417 classifier(item.excerpt, '')`）；证据 note 只存这 400 字符（`:525 {sourceRef:'signal_collector', note: excerpt}`）。
4. 诊断工件（artifacts 表 9900e422）实证：evidence 数组仅 2 条、全部引用第 3 回合；rootCause="Assumption: AI 假设服务正在运行并据此建议重启…"；summary 甚至写着"遭用户纠正"——**模型忠实地蒸馏了它唯一看到的东西，LLM 无罪**。

**设计层根因**：Pain 证据模型把"触发回合片段"（400 字符 excerpt）当作证据本体，"Owner 纠正语句"不是一等证据。最讽刺的事实：纠正观察器在 Pain 产生前 3 分钟（01:14 周期日志 "One real correction: '漏改了/别只改眼前' style accountability phrasing"）**已在同一会话正确识别出真正的纠正**，但该路径的产出只是关键词 cue——与 Pain 证据载荷零连通。**观察器知道教训是什么，诊断器只看到碎片：同一公司两个子系统之间的信息断裂。**

### 断裂② 消费器停摆

**表层**：dreamer 永远 pending；Pain 卡片说"wait for dreamer to complete"。

**机制根因**：配置备份序列实锤 `internalization_auto_consumer` 于 **09-13（true）→ 09-14（false）** 被关闭，`source: owner`（与 09-12"auto-consumer 抢跑烧尝试"事故吻合——一次合理的紧急熄火）。`runtime-internalization-queue.ts` 逻辑：flag=false 且有 ready 任务 ⇒ `manual_action_required`；唯一恢复路径 run-once 是 FIFO（wake-once 实证下一个租约是 09-01 的陈旧任务），**无按 pain/task 定向驱动**。

**设计层根因**：紧急熄火从未复盘；产品没有"管线已暂停"的用户可见面——Pain 卡片文案硬编码，不读 flag，**管线已死而 UI 仍在承诺"等待中"**。

### 断裂③ Owner 权力自锁

**表层**：候选详情"当前不需要拥有者决策"，想拒绝都拒绝不了。

**机制根因**：Owner 决策动作以内化生命周期走完为前提（pd-console validators 的 `internalization-pending` 状态无决策动作）。

**设计层根因**：**消费器停摆 ⇒ 生命周期冻结 ⇒ Owner 否决权永久不可达。** 治理系统里 Owner 的最终权力，依赖一个被 Owner 自己关掉的批处理消费者——系统性自锁，这是本次实验最深刻的结构性发现。

### 断裂④ 血缘无家

**表层**："详细来源尚未关联"/"规范血缘尚不可用"；pain_13 同族告警早已在案。

**机制根因**：`principle_candidates` 表 **没有 pain_id 列**——与 Pain 的关联只存在于 task_id 字符串约定（`diag_router-diagnosis_pain_host_<id>`）中；`pain_diagnoses` 持久化 flag 关闭（表为空），诊断证据只存在于 artifacts。

**设计层根因**：血缘是字符串约定而非外键。Console 显示"未关联"是结构性必然，不是数据丢失。

## H3 归因失败 = 机制竞争 + 设计盲区

**表层**：新会话 L2 行为，agent 引用"全局引用规则"。

**机制根因**：USER.md 是 **OpenClaw 原生 bootstrap 文件**（openclaw dist 中 `WORKSPACE_BOOTSTRAP_FILENAMES = ["AGENTS.md","SOUL.md","IDENTITY.md","USER.md","BOOTSTRAP.md","MEMORY.md"]`，USER.md 有独立 bootstrap 预算），每个新会话注入 agent 上下文。纠正后 ~90 秒 agent 自行写入规则（commit d6a5a9b），第二次任务直接驱动 L2 行为——速度 30 秒 vs PD 管线 38 分钟，保真度逐字 vs 400 字符碎片。

**设计层根因**：**PD 全部源码对 USER.md 零引用**。PD 的捕获-内化模型假设自己是行为改变的唯一通道：Pain 记录不知道"这条纠正已被写进宿主记忆"，没有感知、协调、去重或治理挂载。**真正的行为突变点（USER.md 写入）完全发生在治理视野之外**——无 Owner 审批、无撤销面、无审计痕迹（除 git）、无与 PD 候选的去重。

## 定位级结论

PD 的"捕获→内化→激活"管线与宿主原生记忆正面竞争"让 agent 记住"这个任务，并在速度与保真度上双双落败；同时行为突变点在治理视野之外。这不是 bug 集合，是**产品边界假设过时**：宿主已原生解决"记住"，PD 的不可替代价值只剩治理面——Owner 可见、可审、可撤销、质量门、跨宿主。修复方向（供决策，不自动开工）：① Pain 证据一等化（纠正句为锚、全窗口上下文、观察器与实时通道证据合并）；② 消费器定向恢复 + flag 状态用户可见；③ 血缘外键化；④ 宿主记忆感知（捕获时检测"已写入宿主记忆"并将宿主记忆写入本身纳入治理对象）。



1. 首次 Console 页面：`pri768-assets/shot1-console-first-impression.png`
2. Pain 出现位置（01:17 新条目 + 被蒸馏错的"结论"）：`pri768-assets/shot2-pain-entry-present.png`
3. Principle 页面（候选详情：语义偏移 + 决策锁定 + 血缘断裂）：`pri768-assets/shot3-principle-candidate-detail.png`
4. Activation 页面（仅存基线原则；新候选无激活）：`pri768-assets/shot4-activation-baseline.png`
5. 第二次任务结果：结果面是 agent 对话与文件终态而非 PD UI，以文本证据呈现（`pd-labs/.../evidence/s2-turn1-task2-agent-reply.txt` + config/README=9110、8085 零残留、commit 3c72fcd），不另造截图。

# 证据文件清单

`D:\pd-labs\pri768-golden-journey-v4\`：
`scenario-design.md`（设计）、`evidence/s1-turn1-agent-reply.txt`、`evidence/s1-turn2-correction-agent-reply.txt`、`evidence/s1-turn3-closeout-agent-reply.txt`、`evidence/s2-turn1-task2-agent-reply.txt`、`evidence/s2-turn2-phase2-agent-reply.txt`、`evidence/pain-list-cli.txt`、`evidence/USER.md.after-correction`、`evidence/config.yaml.before-20260919-0108`（修复前配置备份）、`sandbox-backups/t0|t4-after-correction|t8-final/`（沙盒三时点快照）、`console-token.txt`（本实验 console 令牌）、`release-build/`（本次部署的 release 资产）。
