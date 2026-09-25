---
name: dev-flow-wf
description: >-
  Use when 一份完整设计包（tech-design-wf 产出：设计文档 + 双格式 impl-plan + 审查终态）
  需要落地为已验收代码。dev-flow 的 workflow 版（灰度并行，老版保留可随时切回）：
  纯执行七段——编译 → 开发 → 一致性审查 → 验收 → 收尾 → 终态同步 → 交付后守护。
  触发词：「wf 实施」「按设计包开发」「workflow 版实施」「设计包执行」。
  含 W2 wave-executor / W3 dev-consistency-loop / W4 design-code-sync-loop 三个
  workflow 衔接（就绪前走内置手工路径）。W4 段含 design-code-sync 升级语义
  （三向功能对照矩阵 + 越权三问）。
  Not for 写/审设计文档（用 tech-design-wf 或老 tech-design）；无设计包的 bug 修复
  直接编码；只出计划不写代码（用 lite-plan）；老流程实施（用老 dev-flow）。
---

# dev-flow-wf（dev-flow 纯执行版）

**纯执行**：impl-plan 的创建与审查已上移到 tech-design-wf 的 T3——本技能从「设计包」起步，主 agent 只做编译、发起 workflow、段间裁决、收尾，一切编排细节收归 workflow 确定性通道（workflow 未就绪时走各 flow 文件的手工降级路径，语义等价）。

## 设计包入口门 [MANDATORY]（机械可查）

入口逐行核对（任一缺失 → 拒绝并指明缺什么、回 tech-design-wf 哪个阶段补）：

| 文件 | 判据 |
|------|------|
| `.tmp/tech-design/<name>.md` | 存在 |
| `<name>.impl-plan.md` + `.impl-plan.json` | 存在且单元 id 集一致 |
| `.tmp/tech-design/<name>/final.json` | terminated == "converged" |
| `<name>.plan-review.md` | 触发门槛（关键路径深度 ≥3 或单元 ≥4）时必须存在 |

**外部设计文档直投** → 拒绝，转 tech-design-wf（先补 T2 审查再 T3 拆计划）。

## 执行七段

| 段 | 内容 | 承载 | 推进门 |
|----|------|------|--------|
| D0 编译 | 设计包 → exec-plan.json + 逐节点 promptFile + 初始 status.json + L0 前置 + 环境 smoke | 主 agent | `flow/compile.md` |
| D1 开发循环 | 单元 DAG 流式并行（写码→核验→commit→解锁） | W2 wave-executor（手工路径 `flow/execute.md`） | 全节点 done 或 blocked |
| D2 一致性审查 | diff × 设计对照（R1 全面分区审 / R2+ 定向复审）+ 修复组并行 + Gate A 全量测试 | W3 dev-consistency-loop（手工路径 `flow/consistency-review.md`） | unreasonable 清零 + Gate A 绿 |
| D3 端到端验收 | 验收计划表 L3/L4 编译成 verify/inspect 节点（核心先行 + 短路） | W2 第二实例化（手工路径 `flow/acceptance.md`） | 验收全绿 |
| D4 收尾交付 | 交付汇总 + 功能分级登记 + 文档资产同步 + ADR 复审 + 最终 commit | 主 agent | `flow/acceptance.md` 收尾节 |
| D5 终态同步 | 代码与设计双向校准：三向功能对照矩阵 + 越权三问 + 两级审查拓扑 | W4 design-code-sync-loop（手工路径 `flow/sync.md`） | 矩阵 0 must-fix |
| D6 交付后守护 | 交付后修复回写纪律 + 按需定向对抗审查 | 主 agent | `flow/post-delivery.md`（[HISTORICAL] 原样） |

段间不设用户确认（gate 驱动连续推进）；熔断终态（blocked / stuck / core-failed / contested）停回主 agent 按各 flow 文件的终态表处置。

## 核心原则

