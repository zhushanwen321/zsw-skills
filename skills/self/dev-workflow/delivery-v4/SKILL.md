---
name: delivery-v4
# 技能版本唯一权威（手动 semver）。workflow 构建器读此值注入产物；改本行后必须重建
version: 4.0.0
description: >-
  Use when 用户说「设计并实现」「按目标与验收开发」「独立验收」「审查这次交付」「高风险功能开发」，
  需要把需求转为有证据支持的代码交付，或只完成其中的目标与验收设计、候选实现、独立保证。
  适合功能开发、架构改动和需要回归判据的 bug 修复。Not for 纯调研、只讨论方案不落产物、
  无行为判据的文档润色、用户明确要求跳过验证直接写代码、局部一行小修。
---

# delivery-v4（技能①：目标与验收·裁判）

三技能交付体系的裁判：定义什么算对 → 独立验证 → 唯一宣告交付。tech-design-v4（技能②设计）与
dev-flow-v4（技能③执行）在本体系内协作：②在已批准目标与验收的约束下推敲方案并登记方案包；
③按验收与方案产出候选实现；交付结论只由本技能的裁决器给出。

先按用户意图读对应文件再执行；不要在主会话凭记忆手写验收、事件或 `verdict.json`。

## 核心边界

1. **目标与验收先于并独立于方案**：acceptance.json 定义外部可观察的正确行为；方案可以换，验收不跟着方案改。
2. **实现完成不等于接受交付**：`implemented`、`contract-ready`、workflow `completed` 都是过程状态；技能③产出只是候选。
3. **唯一交付判定**：只有 `delivery-gate evaluate` 能写 `verdict.json`；自动和手工路径使用同一判据。
4. **独立保证**：由不参与实现的角色核对验收覆盖，并按风险进行探索性审查——主动寻找验收与测试遗漏。
5. **未知不等于通过**：`partial` 不是 `verified`；用户接受风险也不改写成已验证。schema 2 缺口逐「断言×证据类型」判定，schema 1 保持「需求×证据类型」兼容语义。

## 意图路由

| 用户意图 | 先读 | 执行 |
|----------|------|------|
| 设计并实现、修复 bug、开发功能 | `references/risk-routing.md`、`references/operations.md` | 完整主流程（①验收 → ②设计 → ③执行 → ①保证与裁决） |
| 只定义目标与验收 | `references/acceptance.md` | `acceptance-design-v4`；经用户批准后停止，不写代码 |
| 按已有目标与验收开发 | `references/operations.md` | 校验验收包后走 tech-design-v4（方案）→ dev-flow-v4（候选实现）→ 本技能保证与裁决 |
| 只验收已有实现 | `references/state-and-events.md`、`references/operations.md` | init 加 `--verification-only`（豁免方案包与 DesignApproved）；由 candidate-build-v4 承载只核验模式——builder 不改代码，逐增量核验在当前 revision 成立并登记当前实现记录（摘要带 `[verification-only]` 标注），再独立保证；禁止补写「当时实现完成」的旧事件 |
| 用户接受具体残余风险 | `references/state-and-events.md` | 确认用户明确指定风险后 `accept-risk`（单缺口缺省绑定 gapId，多缺口须 `--gap-id` 指定其一）→ evaluate。finding 类残余若在用户 `preauthorize-risk` 预授权范围内，可用 `--confirmation standing-authorization` 接受（见「收敛机制」节） |
| 查看当前能否交付 | `references/state-and-events.md` | 直接 evaluate，不重放旧证据 |
| 修改验收判据 | `references/acceptance.md` | 递增 acceptanceVersion 并重新审查与批准；相关旧证据失效 |

## 主流程

