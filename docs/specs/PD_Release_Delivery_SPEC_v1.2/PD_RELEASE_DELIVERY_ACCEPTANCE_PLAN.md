# PD_RELEASE_DELIVERY_ACCEPTANCE_PLAN

## PD 发布、安装、更新与恢复端到端验收计划

-   版本：v1.2
-   所属总规范：SPEC-PD-RELEASE-DELIVERY-001
-   原则：真实产物、真实平台、真实浏览器；隔离测试，不触碰生产安装
-   v1.2 变更：§7.1 新增 G1 故障注入场景 F-19..F-33（来源
    PRI-1069 / PRI-1070）

## 1. 验收目标

证明：

-   发布产物与已验证产物身份一致；
-   安装包只含产品运行/交付真正需要的内容；
-   全新安装、升级、失败和恢复可靠；
-   事务状态与磁盘真实状态一致；
-   Console、CLI 和正式支持的宿主正常工作；
-   信任与完整性机制没有退化；
-   体积、文件数、依赖和耗时收益可复现。

## 2. 验收前提

每轮记录 commit SHA、OS/版本/架构、Node/npm 版本和 ABI、发行
cohort、lockfile hash、构建命令、artifact
SHA、安装前后快照、测试数据、日志和浏览器版本。

测试只能在临时目录、隔离用户配置和可销毁 VM/runner 执行。不得把真实
`~/.pd` 当测试目录。

## 3. 平台与测试分层

先从当前发布配置读取正式支持矩阵，不得凭记忆补齐。

### Tier A --- 每个正式支持平台/ABI 必测

-   安装包可下载/校验/解包；
-   原生模块加载；
-   全新安装 smoke；
-   Console、CLI 和适用宿主启动；
-   更新成功 smoke；
-   安装后文件/体积基线。

### Tier B --- 平台语义测试

-   Windows：原生模块加载、进程退出、目录替换/恢复、junction；
-   至少一个正式支持的 POSIX 平台：rename、权限、进程退出、恢复；
-   macOS/Linux 若代码路径或文件系统语义不同，增加对应测试。

### Tier C --- 逻辑故障注入

同一事务逻辑可在一个代表性平台集中执行全套故障注入；对平台特有的文件系统/ABI行为在对应平台补测。只有当行为确实随
ABI 或平台变化时才扩展全矩阵，避免无价值地重复高成本测试。

## 4. Release Pipeline 验收

### 4.1 构建和打包

-   固定 commit、cohort 和每个平台/ABI 的目标产物；
-   记录 npm lifecycle 和 workflow/action 的真实触发次数；
-   区分生产构建与可复现性双构建；
-   证明同一具体产物没有无价值的重复生产；
-   保留用于复现性验证的独立双构建。

### 4.2 产物身份

-   生成候选 tarball/asset 并计算 hash；
-   对候选产物执行内容、manifest、签名、平台/ABI 和 smoke 验证；
-   发布路径必须证明发布的字节与候选产物相同；
-   若 npm 工具链会重新 pack，必须通过实际 npm lifecycle 实验和 registry
    integrity/下载后 hash 证明等价，不能只在文档中声称同一产物；
-   记录 provenance/签名/元数据与产物的对应关系。

### 4.3 发布负向测试

-   资产被修改；
-   manifest 缺文件/多文件；
-   hash 不匹配；
-   错误 platform/arch/ABI；
-   错误 cohort；
-   签名或信任元数据无效/过期；
-   组件版本不一致；
-   publish job 使用未经验证的重建产物。

所有场景必须 fail-closed。

## 5. 全新安装验收

每个平台/ABI Tier A：

1.  在干净临时用户环境安装；
2.  核验目录结构和文件 manifest；
3.  核验组件依赖解析路径；
4.  加载原生模块；
5.  启动 Console 并检查 health；
6.  核验 health 的实例身份、版本和 auth posture；
7.  执行 CLI 版本、诊断和核心命令；
8.  执行正式支持宿主的安装/发现/加载 smoke；
9.  进程重启后复验（只有产品依赖 OS 启动集成时才要求完整系统重启）；
10. 记录安装时间、磁盘占用、文件数和日志。

## 6. 更新成功验收

至少覆盖：

-   当前正式支持的旧版本升级到目标版本；
-   跨版本升级（按当前支持策略选代表性起点）；
-   同版本重复更新/目标版本已安装；
-   慢网络和下载中断；
-   hash/签名/metadata/manifest 失败；
-   错误 ABI；
-   磁盘空间不足和权限不足；
-   Console 正在运行；
-   更新后 Console、CLI、宿主正常。

