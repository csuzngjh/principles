# SPEC-PD-RELEASE-ARCH-SIMPLIFICATION-001

## PD 发布、安装与更新架构简化规范

-   版本：v1.2
-   所属总规范：SPEC-PD-RELEASE-DELIVERY-001
-   优先级：P1 / P2
-   原则：减少重复职责，不为简化而牺牲真实安全边界
-   v1.2 变更：仅版本/引用一致性修订（内容维持 v1.1；本阶段为可靠性
    优先，架构简化在 G3 逐项批准执行）。

## 1. 目标

识别并消除发布、安装、更新及直接依赖中的无效抽象、重复实现、职责耦合、重复状态和无价值依赖。目标不是全面重构，也不是增加包或服务。

## 2. 架构 Reality Audit

每个候选项必须回答：

1.  它服务哪个真实产品场景？
2.  谁调用它？完整生产调用链是什么？
3.  是否有独立生命周期、安全边界或发布节奏？
4.  是否已有其他模块执行同一职责？
5.  是否能通过删除、合并、复用或修复连接解决？
6.  删除会失去什么行为、安全保证或兼容性？
7.  它带来多少 runtime 依赖、文件、状态、接口、配置和测试成本？
8.  是否有测试证明其独立性必要？

检查必须覆盖静态引用、动态加载、配置引用、脚本入口、外部调用、历史兼容、测试和
CI。仅凭文件名相似、代码相似或静态扫描"不可达"不能删除。

## 3. Release Check 与 Bootstrap Executor

### 3.1 目标职责

**Release Check**

-   获取候选版本/元数据；
-   执行权威更新信任链验证，或调用唯一权威验证模块；
-   检查兼容性和更新策略；
-   向 Console 提供状态和诊断；
-   不直接替换正在运行的安装目录。

**Bootstrap Executor**

-   独立于 Console 生命周期执行事务；
-   接收已绑定身份的目标资产，或在它被指定为信任校验 owner
    时负责下载/验证；
-   执行 staging、部署、验收、激活、journal、回滚；
-   不依赖正在被更新的 Console 继续存活。

### 3.2 约束

-   不强制拆成两个 npm 包或进程以外的新架构。
-   必须明确 TUF 验证的唯一权威 owner；不得在多个组件无理由复制完整 TUF
    信任实现。
-   其他边界可以复核 asset hash、manifest、平台/ABI
    和文件身份，但需说明独立威胁。
-   只读检查依赖可裁剪的前提是消费者和运行时解析已被验证。
-   Executor 独立生命周期有合理产品价值：Console
    可能需要停止或被替换。不得只为减少一个目录/进程删除该边界。
-   Release Manager 双份载荷是待验证线索，不是已确认的物理重复结论。

## 4. 组件依赖解析

此前审查提出通用链接逻辑与组件专用逻辑并存。G0
必须重新定位调用方和实际行为。

目标：

-   对语义相同的依赖解析复用一个权威实现；
-   不同宿主/安全/生命周期语义可以保留专用实现；
-   专用实现必须记录与通用实现的差异和理由；
-   junction/symlink 创建失败应可诊断、可恢复；
-   不得创建指向不可信路径的链接；
-   不为"减少函数数量"把不同语义强塞进复杂 helper。

依赖共享只有在真实模块解析、peer dependency、native
ABI、宿主隔离和升级回滚均通过验证后才准入。

## 5. 状态与事务模型简化

-   一个状态表达一个明确事实；
-   不保留无人写入、无人读取且无兼容意义的状态；
-   不用一个布尔值同时表达事务成功、旧版本可用和新版本激活；
-   不把 terminal 事务等同于安装健康；
-   不为同一故障维护两套权威状态；
-   不让只读 status API 隐式执行恢复。

候选清理项包括死状态、无消费者字段、重复 readiness、重复 active/journal
解析和无行为价值的源码字符串测试。每项清理前需证明没有有效动态消费者、外部
API 或恢复兼容要求，并通过负向测试。

## 6. 发布 Pipeline 简化

目标语义：

`Resolve cohort → Build each required artifact → Pack immutable candidate → Verify candidate → Publish that candidate`

这里的"each required
artifact"指每个需要独立生成的平台/ABI/包产物。不能把多个平台构建误判为重复。

必须核实：