1. `init`（可带 `--intent-file` 原始意图）：写 intent.md、生成凭据文件与公钥登记；血统检查——同 git 仓库身份下已存在同 intent 的未替换任务时，改走任务替换（`supersede-prepare`）或先 `declare-independent`。
2. 发起 `acceptance-design-v4`：固定策略快照（`snapshot-policy`）→ designer 起草 schema 2 验收包（requirements[].assertions + 顶层 adversarialForms）与 increments.json → assurance 角色对照 intent.md 独立审查每个限定条件是否有可构造反例场景，审查与机器校验双通过后登记 `AcceptanceReviewed` → 产出草稿，不是直接批准。
3. 呈报关键目标、非目标、风险与相对原始意图的覆盖对照；用户明确批准后 `approve-acceptance`（批准绑验收包哈希、intent 哈希、策略快照哈希与通过审查的事件 id）。全托管授权用 `standing-authorization`。
4. tech-design-v4（技能②）产出完整方案包，用户确认后 `record-design-approved` 绑方案包哈希清单。
5. 候选实现两通道任选其一：内置 `candidate-build-v4`（入口门校验验收批准；非 `--verification-only` 任务还要求 DesignApproved——state=design 直接拒绝并指向 `record-design-approved`），或 dev-flow-v4（技能③）执行并在其 D4 收尾按 increments 逐增量以 builder 凭据登记 `ImplementationRecorded`（衔接定义见 dev-flow-v4 文档）；两通道的实现记录与合并回执口径一致。
6. 发起 `independent-assurance-v4`：schema 2 逐「断言×证据类型」取证并重跑全部增量测试。`full` 执行完整覆盖与开放探索；`recheck` 只复核旧发现、修复 diff 与受影响断言，重跑全量确定性测试并引用历史探索；`explore-only` 在 D3 后、D4 前攻击候选实现。证据路径按运行隔离且禁止覆盖，setup/finalize 比对 revision，漂移按既有规则处理。
7. 实现性修复统一发起 `assurance-repair-loop-v4`：独立聚合给出来源阶段、受影响断言和回归测试，builder 修复，独立 reviewer 做受影响一致性复核，最后以 recheck 完成当前版本取证。主会话确认 worktree 归属后显式传 `allowCommit=true`，禁止裸补丁直提。需要第 4 轮实现性修复或出现第 11 条不同 must-fix 时，裁决器进入 `process-failed`；同一问题 `reopenOf` 不重复计数，环境与证据采集重试不计轮。
8. `evaluate`：按 state/missing/nextAction 决定补证据、回设计、回实现、接受具体风险或停止过程失败。最后一批建议级修复后以 recheck 完成当前版本取证，不重新开放探索。只有 `accepted` 或 `accepted_with_risk` 才能按对应口径交付；`process-failed` 不得作为成功交付。

## 任务目录、血统与凭据

- 任务目录按 projectRoot 分组：`~/.agents/skill-data/delivery/<分组 slug>/<taskId>/`。init 输出 projectRoot/worktree/siblingTasks/evalIdentity——init 前必须确认 `--project-root` 是本会话自己的 worktree；多会话同题环境每会话独立 worktree。
- 同 taskId 重复 init 默认拒绝：继续用 `--resume-existing`；新一轮用 `--new-round`（目录 `-r2/-r3` 递增）。
- **血统规则**：同一 git 仓库身份（gitdir/远端一致，覆盖全部 worktree）内 intent 哈希或验收包相同的未替换任务，必须走任务替换（继承未决发现）或由用户签署 `IndependentTaskDeclared`；口头声明独立无效。
- **凭据文件**：三把角色私钥写入 `~/.agents/skill-data/delivery-keys/<分组>/<任务id>/{builder,assurance,user}.key`（0600），init 只输出凭据 id（credentialId），不输出私钥。签名命令用 `--credential <credentialId>`；CLI 强制事件 actor 与凭据角色一致。user 凭据仅主会话使用，绝不注入子 agent 或 workflow；builder/assurance 凭据 id 可注入对应 workflow（非私钥本体）。凭据丢失走任务替换，不删除重建。

## Workflow 契约

| workflow | 输入 | 允许产出 | 明确不能产出 |
|----------|------|----------|--------------|
| `acceptance-design-v4` | projectRoot、taskDir、objective、assuranceCredentialId | 验收草稿、increments.json、AcceptanceReviewed | AcceptanceApproved、最终交付结论 |
| `candidate-build-v4` | projectRoot、taskDir、builderCredentialId、assuranceCredentialId | 代码、测试、候选反例审查、原始输出、ImplementationRecorded（带合并回执） | verified 证据、验收修订、最终交付结论 |
| `independent-assurance-v4` | projectRoot、taskDir、assuranceCredentialId、mode | 断言级覆盖结论、探索发现、证据与发现事件、逐增量测试回执 | 产品代码修改、验收修订、风险接受 |
| `assurance-repair-loop-v4` | projectRoot、taskDir、assuranceCredentialId、builderCredentialId、allowCommit、fixSuggestions? | 修复计划、产品代码与回归测试、RepairRoundRecorded、受影响复核、recheck 证据 | 验收修订、风险接受、user 凭据写入、未经提交授权的 Git 写 |

四个 workflow 均接收可选 `taskId/executionId/sampleType` 观测参数（同时传 `taskId` 与 `executionId` 启用；阶段边界逐行记 `~/.agents/skill-data/workflow-observability/<task-id>/<execution-id>.jsonl`，skill 字段恒 `delivery-v4`——契约与字段表见 dev-flow-v4 SKILL「阶段事件观测」节）。耗时与 token 统计：`node <zsw-skills 检出根>/scripts/skill-usage-stats.mjs --skill delivery-v4`（阶段窗口来自观测事件、token 经 `agent-session-reader usage` 双平台重算，口径详见该命令 `--help` 与 dev-flow-v4 SKILL「统计入口」节）。写事务租约：`candidate-build-v4`、`independent-assurance-v4` 与 `assurance-repair-loop-v4` 接收可选 `runId`（acquire/心跳/release 全程配对，事件 append 带 `--run-id` 代次复核）；`acceptance-design-v4` 接收可选 `runId`（审查登记期间持有 projectRoot 级租约，任何出口释放）。zcode 用同名 saved workflow；pi 用上级 `workflows/pi/<name>.js`。两边都不可用时主会话可按相同职责手工执行，但事件与最终判定仍必须走 `delivery-gate`。

