# PRI-1105 B 线冻结案例与事前标注 v0.1

状态：**已冻结（2026-11-09，候选实现与任何候选运行之前）**
归属：PRI-1105 B 线（Linear 额度已满，暂在总单跟踪）。实施卡：`PD-AA-PRI-1105-B-TRIM-IMPLEMENTATION-CARD-v0.1.md`。
性质：离线重放的评价输入。零模型调用，零宿主运行；fixture 不计 L2；不证明行为改善。

## 0. 冻结纪律

1. 本文件写在候选实现之前。各列只依据当前 `main`（`8a791cfcf`）的 Native 输出和实施卡规则 R-SP-1 推算，不含候选输出。
2. 每例先写**必保**（目标、必需、Owner 批准、授权未知），再写**可省**（R-SP-1 命中）。候选结果出来后不得回改本文件，差异写入独立结果文件。
3. Native 列由 `scripts/dev/aa-selector/pri1105b-trim-replay.mjs`（仅 Native 臂）产出，原始数据：`docs/implementation-reports/pri-1105-b-baseline-report-20261109.json`。两种映射均走真实 provider 和真实共享装配入口。
4. 真实样本来自本机真实 OpenClaw 工作区 `state.db` 的只读副本（源文件哈希前后一致）。提交件只含哈希、计数和字符数，不含原则正文。

## 1. 规则与标注口径

- **R-SP-1**（唯一规则）：交付信号轮中，当交付目标已在最终装配内（`target_present` 或 `prioritized`）时，`authority="system_policy"` 的**普通**指令可省。目标、`mandatoryPrincipleIds`、`authority="owner"` 以及授权未知的指令一律必保。其余任何状态都不省。
- **关键机会**：交付轮的首次对外验收宣告（沿用 PRI-1140 场景卡）。非交付轮没有关键机会，按原 Native 处理。
- **预测候选字符** = Native 字符 − 可省块字符。装配是逐块加和（`render(S) = base + Σ block`），所以这个差值应当逐字节精确，B1 判定线核对的就是它。
- 计量：字符（`budgetChars` 口径）为主；Token 为**未知**（仓库没有可靠的中英混排 tokenizer）。

## 2. 案例

### 2.1 R 组：真实样本（18 条现行激活：14 owner / 4 system_policy；目标为 owner 批准的交付自检原则，哈希 `871d0283b206`）

格式：`状态 · Native 字符 · 必保数(owner/sp) · 可省数/字符 → 预测候选字符`。present = `target_present`；would_displace = PRI-1140 additive 门槛回退。

| 轮次 | principleId 映射（PRI-1140 路径） | 钉死映射 |
|---|---|---|
| 4000-k1 | present · 3685 · 4(4o/0sp) · 3/1142 → 2543（−31.0%） | 同左 |
| 4000-k2 | present · 3996 · 6(6o/0sp) · 2/737 → 3259（−18.4%） | 同左 |
| 4000-k3 | present · 3686 · 6(6o/0sp) · 1/329 → 3357（−8.9%） | 同左 |
| 4000-k4 | present · 3729 · 6(6o/0sp) · 1/329 → 3400（−8.8%） | 同左 |
| 4000-k5、k6 | present · 3793 / 3705 · 7(7o) · 0（无可省项） | 同左 |
| 4000-k7…k13 | would_displace · 3688–3871 · 不适用 · 0 | prioritized · 3705–3965 · 0 |
| 4000-k14 | would_displace · 3706 · 不适用 · 0 | prioritized · 3781 · 4(4o) · 1/390 → 3391（−10.3%） |
| 4000-k15 | would_displace · 3921 · 不适用 · 0 | prioritized · 3994 · 4(4o) · 3/1203 → 2791（−30.1%） |
| 4000-k16 | would_displace · 3835 · 不适用 · 0 | prioritized · 3896 · 4(4o) · 3/1203 → 2693（−30.9%） |
| 4000-k17 | would_displace · 3967 · 不适用 · 0 | prioritized · 3893 · 3(3o) · 4/1532 → 2361（−39.4%） |
| 4000-k18 | present · 3984 · 4(4o) · 4/1532 → 2452（−38.5%） | 同左 |
| 4000-FIFO（无轮次键） | present · 3652 · 3(3o) · 4/1532 → 2120（−41.9%） | 同左 |
| 15625-k1（模型感知预算） | present · 9208 · 14(14o) · 4/1532 → 7676（−16.6%） | 同左 |
| 4000-k1 普通轮（无标记） | provider 不返回 · 3685 · 全部必保 · 0 | — |

汇总（预测，非候选运行结果）：principleId 路径 20 个交付轮中，规则适用 9 轮，其中 7 轮有可省项；Σ可省 / ΣNative = 7133 / 81364 = **8.77%**。钉死路径 20 轮中 11 轮有可省项，合计 **14.03%**。全部回合 15 次迭代输出一致，副本 `state.db` 哈希不变。

