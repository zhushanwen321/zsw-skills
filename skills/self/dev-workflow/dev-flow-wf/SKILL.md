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
  直接编码；只出计划不写代码（用 tech-design-wf——其 T2/T3 产出 impl-plan 后不进开发）；老流程实施（用老 dev-flow）。
---

# dev-flow-wf（dev-flow 纯执行版）

**纯执行**：impl-plan 的创建与审查已上移到 tech-design-wf 的 T3——本技能从「设计包」起步，主 agent 只做编译、发起 workflow、段间裁决、收尾，一切编排细节收归 workflow 确定性通道（workflow 未就绪时走各 flow 文件的手工降级路径，语义等价）。

## 设计包入口门 [MANDATORY]（机械可查）

入口逐行核对（任一缺失 → 拒绝并指明缺什么、回 tech-design-wf 哪个阶段补；`<project-slug>` = 项目根 basename + "-" + 项目根绝对路径 sha256 前 8 位十六进制，脚本自动拼）：

| 文件 | 判据 |
|------|------|
| `~/.agents/skill-data/tech-design/<project-slug>/<name>.md` | 存在 |
| `<name>.impl-plan.md` + `.impl-plan.json`（与设计文档同目录） | 存在且单元 id 集一致 |
| `<name>/final.json`（审查报告目录，与设计文档同根） | terminated == "converged" |
| `<name>.plan-review.md`（与设计文档同目录） | 触发门槛（关键路径深度 ≥3 或单元 ≥4）时必须存在 |

**外部设计文档直投** → 拒绝，转 tech-design-wf（先补 T2 审查再 T3 拆计划）。

## 执行七段

| 段 | 内容 | 承载 | 推进门 |
|----|------|------|--------|
| D0 编译 | 设计包 → exec-plan.json + 逐节点 promptFile + 初始 status.json + L0 前置 + 环境 smoke | 主 agent | `flow/compile.md` |
| D1 开发循环 | 单元 DAG 流式并行（写码→核验→commit→解锁；开发期 e2e verify 失败与 commit 门禁被拒同入统一失败处理中心轮内修） | W2 wave-executor（手工路径 `flow/execute.md`） | 全节点 done 或 blocked |
| D2 一致性审查 | diff × 设计对照（R1 全面分区审 / R2+ 定向复审）+ 每轮聚合定性独立 phase（跨区同根因去重 / 定性复核 / 无交集分组 / 跨职责路由）+ 修复组并行 + Gate A 全量测试（红后归因分诊独立 phase：本批回归条目回注修复轮再修、瞬态重跑、存量红/测试基建缺陷带分诊报告终态，≤2 轮） | W3 dev-consistency-loop（手工路径 `flow/consistency-review.md`） | unreasonable 清零 + Gate A 绿 |
| D3 端到端验收 | 验收计划表 L3/L4 编译成 verify/inspect 节点（核心先行 + 短路）+ 验收失败修复循环（failed 入失败池 → 聚合裁决独立 phase（跨节点同根因合并/disputed 反证/文件不相交分组）→ 修复组独立 phase（fixer 修产品代码与验收资产，引擎按组 commit）→ 节点重置机器重验回调度循环，≤3 轮不收敛才熔断） | W2 第二实例化（手工路径 `flow/acceptance.md`） | 验收全绿 |
| D4 收尾交付 | 交付汇总 + 功能分级登记 + 文档资产同步 + ADR 复审 + 最终 commit | 主 agent | `flow/acceptance.md` 收尾节 |
| D5 终态同步 | 代码与设计双向校准：三向功能对照矩阵 + 越权三问 + 两级审查拓扑 | W4 design-code-sync-loop（手工路径 `flow/sync.md`） | 矩阵 0 must-fix |
| D6 交付后守护 | 交付后修复回写纪律 + 按需定向对抗审查 | 主 agent | `flow/post-delivery.md`（[HISTORICAL] 原样） |

