# 主 agent 操作序列（v2：凭据文件 + 验收包哈希 + 策略快照 + 任务替换 + 租约）

所有路径参数用绝对路径；不要把本机路径写进项目仓库。命令中的 `<...>` 是占位符。CLI 入口：

```bash
node ~/.agents/skills/delivery-v2/scripts/delivery-gate.mjs <command> ...
```

## 1. 初始化（init：意图 + 凭据 + 血统）

init 前确认 `--project-root` 归属（本会话自己的项目/worktree）。stdout 含 `projectRoot`、`worktree`、`siblingTasks`、`evalIdentity`（评测环境）。

```bash
node ~/.agents/skills/delivery-v2/scripts/delivery-gate.mjs init \
  --project-root <项目根> --task-id <任务id> [--intent-file <原始意图文件>] \
  [--verification-only] [--new-round | --resume-existing]
```

- stdout 输出：`taskDir`、`credentials`（三个 credentialId，形态 `<分组>/<任务id>/<角色>`）、`intentSha256` 与三把公钥。**私钥不输出**——已写入凭据目录 `~/.agents/skill-data/delivery-keys/<分组>/<任务id>/`（0600）。
- 血统规则：同 git 仓库身份下已存在同 intent 的未替换任务时 init 拒绝——走任务替换（第 8 节）或先 `declare-independent`。
- `--verification-only`：纳管体系外已有实现的只核验模式（豁免方案包与 DesignApproved）；由 candidate-build-v2 承载——builder 不改代码，逐增量核验在当前 revision 成立并登记实现记录。
- 意图未随 init 带入时，后续一次性写入：`set-intent --task-dir <taskDir> --file <意图文件>`（写入后不可修改——需要新意图 = 新任务）。

凭据传递边界：

| 凭据 | 持有 | 用途 | 注入边界 |
|------|------|------|----------|
| `builder` | 凭据文件 | candidate-build-v2 签 ImplementationRecorded/FindingRaised | builderCredentialId 可注入该 workflow |
| `assurance` | 凭据文件 | 验收审查、证据与发现、保证与探索事件 | assuranceCredentialId 可注入独立保证 workflow |
| `user` | 凭据文件 | 批准、风险接受、替换、基线、策略命令 | **仅主会话**；绝不注入任何子 agent 或 workflow |

## 2. 目标与验收设计与批准

zcode：`CreateWorkflow saved: acceptance-design-v2`，args `{ projectRoot, taskDir, objective, assuranceCredentialId, taskId?, executionId?, sampleType?, runId? }`；pi：运行技能上级 `workflows/pi/acceptance-design-v2.js`。

workflow 内完成：策略快照固定（`snapshot-policy`）→ designer 起草 acceptance.json + increments.json → assurance 对照 intent.md 独立审查（修订轮对照上一版草稿备份的完整差异）→ 机器校验；审查与校验双通过后由 workflow 以 assurance 凭据执行 `record-review --conclusion pass`（自动绑验收包哈希、intent 哈希、快照哈希——approve-acceptance 的审查前置由此满足），审查不通过则打回 designer 修订重审。呈报用户后批准：

```bash
node ~/.agents/skills/delivery-v2/scripts/delivery-gate.mjs approve-acceptance \
  --task-dir <taskDir> --confirmation user-explicit|standing-authorization \
  --summary "用户批准验收 vN 及验收要求" --credential <user credentialId>
```

批准自动绑最新通过的审查事件。同组合后发的 reject 审查会使批准失效（回 draft 重新走审查）。只做设计的任务到此停止。

## 3. 方案确认（技能② 衔接点）

tech-design-v2 产出完整方案包（设计文档目录 + 渲染视图 + impl-plan 双格式 + 审查终态）并经用户确认后：

```bash
node ~/.agents/skills/delivery-v2/scripts/delivery-gate.mjs record-design-approved \
  --task-dir <taskDir> --summary "方案包确认" \
  --package-file <方案包哈希清单 JSON：[{name, sha256}]> --credential <user credentialId>
```

方案包或验收版本变化后 DesignApproved 失效，需重新确认。

## 4. 候选实现（技能③，两通道任选）

- `candidate-build-v2`：入口门校验验收批准；非 `--verification-only` 任务还要求 DesignApproved（state=design 直接拒绝，恢复动作指向 `record-design-approved`）。只核验任务（init `--verification-only`）由 builder 逐增量核验不改代码，实现摘要带 `[verification-only]` 标注。
- dev-flow-v2（技能③）：按验收与方案实现，其 D4 收尾按 increments 逐增量以 builder 凭据登记 `ImplementationRecorded`（衔接定义见 dev-flow-v2 文档），与 candidate-build-v2 的实现记录与合并回执口径一致。

builder 事件经 `append --credential <builder credentialId> [--run-id <runId>]` 登记（ImplementationRecorded 附合并回执：起始指纹=上一增量完成指纹或 setup 基线、合并后指纹、补丁哈希）。

