# 人格风格设计方法论

## 前置知识

设计 Personality 前，必须已掌握以下原则和失败模式。如未读过，请先 read：

```
read {skill_dir}/references/design-principles.md
  # 重点：P13(人格风格不影响能力只影响交互)、P5(示例驱动)
read {skill_dir}/references/failure-mode-taxonomy.md
  # 重点：F11(人格污染)
```

## 核心挑战

Personality 设计最大的陷阱：**在风格中混入能力约束。** Personality 切换到 pragmatic 后 agent 变得不敢挑战用户——这不应该是 personality 的职责，但因为 Escalation 规则写得模糊而发生了。

第二个陷阱：**Values 只有抽象词。** "Empathy"、"Precision"、"Creativity"——这些词对模型来说没有行为含义。没有具体的行为描述，两个不同的 personality 看起来差不多，用户感觉不到切换效果。

## 设计维度

### 维度 1：Values — 3-4 条核心价值

**为什么重要**：Values 是 personality 的锚点。它们定义 agent 行为的**基调方向**。如果 Values 太抽象，agent 不知道如何体现；如果 Values 太多，互相冲突。

**决策指南**：

- 3-4 条，每条必须包含：抽象词 + 具体行为描述（[P5 示例驱动]）
  - 坏例：`"Empathy"` — 模型不知道怎么做
  - 好例：`"Empathy: the user should feel safe asking basic questions without embarrassment. Explain technical concepts in terms of their goal, not in terms of your tools."`
- Values 必须可观测——第三方读了这个 Value 的描述后，能从 agent 的对话中判断"agent 是否体现了这个 Value"。如果不能判断，描述太模糊
- 不同 personality 的 Values 必须有**明确的差异化锚点**。如果 friendly 和 pragmatic 的 Values 看起来差不多 → 定位不清 → 用户切换后无感知
- Values 之间不允许矛盾（如"精确"和"快速"在同一个 personality 中同时作为最高优先级）→ 给 Values 排序确定优先级

### 维度 2：Tone & Experience — 语言风格

**为什么重要**：Tone 是 Values 在语言层面的落地。模型知道"我重视精确"，但如果不知道"说话用短句还是长句"、"用第一人称还是复数"，tone 会和 values 冲突。

**决策指南**：

- 必须定义的具体语言特征：
  - 用词偏好：`"we/let's"` vs `"I"` vs `"you should"`
  - 句子长度：短句（10 词）vs 长句（20+ 词）
  - 肯定与批评的边界：`"no flattery, no hype"` vs `"acknowledge good ideas before critiquing"`
  - 专业术语的使用：默认使用专业术语还是解释成通俗语言
- **正反面示例必不可少**——模型通过示例学习边界比通过规则推断更准确
  - 好例（正面）：具体展示"鼓励型语气"应该长什么样
  - 好例（反面）：具体展示"不是鼓励型语气"长什么样
- 单一 personality 的 tone 内部一致——不要让 friendly personality 在 80% 时间用短句但在某些话题突然变成长篇大论

### 维度 3：Escalation — 意见不一致时

**为什么重要**：这是最容易和能力约束混淆的维度。Escalation 定义的是**风格层面**的"如何表达不同意见"，不是**功能层面**的"什么时候应该表达不同意见"。

**决策指南**：

- Escalation 的纯风格定义：
  - Friendly：`"Disagreement is expressed as shared responsibility, not correction. 'We might want to reconsider this approach' rather than 'This is wrong'."`
  - Pragmatic：`"You may challenge the user to raise standards, but never condescend. 'This works but has performance issues' rather than 'Why would you do it this way?'."`
- **绝对不放的内容**：
  - 功能判断条件（"当代码有性能问题时..."）——这是能力行为，应该在 System Prompt 中
  - 工具使用规则（"使用 X 工具来验证..."）——这在 Tool Description 或 System Prompt 中
  - 任务完成标准（"必须在所有测试通过后..."）——这在 Steering Prompt 或 System Prompt 中
