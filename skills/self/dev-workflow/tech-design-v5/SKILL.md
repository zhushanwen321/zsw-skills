---
name: tech-design-v5
# 技能版本唯一权威（手动 semver）。bump 语义：MAJOR = 数据契约变更（须伴随 schemaVersion 升号）/
# MINOR = 行为新增（新参数、新阶段）/ PATCH = 修复与措辞。构建器（scripts/build-workflows.mjs）
# 读此值注入产物 SKILL_VERSION——改本行后必须重跑该构建，--check 对账版本戳
version: 5.1.1
description: >-
  Use when 在已批准目标与验收（delivery-v5 产出）的约束下三阶段推敲方案并产出完整设计包：
  写技术设计文档 → 对抗式审查循环 → 实施计划（impl-plan 双格式），用户确认后登记方案包
  （DesignApproved）交 dev-flow-v5 执行。三技能体系的技能②（裁判 = delivery-v5）。
  触发词：「三阶段设计」「设计包」「方案推敲」；「优化表达」「换个说法」「agent 说得太绕」（借用 flow/express.md 易理解性准则优化沟通表达，不走 review 流程）。
  每阶段结束默认停下等用户确认，前期授权可连跑。含 W1 tech-review-loop-v5 审查循环
  （workflow 就绪前走内置手工路径）。
  Not for 未验收定义就直接设计（先走 delivery-v5 的验收设计）、写代码实现、写测试（用 test-quality）、
  纯架构分析无文档产出、体系外独立设计（用户明确不走交付体系）。
---

# tech-design-v5（技能②：设计——三技能交付体系的生产侧上游）

本技能是三技能体系的技能②：**在已批准的目标与验收（delivery-v5 = 技能①产出）约束下推敲方案**。
方案可以换，验收不跟着方案改——发现验收本身有遗漏时，回 delivery-v5 递增 acceptanceVersion 重批，
不在本技能内顺手改判据。产出经用户确认后登记 DesignApproved（绑方案包哈希），作为 dev-flow-v5
（技能③）的入口输入之一。

**入口门 [MANDATORY]**：T1 开始前，交付任务目录必须存在已批准的 acceptance.json——用
`node ~/.agents/skills/delivery-v5/scripts/delivery-gate.mjs evaluate --task-dir <taskDir>` 检查，
state 须为 `design`（已批准、待方案——验收版本递增重批后 DesignApproved 失效、state 亦回到该态，重入设计走同一判据；该判据仅对应 verdict-rules `requireDesignApproved` 默认 true 的任务）。verdict-rules `requireDesignApproved=false` 的任务 state 不落 design（delivery-gate 状态路由跳过 design 分支，直接落到 acceptance-approved）：该策略下设计阶段非裁决前置，不得按「未批准」误判回 delivery-v5；仍需推敲方案时按用户明确要求进入（照常走三阶段并 record-design-approved）。缺任务目录或未批准 → 停止并回 delivery-v5 走验收设计
（用户明确不走交付体系的独立设计任务不经本门，按普通任务处理）。设计包全程绑定该任务的
acceptanceVersion 与 acceptancePackageSha256。

**三阶段产出完整设计包**，每阶段结束默认停下向用户确认产出是否合理，确认后进下一阶段：

```
T1 设计文档（Step 0 问题定义 → Step D 诊断期 → Step 1-5 写作 → Step 6 自检 → Step 7 用例走查）
   │ 确认
   ▼
T2 审查循环（四席并行审查 → 聚合裁决独立 phase → 修复循环至收敛；方向审 rewrite 档击穿整循环终止）
   │ 确认
   ▼
T3 实施计划（impl-plan 双格式 + 三类关联声明 associations + 自检 + 并行度复审）
   │ 确认（A 级逐条、B 级扫清单）
   ▼
方案包确认 → 主会话 record-design-approved（绑方案包哈希清单）→ dev-flow-v5 候选实现
```

