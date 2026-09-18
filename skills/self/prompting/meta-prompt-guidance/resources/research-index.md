# 调研文档索引

指向本项目内所有原始调研文档。这些文档是 `meta-prompt-creator/references/design-principles.md` 中 12 条原则的来源。

## Codex CLI Prompt 分析

路径：`research/prompt/codex/`

| 文档 | 内容 | 与本系统关系 |
|------|------|------------|
| `00-summary.md` | 总报告（8 分类、15 条原则、管理矩阵、决策树） | 原则 P1-P12 的核心来源 |
| `tool-descriptions.md` | 工具描述详细分析 | `patterns/tool-description.md` 的参考 |
| `steering-prompts.md` | 运行时引导详细分析 | `patterns/steering-prompt.md` 的参考 |
| `system-agent-prompts.md` | 系统和 Agent 提示详细分析 | `patterns/system-prompt.md` / `agent-prompt.md` 的参考 |

## Claude Code Prompt 分析

路径：`research/prompt/claude-code/`

| 文档 | 内容 | 与本系统关系 |
|------|------|------------|
| `00-summary.md` | 总报告（6 分类、缓存优化、横向对比） | 示例驱动方法、缓存策略的来源 |
| `tool-descriptions.md` | 工具描述详细分析 | `patterns/tool-description.md` 的参考 |
| `system-steering-prompts.md` | 系统和引导提示详细分析 | `patterns/system-prompt.md` / `steering-prompt.md` 的参考 |

## Claude Code 原始 Prompt 分析

路径：`research/claude-code-prompts/`

| 文档 | 内容 |
|------|------|
| `system-prompts.md` | Claude Code system prompt 原始内容拆解 |
| `tool-descriptions-core.md` | 核心工具描述原始分析 |
| `tool-descriptions-mcp.md` | MCP 工具描述原始分析 |
| `skill-list.md` | Skill 发现和加载机制分析 |
| `workflow-gap-analysis.md` | Workflow 差距分析 |

## Skill/Meta-Skill 设计调研

路径：`research/`

| 文档 | 内容 |
|------|------|
| `meta-sk-design-research.md` | Meta-Skill 设计方法论调研 |
| `skill-description-trigger-research.md` | Skill 描述和触发机制调研 |
| `agent-md-writing-research.md` | Agent.md 编写规范调研 |
| `coding-agents-context-research.md` | AI Coding Agent 上下文管理研究 |
| `skill-state-tracker-design.md` | Skill 状态追踪器设计 |

## Skill 编写规范（从 meta-sk-skill-writer 迁移）

路径：`research/`

| 文档 | 内容 |
|------|------|
| `rule-templates.md` | 规则质量模板（后果链模板、反模式检测清单） |
| `yaml-guide.md` | YAML 格式规范（description 格式、验证方法） |

## 旧版指南（新框架前的历史文档）

路径：`legacy/`

| 文档 | 内容 |
|------|------|
| `01-08*.md` | 按载体的旧版写作指南（已被 `patterns/` 取代） |
| `元提示与元技能-*.md` | 早期设计讨论文档 |

## 使用方式

调研文档不是方法论——它们是方法论的知识来源。当需要理解"为什么这条原则有效"时查阅，不要在 prompt 设计会话中加载（它们很大）。
