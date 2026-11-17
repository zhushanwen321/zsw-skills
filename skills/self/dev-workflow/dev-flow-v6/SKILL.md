---
name: dev-flow-v6
# 技能版本唯一权威（手动 semver）。bump 语义：MAJOR = 数据契约变更（须伴随 schemaVersion 升号）/
# MINOR = 行为新增（新参数、新阶段）/ PATCH = 修复与措辞。构建器（scripts/build-workflows.mjs）
# 读此值注入产物 SKILL_VERSION——改本行后必须重跑该构建，--check 对账版本戳
version: 6.1.0
description: >-
  Use when 一份完整设计包（tech-design-v6 产出：设计文档 + impl-plan.json 单源与渲染视图 + 审查终态）
  需要落地为已验收代码。纯执行七段——编译 → 开发 → 一致性审查 → 验收 → 收尾 →
  终态同步 → 交付后守护。
  三技能交付体系的技能③（裁判 = delivery-v6）：产出候选实现，交付结论只由裁决器给出。
  触发词：「wf 实施」「按设计包开发」「workflow 版实施」「设计包执行」。
  含 W2 wave-executor-v6 / W3 dev-consistency-loop-v6 / W4 design-code-sync-v2（conformance
  绑定包的对账引擎）与 design-code-sync-loop（未绑定 legacy 包只读期收尾）四个
  workflow 衔接（就绪前走内置手工路径）。W4 段含 design-code-sync 升级语义
  （三向功能对照矩阵 + 越权三问）。
  Not for 写/审设计文档（用 tech-design-v6 或老 tech-design）；无设计包的 bug 修复
  直接编码；只出计划不写代码（用 tech-design-v6——其 T2/T3 产出 impl-plan 后不进开发）；老流程实施（用老 dev-flow）。
---

# dev-flow-v6（dev-flow 纯执行版）

**纯执行**：impl-plan 的创建与审查已上移到 tech-design-v6 的 T3——本技能从「设计包」起步，主 agent 只做编译、发起 workflow、段间裁决、收尾，一切编排细节收归 workflow 确定性通道（workflow 未就绪时走各 flow 文件的手工降级路径，语义等价）。

## 设计包入口门 [MANDATORY]（机械可查）

入口逐行核对（任一缺失 → 拒绝并指明缺什么、回 tech-design-v6 哪个阶段补）。设计包目录按寻址双形态（算法与约定见 `skill-data-addressing.md`——`<zsw-skills 检出根>/skills/self/dev-workflow/references/skill-data-addressing.md`，本节不内联）：workspace 形态（同仓多个 worktree 同父目录）= `~/.agents/skill-data/tech-design/<ws-slug>/`——工作区级共享、无 worktree 段，任何 worktree 的入口门都发现同一设计包；单仓形态 = `~/.agents/skill-data/tech-design/<project-slug>/`（现行平铺，路径不变）。两种 slug 均由脚本按 projectRoot 检测后自动拼接，不手拼。下表 `<slug>` = 单仓形态的 project-slug 或工作区形态的 ws-slug：

交付体系任务（本技能的正常形态）还须先过**验收任务门**：

| 判据 | 缺失时 |
|------|--------|
| 交付任务目录存在已批准 acceptance.json（`delivery-gate evaluate` 的 state ∈ {design, revision-unstable, implementing, acceptance-approved, candidate, accepted, accepted_with_risk}——显式枚举，替换态 superseded / supersede-pending / supersede-cancelled 与未批准 draft 不放行；meta.json acceptanceBinding 与当前批准一致——D0 编译门 `check-exec-plan.mjs --task-dir` 机器核对：acceptanceVersion 与验收包联合哈希（acceptance.json + increments.json 解析内容规范 JSON）复算比对，见 `flow/compile.md` 步骤 3） | 回 delivery-v6 走验收设计与批准 |
| DesignApproved 存在且绑定的方案包哈希清单覆盖当前设计包（`verdict.designApproved == true`） | 回 tech-design-v6 重新确认方案包并 record-design-approved |
| increments.json 的增量契约未被 impl-plan 变更（D0 编译门 `check-exec-plan.mjs --task-dir <交付任务目录>` 逐增量核对 exec-plan 单元归属（nodes[].incrementId）与测试命令一致；不一致 → fail-fast 回 T3） | 回 tech-design-v6 修 T3（increments 的增删改属技能①，走验收版本递增重批） |

设计包判据表（交付体系任务同样适用）：

