@companion @degraded
Feature: Companion 降级路径必须给出结构化原因与下一步

  对应 rc-9-no-silent-fallback:所有失败/降级路径必须携带 reason + nextAction,
  禁止白屏或静默降级。pd-cli 已提供的 nextAction 优先,companion 不发明冲突指引。

  Background:
    Given companion 的降级文案映射

  @pri-526 @reason-copy
  Scenario: 每个降级原因都有标题、描述与下一步动作
    When 查询降级原因 "node_missing" 的文案
    Then 文案包含非空 title 与非空 nextAction
    When 查询降级原因 "pd_not_installed" 的文案
    Then 文案包含非空 title 与非空 nextAction
    When 查询降级原因 "workspace_missing" 的文案
    Then 文案包含非空 title 与非空 nextAction
    When 查询降级原因 "server_crash_loop" 的文案
    Then 文案包含非空 title 与非空 nextAction
    When 查询降级原因 "launch_failed" 的文案
    Then 文案包含非空 title 与非空 nextAction

  @pri-526 @cli-next-action-preferred
  Scenario: launch_failed 时优先使用 pd-cli 给出的 nextAction
    When 查询降级原因 "launch_failed" 的文案且 detail 为 "console_exited_with_code_1"
    And pd-cli 提供的 nextAction 为 "重新运行安装器"
    Then 文案的 nextAction 为 "重新运行安装器"

  @pri-526 @reason-mapping
  Scenario: pd-cli 失败原因映射到 companion 降级原因
    When 映射 pd-cli 原因 "workspace_missing"
    Then 降级原因为 workspace_missing
    When 映射 pd-cli 原因 "console_runtime_not_installed"
    Then 降级原因为 pd_not_installed
    When 映射 pd-cli 原因 "console_exited_with_code_1"
    Then 降级原因为 launch_failed

  @pri-526 @html-escaping
  Scenario: 降级页面内容经过 HTML 转义,详情不可注入标记
    When 用 detail "<img src=x onerror=alert(1)>" 构建降级页面
    Then 页面不包含原始的 "<img src=x"
    And 页面包含转义后的 "&lt;img src=x"
