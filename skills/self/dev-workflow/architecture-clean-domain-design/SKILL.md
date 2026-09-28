---
name: architecture-clean-domain-design
description: >-
  Use when 开发前的领域建模与架构分层设计。两大能力：DDD 领域建模（统一语言、限界上下文、
  实体、聚合根、值对象、聚合不变量）+ 六边形架构（hexagonal architecture / clean
  architecture）分层归属判定（领域核心 / 应用层 / 端口 / 适配器 / 组装根）与包目录规划。
  触发词：领域建模、DDD、限界上下文、统一语言、聚合根、值对象、六边形架构、clean
  architecture、分层设计、这块代码该放哪、包目录怎么划、新模块动工前划界、
  领域现状分析。存量代码的领域与架构现状分析（归属错位盘点）同样适用。
  Not for 存量代码的结构质量审查（用 code-arch-review）、diff 行为正确性审查
  （用 code-domain-review）、写设计文档流程本身（用 tech-design / tech-design-wf，
  它们在现状分析章节加载本技能）。
---

# Architecture Clean Domain Design（领域建模 + 六边形分层设计）

设计期技能，一个入口两步分析，回答「业务上有什么、边界在哪」与「代码上这些东西放哪、目录怎么组织」：

1. **领域建模**（DDD，domain-driven design 领域驱动设计）：统一业务语言、划限界上下文、识别实体 / 聚合根 / 值对象、登记聚合不变量
2. **架构分层**（六边形架构 / clean architecture）：判定每个功能 / 文件归属哪个圈层、端口放哪、包目录怎么组织

两步的关系：领域建模产出 = 六边形内圈（领域核心）的内容清单；架构分层负责内圈外围的一切（应用编排、端口、适配器、组装）与整体目录结构。典型顺序：先域后层；存量分析时可两步并行输出对照表。

## 路由

| 用户意图 | read |
|---|---|
| 领域建模 / 术语统一 / 聚合划分 / 上下文边界 | `references/domain-modeling.md` |
| 圈层归属 / 端口划分 / 包目录结构 / 依赖规则 | `references/hexagonal-layering.md` |
| 两步连跑（典型：新模块动工前 / 存量现状盘点） | 先 domain-modeling 后 hexagonal-layering |

## 产出物与落盘

| 产物 | 内容 | 落盘位置 |
|------|------|---------|
| 统一语言词条 | 术语 + 定义 + Avoid 别名 | 项目 `CONTEXT.md`（纯词表，格式见 domain-modeling.md；无则创建） |
| 领域模型登记 | 上下文边界 + 聚合清单 + 聚合不变量 | `docs/domain-model.md`（格式样例见 domain-modeling.md） |
| 圈层归属表 | 功能 / 文件 → 圈层 → 包目录 → 端口归属 → 违规预警 | 设计产物，随设计文档或交付汇报呈现（格式见 hexagonal-layering.md） |

## 与其他技能的关系

| 技能 | 关系 |
|------|------|
| tech-design / tech-design-wf | 本技能是设计文档「现状与问题分析」章节的方法论供应商（tech-design-wf 的 T1 Step 2 已接线加载） |
| code-domain-review | 消费本技能的领域登记（聚合不变量、统一语言）作 diff 行为核对基准；登记缺失时降级为纯骨架审查 |
| code-arch-review | 消费本技能的圈层归属表与依赖规则作结构合规核对基准 |
| architecture-improve-loop | 循环编排技能；可挂载 code-arch-review 做自动循环修复 |

## 关键纪律

- [MANDATORY] 概念必须先在统一语言登记再使用：设计过程中引入的每个领域概念（实体 / 值对象 / 聚合根名）都进 CONTEXT.md 词条，未登记概念不得出现在设计产物里
- [MANDATORY] 聚合不变量必须可核对：每条写成「外部可对照 diff / 测试验证的规则语句」（如「订单支付后金额不可再改」），不写「保持一致性」类不可检验表述
- [MANDATORY] 依赖规则是硬约束：任何圈层归属判定与目录建议不得违反「源码依赖指向内」；现有代码违反时在归属表「违规预警」列如实登记，不得默认现状合法
- 简单域不硬套：CRUD 级领域按「实体 + 仓库端口」最小形态处理，不为方法论完整度强拆聚合与上下文（对齐 code-overdesign-audit 的投机抽象判据）

## 标记说明

| 标记 | 含义 |
|------|------|
| `[MANDATORY]` | 建模纪律，必须严格遵守 |
