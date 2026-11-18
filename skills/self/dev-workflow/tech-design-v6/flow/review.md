# T2 审查循环流程

> 四席并行审查（方向审席 + 主审 / 影响面审 / 简洁审）+ 多轮修复循环（方向审 rewrite 档击穿时整循环终止回 T1）。deliveryProfile=a 时降为方向审 + 主审两席（见「A 级降档」节）。执行体两形态：**zcode 环境优先发起 saved workflow `tech-review-loop-v6`**（契约见 SKILL.md）；workflow 未就绪/发起失败按本文件手工路径执行（语义等价）。审查标准见 `review/rubric-design-doc.md`，agent 定义见 `agents/`。

> **外部契约审查输入（条件触发）**：交付体系任务且验收包含外部契约（acceptance.json 顶层 `externalContracts` 非空）时，方向审与主审的输入除设计文档外还包含契约能力清单与权威快照摘要（来源 = 验收包 externalContracts[].capabilities 与任务目录 `environment-contracts.current.json` 指向的快照）——两席据此核对自建接口 / vendored 类型 / mock 契约与 authority surface 的一致性，并把「以 SDK 为准」「联调时再核对」类未完成核对义务判 must-fix（判据写进两席 agent 模板与下方任务模板）。

## 产物路径约定 [MANDATORY]

- runDir 即设计包目录 `~/.agents/skill-data/tech-design/<project-slug>/<name>/`（六个章节 JSON 权威源与渲染产物 `<name>.rendered.md` 所在；审查者读渲染视图，需核对结构化字段时读章节 JSON）
- 四席报告同落当轮 `round-N[.attemptM]/`：`review-direction.md`（方向审）+ `review-<dimension>.md`（dimension = main / impact / simplicity）+ `aggregated.md`（聚合清单——聚合裁决 phase 产物，四席发现按同根因合并的去重权威清单，修复者的操作清单）+ `dispositions.md`（当轮处置表）
- 重发起（direction-rejected 修完重来 / escalated 裁决后重跑）时新轮次目录带 attempt 后缀：`round-3.attempt2/`——不覆盖历史
- 终态记录 `<name>/final.json`：`{ terminated, rounds, runDir, designDoc, oneliner, reportFile, mustFixTrajectory, remaining, blocked, message }`——oneliner = 方向审席一句话判定（取末轮）；reportFile = 末轮 `round-N/review-direction.md` 路径；designDoc = 设计目录绝对路径；设计包的审查证据（dev-flow-v6 入口判据读它）
- 产物根 `~/.agents/skill-data/` 在 HOME 下天然不入 git；用户显式指定路径时以用户为准

## T2 进场门槛 [MANDATORY]

进 T2 派审前，设计文档机器项必须全绿：`node <skill 安装位置>/scripts/check-design-doc.mjs <设计目录绝对路径>`（T1 `flow/write.md` Step 6 机器自检跑同一脚本）。脚本按十条规则判定：六文件完整与枚举合法 / id 全局唯一 / 导航对齐 / 跨章节引用与守护引用存在 / 分型一致 / 产物表触发完备 / 内容形态合法 / 穷举断言声明（warning 不阻塞）/ 渲染产物过期（warning 不阻塞）/ 守护单一登记——其中导航对齐 = reviewNav 与 decisions 的 decisionId 集合对账；跨章节引用与守护引用存在 = gapRefs / unitRefs / axiomRefs / goalRefs 指向的 id 必须在被引用数组中存在、{{Gx}} 守护引用指向的 guards id 必须在 decisions[].guards 登记中存在；内容形态合法 = 分型理由不重复前缀、文件条目括号配对；穷举断言声明 = 穷举断言行缺 searchCmd 登记时告警；守护单一登记 = guards 文本全局唯一，可执行内容跨字段逐字重复只告警不阻塞（提示收敛为 guards 登记 + 引用）。exit 非 0 = 未全绿——**不派审**，先回 T1 按 stdout 校验报告修对应章节 JSON、重跑脚本至 exit 0 再进 T2。输入是 md 单文件时脚本 exit 1 并输出指引（全文见 `references/design-doc-schema.md` §11），按指引处理后另行发起。骨架完整性、引用对账、导航对齐这类机器可查问题在 T1 拦截，T2 各 reviewer 不报它们。

## A 级降档（deliveryProfile=a）