| 文件 | 判据 |
|------|------|
| `~/.agents/skill-data/tech-design/<slug>/<name>/`（设计目录：六章节 JSON 权威源，tech-design-v6 产物形态）+ `<slug>/<name>.rendered.md`（渲染视图） | 存在 |
| `<name>.impl-plan.json` + `.impl-plan.md`（与设计文档同目录；md 是渲染视图） | 两文件存在且 `node ~/.agents/skills/tech-design-v6/scripts/render-impl-plan.mjs <plan.json> --check` 绿（编译清单步骤 1） |
| `<name>/final.json`（审查报告目录，与设计文档同根） | terminated == "converged" |
| `<name>.plan-review.md`（与设计文档同目录） | 触发门槛（关键路径深度 ≥3 或单元 ≥4）时必须存在 |

**外部设计文档直投** → 拒绝，转 tech-design-v6（先补 T2 审查再 T3 拆计划）。
**交付体系外的独立执行**（用户明确不走交付体系）→ 无专用技能，按普通开发任务处理。

## 执行七段

| 段 | 内容 | 承载 | 推进门 |
|----|------|------|--------|
| D0 编译 | 编译器 `scripts/compile-exec-plan.mjs --impl-plan <plan.json>` 生成 exec-plan.json（生成即校验 PASS，含三类关联声明 associations 对账）+ 逐节点 promptFile + 初始 status.json（语义缺口回上游修后重新编译，禁手修生成物；验收资产就绪后再跑 `--mode acceptance`；手工降级路径见 flow 文件）+ L0 前置 + 环境 smoke | 主 agent | `flow/compile.md` |
| D1 开发循环 | 单元 DAG 流式并行（写码→核验→commit→解锁；开发期 e2e verify 失败与 commit 门禁被拒同入统一失败处理中心轮内修；过程审查 kind=review 节点 = 渐进式 review——机器检查三态 + reviewer 按需触发 + 修复波及机器重验，过程记录 process-review.jsonl 带 process 域章，与交付事件流经 `delivery-core events` 读侧合流（分储单口），判据见 `flow/compile.md`） | W2 wave-executor-v6（手工路径 `flow/execute.md`） | 全节点 done 或 blocked |
| D2 一致性审查 | diff × 设计对照（R1 全面分区审 / R2+ 定向复审）+ 每轮聚合定性独立 phase（跨区同根因去重 / 定性复核 / 无交集分组 / 跨职责路由）+ 修复组流式槽位池并行（在途 ≤5；文档修复组按文件门控进同一派发池——不相交同池并行、相交回退串行段）+ Gate A 全量测试（红后归因分诊独立 phase：本批回归条目回注修复轮再修、瞬态重跑、存量红/测试基建缺陷带分诊报告终态，≤2 轮） | W3 dev-consistency-loop-v6（手工路径 `flow/consistency-review.md`） | unreasonable 清零 + Gate A 绿 |
| D3 端到端验收 | 验收计划表 L3/L4 编译成 verify/inspect 节点（核心先行 + 短路）+ 验收失败修复循环（failed 入失败池 → 聚合裁决独立 phase（跨节点同根因合并/disputed 反证/文件不相交分组）→ 修复组独立 phase（fixer 修产品代码与验收资产，引擎按组 commit）→ 节点重置机器重验回调度循环，≤3 轮不收敛才熔断） | W2 第二实例化（手工路径 `flow/acceptance.md`） | 验收全绿 |
| D4 收尾（候选完成） | 交付汇总 + 增量实现登记（交付体系任务：逐增量以 builder 凭据 `delivery-gate append` 登记 ImplementationRecorded，与 candidate-build-v6 同一事件流与回执口径——`flow/acceptance.md` 收尾节）+ 功能分级登记 + 文档资产同步 + ADR 复审 + 最终 commit——收尾产出的是**候选实现**，不是交付结论 | 主 agent | `flow/acceptance.md` 收尾节 |
| D5 终态同步 | 代码与设计差距收敛为固定义务覆盖率的一致性对账（义务表 → checker 派发（机械优先/语义缓存）→ 差距地址聚合 → 隔离变更集 → 集成器唯一写入门径 → 四层结论；状态唯一权威 = conformance-state 事件流，agent 无状态；未绑定 legacy 包由旧引擎只读期收尾，带 cutover 标记的包旧引擎入口拒启） | W4 v2 design-code-sync-v2（绑定包；手工路径 `flow/sync.md`）/ W4 legacy design-code-sync-loop（未绑定包收尾） | 引擎 completed + 覆盖率分母全 verified/waived |
| D6 交付后守护 | 交付后修复回写纪律 + 按需定向对抗审查 | 主 agent | `flow/post-delivery.md`（[HISTORICAL] 原样） |

