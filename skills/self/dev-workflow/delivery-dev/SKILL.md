---
name: delivery-dev
# 技能版本唯一权威（手动 semver）。workflow 构建器读此值注入产物；改本行后必须重建
version: 2.6.0
description: >-
  Use when 用户说「设计并实现」「按目标与验收开发」「独立验收」「审查这次交付」「高风险功能开发」，
  需要把需求转为有证据支持的代码交付，或只完成其中的目标与验收设计、候选实现、独立保证。
  适合功能开发、架构改动和需要回归判据的 bug 修复。Not for 纯调研、只讨论方案不落产物、
  无行为判据的文档润色、用户明确要求跳过验证直接写代码、局部一行小修。
---

# delivery-dev（技能①：目标与验收·裁判）

三技能交付体系的裁判：定义什么算对 → 独立验证 → 唯一宣告交付。tech-design-dev（技能②设计）与
dev-flow-dev（技能③执行）在本体系内协作：②在已批准目标与验收的约束下推敲方案并登记方案包；
③按验收与方案产出候选实现；交付结论只由本技能的裁决器给出。

先按用户意图读对应文件再执行；不要在主会话凭记忆手写验收、事件或 `verdict.json`。

## 核心边界

1. **目标与验收先于并独立于方案**：acceptance.json 定义外部可观察的正确行为；方案可以换，验收不跟着方案改。
2. **实现完成不等于接受交付**：`implemented`、`contract-ready`、workflow `completed` 都是过程状态；技能③产出只是候选。
3. **唯一交付判定**：只有 `delivery-gate evaluate` 能写 `verdict.json`；自动和手工路径使用同一判据。
4. **独立保证**：由不参与实现的角色核对验收覆盖，并按风险进行探索性审查——主动寻找验收与测试遗漏。
5. **未知不等于通过**：`partial` 不是 `verified`；用户接受风险也不改写成已验证，缺口逐「需求×证据类型」判定。

## 意图路由

| 用户意图 | 先读 | 执行 |
|----------|------|------|
| 设计并实现、修复 bug、开发功能 | `references/risk-routing.md`、`references/operations.md` | 完整主流程（①验收 → ②设计 → ③执行 → ①保证与裁决） |
| 只定义目标与验收 | `references/acceptance.md` | `acceptance-design-dev`；经用户批准后停止，不写代码 |
| 按已有目标与验收开发 | `references/operations.md` | 校验验收包后走 tech-design-dev（方案）→ dev-flow-dev（候选实现）→ 本技能保证与裁决 |
| 只验收已有实现 | `references/state-and-events.md`、`references/operations.md` | init 加 `--verification-only`（豁免方案包与 DesignApproved）；由 candidate-build-dev 承载只核验模式——builder 不改代码，逐增量核验在当前 revision 成立并登记当前实现记录（摘要带 `[verification-only]` 标注），再独立保证；禁止补写「当时实现完成」的旧事件 |
| 用户接受具体残余风险 | `references/state-and-events.md` | 确认用户明确指定风险后 `accept-risk`（单缺口缺省绑定 gapId，多缺口须 `--gap-id` 指定其一）→ evaluate |
| 查看当前能否交付 | `references/state-and-events.md` | 直接 evaluate，不重放旧证据 |
| 修改验收判据 | `references/acceptance.md` | 递增 acceptanceVersion 并重新审查与批准；相关旧证据失效 |

## 主流程

1. `init`（可带 `--intent-file` 原始意图）：写 intent.md、生成凭据文件与公钥登记；血统检查——同 git 仓库身份下已存在同 intent 的未替换任务时，改走任务替换（`supersede-prepare`）或先 `declare-independent`。
2. 发起 `acceptance-design-dev`：固定策略快照（`snapshot-policy`）→ designer 起草 acceptance.json 与 increments.json → assurance 角色对照 intent.md 独立审查，审查与机器校验双通过后由 workflow 以 assurance 凭据登记 `AcceptanceReviewed`（`record-review --conclusion pass`）→ 产出草稿，不是直接批准。
3. 呈报关键目标、非目标、风险与相对原始意图的覆盖对照；用户明确批准后 `approve-acceptance`（批准绑验收包哈希、intent 哈希、策略快照哈希与通过审查的事件 id）。全托管授权用 `standing-authorization`。
4. tech-design-dev（技能②）产出完整方案包，用户确认后 `record-design-approved` 绑方案包哈希清单。
5. 候选实现两通道任选其一：内置 `candidate-build-dev`（入口门校验验收批准；非 `--verification-only` 任务还要求 DesignApproved——state=design 直接拒绝并指向 `record-design-approved`），或 dev-flow-dev（技能③）执行并在其 D4 收尾按 increments 逐增量以 builder 凭据登记 `ImplementationRecorded`（衔接定义见 dev-flow-dev 文档）；两通道的实现记录与合并回执口径一致。
6. 发起 `independent-assurance-dev`：coverage-reviewer 逐「需求×证据类型」取证并重跑全部增量测试（逐增量回执：命令、退出码、日志哈希、被测产物哈希），审查本轮测试是否被改弱；explorer 在覆盖清单冻结后按维度构造验收外反例；策略 `runsFromIgnoredArtifacts=true` 时取证来自干净构建（见 operations.md 第 5 节）；setup/finalize 比对 revision，漂移登记 `AssuranceRevisionDrift`，连续漂移链超上限进 `revision-unstable`（用户排查后 `confirm-baseline`）。
7. `evaluate`：按 state/missing/nextAction 决定回环（修实现 / 补证据 / 改验收 / 请用户逐项接受风险）。
8. 只有 `accepted` 或 `accepted_with_risk` 才能按对应口径交付；后者逐项披露用户接受的风险。verdict 哈希由用户在任务目录之外保存参照（A 档复核）。