- **跳过确认的唯一通道 = 前期授权**：用户宣布全托管/夜间托管，或显式说「一路执行」时三阶段连续推进，阶段产出仍完整呈现（陈述性展示，不构成等待点）
- **T2 进场门槛 = 机器项全绿 [MANDATORY]**：进 T2 派审前 `scripts/check-design-doc.mjs` 对设计目录跑必须 exit 0（T1 Step 6 机器自检跑同一脚本）——六文件完整、跨章节引用存在、导航对齐这类机器可查的写作完备性问题在 T1 拦截，T2 审查不花轮次报它们（执行细节见 `flow/review.md` T2 进场门槛节）
- **用语规范 [MANDATORY]**：T1 动笔写设计文档前必须加载 meta-words-guidance skill（zcode 用 Skill 工具；pi / 无 Skill 工具环境直接 Read `~/.agents/skills/meta-words-guidance/SKILL.md` 及其词表），写出的文档必须遵守其中的用语规范（四张词表逐条适用 + 该 skill 的扫描自查），细则见 `flow/write.md` 头部
- 确认的裁决维度：T1 = 问题定义、方案方向与用例走查缺口处置；T2 = 审查是否真收敛（含方向审一句话判定的转述）；T3 = 拆分粒度与验收计划。打回 = 回该阶段或上一阶段修订。**T1/T3 确认点以「人工审核导航」为入口**：每条关键决策写作期已定审核级别（A = 必须逐条裁决 / B = 无异议即过 / C = 局部实现细节不入决策节），用户只逐条裁决 A 级、扫 B 级清单，无需通读全文；分级判据与六维影响评估（架构/功能/复杂度/性能/资源/红线触碰）见 `references/review-guide-rubric.md`
- **与 tech-design-dev / tech-design-v4 及归档代的关系**：dev 为加固线（v2 分叉，交付语义同源），v4 为质量传递线（机制对账、反例场景测试绑定、T2 冲突清零门）；v1 / v2 / v3 已归档（仓库根 `.archived/`，不入版本库），不再作为正式技能。v5 增加循环上限收编：T2 方向审 rewrite 档打回的重写回边至多 2 次（attempt 计数，超限停回用户裁决——不再回 T1 重写），验收复审轮预算见 delivery-v5。入口门、验收绑定与 DesignApproved 登记沿用 v3（归档代基线），workflow 执行韧性沿用 dev。

## 设计包（dev-flow-v5 的唯一入口输入）

设计包整体落 tech-design 段，目录按寻址双形态（算法与约定见 `skill-data-addressing.md`——`<zsw-skills 检出根>/skills/self/dev-workflow/references/skill-data-addressing.md`，本节不内联）：workspace 形态（同仓多个 worktree 同父目录）= `~/.agents/skill-data/tech-design/<ws-slug>/`——工作区级共享、无 worktree 段，任何 worktree 的入口门都发现同一设计包；单仓形态 = `~/.agents/skill-data/tech-design/<project-slug>/`（现行平铺，路径不变）。两级化只换父目录，`<ws-slug>/` 内部排布与现行目录完全一致；两种 slug 由 workflow 脚本按 projectRoot 检测后自动拼接。用户传参（designDoc / projectRoot 等）一律传绝对路径，不手拼 slug。下表路径均相对该目录：

| 文件 | 产生者 | 机械可查判据 |
|------|--------|-------------|
| `meta.json` 内的 `acceptanceBinding`（acceptanceVersion + acceptancePackageSha256 + taskDir） | T1 入口门写入 | 与交付任务目录当前批准一致——T3 入口自检比对 `delivery-gate evaluate` 输出的 acceptanceVersion / acceptancePackageSha256（flow/plan.md 入口自检第 4 条），dev-flow-v5 D0 编译门 `check-exec-plan.mjs --task-dir` 复算验收包联合哈希机器核对（其 flow/compile.md 步骤 3）；验收版本变化后旧设计包不可直接进 T3/dev-flow-v5 入口（须重新影响审查） |
| `<name>/`（设计文档目录：六章节 JSON `meta.json` / `s1-context.json` / `s2-status.json` / `s3-solution.json` / `s4-accept.json` / `s5-breakdown.json`——权威源，字段规格见 `references/design-doc-schema.md`）+ `<name>.rendered.md`（渲染视图，`scripts/render-design-doc.mjs` 生成，非权威） | T1 | `scripts/check-design-doc.mjs` 对设计目录 exit 0 |
| `<name>.impl-plan.md` + `<name>.impl-plan.json`（双格式） | T3 | 两文件存在且单元 id 集一致 |
| `<name>.symbol-watchlist.json`（符号词表） | T3 | 文件存在且 sourceFingerprints 与源文档当前 sha256 一致（design-code-sync 发起时机器复验；词集漂移经 wordsDrift 软监测不拒启） |
| `<name>/` 内审查产物（`round-N/` 四席报告——review-direction / review-main / review-impact / review-simplicity——与处置表）+ `<name>/final.json`（终态记录，designDoc 字段 = 设计目录） | T2 | 目录存在且 final.json.terminated == "converged" |
| `<name>.plan-review.md`（并行度复审） | T3 | 触发门槛（关键路径深度 ≥3 或单元 ≥4）时必须存在；未触发缺省合法 |

