---
name: delivery-v6
# 技能版本唯一权威（手动 semver）。workflow 构建器读此值注入产物；改本行后必须重建
version: 7.3.0
description: >-
  Use when 用户说「设计并实现」「按目标与验收开发」「独立验收」「审查这次交付」「高风险功能开发」，
  需要把需求转为有证据支持的代码交付，或只完成其中的目标与验收设计、候选实现、独立保证。
  适合功能开发、架构改动和需要回归判据的 bug 修复。Not for 纯调研、只讨论方案不落产物、
  无行为判据的文档润色、用户明确要求跳过验证直接写代码、局部一行小修。
---

# delivery-v6（技能①：目标与验收·裁判）

三技能交付体系的裁判：定义什么算对 → 独立验证 → 唯一宣告交付。tech-design-v6（技能②设计）与
dev-flow-v6（技能③执行）在本体系内协作：②在已批准目标与验收的约束下推敲方案并登记方案包；
③按验收与方案产出候选实现；交付结论只由本技能的裁决器给出。

先按用户意图读对应文件再执行；不要在主会话凭记忆手写验收、事件或 `verdict.json`。

## 核心边界

1. **目标与验收先于并独立于方案**：acceptance.json 定义外部可观察的正确行为；方案可以换，验收不跟着方案改。
2. **实现完成不等于接受交付**：`implemented`、`contract-ready`、workflow `completed` 都是过程状态；技能③产出只是候选。
3. **唯一交付判定**：只有 `delivery-gate evaluate` 能写 `verdict.json`；自动和手工路径使用同一判据。
4. **独立保证**：由不参与实现的角色核对验收覆盖，并按风险进行探索性审查——主动寻找验收与测试遗漏。独立保证不得只复用实现方的契约解释与模拟环境：须独立取得权威环境事实（真实 SDK、宿主源码或正式文档），无法取得时登记为证据缺口（详细责任在 coverage-reviewer 提示词，此处不重复）。
5. **未知不等于通过**：`partial` 不是 `verified`；用户接受风险也不改写成已验证。schema 2 缺口逐「断言×证据类型」判定，schema 1 保持「需求×证据类型」兼容语义。
6. **外部契约运行可用性**：交付物依赖外部系统（真实宿主 / 官方运行器 / 外部 SDK）时，`accepted` 必须意味着真实运行环境可用——权威工件已登记、runtime 义务在当前 revision 被 official-runner 或 real-host 证据满足；mock 绿或代码存在不构成运行可用。

## 交付事务内核（delivery-core）

「下一步做什么」的唯一回答者是内核（`scripts/delivery-core.mjs` CLI + `scripts/kernel/rules.json` 五域转移表 + `scripts/lib/kernel-judgments.mjs` 判定单源库）。主 agent 每次裁决前先 `delivery-core next --task-dir <taskDir>`，按合法转移的 executor 执行（转移带 kind 分类：裁决点停回 / workflow 转移附可照抄的预填发起规格 / gate 命令；`--auto` 自动执行 evaluate 类例行转移），不凭会话记忆推演流程：