段间不设用户确认（gate 驱动连续推进）；熔断终态（blocked / stuck / core-failed / contested / gate-a-failed / review-failure / fix-failure）停回主 agent 按 flow/execute.md 与 flow/consistency-review.md 的终态处置表处置——core-failed / gate-a-failed 在 D3/D2 是修复循环不收敛的出口（常态失败已由轮内聚合修复消化），终态自带归因材料（聚合清单 / 分诊报告 / disputed 反证）。

### D3 验收 wrapper 模板（V6 代，主 agent 编译 verify 节点时照抄）

> 编译器通道：D0 acceptance 编译（`compile-exec-plan.mjs --mode acceptance`）已自动经 `gen-acceptance-wrapper.mjs` 生成 wrapper（runner 契约从 impl-plan `acceptancePlan[].runner/scenario` 声明组装，禁手改）；本模板仅手工降级路径使用。

两场实跑证实 D3 首发失败集中在此处，三个坑全部来自引擎接口与直觉相反：引擎以 `node <script>` 直跑 wrapper、**不传任何参数**；`node` 从 stdin 读脚本时 `__dirname` 是 `.`（不是脚本目录）；产物目录不存在时引擎按「节点失败」判定（必须脚本自建）。模板（`<ARTIFACTS_DIR>` 与测试命令写死为绝对路径）：

```js
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
// 产物目录必须脚本自建（引擎不建；exec-plan 里也要存这个绝对路径，不是相对路径）
const ARTIFACTS_DIR = "<taskDir>/evidence/<node-id>-artifacts";
fs.mkdirSync(ARTIFACTS_DIR, { recursive: true });
const run = spawnSync("<program>", [<args>], { encoding: "utf8", timeout: <timeoutMs> });
// summary.jsonl 是 inspect 节点的核对依据：passed 与 skipped 必须分开统计（不可从 exitCode 推断）
const counts = { passed: <数>, failed: <数>, skipped: <数> };
fs.appendFileSync(path.join(ARTIFACTS_DIR, "summary.jsonl"), JSON.stringify({ node: "<node-id>", ...counts, exitCode: run.status }) + "\n");
process.stdout.write(`PASS ${counts.passed} FAIL ${counts.failed} SKIP ${counts.skipped}\n`);
process.exitCode = run.status === 0 ? 0 : 1;
```

要点：wrapper 落盘位置在交付体系产物区（skill-data），不进答卷/项目仓；测试日志同时落 `ARTIFACTS_DIR` 供 inspect 核对；stats 行输出 `PASS n FAIL n SKIP n`（数字分开，禁止只打 ok）。

## 核心原则

1. **编排者零编码**：主 agent 只编译、发起、裁决、commit（workflow 形态下 commit 也归引擎）；一切 src/tests 编写修改走 subagent/节点
2. **门只认证据**：推进只承认命令输出、diff、结构化终态——无证据的「已完成」一律退回
3. **验证方式分级 L0-L4**（低成本高收益前置）：L0 静态规则（主 agent/world.run 直跑）→ L1 增量单测（节点/dev 自跑）→ L2 全量套件（D2 Gate A）→ L3 脚本端到端（verify 节点）→ L4 agent 端到端（inspect 节点）。低级未清不进高级
4. **范围对账**：节点/dev 优先改任务书声明范围内的文件；范围外的必要改动直接做 + 自报 deviations/自报清单如实登记——运行时不再逐文件打回（2026-09-29 裁决范围声明降级），改动对账由核验对账事件、终态残留核查与 D2 一致性审查承接；并行单元互不触碰对方声明内的文件（写冲突会互相覆盖丢改动，不可恢复）
5. **git 单点**：subagent 禁止一切 git 写；workflow 形态下 commit 由引擎 world.run 执行（精确路径 add，禁 -A），手工形态下由主 agent 执行；文档类同步改动禁止单独成笔——随触发它的单元同笔提交（files_changed 含文档路径即同笔）；确因验收结论后置的攒批成一笔，禁止一文档一笔
6. **基线先行**：exec-plan.json 落盘即基线（产物在 `~/.agents/skill-data/`，HOME 下天然不入 git）；执行态事实源 = `<name>.status.json`
7. **单波次交付**：一个设计包 = 一次实施流程，实际执行只有一个波次；未经用户明确指示，禁止按「波次/批次」把一个 impl-plan 拆成多次独立实施（每波各自走 D1-D6 完整流程）。允许的拆分 = impl-plan 内部的单元分组与 DAG 并行（多 subagent / 多组执行，W2 一次承接全部单元）；分期交付仅随用户明确指示出现
8. **独立保证与有限修复（V6 代）**：候选反例审查在 D3 后、D4 前完成（全部 schema 2 任务，与风险字段无关）。最终保证分 full 与 recheck：full = 覆盖核对 + 全量断言取证 + 开放探索（开放探索按「缺少候选探索证据、验收或关键设计变化」触发，已有合格候选探索时引用既有探索）；recheck = 旧发现与修复 diff 复核 + 受影响断言 + 全量确定性测试 + 历史探索引用，不默认重新开放探索。实现性修复统一走 `assurance-repair-loop-v6`（builder 凭据 + 受影响一致性复核 + 显式 allowCommit 授权），第 4 轮修复或第 11 条不同 must-fix 进入 process-failed；同一问题 reopenOf 不重复计数，环境与证据采集重试不计轮（登记 RepairRoundRecorded 带 nature=environment|evidence，缺省 nature=behavior 计轮），保证后的方案修订与验收版本递增各按一轮并入计轮。最后一批建议级修复后以 recheck 完成当前版本取证，不为攒批项重新开放探索。

