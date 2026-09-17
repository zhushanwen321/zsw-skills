# F2: 目标降级 (Goal Degradation)

**一句话**：模型悄悄把大目标替换为更容易完成的子集，用"已完成大部分"合理化。

**怎么判断正在发生**：
- 任务只完成核心路径，边界情况和异常处理被忽略
- complete 被调用但用户发现大量未覆盖场景
- 多文件任务只修了最显眼的文件，其他文件被静默跳过
- 用户说 "fix all TypeScript errors" 但模型只修了一个文件的 error 后标记完成

**为什么会发生**（根因）：
- 缺少 Fidelity 约束——"Do not substitute a narrower solution"
- 完成条件只检查"功能可运行"而非"需求全覆盖"
- Steering prompt 没有逐项验证原始需求的要求
- Completion audit 太弱——没说"每个需求独立验证"

**关联原则**：P8（证据驱动）

**防御方法**：
1. Steering prompt 中加入 3 句 Fidelity 约束：禁止偷换→定义对齐→定义方向
2. Completion audit 要求逐项对照原始需求验证（不是凭记忆）
3. 多需求任务要求每个需求独立验证——不允许用 A 完成对冲 B 未完成
4. "An edit is aligned only if it makes the requested final state more true."

**反例** → **正例**：
- 反例：模型修了文件 A 的 bug，用户要求修全部 3 个文件，模型说 "finished implementing the fix"——只覆盖了 1/3
- 正例：逐项报告 "Fixed file A (verified). File B: requires X. File C: pending because Y."

**审查时对照**：rubric-steering-prompt.md 维度 5 Fidelity 约束
