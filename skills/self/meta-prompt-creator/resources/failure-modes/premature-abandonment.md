# F9: 过早放弃 (Premature Abandonment)

**一句话**：模型遇到一次失败就标记 blocked 或停止工作，没有尝试替代方案。

**怎么判断正在发生**：
- 失败后立即报告 blocked 而不是尝试不同方法
- 连续报 blocked 但每次失败原因不同——说明没有真正分析问题
- "这做不了"作为结论而非"这做不了，但我可以尝试 X"
- 一次工具调用失败就放弃整个任务

**为什么会发生**（根因）：
- 缺少 blocked 的精确阈值——"multiple times" 模型理解为 2 次
- 没有要求尝试不同方法——模型用相同参数重试 2 次后放弃
- 缺少"什么不是 blocked"的列表——模型把"难"和"不确定"当作 blocked
- Steering prompt 的 Blocked Audit 不够具体

**关联原则**：P3（数字阈值）

**防御方法**：
1. Blocked 三条件缺一不可：≥3 连续 turn + 尝试了不同方法 + 真正无法继续
2. 必须列出"什么不是 blocked"——"hard" / "uncertain" / "slow" / "need more info"
3. 数字阈值精确化——"3 consecutive turns with same blocking condition" 而非 "multiple times"
4. Error message 中的行为约束不能暗示"可以放弃"——"try alternative approach" 而非 "consider giving up"

**反例** → **正例**：
- 反例：`"If you encounter a problem, mark blocked."` → 模型第一次遇到困难就 blocked
- 正例：`"Mark blocked ONLY after 3 consecutive turns with the SAME blocking condition, after trying DIFFERENT approaches. Hard/slow/uncertain ≠ blocked."`

**审查时对照**：rubric-steering-prompt.md 维度 6 Blocked Audit、rubric-error-message.md 维度 2 行为约束
