# SPEC-PD-RELEASE-RELIABILITY-001

## PD 安装、更新与恢复可靠性规范

-   版本：v1.2
-   所属总规范：SPEC-PD-RELEASE-DELIVERY-001
-   优先级：P0
-   性质：目标行为规范；G0 已在基线 `b98e7e339` 完成 R-1..R-4 复核
    （全部 CONFIRMED_IN_CHECKOUT）；v1.2 补充 §13-§17（A-E 项）
    来源于 PRI-1069 / PRI-1070 用户故障与源码核查评论

## 1. 目标

升级成功时证明新版本真实可用；升级失败时旧版本仍可恢复；任何无法自动恢复的状态都必须真实、可见、可诊断。

本规范不预设必须采用 generations、目录 rename-aside
或某个具体状态机。先确认当前实现和平台语义，再选最小可靠方案。

## 2. 当前代码复核线索

v1.1（2026-11-02）在本地 `HEAD@68537c19` 抽查；**G0 已在基线
`b98e7e339`（= 当日 origin/main）亲自复核 R-1..R-4，全部维持
CONFIRMED_IN_CHECKOUT**，并补充了行号证据（restoreBackup =
installer.ts:1187-1207；verifyConsole = installer.ts:2880-2992；
backupExistingInstall = installer.ts:1159-1185；install() catch =
installer.ts:4439-4463）。R-5..R-8 状态见下表。

  -----------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  ID                本次抽查结果                          当前判断（G0 复核后）                                                          G1 还需做什么
  ----------------- ------------------------------------- ------------------------------------------------------------------------------ --------------------------------------
  R-1               `restoreBackup` 对现有                **CONFIRMED_IN_CHECKOUT**（G0 亲自复核）：先 rmSync 后 renameSync，             修复（P0-3）＋每步故障注入
                    extension/runtime                     两树顺序、失败仅返回 restored:false                                             ＋PRI-1070 已源码确认同一缺陷
                    目录执行递归删除，再 rename 备份归位  （用户实测 EPERM 半恢复：PRI-1069/1070）                                         

  R-2               `verifyConsole` 失败时发送            **CONFIRMED_IN_CHECKOUT**（G0 亲自复核）：SIGTERM 后立即                        修复（P0-2）；PRI-1069 核查评论
                    SIGTERM；若 exit 事件尚未发生即发送    SIGKILL、无 join；成功路径 killConsoleChild 同模式                              确认同一缺陷
                    SIGKILL，然后继续下一端口；没有等待                                                                                  
                    child exit 的 join                                                                                                   

  R-3               `verifyConsole`                       **CONFIRMED_IN_CHECKOUT**（G0 亲自复核）：成功判据=200+JSON                    修复（P0-1）；PRI-1069 实测 502
                    探测固定端口区间，成功条件是 HTTP 200  object，无 nonce/instanceId；3100-3199 洗牌取 3、固定                未知响应者即此缺陷的现实表现
                    且 body 为非 null、非数组 JSON object  6s 等待、无端口预检/listen(0)；仅保留最后一次失败原因、                            
                                                          每次尝试诊断不落 journal                                                       

  R-4               备份分 extension/runtime              **CONFIRMED_IN_CHECKOUT**（G0 补充细节）：ext rename 成功而                    修复（P0-3）；PRI-1070 评论确认
                    两棵目录处理；restore                  runtime rename 失败时抛错，外层 backupDir 变量尚未赋值，                       （"调用方可能没有拿到第一份已移动
                    可能在两者之间失败                    catch 拿不到备份路径；备份 source/destination 不入 journal                      备份的路径"）
                                                         （仅 logger.info）                                                               

  R-5               terminal journal 与恢复列表是否一致   **UNKNOWN→部分收窄（G0）**：恢复端点实现为只读扫描+active.json                 G1 核验（P0-4）；PRI-1070 评论指出
                                                         不可读保守报警；但 terminal failed 事务是否进 needsRecovery、                   "恢复扫描跳过 terminal fact"
                                                         与磁盘交叉核对未经证明                                                          待验证

  R-6               active record、journal                **UNKNOWN**：journal-first+torn-tail reader+恢复决策存在且有测试，              G1 故障注入（F14/F15/F16）
                    和物理目录的崩溃窗口                  activated/confirmed 窗口崩溃未注入                                              

  R-7               旧 Console、探针 child、executor      **代码事实 CONFIRMED / 实际竞态 UNKNOWN**：更新全程不停旧 Console              G1 核验（P0-5）＋F18 注入
                    的进程/句柄/端口竞态                  （仅停 gateway）；installConsole rmSync 运行中目录；探针 child                  
                                                         无 join、可能持新 runtime 原生模块句柄                                          

  R-8               Windows 原生模块加载期间目录          **UNKNOWN（未实验）**：当前实现依赖"先 rename-aside 再复制"，                  仅当候选修复依赖该语义时实验；
                    rename/delete 行为                    回滚路径的 rmSync 遇加载中 .node 的 EPERM 已由用户实测                          修复后不再依赖则只验证退出后安全
  -----------------------------------------------------------------------------------------------------------------------------------------------------------------------------