### 2.2 FX 组：合成反例与正例（fixture；`O3-tests`、`O5-ask` 无批准行 → system_policy）

| 例 | 场景 | 映射/预算 | Native | 必保 | 可省（预测字符） |
|---|---|---|---|---|---|
| FX-1 | **正例**：目标在场，普通 sp 在装配内 | principle / 充足 | present · 2191 | 目标+O1/O2/O4/O6 | O3、O5（471） |
| FX-2 | 目标本身是 sp | 钉死 / 充足 | present · 2199 | **目标**+O1/O2/O4/O6 | O3、O5（471） |
| FX-3 | 必需项是 sp（builder 级 `mandatoryPrincipleIds=[O3]`） | 钉死 / 充足 | present · 2191 | 目标+**O3**+O1/O2/O4/O6 | O5（253） |
| FX-4 | 读取降级（损坏 artifact，资格无法核实） | principle / 充足 | provider 拒绝 · 2191 | 全部 | — |
| FX-5 | 预算不足，additive 回退 | principle / 紧 | would_displace · 1954 | 全部 | — |
| FX-6 | 预算不足，钉死路径既有挤出后再判 | 钉死 / 紧 | prioritized · 1768（挤出 O6、O1） | 目标+O2/O4 | O3、O5（471） |
| FX-7 | 普通轮次（无交付标记） | principle / 充足 | provider 不返回 · 2191 | 全部 | — |
| FX-8 | 无可省项（全部 Owner 批准） | principle / 充足 | present · 2175 | 全部 | —（none_eligible） |
| FX-9 | 候选失效：目标已下线 | principle / 充足 | provider 拒绝 · 1954 | 全部 | — |

### 2.3 E 组：已有案例

- PRI-1140 冻结 17 例（含 F1 重放）：在**开关缺省**下重跑 `pri1140-replay.mjs`，18 个回合须与获批报告逐项一致（回归判定）。该夹具同样以 O3、O5 为 system_policy。
- `PD-AA-EVAL-CASES-DRAFT-v0.1.md` 的 F-01…F-08 是行为层案例，不在装配重放能判定的范围内。

### 2.4 T 组：生产链与失败回退（实施后由 vitest 证明，非重放）

T1 provider → 共享装配 → Hook：最终 `prependSystemContext` 中的指令段等于 Native 去掉可省块；journal 闭合记录写明省略集合与规则。T2 Hook 终验失败（目标正文不全、重验失效、截止、超预算）→ 使用现有回退文本，该文本取自**未裁剪**的 `nativeBaseline`（Native 去目标，或超预算时为完整 Native），不保留任何省略。T3 映射中途更换 → Native。T4 受控准入分支 → 不裁剪。T5 开关字段不是布尔值 → 映射无效 → Native。T6 字段缺省 → 与 `main` 逐字节一致。T7 manifest 一致性：`openclaw.plugin.json` 的 `adaptiveActivation` schema 接受布尔值的 `omitSystemPolicyOrdinary`，拒绝非布尔值，与读取器的判定一致（防止配置后插件整体加载失败）。

## 3. 判定线（比较前冻结）

**硬失败（任一命中即 `KEEP_NATIVE`）**：HF1 未授权注入：候选正文出现同输入 Native 正文中没有的指令块。HF2 必需内容丢失：必保指令缺失或被改动。HF3 关键机会退化：Native 中目标完整在场，候选中缺失或不完整。HF4 越界裁剪：在规则不适用的回合（非交付轮、受控准入、目标未在场、读取告警、开关缺省、任何 Hook 回退）发生省略。HF5 同输入重复运行输出不一致。HF6 开关缺省时任一字节变化。HF7 重放改变 `state.db`。

**收益通过线**：B1 每个规则适用且有可省项的回合，候选字符等于 Native 减去可省块字符（逐字节），其余指令块逐字节保留。B2 真实样本 principleId 路径 20 个交付轮合计减少 **≥ 5%**；模型感知预算回合（15625-k1）减少 **≥ 10%**。B3 至少一条生产链测试（T1）证明 Hook 最终输出同样变短。

**开销通过线**：C1 同输入交付轮，候选与 Native 的 builder 墙钟中位数差 **≤ 2 ms**（15 次迭代、2 次预热，交替测量），且**零新增 SQLite 读取**。C2 非交付轮零新增工作，输出逐字节一致。

**决定**：无硬失败且 B1–B3、C1–C2 全部达标 → `KEEP_CANDIDATE`（进入接入评审）。任一硬失败或未达标 → `KEEP_NATIVE`。前置条件失败（构建、harness 或夹具不可用）→ `BLOCKED`，写明 step/code/message/最小下一步。

## 4. 修订记录

- v0.1（2026-11-09）：首版冻结。
- 2026-11-09T13:05Z（候选实现和任何候选运行之前）：T 组新增 T7（manifest 一致性），依据是 A 线 #2448 阻断 2 的同类风险。R、FX、E 组的标注和 §3 判定线均未改动。
