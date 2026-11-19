# 事件、状态与失效范围

`events.jsonl` 是事实事件唯一权威；`verdict.json` 是裁决器根据当前验收、当前 revision 与事件重新计算的派生结果，禁止手改。每条事件带 Ed25519 签名（凭据文件中的角色私钥签出，公钥在 task.json）；evaluate 逐条验签。

## 事件词表（22 类）

| 事件 | 签署角色 | 含义与关键绑定 |
|------|----------|----------------|
| AcceptanceReviewed | assurance | 验收独立审查完成；绑 acceptanceVersion + 验收包哈希 + intentSha256 + 策略快照哈希 + 结论（pass/reject） |
| AcceptanceApproved | user | 某版验收被批准；四元组同上 + reviewEventId（指向通过的审查） |
| RevisionOpened | user | 解封已冻结验收包进入修订起草的唯一合法通道（`open-revision` 留痕）；绑 target 与 reason，要求递增 acceptanceVersion 并重新审查批准 |
| DesignApproved | user | 方案包确认；绑包文件哈希清单（packageFiles）与决策参照 |
| ImplementationRecorded | builder | 增量在某指纹下实现完成；附合并回执（起始指纹、合并后指纹、补丁哈希） |
| EvidenceRecorded | assurance | 某需求或断言某证据类型的结论；schema 2 附 assertionIds/adversarialFormIds；additive 可选字段 contractCapabilityIds（认领的外部契约能力 id）与 runtimeProbe（真实 runner / 宿主驱动产生的 runtime probe 证据，runtime 义务唯一可满足形态）；绑 artifact 内容哈希（禁止覆盖写）；宿主类证据的 JSON artifact 附 environment 元数据（kind/name/version/source/sourceHash/driver，见「宿主类断言与证据环境」节） |
| FindingRaised | builder/assurance | 登记发现；category=defect/boundary、severity、关联需求（可空）；非 blocker 附 consequenceRefutation；schema 2 空关联 boundary 附 emptyScopeRefutation；重开附 reopenOf（目标须已关闭且判据环境已变化）；结构命中外部契约时附 authorityBacked/authorityHash/authorityObservationRef 三段；可附来源阶段与回归测试 |
| FindingResolved | assurance | 发现解决（当前指纹有效）；boundary 的确认也走此事件，附对照论证 |
| ResolutionReaffirmed | assurance | 原解决事件在当前 revision 的逐项重认领；必须有原解决事件与复核依据，不允许只凭全量测试绿 |
| ExplorationCompleted | assurance | 探索审查完成；绑覆盖维度 + coverageManifestSha256（该值是探索报告文件的内容哈希声明值，机器只校验格式与与报告文件的同源计算，不做额外清单对账） |
| AssuranceCompleted | assurance | 独立保证完成；mode=full/recheck；绑本轮证据事件 id 集 + 探索事件 id + 逐增量测试回执 + 干净构建记录（按策略） |
| AssuranceRevisionDrift | assurance | 保证期间指纹漂移；setup/finalize 指纹与序号，按链计数 |
| RepairRoundRecorded | builder | 一次实现性修复开始；绑轮次、触发 finding、受影响断言与修复报告；第 4 轮触发 process-failed |
| RiskAccepted | user | 接受具体缺口；绑 gapId（missing 派生 / 证据事件 id / findingId）与当时证据状态 |
| RiskPreauthorized | user | 预授权指定类别 non-blocker finding 的风险接受范围与名额；blocker 与 requirement 目标不可预授权；名额按验收版本独立配额、按事件流顺序消耗；同分类范围的重复登记不合并、不叠加去重（每次登记是独立名额池） |
| PolicyUpgraded | user | 策略升级；绑旧/新快照哈希与逐事件失效范围声明 |
| RevisionBaselineConfirmed | user | 人工确认新基线（`confirm-baseline`）：漂移计数此后归零重计；或携带 explainedUnknownIntervals（`confirm-history`）：用户署名逐段解释 revision 来源对账中的历史 unknown 区间（每段绑 from/to 与区间哈希），不推进链条、不构成新基线——只把精确匹配的区间归为 user-confirmed |
| IndependentTaskDeclared | user | 独立任务声明；绑 intent 哈希与当时全部未替换任务清单 |
| TaskSuperseded | user | 任务替换 prepare/committed 两段；predecessor 绑 task.json/verdict/openFindings 哈希与继承发现 |
| TaskSupersedeCancelled | user | 恢复型取消；绑被取消 prepare 的事件 id 与被取消任务身份 |
| ExternalAuthorityDeclared | user | 外部权威登记（local-path/executable 必须由用户凭据登记）；绑 contractId、resolverKind、locator 与快照哈希 |
| EnvironmentBaselineConfirmed | user | 外部环境基线确认；绑新快照哈希与覆盖的契约 id 清单，只接环境历史链不满足 runtime 义务；同一 acceptanceVersion 最多一次 |

