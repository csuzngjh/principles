# Pi 1.2 兼容性 Phase 0 最小实验报告（E01–E05）

- SPEC：SPEC-PD-PI12-COMPAT-001 v0.1
- 日期：2026-10-17
- 实验分支：`ai/adhoc-20261017-pi12-compat-phase0-ac1fd3`
- Worktree：`D:\Code\_worktrees\principles\adhoc-20261017-pi12-compat-phase0-ac1fd3`（基于 origin/main `702d92233`，`npm run dev:worktree` 创建，bootstrap READY，writer=zcode 已认领租约+git lock）
- 环境：Node v26.7.0（本机）/ Pi 来源 = npm registry `@earendil-works/{pi-ai,pi-agent-core}@1.2.0`（registry 已发布；本地 `D:\Code\pi-mono` 的 v1.2.0 tag 源码逐项核对 API 行为，两来源一致）
- **零付费 LLM 调用**：全部模型层由 pi-mono 自带的 `registerFauxProvider`（compat 导出）驱动，真实 `runAgentLoop`/`completeSimple` + 脚本化模型，零网络。

## 实验代码与复现

迁移编辑（实验分支，3 个生产文件 + 2 个契约测试文件 + 3 个新 spike 测试）：

| 文件 | 变更 |
|---|---|
| `packages/principles-core/package.json` + `packages/create-principles-disciple/core/package.json` | pi 两依赖 `^0.85.1` → 精确 `1.2.0` |
| `src/runtime-v2/adapter/l2-agent-loop-adapter.ts` | ① prompts 前插 SystemMessage（timestamp 0）；② `agentContext` 改 `{messages: [], tools}`（去 systemPrompt、去重复）；③ convertToLlm 放行 `system`；④ `shouldStopAfterTurn` → `finishTurn`（error/aborted 守卫在计数前返回 undefined） |
| `src/runtime-v2/adapter/artificer-l2-adapter.ts` | 同上四点 |
| `src/runtime-v2/adapter/pi-ai-runtime-adapter.ts` | ToolCall 提取谓词改用 SDK `ToolCall` 类型（+类型导入） |
| `__tests__/l2-agent-loop-adapter.test.ts` / `artificer-l2-adapter.test.ts` | 6 处契约断言更新到新合同（finishTurn 语义 + system 消息入 transcript + messages 去重断言）——**合同有意变更，非弱化**：新增 error/aborted 不计数断言 |
| `__tests__/pi12-spike-{dreamer,artificer,oneshot}.test.ts` | 3 个新 spike：真实 loop + faux（详见下） |

复现命令（包目录 `packages/principles-core` 下）：

```bash
npx tsc --noEmit                 # 0
npx vitest run                   # 8486 passed / 0 failed（全量）
npx vitest run src/runtime-v2/adapter/__tests__/pi12-spike-dreamer.test.ts \
                src/runtime-v2/adapter/__tests__/pi12-spike-artificer.test.ts \
                src/runtime-v2/adapter/__tests__/pi12-spike-oneshot.test.ts   # 14/14
```

## E01 依赖与导出 — PASS

- `npm install` exit 0；`npm ls`：`pi-agent-core@1.2.0` 与 `pi-ai@1.2.0` dedupe 单副本（工作区根提升）。
- 运行时导入探测：compat 真实导出 `complete/completeSimple/streamSimple/getModel/getProviders/registerFauxProvider/faux*` 与 `streamSimpleOpenAICompletions` 等；agent-core 导出 `runAgentLoop/agentLoop(+Continue)`。
- ESM/TS/打包路径：core `tsc -p tsconfig.build.json` + dist 卫生检查通过（见 E05）。
- **迁移前 tsc 碰撞清单（证据）**：仅 3 处——`artificer-l2-adapter.ts(499)` 与 `l2-agent-loop-adapter.ts(479)` 的 `shouldStopAfterTurn` TS2353；`pi-ai-runtime-adapter.ts(1102/1110/1123)` 的 `ToolCall.arguments` JsonObject 连锁。修复后 `tsc --noEmit` exit 0。
- 值得记录：`agentContext.systemPrompt` 多余属性**不产生编译错误**（经中间 const 传入）——若不迁移则静默丢失 system prompt。spike 以请求形状断言锁定。

## E02 Dreamer L2 — PASS（5/5）

`pi12-spike-dreamer.test.ts`（真实 `runAgentLoop@1.2.0` + 真 compat `streamSimple` → faux provider；仅 catalog 查询 stub 化）：

| 用例 | 结果 |
|---|---|
| 工具调用→submit_output 终止；请求 transcript 形状 = `['system','user']` 恰好各一，system 含三层 prompt + `toolsAdded` 三工具名 | PASS（callCount=2，无第三次调用） |
| 混合工具批次不提前结束（read_principles+read_artifact 同批） | PASS（两工具遥测均在，submit 后终止） |
| 轮上限：连续工具回合 maxTurns=3 截断 | PASS（callCount=3，第 4/5 个脚本响应未被消费） |
| 预算中止：80ms 预算 vs 800ms 慢响应 | PASS（`output_invalid` 有界失败——与 0.85.1 存量语义一致的宽松分类，见审计 §E.2；callCount=1） |
| L2 空→L1 回退端到端 | PASS（3 次空 L2 + 恰好 1 次 L1 completeSimple，遥测含 `dreamer_l2_fallback_to_l1`） |