段间不设用户确认（gate 驱动连续推进）；熔断终态（blocked / stuck / core-failed / contested / gate-a-failed / review-failure / fix-failure）停回主 agent 按 flow/execute.md 与 flow/consistency-review.md 的终态处置表处置——core-failed / gate-a-failed 在 D3/D2 是修复循环不收敛的出口（常态失败已由轮内聚合修复消化），终态自带归因材料（聚合清单 / 分诊报告 / disputed 反证）。

## 核心原则

1. **编排者零编码**：主 agent 只编译、发起、裁决、commit（workflow 形态下 commit 也归引擎）；一切 src/tests 编写修改走 subagent/节点
2. **门只认证据**：推进只承认命令输出、diff、结构化终态——无证据的「已完成」一律退回
3. **验证方式分级 L0-L4**（低成本高收益前置）：L0 静态规则（主 agent/world.run 直跑）→ L1 增量单测（节点/dev 自跑）→ L2 全量套件（D2 Gate A）→ L3 脚本端到端（verify 节点）→ L4 agent 端到端（inspect 节点）。低级未清不进高级
4. **范围对账**：节点/dev 优先改任务书声明范围内的文件；范围外的必要改动直接做 + 自报 deviations/自报清单如实登记——运行时不再逐文件打回（2026-09-29 裁决范围声明降级），改动对账由核验对账事件、终态残留核查与 D2 一致性审查承接；并行单元互不触碰对方声明内的文件（写冲突会互相覆盖丢改动，不可恢复）
5. **git 单点**：subagent 禁止一切 git 写；workflow 形态下 commit 由引擎 world.run 执行（精确路径 add，禁 -A），手工形态下由主 agent 执行；文档类同步改动禁止单独成笔——随触发它的单元同笔提交（files_changed 含文档路径即同笔）；确因验收结论后置的攒批成一笔，禁止一文档一笔
6. **基线先行**：exec-plan.json 落盘即基线（产物在 `~/.agents/skill-data/`，HOME 下天然不入 git）；执行态事实源 = `<name>.status.json`
7. **单波次交付**：一个设计包 = 一次实施流程，实际执行只有一个波次；未经用户明确指示，禁止按「波次/批次」把一个 impl-plan 拆成多次独立实施（每波各自走 D1-D6 完整流程）。允许的拆分 = impl-plan 内部的单元分组与 DAG 并行（多 subagent / 多组执行，W2 一次承接全部单元）；分期交付仅随用户明确指示出现

## 运行记录（防丢失）[MANDATORY]

任务执行期信息统一平铺落 `~/.agents/skill-data/dev-flow/<project-slug>/`（`<name>.` 前缀隔离；设计包在同根 `tech-design/<project-slug>/` 段，slug 同源），两类载体、三条写入通道：

| 载体 | 写入者 | 内容 |
|------|--------|------|
| `<name>.runlog/<记录者>.md` | 每个执行 agent（任务书 / W3·W4 prompt 注入义务行，路径由注入方给出） | 过程性发现：临时待办、需裁决事项、复盘观察（踩坑根因 / 方案取舍 / 环境异常）。一行一条 `[HH:MM] 类型: 一句话事实`，append 式即时写盘——agent 中途退出也留痕；每记录者独占一文件，无并发冲突 |
| `<name>.ledger.md` | ① W2/W3/W4 引擎终态各一笔（attempt 标识）② 主 agent 处置时追加 | ① 未决事项清单：blocked / deferredCommits / deferredLedger / escalated / contested / overdesignCandidates / 工作区残留等 ② 熔断处置与用户裁决记录（时间 + 终态 + 动作 + 理由 + 结果） |

