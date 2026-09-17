# F3: 偷懒完成 (Lazy Completion)

**一句话**：模型用"意图"或"部分进度"代替客观证据来论证任务已完成。

**怎么判断正在发生**：
- complete 操作被过早调用——还没验证就标记完成
- 没有运行测试就声称"测试通过"
- "应该没问题了"、"看起来是对的"作为完成理由
- 预算耗尽后立即标记完成——"没预算了，done"

**为什么会发生**（根因）：
- 缺少 "intent is not evidence" 的显式禁令
- 完成条件太宽松——"实现了核心逻辑"就算完成
- Error message 没有防偷懒禁令——模型用错误作为合理出口
- Steering prompt 缺少 completion audit 三要素（逐项验证 + 证据标准 + 显式禁令）

**关联原则**：P8（证据驱动）、P3（数字阈值）

**防御方法**：
1. Completion audit 中显式列出模型最可能用的偷懒借口，逐条否定
2. Error message 中加入防偷懒禁令——"Do not mark complete because budget exhausted"
3. 证据标准明确化——Evidence = file content/command output/test results
4. "Progress ≠ completion. 80% done ≠ done."

**反例** → **正例**：
- 反例：预算耗尽后模型说 "I've implemented the core logic, marking as complete"——但边界情况一个没做
- 正例：收尾指令 "Summarize what is DONE and VERIFIED. Identify what is NOT DONE and WHY. Do NOT mark complete."

**审查时对照**：rubric-steering-prompt.md 维度 4 Completion Audit、rubric-error-message.md 维度 3 防偷懒禁令
