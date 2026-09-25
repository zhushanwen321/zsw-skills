---
name: tech-design-wf
description: >-
  Use when 三阶段产出完整设计包（设计文档 + 实施计划）：写技术设计文档 → 对抗式审查循环 →
  实施计划（impl-plan 双格式）。tech-design 的 workflow 版（灰度并行，老版保留可随时切回）。
  触发词：「三阶段设计」「设计包」「wf 设计」「workflow 版设计」；「优化表达」「换个说法」「agent 说得太绕」（借用 flow/express.md 易理解性准则优化沟通表达，不走 review 流程）。
  每阶段结束默认停下等用户确认，前期授权可连跑。含 W1 tech-review-loop 审查循环
  （workflow 就绪前走内置手工路径）。
  Not for 写代码实现、写测试（用 test-quality）、纯架构分析无文档产出；
  只写设计文档不走三阶段（用老 tech-design）。
---

# tech-design-wf（tech-design 三阶段版）

**三阶段产出完整设计包**，每阶段结束默认停下向用户确认产出是否合理，确认后进下一阶段：

```
T1 写设计文档（Step 0-6）──确认──▶ T2 审查循环（价值审 → 三审 → 修复收敛）
                                              │确认
                                              ▼
                                   T3 实施计划（impl-plan 双格式 + 自检 + 并行度复审）
                                              │确认
                                              ▼
                                        设计包交付 → dev-flow-wf 执行
```

- **跳过确认的唯一通道 = 前期授权**：用户宣布全托管/夜间托管，或显式说「一路执行」时三阶段连续推进，阶段产出仍完整呈现（陈述性展示，不构成等待点）
- 确认的裁决维度：T1 = 问题定义与方案方向；T2 = 审查是否真收敛（含价值审复述的理解校验）；T3 = 拆分粒度与验收计划。打回 = 回该阶段或上一阶段修订
- **与老 tech-design 的关系（灰度并行）**：本技能是流程重构版（impl-plan 创建从 dev-flow 上移至 T3；审查循环 workflow 化），老 tech-design 原样保留——判据面（红线/准则/rubric/reviewer）与老版一致，变量只锁流程形态；任一时点可切回老版

## 设计包（dev-flow-wf 的唯一入口输入）

| 文件 | 产生者 | 机械可查判据 |
|------|--------|-------------|
| `<项目根>/.tmp/tech-design/<name>.md` | T1 | 文件存在 |
| `<name>.impl-plan.md` + `<name>.impl-plan.json`（双格式） | T3 | 两文件存在且单元 id 集一致 |
| `.tmp/tech-design/<name>/`（审查报告目录）+ `<name>/final.json`（终态记录） | T2 | 目录存在且 final.json.terminated == "converged" |
| `<name>.plan-review.md`（并行度复审） | T3 | 触发门槛（关键路径深度 ≥3 或单元 ≥4）时必须存在；未触发缺省合法 |

## 意图路由

| 用户意图 | read |
|---|---|
| 开始三阶段（拿到问题/需求） | `flow/write.md`（T1 全程，含 Step 0 问题定义） |
| T2 审查循环（发起/复审/手工降级） | `flow/review.md` |
| T3 实施计划（审查收敛后） | `flow/plan.md` |
| 审查后修复 / 多轮循环协议 | `flow/write.md` Step 7（循环由 must-fix 驱动 + suggestion 处置制） |
| 问结构/原则/反模式/验收最佳实践 | `references/`（doc-structure / design-principles / anti-patterns / acceptance-practices） |
| 要文档骨架模板 | `resources/templates/design-doc-template.md` |
| 优化表达 / 换个说法 / agent 说得太绕 | `flow/express.md`（一次性表达优化，不写文档不派 review） |

## W1 workflow 契约（执行体按宿主环境选择）

T2 审查循环的脚本化执行体有两版（业务逻辑逐行一致，仅 agent 调用层与文件头不同），按当前环境选择：