- 引擎侧已核实互不干扰：产物在 HOME 下不在项目工作区内，`git status --porcelain` 天然看不到（引擎对项目内 `.tmp/` 的过滤器仍在——wave-executor `isTmpArtifact`，覆盖仍在项目内的其他临时产物），agent 写 runlog 不触发核验红灯
- **ledger 是中转不是归宿**：合理偏差 / 残留风险 / ADR 的最终登记处仍是 impl-plan §5、impl-plan 残留风险节、docs/adr——D4 收尾把未清项分流过去（处置完成标记 / 登记到既有归宿 / 显式记录丢弃理由），禁止双登记并存
- 主 agent 处置熔断终态（各 flow 终态处置表任一行）与用户裁决落地时，append 处置记录到 ledger
- 档案交付后默认保留（HOME 下天然不入 git），仅用户指示时清理（D4 第 8 条）

## 阶段事件观测

阶段事件观测回答「一次任务的开发执行各阶段何时开始、何时结束、归哪个任务」，只记归属与边界（不记 token、不记内容）。事件逐行追加到本次执行的 JSONL 文件：

```
~/.agents/skill-data/workflow-observability/<task-id>/<execution-id>.jsonl
```

每行一个 JSON 对象，契约固定（构建器按三源同步机器检查——观测层单一构建输入 `workflows/src/observability.shared.ts` / `scripts/build-workflows.mjs` 的 OBS_EVENT_FIELDS / `scripts/workflow-observe.mjs`）：

| 字段 | 含义 |
|------|------|
| `task_id` / `execution_id` | 任务标识 / 单次执行标识（同时是落盘目录名与文件名主干；命名规则：字母或数字开头，只含字母、数字、点、连字符、下划线，≤128 字符，禁「..」——防路径穿越，非法即告警并关闭观测） |
| `skill` / `stage` / `step` | 所属技能的 canonical 名（tech-design-wf / dev-flow-wf——统计按它过滤，禁止写 workflow 脚本名）/ 流程阶段编号（D0-D6、T2）/ 阶段内步骤（execution / setup / review / aggregate / fix / execute / finalize / gate-a / retire，外部步骤自定） |
| `round` / `attempt` | 循环轮次 / 重发起序号（无则 null；attempt 在启动早期自动检测未完成时也为 null，检测确定后其后的事件带值） |
| `event` / `timestamp` / `sample_type` | start 或 end / ISO8601 / production（真实执行，缺省）或 selftest（测试执行） |
| `outcome`（可选） | 仅出现在终态统一补记的 end 上，值 = 本次执行的终态词（如 completed / converged / blocked / setup-failure） |

**生成与传递**：`task_id` 由主 agent 在 D0 编译时分配（建议 = 设计包 `<name>`），同一任务的 D0/D1/D2/D3/D4/D6 全段共用；`execution_id` 每次发起一个新的执行时分配（建议 = `<段名>-<发起时点短时间戳>`），同一 execution_id 的多次重发起共用（attempt 字段区分轮次）。W2（D1/D3）、W3（D2）与 W4（D5）已内建：发起时 args 同时传 `taskId` 与 `executionId` 即启用，stage 自动记录（D1/D3 按 exec-plan 的 mode 区分，D2 恒 D2，D5 恒 D5），步骤边界由引擎写入——W2 的 setup/finalize、W3 每轮的 review/aggregate/fix/gate-a、W4 的 setup（环境校验/矩阵初始化/框架对照规划）/review（机械信号扫描 + 并行模块审查，R2+ 含聚焦复审）/fix（并行修复）/retire（退役判定）/finalize（轮次耗尽收尾）。

**可选兼容**：两参都不传 = 观测关闭、业务照常（存量调用不受影响）；只传其一 = 告警（含恢复动作）并关闭，不猜测意图；观测写失败 = 告警（同一文件只告警一次）不改业务终态——观测是辅助功能，故障不拖垮主流程。

**workflow 外步骤（D0/D4/D6）由主 agent 用观测命令记录边界**，契约与内建观测完全一致。统一运行入口 = `~/.agents/scripts/workflow-observe.mjs`（dev-flow-wf 可在任意项目运行，禁止写仓库相对路径 `scripts/workflow-observe.mjs`——那会解析到当前业务项目）：