## 意图路由

| 用户意图 | read |
|---|---|
| 开始三阶段（拿到问题/需求） | `flow/write.md`（T1 全程，含 Step 0 问题定义与 Step D 诊断期） |
| T1 用例走查（方向确定性检查 / 生成用例 / 派走查 / 缺口反哺） | `flow/write.md` Step 7 |
| T2 审查循环（发起/复审/手工降级） | `flow/review.md` |
| T3 实施计划（审查收敛后） | `flow/plan.md` |
| 审查后修复 / 多轮循环协议 | `flow/write.md` Step 8（循环由 must-fix 驱动 + 处置三态） |
| 七原则 / 产物表 / 设计分型 | `references/principles.md` |
| 问结构/原则/反模式/验收最佳实践 | `references/`（doc-structure / design-principles / anti-patterns / acceptance-practices） |
| 决策审核分级（A/B/C 判据 + 六维影响评估 + 导航节格式） | `references/review-guide-rubric.md` |
| 行为 × 状态组合类决策的裁决材料（穷举矩阵 + 视觉元素 HTML demo） | `references/enumeration-matrix.md` |
| 要设计文档模板（六章节 JSON 起步样例） | `resources/templates/design-doc/` |
| 优化表达 / 换个说法 / agent 说得太绕 | `flow/express.md`（一次性表达优化，不写文档不派 review） |

## 方案包确认与登记（T3 之后的技能①衔接点）

T3 确认通过即形成**完整方案包** = 设计文档目录 + `<name>.impl-plan.md/.json` + 审查终态（final.json）+
方案决策记录。用户确认（A 级逐条、B 级扫清单）后，主会话执行：

```bash
# 方案包哈希清单：逐文件 name+sha256（solution 主文档取渲染视图、impl-plan 双格式、final.json、决策记录）
node ~/.agents/skills/delivery-v5/scripts/delivery-gate.mjs record-design-approved   --task-dir <交付任务目录> --summary "方案包确认"   --package-file <方案包哈希清单 JSON> --credential <user credentialId>
```

方案包或验收版本变化后 DesignApproved 自动失效（重新确认）。**方案包不得变更 increments.json 的增量契约**
（增量×需求×测试命令由技能①的 acceptance-design 产出并随验收包批准）——impl-plan 只细化实施步骤与调度，
逐增量核对要求见 `flow/plan.md`「增量契约对齐」节。

**decisionRef（决策记录落点）**：`record-design-approved` 不传 `--decision-file` 时 decisionRef 缺省指向
交付任务目录 `evidence/design-decisions.md`——主会话在执行登记命令前把 A/B 级决策清单写入该文件
（从 `meta.json` reviewNav 导出：decisionId / level / title / anchor，各附一句结论与用户裁决结果），
使裁决与复核可回溯（该文件同时计入方案包哈希清单）；决策记录放别处时显式传 `--decision-file <路径>`。

## W1 workflow 契约（执行体按宿主环境选择）

T2 审查循环的脚本化执行体有两版（业务逻辑逐行一致，仅 agent 调用层与文件头不同），按当前环境选择：

| 宿主环境 | 判别信号 | 执行体与发起方式 |
|---------|---------|----------------|
| zcode | 会话可见 CreateWorkflow 工具 / saved workflows | saved workflow `tech-review-loop-v5`（`CreateWorkflow saved` 发起） |
| pi（subagent-workflow extension） | 宿主为 pi coding agent、workflow 工具可用 | 本 skill 安装位置上级的 `../workflows/pi/tech-review-loop-v5.js`——复制或 symlink 到 `~/.pi/agent/workflows/`（或项目 `.pi/workflows/`）后 `workflow run tech-review-loop-v5 --args designDoc=<路径> projectRoot=<路径> maxRounds=<N>`（数组型参数 reviewers 不支持——--args 值全字符串，用缺省四件模板） |

