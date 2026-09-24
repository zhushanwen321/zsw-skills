# Create — 创作入口

**流程目标**：基于 brainstorm 的设计简报，引导 AI 完成 prompt 的创建或改进。

[MANDATORY] **此文件是执行指令，不是参考文档。** 你作为 AI agent 必须按步骤 1→6 的顺序阅读 pattern 的每个章节，不跳过任何步骤。如果你跳过 create.md 直接 read patterns/，你失去了风险分级、逐维度设计协议和设计走查——三个关键保障。

## 前置条件

必须先有设计简报（来自 brainstorm.md）或确认了载体类型。如果没有，先回 brainstorm。

## 设计流程

create.md 引导你按固定顺序阅读 `patterns/<carrier>.md` 的各章节。每个章节对应设计的一个关键环节，跳过任何一个都意味着设计缺少系统性保障。

## 步骤

### 0. 确定要加载的方法论文档

从设计简报中获取载体类型，加载对应 pattern：

| 简报中的载体类型 | 方法论文档 |
|----------------|-----------|
| Tool Description | `patterns/tool-description.md` |
| System Prompt | `patterns/system-prompt.md` |
| Steering Prompt | `patterns/steering-prompt.md` |
| Compact Prompt | `patterns/compact-prompt.md` |
| Agent Prompt | `patterns/agent-prompt.md` |
| Error Message | `patterns/error-message.md` |
| Safety Policy | `patterns/safety-guardian.md` |
| SKILL.md | `patterns/skill-design.md` |
| Personality | `patterns/personality.md` |

### 1. 前置知识

不要直接进入设计。先读步骤 0 确定的方法论文档的 `## 前置知识` 块中声明的参考文档：

```
read {skill_dir}/references/design-principles.md      # 按前置知识块中的重点列表
read {skill_dir}/references/failure-mode-taxonomy.md  # 同上
# 以及其他前置知识块中列出的文件
```

这些文档建立判断依据，后续所有设计决策的"为什么"都源自这里。

### 2. 核心挑战 + 风险分级

读 pattern 的 `## 核心挑战` 和 `## 风险驱动的分级`。

- 核心挑战：理解这个载体最致命的陷阱——设计全程带着这个问题意识
- 风险分级：根据设计简报中的风险等级，确定本次设计的深度（哪些维度走全程、哪些精简）

### 3. 逐维度设计

按 pattern 的 `## 设计维度` 下二级标题的顺序，逐维度推进。每个维度：

1. 读该维度的 `**决策指南**` 段落——这是方法论核心
2. 根据设计简报的场景句和失败假设，做出设计决策
3. 将决策写成 prompt 内容
4. 检查：这条决策是否能防御设计简报中假设的失败模式？

跳过维度规则：低风险等级可跳过标记为“可选”的维度（参考风险分级表）。

### 4. 失败案例对照

读 `## 最致命的 N 个失败案例`。逐条检查：我当前的设计是否覆盖了这些已知失败？

- 如果某条失败案例在你的设计中完全没有防御 → 回到对应维度加固
- 如果是低风险载体可跳过此步（参考风险分级表）

### 5. 载体协作检查

读 `## 与其他载体的协作`。检查：

- 你的设计是否侵入了其他载体的职责？（如把 tool-level 约束写进了 system prompt）
- 是否有遗漏的协作点？（如应该引用 personality 占位符但没引用）

### 6. 设计走查

读 `## 设计走查`。按走查中的问题顺序逐条验证。每条：

- 通过 → 记录证据（为什么通过）
- 不通过 → 回到对应维度修正

### 7. 格式参考（可选）

设计完成后，可取模板作为格式参考：

```
read {skill_dir}/resources/templates/<carrier>-template.md
```

**警告**：模板只提供格式框架，不包含方法论。在走完步骤 1→6 之前不要碰模板。

### 8. 输出

最终输出 prompt 正文 + 设计决策与走查记录：

```
## 设计的 prompt

[prompt 正文]

## 设计决策

| 维度 | 决策 | 防御的失败模式 |
|------|------|--------------|
| ... | ... | F* |

## 走查记录

| 走查项 | 结果 | 证据/修正 |
|--------|------|----------|
| ... | 通过/不通过→已修正 | ... |
```

## 常见错误

### 先写模板再填东西
模板是格式约束，不应该主导设计决策。先想清楚要说什么，再选格式。

### 参考其他工具但不看方法论
"看看类似的工具怎么写的"可以补充思路，但不能替代方法论。类似工具可能有相同的问题。

### 设计后不验证
写完至少要过一次自检清单。审查走 review.md。