- **转移表是数据不是文档**：任务 / DAG 节点 / 发现 / 探索 / 验收包五域，`validate` 静态校验（无环除回边、状态可达、执行器唯一、谓词与角色在词表、写入矩阵词表闭包）——流程顺序矛盾在定义期被机器检出，不靠实跑暴露；静态校验随全量测试进 CI（`.github/workflows/ci.yml`）。
- **判定单源**：发现 open 集、可用探索集、探索 due、修复轮预算只保留一份实现（kernel-judgments）；gate 与内核同进程复用，workflow 经内核 CLI 的 JSON 子命令消费（workflow 产物禁 import 的平台约束下仍单实现——判定随技能更新即时生效、artifact 哈希校验不分叉），禁止在 workflow 复刻同口径判定。
- **事件意图提交**：全部事件经意图命令登记（record-implementation / record-finding / record-evidence / record-exploration / complete-assurance 等），信封（actor/revision/acceptanceVersion/domain/artifactSha256）由 gate 构造，执行器不再手工拼事件 JSON；`append` 通道已退役。
- **写入防护**：批准即冻结验收包（0444 + frozen/v<N>/ 快照）；合法修订唯一通道 `open-revision`（RevisionOpened 留痕解封）；漏网改写被加载时篡改检测拦下；写入矩阵「角色 × 当前阶段 × 目标域」在写入当刻执行（builder 不可写验收/证据/裁决域，assurance 不可写实现/裁决域）。
- **status.json 派生视图**：节点状态以 status.events 为源（事件带结构化 payload），`node-project` 按事件重新推算并比对在盘 nodes——绕过转移入口的改动被检出，`--write` 以事件恢复。
- **过程记录读侧合流**：交付事件带 domain 章，过程记录（process-review.jsonl）带 process 域章；`delivery-core events` 输出统一时间线（签名流与观测流分储、读侧单口——签名完整性不因观测数据稀释）。
- **定级护栏**：关联需求已有断言级判据明文覆盖的发现禁止归 boundary；non-blocker 必须附 consequenceRefutation 三类论证；同一条目定级组合超过 2 种熔断停回用户；T2 聚合分级与 D2 聚合定性的改判必附理由留痕，同一 ref/条目连续改判达上限停回（aggregateRegradeHalt）。护栏只拦新写入；历史记录违规在加载折算时留档 guardrailWarnings（旧任务目录可读）。
- **循环预算**：perVersion 修复 ≤3、不同 must-fix ≤10、跨 run 保证总轮 ≤6、验收复审轮 ≤6——超限判 process-failed 停回（`quality.budgets` 报用量）。计数口径分两类：验收复审轮按 started 尝试计数（打回、失败、中断全部计入，跨 run 与手工路径累计不重置）；其余三项按签名事件计数（既有口径，environment/evidence 类不计轮）。尝试登记与查询走 `delivery-core loop-attempt` / `loop-budget`（记录文件 loop-attempts.jsonl，非签名事件）。
- **待办实体**（pending-actions）：善后 / 待恢复 / 待登记 / 待裁决 / 待复盘落盘，`next` 优先回答；中断恢复 = 读待办 + 合法转移，不依赖会话记忆。
- **交付义务与 revision 来源对账**：accepted 判定从「事件是否齐」扩展——`delivery-core obligations` 从验收断言 / 必需阶段 / 修复轮 / blocking 待办 / 外部契约能力派生义务清单（不建人工总表），必需义务无 open 才可 accepted（`explicitly-waived` 须绑用户裁决，豁免通道按义务类型映射现有命令）；其中 kind=runtime（外部契约运行可用性）义务不可豁免——`accept-risk` 与 `preauthorize-risk` 均不消化，满足形态 = 当前 revision 由 assurance 登记、`runtimeProbe=true` 且认领该契约能力的证据；`delivery-core revision-provenance` 只读派生候选形成后每次 revision 变化的来源，来源不明（unknown）的代际不得被后续保证覆盖、不得 accepted，恢复动作 = 补做合法修复登记 / 恢复已知基线 / 用户确认外部基线（`confirm-baseline` 命令，登记 RevisionBaselineConfirmed 事件接链）。
- **人工处置显式转移**：DAG 节点人工改判 done 的唯一合法通道 `node-transition --event manual-disposition --basis <依据> --task-dir <taskDir>`（自动登记待复盘待办）；禁止词表外事件与直改状态文件。
- **验证体系**：转移表静态校验 + 编排链已知答案样例 + golden 任务端到端（`scripts/tests/delivery-golden-v6.test.mjs`：正常流与预置缺陷流，断言拦截阶段/定级/轮次；agent 语义行为的 golden 需活跑，见 dev-flow-v6 题库分级）+ 历史任务回放（`delivery-core replay --task-dir`：真实事件序列对转移表的可表达性核验）+ 全量机制单测，全部进 CI。

内核命令组与逐裁决点命令见 `references/operations.md`（§0 内核命令组、§11 中断恢复）。

## 意图路由