**重要纠正（v1.1 保留，v1.2 维持）**：本规范不把 `restoreBackup(null, null)`
当作既定缺陷。当前实现允许无备份时返回 `restored: true`，调用方另有
`hasBackup`
判断；真正需要审查的是"无备份/未发生变更"与"已执行但恢复失败"的语义是否被所有路径正确区分。
**v1.2 补充**：R-4 证明"备份中途失败"路径下该区分被破坏（外层拿不到备份
路径 → restoreBackup(null,null) 无操作 → journal 记 failed 但 ext 树已
离开原位）。

## 3. 核心不变量

1.  新版本通过验收并确认前，旧版本必须保持可恢复。
2.  不得在唯一有效版本或唯一恢复副本仍可能需要时先做不可逆删除。
3.  health probe 必须证明响应属于本次启动实例。
4.  对仍被进程使用的目录执行破坏性操作前，必须确认相关进程退出，或采用目标平台已验证的安全切换方式。
5.  `active` 记录不能单独证明磁盘安装完整。
6.  回滚失败必须显式暴露；不得伪装成"没有发生变更"或"回滚成功"。
7.  terminal journal 不等于物理安装健康。
8.  恢复动作应幂等、可审计；只读状态查询不能隐式修改安装。
9.  更新失败不能绕过 TUF、签名、摘要、manifest、ABI 或宿主校验。

## 4. 安装事务语义

以下是需要被当前状态模型表达的语义，不是要求机械新增同名状态：

  语义                必须证明的事实
  ------------------- -----------------------------------------------------
  Prepared            目标资产、版本 cohort、平台/ABI、路径和空间预检通过
  Staged              资产已验证并在隔离 staging 中完整展开
  Installing          正在部署候选版本；旧版本仍可恢复
  Verifying           正在验收本次启动的候选实例
  Activated           活动版本指针已切换到候选版本
  Confirmed           候选版本通过验收，事务完成
  Rolling back        正在恢复；每一步物理操作结果可追踪
  Rolled back         旧版本实际恢复且物理完整性检查通过
  Recovery required   自动恢复无法证明成功，必须向用户/运维明确暴露

事务进度与安装健康度是两个维度。事务可以 terminal failed，但安装仍
incomplete。若现有模型已有等价表达，直接复用，不增加平行状态机。

## 5. 事务目标顺序

1.  **Preflight**：验证受信任的更新元数据、目标资产身份、摘要、manifest、平台/ABI、路径、权限、空间和并发事务。
2.  **Prepare**：下载/读取已验证资产，在隔离 staging
    中展开；核对实际文件集合、入口、原生模块和依赖。
3.  **Preserve old
    install**：记录旧安装身份和位置；创建可验证恢复点。任何一步失败都要记录已完成的物理操作。
4.  **Install
    candidate**：部署到候选位置；不允许不完整候选覆盖唯一有效安装。
5.  **Probe candidate**：探测必须绑定本次启动实例。可采用 child
    分配端口并经 IPC/stdout 报告，或现有端口机制加一次性随机 nonce
    等等价方案；不强制特定实现。
6.  **Join child**：结束探针子进程并等待
    exit。优雅终止后可按有界超时强制终止；未确认退出时，不得执行会破坏其正在使用目录的操作。
7.  **Activate**：使用目标平台已验证的切换方式；active record
    原子写入、回读，并绑定候选目录身份。
8.  **Confirm**：检查活动目录、关键入口、版本身份、journal 和 active
    record 一致后才确认。
9.  **Cleanup**：清理旧备份与成功事务分离；不得删除唯一恢复版本。清理失败可报告残留，不应伪装为安装失败。

## 6. 信任校验责任边界

-   必须有一个权威组件负责更新元数据的 TUF 信任链验证。
-   下载/执行边界可对资产摘要、manifest、平台/ABI
    和文件集合做必要复核，但必须说明与权威验证的差别。
-   不得在 Release Check、Console 和 Executor
    中复制多套没有独立威胁价值的完整 TUF 实现。
