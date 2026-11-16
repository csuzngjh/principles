# DREAMER_V21_OWNER_BLIND_REVIEW_PACKET.md — Owner 盲评材料（Phase 3）

生成：2026-11-15。样本来源：既有 35 个抽检包（本轮逐一核实存在性：35/35 完整，未补齐、未新增）。**本文件不含任何实验组信息**；组别答案键仅存于 `.tmp/prompt-v2-ab/spotcheck/owner-spotcheck-answer-key.local.json`（本地文件，Owner 评分完成前不得打开）。

## 一、材料位置与读取方式

每个抽检包 = `packages.json` 中以 evalId 为键的一个对象，内含：

- `sample`：原始 Pain（含证据 note 全文——全保真，仅本地）；
- `outputA` / `outputB`：同阶段两份产物，**匿名随机排序**（A/B 与实验组无固定对应）；
- `attemptsA/attemptsB`、`completeness`：多工件收集的完整性标注。

读取脚本（可复现）：

```bash
node -e "const p=require('./.tmp/prompt-v2-ab/runs/<runId>/blindpack/packages.json').packages.find(x=>x.evalId==='<evalId>');console.log(JSON.stringify(p,null,1))"
```

## 二、评分维度（Owner 指令 §六/Phase 2 指定的判断标准）

对每个包的 Output-A 与 Output-B 分别回答：

1. **独立机制判断**：候选/产物中哪些是真正不同的纠正机制（不同决策点/触发/行为/证据）？哪些只是换说法？——对照 MECHANISM_DIVERSITY_AUDIT §二的六类定义（Duplicate / Near Duplicate / Complementary / Conflicting / Independent / Insufficient）。
2. **证据忠实性判断**：每个机制的前提是否被 Pain 证据或诊断支持？是否存在无中生有的场景设定（参照 EVIDENCE_FIDELITY_AUDIT §一的 Supported/Partially/Unsupported/Contradicted 分类）？特别标注：合理但未经验证的泛化是否可接受。
3. **最终质量判断**：哪些候选值得进入原则提炼？哪些应直接淘汰？若两份产物都含同一机制的重复表述，标注"重复传播"。

## 三、35 包清单（盲态；顺序即 evalId 字典序，与生成顺序无关）

| # | run | evalId | 阶段 | 样本 | 轮次 |
|---|---|---|---|---|---|
| 1 | grid-3 | 005e22645d67f504 | dreamer | S10 | 2 |
| 2 | grid-3 | 08a33a65c75c67df | rootcause | S14 | 0 |
| 3 | grid-3 | 10318506fccccea8 | rootcause | S14 | 1 |
| 4 | grid-3 | 13c838e9a8ed9823 | philosopher | S16 | 0 |
| 5 | grid-3 | 15204e746f7ca707 | philosopher | S14 | 2 |
| 6 | paired-2 | 1ca1197ba9ef0a92 | dreamer | S07 | 1 |
| 7 | grid-3 | 2328019aa8447e5f | rootcause | S16 | 0 |
| 8 | grid-3 | 270e42581f357faf | router | S15 | 0 |
| 9 | grid-3 | 2dac6f634ed1046c | router | S12 | 2 |
| 10 | grid-3 | 330a2b31c8845b51 | distiller | S03 | 0 |
| 11 | grid-3 | 3a28b9f1e22935fe | rootcause | S07 | 0 |
| 12 | paired-2 | 3f0ca8757d83d31c | scribe | S12 | 1 |
| 13 | grid-3 | 46761708d939db7d | distiller | S10 | 2 |
| 14 | paired-2 | 48912fe607ac925a | dreamer | S09 | 0 |
| 15 | grid-3 | 4f57da84ad893272 | dreamer | S07 | 0 |
| 16 | grid-3 | 59af10bf94bbfa8f | dreamer | S14 | 2 |
| 17 | grid-3 | 5f823a9e7fc76c43 | philosopher | S12 | 2 |
| 18 | paired-2 | 67ee40d6d114b54d | scribe | S05 | 0 |
| 19 | grid-3 | 7209931b0b5998f7 | distiller | S08 | 0 |
| 20 | paired-2 | 75c1843903b058d5 | philosopher | S03 | 0 |
| 21 | grid-3 | 7a7aac442fcdc96d | philosopher | S10 | 1 |
| 22 | grid-3 | 83e7f953259295dc | distiller | S16 | 0 |
| 23 | grid-3 | 865b346acd77f35a | router | S06 | 0 |
| 24 | grid-3 | 8e9fdbbd2df6a755 | distiller | S07 | 2 |
| 25 | grid-3 | 918893affa319685 | rootcause | S04 | 0 |
| 26 | paired-2 | 97bc7c57871f0f1e | dreamer | S02 | 0 |
| 27 | grid-3 | 9e328e150c1c3583 | rootcause | S02 | 0 |
| 28 | paired-2 | a320f0d109233071 | philosopher | S12 | 2 |
| 29 | grid-3 | b1534cc53cc8371d | philosopher | S02 | 0 |
| 30 | grid-3 | b32154623ce2c3f4 | dreamer | S14 | 0 |
| 31 | grid-3 | b74e8794141d21af | rootcause | S12 | 1 |
| 32 | grid-3 | bc9b30d92782808d | distiller | S02 | 0 |
| 33 | grid-3 | bff6f0b62efd0714 | philosopher | S07 | 1 |
| 34 | paired-2 | c4dc2f4a31df001a | scribe | S03 | 0 |
| 35 | grid-3 | c9d01fc532aee4cb | philosopher | S09 | 0 |

（清单由 `owner-spotcheck-list.mjs` 确定性生成并经 35/35 存在性核实；本表为逐行转录。）

## 四、评分记录格式（建议）

每包一行记录（Owner 自行填写，本材料不预设分数）：

```
#<行号> <evalId> <阶段>
A 独立机制: <N_A 个；列出> ；重复: <哪些只是换说法>
A 证据忠实: <每机制 Supported/Partially/Unsupported>
B 独立机制 / B 证据忠实: 同上
偏好: A / B / 平 ；理由（≤30 字）
应淘汰候选: <编号>
```

## 五、边界说明（诚实披露）

- 本材料由 AI 准备；机器审计结论（机制普查、忠实性分类）已单独成文，但**未**嵌入本包——避免锚定 Owner 判断。
- 评估模型与生成模型同族（glm-5.3）的历史评分**未**包含在本包中。
- AI 不得冒充 Owner 完成评分；本材料仅为评分输入。
- 样本量 35/174 = 20.1%，满足 ≥20% 要求；未人为补齐。