## 任务目录、血统与凭据

- 任务目录按 projectRoot 分组：`~/.agents/skill-data/delivery/<分组 slug>/<taskId>/`。init 输出 projectRoot/worktree/siblingTasks/evalIdentity——init 前必须确认 `--project-root` 是本会话自己的 worktree；多会话同题环境每会话独立 worktree。
- 同 taskId 重复 init 默认拒绝：继续用 `--resume-existing`；新一轮用 `--new-round`（目录 `-r2/-r3` 递增）。
- **血统规则**：同一 git 仓库身份（gitdir/远端一致，覆盖全部 worktree）内 intent 哈希或验收包相同的未替换任务，必须走任务替换（继承未决发现）或由用户签署 `IndependentTaskDeclared`；口头声明独立无效。
- **凭据文件**：三把角色私钥写入 `~/.agents/skill-data/delivery-keys/<分组>/<任务id>/{builder,assurance,user}.key`（0600），init 只输出凭据 id（credentialId），不输出私钥。签名命令用 `--credential <credentialId>`；CLI 强制事件 actor 与凭据角色一致。user 凭据仅主会话使用，绝不注入子 agent 或 workflow；builder/assurance 凭据 id 可注入对应 workflow（非私钥本体）。凭据丢失走任务替换，不删除重建。

## Workflow 契约

| workflow | 输入 | 允许产出 | 明确不能产出 |
|----------|------|----------|--------------|
| `acceptance-design-dev` | projectRoot、taskDir、objective、assuranceCredentialId | 验收草稿、increments.json、AcceptanceReviewed | AcceptanceApproved、最终交付结论 |
| `candidate-build-dev` | projectRoot、taskDir、builderCredentialId | 代码、测试、原始输出、ImplementationRecorded（带合并回执） | verified 证据、验收修订、最终交付结论 |
| `independent-assurance-dev` | projectRoot、taskDir、assuranceCredentialId | 覆盖结论、探索发现、证据与发现事件、逐增量测试回执 | 产品代码修改、验收修订、风险接受 |

三个 workflow 均接收可选 `taskId/executionId/sampleType` 观测参数（同时传 `taskId` 与 `executionId` 启用；阶段边界逐行记 `~/.agents/skill-data/workflow-observability/<task-id>/<execution-id>.jsonl`，skill 字段恒 `delivery-dev`——契约与字段表见 dev-flow-dev SKILL「阶段事件观测」节）。耗时与 token 统计：`node <zsw-skills 检出根>/scripts/skill-usage-stats.mjs --skill delivery-dev`（阶段窗口来自观测事件、token 经 `agent-session-reader usage` 双平台重算，口径详见该命令 `--help` 与 dev-flow-dev SKILL「统计入口」节）。写事务租约：`candidate-build-dev` 与 `independent-assurance-dev` 接收可选 `runId`（acquire/心跳/release 全程配对，事件 append 带 `--run-id` 代次复核）；`acceptance-design-dev` 接收可选 `runId`（审查登记期间持有 projectRoot 级租约，任何出口释放）。zcode 用同名 saved workflow；pi 用上级 `workflows/pi/<name>.js`。两边都不可用时主会话可按相同职责手工执行，但事件与最终判定仍必须走 `delivery-gate`。

## 密钥与信任边界

三对 Ed25519 密钥（公钥登记 task.json，私钥在凭据文件）：`builder`（只给 candidate-build-dev）、`assurance`（只给 independent-assurance-dev 与验收审查）、`user`（仅主会话，用于批准/风险接受/替换/基线/策略类命令）。凭据 id 与事件 actor 由 CLI 强制一致——builder 凭据签不出 assurance 事件。

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

## 与 delivery-v1 / delivery-v2 的关系

v1 为冻结维护版（旧通道）；v2 是三技能体系稳定线的裁判技能。dev 是 v2 分叉的 DEV 加固线：裁决语义与 v2 完全一致（16 事件词表、判定式、验收包哈希、凭据文件、任务替换、漂移链、租约同构，事件与 verdict 双向兼容），差异集中在三个 workflow 的执行韧性——agent 调用结构校验与修正重问、CLI 失败修正提示、自修复记录（`self-repairs.jsonl`）与终态上报（见 Workflow 契约的韧性加固节）。