**两版均未就绪或发起失败时走 `flow/review.md` 内置手工路径**（语义等价）。发起参数：`{ designDoc, projectRoot, maxRounds?, reviewers?, taskId?, executionId?, sampleType?, attempt? }`——designDoc = 设计目录绝对路径（或其渲染 md 路径，workflow 内部归一为设计目录；reviewers = 自定义 reviewer 模板绝对路径数组，缺省用本技能 agents/ 默认四件 = 方向审 `tech-design-direction-review` + 三审 `tech-design-review-v5` / `tech-design-impact-review` / `tech-design-simplicity-review`；attempt = 重发起序号——环境失败族重发时递增，防轮次产物覆盖；缺省时自动检测已有产物并递增）；终态：converged / direction-rejected / escalated / stuck / max-rounds + setup-failure / review-failure / aggregator-failure / fix-failure（环境失败族，处置 = 按 message 恢复动作重发，attempt 递增防产物覆盖）——除 converged 外全部停回主 agent 处理（见 review.md 终态处置表）。

**关键决策分级收敛（V5 代，裁决规则 2026-11-15）**：聚合裁决对每条聚合项标注 impact 分级——critical（影响关键 ADR / 关键设计决策：分型、公理/不变量、问题定义、方案主干、关键决策的前提失实或矛盾、影响决策走向的事实错误）进修复循环参与收敛计数；minor（不影响关键决策：登记缺口、产物表完备性、非关键措辞、实施期探针补登记）不进循环，跨轮收集，converged 或触顶时统一落盘 `minor-findings.json`——主 agent 最后一波统一处理或登记放行。收敛判据只看 critical（两场实跑教训：patch 档前提层问题与关键决策问题等权计数时，T2 十轮触顶、约 4 亿 token 仍未收敛）。触顶/stuck 终态的 `remaining` 逐条带 `guidance`（最后一次聚合的可执行处方）与 `reportRefs`（报告锚点）——主 agent 按清单直接处置后登记 dispositions，不必再派复审 run；final.json 续跑前自动转存 `final.attempt-N.json`（防跨 run 轨迹覆盖）。

**阶段事件观测（可选）**：`taskId` 与 `executionId` 同时传入即启用——每次执行的阶段边界（setup / review / aggregate / fix / finalize）逐行记录到 `~/.agents/skill-data/workflow-observability/<task-id>/<execution-id>.jsonl`，skill 恒 `tech-design-v5`（canonical 技能名，非 workflow 脚本名）、stage 恒 `T2`。task_id = 本次设计包任务标识（建议 = 设计包 `<name>`，进 dev-flow-v5 执行时同一 task_id 延续共用）；execution_id = 本次审查发起标识（建议 `T2-<发起时点短时间戳>`）。两参都不传 = 观测关闭、业务照常；只传其一 = 告警并关闭；观测写失败只告警不改终态。事件契约与 D0/D4/D6 外部步骤的记录命令见 dev-flow-v5 SKILL 的「阶段事件观测」节（`~/.agents/skills/dev-flow-v5/SKILL.md`）。耗时与 token 统计：`node <zsw-skills 检出根>/scripts/skill-usage-stats.mjs --skill tech-design-v5`（阶段窗口来自观测事件、token 经 `agent-session-reader usage` 双平台重算，口径详见该命令 `--help` 与 dev-flow-v5 SKILL「统计入口」节）。

## 核心红线（14 条，详解见 references/design-principles.md 与 references/principles.md）

