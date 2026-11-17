# 裁决点与命令参考（内核 next 驱动 + 凭据 + 写入防护 + 租约）

「下一步做什么」的唯一回答者是内核：**先问 `delivery-core next`，再按合法转移的 executor 执行**——转移表（`scripts/kernel/rules.json`，五域：任务/节点/发现/探索/验收包）是流程唯一权威，本文只写裁决点、命令语义与角色权限。所有路径参数用绝对路径；`<...>` 是占位符。

```bash
node ~/.agents/skills/delivery-v5/scripts/delivery-core.mjs next --task-dir <taskDir> [--status-file <dev-flow status.json>]
```

`next` 输出顺序：**待办优先**（pending-actions 实体——中断恢复、善后、待登记、待裁决全部落盘，禁止只存在会话记忆里）→ 五域状态 → 合法转移（含执行器与角色）→ 预算（修复轮 perVersion ≤3、跨 run 保证 ≤6、不同 must-fix ≤10）→ machineChecks（schema2 / must-fix open / 探索 due）。

## 0. 内核命令组（delivery-core）

| 命令 | 用途 | 调用方 |
|------|------|--------|
| `validate` | 转移表静态校验（无环除回边/可达/执行器唯一/谓词与角色在词表）——改 rules.json 后必跑 | 主 agent / CI |
| `next` | 下一步唯一回答者（见上） | 主 agent |
| `pending add\|resolve\|list` | 脑内状态实体化：`--kind cleanup\|awaiting-restore\|awaiting-registration\|awaiting-ruling --note <一句话待办>` | 主 agent |
| `budget` | 循环预算查询（修复轮/跨 run/改判统计） | 主 agent / workflow |
| `open-findings` / `usable-explorations` / `exploration-due` / `repair-budget` | 判定单源 JSON 出口（唯一实现在 `scripts/lib/kernel-judgments.mjs`） | workflow（IA/ARL 经此消费，禁复刻） |
| `node-transition` | DAG 节点状态转移唯一判定（`--dry-run` 供引擎串行写链内先判后写；`manual-disposition --basis <依据>` 为人工处置唯一合法通道） | wave-executor-v5 / 主 agent |

**写入防护**：`approve-acceptance` 即冻结验收包（acceptance.json + increments.json chmod 0444 + `frozen/v<N>/` 快照）——非法改写在写入当秒被拒，漏网者在下次加载被篡改检测拦下。合法修订唯一通道：

```bash
node ~/.agents/skills/delivery-v5/scripts/delivery-gate.mjs open-revision \
  --task-dir <taskDir> --reason "修订理由" --credential <user credentialId>
```

**定级护栏**（FindingRaised 登记当时执行）：关联需求已有断言级判据明文覆盖的发现禁止归 boundary；non-blocker 必须附 consequenceRefutation（三类枚举）；同一条目（reopenOf 根）定级组合超过 2 种即熔断停回用户裁决。

## 1. 初始化（init：意图 + 凭据 + 血统）

init 前确认 `--project-root` 归属（本会话自己的项目/worktree）。stdout 含 `projectDir`、`worktree`、`siblingTasks`、`evalIdentity`（评测环境）。

```bash
node ~/.agents/skills/delivery-v5/scripts/delivery-gate.mjs init \
  --project-root <项目根> --task-id <任务id> [--intent-file <原始意图文件>] \
  [--verification-only] [--new-round | --resume-existing]
```

- stdout 输出：`taskDir`、`credentials`（三个 credentialId，形态 `<分组>/<任务id>/<角色>`）、`intentSha256` 与三把公钥。**私钥不输出**——已写入凭据目录 `~/.agents/skill-data/delivery-keys/<分组>/<任务id>/`（0600）。
- 血统规则：同 git 仓库身份下已存在同 intent 的未替换任务时 init 拒绝——走任务替换（第 8 节）或先 `declare-independent`。
- `--verification-only`：纳管体系外已有实现的只核验模式（豁免方案包与 DesignApproved）；由 candidate-build-v5 承载——builder 不改代码，逐增量核验在当前 revision 成立并登记实现记录。
- 意图未随 init 带入时，后续一次性写入：`set-intent --task-dir <taskDir> --file <意图文件>`（写入后不可修改——需要新意图 = 新任务）。