相同事件重复追加幂等；角色权限由策略包 roles.json 约束（加载信任边界：技能安装目录 + 用户级，项目仓库不可覆盖）。

## 失效范围（逐事件）

| 事件 | 有效范围 |
|------|----------|
| AcceptanceReviewed / AcceptanceApproved | 当前 acceptanceVersion + 验收包哈希 + intentSha256 + 策略快照哈希；同组合后发 reject 使旧通过失效 |
| DesignApproved | 当前 acceptanceVersion。packageFiles 是登记时声明的快照清单：机器层按「事件存在 + 版本一致」判定，不核对方案包文件当前内容——方案包改动不被机器自动检出，须靠人工纪律（改动后重新 record-design-approved）保证 |
| ImplementationRecorded | 按 acceptanceVersion 有效，跨 revision 保留；当前行为仍含增量由 AssuranceCompleted 回执兜底 |
| EvidenceRecorded | 当前版本 + 当前 revision；schema 1 同需求×同类型取最后一条，schema 2 同断言×同类型取最后一条 |
| FindingRaised | 按版本持久（继承发现同语义且跨版本持久） |
| FindingResolved | 当前版本 + 当前 revision；新 revision 自动重开 |
| AssuranceCompleted / ExplorationCompleted | full 必须绑定当前 revision 探索；recheck 可引用同验收版本历史探索，但必须有当前 revision 的定向覆盖报告与全量确定性测试回执 |
| RiskAccepted | 当前版本 + 当前 revision 且 gapId 与当前缺口一致；缺口内容变化即失效 |
| AssuranceRevisionDrift / RevisionBaselineConfirmed / IndependentTaskDeclared / TaskSuperseded / TaskSupersedeCancelled / PolicyUpgraded / ExternalAuthorityDeclared / EnvironmentBaselineConfirmed | 持久事实 |

## artifact 登记后冻结（五类带哈希事件）

EvidenceRecorded / ImplementationRecorded / ExplorationCompleted / AssuranceCompleted / RepairRoundRecorded 登记时绑 artifact 内容哈希。两条机器行为同时生效：

1. **写入时拒绝覆盖**：同一 artifact 路径已被事件以不同内容哈希登记时，再写入即拒（恢复动作 = 换新文件名写新报告）。
2. **登记后修改文件本体 = 静默失效**：evaluate 每次重算内容哈希，登记后再向已登记报告追加/编辑任何字符，该事件在下一次 evaluate 时退出有效集（missingArtifacts 标 hash-mismatch），**不报错、不拒绝**——现象与原因相距很远，容易被误判为「证据莫名其妙失效」。

正确做法：需要补充说明或追加结论时，用新文件名写一份追加报告并登记新事件，不要改动已登记文件；手工重跑要覆盖旧报告时同样换新路径（workflow 自动路径靠 attemptTag/revisionHash 命名隔离）。

## 判定式（两个终态）

