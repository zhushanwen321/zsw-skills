---
name: architecture-improve-loop
description: >-
  Use when 用户想改进架构、找重构机会、合并紧耦合模块、加深浅层模块、让代码库更可测试和
  AI 可导航（触发词：改进架构、重构机会、架构优化、improve architecture、refactoring、
  architecture review、架构改进循环、自动架构审查修复、architecture improve loop、循环修架构），
  以及要把架构审查候选直接修掉不要只出报告。本质 = 用 zcode saved workflow
  review-fix-loop 做引擎，架构域 reviewer 定义做眼睛，循环直到无 Strong（Worth 随批全修）。
  本 skill 已内化 improve-codebase-architecture（走查方法论/候选卡/HTML 报告）、
  codebase-design（深模块词汇与判定原则）、domain-modeling（CONTEXT.md/ADR 纪律）与
  grilling 的方案质询决策树。

  Not for 找 bug（用 diagnosing-bugs）、PR 增量多维 review（用 pr-cr-fix，其 reviewer
  面向 git diff）、过度设计审计（用 code-overdesign-audit）、与用户对话式逐候选质询
  （grilling 独立技能仍在）。
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

| 原走查流程的人工环节 | review-fix-loop 的机制 | 等价性说明 |
|---|---|---|
| 派 sub-agent 走查热点域 | `reviewers` 参数（.md 定义驱动，4 个一批并行） | reviewer 定义文件承载架构词汇+候选卡格式+证据纪律 |
| grilling 对抗质询 | 聚合器证据分级（evidence/unverified/downgraded）+ **reviewer 定义内嵌质询** | 质询拆两半：证据核实 + 方案质询五问（约束/依赖/形态/接缝后面/测试存活）内嵌进 reviewer 定义，方案裁决进聚合（无实证不进修复队列） |
| 候选卡 Solution 方案 | issue 的 `guidance` 字段（随 per-fixer 文档直达修复者） | guidance 必含修复方向+行为不变量（reviewer 定义强制） |
| 文件冲突矩阵分批派 worker | reconcileGroups：组间文件不相交确定性校验 + 相交传递闭包合并，3 个一批并行 | 比人工矩阵更严（机器校验） |
| 主会话统一验收提交 | autoCommit 统一 commit（显式路径）+ R2+ reconciliation 对账 | fixed 需实证、regressed 计修复失败、needs-redesign 熔断 |
| 循环直到无 Strong | mustFix==0 → converged；stuck/needs-redesign/max-rounds 熔断 | 「无 Strong」= major 映射档清零 |

**severity 映射契约**（写死在 reviewer 定义里，reviewer 与聚合器共同遵守）：

| 架构候选档 | review-fix-loop 档 | 计数 | 循环语义 |
|---|---|---|---|
| Strong（现实击中 + 长期合理） | major | mustFix | 清零才收敛 |
| Worth exploring（真实但需权衡） | minor | suggestion | 随批全修；fixer 可 deferred（须具体理由） |
| Speculative（纯未来收益） | 不报 | — | reviewer 定义禁止出卡 |

## 流程

### 1. 圈定范围

**Scope before you scan（YAGNI）**：加深模块的收益在于让未来改动更容易，所以把额外
权重放在最近变过的部分——先决定看哪里再看。用户点名方向（模块/子系统/痛点）就直接用；
否则回溯一段 `git log --oneline` 找热点路径（反复出现的文件优先拉注意力），改动分散
无热点则放宽网。范围决定传给 workflow 的 `base` 与 reviewer 域定义的侧重（见第 2 步）。

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

### 5. 消费产物与收尾

- 分轮报告：`{reportDir}/{topic}/round-N/`（review-<域>.md / aggregated.md /
  aggregate-4-fixer-<k>.md）——事后审阅与下次循环的基线
