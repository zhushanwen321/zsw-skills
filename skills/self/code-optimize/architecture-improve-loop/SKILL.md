---
name: architecture-improve-loop
description: >-
  Use when 架构改进要自动循环执行（审查→修复→复审直到 Strong 级清零）、自动化架构审查修复、
  architecture improve loop、循环修架构、架构审查修复循环、把 improve-codebase-architecture
  的候选直接修掉不要只出报告。本质 = 用 zcode saved workflow review-fix-loop 做引擎，
  架构域 reviewer 定义做眼睛，循环直到无 Strong（Worth 随批全修）。

  Not for 只要架构报告不改码（用 improve-codebase-architecture 原版走查 + HTML 报告）、
  PR 增量多维 review（用 pr-cr-fix，其 reviewer 面向 git diff）、找 bug（用 diagnosing-bugs）、
  过度设计审计（用 code-overdesign-audit）。
---

# Architecture Improve Loop

把 improve-codebase-architecture 的「走查 → 候选卡 → 对抗质询 → 修复 → 复审」人工循环
替换为 review-fix-loop 动态工作流的自动循环：架构域 reviewer 找 Strong/Worth 候选 →
聚合裁决去重分组 → 分组并行修复 → 下一轮 reviewer 对账实证（fixed 必须亲读代码确认，
修了又坏计失败）→ 直到 Strong（major）清零收敛或熔断。**Worth（minor）随批全修**
——review-fix-loop 的 fixer 原生修全部等级，与本流程目标一致。

本 skill 是**编排层**：引擎是 zcode saved workflow `review-fix-loop`
（`~/.zcode/workflows/review-fix-loop.dwf.ts`，pi/zsw 内置版语义同源），眼睛是本目录
`agents/` 下的架构域 reviewer 定义文件。不修改 workflow 本体。

## 机制映射（为什么这样复用）

| 原版 skill 的人工环节 | review-fix-loop 的机制 | 等价性说明 |
|---|---|---|
| 派 sub-agent 走查热点域 | `reviewers` 参数（.md 定义驱动，4 个一批并行） | reviewer 定义文件承载架构词汇+候选卡格式 |
| grilling 对抗质询 | 聚合器证据分级（evidence/unverified/downgraded）+ **reviewer 定义内嵌质询纪律** | 质询拆两半：证据核实进 reviewer 定义（先读码再写卡），方案裁决进聚合（无实证不进修复队列） |
| 候选卡 Solution 方案 | issue 的 `guidance` 字段（随 per-fixer 文档直达修复者） | guidance 必含修复方向+行为不变量（reviewer 定义强制） |
| 文件冲突矩阵分批派 worker | reconcileGroups：组间文件不相交确定性校验 + 相交传递闭包合并，3 个一批并行 | 比人工矩阵更严（机器校验） |
| 主会话统一验收提交 | autoCommit 统一 commit（显式路径）+ R2+ reconciliation 对账 | fixed 需实证、regressed 计修复失败、needs-redesign 熔断 |
| 循环直到无 Strong | mustFix==0 → converged；stuck/needs-redesign/max-rounds 熔断 | 「无 Strong」= major 映射档清零 |

**severity 映射契约**（写死在 reviewer 定义里，reviewer 与聚合器共同遵守）：

| 架构候选档 | review-fix-loop 档 | 计数 | 循环语义 |
|---|---|---|---|
| Strong（现实击中 + 长期合理） | major | mustFix | 清零才收敛 |
| Worth exploring（真实但需权衡） | minor | suggestion | 随批全修；fixer 可 deferred（须具体理由） |
| Speculative（纯未来收益） | 不报 | — | reviewer 定义禁止出卡（原版也只登记不展开） |

## 流程

### 1. 圈定范围

继承原版 skill 第 1 步：用户点名方向就用它；否则走 `git log --oneline` 找热点路径。
范围决定传给 workflow 的 `base` 与 reviewer 域定义的侧重（见第 2 步）。

### 2. 选定/校准域 reviewer

本目录 `agents/` 提供三个通用分层域模板：

