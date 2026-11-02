# SPEC-PD-RELEASE-FOOTPRINT-001

## PD 发行产物与安装体积治理规范

-   版本：v1.2
-   所属总规范：SPEC-PD-RELEASE-DELIVERY-001
-   优先级：P1
-   原则：先测量、再分类、后裁剪；任何减量不得破坏运行、安全、诊断或开发者
    API
-   v1.2 变更：仅版本/引用一致性修订（内容维持 v1.1；本阶段为可靠性
    优先，全量测量在 G2 启动时执行）。G0 已重测的关键基线更新见
    `SPEC-V1.2-REVISION-NOTES.md`（单资产 162 MiB、~/.pd 1.61 GiB
    实测等）。

## 1. 目标与体积口径

必须分别统计：

1.  npm tarball 压缩体积；
2.  GitHub Release asset 压缩体积；
3.  解包后的 payload 体积；
4.  `~/.pd/runtime` 逻辑大小；
5.  文件系统实际占用；
6.  bootstrap/executor 占用；
7.  备份代数和升级峰值占用；
8.  整个 `~/.pd` 总占用；
9.  GitHub Release 历史资产总量；
10. GitHub Actions artifact / cache（如本任务会影响）的占用与保留期。

不同口径不能互相替代。每项数字必须标注压缩/解压、逻辑/实占、是否包含备份/缓存。

## 2. 历史审计基线（只作线索，不作当前目标）

2026-11-01 的只读审计报告曾记录以下测量：

  -----------------------------------------------------------------------------------------
  指标                                      历史记录 使用限制
  --------------------- ---------------------------- --------------------------------------
  `~/.pd/runtime`                        约 812.9 MB 必须重测；报告另记磁盘实占约 1.02 GiB
  逻辑大小                                           

  runtime + bootstrap                    约 911.5 MB 按历史报告口径；不可与实占数直接相加

  整个 `~/.pd`                            约 2.28 GB 可能包含备份/其他状态，必须拆分

  runtime 文件数                             132,078 历史实测

  runtime 目录数                              12,974 "约 13,000"可能来自目录数，不是文件数

  PD 自有载荷                               约 27 MB 历史分类结果，需重新分类

  第三方 node_modules                      约 786 MB 报告称被物化到 9
                                                     个组件目录；并不意味着 9 份都可合并

  非执行候选内容                         约 515.9 MB 报告分类：类型声明约 227.5
                                                     MB、sourcemap 约 182 MB、SQLite C
                                                     源码约 85.9 MB；各分类边界和总量须重算

  GitHub Release assets  267 个，合计 54,255,514,021 历史累计存量，不等于单次发布大小
                                   B（约 50.53 GiB） 

  单个最新平台/ABI 资产              约 161--168 MiB 历史记录；不同平台/ABI 不同

  Console UI / CSS                        约 74.4 MB 历史报告线索；须确认其是否进入正式
  构建链                                             runtime 以及是否有用户机消费者
  -----------------------------------------------------------------------------------------

以上均为
**HISTORICAL_MEASUREMENT**，不是当前事实或必须达到的优化承诺。G0
必须重新测量并保存原始数据、脚本、commit、平台和统计口径。

## 3. 本次代码抽查中已确认的载荷线索

在 2026-11-02 本地 checkout `HEAD@68537c19` 抽查：

-   `bundle-plugin.mjs` 在 self-contained 模式下对
    plugin、core、host-runtime、pd-cli、console、install-layout、release-manager、codex-adapter
    分别执行依赖物化；WorkBuddy adapter 存在时再执行一份。
-   `install-layout` 注释明确说明它没有 runtime dependencies，但仍运行
    `npm ci` 以验证提交的 release lock。
-   插件、Codex、WorkBuddy、Release Manager
    的隔离依赖有明确代码注释/加载边界线索，不能按"重复目录"直接合并。
-   `create-principles-disciple/package.json` 中 `prepack` 与
    `prepublishOnly` 当前都声明
    `npm run build && npm run bundle`。这证明脚本内容相同，不单独证明每条真实发布路径重复执行了两次。
-   `sqlite-prebuild-pruning.mjs` 是已有原生依赖裁剪机制；历史报告称约
    99.5 MiB 的旧问题已解决。本轮不重新设计它，除非 G0 发现回归。
-   历史审计把 Lab/Examiner 发行内容测得约 0.64 MB / 21 文件，已列为 P3
    冻结区。