凭据传递边界：

| 凭据 | 持有 | 用途 | 注入边界 |
|------|------|------|----------|
| `builder` | 凭据文件 | candidate-build-v5 签 ImplementationRecorded/FindingRaised | builderCredentialId 可注入该 workflow |
| `assurance` | 凭据文件 | 验收审查、证据与发现、保证与探索事件 | assuranceCredentialId 可注入独立保证 workflow |
| `user` | 凭据文件 | 批准、风险接受、替换、基线、策略、解冻命令 | **仅主会话**；绝不注入任何子 agent 或 workflow |

## 2. 目标与验收设计与批准（裁决点：用户批准）

zcode：`CreateWorkflow saved: acceptance-design-v5`，args `{ projectRoot, taskDir, objective, assuranceCredentialId, taskId?, executionId?, sampleType?, runId? }`；pi：运行技能上级 `workflows/pi/acceptance-design-v5.js`。

workflow 完成 designer 起草 → assurance 独立审查 → 机器校验，双通过后以 assurance 凭据登记 `record-review --conclusion pass`（自动绑验收包/intent/快照哈希）。审查与校验语义、修订轮对照上一版草稿差异的机制见 workflow 契约（delivery-v5 SKILL「Workflow 契约」节）。**验收复审轮预算**：既有审查轮 + 本 run 轮次合计 ≤6，超限 workflow 停回用户裁决。

呈报关键目标、非目标、风险与覆盖对照，用户明确批准后：

```bash
node ~/.agents/skills/delivery-v5/scripts/delivery-gate.mjs approve-acceptance \
  --task-dir <taskDir> --confirmation user-explicit|standing-authorization \
  --summary "用户批准验收 vN 及验收要求" --credential <user credentialId>
```

批准自动绑最新通过的审查事件并**冻结验收包**（见第 0 节写入防护）。同组合后发的 reject 审查会使批准失效（回 draft 重新走审查）。修改验收判据必须：`open-revision` 解封 → 递增 acceptanceVersion 重新起草 → 重新审查与批准。只做设计的任务到批准即停止。

## 3. 方案确认（裁决点：用户确认方案包；技能②衔接）

tech-design-v5 产出完整方案包并经用户确认后：

```bash
node ~/.agents/skills/delivery-v5/scripts/delivery-gate.mjs record-design-approved \
  --task-dir <taskDir> --summary "方案包确认" \
  --package-file <方案包哈希清单 JSON：[{name, sha256}]> --credential <user credentialId>
```

方案包或验收版本变化后 DesignApproved 失效，需重新确认。注意：首次保证之后的方案修订按一轮并入修复预算（perVersion）。

## 4. 候选实现（技能③，两通道任选）

- `candidate-build-v5`：入口门校验验收批准；非 `--verification-only` 任务还要求 DesignApproved（state=design 直接拒绝，恢复动作指向 `record-design-approved`）。只核验任务由 builder 逐增量核验不改代码，实现摘要带 `[verification-only]` 标注。
- dev-flow-v5（技能③）：按验收与方案实现，其 D4 收尾按 increments 逐增量以 builder 凭据登记 `ImplementationRecorded`（衔接定义见 dev-flow-v5 文档），与 candidate-build-v5 的实现记录与合并回执口径一致。

builder 事件经 `append --credential <builder credentialId> [--run-id <runId>]` 登记（ImplementationRecorded 附合并回执：起始指纹=上一增量完成指纹或 setup 基线、合并后指纹、补丁哈希）。schema 2 任务登记实现的门禁：**当前 revision 必须已有候选探索**（explore-only 先行）且 must-fix 清零——探索通道不要求实现先登记（V4 死锁点的机器化否定，转移表 `implementing → candidate-explored`）。

## 5. 独立保证

