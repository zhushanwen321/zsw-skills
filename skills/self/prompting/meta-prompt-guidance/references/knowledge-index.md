# 知识索引入口

本文件是知识层的总入口。当需要了解"为什么某条原则有效"或"某个场景该读哪个知识文件"时，先读这里，再按推荐路径跳转。

## 5 个知识模块速览

| 文件 | 回答的问题 | 行数（约） |
|------|-----------|----------|
| `design-principles.md` | 什么原则让 prompt 有效？ | ~150 |
| `failure-mode-taxonomy.md` | 没有好 prompt 时会怎么失败？ | ~130 |
| `carrier-taxonomy.md` | 我要设计的是什么类型的 prompt？ | ~110 |
| `prompt-architecture.md` | prompt 在代码里应该怎么组织？ | ~120 |
| `interaction-patterns.md` | 多个 prompt/工具之间如何协作？ | ~100 |

## 按场景的推荐阅读路径

### 场景 A：我要设计一个新的 Tool Description

**必读原则**：P1（行为约束）、P2（风险∝密度）、P4（反模式枚举）、P6（能力边界）、P9（工具链约束）
**必读失败模式**：F1（规则忽略）、F4（工具误用）、F5（范围蔓延）、F8（链断裂）、F12（优先级网络断裂）
**可选知识**：`interaction-patterns.md`（优先级网络、前置依赖）

```
read references/design-principles.md      # 重点：P1/P2/P4/P6/P9 段落
read references/failure-mode-taxonomy.md  # 重点：F1/F4/F5/F8/F12 段落
read references/carrier-taxonomy.md       # Tool Description 载体维度
```

### 场景 B：我要设计一个新的 System Prompt

**必读原则**：P1（行为约束）、P2（风险∝密度）、P5（示例驱动）、P11（展示独立）
**必读失败模式**：F1（规则忽略）、F6（假完成）、F10（示例空洞）
**可选知识**：`prompt-architecture.md`（static/dynamic 分层）、`carrier-taxonomy.md`（System Prompt 维度）

```
read references/design-principles.md      # 重点：P1/P2/P5/P11 段落
read references/failure-mode-taxonomy.md  # 重点：F1/F6/F10 段落
read references/prompt-architecture.md    # static/dynamic 分层
```

### 场景 C：我要设计一个 Steering Prompt

**必读原则**：P3（数字阈值）、P7（防注入分层）、P8（证据驱动）、P12（交接 framing）
**必读失败模式**：F2（目标降级）、F3（偷懒完成）、F6（假完成）、F7（注入突破）、F9（过早放弃）
**可选知识**：`interaction-patterns.md`（注入防御分层、约束冗余）、`prompt-architecture.md`（模板引擎选择）

```
read references/design-principles.md      # 重点：P3/P7/P8/P12 段落
read references/failure-mode-taxonomy.md  # 重点：F2/F3/F6/F7/F9 段落
read references/interaction-patterns.md   # 注入防御分层
```

### 场景 D：我要设计一个 SKILL.md

**必读原则**：P1（行为约束）、P5（示例驱动）、P11（展示独立）
**必读失败模式**：F1（规则忽略）、F10（示例空洞）
**可选知识**：`carrier-taxonomy.md`（SKILL.md 维度：description 只写"何时用"）

```
read references/design-principles.md      # 重点：P1/P5/P11 段落
read references/failure-mode-taxonomy.md  # 重点：F1/F10 段落
```

### 场景 E：我要审查一个已有的 prompt

审查不需要读完所有知识，按载体类型加载对应审查清单（`review/rubric-XXX.md`）。审查清单中标注了每条检查项关联的原则编号，遇到不理解的编号时回查：

```
read references/design-principles.md      # 查具体原则编号
read references/failure-mode-taxonomy.md  # 查具体失败模式编号
```

### 场景 F：我要理解 prompt 代码工程管理

```
read references/prompt-architecture.md    # 全文：决策树 + 分层 + 缓存
read references/interaction-patterns.md   # 约束冗余策略章节
```

## 原则速查表

| 编号 | 原则 | 在 design-principles.md 的大致位置 |
|------|------|--------------------------------|
| P1 | Description 是行为约束器，不是功能说明书 | 开头第 2 段 |
| P2 | 约束密度与操作风险成正比 | 第 3 段 |
| P3 | 数字阈值优于模糊描述 | 第 4 段 |
| P4 | 反模式需要具体场景枚举 | 第 5 段 |
| P5 | 示例驱动优于规则描述 | 第 6 段 |
| P6 | 能力边界必须显式声明 | 第 7 段 |
| P7 | 防注入必须分层防御（覆盖用户输入+工具结果） | 第 8 段 |
| P8 | Completion 必须证据驱动 | 第 9 段 |
| P9 | 工具链约束在 description 中交叉声明 | 第 10 段 |
| P10 | 生命周期结构优于平铺列表 | 第 11 段 |
| P11 | 结果展示规则独立于结果生成 | 第 12 段 |
| P12 | 跨模型交接必须有显式 framing | 第 13 段 |
| P13 | 人格风格不影响能力只影响交互 | 第 14 段 |
| P14 | 约束有衰减效应，超过阈值后新增约束稀释已有约束 | 第 15 段 |
| P15 | 系统提示词是敏感资产，禁止向用户透露 | 第 16 段 |

## 失败模式速查表

| 编号 | 失败模式 | 一句话描述 |
|------|---------|-----------|
| F1 | 规则被忽略 | 约束太弱、无后果链，模型直接无视 |
| F2 | 目标降级 | 模型偷偷替换为用户更容易完成的目标 |
| F3 | 偷懒完成 | 模型用意图代替证据来论证"已完成" |
| F4 | 工具误用 | 在错误的场景使用工具，或跳过必要工具 |
| F5 | 范围蔓延 | 工具越权做超出权限范围的操作 |
| F6 | 假完成 | 提交"看起来对"但未验证的结果 |
| F7 | 注入突破 | 用户输入中的指令覆盖了系统行为 |
| F8 | 工具链断裂 | 跳过前置依赖步骤直接执行后置步骤 |
| F9 | 过早放弃 | 一次失败就标记 blocked 或停止工作 |
| F10 | 示例空洞 | 有规则但无示例，模型不理解规则边界 |
| F11 | 人格污染 | 能力约束被误写入 Personality 模板 |
| F12 | 优先级网络断裂 | 工具间优先级只有单向声明，缺少交叉引用 |
| F13 | 约束过载 | prompt 中规则太多，核心规则被稀释 |
| F14 | 工具结果注入 | 工具返回的恶意内容被模型当作指令执行 |
| F15 | 提示词泄露 | 用户诱导模型输出系统 prompt 内容 |

---

## 标记说明

| 标记 | 含义 | 修改约束 |
|------|------|----------|
| `[HISTORICAL]` | 历史经验总结 | 不允许删除或削弱 |
| `[MANDATORY]` | 流程强制要求 | 必须严格遵守 |
| `[OPTIONAL]` | 可选步骤 | 可根据需求调整 |