历史审计另标记两个 adapter 相关载荷约 181 MB、Release Manager 约 92 MB
为待动态解析/消费者探针确认的候选区域；原始 JSON 的聚合口径须在 G0
重读。不得据此直接裁剪。

以上仅对抽查 checkout 负责；G0 必须在最终实现基线上重核。

## 4. 测量基线

每个平台/架构/Node ABI 分别记录：

  ---------------------------------------------------------------------------
  类别                                指标
  ----------------------------------- ---------------------------------------
  npm                                 tarball
                                      bytes、文件数、文件类型、最大文件

  Release                             asset bytes、解压 bytes、asset 文件数

  Payload                             总 bytes、总文件数、按组件 bytes/文件数

  Runtime                             逻辑 bytes、磁盘实占、regular
                                      files、symlink/junction、directories

  Bootstrap                           executor bytes、文件数、依赖包数

  Backup                              每代 bytes、保留代数、升级峰值空间

  Build                               build/pack/verify/publish
                                      各阶段耗时和调用次数

  Dependencies                        每组件 production
                                      graph、包路径、版本、peer
                                      context、物理副本、文件 hash

  Native                              原生模块数量、平台/ABI
                                      分布、真实加载结果

  Release history                     资产数、总
                                      bytes、按平台/ABI/版本/代次分布、当前
                                      metadata 引用情况
  ---------------------------------------------------------------------------

所有结果记录 commit SHA、OS/架构、Node/npm 版本、ABI、lockfile
hash、构建命令、环境、输出路径、脚本版本、缓存状态和是否干净环境。

### 测量规则

-   在隔离 staging 和临时安装目录执行。
-   不把用户缓存算作产品 payload。
-   逻辑大小与磁盘实占分开。
-   regular file、symlink/junction、directory 分开计数。
-   hardlink 按逻辑路径与实际文件身份分别统计。
-   依赖统计解析 lockfile
    的真实安装路径和版本；物理重复需通过文件路径/hash/文件 ID 证明。
-   原始 JSON/CSV 与统计脚本一并保存，保证可重复。

## 5. 载荷分类

  -----------------------------------------------------------------------------------------------------
  类别                    定义                                             默认策略
  ----------------------- ------------------------------------------------ ----------------------------
  Runtime-required        Node 执行、动态加载或产品运行必需                保留

  Native-required         当前平台/ABI 必需的原生模块                      精确保留

  Runtime-metadata        manifest、schema、配置、许可证等运行时读取内容   逐项确认后保留

  Public API type         npm 下游开发者需要的类型声明                     对外包保留；内部 runtime
                                                                           单独评估

  Source map              调试/诊断使用                                    评估是否移至独立调试产物

  Source code             运行时不加载的源码                               有消费者证据后可裁剪

  Test fixture            测试数据/测试代码                                不进入生产 payload

  Build tool              编译器、打包器、CSS 构建链等                     默认不进入正式用户 runtime

  Documentation           用户需要的文档                                   按产品交付需要保留

  Unclassified            用途不明                                         禁止自动删除，先追踪消费者
  -----------------------------------------------------------------------------------------------------

静态 import 扫描不能单独作为删除依据。必须考虑动态
import、require.resolve、package
exports、反射加载、插件发现、运行时读取、原生模块和宿主注入。

## 6. 开发工件与 Console UI 构建链

正式用户安装是产品运行环境，不是开发工作区。默认策略：

-   UI、CSS 和静态资源在开发/CI 构建；
-   正式 runtime 不保留用户机重建 UI 所需的构建链；
-   只有 G0 找到明确受支持的用户机重构建/定制流程，才保留对应依赖。

可评估裁剪 `.d.ts`、`.d.ts.map`、`.map`、native addon C/C++
源码、测试/fixture/benchmark、开发服务器和 CSS
构建工具，但必须逐项确认：

-   npm `exports` / `types` / `typesVersions`；
-   runtime 是否读取源码、模板或 JSON；
-   用户机是否有受支持的构建命令；
-   崩溃诊断是否依赖 source map；
-   native addon 是否需要源码 fallback；
-   npm 对外包与内部 runtime payload 是否使用不同文件集合。

不能误删对外 npm API 类型。内部 payload 与 npm tarball
允许采用不同裁剪规则，但必须分别验收。

## 7. 重复依赖治理

### 7.1 必须先证明物理重复

lockfile 同包名/版本重复，不等于安装目录有同样大小的重复字节。必须比较：

