# F5: 范围蔓延 (Scope Creep)

**一句话**：模型超出工具的权限范围，做不属于它的操作。

**怎么判断正在发生**：
- 只读工具被用来修改状态——read 工具做了 write 的事
- 查询工具被用来做复杂编排——一个简单查询变成了多步流程的控制器
- 一个工具越权替代另一个工具——update 工具被认为能做 delete
- 模型基于工具名推断能力——"update_goal" 被认为能做 pause/resume

**为什么会发生**（根因）：
- 缺少能力边界声明——"You cannot use this tool to X"
- 工具名称和功能描述让模型产生联想——推断出超出实际范围的操作
- 能力边界没有用白名单式声明——"只能用这个工具做合理的事"模型不知道什么算合理

**关联原则**：P6（能力边界）、P1（行为约束）

**防御方法**：
1. 能力边界用白名单式声明：列出所有"看起来像但实际不是的"操作
2. 验证方法：5 个不同人读工具 name+params 会推断出哪些操作？边界声明覆盖了超出的部分吗？
3. 与反模式区别：反模式 = 在错误场景用对工具，范围蔓延 = 用了工具做它不支持的操作

**反例** → **正例**：
- 反例：`"Use this tool to manage goals."` → 模型认为能 create / update / delete / pause / resume 全部操作
- 正例：`"You cannot use this tool to pause or resume goals. This tool only creates and updates goal text."`

**审查时对照**：rubric-tool-description.md 维度 3 能力边界