## 运行记录（防丢失）[MANDATORY]

任务执行期信息统一平铺落 dev-flow 段（`<name>.` 前缀隔离）：workspace 形态 = `~/.agents/skill-data/dev-flow/<ws-slug>/<worktreeName>/`（worktree 级隔离——status 与 git 实物对账、断点恢复都绑定该 worktree 的检出状态），单仓形态 = `~/.agents/skill-data/dev-flow/<project-slug>/`（现行平铺，路径不变）；设计包在 tech-design 段同源（workspace 形态 `tech-design/<ws-slug>/`，工作区级共享无 worktree 段）。slug 判据见 skill-data-addressing.md，下表路径相对 dev-flow 段产物根。两类载体、三条写入通道：

| 载体 | 写入者 | 内容 |
|------|--------|------|
| `<name>.runlog/<记录者>.md` | 每个执行 agent（任务书 / W3·W4 prompt 注入义务行，路径由注入方给出） | 过程性发现：临时待办、需裁决事项、复盘观察（踩坑根因 / 方案取舍 / 环境异常）。一行一条 `[HH:MM] 类型: 一句话事实`，append 式即时写盘——agent 中途退出也留痕；每记录者独占一文件，无并发冲突 |
| `<name>.ledger.md` | ① W2/W3/W4 引擎终态各一笔（attempt 标识）② 主 agent 处置时追加 | ① 未决事项清单：blocked / deferredCommits / deferredLedger / escalated / contested / overdesignCandidates / 工作区残留等 ② 熔断处置与用户裁决记录（时间 + 终态 + 动作 + 理由 + 结果） |

- 引擎侧已核实互不干扰：产物在 HOME 下不在项目工作区内，`git status --porcelain` 天然看不到（引擎对项目内 `.tmp/` 的过滤器仍在——wave-executor-v6 `isTmpArtifact`，覆盖仍在项目内的其他临时产物），agent 写 runlog 不触发核验红灯
- **ledger 是中转不是归宿**：合理偏差 / 残留风险 / ADR 的最终登记处仍是 `.impl-plan.json` 的 `reasonableDeviations` / `residualRisks` 字段（写后重跑渲染命令刷新 `.impl-plan.md` 视图，禁手改 `.impl-plan.md`）、docs/adr——D4 收尾把未清项分流过去（处置完成标记 / 登记到既有归宿 / 显式记录丢弃理由），禁止双登记并存
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
| `skill` / `stage` / `step` | 所属技能的 canonical 名（tech-design-v6 / dev-flow-v6 / delivery-v6——统计按它过滤，禁止写 workflow 脚本名）/ 流程阶段编号（tech-design-v6 的 T2、dev-flow-v6 的 D0-D6、delivery-v6 三 workflow 的 DESIGN / BUILD / ASSURE）/ 阶段内步骤（execution / setup / review / aggregate / fix / execute / finalize / gate-a / retire，外部步骤自定） |
| `round` / `attempt` | 循环轮次 / 重发起序号（无则 null；attempt 在启动早期自动检测未完成时也为 null，检测确定后其后的事件带值） |
| `event` / `timestamp` / `sample_type` | start 或 end / ISO8601 / production（真实执行，缺省）或 selftest（测试执行） |
| `outcome`（可选） | 仅出现在终态统一补记的 end 上，值 = 本次执行的终态词（如 completed / converged / blocked / setup-failure） |

