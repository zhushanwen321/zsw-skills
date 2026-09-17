# F8: 工具链断裂 (Chain Break)

**一句话**：多步操作中，模型跳过依赖的前置步骤直接执行后置步骤。

**怎么判断正在发生**：
- 不先搜索就直接安装——"我猜包名是 X"
- 不先 list 就直接 update——用猜测的 ID 而非实际数据
- 不先 read 就直接 edit——基于记忆修改文件
- 不先验证前置条件就直接执行——跳过"检查"步骤

**为什么会发生**（根因）：
- 前置工具的 description 中缺少"在此之后才能用 X"的交叉引用
- 工具链约束只在"后置工具"中声明，"前置工具"中没有对应确认
- 模型的"效率优化"倾向——跳过它认为不必要的前置步骤
- 主流程约束分散在多个 tool description 中，不突出

**关联原则**：P9（工具链约束）、P10（生命周期结构）

**防御方法**：
1. 在"后置工具"的 description 中显式声明前置依赖——"Use only after X returns results. Do not guess IDs."
2. 三种约束类型都要覆盖：前置条件 + 互斥关系 + 优先级
3. 双向原则（部分场景）：如果 B 必须在 A 之后，A 的 description 可以不需要反向声明。但如果是全局优先级，System Prompt 中也需要声明
4. 高风险工具用生命周期结构——before → during → after，每个阶段的约束不分散

**反例** → **正例**：
- 反例：update tool 的 description 只说 "Update task by ID" → 模型随便猜一个 ID
- 正例：`"Use this tool only after list_items returns the correct item ID. Do not guess IDs based on task names."`

**审查时对照**：rubric-tool-description.md 维度 4 跨工具约束