成功条件：active record 指向目标版本、目标目录物理完整、journal
确认成功、health
实例身份匹配、关键用户配置/数据保留、上一版本备份按策略保留。

## 7. 失败与恢复故障注入

每个场景检查用户可见状态、journal、active
record、新旧目录、备份目录、进程退出、恢复列表、重启后可恢复性，以及是否误报成功。

  --------------------------------------------------------------------------------------
  ID                      故障点                  预期结果
  ----------------------- ----------------------- --------------------------------------
  F-01                    下载前/下载中断         原安装不变，可安全重试

  F-02                    hash/签名/manifest 失败 拒绝安装，原安装可用

  F-03                    staging 解包中断        staging 可识别，原安装不变

  F-04                    备份第一步失败          原安装不变，事务明确失败

  F-05                    备份第二步/部分成功     已移动部分准确识别并恢复

  F-06                    candidate 部署中断      原版本仍可恢复

  F-07                    child 启动失败          不误判健康，安全恢复

  F-08                    端口冲突/伪造 200 JSON  非本次实例响应被拒绝

  F-09                    HTTP 502/超时           正确分类，child 被 join，恢复安全

  F-10                    child 忽略优雅终止      有界强制终止并等待
                                                  exit；未确认退出不得破坏目录

  F-11                    原生模块/目录占用       按目标平台已验证方式安全处理

  F-12                    active record           依据物理状态恢复，不误报
                          写入前/后崩溃           

  F-13                    activated/confirmed     状态与物理安装重新协调
                          窗口崩溃                

  F-14                    回滚中途 EPERM/权限拒绝 保留备份，进入可见的恢复待处理状态

  F-15                    备份缺失/损坏           明确无法自动恢复，不伪装成功

  F-16                    terminal failed         必须出现在恢复 UI/API
                          但目录残缺              

  F-17                    旧 Console 仍运行       不产生错误响应者或破坏仍被使用的目录

  F-18                    磁盘空间不足            预检拒绝或安全退出，不破坏旧版本
  --------------------------------------------------------------------------------------

### 7.1 G1 补充场景（v1.2 新增，来源 PRI-1069/1070）

  --------------------------------------------------------------------------------------
  ID                      故障点                  预期结果
  ----------------------- ----------------------- --------------------------------------
  F-19                    探针误命中其他          响应身份判定失败；attempt 级诊断
                          Console/其他本地服务    记录 PID/端口/HTTP 状态/body 形状；
                                                  fail-closed，不误判健康

  F-20                    HTTP 502 且响应者       诊断保持 UNKNOWN 归因；记录观测
                          身份未知                事实；不猜测为 PD/代理

  F-21                    子进程忽略 SIGTERM      有界超时后 SIGKILL；仍等待并确认
                                                  exit 事件；记录 signal/退出码

  F-22                    SIGKILL 后仍未确认      拒绝执行破坏性目录操作；进入
                          退出（join 超时）        恢复待处理状态；记录 PID/超时

  F-23                    进程未退出时禁止        破坏性目录操作前的退出确认
                          破坏性目录操作          守卫被负向验证（回退守卫→测试红）

  F-24                    回滚第一步（ext）       分树结果准确表达；runtime 树
                          失败                    状态不受影响；材料保留

  F-25                    回滚第二步（runtime）   ext 已归位不被撤销；runtime 失败
                          失败                    被单独暴露；备份保留；不写
                                                  rolled_back

  F-26                    Extension 恢复成功但    结果=部分恢复（非 rolled_back
                          Runtime 恢复失败        非 failed-success）；可诊断可重试

  F-27                    Runtime 恢复成功但      同 F-26 对称；分树结果准确
                          Extension 恢复失败      

  F-28                    回滚中途 EPERM（含      不误报成功；失败代际与备份均
                          加载中 .node 实锁）     保留；明确 broken/needsRecovery
                                                  状态与恢复指引

  F-29                    回滚中途 EBUSY          同 F-28；不破坏唯一副本

  F-30                    active record 写入      两窗口分别注入；恢复决策依据
                          前/后崩溃               物理状态而非仅 journal

  F-31                    journal 与物理目录      状态 API/恢复列表显示真实物理
                          不一致                  状态；不单凭 terminal 状态跳过

  F-32                    terminal failed 但      恢复 UI/API 可见（needsRecovery
                          恢复目录残缺            不因终态被跳过）

  F-33                    旧版本 Runtime 执行     executor 协议兼容；旧版验证
                          更新（跨版本兼容）      逻辑运行新版资产的 preflight；
                                                  失败路径仍走安全回滚
  --------------------------------------------------------------------------------------