- **accepted** = 批准有效（四元组一致 + 审查未被 reject 击穿）＋ 全部增量实现 ＋ 每条必需断言的**每类证据** verified（schema 1 仍为每条必需需求）＋ 当前指纹的保证完成（回执覆盖全部增量、退出码 0、绑定事件可追溯、按策略附干净构建）＋ 探索完成（如要求）＋ 无未决 defect ＋ 无未确认 boundary ＋ 候选形成后全部 revision 变化有合法来源（`revision-provenance` 无 unknown 代际；用户经 `confirm-history` 署名确认的历史区间归 user-confirmed 来源）＋ 必需交付义务无 open（`obligations` 派生；`explicitly-waived` 须绑用户裁决）＋ 循环尝试未超预算（`loop-budget` 按 started 计数）＋ runtime readiness 为 established / not-applicable 且每个外部契约的环境历史链完好（当前权威哈希等于批准时哈希，或有覆盖该契约的 `EnvironmentBaselineConfirmed` 接链）＋ 未进入 process-failed。
- **accepted_with_risk** = 上述条件中，逐缺口豁免：每个未 verified 的「需求×证据类型」都有绑定该缺口 gapId 的有效接受（且需求 riskAcceptable=true），每个未决 defect 有有效接受；boundary 不可接受风险；至少存在一项具体接受。两类证据缺口各自需独立接受。来源不明的 revision 与无豁免通道的 open 义务不在可接受范围内——豁免只作用于现有规则允许接受风险的事项。

缺口 gapId：完全缺失 = (acceptanceVersion, requirementId, evidenceKind, revision, "missing") 确定性派生；partial/failed = 对应证据事件 id；finding = findingId。

## 状态与 nextAction（优先级路由）

| 优先级 | 条件 | state |
|--------|------|-------|
| 0 | task.json 有 supersededBy 标记 | superseded |
| 0.5 | task.json 有 supersedeCancelled 标记 | supersede-cancelled（不可交付终态） |
| 1 | 本任务流有 prepare 无 committed | supersede-pending（禁止批准与交付） |
| 2 | 无有效批准 | draft |
| 3 | 已批准、完整路径、无 DesignApproved（非只核验） | design |
| 4 | 漂移链超上限 | revision-unstable |
| 4.5 | 需要第 4 轮实现性修复，或累计不同 must-fix 达到第 11 条，或验收复审 started 计数超 acceptanceReReviewRoundCap（6） | process-failed（停止正常修复，不得交付） |
| 5 | 必需需求存在未接受 failed 证据 | implementing |
| 6 | 存在未接受 blocker defect（无关联需求者触发全量增量修复） | implementing |
| 7 | 已批准且零实现 | acceptance-approved |
| 8 | 增量未齐 | implementing |
| 9 | 未接受 non-blocker defect | candidate |
| 10 | 未确认 boundary | candidate |
| 11 | partial/missing 缺口未全部接受 | candidate |
| 12 | 缺保证或探索 | candidate |
| 13 | accepted 完整公式满足 | accepted |
| 14 | accepted_with_risk 公式满足 | accepted_with_risk |

非必需需求出现 failed 不阻终态，但 verdict.nonRequiredFailures 必须披露。

## 漂移链计数

连续漂移链 = 前一条 finalize 等于后一条 setup、且最新一条 finalize 等于当前 revision 的漂移序列长度；只统计最近一次 RevisionBaselineConfirmed（或任务起点）之后、最近一次成功 AssuranceCompleted 之后的漂移。**预期修复豁免**：当前 revision 等于最新实现事件合并回执的 toRevision 时（builder 合并后的稳定状态）不计漂移；当前 revision 超出实现指纹且无衔接链时计一次失败保证（按 (实现事件, revision) 去重）。链超策略 maxDriftChain（默认 2）进 revision-unstable。

## 宿主类断言与证据环境

断言可通过可选字段 `requiredEnvironment` 声明宿主环境要求（缺省不限制；字段定义见 `references/acceptance.md`）：

```jsonc
{ "assertionId": "R4-A1", "requiredEnvironment": { "kind": "official-runner | real-host", "capability": "<能力名，可选>" } }
```

宿主类证据（声明了 requiredEnvironment 的断言的取证 artifact）使用 JSON artifact，附 environment 元数据：

```jsonc
{ "kind": "official-runner | real-host | fake-host", "name": "<宿主或执行器名>", "version": "<版本>", "source": "<权威来源>", "sourceHash": "<来源内容哈希>", "driver": "<实际驱动入口>" }
```

认领外部契约能力的 runtime probe 证据（EvidenceRecorded 带 contractCapabilityIds 且 runtimeProbe=true）在同一 environment 元数据上扩展驱动哈希、能力清单与逐能力观察：

