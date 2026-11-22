# SPEC-PRI-1281-SCHEDULER-LIFECYCLE-RELIABILITY-001

> 第三轮评审整改 SPEC。评审基线 `de21ca9e230e65ecea6e6d57506010e334a5ddab`。
> 范围：`packages/pd-cli/src/services/service-host/scheduler/{macos,linux,windows}.ts`
> 及契约 `contract.ts`、`index.ts`；不更改 CLI/API 外部契约（intervalExplicit 已存在）。

## 1. 状态模型（三平台统一）

三态证据：`POSITIVE`（明确证据）/ `NEGATIVE`（明确不存在）/ `UNKNOWN`（查询失败、
权限、超时、spawn 失败、无法分类输出）。UNKNOWN 永不折叠为成功/停止/不存在。

破坏性操作序列固定：**验证归属 → 读状态 → 执行修改 → 验证后置条件 → 返回结果**。

## 2. 问题与根因（按平台）

### macOS（P0）

| # | 问题 | 根因 |
|---|---|---|
| M1 | `verifyUnloaded` 将所有非零退出码当作"已卸载" | 布尔化 print 结果，权限/超时/未知错误均返回 true |
| M2 | 首次安装无事务回滚：plist 写入后 `launchctl disable` 失败留下 RunAtLoad 可触发注册；状态验证失败留下半注册 | 写文件与钉 disabled 是两步非原子操作，失败路径直接返回 |
| M3 | refresh `wasEnabled = refreshOnly && state.disabled === false` 对未知 disabled 态不拒绝；bootout 成功+bootstrap 失败留下已卸载旧配置且无快照；enabled+unloaded 的注册不重新 bootstrap | 缺少三态门控与"先快照后替换"顺序 |
| M4 | `parseLaunchAgent` 用正则提取首个 Label/ProgramArguments/WorkingDirectory | 注释伪造、嵌套 dict、重复 key、类型错误、多余 action 均可欺骗归属判定 |
| M5 | `print-disabled` 解析未验证真实输出格式与 label 精确匹配 | 行匹配仅 `includes('"label"')` |

### Linux（P0）

| # | 问题 | 根因 |
|---|---|---|
| L1 | `enabledVerdict` 用错误文本黑名单推断 disabled（`!/failed|error|bus/` → disabled） | 黑名单以外的失败文本被误分类为 disabled |
| L2 | 不识别 systemd 254+ `exit 4 + stdout "not-found"` | 只处理 exit 1 stderr 模式 |
| L3 | enable 后置只验 `enabled===true`，未验 `active===true` | 单见证验证 |
| L4 | uninstall 终验只 `systemctl cat .service`，不验 `.timer`，且 files 删除后未复核 | 单 unit 见证 |
| L5 | `unitSetting` 读首个匹配 key，不区分 section、不查重复 ExecStart/多命令/drop-in/同名 unit | 归属证据不完整 |
| L6 | `systemdSettingEscape` 对 Setting 行统一做 `%`+`$` 双重转义 | `WorkingDirectory=`/`Description=` 中 `$` 不被展开，`$$` 留下字面量 |
| L7 | interval 解析仅 ms/s/min；无法解析时用默认 interval 覆盖 | 不支持 h/d/组合表达式；refresh 前未验证可解析 |
| L8 | 首次安装 service 写成功、timer 写失败留半注册不可安全重试 | 无回滚/补齐语义 |

### Windows（P1）

| # | 问题 | 根因 |
|---|---|---|
| W1 | `[int]$info.LastTaskResult` 无法承载 UInt32 高位 HRESULT | int32 溢出 |
| W2 | `execElement` 只读第一个 `<Exec>`，多 Action/非 Exec Action/额外 Exec 不影响归属判定 | Actions 完整性未验证；Principal/UserId 仅取首个 |

## 3. 设计约束

- UNKNOWN 一律 fail-closed：结构化 reason + nextAction + 保留诊断，可安全重试。
- 失败不得丢失原有效注册；回滚失败单独记录，不遮蔽主错误。
- 不得覆盖/删除无法证明属于 PD 的 OS 注册与文件。
- 复用现有 adapter/fileIo/runner 边界与 Fake runner 测试设施；不引入新子系统。
- macOS plist 解析使用已锁定的 `plist@3.1.0`（项目已有依赖，加入 pd-cli deps），不用正则。

## 4. 状态转换（refresh 矩阵）

| 原状态 | install-refresh 预期 |
|---|---|
| enabled+loaded | bootout → 写新定义 → bootstrap → verifyLoaded |
| enabled+unloaded | 写新定义 → bootstrap → verifyLoaded（恢复 loaded） |
| disabled+unloaded | 写新定义，保持 disabled，不 bootstrap |
| disabled+loaded | bootout → 写新定义，保持 disabled |
| enabled unknown | 拒绝（不写文件） |
| loaded unknown | 拒绝破坏性操作 |
| disabled unknown | 拒绝改变状态 |

Linux refresh：显式 interval 优先；未显式则保留已解析值；已注册 interval 不可解析 → **拒绝刷新（不写文件）**。

## 5. 失败处理与回滚

- macOS 首装：先写 plist → 钉 disabled → 验证；任何一步失败 → 删除本次创建的 plist
  （仅限"本次创建"——安装前已存在文件绝不删除）→ 恢复 disable override；回滚失败
  附加在 reason 中，主错误优先。
- Linux 首装：service/timer 任一步失败 → 删除本次创建的文件（仅限无先前注册时）；
  refresh 中原文件恢复（写前快照）。
- Windows：保留 TASK_UPDATE 原位更新、TASK_CREATE 新建；不允许 Unregister→Register。

## 6. 测试矩阵（节选，详见 §指令 6）

- macOS：print 成功/明确 not-found/权限/超时；print-disabled 真实格式 fixture；
  disable 失败回滚、回滚自身失败、uninstall UNKNOWN 保留 plist、bootout 验证失败、
  enabled+unloaded refresh 恢复、bootstrap 失败安全重试、注释/重复/嵌套伪造拒绝。
- Linux：enabled/disabled/not-found/exit4/permission/bus 不可用/spawn；
  enable 后 active=false 拒绝、disable 后 active=true 拒绝、uninstall 双 unit 验证、
  drop-in/多 ExecStart/重复 key 拒绝、`$`/`%` 路径往返、小时/天 interval、
  不可解析 interval 拒绝刷新、半安装回滚、重试幂等。
- Windows：高位 HRESULT/UInt32 边界、多 Actions/非 Exec/额外 Exec/Principal 不符、
  TASK_UPDATE 失败保留旧任务。
- 跨平台：UNKNOWN≠成功、外部注册不覆盖、删除失败不丢配置、幂等重试。

## 7. 验收标准

1. UNKNOWN 永不被报告为成功（对每条 verdict 注入 unreadable → 结果 ok=false 或降级证据）。
2. 外部注册在任何操作下不被覆盖/删除/改造。
3. refresh 失败保留原注册。
4. 部分安装后可安全重试至收敛。
5. 显式 interval 不被静默覆盖；不可解析 interval 拒绝刷新。
6. 所有破坏性操作先归属后状态证据。

## 8. 真实主机验证限制

本机无 systemd user bus（`systemctl --user` 无会话）、无 macOS/Windows 主机。
- Linux/macOS 真机：NOT_VERIFIED，验收步骤见 runbook。
- Windows：以 CI `Test pd-cli (Windows)`（真实 Windows Server）为准。