## 8. Health Probe 验收

-   readiness 与本次 child 绑定；
-   实例 nonce/ID 一致；
-   版本和 auth posture 符合预期；
-   错误身份被拒绝；
-   其他进程返回 200/JSON 被拒绝；
-   child 存活但另一个进程响应时被拒绝；
-   child 提前退出被识别；
-   502、超时、非 JSON、错误 schema 分类明确；
-   测试结束没有孤儿 child。

## 9. 体积和性能验收

同环境、同版本策略、同平台/ABI 比较：

  指标                                    Baseline   Candidate   差异
  ------------------------------------- ---------- ----------- ------
  npm tarball bytes                                            
  Release asset bytes                                          
  unpacked payload bytes                                       
  runtime logical / disk bytes                                 
  runtime regular files                                        
  symlink/junction / directories                               
  bootstrap bytes/files                                        
  duplicate physical bytes                                     
  GitHub Release history assets/bytes                          
  clean install time                                           
  upgrade time                                                 
  build/pack/verify time                                       
  peak disk requirement                                        

每个平台/ABI 单独报告，不得只展示最小结果。

## 10. 宿主与产品流程

按正式支持矩阵验证：

-   Console：认证、健康、更新检查、更新状态、恢复状态；
-   CLI：版本、诊断、核心命令；
-   OpenClaw plugin：加载、关键命令/工具和配置；
-   Codex adapter：模块解析、宿主发现、关键工作流；
-   WorkBuddy adapter：模块解析、宿主加载、关键工作流；
-   Core / Host Runtime：关键入口和依赖解析；
-   用户配置、数据、权限不被更新覆盖。

Console
更新/恢复关键流程必须有真实浏览器验收，保存截图、网络请求和服务日志。Tier
A 其他平台至少执行启动和关键页面 smoke；不要求所有平台重复完整 UI
故障注入。

## 11. 安全回归

-   TUF metadata 篡改；
-   签名无效、过期、版本回滚；
-   asset hash / payload manifest 不匹配；
-   路径穿越；
-   恶意 symlink/junction；
-   错误平台/ABI；
-   未授权恢复；
-   并发更新；
-   transaction ID 冲突；
-   active record 篡改或目录错配。

拒绝操作必须 fail-closed，且不能破坏已有有效安装。

## 12. CI / Release Gate

-   P0 故障注入测试必须接入真实发布入口；
-   从实际调用者 workflow 的 `needs` / reusable workflow / composite
    action 追踪发布 job，证明它等待 Gate 成功；
-   reusable workflow 自身的历史 run 不足以证明调用者发布链执行过它；
-   skipped、条件未触发、continue-on-error 或允许失败不能算通过；
-   Windows 特有语义测试必须运行在真实 Windows runner；
-   其他平台执行对应 Tier A smoke；
-   必须有负向验证：回退关键保护时 Gate 会失败。

## 13. 最终裁定

  ------------------------------------------------------------------------------------------------------
  裁定                                条件
  ----------------------------------- ------------------------------------------------------------------
  PASS                                P0、支持平台矩阵、产品流程、安全和发布 Gate 全通过

  PASS_WITH_LIMITATIONS               非核心限制有证据、责任人和计划，且不影响安装/更新安全

  BLOCKED                             P0
                                      不通过、恢复不可靠、身份探针不可信、安全链降级或真实产品流程失败
  ------------------------------------------------------------------------------------------------------

CI 全绿不能覆盖真实浏览器/平台失败；测试文件存在不能替代实际运行记录。

## 14. 最终交付包

-   优化前后基线；
-   release artifact hashes / registry integrity；
-   各平台安装/升级/回滚日志；
-   故障注入结果；
-   Console 浏览器验收证据；
-   宿主兼容性结果；
-   安全负向测试；
-   Release 历史资产保留策略建议；
-   未解决限制；
-   PR/commit 索引；
-   Owner 最终裁定材料。

## 15. 禁止事项

-   不在生产机器故障注入；
-   不删除真实用户备份或历史 Release 资产；
-   不在未授权情况下合并、发布或部署；
-   不以模拟测试替代 Windows 原生模块实验；
-   不以静态扫描替代真实运行依赖验证；
-   不以体积下降为由接受功能、数据或安全退化。
