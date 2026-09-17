# F4: 工具误用 (Tool Misuse)

**一句话**：模型在错误场景使用工具，或跳过必要工具直接走下一步。

**怎么判断正在发生**：
- 操作失败后用错工具重试（如用 Write 重试因为 Edit 失败了）
- 两个功能相似的工具被互换使用（Edit vs Write、Bash vs 专用工具）
- 跳过前置工具直接调后置（不搜索直接安装、不 list 直接 update）
- 用只读查询工具做状态变更

**为什么会发生**（根因）：
- Tool description 没有 "when NOT to use"——反模式缺失
- 工具优先级只在单向声明——从另一边看不到（F12 优先级网络断裂）
- Tool description 写成了功能说明书——模型知道能做什么但不知道什么时候不该做
- 缺少跨 tool 约束——不声明 A 在 B 之后才能用

**关联原则**：P1（行为约束）、P4（反模式枚举）、P6（能力边界）、P9（工具链约束）

**防御方法**：
1. 每个工具 description 必须有反模式列表——按频率排序，每条约 "why the model would misuse"
2. 全局工具优先级规则在 System Prompt 中——确保模型在"看单个 tool description 之前"已知
3. 高风险工具的能力边界用白名单式声明——"You cannot use this tool to X"
4. 前置条件在 description 中显式声明——"Use only after X completes"

**反例** → **正例**：
- 反例：Tool description 只写了 "Use this tool to update task status" → 模型在创建任务时也用这个工具（应该用 create）
- 正例：`"Do not use this tool to create tasks — use create_task instead. This tool only updates existing tasks."`

**审查时对照**：rubric-tool-description.md 维度 2 反模式、维度 4 跨工具约束