交付体系任务的 task 元数据 `deliveryProfile`（task.json 字段，由 gate init 参数或 user 凭据命令 `set-delivery-profile` 写入，禁手改 task.json）为 `a` 时，T2 固定降为**方向审 + 主审（兼契约主审）两席**——跳过影响面审 / 简洁审（外部契约守门设计的 A 级成本控制：外部契约任务是「先小探针、后大流程」，降档只减审查席与分区，不减必做机器门；探索维度取契约与故障两类归独立保证线，本技能只降审查席）。

- **读取方式**：设计目录 meta.json `acceptanceBinding.taskDir` → 任务目录 `task.json` 的 `deliveryProfile` 字段；合法取值 `a` / `b` / `c`（普通任务缺省 `b`）
- **缺省不降档**：读不到字段（独立设计任务无任务目录 / task.json 缺失 / 字段缺失或值非法）一律按 `b` 处理，四席照常
- **两席的输入不减**：契约能力清单与权威快照摘要（外部契约任务）仍进方向审与主审的输入——降档不是降契约核对强度
- **双轨同判据**：workflow 路径（tech-review-loop-v6）由脚本侧读同一字段短路派审席（agent 名与产物名不变，只少派两席）；手工路径按本节派两席。轮次形态（R1 全面 / R2+ 聚焦复审）、聚合裁决、修复循环、终态判定不因降档改变

## W1 workflow 发起（zcode 环境默认动作）

```
CreateWorkflow saved: tech-review-loop-v6
args: { designDoc: <设计目录绝对路径（或其渲染 md 路径——workflow 内部归一为设计目录）>, projectRoot: <项目根绝对路径>, maxRounds?: 10, reviewers?: <自定义 reviewer 模板绝对路径数组，缺省用本技能 agents/ 默认四件>, taskId?: <设计包任务标识，建议 = 设计包 <name>>, executionId?: "T2-<发起时点短时间戳>", attempt?: <重发起序号——环境失败族重发时递增，防轮次产物覆盖；缺省时自动检测已有产物并递增> }
终态: converged / direction-rejected / escalated / stuck / max-rounds + setup-failure / review-failure / aggregator-failure / fix-failure（环境失败族）
```

观测参数（taskId + executionId）同时传入即启用阶段事件观测（stage 恒 T2，落点与可选兼容语义见 SKILL「W1 workflow 契约」节）；不传业务照常。进 dev-flow-v6 执行时同一 task_id 延续共用，execution_id 换新段。

**修复后机器预检**（引擎内置）：每轮文档修复者返回且处置表过校验后，引擎复跑 render-design-doc.mjs（刷新渲染视图）+ check-design-doc.mjs（机器校验）——章节 JSON 的语法/结构/渲染红当场回喂修复者修正（与处置表回喂共享重试预算），全绿才进下一轮四席复审；避免格式错误烧掉一整轮审查才暴露 rendered.md 损坏。手工路径同义务：主 agent 在派复审前先跑同两个脚本，红则打回修复 agent。

终态处置（workflow 与手工路径同表）：

| 终态 | 主 agent 动作 |
|------|--------------|
| converged | **T2 确认点**：转述 oneliner（方向审一句话判定）+ 收敛轨迹 + 处置清单 → 默认等用户确认 → 进 T3（前期授权直接进） |
| direction-rejected | 只在方向审席判 rewrite 档（问题定义/方案主干/分型被击穿）时到达：回 T1 与用户对话重写（含 Step D 诊断期重做）；修完重新发起（attempt+1，重过四席）。重写回边有内核预算上限（t2RewriteAttemptCap，判定单源见 kernel-judgments，经 delivery-core CLI 消费）：预算耗尽后再次打回即停回用户裁决（换方向/换问题定义/终止本设计线），不再回 T1。patch 档发现不触发本终态——进当轮问题清单由修复者处置，循环继续 |
| escalated | 方案性意见需方向裁决——与用户对比新候选后改文档重新发起（一律停回用户裁决，不在轮内自行重跑方案对比） |
| stuck / max-rounds | 呈报残余风险矩阵，用户裁决（stuck = 连续 3 轮 must-fix 不降） |
| aggregator-failure | 聚合裁决结构化返回多次回喂仍不合规（refs 未构成原始清单的精确划分——漏报/重叠/幻觉 ref）——人工读四份报告合并后把聚合清单落当轮 `aggregated.md` 再续，或 attempt+1 重新发起 |
| 其余 *-failure（环境/工具） | 读 runDir 日志排障后 resume 或重发起 |

## 手工路径 Step 1：确认审查对象

