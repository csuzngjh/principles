## Pain Signal 修正

之前 `manual_1781264655076_3t1pxkra` 写入到了错误 workspace（D:\Code\principles 而非 D:\.openclaw\workspace）。

**正确的 painId**: `manual_1781265768279_n3w1y68n`（score=82，中文描述，已写入生产工作区）

根因：agent 机械地把 git 操作目录当作 PD workspace，忽略了 CLI 警告。这是一个二次教训——workspace 边界意识不足。
