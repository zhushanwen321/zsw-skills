---
name: meta-prompt-creator
description: >-
  Use when designing, writing, auditing, or reviewing AI agent prompts
  of any kind — tool descriptions, system prompts, steering prompts,
  skill definitions, agent prompts, error messages, safety policies,
  or personality styles.
  Not for writing code, general documentation, CLAUDE.md user instructions,
  or business logic.
---

# Meta Prompt Creator

设计 AI Agent 提示词的方法论系统。不直接给答案，而是引导你按场景思考、按原则设计、按清单审查。

## 核心原则

以下 4 条是一切设计的基础。详细版本见 `references/design-principles.md`。

1. **先看失败，再写 prompt**。没有观察过 agent 在没有这个 prompt 时怎么失败，不该知道 prompt 应该教什么
2. **Description 是行为约束器，不是功能说明书**。重心在"何时用/何时不用"，而非"能做什么"
3. **约束密度与操作风险成正比**。只读工具用精简描述，状态变更用密集约束
4. **证据驱动完成，不允许意图推断**。"我觉得差不多了"不是完成的证据

## 路由

根据用户意图加载对应文档。**不预设流程，每个需求类型只加载它需要的文档。**

### 用户说"写"/"设计"/"创建"/"改进"

第一步永远是需求探索。按顺序 read：

```
read {skill_dir}/flow/brainstorm.md
```

brainstorm 完成后，进入设计阶段：

```
read {skill_dir}/flow/create.md
```

create.md 会引导你按顺序消费 `patterns/<carrier>.md` 的各章节（前置知识 → 核心挑战 → 逐维度设计 → 失败案例 → 载体协作 → 设计走查）。

设计完成后，如需要格式起点，read 对应模板：

```
read {skill_dir}/resources/templates/<carrier>-template.md
```

### 用户说"审查"/"review"/"audit"/"检查"

```
read {skill_dir}/flow/review.md
```

根据要审查的载体类型，review.md 会指引加载对应审查清单。

### 用户说"为什么"/"原则"/"反模式"

先读索引入口，再按场景路径跳转到具体知识文件：

```
read {skill_dir}/references/knowledge-index.md
```

索引入口会根据你的场景推荐具体阅读路径。如需直接跳转：

| 问题 | 直接跳转 |
|------|---------|
| 通用设计原则 | `references/design-principles.md` |
| 失败模式分类 | `references/failure-mode-taxonomy.md` |
| 载体特征对比 | `references/carrier-taxonomy.md` |
| Prompt 架构与工程管理 | `references/prompt-architecture.md` |
| 跨工具交互设计 | `references/interaction-patterns.md` |

### 用户说"模板"/"给我个模板"

```
read {skill_dir}/resources/templates/<carrier>-template.md
```

注意：模板只是格式起点。跳过方法论直接套模板 = 空洞输出。

### 用户说"失败"/"常见错误"

```
read {skill_dir}/resources/failure-modes/<failure-mode>.md
```

可加载的失败模式：`rule-ignored` / `goal-degradation` / `lazy-completion` / `tool-misuse` / `scope-creep` / `false-completion` / `injection-bypass` / `chain-break` / `premature-abandonment` / `example-vacuity` / `personality-contamination` / `priority-network-break` / `constraint-overload` / `tool-result-injection` / `prompt-extraction`

## 载体选择

先判断载体类型，再加载方法论。判断依据：

| 你要设计的是 | 载体 | 场景 |
|------------|------|------|
| 工具的使用边界与调用约束 | Tool Description | 写一个工具的描述——告诉模型何时该用、不该用、有什么约束 |
| Agent 的持久化身份与全局约束 | System Prompt | 设定 agent 的基本身份、行为规范、输出格式——每次对话都看到的核心约束 |
| 运行时状态变更时的动态注入 | Steering Prompt | 运行时动态注入的行为引导——任务状态变更、预算耗尽、目标更新等关键节点 |
| 上下文压缩时的摘要指令 | Compact Prompt | compact/compress 触发时的摘要指令——如何总结进度、保留关键信息 |
| 子 agent 的身份和约束 | Agent Prompt | 定义独立执行的子 agent 的身份、能力和行为边界 |
| 工具失败后的错误消息 | Error Message | 工具执行失败、预算耗尽、超时等异常场景的返回消息 |
| 安全评估的规则和矩阵 | Safety Policy | 安全审查的触发规则和风险矩阵——定义哪些操作需要安全检查、如何评估 |
| Skill 文件的触发条件与路由规则 | SKILL.md | Skill 文件的入口设计——定义触发条件、路由逻辑和核心原则 |
| Agent 的沟通风格 | Personality | 定义 Agent 沟通风格，不涉及能力约束——友好、务实、严谨等 |

## 关键约束

- [MANDATORY] **永远先 brainstorm → create → patterns，不跳过 create.md**。brainstorm 确定载体和失败模式，create 引导你按固定顺序消费 pattern 的每个章节。跳过 create 直接进 patterns = 方法论碎片化——你失去了风险分级、逐维度设计协议和设计走查
- [MANDATORY] **方法论文档按需要加载，不要一次全读**。`patterns/` 下的每个文件约 300 行，一次加载浪费 context
- [MANDATORY] **模板必须在方法论之后才能使用**。如果用户直接要模板，给模板但同时加载对应的方法论文档
- [MANDATORY] **审查必须用审查清单，不能凭感觉**。每个载体有对应的 review/rubric-XXX.md

---

## 标记说明

| 标记 | 含义 | 修改约束 |
|------|------|----------|
| `[HISTORICAL]` | 历史经验总结的规则。来自实际事故和教训 | 不允许删除或削弱 |
| `[MANDATORY]` | 流程强制要求。不遵守会导致流程失败 | 必须严格遵守 |
| `[OPTIONAL]` | 可选步骤。根据实际情况决定是否执行 | 可根据需求调整 |