- 终态 `result`：remaining / disputed 清单即人工待办
- **领域模型落盘**（reviewer 是只读的，登记在其报告末尾的待办由主 agent 循环收敛后统一执行）：
  - 「领域词表待登记」清单 → 写入项目 `CONTEXT.md`（词条格式：`**术语**：1-2 句定义（定义它 IS 什么而非做什么）+ _Avoid_: 别名列表`；有主见——多词一概念选最佳、其余进 Avoid；**只收项目特有概念**，通用编程概念不收；文件不存在则此时创建）
  - 「建议 ADR」清单（disputed 成立的 load-bearing 否决）→ 按三条件复核后在 `docs/adr/` 记录（格式极简：`# 决策短标题` + 1-3 句「上下文/决定/为什么」；顺序编号扫描最大号 +1；目录不存在则此时创建）
- **HTML 呈阅报告**（可选，给用户看的最终产物）：自包含单文件 HTML 写入系统临时目录
  （`$TMPDIR`，回退 `/tmp`；文件名 `architecture-review-<时间戳>.html`），写完 `open` 给
  用户并告知绝对路径。要点：
  - Tailwind via CDN 布局 + Mermaid via CDN 图表；两者混用——**Mermaid 管 graph 型**
  （依赖/调用链/时序），**手绘 div/inline-SVG 管 editorial 型**（体量图/剖面/前后对比）
  - 每候选一卡：标题（命名 the deepening，如「收拢 Order 接入管线」）+ 强度徽章
  （Strong=emerald / Worth=amber）+ 依赖类别 tag（in-process / local-substitutable /
  ports & adapters / mock）+ Files（等宽字体）+ **Before/After 双栏图（主角）** +
  Problem/Solution 各一句 + Wins（≤6 词 bullet，如「测试只打一个 interface」）+
  ADR 警示框（若有）
  - 图承担表达重量、散文极简：图需要一段话才能看懂就重画图；模块=实线框、接缝=虚线、
  泄漏=红箭头、深模块=厚深色框（header 给图例）
  - 报告收尾「Top recommendation」节：最优先做哪个候选、为什么
  - 领域概念用项目 CONTEXT.md 词条称呼，架构词用 reviewer 定义的词汇表

## 设计决策（为什么 grilling 不独立成环）

原流程的 grilling 对话（与用户逐候选质询）在本 skill 中拆解消化：**证据核实 + 方案质询
五问**（grilling 决策树：约束/依赖/深模块形态/接缝后面/测试存活）内嵌进 reviewer 定义
——出卡前逐问想清，答不上来降档或不出卡；**方案对抗**由两道机器闸门承接——聚合器
evidence 裁决（无实证不进修复队列）与 R2+ reconciliation（修坏会在下轮被 regressed
揭穿并走向 needs-redesign 熔断）。fixer 侧保留 disputed 申诉通道（怀疑误报给
file:line 反证转人工，不盲改）。代价：失去「修复前的人工方案裁决」——若项目对架构
变更要求更高把关，autoCommit=false 让改动停在每轮工作区，人工审后统一提交。

## 内化来源（已移除的上游技能）

本 skill 的方法论自下列技能内化，它们已从全局 skill 清单移除（git 历史可追溯）：

- **improve-codebase-architecture**：走查方法论（scope before scan / 热点优先 /
  通用摩擦五问 / 候选卡与三档强度 / HTML 报告）→ SKILL.md 流程 + reviewer 定义 + HTML 呈阅节
- **codebase-design**：深模块词汇表与判定原则（interface 全义 / deletion test /
  interface-is-test-surface / 接缝计数 / 可测试性三原则 / 依赖四分类 /
  replace-don't-layer）→ reviewer 定义的词汇与判定段
- **domain-modeling**：CONTEXT.md 词条纪律与 ADR 三条件/格式 → reviewer 定义的
  领域词表与 ADR 纪律段 + SKILL.md 收尾落盘节
- **grilling**（技能本体**保留**，tech-design 与 code-overdesign-audit 仍在引用）：
  其决策树问题内化为 reviewer 的方案质询五问；「事实自己查不问用户」已是 reviewer
  证据纪律