```bash
node ~/.agents/scripts/workflow-observe.mjs start --task-id <task-id> --execution-id <exec-id> --skill dev-flow-wf --stage D0 --step compile
node ~/.agents/scripts/workflow-observe.mjs end   --task-id <task-id> --execution-id <exec-id> --skill dev-flow-wf --stage D0 --step execution --outcome completed
```

**安装说明**：运行入口是 zsw-skills 仓 `scripts/workflow-observe.mjs` 的安装 symlink；同目录另有一个 symlink `~/.agents/scripts/workflow-observability.shared.ts` → 本仓 `skills/self/dev-workflow/workflows/src/observability.shared.ts`（观测层单一构建输入，供其他构建器把同一观测层拼进自己的 workflow 产物）。安装命令（本仓检出版图内执行）：

```bash
ln -sf <zsw-skills 检出根>/scripts/workflow-observe.mjs ~/.agents/scripts/workflow-observe.mjs
ln -sf <zsw-skills 检出根>/skills/self/dev-workflow/workflows/src/observability.shared.ts ~/.agents/scripts/workflow-observability.shared.ts
```

用法错误 exit 2（stderr 含恢复动作）、写失败 exit 1。一次外部步骤 = 一对 start/end；整个执行结束时再记一对 `step=execution` 的 start/end（end 带 `--outcome <终态词>`）。

**统计入口**：`node <zsw-skills 检出根>/scripts/skill-usage-stats.mjs` 汇总 tech-design-wf / dev-flow-wf / dev-merge / pr-cr-fix 四技能的耗时与 token（双平台数据经 `pi-session-reader usage` CLI 采集——zcode `--db`、pi `--agent-dir`；观测事件直读观测根 JSONL，此外不直连任何数据库或会话文件）：

```bash
node <zsw-skills 检出根>/scripts/skill-usage-stats.mjs --skill dev-flow-wf --since 2026-10-01   # 单技能 + 时间窗（table 输出）
node <zsw-skills 检出根>/scripts/skill-usage-stats.mjs --format json --output /tmp/stats.json   # 全技能完整 JSON 报告
node <zsw-skills 检出根>/scripts/skill-usage-stats.mjs --pi-agent-dir ~/.taiji/agent --group stage --group model  # 追加 pi 数据目录与分组维度
```

- 选项：`--skill`（四技能或 all，可重复）、`--since`/`--until`（透传 usage CLI）、`--format table|json`、`--group stage|step|role|model|status`（可重复）、`--pi-agent-dir`（可重复，给出即替换缺省 `~/.pi/agent`；zcode 恒参与）、`--include-selftest`（缺省只算 production）、`--output <路径>`。未知参数与非法值 exit 2（含恢复动作），帮助 `--help`。
- 归因口径恒分开报：`observed` = run 带 `executionId` 且与观测 JSONL 精确关联（阶段/步骤窗口由事件 start/end 配对，actor/node 按时间重叠归窗）；`estimated` = 历史 run 按 run 名 + args（designDoc/execPlan/implPlan/base 等）+ actor 名称归类——精度低于 observed，两者不得相加视为同精度。认不出的进 unclassified 计数与明细。
- token 用 usage CLI 重算值（不读 spent_tokens / tokensReported 自报值）；时间双口径分开报：经历（证据区间并集=日历实际经过）与耗时相加（run duration 累加）。手工段（D0/D4/D6 只有事件没有模型用量）耗时照报、token 记 unknown 不写 0。坏 JSONL、未配对 start/end、声明 executionId 但缺观测文件等数据质量问题在 `dataQuality` 显式计数，不静默。
- 按 taskId 跨技能/跨 attempt 汇总在报告 `byTask` 节（observed/arg/legacy 词干来源分开标注）。

## Workflow 契约（执行体按宿主环境选择）