-   若 executor 接收已验证资产，必须以不可混淆的资产身份/路径/hash
    绑定输入，不能信任任意路径或可变文件。

## 7. Health Probe 身份要求

必须满足：

-   不能仅扫描固定端口区间并把任意 200 JSON 当作候选 Console；
-   响应必须绑定本次 child/transaction 的实例身份；
-   版本和认证模式必须符合目标安装契约；
-   nonce/秘密材料若采用，必须短期、仅本机传递、不写普通日志、不作为长期凭据；
-   失败分类至少区分 child
    启动失败、端口绑定失败、错误响应者、身份不匹配、schema/auth
    不匹配、超时和提前退出；
-   其他本地进程、旧 Console 或代理返回的健康 JSON 必须不能通过验收。

具体采用 OS 临时端口、IPC、stdout readiness 或一次性
nonce，由实施者根据当前 server 结构选最小方案，并提供反例测试。

## 8. 备份与恢复要求

-   备份每一步记录 source、destination、transaction id 和完成状态。
-   extension/runtime
    多棵目录之间的部分成功必须可表达，不能只返回一个模糊 boolean。
-   `rolled_back` 只能在旧版本实际归位且完整性检查通过后写入。
-   无备份且尚未发生部署，与已有安装已被修改但恢复失败，必须清楚区分。
-   回滚失败时保留所有可能有恢复价值的目录，不自动清理失败残留。
-   默认保留策略为当前版本 +
    一个上一版本；减少保留代数需单独证明恢复覆盖不受影响。
-   恢复列表应显示物理不完整或需人工处理的事务；已确认健康的历史
    terminal 事务可以不展示。
-   GET/status 只读；恢复动作需要明确操作、权限校验、事务 ID
    和审计结果。

## 9. Windows 文件系统实验

只有当候选修复方案依赖目录 rename-aside
或原生模块文件占用语义时，才必须做真实 `.node` 模块实验。

实验使用临时目录：

-   child 真实加载发行所用 native addon 并保持运行；
-   parent 分别测试同卷目录 rename/delete；
-   child 退出并确认 exit 后重复测试；
-   记录 OS 错误码、Node errno、目录内容、耗时和进程状态；
-   测试真实支持的 Node ABI/Windows runner；
-   模块加载失败则实验无效，不能用普通文件句柄替代。

若方案不依赖"模块仍加载时 rename 成功"，不得把这个实验变成无意义的额外
Gate；但仍要验证停止进程后目录操作安全。

## 10. 测试要求

### 单元/集成

-   状态转换、journal 中断/重复/并发；
-   active record 原子写、回读和目录身份不匹配；
-   备份和回滚每一步成功/失败组合；
-   health 错误 nonce、端口冲突、伪造 200 JSON、502、非 JSON、超时；
-   child 正常退出、忽略优雅终止、强制终止、无法确认退出；
-   terminal failed 但目录残缺必须可见；
-   activated/confirmed 各崩溃窗口恢复。

### 真实平台故障注入

-   下载/校验失败；
-   staging 和部署中断；
-   备份部分成功；
-   probe 前、中、后崩溃；
-   active record 写入前后崩溃；
-   child 未退出；
-   磁盘空间不足、权限拒绝；
-   旧 Console 仍运行；
-   备份缺失/损坏；
-   回滚中途 EPERM/EBUSY。

故障注入平台按验收计划分层，不要求所有故障在每个 ABI 上重复执行。

## 11. 发版阻断条件

任何一项成立均阻断发布：

-   旧安装在失败时无法证明可恢复；
-   健康探针无法证明响应者身份；
-   child 未退出仍执行不安全目录操作；
-   部分恢复被报告为成功或无变更；
-   terminal 失败导致的物理损坏不可见；
-   active record 与物理目录不一致仍显示成功；
-   平台/ABI/信任校验可绕过；
-   选择依赖 Windows 特定文件系统语义的方案，却没有真实 Windows 证据。

## 12. 非目标

-   不为每种错误新增独立状态机；
-   不强制采用 generations；
-   不把状态查询改成自动修复；
-   不追求清理所有残留；
-   不用无限重试替代事务安全；
-   不为满足某个目录切换方案而先验要求 Windows rename 成功。

## 13. 更新执行代码来源（v1.2 新增，A 项）

**不得默认更新逻辑运行在候选版本代码中。**

