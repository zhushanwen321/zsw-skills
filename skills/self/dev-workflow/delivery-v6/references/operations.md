# 裁决点与命令参考（内核 next 驱动 + 凭据 + 写入防护 + 租约）

「下一步做什么」的唯一回答者是内核：**先问 `delivery-core next`，再按合法转移的 executor 执行**——转移表（`scripts/kernel/rules.json`，五域：任务/节点/发现/探索/验收包）是流程唯一权威，本文只写裁决点、命令语义与角色权限。所有路径参数用绝对路径；`<...>` 是占位符。事件登记的 artifact 路径另有形态约定（见 §0 末段）：必须在 taskDir 的 evidence/ 内，相对路径以 taskDir 为基准，绝对路径与 symlink 逃逸一律拒。

并发登记同一任务目录的事件时，gate 以任务级事件锁（`.events.lock`）串行化写入：等待上限 30 秒、锁龄超 30 秒视为陈旧可被抢占（死 pid 锁同样可抢），抢占时 stderr 会告知；不要绕过锁直接写 events.jsonl。

```bash
node ~/.agents/skills/delivery-v6/scripts/delivery-core.mjs next --task-dir <taskDir> [--status-file <dev-flow status.json>]
```

`next` 输出顺序：**待办优先**（pending-actions 实体——中断恢复、善后、待登记、待裁决全部落盘，禁止只存在会话记忆里）→ 五域状态 → 合法转移（含执行器与角色）→ 预算（修复轮 perVersion ≤3、跨 run 保证 ≤6、不同 must-fix ≤10）→ machineChecks（schema2 / must-fix open / 探索 due）。

## 0. 内核命令组（delivery-core）

| 命令 | 用途 | 调用方 |
|------|------|--------|
| `validate` | 转移表静态校验（无环除回边/可达/执行器唯一/谓词与角色在词表/写入矩阵词表闭包）——改 rules.json 后必跑 | 主 agent / CI |
| `next [--auto]` | 下一步唯一回答者（见上）；转移带 kind 分类（裁决点 / workflow 附预填发起规格 / gate 命令），`--auto` 自动执行 evaluate 类例行转移 | 主 agent |
| `pending add\|resolve\|list` | 脑内状态实体化：`--kind cleanup\|awaiting-restore\|awaiting-registration\|awaiting-ruling\|awaiting-review --note <一句话待办>` | 主 agent |
| `budget` | 循环预算查询（修复轮/跨 run/改判统计） | 主 agent / workflow |
| `open-findings` / `usable-explorations` / `exploration-due` / `repair-budget` | 判定单源 JSON 出口（唯一实现在 `scripts/lib/kernel-judgments.mjs`） | workflow（IA/ARL 经此消费，禁复刻） |
| `node-transition` | DAG 节点状态转移唯一判定（`--dry-run` 供引擎串行写链内先判后写；`manual-disposition --basis <依据> --task-dir <taskDir>` 为人工处置唯一合法通道，自动登记待复盘待办） | wave-executor-v6 / 主 agent |
| `node-project [--write]` | status.json 派生视图：从 status.events 按事件重新推算节点状态、比对在盘 nodes（绕过转移入口的改动被检出）；`--write` 以事件恢复 | 主 agent / 断点恢复 |
| `loop-attempt` | 循环尝试登记：进入循环即追加 `started`，退出补 `finished --outcome passed\|rejected\|failed\|interrupted`（追加写任务目录 loop-attempts.jsonl；attemptKey = runId:round 幂等去重，崩溃重放不重复计数；打回、校验失败、中断全部计入） | workflow / 主 agent |
| `loop-budget` | 循环尝试预算查询：按 `started` 计数（不读结果事件）对照各循环上限，输出用量与剩余；超限即停回判 process-failed | workflow / 主 agent |
| `revision-provenance` | revision 来源对账（只读派生）：候选形成后每次 revision 变化的来源（source + 事件引用 + actor）；无法推断来源的代际标 unknown | 主 agent / gate |
| `obligations` | 交付义务清单派生（只读）：从验收断言 / 必需阶段 / 修复轮 / blocking 待办 / 外部契约能力派生 `{id, kind: assertion\|stage\|repair\|pending\|asset\|runtime, state: open\|satisfied\|explicitly-waived}`（runtime 无 explicitly-waived；asset 待实现——依赖用户资产声明通道）；不新增人工总表 | 主 agent / workflow |
| `events [--domain D]` | 事件时间线读侧合流：交付事件（domain 章）+ 过程记录（process 域）统一输出 | 主 agent / 复盘 |
| `replay` | 历史任务回放：真实事件序列对转移表的可表达性核验（不可表达即建模缺口或词表外操作） | 主 agent / 内核演进 |

