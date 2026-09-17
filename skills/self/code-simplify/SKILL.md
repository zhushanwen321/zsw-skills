---
name: code-simplify
description: >-
  Use when 简化代码、清理本次改动、找简化机会、找死代码、清理重复、全仓去重、
  代码复用优化、抽取重复代码、沉淀工具能力、抽取工具类/静态方法、局部性能优化、
  找性能优化点、simplify、code simplify、简化最近的代码，或 review my changes。

  Not for 找 bug（用 diagnose）、架构重构或全局性能改造（用
  improve-codebase-architecture）、泛化代码审查、或 lint 级格式化。
---

# Code Simplifier

把最近改动的代码变"更容易读懂"而非"更短"，行为严格不变；能复用的不新写，重复逻辑沉淀为可测试的工具。

## 核心原则

1. **先理解再改**：动任何一行前先弄清"为什么这么写"（Chesterton's Fence，查 git blame）。回答不了就别改。
2. **复用优先**：动手前先盘点既有工具代码——能复用不新写，差一点扩展后复用；重复逻辑抽成可测试的工具/静态方法持续沉淀工具层。
3. **行为严格不变**：只改"怎么做"，不改"做什么"；输入/输出/副作用/错误路径顺序全一致。要改测试才能过的简化 = 改坏了行为，撤销。
4. **清晰 > 简洁**：明确代码优于紧凑代码，禁嵌套三元。目标是"新成员看懂更快"，不是行数变少。
5. **防过度简化**：不强内联、不合并无关逻辑、不删服务扩展性/可测性的抽象；简化后更难懂 = 失败回滚。
6. **范围收敛 + 确认后改**：默认只动本次改动，不做路过重构；先报告，用户确认才动手。

## 路由

| 用户意图 | 应加载的文档 | 备注 |
|---------|------------|------|
| 开场（被触发时） | `references/workflow.md` | fix 模式（默认）：定范围 → 选策略 → 审查 → 报告 |
| 只要找简化候选（"找找哪里能简化"/"找死代码"/"清理重复"） | `references/scan-candidates.md` | scan 模式：只产候选（TODO/提案），不改代码 |
| 想知道范围怎么定 | `references/scaling.md` | git 提交 / origin main / 用户指定优先级；单/多 agent 决策表 |
| 审查该看什么信号 | `references/review-signals.md` | 复用/质量/结构/命名/冗余/效率 的精确信号清单 |
| 盘点工具 / 检测重复 / 复用优化 / 抽取沉淀 | `references/reuse-optimization.md` | 工具盘点 [MANDATORY 前置]、两层重复检测、三分法、沉淀位置、量化验收 |
| 局部性能优化 / 找性能优化点 | `references/perf-signals.md` | 局部（非架构）性能信号清单、A/B 行为分档、先测量护栏 |
| 需要简化示例 | `references/simplify-examples.md` | TS/Python 正反例对照 |
| 报告/确认后应用 | `references/workflow.md` 第 3-4 节 | 报告格式、增量验证、提交拆分 |

## 关键约束

- [MANDATORY] 被触发后先判模式：用户只要找简化候选（"找机会"/"找死代码"/"清理重复"）→ **必须 read** `references/scan-candidates.md`，按 scan 模式只产候选，**绝不改代码**；否则 → **必须 read** `references/workflow.md` 按 fix 流程执行，禁止凭正文直接开改（避免跳过定范围/策略/确认）。
- [MANDATORY] 先报告、确认后改。报告命中后**等用户确认再应用修改**——不要自动改文件。
- [MANDATORY] 任何简化都不得改变行为：改测试来迁就简化 = 直接撤销。
- [MANDATORY] 执行细节（审查信号、多 agent 拆法、示例）在 `references/` 子文件里，需要时再 read，不内联。
- [MANDATORY] fix 模式在确定范围后、审查前必须做工具盘点（`references/reuse-optimization.md` 步骤 0），产出工具清单；未经盘点不得提议新写工具函数。
- [MANDATORY] 重复检测必须走两层：先确定性工具（jscpd 等），再纯 LLM 语义级补漏（`references/reuse-optimization.md` 步骤 1）；只靠肉眼读文件找重复 = 未完成。
- [MANDATORY] 性能优化只做局部（函数/语句级）改动，架构级（全局缓存模块、模块关系调整等）不在本 skill 范围；B 档（行为敏感）优化必须经用户确认行为差异后才可应用 — 见 `references/perf-signals.md`。
- [OPTIONAL] 大型重构（>500 行）优先用 codemod/AST 工具，别手改 — 见 `references/workflow.md`。

---

## 标记说明

| 标记 | 含义 | 修改约束 |
|------|------|----------|
| `[HISTORICAL]` | 来自实际事故的规则 | **不允许删除或削弱**。只能补充，不能降低要求 |
| `[MANDATORY]` | 流程强制要求 | 必须严格遵守 |
| `[OPTIONAL]` | 可选步骤 | 可按需调整 |

「先理解 / 行为不变 / 降认知复杂度」三条为 `[MANDATORY]` 铁律，任何模式下不可关闭。