**生成与传递**：`task_id` 由主 agent 在 D0 编译时分配（建议 = 设计包 `<name>`），同一任务的 D0/D1/D2/D3/D4/D6 全段共用；`execution_id` 每次发起一个新的执行时分配（建议 = `<段名>-<发起时点短时间戳>`），同一 execution_id 的多次重发起共用（attempt 字段区分轮次）。W2（D1/D3）、W3（D2）与 W4（D5）已内建：发起时 args 同时传 `taskId` 与 `executionId` 即启用，stage 自动记录（D1/D3 按 exec-plan 的 mode 区分，D2 恒 D2，D5 恒 D5），步骤边界由引擎写入——W2 的 setup/finalize、W3 每轮的 review/aggregate/fix/gate-a、W4 v2 的 setup（义务表装载/workspace 清单/状态仓/裁决装载/宿主清扫）/fix（每轮 checker 派发与修复集成）、W4 legacy 的 setup（环境校验/矩阵初始化/框架对照规划）/review（机械信号扫描 + 并行模块审查，R2+ 含聚焦复审）/fix（并行修复）/retire（退役判定）/finalize（轮次耗尽收尾）。

**可选兼容**：两参都不传 = 观测关闭、业务照常（存量调用不受影响）；只传其一 = 告警（含恢复动作）并关闭，不猜测意图；观测写失败 = 告警（同一文件只告警一次）不改业务终态——观测是辅助功能，故障不拖垮主流程。

**workflow 外步骤（D0/D4/D6）由主 agent 用观测命令记录边界**，契约与内建观测完全一致。统一运行入口 = `~/.agents/scripts/workflow-observe.mjs`（dev-flow-v6 可在任意项目运行，禁止写仓库相对路径 `scripts/workflow-observe.mjs`——那会解析到当前业务项目）：

```bash
node ~/.agents/scripts/workflow-observe.mjs start --task-id <task-id> --execution-id <exec-id> --skill dev-flow-v6 --stage D0 --step compile
node ~/.agents/scripts/workflow-observe.mjs end   --task-id <task-id> --execution-id <exec-id> --skill dev-flow-v6 --stage D0 --step execution --outcome completed
```

**安装说明**：运行入口是 zsw-skills 仓 `scripts/workflow-observe.mjs` 的安装 symlink；同目录另有一个 symlink `~/.agents/scripts/workflow-observability.shared.ts` → 本仓 `skills/self/dev-workflow/workflows/src/observability.shared.ts`（观测层单一构建输入，供其他构建器把同一观测层拼进自己的 workflow 产物）。安装命令（本仓检出版图内执行）：

```bash
ln -sf <zsw-skills 检出根>/scripts/workflow-observe.mjs ~/.agents/scripts/workflow-observe.mjs
ln -sf <zsw-skills 检出根>/skills/self/dev-workflow/workflows/src/observability.shared.ts ~/.agents/scripts/workflow-observability.shared.ts
```

用法错误 exit 2（stderr 含恢复动作）、写失败 exit 1。一次外部步骤 = 一对 start/end；整个执行结束时再记一对 `step=execution` 的 start/end（end 带 `--outcome <终态词>`）。

**统计入口**：`node <zsw-skills 检出根>/scripts/skill-usage-stats.mjs` 汇总 tech-design / dev-flow / delivery 三代（v1 / v2 / dev）+ dev-merge + pr-cr-fix 的耗时与 token（双平台数据经 `agent-session-reader usage` CLI 采集——zcode `--zcode`、pi `--pi=<目录>`；观测事件直读观测根 JSONL，此外不直连任何数据库或会话文件）：

```bash
node <zsw-skills 检出根>/scripts/skill-usage-stats.mjs --skill dev-flow-v6 --since 2026-10-01   # 单技能 + 时间窗（table 输出）
node <zsw-skills 检出根>/scripts/skill-usage-stats.mjs --format json --output /tmp/stats.json   # 全技能完整 JSON 报告
node <zsw-skills 检出根>/scripts/skill-usage-stats.mjs --pi-agent-dir ~/.taiji/agent --group stage --group model  # 追加 pi 数据目录与分组维度
```

- 选项：`--skill`（技能名或 all，可重复）、`--since`/`--until`（透传 usage CLI）、`--format table|json`、`--group stage|step|role|model|status`（可重复）、`--pi-agent-dir`（可重复，给出即替换缺省 `~/.pi/agent`；zcode 恒参与）、`--include-selftest`（缺省只算 production）、`--output <路径>`。未知参数与非法值 exit 2（含恢复动作），帮助 `--help`。
- 归因口径恒分开报：`observed` = run 带 `executionId` 且与观测 JSONL 精确关联（阶段/步骤窗口由事件 start/end 配对，actor/node 按时间重叠归窗）；`estimated` = 历史 run 按 run 名 + args（designDoc/execPlan/implPlan/base 等）+ actor 名称归类——精度低于 observed，两者不得相加视为同精度。认不出的进 unclassified 计数与明细。
- token 用 usage CLI 重算值（不读 spent_tokens / tokensReported 自报值）；时间双口径分开报：经历（证据区间并集=日历实际经过）与耗时相加（run duration 累加）。手工段（D0/D4/D6 只有事件没有模型用量）耗时照报、token 记 unknown 不写 0。坏 JSONL、未配对 start/end、声明 executionId 但缺观测文件等数据质量问题在 `dataQuality` 显式计数，不静默。
- 按 taskId 跨技能/跨 attempt 汇总在报告 `byTask` 节（observed/arg/legacy 词干来源分开标注）。