**判定单源的消费通道**：gate 与内核同进程 import kernel-judgments；workflow 经内核 CLI 的 JSON 子命令消费——zcode/pi workflow 产物禁模块 import（平台约束），CLI 通道保持判定随技能更新即时生效且 artifact 哈希校验不分叉，单实现不受影响。

**事件意图提交**（执行器事件唯一通道，`append` 已退役）：`record-implementation` / `record-repair-round` / `record-finding` / `resolve-finding` / `reaffirm-resolution` / `record-evidence` / `record-exploration` / `complete-assurance` / `record-assurance-drift`——信封（actor/revision/acceptanceVersion/domain/artifactSha256）由 gate 构造；`--revision` 显式锁定保证 run 在途的 setup revision；写入矩阵「角色 × 当前阶段 × 目标域」与 domain 章在写入当刻执行。主会话命令（批准/风险接受/替换等）见 `delivery-gate.mjs help`。additive 可选参数：`record-finding` 带 `--contract-capability-ids '<JSON>'` 与 authority 组（`--authority-backed true --authority-hash H --authority-observation-ref R`）——结构命中外部契约（contractCapabilityIds 非空，或 requirementIds 反查到的断言含 requiredEnvironment.capability）时 authority 组必填；`record-evidence` 带 `--contract-capability-ids '<JSON>'` 认领契约能力，`--runtime-probe` 标记真实 runner / 宿主驱动产生的 runtime probe 证据（runtime 义务唯一可满足形态）。artifact 路径形态：必须位于 `<taskDir>/evidence/` 内（相对路径以 taskDir 为基准解析，也接受在该目录内的绝对路径）；目录外路径、`..` 越界与 symlink 逃逸一律拒绝（恢复动作 = 把报告/证据移入 evidence/ 后重登）。

**写入防护**：`approve-acceptance` 即冻结验收包（acceptance.json + increments.json chmod 0444 + `frozen/v<N>/` 快照）——非法改写在写入当秒被拒，漏网者在下次加载被篡改检测拦下。合法修订唯一通道：

```bash
node ~/.agents/skills/delivery-v6/scripts/delivery-gate.mjs open-revision \
  --task-dir <taskDir> --reason "修订理由" --credential <user credentialId>
```

**定级护栏**（新写入当时执行；历史记录违规在加载折算时留档 guardrailWarnings，不阻塞旧任务目录读取）：关联需求已有断言级判据明文覆盖的发现禁止归 boundary；schema 2 下 `category=boundary` 且 `requirementIds=[]`（空关联）的发现必须附 `--empty-scope-refutation "<不影响任何需求的论证>"`——空关联不得成为绕过定级护栏的通道（GLM F-5 实证），未附即拒绝写入，恢复动作三选一：补充论证重登 / 关联对应需求 id 重登 / 走 `open-revision` 修订验收；non-blocker 必须附 consequenceRefutation（三类枚举）；同一条目（reopenOf 根）定级组合超过 2 种即熔断停回用户裁决；T2 聚合分级与 D2 聚合定性的改判必附理由留痕，连续改判达上限停回（aggregateRegradeHalt）。

**循环尝试记录**（workflow 与手工路径同一记录，只追加不回写历史行）：

```bash
node ~/.agents/skills/delivery-v6/scripts/delivery-core.mjs loop-attempt \
  --task-dir <taskDir> --loop acceptance-review --event started \
  --run-id <runId> --round <本地轮次> --path workflow|manual [--input-hash <输入哈希>]
# finished 事件必须带 --outcome passed|rejected|failed|interrupted；started 不携带结果
node ~/.agents/skills/delivery-v6/scripts/delivery-core.mjs loop-budget \
  --task-dir <taskDir> --loop acceptance-review
```

预算语义 = 按 `started` 计数（结果事件不作工作量依据）：进入循环即计数，打回、校验失败、designer 失败、整次重发与中断全部计入；跨 run、跨 workflow 与手工路径累计，重开 run 不重置。恢复时按 attemptKey + event 去重，同一尝试的完成事件不增加次数。已接入登记的循环：验收复审（`--loop acceptance-review`，唯一接入判定上限的循环——上限 `acceptanceReReviewRoundCap` = 6，超限判 process-failed）、T2 设计审查（`--loop tech-review`，设计目录绑定交付任务时由 workflow 自动登记）、D2 一致性审查（`--loop dev-consistency`，同前）、独立保证（`--loop assurance`，independent-assurance-v6 各终态出口登记）、D1 开发执行 wave（`--loop d1`，wave-executor-v6 mode=dev 执行入口登记 started、终局按 terminated 补 finished outcome——completed=passed、blocked/core-failed=failed；taskDir 由 exec-plan 编译时固化的 `<taskDir>/process-review.jsonl` 推导，独立设计任务无该字段不入账）。后四类只登记不判定：机器上界判定需 gate 侧扩展循环词表（另行工作），属已知缺口，不宣称已有统一上界。手工复审同用 `loop-attempt --path manual` 登记（第 11 节手工通道执行复审时同样入账，保证终态报告的通道统计不缺手工路径）。

