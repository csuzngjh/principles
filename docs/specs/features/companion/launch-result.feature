@companion @launch-result
Feature: Companion 解析 pd console open --json 输出契约

  对应 rc-1-treat-as-unknown / cli-1-strict-json:companion 把 CLI 子进程的
  stdout 当不可信输入,逐字段校验后才进入 supervisor;流式部分 JSON 等待更多
  分片,完整但非法的对象必须 fail loud。成功结果还必须携带已验证的
  authenticationMode；该字段只允许 authenticated/no_auth，绝不包含令牌值。

  Background:
    Given companion 的控制台启动输出解析器

  @pri-526 @valid-started
  Scenario: 完整的 started 结果带正整数 serverPid 通过校验
    When 解析包含 status=started port=3100 serverPid=4242 的 JSON 输出
    Then 解析结果的 status 为 started
    And 解析结果的 serverPid 为 4242

  @pri-526 @reused-no-pid
  Scenario: reused 结果不含 serverPid 字段
    When 解析包含 status=reused port=3100 的 JSON 输出
    Then 解析结果的 status 为 reused
    And 解析结果没有 serverPid 字段

  @pri-526 @partial-json
  Scenario: 流式部分 JSON 返回 undefined 等待更多分片
    When 解析片段 "{ \"status\": \"sta"
    Then 解析结果为 undefined

  @pri-526 @invalid-fail-loud
  Scenario: 完整但非法的对象抛出 LaunchResultError
    When 解析不含 status 字段的完整 JSON 对象
    Then 抛出 LaunchResultError

  @pri-526 @plugin-version
  Scenario: 插件 package.json 的 version 字段是更新重启的触发源
    When 解析插件 package.json 内容 {"name":"x","version":"1.202.0"}
    Then 安装版本为 "1.202.0"
    When 解析插件 package.json 内容 "not json"
    Then 安装版本为 undefined
