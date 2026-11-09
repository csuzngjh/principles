# PRI-1140 离线比较结果：钉死映射 vs 原则身份映射（17 例，一轮）

日期：2026-11-09 · 实现提交 `3c7d4ef9a` · 原始报告 `pri-1140-replay-report-20261109.json`（sha256 `ce3971d946485fb81a0d9d5204c86bc81357153b59ef34224cdea9fec5b010a6`）· 真实模型调用 0 · 生产启用 0

**git-7 复验（2026-11-09）**：main 前移至 `1dd3b8e87`（含同包 #2427）。merge 无冲突；实现源文件在 merge 前后字节一致；定向 AA 套件 111/111 通过；重放在合并后 HEAD 复跑，18 个回合与获批轮次的报告逐项一致（`.tmp/pri-1140/replay-merged/`）。

**决定：保留候选，供接入评审。** 结论只覆盖换版后的干预连续性（Owner 补充条件 #9），不主张行为改善或覆盖扩张。

## 1. 方法

- **两臂**：Native 臂 = 现行钉死映射 `(artifactId, activationId)`；候选臂 = `principleId` 映射（每请求解析 + additive-only 装配）。两臂调用同一个真实 provider `resolveAdaptivePriorityForHook`（插件 dist）和同一个共享装配入口 `buildActivePrinciplePromptContext`（host-runtime dist）。provider 到装配入口的字段转发与 `host-runtime/src/index.ts` 逐项一致。夹具库通过真实 `SqliteConnection` / `SqliteActivationStateStore` 写入，修订形态与生产的 prompt-replacement 流程一致（旧激活停用，新 artifact 和新激活共用同一 principleId）。
- **对照基线**：每回合另算一次无映射的普通 Native（同一 roundKey 与预算）。
- **计量**：判定货币为字符数（生产预算单位 `budgetChars`）。Token 只报 `floor(chars/4)` 粗估；夹具正文以中文为主，该估算会**偏低**，仅供参考。耗时用 `process.hrtime.bigint()` 墙钟：先丢弃 2 次预热，再测 15 次取中位数。provider 耗时含候选臂的解析读取，builder 耗时为装配入口本身。
- **覆盖口径**：最终正文是否完整包含当前版次目标的 `<directive>` 切片。
- **失败判据**（自动检查）：未授权注入（出现旧版次正文，或装配了非现行激活）、必需内容丢失（候选臂缺少普通 Native 已装配的激活）、新增内容超出目标、相对普通 Native 的关键机会退化。
- **运行记录**：第 1 次运行无效。夹具映射漏写 `workspaceDir`，被配置读取器按设计静默拒绝，两臂都输出 `none`。这是 harness 接线错误，不是比较结果；已修正，并加了完整性断言：哨兵轮的钉死臂必须拿到优先级，否则直接报错。第 2 次是首个有效比较。第 3 次只为在报告中加入授权事实字段，18 个回合的文本哈希、状态、原因、roundKey 和预算与第 2 次逐项一致。

## 2. 汇总

| 维度 | 结果 |
|---|---|
| 覆盖范围 | 17 例 = 16 个夹具例（C1、C2 各两个回合，共 18 回合）+ F1 重放确定性 |
| 失败判据 | 18 个回合**全部为否**：没有未授权注入、没有必需内容丢失、没有超出目标的新增、相对普通 Native 没有关键机会退化 |
| 候选臂最终正文 | **18/18 回合与普通 Native 逐字节一致**（字符差 0） |
| 与钉死臂的字符差 | 15 回合为 0；A7 +237（钉死臂多剔除了目标）；A8、D2 各 +186（钉死臂为放入目标挤出了原有内容，候选臂不挤出） |
| 解析开销（交付信号轮） | provider 中位数增加 +1.5 至 +4.3 ms（一次只读 SQLite 读取） |
| 非目标轮（B1/B2/C1#0/C2#1/E1/E2） | 增量 −0.002 至 +0.003 ms，属于噪声。provider 在信号门处返回，**没有新增读取** |
| 确定性 | 每臂 15 次迭代输出一致；F1：A4、A8 各重放 3 次，输出逐字节一致；全部回合 state.db 哈希不变（只读） |
| 授权核对 | 能解析的 13 例都解析到当前版次 `act-delivery-v2`，authority=`owner`，approvedBy=`owner-replay`。不能解析的 3 例给出结构化拒绝原因（见 §3） |