-   必须核实：更新事务实际由哪个版本的 Runtime 执行。当前生产链
    = Console（旧版）→ bootstrap executor（旧版，独立 detached 进程）
    → ReleaseManager（旧版）→ 动态 import 旧 runtime 的
    `installer.js` → `install()`/`verifyConsole()`。**更新验证逻辑来自
    更新前已安装的 runtime**（PRI-1069 核查评论第 1 节，已对 2.4.0 /
    2.7.0 / main 比对确认实现一致）。
-   必须核实 Bootstrap Executor 是否使用旧版本代码、其与
    `~/.pd/bootstrap/executor` 投递的 digest 边界，以及新版本安装器与
    旧版本执行器之间的兼容关系（executor 协议 `ping|inspect|check|apply`
    的跨版本稳定性）。
-   必须描述升级过程中旧 Console、Executor、探针子进程的完整生命周期
    （谁启动、谁持有句柄、何时退出、谁等待退出）。
-   修复必须同时考虑：旧版本 runtime 执行更新（存量用户）与新版本
    runtime 执行更新（修复发布后）两条路径的兼容性。

## 14. 探针诊断与身份识别（v1.2 新增，B 项）

-   每次探针尝试必须有**独立诊断记录**（attempt-level），不得只保留
    最后一次失败的摘要。
-   每次尝试至少记录：PID、端口、进程启动结果、退出码、终止 signal、
    HTTP 状态码、响应身份判定结果。
-   在安全范围内保留 stderr 片段与错误上下文（有界截断），进入事务
    journal 或失败 detail，使 Owner/运维可以离线归因。
-   敏感 nonce、凭据不得进入普通日志（nonce 仅在内存中比对，日志只记
    录身份匹配成功/失败，不记录 nonce 值）。
-   **502 不得未经证据直接归因**于 PD、代理或其他服务（PRI-1069 核查
    评论第 3 节：PD health handler 无 502 分支，实际响应者未知）。
-   无法确认响应者身份时，诊断必须保持 UNKNOWN 并记录观测事实
    （状态码、body 形状、端口、时间），不得猜测归因。

## 15. Windows EPERM 证据（v1.2 新增，C 项）

-   不得预设 `.node` 原生模块一定是 EPERM 的原因；必须识别**实际失败的
    文件操作**（哪个 unlink/rename 抛出、错误码、路径）。
-   尽可能确定占用文件或目录的进程（PID/进程名）；区分：进程存活、
    模块已加载（内存映射）、文件句柄打开、目录操作受限（EPERM vs
    EBUSY vs ERROR_ACCESS_DENIED）。
-   仅当候选实现**依赖加载期间的目录 rename/delete 语义**时，才执行
    真实原生模块实验（发行所用 `.node`，child 真实加载并保持运行）。
-   不允许用普通文本文件句柄冒充原生模块实验。
-   若修复方案不依赖该语义（例如回滚关键路径只做同卷 rename、不递归
    删除 live 目录），则不强制该实验，但仍必须验证进程退出确认后的
    目录操作安全性。

## 16. Journal 与事务身份（v1.2 新增，D 项）

-   原始日志（journal 原文）、脱敏日志（反馈报告中的
    `<redacted-path>`）和截断日志必须明确区分，不得把脱敏后的数据当
    成完整原始证据（PRI-1069 核查评论第 4 节）。
-   事务 ID 格式异常（如与源码生成格式 `update-<epoch-ms>-<uuid8>`
    不符）需要核验产生位置：源码、日志管线还是报告脱敏环节；格式异常
    本身不是改写证明，也不能被忽略。
-   Journal 状态不能代替磁盘真实状态；active record、journal、物理
    目录三者必须能交叉核对（P0-4 的实现要求）。
-   探针 attempt 级诊断（§14）进入 journal 时必须与事务身份一致
    （transactionId 贯穿）。

## 17. 部分恢复语义（v1.2 新增，E 项）

-   Extension 与 Runtime **分别记录**备份与恢复结果（分树结果结构，
    不是一个模糊 boolean）。
-   任一恢复步骤失败都必须**保留剩余恢复材料**（未应用的备份目录
    不得删除；失败代际移入隔离位置而非销毁）。
-   不允许把部分恢复报告为完整恢复；`rolled_back` 只能在**两树均
    物理归位且入口完整性检查通过**后写入。
-   恢复动作必须幂等：重复执行 restore 不得二次破坏（先检查目标
    状态再行动）。
-   失败后的目录必须进入**可诊断、可恢复**状态：恢复失败时 active
    指针不变、备份保留、失败 detail 包含残留目录清单与下一步操作
    指引；恢复状态扫描不得因 terminal `failed` 而跳过物理不完整的
    安装（见 P0-4）。