| 用户意图 | 先读 | 执行 |
|----------|------|------|
| 设计并实现、修复 bug、开发功能 | `references/risk-routing.md`、`references/operations.md` | 完整主流程（①验收 → ②设计 → ③执行 → ①保证与裁决） |
| 只定义目标与验收 | `references/acceptance.md` | `acceptance-design-v6`；经用户批准后停止，不写代码 |
| 按已有目标与验收开发 | `references/operations.md` | 校验验收包后走 tech-design-v6（方案）→ dev-flow-v6（候选实现）→ 本技能保证与裁决 |
| 只验收已有实现 | `references/state-and-events.md`、`references/operations.md` | init 加 `--verification-only`（豁免方案包与 DesignApproved）；由 candidate-build-v6 承载只核验模式——builder 不改代码，逐增量核验在当前 revision 成立并登记当前实现记录（摘要带 `[verification-only]` 标注），再独立保证；禁止补写「当时实现完成」的旧事件 |
| 用户接受具体残余风险 | `references/state-and-events.md` | 确认用户明确指定风险后 `accept-risk`（单缺口缺省绑定 gapId，多缺口须 `--gap-id` 指定其一）→ evaluate。finding 类残余若在用户 `preauthorize-risk` 预授权范围内，可用 `--confirmation standing-authorization` 接受（见「收敛机制」节） |
| 查看当前能否交付 | `references/state-and-events.md` | 直接 evaluate，不重放旧证据 |
| 修改验收判据 | `references/acceptance.md` | 递增 acceptanceVersion 并重新审查与批准；相关旧证据失效 |

## 主流程（内核 next 驱动）

每次推进前 `delivery-core next --task-dir <taskDir>` 读当前五域状态、待办、合法转移与预算，按合法转移的 executor 执行；本节只列**裁决点**与不可省略的语义门，命令细节见 `references/operations.md`：

| 阶段 | 裁决点（停回用户） | 机器门（内核/gate） |
|------|--------------------|---------------------|
| init | 血统冲突走替换或独立声明 | init 血统检查；`--verification-only` 标记 |
| 验收设计 | **用户批准验收**（呈报目标/非目标/风险/覆盖对照） | 审查与机器校验双通过才可批准；批准即冻结（0444 + frozen 快照）；复审轮预算 ≤6 超限停回；声明 externalContracts 时增跑外部契约守门（候选探测与处置、essential 契约权威解析、capability 回溯与 mock-only 检查、契约冒烟增量），审查与批准绑定 authoritySnapshotSha256 |
| 方案 | **用户确认方案包** | record-design-approved 绑哈希清单；保证后修订按轮入预算 |
| 候选实现 | — | 入口门校验批准与 DesignApproved；schema 2 登记实现前必须已有当前 revision 探索（探索通道不要求实现先登记——转移表死锁防护）且 must-fix 清零 |
| 独立保证 | — | full/recheck/explore-only 三模式语义门；探索 due 与 open 集由内核单源判定 |
| 有限修复 | **预算耗尽停回**（perVersion >3 / 不同 must-fix >10 / 跨 run 保证 >6） | 轮次预判走内核 repair-budget；reopenOf 根去重；environment/evidence 不计轮 |
| 判定 | **风险接受逐项裁决** | 只有 evaluate 写 verdict；accepted / accepted_with_risk 才可交付；process-failed 不得作为成功交付；evaluate 前置机器核对：`obligations` 必需义务无 open、`revision-provenance` 无 unknown 来源代际、`loop-budget` 未超限、外部契约 runtime readiness 为 established / not-applicable 且环境历史链完好 |

收尾质量指标：交付终态确定后运行 `node ~/.agents/skills/delivery-v6/scripts/delivery-quality-stats.mjs <taskDir> --json` 输出 11 项交付质量指标（uniqueMustFix、repairRounds、findings、reopenedFindings、expectedStageAccuracy、escapedByStage、assuranceMustFixFirstRun、targetedReviewRate、finalExplorations、evidenceIntegrityFailures、stuckContinuationCount），呈报用户并存档。卡住续跑次数由主会话按 dev-flow 执行记录统计后经 `--stuck-continuation-count N` 传入。过程审查统计：taskDir 含 process-review.jsonl（dev-flow-v6 渐进式 review 的过程记录）时追加输出 processReview 字段，缺失不影响既有指标。终态报告：`node ~/.agents/skills/delivery-v6/scripts/generate-delivery-report.mjs --task-dir <taskDir> [--status-file <dev-flow status.json>] [--out <路径>]` 由权威记录（verdict.json / events.jsonl / loop-attempts.jsonl / self-repairs.jsonl / status.json / workflow 观测记录）机器生成分节报告（与 delivery-quality-stats 并列使用：前者面向用户的终态呈报，后者为质量指标数值）——数字与状态以报告文件为准，LLM 只做叙事解释；缺运行记录的项标 unknown，不按 0 或成功补齐，人工转述数字属违规。两项已知缺口登记：① 层间漏检阈值触发的检查规则修订提案不自动化——发现来源（origin）与预期阶段（expectedStage）分布已进 delivery-quality-stats 与终态报告，阈值人工判读；② 过程记录（process-review.jsonl）条目较 V4 设计建议精简（无输入快照哈希 / 三值分类 / 重开引用），条目级「过程发现漏出到末端」对照待实跑需要时再建。