| 宿主环境 | 判别信号 | 执行体与发起方式 |
|---------|---------|----------------|
| zcode | 会话可见 CreateWorkflow 工具 / saved workflows | saved workflow `tech-review-loop`（`CreateWorkflow saved` 发起） |
| pi（subagent-workflow extension） | 宿主为 pi coding agent、workflow 工具可用 | 本 skill 安装位置上级的 `../workflows/pi/tech-review-loop.js`——复制或 symlink 到 `~/.pi/agent/workflows/`（或项目 `.pi/workflows/`）后 `workflow run tech-review-loop --args designDoc=<路径> projectRoot=<路径> maxRounds=<N>`（数组型参数 reviewers 不支持——--args 值全字符串，用缺省四件模板） |

**两版均未就绪或发起失败时走 `flow/review.md` 内置手工路径**（语义等价）。发起参数：`{ designDoc, projectRoot, maxRounds?, reviewers? }`（reviewers = 自定义 reviewer 模板绝对路径数组，缺省用本技能 agents/ 默认四件）；终态：converged / value-rejected / escalated / stuck / max-rounds + setup-failure / review-failure / fix-failure（环境失败族，处置 = 按 message 恢复动作重发，attempt 递增防产物覆盖）——除 converged 外全部停回主 agent 处理（见 review.md 停回通道表）。

## 核心红线（11 条，详解见 references/design-principles.md）

1. [MANDATORY] 问题定义先行：前置探明门 + 产品最小形态三问 + 前提清单节；未探明先调研，禁止猜
2. [MANDATORY] 产品最小形态前置：最小形态主干 / 增量逐项裁决 / 扩展点须已发生证据
3. [MANDATORY] 五段骨架：背景目标 → 现状与问题 → 解决方案（多方案对比）→ 验收 → 下一层拆分
4. [MANDATORY] 方案对比 ≥2，评长期/短期/风险给推荐；标注触及的最高 P 级（功能分级登记表取）
5. [MANDATORY] 使用者视角主线 + 抽象锚定例子
6. [MANDATORY] 自包含 + 结论先行；SCQA 开篇、每章首句结论
7. [MANDATORY] scope = 当前层 → 紧邻下一层，不跨 2 层
8. [MANDATORY] 全流程坐标系：端到端大流程图 + 问题点/决策以环节锚定
9. [MANDATORY] 验收用真实场景（非单测非 mock）+ e2e 影响面评估
10. [MANDATORY] 陈述四分类推断必核实 + 绝对化断言禁令（改写为取舍表）
11. [MANDATORY] 直接解决优先：定级 → 路线显式进对比 → 方案落病因环节 → 非功能后置三档裁决

> 红线细则与操作化表达在 `flow/write.md` 对应 Step 内；完整 14 条准则见 `references/design-principles.md`。

## 层适配

层无关——差异只在 §3/§4 侧重点（子系统划分 / 需求集合 / 接口与数据模型 / 测试用例与代码任务），完整调节表见 `references/doc-structure.md` 末尾。**下一层产物 = 代码任务/技术方案的设计才进 T3**；到子系统/需求集合为止的设计在 T2 收敛即交付（无 T3）。

## 审查：价值评审先行 + 三 reviewer 并行

两阶段审查（T2）：`tech-design-value-review` 先行（一句话复述测试/问题值不值得这么解/最小形态检查）——must-fix > 0 打回重写**不派三审**；通过后三 reviewer 并行（`tech-design-review` 主审 / `tech-design-impact-review` 影响面审 / `tech-design-simplicity-review` 简洁审，agent 定义在 `agents/`，分工判据在 `review/rubric-design-doc.md`）。审查与修复分离：agent 只报告不代改；修复按 `flow/write.md` Step 7 循环协议。**轮次唯一形态：每轮 = 聚焦审 + 修复（R1 全面、R2+ 只审上轮处置表 + 攻击点），不存在全面审+聚焦审双重派发**。

## 标记说明

| 标记 | 含义 |
|------|------|
| `[MANDATORY]` | 写作红线，不遵守文档不合格 |
| （无标记） | 强烈建议 |

本 skill 无 `[HISTORICAL]` 项（首建）；老 tech-design 的事故教训经其 [HISTORICAL] 条目承载，判据同源继承。
