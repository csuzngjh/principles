# AI User QA（PRI-754）

用 AI 模拟真实用户，通过 Playwright 操作**真实运行的 PD Console**，从用户视角发现：

- 用户无法理解的问题（看不懂的文案/概念）
- 用户无法完成的问题（流程断链、入口缺失）
- 用户无法恢复的问题（出错后没有出路）
- 差的交互体验

这是对既有 Unit / Integration / E2E / PR Review 的补充，**不替代它们**：
AI User 发现的问题只记录在报告里，不自动修改代码、不自动创建 Linear issue。

## 前置条件

- 环境变量 `OPENAI_API_KEY`（OpenAI 兼容端点的 API key）；
- 环境变量 `PD_AI_USER_MODEL`（模型 id，如 `glm-5.3-flash`），或运行时传 `--model`；
- 可选 `OPENAI_BASE_URL`（默认 `https://api.openai.com/v1`；本地 LM Studio 等本地端点同样支持）；
- Playwright chromium 二进制（跑过 `npx playwright install chromium` 即可；console E2E 已依赖同一二进制）。

## 用法

```bash
# 在 packages/pd-console 目录下（脚本会先自动 build:ui，干净 checkout 可直接运行）
npm run test:ai-user -- --scenario tests/ai-user/scenarios/first-run-onboarding.yaml

# 常用选项
npm run test:ai-user -- --scenario <yaml> --model <id> --max-steps 8 --headed
npm run test:ai-user -- --scenario <yaml> --base-url http://127.0.0.1:3100 --console-token <token>
#   attach 模式：附加到已运行的 console；目标启用了认证时必须提供 --console-token，
#   否则 AI User 只会看到登录页，无法进入真实产品流程。
```

Runner 会自动：在临时目录创建**全新 workspace** → 以 `--no-auth` 启动真实
console server（与 `playwright.config.ts` 的 e2e webServer 同一生产入口，
SqliteConnection 自动 bootstrap schema，无 seed——即「第一次使用」的真实状态；
子进程 HOME/USERPROFILE 重定向到临时目录，QA run 不触碰开发机真实安装）
→ 启动 chromium → 循环执行「观察 → LLM 决策 → 动作 → 截图」→ 生成报告 →
清理进程与临时 workspace。

退出码：`0` = 运行完成且报告已生成（`result: failed` 也是有效产出——发现
问题正是本工具的目的）；`1` = 基础设施故障（scenario 非法、server 起不来、
**LLM 全程不可用导致零决策** 等）。LLM 中途失败（已有部分决策）不算基础
设施故障：报告以 `incomplete`/`llm-error` 如实记录后正常退出。

## Scenario 格式（简单 YAML，非 DSL）

```yaml
id: first-run-onboarding        # 必填，唯一标识
persona: 第一次使用 PD 的开发者  # 必填，用户身份
goal: 完成 PD 初始化            # 必填，用户目标
success:                        # 必填，非空列表，逐条成功标准
  - 页面明确展示系统处于运行状态
observe:                        # 可选，观察点
  - 首屏是否让用户知道下一步该做什么
maxSteps: 12                    # 可选，默认 10（上限 50）
startUrl: /                     # 可选，默认 /
```

AI User 每步只能输出一个白名单动作：`click` / `fill` / `press` /
`navigate`（仅站内路径）/ `wait` / `finish`。模型回复按不可信输入校验
（AGENTS.md rc-1..rc-8），畸形回复自动纠错重试一次，仍失败则结构化记录。

## 报告与产物

每次运行产出独立目录（gitignored，默认 `packages/pd-console/ai-user-runs/`）：

```
ai-user-runs/<scenario-id>-<时间戳>/
  report.json      # 结构化报告：Scenario / Result / Steps / Evidence / Problems / Suggestions
  report.md        # 同源渲染的人可读版本
  server.log       # console server 输出
  screenshots/     # step-00.png（初始状态）+ 每步一张全页截图
```

## 已知限制

- 只覆盖 Web Console 入口；Electron（PD Companion）入口未接入。
- 模型输出的选择器依赖可访问性快照质量，动态页面可能定位失败（会如实记录为步骤失败）。
- 结果判定来自 AI User 的 `finish(success)` 自评，不是独立仲裁（后续可加第二模型复核）。
- 本目录代码为 QA 工具，不属于产品运行时，不进入任何构建产物。