## 任务目录、血统与凭据

- 任务目录按 projectRoot 分组：`~/.agents/skill-data/delivery/<分组 slug>/<taskId>/`。init 输出 projectRoot/worktree/siblingTasks/evalIdentity——init 前必须确认 `--project-root` 是本会话自己的 worktree；多会话同题环境每会话独立 worktree。
- 同 taskId 重复 init 默认拒绝：继续用 `--resume-existing`；新一轮用 `--new-round`（目录 `-r2/-r3` 递增）。
- **血统规则**：同一 git 仓库身份（gitdir/远端一致，覆盖全部 worktree）内 intent 哈希或验收包相同的未替换任务，必须走任务替换（继承未决发现）或由用户签署 `IndependentTaskDeclared`；口头声明独立无效。
- **凭据文件**：三把角色私钥写入 `~/.agents/skill-data/delivery-keys/<分组>/<任务id>/{builder,assurance,user}.key`（0600），init 只输出凭据 id（credentialId），不输出私钥。签名命令用 `--credential <credentialId>`；CLI 强制事件 actor 与凭据角色一致。user 凭据仅主会话使用，绝不注入子 agent 或 workflow；builder/assurance 凭据 id 可注入对应 workflow（非私钥本体）。凭据丢失走任务替换，不删除重建。

## Workflow 契约

| workflow | 输入 | 允许产出 | 明确不能产出 |
|----------|------|----------|--------------|
| `acceptance-design-v6` | projectRoot、taskDir、objective、assuranceCredentialId | 验收草稿、increments.json、AcceptanceReviewed | AcceptanceApproved、最终交付结论 |
| `candidate-build-v6` | projectRoot、taskDir、builderCredentialId、assuranceCredentialId | 代码、测试、候选反例审查、原始输出、ImplementationRecorded（带合并回执） | verified 证据、验收修订、最终交付结论 |
| `independent-assurance-v6` | projectRoot、taskDir、assuranceCredentialId、mode | 断言级覆盖结论、探索发现、证据与发现事件、逐增量测试回执 | 产品代码修改、验收修订、风险接受 |
| `assurance-repair-loop-v6` | projectRoot、taskDir、assuranceCredentialId、builderCredentialId、allowCommit、fixSuggestions? | 修复计划、产品代码与回归测试、RepairRoundRecorded、受影响复核、recheck 证据 | 验收修订、风险接受、user 凭据写入、未经提交授权的 Git 写 |

四个 workflow 均接收可选 `taskId/executionId/sampleType` 观测参数（同时传 `taskId` 与 `executionId` 启用；阶段边界逐行记 `~/.agents/skill-data/workflow-observability/<task-id>/<execution-id>.jsonl`，skill 字段恒 `delivery-v6`——契约与字段表见 dev-flow-v6 SKILL「阶段事件观测」节）。耗时与 token 统计：`node <zsw-skills 检出根>/scripts/skill-usage-stats.mjs --skill delivery-v6`（阶段窗口来自观测事件、token 经 `agent-session-reader usage` 双平台重算，口径详见该命令 `--help` 与 dev-flow-v6 SKILL「统计入口」节）。写事务租约：`candidate-build-v6`、`independent-assurance-v6` 与 `assurance-repair-loop-v6` 接收可选 `runId`（acquire/心跳/release 全程配对，事件登记命令带 `--run-id` 代次复核）；`acceptance-design-v6` 接收可选 `runId`（审查登记期间持有 projectRoot 级租约，任何出口释放）。zcode 用同名 saved workflow；pi 用上级 `workflows/pi/<name>.js`。两边都不可用时主会话可按相同职责手工执行，但事件与最终判定仍必须走 `delivery-gate`。

### 韧性加固（V6 代差异，v2 无此层）

