---
"create-principles-disciple": patch
---

修复 #2505 引入的 Windows 路径空格回归：安装器不再把所有命令都交给 cmd.exe，只有 `codex` 这类裸 shim 才走 shell，`process.execPath`（如 `D:\Program Files\nodejs\node.exe`）改为直接 spawn，Codex 的 PLUGIN_DATA 运行时可正常按载荷 pin 落地。

- `codex-host-installer.ts`：新增 shell 判定——裸命令名走 shell（`.cmd`/`.ps1` shim 需要），绝对路径或含分隔符的可执行路径直接 `spawnSync(file, args)`，避免命令字符串被空格截断。
- `installer.ts`：`Install summary:` 的非 Codex 宿主改用规范运行时的布局（`<runtimeDir>/<component>/package.json`），不再把 OpenClaw / WorkBuddy 误读成 `runtime not verified`。
- 新增回归测试：真实 spawn 含空格的 node 路径并断言子进程收到的完整 argv；同时断言裸 `codex` shim 仍能被 shell 解析。
