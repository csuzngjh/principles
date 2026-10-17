---
'create-principles-disciple': patch
---

修复装机上「Codex 治理健康」永久降级：console 改用安装布局权威去找 pd-cli 入口。

此前 `CodexGovernanceHealthModel` 用包名解析（`require.resolve('@principles/pd-cli/package.json')`）定位要执行的 CLI，而 console 从未声明这个依赖——装机上它必然抛 `MODULE_NOT_FOUND`，被 `catch { return null }` 压成一个常量 reason `pd_cli_unavailable`，与「运行时真的坏了」无法区分；nextAction 还引导 Owner 去 `npm i -g @principles/pd-cli`，这台机器上既无效也不该做（安装面由 installer/更新链独占）。

现在解析顺序为：安装布局权威 `resolveUpdateLayout()` 给出 `pdCliDir` → 拼 `<pdCliDir>/dist/index.js` → 按实际盘上状态给出可区分原因（入口缺失 / 不可读 / 不是常规文件），nextAction 指向控制台的更新页与 `npx create-principles-disciple`。布局解析不到时才退回工作区依赖图（源码树场景），且该通道不做存在性预检，未构建时由子进程自己报结构化失败。既有 dev 行为与 CLI 调用命令行（`health --host codex --workspace <dir> --json`）均未变。

同一症状的第二处断链：CLI 在报告本身判定「治理未就绪」时按设计以退出码 1 结束（cli-2：未就绪就是可执行信号），而 console 把非零退出直接当作采集失败丢掉。于是在 host 未启用的装机上——退出码恒为 1、stdout 却是一份完整报告——面板显示的仍是采集失败常量，真正的阻断原因（如 `host.codex: disabled`）被淹没。现在非零退出只表示「需要用 stdout 判定」：解析并校验到报告字段就原样返回（未就绪仍如实呈现 ready=false + 阻断原因），拿不到可用报告才降级，并区分 `health_collection_failed`（子进程没能给出输出）与 `report_unusable`（输出了但不符合 --json 契约）。
