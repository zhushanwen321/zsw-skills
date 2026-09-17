# Compact Prompt 审查清单

审查 Compact Prompt 时按此清单逐项判定。Compact 的 turn 极其宝贵（通常只有一次），浪费在工具调用上 = 压缩失败。

> 前置知识：审查前必须已读 patterns/compact-prompt.md 的 5 个设计维度、references/design-principles.md 的 P7/P12、references/failure-mode-taxonomy.md 的 F1/F2、references/interaction-patterns.md 的 Compaction 交互模式。无此前提的审查 = 凭感觉打分。

## P0 必需检查

缺少任何一项 → 压缩失败、恢复后任务漂移、关键信息丢失。

### 维度 1：反工具调用围栏

- [ ] **反工具调用围栏至少 2 次**：开头 + 结尾各至少一次。三次尤佳（开头→中间→结尾）。三次优于一次——模型在处理长 prompt 时注意力分散。
  - 无此 → 压缩 session 中调用工具，浪费唯一 turn。F1 规则被忽略
- [ ] **开头强调的措辞强度足够**：用 CRITICAL 声明开头 + 列出被禁用的具体工具 + 第二段用不同措辞重申。
- [ ] **结尾强调紧跟输出模板之后**：位置在章节模板后面——此时模型正在计划"输出什么"，最容易产生"去看一下文件"的冲动。

### 维度 2：结构化章节模板

- [ ] **≥9 个必需章节**：Primary Request、Key Technical Concepts、Files and Code、Errors and Fixes、Problem Solving、All User Messages、Pending Tasks、Current Work、Optional Next Step。
- [ ] **Current Work 要求引用原文**："include direct quotes from recent conversation showing exactly what you were working on"——非协商项。没有原文引用 → 恢复方基于摘要模型的理解重新开始 → 任务漂移（F2 目标降级）。
- [ ] **空章节标记为 N/A**：如果某章节无内容，明确写"N/A"——让恢复方知道"不是漏了，是真的没有"。

### 维度 3：Analysis 草稿区

- [ ] **草稿区与输出分离**：`<analysis>` → 模型自由推理 → `</analysis>` → `<summary>` → 结构化输出。
- [ ] **声明 analysis 会被剥离**：模型知道分析内容不会被后续看到，不用担心"暴露推理过程"——鼓励更深度的思考。

## P1 建议检查

### 维度 4：Partial Compact 变体

- [ ] **有压缩范围选择逻辑**：不每次都用 BASE。30 轮以上强制考虑 PARTIAL。根据近期对话价值密度选择。
- [ ] **PARTIAL_UP_TO 分界点合理**：以第一次 git commit 或第一次具体修改时刻往前 5 轮为分界点。

### 维度 5：自定义指令注入

- [ ] **支持用户自定义关注点**：`"When compacting, pay extra attention to: [user-defined focus areas]."` 自定义指令作为章节模板加权因子而非额外章节。

### 维度 1：围栏深度

- [ ] **禁止工具调用的措辞强度测试**：删除所有反工具围栏后，模型会不会尝试调工具？如会 → 围栏还不够强。

---

## 审查清单自检

审查清单本身也需要质量检查。完成本案审查后，确认：

1. **维度覆盖**：5 个设计维度（反工具围栏/章节模板/Analysis草稿区/Partial Compact/自定义指令）是否均有检查项？
2. **P0 判断准确**：反工具围栏和 Current Work 原文引用的 P0 定位是否合理（缺少确实=压缩失败/任务漂移）？
3. **P1 判断准确**：Partial Compact 变体和自定义指令注入的 P1 定位是否合理？通用 compact 不应依赖用户自定义配置，但变体选择在特定场景可以跳过。
4. **引用完整**：每个检查项是否标注了违反的原则编号和导致的失败模式编号？
5. **可判定性**："措辞强度足够"如何客观判定？需要给出更具体的判定标准（如至少 2 次 CRITICAL 声明 + 列出具体禁用工具）。

---

## 快速参考

审查完成后对照此表做最终确认：

| 原则 | 此载体语境 |
|------|----------|
| P7 防注入分层 | Compact prompt 处理不可信数据（用户对话、工具结果），必须有围栏防止注入 |
| P12 跨模型交接 | 接收方需被告知"这是另一个模型的摘要"——framing 决定信任度 |

| 失败模式 | 此载体语境 |
|---------|----------|
| F1 规则被忽略 | 接收方忽略 compact 中的约束，自由发挥导致任务漂移 |
| F2 目标降级 | 接收方只关注摘要的表面任务，忽略紧凑前的完整目标 |