zcode：`CreateWorkflow saved: independent-assurance-v5`，args `{ projectRoot, taskDir, assuranceCredentialId, mode?, taskId?, executionId?, sampleType?, runId? }`。前置：state 非 draft；除 explore-only 外增量齐。`full` = 覆盖核对 + 全量断言取证 + 开放探索；`recheck` = 旧发现与修复 diff 复核 + 受影响断言 + 全量确定性测试 + 历史探索引用，不默认重新开放探索；`explore-only` = D3 后、D4 前的候选反例审查，只写 ExplorationCompleted，不写 AssuranceCompleted。探索 due、可用探索集、open 发现集由 workflow 经 `delivery-core` 判定命令消费（单源纪律，不本地复刻）。setup/finalize 比对 revision；漂移登记 AssuranceRevisionDrift，链超上限进 revision-unstable。AssuranceCompleted 绑逐增量测试回执与证据/探索事件 id；full 必须引用当前 revision 探索，recheck 可引用同验收版本历史探索，但必须有当前 revision 的定向覆盖报告与全量确定性测试。

回执与 setup/finalize 使用的产物状态指纹口径与 `delivery-gate` 的 revision 计算一致，按任务策略快照 revision.json 的 mode 分两档：`auto-git`（普通模式）= git HEAD + tracked 修改（`git diff`）+ untracked 非 ignored 文件逐文件内容——builder 新增的未跟踪文件替换内容后指纹必变；`content-manifest` = 按项目根 `delivery-manifest.txt` 清单逐文件内容计算（输出 `manifest-` 前缀指纹），非 git 项目走该模式（`auto-git` 下非 git 目录无法计算 revision，链路走不通）。

策略快照 `runsFromIgnoredArtifacts=true`（policies/revision.json 随任务固定）时的执行语义：workflow 取证前生成干净构建（HEAD 导出 + 工作树补丁 + 非 ignored 新文件复制，不含 ignored 本地产物），逐增量测试在干净目录执行并统一绑 buildId，AssuranceCompleted 附 cleanBuild 记录——证明证据不依赖本机 ignored 产物；干净目录内测试失败（如需本机 ignored 依赖）会如实记入回执，裁决器按退出码判定保证无效。`mode=content-manifest` 时豁免干净构建：产物已纳入内容清单、变化即改变 revision 使旧证据失效，裁决器与 workflow 同判定。

## 6. 有限修复与统一判定（裁决点：预算停回）

实现缺陷统一走 `assurance-repair-loop-v5`，args `{ projectRoot, taskDir, assuranceCredentialId, builderCredentialId, allowCommit, fixSuggestions?, runId?, taskId?, executionId?, sampleType? }`。聚合节点给出来源阶段、受影响断言和回归测试，builder 修复并提交，独立 reviewer 做受影响一致性复核，最后以 recheck 完成当前版本取证。`allowCommit` 必须由主会话在确认 worktree 归属后显式传 true；禁止主会话裸补丁直提。

**预算三档**（超限即 `process-failed` 停回用户，不再补丁）：perVersion 修复轮 >3（behavior 轮 + 首次保证后的方案/验收修订；environment/evidence 重试不计轮）；不同 must-fix >10（reopenOf 根去重）；**跨 run 保证总轮 >6**（保证 run 次数 + perVersion 轮——跨 run「重取证→新发现→再修复」循环的机器上界）。轮次预判由 workflow 经 `delivery-core repair-budget` 查询（与 evaluate 同口径单源）。

- 设计冲突回 tech-design-v5，场景缺失回 T3，验收遗漏走第 2 节修订通道（open-revision → 递增版本重批）。
- 测试与场景不一致（测试未构造判据条件或断言更弱）：回 D2 三方对账 / 修测试，修复时必须证明该测试能在缺陷版本失败（回归测试口径同 `references/roles/repair-builder.md` 第 4 条）。
- 证据不足回 independent-assurance-v5；具体风险交用户逐项决定。

## 7. 统一判定与风险接受（裁决点：风险接受）

