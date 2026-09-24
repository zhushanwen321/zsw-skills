---
name: dev-flow
description: >-
  Use when 一份已通过对抗式审查的技术设计文档（tech-design 产出）需要落地为可运行代码。
  触发短语：「按设计文档开发」「实施这个设计」「按设计实现」「设计已经好了，开始开发」「根据 design doc 写代码」。
  Not for 编写或审查设计文档本身（用 tech-design）；结构化 topic/unit 台账式开发（用 cw-cli / coding-workflow）；
  已产出 execution-plan/plan.md 待 Wave 式执行（用 coding-execute）；
  无设计文档的 bug 修复、小改动（直接编码）；只出计划不写代码（用 lite-plan）。
---

# dev-flow

主 agent 只调度，subagent 完成全部开发与验收——把通过对抗式审查的设计文档变成已验收、且与文档双向校准一致的代码。

首次进入 → read `flow/plan.md`。中途进入按路由表落点，各行的入口前提机械可查。

## 核心原则

1. **编排者零编码**：主 agent 只做规划、派发、验证、commit、状态记录；一切 src/tests 编写修改走 subagent
2. **门只认证据**：阶段推进只承认命令输出、diff、逐行签收清单；无证据的「已完成」一律退回
3. **验证方式分级，低成本高收益前置 [MANDATORY]**：L0 静态规则（lint/typecheck/守卫脚本/grep 机械信号，主 agent 直跑）→ L1 增量单测（dev 自跑）→ L2 全量套件（阶段 3 尾并入）→ L3 脚本化端到端（预编译剧本，多实例并行）→ L4 agent 端到端（最贵，仅需判断力的场景）。铁律：低级未清不进高级；机器可判定的修复不许留到 L4 才发现。各级定义与执行者见 `flow/acceptance.md`
4. **范围锁定**：subagent 只允许改计划中白名单内的文件；发现范围外必改时停下上报，禁止顺手改
5. **git 单点**：subagent 禁止一切 git 写操作；只有主 agent 在核验通过后按精确路径 `git add`，禁 `-A`/`.`。commit 粒度纪律：单元/批次级 commit 是流水线结构，保留；流程自动生成的小改动/文档类改动（纯文档同步、文案修订、清单登记）**禁止单独成笔**——能折进触发它的单元/功能 commit 的同笔提交，确因验收结论后置的攒批成一笔，禁止一文档一笔
6. **基线先行**：计划文档基线落盘（`.tmp/dev-flow/` 落盘即基线，不入 git）后才可派发；流转前主 agent 核对计划白名单内文件的 diff 干净

## 流水线七阶段

| 阶段 | 产物 | 推进门（gate） |
|------|------|----------------|
| 0 预检 | 设计文档可用性确认 | 结构四节齐全 + 对抗式审查 must_fix==0 证据 |
| 1 执行计划 | `<项目根>/.tmp/dev-flow/<同名>.impl-plan.md`（DAG+单元表+状态表+验收计划表） | 计划自检（+ 门槛触发的并行度复审）通过后基线落盘（Write 计划文件即完成，**不 commit、禁 `git add`/`git add -f`**——`.tmp/` 是 gitignored 产物目录，全局 AGENTS.md「提交策略」同款禁令）；**进度清单全程写盘即可、不 commit**：状态表/变更历史/验收回填等一切进度登记写盘即闭环，任何时点不产生 commit，需要用户可见的结论落 docs/ 下设计文档随所属功能 commit 入库；验收计划表含每项方式/成本/收益打分与提速结论 |
| 2 开发循环 | 各单元 committed | 白名单内文件 diff 干净 + 测试真实跑绿 |
| 3 一致性审查与全量测试 | 合理/不合理偏差清单 + 全量套件绿 | 每条结论带 file:line 证据；全量测试验收（原 Gate A）并入本阶段尾，出口双证据 = 审查清零 + 全量绿 |
| 4 修复循环 | unreasonable 与 doc_errors 清零 | 定向复审（只审影响面）收敛 |
| 5 端到端验收 | 场景表逐行签收（核心先行 + 依赖解锁 + 剧本预编译） | 验收全绿；触及验收场景的修复已重验受影响场景 |
| 6 终态同步 | 实现与设计文档双向校准 0 must-fix | design-code-sync 终止条件（收敛轨迹+交付汇报） |

## 路由