| workflow | 段 | args | 终态 |
|----------|----|------|------|
| W2 `wave-executor`（saved） | D1 / D3（两实例化） | `{ execPlan, taskId?, executionId?, sampleType? }` | completed / blocked / core-failed（统一失败处理中心：verify/inspect failed（dev 与 acceptance 模式一律）与 commit 门禁被拒入失败池 → 聚合裁决 → 修复组 → 机器重验（节点重跑 / 原 message 重试 commit），≤3 轮；终态携带 acceptanceFix = { rounds, disputed（聚合级与 fixer 级反证清单，人工裁决）, fixesDir }，非 null 时 disputed 必处置；轮内修不动的 commit 残留留 deferredCommits 呈报） |
| W3 `dev-consistency-loop`（saved） | D2 | `{ execPlan, maxRounds?, reviewerTemplate?, attempt?, taskId?, executionId?, sampleType? }` | converged / stuck / gate-a-failed / review-failure / fix-failure（Gate A 红后归因分诊独立 phase ≤2 轮：本批回归条目（GA-id）回注修复轮再修、瞬态重跑、存量红/测试基建缺陷带分诊报告终态；产物构建失败先引擎重跑自愈（stale），仍败回注修复轮（fixer 修产物脚本/基建），回注轮耗尽才终态；终态回写 status.json events：consistency 终态一笔恒写 + gate-a 笔仅在 converged/gate-a-failed 时写；必填字段双无条目降级登记项——deferredLedger 回流；attempt>1 时 Gate A 日志带 .attemptM 后缀） |
| W4 `design-code-sync-loop`（saved） | D5 | `{ designDoc, implPlan, projectRoot, maxRounds?, statusPath?, plannerTemplate?, reviewerTemplate?, attempt?, taskId?, executionId?, sampleType? }` | converged / contested / stuck + setup/planner/review/fix/retire/io-failure 族（修复组 commit 被仓库钩子拒时先派门禁修复 fixer 做合规修复（豁免标记/清单登记/指针跟改）+ 原 message 重试 ≤2 轮，仍拒才 fix-failure——真代码问题 fixer 返回空 fixed 转人工；模板路径与 attempt 缺省自动处理，attempt>1 历史产物不覆盖；终态含 overdesignCandidates——越权候选卡呈报） |

执行体按宿主环境选择：**zcode**（会话可见 CreateWorkflow 工具 / saved workflows）→ 上表 saved workflow 经 `CreateWorkflow saved` 发起；**pi**（subagent-workflow extension、workflow 工具可用）→ 本 skill 安装位置上级的 `../workflows/pi/<name>.js`（四件：wave-executor / dev-consistency-loop / design-code-sync-loop）复制或 symlink 到 `~/.pi/agent/workflows/`（或项目 `.pi/workflows/`）后 `workflow run <name> --args k=v`——两版脚本业务逻辑逐行一致，仅 agent 调用层与文件头不同；--args 值全字符串，数字参数脚本内自动归一，数组型不支持。两版均未就绪或发起失败 → 各段 flow 文件的手工路径（与 workflow 语义等价；断点恢复：zcode workflow 用 ResumeWorkflowRun/AmendWorkflow，pi 重新 run（attempt 递增防产物覆盖），手工路径以 status.json + git log 对账，冲突以 git 为准）。

**attempt 重发起纪律 [MANDATORY]**：对在途 run 重发起（AmendWorkflow / supersede）前尽量等在途节点落定（或先停派发让活跃节点收尾）——journal 缓存只认已完成节点，未完成的在途工作不入缓存，重发起即在途工作全部作废重做（实测单次损失 47.6 分钟 / 约 3700 万 token，2026-09-29）。

## 双平台脚本维护约定（改 workflows/src/ 时）