**revision 来源对账**（候选形成后的每次 revision 变化必须有合法来源）：`revision-provenance` 从既有事件与合并回执只读派生逐代来源（source ∈ implementation / candidate-repair / assurance-repair / environment / external-baseline，附 eventRef 与 actor）。存在 unknown（来源不明）代际时的恢复动作 = 补做合法修复登记（如 `record-repair-round`）或恢复已知基线；恢复不了且变化来自外部进程或用户操作时，由用户经 `confirm-baseline` 命令确认新的外部基线（登记 RevisionBaselineConfirmed 事件接链——未确认前 unknown 不得静默消除）。unknown 未消除不得 accepted；后续保证完成不把来源不明代际变成正常历史。

**交付义务派生**（accepted 前置的判定输入，从现有权威数据派生，不建人工总表）：

```bash
node ~/.agents/skills/delivery-v6/scripts/delivery-core.mjs obligations --task-dir <taskDir>
```

输出义务清单（kind：assertion 验收断言 / stage 必需阶段 / repair 受控修复 / pending blocking 待办 / asset 用户要求的交付资产（asset 待实现——依赖用户资产声明通道）/ runtime 外部契约运行可用性；state：open / satisfied / explicitly-waived）。**accepted 前置 = 必需义务无 open**；`explicitly-waived` 必须绑定用户裁决。豁免通道按义务类型映射现状：assertion 类走 `accept-risk`（绑 gapId；boundary 与 riskAcceptable=false 不可豁免）；pending 类无豁免——按待办 note 完成事项后 `delivery-core pending resolve` 关闭；stage 与 repair 类无豁免通道（stage 类 gate 恢复动作明写「阶段无独立豁免通道，走正常交付流程」），只能推进完成或停回用户裁决；runtime 类无豁免——`accept-risk` 与 `preauthorize-risk` 均不消化，义务词表无 explicitly-waived 状态，满足形态 = 当前 revision 由 assurance 登记、`runtimeProbe=true` 且认领该契约能力的证据（artifact 的 environment.kind 满足能力 minEnvironment、sourceHash 与当前权威 aggregateHash 一致、probe 记录该能力观察通过、subject.revision 与事件 revision 一致），环境确实不可得时停回用户裁决「目标环境不可满足」，不得写成 accepted / accepted_with_risk。注意：人工处置（`node-transition --event manual-disposition --basis`）自动登记的待复盘待办属 pending 类，accept 前须先 resolve。finding 类残余风险不在义务清单内（义务 kind 词表无 finding），其接受走既有 finding 通道（`preauthorize-risk` 预授权范围内，或 `accept-risk --target-type finding` 绑 findingId）。交付义务派生不含 D5（其状态权威在 dev-flow 侧状态仓，机器前置待载体，见 dev-flow 文档）。已知缺口：deferredLedger（dev-flow 侧未决清单）未接入义务派生。

**外部契约守门命令组**（delivery-gate，user 凭据；不在内核转移表，`next` 不会带出，仅手工 / 主会话路径使用）：

```bash
# 外部权威登记：local-path / executable 权威必须由用户凭据登记；designer / builder 填写的本地路径不生成 resolved
node ~/.agents/skills/delivery-v6/scripts/delivery-gate.mjs declare-external-authority \
  --task-dir <taskDir> --contract-id <契约id> --resolver-kind <resolverKind> \
  --locator <定位符> --snapshot-sha256 <快照哈希> --summary "登记理由" \
  --credential <user credentialId>
# 外部环境基线确认：只接环境历史链，不满足 runtime 义务；同一 acceptanceVersion 最多一次
node ~/.agents/skills/delivery-v6/scripts/delivery-gate.mjs confirm-environment-baseline \
  --task-dir <taskDir> --contract-ids '["<契约id>"]' --new-authority-snapshot-sha256 <新快照哈希> \
  --credential <user credentialId>
# 任务分级唯一写通道（另一通道 = init --delivery-profile；禁直改 task.json）
node ~/.agents/skills/delivery-v6/scripts/delivery-gate.mjs set-delivery-profile \
  --task-dir <taskDir> --profile a|b|c --credential <user credentialId>
```