1. [MANDATORY] 五段骨架：背景目标 → 现状与问题 → 解决方案（演进型多方案对比 / 终态型公理与迁移路径）→ 验收 → 下一层拆分——权威载体 = 设计目录内六章节 JSON（章节对应表见 `references/doc-structure.md`），渲染视图按五段展示，语义不变
2. [MANDATORY] 方案对比 ≥2：演进型评长期/短期/风险给推荐并标注触及的最高 P 级；终态型用迁移路径对比（候选至少含一次到位与分波次两型），成本只呈现不作推荐依据
3. [MANDATORY] 使用者视角主线 + 抽象概念配真实例子锚定
4. [MANDATORY] 自包含 + 结论先行：SCQA 开篇、每章首句结论
5. [MANDATORY] scope = 当前层 → 紧邻下一层，不跨 2 层
6. [MANDATORY] 全流程坐标系：端到端大流程图 + 问题点/决策以环节锚定
7. [MANDATORY] 验收用真实场景（非单测非 mock）+ e2e 影响面评估固定子节
8. [MANDATORY] 陈述四分类（事实/推断/知识/决策）推断必核实 + 绝对化断言禁令（改写为取舍表）
9. [MANDATORY] 决策审核分级：关键决策每条定 A/B 级（C 级挪实现机制内容），`meta.json` 落 reviewNav 且 decisionId 集与 s3 decisions 的 id 集完全一致（渲染为头部「人工审核导航」表）；判据见 `references/review-guide-rubric.md`
10. [MANDATORY] 原则层强制：Step D 逐条扫描七原则（P1-P7）触发条件，触发的必须执行其执行步骤并产出对应产物表，P5 推断核实全量强制；规格见 `references/principles.md`
11. [MANDATORY] 设计分型声明：`meta.json` 标注 designType（terminal / evolution）与 typeRationale（终态型 = 用户显式要求 / 修复史判定「未修到」/ 架构级设计对象，任一即触发；演进型附「为什么不需要终态视角」辩护——渲染为头部分型声明）
12. [MANDATORY] T2 进场门槛 = 机器项全绿：`scripts/check-design-doc.mjs` 对设计目录 exit 0 才派审，机器可查的写作完备性问题不带进 T2
13. [MANDATORY] 处置三态：审查唯一报告级别 = must-fix，每条 finding 处置 fixed（修复）/ deferred（登记不修）/ archived（归档）之一并逐条记录
14. [MANDATORY] 单波次交付：一个需求 = 一份设计文档 + 一份 impl-plan，未经用户明确指示禁止拆成多个波次分别走完整流程；例外 = 终态型波次可标注目标交付版本（项目存在版本化交付队列时），各期共用同一设计文档与审查终态，分期映射在 T3 确认点一次批准

> 红线细则与操作化表达在 `flow/write.md` 对应 Step 内；完整准则见 `references/design-principles.md`。问题定义先行（前置探明门 + 产品最小形态三问）与直接解决优先同样强制，因属流程步骤而非文档判据，落在 `flow/write.md` Step 0 与 Step 3 承载，不占本清单条目。

## 层适配

层无关——差异只在 §3/§4 侧重点（子系统划分 / 需求集合 / 接口与数据模型 / 测试用例与代码任务），完整调节表见 `references/doc-structure.md` 末尾。**下一层产物 = 代码任务/技术方案的设计才进 T3**；到子系统/需求集合为止的设计在 T2 收敛即交付（无 T3）。

## 审查：四席并行（方向审席 + 三 reviewer）

四席并行审查（T2）：`tech-design-direction-review` 方向审席与三 reviewer 同轮并行、同一对账契约，判据 D1-D5（D1 分型正确 / D2 前提可击穿：否定性断言找写者侧反例、穷举断言（exhaustive=true 声明行）按 searchCmd 登记的检索命令重跑对账、✅ 条目抽样复核实 / D3 终态有效：公理是真不变量、差距表无漏项、波次不制造新差距 / D4 产物表完整且真实：漏行与行级填表不实都算 / D5 问题定义忠于真问题）；发现分档：patch 档（前提层/产物表/措辞级——问题定义与方案主干不动）进当轮问题清单由文档修复者随三审发现一并处置，rewrite 档（问题定义/方案主干/分型被击穿）**整循环立即终止**回 T1 重做（含 Step D 诊断期重跑）。三 reviewer（`tech-design-review-v5` 主审：方案级判据 + 断言-红灯映射表核对 / `tech-design-impact-review` 影响面审：写入点穷举与代价量化 / `tech-design-simplicity-review` 简洁审：机制必要性与概念数净增；agent 定义在 `agents/`，分工判据在 `review/rubric-design-doc.md`）。审查与修复分离：agent 只报告不代改。**聚合裁决是独立 phase**：四席返回后先派聚合裁决员把发现按同根因合并为去重权威清单（`round-N/aggregated.md`；refs 对原始清单的精确划分由脚本 fail-closed 校验——漏报/重叠/幻觉 ref 均打回），修复者据聚合清单处置，语义去重不落在修复者身上。修复按 `flow/write.md` Step 8 循环协议。**轮次唯一形态：每轮 = 四席审 + 修复（R1 全面、R2+ 只审上轮处置表 + 攻击点——方向审席另重跑穷举断言 searchCmd 登记的检索命令对账），不存在全面审+聚焦审双重派发**。

## 标记说明

| 标记 | 含义 |
|------|------|
| `[MANDATORY]` | 写作红线，不遵守文档不合格 |
| （无标记） | 强烈建议 |

本 skill 无 `[HISTORICAL]` 项；老 tech-design 的事故教训经其 [HISTORICAL] 条目承载，可参照。
