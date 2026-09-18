# Agent Prompt 审查清单

审查子 Agent Prompt 时按此清单逐项判定。核心原则：只写这个 agent 特有的，不重复主 agent 已有的。每多一行规则就少一行任务执行空间。

> 前置知识：审查前必须已读 patterns/agent-prompt.md 的 6 个设计维度、references/design-principles.md 的 P2/P4/P7、references/failure-mode-taxonomy.md 的 F2/F4/F5/F7、references/interaction-patterns.md 的优先级网络。无此前提的审查 = 凭感觉打分。

## P0 必需检查

缺少任何一项 → 无限递归、文件找不到、任务执行空间被挤压。

### 维度 1：身份声明

- [ ] **身份声明一句话**：`"You are a sub-agent of [主系统]. Your role is [单一职责]."` 不重复主 agent 的完整身份画像。
  - 无此 → 浪费 context，稀释任务焦点
- [ ] **基调词 1 个**：选一个——"精确"或"快速"或"全面"。多个基调词在极短 prompt 中互相稀释。

### 维度 2：任务完成约束

- [ ] **一句话平衡两端**：`"Complete the task fully — don't gold-plate, but don't leave it half-done."` 放在身份声明之后、任何具体指令之前。
  - 无此 → 子 agent 要么过度包装（gold-plating）要么半途而废

### 维度 3：防递归约束

- [ ] **防递归在前 3 条约束中**：`"You cannot spawn additional agents unless the task explicitly requires it."` 不能放在末尾被注意力衰减跳过。
  - 无此 → 子 agent 无限 spawn 子 agent，耗尽资源
- [ ] **如需递归有显式覆盖声明**：如编排 agent 需要 spawn 子 agent，显式覆盖 `"You may spawn sub-agents for sub-tasks as described below."`

### 维度 4：环境信息注入

- [ ] **cwd、git branch、可用工具列表已注入**：子 agent 不知道主 agent 的上下文。这些信息是必需的。
- [ ] **环境信息与指令有格式区分**：`"Working directory: [cwd]"` 用格式标记为环境数据而非系统指令，防止注入风险。

### 维度 5：路径规范

- [ ] **绝对路径要求显式声明**：`"Use absolute file paths only. Relative paths may resolve incorrectly across operations."`
  - 无此 → cwd 重置后相对路径失效，文件操作实际未生效

### 维度 6：输出规范

- [ ] **输出规范防废话**：要求列出文件路径 + 只在有证据价值时包含代码片段 + 不逐步叙述做了什么。
  - 无此 → 子 agent 花 300 tokens 逐行复述改了什么，主 agent 不需要

## P1 建议检查

### 总体：极简检查

- [ ] **Agent prompt ≤20 行核心内容**：超过 20 行 → 其中是否在重复主 agent 的约束？
- [ ] **不与主 System Prompt 重复**：子 agent 不继承主 agent system prompt。如有必须继承的全局规则，只复制精简版。

### 维度 4：环境信息深度

- [ ] **可选环境信息已注入**（如适用）：相关文件列表、项目 CLAUDE.md——帮助子 agent 理解上下文。
- [ ] **skill-driven agent 有 skill 引用**：如果子 agent 的行为由 skill 定义，身份声明中引用对应 skill："Your methodology comes from the ts-taste-check skill."

### 维度 6：输出规范深度

- [ ] **输出规范考虑 compact 场景**：如果子 agent 的 output 将被 compact 后传给主 agent，输出规范更严格——标注哪些是事实、哪些是推断。

---

## 审查清单自检

审查清单本身也需要质量检查。完成本案审查后，确认：

1. **维度覆盖**：6 个设计维度（身份声明/任务完成约束/防递归/环境注入/路径规范/输出规范）是否均有检查项？
2. **P0 判断准确**：防递归约束的 P0 定位是否合理（缺少确实=无限嵌套）？环境注入是否应该全部 P0 而不只是部分项？
3. **P1 判断准确**：输出规范深度是否确实属于"有了更好"而非"必须"？
4. **引用完整**：每个检查项是否标注了违反的原则编号和导致的失败模式编号？
5. **可判定性**："≤20 行核心内容"和"不重复主 agent 约束"如何客观判定？

---

## 快速参考

审查完成后对照此表做最终确认：

| 原则 | 此载体语境 |
|------|----------|
| P2 风险∝密度 | Agent prompt 极短，每行都是 context 成本——不重复主 agent 已有约束 |
| P4 反模式枚举 | 必须枚举"不要委派什么任务"——模型不知道哪些任务不适合 agent |
| P7 防注入分层 | 环境信息（cwd/git）是可注入的不可信数据，必须声明为不可信 |

| 失败模式 | 此载体语境 |
|---------|----------|
| F2 目标降级 | 主 agent 把关键路径任务委派给子 agent → 子 agent 静默缩小范围 |
| F4 工具误用 | 子 agent 拿到不该用的工具（如 delete）→ 不可逆操作 |
| F5 范围蔓延 | 子 agent 越权执行超出委派范围的操作 |
| F7 注入突破 | 子 agent 从环境信息（cwd 中的恶意文件名）中读取指令 |