- `declare-external-authority` 登记 ExternalAuthorityDeclared 事件（绑 contractId、resolverKind、locator 与快照哈希）：local-path 按 git 仓库身份覆盖全部 worktree，路径位于同仓库可写范围内即拒绝；executable 登记绝对路径、版本与厂商来源指纹，不依赖会话 PATH 上的 `which` 结果。
- `confirm-environment-baseline` 登记 EnvironmentBaselineConfirmed 事件（绑新快照哈希与覆盖的契约 id 清单）：确认后仍必须在当前环境重跑 probe；同一 acceptanceVersion 内再次漂移必须 `open-revision` 或停回用户，不允许用环境重试掩盖实现缺陷。
- `set-delivery-profile` 写 task.json 的 deliveryProfile（a=机制小改 / b=结构改，缺省 / c=大版本）：降档只减审查席与分区，不减必做机器门。已批准任务降档到 a 的前提：验收 `reviewDimensions` 必须 ⊆ a 级两维（「外部契约」「故障形态」），否则探索登记（ExplorationCompleted）会因维度覆盖不足被拒——需更多维度时先 `open-revision` 收窄验收维度并重新审查批准，或保持 b 级。

## 1. 初始化（init：意图 + 凭据 + 血统）

init 前确认 `--project-root` 归属（本会话自己的项目/worktree）。stdout 含 `projectDir`、`worktree`、`siblingTasks`、`evalIdentity`（评测环境）。

```bash
node ~/.agents/skills/delivery-v6/scripts/delivery-gate.mjs init \
  --project-root <项目根> --task-id <任务id> [--intent-file <原始意图文件>] \
  [--verification-only] [--new-round | --resume-existing] [--delivery-profile a|b|c]
```

- stdout 输出：`taskDir`、`credentials`（三个 credentialId，形态 `<分组>/<任务id>/<角色>`）、`intentSha256` 与三把公钥。**私钥不输出**——已写入凭据目录 `~/.agents/skill-data/delivery-keys/<分组>/<任务id>/`（0600）。
- `--task-id` 形态约束：以字母或数字开头、不含连续两个点、长度 ≤128，非法即拒绝（它直接参与目录名与凭据路径）。
- `--delivery-profile` 缺省 b（a=机制小改 / b=结构改 / c=大版本，与 benchmark 同级）；降档只减审查席与分区，不减必做机器门。唯一写通道 = init 本参数或 user 凭据命令 `set-delivery-profile`（第 0 节），禁直改 task.json。
- 血统规则：同 git 仓库身份下已存在同 intent 的未替换任务时 init 拒绝——走任务替换（第 8 节）或先 `declare-independent`。
- `--verification-only`：纳管体系外已有实现的只核验模式（豁免方案包与 DesignApproved）；由 candidate-build-v6 承载——builder 不改代码，逐增量核验在当前 revision 成立并登记实现记录。
- 意图未随 init 带入时，后续一次性写入：`set-intent --task-dir <taskDir> --file <意图文件>`（写入后不可修改——需要新意图 = 新任务）。

凭据传递边界：

| 凭据 | 持有 | 用途 | 注入边界 |
|------|------|------|----------|
| `builder` | 凭据文件 | candidate-build-v6 签 ImplementationRecorded/FindingRaised | builderCredentialId 可注入该 workflow |
| `assurance` | 凭据文件 | 验收审查、证据与发现、保证与探索事件 | assuranceCredentialId 可注入独立保证 workflow |
| `user` | 凭据文件 | 批准、风险接受、替换、基线、策略、解冻命令 | **仅主会话**；绝不注入任何子 agent 或 workflow |

## 2. 目标与验收设计与批准（裁决点：用户批准）

zcode：`CreateWorkflow saved: acceptance-design-v6`，args `{ projectRoot, taskDir, objective, assuranceCredentialId, taskId?, executionId?, sampleType?, runId? }`；pi：运行技能上级 `workflows/pi/acceptance-design-v6.js`。

workflow 完成 designer 起草 → assurance 独立审查 → 机器校验，双通过后以 assurance 凭据登记 `record-review --conclusion pass`（自动绑验收包/intent/快照哈希）。机器校验入口 = `delivery-gate validate-acceptance --task-dir <taskDir>`（只读幂等；验收包声明 `externalContracts` 时增跑外部契约静态检查，失败按其恢复动作交 designer 修订）。审查与校验语义、修订轮对照上一版草稿差异的机制见 workflow 契约（delivery-v6 SKILL「Workflow 契约」节）。**验收复审轮预算**：按 `delivery-core loop-budget` 的 started 计数执行（进入复审即 `loop-attempt` 登记 started；打回、校验失败、designer 失败、中断全部计入，跨 run 累计），超 `acceptanceReReviewRoundCap`（6）判 process-failed 停回用户。审查反馈 artifact 按 `acceptanceVersion + runId + round` 隔离存放，禁止只按 round 覆盖历史报告；打回后下一轮 designer 发起前必须读取最新反馈 artifact（不靠主 agent 转述）。