## 3. 逐例结果

字段说明：「钉死臂」「候选臂」列为装配结果的 `状态:原因`，括号内为最终字符数，`cov` 表示当前版次目标是否在最终正文中。

| 例 | 类目 | 普通 Native | 钉死臂 | 候选臂 | Δ（候选−钉死） | 解析开销 |
|---|---|---|---|---|---|---|
| A1 | 交付 | 2191c，cov | `target_present`（2191，cov） | `target_present`（2191，cov） | 0 | +1.69 ms |
| A2 | 交付/目标已存在 | 2191c，cov | `target_present`（2191，cov） | `target_present`（2191，cov） | 0 | +1.70 ms |
| A3 | 交付/修订后·预算充足 | 2191c，cov | **`target_unavailable`**（2191，cov 只是顺带） | **`target_present`**（2191，cov；owner 核对通过） | 0 | +1.85 ms |
| A4 | 交付/修订后·预算紧张 | 1954c，无 | **`target_unavailable`**（1954，无） | **`would_displace_native_assembly`**（1954，无；将挤出 O6、O1） | 0 | +1.87 ms |
| A5 | 交付/原则下线 | 1954c，无 | `target_unavailable`（1954） | 拒绝：`principle_not_currently_authorized`（1954） | 0 | +1.51 ms |
| A6 | 交付/同原则双现行 | 2406c（双版次，覆盖口径不适用） | `target_ambiguous`（2406） | 拒绝：`ambiguous_current_activations`（2406） | 0 | +1.55 ms |
| A7 | 交付/读取降级 | 2191c，cov | `authority_unavailable`（**1954，目标被剔除**） | 拒绝：`candidates_unavailable`（2191，cov = 普通 Native） | +237 | +1.57 ms |
| A8 | 预算不足反例（Owner 新增） | 1954c，无 | `prioritized`（1768，cov；**挤出 O6、O1**） | **`would_displace_native_assembly`**（1954，原 Native 保留） | +186 | +1.60 ms |
| B1 | 普通执行 | 2191c | 无优先级 | 无优先级 | 0 | 0 |
| B2 | 标记在非首行 | 2191c | 无优先级 | 无优先级 | 0 | 0 |
| C1#0 / #1 | 实现→验收 | 2191c | 无 / `target_present` | 无 / `target_present` | 0 / 0 | 0 / +1.78 ms |
| C2#0 / #1 | 验收→实现 | 2191c | `target_present` / 无 | `target_present` / 无 | 0 / 0 | +4.27 ms / 0 |
| D1 | 目标超大 | 1954c | `target_does_not_fit` | `target_does_not_fit` | 0 | +3.68 ms |
| D2 | 需挤出才能放入 | 1954c，无 | `prioritized`（1768，cov；挤出 O6、O1） | `would_displace_native_assembly`（1954） | +186 | +3.75 ms |
| E1 | 自然语言交付请求 | 2191c | 无优先级 | 无优先级 | 0 | 0 |
| E2 | agent-to-agent | 2191c | 无优先级 | 无优先级 | 0 | 0 |

Token 粗估：2191c ≈ 547，1954c ≈ 488，1768c ≈ 442。builder 耗时中位数在 1.6 至 11.4 ms 之间，两臂没有系统性差异。候选臂提前回退或被门槛拒绝时，还会跳过重验读取，例如 D2 为 6.8 ms，钉死臂为 11.4 ms。

## 4. Owner 补充条件逐项核对