```bash
node ~/.agents/skills/delivery-v5/scripts/delivery-gate.mjs evaluate --task-dir <taskDir>
node ~/.agents/skills/delivery-v5/scripts/delivery-gate.mjs accept-risk \
  --task-dir <taskDir> --target-type requirement|finding --target-id <id> \
  --confirmation user-explicit --summary "接受 <具体风险、影响、恢复方式>" \
  --credential <user credentialId> [--gap-id <gapId>]
```

- accept-risk 缺口绑定：单缺口缺省自动绑定当前 gapId（missing 缺口为确定性派生 id；partial/failed 绑对应证据事件 id）；同一需求存在多个未接受缺口时必须 `--gap-id` 指定其一（缺省执行会列出全部候选 gapId）——多缺口不允许自动绑定，防登记项与用户批准项错位。boundary 类与 riskAcceptable=false 需求拒绝。
- 按 `nextAction` 处理；预算耗尽的 process-failed 带 `quality.budgets` 三档用量与停回指引。

## 8. 写事务租约（workflow run 级）

```bash
node ~/.agents/skills/delivery-v5/scripts/delivery-gate.mjs lease-acquire  --project-root <项目根> --run-id <runId>
node ~/.agents/skills/delivery-v5/scripts/delivery-gate.mjs lease-heartbeat --project-root <项目根> --run-id <runId>
node ~/.agents/skills/delivery-v5/scripts/delivery-gate.mjs lease-release --project-root <项目根> --run-id <runId>
```

失联租约被 acquire 接管时先按进程组终止旧进程树并递增代次；`append --run-id` 在事件锁临界区内复核租约持有者，非当前代次拒绝写入。

## 9. 任务替换与独立声明

凭据丢失或任务接管时，在新任务上发起（不依赖旧任务密钥；血统限同一 git 仓库身份）：

```bash
# prepare：绑前任身份（task.json/verdict/openFindings 哈希）并继承未决发现
supersede-prepare --task-dir <新任务> --predecessor-dir <前任> --summary S --credential <新任务 user>
# committed：对前任 task.json 比较后交换写入 supersededBy 标记（幂等可重放）
supersede-commit --task-dir <新任务> --summary S --credential <新任务 user>
# 恢复型取消：prepare 无法完成的出口——恢复任务签取消 + 自己的 prepare，被取消任务进入不可交付终态
supersede-cancel --task-dir <恢复任务> --cancelled-task-dir <被取消任务A> \
  --cancelled-prepare-event-id <A 的 prepare eventId> --reason S --summary S \
  --credential <恢复任务 user> [--transfer-marker]
# 独立任务声明：同仓库同 intent 想另起任务时的显式声明（绑 intent 哈希与未替换清单）
declare-independent --task-dir <既有任务> --credential <user>
```

## 10. 漂移基线与策略升级

```bash
confirm-baseline --task-dir <taskDir> --reason "排查结论" --credential <user> [--revision R]
upgrade-policy  --task-dir <taskDir> --invalidation-note "逐事件失效范围" --summary S --credential <user>
```

revision-unstable 排查完写入源后由用户确认新基线（漂移计数归零）。策略升级重写任务快照并要求重新审查与批准受影响的验收包。

## 11. 中断恢复与人工处置（显式转移，无手工通道）

恢复 = `delivery-core next` 读待办与合法转移，**不依赖会话记忆**：

1. 中断/善后/待登记事项在中断当下 `pending add` 落盘（kind 四类见第 0 节）；恢复后 `next` 优先回答待办。
2. workflow 不可用时按 next 给出的合法转移 executor 手工执行同一角色职责，事件仍走 CLI（`append --credential <对应角色>`；user 类命令走第 2/3/6/8/9 节高层命令）。每次恢复先 `evaluate` 读 verdict 与 nextAction；跨会话凭据按 task.json 的 credentialId 定位（evaluate 不需要私钥）。
3. DAG 节点的人工处置（blocked/failed/suspended → done）唯一合法通道 = `delivery-core node-transition --event manual-disposition --basis "<处置依据>"`——依据必填留痕；禁止直接编辑 status.json 或自造词表外事件。