**外部契约任务的验收复审流程**（验收包出现 `externalContracts` 键时，workflow 顺序固定）：候选探测（setup 跑 `detect-external-contracts.mjs`，候选快照落 `taskDir/evidence/acceptance-v<N>/external-contract-candidates.json`，detectionSha256 = 快照文件字节 sha256）→ 候选处置（designer 在 `externalContractReview` 逐候选填 bound / manual / not-external / unresolved）→ 权威解析（跑 `resolve-external-contracts.mjs --write`，落 `taskDir/environment-contracts/<snapshotSha256>.json` 与派生指针 `environment-contracts.current.json`）→ 起草 / 修订 → 独立审查 → 机器校验 → 以 assurance 凭据登记 `record-review`。审查与批准时刻自动绑定当前环境契约快照哈希（additive 字段 `authoritySnapshotSha256`，显式 `--authority-snapshot-sha256` 优先）；批准事件绑定的哈希是环境历史链起点。无外部候选时也落空候选快照与空环境快照（`contracts: []`），使 detectionSha256 / authoritySnapshotSha256 有可绑定对象，不缺省猜测。环境快照或 current 指针被手改 / 损坏时：重跑 `resolve-external-contracts.mjs --write` 重建（快照按哈希分文件存储、不覆盖历史），不要手改快照文件。

呈报关键目标、非目标、风险与覆盖对照，用户明确批准后：

```bash
node ~/.agents/skills/delivery-v6/scripts/delivery-gate.mjs approve-acceptance \
  --task-dir <taskDir> --confirmation user-explicit|standing-authorization \
  --summary "用户批准验收 vN 及验收要求" --credential <user credentialId> \
  [--authority-snapshot-sha256 <环境快照哈希>]
```

批准自动绑最新通过的审查事件并**冻结验收包**（见第 0 节写入防护）。同组合后发的 reject 审查会使批准失效（回 draft 重新走审查）。修改验收判据必须：`open-revision` 解封 → 递增 acceptanceVersion 重新起草 → 重新审查与批准。只做设计的任务到批准即停止。

冻结验收包被误改（0444 权限被绕过、内容被改）时：下次加载的篡改检测会拒绝——恢复动作 = 从 `taskDir/frozen/v<N>/` 快照恢复 acceptance.json 与 increments.json 原内容后再重试；确需改判据走 `open-revision` 正常修订通道，不要手工改回后继续用旧批准。

## 3. 方案确认（裁决点：用户确认方案包；技能②衔接）

tech-design-v6 产出完整方案包并经用户确认后：

```bash
node ~/.agents/skills/delivery-v6/scripts/delivery-gate.mjs record-design-approved \
  --task-dir <taskDir> --summary "方案包确认" \
  --package-file <方案包哈希清单 JSON：[{name, sha256}]> --credential <user credentialId>
```

验收版本变化后 DesignApproved 失效，需重新确认。**方案包内容变化不被机器自动检出**（packageFiles 是登记时声明的快照清单，gate 只判「事件存在 + 版本一致」）——改动方案包后必须重新 `record-design-approved`，否则执行侧仍按旧批准继续；首次保证之后的方案修订按一轮并入修复预算（perVersion）。

## 4. 候选实现（技能③，两通道任选）

- `candidate-build-v6`：入口门校验验收批准；非 `--verification-only` 任务还要求 DesignApproved（state=design 直接拒绝，恢复动作指向 `record-design-approved`）。只核验任务由 builder 逐增量核验不改代码，实现摘要带 `[verification-only]` 标注。
- dev-flow-v6（技能③）：按验收与方案实现，其 D4 收尾按 increments 逐增量以 builder 凭据登记 `ImplementationRecorded`（衔接定义见 dev-flow-v6 文档），与 candidate-build-v6 的实现记录与合并回执口径一致。

builder 事件经 `record-implementation --credential <builder credentialId> [--run-id <runId>]` 登记（ImplementationRecorded 附合并回执：起始指纹=上一增量完成指纹或 setup 基线、合并后指纹、补丁哈希）。schema 2 任务登记实现的门禁：**当前 revision 必须已有候选探索**（explore-only 先行）且 must-fix 清零——探索通道不要求实现先登记（V4 死锁点的机器化否定，转移表 `implementing → candidate-explored`）。

## 5. 独立保证