1. **换版后仍能装配唯一、当前已授权版本，无需手工改映射**：A3 中钉死映射判 `target_unavailable`；原则映射恢复映射解析和授权记录（解析到 v2，owner 授权复核通过，`target_present`），正文原本就包含新版（两臂文本一致，新版是作为普通候选进入 Native 的）。A1、A2、C1、C2 中两臂都正常。
2. **保留旧固定 ID 路径与受控准入语义**：钉死臂在 A6、A7、A8、D2 的行为与改动前一致，包括 A8、D2 的挤出语义。特征化测试全绿；受控准入分支未改动，并对 principleId 映射失败关闭（单测覆盖）。
3. **需要挤出原 Native 内容时保留原 Native 并记录原因**：A4、A8、D2 都判 `would_displace_native_assembly`，将被挤出的激活集合 `[act-O6-small, act-O1-scope]` 已记录，最终正文就是原 Native。
4. **预算不足反例**：已补 A8。同一夹具下，钉死臂按旧语义挤出，候选臂零位移，两种结果并列给出。
5. **选中后被撤销或替换时本轮回退、下轮重新解析**：由单测与真实链路测试覆盖，不在本重放内。验证点：解析之后停用目标，本轮判 `target_unavailable` 并回退 Native；再次解析得到新状态；终验失效判 `target_changed` 并剔除目标；重复回调时解析结果已被消费，不会再次应用优先级。
6. **真实装配链回归**：插件链路测试走 provider → 共享装配 → hook → journal，新增 5 例；本重放直接调用真实 provider 和真实装配入口。
7. **A4 的三项核对**：A4 中旧映射失效（`target_unavailable`）。新映射经同一装配链解析出唯一现行版次，授权复核通过（流程走到 additive 门槛，说明二次读取、授权漂移检查和正文检查都已通过；解析事实为 owner），然后按条件 #3 保留原 Native 并记录原因。结论：预算不足、目标未装配。非目标轮零开销（B、C、E 组）。旧路径兼容（见 #2）。
8. **字符变化与解析开销**：见 §2、§3。
9. **结论边界**：见 §5。

## 5. 诚实边界与派生事实

- **A3 与 A4 的结论口径。** A3：恢复映射解析和授权记录，正文原本就包含新版。A4：预算不足、目标未装配——在现行 greedy fair-rotation 下，目标因预算被基线落下，说明扫到它时剩余头寸已经小于它的成本；之后头寸只减不增，把它加回去必然挤出原有内容，按条件 #3 只能保留原 Native 并记录将被挤出的集合。
- **本轮候选没有改变任何最终正文**（相对普通 Native，18/18 一致）。它的作用有两点：让交付干预在治理修订后继续可用并留证据；不挤出原有内容。这是 Owner 条件的直接结果，不算缺陷。冻结 17 例都是 fair-rotation 轮；round key 不可用时（legacy FIFO，首个装不下即停），additive 门槛可以在不挤出的前提下加入目标，收口回归用这一点构造了可观察差异（见 §7）。如果以后要在预算紧张时真正提高覆盖，需要另行决定是否允许挤出有明确依据的可选内容。本票不做。
- **没有发现需要模型辅助的可复现语义缺口。** E1（不带标记的自然语言交付请求）按场景卡与 C01 有意保持 Native，属于信号边界，不是选择缺口。因此不向单模型或两阶段比较移交反例。
- 夹具为 fixture，不计入 L2。没有真实宿主运行，没有送达确认（D=unknown），G1/C04/G2 保持原状态。

## 6. 复现

```bash
npm run build -w @principles/host-runtime && npm run build -w principles-disciple
node scripts/dev/aa-selector/pri1140-replay.mjs --out .tmp/pri-1140/replay --commit <sha> --iterations 15
```

夹具全部写在 `--out` 目录下的临时工作区，不触碰生产工作区。harness sha256：`0f4730aa20286fd51dae2a9d7b3040d1cd92095be33ff7e78d6d188fa4319f07`。

## 7. 收口（Owner 2026-11-09）

- **Hook 重读配置后核对 principleId**（提交 `8acfdff38`）：principleId 映射只有在当前 principleId 等于本轮 provider 解析结果的 principleId 时，才保留本轮优先装配；不一致时丢弃优先装配，回到 Native。终态记录仍归原 invocation 和原目标，原因记为 `adaptive_mapping_changed`；下一轮按当前映射重新解析。解析记忆无论当前映射形态都只消费一次；钉死路径与受控准入不变。
- **新增真实链路回归**（provider → 共享装配 → Hook）：provider 解析 A，Hook 前把配置改为 B，A 仍有效授权；在 legacy FIFO 下 A 的 additive 装配加入了目标，与 Native 有可观察差异。断言：本轮最终正文严格等于 Native；journal 终态记录归原 invocation 和 A，`selection=unavailable`、`payload=none`、`addedTarget=false`，不记为优先装配成功；下一轮解析到 B。
- **正向对照**：临时撤掉核对后，该回归在「最终正文严格等于 Native」处变红；恢复后定向套件 112/112。冻结案例重放在收口后复跑，18 个回合与获批轮次逐项一致（重放只覆盖 provider 与共享装配，不经过 Hook 改动）。