从用户/上游拿到：设计目录路径（给出的是渲染 md 路径时取其所在目录）、一句话说明（这是什么设计）。报告路径按产物约定解析；进场门槛（机器项全绿）未过先回 T1。

## 手工路径 Step 2：并行派四席 reviewer（方向审席 + 三审）

路径解析：本 skill 安装位置 = available_skills 里 `tech-design-v6` 的 `location` 字段。据此拼绝对路径：rubric = `<location>/review/rubric-design-doc.md`；原则层 = `<location>/references/principles.md`（七原则与产物表规格）。

派 `tech-design-direction-review`（task 三段式）：

```text
背景：对设计 <一句话说明> 做方向审（四席之一，与三 reviewer 同轮并行；设计包在 <设计目录绝对路径>）。
目标：
  1. read <rubric 绝对路径> 加载方向审判据（D 系列）+ <principles 绝对路径>
     加载原则层（产物表规格与触发条件——D2 攻击前提清单、D4 对账产物表都要用）
  2. read <设计目录>/<name>.rendered.md（渲染视图——审查读它；需核对产物表等
     结构化字段原文时读 <设计目录>/ 内章节 JSON，如 s2-status.json 的 artifactTables）
  3. 目标项目根：<绝对路径>——read 其 AGENTS.md（若存在）提取项目约定与架构
     事实；攻击「状态副本清单 / 上游依赖」以项目自己的架构事实为依据，不凭偏好
  3.5 外部契约输入（交付体系任务且验收包含 externalContracts 时；无则跳过本条）：
     主 agent 附契约能力清单（acceptance.json externalContracts[].capabilities：
     id / minEnvironment / observable / surfaceRefs）与权威快照摘要（任务目录
     environment-contracts.current.json 指向的快照：snapshotSha256、各契约
     status / identity / aggregateHash 与 surfaces 的 surfaceRef+sha256；完整
     内容可 read 该文件）。攻击「契约事实的来源不是权威快照」类前提（D2）：平台
     文档与文字概述只能作背景，单独引用作契约事实 = must-fix；上游依赖清单的
     契约能力行（capabilityRef / observation / risk）与能力清单对账（D4）——
     capabilityRef 必须覆盖全部能力且一一对应
  4. 五大方向逐项攻击（判据 D1-D5，每项先找反例，找不到反例才判通过）：
     ① 分型：终态型有无触发依据（用户显式要求 / 修复史判定表「未修到」/
        架构级设计对象）；演进型的「为什么不需要终态视角」辩护是否被修复史
        判定表支撑
     ② 前提清单（增强版）：否定性断言逐条攻击——先枚举「谁可能在写、谁可能
        在持有」再找写者侧反例；穷举断言（exhaustive=true 声明行）优先核对
        searchCmd 登记的检索命令与命中清单——登记了的重跑对账，未登记的直接 must-fix；
        ✅ 条目抽样复核实（亲自 read 它声称的核实位置，验证核实动作真实发生）；
        ⏳ 待裁决项逐条判「是否影响方向」
     ③ 终态层（终态型）：公理逐条判「真不变量还是实现细节」（假设推翻重建，
        该陈述还必须成立吗）；差距表逐维对照现状查漏项；迁移波次查是否制造
        新差距
     ④ 产物表：触发的产物表存在且无漏行 + 行级真实性抽样（随机挑行 read
        源码验证行内容与代码一致）
     ⑤ 问题定义：§1 是现象还是根因、有无未识别的深层问题；探明手段（加
        日志/探针/先收集数据）不占设计主体；问题定义不被现状实现污染
  5. 声称「击穿 / 填表不实」前必须 read 源码取证；机制正确性/影响面/机制必要
     性留给三 reviewer（标 INFO 交接）
  6. 报告写到 <runDir>/<round-N>/review-direction.md（当轮产物目录，与三审报告同目录；R2+ 另按聚焦复审对上轮处置逐条对账并重跑穷举断言（exhaustive=true）searchCmd 登记的检索命令）
验收：
  - 返回 structured-output { mustFix, fixScope, problems[], reconciliation[], oneliner }——fixScope = patch（全部发现属前提层/产物表/措辞级，问题定义与方案主干不动，发现进当轮问题清单由修复者处置）/ rewrite（问题定义/方案主干/分型被击穿，整循环终止）；reconciliation 与三审同契约（R1 空数组）——
    problems = 逐条问题清单，每条 { ref, title }（ref 即报告 Findings 行锚点
    review-direction#<序>；条目无 level 字段——唯一报告级别是 must-fix；条数
    须等于 mustFix）
  - 报告含 Summary + 方向判定（一句话）+ Findings 表（每行带锚点编号）；每个
    must-fix 引用 D 系列编号 + 文档位置
```