| 用户意图 | read | 入口前提（机械可查） |
|----------|------|----------------------|
| 开始实施（拿到设计文档路径） | `flow/plan.md` | 无 |
| 中断后恢复 | 先读本页末尾「状态恢复」，再按所处阶段选落点 | — |
| 计划就绪，派发开发单元 / 循环中途卡住 | `flow/execute.md` | 计划文档已基线落盘（`.tmp/dev-flow/` 下文件存在且状态表完整） |
| 开始一致性审查与修复 | `flow/consistency-review.md` | 状态表全部 committed |
| 进入端到端验收 | `flow/acceptance.md` | 审查清零 + 全量测试绿的 commit 在 git log 可见，且无未裁决冻结单元 |
| 阶段 5 验收全绿（自动衔接，无需用户指令） | `../design-code-sync/SKILL.md` 并按其流程执行 | 收尾最终 commit 已落地 |
| 流水线交付后的修复 / 是否需要重跑对抗审查 | `flow/post-delivery.md` | 阶段 6 终态同步已收敛（或用户明示跳过且已记录） |
| 单元怎么拆 / 并行串行怎么判 / worktree 要不要开 / DAG 怎么画 / 链太深并行度上不去怎么压扁 | `references/dag-authoring.md` | — |

## 关键约束

- [MANDATORY] 派发遵守全局 AGENTS.md 的 subagent 约束：并发 ≤5；模型按全局路由表选、thinking max；task 三段式（背景/目标/验收）。环境中看不到指定模型时列出实际可见项请用户选择
- [MANDATORY] 所有 subagent 一律后台异步派发、靠完成通知推进（zcode 即 run_in_background=true；xyz-agent 原生仅异步），禁止前台同步阻塞等待返回——同步等待长任务有超时丢失结果风险，且阻塞主 agent 无法流水化核验
- [MANDATORY] 数字阈值：同一单元 dev→fix 超 2 轮未绿即冻结升级用户；一致性审查累计 ≥3 轮未收敛即暂停升级。两种情况都禁止自行突破或无声放弃
- [MANDATORY] 收尾阶段跑全量测试套件（项目收尾场景）；单元开发期内增量测试即可
- [MANDATORY] e2e 执行准则：e2e / 真实进程 / 真实 LLM 用例只在开发阶段按改动面跑——清单从设计文档「e2e 影响面评估」（tech-design 验收章节）继承，由阶段 1 验收计划表圈定为 L3/L4 项，空载串行执行，禁止全量扫跑；PR/merge/CI 门禁只跑单测（与项目 pre-merge-check 的 unit 轨同口径，SSOT = 项目 AGENTS.md 测试节）；自动化回归的长期方向 = e2e 逐步单测化
- [MANDATORY] 偏差三分类处理：合理不一致 → 计划登记表固化（必要时同步设计文档措辞）；不合理偏差 → 打回 dev 修；doc_errors → 主 agent 改设计文档并记变更历史
- [MANDATORY] 阶段 5 验收全绿、最终 commit 落地后**自动衔接 design-code-sync 终态同步**（阶段 6）：read `../design-code-sync/SKILL.md` 按其流程执行，输入直接给出本流水线的设计文档与 impl-plan 路径。仅用户明示跳过可免，跳过须在计划「变更历史」记录——终态同步是交付的组成部分，不是可选附加
- [OPTIONAL] 高风险大单元可开 worktree 隔离（判据见 dag-authoring），建/并优先项目既有工具；subagent 零 git 不变量不变

## 状态恢复

进度唯一事实源 = 计划文档内「状态表」。

1. 校准：以 git log 与工作区实物为准修正表项（无 committed 证据一律按 pending 重算），并在计划变更历史记一笔校准事件
2. 定位中断点：
   - 计划期（计划文件缺失或状态表不完整）→ 重走 `flow/plan.md`，从计划自检步继续
   - 执行期 → `flow/execute.md` 第 1 步重新算就绪集
   - 已全部 committed → 按路由表查审查清零情况，决定进审查还是验收
   - 阶段 5 验收全绿已达成 → 查终态同步状态：design-code-sync 汇报 must-fix==0（或用户明示跳过已记录）即整体交付完成；否则从 design-code-sync 当前循环步续跑

---

## 标记说明

| 标记 | 含义 | 修改约束 |
|------|------|----------|
| `[HISTORICAL]` | 来自实际事故的规则 | `flow/post-delivery.md`（2026-08-31 流水线后修复未回写文档致 9 条漂移）；一旦标记不允许删除或削弱 |
| `[MANDATORY]` | 流程强制要求 | 必须严格遵守 |
| `[OPTIONAL]` | 可选步骤 | 可按需调整 |