1. 改完必须先 `node scripts/build-workflows.mjs` 再提交——pre-commit 自动核对构建一致性 / 双平台对等 / 类型三道门，产物过期即拦。
2. **结构化返回接口两侧同 commit 同步**：改 zcode 壳（`.zcode.tpl.ts`）的 interface 顶层字段或 required 时，同步四个 pi 壳（`.pi.tpl.js`）对应 `SCHEMA_*` 的 properties 键与 required 数组；`check-workflow-parity.mjs` 按字段名机器核对，红灯 = 漏同步（描述文本两侧允许不同，不比对）。
3. 跨拷贝契约分层归宿判据（同一条规则在多处存在拷贝时按此选层）：拷贝是过渡态（已有收敛方向裁决）→ 不建共享基建，用不变量检查器守住过渡期，检查器随收敛自然退役；稳态且语义全同 → 物理收敛或构建期派生单一来源；稳态且存在合法变异 → 检查器断言共同不变量，变异留在各拷贝局部；纯文字范围 → 义务句 + 消费方按可观察特征分支（承认是愿望式约定，不是被强制执行的契约）。「机制要有已发生证据支撑」只约束机制复杂度（生成器 / 推导器 / 抽象层），不约束简单确定性断言——断言只需合理的失败路径。

## 关键约束

- [MANDATORY] 并发 ≤5（全局 subagent 约束）；模型按全局路由表、thinking max；task 三段式；环境中看不到指定模型时列出实际可见项请用户选择
- [MANDATORY] 手工路径的 subagent 派发一律后台异步、靠完成通知推进（zcode 即 run_in_background=true），禁止前台同步阻塞等待返回——同步等待长任务有超时丢失结果风险，且阻塞主 agent 无法流水化核验；workflow 通道不受此条约束
- [MANDATORY] 数字阈值：单元 dev→fix 超 2 轮 = blocked 升级用户；一致性审查累计 ≥3 轮不收敛或活跃数不减反增 = stuck 呈报（顽固条目 ≥2 轮修复未清随 escalated 清单标注，优先人工裁决）；终态同步 must-fix 连续 4 轮不降或单条 must-fix 存活超 2 轮 = 呈报
- [MANDATORY] e2e 只在开发阶段按改动范围跑（清单继承 T3 验收计划表），空载串行；PR/merge/CI 门禁只跑单测（SSOT = 项目 AGENTS.md 测试节）；自动化回归的长期方向 = e2e 逐步单测化——能以 mock/fixture 重放等价覆盖的圈定项，随所属单元转化为 L1/L2 单测
- [MANDATORY] 偏差三分类：合理 → 登记表固化；不合理 → 打回修；doc_errors → 引擎文档修复组在审出它的轮次当场修（方向 = 改文档对齐实现；fixer 核实方向两可或实现侧错误的条目回流主 agent 裁决）——哪个阶段审出来就在哪个阶段修，禁止把方向已明确的发现转手下一阶段（2026-10-06 裁决）
- [MANDATORY] D3 全绿 + D4 最终 commit 后自动进 D5（仅用户明示跳过可免，跳过须记录）；D5 收敛 = 整体交付
- [OPTIONAL] 高风险大单元可开 worktree 隔离（判据见 references/dag-authoring.md；exec-plan 节点 cwd 字段承载）

## 状态恢复

进度唯一事实源 = `<name>.status.json`（D0 生成于 `~/.agents/skill-data/dev-flow/<project-slug>/`，实际落点以 exec-plan 内 statusPath 声明为准；workflow/手工路径每次节点终态后回写）。恢复程序：以 git log 与工作区实物校准 status（**冲突以 git 为准**：标 done 无 commit → 回 pending；有 commit 未写 → 补写 done）→ 按所处段选 flow 落点续跑。

## 与老 dev-flow 的关系（灰度并行）

本技能是纯执行重构版（impl-plan 上移 tech-design-wf T3；编排收归 workflow；状态载体 JSON 化；design-code-sync 升级内嵌 D5）。老 dev-flow / design-code-sync 原样保留可随时切回；判据面（dag-authoring / parallelism-reviewer / post-delivery）同源继承。

## 标记说明

| 标记 | 含义 | 修改约束 |
|------|------|----------|
| `[HISTORICAL]` | 来自实际事故的规则（见 flow/post-delivery.md） | 不允许删除或削弱 |
| `[MANDATORY]` | 流程强制要求 | 必须严格遵守 |
| `[OPTIONAL]` | 可选步骤 | 可按需调整 |