方向审席与三审同轮返回：problems 清单计数以清单为准、自报数字只做交叉校验。fixScope = rewrite（问题定义/方案主干/分型被击穿）→ 整循环终止，按终态表 direction-rejected 处理；patch 档与清单空 → 发现并入当轮问题清单，走 Step 4 修复循环（「修复方向」列是修复者的操作清单）。

**全托管模式附加声明**：task 末尾追加「全托管模式：禁止 AskUserQuestion / ask-user / 任何等待用户输入的操作；遇到决策点自行裁决，决策清单写入报告 INFO 节。」

三审（主审 / 影响面审 / 简洁审）与方向审席同一条消息并行派出（subagent 独立加载，task 内路径全部绝对路径；方向审 task 按 Step 2 模板）。**不要自己审——审查与写作分离，避免确认偏差，主 agent 不自审**。四席同轮并行、同一对账契约：方向审 patch 档发现与三审发现合并进当轮问题清单，由修复者一并处置（Step 4）；rewrite 档（问题定义/方案主干/分型被击穿）整循环终止按终态表 direction-rejected 处理。R2+ 四席均按聚焦复审（上轮处置对账 + 只审触及章节——方向审席另重跑穷举断言（exhaustive=true）searchCmd 登记的检索命令对账）。**deliveryProfile=a 时只派主审（兼契约主审）——影响面审 / 简洁审跳过，判据见「A 级降档」节；主审的 task 模板不变（3.5 契约输入与加判项照常）。**

```text
agent: tech-design-review-v6
task:
  背景：对设计 <一句话说明> 做对抗式审查（已通过方向审；设计包在 <设计目录绝对路径>）。
  目标：
    1. read <rubric 绝对路径> 加载 P0 清单与分工（你只判主审条目：方案对比
       P0-7/8/9、对抗三问 P0-10/11/12、断言-红灯映射表核对 P0-27——P0-27 的
       产物规格见 <principles 绝对路径> P6）
    2. read <设计目录>/<name>.rendered.md（渲染视图——审查读它；需核对断言-红灯
       表等结构化字段原文时读 <设计目录>/ 内章节 JSON，如 s4-accept.json 的
       assertionRedlights）
    3. 目标项目根：<绝对路径>——read 其 AGENTS.md / ARCHITECTURE.md（若存在）提取
       项目约定；read 源码核实声称时以此为锚
    3.5 外部契约输入（交付体系任务且验收包含 externalContracts 时；无则跳过本条）：
        主 agent 附契约能力清单与权威快照摘要（内容同方向审 3.5）。加判一项——
        自建接口 / vendored 类型 / mock 契约与权威快照 surface 逐项对照（签名、
        参数个数与形态、字段名、返回对象、命令分发规则——不一致 = must-fix，引用
        能力 id 与 surfaceRef）；「以 SDK 为准」「联调时再核对」类未完成核对义务
        = must-fix，修复方向只能是转为实施单元（s5-breakdown.json units 或 T3
        impl-plan 契约 spike 单元，kind=contract-spike）或由修复者停回用户裁决
        阻断设计确认，不得保留为待办文字
    4. <R1：逐项对抗式审查，找反例和攻击点，声称事实错误前必须 read 源码核实；
       只报影响决策的事实错误。
       R2+（聚焦复审）：只审三件事——上轮 must-fix 修复是否成立（fixed 须实证：读了
       什么确认了什么）；修复是否引入新问题（只扫修复触及章节）；上轮处置表的登记
       不修项上下文是否被改变（结构化申报复活）。不做全面重扫，不重查已确认项。
       注入材料：上轮处置表全文 + 修订摘要 + 反例重演结果 + 修订方攻击点建议>
    5. 报告写到 <runDir>/round-N/review-main.md
  验收：
    - 返回 structured-output { report_file, must_fix, problems[], reconciliation[] }——
      problems = 逐条问题清单，每条 { ref, title }（ref 即报告小节锚点
      review-main#<序>，报告每条问题的小节标题带此锚点；条目无 level 字段——
      唯一报告级别是 must-fix；条数合计须等于 must_fix）；reconciliation = 对
      上轮处置表的逐条复核（每条 { prevId, status: fixed|not-fixed|regressed|
      escalate, evidence }，R1 返回空数组）
    - 每个 must-fix 引用 P0-N 检查项编号 + 文档位置
```

