# SPEC 自评、自查与证据记录

## PD Release & Delivery Architecture Optimization v1.1

-   审查日期：2026-11-02
-   审查对象：PD Release & Delivery SPEC v1.0
-   输出：v1.1 修订依据
-   审查范围：文档逻辑、跨文档一致性、已授权本地 checkout 的关键路径抽查
-   重要限制：这不是全仓库 G0，也不是对当前 GitHub
    远端最新代码的完整审计

## 1. 总体结论

**v1.0 战略方向正确，但执行约束不足，不适合原样交给本地 AI 直接实施。**

主要问题不是技术方案不够多，而是缺少明确的证据等级、仓库工作区纪律、产品级默认决策，以及对"重复构建"和"重复依赖"的准确区分。

v1.1 已修订为：G0 只读调查 → Owner 审阅 → 独立 worktree 实施 → 分阶段
Gate → 产品验收。

## 2. 本次本地代码核验

通过授权的 Remote Desktop Commander 只读访问 `D:\\Code\\principles`。

### 2.1 仓库状态

  --------------------------------------------------------------------------------
  项目                                观察值
  ----------------------------------- --------------------------------------------
  Branch                              `main`

  HEAD                                `68537c19d6d3f3ad4b9395a2047bcfe118d59a5b`

  本地 origin/main tracking ref       `0ff5f9f031d83f8243f26c62881db4c13e6ab4ab`

  Ahead/behind                        `0 / 32`

  Working tree                        27 项 untracked；未观察到 tracked
                                      modification

  Fetch                               本次未执行
  --------------------------------------------------------------------------------

`origin/main` 是本地跟踪引用，不代表刚刚从 GitHub 刷新的远端状态。G0
必须刷新并记录。

### 2.2 仓库工程规则

已读取根 `AGENTS.md` 开头的产品边界/Evidence Over
Assumption/Architecture Reality Audit 规则，以及 `git-1` 至 `git-15`
worktree 规则。

关键规则：

-   primary checkout 只读；
-   每个写入任务必须独立 worktree；
-   不得清理未知 untracked/modified 内容；
-   不使用共享 stash；
-   写入前获取 writer claim/lease；
-   worktree 必须 READY，且不得从 primary checkout 泄漏依赖；
-   worktree 池路径由工具推导，不得硬编码机器路径。

v1.0 没有把这些仓库强制规则纳入执行步骤，是重大遗漏。

### 2.3 发布打包脚本

抽查 `packages/create-principles-disciple/package.json`：

-   `prepack`: `npm run build && npm run bundle`
-   `prepublishOnly`: `npm run build && npm run bundle`

结论：两个生命周期脚本内容相同，属于需要追踪的重复执行风险；真实发布时是否都触发、是否另有显式构建，必须从
npm 实际生命周期和 workflow/action 运行日志证明。

抽查 `scripts/bundle-plugin.mjs`：

-   self-contained 构建分别物化
    plugin、core、host-runtime、pd-cli、console、install-layout、release-manager、codex-adapter；
-   WorkBuddy adapter 存在时额外物化；
-   install-layout 无 runtime dependency，但仍执行 `npm ci` 验证 release
    lock；
-   代码注释给出插件/adapter/Release Manager 的依赖隔离原因。

结论：9 个目录/物化步骤不能被直接认定为 9
份可共享重复依赖。必须逐组件证明物理重复和解析兼容性。

### 2.4 可复现性 workflow

抽查 `release-reproducibility-full.yml`：

-   两次独立执行 self-contained archive build；
-   比较两份 archive 的可复现性。

结论：这是独立验证价值，不应因"构建两次"而删除。v1.0 "Build
once"需要定义为"每个具体发布产物的生产路径不做无价值重复构建"，不能删除独立复现性测试。

### 2.5 Installer 关键路径

抽查 `packages/create-principles-disciple/src/installer.ts`：

-   `restoreBackup`：当目标 extension/runtime
    目录存在时先递归删除，再将备份 rename
    归位。两棵目录分步操作，存在部分恢复失败的可能。
-   `verifyConsole`：在固定端口区间中尝试端口；health 成功判据是 HTTP
    200 且 body 是非 null、非数组 JSON object，不能证明响应来自本次
    child。
-   `verifyConsole` 失败时发送 SIGTERM；若 exit event 尚未发生立即发送
    SIGKILL，然后继续下一端口；没有在该分支等待 child exit。
-   同文件存在 `isLaunchedConsoleHealth` 较严格的 health 检查
    helper，但当前抽查的 `verifyConsole` 使用的是更宽松的 JSON object
    判据。

