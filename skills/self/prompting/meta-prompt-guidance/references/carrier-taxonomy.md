# 载体特征矩阵

不是所有设计原则都适用于所有载体。这个矩阵定义每种载体有哪些设计维度、风险等级和优先级分布。

## 载体分类

| 载体 | 注入时机 | 主要任务 | 风险等级 |
|------|---------|---------|---------|
| Tool Description | 工具注册时 | 约束工具的调用条件和使用方式 | 中-高 |
| System Prompt | 会话启动时 | 定义 agent 的身份、全局行为和输出规范 | 高 |
| Steering Prompt | 运行时状态变更时 | 在关键节点动态注入行为引导 | 高 |
| Compact Prompt | 上下文压缩时 | 指导压缩行为，生成结构化摘要 | 中 |
| Agent Prompt | 子 agent 启动时 | 定义独立执行者的行为和约束 | 中 |
| Error Message | 工具执行失败时 | 告知错误事实并引导下一步行为 | 低-中 |
| Safety Policy | 工具调用前 | 独立评估操作风险 | 最高 |
| SKILL.md | 被模型概率匹配加载 | 知识/行为的入口路由 | 高 |
| Personality | 会话启动时（占位符替换） | 定义沟通风格和价值观 | 低 |

## 每种载体的设计维度

维度分为"核心维度"（必须覆盖）和"可选维度"（按需深入）。

### Tool Description
- 核心：调用条件（when to use）、反模式（when NOT to use）、能力边界
- 可选：正反面示例、数字阈值、跨 tool 引用、参数级约束
- 特殊：高风险工具需生命周期结构（before → during → after）

### System Prompt
- 核心：身份声明、全局 Anti-pattern、默认行为（"默认行动，非默认规划"）
- 可选：输出格式规范（按变更规模分级）、工具使用优先级、上下文感知行为
- 特殊：按模型能力分代管理（强模型用精简 prompt）

### Steering Prompt
- 核心：角色/状态声明、防注入围栏（XML 标签 + 语义声明）、行为约束
- 可选：Completion audit（逐项验证）、Fidelity 约束、Blocked audit
- 特殊：必须使用模板引擎支持变量替换

### Compact Prompt
- 核心：反工具调用围栏（PREAMBLE + TRAILER 双重禁止）、结构化章节模板
- 可选：analysis 草稿区、Partial Compact 变体、用户自定义指令注入
- 特殊：独立 session 运行，不继承主 agent context

### Agent Prompt
- 核心：身份声明、任务完成约束、防递归约束、环境信息注入
- 可选：输出规范、路径规范
- 特殊：极简（10-20 行），大部分行为规范从主 system prompt 继承

### Error Message
- 核心：事实数据、行为约束、防偷懒禁令
- 可选：收尾指令、与 Steering Prompt 的协作关系
- 特殊：极简（80-100 词），必须包含"事实 + 约束 + 禁令"三要素

### Safety Policy
- 核心：反注入声明、风险分类标准、Decision Matrix、覆盖机制
- 可选：风险评分规则、操作记录
- 特殊：必须在独立 session 运行，不与主 agent 共享 context

### SKILL.md
- 核心：触发条件（description）、路由逻辑、结构指引、强制约束
- 可选：标记规范（HISTORICAL/MANDATORY/OPTIONAL）、自由度分级
- 特殊：description 只写"何时用"，不写"做什么"；正文做路由不做内容

### Personality
- 核心：Values 列表、Tone & Experience 规范、Escalation 规则、绝对禁止项
- 可选：正反面沟通示例
- 特殊：不影响能力只影响交互；可通过占位符替换切换

## 设计维度到原则的映射

| 设计维度 | 关键原则 |
|---------|---------|
| 调用条件 / when to use | P1（行为约束）、P3（数字阈值） |
| 反模式 / when NOT to use | P4（反模式枚举） |
| 能力边界声明 | P6（能力边界） |
| 正反面示例 | P5（示例驱动） |
| 跨 tool 约束 | P9（工具链约束） |
| 生命周期结构 | P10（生命周期结构） |
| 输出格式规范 | P11（展示独立） |
| 防注入设计 | P7（防注入分层） |
| Completion audit | P8（证据驱动） |
| 状态转换阈值 | P3（数字阈值） |
| 跨模型交接 | P12（交接 framing） |
| 约束总量控制 | P2（风险∝密度） |

## 载体到失败模式的映射

设计某种载体时，应优先排查其高频失败模式：

| 载体 | 最需警惕的失败模式 |
|------|------------------|
| Tool Description | F1（规则忽略）、F4（工具误用）、F5（范围蔓延）、F8（链断裂）、F12（优先级网络断裂）、F14（工具结果注入） |
| System Prompt | F1（规则忽略）、F6（假完成）、F10（缺示例）、F13（约束过载）、F15（提示词泄露） |
| Steering Prompt | F2（目标降级）、F3（偷懒完成）、F6（假完成）、F7（注入突破）、F9（过早放弃） |
| Compact Prompt | F2（目标降级）—— 压缩丢失关键信息后恢复方偏离原始意图 |
| Agent Prompt | F2（目标降级）、F5（范围蔓延）、F7（注入突破） |
| Error Message | F3（偷懒完成）、F9（过早放弃） |
| Safety Policy | F7（注入突破）、F14（工具结果注入） |
| SKILL.md | F1（规则忽略）、F10（缺示例）、F13（约束过载） |
| Personality | F11（人格污染）——能力约束混入风格定义 |

## 载体对交互模式的需求

部分载体依赖跨 prompt 交互：

| 载体 | 需要的交互模式 |
|------|-------------|
| Tool Description | 优先级网络、前置依赖、约束冗余 |
| System Prompt | static/dynamic 分层边界 |
| Steering Prompt | 注入防御分层、约束冗余（与 tool description 配合作业） |
| Compact Prompt | Compaction 交互模式（framing + 反工具调用围栏） |
| Agent Prompt | 优先级网络（继承 vs 覆盖主 prompt） |