```jsonc
{
  "environment": {
    "kind": "official-runner | real-host",
    "name": "<宿主或执行器名>",
    "version": "<版本>",
    "source": "<权威 locator>",
    "sourceHash": "<该契约当前权威 aggregateHash>",
    "driver": "<probe 脚本或命令入口>",
    "driverHash": "<驱动文件全文 sha256>",
    "capabilities": ["load-extension", "register-tool-and-invoke"]
  },
  "subject": { "revision": "<当前代码指纹>", "entrypoint": "<扩展入口>" },
  "cases": [
    { "capabilityId": "register-tool-and-invoke", "operation": "<按真实宿主调用签名调用工具>", "observed": { "<键>": "<值>" }, "passed": true }
  ],
  "summary": { "passed": 1, "failed": 0, "skipped": 0 }
}
```

driver 限定为单文件、无动态 import、无运行时生成代码，driverHash 覆盖该文件全文（需要辅助模块时全部纳入 import 闭包并逐文件登记哈希）；观察值不得只有 passed 布尔，必须保留能定位契约形态的键值；skipped 必须有理由并导致对应能力 open。probe artifact 的完整形态与独立保证侧的执行责任见 `references/roles/coverage-reviewer.md`。

判定规则（delivery-gate evaluate 执行）：

1. gate 对宿主类断言核对证据 artifact 的 environment 是否满足该断言的 requiredEnvironment——不满足时该证据最多判 partial/unknown，**不得 verified**。
2. 模拟环境（fake-host）不能独立证明宿主契约：宿主专属语义（命令解析、注册、回执、事件语义）必须至少一条 official-runner 或 real-host 证据；真实环境不可用只能 unknown/partial，用户是否接受该风险走既有裁决通道。
3. environment 的 `sourceHash` 核对口径按证据是否认领外部契约能力分裂：无外部契约的宿主证据仍只登记不核（读取与绑定元数据）；认领外部契约能力（EvidenceRecorded 带 contractCapabilityIds）的证据，其 `sourceHash` 与 resolver 现场重解析出的该契约当前权威 aggregateHash 机器核对，不一致时该证据不得 verified、对应 runtime 义务保持 open；`sourceHash` 缺失、driver 缺失或 driverHash 与驱动文件内容不一致同样不得 verified。
4. 已知缺口：分层证据规则第 4 条（模拟环境用于宿主语义证明前，须用相同样本与真实环境对照，证明未改写关键语义）未实施——当前拦截依赖 kind 词表 + 独立保证环境责任 + gate 降级三道防线；对照记录机制登记待实施。

## 循环尝试记录与预算

任务目录执行记录 `loop-attempts.jsonl`（append-only，不回写历史行）承载全部循环的尝试事实：进入循环即追加 `started`（attemptKey = runId:round，恢复重放按 attemptKey + event 去重），退出补 `finished --outcome passed|rejected|failed|interrupted`（`started` 不携带结果，同一尝试的完成事件不增加次数）。它不是签名事件（不进事件词表、不改变 AcceptanceReviewed 语义），workflow 与手工路径写同一份记录。

预算读取 `started` 计数，不读结果事件数——打回、校验失败、designer 失败、整次重发与中断全部计入，跨 run、跨 workflow 与手工路径累计，重开 run 不重置。验收复审（loop=acceptance-review）上限 = `acceptanceReReviewRoundCap`（6，`rules.json` budgets），超限进 process-failed（nextAction 优先级 4.5）；查询入口 `delivery-core loop-budget`，登记入口 `delivery-core loop-attempt`。审查反馈 artifact 按 `acceptanceVersion + runId + round` 隔离存放，禁止只按 round 覆盖历史报告。其余循环接入同一记录前进度属已知缺口，不宣称统一上界。

## 信任边界（如实声明）

凭据机制防：无凭据伪造、跨角色误写、审查省略、无独立证据却拿 accepted。不防：同一操作系统用户下的恶意进程（可读凭据、改公钥、回滚事件流重签）。用户防线 = A 档重算复跑 + B 档独立抽查产品行为；verdict 哈希由用户在任务目录外保存参照。
