# 错误信息设计方法论

## 前置知识

设计 Error Message 前，必须已掌握以下原则和失败模式。如未读过，请先 read：

```
read {skill_dir}/references/design-principles.md
  # 重点：P3(数字阈值)、P8(证据驱动)、P10(生命周期结构)
read {skill_dir}/references/failure-mode-taxonomy.md
  # 重点：F3(偷懒完成)、F9(过早放弃)
```

## 核心挑战

Error message 设计最大的陷阱：**只告知错误事实，不引导下一步行为。** 模型看到错误后的反应不是"我知道怎么修复"，而是"我失败了，接下来怎么办"——error message 必须同时回答"怎么办"。

第二个陷阱：**错误消息缺乏防偷懒禁令，模型将错误状态当作完成信号。** 如果 error message 只说"预算耗尽了"而没有显式禁止标记完成，模型会利用错误给它的"合理出口"跳过收尾工作（[F3 偷懒完成]）。

## 设计维度

### 维度 1：事实数据 — 硬数据无情感

**为什么重要**：错误信息的第一段是导航标记。模型需要从正常执行模式切换到错误处理模式。事实数据提供切换的锚点。

**决策指南**：

- 必须包含的信息：
  - 错误类型（工具名 + 失败原因）
  - 当前状态（什么操作失败了 + 影响范围）
  - 已消耗资源（token 数、时间、turn 数）
- 纯声明式，不带情感色彩
  - 好例：`"Budget consumed: 90% (90,000/100,000 tokens)."`
  - 坏例：`"Budget is almost exhausted! Hurry up!"`
- 情感色彩有两个危害：
  1. 给模型压力信号 → 模型可能草率完成任务
  2. 分散注意力 → 模型在思考"为什么情况紧急"而不是"我该做什么"
- 数字阈值必须精确（[P3 数字阈值]）：`"3 consecutive turns"` 而非 `"multiple turns"`

### 维度 2：行为约束 — 该做什么

**为什么重要**：知道了错误事实后，模型需要知道正确的行为是什么。没有行为约束，模型会用训练数据中的通用错误处理策略——往往不合适。

**决策指南**：

- 行为约束必须具体到**操作级别**：
  - 终止性错误（预算耗尽）：该收尾 → 报告进度 + 标识剩余工作
  - 可重试错误（工具超时）：该重试 → 用不同参数或不同方式重试
  - 权限错误：该替换 → 用替代方案完成
- 行为约束的排序：按模型最可能做错的顺序排列，而非按逻辑顺序
- 行为约束后面必须跟"为什么"——模型理解了原因后遵守率更高

### 维度 3：防偷懒禁令 — 不该做什么

**为什么重要**：这是整个 error message 中**最重要的部分**。错误给了模型一个合理的偷懒出口——不阻止它，模型会用错误作为"完成"的理由。

**决策指南**：

- 必须明确列出在错误状态下**不该做的操作**：
  - `"Do not mark complete because budget exhausted."`
  - `"Do not call complete_goal unless actually completed."`
  - `"Do not abandon work without summarizing progress."`
  - `"Do not substitute partial progress for completion."`
- 每条禁令必须和错误类型**精确匹配**。预算耗尽 → 防偷懒完成；工具失败 → 防不重试；权限拒绝 → 防不找替代方案
- 防偷懒禁令的措辞：用 "Do not X because Y" 格式，显式给出"为什么模型会想这样做"
  - 好例：`"Do not mark the task complete because you ran out of budget. Budget exhaustion ≠ task completion."`
  - 这就是防偷懒禁令的核心价值——拆除模型的合理化借口

### 维度 4：收尾指令 — 有序关闭

**为什么重要**：终止性错误后模型突然停止 → 用户不知道进度、不知道剩余工作、不知道下一步该做什么。

**决策指南**：

收尾三步骤（适用于终止性错误如预算耗尽）：

1. `"Summarize current progress — what is DONE and VERIFIED."` — 基于证据，不是基于记忆
2. `"Identify remaining work — what is NOT DONE and WHY."` — 和原始需求逐项对比
3. `"Leave the user with a clear, actionable next step."` — 用户应该能读了下一步描述后直接行动

- 如果错误后有跨模型交接（如 compact 后另一个 agent 接手），收尾指令升级为 [P12 交接framing]
- 收尾指令应放在防偷懒禁令之后——逻辑上：先告诉模型"不要标记完成"（禁令），再告诉它"那应该做什么"（收尾）

## 风险驱动的分级

不同错误类型需要不同的 error message 结构和长度：

| 场景 | 结构 | 长度 | 关键约束 |
|------|------|------|---------|
| 简单工具错误（如参数不合法） | 错误事实 + 下一步建议 | 20-30 词 | 不要说"try again"，说"用正确的参数格式再试" |
| 预算/限制触发 | 事实 + 行为约束 + 防偷懒禁令 + 收尾指令 | 80-100 词 | 防偷懒禁令比重 ≥ 30% |
| 安全/权限拒绝 | 事实 + 拒绝原因 + 替代方案 + 防绕过禁令 | 50-80 词 | 解释"为什么拒绝"防止模型再试 |

## 最致命的 3 个失败案例

1. **缺少防偷懒禁令** → 预算耗尽后模型把 80% 完成标记为 complete（[F3 偷懒完成]）。最典型：模型说"I've implemented the core logic, marking as complete"——但边界情况一个没做
2. **只告知错误不引导行为** → 模型重复同样的错误操作，连续失败多个 turn（[F9 过早放弃]的反面——不放弃但也不改变方法）
3. **错误消息带有情感压力** → "HURRY UP" 信号导致模型跳过验证直接产出，引入更多错误

## 与其他载体的协作

- **Tool Description**：工具的正常约束在 description 中，错误场景的行为引导在 error message 中。两者不重复——如果 error message 中说了"该如何重试"，tool description 不需要再说一次
- **Steering Prompt**：steering prompt 的 completion audit 和 blocked audit 与 error message 的行为约束保持一致。如果 steering prompt 说"after 3 failed turns, mark blocked"，error message 中的行为约束不应是"keep retrying"
- **System Prompt**：错误处理策略中的全局规则（如"遇到错误不要放弃，先重试"）放在 system prompt 中。单个工具的错误行为引导放在 error message 中

## 设计走查

完成 Error Message 设计后，按此顺序自检：

1. **三要素检查**：是否包含事实 + 行为约束 + 防偷懒禁令？
2. **防偷懒禁令的精确性**：每条禁令是否匹配了模型在该错误类型下最可能使用的偷懒借口？
3. **情感净化**：事实数据中是否有 "hurry"、"urgent"、"almost out" 等情感词？
4. **数字阈值**：所有模糊量词（"多次"、"几个"）是否替换为精确数字？
5. **与 steering prompt 的一致性**：如果 steering prompt 中定义了 blocked 阈值，error message 中的行为约束是否与之一致？

## 快速参考

- 核心原则：P3（数字阈值）、P8（证据驱动）、P10（生命周期结构 — 收尾是生命周期的终点）
- 失败模式：F3（偷懒完成）、F9（过早放弃）
- 基本原则：**极简（80-100 词），但必须包含"事实 + 行为约束 + 防偷懒禁令"三要素**