- 验证方法：把 Escalation 规则全部删除，agent 的行为能力会不会改变？如果会 → Escalation 中混入了能力约束（[F11 人格污染]）

### 维度 4：绝对禁止项 — 风格底线

**为什么重要**：定义绝对不接受的语言风格，消除模糊空间。

**决策指南**：

- 用 "NEVER" 句式定义—— "NEVER" 比 "DO NOT" 更强，暗示这是风格底线而非偏好
- 绝对禁止项必须是**纯风格层面**的：
  - 好例：`"NEVER curt or dismissive."`
  - 坏例：`"NEVER modify code without reading it."` — 这是功能约束
- 每条绝对禁止项后面跟着一个反例：`"NEVER curt or dismissive — e.g., 'just do X' without explanation."`
- 3-5 条绝对禁止项足够。超过 5 条 = 你在列出所有你不喜欢的沟通方式，而不是真正的底线

### 维度 5：短版/长版分离

**为什么重要**：短版作为占位符注入 system prompt，长版按需加载。如果每次都用长版，personality 占用过多 context。

**决策指南**：

- 短版（1-2 行）：Values 的一个压缩版本 + Tone 的一句话概括
  - 好例：`"Friendly and encouraging. Use 'we' and short sentences. No flattery, no curt responses."`
- 长版：完整的 Values/Tone/Escalation/绝对禁止项
- 短版和长版必须语义一致——模型不应该在读到短版和长版时表现出不同的行为
- 如果只有一个 personality，可以不需要短版——直接在 system prompt 中放完整版
- 如果有多个 personality（如 friendly / pragmatic / precise），system prompt 中用 `{{ personality }}` 占位符，运行时替换为对应短版

## 最致命的 3 个失败案例

1. **Escalation 定义太模糊** → 友好型不敢指出问题，务实型变得粗暴。根源：Escalation 规则只说了"应该怎样"没说"具体说什么"
2. **风格中混入能力约束（[F11 人格污染]）** → 切换 personality 意外改变了 agent 的功能行为。最典型：pragmatic personality 中写了"Always check the code before suggesting changes"——这是功能约束
3. **Values 只有抽象词** → 不同 personality 的差别模糊，用户切换后感觉不到差异。根源：没有为每个 Value 给出具体的行为描述

## 与其他载体的协作

- **System Prompt**：通过占位符 `{{ personality }}` 注入短版。System Prompt 的身份声明只说"是什么"的基调，Personality 说"怎么说话"的风格。两者正交——修改 personality 不应影响 system prompt 的其他部分
- **Skill**：skill 不定义 personality。personality 是 agent 层面的设置
- **Steering Prompt**：steering prompt 中不应该引用 personality 或要求切换 personality——personality 在会话开始时设定，运行时不建议切换（切换可能让用户困惑"为什么 agent 的语气变了"）

## 设计走查

完成 Personality 设计后，按此顺序自检：

1. **纯风格检查**：从 personality 中删除所有规则后，agent 的**功能行为**是否会改变？（会 → 有 [F11 人格污染]）
2. **Values 可观测性**：第三方能从 agent 对话中判断每个 Value 是否被体现吗？
3. **Escalation 的纯风格化**：Escalation 规则中包含功能判断条件吗？（如"当代码有...时"）
4. **两个 personality 的差异化**：如果设计多个 personality，它们的 Values 描述有明显区别吗？给两个人分别看两个 personality，他们会觉得是两种不同的风格吗？
5. **短版长版一致性**：短版和长版描述的是同一个行为模式吗？有没有短版说了"encouraging"但长版中没有任何鼓励型语言的具体描述？

## 快速参考

- 核心原则：[P13 人格分离]、[P5 示例驱动]
- 失败模式：[F11 人格污染]、[F1 规则被忽略]
