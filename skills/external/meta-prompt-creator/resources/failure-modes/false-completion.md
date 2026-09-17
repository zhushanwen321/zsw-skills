# F6: 假完成 (False Completion)

**一句话**：模型提交了"看起来对"的结果但实际没验证过。

**怎么判断正在发生**：
- 文件被写入但内容来自猜想而非读取——"常见做法"替代了"实际代码"
- 代码修改基于记忆——没有重新 read 文件就改
- 测试结果被假定而非实际运行——"这个改动应该不会影响测试"
- 用户说"看起来实现了"但实际运行失败

**为什么会发生**（根因）：
- System prompt 允许不经验证的推断——没有"验证优于推断"的默认约束
- Steering prompt 缺少 Completion Audit——没有逐项验证需求的要求
- "Intent is not evidence" 禁令缺失——模型认为"我想做"等于"我做完了"
- Completion audit 占比不足——不到全文 20%，模型匆匆略过

**关联原则**：P8（证据驱动）、P5（示例驱动）

**防御方法**：
1. Completion audit 必须占 steering prompt 全文 30%+
2. 三要素齐全：逐项验证 + 证据标准 + 显式禁令
3. 显式禁令列出模型最可能用的偷懒借口，逐条否定
4. "Evidence = file content, command output, OR test results. NOT recollection."
5. Completion audit 的语气必须比其他段落更强——"没有商量余地"

**反例** → **正例**：
- 反例：模型改了一个函数但没运行测试，说 "The fix looks correct, marking as complete"
- 正例：Completion audit 要求 "For each requirement, provide the command output or file content that PROVES completion"

**审查时对照**：rubric-steering-prompt.md 维度 4 Completion Audit
