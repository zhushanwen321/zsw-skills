# F11: 人格污染 (Personality Contamination)

**一句话**：能力约束或行为规则被写入 Personality 模板，导致切换风格时意外改变 agent 的功能行为。

**怎么判断正在发生**：
- 用户从 pragmatic 切换到 friendly 后，agent 不再指出代码问题——因为 friendly 模式下 "don't criticize"
- 切换到 "precise" 后 agent 要求每一步确认——因为 precise 模式下写了 "always confirm"
- 切换 personality 后工具使用行为改变——如不再用 Edit 只用 Write
- 两个 personality 的"风格差异"实际上包含了功能差异

**为什么会发生**（根因）：
- Personality 模板中混入了行为约束——如 "Always check the code before suggesting changes"
- Escalation 规则写得太模糊——从"如何表达不同意见"滑到了"什么时候应该表达不同意见"
- 没有正交性检验——修改 personality 后 system prompt 其他部分的行为是否改变？

**关联原则**：P13（人格分离）

**防御方法**：
1. Personality 只定义风格——Values/Tone/Escalation/绝对禁止项，全部是纯风格层面
2. 验证方法：删除所有 personality 规则后，agent 的功能行为会改变吗？会 → 有污染
3. Escalation 必须是"怎么说话"——"We might reconsider" 是风格，"Always verify first" 是功能
4. 绝对禁止项用 "NEVER" 句式但只禁风格——"NEVER curt"（风格）vs "NEVER skip testing"（功能）

**反例** → **正例**：
- 反例：pragmatic personality 中写 "Always check the code before suggesting changes" → 这是功能约束，应在 System Prompt 中
- 正例：pragmatic personality 中写 "You may challenge the user to raise standards, but never condescend. 'This works but has performance issues.'"

**审查时对照**：rubric-personality.md 维度 3 Escalation、维度 4 绝对禁止项