## Workflow 契约（执行体按宿主环境选择）

| workflow | 段 | args | 终态 |
|----------|----|------|------|
| W2 `wave-executor-v6`（saved） | D1 / D3（两实例化） | `{ execPlan, taskId?, executionId?, sampleType? }` | completed / blocked / core-failed（统一失败处理中心：verify/inspect failed（dev 与 acceptance 模式一律）与 commit 门禁被拒入失败池 → 聚合裁决 → 修复组 → 机器重验（节点重跑 / 原 message 重试 commit），≤3 轮；终态携带 acceptanceFix = { rounds, disputed（聚合级与 fixer 级反证清单，人工裁决）, fixesDir }，非 null 时 disputed 必处置；轮内修不动的 commit 残留留 deferredCommits 呈报） |
| W3 `dev-consistency-loop-v6`（saved） | D2 | `{ execPlan, maxRounds?, reviewerTemplate?, attempt?, taskId?, executionId?, sampleType? }` | converged / stuck / gate-a-failed / review-failure / fix-failure（Gate A 红后归因分诊独立 phase ≤2 轮：本批回归条目（GA-id）回注修复轮再修、瞬态重跑、存量红/测试基建缺陷带分诊报告终态；产物构建失败先引擎重跑自愈（stale），仍败回注修复轮（fixer 修产物脚本/基建），回注轮耗尽才终态；终态回写 status.json events：consistency 终态一笔恒写 + gate-a 笔在 converged/gate-a-failed 恒写、stuck 且 Gate A 已跑时同写；必填字段双无条目降级登记项——deferredLedger 回流；attempt>1 时 Gate A 日志带 .attemptM 后缀） |
| W4 v2 `design-code-sync-v2`（saved） | D5（conformance 绑定包） | `{ designPkg, projectRoot, declaredRepos, confirmedRepoIds?, sandboxRoot?, stateRoot?, confRoot?, reviewerTemplate?, fixerTemplate?, maxRounds?, rulingsFile?, taskId?, executionId?, sampleType? }` | 四层结论 scriptStatus / engineOutcome（completed / awaiting-ruling / stopped / failed）/ integrationOutcome（not-required / not-started / verified-pending-integration / integrated / rolled-back / failed）/ deliveryOutcome（pending / blocked——resolved 系列由主 agent 在裁决器 verdict 为 accepted/accepted_with_risk 后追记，人工接管走集成器 manual 模式）；续跑 = 同 stateRoot 重发（事件流恢复），裁决续跑携 rulingsFile（respondsTo 锚点在停回 message）；文档侧差距走 doc-proposals 提案 + 裁决门径 |
| W4 legacy `design-code-sync-loop`（saved） | D5（未绑定 legacy 包只读期收尾） | `{ designDoc, implPlan, projectRoot, maxRounds?, statusPath?, plannerTemplate?, reviewerTemplate?, attempt?, taskId?, executionId?, sampleType? }` | converged / contested / stuck + setup/planner/review/fix/retire/io-failure 族（修复组 commit 被仓库钩子拒时先派门禁修复 fixer 做合规修复（豁免标记/清单登记/指针跟改）+ 原 message 重试 ≤2 轮，仍拒才 fix-failure——真代码问题 fixer 返回空 fixed 转人工；模板路径与 attempt 缺省自动处理，attempt>1 历史产物不覆盖；终态含 overdesignCandidates——越权候选卡呈报；setup 第一步 cutover 检查——已切换包拒启） |

执行体按宿主环境选择：**zcode**（会话可见 CreateWorkflow 工具 / saved workflows）→ 上表 saved workflow 经 `CreateWorkflow saved` 发起；**pi**（subagent-workflow extension、workflow 工具可用）→ 本 skill 安装位置上级的 `../workflows/pi/<name>.js`（五件：wave-executor-v6 / dev-consistency-loop-v6 / design-code-sync-loop / design-code-sync-v2 / tech-review-loop-v6——tech-review-loop-v6 属 tech-design-v6 的 W1，dev-flow-v6 运行只需前四件）复制或 symlink 到 `~/.pi/agent/workflows/`（或项目 `.pi/workflows/`）后 `workflow run <name> --args k=v`——两版脚本业务逻辑逐行一致，仅 agent 调用层与文件头不同；--args 值全字符串，数字参数脚本内自动归一，数组型不支持。两版均未就绪或发起失败 → 各段 flow 文件的手工路径（与 workflow 语义等价；断点恢复：zcode workflow 用 ResumeWorkflowRun/AmendWorkflow，pi 重新 run（attempt 递增防产物覆盖），手工路径以 status.json + git log 对账，冲突以 git 为准）。