-   `prepack`、`prepublishOnly`、`prepare`；
-   显式 build/bundle；
-   npm pack dry-run；
-   publish action 是否重新 pack；
-   workflow、reusable workflow、composite action 的真实调用图；
-   npm release train、release metadata、self-contained asset 和
    reproducibility workflow 是否服务不同产物/目标；
-   发布后 registry/Release 中的字节是否与候选产物一致。

**保留有价值的重复验证**：例如两次独立构建 archive
并比较哈希/内容，是可复现性测试，不是无效重复构建。只清除同一具体发布产物生产路径中没有额外验证价值的重复执行。

## 7. 当前已知实现线索（需 G0 复核）

2026-11-02 抽查本地 checkout：

-   `create-principles-disciple/package.json` 的 `prepack` 与
    `prepublishOnly` 都是 `npm run build && npm run bundle`；需要用实际
    npm 命令和 CI 运行日志证明各发布路径的真实触发次数。
-   `bundle-plugin.mjs` 分组件物化依赖，包含
    plugin、core、host-runtime、pd-cli、console、install-layout、release-manager、codex-adapter，以及可选
    WorkBuddy
    adapter。代码注释说明其中一些边界有真实模块解析/宿主原因；`install-layout`
    无 runtime dependency，但仍通过 `npm ci` 验证 release lock。
-   `release-reproducibility-full.yml` 有两次独立 archive build +
    compare 的路径，这是可复现性验证，不能直接删除。
-   `publish-npm.yml`、`publish-preflight.yml`、`release-metadata.yml`、`release-reproducibility*.yml`、`companion-release.yml`
    有不同职责线索。多个 workflow 文件或 build
    命令本身不构成过度设计证据。

以上事实来自本地 `HEAD@68537c19` 抽查；所选发行关键文件在当时本地
`origin/main` 跟踪引用中未见差异，但没有 fetch，必须在 G0
最终基线上重新核实。

## 8. 过度设计判定矩阵

  ---------------------------------------------------------------------------------------------------
  候选发现                可判定为过度设计的证据                              不能仅凭
  ----------------------- --------------------------------------------------- -----------------------
  重复依赖                实际物理副本可减少，解析/peer/native/host 语义等价  lockfile 同名同版本

  重复构建                同一具体产物无额外验证价值地被重复生产              workflow 中多次出现
                                                                              build

  双份 Release Manager    物理代码/依赖重复且职责可复用，无独立生命周期价值   目录名称相似

  多套链接 helper         调用方语义一致，合并后安全和兼容不变                函数数量多

  状态冗余                无写入者/读取者/外部兼容消费者                      状态名称多

  多重完整性检查          保护对象、威胁和信任层完全相同，确属重复            都涉及 hash/manifest

  复杂 CI                 重复执行相同任务且无额外覆盖/信任/可复现性价值      workflow 数量多

  备份代数                超出产品恢复要求，且有经批准的替代恢复方案          备份占空间
  ---------------------------------------------------------------------------------------------------

## 9. 复杂度变更记录

每个 PR 必须记录：

  维度                变更前   变更后   净变化   证据/收益
  ------------------- -------- -------- -------- -----------
  独立模块/包                                    
  生产依赖/物理副本                              
  持久化状态                                     
  配置/开关                                      
  跨包接口                                       
  发布步骤/构建次数                              
  runtime 文件/字节                              
  测试覆盖/运行成本                              

可靠性修复可以增加有界复杂度，但必须对应已证实的风险降低；不能仅用"未来可能有用"作为理由。

## 10. 实施顺序

1.  G0 Reality Audit 和发布链路图；
2.  G1 更新可靠性 P0；
3.  G2 已证明无用的载荷过滤；
4.  G3 构建/打包重复清理（保留可复现性双构建）；
5.  G3 可证明等价的依赖链接/状态逻辑合并；
6.  最后才评估跨组件共享依赖布局。

共享依赖布局风险高于死代码/工件裁剪，必须单独实施、单独验证，不与多个高风险改动捆绑。

## 11. 非目标

-   不引入通用 Release Framework；
-   不为减少模块数而制造巨型文件；
-   不强制所有组件共享 node_modules；
-   不删除有独立威胁覆盖的重复校验；
-   不把可复现性测试当作冗余；
-   不为"架构现代化"全面更换工具；
-   不整理无关业务包。
