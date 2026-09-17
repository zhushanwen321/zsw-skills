# F1: 规则被忽略 (Rule Ignored)

**一句话**：prompt 中的约束规则被模型完全无视，像不存在一样。

**怎么判断正在发生**：
- 同一条规则在多次对话中反复被破坏
- 模型输出违反明确规则的内容（如在禁止 emoji 的 prompt 中使用 emoji）
- 规则写在 prompt 中但模型行为表明它根本没读

**为什么会发生**（根因）：
- 约束太弱——只说"不要 X"没说后果
- 缺少数字阈值——"不要多次"模型理解为"不要超过 2 次"
- 规则淹没在海量文本中——注意力衰减导致末尾规则被完全忽略（P14 约束衰减）
- 约束和示例不匹配——规则说"不要 X"但示例中恰好出现了类似 X 的行为（P5 示例驱动）

**关联原则**：P1（行为约束）、P2（风险∝密度）、P3（数字阈值）、P5（示例驱动）、P14（约束衰减）

**防御方法**：
1. 每条规则用 "Do not X, because Y" 格式——解释为什么会导致什么后果
2. 数字阈值替换模糊描述——"3 次"不是"多次"
3. 最关键的规则放前 5 条——利用注意力首因效应
4. 限制全局约束 ≤15 条——超过的移入 Tool Description 或 Steering Prompt
5. 正反面示例对齐规则——示例中展示正确和错误两种行为

**反例** → **正例**：
- 反例：`"Be careful with git operations."` → 模型不知道"小心"意味着什么
- 正例：`"Do not stage or commit code unless explicitly asked. Unauthorized commits are a hard failure."`

**审查时对照**：rubric-system-prompt.md 维度 3 全局硬约束