zcode：`CreateWorkflow saved: independent-assurance-v6`，args `{ projectRoot, taskDir, assuranceCredentialId, mode?, taskId?, executionId?, sampleType?, runId? }`。前置：state 非 draft；除 explore-only 外增量齐。`full` = 覆盖核对 + 全量断言取证 + 开放探索；`recheck` = 旧发现与修复 diff 复核 + 受影响断言 + 全量确定性测试 + 历史探索引用，不默认重新开放探索；`explore-only` = D3 后、D4 前的候选反例审查，只写 ExplorationCompleted，不写 AssuranceCompleted。探索 due、可用探索集、open 发现集由 workflow 经 `delivery-core` 判定命令消费（单源纪律，不本地复刻）。setup/finalize 比对 revision；漂移登记 AssuranceRevisionDrift，链超上限进 revision-unstable。AssuranceCompleted 绑逐增量测试回执与证据/探索事件 id；full 必须引用当前 revision 探索，recheck 可引用同验收版本历史探索，但必须有当前 revision 的定向覆盖报告与全量确定性测试。

回执与 setup/finalize 使用的产物状态指纹口径与 `delivery-gate` 的 revision 计算一致，按任务策略快照 revision.json 的 mode 分两档：`auto-git`（普通模式）= git HEAD + tracked 修改（`git diff`）+ untracked 非 ignored 文件逐文件内容——builder 新增的未跟踪文件替换内容后指纹必变；`content-manifest` = 按项目根 `delivery-manifest.txt` 清单逐文件内容计算（输出 `manifest-` 前缀指纹），非 git 项目走该模式（`auto-git` 下非 git 目录无法计算 revision，链路走不通）。

策略快照 `runsFromIgnoredArtifacts=true`（policies/revision.json 随任务固定）时的执行语义：workflow 取证前生成干净构建（HEAD 导出 + 工作树补丁 + 非 ignored 新文件复制，不含 ignored 本地产物），逐增量测试在干净目录执行并统一绑 buildId，AssuranceCompleted 附 cleanBuild 记录——证明证据不依赖本机 ignored 产物；干净目录内测试失败（如需本机 ignored 依赖）会如实记入回执，裁决器按退出码判定保证无效。`mode=content-manifest` 时豁免干净构建：产物已纳入内容清单、变化即改变 revision 使旧证据失效，裁决器与 workflow 同判定。

**外部契约任务的 runtime probe 义务**（验收包带 `externalContracts` 时，coverage-reviewer 硬责任，六条）：① 亲自运行 resolver，不采信 builder 提供的路径字符串，权威以 resolver 输出与权威 surface 文件为准；② 每个 essential capability 至少一条由 assurance 亲自执行的非 builder 自报观察——经 resolver 输出的 resolvedPath（权威绝对路径）调用外部系统做最小观察，probe artifact 写入 evidence/（environment.kind=official-runner|real-host、sourceHash=该契约 aggregateHash、capabilities 含该能力、subject.revision=当前 revision、cases 记录 operation/observed/passed、summary 计数与 cases 一致），禁止用裸包名、项目内 alias 或 mock 模块替代权威入口；③ 验收反例引用的 negative case 由 assurance 亲自执行——自写最小 probe 或亲自执行独立执行器并观察真实环境拒绝，不能只运行 builder driver；④ 不从平台文档重新推导契约，文档只作辅助材料；⑤ authority 不可得时申报 `authority-missing` must-fix，不得降为 info；⑥ recheck 必须重跑 runtime probe——全部 essential capability 的 probe artifact 必须为当前 revision 重新执行产生，不得引用早期 spike，只复跑项目测试不满足义务。real-host 类无法安全自动化的能力转人工执行：由 assurance 承担人工执行义务，回传 artifact 并登记 `executedBy=manual-handoff` 与理由，不得静默跳过。fake-host 资产被用于证明契约专属语义时另需 parity 记录（mock 与真实 probe 逐样本对照，任一样本语义不同则该 mock 不得继续作为该语义的证明，见 `references/roles/coverage-reviewer.md`）。runtime 义务唯一可满足形态 = `record-evidence` 带 `--runtime-probe` 且认领该能力的 assurance 证据。

**内容冻结窗口（主会话与用户义务）**：revision = git HEAD + tracked 修改 + untracked 非 ignored 文件逐文件哈希——任何字节变化（含新建临时文件、手工 git commit、编辑项目内文件）都会改变 revision，使该 revision 上的既有证据失效。因此独立保证 run 在途期间、以及 D4 最终 commit 后到 verdict 产出之前，项目内容必须冻结：不手工 commit、不写临时文件、不整理文件；builder/explorer/coverage-reviewer 的角色文件已要求「临时产物当场删除」，主会话同样受此约束。确需变更时等本轮保证结束或接受整轮作废重跑。

## 6. 有限修复与统一判定（裁决点：预算停回）

实现缺陷统一走 `assurance-repair-loop-v6`，args `{ projectRoot, taskDir, assuranceCredentialId, builderCredentialId, allowCommit, fixSuggestions?, runId?, taskId?, executionId?, sampleType? }`。聚合节点给出来源阶段、受影响断言和回归测试，builder 修复并提交，独立 reviewer 做受影响一致性复核，最后以 recheck 完成当前版本取证。`allowCommit` 必须由主会话在确认 worktree 归属后显式传 true；禁止主会话裸补丁直提。