- `review-arch-contract-host.md` —— 跨进程契约（shared 类型/协议/常量 SSOT）+ 宿主进程侧（main 装配 / 子进程生命周期 / IPC 面 / 配置持久化）
- `review-arch-service-core.md` —— 长驻服务层（transport / 服务注册 / 鉴权 / 静态面）+ 核心连接层（连接发现 / 客户端状态机 / 域 API）+ 领域状态机
- `review-arch-shell-ui.md` —— 多壳（桌面/移动/其他）+ 共享组件与桥接层（ui 包）+ 壳内装配与状态机

模板是 **LLM 自圈定**形态：reviewer 首轮用 glob/grep 圈定本层文件清单写进报告头，
R2+ 复用上轮清单——无需发起前手工实例化。若项目分层与模板不匹配（如无独立宿主进程），
删掉不适用维度、按模板结构补写项目特定域（复制一份改「域界定」段即可），传入路径数组。

reviewer 定义的绝对路径（symlink 安装后从 `~/.agents/skills/architecture-improve-loop/agents/` 取）。

### 3. 发起循环

```
CreateWorkflow:
  saved:
    name: review-fix-loop
    args:
      base: main                  # diff 基线：架构审查以域现状为准，diff 仅作热点参考
                                  # （reviewer 定义已声明覆盖；不传则默认 main）
      reviewers:
        - ~/.agents/skills/architecture-improve-loop/agents/review-arch-contract-host.md
        - ~/.agents/skills/architecture-improve-loop/agents/review-arch-service-core.md
        - ~/.agents/skills/architecture-improve-loop/agents/review-arch-shell-ui.md
      maxRounds: 10               # 架构重构轮次收敛通常 2-4 轮
      autoCommit: true            # 每轮一 commit（fix: review round N — 可回溯）
                                  # 需要人工整理提交语义时传 false（改动留工作区）
      reportDir: .tmp/architecture-improve-loop
```

发起后等完成通知，**不要轮询**。

### 4. 终态判读

| terminated | 含义 | 动作 |
|---|---|---|
| clean / converged | Strong 清零收敛（clean = 首轮全净；converged = 修复后收敛） | 转第 5 步 |
| needs-human | 收敛但有 fixer 误报申述（disputed） | 逐条核对 `result.disputed` 反证，人工裁决后处理 |
| stuck | must-fix 连续 N 轮不降 / 同一问题连续不收敛 | 读分轮报告定位死结，通常需人工介入方案 |
| needs-redesign | 同一问题修了又坏达 maxFixAttempts（结构性，补丁修不好） | 回到 tech-design 层重新设计该域 |
| max-rounds | 轮次耗尽仍有活跃问题 | 读 remaining 清单，人工收尾 |
| *-failure | review/aggregate/fix 环节失败 | 按失败信息处置后 ResumeWorkflowRun 或重新发起 |

### 5. 消费产物

- 分轮报告：`{reportDir}/{topic}/round-N/`（review-<域>.md / aggregated.md /
  aggregate-4-fixer-<k>.md）——事后审阅与下次循环的基线
- 终态 `result`：remaining / disputed 清单即人工待办
- 可选：把最终轮 aggregated.md 的候选卡转 HTML 报告（原版 skill 的 HTML-REPORT.md 格式）
  给用户呈阅；循环已收敛时此步仅作展示，不驱动修复

## 设计决策（为什么 grilling 不独立成环）

原版流程的 grilling 对话（与用户逐候选质询）在本 skill 中拆解消化：**证据核实**前置进
reviewer 定义（先读码再写卡、file:line 必引、推断必须核实升级为事实）；**方案对抗**由
两道机器闸门承接——聚合器 evidence 裁决（无实证不进修复队列）与 R2+ reconciliation
（修坏会在下轮被 regressed 揭穿并走向 needs-redesign 熔断）。fixer 侧保留 disputed
申诉通道（怀疑误报给 file:line 反证转人工，不盲改）。代价：失去「修复前的人工方案
裁决」——若项目对架构变更要求更高把关，autoCommit=false 让改动停在每轮工作区，
人工审后统一提交。

## 与原版 skill 的关系

- 本 skill = improve-codebase-architecture 的**执行引擎化**（出码闭环）
- 原版 skill = **走查 + 候选卡 + HTML 报告 + 与用户 grilling 对话**（不出码，适合
  需要人工逐候选裁决的场景）
- 触发分流：用户说「改/修/循环/自动」→ 本 skill；说「看看/分析/出报告」→ 原版