## 5. 独立保证

zcode：`CreateWorkflow saved: independent-assurance-v2`，args `{ projectRoot, taskDir, assuranceCredentialId, taskId?, executionId?, sampleType?, runId? }`。前置：state 非 draft、增量齐（candidate-build-v2 或 dev-flow-v2 D4 登记实现皆可）。两阶段串行：coverage-reviewer 先行取证并落盘冻结覆盖清单，explorer 拿到清单后探索。setup/finalize 比对 revision；漂移登记 AssuranceRevisionDrift（driftSeq 按事件流既有漂移数递增），链超上限进 revision-unstable。AssuranceCompleted 绑逐增量测试回执（命令、退出码、日志哈希、cwd、被测产物哈希——与日志哈希来源不同，防「构建 A 测 B」）与证据/探索事件 id——防跨 run 拼接。

回执与 setup/finalize 使用的产物状态指纹口径与 `delivery-gate` 的 revision 计算一致，按任务策略快照 revision.json 的 mode 分两档：`auto-git`（普通模式）= git HEAD + tracked 修改（`git diff`）+ untracked 非 ignored 文件逐文件内容——builder 新增的未跟踪文件替换内容后指纹必变；`content-manifest` = 按项目根 `delivery-manifest.txt` 清单逐文件内容计算（输出 `manifest-` 前缀指纹），非 git 项目走该模式（`auto-git` 下非 git 目录无法计算 revision，链路走不通）。

策略快照 `runsFromIgnoredArtifacts=true`（policies/revision.json 随任务固定）时的执行语义：workflow 取证前生成干净构建（HEAD 导出 + 工作树补丁 + 非 ignored 新文件复制，不含 ignored 本地产物），逐增量测试在干净目录执行并统一绑 buildId，AssuranceCompleted 附 cleanBuild 记录——证明证据不依赖本机 ignored 产物；干净目录内测试失败（如需本机 ignored 依赖）会如实记入回执，裁决器按退出码判定保证无效。`mode=content-manifest` 时豁免干净构建：产物已纳入内容清单、变化即改变 revision 使旧证据失效，裁决器与 workflow 同判定。

## 6. 统一判定与风险接受

```bash
node ~/.agents/skills/delivery-v2/scripts/delivery-gate.mjs evaluate --task-dir <taskDir>
node ~/.agents/skills/delivery-v2/scripts/delivery-gate.mjs accept-risk \
  --task-dir <taskDir> --target-type requirement|finding --target-id <id> \
  --confirmation user-explicit --summary "接受 <具体风险、影响、恢复方式>" \
  --credential <user credentialId> [--gap-id <gapId>]
```

- accept-risk 缺口绑定：单缺口缺省自动绑定当前 gapId（missing 缺口为确定性派生 id；partial/failed 绑对应证据事件 id）；同一需求存在多个未接受缺口时必须 `--gap-id` 指定其一（缺省执行会列出全部候选 gapId）——多缺口不允许自动绑定，防登记项与用户批准项错位。boundary 类与 riskAcceptable=false 需求拒绝。
- 按 `nextAction` 处理：实现缺陷回技能③；验收遗漏递增版本回审查；证据不足回独立保证；具体风险交用户逐项决定。

## 7. 写事务租约（workflow run 级）

```bash
node ~/.agents/skills/delivery-v2/scripts/delivery-gate.mjs lease-acquire  --project-root <项目根> --run-id <runId>
node ~/.agents/skills/delivery-v2/scripts/delivery-gate.mjs lease-heartbeat --project-root <项目根> --run-id <runId>
node ~/.agents/skills/delivery-v2/scripts/delivery-gate.mjs lease-release  --project-root <项目根> --run-id <runId>
```

失联租约被 acquire 接管时先按进程组终止旧进程树并递增代次；`append --run-id` 在事件锁临界区内复核租约持有者，非当前代次拒绝写入。

## 8. 任务替换与独立声明

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

## 9. 漂移基线与策略升级

```bash
confirm-baseline --task-dir <taskDir> --reason "排查结论" --credential <user> [--revision R]
upgrade-policy  --task-dir <taskDir> --invalidation-note "逐事件失效范围" --summary S --credential <user>
```

revision-unstable 排查完写入源后由用户确认新基线（漂移计数归零）。策略升级重写任务快照并要求重新审查与批准受影响的验收包。

## 10. 手工与恢复

workflow 不可用时主会话按同一角色职责手工执行，事件仍走 CLI（`append --credential <对应角色>`；user 类命令走第 2/6/8/9 节高层命令）。每次恢复先 `evaluate` 读 verdict 与 nextAction，不根据聊天记忆补状态；跨会话凭据按 task.json 的 credentialId 定位（evaluate 不需要私钥）。