**预算三档**（超限即 `process-failed` 停回用户，不再补丁）：perVersion 修复轮 >3（behavior 轮 + 首次保证后的方案/验收修订；environment/evidence 重试不计轮）；不同 must-fix >10（reopenOf 根去重）；**跨 run 保证总轮 >6**（保证 run 次数 + perVersion 轮——跨 run「重取证→新发现→再修复」循环的机器上界）。轮次预判由 workflow 经 `delivery-core repair-budget` 查询（与 evaluate 同口径单源）。

- 设计冲突回 tech-design-v6，场景缺失回 T3，验收遗漏走第 2 节修订通道（open-revision → 递增版本重批）。
- 测试与场景不一致（测试未构造判据条件或断言更弱）：回 D2 三方对账 / 修测试，修复时必须证明该测试能在缺陷版本失败（回归测试口径同 `references/roles/repair-builder.md` 第 4 条）。
- 证据不足回 independent-assurance-v6；具体风险交用户逐项决定。

## 7. 统一判定与风险接受（裁决点：风险接受）

```bash
node ~/.agents/skills/delivery-v6/scripts/delivery-gate.mjs evaluate --task-dir <taskDir>
node ~/.agents/skills/delivery-v6/scripts/delivery-gate.mjs accept-risk \
  --task-dir <taskDir> --target-type requirement|finding --target-id <id> \
  --confirmation user-explicit --summary "接受 <具体风险、影响、恢复方式>" \
  --credential <user credentialId> [--gap-id <gapId>]
```

- accept-risk 缺口绑定：单缺口缺省自动绑定当前 gapId（missing 缺口为确定性派生 id；partial/failed 绑对应证据事件 id）；同一需求存在多个未接受缺口时必须 `--gap-id` 指定其一（缺省执行会列出全部候选 gapId）——多缺口不允许自动绑定，防登记项与用户批准项错位。boundary 类与 riskAcceptable=false 需求拒绝。
- evaluate 前的机器核对（内核只读命令，任一不过按其恢复动作处置）：`obligations` 必需义务无 open；`revision-provenance` 候选形成后无 unknown 来源代际（历史 unknown 区间可由用户 `confirm-history` 署名确认后归 user-confirmed，见第 10 节）；`loop-budget` 各循环 started 计数未超上限；外部契约候选复扫（evaluate 会重新扫描当前实现对外部系统的实际调用点）：实现中新增验收未登记的外部系统调用会让候选复扫不过、evaluate 拒绝——恢复动作 = 走第 2 节 `open-revision` 修订验收登记 capability；外部契约任务的 `runtimeReadiness.overall` 为 established / not-applicable 且每个外部契约的环境历史链完好（当前权威 aggregateHash 等于批准时该契约哈希，或有覆盖该契约的 `EnvironmentBaselineConfirmed` 接链；同一 acceptanceVersion 最多确认一次）。runtime 义务不接受风险接受——`accept-risk` 与 `preauthorize-risk` 均不消化 kind=runtime 义务，环境不可得时停回用户裁决。
- 按 `nextAction` 处理；预算耗尽的 process-failed 带用量明细（修复三档 + 各循环 started 计数）与停回指引。

## 8. 写事务租约（workflow run 级）

```bash
node ~/.agents/skills/delivery-v6/scripts/delivery-gate.mjs lease-acquire  --project-root <项目根> --run-id <runId>
node ~/.agents/skills/delivery-v6/scripts/delivery-gate.mjs lease-heartbeat --project-root <项目根> --run-id <runId>
node ~/.agents/skills/delivery-v6/scripts/delivery-gate.mjs lease-release --project-root <项目根> --run-id <runId>
```

失联租约被 acquire 接管时先按进程组终止旧进程树并递增代次；事件登记命令（意图命令组）的 `--run-id` 在事件锁临界区内复核租约持有者，非当前代次拒绝写入。

- **心跳时效 120 秒**：租约持有者必须至少每 120 秒发一次 `lease-heartbeat`，超过即视为失联、可被其他 run 的 acquire 接管（接管会终止旧进程树）。主会话手工 `lease-acquire` 后做长操作前要评估时长，超过 2 分钟须先发心跳。
- **手工路径豁免租约**：意图命令组不传 `--run-id` 时直接放行（手工路径不需要租约）；并发边界 = 手工登记与 workflow run 不得同时写同一任务目录——有 run 在途时先等其结束或由其主会话统一登记。

## 9. 任务替换与独立声明

凭据丢失或任务接管时，在新任务上发起（不依赖旧任务密钥；血统限同一 git 仓库身份）：