1. **编排者零编码**：主 agent 只编译、发起、裁决、commit（workflow 形态下 commit 也归引擎）；一切 src/tests 编写修改走 subagent/节点
2. **门只认证据**：推进只承认命令输出、diff、结构化终态——无证据的「已完成」一律退回
3. **验证方式分级 L0-L4**（低成本高收益前置）：L0 静态规则（主 agent/world.run 直跑）→ L1 增量单测（节点/dev 自跑）→ L2 全量套件（D2 Gate A）→ L3 脚本端到端（verify 节点）→ L4 agent 端到端（inspect 节点）。低级未清不进高级
4. **范围锁定**：节点/dev 只改领地白名单内文件；范围外必改停下上报
5. **git 单点**：subagent 禁止一切 git 写；workflow 形态下 commit 由引擎 world.run 执行（精确路径 add，禁 -A），手工形态下由主 agent 执行
6. **基线先行**：exec-plan.json 落盘即基线（`.tmp/` 不入 git）；执行态事实源 = `<name>.status.json`

## Workflow 契约（zcode 环境执行体，渐进接入）

| workflow | 段 | args | 终态 |
|----------|----|------|------|
| W2 `wave-executor`（saved） | D1 / D3（两实例化） | `{ execPlan: "<path>.exec-plan.json" }` | completed / blocked |
| W3 `dev-consistency-loop`（saved） | D2 | `{ execPlan }` | converged / stuck |
| W4 `design-code-sync-loop`（saved） | D5 | `{ designDoc, implPlan, projectRoot, maxRounds? }` | converged / contested / stuck |

workflow 未就绪或发起失败 → 各段 flow 文件的手工路径（与 workflow 语义等价；断点恢复：workflow 用 ResumeWorkflowRun/AmendWorkflow，手工路径以 status.json + git log 对账，冲突以 git 为准）。

## 关键约束

- [MANDATORY] 并发 ≤5（全局 subagent 约束）；模型按全局路由表、thinking max；task 三段式
- [MANDATORY] 数字阈值：单元 dev→fix 超 2 轮 = blocked 升级用户；一致性审查累计 ≥3 轮不收敛或单条 unreasonable 超 2 轮 = stuck 呈报；终态同步 must-fix ≥4 轮不收敛或单条超 2 轮 = 呈报
- [MANDATORY] e2e 只在开发阶段按改动面跑（清单继承 T3 验收计划表），空载串行；PR/merge/CI 门禁只跑单测（SSOT = 项目 AGENTS.md 测试节）
- [MANDATORY] 偏差三分类：合理 → 登记表固化；不合理 → 打回修；doc_errors → 主 agent 改设计文档并记录
- [MANDATORY] D3 全绿 + D4 最终 commit 后自动进 D5（仅用户明示跳过可免，跳过须记录）；D5 收敛 = 整体交付
- [OPTIONAL] 高风险大单元可开 worktree 隔离（判据见 references/dag-authoring.md；exec-plan 节点 cwd 字段承载）

## 状态恢复

进度唯一事实源 = `<name>.status.json`（D0 生成，workflow/手工路径每次节点终态后回写）。恢复程序：以 git log 与工作区实物校准 status（**冲突以 git 为准**：标 done 无 commit → 回 pending；有 commit 未写 → 补写 done）→ 按所处段选 flow 落点续跑。

## 与老 dev-flow 的关系（灰度并行）

本技能是纯执行重构版（impl-plan 上移 tech-design-wf T3；编排收归 workflow；状态载体 JSON 化；design-code-sync 升级内嵌 D5）。老 dev-flow / design-code-sync 原样保留可随时切回；判据面（dag-authoring / parallelism-reviewer / post-delivery）同源继承。

## 标记说明

| 标记 | 含义 | 修改约束 |
|------|------|----------|
| `[HISTORICAL]` | 来自实际事故的规则（见 flow/post-delivery.md） | 不允许删除或削弱 |
| `[MANDATORY]` | 流程强制要求 | 必须严格遵守 |
| `[OPTIONAL]` | 可选步骤 | 可按需调整 |
