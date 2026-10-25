# Examiner Stage G — 阶段恢复文档（Context Recovery）

```
LAST_VERIFIED_AT:        2026-10-25（候选总账核验完成：60/60 唯一 caseDef、盲评包扩展至 60 RV packets）
CURRENT_STAGE:           E 组候选生成已收口（60 adopted envelopes / 36 唯一基线锚点 / 52 unique skeleton+param combos）；盲评包扩展至 60 RV；等待 ChatGPT AI-only 盲评
OWNER_DECISION:          模型切换至 Atria-Dawn 已执行；E 组候选生成已收口；仍待：盲评者指派/时薪/骨架边界/核验人
IMPLEMENTATION_STATUS:   全管线稳定；盲评包 60 RV（12 round7 + 6 round8 + 42 round10）
REAL_MODEL_CALLS:        累计 48 次正式请求（round7 16 + round8 16 + round10 16），3 成功轮产出 60 候选，其余 429/超时
REAL_HOST_RUNS:          0
PRODUCTION_WRITES:       0
AUTHORIZATION_STATUS:    Stage G = round10 授权存活（Atria-Dawn 绑定）；Stage R = NOT_AUTHORIZED；realHostBaseline = UNKNOWN；PRI-1037 = NOT_RUN
NEXT_ACTION:             将 60 RV 匿名包转交 ChatGPT AI-only 盲评 → 表达质量数据 → B0/B1/E 比较 → 研究结论
```

## 1. 主研究目标

在相同可信事实库、冻结语义骨架、合法参数空间与机械验证规则下，检验 Examiner LLM 受约束生成（表达质量/实质结构多样性/人工修订成本）相较确定性枚举的可独立验证增量（SPEC v0.4 RQ5）。主 SPEC（PL 主线）：`SPEC-PD-PL-001 v0.3`——Examiner 支线不改变其 C-A/C-E 判定。

## 2. SPEC 与版本

- 当前 Examiner SPEC：`docs/specs/SPEC-PD-EXAMINER-001-v0.4.md`（v0.3 增量修订，637 行，sha256 前缀 `a4691f7e…`）
- v0.3 保留为 Phase 1A 冻结基线引用（`input-manifest.json` 的 `specFileSha256=def15985…` 指向 v0.3 历史核验，不因 v0.4 失效）

## 3. 研究资产与冻结哈希

- 研究支线：`scripts/dev/principle-learning-lab/challenge-studies/CEB-001/`；预检文档：其 `stage-g-preflight/`（Preflight-Report / Owner-Review-Consistency-Check / Pre-Execution-Contract-Review / Design-Review-Final / protocol-option-a,b / preregistration.stage-g.draft）
- 冻结四哈希：mappingHash `213090daecf0cbc9…`、graderHash `eef38484c4f8ace0…`、suiteHash `e1f2f5ca9d7f570f…`、preregistrationHash `01ac054b2aee6e84…`
- 核验命令：`node scripts/dev/principle-learning-lab/freeze-challenge-study.mjs --study CEB-001 --verify`

## 4. 本轮（B0/B1/E 最终收口）变更文件

新增/修改：`lib/challenge-enumerator.mjs`（+verifyFullLegalSpace；B1 升级 **v2=exhaustive-verify-then-select**，v1 保留为 `enumerateCandidatesB1V1`）、`__tests__/principle-learning-lab-challenge-b1.test.ts`（12→**18 项**）、`stage-g-preflight/protocol-b0-b1-e-comparison.draft.json`（v2：核实空间/搜索空间区分/双口径指标/结论边界四问）、SPEC v0.4 §5.3A（增量3）、OWNER-DECISIONS-REQUIRED.md（第 13 项更新）、本文件、PL-PROJECT-STATE.md。
冻结资产：**零改动**。

## 5. 本轮测试与真实结果

- `npx vitest run __tests__/principle-learning-lab-challenge-b1.test.ts` → exit 0，**18/18**（含全量 31,680 组合实际枚举逐一体 validator 全验 it[120s 超时档]、空间指纹钉死断言 8a46476e…、stakes 纯标注裁定逐字节相同、非法点拒绝面、v2 全验溯源、v1 保留、确定性[60s 档]）。
- 空间核实（node 实跑 6.5s）：31,680/31,680 全过、0 失败；实质决策情境 3,960；指纹 8a46476ed3520973cd4b75a03ccaa6f5…。
- 全量回归见收工报告；`freeze --verify` 四哈希不变。

## 6. 尚未完成 / 阻塞项（全部待 Owner）

模型与版本、输入/输出分价单价（per-million）、人工时薪、$3 上限重定（$10/$30 价位最坏 $3.20>3）、盲评人员（2+仲裁 1）、骨架边界与表达层残余风险接受、新领域核验人、PRI-1034 Examiner 适配器实现授权、Stage G 执行授权签发、（独立阻断）PRI-1037 真实宿主隔离探针。

## 7. 下一条可直接执行的行动（2026-10-25 第二次修订：六步既定顺序）

**Owner 决定模型和预算（见 stage-g-preflight/OWNER-DECISIONS-REQUIRED.md 12 项） → 真实 transport 工程实现（不发真实请求；独立工程许可，与 Stage G 执行授权分开批准） → 授权与安全独立审查 → 正式预注册冻结（以 option-b 草案+statsContract_v04 为基础） → Owner 最终签发 Stage G 执行授权（challenge-stage-g-authorization.v1：APPROVED+绑定+validFrom/validUntil，可撤销） → 才能运行限定范围内的真实请求。**

当前所处位置：第 1 步（Owner 决策输入未齐备）。任何一步未完成不得跳到真实请求；工程完成≠真实实验获准。

## 8. 保护区（不得违反）

冻结 CEB-001 题集/Gold/评分契约/冻结预注册与四哈希链；`generation/run-authorization.json` 保持 NOT_AUTHORIZED（fail-closed）；`realHostBaseline=UNKNOWN` 不得改 PASS；生产 DAG/RuleHost/激活/治理与生产数据库；PAHF 借鉴仅限离线测试思路；相关 Linear：PRI-1024（总）、PRI-1034/1035/1037；不建竞争性状态文档。
