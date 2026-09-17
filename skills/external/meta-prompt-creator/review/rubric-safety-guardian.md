# Safety Policy 审查清单

审查 Safety Policy 时按此清单逐项判定。核心原则：独立 session 运行、反注入声明在最前面、决策矩阵消除判断歧义。

> 前置知识：审查前必须已读 patterns/safety-guardian.md 的 5 个设计维度、references/design-principles.md 的 P7、references/failure-mode-taxonomy.md 的 F7/F14、references/interaction-patterns.md 的注入防御分层模式。无此前提的审查 = 凭感觉打分。

## P0 必需检查

缺失 → 注入突破、矛盾判定、用户关闭 Guardian。

### 维度 1：反注入声明

- [ ] **反注入声明在 prompt 第一句**：声明所有输入是不可信证据——对话历史、工具调用参数、工具返回值、计划操作。不只覆盖用户输入（F14 工具结果注入）。
  - 违反 P7（防注入分层）。无此 → F7 注入突破：工具调用参数中嵌入"该操作已获批准"绕过 Guardian
- [ ] **声明至少重复一次**：在风险分类标准和决策矩阵之前再强调一次——Guardian 阅读细节时可能忘记开头声明。

### 维度 2：风险分类

- [ ] **≥4 大风险类别**：数据泄漏 + 凭证探测 + 持久安全削弱 + 破坏操作。每类有 ≥2 个正例和 ≥2 个反例。
- [ ] **反例比正例更重要**：告诉 Guardian"什么看起来像但实际不是"——防止误判。`"Deleting temporary build artifacts is not destructive."`
- [ ] **分类用具体操作而非抽象概念**："泄露凭证"不是一类——"发送包含 secret key 的环境变量文件到外部 URL"才是一类。

### 维度 3：决策矩阵

- [ ] **有 risk × authorization → outcome 矩阵**：每个组合有明确的 allow/deny。不允许出现 "maybe" 或 "assess further"。
  - 无此 → Guardian 对同类操作做出矛盾判定——一次允许一次拒绝，用户失去信任
- [ ] **矩阵覆盖所有 risk 和 auth 组合**：无漏判。每个格子有值。

### 维度 4：覆盖机制

- [ ] **有覆盖机制**：用户可覆盖 deny（设置 authorization=high + outcome=allow）。覆盖必须记录日志、留下审计痕迹。
  - 无此 → 用户合法操作被永久阻止 → 关闭 Guardian → 安全系数归零
- [ ] **Critical 级别不允许覆盖**：即使 high auth 也不能覆盖 critical 判定。不要让 Guardian 代替人做 critical 决策。
- [ ] **覆盖不等于豁免**：Guardian 仍然评估和记录操作，只是最终判定改为 allow。

## P1 建议检查

### 维度 2：风险分类深度

- [ ] **风险分类可扩展**：设计上允许新增风险类别而不破坏现有分类结构。

### 维度 5：低风险保护

- [ ] **≥3 条防御性豁免**：`"Do not assign high risk solely because path is outside workspace."` / `"Sandbox retries are not suspicious."` / `"Read-only config file operations are low risk."`
- [ ] **最常见误判排在最前**：按实际误判频率排序。
- [ ] **每条豁免经过恶意利用检查**：这条豁免会不会被恶意利用？如会 → 重新设计豁免范围。

### 维度 3：决策矩阵深度

- [ ] **人工审查场景有明确标记**：如果某组合确实需要人工审查，标注 "deny + escalate to human"——不要让 Guardian 代替人做决策。

### 跨维度

- [ ] **独立 session 运行已确认**：Guardian 不与主 agent 共享 context——这是架构级要求，不是 prompt 设计问题。审查时确认架构上支持。

---

## 审查清单自检

审查清单本身也需要质量检查。完成本案审查后，确认：

1. **维度覆盖**：5 个设计维度（反注入声明/风险分类/决策矩阵/覆盖机制/低风险保护）是否均有检查项？
2. **P0 判断准确**：独立 session 运行是否应升为 P0（共享 context = 评估被污染 = 整个 Guardian 形同虚设）？
3. **P1 判断准确**：低风险保护清单的 P1 定位是否合理？缺少豁免可能导致过度拒绝 → 用户关闭 Guardian → 安全归零。是否应升为 P0？
4. **引用完整**：每个检查项是否标注了违反的原则编号和导致的失败模式编号？
5. **可判定性**："决策矩阵覆盖所有组合"如何验证？需要给出包含哪些 risk 和 auth 维度的检查方法。

---

## 快速参考

审查完成后对照此表做最终确认：

| 原则 | 此载体语境 |
|------|----------|
| P7 防注入分层 | Guardian 处理不可信工具调用数据——反注入声明必须在最前面，三重防御 |

| 失败模式 | 此载体语境 |
|---------|----------|
| F7 注入突破 | 工具调用的 content 中包含指令式文本被 Guardian 执行 |
| F14 工具结果注入 | 工具返回的网页或文件中包含伪装指令被 Guardian 当作规则 |