三个 workflow 拼入韧性层（`workflows/src/resilience.shared.ts`，构建器按登记拼进产物），交付语义不变，执行侧多三道防线：

1. **agent 调用校验与修正重问（askGuarded）**：每次 agent 调用返回后立即做结构校验（各角色的期望 JSON 形态写在 prompt 尾部——首答即合法是正常路径）；结构非法、调用抛异常或该写的报告/证据文件缺失时，携修正提示（失败原因 + 期望结构）以完整自包含 prompt 重问一次（pi 无续聊，重问不依赖上一轮上下文）；两次尝试都失败才走原有终态。覆盖的调用点：designer、acceptance-reviewer、builder（含实现报告后验）、coverage-reviewer（含报告与证据文件后验）、explorer（含探索报告后验）。
2. **CLI 失败分类**：`delivery-gate` 只读/幂等命令（evaluate、revision、snapshot-policy、validate-acceptance）spawn 级失败（进程没起来/超时前未执行）自动重试一次；语义性失败（exit N>0）不自动重试——gate 报错自带恢复动作，workflow 按「修正提示」回喂下一轮（validate-acceptance 走 feedback 环）或按终态停回主 agent。**变更类命令（意图命令组、lease-*）不重试**：超时被杀时命令可能已写入，重试有重复写入风险。
3. **自修复记录与终态上报**：每次防线触发（修正重问 / 重试）逐条追加 `<taskDir>/self-repairs.jsonl`（字段：at、workflow、step、round、kind、target、trigger、outcome=recovered|exhausted）；终态 message 末尾携带汇总块（`自修复兜底被触发：共 N 条（kind 计数）`）——**主 agent 收到后必须向用户披露**，不允许静默修复。正常路径零触发、message 不带该块。

防御次序固定：prompt 写明返回结构（防呆）→ 结构校验 + 修正重问（兜底一）→ 原终态路径（兜底二，语义与 v2 完全一致）。兜底一被触发本身是可见事件（JSONL + 终态块），不是无声失败。

### 有限修复与证据语义

1. **逐项解决旧发现**：旧 must-fix 必须由 reviewer 逐项确认，并有能在缺陷版本失败的回归测试；不允许仅凭全量测试绿自动重新认领全部旧发现。`ResolutionReaffirmed` 只用于有明确原解决事件与本轮逐项复核依据的通道。
2. **风险预授权**：`preauthorize-risk` 与 `RiskPreauthorized` 保持既有安全边界——仅 finding 目标、severity 上限 non-blocker、名额有限且 user-explicit 登记；blocker 与 requirement 目标永不可预授权。
3. **三档处置**：must-fix 立即修复；suggestion 在 must-fix 清零后统一处理；info/boundary 逐项确认或按授权处置。非 must-fix 必须附 consequenceRefutation（不会发生 / 用户不可观察 / 验收明确允许，三择一并给依据），不能只按字面合规降级。
4. **有限结束**：`recheck` 不再默认开放探索。最后一批建议级修复后以 recheck 重新生成当前版本证据，解决「修复后版本变化使旧证据失效」与「最终必须重新取证」的冲突。
5. **过程失败**：实现性修复需要第 4 轮，或累计不同 must-fix 达到第 11 条，进入 `process-failed`；不得通过改名、错误合并、降低级别或递增验收版本规避。
6. **证据定位走统一内容索引**：统一内容索引 = evidence-bundle.json（dev-flow-v6 `gen-evidence-bundle.mjs` 生成的内容索引——原始记录与附属 artifact 的 path+sha256 清单，`--check` 可核，禁手改）；当前生成入口 = dev-flow-v6 验收阶段的手工路径（`dev-flow-v6/flow/acceptance.md` 证据内容索引条），独立保证 workflow（independent-assurance-v6）的自动消费接线属待实施项——接线落地前独立保证仍按事件与证据文件定位，缺记录、缺 artifact、skipped 未披露时不得按完整证据处理；原始步骤 pass/fail/skipped 不自动升格为 verified，交付判定仍走事件与 gate，本条不改变交付判定语义

## 密钥与信任边界

三对 Ed25519 密钥（公钥登记 task.json，私钥在凭据文件）：`builder`（只给 candidate-build-v6）、`assurance`（只给 independent-assurance-v6 与验收审查）、`user`（仅主会话，用于批准/风险接受/替换/基线/策略类命令）。凭据 id 与事件 actor 由 CLI 强制一致——builder 凭据签不出 assurance 事件。

