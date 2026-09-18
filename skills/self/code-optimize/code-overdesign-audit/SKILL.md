---
name: code-overdesign-audit
description: >-
  Use when 审计过度设计、过度抽象、审计复杂度、复杂度过高、找投机抽象、
  speculative generality、YAGNI 审计、高杠杆简化、大简化、
  over-engineering audit、简化设计、删抽象、删间接层、这段设计是不是过度了。
  识别「只需简化一点点设计，就能大幅提升可维护性/可理解性」的高杠杆点：
  三层证据（可计算信号+语义四问+业务保证映射）→ 杠杆排序 → 候选卡片
  （小取舍→大简化→核心无损三段论证）→ 用户裁决后才执行。

  Not for 模块做深、deepening、可测试性重构（用 improve-codebase-architecture）；
  简化最近的代码、清理本次改动、死代码、去重、复用优化（用 code-simplify）；
  代码规范检查、lint 级问题（lint 工具领地）；找 bug（用 diagnose）。
---

# Over-Engineering Audit

把「过度复杂设计」变成可裁决的简化候选：每张候选卡片论证三段——牺牲什么保证（小取舍）、省下什么机制（大简化）、为什么核心价值无损（价值锚）。设计文档是本 skill 的 SSOT：`<skill_dir>/docs/plans/2026-09-10-over-engineering-audit-skill.md`（本 skill 内，随仓库分发）。

被触发后先判模式，再按路由 read 对应文档；细节全部在 references，正文不含。

## 核心原则

1. **先证据后判定**：语义层的每个「投机」判定必须附调用方清单与证据行号，无证据的怀疑丢弃——复杂度高 ≠ 过度设计（可能是本质复杂度），分层转发型过度设计单点复杂度都很低。
2. **裁决权在人**：audit 模式只产报告，绝不自动改代码；候选经用户裁决（grilling 确认取舍边界）后才进入执行。报告先于执行。
3. **语义判定必须抽验**：subagent 报告的「投机」结论，主 agent 抽验 ≥1 个调用方真实存在（实际读调用点代码）后才进候选——防 LLM 幻觉调用方缺失。
4. **粗网细网分工**：pre-commit 断言是粗网（宁漏勿拦，四类已知漏拦由 audit 细网兜底）；audit 是细网（knip 精确分析 + 语义四问，不依赖 grep 计数）。
5. **简化后更难懂 = 失败**：与 code-simplify 同铁律——改测试迁就简化 = 撤销；「更简单」的定义是概念数下降（读者需理解的独立概念），不是行数变少。

## 模式路由

| 模式 | 触发 | 流程 |
|------|------|------|
| **audit**（默认） | 「审计过度设计」「扫一遍这个仓库/模块」 | 五步全流程：定范围 → 三层证据 → 杠杆排序 → 卡片报告 → 结束回合等裁决 |
| **复核豁免** | 「复核一下 oe-exempt」「豁免清一下」 | read `references/ci-assertions.md` 步骤 0 同款 grep 汇总 → 逐条按日期/类目复核 → 更新基线复核队列 |
| **裁决后执行** | 用户在历史报告/基线上说「砍候选 N」 | read `references/report-and-grilling.md` 的执行协议，从裁决步续跑 |

## 五步流程骨架（audit 模式）

1. **定范围**：用户指定模块优先；未指定则用 git 近 30 天活跃路径圈定（变更热度 = 杠杆分母，没人碰的代码里的简化机会永远兑现不了）。audit 步骤 0 固定先 `grep -r "oe-exempt:"` 汇总既有豁免（按日期排序、过期标红），复核队列写入基线。
2. **三层证据**：read `references/evidence-signals.md`——可计算层（knip/转发占比/单实现接口/链深，bash 并行）+ 语义层（subagent 按四问×模块分组并行扫，派发模板同文件）+ 业务层（读设计文档/ADR 映射保证→调用方）。
3. **杠杆排序**：read `references/ranking-model.md`——投机判定为入围门槛（非排序分），三维定性评分（**简化收益 / 执行成本 / 综合**），综合降序 + 成本升序 tie-break，刻意不造公式。
4. **卡片报告**：read `references/report-and-grilling.md`——markdown 写 `<项目根>/.tmp/code-overdesign-audit/code-overdesign-audit-<ts>.md`（项目根 = `git rev-parse --show-toplevel`；目标非 git 仓库时落 `/tmp/code-overdesign-audit/`），含候选卡片（三段论证+推荐强度）与「已核实非过度」节，然后**结束回合等裁决**（挂起模式，夜间托管兼容）。
5. **裁决后执行**：用户挑选候选 → grilling 确认取舍边界 → 架构级删减由本 skill 执行（跑受影响测试）；语句级清理移交 code-simplify；裁决结论与非过度清单写基线 `<项目根>/.tmp/code-overdesign-audit/baseline.md`（目标非 git 仓库时写 `/tmp/code-overdesign-audit/<repo 标识>/baseline.md`）。

## 关键约束

- [MANDATORY] 被触发后先判模式（audit/复核豁免/裁决后执行），按路由 read 对应文档后再动作，禁止凭正文直接开扫（避免跳过定范围/派发规格/排序规则）。
- [MANDATORY] audit 模式对目标仓库零写入（knip/grep/subagent 均只读）；报告与基线只写 `<项目根>/.tmp/code-overdesign-audit/`（非 git 目标写 `/tmp/code-overdesign-audit/`）。报告落盘 + 给绝对路径后**结束回合等用户裁决**，禁止在等待裁决上空转或自动继续。
- [MANDATORY] 语义层 subagent 的「投机」判定必须附调用方清单，主 agent 抽验 ≥1 个调用方（实际读调用点代码）后才进候选；测试文件算不算调用方、动态调用、跨包 re-export 三类分歧点必须实际核查。
- [MANDATORY] 派发遵守全局 AGENTS.md：并发 ≤5、单 subagent ≤5 文件/3000 行、task 三段式、模型按全局路由表（扫描用 flash 级、thinking max）、一律后台异步派发靠通知推进。subagent 不自动加载 skill——四问清单与反模式清单必须内联进派发提示词（模板见 evidence-signals.md）。
- [MANDATORY] 执行边界：改测试迁就简化 = 直接撤销；行为变更类取舍必须在裁决确认中写明「取舍后的新行为」，它就是验收标准；架构级删减留本 skill，语句级清理移交 code-simplify（报告「另有 N 处代码级清理点」）。
- [MANDATORY] 「已核实非过度」条目必须附证据快照（调用方清单+计数）；下次审计时调用方计数较快照变化的条目强制重验，未变才可复用。
- [OPTIONAL] 报告可粘贴进 issue/ADR 复用；用户裁决后可建议把「已核实非过度」的重要判定沉淀为 ADR（防未来重复建议）。

## 标记说明

| 标记 | 含义 | 修改约束 |
|------|------|----------|
| `[HISTORICAL]` | 来自实际事故的规则 | 不允许删除或削弱，只能补充 |
| `[MANDATORY]` | 流程强制要求 | 必须严格遵守 |
| `[OPTIONAL]` | 可选步骤 | 可按需调整 |