（impact / simplicity 同构，判据分工按 rubric：impact 审 P0-19/20/21（写入点穷举 / 代价量化 / 宿主不变量）；simplicity 审 P0-22/23、P1-6 机制必要性——报告名 review-impact.md / review-simplicity.md，锚点前缀随报告名（review-impact#N / review-simplicity#N）。**简洁审一律派**——agent 在报告中说明本设计是否纯文案/参数调整类、简洁审范围内零发现即可（无需跳过通道）。）

## 手工路径 Step 4：修复轮（主 agent 亲为）

1. 聚合裁决（独立环节，先于修复）：把四席发现按同根因合并为去重权威清单——同根因跨席位表述合并为一条（保留全部原始 ref，禁止静默丢弃），不同根因绝不合并，每条给可执行修复指导；每条聚合项标注 impact 分级（critical=影响关键决策——分型错误、公理/不变量不成立、问题定义失真、方案主干被击穿、A 级决策前提失实/矛盾、影响决策走向的事实错误；minor=不影响关键决策——前提登记缺口、产物表完备性、非关键场景措辞；拿不准按 critical）。minor 必须附 consequenceRefutation（不会发生 / 用户不可观察 / 验收明确允许，三择一并给依据），已推演出用户可观察的不正确行为时不得降级。原始清单合并落 `<runDir>/round-N/problems.json`（`{ round, problems: [...] }`，条目 `{ ref, title }`——无 level 字段），聚合清单落 `<runDir>/round-N/aggregated.md`（每条 AG 项含全部原始 ref 与修复指导）；critical 项的原始条目另落 `<runDir>/round-N/problems-critical.json`（覆盖校验输入——minor 不要求本轮处置）。自检：聚合项 refs 全体 = 原始清单的精确划分（每条 ref 恰好归属一条 AG 项）
2. 按 `flow/write.md` Step 8.1/8.2 修复全部 critical must-fix（minor 项跨轮收集进 `<runDir>/minor-findings.json`，最后一波统一处理或登记放行——不进本轮修复循环与覆盖校验），不留尾巴。修复 = 编辑设计目录内章节 JSON（长文本是字段值；跨章节引用字段 gapRefs / unitRefs / axiomRefs / goalRefs / reviewNav.decisionId 与被引用数组的 id 同步更新），每轮修复后重跑 `node <skill 安装位置>/scripts/render-design-doc.mjs <设计目录>` 刷新渲染视图。每条问题处置三选一：**修复（fixed）** / **登记不修（deferred，记一句话理由）** / **归档（archived，记入章节 JSON 相应内容的待办或残留风险）**——判定存疑按修复处理（滑坡防护）
3. 产出当轮处置表 `<runDir>/round-N/dispositions.md`（每条九字段：id（D-<轮>-<序>）/ title（一句话标题）/ source（数组，逐条引用 problems-critical.json 的 ref）/ action（fixed|deferred|archived）/ location（修订位置）/ reenactment（反例重演）/ attackHints（攻击点建议）/ affectsDecision（影响决策）/ affectsDelivery（影响交付）），并同步落 `<runDir>/round-N/dispositions.json`（结构：`{ dispositions: [...] }`，字段同 workflow 路径）
4. 处置表机器校验（与 workflow 路径同一校验器——双轨语义等价由此保证）：`node ~/.agents/skills/tech-design-v6/scripts/check-dispositions.mjs <runDir>/round-N/dispositions.json --problems <runDir>/round-N/problems-critical.json`；exit 1 时按 stdout 校验报告（缺失 ref 清单）补正处置表后重跑，至 exit 0
5. 终态判定（机械）：critical must-fix==0 且上轮处置全部经复核确认（reconciliation 无 not-fixed / regressed / escalate）即终止（converged，写 final.json）；R1 三报告 critical 全 0 直接收敛，不派修复者。否则 → 下一轮聚焦复审（Step 3 的 R2+ 形态），轮次 +1
6. 停机线：maxRounds（默认 10）；连续 3 轮 must-fix 不降 → stuck 呈报用户

## 手工路径 Step 5：终态与 T2 确认

按终态处置表（见 W1 发起节）处理；converged 后写 final.json（字段见产物路径约定），进入 T2 确认点 → T3（`flow/plan.md`）。