本机信任边界：凭据机制防无凭据伪造、跨角色误写、审查省略；**防不了同一操作系统用户下的恶意进程**（可读凭据文件、改公钥、回滚事件流重签）。防线是用户独立复核：A 档重算复跑（重跑 evaluate 对哈希、复跑证据脚本——防部分篡改，防不了整体替换与语义造假）；B 档用户独立抽查产品行为（唯一能覆盖弱测试与审查放水的手段）。verdict 生成后哈希呈报用户在任务目录之外保存。

## 角色与写入权限

- designer：写验收草稿与方案辅助材料，不能自我批准。
- builder：改代码和测试、写实现报告与实现者自报发现，不能改验收、事件文件或 verdict。
- assurance：验收审查、读代码并运行验证、写独立证据与发现、确认 boundary（附对照论证），不能改产品代码或验收。
- 主 agent：呈现裁决点、以用户凭据登记批准或风险接受、调用裁决器；不能代替用户接受风险。
- 所有子 agent 禁止再派 agent、禁止 git 写，除非项目明确授权主 agent 在收尾提交。

## 强制约束

- [MANDATORY] 一个需求只有一份目标与验收与一个交付事务；实施分增量，证据随增量产生。
- [MANDATORY] 验收变化递增 acceptanceVersion 并重新审查与批准；代码/验收/验收资产变化后重算 revision 并重新取证。
- [MANDATORY] 批准绑验收包哈希、intent 哈希与策略快照——三者任一变化批准即失效；策略固定按任务内快照执行，升级走 `upgrade-policy` 并重新审查批准。
- [MANDATORY] `accepted_with_risk` 只能来自用户对具体缺口（gapId 绑定）的明确接受；boundary 类与 riskAcceptable=false 需求不接受风险。
- [MANDATORY] 产品长期价值与语义质量不能被自动化行为验证替代；需要时另做真实样本评估与投产观测。
- [OPTIONAL] 低风险小改可缩短设计与探索环节，但不能省略验收批准、独立保证和统一判定。

## 标记说明

| 标记 | 含义 | 修改约束 |
|------|------|----------|
| `[MANDATORY]` | 保持交付判定可信所必需的约束 | 必须严格遵守 |
| `[OPTIONAL]` | 按风险调整执行深度的建议 | 可裁剪流程成本，不改变证据语义 |

## 与归档代（v1 / v2 / v3）/ v4 的关系

v1 / v2 / v3 已归档（仓库根 `.archived/`，不入版本库），不再作为正式技能；v4 为质量传递线（冻结维护）。v5 在 v4 基础上落地交付事务内核（delivery-core）：五域转移表与静态校验、判定单源库（open 集/探索集/due/预算只此一份）、验收包写入防护（冻结 + open-revision + 篡改检测）、FindingRaised 定级护栏（boundary 禁令/后果论证强制/改判熔断）、循环预算三档（新增跨 run 保证 ≤6）、pending-actions 待办实体、节点人工处置显式转移。判定语义与 v4 兼容（schema 1/2 双轨不变）；新增事件 RevisionOpened、新增命令 open-revision 与内核命令组。v6 在 v5 基线上叠加三份设计：《三技能结构化优化设计》第二至五步（能力快照、D0 编译器、双索引、reviewer 种子定位）、《V5 交付完整性与语义可信性改造设计》六机制（判据判别力检查、证据环境与独立校验、交付义务与 revision 来源对账、循环尝试记录、缺陷族修复、派生产物与终态报告）与《V6 运行可用性与外部契约守门升级设计》（外部契约登记 externalContracts / externalContractReview、权威工件解析与环境历史链、kind=runtime 义务与真实环境 probe、契约冒烟增量），为现行开发代；v5 为冻结参照。7.0.0 bump 理由（数据契约变更）：事件词表 +2（ExternalAuthorityDeclared、EnvironmentBaselineConfirmed）、verdict 增 runtimeReadiness、obligations 增 kind=runtime、验收包 additive 两字段（externalContracts / externalContractReview）。迁移边界：升级前任务（task.json 无 deliveryProfile 元数据）与未声明 externalContracts 的验收包零新约束，外部契约全链仅在验收包声明该键后生效。
