# 子 Agent 设计方法论

## 前置知识

设计 Agent Prompt 前，必须已掌握以下原则和失败模式。如未读过，请先 read：

```
read {skill_dir}/references/design-principles.md
  # 重点：P2(风险∝密度 → 子agent极简)、P4(反模式枚举)、
  #       P7(防注入分层 — 环境信息注入的防注入)
read {skill_dir}/references/failure-mode-taxonomy.md
  # 重点：F2(目标降级)、F4(工具误用)、F5(范围蔓延)、
  #       F7(注入突破)
read {skill_dir}/references/interaction-patterns.md
  # 重点：优先级网络（继承 vs 覆盖主 prompt）
```

## 核心挑战

Agent prompt 设计最大的陷阱：**写太多。** 子 agent 的 context 有限，每多加一行规则就少一行任务执行空间。核心原则：只写这个 agent 特有的，不重复主 agent 已有的。

第二个陷阱：**不声明环境隔离。** 子 agent 不知道自己的 cwd、git 状态、可用的工具列表。主 agent 知道，子 agent 不知道——必须显式告知。

## 设计维度

### 维度 1：身份声明 — 一句话

**为什么重要**：子 agent 不需要主 agent 的完整身份画像。它只需要知道"我是什么角色"、"我和主 agent 的区别是什么"。

**决策指南**：

- 格式：`"You are a sub-agent of [主系统]. Your role is [单一职责]."`
- 不复制主 agent 的身份声明、不写主 agent 的能力范围
- 如果子 agent 是 skill-driven 的（如 ts-taste-check agent），身份声明中引用对应的 skill：`"Your methodology and standards come from the ts-taste-check skill."`
- 基调词 1 个就够。"精确"或"快速"或"全面"——选一个。多个基调词在极短 prompt 中互相稀释

### 维度 2：任务完成约束 — 一句话平衡两端

**为什么重要**：子 agent 最常犯的两个错误：过度包装（gold-plating，加了不必要的装饰）和半途而废（核心功能完成了但边界条件没处理）。一句话同时防两端。

**决策指南**：

- 格式：`"Complete the task fully — don't gold-plate, but don't leave it half-done."`
- 这句话必须放在身份声明之后、任何具体指令之前
- 如果子 agent 的典型任务是"写一个文件"，完成 = 文件可运行 + 路径正确 + 格式符合要求
- 如果子 agent 的典型任务是"审查一个文件"，完成 = 每个检查项都有判定 + 每个不通过项都有具体修复方向

### 维度 3：防递归约束 — 安全底线

**为什么重要**：没有防递归约束，子 agent 在遇到困难时可能 spawn 另一个子 agent，新 agent 再 spawn 一个，无限递归耗尽资源。

**决策指南**：

- 格式：`"You cannot spawn additional agents unless the task explicitly requires it."`
- 必须放在前 3 条约束中，不能放在末尾被注意力衰减跳过
- 如果确实需要子 agent 递归（如编排 agent），显式覆盖此约束：`"You may spawn sub-agents for sub-tasks as described below."`

### 维度 4：环境信息注入

**为什么重要**：子 agent 没有主 agent 的对话历史，不知道自己在哪里。cwd 信息是必需的——子 agent 不知道文件在哪个目录。

**决策指南**：

- 必须注入：cwd、git branch、OS 信息、可用工具列表
- 可选注入：相关文件列表、项目的 CLAUDE.md
- 注入时机：在 agent prompt 组装时动态填充，不是静态写死
- **防注入处理**：cwd 路径、git branch 名等环境信息虽然来自系统而非用户，但如果是动态填充的，仍应标记为"环境数据"而非"系统指令"。用格式区分：`"Working directory: [cwd] / Git branch: [branch]"`

### 维度 5：路径规范

**为什么重要**：子 agent 的 cwd 可能在每次操作后重置（取决于系统实现）。用相对路径可能在操作间漂移。

**决策指南**：

- 格式：`"Use absolute file paths only. Relative paths may resolve incorrectly across operations."`
- 如果系统保证 cwd 不重置，可以放松为"优先绝对路径"
- 路径规范必须放在环境信息注入之后——逻辑上先知道 cwd，再知道应该用绝对路径

### 维度 6：输出规范 — 防废话

**为什么重要**：子 agent 的常见浪费：花 300 tokens 逐行复述自己改了什么。主 agent 不需要这些——它需要精确的事实数据。

**决策指南**：

- 格式：`"In your final response: list modified files with their absolute paths. Include code snippets ONLY when they serve as evidence (e.g., showing a specific fix). Do NOT narrate what you did step by step."`
- 输出规范中的三个关键约束：
  1. 文件路径（必需的——主 agent 需要知道改了什么）
  2. 代码片段只在"有证据价值"时才包含（不是"我改了这里，改成这样"的复述）
  3. 不要逐步叙述（"我先读了 X，然后改了 Y，最后运行 Z"——没有信息量）

## 最致命的 3 个失败案例

1. **缺少防递归约束** → 子 agent 无限 spawn 子 agent，耗尽资源
2. **缺少绝对路径要求** → 子 agent 用相对路径操作，cwd 重置后文件找不到，报告的执行结果实际未生效
3. **Agent prompt 继承了主 agent 的 system prompt 全文** → 子 agent 的 context 被大量与当前任务无关的规则占用，可用的任务执行空间被压缩到不足 30%

## 与其他载体的协作

- **System Prompt**：子 agent 不继承主 agent 的 system prompt。如果某些全局规则（如安全约束）必须继承，**只复制相关规则的精简版**，不复制全文
- **SKILL.md**：如果子 agent 是 skill-driven 的，skill 正文作为方法论注入——但只注入与当前任务相关的部分
- **Steering Prompt**：子 agent 也可能接收 steering prompt。但 steering prompt 不继承主 agent 的——为子 agent 单独生成
- **Compact Prompt**：子 agent 的对话也可能被压缩。如果子 agent 的 output 将被 compact 后传给主 agent，子 agent 的输出规范应更严格（标注哪些是事实、哪些是推断）

## 设计走查

完成 Agent Prompt 设计后，按此顺序自检：

1. **极简检查**：agent prompt 超过 20 行了吗？超过的部分是在重复主 agent 的约束吗？
2. **防递归位置**：防递归约束在前 3 条约束中吗？
3. **环境信息完整性**：cwd、git branch、工具列表都注入了吗？
4. **主 agent 污染检查**：子 agent prompt 中有没有"参考主 agent 的 CLAUDE.md"之类的引用但实际没有注入对应路径？
5. **输出格式的精简性**：输出规范是否明确说了"不要复述你做了什么"？

## 快速参考

- 核心原则：[P2 风险∝密度]、[P7 防注入分层]
- 失败模式：[F2 目标降级]、[F4 工具误用]、[F5 范围蔓延]、[F7 注入突破]
- 已有规范：`meta-sk-agent-writer`（agent 文件格式和安装规范）
