# Personality 审查清单

审查 Personality 时按此清单逐项判定。核心原则：只定义风格，不涉及能力。切换到 pragmatic 后 agent 变得不敢挑战用户——这不应该是 personality 的职责。

> 前置知识：审查前必须已读 patterns/personality.md 的 5 个设计维度、references/design-principles.md 的 P5/P13、references/failure-mode-taxonomy.md 的 F1/F11。无此前提的审查 = 凭感觉打分。

## P0 必需检查

缺失 → 人格污染（切换 personality 改变功能行为）、切换后无感知差异。

### 维度 1：Values

- [ ] **3-4 条核心价值**：每条包含抽象词 + 具体行为描述。`"Empathy: the user should feel safe asking basic questions without embarrassment."` 而非 `"Empathy"` 空词。
  - 违反 P5（示例驱动）。无此 → 模型不知道如何体现价值观
- [ ] **Values 可观测**：第三方读完 Value 描述后，能从 agent 对话中判断"agent 是否体现了这个 Value"。
  - 无此 → 审查者无法验证 personality 是否生效
- [ ] **Values 之间无矛盾**："精确"和"快速"不能同时作为最高优先级——有明确排序。

### 维度 2：Tone & Experience

- [ ] **定义了具体语言特征**：用词偏好（"we/let's" vs "I" vs "you should"）+ 句子长度（短句 vs 长句）+ 肯定与批评的边界（"no flattery" vs "acknowledge before critiquing"）+ 术语使用（默认专业还是通俗）。
- [ ] **有正反面示例**：模型通过示例学习边界比通过规则推断更准确。正面示例展示"鼓励型语气"长什么样，反面示例展示"不是鼓励型语气"长什么样。
  - 违反 P5（示例驱动）

### 维度 3：Escalation

- [ ] **Escalation 是纯风格层面**：定义的是"如何表达不同意见"（用 "We might want to reconsider" 而非 "This is wrong"），不是"什么时候应该表达不同意见"。
  - 违反 F11（人格污染）。无此 → 切换 personality 意外改变 agent 功能行为
- [ ] **验证方法通过**：把 Escalation 规则全部删除，agent 的功能行为是否会改变？如会 → Escalation 中混入了能力约束。

### 维度 4：绝对禁止项

- [ ] **用 "NEVER" 句式**（3-5 条）：比 "DO NOT" 更强。每条后面跟反例。必须纯风格层面。
- [ ] **绝对禁止项不含功能约束**：好例 "NEVER curt or dismissive" / 坏例 "NEVER modify code without reading it"（这是功能约束，应在 System Prompt 中）。

## P1 建议检查

### 维度 1：Values 深度

- [ ] **不同 personality 有明确差异化锚点**：friendly 和 pragmatic 的 Values 描述有明显区别。两个人分别看两个 personality，会觉得是两种不同的风格。

### 维度 5：短版/长版分离

- [ ] **短版长版语义一致**：短版（1-2 行压缩版）和长版描述的是同一行为模式。不能短版说 "encouraging"但长版没有任何鼓励型语言的具体描述。
- [ ] **短版格式适合占位符注入**：可放入 `{{ personality }}` 占位符注入 system prompt。

### 维度 2：Tone 深度

- [ ] **单一 personality 内部 tone 一致**：不在 80% 时间用短句但在某些话题突然变长篇大论。

### 跨维度

- [ ] **Personality 切换不应影响 System Prompt 其他部分**：修改 personality 不影响 system prompt 中的身份声明和全局硬约束。两者正交。

---

## 审查清单自检

审查清单本身也需要质量检查。完成本案审查后，确认：

1. **维度覆盖**：5 个设计维度（Values/Tone/Escalation/绝对禁止项/短版长版分离）是否均有检查项？
2. **P0 判断准确**：Escalation 纯风格化的 P0 定位是否合理（确实——混入能力约束 = F11 人格污染，切换 personality 改变功能行为）？
3. **P1 判断准确**：短版/长版分离的 P1 定位是否合理？单 personality 场景不需要短版，多 personality 场景短版确实必需——是否应按场景分 P0/P1？
4. **引用完整**：每个检查项是否标注了违反的原则编号和导致的失败模式编号？
5. **可判定性**："Values 可观测"如何客观判定？需要给出具体的可观测性标准。

---

## 快速参考

审查完成后对照此表做最终确认：

| 原则 | 此载体语境 |
|------|----------|
| P5 示例驱动 | Personality 通过具体的用户对话示例展示风格，比规则描述更有效 |
| P13 人格分离 | 人格只定义沟通风格，不定义能力约束——人格与功能和行为约束正交 |

| 失败模式 | 此载体语境 |
|---------|----------|
| F1 规则被忽略 | Personality 太弱 → 切换后无感知差异，用户看不出风格变化 |
| F11 人格污染 | Personality 中混入行为约束 → 切换风格意外改变 agent 的功能行为 |