前置约束：`supersede-prepare` 要求前任任务目录已有 verdict.json（缺 verdict = 未裁决的前任不能作为替换来源，先让前任走到裁决终态或走 supersede-cancel）；prepare 绑定前任 task.json/verdict/openFindings 三份哈希，`supersede-commit` 再次复核该哈希，任一变化即拒（前任在 prepare 后被改动 → 取消本次替换重新发起）。`declare-independent` 要求目标任务已有 intent.md（未 set-intent 的任务不能声明独立，先 `set-intent` 写意图）。

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
confirm-history  --task-dir <taskDir> --reason "确认结论" --credential <user> \
  --intervals '[{"fromRevision":"<旧指纹>","toRevision":"<新指纹>","rationale":"为何属合法外部变化"}]' [--revision R]
upgrade-policy  --task-dir <taskDir> --invalidation-note "逐事件失效范围" --summary S --credential <user>
snapshot-policy --task-dir <taskDir>   # 重建任务策略快照（读当前策略包并重算快照哈希；批准四元组与策略升级对账用）
```

revision-unstable 排查完写入源后由用户确认新基线（漂移计数归零）。`confirm-history` 是历史 unknown 区间的署名解释通道：只接受派生结果（`delivery-core revision-provenance`）中精确存在的 unknown 区间（from/to 须逐字匹配，区间绑哈希），把该段来源归为 user-confirmed；它不推进链条位置、不等于新基线，未覆盖的 unknown 仍阻断 accepted。多会话并行提交造成的断链历史用该命令逐段确认——登记前先跑 `revision-provenance` 取当前 unknown 区间清单。策略升级重写任务快照并要求重新审查与批准受影响的验收包。策略快照由 `snapshot-policy` 在 AcceptanceReviewed 之前固化为任务目录内文件，此后审查 / 批准 / evaluate 全按该快照执行——执行中读到的策略变化不即时生效。

## 11. 中断恢复与人工处置（显式转移，无手工通道）

恢复 = `delivery-core next` 读待办与合法转移，**不依赖会话记忆**：

1. 中断/善后/待登记事项在中断当下 `pending add` 落盘（kind 五类见第 0 节）；恢复后 `next` 优先回答待办。
2. workflow 不可用时按 next 给出的合法转移 executor 手工执行同一角色职责，事件走意图命令组（builder/assurance 类，见第 0 节；user 类命令走第 2/3/6/8/9 节高层命令）。每次恢复先 `evaluate` 读 verdict 与 nextAction；跨会话凭据按 task.json 的 credentialId 定位（evaluate 不需要私钥）。手工复审同用 `loop-attempt --path manual` 登记（进入登记 started、离开登记 finished——手工路径与 workflow 同表计数，终态报告按通道分开统计）。
3. DAG 节点的人工处置（blocked/failed/suspended → done）唯一合法通道 = `delivery-core node-transition --event manual-disposition --basis "<处置依据>"`——依据必填留痕；禁止直接编辑 status.json 或自造词表外事件。
4. 手工复核独立性：高风险任务的关键手工复核（替代独立保证路径的人工环节，如验收复审、修复受影响复核）须由独立 assurance 子角色完成，主 agent 只做登记与呈报、不亲自复核；无法达到独立性时只能降低证据结论（如实降级为 partial/unknown 并披露）或停回用户，不得按完整独立保证表述。
5. 场景库零产出治理：验证场景只保留实际拦截过问题或能证明区分度（能区分正误实现）的条目，连续零拦截且无区分度证明的场景删除；治理随实跑任务建设，不预设清单。
6. 中断恢复的补登记锚定事实时点：意图命令缺省按「当下 revision」登记（`computeRevision`），中断后补登记实现/修复事件必须显式传 `--revision <事实发生时点的 revision>`，否则事件被绑到恢复时点的 revision、证据范围错位。补登记前用合并回执/修复轮的 from/to revision 核对事实时点。
7. 「代码已提交但轮次未记账」的补登记：assurance-repair-loop-v6 在 `RepairRoundRecorded` 登记失败时会在终态 message 给出完整补登记命令（`record-repair-round` 带 round/trigger-finding-ids/affected-assertion-ids/artifact/revision/from-revision/to-revision/increment-receipts + builder 凭据）——按原命令补登记后重发本 workflow（重发会跳过已清零的修复轮）；不要用 `git reset --soft` 撤回已提交的修复代码（登记优先）。
8. 同一 revision 重复关闭：`resolve-finding` 只接受当前版本 + 当前 revision 下仍 open 的 finding；已关闭的（同 revision 内）再次关闭属表外转移，会被拒——手工复核时先读 `delivery-core open-findings` 确认目标仍在 open 集，已关闭的用 `reaffirm-resolution`（有原解决事件与复核依据时）或按新发现登记。