**attempt 重发起纪律 [MANDATORY]**：对 run 重发起分两种形态，前提判据 = 脚本是否变化——

- **形态一：改脚本重发（含 AmendWorkflow 改脚本）**：对在途 run 重发起前尽量等在途节点落定（或先停派发让活跃节点收尾）——journal 缓存只认已完成节点，未完成的在途工作不入缓存，改脚本重发起即在途工作全部作废重做（实测单次损失 47.6 分钟 / 约 3700 万 token，2026-09-29）
- **形态二：脚本不变的重发**（GUI 仅改模型设置，提示 Changed the settings of workflow run；脚本不变的 AmendWorkflow 同效）：已完成工作零重做——已完成节点（ask 与 world-run）按 journal 重放、同秒完成不重新派发；在途 actor 的 session 历史完整并入新 run 同名 actor session、新模型从断点续跑（实测依据：2026-11-08 tech-review-loop-v4 三次 run，R1 六个 ask 节点同秒重放、在途 actor 21 条消息原样保留后由新模型续跑）。损失上限 = 切换瞬间各在途 actor 正在流式生成、尚未落盘的消息（每个在途 actor 至多一条，并行 actor 分别计）。附带口径提醒：跨 run 汇总 token 时继承消息会在新旧 run 各计一次，读 usage 统计时注意
- 脚本不变的重发不适用形态一的等待纪律

## 双平台脚本维护约定（改 workflows/src/ 时）

1. 改完必须先 `node scripts/build-workflows.mjs` 再提交——pre-commit 自动核对构建一致性 / 双平台对等 / 类型三道门，产物过期即拦。
2. **结构化返回接口两侧同 commit 同步**：改 zcode 壳（`.zcode.tpl.ts`）的 interface 顶层字段或 required 时，同步四个 pi 壳（`.pi.tpl.js`）对应 `SCHEMA_*` 的 properties 键与 required 数组；`check-workflow-parity.mjs` 按字段名机器核对，红灯 = 漏同步（描述文本两侧允许不同，不比对）。
3. 跨拷贝契约分层归宿判据（同一条规则在多处存在拷贝时按此选层）：拷贝是过渡态（已有收敛方向裁决）→ 不建共享基建，用不变量检查器守住过渡期，检查器随收敛自然退役；稳态且语义全同 → 物理收敛或构建期派生单一来源；稳态且存在合法变异 → 检查器断言共同不变量，变异留在各拷贝局部；纯文字范围 → 义务句 + 消费方按可观察特征分支（承认是愿望式约定，不是被强制执行的契约）。「机制要有已发生证据支撑」只约束机制复杂度（生成器 / 推导器 / 抽象层），不约束简单确定性断言——断言只需合理的失败路径。
4. **workflow 脚本写法约束（防 CreateWorkflow 发起预检爆炸）**：预检会全量分析脚本控制流图，两种写法让边数组指数爆炸——轻则预检劣化到分钟级，重则大数组展开超限抛 "Maximum call stack size exceeded" 把整个回合带崩（2026-11-04 dev-consistency-loop-v4 实测：边 54 万条必崩，改后 618ms 通过）：① 迭代回调里链 `.then()`（`items.map((item) => acquire().then(async () => {...}))`）——回调被内联进扇形区域、throw 跳转边按入口事实数成倍克隆；改写为 `const runOne = async (item) => { await acquire(); ... }` + `items.map((item) => runOne(item))`，语义等价（acquire 仍在 map 序同步调用，微任务顺序与释放/错误路径不变）。② 派发经过任务对象中转（`names.map((n) => ({ run: async () => {...} }))` + `pool(tasks, N, (t) => t.run())`）——对象方法间接调用让内联展开超线性；改为池直接按条目派发 `pool(names, N, (n) => runOne(n))`，执行体提为命名 async 函数。两处各消一个乘法因子，只改一处不够（单改实测 47~72s，同改才回亚秒）。

## 关键约束

