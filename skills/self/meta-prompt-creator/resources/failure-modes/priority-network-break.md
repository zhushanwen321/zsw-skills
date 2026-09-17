# F12: 优先级网络断裂 (Priority Network Break)

**一句话**：工具间的优先级关系只在单向声明，模型从另一个方向看不到这个关系，导致选错工具。

**怎么判断正在发生**：
- A 的 description 说"优先用 B"，但模型在考虑 A 时（没看到 B 的 description）仍选了 A
- 用 Bash 做 Edit 能做的事——没人告诉模型 Edit 更好
- 两个工具都能完成同一任务时，模型随机选择而非遵循优先级
- 优先级规则只在单个工具的 description 中——模型在"全局决策"时看不到

**为什么会发生**（根因）：
- 工具优先级只在"被替代方"描述中声明——"替代方"没有对应确认
- 缺少双向交叉引用——全局优先级规则必须在 System Prompt 中覆盖
- 模型在一个工具被加载时只看它的 description——不会自动看其他工具的 description

**关联原则**：P1（行为约束）、P9（工具链约束）

**防御方法**：
1. 全局工具优先级规则放在 System Prompt 中——确保模型做"选哪个工具"决策前已知道优先级
2. "在所有其他条件相等的情况下，优先 A 而非 B"——不用单向声明
3. 优先级规则只覆盖"已观测到实际误用"的场景——不凭空拍优先级
4. 双向原则：System Prompt 中声明全局优先级 + 被替代工具 description 中指向替代工具

**反例** → **正例**：
- 反例：只在 Edit 的 description 中写"如果两种方式都能完成，优先用 Edit"——模型在考虑 Write 时看不到这句话
- 正例：System Prompt 中全局声明 "Prefer Edit over Write when both can achieve the change" + Edit description 中补充

**审查时对照**：rubric-system-prompt.md 维度 5 工具使用优先级、rubric-tool-description.md 维度 4 跨工具约束