结论：R-1/R-2/R-3 是在该 checkout
中确认的代码事实；故障影响和触发频率仍需测试，不能把"存在危险窗口"夸大成"每次必然失败"。

### 2.6 关键路径与跟踪引用差异

本次比较 `HEAD..origin/main` 的选定发行关键路径：

-   `installer.ts`、`bundle-plugin.mjs`、release lock/hygiene/build
    scripts、`pd-console/package.json`、Lab payload builder 和
    `.github/workflows` 未见文件差异；
-   `create-principles-disciple/package.json` 的可见差异为版本 `1.146.0`
    → `1.146.2`。

这只证明本次选定路径在本地两个 Git 引用间未见差异，不证明整个仓库或实时
GitHub 远端一致。

## 3. v1.0 问题清单与修订

  ---------------------------------------------------------------------------------------------------------------------------
  严重度                  v1.0 问题                                        v1.1 修订
  ----------------------- ------------------------------------------------ --------------------------------------------------
  Critical                未把 AGENTS worktree/primary read-only           新增执行手册和硬约束
                          规则写入执行步骤                                 

  Critical                未显式保护当前主工作区的 27 项 untracked 内容    禁止 reset/clean/restore/stash，G0 只记录

  High                    把 Build once                                    定义为每个具体产物生产路径去重，保留复现性双构建
                          写得过于笼统，可能误删可复现性双构建             

  High                    Release Check / Executor 的 TUF 校验职责可能重复 明确一个权威信任校验
                                                                           owner，其他边界只做必要资产复核

  High                    体积规范遗漏 267 个历史 Release assets / 50.53   新增 Release
                          GiB 的存量治理                                   历史资产盘点与保留策略，禁止未经授权删除

  High                    把多个组件 npm ci / node_modules                 按组件证明物理重复、peer/native/host 解析等价
                          视作可疑重复，缺少隔离语义                       

  High                    Reliability                                      改为目标语义和等价实现，由实施者选最小方案
                          中部分要求过度具体，可能把实现方案写成产品要求   

  Medium                  平台矩阵容易导致每个故障注入在每个 ABI           新增 Tier A/B/C 分层
                          重复，成本过高                                   

  Medium                  生产用户机是否需要 UI rebuild 能力没有默认答案   默认正式 runtime
                                                                           不保留构建链，只有找到受支持用户场景才例外

  Medium                  备份代数需要 Owner 逐项做技术裁决                默认保持当前 + 一个 previous，不在本轮擅自减少

  Medium                  历史代码基线容易被误当成当前 HEAD                标记日期、SHA、未 fetch 限制；要求 G0 重核
  ---------------------------------------------------------------------------------------------------------------------------

## 4. 未能核实 / 不应声称已核实

本次没有完成全仓 G0，因此以下仍是 UNKNOWN：

-   当前 GitHub 实时 `main`（本次没有 fetch）；
-   全部 npm lifecycle 在每种发布入口的实际触发次数；
-   publish action 是否在每个分支重复 pack/build；
-   发行资产、安装目录和 GitHub Release 历史资产的最新体积；
-   依赖重复的物理字节数及共享安全性；
-   181 MB adapter 线索和 92 MB Release Manager 线索的动态可达性；
-   所有平台/ABI 的目录 rename/delete 真实行为；
-   所有 terminal journal 与物理安装状态的一致性；
-   Release 历史资产删除是否影响旧客户端升级或回滚。

这些问题已交由 G0 取证，不应在 SPEC 中预设结论。

## 5. 是否存在过度设计

v1.1 特意避免新增：

-   新的 Release Framework；
-   平行恢复状态机；
-   强制 generations；
-   全局共享 node_modules；
-   新的数据库/服务/配置系统；
-   为每个故障新增独立状态；
-   自动历史资产清理服务。

只要求明确职责、修复已证实风险和减少可证明的重复内容。

## 6. v1.1 的执行边界

当前仅授权 G0 只读调查。G0 结束必须停下交 Owner 审阅。Owner
明确批准实施后，按 `AGENTS.md` 使用独立
worktree。未经授权不得修改源代码、生产安装、历史 Release
资产、Linear、ERR 树、项目记忆，不得合并或发布。

## 7. 最终自评

-   战略对齐：PASS
-   文档之间目标/范围/优先级一致性：PASS（经 v1.1 修订）
-   当前关键代码事实：部分抽查确认；不是全仓审计
-   平台运行事实：待 G0
-   Release workflow 实际执行证据：待 G0
-   本地 AI 执行边界：已补齐
-   可直接开始代码重构：**NO**；必须先完成 G0 并由 Owner 审阅

**最终判断：v1.1 可以交给本地 AI 执行 G0；不能把它理解为无需 G0
就可直接大规模改代码的授权。**