## E03 Artificer L2 — PASS（5/5）

`pi12-spike-artificer.test.ts`（真实 loop；真 `DefaultArtificerValidator`；注入式 sandbox gate）：

| 用例 | 结果 |
|---|---|
| 全工具链：spec→INVALID 静态校验→VALID→replay PASSED→validator 拒绝不完整 submit（修复回路）→合规 submit 终止 | PASS（callCount=6，四工具遥测齐全） |
| 白名单外工具调用被拒并反馈模型 | PASS（loop 本体 `Tool read_principles not found` + `isError:true` 进入下一请求；运行仍完成） |
| 无工具调用+劝导耗尽 → 有界失败且**无 L1 回退** | PASS（3 文本回合+2 劝导 = callCount=3；无第 4 次调用） |
| 预算中止 → `timeout` 分类（PRI-795 abort 所有权） | PASS（80ms 预算 vs 800ms 响应，reject category='timeout'） |
| replay 失败反馈进模型上下文（修复回路输入） | PASS |
| Owner-Evidence 门 / NHR / Evaluator 绕过 | **不在适配器层**：门在 host-runtime 适配器构造前（`internalization-consumer-cycle.ts:504-594`），Pi 升级不触碰；由既有 host-runtime 套件 + 本实验零改动证明 |

## E04 One-shot — PASS（4/4）+ 既有套件

`pi12-spike-oneshot.test.ts`（真实 compat `completeSimple` → faux；PD 自管重试/分类全部真码）：

| 用例 | 结果 |
|---|---|
| 成功：JSON 提取 + 成功遥测 | PASS |
| PD 自管重试：429 类错误后第二次成功 | PASS（callCount=2，无双重输出） |
| 硬错误 → `execution_failed` 有界失败（1+2 重试） | PASS（callCount=3） |
| 输入超时中止慢响应 → `timeout` 分类 | PASS（80ms 超时 vs 800ms 响应） |
| `onPayload`（tool_choice/response_format） | **SOURCE-VERIFIED**（faux 绕过 HTTP 适配器；两版消费点同构，审计 §B.6）；真实连发 NOT_RUN |
| baseUrl 目录扫描 / 模型目录兼容 | 既有 `l2-resolve-model-compat.test.ts`（真 SDK 无 mock）在 1.2 下 PASS；Google fetch 拒绝套件 PASS |

## E05 构建/打包/安装 — PASS（1 项环境性 NOT_RUN）

| 项 | 命令 | 退出码 | 结果 |
|---|---|---|---|
| core 全量套件 | `npx vitest run` | 0 | **8486 passed / 0 failed**（4 文件 skipped 既有），21.6s |
| core 构建 | `npm run build` | 0 | tsc + dist 卫生 OK |
| host-runtime 构建 | `npm run build --workspace @principles/host-runtime` | 0 | tsc OK |
| pd-cli 构建 | `npm run build` | 0 | OK |
| openclaw-plugin 构建 | `npm run build` + `build:bundle` | 0 | 卫星纯度守卫：forbidden deps **0**；体积预算内（rulehost-evidence 477,058 / 553,489 上限） |
| 插件 bundle 体积 | — | — | 37,064,201 → **37,636,719 字节（+1.55%）**；无新增二进制/Worker/平台依赖（依赖变化全为纯 JS 大版本上移） |
| transitive-deps 守卫 | `npx vitest run tests/scripts/transitive-deps.test.ts` | 0 | 5/5 |
| 依赖树 | `npm ls` | — | `@earendil-works/chord` 消失；pi-agent-core 依赖仅 `{pi-ai ^1.2.0, typebox 1.3.27}`；pi-telemetry 传递解析 1.3.0 |
| release-locks（core、host-runtime） | `node scripts/generate-release-locks.mjs` | 1* | 两锁已再生成且解析 `pi-ai/pi-agent-core 1.2.0`（diff -1951/+861 行，树变小）；`*`脚本最终失败于 plugin 组件的 npm11 `link:true` 形态守卫——**工具链约束（要求 Node22/npm10），与 Pi 无关**，其余组件锁 NOT_RUN（本地）。正式 PR-05 须在 Node22 工具链/CI 再生成全部锁 |

实验过程偏差记录（全部定位并解决，非 Pi 回归）：

1. 首轮 6 个契约测试失败 = 断言旧配置形状（预期内，合同变更后同步更新断言）。
2. oneshot 首版夹具用纯文本输出 → `output_invalid`（诊断路径本就要求 JSON）——夹具缺陷，非迁移问题。
3. 我的手工 `build:bundle` 清掉了 tsc 生成的卫星 `.d.ts`，污染 console 构建（顺序问题）；恢复 tsc 构建后 release-locks 链路通过该步骤。
4. Dreamer 预算中止实测分类为 `output_invalid`——0.85.1 同语义存量行为（E02 断言按真实行为收口并在审计 §E.2 记录）。

## 结论

三路径（Dreamer/Artificer/One-shot）在 Pi 1.2.0 上**全部完成无费用闭环验证**；全量 core 套件 8486/8486 绿；构建/打包/守卫全过；安装布局证据（锁再生成）部分完成且失败项与 Pi 无关。未验证项均有明确边界与后续归属（见 SPEC §12 残余风险）。