### 韧性加固（V4 代差异，v2 无此层）

三个 workflow 拼入韧性层（`workflows/src/resilience.shared.ts`，构建器按登记拼进产物），交付语义不变，执行侧多三道防线：

1. **agent 调用校验与修正重问（askGuarded）**：每次 agent 调用返回后立即做结构校验（各角色的期望 JSON 形态写在 prompt 尾部——首答即合法是正常路径）；结构非法、调用抛异常或该写的报告/证据文件缺失时，携修正提示（失败原因 + 期望结构）以完整自包含 prompt 重问一次（pi 无续聊，重问不依赖上一轮上下文）；两次尝试都失败才走原有终态。覆盖的调用点：designer、acceptance-reviewer、builder（含实现报告后验）、coverage-reviewer（含报告与证据文件后验）、explorer（含探索报告后验）。
2. **CLI 失败分类**：`delivery-gate` 只读/幂等命令（evaluate、revision、snapshot-policy、validate-acceptance）spawn 级失败（进程没起来/超时前未执行）自动重试一次；语义性失败（exit N>0）不自动重试——gate 报错自带恢复动作，workflow 按「修正提示」回喂下一轮（validate-acceptance 走 feedback 环）或按终态停回主 agent。**变更类命令（append、lease-*）不重试**：超时被杀时命令可能已写入，重试有重复写入风险。
3. **自修复记录与终态上报**：每次防线触发（修正重问 / 重试）逐条追加 `<taskDir>/self-repairs.jsonl`（字段：at、workflow、step、round、kind、target、trigger、outcome=recovered|exhausted）；终态 message 末尾携带汇总块（`自修复兜底被触发：共 N 条（kind 计数）`）——**主 agent 收到后必须向用户披露**，不允许静默修复。正常路径零触发、message 不带该块。

防御次序固定：prompt 写明返回结构（防呆）→ 结构校验 + 修正重问（兜底一）→ 原终态路径（兜底二，语义与 v2 完全一致）。兜底一被触发本身是可见事件（JSONL + 终态块），不是无声失败。

### 有限修复与证据语义

1. **逐项解决旧发现**：旧 must-fix 必须由 reviewer 逐项确认，并有能在缺陷版本失败的回归测试；不允许仅凭全量测试绿自动重新认领全部旧发现。`ResolutionReaffirmed` 只用于有明确原解决事件与本轮逐项复核依据的通道。
2. **风险预授权**：`preauthorize-risk` 与 `RiskPreauthorized` 保持既有安全边界——仅 finding 目标、severity 上限 non-blocker、名额有限且 user-explicit 登记；blocker 与 requirement 目标永不可预授权。
3. **三档处置**：must-fix 立即修复；suggestion 在 must-fix 清零后统一处理；info/boundary 逐项确认或按授权处置。非 must-fix 必须附 consequenceRefutation（不会发生 / 用户不可观察 / 验收明确允许，三择一并给依据），不能只按字面合规降级。
4. **有限结束**：`recheck` 不再默认开放探索。最后一批建议级修复后以 recheck 重新生成当前版本证据，解决「修复后版本变化使旧证据失效」与「最终必须重新取证」的冲突。
5. **过程失败**：实现性修复需要第 4 轮，或累计不同 must-fix 达到第 11 条，进入 `process-failed`；不得通过改名、错误合并、降低级别或递增验收版本规避。

## 密钥与信任边界

三对 Ed25519 密钥（公钥登记 task.json，私钥在凭据文件）：`builder`（只给 candidate-build-v4）、`assurance`（只给 independent-assurance-v4 与验收审查）、`user`（仅主会话，用于批准/风险接受/替换/基线/策略类命令）。凭据 id 与事件 actor 由 CLI 强制一致——builder 凭据签不出 assurance 事件。

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

## 与 delivery-v1 / delivery-v2 / delivery-dev / delivery-v3 的关系

v1 为冻结维护版，v2 为稳定线，dev 为加固线，v3 为 dev 的基线复制版。v4 在 v3 基础上增加质量传递与有限修复：schema 2 验收断言与反例场景、断言级裁决、判据与机制对账、候选反例审查、full/recheck 双模式、受控修复循环和 process-failed。schema 1 任务继续按 v3 判定式执行；新增事件字段均为可选扩展，旧版本不消费这些字段。