-   package、版本、安装路径、peer dependency context、平台条件；
-   实际文件 hash 和物理占用；
-   每个组件运行时模块解析路径；
-   版本冲突、native ABI、宿主边界；
-   Windows junction / Linux/macOS symlink 的安全和升级行为；
-   npm 单包安装与 self-contained 安装的差异。

### 7.2 优先级

1.  删除已证明不需要的依赖；
2.  复用当前已有的共享能力；
3.  对版本、peer、ABI、宿主解析语义完全兼容的依赖评估共享；
4.  如果共享破坏隔离、回滚或模块解析，则保留独立副本。

不要因为有 9 个 `npm ci` 就认定存在 9 份无意义重复。特别是
`install-layout` 的 `npm ci` 还承担 lock 一致性验证；插件和不同 adapter
的依赖隔离有已记录的宿主加载原因。每项都必须独立裁定。

## 8. 构建、打包与发布去重

G0 必须建立真实调用图，分别检查：

-   `prepack`、`prepublishOnly`、`prepare`；
-   显式 build/bundle；
-   `npm pack --dry-run`；
-   publish action 是否重新 pack；
-   reusable workflow、composite action 和多个 job 是否各自构建；
-   Release metadata 与 npm release 是否产出不同目标；
-   多平台/ABI 是否本来就需要独立资产。

目标是：**同一具体产物不做无价值的重复构建，验证与发布的产物身份可证明一致。**

不得删除为可复现性而执行的独立双构建/比较。例如构建两份 archive
并比较字节，是验证构建可复现性的测试，不应因"build 两次"被清理。

不得只看 workflow 中出现多个 `npm run build` 就判定重复。也不得直接删除
lifecycle 脚本；必须验证本地 `npm pack`、CI dry-run 和真实 publish
的生命周期行为。

## 9. GitHub Release / CI 历史资产保留

G0 必须区分：

-   正式 GitHub Release assets；
-   TUF metadata 当前引用的 targets；
-   npm 版本包；
-   GitHub Actions artifacts；
-   Actions cache；
-   临时 staging 和构建输出。

策略要求：

-   先盘点资产和 metadata 引用关系；
-   保留当前受支持版本升级所需资产和必要回滚资产；
-   不删除 metadata 仍引用的资产；
-   不在本任务中自动清理历史 Release；
-   给出按版本、平台/ABI、受支持升级窗口和回滚需要制定的保留建议；
-   任何历史资产删除都需 Owner 单独授权，并有恢复/审计方案。

## 10. 安全约束

不得为减量删除或弱化：

-   TUF metadata、签名和 trust root；
-   版本/过期策略；
-   asset SHA256 / registry integrity；
-   payload manifest；
-   platform/arch/ABI 匹配；
-   路径安全检查；
-   provenance（适用时）；
-   安装后真实运行 smoke test。

若改变 manifest 生成/验证方式，必须证明文件集合、摘要覆盖和 fail-closed
行为不变。

## 11. 量化验收

优化前后使用相同环境、版本、平台/ABI 和安装步骤比较：

  指标                                      Baseline   Candidate   差异
  --------------------------------------- ---------- ----------- ------
  npm tarball bytes                                              
  Release asset bytes                                            
  unpacked payload bytes                                         
  runtime logical / disk bytes                                   
  runtime regular files                                          
  symlink/junction / directories                                 
  bootstrap bytes/files                                          
  duplicate physical bytes                                       
  historical Release assets count/bytes                          
  clean install time                                             
  upgrade time                                                   
  build/pack/verify time                                         
  peak disk requirement                                          

G0
之后再定具体目标，不用历史估算承诺固定压缩率。已证明无用的工件应从相应
payload 移除；不能安全减量的内容必须说明原因。

## 12. 测试要求

-   对裁剪前后文件集合做 diff。
-   对裁剪文件做动态加载/读取追踪或消费者证明。
-   依赖共享必须做真实模块解析、版本断言和宿主加载。
-   测试全新安装、升级、回滚、Console、CLI 和正式支持的宿主。
-   验证 native addon 加载。
-   验证 TUF/hash/manifest 对篡改资产仍 fail-closed。
-   测量升级峰值磁盘和备份占用。
-   验证清理不删除唯一恢复副本。

## 13. 非目标

-   不为数字好看删除诊断材料；
-   不强制所有组件共用一个全局 node_modules；
-   不引入不透明压缩/运行时解压系统来减少文件数；
-   不更换包管理器或构建系统，除非另有强证据和独立迁移审批；
-   不触碰 P3 冻结区和与发布无直接关系的业务载荷。
