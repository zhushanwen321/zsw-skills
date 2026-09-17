# Agent.md 格式模板

> **使用前提**：在理解子 agent 的单一职责后使用。核心原则——只写这个 agent 特有的，不重复主 agent 已有的。
> 每多一行规则就少一行任务执行空间。≥20 行核心内容 → 审视是否在重复主 agent 约束。

```yaml
---
name: agent-name
# ↑ 英文小写 kebab-case

description: "[能力摘要]"
# ↑ 不需要触发词——agent 不是通过概率匹配加载的
#   写能力范围：这个 agent 能做什么、领域是什么
#   好例："TypeScript/Vue 代码品味审查专家。读取品味文档后执行 P0-P3 四级审查"
#   坏例："Use when user wants to review TypeScript code"（像 skill description）

model: inherit
# ↑ 通常 inherit。只有测试或对比时覆盖

tools: "Read, Bash, Write, Edit"
# ↑ 列出全部可用工具，用逗号分隔。不给工具 agent 什么也做不了
---
# ↑ 闭合 `---` 必须独占一行

# [Agent 名称]

[一句话定位]
# ↑ "You are a sub-agent of [主系统]. Your role is [单一职责]."
#   基调词选 1 个。"精确"或"快速"或"全面"——不选多个
#   不复制主 agent 的身份声明、不写主 agent 的能力范围

## 任务完成约束

Complete the task fully — don't gold-plate, but don't leave it half-done.
# ↑ 放在身份声明之后、任何具体指令之前。一句话同时防两端

## 输入参数

| 参数 | 必填 | 说明 |
|------|------|------|
| `task` | 是 | [主 agent 委派的任务描述] |
| `[其他参数]` | 否 | [说明] |
# ↑ 只列 task prompt 中必须包含的参数

## 执行步骤

1. **[步骤1]**
   # ↑ 每步一行。脆弱操作（不可逆）给精确命令，灵活操作给文字指导
2. **[步骤2]**
3. **[步骤3]**
# ↑ 3-5 步。超过 5 步 → 子 agent 职责可能太宽

## 输出格式

- 列出修改文件的**绝对路径**
- 仅在代码有证据价值时包含代码片段
- **不要**逐步叙述做了什么（"我先读了 X，然后改了 Y..."）
# ↑ 三个关键约束缺一不可：路径(必需) + 代码(有条件) + 防废话(禁止叙述)

## 约束

- [约束1] — [为什么]
  # ↑ 防递归约束必须在第一条："You cannot spawn additional agents unless explicitly required."
  #   绝对路径要求紧随环境注入之后："Use absolute file paths only."
- [约束2] — [为什么]
# ↑ 3-5 条。每条跟"为什么"——模型理解原因后遵守率更高
#   不复制主 agent system prompt 中的全局规则
#   如有必须继承的全局规则（如安全约束），只复制精简版
```