- [MANDATORY] 并发 ≤5（全局 subagent 约束）；模型按全局路由表、thinking max；task 三段式；环境中看不到指定模型时列出实际可见项请用户选择
- [MANDATORY] 手工路径的 subagent 派发一律后台异步、靠完成通知推进（zcode 即 run_in_background=true），禁止前台同步阻塞等待返回——同步等待长任务有超时丢失结果风险，且阻塞主 agent 无法流水化核验；workflow 通道不受此条约束
- [MANDATORY] 数字阈值：单元 dev→fix 超 2 轮 = blocked 升级用户；一致性审查累计 ≥3 轮不收敛或活跃数不减反增 = stuck 呈报（顽固条目 ≥2 轮修复未清随 escalated 清单标注，优先人工裁决）；终态同步 must-fix 连续 4 轮不降或单条 must-fix 存活超 2 轮 = 呈报
- [MANDATORY] e2e 只在开发阶段按改动范围跑（清单继承 T3 验收计划表），空载串行；PR/merge/CI 门禁只跑单测（SSOT = 项目 AGENTS.md 测试节）；自动化回归的长期方向 = e2e 逐步单测化——能以 mock/fixture 重放等价覆盖的圈定项，随所属单元转化为 L1/L2 单测
- [MANDATORY] 偏差三分类：合理 → 登记表固化；不合理 → 打回修；doc_errors → 引擎文档修复组在审出它的轮次当场修（方向 = 改文档对齐实现；fixer 核实方向两可或实现侧错误的条目回流主 agent 裁决）——哪个阶段审出来就在哪个阶段修，禁止把方向已明确的发现转手下一阶段（2026-10-06 裁决）
- [MANDATORY] D3 全绿 + D4 最终 commit 后自动进 D5（仅用户明示跳过可免，跳过须记录）；交付体系任务在 D4 收尾完成**增量实现登记**（逐增量以 builder 凭据 `delivery-gate append` 登记 ImplementationRecorded 含合并回执——独立保证与裁决器消费该事件，缺它主流程 5→6 步走不通，步骤见 `flow/acceptance.md` 收尾节）；D5 收敛后回 delivery-v6 发起 independent-assurance-v6 独立取证并 `evaluate`——**本技能任何阶段都不宣告交付**，accepted/accepted_with_risk 只由裁决器给出
- [MANDATORY] 发现桥接：D2/D3 的终态未决项（不合理遗留、escalated 顽固条目）由主会话经 `delivery-gate append`（builder 凭据）登记 FindingRaised（category=defect；实现有意的边界申报用 boundary 并附对照论证）后随候选交付——裁决器据此判定，不在本技能内部静默吞掉；D5 的 conformance 未覆盖项按其状态分流登记
- [OPTIONAL] 高风险大单元可开 worktree 隔离（判据见 references/dag-authoring.md；exec-plan 节点 cwd 字段承载）

## 状态恢复

进度唯一事实源 = `<name>.status.json`（D0 生成于 dev-flow 段产物根——workspace 形态为 `<ws-slug>/<worktreeName>/` 两级，单仓形态为现行 `<project-slug>/` 平铺；实际落点以 exec-plan 内 statusPath 声明为准；workflow/手工路径每次节点终态后回写）。恢复程序：以 git log 与工作区实物校准 status（**冲突以 git 为准**：标 done 无 commit → 回 pending；有 commit 未写 → 补写 done）→ 按所处段选 flow 落点续跑。

## 与归档代（v1 / v2 / v3）的关系

本技能是纯执行重构形态（impl-plan 上移 tech-design-v6 T3；编排收归 workflow；状态载体 JSON 化；design-code-sync 升级内嵌 D5）。v1 / v2 / v3 已归档（仓库根 `.archived/`，不入版本库），不再作为正式技能；v4 为质量传递线（三方对账、候选反例审查、受控修复循环）。v5 接入 delivery-core 内核：W2 节点状态六写入点收敛为单一转移入口（`computeNodeTransition` 与内核 node 域同表，测试对拍；attempts 语义修复——派发即计数、重派不清零）；D2 条目回流上限 ≤2（超限转升级呈报停回）；status.json 人工处置唯一合法通道 = `delivery-core node-transition --event manual-disposition --basis`（主 agent 禁止直改 status.json 或自造词表外事件）。W2/W3 执行韧性层构建期拼接（resilience.shared.ts）；W4 对账引擎继续跨代共用，避免状态双写。

## 标记说明

| 标记 | 含义 | 修改约束 |
|------|------|----------|
| `[HISTORICAL]` | 来自实际事故的规则（见 flow/post-delivery.md） | 不允许删除或削弱 |
| `[MANDATORY]` | 流程强制要求 | 必须严格遵守 |
| `[OPTIONAL]` | 可选步骤 | 可按需调整 |
