# AA v0.6 集成执行状态

本文件是当前未完成工作的接续清单，不是验收通过声明。集成分支ai/PRI-1112-aa-delivery-verifier，worktree D:/Code/_worktrees/principles/PRI-1112-aa-delivery-verifier。Owner要求持续推进整个首期SPEC，Deferred能力不擅自实现；单票提交不是停止点。

## 已有代码与验证

- 正式core：prepareAdaptiveIntervention，严格场景、真实身份或受控准入两种来源分开，Native同文复用、必需约束、最终正文完整性、有界重验、失效/未知目标安全剔除。缓存旧revision复活反例已修。
- ActivatedPrinciple携带完整artifactContentSha256，纯resolver计算原始content_json UTF8摘要，metadata-only变更也能识别。
- host-runtime只读重验器已合入，身份/正文/摘要/authority/approvedBy、取消和Reader错误均fail closed；shared与local Reader授权推导一致性修复由Luna在独立worktree推进。
- 回执数据契约已提升到正式core，lab入口转导出轻量package子路径，生产/离线不再各自校验。尚未把journal与新阶段写入实际hook/统一evidence入口。
- PD SDK补齐新版可选currentUserMessage/currentUserMessageId。prompt接线改为优先显式当前输入，空/无效显式值不回退旧历史，缺字段保留旧Native；不等于OpenClaw embedded生产者已修。
- 正常本地before_prompt_build现已接入正式干预核心。显式启用、限定工作区且未过期的单条映射，仅在真实当前准入文本首行匹配场景标记且有宿主消息身份时执行；不要求尚未产生的模型请求ID。复用Native正文、最终正文完整性、返回边界只读重验、失效/超时剔除目标、最终集合再记证据。配置默认关闭，未写入用户安装或生产配置。
- 本批真实入口SQLite测试5项与配置边界8项通过；含既有回归的两文件60项通过，另外6文件61项回归通过；核心/解析55项通过。core、host-runtime、OpenClaw插件构建和所改插件源码lint通过。以上只证明开发代码路径，不证明已安装启用、独立送达或行为改善。
- 独立送达验证器、配置投影、覆盖率统计和本地传输工具已经实现。Node工具66项通过；core原有及新核心/解析测试54项通过，正式回执9项、host重验7项分别通过；不要将重叠回归套件相加宣传。
- 全仓npm run build曾在正式core合入后通过；后续变更需最后一次完整集成构建和适用测试。

## 当前工单前沿

| 工单 | 实际状态 |
|---|---|
| PRI-1106/1107 | 场景与批准范围记录已有；G1补充卡获书面批准，不代表生产启用 |
| PRI-1108 | 正式核心与本地正常hook接线及SQLite集成测试已有；实际宿主正例未验收 |
| PRI-1109 | 正式状态契约已合入，运行journal/ingress接线待做 |
| PRI-1110 | 纯配置身份和来源文档已完成，生效profile自动采集待做 |
| PRI-1111 | SDK、显式当前输入消费、本地正常hook干预已实现；未安装启用，embedded缺消息身份时保持Native |
| PRI-1112 | 独立验证器与普通真实请求捕获已有；原则真实正例未通过 |
| PRI-1113 | 案例判据文档已合入，仍为草案/未完成行为评价校准 |
| PRI-1114 | 生产读模型/真实机会和后续行动关联未完成 |
| PRI-1115 | 纯统计完成，真实生产输入/窗口未接入 |
| PRI-1116/1117 | 适用回归和独立代码审查在推进，不能说整体G1通过 |
| PRI-1118 | 本轮受控正例/对照已执行，均未取得目标原则请求确认，详见下段 |
| PRI-1119/1120/1121 | 未开启真实工作区试用或观察窗口，不能虚报Owner批准、行为收益或观察完成 |
| PRI-1122–1128 | Deferred，保持不实施 |

## 两次获准受控调用（预算已使用）

Owner补充卡允许一次正例及一次Native对照，最多两次本地假模型回合，无生产写入/付费模型/自动重试。

1. .tmp/aa-local-transport-20261105/run-_j5v1576：正例120.438秒外层超时，0HTTP请求、没有callback文件；host exit1。不得记原则送达成功。
2. .tmp/aa-local-transport-20261105/run-4yl3aqvl：Native对照65.453秒正常退出、1HTTP请求并收到固定随机stub回复；没有callback，独立检查nativeInInstructionRole=false/targetInInstructionRole=false。只证明运输链，不证明Native/目标原则注入。

第二次插件采用bundle而非首个未打包源码，构建产物不同且首个未到请求阶段，不能将两者作为公平的行为/性能因果对照。原始目录不改写。尚未执行第三次实际宿主调用。

随后仅用官方plugins inspect --runtime做只读装载诊断（没有Agent/模型回合），在独立复制目录.tmp/aa-controlled/inspect-rowyk0t_中确认插件已import但hookCount=0，明确诊断为缺少plugins.entries.aa-controlled-intervention.hooks.allowConversationAccess=true，因此before_prompt_build注册被阻止。这是本次夹具的权限遗漏；真实PD默认配置和安装器已有该权限。先前关于manifest缺activation声明导致CLI未回调的解释未成立：CLI注册路径没有使用Gateway lazy startup规划，不能保留为已确认根因。原始失败记录不改写，额外实际Agent调用仍须新的有界授权。

## OpenClaw ID调查

已只读核实用户指定D:/Code/openclaw。当前checkout 2026.9.2/63fbea0c；跟踪origin/main f6efdcb8为2026-11-02快照；安装版2026.10.10 commit7dc3350cb9f0不在本地对象库。字段在5d7f6690c5a引入，harness传入admitted identity，embedded helper仍仅prompt/messages。没有发现单独关闭字段的开关；PD已跟进类型和显式文本消费，但没修改OpenClaw仓库/安装。详见PD-AA-OPENCLAW-MESSAGE-IDENTITY-AUDIT.md。

## 下一步执行顺序

1. 合入Luna的shared/local授权推导一致性修复并独立复查；最后构建、回归，保持未知/撤销不可复活。
2. 修正受控fixture的声明和打包、离线验证插件装载/准入；不要消耗新宿主调用直到新的有界实验获准。
3. 明确真实Adapter可用身份与G0来源，不能用实验token假扮宿主原生ID；OpenClaw上游修复应在匹配版本的独立worktree，不改用户旧主checkout或安装。
4. 完成实际hook、journal、配置身份及evidence/read-model接线；验证C01–C09适用正负例，关闭映射后回到Native。
5. G1具证后再申请/执行指定真实工作区的限域G2窗口并按期做G3复盘。一次组件测试不代替真实观察，不能现在声称整个SPEC完成。
